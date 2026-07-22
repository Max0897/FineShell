import type { HostFormValues } from "./models";

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
