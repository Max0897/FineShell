import { describe, expect, test } from "bun:test";
import { isSftpUploadRetryableError } from "./sftpErrors";

describe("SFTP upload retry errors", () => {
  test("retries transient connection and remote write failures", () => {
    expect(isSftpUploadRetryableError("上传连续 120 秒无进度")).toBe(true);
    expect(isSftpUploadRetryableError("写入远程文件失败：socket closed")).toBe(
      true,
    );
  });

  test("does not retry errors that require user action or local fixes", () => {
    expect(isSftpUploadRetryableError("远程目标已存在，需要确认覆盖")).toBe(
      false,
    );
    expect(isSftpUploadRetryableError("无法打开本地文件：权限不足")).toBe(false);
  });
});
