import { describe, expect, test } from "bun:test";
import { aiFileApprovalToolResult } from "./ai-file-approvals";

const call = {
  arguments: JSON.stringify({ path: "/etc/app.conf" }),
  id: "file-1",
  name: "propose_file_edit",
};

describe("aiFileApprovalToolResult", () => {
  test("reports a completed file action to the agent", () => {
    const result = aiFileApprovalToolResult(call, {
      kind: "execution_completed",
      summary: "远程文件已更新",
    });

    expect(JSON.parse(result.content)).toEqual({
      decision: "approved_and_completed",
      message: "远程文件已更新",
      ok: true,
    });
  });

  test("preserves revision feedback", () => {
    const result = aiFileApprovalToolResult(call, {
      feedback: "保留原来的注释",
      kind: "revision_requested",
    });

    expect(JSON.parse(result.content)).toMatchObject({
      decision: "revision_requested",
      feedback: "保留原来的注释",
      ok: false,
    });
  });
});
