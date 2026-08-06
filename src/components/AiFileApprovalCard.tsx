import { Button, Tag, Typography } from "@arco-design/web-react";
import {
  IconDelete,
  IconEdit,
  IconFile,
  IconPlus,
} from "@arco-design/web-react/icon";
import {
  aiFileEditLineSummary,
  type AiFileEditProposal,
} from "../ai-file-edits";
import {
  aiFileOperationLabel,
  aiFileOperationLineSummary,
  type AiFileOperationProposal,
} from "../ai-file-operations";
import AiApprovalActions from "./AiApprovalActions";

interface AiFileApprovalCardProps {
  applying: boolean;
  editProposal?: AiFileEditProposal;
  onApprove: () => void | Promise<void>;
  onOpenReview: () => void;
  onReject: () => void | Promise<void>;
  onRevise: (feedback: string) => void | Promise<void>;
  operationProposal?: AiFileOperationProposal;
  queueCount?: number;
}

function operationIcon(operation: AiFileOperationProposal["operation"]) {
  if (operation === "create") return <IconPlus />;
  if (operation === "delete") return <IconDelete />;
  return <IconEdit />;
}

function AiFileApprovalCard({
  applying,
  editProposal,
  onApprove,
  onOpenReview,
  onReject,
  onRevise,
  operationProposal,
  queueCount = 1,
}: AiFileApprovalCardProps) {
  const proposalId = editProposal?.id ?? operationProposal?.id;

  if (!editProposal && !operationProposal) return null;
  const title = editProposal
    ? "修改远程文件"
    : `${aiFileOperationLabel(operationProposal!.operation)}远程文件`;
  const path = editProposal
    ? editProposal.originalFile.path
    : operationProposal!.targetPath
      ? `${operationProposal!.path} → ${operationProposal!.targetPath}`
      : operationProposal!.path;
  const summary = editProposal
    ? aiFileEditLineSummary(
        editProposal.originalFile.content,
        editProposal.content,
      )
    : aiFileOperationLineSummary(operationProposal!);

  return (
    <div className="ai-file-approval-card">
      <div className="ai-file-approval-heading">
        <span className="ai-file-approval-title">
          {editProposal ? (
            <IconFile />
          ) : (
            operationIcon(operationProposal!.operation)
          )}
          <Typography.Text bold>{title}</Typography.Text>
        </span>
        {queueCount > 1 && <Tag size="small">待审批 {queueCount}</Tag>}
      </div>
      <Typography.Text
        className="ai-file-approval-path"
        ellipsis
        title={path}
        type="secondary"
      >
        {path}
      </Typography.Text>
      {(summary.addedLines > 0 || summary.removedLines > 0) && (
        <Typography.Text className="ai-file-approval-summary" type="secondary">
          <span className="ai-file-lines-added">+{summary.addedLines}</span>{" "}
          <span className="ai-file-lines-removed">-{summary.removedLines}</span>
        </Typography.Text>
      )}
      <AiApprovalActions
        approvalKey={proposalId!}
        busy={applying}
        buttonSize="default"
        feedbackPlaceholder="说明希望如何调整"
        leading={
          <Button disabled={applying} onClick={onOpenReview} type="text">
            查看差异
          </Button>
        }
        onApprove={onApprove}
        onReject={onReject}
        onRevise={onRevise}
      />
    </div>
  );
}

export default AiFileApprovalCard;
