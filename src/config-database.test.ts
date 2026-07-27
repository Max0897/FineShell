import { describe, expect, test } from "bun:test";
import {
  createDeletedHostRecord,
  isDeletedHostExpired,
  migrateLegacyConfiguration,
  parseConfigurationExport,
  serializeConfigurationExport,
} from "./config-database";
import { DEFAULT_APP_SETTINGS } from "./app-settings";

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

    expect(configuration.schemaVersion).toBe(17);
    expect(configuration.proxies).toEqual([]);
    expect(configuration.sshKeys).toEqual([]);
    expect(configuration.quickCommands).toEqual([]);
    expect(configuration.hostSort).toBe("manual");
    expect(configuration.sftpLocations).toEqual([]);
    expect(configuration.knownHosts).toEqual([]);
    expect(configuration.credentialReferences).toEqual([]);
    expect(configuration.settings).toEqual(DEFAULT_APP_SETTINGS);
    expect(configuration.updatedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(configuration.hosts).toEqual([
      {
        id: "host-1",
        name: "Production",
        address: "server.example.com",
        port: 22,
        username: "root",
        authMethod: "password",
        sshKeyId: undefined,
        privateKeyPath: undefined,
        connectTimeoutSeconds: 10,
        keepAliveIntervalSeconds: 15,
        autoReconnect: true,
        maxReconnectAttempts: 3,
        proxyId: undefined,
        jumpHostId: undefined,
        localPortForwards: [],
        remotePortForwards: [],
        dynamicPortForwards: [],
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
    expect(configuration.history[0].id).toBe("history-54");
    expect(configuration.history[49].id).toBe("history-5");
  });

  test("recovers from invalid legacy JSON", () => {
    const configuration = migrateLegacyConfiguration("not-json", "{}");

    expect(configuration.hosts).toEqual([]);
    expect(configuration.history).toEqual([]);
  });
});

