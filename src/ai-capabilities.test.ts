import { describe, expect, test } from "bun:test";
import {
  AI_CAPABILITY_DEFINITIONS,
  aiCapabilityStateColor,
  aiCapabilityStateLabel,
} from "./ai-capabilities";

describe("AI capability display", () => {
  test("keeps capability order and three-state labels stable", () => {
    expect(AI_CAPABILITY_DEFINITIONS.map(({ key }) => key)).toEqual([
      "chat",
      "models",
      "streaming",
      "tools",
    ]);
    expect(aiCapabilityStateLabel("supported")).toBe("支持");
    expect(aiCapabilityStateLabel("unsupported")).toBe("不支持");
    expect(aiCapabilityStateLabel("unknown")).toBe("未确认");
    expect(aiCapabilityStateColor("supported")).toBe("green");
    expect(aiCapabilityStateColor("unsupported")).toBe("red");
    expect(aiCapabilityStateColor("unknown")).toBe("gray");
  });
});
