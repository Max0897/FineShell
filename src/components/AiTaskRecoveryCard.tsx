import { Button, Space, Typography } from "@arco-design/web-react";
import { IconExclamationCircle } from "@arco-design/web-react/icon";
import type { AgentTaskRecoveryDecision } from "../tauri-protocol";

interface AiTaskRecoveryCardProps {
  busyDecision?: AgentTaskRecoveryDecision;
  disconnected: boolean;
  onDecision: (decision: AgentTaskRecoveryDecision) => void;
  reason: string;
  sessionAvailable: boolean;
}

export default function AiTaskRecoveryCard({
  busyDecision,
  disconnected,
  onDecision,
  reason,
  sessionAvailable,
}: AiTaskRecoveryCardProps) {
  const busy = busyDecision !== undefined;
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
          <Typography.Text type="secondary">
            重新尝试会创建新任务；命令和文件修改仍需重新审批。
          </Typography.Text>
        </div>
      </div>
      <Space size="mini">
        <Button
          disabled={busy || !sessionAvailable}
          loading={busyDecision === "continue_analysis"}
          onClick={() => onDecision("continue_analysis")}
          size="small"
          type="primary"
        >
          继续分析
        </Button>
        <Button
          disabled={busy || !sessionAvailable}
          loading={busyDecision === "retry"}
          onClick={() => onDecision("retry")}
          size="small"
        >
          重新尝试
        </Button>
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
