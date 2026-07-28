import { useState } from "react";
import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiFileEditProposal } from "../ai-file-edits";
import type {
  AiFileOperationExecutionRequest,
  AiFileOperationProposal,
  AiFileOperationResult,
} from "../ai-file-operations";
import type { AiRemoteFileContext } from "../ai-utils";
import type { AiMessage } from "./useAiConversations";
import {
  useAiFileChangeWorkflow,
  type AiFileChangeConfirmation,
} from "./useAiFileChangeWorkflow";

function remoteFile(path: string, content: string): AiRemoteFileContext {
  return {
    content,
    name: path.split("/").pop() ?? path,
    path,
    size: new TextEncoder().encode(content).length,
  };
}

function fileEditProposal(): AiFileEditProposal {
  return {
    content: "updated\n",
    id: "edit-1",
    originalFile: remoteFile("/srv/app.conf", "original\n"),
    sessionId: "session-1",
    status: "pending",
  };
}

function appliedCreateOperation(
  id: string,
  path: string,
): AiFileOperationProposal {
  return {
    appliedAt: "2026-07-28T08:00:00.000Z",
    appliedFile: remoteFile(path, `${id}\n`),
    content: `${id}\n`,
    id,
    operation: "create",
    path,
    reviewed: true,
    sessionId: "session-1",
    status: "applied",
  };
}

function assistantMessage(
  edits: AiFileEditProposal[] = [],
  operations: AiFileOperationProposal[] = [],
): AiMessage {
  return {
    content: "",
    fileEditProposals: edits,
    fileOperationProposals: operations,
    id: "assistant-1",
    role: "assistant",
  };
}

interface HarnessOptions {
  initialMessages: AiMessage[];
  onApplyRemoteFileEdit: (
    sessionId: string,
    file: AiRemoteFileContext,
    content: string,
  ) => Promise<AiRemoteFileContext>;
  onApplyRemoteFileOperation: (
    sessionId: string,
    request: {
      content?: string;
      expectedContent?: string;
      operation: "create" | "rename" | "delete";
      path: string;
      targetPath?: string;
    },
  ) => Promise<AiFileOperationResult>;
  onConfirm: (confirmation: AiFileChangeConfirmation) => void;
  onNotice: (type: "error" | "success" | "warning", content: string) => void;
}

function useWorkflowHarness(options: HarnessOptions) {
  const [messages, setMessages] = useState(options.initialMessages);
  const workflow = useAiFileChangeWorkflow({
    messages,
    onApplyRemoteFileEdit: options.onApplyRemoteFileEdit,
    onApplyRemoteFileOperation: options.onApplyRemoteFileOperation,
    onConfirm: options.onConfirm,
    onNotice: options.onNotice,
    sessionId: "session-1",
    updateFileEditProposal: (messageId, proposalId, update) =>
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                fileEditProposals: message.fileEditProposals?.map((proposal) =>
                  proposal.id === proposalId ? update(proposal) : proposal,
                ),
              }
            : message,
        ),
      ),
    updateFileOperationProposal: (messageId, proposalId, update) =>
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                fileOperationProposals: message.fileOperationProposals?.map(
                  (proposal) =>
                    proposal.id === proposalId ? update(proposal) : proposal,
                ),
              }
            : message,
        ),
      ),
  });
  return { messages, workflow };
}

function unusedOperation() {
  return Promise.resolve({ file: null });
}

describe("useAiFileChangeWorkflow", () => {
  test("applies a reviewed file edit and records the returned snapshot", async () => {
    const proposal = fileEditProposal();
    const applyEdit = mock(
      async (_sessionId: string, file: AiRemoteFileContext, content: string) =>
        remoteFile(file.path, content),
    );
    const onNotice = mock(() => undefined);
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([proposal])],
        onApplyRemoteFileEdit: applyEdit,
        onApplyRemoteFileOperation: unusedOperation,
        onConfirm: () => undefined,
        onNotice,
      }),
    );

    act(() => {
      result.current.workflow.openFileEditReview("assistant-1", proposal);
    });
    await waitFor(() =>
      expect(result.current.workflow.reviewedFileEditProposal?.reviewed).toBe(
        true,
      ),
    );
    await act(async () => {
      await result.current.workflow.applyReviewedFileEdit();
    });

    expect(applyEdit).toHaveBeenCalledWith(
      "session-1",
      proposal.originalFile,
      proposal.content,
    );
    expect(result.current.messages[0]?.fileEditProposals?.[0]).toEqual(
      expect.objectContaining({
        appliedFile: expect.objectContaining({ content: proposal.content }),
        status: "applied",
      }),
    );
    expect(result.current.workflow.fileEditReview).toBeNull();
    expect(onNotice).toHaveBeenCalledWith("success", "已更新 app.conf");
  });

  test("marks a stale remote file as conflicted without claiming success", async () => {
    const proposal = fileEditProposal();
    const applyEdit = mock(async () => {
      throw new Error("远程文件已被其他程序修改");
    });
    const onNotice = mock(() => undefined);
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([proposal])],
        onApplyRemoteFileEdit: applyEdit,
        onApplyRemoteFileOperation: unusedOperation,
        onConfirm: () => undefined,
        onNotice,
      }),
    );

    act(() => {
      result.current.workflow.openFileEditReview("assistant-1", proposal);
    });
    await waitFor(() =>
      expect(result.current.workflow.reviewedFileEditProposal).toBeDefined(),
    );
    await act(async () => {
      await result.current.workflow.applyReviewedFileEdit();
    });

    expect(result.current.messages[0]?.fileEditProposals?.[0]?.status).toBe(
      "conflict",
    );
    expect(onNotice).toHaveBeenCalledWith(
      "error",
      "远程文件已变化，请重新发送给 AI",
    );
  });

  test("rolls back applied file operations in reverse order", async () => {
    const first = appliedCreateOperation("operation-1", "/srv/one.conf");
    const second = appliedCreateOperation("operation-2", "/srv/two.conf");
    let confirmation: AiFileChangeConfirmation | undefined;
    const applyOperation = mock(
      async (
        _sessionId: string,
        _request: AiFileOperationExecutionRequest,
      ) => ({ file: null }),
    );
    const onNotice = mock(() => undefined);
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([], [first, second])],
        onApplyRemoteFileEdit: async (_sessionId, file) => file,
        onApplyRemoteFileOperation: applyOperation,
        onConfirm: (value) => {
          confirmation = value;
        },
        onNotice,
      }),
    );

    act(() => {
      result.current.workflow.confirmRollbackAllFileOperations(
        "assistant-1",
        [first, second],
      );
    });
    expect(confirmation?.title).toBe("回滚这组文件操作？");
    await act(async () => {
      await confirmation?.onConfirm();
    });

    expect(applyOperation.mock.calls.map((call) => call[1]?.path)).toEqual([
      "/srv/two.conf",
      "/srv/one.conf",
    ]);
    expect(
      result.current.messages[0]?.fileOperationProposals?.map(
        (proposal) => proposal.status,
      ),
    ).toEqual(["rolled-back", "rolled-back"]);
    expect(onNotice).toHaveBeenCalledWith("success", "已回滚 2 个文件操作");
  });
});
