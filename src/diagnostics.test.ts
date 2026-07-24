import { describe, expect, test } from "bun:test";
import { sanitizeDiagnosticValue } from "./diagnostics";

describe("diagnostic redaction", () => {
  test("redacts secrets, hosts, users and local paths from text", () => {
    const value = sanitizeDiagnosticValue(
      "ssh root@server.example.com 192.168.1.10 /Users/max/.ssh/id_ed25519 password=hello",
    );

    expect(value).not.toContain("root");
    expect(value).not.toContain("server.example.com");
    expect(value).not.toContain("192.168.1.10");
    expect(value).not.toContain("/Users/max");
    expect(value).not.toContain("hello");
    expect(value).toContain("[USER]@[HOST]");
  });

  test("redacts sensitive structured fields recursively", () => {
    expect(
      sanitizeDiagnosticValue({
        operation: "ssh_connect",
        request: { address: "server.example.com" },
        nested: { password: "secret", status: "failed" },
      }),
    ).toEqual({
      operation: "ssh_connect",
      request: "[REDACTED]",
      nested: { password: "[REDACTED]", status: "failed" },
    });
  });

  test("redacts URL credentials, IPv6 addresses and private key blocks", () => {
    const value = String(
      sanitizeDiagnosticValue(
        "ssh://root:secret@[2001:db8::1]/home/root -----BEGIN OPENSSH PRIVATE KEY-----\nfake-key\n-----END OPENSSH PRIVATE KEY-----",
      ),
    );

    expect(value).not.toContain("root:secret");
    expect(value).not.toContain("2001:db8::1");
    expect(value).not.toContain("fake-key");
    expect(value).toContain("[PRIVATE_KEY]");
  });
});
