import { describe, expect, test } from "bun:test";
import {
  formatFileSize,
  formatPermissions,
  addRemotePathHistory,
  isValidRemoteName,
  isRemotePathDescendant,
  localFileName,
  matchRemoteDirectoryPaths,
  nextAvailableRemoteName,
  normalizeRemoteDirectoryPath,
  parsePermissions,
  remoteJoinPath,
  remoteParentPath,
  setRemotePathBookmark,
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

  test("detects descendants without matching sibling prefixes", () => {
    expect(isRemotePathDescendant("/srv/releases", "/srv/releases/2026")).toBe(
      true,
    );
    expect(isRemotePathDescendant("/srv/releases", "/srv/releases-old")).toBe(
      false,
    );
    expect(isRemotePathDescendant("/", "/tmp")).toBe(true);
    expect(isRemotePathDescendant("/", "/")).toBe(false);
  });

  test("creates available copy names while preserving file extensions", () => {
    expect(
      nextAvailableRemoteName(
        "report.txt",
        new Set(["report.txt", "report (1).txt"]),
      ),
    ).toBe("report (2).txt");
    expect(nextAvailableRemoteName("archive", new Set(["archive"]))).toBe(
      "archive (1)",
    );
    expect(nextAvailableRemoteName(".env", new Set([".env"]))).toBe(
      ".env (1)",
    );
  });

  test("extracts file names from Unix and Windows paths", () => {
    expect(localFileName("/Users/test/report.txt")).toBe("report.txt");
    expect(localFileName("C:\\Users\\test\\report.txt")).toBe("report.txt");
  });

  test("normalizes, deduplicates and limits directory history", () => {
    expect(normalizeRemoteDirectoryPath(" /var/log/// ")).toBe("/var/log");
    expect(normalizeRemoteDirectoryPath("relative/path")).toBeNull();
    expect(addRemotePathHistory(["/tmp", "/var/log"], "/tmp/", 2)).toEqual([
      "/tmp",
      "/var/log",
    ]);
    expect(addRemotePathHistory(["/tmp", "/var/log"], "/home", 2)).toEqual([
      "/home",
      "/tmp",
    ]);
  });

  test("manages bookmarks and matches bookmarks before history", () => {
    expect(setRemotePathBookmark(["/tmp"], "/var/www", true, 2)).toEqual([
      "/var/www",
      "/tmp",
    ]);
    expect(setRemotePathBookmark(["/tmp", "/var/www"], "/tmp", false, 2)).toEqual([
      "/var/www",
    ]);
    expect(
      matchRemoteDirectoryPaths(
        ["/var/www"],
        ["/tmp", "/var/log", "/var/www"],
        "var",
      ),
    ).toEqual(["/var/www", "/var/log"]);
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
});
