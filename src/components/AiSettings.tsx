import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  InputNumber,
  Message,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { IconRefresh } from "@arco-design/web-react/icon";
import type { AppSettings, AiProvider } from "../app-settings";
import {
  AI_PROVIDER_PRESETS,
  aiModelFetchSignature,
  inferAiProvider,
  isLocalAiBaseUrl,
} from "../ai-providers";
import { diagnosticInvoke as invoke } from "../diagnostics";
import {
  commandErrorMessage,
  type AiModelInfo,
} from "../tauri-protocol";

interface AiSettingsProps {
  settings: AppSettings;
  updateSetting: <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => void;
}

type ConnectionState = "success" | "failed" | null;

function AiSettings({ settings, updateSetting }: AiSettingsProps) {
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loadingKeyStatus, setLoadingKeyStatus] = useState(true);
  const [savingKey, setSavingKey] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [modelListError, setModelListError] = useState("");
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [testing, setTesting] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>(null);
  const localService = useMemo(
    () => isLocalAiBaseUrl(settings.aiBaseUrl),
    [settings.aiBaseUrl],
  );
  const canAuthenticate = localService || hasApiKey;
  const modelRequestRef = useRef(0);
  const lastAutoFetchSignatureRef = useRef("");
  const autoFetchTimerRef = useRef<number>();

  useEffect(() => {
    let disposed = false;
    void invoke<boolean>("ai_api_key_status")
      .then((exists) => {
        if (!disposed) setHasApiKey(exists);
      })
      .catch((error) => {
        if (!disposed) Message.error(commandErrorMessage(error));
      })
      .finally(() => {
        if (!disposed) setLoadingKeyStatus(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(
    () => () => {
      modelRequestRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    modelRequestRef.current += 1;
    setLoadingModels(false);
    setModels([]);
    setModelListError("");
    setConnectionState(null);
  }, [settings.aiBaseUrl]);

  useEffect(() => {
    setConnectionState(null);
  }, [settings.aiModel]);

  const changeProvider = (provider: AiProvider) => {
    updateSetting("aiProvider", provider);
    const preset = AI_PROVIDER_PRESETS.find((item) => item.value === provider);
    if (preset?.baseUrl) {
      updateSetting("aiBaseUrl", preset.baseUrl);
      updateSetting("aiModel", "");
    }
  };

  const changeBaseUrl = (baseUrl: string) => {
    updateSetting("aiBaseUrl", baseUrl);
    updateSetting("aiProvider", inferAiProvider(baseUrl));
  };

  const saveApiKey = async () => {
    if (!apiKey.trim()) {
      Message.warning("请输入 API Key");
      return;
    }
    setSavingKey(true);
    try {
      await invoke("store_ai_api_key", { apiKey: apiKey.trim() });
      setApiKey("");
      setHasApiKey(true);
      setCredentialRevision((current) => current + 1);
      setConnectionState(null);
      Message.success("API Key 已保存到系统凭据库");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setSavingKey(false);
    }
  };

  const deleteApiKey = async () => {
    try {
      await invoke("delete_ai_api_key");
      setApiKey("");
      setHasApiKey(false);
      setModels([]);
      setModelListError("");
      setConnectionState(null);
      Message.success("API Key 已删除");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    }
  };

  const loadModels = async (silent = false) => {
    if (loadingKeyStatus) {
      if (!silent) Message.info("正在读取 API Key 状态，请稍候");
      return;
    }
    if (!canAuthenticate) {
      if (!silent) Message.warning("请先保存 API Key");
      return;
    }
    const requestId = modelRequestRef.current + 1;
    modelRequestRef.current = requestId;
    setLoadingModels(true);
    setModelListError("");
    try {
      const result = await invoke<AiModelInfo[]>("ai_list_models", {
        request: { baseUrl: settings.aiBaseUrl },
      });
      if (modelRequestRef.current !== requestId) return;
      setModels(result);
      if (!result.length) {
        setModelListError("服务未返回模型，可直接输入模型名称");
        if (!silent) Message.info("服务没有返回可用模型");
      }
    } catch (error) {
      if (modelRequestRef.current !== requestId) return;
      setModelListError("模型列表获取失败，可手动刷新或直接输入");
      if (!silent) Message.error(commandErrorMessage(error));
    } finally {
      if (modelRequestRef.current === requestId) setLoadingModels(false);
    }
  };

  const autoFetchSignature = loadingKeyStatus
    ? ""
    : aiModelFetchSignature(
        settings.aiBaseUrl,
        hasApiKey,
        credentialRevision,
      );

  useEffect(() => {
    if (!autoFetchSignature) {
      lastAutoFetchSignatureRef.current = "";
      return;
    }
    if (lastAutoFetchSignatureRef.current === autoFetchSignature) return;
    lastAutoFetchSignatureRef.current = autoFetchSignature;
    const timer = window.setTimeout(() => {
      autoFetchTimerRef.current = undefined;
      void loadModels(true);
    }, 600);
    autoFetchTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (autoFetchTimerRef.current === timer) {
        autoFetchTimerRef.current = undefined;
      }
    };
  }, [autoFetchSignature]);

  const refreshModels = () => {
    if (autoFetchTimerRef.current !== undefined) {
      window.clearTimeout(autoFetchTimerRef.current);
      autoFetchTimerRef.current = undefined;
    }
    lastAutoFetchSignatureRef.current = autoFetchSignature;
    void loadModels();
  };

  const testConnection = async () => {
    if (loadingKeyStatus) {
      Message.info("正在读取 API Key 状态，请稍候");
      return;
    }
    if (!settings.aiModel.trim()) {
      Message.warning("请先选择或填写模型名称");
      return;
    }
    if (!canAuthenticate) {
      Message.warning("请先保存 API Key");
      return;
    }
    setTesting(true);
    setConnectionState(null);
    try {
      await invoke("ai_test_connection", {
        request: {
          baseUrl: settings.aiBaseUrl,
          model: settings.aiModel,
        },
      });
      setConnectionState("success");
      Message.success("AI 服务连接正常");
    } catch (error) {
      setConnectionState("failed");
      Message.error(commandErrorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="ai-settings settings-group">
      <div className="settings-row">
        <Typography.Text>服务类型</Typography.Text>
        <div className="settings-control">
          <Select
            aria-label="AI 服务类型"
            onChange={(value) => changeProvider(value as AiProvider)}
            options={AI_PROVIDER_PRESETS.map(({ label, value }) => ({
              label,
              value,
            }))}
            value={settings.aiProvider}
          />
        </div>
      </div>
      <div className="settings-row">
        <Typography.Text>服务地址</Typography.Text>
        <div className="settings-control">
          <Input
            aria-label="AI 服务地址"
            onChange={changeBaseUrl}
            placeholder="https://api.example.com/v1"
            value={settings.aiBaseUrl}
          />
        </div>
      </div>
      <div className="settings-row">
        <Typography.Text>模型</Typography.Text>
        <div className="settings-control ai-model-setting">
          <div className="ai-model-control">
            <Select
              allowCreate
              aria-label="AI 模型"
              onChange={(value) => updateSetting("aiModel", value)}
              options={models.map((model) => ({
                label: model.id,
                value: model.id,
              }))}
              placeholder="选择或输入模型名称"
              showSearch
              value={settings.aiModel || undefined}
            />
            <Tooltip content="获取模型列表">
              <Button
                aria-label="获取 AI 模型列表"
                icon={<IconRefresh />}
                loading={loadingModels}
                onClick={refreshModels}
              />
            </Tooltip>
          </div>
          {modelListError && (
            <Typography.Text className="ai-model-hint" type="secondary">
              {modelListError}
            </Typography.Text>
          )}
        </div>
      </div>
      <div className="settings-row">
        <Typography.Text>API Key</Typography.Text>
        <div className="settings-control">
          <Space size="mini">
            <Input.Password
              aria-label="AI API Key"
              disabled={loadingKeyStatus}
              onChange={setApiKey}
              placeholder={
                hasApiKey
                  ? "已保存，输入新值可替换"
                  : localService
                    ? "本地服务可留空"
                    : "输入 API Key"
              }
              value={apiKey}
            />
            <Button
              disabled={!apiKey.trim()}
              loading={savingKey}
              onClick={() => void saveApiKey()}
            >
              保存
            </Button>
            {hasApiKey && (
              <Popconfirm
                content="确定从系统凭据库删除 AI API Key？"
                onOk={() => void deleteApiKey()}
              >
                <Button status="danger">删除</Button>
              </Popconfirm>
            )}
          </Space>
        </div>
      </div>
      <div className="settings-row">
        <Typography.Text>上下文上限</Typography.Text>
        <div className="settings-control">
          <InputNumber
            aria-label="AI 上下文字符上限"
            max={32_000}
            min={2_000}
            mode="button"
            onChange={(value) => updateSetting("aiContextMaxChars", value)}
            step={2_000}
            suffix="字符"
            value={settings.aiContextMaxChars}
          />
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label-with-description">
          <Typography.Text>只读诊断工具</Typography.Text>
          <Typography.Text type="secondary">
            允许 AI 读取状态、进程、目录并执行受限网络探测
          </Typography.Text>
        </span>
        <div className="settings-control">
          <Switch
            aria-label="允许 AI 使用只读诊断工具"
            checked={settings.aiToolsEnabled}
            onChange={(checked) => updateSetting("aiToolsEnabled", checked)}
          />
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label-with-description">
          <Typography.Text>命令执行关联</Typography.Text>
          <Typography.Text type="secondary">
            仅关联由 AI 填入且由你手动提交的同会话命令
          </Typography.Text>
        </span>
        <div className="settings-control">
          <Switch
            aria-label="关联 AI 命令提案与终端提交"
            checked={settings.aiCommandTrackingEnabled}
            onChange={(checked) =>
              updateSetting("aiCommandTrackingEnabled", checked)
            }
          />
        </div>
      </div>
      <div className="settings-row">
        <Typography.Text>连接状态</Typography.Text>
        <div className="settings-control ai-connection-control">
          {connectionState === "success" && <Tag color="green">正常</Tag>}
          {connectionState === "failed" && <Tag color="red">失败</Tag>}
          <Button
            loading={testing}
            onClick={() => void testConnection()}
          >
            测试连接
          </Button>
        </div>
      </div>
    </div>
  );
}

export default AiSettings;
