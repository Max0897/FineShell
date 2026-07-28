import { useEffect, useState } from "react";
import {
  aiFileEditRollbackEligibilityError,
  markAiFileEditApplied,
  markAiFileEditRolledBack,
  proposedFileContentError,
  type AiFileEditProposal,
} from "../ai-file-edits";
import {
  aiFileOperationApplyRequest,
  aiFileOperationDisplayName,
  aiFileOperationLabel,
  aiFileOperationRollbackEligibilityError,
  aiFileOperationRollbackRequest,
  markAiFileOperationApplied,
  markAiFileOperationRolledBack,
  type AiFileOperationExecutionRequest,
  type AiFileOperationProposal,
  type AiFileOperationResult,
} from "../ai-file-operations";
import type { AiRemoteFileContext } from "../ai-utils";
import { commandErrorMessage } from "../tauri-protocol";
import type { AiMessage } from "./useAiConversations";

export interface AiFileChangeConfirmation {
  content: string;
  okText: string;
  onConfirm: () => void | Promise<void>;
  title: string;
}

export type AiFileChangeNotice = "error" | "success" | "warning";

interface FileEditReviewState {
  content: string;
  messageId: string;
  proposalId: string;
}

interface FileOperationReviewState {
  messageId: string;
  proposalId: string;
}

interface UseAiFileChangeWorkflowOptions {
  messages: AiMessage[];
  onApplyRemoteFileEdit: (
    sessionId: string,
    file: AiRemoteFileContext,
    content: string,
  ) => Promise<AiRemoteFileContext>;
  onApplyRemoteFileOperation: (
    sessionId: string,
    request: AiFileOperationExecutionRequest,
  ) => Promise<AiFileOperationResult>;
  onConfirm: (confirmation: AiFileChangeConfirmation) => void;
  onNotice: (type: AiFileChangeNotice, content: string) => void;
  sessionId: string | null;
  updateFileEditProposal: (
    messageId: string,
    proposalId: string,
    update: (proposal: AiFileEditProposal) => AiFileEditProposal,
  ) => unknown;
  updateFileOperationProposal: (
    messageId: string,
    proposalId: string,
    update: (proposal: AiFileOperationProposal) => AiFileOperationProposal,
  ) => unknown;
}

type ApplyResult = "applied" | "conflict" | "failed";
type RollbackResult = "rolled-back" | "conflict" | "failed";

function isFileOperationConflict(message: string) {
  return (
    message.includes("远程文件已被其他程序修改") ||
    message.includes("远程目标已存在")
  );
}

