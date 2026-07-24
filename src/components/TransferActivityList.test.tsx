import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ExternalEditPayload } from "../tauri-protocol";
import TransferActivityList, {
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
        transfers={[running, paused, failed]}
      />,
    );

    expect(screen.getByText("1.00 KB/s")).not.toBeNull();
    expect(screen.getByText("已暂停")).not.toBeNull();
    expect(screen.getByText("传输失败")).not.toBeNull();
    expect(screen.getByText("同步冲突")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "暂停 upload.zip" }));
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
    expect(onResume).toHaveBeenCalledWith(paused);
    expect(onCancel).toHaveBeenCalledWith(running);
    expect(onRetry).toHaveBeenCalledWith(failed);
    expect(onOpenExternalEdit).toHaveBeenCalledWith(CONFLICT);
    expect(onResolveExternalEdit).toHaveBeenCalledWith(CONFLICT);
  });
});
