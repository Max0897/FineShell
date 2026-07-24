import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Message,
  Popconfirm,
  Select,
  Space,
  Spin,
  Typography,
} from "@arco-design/web-react";
import {
  IconDelete,
  IconDownload,
  IconRefresh,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { AppSettings } from "../app-settings";
import {
  clearDiagnosticLogs,
  exportDiagnosticLogs,
  loadDiagnosticSummary,
  type DiagnosticSummary,
} from "../diagnostics";

interface AdvancedSettingsProps {
  settings: AppSettings;
  updateSetting: <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => void;
}

const LEVEL_LABELS: Record<AppSettings["diagnosticLogLevel"], string> = {
  debug: "调试",
  info: "信息",
  warn: "警告",
  error: "错误",
};

function formatDiagnosticTime(timestamp?: number) {
  if (!timestamp) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}

function diagnosticFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `fineshell-diagnostics-${timestamp}.log`;
}

function AdvancedSettings({ settings, updateSetting }: AdvancedSettingsProps) {
  const [summary, setSummary] = useState<DiagnosticSummary>();
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [exporting, setExporting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await loadDiagnosticSummary());
    } catch (error) {
      Message.error(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearLogs = async () => {
    setClearing(true);
    try {
      await clearDiagnosticLogs();
      await refresh();
      Message.success("诊断日志已清空");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setClearing(false);
    }
  };

  const exportLogs = async () => {
    if (!isTauri()) {
      Message.warning("诊断日志导出仅支持桌面应用");
      return;
    }
    const path = await save({
      defaultPath: diagnosticFilename(),
      filters: [{ extensions: ["log"], name: "诊断日志" }],
      title: "导出诊断日志",
    });
    if (!path) return;

    setExporting(true);
    try {
      const count = await exportDiagnosticLogs(path);
      Message.success(`已导出 ${count} 条脱敏诊断日志`);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="advanced-settings">
      <Typography.Title heading={5}>高级</Typography.Title>
      <section className="advanced-section">
        <div className="advanced-section-heading">
          <div>
            <Typography.Title heading={6}>诊断日志</Typography.Title>
            <Typography.Text type="secondary">
              日志仅保存在本次运行的内存中，退出应用后自动清除
            </Typography.Text>
          </div>
          <Button
            aria-label="刷新诊断摘要"
            icon={<IconRefresh />}
            loading={loading}
            onClick={() => void refresh()}
          />
        </div>

        <div className="settings-group advanced-log-settings">
          <div className="settings-row">
            <Typography.Text>日志级别</Typography.Text>
            <div className="settings-control">
              <Select
                aria-label="诊断日志级别"
                onChange={(value) =>
                  updateSetting(
                    "diagnosticLogLevel",
                    value as AppSettings["diagnosticLogLevel"],
                  )
                }
                options={[
                  { label: "调试", value: "debug" },
                  { label: "信息", value: "info" },
                  { label: "警告", value: "warn" },
                  { label: "错误", value: "error" },
                ]}
                value={settings.diagnosticLogLevel}
              />
            </div>
          </div>
        </div>

        <Alert
          content="导出前会再次脱敏主机地址、用户名、本地路径、命令参数和凭据字段；密码、私钥及口令不会写入日志。"
          type="info"
        />

        <Spin className="diagnostic-summary-loading" loading={loading}>
          <div className="diagnostic-summary">
            <div>
              <Typography.Text type="secondary">记录</Typography.Text>
              <Typography.Text>
                {summary?.total ?? 0} / {summary?.capacity ?? 1_000}
              </Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary">错误</Typography.Text>
              <Typography.Text>{summary?.counts.error ?? 0}</Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary">警告</Typography.Text>
              <Typography.Text>{summary?.counts.warn ?? 0}</Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary">当前级别</Typography.Text>
              <Typography.Text>
                {LEVEL_LABELS[summary?.level ?? settings.diagnosticLogLevel]}
              </Typography.Text>
            </div>
          </div>
        </Spin>

        <div className="advanced-log-footer">
          <div className="diagnostic-summary-time">
            <Typography.Text type="secondary">最近记录</Typography.Text>
            <Typography.Text>
              {formatDiagnosticTime(summary?.latestAt)}
            </Typography.Text>
          </div>
          <Space className="advanced-log-actions">
            <Button
              icon={<IconDownload />}
              loading={exporting}
              onClick={() => void exportLogs()}
              type="primary"
            >
              导出日志
            </Button>
            <Popconfirm
              disabled={!summary?.total}
              onOk={() => clearLogs()}
              title="清空本次运行产生的全部诊断日志？"
            >
              <Button
                disabled={!summary?.total}
                icon={<IconDelete />}
                loading={clearing}
              >
                清空
              </Button>
            </Popconfirm>
          </Space>
        </div>
      </section>
    </div>
  );
}

export default AdvancedSettings;
