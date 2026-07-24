import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Message,
  Modal,
  Space,
  Typography,
} from "@arco-design/web-react";
import {
  IconPaste,
  IconPlayArrow,
} from "@arco-design/web-react/icon";
import type { QuickCommandRecord } from "../models";
import {
  filterQuickCommands,
  quickCommandParameters,
  renderQuickCommand,
} from "../quick-command-utils";

interface QuickCommandDrawerProps {
  canSend: boolean;
  commands: QuickCommandRecord[];
  onAfterClose: () => void;
  onCancel: () => void;
  onSend: (command: string, execute: boolean) => Promise<void>;
  visible: boolean;
}

interface CommandGroup {
  label: string;
  commands: QuickCommandRecord[];
}

function groupQuickCommands(commands: QuickCommandRecord[]) {
  const groups = new Map<string, QuickCommandRecord[]>();
  for (const command of commands) {
    const label = command.group || "未分组";
    const group = groups.get(label) ?? [];
    group.push(command);
    groups.set(label, group);
  }
  return [...groups].map<CommandGroup>(([label, groupedCommands]) => ({
    label,
    commands: groupedCommands,
  }));
}

function QuickCommandDrawer({
  canSend,
  commands,
  onAfterClose,
  onCancel,
  onSend,
  visible,
}: QuickCommandDrawerProps) {
  const [query, setQuery] = useState("");
  const [pendingCommand, setPendingCommand] =
    useState<QuickCommandRecord | null>(null);
  const [parameterValues, setParameterValues] = useState<
    Record<string, string>
  >({});
  const [sending, setSending] = useState<{
    commandId: string;
    mode: "insert" | "execute";
  } | null>(null);

  const filteredCommands = useMemo(
    () => filterQuickCommands(commands, query),
    [commands, query],
  );
  const commandGroups = useMemo(
    () => groupQuickCommands(filteredCommands),
    [filteredCommands],
  );
  const parameters = useMemo(
    () => quickCommandParameters(pendingCommand?.command ?? ""),
    [pendingCommand],
  );

  useEffect(() => {
    if (visible) return;
    setPendingCommand(null);
    setParameterValues({});
  }, [visible]);

  const sendCommand = async (
    command: QuickCommandRecord,
    execute: boolean,
  ) => {
    if (!canSend) {
      Message.warning("当前终端未连接");
      return;
    }
    const commandParameters = quickCommandParameters(command.command);
    if (commandParameters.length) {
      setPendingCommand(command);
      setParameterValues(
        Object.fromEntries(
          commandParameters.map((parameter) => [
            parameter.name,
            parameter.defaultValue ?? "",
          ]),
        ),
      );
      return;
    }

    setSending({
      commandId: command.id,
      mode: execute ? "execute" : "insert",
    });
    try {
      await onSend(command.command, execute);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSending(null);
    }
  };

  const sendParameterizedCommand = async (execute: boolean) => {
    if (!pendingCommand || !canSend) return;
    const missingParameter = parameters.find(
      (parameter) =>
        !parameter.defaultValue && !parameterValues[parameter.name]?.trim(),
    );
    if (missingParameter) {
      Message.warning(`请填写参数“${missingParameter.name}”`);
      return;
    }

    setSending({
      commandId: pendingCommand.id,
      mode: execute ? "execute" : "insert",
    });
    try {
      await onSend(
        renderQuickCommand(pendingCommand.command, parameterValues),
        execute,
      );
      setPendingCommand(null);
      setParameterValues({});
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSending(null);
    }
  };

  return (
    <>
      <Drawer
        afterClose={onAfterClose}
        bodyStyle={{ padding: 0 }}
        className="quick-command-drawer"
        footer={null}
        onCancel={onCancel}
        title="快捷命令"
        visible={visible}
        width={480}
      >
        <div className="quick-command-drawer-toolbar">
          <Input.Search
            allowClear
            onChange={setQuery}
            placeholder="搜索名称、分组或命令"
            value={query}
          />
        </div>
        {!canSend && (
          <div className="quick-command-drawer-alert">
            <Alert content="当前终端未连接" showIcon type="warning" />
          </div>
        )}
        <div className="quick-command-drawer-content">
          {commandGroups.length ? (
            commandGroups.map((group) => (
              <section className="quick-command-group" key={group.label}>
                <Typography.Text
                  className="quick-command-group-title"
                  type="secondary"
                >
                  {group.label}
                </Typography.Text>
                <div className="quick-command-list">
                  {group.commands.map((command) => (
                    <div className="quick-command-list-item" key={command.id}>
                      <div className="quick-command-list-copy">
                        <Typography.Text bold>{command.name}</Typography.Text>
                        <Typography.Text
                          className="quick-command-list-template"
                          code
                        >
                          {command.command}
                        </Typography.Text>
                        {command.description && (
                          <Typography.Text type="secondary">
                            {command.description}
                          </Typography.Text>
                        )}
                      </div>
                      <Space size="mini">
                        <Button
                          disabled={!canSend || sending !== null}
                          icon={<IconPaste />}
                          loading={
                            sending?.commandId === command.id &&
                            sending.mode === "insert"
                          }
                          onClick={() => void sendCommand(command, false)}
                          size="mini"
                        >
                          填入
                        </Button>
                        <Button
                          disabled={!canSend || sending !== null}
                          icon={<IconPlayArrow />}
                          loading={
                            sending?.commandId === command.id &&
                            sending.mode === "execute"
                          }
                          onClick={() => void sendCommand(command, true)}
                          size="mini"
                          type="primary"
                        >
                          执行
                        </Button>
                      </Space>
                    </div>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <Empty description={query ? "没有匹配的快捷命令" : "暂无快捷命令"} />
          )}
        </div>
      </Drawer>
      {pendingCommand && (
        <Modal
          className="quick-command-parameter-modal"
          footer={null}
          maskClosable={false}
          onCancel={() => {
            if (sending) return;
            setPendingCommand(null);
            setParameterValues({});
          }}
          style={{ width: 560 }}
          title={pendingCommand.name}
          visible
        >
          <div className="quick-command-parameter-fields">
            {parameters.map((parameter, index) => (
              <label key={parameter.name}>
                <Typography.Text>{parameter.name}</Typography.Text>
                <Input
                  autoFocus={index === 0}
                  onChange={(value) =>
                    setParameterValues((current) => ({
                      ...current,
                      [parameter.name]: value,
                    }))
                  }
                  placeholder={parameter.defaultValue || "必填"}
                  value={parameterValues[parameter.name] ?? ""}
                />
              </label>
            ))}
          </div>
          <Typography.Text
            className="quick-command-parameter-preview"
            code
          >
            {renderQuickCommand(pendingCommand.command, parameterValues)}
          </Typography.Text>
          <div className="modal-actions">
            <Space>
              <Button
                disabled={sending !== null}
                onClick={() => {
                  setPendingCommand(null);
                  setParameterValues({});
                }}
              >
                取消
              </Button>
              <Button
                icon={<IconPaste />}
                loading={sending?.mode === "insert"}
                onClick={() => void sendParameterizedCommand(false)}
              >
                填入终端
              </Button>
              <Button
                icon={<IconPlayArrow />}
                loading={sending?.mode === "execute"}
                onClick={() => void sendParameterizedCommand(true)}
                type="primary"
              >
                执行
              </Button>
            </Space>
          </div>
        </Modal>
      )}
    </>
  );
}

export default QuickCommandDrawer;
