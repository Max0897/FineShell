import { useState } from "react";
import {
  Button,
  Message,
  Select,
  Space,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { IconEye, IconFolder } from "@arco-design/web-react/icon";
import type { AppSettings } from "../app-settings";
import { openDiagnosticLog, openDiagnosticLogDirectory } from "../diagnostics";

interface AdvancedSettingsProps {
  settings: AppSettings;
  updateSetting: <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => void;
}

function AdvancedSettings({ settings, updateSetting }: AdvancedSettingsProps) {
  const [openingLog, setOpeningLog] = useState<"file" | "directory" | null>(
    null,
  );

  const openLog = async (target: "file" | "directory") => {
    setOpeningLog(target);
    try {
      if (target === "file") {
        await openDiagnosticLog();
      } else {
        await openDiagnosticLogDirectory();
      }
    } catch (error) {
      Message.error(`打开日志失败：${String(error)}`);
    } finally {
      setOpeningLog(null);
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
              脱敏日志会按容量限制保存在本地，可使用系统默认程序查看
            </Typography.Text>
          </div>
          <Space size={8}>
            <Button
              icon={<IconEye />}
              loading={openingLog === "file"}
              onClick={() => void openLog("file")}
              type="primary"
            >
              打开日志
            </Button>
            <Tooltip content="打开日志目录">
              <Button
                aria-label="打开日志目录"
                icon={<IconFolder />}
                loading={openingLog === "directory"}
                onClick={() => void openLog("directory")}
              />
            </Tooltip>
          </Space>
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
      </section>
    </div>
  );
}

export default AdvancedSettings;
