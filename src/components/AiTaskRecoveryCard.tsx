import { Button, Popconfirm, Space, Typography } from "@arco-design/web-react";
import { IconExclamationCircle } from "@arco-design/web-react/icon";
import type { ReactElement } from "react";
import type { AgentTaskRecoveryDecision } from "../tauri-protocol";

interface AiTaskRecoveryCardProps {
  busyDecision?: AgentTaskRecoveryDecision;
  disconnected: boolean;
  onDecision: (decision: AgentTaskRecoveryDecision) => void;
  reason: string;
  /** A command was interrupted but its remote process may still be running. */
  remoteCommandMayBeRunning?: boolean;
  sessionAvailable: boolean;
}

export default function AiTaskRecoveryCard({
  busyDecision,
  disconnected,
  onDecision,
  reason,
  remoteCommandMayBeRunning = false,
  sessionAvailable,
}: AiTaskRecoveryCardProps) {
  const busy = busyDecision !== undefined;
  const confirmIfRunning = (
    decision: AgentTaskRecoveryDecision,
    button: ReactElement,
  ) =>
    remoteCommandMayBeRunning ? (
      <Popconfirm
        content="中断的命令可能仍在服务器上运行。确认已检查过，再继续？"
        onOk={() => onDecision(decision)}
      >
        {button}
      </Popconfirm>
    ) : (
      button
    );
  return (
    <section aria-label="中断任务恢复" className="ai-task-recovery-card">
      <div className="ai-task-recovery-copy">
        <IconExclamationCircle />
        <div>
          <Typography.Text bold>任务已中断</Typography.Text>
          <Typography.Paragraph ellipsis={{ rows: 2 }} title={reason}>
            {disconnected ? "SSH 连接中断。" : "任务未能正常结束。"}
            {reason}
          </Typography.Paragraph>
          {remoteCommandMayBeRunning && (
            <Typography.Text className="ai-task-recovery-warning" type="warning">
              中断的命令可能仍在服务器上运行，超时或取消不会结束远端进程。请先在终端确认，避免重复执行。
            </Typography.Text>
          )}
          <Typography.Text type="secondary">
            重新尝试会创建新任务；命令和文件修改仍需重新审批。
          </Typography.Text>
        </div>
      </div>
      <Space size="mini">
        {confirmIfRunning(
          "continue_analysis",
          <Button
            disabled={busy || !sessionAvailable}
            loading={busyDecision === "continue_analysis"}
            onClick={
              remoteCommandMayBeRunning
                ? undefined
                : () => onDecision("continue_analysis")
            }
            size="small"
            type="primary"
          >
            继续分析
          </Button>,
        )}
        {confirmIfRunning(
          "retry",
          <Button
            disabled={busy || !sessionAvailable}
            loading={busyDecision === "retry"}
            onClick={
              remoteCommandMayBeRunning ? undefined : () => onDecision("retry")
            }
            size="small"
          >
            重新尝试
          </Button>,
        )}
        <Button
          disabled={busy}
          loading={busyDecision === "finish"}
          onClick={() => onDecision("finish")}
          size="small"
          type="text"
        >
          结束任务
        </Button>
      </Space>
    </section>
  );
}
