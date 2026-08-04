import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import SftpToolbar from "./SftpToolbar";

function renderToolbar() {
  const onInputPathChange = mock(() => undefined);
  const onNavigate = mock(() => undefined);
  return {
    onInputPathChange,
    onNavigate,
    ...render(
      <SftpToolbar
        bookmarks={[]}
        clipboardEntryCount={0}
        connected
        currentPath="/var/log/nginx"
        currentPathBookmarked={false}
        history={[]}
        inputPath="/var/log/nginx"
        loading={false}
        onClearHistory={() => undefined}
        onCreate={() => undefined}
        onInputPathChange={onInputPathChange}
        onNavigate={onNavigate}
        onOpenTransfers={() => undefined}
        onPaste={() => undefined}
        onRefresh={() => undefined}
        onRemoveBookmark={() => undefined}
        onToggleBookmark={() => undefined}
        onUp={() => undefined}
        onUpload={() => undefined}
        operationLoading={false}
        pathSuggestions={[]}
        ready
        transferActivityCount={0}
      />,
    ),
  };
}

describe("SftpToolbar path navigation", () => {
  test("navigates to the directory represented by a breadcrumb item", () => {
    const { onNavigate } = renderToolbar();

    fireEvent.click(screen.getByText("var"));

    expect(onNavigate).toHaveBeenCalledWith("/var");
  });

  test("switches the trailing blank area to the full path editor", () => {
    const { onInputPathChange } = renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "编辑远程目录路径" }));

    const input = screen.getByRole("textbox", { name: "远程目录路径" });
    expect((input as HTMLInputElement).value).toBe("/var/log/nginx");
    expect(onInputPathChange).toHaveBeenCalledWith("/var/log/nginx");
  });
});
