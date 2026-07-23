import { describe, expect, test } from "bun:test";
import {
  decodeSshOutput,
  jumpHostRequest,
  reconnectDelaySeconds,
} from "./terminal-utils";

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

describe("jumpHostRequest", () => {
  test("maps the saved jump host and its proxy to the backend contract", () => {
    const request = jumpHostRequest({
      host: {
        id: "jump-1",
        name: "Jump",
        address: "jump.example.com",
        port: 2222,
        username: "deploy",
        authMethod: "privateKey",
        privateKeyPath: "/keys/jump",
        connectTimeoutSeconds: 12,
        keepAliveIntervalSeconds: 20,
        autoReconnect: true,
        maxReconnectAttempts: 3,
        hostFingerprint: "SHA256:jump",
      },
      proxy: {
        id: "proxy-1",
        name: "Proxy",
        type: "socks5",
        address: "127.0.0.1",
        port: 1080,
      },
    });

    expect(request).toEqual({
      hostId: "jump-1",
      address: "jump.example.com",
      port: 2222,
      username: "deploy",
      authMethod: "privateKey",
      privateKeyPath: "/keys/jump",
      connectTimeoutSeconds: 12,
      keepAliveIntervalSeconds: 20,
      expectedFingerprint: "SHA256:jump",
      proxy: {
        id: "proxy-1",
        name: "Proxy",
        type: "socks5",
        address: "127.0.0.1",
        port: 1080,
      },
    });
    expect(jumpHostRequest()).toBeUndefined();
  });
});
