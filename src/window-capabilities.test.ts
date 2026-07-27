import { describe, expect, test } from "bun:test";
import defaultCapability from "../src-tauri/capabilities/default.json";

describe("window capabilities", () => {
  test("keeps auxiliary windows reusable", () => {
    expect(defaultCapability.windows).toEqual(
      expect.arrayContaining(["main", "settings", "shortcut-guide"]),
    );
    expect(defaultCapability.permissions).not.toContain(
      "core:window:allow-destroy",
    );
  });
});
