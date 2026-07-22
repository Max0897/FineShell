import { describe, expect, test } from "bun:test";
import { decodeSshOutput, reconnectDelaySeconds } from "./terminal-utils";

describe("decodeSshOutput", () => {
  test("decodes unpadded SSH output without changing bytes", () => {
    expect(Array.from(decodeSshOutput("AAEC/4A"))).toEqual([
      0, 1, 2, 255, 128,
    ]);
  });
});

describe("reconnectDelaySeconds", () => {
  test("uses capped exponential backoff", () => {
    expect(reconnectDelaySeconds(1)).toBe(1);
    expect(reconnectDelaySeconds(2)).toBe(2);
    expect(reconnectDelaySeconds(3)).toBe(4);
    expect(reconnectDelaySeconds(10)).toBe(30);
  });
});
