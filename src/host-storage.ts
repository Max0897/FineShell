import type { HostFormValues, HostRecord } from "./models";

type StoredHostRecord = Omit<
  HostRecord,
  | "authMethod"
  | "connectTimeoutSeconds"
  | "keepAliveIntervalSeconds"
  | "autoReconnect"
  | "maxReconnectAttempts"
> &
  Partial<
    Pick<
      HostRecord,
      | "authMethod"
      | "connectTimeoutSeconds"
      | "keepAliveIntervalSeconds"
      | "autoReconnect"
      | "maxReconnectAttempts"
    >
  >;

export function withHostDefaults(host: StoredHostRecord): HostRecord {
  return {
    ...host,
    authMethod: host.authMethod ?? "password",
    connectTimeoutSeconds: host.connectTimeoutSeconds ?? 10,
    keepAliveIntervalSeconds: host.keepAliveIntervalSeconds ?? 15,
    autoReconnect: host.autoReconnect ?? true,
    maxReconnectAttempts: host.maxReconnectAttempts ?? 3,
  };
}

export function normalizeHostForm(values: HostFormValues) {
  const { password, privateKeyPassphrase, ...hostValues } = values;
  return {
    password: values.authMethod === "password" ? password : undefined,
    privateKeyPassphrase:
      values.authMethod === "privateKey" ? privateKeyPassphrase : undefined,
    host: {
      ...hostValues,
      name: values.name.trim(),
      address: values.address.trim(),
      username: values.username.trim(),
      privateKeyPath:
        values.authMethod === "privateKey"
          ? values.privateKeyPath?.trim() || undefined
          : undefined,
      group: values.group?.trim() || undefined,
      hostFingerprint: values.hostFingerprint?.trim() || undefined,
    },
  };
}
