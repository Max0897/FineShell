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
  Tabs,
  Typography,
} from "@arco-design/web-react";
import {
  IconApps,
  IconDelete,
  IconCommand,
  IconHistory,
  IconInfoCircle,
  IconThunderbolt,
  IconTool,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DEFAULT_APP_SETTINGS,
  appSettingsEqual,
  type AppSettings,
} from "../app-settings";
import { loadConfiguration, updateAppSettings } from "../config-database";
import {
  configureDiagnosticLogging,
  recordDiagnostic,
} from "../diagnostics";
import {
  applicationUpdater,
  listenApplicationUpdateNotice,
  readApplicationUpdateNotice,
} from "../app-updater";
import { emitProtocolEventTo } from "../tauri-protocol";
import { TERMINAL_THEMES } from "../terminal-themes";
import AdvancedSettings from "./AdvancedSettings";
import AboutSettings from "./AboutSettings";
import ConfigurationMaintenance from "./ConfigurationMaintenance";
import KnownHostSettings from "./KnownHostSettings";
import PrivacySettings from "./PrivacySettings";
import ProxySettings from "./ProxySettings";
import QuickCommandSettings from "./QuickCommandSettings";
import SshKeySettings from "./SshKeySettings";

type SettingsSection =
  | "terminal"
  | "quickCommands"
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

type SettingsCategory =
  | "general"
  | "connectionSecurity"
  | "quickCommands"
  | "dataPrivacy"
  | "advanced"
  | "about";

const CATEGORY_DEFAULT_SECTION: Record<SettingsCategory, SettingsSection> = {
  general: "terminal",
  connectionSecurity: "connection",
  quickCommands: "quickCommands",
  dataPrivacy: "privacy",
  advanced: "advanced",
  about: "about",
};

const SECTION_CATEGORY: Record<SettingsSection, SettingsCategory> = {
  terminal: "general",
  files: "general",
  monitor: "general",
  connection: "connectionSecurity",
  proxies: "connectionSecurity",
  sshKeys: "connectionSecurity",
  knownHosts: "connectionSecurity",
  quickCommands: "quickCommands",
  privacy: "dataPrivacy",
  backups: "dataPrivacy",
  trash: "dataPrivacy",
  advanced: "advanced",
  about: "about",
};

const CATEGORY_TABS: Partial<
  Record<SettingsCategory, { key: SettingsSection; title: string }[]>
> = {
  general: [
    { key: "terminal", title: "终端" },
    { key: "files", title: "文件管理" },
    { key: "monitor", title: "服务器监控" },
  ],
  connectionSecurity: [
    { key: "connection", title: "连接默认值" },
    { key: "proxies", title: "代理" },
    { key: "sshKeys", title: "密钥" },
    { key: "knownHosts", title: "已知主机" },
  ],
  dataPrivacy: [
    { key: "privacy", title: "隐私与清理" },
    { key: "backups", title: "备份与恢复" },
    { key: "trash", title: "回收站" },
  ],
};

const SECTIONS_WITH_SETTINGS_FOOTER = new Set<SettingsSection>([
  "terminal",
  "files",
  "monitor",
  "connection",
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
  const [updateAvailable, setUpdateAvailable] = useState(
    () =>
      applicationUpdater.canInstallUpdates &&
      readApplicationUpdateNotice() !== null,
  );

  useEffect(() => {
    document.title = "设置";
    let disposed = false;
    void loadConfiguration()
      .then((configuration) => {
        if (disposed) return;
        setSettings(configuration.settings);
        setSavedSettings(configuration.settings);
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
        setUpdateAvailable(
          applicationUpdater.canInstallUpdates && notice !== null,
        );
      }),
    [],
  );

  useEffect(() => {
    void configureDiagnosticLogging(savedSettings.diagnosticLogLevel).catch(
      () => undefined,
    );
  }, [savedSettings.diagnosticLogLevel]);

  const updateSetting = <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const configuration = await updateAppSettings(settings);
      setSettings(configuration.settings);
      setSavedSettings(configuration.settings);
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

  const activeCategory = SECTION_CATEGORY[activeSection];
  const categoryTabs = CATEGORY_TABS[activeCategory];

  const content = (() => {
    switch (activeSection) {
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
          <AdvancedSettings
            settings={settings}
            updateSetting={updateSetting}
          />
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
        return <AboutSettings />;
      default:
        return null;
    }
  })();

  const pageContent = categoryTabs ? (
    <Tabs
      activeTab={activeSection}
      animation={false}
      className="settings-category-tabs"
      destroyOnHide
      headerPadding={false}
      onChange={(key) => setActiveSection(key as SettingsSection)}
      size="small"
      type="capsule"
    >
      {categoryTabs.map((tab) => (
        <Tabs.TabPane key={tab.key} title={tab.title}>
          {activeSection === tab.key ? content : null}
        </Tabs.TabPane>
      ))}
    </Tabs>
  ) : (
    content
  );

  return (
    <main className="settings-window">
      <aside className="settings-sidebar">
        <Menu
          onClickMenuItem={(key) =>
            setActiveSection(
              CATEGORY_DEFAULT_SECTION[key as SettingsCategory],
            )
          }
          selectedKeys={[activeCategory]}
        >
          <Menu.Item key="general">
            <IconApps />
            常规
          </Menu.Item>
          <Menu.Item key="connectionSecurity">
            <IconThunderbolt />
            连接与安全
          </Menu.Item>
          <Menu.Item key="quickCommands">
            <IconCommand />
            快捷命令
          </Menu.Item>
          <Menu.Item key="dataPrivacy">
            <IconHistory />
            数据与隐私
          </Menu.Item>
          <Menu.Item key="advanced">
            <IconTool />
            高级
          </Menu.Item>
          <Menu.Item key="about">
            <IconInfoCircle />
            <Badge count={updateAvailable ? 1 : 0} dot>
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
