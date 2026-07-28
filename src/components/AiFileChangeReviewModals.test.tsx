import { useState } from "react";
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AiFileChangeReviewItem } from "../hooks/useAiFileChangeWorkflow";
import AiFileChangeReviewModals from "./AiFileChangeReviewModals";

const ITEMS: AiFileChangeReviewItem[] = [
  {
    content: "const port = 8080;\n",
    key: "edit:edit-1",
    kind: "edit",
    proposal: {
      content: "const port = 8080;\n",
      id: "edit-1",
      originalFile: {
        content: "const port = 80;\n",
        name: "app.ts",
        path: "/srv/app.ts",
        size: 17,
      },
      reviewed: true,
      sessionId: "session-1",
      status: "pending",
    },
  },
  {
    key: "operation:operation-1",
    kind: "operation",
    proposal: {
      content: "export const enabled = true;\n",
      id: "operation-1",
      operation: "create",
      path: "/srv/worker.ts",
      sessionId: "session-1",
      status: "pending",
    },
  },
];

function ReviewHarness() {
  const [activeKey, setActiveKey] = useState<AiFileChangeReviewItem["key"]>(
    "edit:edit-1",
  );
  return (
    <AiFileChangeReviewModals
      activeKey={activeKey}
      applying={false}
      editContent={ITEMS[0].kind === "edit" ? ITEMS[0].content : ""}
      items={ITEMS}
      onApplyEdit={() => undefined}
      onApplyOperation={() => undefined}
      onChangeEditContent={() => undefined}
      onClose={() => undefined}
      onSelect={setActiveKey}
      visible
    />
  );
}

describe("AiFileChangeReviewModals", () => {
  test("navigates edit and operation proposals in one review session", () => {
    render(<ReviewHarness />);

    expect(screen.getByRole("navigation", { name: "文件变更导航" })).not.toBeNull();
    expect(screen.getByText("1 / 2")).not.toBeNull();
    expect(screen.getByText("已审阅")).not.toBeNull();
    expect(screen.getByText("等待审阅")).not.toBeNull();

    fireEvent.click(screen.getByText("左右"));
    fireEvent.click(screen.getByRole("button", { name: /worker\.ts/ }));

    expect(screen.getByText("2 / 2")).not.toBeNull();
    expect(document.querySelector(".ai-file-edit-review-heading")?.textContent)
      .toContain("新建文件");
    expect(screen.getByText("原文件")).not.toBeNull();
    expect(screen.getByText("建议文件")).not.toBeNull();
  });
});
