import { describe, expect, test } from "bun:test";
import {
  jumpHostSelectionError,
  normalizeHostForm,
  withHostDefaults,
} from "./host-storage";

describe("normalizeHostForm", () => {
  test("trims metadata without putting the password in the stored host", () => {
    const result = normalizeHostForm({
      name: "  Production  ",
      address: "  server.example.com ",
      port: 22,
      username: " root ",
      authMethod: "password",
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
      proxyId: "proxy-1",
      jumpHostId: "jump-1",
      localPortForwards: [
        {
          id: "forward-1",
          name: "  Web  ",
          bindAddress: " 127.0.0.1 ",
          bindPort: 8080,
          targetAddress: " localhost ",
          targetPort: 80,
          enabled: true,
        },
      ],
      remotePortForwards: [
        {
          id: "remote-forward-1",
          name: "  Preview  ",
          bindAddress: " 127.0.0.1 ",
          bindPort: 9000,
          targetAddress: " localhost ",
          targetPort: 3000,
          enabled: false,
        },
      ],
      password: "secret",
      group: "  Linux  ",
      hostFingerprint: " SHA256:abc123 ",
    });

    expect(result.password).toBe("secret");
    expect(result.host).toEqual({
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
      proxyId: "proxy-1",
      jumpHostId: "jump-1",
      localPortForwards: [
        {
          id: "forward-1",
          name: "Web",
          bindAddress: "127.0.0.1",
          bindPort: 8080,
          targetAddress: "localhost",
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
          targetAddress: "localhost",
          targetPort: 3000,
          enabled: false,
        },
      ],
      group: "Linux",
      hostFingerprint: "SHA256:abc123",
    });
    expect("password" in result.host).toBe(false);
    expect("privateKeyPassphrase" in result.host).toBe(false);
  });

  test("keeps private key metadata while separating its passphrase", () => {
    const result = normalizeHostForm({
      name: "Key Server",
      address: "server.example.com",
      port: 22,
      username: "deploy",
      authMethod: "privateKey",
      privateKeyPath: "  /Users/demo/.ssh/id_ed25519  ",
      privateKeyPassphrase: "key-secret",
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
    });

    expect(result.privateKeyPassphrase).toBe("key-secret");
    expect(result.host.privateKeyPath).toBe("/Users/demo/.ssh/id_ed25519");
    expect("privateKeyPassphrase" in result.host).toBe(false);
  });

  test("removes empty optional metadata", () => {
    const result = normalizeHostForm({
      name: "Server",
      address: "127.0.0.1",
      port: 22,
      username: "root",
      authMethod: "password",
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
      group: "   ",
      hostFingerprint: "",
    });

    expect(result.host.group).toBeUndefined();
    expect(result.host.hostFingerprint).toBeUndefined();
  });

  test("normalizes nested group paths", () => {
    const result = normalizeHostForm({
      name: "Server",
      address: "server.example.com",
      port: 22,
      username: "root",
      authMethod: "password",
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
      group: " 生产 / 华东 / ",
    });

    expect(result.host.group).toBe("生产/华东");
  });

  test("does not retain inactive private key fields", () => {
    const result = normalizeHostForm({
      name: "Server",
      address: "127.0.0.1",
      port: 22,
      username: "root",
      authMethod: "password",
      password: "secret",
      privateKeyPath: "/tmp/old-key",
      privateKeyPassphrase: "old-secret",
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
    });

    expect(result.host.privateKeyPath).toBeUndefined();
    expect(result.privateKeyPassphrase).toBeUndefined();
  });
});

describe("withHostDefaults", () => {
  test("migrates hosts saved before reliability settings existed", () => {
    const host = withHostDefaults({
      id: "legacy",
      name: "Legacy",
      address: "127.0.0.1",
      port: 22,
      username: "root",
      authMethod: "password",
      connectTimeoutSeconds: 10,
    });

    expect(host.keepAliveIntervalSeconds).toBe(15);
    expect(host.autoReconnect).toBe(true);
    expect(host.maxReconnectAttempts).toBe(3);
  });
});

describe("jumpHostSelectionError", () => {
  const hosts = [
    {
      id: "jump",
      name: "Jump",
      address: "jump.example.com",
      port: 22,
      username: "root",
      authMethod: "password" as const,
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
    },
    {
      id: "nested",
      name: "Nested",
      address: "nested.example.com",
      port: 22,
      username: "root",
      authMethod: "password" as const,
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
      jumpHostId: "jump",
    },
    {
      id: "other",
      name: "Other",
      address: "other.example.com",
      port: 22,
      username: "root",
      authMethod: "password" as const,
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 15,
      autoReconnect: true,
      maxReconnectAttempts: 3,
    },
  ];

  test("accepts a direct saved host", () => {
    expect(jumpHostSelectionError("target", "jump", hosts)).toBeUndefined();
  });

  test("rejects self references, missing hosts and nested routes", () => {
    expect(jumpHostSelectionError("jump", "jump", hosts)).toContain("自身");
    expect(jumpHostSelectionError("target", "missing", hosts)).toContain(
      "不存在",
    );
    expect(jumpHostSelectionError("target", "nested", hosts)).toContain(
      "一级",
    );
    expect(jumpHostSelectionError("jump", "other", hosts)).toContain(
      "其他主机",
    );
  });
});
