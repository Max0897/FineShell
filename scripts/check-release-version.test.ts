import { describe, expect, test } from "bun:test";
import {
  cargoPackageVersion,
  validateReleaseVersion,
} from "./check-release-version";

const versions = {
  cargo: "1.2.3",
  packageJson: "1.2.3",
  tauri: "1.2.3",
};

describe("release version validation", () => {
  test("accepts a tag matching all application versions", () => {
    expect(validateReleaseVersion("v1.2.3", versions)).toBe("1.2.3");
  });

  test("rejects invalid tags and version mismatches", () => {
    expect(() => validateReleaseVersion("release-1.2.3", versions)).toThrow(
      "格式无效",
    );
    expect(() =>
      validateReleaseVersion("v1.2.4", versions),
    ).toThrow("与应用版本");
    expect(() =>
      validateReleaseVersion("v1.2.3", {
        ...versions,
        cargo: "1.2.2",
      }),
    ).toThrow("版本不一致");
  });

  test("reads the version from the Cargo package section", () => {
    expect(
      cargoPackageVersion(`
[package]
name = "fineshell"
version = "1.2.3"

[dependencies]
library = { version = "9.9.9" }
`),
    ).toBe("1.2.3");
  });
});
