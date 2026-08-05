import { useEffect, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Input,
  InputNumber,
  Menu,
  Message,
  Popconfirm,
  Radio,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
} from "@arco-design/web-react";
import {
  IconApps,
  IconDelete,
  IconCommand,
  IconFolder,
  IconHistory,
  IconInfoCircle,
  IconLaunch,
  IconRobot,
  IconThunderbolt,
  IconTool,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DEFAULT_APP_SETTINGS,
  appSettingsEqual,
  type AppSettings,
} from "../app-settings";
import { setAppearanceMode } from "../appearance";
import { loadConfiguration } from "../config-database";
import { updateAppSettings } from "../configuration-mutations";
import {
  configureDiagnosticLogging,
  diagnosticInvoke,
  recordDiagnostic,
} from "../diagnostics";
import {
  applicationUpdater,
  isApplicationUpdateInstalling,
  listenApplicationUpdateInstalling,
  listenApplicationUpdateNotice,
  readApplicationUpdateNotice,
  type ApplicationUpdateNotice,
} from "../app-updater";
import { emitProtocolEventTo } from "../tauri-protocol";
import { TERMINAL_THEMES } from "../terminal-themes";
import { resolveDefaultTerminalLogDirectory } from "../terminal-logging";
import { isApplePlatform } from "../platform-utils";
import AdvancedSettings from "./AdvancedSettings";
import AiSettings from "./AiSettings";
import AboutSettings from "./AboutSettings";
import ConfigurationMaintenance from "./ConfigurationMaintenance";
import KnownHostSettings from "./KnownHostSettings";
import PrivacySettings from "./PrivacySettings";
import ProxySettings from "./ProxySettings";
import QuickCommandSettings from "./QuickCommandSettings";
import SshKeySettings from "./SshKeySettings";

type SettingsSection =
  | "appearance"
  | "terminal"
  | "quickCommands"
  | "ai"
  | "files"
  | "monitor"
  | "connection"
  | "sshKeys"
  | "knownHosts"
  | "privacy"
  | "advanced"
  | "proxies"
  | "backups"
  | "trash"
  | "about";

const NESTED_SECTION_TITLES: Partial<Record<SettingsSection, string>> = {
  appearance: "外观",
  terminal: "终端",
  files: "文件管理",
  monitor: "服务器监控",
  connection: "连接默认值",
  proxies: "代理",
  sshKeys: "密钥",
  knownHosts: "已知主机",
  privacy: "隐私与清理",
  backups: "备份与恢复",
  trash: "回收站",
};

const SECTIONS_WITH_SETTINGS_FOOTER = new Set<SettingsSection>([
  "appearance",
  "terminal",
  "files",
  "monitor",
  "connection",
  "ai",
  "privacy",
  "advanced",
]);

interface SettingRowProps {
  control: ReactNode;
  label: string;
}

function SettingRow({ control, label }: SettingRowProps) {
  return (
    <div className="settings-row">
      <Typography.Text>{label}</Typography.Text>
      <div className="settings-control">{control}</div>
    </div>
  );
}

function editorNameFromPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? path;
  return name.replace(/\.(?:app|exe)$/i, "");
}

