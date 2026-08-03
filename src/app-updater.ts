import packageMetadata from "../package.json";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AppSettings, GithubMirrorRoute } from "./app-settings";
import { loadConfiguration } from "./config-database";
import { invokeProtocolCommand } from "./tauri-protocol";

export const FINESHELL_REPOSITORY_URL =
  "https://github.com/Max0897/fineshell";
export const FINESHELL_LICENSE_URL = `${FINESHELL_REPOSITORY_URL}/blob/main/LICENSE`;
const APPLICATION_UPDATE_NOTICE_KEY = "fineshell:application-update";
const APPLICATION_UPDATE_NOTICE_EVENT = "fineshell:application-update-changed";
const APPLICATION_UPDATE_INSTALLING_EVENT =
  "fineshell:application-update-installing-changed";
const MOCK_UPDATE_SIZE = 6 * 1024 * 1024;
const MOCK_UPDATE_BODY = `### 新增

- 支持从 \`CHANGELOG.md\` 读取版本说明。
- 更新弹窗现在可以渲染 **GitHub 风格 Markdown**。

### 优化

- 优化服务器监控操作入口。
- 调整更新说明的间距与滚动区域。

| 模块 | 本次变化 |
| --- | --- |
| 版本发布 | 自动生成 Release Notes |
| 应用更新 | 展示结构化更新内容 |`;

export interface ApplicationInfo {
  name: string;
  tauriVersion?: string;
  version: string;
}

export interface ApplicationUpdate {
  body?: string;
  close: () => Promise<void>;
  currentVersion: string;
  date?: string;
  downloadAndInstall: (
    onEvent?: (event: ApplicationUpdateDownloadEvent) => void,
  ) => Promise<void>;
  route?: string;
  version: string;
}

export type ApplicationUpdateDownloadEvent =
  | {
      event: "Started";
      data: { contentLength?: number };
    }
  | {
      event: "Progress";
      data: { chunkLength: number };
    }
  | { event: "Finished" }
  | { event: "Fallback"; data: { route: string } };

export interface ApplicationUpdateOptions {
  customUrl?: string;
  route: GithubMirrorRoute;
}

interface ApplicationUpdateMetadata {
  body?: string;
  currentVersion: string;
  date?: string;
  route: string;
  updateId: number;
  version: string;
}

export interface ApplicationUpdateRouteTestResult {
  latencyMs: number;
  route: string;
}

export interface ApplicationUpdaterService {
  canInstallUpdates: boolean;
  checkForUpdate: (
    options?: ApplicationUpdateOptions,
  ) => Promise<ApplicationUpdate | null>;
  getApplicationInfo: () => Promise<ApplicationInfo>;
  relaunch: () => Promise<void>;
  testRoute: (
    options: ApplicationUpdateOptions,
  ) => Promise<ApplicationUpdateRouteTestResult>;
}

export interface ApplicationUpdateNotice {
  body?: string;
  currentVersion: string;
  date?: string;
  version: string;
}

let applicationUpdateInstalling = false;

export function createMockApplicationUpdate(): ApplicationUpdate {
  return {
    body: MOCK_UPDATE_BODY,
    close: async () => undefined,
    currentVersion: packageMetadata.version,
    date: "2026-07-25T00:00:00Z",
    async downloadAndInstall(onEvent) {
      onEvent?.({
        data: { contentLength: MOCK_UPDATE_SIZE },
        event: "Started",
      });
      const chunkLength = MOCK_UPDATE_SIZE / 8;
      for (let chunk = 0; chunk < 8; chunk += 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        onEvent?.({ data: { chunkLength }, event: "Progress" });
      }
      onEvent?.({ event: "Finished" });
    },
    route: "模拟更新",
    version: "0.2.0",
  };
}

export function applicationUpdateOptionsFromSettings(
  settings: Pick<
    AppSettings,
    "githubMirrorCustomUrl" | "githubMirrorRoute"
  >,
): ApplicationUpdateOptions {
  return {
    customUrl: settings.githubMirrorCustomUrl || undefined,
    route: settings.githubMirrorRoute,
  };
}

async function savedApplicationUpdateOptions() {
  const configuration = await loadConfiguration();
  return applicationUpdateOptionsFromSettings(configuration.settings);
}

function applicationUpdateFromMetadata(
  metadata: ApplicationUpdateMetadata,
): ApplicationUpdate {
  return {
    body: metadata.body,
    close: () =>
      invokeProtocolCommand("application_update_close", {
        updateId: metadata.updateId,
      }),
    currentVersion: metadata.currentVersion,
    date: metadata.date,
    downloadAndInstall(onEvent) {
      const onEventChannel = new Channel<ApplicationUpdateDownloadEvent>();
      if (onEvent) onEventChannel.onmessage = onEvent;
      return invokeProtocolCommand("application_update_download_and_install", {
        onEvent: onEventChannel,
        updateId: metadata.updateId,
      });
    },
    route: metadata.route,
    version: metadata.version,
  };
}

