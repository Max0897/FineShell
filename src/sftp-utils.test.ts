import { describe, expect, test } from "bun:test";
import {
  formatFileSize,
  formatPermissions,
  localFileName,
  remoteJoinPath,
  remoteParentPath,
} from "./sftp-utils";

describe("SFTP path helpers", () => {
  test("keeps the root stable while navigating upward", () => {
    expect(remoteParentPath("/")).toBe("/");
    expect(remoteParentPath("/var/")).toBe("/");
    expect(remoteParentPath("/var/log")).toBe("/var");
  });

  test("joins names without duplicating separators", () => {
    expect(remoteJoinPath("/", "tmp")).toBe("/tmp");
    expect(remoteJoinPath("/var/", "log")).toBe("/var/log");
  });

  test("extracts file names from Unix and Windows paths", () => {
    expect(localFileName("/Users/test/report.txt")).toBe("report.txt");
    expect(localFileName("C:\\Users\\test\\report.txt")).toBe("report.txt");
  });
});

describe("SFTP display helpers", () => {
  test("formats byte sizes and permissions", () => {
    expect(formatFileSize(1024)).toBe("1.00 KB");
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0 MB");
    expect(formatPermissions(0o100755)).toBe("755");
  });
});
