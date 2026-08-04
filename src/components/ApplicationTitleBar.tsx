import { useEffect, useState } from "react";
import { Button, Message, Tooltip } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bot,
  CircleHelp,
  Command,
  Maximize,
  Minimize,
  Minus,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  X,
} from "lucide-react";
import { isApplePlatform, primaryShortcutModifier } from "../platform-utils";

interface ApplicationTitleBarProps {
  aiAssistantVisible: boolean;
  hasActiveSession: boolean;
  onOpenQuickCommands: () => void;
  onOpenSettings: () => void;
  onOpenShortcutGuide: () => void;
  onToggleServerMonitor: () => void;
  onToggleSftp: () => void;
  onToggleAiAssistant: () => void;
  platform?: string;
  serverMonitorCollapsed: boolean;
  sftpCollapsed: boolean;
}

function reportWindowOperationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  Message.error(`窗口操作失败：${message}`);
}

export default function ApplicationTitleBar({
  aiAssistantVisible,
  hasActiveSession,
  onOpenQuickCommands,
  onOpenSettings,
  onOpenShortcutGuide,
  onToggleServerMonitor,
  onToggleSftp,
  onToggleAiAssistant,
  platform = navigator.platform,
  serverMonitorCollapsed,
  sftpCollapsed,
}: ApplicationTitleBarProps) {
  const applePlatform = isApplePlatform(platform);
  const [maximized, setMaximized] = useState(false);
  const primaryModifier = primaryShortcutModifier(platform);

  useEffect(() => {
    if (applePlatform || !isTauri()) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let stopListening: (() => void) | undefined;
    const updateMaximized = async () => {
      try {
        const next = await appWindow.isMaximized();
        if (!disposed) setMaximized(next);
      } catch (error) {
        if (!disposed) reportWindowOperationError(error);
      }
    };

    void updateMaximized();
    void appWindow
      .onResized(() => void updateMaximized())
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopListening = unlisten;
      })
      .catch(reportWindowOperationError);

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [applePlatform]);

  const runWindowOperation = (operation: () => Promise<void>) => {
    if (!isTauri()) return;
    void operation().catch(reportWindowOperationError);
  };

  const toggleMaximize = () => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    void appWindow
      .toggleMaximize()
      .then(() => appWindow.isMaximized())
      .then(setMaximized)
      .catch(reportWindowOperationError);
  };

  return (
    <header
      className={`application-titlebar ${
        applePlatform
          ? "application-titlebar-macos"
          : "application-titlebar-custom"
      }`}
    >
      <div
        className="application-titlebar-drag-region"
        data-tauri-drag-region
        onDoubleClick={applePlatform ? undefined : toggleMaximize}
      >
        {!applePlatform && (
          <div className="application-titlebar-brand">
            <img alt="" src="/app-icon.png" />
            <span>FineShell</span>
          </div>
        )}
      </div>

      <div className="application-titlebar-toolbar">
        <Tooltip
          content={
            hasActiveSession
              ? aiAssistantVisible
                ? "关闭 AI 助手"
                : "打开 AI 助手"
              : "请先打开终端会话"
          }
        >
          <span className="application-titlebar-action-wrapper">
            <Button
              aria-label={aiAssistantVisible ? "关闭 AI 助手" : "打开 AI 助手"}
              aria-pressed={aiAssistantVisible}
              className={`application-titlebar-action-button${
                aiAssistantVisible ? " is-active" : ""
              }`}
              disabled={!hasActiveSession}
              icon={<Bot aria-hidden="true" />}
              onClick={onToggleAiAssistant}
              type="text"
            />
          </span>
        </Tooltip>
        <Tooltip
          content={
            hasActiveSession
              ? `快捷命令（${primaryModifier} + Shift + P）`
              : "请先打开终端会话"
          }
        >
          <span className="application-titlebar-action-wrapper">
            <Button
              aria-label="打开快捷命令"
              className="application-titlebar-action-button"
              disabled={!hasActiveSession}
              icon={<Command aria-hidden="true" />}
              onClick={onOpenQuickCommands}
              type="text"
            />
          </span>
        </Tooltip>
        <Tooltip content="快捷键与操作">
          <span className="application-titlebar-action-wrapper">
            <Button
              aria-label="打开快捷键与操作"
              className="application-titlebar-action-button"
              icon={<CircleHelp aria-hidden="true" />}
              onClick={onOpenShortcutGuide}
              type="text"
            />
          </span>
        </Tooltip>
        <Tooltip
          content={serverMonitorCollapsed ? "显示服务器监控" : "隐藏服务器监控"}
        >
          <span className="application-titlebar-action-wrapper">
            <Button
              aria-label={
                serverMonitorCollapsed ? "显示服务器监控" : "隐藏服务器监控"
              }
              aria-pressed={!serverMonitorCollapsed}
              className="application-titlebar-action-button"
              icon={
                serverMonitorCollapsed ? (
                  <PanelLeftOpen aria-hidden="true" />
                ) : (
                  <PanelLeftClose aria-hidden="true" />
                )
              }
              onClick={onToggleServerMonitor}
              type="text"
            />
          </span>
        </Tooltip>
        <Tooltip content={sftpCollapsed ? "显示文件管理" : "隐藏文件管理"}>
          <span className="application-titlebar-action-wrapper">
            <Button
              aria-label={sftpCollapsed ? "显示文件管理" : "隐藏文件管理"}
              aria-pressed={!sftpCollapsed}
              className="application-titlebar-action-button"
              icon={
                sftpCollapsed ? (
                  <PanelBottomOpen aria-hidden="true" />
                ) : (
                  <PanelBottomClose aria-hidden="true" />
                )
              }
              onClick={onToggleSftp}
              type="text"
            />
          </span>
        </Tooltip>
        <Tooltip content={`设置（${primaryModifier} + ,）`}>
          <span className="application-titlebar-action-wrapper">
            <Button
              aria-label="打开设置"
              className="application-titlebar-action-button"
              icon={<Settings aria-hidden="true" />}
              onClick={onOpenSettings}
              type="text"
            />
          </span>
        </Tooltip>
      </div>

      {!applePlatform && (
        <div className="application-window-controls">
          <button
            aria-label="最小化窗口"
            className="application-window-control"
            onClick={() =>
              runWindowOperation(() => getCurrentWindow().minimize())
            }
            type="button"
          >
            <Minus aria-hidden="true" />
          </button>
          <button
            aria-label={maximized ? "还原窗口" : "最大化窗口"}
            className="application-window-control"
            onClick={toggleMaximize}
            type="button"
          >
            {maximized ? (
              <Minimize aria-hidden="true" />
            ) : (
              <Maximize aria-hidden="true" />
            )}
          </button>
          <button
            aria-label="关闭窗口"
            className="application-window-control application-window-control-close"
            onClick={() => runWindowOperation(() => getCurrentWindow().close())}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  );
}
