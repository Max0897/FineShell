import { describe, expect, test } from "bun:test";
import {
  abbreviateHomePath,
  canRevealLocalTransfer,
  localParentPath,
  middleTruncatePath,
  revealInFileManagerLabel,
  transferLocation,
} from "./transfer-location";

describe("transfer location", () => {
  test("resolves local parent directories on POSIX and Windows", () => {
    expect(localParentPath("/Users/max/Downloads/a.txt")).toBe(
      "/Users/max/Downloads",
    );
    expect(localParentPath("/a.txt")).toBe("/");
    expect(localParentPath("C:\\Users\\max\\Downloads\\a.txt")).toBe(
      "C:\\Users\\max\\Downloads",
    );
    expect(localParentPath("C:\\a.txt")).toBe("C:\\");
  });

  test("abbreviates the home directory only on path boundaries", () => {
    expect(abbreviateHomePath("/Users/max/Downloads", "/Users/max")).toBe(
      "~/Downloads",
    );
    expect(abbreviateHomePath("/Users/max", "/Users/max/")).toBe("~");
    expect(abbreviateHomePath("/Users/maxwell/Downloads", "/Users/max")).toBe(
      "/Users/maxwell/Downloads",
    );
    expect(abbreviateHomePath("/srv", undefined)).toBe("/srv");
  });

  test("truncates long paths in the middle", () => {
    expect(middleTruncatePath("/srv/app", 20)).toBe("/srv/app");
    const truncated = middleTruncatePath(
      "/srv/projects/very/deep/nested/release/uploads",
      20,
    );
    expect(Array.from(truncated)).toHaveLength(20);
    expect(truncated.startsWith("/srv/pr")).toBe(true);
    expect(truncated.endsWith("se/uploads")).toBe(true);
    expect(truncated).toContain("…");
  });

  test("shows the remote directory for uploads and local directory for downloads", () => {
    expect(
      transferLocation({
        direction: "upload",
        localPath: "/Users/max/report.pdf",
        remotePath: "/srv/app/uploads/report.pdf",
      }),
    ).toEqual({
      label: "/srv/app/uploads",
      fullPath: "/srv/app/uploads/report.pdf",
    });
    expect(
      transferLocation(
        {
          direction: "download",
          localPath: "/Users/max/Downloads/backup.tar.gz",
          remotePath: "/srv/backup.tar.gz",
        },
        "/Users/max",
      ),
    ).toEqual({
      label: "~/Downloads",
      fullPath: "/Users/max/Downloads/backup.tar.gz",
    });
  });

  test("only reveals completed downloads", () => {
    expect(
      canRevealLocalTransfer({ direction: "download", status: "completed" }),
    ).toBe(true);
    expect(
      canRevealLocalTransfer({ direction: "download", status: "running" }),
    ).toBe(false);
    expect(
      canRevealLocalTransfer({ direction: "upload", status: "completed" }),
    ).toBe(false);
  });

  test("names the file manager by platform", () => {
    expect(revealInFileManagerLabel("MacIntel")).toBe("在访达中显示");
    expect(revealInFileManagerLabel("Win32")).toBe("在文件夹中显示");
  });
});
