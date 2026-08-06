import { describe, expect, test } from "bun:test";
import {
  nextReleaseVersion,
  prepareReleaseChangelog,
  updateCargoLockVersion,
  updateCargoPackageVersion,
  updateJsonVersion,
} from "./prepare-release";

describe("release preparation", () => {
  test("increments semantic versions", () => {
    expect(nextReleaseVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextReleaseVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextReleaseVersion("1.2.3", "major")).toBe("2.0.0");
  });

  test("synchronizes JSON, Cargo and lockfile versions", () => {
    expect(
      updateJsonVersion('{"name":"fineshell","version":"1.2.3"}', "1.2.4"),
    ).toContain('"version": "1.2.4"');
    expect(
      updateCargoPackageVersion(
        '[package]\nname = "fineshell"\nversion = "1.2.3"\n\n[dependencies]\n',
        "1.2.4",
      ),
    ).toContain('version = "1.2.4"');
    expect(
      updateCargoLockVersion(
        '[[package]]\nname = "dependency"\nversion = "1.2.3"\n\n[[package]]\nname = "fineshell"\nversion = "1.2.3"\n',
        "1.2.3",
        "1.2.4",
      ),
    ).toContain('name = "fineshell"\nversion = "1.2.4"');
  });

  test("moves Unreleased notes into the new version and resets the section", () => {
    const result = prepareReleaseChangelog(
      '# 更新日志\n\n## [Unreleased]\n\n### 修复\n\n- 修复问题\n\n## [1.2.3] - 2026-08-01\n\n- 旧版本\n',
      "1.2.4",
      "2026-08-06",
    );

    expect(result).toContain("## [Unreleased]\n\n### 新增");
    expect(result).toContain(
      "## [1.2.4] - 2026-08-06\n\n### 修复\n\n- 修复问题",
    );
    expect(result.indexOf("## [1.2.4]")).toBeLessThan(
      result.indexOf("## [1.2.3]"),
    );
  });

  test("rejects an empty Unreleased section", () => {
    expect(() =>
      prepareReleaseChangelog(
        "# 更新日志\n\n## [Unreleased]\n\n### 修复\n\n## [1.2.3] - 2026-08-01\n\n- 旧版本\n",
        "1.2.4",
        "2026-08-06",
      ),
    ).toThrow("没有可发布内容");
  });
});
