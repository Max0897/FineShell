import type { HostFormValues, HostRecord } from "./models";
import { normalizeGroupPath } from "./host-organization";

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
    group: normalizeGroupPath(host.group),
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
      localPortForwards: values.localPortForwards?.map((rule) => ({
        ...rule,
        name: rule.name.trim(),
        bindAddress: rule.bindAddress.trim(),
        targetAddress: rule.targetAddress.trim(),
      })),
      remotePortForwards: values.remotePortForwards?.map((rule) => ({
        ...rule,
        name: rule.name.trim(),
        bindAddress: rule.bindAddress.trim(),
        targetAddress: rule.targetAddress.trim(),
      })),
      group: normalizeGroupPath(values.group),
      hostFingerprint: values.hostFingerprint?.trim() || undefined,
    },
  };
}

export function jumpHostSelectionError(
  hostId: string,
  jumpHostId: string | undefined,
  hosts: HostRecord[],
) {
  if (!jumpHostId) return undefined;
  if (hostId === jumpHostId) return "主机不能将自身设置为跳板机";

  const jumpHost = hosts.find((host) => host.id === jumpHostId);
  if (!jumpHost) return "选择的跳板机不存在，请重新选择";
  if (jumpHost.jumpHostId) return "当前仅支持一级跳板机连接";
  if (hosts.some((host) => host.id !== hostId && host.jumpHostId === hostId)) {
    return "当前主机已被其他主机用作跳板机，不能再配置上级跳板机";
  }
  return undefined;
}
