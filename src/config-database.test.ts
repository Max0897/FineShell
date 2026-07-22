import { describe, expect, test } from "bun:test";
import { migrateLegacyConfiguration } from "./config-database";

describe("migrateLegacyConfiguration", () => {
  test("migrates valid hosts and applies connection defaults", () => {
    const configuration = migrateLegacyConfiguration(
      JSON.stringify([
        {
          id: "host-1",
          name: "Production",
          address: "server.example.com",
          port: 22,
          username: "root",
          password: "must-not-be-migrated",
        },
      ]),
      "[]",
      "2026-07-22T00:00:00.000Z",
    );

    expect(configuration.schemaVersion).toBe(1);
    expect(configuration.updatedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(configuration.hosts).toEqual([
      {
        id: "host-1",
        name: "Production",
        address: "server.example.com",
        port: 22,
        username: "root",
        authMethod: "password",
        privateKeyPath: undefined,
        connectTimeoutSeconds: 10,
        keepAliveIntervalSeconds: 15,
        autoReconnect: true,
        maxReconnectAttempts: 3,
        group: undefined,
        hostFingerprint: undefined,
        lastConnectedAt: undefined,
      },
    ]);
    expect(configuration.hosts[0]).not.toHaveProperty("password");
  });

  test("drops malformed records and limits history to fifty entries", () => {
    const history = Array.from({ length: 55 }, (_, index) => ({
      id: `history-${index}`,
      name: `Server ${index}`,
      address: "127.0.0.1",
      port: 22,
      username: "root",
      connectedAt: new Date(index).toISOString(),
    }));

    const configuration = migrateLegacyConfiguration(
      JSON.stringify([{ id: "missing-required-fields" }]),
      JSON.stringify([...history, null, "invalid"]),
    );

    expect(configuration.hosts).toHaveLength(0);
    expect(configuration.history).toHaveLength(50);
    expect(configuration.history[0].id).toBe("history-0");
  });

  test("recovers from invalid legacy JSON", () => {
    const configuration = migrateLegacyConfiguration("not-json", "{}");

    expect(configuration.hosts).toEqual([]);
    expect(configuration.history).toEqual([]);
  });
});
