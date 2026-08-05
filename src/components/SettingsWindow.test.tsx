import { describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsWindow from "./SettingsWindow";

describe("SettingsWindow", () => {
  test("moves grouped setting pages into sidebar submenus", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const view = render(<SettingsWindow />);

    await screen.findByRole("heading", { name: "终端" });
    expect(screen.queryByRole("tab")).toBeNull();
    const submenuHeaders = Array.from(
      view.container.querySelectorAll(
        ".settings-sidebar .arco-menu-inline-header",
      ),
    ).map((item) => item.textContent?.trim());
    expect(submenuHeaders).toEqual(["常规", "连接与安全", "数据与隐私"]);
    expect(
      view.container.querySelectorAll(
        ".settings-sidebar .arco-menu-icon-suffix.is-open",
      ),
    ).toHaveLength(0);
    const menuItems = Array.from(
      view.container.querySelectorAll(".settings-sidebar .arco-menu-item"),
    ).map((item) => item.textContent?.trim());
    expect(menuItems).toEqual([
      "外观",
      "终端",
      "文件管理",
      "服务器监控",
      "连接默认值",
      "代理",
      "密钥",
      "已知主机",
      "快捷命令",
      "AI 助手",
      "隐私与清理",
      "备份与恢复",
      "回收站",
      "高级",
      "关于",
    ]);

    await user.click(screen.getByText("常规"));
    await user.click(screen.getByText("外观"));
    await screen.findByRole("heading", { name: "外观" });
    await user.click(screen.getByText("深色"));
    await waitFor(() =>
      expect(document.body.getAttribute("arco-theme")).toBe("dark"),
    );
    await user.click(screen.getByText("浅色"));
    await waitFor(() =>
      expect(document.body.hasAttribute("arco-theme")).toBe(false),
    );

    await user.click(screen.getByText("AI 助手"));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "AI 服务地址" }),
      ).not.toBeNull(),
    );
    expect(screen.getByRole("combobox", { name: "AI 模型" })).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "检测能力" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "获取 AI 模型列表",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.getByRole("checkbox", { name: "服务器状态" })).not.toBeNull();
    expect(screen.getByRole("checkbox", { name: "路由追踪" })).not.toBeNull();
    expect(screen.getByLabelText("允许 AI 生成文件变更提案")).not.toBeNull();
    expect(screen.getByLabelText("允许 AI 生成终端命令提案")).not.toBeNull();

    await user.click(screen.getByText("连接与安全"));
    await user.click(screen.getByText("连接默认值"));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "连接默认值" }),
      ).not.toBeNull(),
    );

    await user.click(screen.getByText("数据与隐私"));
    await user.click(screen.getByText("隐私与清理"));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "隐私与清理" }),
      ).not.toBeNull(),
    );

    await user.click(screen.getByText("高级"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "打开日志" })).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "打开日志目录" })).not.toBeNull();
    expect(
      screen.getByRole("combobox", { name: "诊断日志级别" }),
    ).not.toBeNull();
  });
});
