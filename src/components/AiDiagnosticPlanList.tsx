import { useState } from "react";
import {
  Button,
  Checkbox,
  Tag,
  Typography,
} from "@arco-design/web-react";
import {
  IconClose,
  IconPlayArrow,
  IconStop,
} from "@arco-design/web-react/icon";
import type { AiDiagnosticPlan } from "../ai-diagnostic-plans";
import type { AiToolRun } from "../ai-tools";
import AiToolRunList from "./AiToolRunList";

interface AiDiagnosticPlanListProps {
  expandedRuns: ReadonlySet<string>;
  messageId: string;
  onAddToDraft: (run: AiToolRun) => void;
  onCancel: (planId: string) => void;
  onConfirm: (planId: string, selectedCallIds: string[]) => void;
  onCopy: (run: AiToolRun) => void | Promise<void>;
  onRerun: (messageId: string, run: AiToolRun) => void | Promise<void>;
  onStop: (planId: string) => void;
  onToggleRun: (key: string) => void;
  plans: AiDiagnosticPlan[];
  runs: AiToolRun[];
  sending: boolean;
  sessionAvailable: boolean;
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
  onRerun,
  onStop,
  onToggleRun,
  plans,
  runs,
  sending,
  sessionAvailable,
}: AiDiagnosticPlanListProps) {
  const [excludedSteps, setExcludedSteps] = useState<Set<string>>(
    () => new Set(),
  );
  if (!plans.length) return null;

  return (
    <div className="ai-diagnostic-plans">
      {plans.map((plan, planIndex) => {
        const steps = plan.stepCallIds
          .map((callId) => runs.find((run) => run.callId === callId))
          .filter((run): run is AiToolRun => Boolean(run));
        const status = planStatus(plan);
        const selectedCallIds = steps
          .filter(
            (run) =>
              run.status === "pending" &&
              !excludedSteps.has(`${plan.id}:${run.callId}`),
          )
          .map((run) => run.callId);
        const executableCount = steps.filter(
          (run) => run.status !== "unavailable",
        ).length;
        return (
          <section className="ai-diagnostic-plan" key={plan.id}>
            <div className="ai-diagnostic-plan-heading">
              <Typography.Text>只读诊断计划 {planIndex + 1}</Typography.Text>
              <Tag color={status.color} size="small">
                {status.label}
              </Tag>
            </div>
            {plan.description && (
              <Typography.Paragraph className="ai-diagnostic-plan-description">
                {plan.description}
              </Typography.Paragraph>
            )}
            {plan.status === "pending" ? (
              <div className="ai-diagnostic-plan-preview">
                {steps.map((run, index) => {
                  const exclusionKey = `${plan.id}:${run.callId}`;
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
                      {run.optional && !unavailable && (
                        <Checkbox
                          aria-label={`执行可选步骤：${run.label}`}
                          checked={!excludedSteps.has(exclusionKey)}
                          onChange={(checked) =>
                            setExcludedSteps((current) => {
                              const next = new Set(current);
                              if (checked) next.delete(exclusionKey);
                              else next.add(exclusionKey);
                              return next;
                            })
                          }
                        >
                          可选
                        </Checkbox>
                      )}
                    </div>
                  );
                })}
                <div className="ai-diagnostic-plan-actions">
                  <Button
                    icon={<IconClose />}
                    onClick={() => onCancel(plan.id)}
                    size="small"
                    type="secondary"
                  >
                    取消计划
                  </Button>
                  <Button
                    disabled={!executableCount || !selectedCallIds.length}
                    icon={<IconPlayArrow />}
                    onClick={() => onConfirm(plan.id, selectedCallIds)}
                    size="small"
                    type="primary"
                  >
                    确认并执行
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
                  onRerun={onRerun}
                  onToggle={onToggleRun}
                  runs={steps}
                  sending={sending}
                  sessionAvailable={sessionAvailable}
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
