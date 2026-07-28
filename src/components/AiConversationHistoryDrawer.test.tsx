import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import AiConversationHistoryDrawer, {
  aiConversationTime,
} from "./AiConversationHistoryDrawer";

describe("AiConversationHistoryDrawer", () => {
  test("renders history and delegates item actions", () => {
    const onDelete = mock(() => undefined);
    const onExport = mock(() => undefined);
    const onRename = mock(() => undefined);
    const onSelect = mock(() => undefined);
    render(
      <AiConversationHistoryDrawer
        activeConversationId="conversation-1"
        conversations={[
          {
            id: "conversation-1",
            title: "排查负载",
            updatedAt: "2026-07-28T08:30:00.000Z",
          },
        ]}
        loading={false}
        onClose={() => undefined}
        onDelete={onDelete}
        onExport={onExport}
        onRename={onRename}
        onSelect={onSelect}
        visible
      />,
    );

    fireEvent.click(screen.getByText("排查负载"));
    fireEvent.click(screen.getByRole("button", { name: "重命名对话" }));
    fireEvent.click(screen.getByRole("button", { name: "导出对话" }));
    fireEvent.click(screen.getByRole("button", { name: "删除对话" }));

    expect(onSelect).toHaveBeenCalledWith("conversation-1");
    expect(onRename).toHaveBeenCalledWith("conversation-1");
    expect(onExport).toHaveBeenCalledWith("conversation-1");
    expect(onDelete).toHaveBeenCalledWith("conversation-1");
  });

  test("handles invalid persisted timestamps", () => {
    expect(aiConversationTime("not-a-date")).toBe("");
  });
});
