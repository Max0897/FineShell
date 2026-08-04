import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HostRecord,
  JumpHostConnection,
  KnownHostRecord,
  PortForwardStatus,
  ProxyRecord,
  TerminalSession,
} from "../models";
import { confirmHostFingerprint, persistHostFingerprint } from "../app-window-actions";
import { recordDiagnostic, diagnosticInvoke as invoke } from "../diagnostics";
import { withHostDefaults } from "../host-storage";
import { knownHostTargetKey } from "../known-hosts";
import {
  commandErrorMessage,
  listenProtocolEvent,
  type SshConnectResult,
} from "../tauri-protocol";
import {
  jumpHostRequest,
  reconnectDelaySeconds,
  sshCredentialId,
} from "../terminal-utils";

interface UseTerminalSessionsOptions {
  onSessionsClosed?: (sessionIds: Set<string>) => void;
}

function createSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useTerminalSessions({
  onSessionsClosed,
}: UseTerminalSessionsOptions = {}) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const reconnectTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const manualReconnectsRef = useRef(new Set<string>());
  const intentionallyDisconnectedRef = useRef(new Set<string>());
  const onSessionsClosedRef = useRef(onSessionsClosed);
  onSessionsClosedRef.current = onSessionsClosed;

  const updateSession = useCallback(
    (sessionId: string, values: Partial<TerminalSession>) => {
      setSessions((current) => {
        const next = current.map((session) =>
          session.id === sessionId ? { ...session, ...values } : session,
        );
        sessionsRef.current = next;
        return next;
      });
    },
    [],
  );

  const updatePortForwardStatus = useCallback(
    (sessionId: string, status: PortForwardStatus) => {
      setSessions((current) => {
        const next = current.map((session) => {
          if (session.id !== sessionId) return session;
          const statuses = session.portForwardStatuses ?? [];
          const exists = statuses.some(
            (item) =>
              item.ruleId === status.ruleId && item.kind === status.kind,
          );
          return {
            ...session,
            portForwardStatuses: exists
              ? statuses.map((item) =>
                  item.ruleId === status.ruleId && item.kind === status.kind
                    ? status
                    : item,
                )
              : [...statuses, status],
          };
        });
        sessionsRef.current = next;
        return next;
      });
    },
    [],
  );

  const clearReconnectTimer = useCallback((sessionId: string) => {
    const timer = reconnectTimersRef.current.get(sessionId);
    if (timer) clearTimeout(timer);
    reconnectTimersRef.current.delete(sessionId);
  }, []);

  const connectSession = useCallback(
    async function connect(session: TerminalSession, reconnectAttempt = 0) {
      recordDiagnostic("info", "ssh.session", "开始建立 SSH 会话", {
        authentication: session.host.authMethod,
        reconnectAttempt,
        sessionId: session.id,
      });
      try {
        const result = await invoke<SshConnectResult>("ssh_connect", {
          request: {
            sessionId: session.id,
            hostId: sshCredentialId(session.host),
            address: session.host.address,
            port: session.host.port,
            username: session.host.username,
            authMethod: session.host.authMethod,
            privateKeyPath: session.host.privateKeyPath,
            connectTimeoutSeconds: session.host.connectTimeoutSeconds,
            keepAliveIntervalSeconds: session.host.keepAliveIntervalSeconds,
            expectedFingerprint: session.host.hostFingerprint,
            proxy: session.proxy,
            jumpHost: jumpHostRequest(session.jumpHost),
            localPortForwards: session.host.localPortForwards ?? [],
            remotePortForwards: session.host.remotePortForwards ?? [],
            dynamicPortForwards: session.host.dynamicPortForwards ?? [],
            cols: 80,
            rows: 24,
          },
        });
        if (intentionallyDisconnectedRef.current.has(session.id)) {
          void invoke("ssh_disconnect", { sessionId: session.id }).catch(
            () => undefined,
          );
          return;
        }
        if (result.status === "hostKeyVerificationRequired") {
          updateSession(session.id, {
            status: "connecting",
            error: "等待确认主机指纹",
          });
          const accepted = await confirmHostFingerprint(session.host, result);
          if (!sessionsRef.current.some((item) => item.id === session.id)) {
            return;
          }
          if (!accepted) {
            updateSession(session.id, {
              status: "failed",
              error: result.expectedFingerprint
                ? "主机指纹已变更，连接已取消"
                : "未信任主机指纹，连接已取消",
            });
            return;
          }

          const trustedHost = {
            ...session.host,
            hostFingerprint: result.fingerprint,
          };
          await persistHostFingerprint(trustedHost, result.fingerprint);
          updateSession(session.id, {
            status: "connecting",
            error: undefined,
            host: trustedHost,
          });
          await connect({ ...session, host: trustedHost }, reconnectAttempt);
          return;
        }
        clearReconnectTimer(session.id);
        updateSession(session.id, {
          status: "connected",
          fingerprint: result.fingerprint,
          error: undefined,
          host: {
            ...session.host,
            hostFingerprint: result.fingerprint,
          },
          reconnectAttempt: 0,
          portForwardStatuses: result.portForwards,
        });
        await persistHostFingerprint(session.host, result.fingerprint);
        recordDiagnostic("info", "ssh.session", "SSH 会话连接成功", {
          sessionId: session.id,
        });
      } catch (error) {
        if (intentionallyDisconnectedRef.current.has(session.id)) return;
        if (!sessionsRef.current.some((item) => item.id === session.id)) return;
        const message = commandErrorMessage(error);
        recordDiagnostic("error", "ssh.session", "SSH 会话连接失败", {
          error: message,
          reconnectAttempt,
          sessionId: session.id,
        });
        if (
          reconnectAttempt > 0 &&
          session.host.autoReconnect &&
          reconnectAttempt < session.host.maxReconnectAttempts
        ) {
          const nextAttempt = reconnectAttempt + 1;
          const delaySeconds = reconnectDelaySeconds(nextAttempt);
          updateSession(session.id, {
            status: "reconnecting",
            error: `第 ${reconnectAttempt} 次重连失败，${delaySeconds} 秒后重试：${message}`,
            reconnectAttempt,
          });
          clearReconnectTimer(session.id);
          const timer = setTimeout(() => {
            reconnectTimersRef.current.delete(session.id);
            const latest = sessionsRef.current.find(
              (item) => item.id === session.id,
            );
            if (latest) void connect(latest, nextAttempt);
          }, delaySeconds * 1000);
          reconnectTimersRef.current.set(session.id, timer);
          return;
        }
        updateSession(session.id, {
          status: "failed",
          error:
            reconnectAttempt > 0
              ? `自动重连失败（已尝试 ${reconnectAttempt} 次）：${message}`
              : message,
          reconnectAttempt,
        });
      }
    },
    [clearReconnectTimer, updateSession],
  );

  const openSession = useCallback(
    (host: HostRecord, proxy?: ProxyRecord, jumpHost?: JumpHostConnection) => {
      const session: TerminalSession = {
        id: createSessionId(),
        host: withHostDefaults(host),
        proxy,
        jumpHost,
        openedAt: new Date().toISOString(),
        status: "connecting",
      };
      const next = [...sessionsRef.current, session];
      sessionsRef.current = next;
      setSessions(next);
      setActiveSessionId(session.id);
      void connectSession(session);
    },
    [connectSession],
  );

  const reconnectSession = useCallback(
    (requestedSession: TerminalSession) => {
      const session =
        sessionsRef.current.find((item) => item.id === requestedSession.id) ??
        requestedSession;
      if (
        session.status === "connecting" ||
        session.status === "reconnecting"
      ) {
        return;
      }

      clearReconnectTimer(session.id);
      intentionallyDisconnectedRef.current.delete(session.id);
      updateSession(session.id, {
        status: "reconnecting",
        error: undefined,
        reconnectAttempt: 0,
      });

      if (session.status === "connected") {
        manualReconnectsRef.current.add(session.id);
        void invoke("ssh_disconnect", { sessionId: session.id }).catch(() => {
          if (!manualReconnectsRef.current.delete(session.id)) return;
          const latest = sessionsRef.current.find(
            (item) => item.id === session.id,
          );
          if (latest) void connectSession(latest, 0);
        });
        void invoke("sftp_disconnect", { sessionId: session.id }).catch(
          () => undefined,
        );
        return;
      }

      void connectSession(
        {
          ...session,
          status: "reconnecting",
          error: undefined,
          reconnectAttempt: 0,
        },
        0,
      );
    },
    [clearReconnectTimer, connectSession, updateSession],
  );

  const disconnectSession = useCallback(
    (sessionId: string) => {
      clearReconnectTimer(sessionId);
      manualReconnectsRef.current.delete(sessionId);
      intentionallyDisconnectedRef.current.add(sessionId);
      updateSession(sessionId, {
        status: "disconnected",
        error: undefined,
        reconnectAttempt: 0,
        portForwardStatuses: (
          sessionsRef.current.find((session) => session.id === sessionId)
            ?.portForwardStatuses ?? []
        ).map((status) => ({
          ...status,
          status: "stopped" as const,
          error: undefined,
        })),
      });
      void invoke("ssh_disconnect", { sessionId }).catch(() => undefined);
      void invoke("sftp_disconnect", { sessionId }).catch(() => undefined);
    },
    [clearReconnectTimer, updateSession],
  );

  const closeSessions = useCallback(
    (sessionIds: string[]) => {
      const closingIds = new Set(sessionIds);
      if (closingIds.size === 0) return;

      const current = sessionsRef.current;
      closingIds.forEach((sessionId) => {
        clearReconnectTimer(sessionId);
        manualReconnectsRef.current.delete(sessionId);
        intentionallyDisconnectedRef.current.delete(sessionId);
        void invoke("sftp_close_external_edits", { sessionId }).catch(
          () => undefined,
        );
        void invoke("ssh_disconnect", { sessionId }).catch(() => undefined);
        void invoke("sftp_disconnect", { sessionId }).catch(() => undefined);
      });
      const remaining = current.filter(
        (session) => !closingIds.has(session.id),
      );
      sessionsRef.current = remaining;
      setSessions(remaining);
      onSessionsClosedRef.current?.(closingIds);

      setActiveSessionId((currentActiveId) => {
        if (!currentActiveId || !closingIds.has(currentActiveId)) {
          return currentActiveId;
        }
        const currentIndex = current.findIndex(
          (session) => session.id === currentActiveId,
        );
        const nextIndex = Math.max(0, currentIndex - 1);
        return (
          remaining[nextIndex]?.id ??
          remaining[remaining.length - 1]?.id ??
          null
        );
      });
    },
    [clearReconnectTimer],
  );

  const closeSession = useCallback(
    (sessionId: string) => closeSessions([sessionId]),
    [closeSessions],
  );

  const syncKnownHostFingerprints = useCallback(
    (knownHosts: KnownHostRecord[]) => {
      setSessions((current) => {
        const next = current.map((session) => {
          const targetKey = knownHostTargetKey(
            session.host.address,
            session.host.port,
          );
          const knownHost = knownHosts.find(
            (record) =>
              knownHostTargetKey(record.address, record.port) === targetKey,
          );
          return {
            ...session,
            host: {
              ...session.host,
              hostFingerprint: knownHost?.fingerprint,
            },
          };
        });
        sessionsRef.current = next;
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlistenStatus: (() => void) | undefined;
    let unlistenPortForward: (() => void) | undefined;
    void listenProtocolEvent("ssh-status", ({ payload }) => {
      const session = sessionsRef.current.find(
        (item) => item.id === payload.sessionId,
      );
      if (!session) return;
      if (payload.error) {
        recordDiagnostic(
          payload.recoverable ? "warn" : "error",
          "ssh.session",
          "SSH 会话状态异常",
          {
            error: payload.error,
            recoverable: payload.recoverable,
            sessionId: payload.sessionId,
            status: payload.status,
          },
        );
      }
      if (manualReconnectsRef.current.delete(session.id)) {
        const reconnectingSession = {
          ...session,
          status: "reconnecting" as const,
          error: undefined,
          reconnectAttempt: 0,
        };
        updateSession(session.id, reconnectingSession);
        void connectSession(reconnectingSession, 0);
        return;
      }
      if (intentionallyDisconnectedRef.current.has(session.id)) {
        updateSession(session.id, {
          status: "disconnected",
          error: undefined,
          reconnectAttempt: 0,
          portForwardStatuses: (session.portForwardStatuses ?? []).map(
            (status) => ({
              ...status,
              status: "stopped" as const,
              error: undefined,
            }),
          ),
        });
        return;
      }
      if (payload.recoverable && session.host.autoReconnect) {
        const attempt = 1;
        const delaySeconds = reconnectDelaySeconds(attempt);
        clearReconnectTimer(session.id);
        updateSession(session.id, {
          status: "reconnecting",
          error: `${payload.error || "SSH 连接中断"}，${delaySeconds} 秒后自动重连`,
          reconnectAttempt: attempt,
        });
        const timer = setTimeout(() => {
          reconnectTimersRef.current.delete(session.id);
          const latest = sessionsRef.current.find(
            (item) => item.id === session.id,
          );
          if (latest) void connectSession(latest, attempt);
        }, delaySeconds * 1000);
        reconnectTimersRef.current.set(session.id, timer);
        return;
      }
      updateSession(payload.sessionId, {
        status: payload.status,
        error: payload.error,
        reconnectAttempt: 0,
        portForwardStatuses: (session.portForwardStatuses ?? []).map(
          (status) => ({
            ...status,
            status: "stopped" as const,
            error: undefined,
          }),
        ),
      });
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlistenStatus = stopListening;
    });

    void listenProtocolEvent("port-forward-status", ({ payload }) => {
      const { sessionId, ...status } = payload;
      updatePortForwardStatus(sessionId, status);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlistenPortForward = stopListening;
    });

    return () => {
      disposed = true;
      unlistenStatus?.();
      unlistenPortForward?.();
    };
  }, [
    clearReconnectTimer,
    connectSession,
    updatePortForwardStatus,
    updateSession,
  ]);

  useEffect(
    () => () => {
      reconnectTimersRef.current.forEach((timer) => clearTimeout(timer));
      reconnectTimersRef.current.clear();
      manualReconnectsRef.current.clear();
      intentionallyDisconnectedRef.current.clear();
      sessionsRef.current.forEach((session) => {
        void invoke("ssh_disconnect", { sessionId: session.id }).catch(
          () => undefined,
        );
        void invoke("sftp_disconnect", { sessionId: session.id }).catch(
          () => undefined,
        );
      });
    },
    [],
  );

  const activeSession = useMemo(
    () =>
      sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  return {
    activeSession,
    activeSessionId,
    closeSession,
    closeSessions,
    disconnectSession,
    openSession,
    reconnectSession,
    sessions,
    setActiveSessionId,
    syncKnownHostFingerprints,
    updatePortForwardStatus,
  };
}
