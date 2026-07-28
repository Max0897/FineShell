import {
  Alert,
  Input,
  Modal,
  Tabs,
  Typography,
} from "@arco-design/web-react";
import {
  aiFileEditDiff,
  type AiFileEditProposal,
} from "../ai-file-edits";
import {
  aiFileOperationLabel,
  type AiFileOperationProposal,
} from "../ai-file-operations";

interface AiFileChangeReviewModalsProps {
  applying: boolean;
  editContent: string;
  editError?: string | null;
  editProposal?: AiFileEditProposal;
  editVisible: boolean;
  onApplyEdit: () => void | Promise<void>;
  onApplyOperation: () => void | Promise<void>;
  onChangeEditContent: (content: string) => void;
  onCloseEdit: () => void;
  onCloseOperation: () => void;
  operationProposal?: AiFileOperationProposal;
  operationVisible: boolean;
}

function AiFileEditDiff({
  originalContent,
  proposedContent,
}: {
  originalContent: string;
  proposedContent: string;
}) {
  return (
    <div className="ai-file-edit-diff" role="region" aria-label="文件修改差异">
      {aiFileEditDiff(originalContent, proposedContent).map((part, index) => (
        <pre
          className={`ai-file-edit-diff-part ai-file-edit-diff-part-${part.kind}`}
          key={`${part.kind}-${index}`}
        >
          {part.value}
        </pre>
      ))}
    </div>
  );
}

function AiFileChangeReviewModals({
  applying,
  editContent,
  editError,
  editProposal,
  editVisible,
  onApplyEdit,
  onApplyOperation,
  onChangeEditContent,
  onCloseEdit,
  onCloseOperation,
  operationProposal,
  operationVisible,
}: AiFileChangeReviewModalsProps) {
  return (
    <>
      <Modal
        className="ai-file-edit-modal"
        confirmLoading={applying}
        getPopupContainer={() => document.body}
        maskClosable={!applying}
        okButtonProps={{
          disabled:
            editProposal?.status !== "pending" || Boolean(editError),
        }}
        okText="应用修改"
        onCancel={onCloseEdit}
        onOk={() => void onApplyEdit()}
        title="审阅文件修改"
        unmountOnExit
        visible={editVisible && Boolean(editProposal)}
        style={{ width: "min(880px, calc(100vw - 64px))" }}
      >
        {editProposal && (
          <div className="ai-file-edit-review">
            <Typography.Text
              className="ai-file-edit-review-path"
              ellipsis
              title={editProposal.originalFile.path}
            >
              {editProposal.originalFile.path}
            </Typography.Text>
            <Alert
              content="只有点击“应用修改”才会写入远程文件；若远程内容已经变化，本次写入会被阻止。"
              type="warning"
            />
            <Tabs defaultActiveTab="diff" type="capsule">
              <Tabs.TabPane key="diff" title="差异">
                <AiFileEditDiff
                  originalContent={editProposal.originalFile.content}
                  proposedContent={editContent}
                />
              </Tabs.TabPane>
              <Tabs.TabPane key="edit" title="调整内容">
                <Input.TextArea
                  aria-label="调整建议文件内容"
                  className="ai-file-edit-editor"
                  onChange={onChangeEditContent}
                  value={editContent}
                />
              </Tabs.TabPane>
            </Tabs>
            {editError && (
              <Typography.Text type="error">{editError}</Typography.Text>
            )}
          </div>
        )}
      </Modal>
      <Modal
        className="ai-file-edit-modal"
        confirmLoading={applying}
        getPopupContainer={() => document.body}
        maskClosable={!applying}
        okButtonProps={{
          disabled: operationProposal?.status !== "pending",
        }}
        okText="应用操作"
        onCancel={onCloseOperation}
        onOk={() => void onApplyOperation()}
        title="审阅文件操作"
        unmountOnExit
        visible={operationVisible && Boolean(operationProposal)}
        style={{ width: "min(760px, calc(100vw - 64px))" }}
      >
        {operationProposal && (
          <div className="ai-file-edit-review">
            <Typography.Text
              className="ai-file-edit-review-path"
              ellipsis
              title={
                operationProposal.targetPath
                  ? `${operationProposal.path} → ${operationProposal.targetPath}`
                  : operationProposal.path
              }
            >
              {aiFileOperationLabel(operationProposal.operation)}：
              {operationProposal.targetPath
                ? `${operationProposal.path} → ${operationProposal.targetPath}`
                : operationProposal.path}
            </Typography.Text>
            <Alert
              content="只有点击“应用操作”才会修改远程文件；目标已存在或源文件内容变化时，操作会被阻止。"
              type={operationProposal.operation === "delete" ? "error" : "warning"}
            />
            {operationProposal.operation === "rename" ? (
              <div className="ai-file-operation-rename-preview">
                <Typography.Text type="secondary">原路径</Typography.Text>
                <Typography.Text>{operationProposal.path}</Typography.Text>
                <Typography.Text type="secondary">新路径</Typography.Text>
                <Typography.Text>{operationProposal.targetPath}</Typography.Text>
              </div>
            ) : (
              <AiFileEditDiff
                originalContent={
                  operationProposal.operation === "delete"
                    ? operationProposal.originalFile?.content ?? ""
                    : ""
                }
                proposedContent={
                  operationProposal.operation === "create"
                    ? operationProposal.content ?? ""
                    : ""
                }
              />
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

export default AiFileChangeReviewModals;
