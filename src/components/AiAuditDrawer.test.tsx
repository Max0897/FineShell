import { describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiAuditDrawer from "./AiAuditDrawer";

describe("AiAuditDrawer", () => {
  test("shows a unified audit list and refreshes it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const loadEntries = mock(async () => [
      {
        action: "get_server_status",
        category: "diagnostic" as const,
        conversationId: "conversation-1",
        durationMs: 120,
        hostId: "host-1",
        hostName: "生产服务器",
        id: "audit-1",
        label: "读取服务器状态",
        occurredAt: "2026-07-28T09:00:00.000Z",
        sequence: 1,
        status: "success" as const,
      },
    ]);
    render(
      <AiAuditDrawer
        loadEntries={loadEntries}
        onClose={() => undefined}
        visible
      />,
    );

    expect(await screen.findByText("读取服务器状态")).not.toBeNull();
    expect(screen.getByText("已完成")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "刷新 AI 操作审计" }));
    await waitFor(() => expect(loadEntries).toHaveBeenCalledTimes(2));
  });
});
