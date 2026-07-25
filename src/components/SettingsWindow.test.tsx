import { describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsWindow from "./SettingsWindow";

describe("SettingsWindow", () => {
  test("groups settings into six primary menu entries", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const view = render(<SettingsWindow />);

    await screen.findByRole("tab", { name: "终端" });
    expect(screen.queryByRole("heading", { name: "终端" })).toBeNull();
    const menuItems = Array.from(
      view.container.querySelectorAll(".settings-sidebar .arco-menu-item"),
    ).map((item) => item.textContent?.trim());
    expect(menuItems).toEqual([
      "常规",
      "连接与安全",
      "快捷命令",
      "数据与隐私",
      "高级",
      "关于",
    ]);

    expect(screen.getByRole("tab", { name: "文件管理" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "服务器监控" })).not.toBeNull();

    await user.click(screen.getByText("连接与安全"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "连接默认值" })).not.toBeNull(),
    );
    expect(
      screen.queryByRole("heading", { name: "连接默认值" }),
    ).toBeNull();
    expect(screen.getByRole("tab", { name: "代理" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "密钥" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "已知主机" })).not.toBeNull();

    await user.click(screen.getByText("数据与隐私"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "隐私与清理" })).not.toBeNull(),
    );
    expect(
      screen.queryByRole("heading", { name: "隐私与清理" }),
    ).toBeNull();
    expect(screen.getByRole("tab", { name: "备份与恢复" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "回收站" })).not.toBeNull();
  });

});
