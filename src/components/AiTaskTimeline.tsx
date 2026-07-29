import { useState } from "react";
import { Button, Tag, Typography } from "@arco-design/web-react";
import {
  IconCheckCircle,
  IconDown,
  IconExclamationCircle,
  IconRight,
} from "@arco-design/web-react/icon";
import type {
  AgentActionState,
  AgentTask,
  AgentVerificationStatus,
} from "../tauri-protocol";

function taskStatus(status: AgentTask["status"]) {
  if (status === "completed") return { color: "green", label: "已完成" };
  if (status === "failed") return { color: "red", label: "失败" };
  if (status === "cancelled") return { color: "gray", label: "已取消" };
  if (status === "awaiting_approval") {
    return { color: "orange", label: "等待审批" };
  }
  if (status === "awaiting_user_input") {
    return { color: "orange", label: "等待输入" };
  }
  if (status === "verifying") return { color: "arcoblue", label: "验证中" };
  if (status === "paused_disconnected") {
    return { color: "orange", label: "等待重连" };
  }
  if (status === "paused") return { color: "gray", label: "已暂停" };
  return { color: "arcoblue", label: "执行中" };
}

function actionStatus(status: AgentActionState["status"]) {
  if (status === "pending") return { color: "orange", label: "等待审阅" };
  if (status === "approved") return { color: "arcoblue", label: "已批准" };
  if (status === "running") return { color: "arcoblue", label: "执行中" };
  if (status === "succeeded") return { color: "green", label: "已执行" };
  if (status === "rolling_back") return { color: "orange", label: "回滚中" };
  if (status === "rolled_back") return { color: "green", label: "已回滚" };
  if (status === "rejected") return { color: "gray", label: "已拒绝" };
  if (status === "cancelled") return { color: "gray", label: "已取消" };
  return { color: "red", label: "失败" };
}

function verificationStatus(status: AgentVerificationStatus) {
  if (status === "verified") return { color: "green", label: "已验证" };
  if (status === "partial") return { color: "orange", label: "部分验证" };
  if (status === "failed") return { color: "red", label: "验证失败" };
  if (status === "unverified") return { color: "gray", label: "未验证" };
  if (status === "not_applicable") return { color: "gray", label: "无需验证" };
  return { color: "arcoblue", label: "等待验证" };
}

function actionLabel(action: AgentActionState) {
  if (action.tool === "propose_file_edit") return "文件修改";
  if (action.tool === "propose_file_operation") return "文件操作";
  if (action.tool === "insert_terminal_command") return "填入终端";
  return "受控动作";
}

function recoveryLabel(action: AgentActionState) {
  const recovery = action.recoveryState;
  if (!recovery) return null;
  const recommendation = recovery.recommendation === "rollback"
    ? "建议回滚"
    : recovery.recommendation === "retry"
      ? "建议修复重试"
      : "建议人工检查";
  const status = recovery.status === "verified"
    ? "恢复已验证"
    : recovery.status === "running"
      ? "恢复中"
      : recovery.status === "failed"
        ? "恢复失败"
        : recovery.status === "unverified"
          ? "恢复未验证"
          : recommendation;
  return { status, summary: recovery.summary };
}

interface AiTaskTimelineProps {
  task?: AgentTask;
}

function AiTaskTimeline({ task }: AiTaskTimelineProps) {
  const [expanded, setExpanded] = useState(true);
  if (!task) return null;

  const status = taskStatus(task.status);
  const actionCount = task.actions.length;
  const stepCount = task.plan?.steps.length ?? 0;

  return (
    <section className="ai-task-timeline" aria-label="AI 任务时间线">
      <div className="ai-task-timeline-heading">
        <Button
          aria-label={expanded ? "收起任务时间线" : "展开任务时间线"}
          icon={expanded ? <IconDown /> : <IconRight />}
          onClick={() => setExpanded((current) => !current)}
          size="mini"
          type="text"
        />
        <Typography.Text ellipsis title={task.objective}>
          当前任务
        </Typography.Text>
        <Typography.Text type="secondary">
          {stepCount ? `${stepCount} 个步骤` : "处理中"}
          {actionCount ? ` · ${actionCount} 个动作` : ""}
        </Typography.Text>
        <Tag color={status.color} size="small">{status.label}</Tag>
      </div>
      {expanded && (
        <div className="ai-task-timeline-body">
          {task.plan?.steps.length ? (
            <div className="ai-task-timeline-section">
              <Typography.Text type="secondary">计划</Typography.Text>
              {task.plan.steps.map((step) => (
                <div className="ai-task-timeline-row" key={step.id}>
                  <span className={`ai-task-timeline-dot is-${step.status}`} />
                  <Typography.Text ellipsis title={step.title}>
                    {step.title}
                  </Typography.Text>
                  <Tag size="small">
                    {step.status === "completed"
                      ? "已完成"
                      : step.status === "in_progress"
                        ? "执行中"
                        : step.status === "failed"
                          ? "失败"
                          : step.status === "skipped"
                            ? "已跳过"
                            : step.optional
                              ? "可选"
                              : "待执行"}
                  </Tag>
                </div>
              ))}
            </div>
          ) : null}
          {task.actions.length ? (
            <div className="ai-task-timeline-section">
              <Typography.Text type="secondary">审批、工件与验证</Typography.Text>
              {task.actions.map((action) => {
                const execution = actionStatus(action.status);
                const verification = verificationStatus(action.verificationStatus);
                const recovery = recoveryLabel(action);
                const latestEvidence = action.verificationEvidence[
                  action.verificationEvidence.length - 1
                ];
                return (
                  <div className="ai-task-action" key={action.id}>
                    <div className="ai-task-timeline-row">
                      {verification.color === "green"
                        ? <IconCheckCircle className="is-success" />
                        : verification.color === "red"
                          ? <IconExclamationCircle className="is-error" />
                          : <span className="ai-task-timeline-dot is-pending" />}
                      <Typography.Text ellipsis title={action.reason}>
                        {actionLabel(action)} · {action.reason}
                      </Typography.Text>
                      <Tag color={execution.color} size="small">
                        {execution.label}
                      </Tag>
                      <Tag color={verification.color} size="small">
                        {verification.label}
                      </Tag>
                    </div>
                    {(latestEvidence || recovery) && (
                      <Typography.Text className="ai-task-action-detail" type="secondary">
                        {latestEvidence?.summary}
                        {recovery ? (
                          <>
                            {latestEvidence ? " · " : ""}
                            {recovery.status}: {recovery.summary}
                          </>
                        ) : null}
                      </Typography.Text>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          {task.result && (
            <div className="ai-task-result">
              <Typography.Text>{task.result.summary}</Typography.Text>
              <Tag
                color={verificationStatus(task.result.verificationStatus).color}
                size="small"
              >
                {verificationStatus(task.result.verificationStatus).label}
              </Tag>
            </div>
          )}
          {task.repairAttempts > 0 && (
            <Typography.Text className="ai-task-repair-count" type="secondary">
              已修复 {task.repairAttempts} / {task.repairLimit} 次
            </Typography.Text>
          )}
        </div>
      )}
    </section>
  );
}

export default AiTaskTimeline;
