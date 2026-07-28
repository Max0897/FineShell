import {
  Alert,
  Button,
  Input,
  Modal,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { IconLeft, IconRight } from "@arco-design/web-react/icon";
import { useEffect, useState } from "react";
import { aiFileEditLineSummary } from "../ai-file-edits";
import {
  aiFileOperationDisplayName,
  aiFileOperationLabel,
  aiFileOperationLineSummary,
} from "../ai-file-operations";
import type { AiFileChangeReviewItem } from "../hooks/useAiFileChangeWorkflow";
import AiFileDiffView, { type AiFileDiffMode } from "./AiFileDiffView";
import { aiFileProposalStatus } from "./AiFileChangePanels";

interface AiFileChangeReviewModalsProps {
  activeKey?: AiFileChangeReviewItem["key"];
  applying: boolean;
  editContent: string;
  editError?: string | null;
  items: AiFileChangeReviewItem[];
  onApplyEdit: () => void | Promise<void>;
  onApplyOperation: () => void | Promise<void>;
  onChangeEditContent: (content: string) => void;
  onClose: () => void;
  onSelect: (key: AiFileChangeReviewItem["key"]) => void;
  visible: boolean;
}

function reviewItemPath(item: AiFileChangeReviewItem) {
  if (item.kind === "edit") return item.proposal.originalFile.path;
  return item.proposal.targetPath
    ? `${item.proposal.path} → ${item.proposal.targetPath}`
    : item.proposal.path;
}

function reviewItemName(item: AiFileChangeReviewItem) {
  return item.kind === "edit"
    ? item.proposal.originalFile.name
    : aiFileOperationDisplayName(item.proposal);
}

function reviewItemLabel(item: AiFileChangeReviewItem) {
  return item.kind === "edit"
    ? "修改文件"
    : aiFileOperationLabel(item.proposal.operation);
}

function reviewItemSummary(item: AiFileChangeReviewItem) {
  return item.kind === "edit"
    ? aiFileEditLineSummary(item.proposal.originalFile.content, item.content)
    : aiFileOperationLineSummary(item.proposal);
}

function AiFileReviewNavigator({
  activeKey,
  applying,
  items,
  onSelect,
}: {
  activeKey: AiFileChangeReviewItem["key"];
  applying: boolean;
  items: AiFileChangeReviewItem[];
  onSelect: (key: AiFileChangeReviewItem["key"]) => void;
}) {
  const activeIndex = items.findIndex((item) => item.key === activeKey);
  return (
    <nav className="ai-file-review-navigation" aria-label="文件变更导航">
      <div className="ai-file-review-navigation-heading">
        <span>
          <Typography.Text bold>变更文件</Typography.Text>
          <Typography.Text type="secondary">
            {Math.max(activeIndex + 1, 0)} / {items.length}
          </Typography.Text>
        </span>
        <Space size={2}>
          <Tooltip content="上一项">
            <Button
              aria-label="上一项"
              disabled={applying || activeIndex <= 0}
              icon={<IconLeft />}
              onClick={() => onSelect(items[activeIndex - 1].key)}
              shape="circle"
              size="mini"
              type="text"
            />
          </Tooltip>
          <Tooltip content="下一项">
            <Button
              aria-label="下一项"
              disabled={applying || activeIndex < 0 || activeIndex >= items.length - 1}
              icon={<IconRight />}
              onClick={() => onSelect(items[activeIndex + 1].key)}
              shape="circle"
              size="mini"
              type="text"
            />
          </Tooltip>
        </Space>
      </div>
      <div className="ai-file-review-navigation-list">
        {items.map((item) => {
          const status = aiFileProposalStatus(
            item.proposal.status,
            item.proposal.reviewed,
          );
          const summary = reviewItemSummary(item);
          return (
            <button
              aria-current={item.key === activeKey ? "true" : undefined}
              className="ai-file-review-navigation-item"
              disabled={applying}
              key={item.key}
              onClick={() => onSelect(item.key)}
              type="button"
            >
              <span className="ai-file-review-navigation-name">
                <strong title={reviewItemName(item)}>{reviewItemName(item)}</strong>
                <Tag color={status.color} size="small">{status.label}</Tag>
              </span>
              <span className="ai-file-review-navigation-detail">
                {reviewItemLabel(item)}
                {(summary.addedLines > 0 || summary.removedLines > 0) && (
                  <span>
                    <span className="ai-file-lines-added">+{summary.addedLines}</span>{" "}
                    <span className="ai-file-lines-removed">-{summary.removedLines}</span>
                  </span>
                )}
              </span>
              {(item.proposal.error || item.proposal.rollbackError) && (
                <span className="ai-file-review-navigation-error">
                  {item.proposal.rollbackError ?? item.proposal.error}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function AiFileChangeReviewModals({
  activeKey,
  applying,
  editContent,
  editError,
  items,
  onApplyEdit,
  onApplyOperation,
  onChangeEditContent,
  onClose,
  onSelect,
  visible,
}: AiFileChangeReviewModalsProps) {
  const [diffMode, setDiffMode] = useState<AiFileDiffMode>("unified");
  const activeItem = items.find((item) => item.key === activeKey);

  useEffect(() => {
    if (!visible) setDiffMode("unified");
  }, [visible]);

  const activeOperation = activeItem?.kind === "operation"
    ? activeItem.proposal
    : undefined;
  const canApply = activeItem?.proposal.status === "pending" &&
    (activeItem.kind !== "edit" || !editError);

  return (
    <Modal
      className="ai-file-edit-modal"
      confirmLoading={applying}
      getPopupContainer={() => document.body}
      maskClosable={!applying}
      okButtonProps={{ disabled: !canApply }}
      okText={activeItem?.kind === "operation" ? "应用操作" : "应用修改"}
      onCancel={onClose}
      onOk={() => void (
        activeItem?.kind === "operation" ? onApplyOperation() : onApplyEdit()
      )}
      title="审阅文件变更"
      unmountOnExit
      visible={visible && Boolean(activeItem)}
      style={{ width: "min(1120px, calc(100vw - 48px))" }}
    >
      {activeItem && activeKey && (
        <div className="ai-file-review-layout">
          <AiFileReviewNavigator
            activeKey={activeKey}
            applying={applying}
            items={items}
            onSelect={onSelect}
          />
          <div className="ai-file-edit-review">
            <div className="ai-file-edit-review-heading">
              <Typography.Text bold>{reviewItemLabel(activeItem)}</Typography.Text>
              <Typography.Text
                className="ai-file-edit-review-path"
                ellipsis
                title={reviewItemPath(activeItem)}
              >
                {reviewItemPath(activeItem)}
              </Typography.Text>
            </div>
            <Alert
              content={activeOperation
                ? "只有点击“应用操作”才会修改远程文件；目标已存在或源文件内容变化时，操作会被阻止。"
                : "只有点击“应用修改”才会写入远程文件；若远程内容已经变化，本次写入会被阻止。"}
              type={activeOperation?.operation === "delete" ? "error" : "warning"}
            />
            {activeItem.kind === "edit" ? (
              <Tabs defaultActiveTab="diff" key={activeItem.key} type="capsule">
                <Tabs.TabPane key="diff" title="差异">
                  <AiFileDiffView
                    mode={diffMode}
                    onChangeMode={setDiffMode}
                    originalContent={activeItem.proposal.originalFile.content}
                    path={activeItem.proposal.originalFile.path}
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
            ) : activeOperation?.operation === "rename" ? (
              <div className="ai-file-operation-rename-preview">
                <Typography.Text type="secondary">原路径</Typography.Text>
                <Typography.Text>{activeOperation.path}</Typography.Text>
                <Typography.Text type="secondary">新路径</Typography.Text>
                <Typography.Text>{activeOperation.targetPath}</Typography.Text>
              </div>
            ) : activeOperation ? (
              <AiFileDiffView
                mode={diffMode}
                onChangeMode={setDiffMode}
                originalContent={activeOperation.operation === "delete"
                  ? activeOperation.originalFile?.content ?? ""
                  : ""}
                path={activeOperation.path}
                proposedContent={activeOperation.operation === "create"
                  ? activeOperation.content ?? ""
                  : ""}
              />
            ) : null}
            {editError && activeItem.kind === "edit" && (
              <Typography.Text type="error">{editError}</Typography.Text>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default AiFileChangeReviewModals;