function SettingsWindow() {
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("terminal");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [savedSettings, setSavedSettings] =
    useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updateNotice, setUpdateNotice] =
    useState<ApplicationUpdateNotice | null>(() =>
      applicationUpdater.canInstallUpdates
        ? readApplicationUpdateNotice()
        : null,
    );
  const [updateInstalling, setUpdateInstalling] = useState(
    isApplicationUpdateInstalling,
  );

  useEffect(() => {
    document.title = "设置";
    let disposed = false;
    void loadConfiguration()
      .then(async (configuration) => {
        let resolvedSettings = configuration.settings;
        if (isTauri() && !resolvedSettings.terminalLogDirectory.trim()) {
          try {
            resolvedSettings = {
              ...resolvedSettings,
              terminalLogDirectory:
                await resolveDefaultTerminalLogDirectory(),
            };
          } catch (error) {
            recordDiagnostic(
              "warn",
              "terminal.logging",
              "默认终端日志目录解析失败",
              { error: String(error) },
            );
          }
        }
        if (disposed) return;
        setSettings(resolvedSettings);
        setSavedSettings(resolvedSettings);
        setAppearanceMode(resolvedSettings.appearanceMode);
      })
      .catch((error) => {
        if (!disposed) {
          recordDiagnostic("error", "configuration", "设置窗口读取配置失败", {
            error: String(error),
          });
          Message.error(String(error));
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(
    () =>
      listenApplicationUpdateNotice((notice) => {
        setUpdateNotice(applicationUpdater.canInstallUpdates ? notice : null);
      }),
    [],
  );

  useEffect(() => listenApplicationUpdateInstalling(setUpdateInstalling), []);

  useEffect(() => {
    if (!isTauri() || !isApplePlatform()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (!isApplicationUpdateInstalling()) return;
        event.preventDefault();
        Message.warning("更新正在安装，请等待安装完成");
      })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    void configureDiagnosticLogging(savedSettings.diagnosticLogLevel).catch(
      () => undefined,
    );
  }, [savedSettings.diagnosticLogLevel]);

  useEffect(() => {
    if (!loading) setAppearanceMode(settings.appearanceMode);
  }, [loading, settings.appearanceMode]);

  const updateSetting = <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const saveSettings = async () => {
    if (
      settings.terminalLoggingEnabled &&
      !settings.terminalLogDirectory.trim()
    ) {
      Message.warning("请先选择终端日志目录");
      setActiveSection("terminal");
      return;
    }
    setSaving(true);
    try {
      const configuration = await updateAppSettings(settings);
      setSettings(configuration.settings);
      setSavedSettings(configuration.settings);
      setAppearanceMode(configuration.settings.appearanceMode, {
        persist: true,
      });
      if (isTauri()) {
        await emitProtocolEventTo(
          "main",
          "settings:changed",
          configuration.settings,
        );
      }
      Message.success("设置已保存");
    } catch (error) {
      recordDiagnostic("error", "configuration", "应用设置保存失败", {
        error: String(error),
      });
      Message.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  const chooseExternalEditor = async () => {
    if (!isTauri()) {
      Message.warning("仅桌面应用支持选择外部编辑器");
      return;
    }
    const selected = await open({
      directory: false,
      multiple: false,
      title: "选择外部编辑器",
    });
    if (typeof selected !== "string") return;
    setSettings((current) => ({
      ...current,
      externalEditorPath: selected,
      externalEditorName: editorNameFromPath(selected),
    }));
  };

  const chooseTerminalLogDirectory = async () => {
    if (!isTauri()) {
      Message.warning("仅桌面应用支持选择终端日志目录");
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择终端日志目录",
    });
    if (typeof selected !== "string") return;
    updateSetting("terminalLogDirectory", selected);
  };

  const openTerminalLogDirectory = async () => {
    if (!isTauri()) {
      Message.warning("仅桌面应用支持打开终端日志目录");
      return;
    }
    if (!settings.terminalLogDirectory.trim()) {
      Message.warning("请先选择终端日志目录");
      return;
    }
    try {
      await diagnosticInvoke("terminal_log_open_directory", {
        directory: settings.terminalLogDirectory,
      });
    } catch (error) {
      Message.error(String(error));
    }
  };

  const content = (() => {
    switch (activeSection) {
      case "appearance":
        return (
          <div className="settings-group">
            <SettingRow
              control={
                <Radio.Group
                  aria-label="应用外观"
                  onChange={(value) =>
                    updateSetting(
                      "appearanceMode",
                      value as AppSettings["appearanceMode"],
                    )
                  }
                  options={[
                    { label: "浅色", value: "light" },
                    { label: "深色", value: "dark" },
                    { label: "跟随系统", value: "system" },
                  ]}
                  type="button"
                  value={settings.appearanceMode}
                />
              }
              label="主题模式"
            />
          </div>
        );
      case "terminal":
        return (
          <>
            <div className="settings-group">
              <SettingRow
                control={
                  <Select
                    aria-label="终端配色方案"
                    onChange={(value) =>
                      updateSetting(
                        "terminalColorScheme",
                        value as AppSettings["terminalColorScheme"],
                      )
                    }
                    options={Object.entries(TERMINAL_THEMES).map(
                      ([value, definition]) => ({
                        label: (
                          <span className="terminal-theme-option">
                            <span
                              className="terminal-theme-swatch"
                              style={{ background: definition.swatch }}
                            />
                            {definition.label}
                          </span>
                        ),
                        value,
                      }),
                    )}
                    value={settings.terminalColorScheme}
                  />
                }
                label="配色方案"
              />
              <SettingRow
                control={
                  <Select
                    aria-label="终端字体"
                    onChange={(value) =>
                      updateSetting(
                        "terminalFontFamily",
                        value as AppSettings["terminalFontFamily"],
                      )
                    }
                    options={[
                      { label: "系统等宽字体", value: "system" },
                      { label: "Menlo", value: "menlo" },
                      { label: "Consolas", value: "consolas" },
                    ]}
                    value={settings.terminalFontFamily}
                  />
                }
                label="字体"
              />
              <SettingRow
                control={
                  <InputNumber
                    aria-label="终端字号"
                    max={24}
                    min={10}
                    mode="button"
                    onChange={(value) =>
                      updateSetting("terminalFontSize", value)
                    }
                    suffix="px"
                    value={settings.terminalFontSize}
                  />
                }
                label="字号"
              />
              <SettingRow
                control={
                  <InputNumber
                    aria-label="终端行高"
                    max={2}
                    min={1}
                    mode="button"
                    onChange={(value) =>
                      updateSetting("terminalLineHeight", value)
                    }
                    precision={1}
                    step={0.1}
                    value={settings.terminalLineHeight}
                  />
                }
                label="行高"
              />
              <SettingRow
                control={
                  <Radio.Group
                    onChange={(value) =>
                      updateSetting(
                        "terminalCursorStyle",
                        value as AppSettings["terminalCursorStyle"],
                      )
                    }
                    options={[
                      { label: "方块", value: "block" },
                      { label: "下划线", value: "underline" },
                      { label: "竖线", value: "bar" },
                    ]}
                    type="button"
                    value={settings.terminalCursorStyle}
                  />
                }
                label="光标样式"
              />
              <SettingRow
                control={
                  <Switch
                    checked={settings.terminalCursorBlink}
                    onChange={(value) =>
                      updateSetting("terminalCursorBlink", value)
                    }
                  />
                }
                label="光标闪烁"
              />
              <SettingRow
                control={
                  <Select
                    aria-label="终端回滚行数"
                    onChange={(value) =>
                      updateSetting("terminalScrollback", value)
                    }
                    options={[
                      { label: "1,000 行", value: 1_000 },
                      { label: "5,000 行", value: 5_000 },
                      { label: "10,000 行", value: 10_000 },
                      { label: "50,000 行", value: 50_000 },
                    ]}
                    value={settings.terminalScrollback}
                  />
                }
                label="回滚行数"
              />
              <SettingRow
                control={
                  <Switch
                    checked={settings.terminalCopyOnSelect}
                    onChange={(value) =>
                      updateSetting("terminalCopyOnSelect", value)
                    }
                  />
                }
                label="选中后复制"
              />
              <SettingRow
                control={
                  <Select
                    aria-label="终端右键行为"
                    onChange={(value) =>
                      updateSetting(
                        "terminalRightClickAction",
                        value as AppSettings["terminalRightClickAction"],
                      )
                    }
                    options={[
                      { label: "显示操作菜单", value: "menu" },
                      { label: "直接粘贴", value: "paste" },
                    ]}
                    value={settings.terminalRightClickAction}
                  />
                }
                label="右键行为"
              />
            </div>
            <div className="settings-subsection-heading">
              <Typography.Title heading={6}>终端日志</Typography.Title>
              <Typography.Text type="secondary">
                每个终端会话单独保存，日志可能包含命令和敏感输出
              </Typography.Text>
            </div>
            <div className="settings-group">
              <SettingRow
                control={
                  <Switch
                    aria-label="自动记录终端日志"
                    checked={settings.terminalLoggingEnabled}
                    onChange={(value) =>
                      updateSetting("terminalLoggingEnabled", value)
                    }
                  />
                }
                label="自动记录"
              />
              <SettingRow
                control={
                  <Space className="terminal-log-directory-control" size={8}>
                    <Input
                      aria-label="终端日志目录"
                      placeholder="请选择日志保存目录"
                      readOnly
                      value={settings.terminalLogDirectory}
                    />
                    <Button
                      aria-label="选择终端日志目录"
                      icon={<IconFolder />}
                      onClick={() => void chooseTerminalLogDirectory()}
                    />
                    <Button
                      aria-label="打开终端日志目录"
                      disabled={!settings.terminalLogDirectory.trim()}
                      icon={<IconLaunch />}
                      onClick={() => void openTerminalLogDirectory()}
                    />
                  </Space>
                }
                label="日志目录"
              />
              <SettingRow
                control={
                  <Select
                    aria-label="终端日志格式"
                    disabled={!settings.terminalLoggingEnabled}
                    onChange={(value) =>
                      updateSetting(
                        "terminalLogFormat",
                        value as AppSettings["terminalLogFormat"],
                      )
                    }
                    options={[
                      { label: "纯文本", value: "plain" },
                      { label: "原始输出（ANSI）", value: "raw" },
                    ]}
                    value={settings.terminalLogFormat}
                  />
                }
                label="日志格式"
              />
              <SettingRow
                control={
                  <Select
                    aria-label="终端日志单文件上限"
                    disabled={!settings.terminalLoggingEnabled}
                    onChange={(value) =>
                      updateSetting("terminalLogMaxFileSizeMb", value)
                    }
                    options={[
                      { label: "50 MB", value: 50 },
                      { label: "100 MB", value: 100 },
                      { label: "500 MB", value: 500 },
                    ]}
                    value={settings.terminalLogMaxFileSizeMb}
                  />
                }
                label="单文件上限"
              />
            </div>
          </>
        );
      case "files":
        return (
          <>
            <div className="settings-group">
              <SettingRow
                control={
                  <Switch
                    checked={settings.showHiddenFiles}
                    onChange={(value) =>
                      updateSetting("showHiddenFiles", value)
                    }
                  />
                }
                label="显示隐藏文件"
              />
              <SettingRow
                control={
                  <Switch
                    checked={settings.confirmFileDelete}
                    onChange={(value) =>
                      updateSetting("confirmFileDelete", value)
                    }
                  />
                }
                label="删除前确认"
              />
              <SettingRow
                control={
                  <Space className="settings-editor-picker" size="mini">
                    <Input
                      aria-label="外部编辑器"
                      placeholder="使用系统默认应用"
                      readOnly
                      value={settings.externalEditorName}
                    />
                    <Button onClick={() => void chooseExternalEditor()}>
                      选择
                    </Button>
                    {settings.externalEditorPath && (
                      <Button
                        aria-label="清除外部编辑器"
                        icon={<IconDelete />}
                        onClick={() =>
                          setSettings((current) => ({
                            ...current,
                            externalEditorPath: "",
                            externalEditorName: "",
                          }))
                        }
                      />
                    )}
                  </Space>
                }
                label="外部编辑器"
              />
            </div>
          </>
        );
      case "quickCommands":
        return <QuickCommandSettings />;
      case "ai":
        return <AiSettings settings={settings} updateSetting={updateSetting} />;
      case "monitor":
        return (
          <>
            <div className="settings-group">
              <SettingRow
                control={
                  <Select
                    aria-label="监控刷新间隔"
                    onChange={(value) =>
                      updateSetting("monitorRefreshIntervalSeconds", value)
                    }
                    options={[
                      { label: "3 秒", value: 3 },
                      { label: "5 秒", value: 5 },
                      { label: "10 秒", value: 10 },
                      { label: "15 秒", value: 15 },
                      { label: "30 秒", value: 30 },
                    ]}
                    value={settings.monitorRefreshIntervalSeconds}
                  />
                }
                label="刷新间隔"
              />
            </div>
          </>
        );
      case "connection":
        return (
          <>
            <div className="settings-group">
              <SettingRow
                control={
                  <InputNumber
                    aria-label="默认连接超时"
                    max={120}
                    min={3}
                    mode="button"
                    onChange={(value) =>
                      updateSetting("defaultConnectTimeoutSeconds", value)
                    }
                    suffix="秒"
                    value={settings.defaultConnectTimeoutSeconds}
                  />
                }
                label="连接超时"
              />
              <SettingRow
                control={
                  <InputNumber
                    aria-label="默认保活间隔"
                    max={300}
                    min={5}
                    mode="button"
                    onChange={(value) =>
                      updateSetting("defaultKeepAliveIntervalSeconds", value)
                    }
                    suffix="秒"
                    value={settings.defaultKeepAliveIntervalSeconds}
                  />
                }
                label="保活间隔"
              />
              <SettingRow
                control={
                  <Switch
                    checked={settings.defaultAutoReconnect}
                    onChange={(value) =>
                      updateSetting("defaultAutoReconnect", value)
                    }
                  />
                }
                label="自动重连"
              />
              <SettingRow
                control={
                  <InputNumber
                    aria-label="默认最大重连次数"
                    disabled={!settings.defaultAutoReconnect}
                    max={10}
                    min={1}
                    mode="button"
                    onChange={(value) =>
                      updateSetting("defaultMaxReconnectAttempts", value)
                    }
                    suffix="次"
                    value={settings.defaultMaxReconnectAttempts}
                  />
                }
                label="最大重连次数"
              />
            </div>
          </>
        );
      case "proxies":
        return <ProxySettings />;
      case "sshKeys":
        return <SshKeySettings />;
      case "knownHosts":
        return <KnownHostSettings />;
      case "privacy":
        return (
          <PrivacySettings
            savedSettings={savedSettings}
            settings={settings}
            updateSetting={updateSetting}
          />
        );
      case "advanced":
        return (
          <AdvancedSettings settings={settings} updateSetting={updateSetting} />
        );
      case "backups":
        return (
          <ConfigurationMaintenance
            onConfigurationImported={(importedSettings) => {
              setSettings(importedSettings);
              setSavedSettings(importedSettings);
            }}
            section="backups"
          />
        );
      case "trash":
        return <ConfigurationMaintenance section="trash" />;
      case "about":
        return (
          <AboutSettings
            knownUpdate={updateNotice}
            settings={settings}
            updateSetting={updateSetting}
          />
        );
      default:
        return null;
    }
  })();

  const nestedSectionTitle = NESTED_SECTION_TITLES[activeSection];
  const pageContent = nestedSectionTitle ? (
    <>
      <Typography.Title className="settings-section-title" heading={5}>
        {nestedSectionTitle}
      </Typography.Title>
      {content}
    </>
  ) : (
    content
  );

  return (
    <main className="settings-window">
      <aside className="settings-sidebar">
        <Menu
          defaultOpenKeys={[]}
          onClickMenuItem={(key) =>
            updateInstalling && key !== "about"
              ? Message.warning("更新正在安装，请等待安装完成")
              : setActiveSection(key as SettingsSection)
          }
          selectedKeys={[activeSection]}
        >
          <Menu.SubMenu
            key="general"
            title={
              <span className="settings-submenu-title">
                <IconApps />
                常规
              </span>
            }
          >
            <Menu.Item key="appearance">外观</Menu.Item>
            <Menu.Item key="terminal">终端</Menu.Item>
            <Menu.Item key="files">文件管理</Menu.Item>
            <Menu.Item key="monitor">服务器监控</Menu.Item>
          </Menu.SubMenu>
          <Menu.SubMenu
            key="connectionSecurity"
            title={
              <span className="settings-submenu-title">
                <IconThunderbolt />
                连接与安全
              </span>
            }
          >
            <Menu.Item key="connection">连接默认值</Menu.Item>
            <Menu.Item key="proxies">代理</Menu.Item>
            <Menu.Item key="sshKeys">密钥</Menu.Item>
            <Menu.Item key="knownHosts">已知主机</Menu.Item>
          </Menu.SubMenu>
          <Menu.Item key="quickCommands">
            <IconCommand />
            快捷命令
          </Menu.Item>
          <Menu.Item key="ai">
            <IconRobot />
            AI 助手
          </Menu.Item>
          <Menu.SubMenu
            key="dataPrivacy"
            title={
              <span className="settings-submenu-title">
                <IconHistory />
                数据与隐私
              </span>
            }
          >
            <Menu.Item key="privacy">隐私与清理</Menu.Item>
            <Menu.Item key="backups">备份与恢复</Menu.Item>
            <Menu.Item key="trash">回收站</Menu.Item>
          </Menu.SubMenu>
          <Menu.Item key="advanced">
            <IconTool />
            高级
          </Menu.Item>
          <Menu.Item key="about">
            <IconInfoCircle />
            <Badge
              count={updateNotice ? 1 : 0}
              dot
              dotStyle={{ width: 8, height: 8 }}
              offset={[5, -2]}
            >
              <span className="settings-about-menu-label">关于</span>
            </Badge>
          </Menu.Item>
        </Menu>
      </aside>
      <section className="settings-content">
        {loading ? (
          <div className="settings-loading">
            <Spin />
          </div>
        ) : (
          <div className="settings-page">{pageContent}</div>
        )}
        {SECTIONS_WITH_SETTINGS_FOOTER.has(activeSection) && (
          <footer className="settings-footer">
            <Popconfirm
              onOk={() => setSettings({ ...DEFAULT_APP_SETTINGS })}
              position="top"
              title="将所有设置恢复为默认值？"
              unmountOnExit={false}
            >
              <Button disabled={loading || saving}>恢复默认</Button>
            </Popconfirm>
            <Space>
              <Button
                disabled={loading || appSettingsEqual(settings, savedSettings)}
                onClick={() => setSettings(savedSettings)}
              >
                撤销更改
              </Button>
              <Button
                disabled={loading || appSettingsEqual(settings, savedSettings)}
                loading={saving}
                onClick={() => void saveSettings()}
                type="primary"
              >
                保存设置
              </Button>
            </Space>
          </footer>
        )}
      </section>
    </main>
  );
}

export default SettingsWindow;
