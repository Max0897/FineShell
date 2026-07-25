import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Modal,
  Progress,
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
  openApplicationUrl,
  setApplicationUpdateNotice,
  type ApplicationInfo,
  type ApplicationUpdate,
  type ApplicationUpdaterService,
} from "../app-updater";

type UpdateStatus =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  | "downloading"
  | "restarting"
  | "error";

interface AboutSettingsProps {
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

function AboutSettings({ updater = applicationUpdater }: AboutSettingsProps) {
  const [applicationInfo, setApplicationInfo] = useState<ApplicationInfo>();
  const [applicationInfoError, setApplicationInfoError] = useState("");
  const [availableUpdate, setAvailableUpdate] =
    useState<ApplicationUpdate | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [updateError, setUpdateError] = useState("");
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const updateRef = useRef<ApplicationUpdate | null>(null);

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

  useEffect(
    () => () => {
      if (updateRef.current) void updateRef.current.close();
    },
    [],
  );

  const replaceAvailableUpdate = (next: ApplicationUpdate | null) => {
    const previous = updateRef.current;
    updateRef.current = next;
    setAvailableUpdate(next);
    if (previous && previous !== next) void previous.close();
  };

  const checkForUpdate = async () => {
    replaceAvailableUpdate(null);
    setStatus("checking");
    setUpdateError("");
    setDownloadedBytes(0);
    setTotalBytes(0);
    try {
      const update = await updater.checkForUpdate();
      replaceAvailableUpdate(update);
      setApplicationUpdateNotice(update);
      setStatus(update ? "available" : "latest");
    } catch (error) {
      setStatus("error");
      setUpdateError(errorMessage(error));
    }
  };

  const downloadAndInstall = async (update: ApplicationUpdate) => {
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
          setTotalBytes(contentLength);
          return;
        }
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setDownloadedBytes(downloaded);
          return;
        }
        if (contentLength > 0) setDownloadedBytes(contentLength);
      });
      setApplicationUpdateNotice(null);
      setStatus("restarting");
      await updater.relaunch();
    } catch (error) {
      setStatus("error");
      setUpdateError(errorMessage(error));
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

  const progressPercent =
    totalBytes > 0
      ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
      : 0;

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
        <div className="about-update-heading">
          <div>
            <Typography.Title heading={6}>软件更新</Typography.Title>
            <Typography.Text type="secondary">
              通过 GitHub Releases 获取经过签名验证的正式版本
            </Typography.Text>
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

        {status === "available" && availableUpdate && (
          <div className="about-release">
            <div className="about-release-heading">
              <Typography.Text bold>
                发现新版本 v{availableUpdate.version}
              </Typography.Text>
              {releaseDate(availableUpdate.date) && (
                <Typography.Text type="secondary">
                  {releaseDate(availableUpdate.date)}
                </Typography.Text>
              )}
            </div>
            {availableUpdate.body && (
              <Typography.Paragraph className="about-release-notes">
                {availableUpdate.body}
              </Typography.Paragraph>
            )}
          </div>
        )}

        {status === "downloading" && (
          <div className="about-download-progress">
            <div className="about-download-meta">
              <Typography.Text>正在下载更新</Typography.Text>
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
