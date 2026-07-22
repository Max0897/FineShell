import type { ServerProcess } from "./models";

export function filterServerProcesses(
  processes: ServerProcess[],
  query: string,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalizedQuery) return processes;
  return processes.filter((process) =>
    [
      process.pid,
      process.parentPid,
      process.user,
      process.state,
      process.name,
      process.command,
    ].some((value) =>
      String(value).toLocaleLowerCase("zh-CN").includes(normalizedQuery),
    ),
  );
}

export function formatProcessPercent(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0.0%";
  return `${value.toFixed(1)}%`;
}

export function formatProcessElapsed(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(wholeSeconds / 86_400);
  const hours = Math.floor((wholeSeconds % 86_400) / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${remainingSeconds} 秒`;
  return `${remainingSeconds} 秒`;
}
