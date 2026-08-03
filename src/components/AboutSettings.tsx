import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Input,
  Message,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Typography,
} from "@arco-design/web-react";
import {
  IconDownload,
  IconFile,
  IconGithub,
  IconRefresh,
} from "@arco-design/web-react/icon";
import {
  FINESHELL_LICENSE_URL,
  FINESHELL_REPOSITORY_URL,
  applicationUpdater,
  formatUpdateBytes,
  isApplicationUpdateInstalling,
  openApplicationUrl,
  setApplicationUpdateNotice,
  setApplicationUpdateInstalling,
  type ApplicationInfo,
  type ApplicationUpdate,
  type ApplicationUpdateNotice,
  type ApplicationUpdaterService,
  applicationUpdateOptionsFromSettings,
} from "../app-updater";
import type { AppSettings } from "../app-settings";
import ReleaseNotesMarkdown from "./ReleaseNotesMarkdown";

type UpdateStatus =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  | "downloading"
  | "restarting"
  | "error";

interface AboutSettingsProps {
  knownUpdate?: ApplicationUpdateNotice | null;
  settings?: AppSettings;
  updateSetting?: <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => void;
  updater?: ApplicationUpdaterService;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function releaseDate(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
  }).format(date);
}

function AboutSettings({
  knownUpdate = null,
  settings,
  updateSetting,
  updater = applicationUpdater,
}: AboutSettingsProps) {
  const [applicationInfo, setApplicationInfo] = useState<ApplicationInfo>();
  const [applicationInfoError, setApplicationInfoError] = useState("");
  const [availableUpdate, setAvailableUpdate] =
    useState<ApplicationUpdate | null>(null);
  const [status, setStatus] = useState<UpdateStatus>(() =>
    isApplicationUpdateInstalling() ? "downloading" : "idle",
  );
  const [updateError, setUpdateError] = useState("");
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [downloadRoute, setDownloadRoute] = useState("");
  const [testingRoute, setTestingRoute] = useState(false);
  const updateRef = useRef<ApplicationUpdate | null>(null);
  const mountedRef = useRef(true);
  const checkRequestRef = useRef(0);
  const installingRef = useRef(isApplicationUpdateInstalling());
  const automaticallyCheckedVersionRef = useRef<string>();

  useEffect(() => {
    let disposed = false;
    void updater
      .getApplicationInfo()
      .then((info) => {
        if (!disposed) setApplicationInfo(info);
      })
      .catch((error) => {
        if (!disposed) setApplicationInfoError(errorMessage(error));
      });
    return () => {
      disposed = true;
    };
  }, [updater]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      checkRequestRef.current += 1;
      if (updateRef.current && !installingRef.current) {
        const update = updateRef.current;
        updateRef.current = null;
        void update.close();
      }
    };
  }, []);

  const replaceAvailableUpdate = useCallback(
    (next: ApplicationUpdate | null) => {
      const previous = updateRef.current;
      updateRef.current = next;
      if (mountedRef.current) setAvailableUpdate(next);
      if (previous && previous !== next) void previous.close();
    },
    [],
  );

  const checkForUpdate = useCallback(async () => {
    const request = checkRequestRef.current + 1;
    checkRequestRef.current = request;
    replaceAvailableUpdate(null);
    setStatus("checking");
    setUpdateError("");
    setDownloadedBytes(0);
    setTotalBytes(0);
    try {
      const update = await updater.checkForUpdate(
        settings ? applicationUpdateOptionsFromSettings(settings) : undefined,
      );
      if (!mountedRef.current || checkRequestRef.current !== request) {
        if (update) await update.close();
        return;
      }
      replaceAvailableUpdate(update);
      setDownloadRoute(update?.route ?? "");
      if (update) automaticallyCheckedVersionRef.current = update.version;
      setApplicationUpdateNotice(update);
      setStatus(update ? "available" : "latest");
    } catch (error) {
      if (!mountedRef.current || checkRequestRef.current !== request) return;
      setStatus("error");
      setUpdateError(errorMessage(error));
    }
  }, [
    replaceAvailableUpdate,
    settings?.githubMirrorCustomUrl,
    settings?.githubMirrorRoute,
    updater,
  ]);

  const knownUpdateVersion = knownUpdate?.version;

  useEffect(() => {
    if (
      !updater.canInstallUpdates ||
      !knownUpdateVersion ||
      automaticallyCheckedVersionRef.current === knownUpdateVersion
    ) {
      return;
    }
    automaticallyCheckedVersionRef.current = knownUpdateVersion;
    void checkForUpdate();
    return () => {
      if (
        automaticallyCheckedVersionRef.current === knownUpdateVersion
      ) {
        automaticallyCheckedVersionRef.current = undefined;
      }
    };
  }, [checkForUpdate, knownUpdateVersion, updater.canInstallUpdates]);

  const downloadAndInstall = async (update: ApplicationUpdate) => {
    installingRef.current = true;
    setApplicationUpdateInstalling(true);
    setStatus("downloading");
    setUpdateError("");
    setDownloadedBytes(0);
    setTotalBytes(0);
    let downloaded = 0;
    let contentLength = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          if (mountedRef.current) setTotalBytes(contentLength);
          return;
        }
        if (event.event === "Fallback") {
          downloaded = 0;
          contentLength = 0;
          if (mountedRef.current) {
            setDownloadedBytes(0);
            setTotalBytes(0);
            setDownloadRoute(event.data.route);
          }
          return;
        }
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (mountedRef.current) setDownloadedBytes(downloaded);
          return;
        }
        if (contentLength > 0 && mountedRef.current) {
          setDownloadedBytes(contentLength);
        }
      });
      setApplicationUpdateNotice(null);
      if (mountedRef.current) setStatus("restarting");
      await updater.relaunch();
    } catch (error) {
      if (mountedRef.current) {
        setStatus("error");
        setUpdateError(errorMessage(error));
      }
    } finally {
      installingRef.current = false;
      setApplicationUpdateInstalling(false);
      if (!mountedRef.current && updateRef.current === update) {
        updateRef.current = null;
        void update.close();
      }
    }
  };

  const confirmInstallation = () => {
    if (!availableUpdate) return;
    const update = availableUpdate;
    Modal.confirm({
      cancelText: "稍后",
      content:
        "更新会关闭当前 SSH 会话并中断正在进行的文件传输。请确认重要任务已经完成。",
      okText: "下载并安装",
      onOk: () => {
        void downloadAndInstall(update);
      },
      title: `安装 FineShell ${update.version}？`,
    });
  };

  const testUpdateRoute = async () => {
    if (!settings || !updater.testRoute) return;
    setTestingRoute(true);
    try {
      const result = await updater.testRoute(
        applicationUpdateOptionsFromSettings(settings),
      );
      Message.success(
        `线路可用：${result.route}（${result.latencyMs} ms）`,
      );
    } catch (error) {
      Message.error(errorMessage(error));
    } finally {
      setTestingRoute(false);
    }
  };

  const progressPercent =
    totalBytes > 0
      ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
      : 0;
  const updateSummary = availableUpdate ?? knownUpdate;
  const showUpdateSummary =
    updateSummary !== null &&
    (status === "idle" ||
      status === "checking" ||
      status === "available" ||
      status === "error");

  return (
    <div className="about-settings">
      <Typography.Title heading={5}>关于</Typography.Title>

      <div className="about-product">
        <img alt="FineShell" className="about-product-logo" src="/app-icon.png" />
        <div className="about-product-copy">
          <Typography.Title heading={4}>
            {applicationInfo?.name ?? "FineShell"}
          </Typography.Title>
          <Typography.Text type="secondary">
            跨平台 SSH 与 SFTP 客户端
          </Typography.Text>
        </div>
      </div>

      <div className="settings-group about-information">
        <div className="settings-row">
          <Typography.Text>当前版本</Typography.Text>
          {applicationInfo ? (
            <Typography.Text>v{applicationInfo.version}</Typography.Text>
          ) : applicationInfoError ? (
            <Typography.Text type="error">读取失败</Typography.Text>
          ) : (
            <Spin size={16} />
          )}
        </div>
        {applicationInfo?.tauriVersion && (
          <div className="settings-row">
            <Typography.Text>Tauri</Typography.Text>
            <Typography.Text>{applicationInfo.tauriVersion}</Typography.Text>
          </div>
        )}
        <div className="settings-row">
          <Typography.Text>开源许可</Typography.Text>
          <Typography.Text>Apache-2.0</Typography.Text>
        </div>
      </div>

      <Space className="about-links" size="small">
        <Button
          icon={<IconGithub />}
          onClick={() => void openApplicationUrl(FINESHELL_REPOSITORY_URL)}
          type="text"
        >
          GitHub
        </Button>
        <Button
          icon={<IconFile />}
          onClick={() => void openApplicationUrl(FINESHELL_LICENSE_URL)}
          type="text"
        >
          开源许可
        </Button>
      </Space>

      <section className="about-update-section">
        {settings && updateSetting && (
          <div className="about-update-route">
            <Typography.Title heading={6}>更新线路</Typography.Title>
            <div className="about-update-route-controls">
              <Select
                aria-label="更新线路"
                disabled={status === "downloading" || status === "restarting"}
                onChange={(value) => updateSetting("githubMirrorRoute", value)}
                value={settings.githubMirrorRoute}
              >
                <Select.Option value="auto">自动选择（推荐）</Select.Option>
                <Select.Option value="direct">GitHub 直连</Select.Option>
                <Select.Option value="gh-proxy.com">gh-proxy.com</Select.Option>
                <Select.Option value="ghproxy.net">ghproxy.net</Select.Option>
                <Select.Option value="githubproxy.cc">githubproxy.cc</Select.Option>
                <Select.Option value="custom">自定义镜像</Select.Option>
              </Select>
              <Button
                disabled={
                  !updater.canInstallUpdates ||
                  (settings.githubMirrorRoute === "custom" &&
                    !settings.githubMirrorCustomUrl.trim())
                }
                loading={testingRoute}
                onClick={() => void testUpdateRoute()}
              >
                测试线路
              </Button>
            </div>
            {settings.githubMirrorRoute === "custom" && (
              <Input
                aria-label="自定义镜像地址"
                disabled={status === "downloading" || status === "restarting"}
                onChange={(value) =>
                  updateSetting("githubMirrorCustomUrl", value)
                }
                placeholder="https://mirror.example.com/"
                value={settings.githubMirrorCustomUrl}
              />
            )}
            <Typography.Text type="secondary">
              镜像线路由第三方提供；不可用时会自动回退 GitHub 直连。
            </Typography.Text>
          </div>
        )}

        <div className="about-update-heading">
          <div>
            <Typography.Title heading={6}>软件更新</Typography.Title>
          </div>
          {availableUpdate &&
          (status === "available" || status === "error") ? (
            <Button
              icon={<IconDownload />}
              onClick={confirmInstallation}
              type="primary"
            >
              下载并安装
            </Button>
          ) : (
            <Button
              disabled={
                !updater.canInstallUpdates ||
                status === "downloading" ||
                status === "restarting"
              }
              icon={<IconRefresh />}
              loading={status === "checking"}
              onClick={() => void checkForUpdate()}
            >
              检查更新
            </Button>
          )}
        </div>

        {!updater.canInstallUpdates && (
          <Alert
            content="开发模式不支持安装更新，请使用正式安装包测试。"
            type="info"
          />
        )}

        {status === "latest" && (
          <Alert content="当前已是最新版本。" type="success" />
        )}

        {showUpdateSummary && updateSummary && (
          <div className="about-release">
            <div className="about-release-heading">
              <Typography.Text bold>
                发现新版本 v{updateSummary.version}
              </Typography.Text>
              {releaseDate(updateSummary.date) && (
                <Typography.Text type="secondary">
                  {releaseDate(updateSummary.date)}
                </Typography.Text>
              )}
            </div>
            {updateSummary.body && (
              <ReleaseNotesMarkdown className="about-release-notes">
                {updateSummary.body}
              </ReleaseNotesMarkdown>
            )}
          </div>
        )}

        {status === "downloading" && (
          <div className="about-download-progress">
            <div className="about-download-meta">
              <Typography.Text>
                正在下载更新{downloadRoute ? ` · ${downloadRoute}` : ""}
              </Typography.Text>
              <Typography.Text type="secondary">
                {formatUpdateBytes(downloadedBytes)}
                {totalBytes > 0 ? ` / ${formatUpdateBytes(totalBytes)}` : ""}
              </Typography.Text>
            </div>
            {totalBytes > 0 ? (
              <Progress percent={progressPercent} showText={false} />
            ) : (
              <Spin size={18} />
            )}
          </div>
        )}

        {status === "restarting" && (
          <Alert content="更新已安装，正在重新启动 FineShell…" type="success" />
        )}

        {status === "error" && (
          <Alert
            content={updateError || "更新失败，请稍后重试。"}
            type="error"
          />
        )}
      </section>
    </div>
  );
}

export default AboutSettings;
