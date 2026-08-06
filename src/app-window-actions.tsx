import {
  Alert,
  Message,
  Modal,
  Progress,
  Spin,
  Typography,
} from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import type { HostRecord } from "./models";
import ReleaseNotesMarkdown from "./components/ReleaseNotesMarkdown";
import { updateStoredHostFingerprint } from "./configuration-mutations";
import {
  applicationUpdater,
  formatUpdateBytes,
  markApplicationUpdateRelaunchFocus,
  setApplicationUpdateInstalling,
  setApplicationUpdateNotice,
  type ApplicationUpdate,
} from "./app-updater";
import {
  commandErrorMessage,
  emitProtocolEventTo,
  type SshConnectResult,
} from "./tauri-protocol";
import { diagnosticInvoke as invoke, recordDiagnostic } from "./diagnostics";
import { auxiliaryWindowHref } from "./window-view";

let startupUpdatePromptShown = false;

interface StartupUpdateProgress {
  downloadedBytes: number;
  error?: string;
  phase: "downloading" | "restarting" | "error";
  route?: string;
  totalBytes: number;
}

function startupUpdateContent(
  update: ApplicationUpdate,
  progress?: StartupUpdateProgress,
) {
  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(
          100,
          Math.round(
            (progress.downloadedBytes / progress.totalBytes) * 100,
          ),
        )
      : 0;

  return (
    <div className="startup-update-content">
      <Typography.Text>
        当前版本 v{update.currentVersion}，发现新版本 v{update.version}。
      </Typography.Text>
      {update.body && (
        <ReleaseNotesMarkdown className="startup-update-notes">
          {update.body}
        </ReleaseNotesMarkdown>
      )}
      {progress && (
        <div className="startup-update-progress">
          {progress.phase === "error" ? (
            <Alert
              content={progress.error ?? "更新失败，请重试"}
              showIcon
              type="error"
            />
          ) : (
            <>
              <div className="startup-update-progress-meta">
                <Typography.Text>
                  {progress.phase === "restarting"
                    ? "更新安装完成，正在重启应用"
                    : `正在下载更新${progress.route ? ` · ${progress.route}` : ""}`}
                </Typography.Text>
                {progress.phase === "downloading" && (
                  <Typography.Text type="secondary">
                    {formatUpdateBytes(progress.downloadedBytes)}
                    {progress.totalBytes > 0
                      ? ` / ${formatUpdateBytes(progress.totalBytes)}`
                      : ""}
                  </Typography.Text>
                )}
              </div>
              {progress.phase === "restarting" ? (
                <Progress percent={100} showText={false} />
              ) : progress.totalBytes > 0 ? (
                <Progress percent={percent} showText={false} />
              ) : (
                <Spin size={18} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function promptStartupApplicationUpdate(update: ApplicationUpdate) {
  if (startupUpdatePromptShown) return;
  startupUpdatePromptShown = true;

  let modalInstance: ReturnType<typeof Modal.confirm>;
  modalInstance = Modal.confirm({
    autoFocus: false,
    cancelText: "稍后",
    className: "startup-update-modal",
    content: startupUpdateContent(update),
    maskClosable: false,
    okText: "立即更新",
    onCancel: () => {
      void update.close();
    },
    onOk: async () => {
      let progress: StartupUpdateProgress = {
        downloadedBytes: 0,
        phase: "downloading",
        route: update.route,
        totalBytes: 0,
      };
      const renderProgress = () => {
        modalInstance.update({ content: startupUpdateContent(update, progress) });
      };

      setApplicationUpdateInstalling(true);
      renderProgress();
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            progress = {
              ...progress,
              downloadedBytes: 0,
              totalBytes: event.data.contentLength ?? 0,
            };
          } else if (event.event === "Fallback") {
            progress = {
              downloadedBytes: 0,
              phase: "downloading",
              route: event.data.route,
              totalBytes: 0,
            };
          } else if (event.event === "Progress") {
            progress = {
              ...progress,
              downloadedBytes:
                progress.downloadedBytes + event.data.chunkLength,
            };
          } else {
            progress = {
              ...progress,
              downloadedBytes: progress.totalBytes || progress.downloadedBytes,
              phase: "restarting",
            };
          }
          renderProgress();
        });
        markApplicationUpdateRelaunchFocus(update.version);
        setApplicationUpdateNotice(null);
        await applicationUpdater.relaunch();
      } catch (error) {
        const message = commandErrorMessage(error);
        progress = { ...progress, error: message, phase: "error" };
        renderProgress();
        recordDiagnostic("error", "application.update", "应用更新失败", {
          error: message,
          version: update.version,
        });
        Message.error(`更新失败：${message}`);
        throw error;
      } finally {
        setApplicationUpdateInstalling(false);
      }
    },
    title: "发现新版本",
  });
}

type AuxiliaryWindow = "settings" | "shortcuts";

export function openAuxiliaryWindow(view: AuxiliaryWindow) {
  if (!isTauri()) {
    window.open(auxiliaryWindowHref(view), `fineshell-${view}`);
    return;
  }

  const command =
    view === "settings" ? "open_settings_window" : "open_shortcut_guide_window";
  void invoke(command).catch((error) => {
    const title = view === "settings" ? "设置" : "快捷键说明";
    Message.error(`无法打开${title}：${commandErrorMessage(error)}`);
  });
}

export async function persistHostFingerprint(
  host: HostRecord,
  fingerprint: string,
) {
  try {
    await updateStoredHostFingerprint(host, fingerprint);
    if (isTauri()) {
      await Promise.all([
        emitProtocolEventTo("main", "configuration:changed").catch(() => undefined),
        emitProtocolEventTo("settings", "configuration:changed").catch(
          () => undefined,
        ),
      ]);
    }
  } catch {
    // Configuration persistence must not interrupt an active SSH connection.
  }
}

export function confirmHostFingerprint(
  host: HostRecord,
  result: SshConnectResult,
) {
  const changed = Boolean(result.expectedFingerprint);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      resolve(accepted);
    };

    Modal.confirm({
      cancelText: "取消连接",
      className: "fingerprint-confirm-modal",
      content: (
        <div className="fingerprint-confirm-content">
          <Alert
            content={
              changed
                ? "服务器返回的指纹与已保存记录不同。确认服务器密钥确实已更换后再继续。"
                : "首次连接该服务器，请先通过可信渠道核对指纹。"
            }
            showIcon
            type={changed ? "error" : "warning"}
          />
          <div className="fingerprint-row">
            <Typography.Text type="secondary">服务器</Typography.Text>
            <Typography.Text className="fingerprint-value">
              {host.address.includes(":")
                ? `[${host.address}]:${host.port}`
                : `${host.address}:${host.port}`}
            </Typography.Text>
          </div>
          {result.expectedFingerprint && (
            <div className="fingerprint-row">
              <Typography.Text type="secondary">原指纹</Typography.Text>
              <Typography.Text className="fingerprint-value">
                {result.expectedFingerprint}
              </Typography.Text>
            </div>
          )}
          <div className="fingerprint-row">
            <Typography.Text type="secondary">
              {changed ? "新指纹" : "SHA256"}
            </Typography.Text>
            <Typography.Text className="fingerprint-value">
              {result.fingerprint}
            </Typography.Text>
          </div>
        </div>
      ),
      maskClosable: false,
      okButtonProps: changed ? { status: "danger" } : undefined,
      okText: changed ? "接受新指纹" : "信任并连接",
      onCancel: () => settle(false),
      onOk: () => settle(true),
      title: changed ? "主机指纹已变更" : "确认主机指纹",
    });
  });
}
