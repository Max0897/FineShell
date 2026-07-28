import { describe, expect, test } from "bun:test";
import {
  aiFileEditDiff,
  aiFileEditEligibilityError,
  aiFileEditLineSummary,
  aiFileEditRollbackEligibilityError,
  aiFileEditToolResult,
  createAiFileEditProposal,
  markAiFileEditApplied,
  markAiFileEditRolledBack,
  proposedFileContentError,
} from "./ai-file-edits";
import {
  aiRemoteFileContextSource,
  buildAiContextPayload,
  type AiRemoteFileContext,
} from "./ai-utils";

const FILE: AiRemoteFileContext = {
  content: "port=80\n",
  name: "app.conf",
  path: "/etc/app.conf",
  size: 8,
};

describe("AI file edit proposals", () => {
  test("allows proposals only when the complete safe file is in context", () => {
    const source = aiRemoteFileContextSource(FILE);
    const context = buildAiContextPayload([source], [source.id], 4_000);
    expect(aiFileEditEligibilityError(FILE, context, 4_000)).toBeNull();
    expect(aiFileEditEligibilityError(FILE, context.slice(0, -1), 4_000)).toContain(
      "未完整加入",
    );
    const longFile = { ...FILE, content: "x".repeat(2_000), size: 2_000 };
    const truncatedContext = buildAiContextPayload(
      [aiRemoteFileContextSource(longFile)],
      [aiRemoteFileContextSource(longFile).id],
      400,
    );
    expect(aiFileEditEligibilityError(longFile, truncatedContext, 400)).toContain(
      "未完整加入",
    );
    expect(
      aiFileEditEligibilityError(
        { ...FILE, content: "password=secret\n" },
        context,
        4_000,
      ),
    ).toContain("只能分析");
  });

  test("parses a proposal only for the exact selected remote path", () => {
    const proposal = createAiFileEditProposal(
      {
        id: "call-1",
        name: "propose_file_edit",
        arguments: JSON.stringify({
          path: FILE.path,
          content: "port=8080\n",
        }),
      },
      FILE,
      "session-1",
    );
    expect(proposal).toMatchObject({
      content: "port=8080\n",
      id: "call-1",
      sessionId: "session-1",
      status: "pending",
    });
    expect(() =>
      createAiFileEditProposal(
        {
          id: "call-2",
          name: "propose_file_edit",
          arguments: JSON.stringify({
            path: "/etc/other.conf",
            content: "port=8080\n",
          }),
        },
        FILE,
        "session-1",
      ),
    ).toThrow("当前上下文不一致");
  });

  test("matches proposals against any eligible file in a batch", () => {
    const secondFile = {
      content: "enabled=false\n",
      name: "worker.conf",
      path: "/etc/worker.conf",
      size: 14,
    };
    const proposal = createAiFileEditProposal(
      {
        id: "call-batch",
        name: "propose_file_edit",
        arguments: JSON.stringify({
          path: secondFile.path,
          content: "enabled=true\n",
        }),
      },
      [FILE, secondFile],
      "session-1",
    );
    expect(proposal.originalFile.path).toBe(secondFile.path);
  });

  test("evaluates completeness independently across multiple file sources", () => {
    const longFile = {
      content: "x".repeat(2_000),
      name: "large.conf",
      path: "/etc/large.conf",
      size: 2_000,
    };
    const smallFile = {
      content: "enabled=true\n",
      name: "small.conf",
      path: "/etc/small.conf",
      size: 13,
    };
    const sources = [
      aiRemoteFileContextSource(longFile),
      aiRemoteFileContextSource(smallFile),
    ];
    const context = buildAiContextPayload(
      sources,
      sources.map((source) => source.id),
      500,
    );
    expect(aiFileEditEligibilityError(longFile, context, 500)).toContain(
      "未完整加入",
    );
    expect(aiFileEditEligibilityError(smallFile, context, 500)).toBeNull();
  });

  test("rejects unchanged, binary, and oversized replacement content", () => {
    expect(proposedFileContentError(FILE.content, FILE.content)).toContain(
      "相同",
    );
    expect(proposedFileContentError("a\0b", FILE.content)).toContain("二进制");
    expect(proposedFileContentError("x".repeat(60_001), FILE.content)).toContain(
      "60000",
    );
  });

  test("creates bounded diff parts and a result that never claims a write", () => {
    expect(aiFileEditDiff("port=80\n", "port=8080\n")).toEqual([
      { count: 1, kind: "removed", value: "port=80\n" },
      { count: 1, kind: "added", value: "port=8080\n" },
    ]);
    const result = aiFileEditToolResult({
      id: "call-1",
      name: "propose_file_edit",
      arguments: "{}",
    });
    expect(result.content).toContain("尚未写入远程文件");
  });

  test("keeps both snapshots so applied changes can be rolled back safely", () => {
    const proposal = createAiFileEditProposal(
      {
        id: "call-rollback",
        name: "propose_file_edit",
        arguments: JSON.stringify({
          path: FILE.path,
          content: "port=8080\n",
        }),
      },
      FILE,
      "session-1",
    );
    const applied = markAiFileEditApplied(
      proposal,
      "port=8080\n",
      { ...FILE, content: "port=8080\n", size: 10 },
      "2026-07-28T01:00:00.000Z",
    );
    expect(applied.originalFile.content).toBe("port=80\n");
    expect(applied.appliedFile?.content).toBe("port=8080\n");
    expect(aiFileEditRollbackEligibilityError(applied)).toBeNull();

    const rolledBack = markAiFileEditRolledBack(
      applied,
      "2026-07-28T02:00:00.000Z",
    );
    expect(rolledBack.status).toBe("rolled-back");
    expect(rolledBack.originalFile.content).toBe("port=80\n");
    expect(aiFileEditRollbackEligibilityError(rolledBack)).toContain("没有可回滚");
    expect(() =>
      markAiFileEditApplied(
        proposal,
        "port=8080\n",
        { ...FILE, path: "/etc/other.conf", content: "port=8080\n" },
        "2026-07-28T01:00:00.000Z",
      ),
    ).toThrow("写入结果");
  });

  test("summarizes changed lines without persisting file contents", () => {
    expect(
      aiFileEditLineSummary(
        "port=80\nenabled=false\n",
        "port=8080\nenabled=true\n",
      ),
    ).toEqual({ addedLines: 2, removedLines: 2 });
  });
});
