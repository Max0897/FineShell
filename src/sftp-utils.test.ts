import { describe, expect, test } from "bun:test";
import {
  formatFileSize,
  formatPermissions,
  isValidRemoteName,
  localFileName,
  parsePermissions,
  remoteJoinPath,
  remoteParentPath,
  summarizeSftpTransfers,
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

  test("rejects names that escape the current directory", () => {
    expect(isValidRemoteName("reports")).toBe(true);
    expect(isValidRemoteName("../reports")).toBe(false);
    expect(isValidRemoteName("reports\\archive")).toBe(false);
    expect(isValidRemoteName("..")).toBe(false);
    expect(isValidRemoteName(" ")).toBe(false);
  });
});

describe("SFTP display helpers", () => {
  test("formats byte sizes and permissions", () => {
    expect(formatFileSize(1024)).toBe("1.00 KB");
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0 MB");
    expect(formatPermissions(0o100755)).toBe("755");
  });

  test("parses only three or four digit octal permissions", () => {
    expect(parsePermissions("755")).toBe(0o755);
    expect(parsePermissions(" 4755 ")).toBe(0o4755);
    expect(parsePermissions("99")).toBeNull();
    expect(parsePermissions("888")).toBeNull();
  });

  test("summarizes queued and completed transfer progress", () => {
    expect(
      summarizeSftpTransfers([
        { status: "completed", transferredBytes: 100, totalBytes: 100 },
        { status: "running", transferredBytes: 40, totalBytes: 100 },
        { status: "queued", transferredBytes: 0, totalBytes: 100 },
      ]),
    ).toEqual({
      active: 2,
      completed: 1,
      percent: 47,
      totalBytes: 300,
      transferredBytes: 140,
    });
  });
});
