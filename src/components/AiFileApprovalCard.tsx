import { useEffect, useState } from "react";
import { Button, Input, Space, Tag, Typography } from "@arco-design/web-react";
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
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [feedback, setFeedback] = useState("");
  const proposalId = editProposal?.id ?? operationProposal?.id;

  useEffect(() => {
    setFeedback("");
    setFeedbackVisible(false);
  }, [proposalId]);

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
          {editProposal ? <IconFile /> : operationIcon(operationProposal!.operation)}
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
      {feedbackVisible && (
        <Input
          autoFocus
          disabled={applying}
          maxLength={1_000}
          onChange={setFeedback}
          onPressEnter={() => {
            if (feedback.trim()) void onRevise(feedback.trim());
          }}
          placeholder="说明希望如何调整"
          value={feedback}
        />
      )}
      <div className="ai-file-approval-actions">
        <Button disabled={applying} onClick={onOpenReview} type="text">
          查看差异
        </Button>
        <Space size="small">
          {feedbackVisible ? (
            <>
              <Button
                disabled={applying}
                onClick={() => setFeedbackVisible(false)}
                type="text"
              >
                取消
              </Button>
              <Button
                disabled={!feedback.trim() || applying}
                onClick={() => void onRevise(feedback.trim())}
                type="primary"
              >
                提交
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={applying}
                onClick={() => setFeedbackVisible(true)}
                type="text"
              >
                其他
              </Button>
              <Button disabled={applying} onClick={onReject} type="text">
                驳回
              </Button>
              <Button
                loading={applying}
                onClick={() => void onApprove()}
                type="primary"
              >
                同意
              </Button>
            </>
          )}
        </Space>
      </div>
    </div>
  );
}

export default AiFileApprovalCard;
