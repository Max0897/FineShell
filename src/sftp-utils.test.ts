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
  nextAvailableRemoteArchiveName,
  normalizeRemoteDirectoryPath,
  parsePermissions,
  permissionFlagsFromValue,
  permissionValueFromFlags,
  remoteArchiveBaseName,
  remoteArchiveExtension,
  remoteArchiveFileName,
  remoteArchiveFormatFromName,
  remoteJoinPath,
  remoteParentPath,
  resolveNativeDropPoint,
  selectAllSftpEntryKeys,
  invertSftpEntryKeys,
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

describe("SFTP selection helpers", () => {
  test("selects all visible entries in display order", () => {
    expect(selectAllSftpEntryKeys(["a", "b", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("inverts only the currently visible entries", () => {
    expect(invertSftpEntryKeys(["a", "b", "c"], ["b", "hidden"])).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("SFTP native drop coordinates", () => {
  const bounds = { left: 500, right: 1_200, top: 400, bottom: 800 };

  test("keeps AppKit logical coordinates on a Retina display", () => {
    expect(
      resolveNativeDropPoint({ x: 900, y: 650 }, 2, bounds, true),
    ).toEqual({
      x: 900,
      y: 650,
      inside: true,
      coordinateMode: "logical",
    });
  });

  test("converts physical coordinates when that is the matching coordinate space", () => {
    expect(
      resolveNativeDropPoint(
        { x: 900, y: 600 },
        1.5,
        { left: 500, right: 800, top: 300, bottom: 500 },
        false,
      ),
    ).toEqual({
      x: 600,
      y: 400,
      inside: true,
      coordinateMode: "physical",
    });
  });

  test("falls back to the alternate coordinate space when it is the only match", () => {
    expect(
      resolveNativeDropPoint({ x: 900, y: 650 }, 2, bounds, false),
    ).toEqual({
      x: 900,
      y: 650,
      inside: true,
      coordinateMode: "logical",
    });
  });

  test("reports points outside the panel without producing invalid values", () => {
    expect(
      resolveNativeDropPoint({ x: 100, y: 100 }, Number.NaN, bounds, true),
    ).toEqual({
      x: 100,
      y: 100,
      inside: false,
      coordinateMode: "logical",
    });
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

  test("converts permissions to visual flags and back", () => {
    expect(permissionFlagsFromValue(0o754)).toEqual([
      "owner-read",
      "owner-write",
      "owner-execute",
      "group-read",
      "group-execute",
      "other-read",
    ]);
    expect(
      permissionValueFromFlags(
        ["owner-read", "owner-write", "group-read", "other-read"],
        0o4000,
      ),
    ).toBe(0o4644);
  });

  test("detects archive formats and derives stable archive names", () => {
    expect(remoteArchiveFormatFromName("backup.TAR.GZ")).toBe("tarGz");
    expect(remoteArchiveFormatFromName("source.tgz")).toBe("tarGz");
    expect(remoteArchiveFormatFromName("bundle.zip")).toBe("zip");
    expect(remoteArchiveFormatFromName("notes.txt")).toBeNull();
    expect(remoteArchiveBaseName("backup.tar.gz")).toBe("backup");
    expect(remoteArchiveExtension("tarGz")).toBe(".tar.gz");
    expect(remoteArchiveFileName("backup.zip", "tar")).toBe("backup.tar");
    expect(
      nextAvailableRemoteArchiveName(
        "backup",
        "tarGz",
        new Set(["backup.tar.gz", "backup (1).tar.gz"]),
      ),
    ).toBe("backup (2).tar.gz");
  });
});
