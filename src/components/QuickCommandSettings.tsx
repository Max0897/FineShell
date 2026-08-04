import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconDelete,
  IconEdit,
  IconPlus,
  IconQuestionCircle,
} from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import {
  loadConfiguration,
} from "../config-database";
import {
  deleteQuickCommand,
  upsertQuickCommand,
} from "../configuration-mutations";
import type {
  QuickCommandFormValues,
  QuickCommandRecord,
} from "../models";
import {
  emitProtocolEventTo,
  listenProtocolEvent,
} from "../tauri-protocol";

function createQuickCommandId() {
  return `command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface QuickCommandEditorModalProps {
  command: QuickCommandRecord | null;
  submitting: boolean;
  visible: boolean;
  onCancel: () => void;
  onSubmit: (values: QuickCommandFormValues) => void;
}

function QuickCommandEditorModal({
  command,
  submitting,
  visible,
  onCancel,
  onSubmit,
}: QuickCommandEditorModalProps) {
  return (
    <Modal
      className="quick-command-editor-modal"
      footer={null}
      maskClosable={false}
      onCancel={onCancel}
      style={{ width: 680 }}
      title={command ? "编辑快捷命令" : "新增快捷命令"}
      visible={visible}
    >
      <Form<QuickCommandFormValues>
        initialValues={{
          name: command?.name ?? "",
          group: command?.group ?? "",
          command: command?.command ?? "",
          description: command?.description ?? "",
        }}
        layout="vertical"
        onSubmit={onSubmit}
      >
        <div className="quick-command-form-row">
          <Form.Item
            field="name"
            label="名称"
            rules={[{ required: true, message: "请输入快捷命令名称" }]}
          >
            <Input autoFocus maxLength={80} placeholder="例如：查看服务日志" />
          </Form.Item>
          <Form.Item field="group" label="分组">
            <Input maxLength={60} placeholder="可选" />
          </Form.Item>
        </div>
        <Form.Item
          field="command"
          label={
            <span className="quick-command-template-label">
              命令模板
              <Tooltip content="使用 {{参数}} 或 {{参数:默认值}} 插入动态参数">
                <IconQuestionCircle />
              </Tooltip>
            </span>
          }
          rules={[{ required: true, message: "请输入命令模板" }]}
        >
          <Input.TextArea
            autoSize={{ minRows: 5, maxRows: 10 }}
            maxLength={4000}
            placeholder="tail -n {{行数:100}} {{文件路径}}"
          />
        </Form.Item>
        <Form.Item field="description" label="备注">
          <Input maxLength={160} placeholder="可选" />
        </Form.Item>
        <div className="modal-actions">
          <Space>
            <Button disabled={submitting} onClick={onCancel}>
              取消
            </Button>
            <Button htmlType="submit" loading={submitting} type="primary">
              保存
            </Button>
          </Space>
        </div>
      </Form>
    </Modal>
  );
}

function QuickCommandSettings() {
  const [commands, setCommands] = useState<QuickCommandRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingCommand, setEditingCommand] =
    useState<QuickCommandRecord | null>(null);

  const refresh = useCallback(async () => {
    const configuration = await loadConfiguration();
    setCommands(configuration.quickCommands);
  }, []);

  useEffect(() => {
    let disposed = false;
    void refresh()
      .catch((error) => {
        if (!disposed) Message.error(String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("configuration:changed", () => {
      void refresh().catch((error) => Message.error(String(error)));
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const notifyMainWindow = async () => {
    if (!isTauri()) return;
    await emitProtocolEventTo("main", "configuration:changed").catch(
      () => undefined,
    );
  };

  const saveCommand = async (values: QuickCommandFormValues) => {
    const command: QuickCommandRecord = {
      id: editingCommand?.id ?? createQuickCommandId(),
      name: values.name.trim(),
      command: values.command.trim(),
      group: values.group?.trim() || undefined,
      description: values.description?.trim() || undefined,
    };
    setActing(true);
    try {
      const configuration = await upsertQuickCommand(command);
      setCommands(configuration.quickCommands);
      await notifyMainWindow();
      setEditorVisible(false);
      setEditingCommand(null);
      Message.success(editingCommand ? "快捷命令已更新" : "快捷命令已添加");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const removeCommand = async (command: QuickCommandRecord) => {
    setActing(true);
    try {
      const configuration = await deleteQuickCommand(command.id);
      setCommands(configuration.quickCommands);
      await notifyMainWindow();
      Message.success(`已删除 ${command.name}`);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const columns = useMemo<TableColumnProps<QuickCommandRecord>[]>(
    () => [
      {
        title: "快捷命令",
        dataIndex: "name",
        render: (_, command) => (
          <div className="quick-command-name-cell">
            <Typography.Text bold>{command.name}</Typography.Text>
            {command.description && (
              <Typography.Text type="secondary">
                {command.description}
              </Typography.Text>
            )}
          </div>
        ),
      },
      {
        title: "分组",
        dataIndex: "group",
        width: 120,
        render: (value) => value || "未分组",
      },
      {
        title: "命令模板",
        dataIndex: "command",
        render: (value) => (
          <Typography.Text className="quick-command-template-cell" code>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: "操作",
        width: 100,
        render: (_, command) => (
          <Space size="mini">
            <Button
              aria-label={`编辑 ${command.name}`}
              disabled={acting}
              icon={<IconEdit />}
              onClick={() => {
                setEditingCommand(command);
                setEditorVisible(true);
              }}
              size="mini"
            />
            <Popconfirm
              content={`确定删除快捷命令“${command.name}”？`}
              onOk={() => void removeCommand(command)}
            >
              <Button
                aria-label={`删除 ${command.name}`}
                disabled={acting}
                icon={<IconDelete />}
                size="mini"
                status="danger"
              />
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [acting],
  );

  return (
    <div className="quick-command-settings">
      <div className="quick-command-settings-heading">
        <Typography.Title heading={5}>快捷命令</Typography.Title>
        <Button
          disabled={loading || acting}
          icon={<IconPlus />}
          onClick={() => {
            setEditingCommand(null);
            setEditorVisible(true);
          }}
          type="primary"
        >
          新增命令
        </Button>
      </div>
      <Table
        border={false}
        columns={columns}
        data={commands}
        loading={loading}
        noDataElement={<Empty description="暂无快捷命令" />}
        pagination={false}
        rowKey="id"
        size="small"
        tableLayoutFixed
      />
      {editorVisible && (
        <QuickCommandEditorModal
          command={editingCommand}
          key={editingCommand?.id ?? "new-command"}
          onCancel={() => {
            setEditorVisible(false);
            setEditingCommand(null);
          }}
          onSubmit={(values) => void saveCommand(values)}
          submitting={acting}
          visible
        />
      )}
    </div>
  );
}

export default QuickCommandSettings;
