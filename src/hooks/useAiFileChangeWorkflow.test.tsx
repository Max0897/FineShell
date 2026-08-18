import { useState } from "react";
import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiFileEditProposal } from "../ai-file-edits";
import type { AiFileOperationProposal } from "../ai-file-operations";
import type { AiRemoteFileContext } from "../ai-utils";
import type { AiActionExecutionHandler } from "../ai-action-lifecycle";
import type { AgentActionExecutionResult } from "../tauri-protocol";
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

function fileEditProposal(
  id = "edit-1",
  path = "/srv/app.conf",
): AiFileEditProposal {
  return {
    content: "updated\n",
    id,
    originalFile: remoteFile(path, "original\n"),
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

function pendingCreateOperation(
  content: string,
): AiFileOperationProposal {
  return {
    content,
    id: "operation-pending",
    operation: "create",
    path: "/srv/generated.conf",
    sessionId: "session-1",
    status: "pending",
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
  onExecuteAction: AiActionExecutionHandler;
  onConfirm: (confirmation: AiFileChangeConfirmation) => void;
  onNotice: (type: "error" | "success" | "warning", content: string) => void;
}

function useWorkflowHarness(options: HarnessOptions) {
  const [messages, setMessages] = useState(options.initialMessages);
  const workflow = useAiFileChangeWorkflow({
    messages,
    onExecuteAction: options.onExecuteAction,
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

function executionResult(
  actionId: string,
  actionType: AgentActionExecutionResult["actionType"],
  file: AiRemoteFileContext | null,
): AgentActionExecutionResult {
  return {
    actionId,
    actionType,
    affectedPaths: file ? [file.path] : [],
    command: null,
    file: file ? { ...file, modifiedAt: null, permissions: null } : null,
  };
}

describe("useAiFileChangeWorkflow", () => {
  test("does not claim user confirmation for an automatically allowed edit", async () => {
    const proposal = fileEditProposal();
    const executeAction = mock(
      async (
        _messageId: string,
        actionId: string,
        _rollback?: boolean,
        contentOverride?: string,
      ) =>
        executionResult(
          actionId,
          "file_edit",
          remoteFile(
            proposal.originalFile.path,
            contentOverride ?? proposal.content,
          ),
        ),
    );
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([proposal])],
        onExecuteAction: executeAction,
        onConfirm: () => undefined,
        onNotice: () => undefined,
      }),
    );

    await act(async () => {
      await result.current.workflow.approveFileEditProposal(
        "assistant-1",
        proposal,
        false,
      );
    });

    expect(executeAction).toHaveBeenCalledWith(
      "assistant-1",
      proposal.id,
      false,
      proposal.content,
      false,
    );
  });

  test("applies a reviewed file edit and records the returned snapshot", async () => {
    const proposal = fileEditProposal();
    const executeAction = mock(
      async (
        _messageId: string,
        actionId: string,
        _rollback?: boolean,
        contentOverride?: string,
      ) =>
        executionResult(
          actionId,
          "file_edit",
          remoteFile(
            proposal.originalFile.path,
            contentOverride ?? proposal.content,
          ),
        ),
    );
    const onNotice = mock(() => undefined);
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([proposal])],
        onExecuteAction: executeAction,
        onConfirm: () => undefined,
        onNotice,
      }),
    );

    act(() => {
      result.current.workflow.openFileEditReview("assistant-1", proposal);
      result.current.workflow.setFileEditReviewContent("reviewed update\n");
    });
    await waitFor(() =>
      expect(result.current.workflow.reviewedFileEditProposal?.reviewed).toBe(
        true,
      ),
    );
    await act(async () => {
      await result.current.workflow.applyReviewedFileEdit();
    });

    expect(executeAction).toHaveBeenCalledWith(
      "assistant-1",
      proposal.id,
      false,
      "reviewed update\n",
    );
    expect(result.current.messages[0]?.fileEditProposals?.[0]).toEqual(
      expect.objectContaining({
        appliedFile: expect.objectContaining({ content: "reviewed update\n" }),
        status: "applied",
      }),
    );
    expect(result.current.workflow.fileChangeReview).toBeNull();
    expect(onNotice).toHaveBeenCalledWith("success", "已更新 app.conf");
  });

  test("blocks persisted redaction placeholders before executing file writes", async () => {
    const edit = {
      ...fileEditProposal(),
      content: "password=[已隐藏]\n",
    };
    const create = pendingCreateOperation("token=[已隐藏密钥]\n");
    const executeAction = mock(async () =>
      executionResult("unexpected", "file_edit", null)
    );
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([edit], [create])],
        onExecuteAction: executeAction,
        onConfirm: () => undefined,
        onNotice: () => undefined,
      }),
    );

    await act(async () => {
      await result.current.workflow.approveFileEditProposal(
        "assistant-1",
        edit,
      );
      await result.current.workflow.approveFileOperationProposal(
        "assistant-1",
        create,
      );
    });

    expect(executeAction).not.toHaveBeenCalled();
    expect(result.current.messages[0]?.fileEditProposals?.[0]).toMatchObject({
      error: expect.stringContaining("脱敏占位符"),
      status: "failed",
    });
    expect(result.current.messages[0]?.fileOperationProposals?.[0]).toMatchObject({
      error: expect.stringContaining("脱敏占位符"),
      status: "failed",
    });
  });

  test("marks a stale remote file as conflicted without claiming success", async () => {
    const proposal = fileEditProposal();
    const executeAction = mock(async () => {
      throw new Error("远程文件已被其他程序修改");
    });
    const onNotice = mock(() => undefined);
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([proposal])],
        onExecuteAction: executeAction,
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
    expect(result.current.workflow.fileChangeReview?.activeKey).toBe("edit:edit-1");
  });

  test("preserves per-file drafts while navigating a unified review", async () => {
    const first = fileEditProposal("edit-1", "/srv/one.conf");
    const second = fileEditProposal("edit-2", "/srv/two.conf");
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([first, second])],
        onExecuteAction: async (_messageId, actionId) =>
          executionResult(actionId, "file_edit", remoteFile("/srv/one.conf", "updated\n")),
        onConfirm: () => undefined,
        onNotice: () => undefined,
      }),
    );

    act(() => {
      result.current.workflow.openFileEditReview("assistant-1", first);
      result.current.workflow.setFileEditReviewContent("first draft\n");
    });
    await waitFor(() =>
      expect(result.current.workflow.reviewedFileEditContent).toBe("first draft\n"),
    );
    act(() => {
      result.current.workflow.selectFileChangeReview("edit:edit-2");
      result.current.workflow.setFileEditReviewContent("second draft\n");
    });
    await waitFor(() =>
      expect(result.current.workflow.reviewedFileEditContent).toBe("second draft\n"),
    );
    act(() => {
      result.current.workflow.selectFileChangeReview("edit:edit-1");
    });

    expect(result.current.workflow.reviewedFileEditContent).toBe("first draft\n");
    expect(
      result.current.messages[0]?.fileEditProposals?.map(
        (proposal) => proposal.reviewed,
      ),
    ).toEqual([true, true]);
  });

  test("opens the next unreviewed item after applying the current file", async () => {
    const first = fileEditProposal("edit-1", "/srv/one.conf");
    const second = fileEditProposal("edit-2", "/srv/two.conf");
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([first, second])],
        onExecuteAction: async (_messageId, actionId) =>
          executionResult(
            actionId,
            "file_edit",
            remoteFile(actionId === "edit-1" ? "/srv/one.conf" : "/srv/two.conf", "updated\n"),
          ),
        onConfirm: () => undefined,
        onNotice: () => undefined,
      }),
    );

    act(() => {
      result.current.workflow.openFileEditReview("assistant-1", first);
    });
    await waitFor(() =>
      expect(result.current.workflow.reviewedFileEditProposal?.reviewed).toBe(true),
    );
    await act(async () => {
      await result.current.workflow.applyReviewedFileEdit();
    });

    expect(result.current.workflow.fileChangeReview?.activeKey).toBe("edit:edit-2");
    expect(result.current.workflow.reviewedFileEditProposal?.id).toBe("edit-2");
    expect(result.current.workflow.reviewedFileEditProposal?.reviewed).toBe(true);
  });

  test("rolls back applied file operations in reverse order", async () => {
    const first = appliedCreateOperation("operation-1", "/srv/one.conf");
    const second = appliedCreateOperation("operation-2", "/srv/two.conf");
    let confirmation: AiFileChangeConfirmation | undefined;
    const executeAction = mock(
      async (_messageId: string, actionId: string, _rollback?: boolean) =>
        executionResult(actionId, "file_operation", null),
    );
    const onNotice = mock(() => undefined);
    const { result } = renderHook(() =>
      useWorkflowHarness({
        initialMessages: [assistantMessage([], [first, second])],
        onExecuteAction: executeAction,
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

    expect(executeAction.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["operation-2", true],
      ["operation-1", true],
    ]);
    expect(
      result.current.messages[0]?.fileOperationProposals?.map(
        (proposal) => proposal.status,
      ),
    ).toEqual(["rolled-back", "rolled-back"]);
    expect(onNotice).toHaveBeenCalledWith("success", "已回滚 2 个文件操作");
  });
});
