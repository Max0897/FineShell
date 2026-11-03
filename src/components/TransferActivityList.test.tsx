import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ExternalEditPayload } from "../tauri-protocol";
import TransferActivityList, {
  transferContextMenuItems,
  type TransferActivityRecord,
} from "./TransferActivityList";

function transfer(
  status: TransferActivityRecord["status"],
  id: string,
): TransferActivityRecord {
  return {
    sessionId: "session-1",
    transferId: id,
    direction: id === "upload" ? "upload" : "download",
    fileName: `${id}.zip`,
    transferredBytes: 512,
    totalBytes: 1024,
    status,
    localPath: `/tmp/${id}.zip`,
    remotePath: `/root/${id}.zip`,
    overwrite: false,
    sampledAt: 0,
    sampledBytes: 0,
    bytesPerSecond: 1024,
  };
}

const CONFLICT: ExternalEditPayload = {
  editId: "edit-1",
  sessionId: "session-1",
  remotePath: "/root/config.toml",
  fileName: "config.toml",
  localPath: "/tmp/config.toml",
  status: "conflict",
  error: "远程文件已修改",
};

describe("TransferActivityList", () => {
  test("renders a single empty state", () => {
    render(
      <TransferActivityList
        externalEdits={[]}
        onCancel={() => undefined}
        onOpenExternalEdit={() => undefined}
        onPause={() => undefined}
        onResolveExternalEdit={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
        transfers={[]}
      />,
    );

    expect(screen.getAllByText("暂无传输记录")).toHaveLength(1);
  });

  test("shows status-specific controls and forwards user actions", () => {
    const onPause = mock(() => undefined);
    const onResume = mock(() => undefined);
    const onCancel = mock(() => undefined);
    const onRetry = mock(() => undefined);
    const onOpenExternalEdit = mock(() => undefined);
    const onResolveExternalEdit = mock(() => undefined);
    const running = transfer("running", "upload");
    const waiting = transfer("waiting", "waiting");
    const paused = transfer("paused", "paused");
    const failed = transfer("failed", "failed");

    render(
      <TransferActivityList
        externalEdits={[CONFLICT]}
        onCancel={onCancel}
        onOpenExternalEdit={onOpenExternalEdit}
        onPause={onPause}
        onResolveExternalEdit={onResolveExternalEdit}
        onResume={onResume}
        onRetry={onRetry}
        transfers={[running, waiting, paused, failed]}
      />,
    );

    expect(screen.getByText("1.00 KB/s")).not.toBeNull();
    expect(screen.getByText("等待远程响应")).not.toBeNull();
    expect(screen.getByText("已暂停")).not.toBeNull();
    expect(screen.getByText("传输失败")).not.toBeNull();
    expect(screen.getByText("同步冲突")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "暂停 upload.zip" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停 waiting.zip" }));
    fireEvent.click(screen.getByRole("button", { name: "继续 paused.zip" }));
    fireEvent.click(screen.getByRole("button", { name: "取消 upload.zip" }));
    fireEvent.click(screen.getByRole("button", { name: "重试 failed.zip" }));
    fireEvent.click(
      screen.getByRole("button", { name: "打开 config.toml 的本地副本" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "处理 config.toml 的同步问题" }),
    );

    expect(onPause).toHaveBeenCalledWith(running);
    expect(onPause).toHaveBeenCalledWith(waiting);
    expect(onResume).toHaveBeenCalledWith(paused);
    expect(onCancel).toHaveBeenCalledWith(running);
    expect(onRetry).toHaveBeenCalledWith(failed);
    expect(onOpenExternalEdit).toHaveBeenCalledWith(CONFLICT);
    expect(onResolveExternalEdit).toHaveBeenCalledWith(CONFLICT);
  });

  test("paginates large transfer lists without rendering every row", () => {
    const transfers = Array.from({ length: 21 }, (_, index) =>
      transfer("queued", `file-${index + 1}`),
    );

    render(
      <TransferActivityList
        externalEdits={[]}
        onCancel={() => undefined}
        onOpenExternalEdit={() => undefined}
        onPause={() => undefined}
        onResolveExternalEdit={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
        transfers={transfers}
      />,
    );

    expect(screen.getByText("file-1.zip")).not.toBeNull();
    expect(screen.queryByText("file-21.zip")).toBeNull();
    expect(screen.getByLabelText("传输记录分页")).not.toBeNull();

    fireEvent.click(screen.getByRole("listitem", { name: "第 2 页" }));

    expect(screen.queryByText("file-1.zip")).toBeNull();
    expect(screen.getByText("file-21.zip")).not.toBeNull();
  });

  test("preserves the list position when retrying a transfer", () => {
    const failed = transfer("failed", "failed");
    const onRetry = mock(() => undefined);
    const view = render(
      <TransferActivityList
        externalEdits={[]}
        onCancel={() => undefined}
        onOpenExternalEdit={() => undefined}
        onPause={() => undefined}
        onResolveExternalEdit={() => undefined}
        onResume={() => undefined}
        onRetry={onRetry}
        transfers={[failed]}
      />,
    );
    const list = view.container.querySelector(
      ".sftp-transfer-list",
    ) as HTMLElement;
    list.scrollTop = 240;

    fireEvent.click(screen.getByRole("button", { name: "重试 failed.zip" }));
    view.rerender(
      <TransferActivityList
        externalEdits={[]}
        onCancel={() => undefined}
        onOpenExternalEdit={() => undefined}
        onPause={() => undefined}
        onResolveExternalEdit={() => undefined}
        onResume={() => undefined}
        onRetry={onRetry}
        transfers={[{ ...failed, status: "queued" }]}
      />,
    );

    expect(list.scrollTop).toBe(240);
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  test("shows where each transfer went and reveals completed downloads", () => {
    const onRevealLocal = mock(() => undefined);
    const upload = {
      ...transfer("completed", "upload"),
      remotePath: "/srv/app/uploads/upload.zip",
    };
    const download = {
      ...transfer("completed", "download"),
      localPath: "/Users/max/Downloads/download.zip",
    };
    const running = transfer("running", "running");

    render(
      <TransferActivityList
        externalEdits={[]}
        homeDirectory="/Users/max"
        onCancel={() => undefined}
        onOpenExternalEdit={() => undefined}
        onPause={() => undefined}
        onResolveExternalEdit={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
        onRevealLocal={onRevealLocal}
        transfers={[upload, download, running]}
      />,
    );

    expect(screen.getByText("→ /srv/app/uploads")).not.toBeNull();
    expect(screen.getByText("→ ~/Downloads")).not.toBeNull();
    const revealButtons = screen.getAllByRole("button", {
      name: /中显示 /,
    });
    expect(revealButtons).toHaveLength(1);

    fireEvent.click(revealButtons[0]);

    expect(onRevealLocal).toHaveBeenCalledWith(download);
  });

  test("marks downloads whose local file is missing", () => {
    const download = transfer("completed", "download");

    render(
      <TransferActivityList
        externalEdits={[]}
        missingTransferIds={new Set([download.transferId])}
        onCancel={() => undefined}
        onOpenExternalEdit={() => undefined}
        onPause={() => undefined}
        onResolveExternalEdit={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
        onRevealLocal={() => undefined}
        transfers={[download]}
      />,
    );

    expect(screen.getByText("已删除")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /中显示 / })).toBeNull();
  });

  test("builds direction-specific context menus", () => {
    const handlers = {
      onCopyPath: mock(() => undefined),
      onLocateRemote: mock(() => undefined),
      onOpenLocal: mock(() => undefined),
      onRemove: mock(() => undefined),
      onRetry: mock(() => undefined),
      onRevealLocal: mock(() => undefined),
    };
    const keys = (record: TransferActivityRecord) =>
      transferContextMenuItems(record, handlers, "MacIntel").map(
        (item) => item.key,
      );

    expect(keys(transfer("completed", "download"))).toEqual([
      "open-local",
      "reveal-local",
      "copy-local-path",
      "remove",
    ]);
    expect(keys(transfer("completed", "upload"))).toEqual([
      "locate-remote",
      "copy-remote-path",
      "remove",
    ]);
    expect(keys(transfer("failed", "download"))).toEqual([
      "copy-local-path",
      "retry",
      "remove",
    ]);
    expect(keys(transfer("running", "upload"))).toEqual(["copy-remote-path"]);

    const reveal = transferContextMenuItems(
      transfer("completed", "download"),
      handlers,
      "MacIntel",
    ).find((item) => item.key === "reveal-local");
    expect(reveal?.label).toBe("在访达中显示");
    void reveal?.onClick?.();
    expect(handlers.onRevealLocal).toHaveBeenCalled();

    const copy = transferContextMenuItems(
      transfer("completed", "upload"),
      handlers,
    ).find((item) => item.key === "copy-remote-path");
    void copy?.onClick?.();
    expect(handlers.onCopyPath).toHaveBeenCalledWith("/root/upload.zip");
  });
});
