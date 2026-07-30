import { useRef, useState } from "react";
import {
  Button,
  Input,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconCommand,
  IconCopy,
  IconRobot,
} from "@arco-design/web-react/icon";
import {
  aiCommandRiskColor,
  type AiCommandProposal,
  type AiCommandRecord,
} from "../ai-command-proposals";

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

function proposalStatus(status: AiCommandProposal["status"]) {
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

function verificationLabel(proposal: AiCommandProposal) {
  const verification = proposal.verification;
  if (!verification) return null;
  if (verification.kind === "service_active") {
    return `执行后验证服务 ${verification.service} 是否处于运行状态`;
  }
  if (verification.kind === "port_listening") {
    return `执行后验证 ${verification.port}/${verification.protocol.toUpperCase()} 端口是否监听`;
  }
  return `执行后验证 ${verification.validator} 配置语法`;
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
  const [revisionProposalId, setRevisionProposalId] = useState<string | null>(
    null,
  );
  const [revisionFeedback, setRevisionFeedback] = useState("");
  const [processingProposalId, setProcessingProposalId] = useState<
    string | null
  >(null);
  const processingProposalRef = useRef<string | null>(null);

  const runDecision = async (
    proposalId: string,
    decision: () => unknown | Promise<unknown>,
  ) => {
    if (processingProposalRef.current) return;
    processingProposalRef.current = proposalId;
    setProcessingProposalId(proposalId);
    try {
      await decision();
    } finally {
      if (processingProposalRef.current === proposalId) {
        processingProposalRef.current = null;
      }
      setProcessingProposalId((current) =>
        current === proposalId ? null : current,
      );
    }
  };

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
        const status = proposalStatus(proposal.status);
        const hasCapturedResult =
          (proposal.status === "succeeded" || proposal.status === "failed") &&
          proposal.resultOutput !== undefined;
        const canAnalyze =
          hasCapturedResult ||
          (proposal.status === "executed" && hasRecentTerminalOutput);
        const verification = verificationLabel(proposal);
        const revising = revisionProposalId === proposal.id;
        const processing = processingProposalId === proposal.id;
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
                <Tag color={status.color} size="small">
                  {status.label}
                </Tag>
              </span>
            </div>
            <pre className="ai-command-proposal-command">
              <code>{proposal.command}</code>
            </pre>
            <div className="ai-command-proposal-details">
              <Typography.Text type="secondary">
                <span>执行位置</span>
                {hostName}
                {proposal.directory ? ` · ${proposal.directory}` : ""}
              </Typography.Text>
              {proposal.assessment.reason && (
                <Typography.Text
                  type={
                    proposal.assessment.risk === "danger"
                      ? "error"
                      : "secondary"
                  }
                >
                  <span>风险说明</span>
                  {proposal.assessment.reason}
                </Typography.Text>
              )}
              {verification && (
                <Typography.Text type="secondary">
                  <span>预期验证</span>
                  {verification}
                </Typography.Text>
              )}
            </div>
            {presentation === "approval" && (
            <div className="ai-command-proposal-footer">
              <Space size={4}>
                <Tooltip content="复制命令">
                  <Button
                    aria-label="复制命令提案"
                    icon={<IconCopy />}
                    onClick={() => void onCopy(proposal.command)}
                    size="mini"
                    type="text"
                  />
                </Tooltip>
                {presentation === "approval" && proposal.status === "pending" && (
                  <Button
                    disabled={processing}
                    onClick={() => {
                      setRevisionProposalId((current) =>
                        current === proposal.id ? null : proposal.id,
                      );
                      setRevisionFeedback("");
                    }}
                    size="mini"
                    type="text"
                  >
                    其他
                  </Button>
                )}
                {presentation === "approval" && proposal.status === "pending" && (
                  <Button
                    disabled={processing}
                    onClick={() =>
                      void runDecision(proposal.id, () =>
                        onReject(proposal.id),
                      )
                    }
                    size="mini"
                    type="text"
                  >
                    驳回
                  </Button>
                )}
              </Space>
              <Space size={4}>
                {presentation === "approval" && proposal.status === "pending" && (
                  <Tooltip
                    content={
                      !sameSession
                        ? "该提案属于其他终端会话"
                        : canInsertCommand
                          ? "审批后立即提交到当前终端"
                          : "当前终端会话未连接"
                    }
                  >
                    <Button
                      disabled={
                        processing ||
                        !canInsertCommand ||
                        !sameSession
                      }
                      loading={processing}
                      onClick={() =>
                        void runDecision(proposal.id, () =>
                          onApprove(proposal),
                        )
                      }
                      size="mini"
                      type="primary"
                    >
                      同意
                    </Button>
                  </Tooltip>
                )}
                {(proposal.status === "executed" ||
                  proposal.status === "succeeded" ||
                  proposal.status === "failed") && (
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
                )}
              </Space>
            </div>
            )}
            {presentation === "approval" && proposal.status === "pending" && revising && (
              <div className="ai-command-proposal-revision">
                <Input.TextArea
                  autoFocus
                  maxLength={500}
                  onChange={setRevisionFeedback}
                  placeholder="输入其他处理要求，例如：改为只检查状态，不重启服务"
                  rows={2}
                  value={revisionFeedback}
                />
                <div className="ai-command-proposal-revision-actions">
                  <Button
                    onClick={() => setRevisionProposalId(null)}
                    size="mini"
                    type="text"
                  >
                    取消
                  </Button>
                  <Button
                    disabled={
                      processing || !revisionFeedback.trim()
                    }
                    onClick={() =>
                      void runDecision(proposal.id, () =>
                        onRevise(proposal, revisionFeedback.trim()),
                      )
                    }
                    size="mini"
                    type="primary"
                  >
                    提交
                  </Button>
                </div>
              </div>
            )}
            {proposal.status === "approved" && (
              <Typography.Text
                className="ai-command-proposal-warning"
                type="secondary"
              >
                已同意，正在等待终端执行结果
              </Typography.Text>
            )}
            {proposal.status === "executed" && (
              <Typography.Text
                className="ai-command-proposal-warning"
                type="secondary"
              >
                已检测到手动提交，不代表命令执行成功
              </Typography.Text>
            )}
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
    </div>
  );
}

export default AiCommandProposalList;
