import { useState } from "react";
import {
  Button,
  Input,
  Space,
  Tag,
  Typography,
} from "@arco-design/web-react";
import {
  IconStop,
} from "@arco-design/web-react/icon";
import type { AiDiagnosticPlan } from "../ai-diagnostic-plans";
import type { AiToolRun } from "../ai-tools";
import AiToolRunList from "./AiToolRunList";

interface AiDiagnosticPlanListProps {
  expandedRuns: ReadonlySet<string>;
  messageId: string;
  onAddToDraft: (run: AiToolRun) => void;
  onCancel: (planId: string) => unknown | Promise<unknown>;
  onConfirm: (
    planId: string,
    selectedCallIds: string[],
  ) => unknown | Promise<unknown>;
  onCopy: (run: AiToolRun) => void | Promise<void>;
  onRevise?: (planId: string, feedback: string) => unknown | Promise<unknown>;
  onStop: (planId: string) => void;
  onToggleRun: (key: string) => void;
  plans: AiDiagnosticPlan[];
  presentation?: "approval" | "timeline";
  queueCount?: number;
  runs: AiToolRun[];
  sending: boolean;
}

function planStatus(plan: AiDiagnosticPlan) {
  if (plan.status === "pending") return { color: "orange", label: "等待确认" };
  if (plan.status === "running") {
    return {
      color: "arcoblue",
      label: plan.stopRequested ? "正在停止" : "执行中",
    };
  }
  if (plan.status === "completed") return { color: "green", label: "已完成" };
  if (plan.status === "partial") return { color: "red", label: "部分完成" };
  return { color: "gray", label: "已取消" };
}

function AiDiagnosticPlanList({
  expandedRuns,
  messageId,
  onAddToDraft,
  onCancel,
  onConfirm,
  onCopy,
  onRevise,
  onStop,
  onToggleRun,
  plans,
  presentation = "timeline",
  queueCount = plans.length,
  runs,
  sending,
}: AiDiagnosticPlanListProps) {
  const [processingPlanId, setProcessingPlanId] = useState<string | null>(null);
  const [revisionPlanId, setRevisionPlanId] = useState<string | null>(null);
  const [revisionFeedback, setRevisionFeedback] = useState("");
  if (!plans.length) return null;

  const runDecision = async (
    planId: string,
    decide: () => unknown | Promise<unknown>,
  ) => {
    setProcessingPlanId(planId);
    try {
      await decide();
    } finally {
      setProcessingPlanId(null);
    }
  };

  return (
    <div
      className={`ai-diagnostic-plans ai-diagnostic-plans-${presentation}`}
    >
      {plans.map((plan) => {
        const steps = plan.stepCallIds
          .map((callId) => runs.find((run) => run.callId === callId))
          .filter((run): run is AiToolRun => Boolean(run));
        const status = planStatus(plan);
        const selectedCallIds = steps
          .filter((run) => run.status === "pending")
          .map((run) => run.callId);
        const executableCount = steps.filter(
          (run) => run.status !== "unavailable",
        ).length;
        const revising = revisionPlanId === plan.id;
        const processing = processingPlanId === plan.id;
        return (
          <section className="ai-diagnostic-plan" key={plan.id}>
            <div className="ai-diagnostic-plan-heading">
              <span>
                <Typography.Text>
                  {presentation === "approval" ? "需要审批" : "网络诊断"}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {presentation === "approval" && queueCount > 1
                    ? `当前 1 项 · 后续 ${queueCount - 1} 项`
                    : `${steps.length} 项操作`}
                </Typography.Text>
              </span>
              <Tag color={status.color} size="small">{status.label}</Tag>
            </div>
            {plan.description && (
              <Typography.Paragraph className="ai-diagnostic-plan-description">
                {plan.description}
              </Typography.Paragraph>
            )}
            {plan.status === "pending" ? (
              <div className="ai-diagnostic-plan-preview">
                {steps.map((run, index) => {
                  const unavailable = run.status === "unavailable";
                  return (
                    <div className="ai-diagnostic-plan-step" key={run.callId}>
                      <span className="ai-diagnostic-plan-step-index">
                        {index + 1}
                      </span>
                      <div className="ai-diagnostic-plan-step-content">
                        <div className="ai-diagnostic-plan-step-title">
                          <Typography.Text>{run.label}</Typography.Text>
                          {run.detail && (
                            <Typography.Text code>{run.detail}</Typography.Text>
                          )}
                          {run.detail && <Tag color="orange">主动探测</Tag>}
                          {unavailable && <Tag color="gray">权限已关闭</Tag>}
                        </div>
                        <Typography.Text type="secondary">
                          {run.reason}
                        </Typography.Text>
                      </div>
                    </div>
                  );
                })}
                {revising && (
                  <div className="ai-approval-feedback">
                    <Input
                      autoFocus
                      maxLength={1_000}
                      onChange={setRevisionFeedback}
                      onPressEnter={() => {
                        const feedback = revisionFeedback.trim();
                        if (!feedback || !onRevise) return;
                        void runDecision(plan.id, () =>
                          onRevise(plan.id, feedback),
                        );
                      }}
                      placeholder="输入其他处理要求，例如：不要探测公网，只读取本机连接"
                      value={revisionFeedback}
                    />
                    <Button
                      disabled={!revisionFeedback.trim() || processing}
                      loading={processing}
                      onClick={() => {
                        const feedback = revisionFeedback.trim();
                        if (!feedback || !onRevise) return;
                        void runDecision(plan.id, () =>
                          onRevise(plan.id, feedback),
                        );
                      }}
                      size="mini"
                      type="primary"
                    >
                      提交
                    </Button>
                  </div>
                )}
                <div className="ai-diagnostic-plan-actions">
                  <Space size={4}>
                    {onRevise && (
                      <Button
                        disabled={processing}
                        onClick={() => {
                          setRevisionPlanId((current) =>
                            current === plan.id ? null : plan.id,
                          );
                          setRevisionFeedback("");
                        }}
                        size="mini"
                        type="text"
                      >
                        其他
                      </Button>
                    )}
                    <Button
                      disabled={processing}
                      onClick={() =>
                        void runDecision(plan.id, () => onCancel(plan.id))
                      }
                      size="mini"
                      type="text"
                    >
                      驳回
                    </Button>
                  </Space>
                  <Button
                    disabled={
                      processing || !executableCount || !selectedCallIds.length
                    }
                    loading={processing}
                    onClick={() =>
                      void runDecision(plan.id, () =>
                        onConfirm(plan.id, selectedCallIds),
                      )
                    }
                    size="mini"
                    type="primary"
                  >
                    同意
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <AiToolRunList
                  expandedRuns={expandedRuns}
                  messageId={messageId}
                  onAddToDraft={onAddToDraft}
                  onCopy={onCopy}
                  onToggle={onToggleRun}
                  runs={steps}
                  sending={sending}
                />
                {plan.status === "running" && (
                  <div className="ai-diagnostic-plan-actions">
                    <Button
                      disabled={plan.stopRequested}
                      icon={<IconStop />}
                      onClick={() => onStop(plan.id)}
                      size="small"
                      type="secondary"
                    >
                      停止剩余步骤
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default AiDiagnosticPlanList;