describe("deleted host retention", () => {
  const host = {
    id: "host-1",
    name: "Server",
    address: "server.example.com",
    port: 22,
    username: "root",
    authMethod: "password" as const,
    connectTimeoutSeconds: 10,
    keepAliveIntervalSeconds: 15,
    autoReconnect: true,
    maxReconnectAttempts: 3,
  };

  test("keeps deleted hosts recoverable for thirty days", () => {
    const deletedHost = createDeletedHostRecord(
      host,
      new Date("2026-07-01T00:00:00.000Z"),
    );

    expect(deletedHost.expiresAt).toBe("2026-07-31T00:00:00.000Z");
    expect(
      isDeletedHostExpired(
        deletedHost,
        new Date("2026-07-30T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      isDeletedHostExpired(
        deletedHost,
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).toBe(true);
  });
});

describe("configuration import and export", () => {
  test("exports a versioned document without unknown credential fields", () => {
    const contents = serializeConfigurationExport(
      {
        hosts: [
          {
            id: "host-1",
            name: "Server",
            address: "server.example.com",
            port: 22,
            username: "root",
            authMethod: "password",
            connectTimeoutSeconds: 10,
            keepAliveIntervalSeconds: 15,
            autoReconnect: true,
            maxReconnectAttempts: 3,
            jumpHostId: "jump-1",
            localPortForwards: [
              {
                id: "forward-1",
                name: "Web",
                bindAddress: "127.0.0.1",
                bindPort: 8080,
                targetAddress: "127.0.0.1",
                targetPort: 80,
                enabled: true,
              },
            ],
            remotePortForwards: [
              {
                id: "remote-forward-1",
                name: "Preview",
                bindAddress: "127.0.0.1",
                bindPort: 9000,
                targetAddress: "127.0.0.1",
                targetPort: 3000,
                enabled: true,
              },
            ],
            dynamicPortForwards: [
              {
                id: "dynamic-forward-1",
                name: "Browser proxy",
                bindAddress: "127.0.0.1",
                bindPort: 1080,
                enabled: true,
              },
            ],
            password: "must-not-be-exported",
          } as never,
        ],
        history: [],
        proxies: [
          {
            id: "proxy-1",
            name: "Office Proxy",
            type: "socks5",
            address: "127.0.0.1",
            port: 1080,
            username: "proxy-user",
            password: "must-not-be-exported",
          } as never,
        ],
        sshKeys: [
          {
            id: "ssh-key-1",
            name: "Production key",
            privateKeyPath: "/Users/demo/.ssh/id_ed25519",
            passphrase: "key-passphrase-must-not-be-exported",
          } as never,
        ],
        quickCommands: [
          {
            id: "command-1",
            name: "查看日志",
            command: "tail -n {{行数:100}} {{文件}}",
            group: "运维",
            description: "读取文件末尾内容",
          },
        ],
        hostSort: "manual",
        sftpLocations: [
          {
            hostId: "host-1",
            bookmarks: ["/var/www", "/var/www"],
            history: ["/var/log", "relative/path"],
          },
        ],
        knownHosts: [
          {
            id: "known-host-1",
            address: "server.example.com",
            port: 22,
            fingerprint: "SHA256:abc123",
            firstSeenAt: "2026-07-20T00:00:00.000Z",
            lastVerifiedAt: "2026-07-22T00:00:00.000Z",
          },
        ],
        settings: DEFAULT_APP_SETTINGS,
      },
      "2026-07-22T00:00:00.000Z",
    );

    expect(contents).toContain('"format": "fineshell-config"');
    expect(contents).toContain('"hostSort": "manual"');
    expect(contents).toContain('"settings"');
    expect(contents).toContain('"proxies"');
    expect(contents).toContain('"sshKeys"');
    expect(contents).toContain('"quickCommands"');
    expect(contents).toContain('"sftpLocations"');
    expect(contents).toContain('"knownHosts"');
    expect(contents).not.toContain("credentialReferences");
    expect(contents).not.toContain("must-not-be-exported");
    expect(contents).not.toContain("key-passphrase-must-not-be-exported");
    const imported = parseConfigurationExport(contents);
    expect(imported.hosts).toHaveLength(1);
    expect(imported.hosts[0].jumpHostId).toBe("jump-1");
    expect(imported.hosts[0].localPortForwards).toHaveLength(1);
    expect(imported.hosts[0].remotePortForwards).toHaveLength(1);
    expect(imported.hosts[0].dynamicPortForwards).toHaveLength(1);
    expect(imported.proxies).toEqual([
      {
        id: "proxy-1",
        name: "Office Proxy",
        type: "socks5",
        address: "127.0.0.1",
        port: 1080,
        username: "proxy-user",
      },
    ]);
    expect(imported.sshKeys).toEqual([
      {
        id: "ssh-key-1",
        name: "Production key",
        privateKeyPath: "/Users/demo/.ssh/id_ed25519",
      },
    ]);
    expect(imported.sftpLocations).toEqual([
      {
        hostId: "host-1",
        bookmarks: ["/var/www"],
        history: ["/var/log"],
      },
    ]);
    expect(imported.quickCommands).toEqual([
      {
        id: "command-1",
        name: "查看日志",
        command: "tail -n {{行数:100}} {{文件}}",
        group: "运维",
        description: "读取文件末尾内容",
      },
    ]);
    expect(imported.knownHosts).toEqual([
      {
        id: "known-host-1",
        address: "server.example.com",
        port: 22,
        fingerprint: "SHA256:abc123",
        firstSeenAt: "2026-07-20T00:00:00.000Z",
        lastVerifiedAt: "2026-07-22T00:00:00.000Z",
      },
    ]);
    expect(imported.settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  test("rejects unrelated and newer configuration documents", () => {
    expect(() => parseConfigurationExport("not-json")).toThrow("有效的 JSON");
    expect(() => parseConfigurationExport('{"format":"other"}')).toThrow(
      "不是 FineShell 配置文件",
    );
    expect(() =>
      parseConfigurationExport(
        '{"format":"fineshell-config","schemaVersion":99}',
      ),
    ).toThrow("版本不受支持");
  });

  test("loads version one exports with the default host order", () => {
    const imported = parseConfigurationExport(
      JSON.stringify({
        format: "fineshell-config",
        schemaVersion: 1,
        hosts: [],
        history: [],
      }),
    );

    expect(imported.hostSort).toBe("manual");
    expect(imported.proxies).toEqual([]);
    expect(imported.sshKeys).toEqual([]);
    expect(imported.quickCommands).toEqual([]);
    expect(imported.sftpLocations).toEqual([]);
    expect(imported.knownHosts).toEqual([]);
    expect(imported.settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  test("derives known hosts from exports created before centralized management", () => {
    const imported = parseConfigurationExport(
      JSON.stringify({
        format: "fineshell-config",
        schemaVersion: 12,
        exportedAt: "2026-07-22T00:00:00.000Z",
        hosts: [
          {
            id: "host-1",
            name: "Server",
            address: "server.example.com",
            port: 22,
            username: "root",
            authMethod: "password",
            hostFingerprint: "legacy-fingerprint",
            lastConnectedAt: "2026-07-21T00:00:00.000Z",
          },
        ],
        history: [],
      }),
    );

    expect(imported.knownHosts).toEqual([
      {
        id: "known-host-server.example.com%3A22",
        address: "server.example.com",
        port: 22,
        fingerprint: "SHA256:legacy-fingerprint",
        firstSeenAt: "2026-07-21T00:00:00.000Z",
        lastVerifiedAt: "2026-07-21T00:00:00.000Z",
      },
    ]);
  });

  test("preserves SSH Agent authentication during import", () => {
    const imported = parseConfigurationExport(
      JSON.stringify({
        format: "fineshell-config",
        schemaVersion: 8,
        hosts: [
          {
            id: "agent-host",
            name: "Agent Server",
            address: "agent.example.com",
            port: 22,
            username: "deploy",
            authMethod: "agent",
          },
        ],
        history: [],
      }),
    );

    expect(imported.hosts[0].authMethod).toBe("agent");
    expect(imported.hosts[0].privateKeyPath).toBeUndefined();
  });

  test("preserves managed key references without importing passphrases", () => {
    const imported = parseConfigurationExport(
      JSON.stringify({
        format: "fineshell-config",
        schemaVersion: 9,
        hosts: [
          {
            id: "key-host",
            name: "Key Server",
            address: "key.example.com",
            port: 22,
            username: "deploy",
            authMethod: "privateKey",
            sshKeyId: "ssh-key-1",
            privateKeyPath: "/tmp/duplicated-key",
          },
        ],
        history: [],
        sshKeys: [
          {
            id: "ssh-key-1",
            name: "Production key",
            privateKeyPath: "/Users/demo/.ssh/id_ed25519",
            passphrase: "must-not-be-imported",
          },
        ],
      }),
    );

    expect(imported.hosts[0].sshKeyId).toBe("ssh-key-1");
    expect(imported.hosts[0].privateKeyPath).toBeUndefined();
    expect(imported.sshKeys[0]).toEqual({
      id: "ssh-key-1",
      name: "Production key",
      privateKeyPath: "/Users/demo/.ssh/id_ed25519",
    });
    expect(imported.sshKeys[0]).not.toHaveProperty("passphrase");
  });

  test("preserves FineShell-managed key references without exporting key contents", () => {
    const contents = serializeConfigurationExport(
      {
        ...migrateLegacyConfiguration(
          null,
          null,
          "2026-07-27T00:00:00.000Z",
        ),
        sshKeys: [
          {
            id: "ssh-key-managed",
            name: "Managed key",
            privateKeyPath: "managed://ssh-key-managed",
            source: "managed",
            privateKeyContent: "must-not-be-exported",
          } as never,
        ],
      },
      "2026-07-27T00:00:00.000Z",
    );

    expect(contents).not.toContain("must-not-be-exported");
    expect(parseConfigurationExport(contents).sshKeys).toEqual([
      {
        id: "ssh-key-managed",
        name: "Managed key",
        privateKeyPath: "managed://ssh-key-managed",
        source: "managed",
      },
    ]);
  });
});
