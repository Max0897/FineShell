import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Message,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconRefresh,
  IconStop,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import { invoke } from "@tauri-apps/api/core";
import type {
  ServerProcess,
  ServerProcessListResult,
  TerminalSession,
} from "../models";
import { formatMonitorBytes } from "../monitor-utils";
import {
  filterServerProcesses,
  formatProcessElapsed,
  formatProcessPercent,
} from "../process-utils";

interface ServerProcessDrawerProps {
  onCancel: () => void;
  session: TerminalSession;
  visible: boolean;
}

const PROCESS_REFRESH_INTERVAL_MS = 5_000;

const PROCESS_STATE_LABELS: Record<string, string> = {
  D: "不可中断",
  I: "空闲",
  R: "运行",
  S: "休眠",
  T: "已停止",
  Z: "僵尸",
};

function processStateLabel(state: string) {
  return PROCESS_STATE_LABELS[state.charAt(0)] ?? state;
}

function processStateColor(state: string) {
  const primaryState = state.charAt(0);
  if (primaryState === "R") return "green";
  if (primaryState === "D" || primaryState === "Z") return "red";
  if (primaryState === "T") return "orange";
  return "gray";
}

function ServerProcessDrawer({
  onCancel,
  session,
  visible,
}: ServerProcessDrawerProps) {
  const [result, setResult] = useState<ServerProcessListResult | null>(null);
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [signalingProcess, setSignalingProcess] = useState<{
    force: boolean;
    pid: number;
  } | null>(null);
  const loadingRef = useRef(false);
  const requestVersionRef = useRef(0);

  const loadProcesses = useCallback(
    async (showLoading = true) => {
      if (loadingRef.current || session.status !== "connected") return;
      loadingRef.current = true;
      const requestVersion = requestVersionRef.current;
      if (showLoading) setLoading(true);
      try {
        const next = await invoke<ServerProcessListResult>("ssh_processes", {
          sessionId: session.id,
        });
        if (requestVersion !== requestVersionRef.current) return;
        setResult(next);
        setError(undefined);
      } catch (processError) {
        if (requestVersion === requestVersionRef.current) {
          setError(String(processError));
        }
      } finally {
        if (requestVersion === requestVersionRef.current) {
          loadingRef.current = false;
          if (showLoading) setLoading(false);
        }
      }
    },
    [session.id, session.status],
  );

  useEffect(() => {
    requestVersionRef.current += 1;
    loadingRef.current = false;
    setResult(null);
    setQuery("");
    setError(undefined);
    setLoading(false);
    setSignalingProcess(null);
  }, [session.id]);

  useEffect(() => {
    if (!visible || session.status !== "connected") return;
    void loadProcesses();
    if (!autoRefresh) return;
    const timer = window.setInterval(
      () => void loadProcesses(false),
      PROCESS_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadProcesses, session.status, visible]);

  const filteredProcesses = useMemo(
    () => filterServerProcesses(result?.processes ?? [], query),
    [query, result],
  );
  const signalProcess = useCallback(
    async (process: ServerProcess, force: boolean) => {
      setSignalingProcess({ force, pid: process.pid });
      setError(undefined);
      try {
        await invoke("ssh_signal_process", {
          force,
          pid: process.pid,
          sessionId: session.id,
        });
        Message.success(
          `已向 ${process.name}（PID ${process.pid}）发送 ${force ? "KILL" : "TERM"}`,
        );
        await loadProcesses(false);
      } catch (signalError) {
        setError(String(signalError));
      } finally {
        setSignalingProcess(null);
      }
    },
    [loadProcesses, session.id],
  );
  const confirmSignalProcess = useCallback(
    (process: ServerProcess, force: boolean) => {
      Modal.confirm({
        cancelText: "取消",
        content: force
          ? `将立即强制结束 ${process.name}（PID ${process.pid}），进程无法执行清理操作。`
          : `向 ${process.name}（PID ${process.pid}）发送 TERM，请求进程正常退出。`,
        okButtonProps: force ? { status: "danger" } : undefined,
        okText: force ? "强制结束" : "结束进程",
        onOk: () => signalProcess(process, force),
        title: force ? "强制结束进程？" : "结束进程？",
      });
    },
    [signalProcess],
  );
  const columns = useMemo<TableColumnProps<ServerProcess>[]>(
    () => [
      {
        dataIndex: "name",
        title: "进程",
        width: 250,
        render: (_, process) => (
          <div className="server-process-name">
            <Typography.Text bold ellipsis={{ showTooltip: true }}>
              {process.name}
            </Typography.Text>
            <Typography.Text ellipsis={{ showTooltip: true }} type="secondary">
              {process.command}
            </Typography.Text>
          </div>
        ),
      },
      {
        dataIndex: "pid",
        sorter: (left, right) => left.pid - right.pid,
        title: "PID",
        width: 82,
      },
      {
        dataIndex: "user",
        sorter: (left, right) => left.user.localeCompare(right.user),
        title: "用户",
        width: 110,
      },
      {
        dataIndex: "state",
        title: "状态",
        width: 96,
        render: (state: string) => (
          <Tag color={processStateColor(state)}>{processStateLabel(state)}</Tag>
        ),
      },
      {
        dataIndex: "cpuUsagePercent",
        defaultSortOrder: "descend",
        sorter: (left, right) =>
          left.cpuUsagePercent - right.cpuUsagePercent,
        title: "CPU",
        width: 88,
        render: (value: number) => formatProcessPercent(value),
      },
      {
        dataIndex: "memoryUsagePercent",
        sorter: (left, right) =>
          left.memoryUsagePercent - right.memoryUsagePercent,
        title: "内存",
        width: 88,
        render: (value: number) => formatProcessPercent(value),
      },
      {
        dataIndex: "residentMemoryBytes",
        sorter: (left, right) =>
          left.residentMemoryBytes - right.residentMemoryBytes,
        title: "RSS",
        width: 94,
        render: (value: number) => formatMonitorBytes(value),
      },
      {
        dataIndex: "elapsedSeconds",
        sorter: (left, right) => left.elapsedSeconds - right.elapsedSeconds,
        title: "运行时间",
        width: 120,
        render: (value: number) => formatProcessElapsed(value),
      },
      {
        title: "操作",
        width: 96,
        render: (_, process) => (
          <Space size="mini">
            <Tooltip content="结束进程（TERM）">
              <Button
                aria-label={`结束进程 ${process.pid}`}
                disabled={process.pid <= 1 || signalingProcess !== null}
                icon={<IconStop />}
                loading={
                  signalingProcess?.pid === process.pid &&
                  !signalingProcess.force
                }
                onClick={() => confirmSignalProcess(process, false)}
                size="mini"
              />
            </Tooltip>
            <Tooltip content="强制结束（KILL）">
              <Button
                aria-label={`强制结束进程 ${process.pid}`}
                disabled={process.pid <= 1 || signalingProcess !== null}
                icon={<IconThunderbolt />}
                loading={
                  signalingProcess?.pid === process.pid &&
                  signalingProcess.force
                }
                onClick={() => confirmSignalProcess(process, true)}
                size="mini"
                status="danger"
              />
            </Tooltip>
          </Space>
        ),
      },
    ],
    [confirmSignalProcess, signalingProcess],
  );

  return (
    <Drawer
      bodyStyle={{ padding: 0 }}
      className="server-process-drawer"
      footer={null}
      onCancel={onCancel}
      title="进程管理"
      visible={visible}
      width={1080}
    >
      <div className="server-process-toolbar">
        <Input.Search
          allowClear
          onChange={setQuery}
          placeholder="搜索名称、PID、用户或命令"
          value={query}
        />
        <Space size="medium">
          <Typography.Text type="secondary">
            {filteredProcesses.length} / {result?.processes.length ?? 0}
          </Typography.Text>
          <span className="server-process-auto-refresh">
            <Switch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              size="small"
            />
            <Typography.Text>自动刷新</Typography.Text>
          </span>
          <Tooltip content="刷新进程列表">
            <Button
              aria-label="刷新进程列表"
              icon={<IconRefresh />}
              loading={loading}
              onClick={() => void loadProcesses()}
            />
          </Tooltip>
        </Space>
      </div>
      {error && (
        <Alert
          className="server-process-alert"
          content={error}
          showIcon
          type="error"
        />
      )}
      {result?.truncated && (
        <Alert
          className="server-process-alert"
          content="进程数量较多，仅显示 CPU 占用最高的前 500 条"
          showIcon
          type="warning"
        />
      )}
      <Table
        border={false}
        columns={columns}
        data={filteredProcesses}
        loading={loading && !result}
        noDataElement={<Empty description={query ? "没有匹配的进程" : "暂无进程"} />}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1024, y: "calc(100vh - 180px)" }}
        size="small"
      />
    </Drawer>
  );
}

export default ServerProcessDrawer;
