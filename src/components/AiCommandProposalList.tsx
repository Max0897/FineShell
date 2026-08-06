import { useState } from "react";
import {
  Button,
  Modal,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconCommand,
  IconCopy,
  IconDown,
  IconRight,
  IconRobot,
} from "@arco-design/web-react/icon";
import {
  aiCommandRiskColor,
  type AiCommandProposal,
  type AiCommandRecord,
} from "../ai-command-proposals";
import AiApprovalActions from "./AiApprovalActions";

interface AiCommandProposalListProps {
  canInsertCommand: boolean;
  hasRecentTerminalOutput: boolean;
  hostName: string;
  onAnalyze: (proposal: AiCommandProposal) => void;
  onCopy: (command: string) => void | Promise<void>;
  onCopyAll: (proposals: AiCommandProposal[]) => void | Promise<void>;
  onApprove: (proposal: AiCommandProposal) => void | Promise<void>;
  onReject: (proposalId: string) => unknown | Promise<unknown>;
  onRevise: (
    proposal: AiCommandProposal,
    feedback: string,
  ) => void | Promise<void>;
  presentation?: "approval" | "timeline";
  proposals?: AiCommandProposal[];
  queueCount?: number;
  records?: AiCommandRecord[];
  sending: boolean;
  sessionId: string | null;
}

function proposalStatus(proposal: AiCommandProposal) {
  if (proposal.executionPhase === "connecting") {
    return { color: "blue", label: "连接中" };
  }
  if (proposal.executionPhase === "running") {
    return { color: "orange", label: "执行中" };
  }
  if (proposal.executionPhase === "cancelling") {
    return { color: "orange", label: "取消中" };
  }
  if (proposal.executionPhase === "interrupted") {
    return { color: "gray", label: "已中断" };
  }
  const { status } = proposal;
  if (status === "verified") return { color: "green", label: "已分析" };
  if (status === "succeeded") return { color: "green", label: "执行成功" };
  if (status === "failed") return { color: "red", label: "执行失败" };
  if (status === "unavailable") return { color: "gray", label: "结果不可用" };
  if (status === "executed") return { color: "orange", label: "已提交" };
  if (status === "approved") return { color: "blue", label: "已同意" };
  if (status === "rejected") return { color: "gray", label: "已拒绝" };
  return { color: "blue", label: "待确认" };
}

function recordStatus(status: AiCommandRecord["status"]) {
  if (status === "verified") return { color: "green", label: "已分析" };
  if (status === "succeeded") return { color: "green", label: "执行成功" };
  if (status === "failed") return { color: "red", label: "执行失败" };
  if (status === "unavailable") return { color: "gray", label: "结果不可用" };
  if (status === "executed") return { color: "orange", label: "已提交" };
  if (status === "approved") return { color: "blue", label: "已同意" };
  if (status === "rejected") return { color: "gray", label: "已拒绝" };
  return { color: "gray", label: "未执行" };
}

function riskLabel(risk: AiCommandRecord["risk"]) {
  if (risk === "danger") return "高风险";
  if (risk === "caution") return "需确认";
  return "低风险";
}

