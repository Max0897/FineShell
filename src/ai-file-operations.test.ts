import { describe, expect, test } from "bun:test";
import {
  aiFileOperationApplyRequest,
  aiFileOperationLineSummary,
  aiFileOperationRollbackRequest,
  aiFileOperationToolResult,
  createAiFileOperationProposal,
  markAiFileOperationApplied,
  markAiFileOperationRolledBack,
} from "./ai-file-operations";
import type { AiRemoteFileContext } from "./ai-utils";

const FILE: AiRemoteFileContext = {
  content: "port=80\n",
  name: "app.conf",
  path: "/etc/app.conf",
  size: 8,
};

function operationCall(argumentsValue: Record<string, unknown>) {
  return {
    id: `call-${String(argumentsValue.operation)}`,
    name: "propose_file_operation",
    arguments: JSON.stringify(argumentsValue),
  };
}

describe("AI file operation proposals", () => {
  test("allows creates only in the selected current directory", () => {
    const proposal = createAiFileOperationProposal(
      operationCall({
        operation: "create",
        path: "/etc/worker.conf",
        content: "enabled=true\n",
      }),
      [FILE],
      "/etc",
      "session-1",
    );
    expect(proposal).toMatchObject({
      operation: "create",
      path: "/etc/worker.conf",
      status: "pending",
    });
    expect(() =>
      createAiFileOperationProposal(
        operationCall({
          operation: "create",
          path: "/tmp/worker.conf",
          content: "enabled=true\n",
        }),
        [FILE],
        "/etc",
        "session-1",
      ),
    ).toThrow("当前远程目录");
  });

  test("requires complete selected files for rename and delete", () => {
    const renamed = createAiFileOperationProposal(
      operationCall({
        operation: "rename",
        path: FILE.path,
        target_path: "/etc/app.old.conf",
      }),
      [FILE],
      null,
      "session-1",
    );
    expect(renamed.originalFile).toEqual(FILE);
    expect(renamed.targetPath).toBe("/etc/app.old.conf");

    const deleted = createAiFileOperationProposal(
      operationCall({ operation: "delete", path: FILE.path }),
      [FILE],
      null,
      "session-1",
    );
    expect(deleted.originalFile).toEqual(FILE);
    expect(() =>
      createAiFileOperationProposal(
        operationCall({ operation: "delete", path: "/etc/unknown.conf" }),
        [FILE],
        "/etc",
        "session-1",
      ),
    ).toThrow("完整文件上下文");
  });

  test("rejects unsafe paths, existing rename targets, and extra arguments", () => {
    expect(() =>
      createAiFileOperationProposal(
        operationCall({
          operation: "rename",
          path: FILE.path,
          target_path: "/etc/../tmp/app.conf",
        }),
        [FILE],
        "/etc",
        "session-1",
      ),
    ).toThrow("相对路径");
    expect(() =>
      createAiFileOperationProposal(
        operationCall({
          operation: "rename",
          path: FILE.path,
          target_path: "/etc/worker.conf",
        }),
        [FILE, { ...FILE, name: "worker.conf", path: "/etc/worker.conf" }],
        "/etc",
        "session-1",
      ),
    ).toThrow("冲突");
    expect(() =>
      createAiFileOperationProposal(
        operationCall({
          operation: "delete",
          path: FILE.path,
          unexpected: true,
        }),
        [FILE],
        "/etc",
        "session-1",
      ),
    ).toThrow("无效的删除");
  });

  test("builds conflict-checked apply and inverse rollback requests", () => {
    const proposal = createAiFileOperationProposal(
      operationCall({
        operation: "rename",
        path: FILE.path,
        target_path: "/etc/app.old.conf",
      }),
      [FILE],
      "/etc",
      "session-1",
    );
    expect(aiFileOperationApplyRequest(proposal)).toEqual({
      expectedContent: FILE.content,
      operation: "rename",
      path: FILE.path,
      targetPath: "/etc/app.old.conf",
    });
    const applied = markAiFileOperationApplied(
      proposal,
      {
        file: { ...FILE, name: "app.old.conf", path: "/etc/app.old.conf" },
      },
      "2026-07-28T01:00:00.000Z",
    );
    expect(aiFileOperationRollbackRequest(applied)).toEqual({
      expectedContent: FILE.content,
      operation: "rename",
      path: "/etc/app.old.conf",
      targetPath: FILE.path,
    });
    expect(
      markAiFileOperationRolledBack(
        applied,
        "2026-07-28T02:00:00.000Z",
      ).status,
    ).toBe("rolled-back");
  });

  test("summarizes create/delete changes and records review-only tool results", () => {
    const created = createAiFileOperationProposal(
      operationCall({
        operation: "create",
        path: "/etc/worker.conf",
        content: "one\ntwo\n",
      }),
      [],
      "/etc",
      "session-1",
    );
    expect(aiFileOperationLineSummary(created)).toEqual({
      addedLines: 2,
      removedLines: 0,
    });
    expect(aiFileOperationToolResult(operationCall({})).content).toContain(
      "尚未执行",
    );
  });
});
