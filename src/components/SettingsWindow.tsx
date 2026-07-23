import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
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
  IconCode,
  IconDashboard,
  IconDelete,
  IconCloud,
  IconSave,
  IconStorage,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import {
  DEFAULT_APP_SETTINGS,
  appSettingsEqual,
  type AppSettings,
} from "../app-settings";
import { loadConfiguration, updateAppSettings } from "../config-database";
import ConfigurationMaintenance from "./ConfigurationMaintenance";
import ProxySettings from "./ProxySettings";

type SettingsSection =
  | "terminal"
  | "files"
  | "monitor"
  | "connection"
  | "proxies"
  | "backups"
  | "trash";

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

function SettingsWindow() {
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("terminal");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [savedSettings, setSavedSettings] =
    useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
        if (!disposed) Message.error(String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

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
        await emitTo("main", "settings:changed", configuration.settings);
      }
      Message.success("设置已保存");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  const content = (() => {
    switch (activeSection) {
      case "terminal":
        return (
          <>
            <Typography.Title heading={5}>终端</Typography.Title>
            <div className="settings-group">
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
            </div>
          </>
        );
      case "files":
        return (
          <>
            <Typography.Title heading={5}>文件管理</Typography.Title>
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
            </div>
          </>
        );
      case "monitor":
        return (
          <>
            <Typography.Title heading={5}>服务器监控</Typography.Title>
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
            <Typography.Title heading={5}>连接默认值</Typography.Title>
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
      default:
        return null;
    }
  })();

  return (
    <main className="settings-window">
      <aside className="settings-sidebar">
        <Menu
          onClickMenuItem={(key) => setActiveSection(key as SettingsSection)}
          selectedKeys={[activeSection]}
        >
          <Menu.Item key="terminal">
            <IconCode />
            终端
          </Menu.Item>
          <Menu.Item key="files">
            <IconStorage />
            文件管理
          </Menu.Item>
          <Menu.Item key="monitor">
            <IconDashboard />
            服务器监控
          </Menu.Item>
          <Menu.Item key="connection">
            <IconThunderbolt />
            连接
          </Menu.Item>
          <Menu.Item key="proxies">
            <IconCloud />
            代理
          </Menu.Item>
          <Menu.Item key="backups">
            <IconSave />
            备份与恢复
          </Menu.Item>
          <Menu.Item key="trash">
            <IconDelete />
            回收站
          </Menu.Item>
        </Menu>
      </aside>
      <section className="settings-content">
        {loading ? (
          <div className="settings-loading">
            <Spin />
          </div>
        ) : (
          <div className="settings-page">{content}</div>
        )}
        {activeSection !== "proxies" &&
          activeSection !== "backups" &&
          activeSection !== "trash" && (
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
