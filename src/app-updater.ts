import packageMetadata from "../package.json";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
} from "@tauri-apps/plugin-updater";

export const FINESHELL_REPOSITORY_URL =
  "https://github.com/Max0897/fineshell";
export const FINESHELL_LICENSE_URL = `${FINESHELL_REPOSITORY_URL}/blob/main/LICENSE`;
const APPLICATION_UPDATE_NOTICE_KEY = "fineshell:application-update";
const APPLICATION_UPDATE_NOTICE_EVENT = "fineshell:application-update-changed";

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
    onEvent?: (event: DownloadEvent) => void,
  ) => Promise<void>;
  version: string;
}

export interface ApplicationUpdaterService {
  canInstallUpdates: boolean;
  checkForUpdate: () => Promise<ApplicationUpdate | null>;
  getApplicationInfo: () => Promise<ApplicationInfo>;
  relaunch: () => Promise<void>;
}

export interface ApplicationUpdateNotice {
  date?: string;
  version: string;
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

const canInstallUpdates = isTauri() && !import.meta.env.DEV;

export const applicationUpdater: ApplicationUpdaterService = {
  canInstallUpdates,
  getApplicationInfo,
  async checkForUpdate() {
    if (!canInstallUpdates) {
      throw new Error("开发模式不支持安装更新，请使用正式安装包测试");
    }
    return check({ timeout: 15_000 });
  },
  relaunch,
};

let startupUpdateCheck: Promise<ApplicationUpdate | null> | undefined;

export function checkForApplicationUpdateOnStartup() {
  if (!applicationUpdater.canInstallUpdates) {
    return Promise.resolve<ApplicationUpdate | null>(null);
  }
  startupUpdateCheck ??= applicationUpdater.checkForUpdate();
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
      !value.version.trim()
    ) {
      return null;
    }
    return {
      version: value.version,
      date:
        "date" in value && typeof value.date === "string"
          ? value.date
          : undefined,
    };
  } catch {
    return null;
  }
}

export function setApplicationUpdateNotice(
  update: Pick<ApplicationUpdate, "date" | "version"> | null,
) {
  if (typeof window === "undefined") return;
  try {
    if (update) {
      window.localStorage.setItem(
        APPLICATION_UPDATE_NOTICE_KEY,
        JSON.stringify({ version: update.version, date: update.date }),
      );
    } else {
      window.localStorage.removeItem(APPLICATION_UPDATE_NOTICE_KEY);
    }
  } catch {
    // The update flow still works when persistent web storage is unavailable.
  }
  window.dispatchEvent(new Event(APPLICATION_UPDATE_NOTICE_EVENT));
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
