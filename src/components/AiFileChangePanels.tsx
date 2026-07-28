import {
  Button,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconDelete,
  IconEdit,
  IconFile,
  IconPlus,
  IconUndo,
} from "@arco-design/web-react/icon";
import type {
  AiFileChangeRecord,
  AiFileEditProposal,
  AiFileEditProposalStatus,
} from "../ai-file-edits";
import {
  aiFileOperationDisplayName,
  aiFileOperationLabel,
  aiFileOperationLineSummary,
  type AiFileOperationProposal,
} from "../ai-file-operations";

interface AiFileChangePanelsProps {
  applying: boolean;
  changes?: AiFileChangeRecord[];
  editProposals?: AiFileEditProposal[];
  onApplyAllEdits: (proposals: AiFileEditProposal[]) => void;
  onApplyAllOperations: (proposals: AiFileOperationProposal[]) => void;
  onOpenEditReview: (proposal: AiFileEditProposal) => void;
  onOpenOperationReview: (proposal: AiFileOperationProposal) => void;
  onRejectEdit: (proposalId: string) => void;
  onRejectOperation: (proposalId: string) => void;
  onRetryEdit: (proposalId: string) => void;
  onRetryOperation: (proposalId: string) => void;
  onRollbackAllEdits: (proposals: AiFileEditProposal[]) => void;
  onRollbackAllOperations: (proposals: AiFileOperationProposal[]) => void;
  onRollbackEdit: (proposal: AiFileEditProposal) => void;
  onRollbackOperation: (proposal: AiFileOperationProposal) => void;
  operationProposals?: AiFileOperationProposal[];
}

export function aiFileProposalStatus(
  status: AiFileEditProposalStatus,
  reviewed = false,
) {
  switch (status) {
    case "applied":
      return { color: "green", label: "已应用" };
    case "rolled-back":
      return { color: "gray", label: "已回滚" };
    case "rejected":
      return { color: "gray", label: "已拒绝" };
    case "conflict":
      return { color: "orange", label: "远端已变化" };
    case "failed":
      return { color: "red", label: "应用失败" };
    default:
      return reviewed
        ? { color: "arcoblue", label: "已审阅" }
        : { color: "blue", label: "等待审阅" };
  }
}

function fileOperationIcon(operation: AiFileOperationProposal["operation"]) {
  if (operation === "create") return <IconPlus />;
  if (operation === "delete") return <IconDelete />;
  return <IconEdit />;
}

function fileChangeStatus(change: AiFileChangeRecord) {
  return change.status === "not-applied"
    ? { color: "gray", label: "未应用" }
    : aiFileProposalStatus(change.status);
}

function fileChangeLabel(change: AiFileChangeRecord) {
  if (change.operation === "create") return "新建";
  if (change.operation === "rename") return "重命名";
  if (change.operation === "delete") return "删除";
  return "修改";
}

