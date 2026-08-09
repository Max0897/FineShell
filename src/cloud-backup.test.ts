import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CLOUD_BACKUP_SETTINGS,
  sanitizeCloudBackupSettings,
} from "./cloud-backup";

describe("cloud backup settings", () => {
  test("keeps S3 connection metadata separate from application settings", () => {
    expect(
      sanitizeCloudBackupSettings({
        storage: {
          profileId: " work ",
          endpoint: " https://s3.example.com ",
          region: " eu-west-1 ",
          bucket: " backup ",
          prefix: " FineShell/device ",
          // Legacy settings are discarded after sanitization.
          forcePathStyle: true,
        },
        protectionMode: "recoveryKey",
        includeCredentials: true,
        retentionCount: 20,
      }),
    ).toEqual({
      storage: {
        profileId: "work",
        endpoint: "https://s3.example.com",
        region: "eu-west-1",
        bucket: "backup",
        prefix: "FineShell/device",
      },
      protectionMode: "recoveryKey",
      includeCredentials: true,
      retentionCount: 20,
    });
  });

  test("bounds retention and rejects unsupported protection modes", () => {
    const sanitized = sanitizeCloudBackupSettings({
      protectionMode: "unknown",
      retentionCount: 999,
    });
    expect(sanitized.protectionMode).toBe("password");
    expect(sanitized.retentionCount).toBe(100);
    expect(sanitized.storage).toEqual(DEFAULT_CLOUD_BACKUP_SETTINGS.storage);
  });
});
