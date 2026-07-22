import { describe, expect, test } from "bun:test";
import { normalizeHostForm } from "./host-storage";

describe("normalizeHostForm", () => {
  test("trims metadata without putting the password in the stored host", () => {
    const result = normalizeHostForm({
      name: "  Production  ",
      address: "  server.example.com ",
      port: 22,
      username: " root ",
      authMethod: "password",
      connectTimeoutSeconds: 10,
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
      connectTimeoutSeconds: 10,
      group: "Linux",
      hostFingerprint: "SHA256:abc123",
    });
    expect("password" in result.host).toBe(false);
  });

  test("removes empty optional metadata", () => {
    const result = normalizeHostForm({
      name: "Server",
      address: "127.0.0.1",
      port: 22,
      username: "root",
      authMethod: "password",
      connectTimeoutSeconds: 10,
      group: "   ",
      hostFingerprint: "",
    });

    expect(result.host.group).toBeUndefined();
    expect(result.host.hostFingerprint).toBeUndefined();
  });
});