function AiFileEditProposalPanel({
  applying,
  onApplyAll,
  onOpenReview,
  onReject,
  onRetry,
  onRollback,
  onRollbackAll,
  proposals,
}: {
  applying: boolean;
  onApplyAll: (proposals: AiFileEditProposal[]) => void;
  onOpenReview: (proposal: AiFileEditProposal) => void;
  onReject: (proposalId: string) => void;
  onRetry: (proposalId: string) => void;
  onRollback: (proposal: AiFileEditProposal) => void;
  onRollbackAll: (proposals: AiFileEditProposal[]) => void;
  proposals: AiFileEditProposal[];
}) {
  if (!proposals.length) return null;
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const applied = proposals.filter(
    (proposal) => proposal.status === "applied" && proposal.appliedFile,
  );
  const rolledBack = proposals.filter(
    (proposal) => proposal.status === "rolled-back",
  );
  const allReviewed = pending.every((proposal) => proposal.reviewed);
  const statusSummary = [
    pending.length ? `待处理 ${pending.length}` : "",
    applied.length ? `已应用 ${applied.length}` : "",
    rolledBack.length ? `已回滚 ${rolledBack.length}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="ai-file-edit-proposals">
      <div className="ai-file-edit-proposals-heading">
        <span className="ai-file-edit-proposals-summary">
          <Typography.Text bold>变更集</Typography.Text>
          <Typography.Text type="secondary">
            {proposals.length} 个文件
            {statusSummary ? ` · ${statusSummary}` : ""}
          </Typography.Text>
        </span>
        <Space size={2}>
          {pending.length > 1 && (
            <Tooltip
              content={
                allReviewed
                  ? "逐个检查冲突后应用"
                  : "请先查看每个待应用文件的差异"
              }
            >
              <Button
                disabled={!allReviewed || applying}
                onClick={() => onApplyAll(proposals)}
                size="mini"
                type="text"
              >
                应用全部
              </Button>
            </Tooltip>
          )}
          {applied.length > 1 && (
            <Button
              disabled={applying}
              icon={<IconUndo />}
              onClick={() => onRollbackAll(proposals)}
              size="mini"
              type="text"
            >
              回滚已应用
            </Button>
          )}
        </Space>
      </div>
      {proposals.map((proposal) => {
        const status = aiFileProposalStatus(proposal.status, proposal.reviewed);
        return (
          <div className="ai-file-edit-card" key={proposal.id}>
            <div className="ai-file-edit-card-icon">
              <IconFile />
            </div>
            <div className="ai-file-edit-card-main">
              <div className="ai-file-edit-card-heading">
                <Typography.Text bold>
                  {proposal.originalFile.name}
                </Typography.Text>
                <Tag color={status.color} size="small">
                  {status.label}
                </Tag>
              </div>
              <Typography.Text
                className="ai-file-edit-card-path"
                ellipsis
                title={proposal.originalFile.path}
                type="secondary"
              >
                {proposal.originalFile.path}
              </Typography.Text>
              {(proposal.error || proposal.rollbackError) && (
                <Typography.Text
                  className="ai-file-edit-card-error"
                  type="error"
                >
                  {proposal.rollbackError ?? proposal.error}
                </Typography.Text>
              )}
            </div>
            <div className="ai-file-edit-card-actions">
              {proposal.status !== "rejected" && (
                <Button
                  disabled={applying}
                  onClick={() => onOpenReview(proposal)}
                  size="mini"
                  type="text"
                >
                  查看差异
                </Button>
              )}
              {proposal.status === "pending" && (
                <Button
                  disabled={applying}
                  onClick={() => onReject(proposal.id)}
                  size="mini"
                  type="text"
                >
                  拒绝
                </Button>
              )}
              {proposal.status === "applied" && proposal.appliedFile && (
                <Button
                  disabled={applying}
                  icon={<IconUndo />}
                  onClick={() => onRollback(proposal)}
                  size="mini"
                  type="text"
                >
                  回滚
                </Button>
              )}
              {proposal.status === "failed" && (
                <Button
                  disabled={applying}
                  onClick={() => onRetry(proposal.id)}
                  size="mini"
                  type="text"
                >
                  重试
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AiFileOperationProposalPanel({
  applying,
  onApplyAll,
  onOpenReview,
  onReject,
  onRetry,
  onRollback,
  onRollbackAll,
  proposals,
}: {
  applying: boolean;
  onApplyAll: (proposals: AiFileOperationProposal[]) => void;
  onOpenReview: (proposal: AiFileOperationProposal) => void;
  onReject: (proposalId: string) => void;
  onRetry: (proposalId: string) => void;
  onRollback: (proposal: AiFileOperationProposal) => void;
  onRollbackAll: (proposals: AiFileOperationProposal[]) => void;
  proposals: AiFileOperationProposal[];
}) {
  if (!proposals.length) return null;
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const applied = proposals.filter((proposal) => proposal.status === "applied");
  const allReviewed = pending.every((proposal) => proposal.reviewed);

  return (
    <div className="ai-file-edit-proposals">
      <div className="ai-file-edit-proposals-heading">
        <span className="ai-file-edit-proposals-summary">
          <Typography.Text bold>文件操作</Typography.Text>
          <Typography.Text type="secondary">
            {proposals.length} 项
            {pending.length ? ` · 待处理 ${pending.length}` : ""}
            {applied.length ? ` · 已应用 ${applied.length}` : ""}
          </Typography.Text>
        </span>
        <Space size={2}>
          {pending.length > 1 && (
            <Tooltip
              content={
                allReviewed ? "逐项检查冲突后执行" : "请先审阅每个文件操作"
              }
            >
              <Button
                disabled={!allReviewed || applying}
                onClick={() => onApplyAll(proposals)}
                size="mini"
                type="text"
              >
                应用全部
              </Button>
            </Tooltip>
          )}
          {applied.length > 1 && (
            <Button
              disabled={applying}
              icon={<IconUndo />}
              onClick={() => onRollbackAll(proposals)}
              size="mini"
              type="text"
            >
              回滚已应用
            </Button>
          )}
        </Space>
      </div>
      {proposals.map((proposal) => {
        const status = aiFileProposalStatus(proposal.status, proposal.reviewed);
        const summary = aiFileOperationLineSummary(proposal);
        return (
          <div className="ai-file-edit-card" key={proposal.id}>
            <div className="ai-file-edit-card-icon">
              {fileOperationIcon(proposal.operation)}
            </div>
            <div className="ai-file-edit-card-main">
              <div className="ai-file-edit-card-heading">
                <Typography.Text bold>
                  {aiFileOperationLabel(proposal.operation)} ·{" "}
                  {aiFileOperationDisplayName(proposal)}
                </Typography.Text>
                <Tag color={status.color} size="small">
                  {status.label}
                </Tag>
              </div>
              <Typography.Text
                className="ai-file-edit-card-path"
                ellipsis
                title={
                  proposal.targetPath
                    ? `${proposal.path} → ${proposal.targetPath}`
                    : proposal.path
                }
                type="secondary"
              >
                {proposal.targetPath
                  ? `${proposal.path} → ${proposal.targetPath}`
                  : proposal.path}
              </Typography.Text>
              {(summary.addedLines > 0 || summary.removedLines > 0) && (
                <Typography.Text type="secondary">
                  <span className="ai-file-lines-added">
                    +{summary.addedLines}
                  </span>{" "}
                  <span className="ai-file-lines-removed">
                    -{summary.removedLines}
                  </span>
                </Typography.Text>
              )}
              {(proposal.error || proposal.rollbackError) && (
                <Typography.Text
                  className="ai-file-edit-card-error"
                  type="error"
                >
                  {proposal.rollbackError ?? proposal.error}
                </Typography.Text>
              )}
            </div>
            <div className="ai-file-edit-card-actions">
              {proposal.status !== "rejected" && (
                <Button
                  disabled={applying}
                  onClick={() => onOpenReview(proposal)}
                  size="mini"
                  type="text"
                >
                  审阅
                </Button>
              )}
              {proposal.status === "pending" && (
                <Button
                  disabled={applying}
                  onClick={() => onReject(proposal.id)}
                  size="mini"
                  type="text"
                >
                  拒绝
                </Button>
              )}
              {proposal.status === "applied" && (
                <Button
                  disabled={applying}
                  icon={<IconUndo />}
                  onClick={() => onRollback(proposal)}
                  size="mini"
                  type="text"
                >
                  回滚
                </Button>
              )}
              {proposal.status === "failed" && (
                <Button
                  disabled={applying}
                  onClick={() => onRetry(proposal.id)}
                  size="mini"
                  type="text"
                >
                  重试
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AiFileChangeHistory({ changes }: { changes: AiFileChangeRecord[] }) {
  if (!changes.length) return null;

  return (
    <div className="ai-file-change-history">
      <div className="ai-file-change-history-heading">
        <Typography.Text bold>变更记录</Typography.Text>
        <Typography.Text type="secondary">
          仅保留文件名和行数统计
        </Typography.Text>
      </div>
      {changes.map((change) => {
        const status = fileChangeStatus(change);
        const label = fileChangeLabel(change);
        const target = change.targetFileName
          ? ` → ${change.targetFileName}`
          : "";
        return (
          <div className="ai-file-change-history-item" key={change.id}>
            <IconFile />
            <Typography.Text
              ellipsis
              title={`${label} ${change.fileName}${target}`}
            >
              {label} · {change.fileName}
              {target}
            </Typography.Text>
            <Typography.Text type="secondary">
              <span className="ai-file-lines-added">+{change.addedLines}</span>{" "}
              <span className="ai-file-lines-removed">
                -{change.removedLines}
              </span>
            </Typography.Text>
            <Tag color={status.color} size="small">
              {status.label}
            </Tag>
          </div>
        );
      })}
    </div>
  );
}

function AiFileChangePanels({
  applying,
  changes = [],
  editProposals = [],
  onApplyAllEdits,
  onApplyAllOperations,
  onOpenEditReview,
  onOpenOperationReview,
  onRejectEdit,
  onRejectOperation,
  onRetryEdit,
  onRetryOperation,
  onRollbackAllEdits,
  onRollbackAllOperations,
  onRollbackEdit,
  onRollbackOperation,
  operationProposals = [],
}: AiFileChangePanelsProps) {
  return (
    <>
      <AiFileEditProposalPanel
        applying={applying}
        onApplyAll={onApplyAllEdits}
        onOpenReview={onOpenEditReview}
        onReject={onRejectEdit}
        onRetry={onRetryEdit}
        onRollback={onRollbackEdit}
        onRollbackAll={onRollbackAllEdits}
        proposals={editProposals}
      />
      <AiFileOperationProposalPanel
        applying={applying}
        onApplyAll={onApplyAllOperations}
        onOpenReview={onOpenOperationReview}
        onReject={onRejectOperation}
        onRetry={onRetryOperation}
        onRollback={onRollbackOperation}
        onRollbackAll={onRollbackAllOperations}
        proposals={operationProposals}
      />
      {!editProposals.length && !operationProposals.length && (
        <AiFileChangeHistory changes={changes} />
      )}
    </>
  );
}

export default AiFileChangePanels;