export function useAiFileChangeWorkflow({
  messages,
  onApplyRemoteFileEdit,
  onApplyRemoteFileOperation,
  onConfirm,
  onNotice,
  sessionId,
  updateFileEditProposal,
  updateFileOperationProposal,
}: UseAiFileChangeWorkflowOptions) {
  const [applying, setApplying] = useState(false);
  const [fileEditReview, setFileEditReview] =
    useState<FileEditReviewState | null>(null);
  const [fileOperationReview, setFileOperationReview] =
    useState<FileOperationReviewState | null>(null);

  const reviewedFileEditProposal = fileEditReview
    ? messages
        .find((message) => message.id === fileEditReview.messageId)
        ?.fileEditProposals?.find(
          (proposal) => proposal.id === fileEditReview.proposalId,
        )
    : undefined;
  const reviewedFileEditError = reviewedFileEditProposal
    ? proposedFileContentError(
        fileEditReview?.content ?? "",
        reviewedFileEditProposal.originalFile.content,
      )
    : "文件修改建议已不可用";
  const reviewedFileOperationProposal = fileOperationReview
    ? messages
        .find((message) => message.id === fileOperationReview.messageId)
        ?.fileOperationProposals?.find(
          (proposal) => proposal.id === fileOperationReview.proposalId,
        )
    : undefined;

  useEffect(() => {
    setFileEditReview(null);
    setFileOperationReview(null);
  }, [sessionId]);

  const openFileEditReview = (
    messageId: string,
    proposal: AiFileEditProposal,
  ) => {
    updateFileEditProposal(messageId, proposal.id, (current) => ({
      ...current,
      reviewed: true,
    }));
    setFileEditReview({
      content: proposal.content,
      messageId,
      proposalId: proposal.id,
    });
  };

  const openFileOperationReview = (
    messageId: string,
    proposal: AiFileOperationProposal,
  ) => {
    updateFileOperationProposal(messageId, proposal.id, (current) => ({
      ...current,
      reviewed: true,
    }));
    setFileOperationReview({ messageId, proposalId: proposal.id });
  };

  const closeFileEditReview = () => {
    if (!applying) setFileEditReview(null);
  };

  const closeFileOperationReview = () => {
    if (!applying) setFileOperationReview(null);
  };

  const setFileEditReviewContent = (content: string) => {
    setFileEditReview((current) =>
      current ? { ...current, content } : current,
    );
  };

  const applyFileEditProposal = async (
    messageId: string,
    proposal: AiFileEditProposal,
    content: string,
  ): Promise<ApplyResult> => {
    try {
      const updatedFile = await onApplyRemoteFileEdit(
        proposal.sessionId,
        proposal.originalFile,
        content,
      );
      updateFileEditProposal(messageId, proposal.id, (current) =>
        markAiFileEditApplied(
          current,
          content,
          updatedFile,
          new Date().toISOString(),
        ),
      );
      return "applied";
    } catch (error) {
      const message = commandErrorMessage(error);
      const conflict = message.includes("远程文件已被其他程序修改");
      updateFileEditProposal(messageId, proposal.id, (current) => ({
        ...current,
        error: message,
        status: conflict ? "conflict" : "failed",
      }));
      return conflict ? "conflict" : "failed";
    }
  };

  const rollbackFileEditProposal = async (
    messageId: string,
    proposal: AiFileEditProposal,
  ): Promise<RollbackResult> => {
    if (aiFileEditRollbackEligibilityError(proposal) || !proposal.appliedFile) {
      return "failed";
    }
    try {
      await onApplyRemoteFileEdit(
        proposal.sessionId,
        proposal.appliedFile,
        proposal.originalFile.content,
      );
      updateFileEditProposal(messageId, proposal.id, (current) =>
        markAiFileEditRolledBack(current, new Date().toISOString()),
      );
      return "rolled-back";
    } catch (error) {
      const message = commandErrorMessage(error);
      const conflict = message.includes("远程文件已被其他程序修改");
      updateFileEditProposal(messageId, proposal.id, (current) => ({
        ...current,
        rollbackError: conflict
          ? "远端内容在应用后又发生变化，已阻止回滚"
          : message,
      }));
      return conflict ? "conflict" : "failed";
    }
  };

  const applyFileOperationProposal = async (
    messageId: string,
    proposal: AiFileOperationProposal,
  ): Promise<ApplyResult> => {
    try {
      const result = await onApplyRemoteFileOperation(
        proposal.sessionId,
        aiFileOperationApplyRequest(proposal),
      );
      updateFileOperationProposal(messageId, proposal.id, (current) =>
        markAiFileOperationApplied(current, result, new Date().toISOString()),
      );
      return "applied";
    } catch (error) {
      const message = commandErrorMessage(error);
      const conflict = isFileOperationConflict(message);
      updateFileOperationProposal(messageId, proposal.id, (current) => ({
        ...current,
        error: message,
        status: conflict ? "conflict" : "failed",
      }));
      return conflict ? "conflict" : "failed";
    }
  };

  const rollbackFileOperationProposal = async (
    messageId: string,
    proposal: AiFileOperationProposal,
  ): Promise<RollbackResult> => {
    if (aiFileOperationRollbackEligibilityError(proposal)) return "failed";
    try {
      await onApplyRemoteFileOperation(
        proposal.sessionId,
        aiFileOperationRollbackRequest(proposal),
      );
      updateFileOperationProposal(messageId, proposal.id, (current) =>
        markAiFileOperationRolledBack(current, new Date().toISOString()),
      );
      return "rolled-back";
    } catch (error) {
      const message = commandErrorMessage(error);
      const conflict = isFileOperationConflict(message);
      updateFileOperationProposal(messageId, proposal.id, (current) => ({
        ...current,
        rollbackError: conflict
          ? "远端文件在应用后又发生变化，已阻止回滚"
          : message,
      }));
      return conflict ? "conflict" : "failed";
    }
  };

  const applyReviewedFileEdit = async () => {
    if (
      !fileEditReview ||
      !reviewedFileEditProposal ||
      reviewedFileEditProposal.status !== "pending" ||
      reviewedFileEditError ||
      applying
    ) {
      return;
    }
    setApplying(true);
    const result = await applyFileEditProposal(
      fileEditReview.messageId,
      reviewedFileEditProposal,
      fileEditReview.content,
    );
    setApplying(false);
    if (result === "applied") {
      setFileEditReview(null);
      onNotice(
        "success",
        `已更新 ${reviewedFileEditProposal.originalFile.name}`,
      );
    } else if (result === "conflict") {
      setFileEditReview(null);
      onNotice("error", "远程文件已变化，请重新发送给 AI");
    } else {
      onNotice("error", "文件修改应用失败，请查看错误信息");
    }
  };

  const applyReviewedFileOperation = async () => {
    if (
      !fileOperationReview ||
      !reviewedFileOperationProposal ||
      reviewedFileOperationProposal.status !== "pending" ||
      applying
    ) {
      return;
    }
    setApplying(true);
    const result = await applyFileOperationProposal(
      fileOperationReview.messageId,
      reviewedFileOperationProposal,
    );
    setApplying(false);
    setFileOperationReview(null);
    if (result === "applied") {
      onNotice(
        "success",
        `已${aiFileOperationLabel(reviewedFileOperationProposal.operation)} ${aiFileOperationDisplayName(reviewedFileOperationProposal)}`,
      );
    } else if (result === "conflict") {
      onNotice("warning", "远端文件状态已变化，未执行操作");
    } else {
      onNotice("error", "文件操作失败，请查看错误信息");
    }
  };

  const confirmRollbackFileEdit = (
    messageId: string,
    proposal: AiFileEditProposal,
  ) => {
    onConfirm({
      content:
        "将恢复应用 AI 修改前的文件内容。若远端文件之后又被修改，本次回滚会自动停止。",
      okText: "确认回滚",
      onConfirm: async () => {
        if (applying) return;
        setApplying(true);
        const result = await rollbackFileEditProposal(messageId, proposal);
        setApplying(false);
        if (result === "rolled-back") {
          onNotice("success", `已回滚 ${proposal.originalFile.name}`);
        } else if (result === "conflict") {
          onNotice("warning", "远端文件已有新修改，未执行回滚");
        } else {
          onNotice("error", "文件回滚失败，请查看错误信息");
        }
      },
      title: `回滚 ${proposal.originalFile.name}？`,
    });
  };

  const confirmRollbackFileOperation = (
    messageId: string,
    proposal: AiFileOperationProposal,
  ) => {
    onConfirm({
      content:
        "将恢复这次文件操作前的状态。若远端文件之后又发生变化，本次回滚会自动停止。",
      okText: "确认回滚",
      onConfirm: async () => {
        setApplying(true);
        const result = await rollbackFileOperationProposal(messageId, proposal);
        setApplying(false);
        if (result === "rolled-back") {
          onNotice("success", "文件操作已回滚");
        } else if (result === "conflict") {
          onNotice("warning", "远端文件已有新变化，未执行回滚");
        } else {
          onNotice("error", "文件操作回滚失败");
        }
      },
      title: `回滚${aiFileOperationLabel(proposal.operation)}？`,
    });
  };

  const confirmApplyAllFileEdits = (
    messageId: string,
    proposals: AiFileEditProposal[],
  ) => {
    const pending = proposals.filter((proposal) => proposal.status === "pending");
    if (!pending.length || pending.some((proposal) => !proposal.reviewed)) return;
    onConfirm({
      content: `将依次写入 ${pending.length} 个远程文件。每个文件仍会单独检查远端内容是否变化。`,
      okText: "应用全部",
      onConfirm: async () => {
        setApplying(true);
        const results: ApplyResult[] = [];
        try {
          for (const proposal of pending) {
            results.push(
              await applyFileEditProposal(
                messageId,
                proposal,
                proposal.content,
              ),
            );
          }
        } finally {
          setApplying(false);
        }
        const applied = results.filter((result) => result === "applied").length;
        const conflicts = results.filter((result) => result === "conflict").length;
        const failed = results.length - applied - conflicts;
        if (applied) onNotice("success", `已更新 ${applied} 个远程文件`);
        if (conflicts || failed) {
          onNotice(
            "warning",
            `未应用 ${conflicts + failed} 个文件${conflicts ? `，其中 ${conflicts} 个远端内容已变化` : ""}`,
          );
        }
      },
      title: "应用全部文件修改？",
    });
  };

  const confirmRollbackAllFileEdits = (
    messageId: string,
    proposals: AiFileEditProposal[],
  ) => {
    const applied = proposals.filter(
      (proposal) => proposal.status === "applied" && proposal.appliedFile,
    );
    if (!applied.length) return;
    onConfirm({
      content: `将依次恢复 ${applied.length} 个文件的应用前内容。若远端文件在应用后又被修改，对应文件会跳过回滚。`,
      okText: "回滚已应用",
      onConfirm: async () => {
        setApplying(true);
        const results: RollbackResult[] = [];
        try {
          for (const proposal of applied) {
            results.push(await rollbackFileEditProposal(messageId, proposal));
          }
        } finally {
          setApplying(false);
        }
        const rolledBack = results.filter(
          (result) => result === "rolled-back",
        ).length;
        const conflicts = results.filter((result) => result === "conflict").length;
        const failed = results.length - rolledBack - conflicts;
        if (rolledBack) {
          onNotice("success", `已回滚 ${rolledBack} 个远程文件`);
        }
        if (conflicts || failed) {
          onNotice(
            "warning",
            `未回滚 ${conflicts + failed} 个文件${conflicts ? `，其中 ${conflicts} 个远端内容已变化` : ""}`,
          );
        }
      },
      title: "回滚这组文件变更？",
    });
  };

  const confirmApplyAllFileOperations = (
    messageId: string,
    proposals: AiFileOperationProposal[],
  ) => {
    const pending = proposals.filter((proposal) => proposal.status === "pending");
    if (!pending.length || pending.some((proposal) => !proposal.reviewed)) return;
    onConfirm({
      content: `将依次执行 ${pending.length} 个远程文件操作，每项都会单独检查冲突。`,
      okText: "应用全部",
      onConfirm: async () => {
        setApplying(true);
        const results: ApplyResult[] = [];
        try {
          for (const proposal of pending) {
            results.push(await applyFileOperationProposal(messageId, proposal));
          }
        } finally {
          setApplying(false);
        }
        const applied = results.filter((result) => result === "applied").length;
        if (applied) onNotice("success", `已执行 ${applied} 个文件操作`);
        if (applied !== results.length) {
          onNotice(
            "warning",
            `有 ${results.length - applied} 个文件操作未执行`,
          );
        }
      },
      title: "应用全部文件操作？",
    });
  };

  const confirmRollbackAllFileOperations = (
    messageId: string,
    proposals: AiFileOperationProposal[],
  ) => {
    const applied = proposals.filter((proposal) => proposal.status === "applied");
    if (!applied.length) return;
    onConfirm({
      content: `将按相反顺序恢复 ${applied.length} 个已应用操作，并逐项检查冲突。`,
      okText: "回滚已应用",
      onConfirm: async () => {
        setApplying(true);
        const results: RollbackResult[] = [];
        try {
          for (const proposal of [...applied].reverse()) {
            results.push(
              await rollbackFileOperationProposal(messageId, proposal),
            );
          }
        } finally {
          setApplying(false);
        }
        const rolledBack = results.filter(
          (result) => result === "rolled-back",
        ).length;
        if (rolledBack) {
          onNotice("success", `已回滚 ${rolledBack} 个文件操作`);
        }
        if (rolledBack !== results.length) {
          onNotice(
            "warning",
            `有 ${results.length - rolledBack} 个文件操作未回滚`,
          );
        }
      },
      title: "回滚这组文件操作？",
    });
  };

  return {
    applying,
    applyReviewedFileEdit,
    applyReviewedFileOperation,
    closeFileEditReview,
    closeFileOperationReview,
    confirmApplyAllFileEdits,
    confirmApplyAllFileOperations,
    confirmRollbackAllFileEdits,
    confirmRollbackAllFileOperations,
    confirmRollbackFileEdit,
    confirmRollbackFileOperation,
    fileEditReview,
    fileOperationReview,
    openFileEditReview,
    openFileOperationReview,
    reviewedFileEditError,
    reviewedFileEditProposal,
    reviewedFileOperationProposal,
    setFileEditReviewContent,
  };
}
