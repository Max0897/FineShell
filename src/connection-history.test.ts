import { describe, expect, test } from "bun:test";
import type { ConnectionHistoryRecord } from "./models";
import { applyConnectionHistoryPolicy } from "./connection-history";

function historyRecord(id: string, connectedAt: string): ConnectionHistoryRecord {
  return {
    id,
    name: id,
    address: "example.com",
    port: 22,
    username: "root",
    authMethod: "password",
    connectedAt,
  };
}

describe("applyConnectionHistoryPolicy", () => {
  test("sorts records and applies the configured count", () => {
    const history = Array.from({ length: 25 }, (_, index) =>
      historyRecord(
        String(index),
        new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
      ),
    );

    const result = applyConnectionHistoryPolicy(history, {
      connectionHistoryLimit: 20,
      connectionHistoryRetentionDays: 0,
    });

    expect(result).toHaveLength(20);
    expect(result[0].id).toBe("24");
  });

  test("expires old records while unlimited keeps all recent records", () => {
    const result = applyConnectionHistoryPolicy(
      [
        historyRecord("old", "2026-05-01T00:00:00.000Z"),
        historyRecord("recent", "2026-07-20T00:00:00.000Z"),
      ],
      {
        connectionHistoryLimit: 0,
        connectionHistoryRetentionDays: 30,
      },
      new Date("2026-07-24T00:00:00.000Z"),
    );

    expect(result.map((item) => item.id)).toEqual(["recent"]);
  });
});
