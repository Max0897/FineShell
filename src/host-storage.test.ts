import { describe, expect, test } from "bun:test";
import { normalizeHostForm, withHostDefaults } from "./host-storage";

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
