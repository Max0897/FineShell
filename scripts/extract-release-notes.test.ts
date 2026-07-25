import { describe, expect, test } from "bun:test";
import {
  extractReleaseNotes,
  releaseVersionFromTag,
} from "./extract-release-notes";

const changelog = `# 更新日志

## [1.2.3] - 2026-07-25

### 新增

- 首个功能
- 第二个功能

## [1.2.2] - 2026-07-20

- 上一个版本
`;

describe("release notes extraction", () => {
  test("extracts only the section matching the release tag", () => {
    expect(extractReleaseNotes(changelog, "v1.2.3")).toBe(`### 新增

- 首个功能
- 第二个功能`);
  });

  test("accepts prerelease tags and Windows line endings", () => {
    expect(releaseVersionFromTag("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(
      extractReleaseNotes(
        "# 更新日志\r\n\r\n## [1.2.3-beta.1]\r\n\r\n- 预览版本\r\n",
        "v1.2.3-beta.1",
      ),
    ).toBe("- 预览版本");
  });

  test("rejects invalid tags, missing versions and empty sections", () => {
    expect(() => releaseVersionFromTag("release-1.2.3")).toThrow("格式无效");
    expect(() => extractReleaseNotes(changelog, "v1.2.4")).toThrow(
      "缺少版本 1.2.4",
    );
    expect(() =>
      extractReleaseNotes("## [1.2.3]\n\n## [1.2.2]\n\n- 旧版本", "v1.2.3"),
    ).toThrow("更新日志为空");
  });
});