function AiCommandProposalList({
  canInsertCommand,
  hasRecentTerminalOutput,
  hostName,
  onAnalyze,
  onCopy,
  onCopyAll,
  onApprove,
  onReject,
  onRevise,
  presentation = "timeline",
  proposals = [],
  queueCount = proposals.length,
  records = [],
  sending,
  sessionId,
}: AiCommandProposalListProps) {
  const [collapsedOutputs, setCollapsedOutputs] = useState<Set<string>>(
    () => new Set(),
  );
  const [fullOutputProposalId, setFullOutputProposalId] = useState<
    string | null
  >(null);
  if (!proposals.length && !records.length) return null;

  if (!proposals.length) {
    return (
      <div className="ai-command-records">
        <div className="ai-command-proposals-heading">
          <span>
            <Typography.Text bold>命令提案记录</Typography.Text>
            <Typography.Text type="secondary">未保存完整命令</Typography.Text>
          </span>
        </div>
        {records.map((record) => {
          const status = recordStatus(record.status);
          return (
            <div className="ai-command-record" key={record.id}>
              <IconCommand />
              <Typography.Text ellipsis title={record.purpose}>
                {record.purpose}
              </Typography.Text>
              <Tag color={aiCommandRiskColor(record.risk)} size="small">
                {riskLabel(record.risk)}
              </Tag>
              <Tag color={status.color} size="small">
                {status.label}
              </Tag>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={`ai-command-proposals ai-command-proposals-${presentation}`}
    >
      <div className="ai-command-proposals-heading">
        <span>
          <Typography.Text bold>
            {presentation === "approval" ? "需要审批" : "终端执行记录"}
          </Typography.Text>
          <Typography.Text type="secondary">
            {presentation === "approval"
              ? queueCount > 1
                ? `当前 1 条 · 后续 ${queueCount - 1} 条`
                : "终端命令"
              : `${proposals.length} 条`}
          </Typography.Text>
        </span>
        {presentation === "timeline" && proposals.length > 1 && (
          <Button
            icon={<IconCopy />}
            onClick={() => void onCopyAll(proposals)}
            size="mini"
            type="text"
          >
            复制全部
          </Button>
        )}
      </div>
      {proposals.map((proposal, proposalIndex) => {
        const sameSession = proposal.sessionId === sessionId;
        const status = proposalStatus(proposal);
        const hasCapturedResult =
          (proposal.status === "succeeded" || proposal.status === "failed") &&
          proposal.resultOutput !== undefined;
        const canAnalyze =
          hasCapturedResult ||
          (proposal.status === "executed" && hasRecentTerminalOutput);
        const hasOutput =
          proposal.resultOutput !== undefined ||
          proposal.outputStreamsSeparated;
        const outputCollapsed = collapsedOutputs.has(proposal.id);
        const hasFullOutput =
          proposal.resultOutputTruncated === true ||
          proposal.resultStdoutTruncated === true ||
          proposal.resultStderrTruncated === true ||
          (proposal.fullResultOutput !== undefined &&
            proposal.fullResultOutput !== proposal.resultOutput) ||
          (proposal.fullResultStdout !== undefined &&
            proposal.fullResultStdout !== proposal.resultStdout) ||
          (proposal.fullResultStderr !== undefined &&
            proposal.fullResultStderr !== proposal.resultStderr);
        return (
          <div className="ai-command-proposal" key={proposal.id}>
            <div className="ai-command-proposal-heading">
              <span className="ai-command-proposal-title">
                {presentation === "timeline" && (
                  <span className="ai-command-proposal-index">
                    {proposalIndex + 1}
                  </span>
                )}
                <Typography.Text bold>{proposal.purpose}</Typography.Text>
              </span>
              <span className="ai-command-proposal-tags">
                <Tag
                  color={aiCommandRiskColor(proposal.assessment.risk)}
                  size="small"
                >
                  {proposal.assessment.label}
                </Tag>
                {(presentation === "timeline" ||
                  proposal.status !== "pending") && (
                  <Tag color={status.color} size="small">
                    {status.label}
                  </Tag>
                )}
              </span>
            </div>
            <pre className="ai-command-proposal-command">
              <code>{proposal.command}</code>
            </pre>
            <div className="ai-command-proposal-context">
              <Typography.Text type="secondary">
                {hostName}
                {proposal.directory ? ` · ${proposal.directory}` : ""}
              </Typography.Text>
              {proposal.assessment.reason &&
                proposal.assessment.risk !== "safe" && (
                  <Typography.Text
                    type={
                      proposal.assessment.risk === "danger"
                        ? "error"
                        : "secondary"
                    }
                  >
                    {proposal.assessment.reason}
                  </Typography.Text>
                )}
            </div>
            {presentation === "approval" &&
              (proposal.status === "pending" ? (
                <AiApprovalActions
                  approvalKey={proposal.id}
                  approveDisabled={!canInsertCommand || !sameSession}
                  approveTooltip={
                    !sameSession
                      ? "该提案属于其他终端会话"
                      : canInsertCommand
                        ? "审批后立即通过后台 SSH 执行"
                        : "当前终端会话未连接"
                  }
                  feedbackPlaceholder="输入其他处理要求，例如：改为只检查状态，不重启服务"
                  leading={
                    <Tooltip content="复制命令">
                      <Button
                        aria-label="复制命令提案"
                        icon={<IconCopy />}
                        onClick={() => void onCopy(proposal.command)}
                        size="mini"
                        type="text"
                      />
                    </Tooltip>
                  }
                  onApprove={() => onApprove(proposal)}
                  onReject={() => onReject(proposal.id)}
                  onRevise={(feedback) => onRevise(proposal, feedback)}
                />
              ) : proposal.status === "executed" ||
                proposal.status === "succeeded" ||
                proposal.status === "failed" ? (
                <Tooltip
                  content={
                    !sameSession
                      ? "请切换到提交该命令的终端会话"
                      : hasCapturedResult
                        ? "将该命令的退出码和有界输出加入下一次提问"
                        : canAnalyze
                          ? "将最近终端输出加入下一次提问"
                          : "暂无可分析的命令输出"
                  }
                >
                  <Button
                    disabled={sending || !sameSession || !canAnalyze}
                    icon={<IconRobot />}
                    onClick={() => onAnalyze(proposal)}
                    size="mini"
                    type="text"
                  >
                    分析结果
                  </Button>
                </Tooltip>
              ) : null)}
            {(proposal.status === "succeeded" ||
              proposal.status === "failed" ||
              (proposal.status === "verified" &&
                proposal.exitCode !== undefined)) && (
              <Typography.Text
                className="ai-command-proposal-result"
                type={proposal.exitCode === 0 ? "success" : "error"}
              >
                退出码 {proposal.exitCode ?? "-"}
                {proposal.durationMs !== undefined
                  ? ` · ${(proposal.durationMs / 1000).toFixed(1)} 秒`
                  : ""}
                {proposal.resultOutputTruncated ? " · 输出已截断" : ""}
              </Typography.Text>
            )}
            {hasOutput && (
              <div className="ai-command-proposal-output">
                <div className="ai-command-proposal-output-heading">
                  <Button
                    aria-expanded={!outputCollapsed}
                    aria-label={
                      outputCollapsed ? "展开命令输出" : "收起命令输出"
                    }
                    icon={outputCollapsed ? <IconRight /> : <IconDown />}
                    onClick={() =>
                      setCollapsedOutputs((current) => {
                        const next = new Set(current);
                        if (next.has(proposal.id)) next.delete(proposal.id);
                        else next.add(proposal.id);
                        return next;
                      })
                    }
                    size="mini"
                    type="text"
                  >
                    命令输出
                  </Button>
                  {hasFullOutput && (
                    <Button
                      onClick={() => setFullOutputProposalId(proposal.id)}
                      size="mini"
                      type="text"
                    >
                      查看完整输出
                    </Button>
                  )}
                </div>
                {!outputCollapsed && (
                  <div className="ai-command-proposal-output-streams">
                    {proposal.outputStreamsSeparated ? (
                      <>
                        {proposal.resultStdout && (
                          <section>
                            <pre className="ai-command-proposal-live-output">
                              <code>{proposal.resultStdout}</code>
                            </pre>
                          </section>
                        )}
                        {proposal.resultStderr && (
                          <section className="ai-command-output-stderr">
                            <pre className="ai-command-proposal-live-output">
                              <code>{proposal.resultStderr}</code>
                            </pre>
                          </section>
                        )}
                        {!proposal.resultStdout && !proposal.resultStderr && (
                          <pre className="ai-command-proposal-live-output">
                            <code>（命令未产生输出）</code>
                          </pre>
                        )}
                      </>
                    ) : (
                      <pre className="ai-command-proposal-live-output">
                        <code>
                          {proposal.resultOutput || "（命令未产生输出）"}
                        </code>
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
            {proposal.status === "unavailable" && (
              <Typography.Text
                className="ai-command-proposal-warning"
                type="secondary"
              >
                {proposal.resultUnavailableReason ??
                  "无法可靠获取命令结束边界或退出码"}
              </Typography.Text>
            )}
          </div>
        );
      })}
      <Modal
        className="ai-command-output-modal"
        footer={null}
        onCancel={() => setFullOutputProposalId(null)}
        title="完整命令输出"
        visible={fullOutputProposalId !== null}
      >
        {(() => {
          const proposal = proposals.find(
            (item) => item.id === fullOutputProposalId,
          );
          if (!proposal) return null;
          return (
            <div className="ai-command-full-output">
              {(proposal.resultOutputTruncated ||
                proposal.resultStdoutTruncated ||
                proposal.resultStderrTruncated) && (
                <Typography.Text type="secondary">
                  输出超过后台采集上限，以下为已捕获的最近内容。
                </Typography.Text>
              )}
              {proposal.outputStreamsSeparated ? (
                <>
                  <section>
                    <Typography.Text bold>标准输出</Typography.Text>
                    <pre>{proposal.fullResultStdout || "（无标准输出）"}</pre>
                  </section>
                  <section className="ai-command-output-stderr">
                    <Typography.Text bold>错误输出</Typography.Text>
                    <pre>{proposal.fullResultStderr || "（无错误输出）"}</pre>
                  </section>
                </>
              ) : (
                <section>
                  <Typography.Text bold>命令输出</Typography.Text>
                  <pre>{proposal.fullResultOutput || "（命令未产生输出）"}</pre>
                </section>
              )}
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

export default AiCommandProposalList;
