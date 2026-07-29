import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
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
import {
  AI_CAPABILITY_DEFINITIONS,
  aiCapabilityStateColor,
  aiCapabilityStateLabel,
} from "../ai-capabilities";
import type { AppSettings, AiProvider } from "../app-settings";
import {
  AI_READ_ONLY_TOOL_OPTIONS,
  type AiReadOnlyToolName,
} from "../ai-permissions";
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
  type AiServiceCapabilities,
  type TauriCommand,
} from "../tauri-protocol";

export type AiSettingsInvoke = <T = void>(
  command: TauriCommand,
  args?: Record<string, unknown>,
) => Promise<T>;

interface AiSettingsProps {
  invokeCommand?: AiSettingsInvoke;
  settings: AppSettings;
  updateSetting: <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key],
  ) => void;
}

type ConnectionState = "success" | "failed" | null;

function AiSettings({
  invokeCommand = invoke,
  settings,
  updateSetting,
}: AiSettingsProps) {
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loadingKeyStatus, setLoadingKeyStatus] = useState(true);
  const [savingKey, setSavingKey] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [modelListError, setModelListError] = useState("");
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [testing, setTesting] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(null);
  const [capabilities, setCapabilities] =
    useState<AiServiceCapabilities | null>(null);
  const localService = useMemo(
    () => isLocalAiBaseUrl(settings.aiBaseUrl),
    [settings.aiBaseUrl],
  );
  const canAuthenticate = localService || hasApiKey;
  const modelRequestRef = useRef(0);
  const capabilityRequestRef = useRef(0);
  const lastAutoFetchSignatureRef = useRef("");
  const autoFetchTimerRef = useRef<number>();

  useEffect(() => {
    let disposed = false;
    void invokeCommand<boolean>("ai_api_key_status")
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
  }, [invokeCommand]);

  useEffect(
    () => () => {
      modelRequestRef.current += 1;
      capabilityRequestRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    modelRequestRef.current += 1;
    capabilityRequestRef.current += 1;
    setLoadingModels(false);
    setTesting(false);
    setModels([]);
    setModelListError("");
    setConnectionState(null);
    setCapabilities(null);
  }, [settings.aiBaseUrl]);

  useEffect(() => {
    capabilityRequestRef.current += 1;
    setTesting(false);
    setConnectionState(null);
    setCapabilities(null);
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
      await invokeCommand("store_ai_api_key", { apiKey: apiKey.trim() });
      setApiKey("");
      setHasApiKey(true);
      setCredentialRevision((current) => current + 1);
      capabilityRequestRef.current += 1;
      setConnectionState(null);
      setCapabilities(null);
      Message.success("API Key 已保存到系统凭据库");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setSavingKey(false);
    }
  };

  const deleteApiKey = async () => {
    try {
      await invokeCommand("delete_ai_api_key");
      setApiKey("");
      setHasApiKey(false);
      capabilityRequestRef.current += 1;
      setModels([]);
      setModelListError("");
      setConnectionState(null);
      setCapabilities(null);
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
      const result = await invokeCommand<AiModelInfo[]>("ai_list_models", {
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
    : aiModelFetchSignature(settings.aiBaseUrl, hasApiKey, credentialRevision);

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
    const requestId = capabilityRequestRef.current + 1;
    capabilityRequestRef.current = requestId;
    setTesting(true);
    setConnectionState(null);
    setCapabilities(null);
    try {
      const result = await invokeCommand<AiServiceCapabilities>(
        "ai_probe_capabilities",
        {
          request: {
            baseUrl: settings.aiBaseUrl,
            model: settings.aiModel,
          },
        },
      );
      if (capabilityRequestRef.current !== requestId) return;
      setCapabilities(result);
      setConnectionState("success");
      Message.success("AI 服务能力检测完成");
    } catch (error) {
      if (capabilityRequestRef.current !== requestId) return;
      setConnectionState("failed");
      Message.error(commandErrorMessage(error));
    } finally {
      if (capabilityRequestRef.current === requestId) setTesting(false);
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
          <Typography.Text>只读工具权限</Typography.Text>
          <Typography.Text type="secondary">
            仅向模型提供已勾选的工具
          </Typography.Text>
        </span>
        <div className="settings-control ai-permission-control">
          <Checkbox.Group
            aria-label="AI 只读工具权限"
            onChange={(values) =>
              updateSetting("aiReadOnlyTools", values as AiReadOnlyToolName[])
            }
            value={settings.aiReadOnlyTools}
          >
            {AI_READ_ONLY_TOOL_OPTIONS.map((option) => (
              <Checkbox key={option.value} value={option.value}>
                {option.label}
              </Checkbox>
            ))}
          </Checkbox.Group>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label-with-description">
          <Typography.Text>文件变更提案</Typography.Text>
          <Typography.Text type="secondary">
            允许生成需人工审阅的修改、新建、重命名和删除建议
          </Typography.Text>
        </span>
        <div className="settings-control">
          <Switch
            aria-label="允许 AI 生成文件变更提案"
            checked={settings.aiFileProposalsEnabled}
            onChange={(checked) =>
              updateSetting("aiFileProposalsEnabled", checked)
            }
          />
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label-with-description">
          <Typography.Text>终端命令提案</Typography.Text>
          <Typography.Text type="secondary">
            允许生成只可复制或填入、不会自动执行的命令建议
          </Typography.Text>
        </span>
        <div className="settings-control">
          <Switch
            aria-label="允许 AI 生成终端命令提案"
            checked={settings.aiCommandProposalsEnabled}
            onChange={(checked) =>
              updateSetting("aiCommandProposalsEnabled", checked)
            }
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
            disabled={!settings.aiCommandProposalsEnabled}
            onChange={(checked) =>
              updateSetting("aiCommandTrackingEnabled", checked)
            }
          />
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label-with-description">
          <Typography.Text>服务能力</Typography.Text>
          <Typography.Text type="secondary">
            会发起少量测试请求，不执行服务器操作
          </Typography.Text>
        </span>
        <div className="settings-control ai-capability-setting">
          {connectionState === "failed" && <Tag color="red">失败</Tag>}
          {capabilities &&
            AI_CAPABILITY_DEFINITIONS.map(({ key, label }) => {
              const capability = capabilities[key];
              return (
                <Tooltip content={capability.detail} key={key}>
                  <span className="ai-capability-item">
                    <Typography.Text>{label}</Typography.Text>
                    <Tag color={aiCapabilityStateColor(capability.state)}>
                      {aiCapabilityStateLabel(capability.state)}
                    </Tag>
                  </span>
                </Tooltip>
              );
            })}
          <Button loading={testing} onClick={() => void testConnection()}>
            检测能力
          </Button>
        </div>
      </div>
    </div>
  );
}

export default AiSettings;
