import { describe, expect, test } from "bun:test";
import defaultCapability from "../src-tauri/capabilities/default.json";

describe("window capabilities", () => {
  test("allows close-request listeners to destroy auxiliary windows", () => {
    expect(defaultCapability.permissions).toContain(
      "core:window:allow-destroy",
    );
  });
});
