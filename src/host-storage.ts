import type { HostFormValues } from "./models";

export function normalizeHostForm(values: HostFormValues) {
  const { password, ...hostValues } = values;
  return {
    password,
    host: {
      ...hostValues,
      name: values.name.trim(),
      address: values.address.trim(),
      username: values.username.trim(),
      group: values.group?.trim() || undefined,
      hostFingerprint: values.hostFingerprint?.trim() || undefined,
    },
  };
}