async function getApplicationInfo(): Promise<ApplicationInfo> {
  if (!isTauri()) {
    return {
      name: "FineShell",
      version: packageMetadata.version,
    };
  }

  const [name, version, tauriVersion] = await Promise.all([
    getName(),
    getVersion(),
    getTauriVersion(),
  ]);
  return { name, version, tauriVersion };
}

const mockApplicationUpdateEnabled =
  import.meta.env.DEV && import.meta.env.VITE_MOCK_UPDATE === "true";
const canInstallUpdates =
  mockApplicationUpdateEnabled || (isTauri() && !import.meta.env.DEV);

export const applicationUpdater: ApplicationUpdaterService = {
  canInstallUpdates,
  getApplicationInfo,
  async checkForUpdate(options) {
    if (mockApplicationUpdateEnabled) {
      return createMockApplicationUpdate();
    }
    if (!canInstallUpdates) {
      throw new Error("开发模式不支持安装更新，请使用正式安装包测试");
    }
    const request = options ?? (await savedApplicationUpdateOptions());
    const metadata = await invokeProtocolCommand<ApplicationUpdateMetadata | null>(
      "application_update_check",
      { request },
    );
    return metadata ? applicationUpdateFromMetadata(metadata) : null;
  },
  relaunch: mockApplicationUpdateEnabled ? async () => undefined : relaunch,
  async testRoute(options) {
    if (mockApplicationUpdateEnabled) {
      return { latencyMs: 80, route: "模拟更新" };
    }
    if (!canInstallUpdates) {
      throw new Error("开发模式不支持测试更新线路，请使用正式安装包测试");
    }
    return invokeProtocolCommand("application_update_test_route", {
      request: options,
    });
  },
};

let startupUpdateCheck: Promise<ApplicationUpdate | null> | undefined;

export function checkForApplicationUpdateOnStartup() {
  if (!applicationUpdater.canInstallUpdates) {
    return Promise.resolve<ApplicationUpdate | null>(null);
  }
  startupUpdateCheck ??= savedApplicationUpdateOptions().then((options) =>
    applicationUpdater.checkForUpdate(options),
  );
  return startupUpdateCheck;
}

export function readApplicationUpdateNotice(): ApplicationUpdateNotice | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(APPLICATION_UPDATE_NOTICE_KEY) ?? "null",
    ) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      typeof value.version !== "string" ||
      !value.version.trim() ||
      !("currentVersion" in value) ||
      typeof value.currentVersion !== "string" ||
      value.currentVersion !== packageMetadata.version ||
      value.version === value.currentVersion
    ) {
      window.localStorage.removeItem(APPLICATION_UPDATE_NOTICE_KEY);
      return null;
    }
    return {
      body:
        "body" in value && typeof value.body === "string"
          ? value.body
          : undefined,
      currentVersion: value.currentVersion,
      version: value.version,
      date:
        "date" in value && typeof value.date === "string"
          ? value.date
          : undefined,
    };
  } catch {
    try {
      window.localStorage.removeItem(APPLICATION_UPDATE_NOTICE_KEY);
    } catch {
      // Ignore unavailable persistent storage.
    }
    return null;
  }
}

export function setApplicationUpdateNotice(
  update: Pick<
    ApplicationUpdate,
    "body" | "currentVersion" | "date" | "version"
  > | null,
) {
  if (typeof window === "undefined") return;
  try {
    if (update) {
      window.localStorage.setItem(
        APPLICATION_UPDATE_NOTICE_KEY,
        JSON.stringify({
          body: update.body,
          currentVersion: update.currentVersion,
          date: update.date,
          version: update.version,
        }),
      );
    } else {
      window.localStorage.removeItem(APPLICATION_UPDATE_NOTICE_KEY);
    }
  } catch {
    // The update flow still works when persistent web storage is unavailable.
  }
  window.dispatchEvent(new Event(APPLICATION_UPDATE_NOTICE_EVENT));
}

export function isApplicationUpdateInstalling() {
  return applicationUpdateInstalling;
}

export function setApplicationUpdateInstalling(installing: boolean) {
  if (applicationUpdateInstalling === installing) return;
  applicationUpdateInstalling = installing;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(APPLICATION_UPDATE_INSTALLING_EVENT));
  }
}

export function listenApplicationUpdateInstalling(
  handler: (installing: boolean) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  const handleInstalling = () => handler(applicationUpdateInstalling);
  window.addEventListener(
    APPLICATION_UPDATE_INSTALLING_EVENT,
    handleInstalling,
  );
  return () => {
    window.removeEventListener(
      APPLICATION_UPDATE_INSTALLING_EVENT,
      handleInstalling,
    );
  };
}

export function listenApplicationUpdateNotice(
  handler: (notice: ApplicationUpdateNotice | null) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  const handleNotice = () => handler(readApplicationUpdateNotice());
  const handleStorage = (event: StorageEvent) => {
    if (event.key === APPLICATION_UPDATE_NOTICE_KEY) handleNotice();
  };
  window.addEventListener(APPLICATION_UPDATE_NOTICE_EVENT, handleNotice);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(APPLICATION_UPDATE_NOTICE_EVENT, handleNotice);
    window.removeEventListener("storage", handleStorage);
  };
}

export async function openApplicationUrl(url: string) {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function formatUpdateBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
