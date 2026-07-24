import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ContextMenu from "./ContextMenu";

describe("ContextMenu", () => {
  test("opens resolved items and invokes the selected action", async () => {
    const onOpen = mock(() => undefined);
    render(
      <ContextMenu
        resolveItems={() => [
          { key: "open", label: "打开", onClick: onOpen },
          { key: "disabled", label: "不可用", disabled: true },
        ]}
      >
        <button type="button">文件.txt</button>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "文件.txt" }));
    const openItem = await screen.findByText("打开");
    expect(
      screen
        .getByText("不可用")
        .closest(".arco-dropdown-menu-item")
        ?.classList.contains("arco-dropdown-menu-disabled"),
    ).toBe(true);
    fireEvent.click(openItem);

    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });

  test("does not open without available items", async () => {
    render(
      <ContextMenu items={[]}>
        <button type="button">空白区域</button>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "空白区域" }));

    await waitFor(() => {
      expect(document.querySelector(".app-context-menu")).toBeNull();
    });
  });
});
