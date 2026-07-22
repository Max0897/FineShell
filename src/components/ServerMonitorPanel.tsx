import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Radio,
  Skeleton,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconBranch,
  IconRefresh,
  IconWifi,
} from "@arco-design/web-react/icon";
import { invoke } from "@tauri-apps/api/core";
import { AreaChart, BarChart } from "@visactor/react-vchart";
import type {
  ServerMonitorHistoryPoint,
  ServerMonitorSnapshot,
  TerminalSession,
  NetworkConnection,
  NetworkConnectionsResult,
  NetworkPingResult,
  NetworkTraceResult,
} from "../models";
import {
  appendMonitorHistory,
  formatLatency,
  formatMonitorBytes,
  formatMonitorPercent,
  formatMonitorRate,
  formatNetworkEndpoint,
  formatUptime,
} from "../monitor-utils";

interface ServerMonitorPanelProps {
  session: TerminalSession;
}

const POLL_INTERVAL_MS = 5_000;

type ConnectionFilter = "all" | "listening" | "connected";

const CONNECTION_STATE_LABELS: Record<string, string> = {
  CLOSED: "已关闭",
  CLOSING: "正在关闭",
  "CLOSE-WAIT": "等待关闭",
  ESTAB: "已连接",
  "FIN-WAIT-1": "等待关闭",
  "FIN-WAIT-2": "等待关闭",
  "LAST-ACK": "最终确认",
  LISTEN: "监听",
  "SYN-RECV": "接收连接",
  "SYN-SENT": "正在连接",
  "TIME-WAIT": "等待回收",
  UNCONN: "无连接",
};

function isListeningConnection(connection: NetworkConnection) {
  return connection.state === "LISTEN" || connection.state === "UNCONN";
}

function connectionStateColor(state: string) {
  if (state === "ESTAB") return "green";
  if (state === "LISTEN" || state === "UNCONN") return "blue";
  if (state.includes("WAIT")) return "orange";
  return "gray";
}

function tooltipMetric(datum?: Record<string, unknown>) {
  return String(datum?.metric ?? "占用率");
}

function tooltipPercent(datum?: Record<string, unknown>) {
  return formatMonitorPercent(Number(datum?.value));
}

function tooltipRate(datum?: Record<string, unknown>) {
  return formatMonitorRate(Number(datum?.value));
}

function ServerMonitorPanel({ session }: ServerMonitorPanelProps) {
  const [snapshot, setSnapshot] = useState<ServerMonitorSnapshot | null>(null);
  const [history, setHistory] = useState<ServerMonitorHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);
  const [pingTarget, setPingTarget] = useState("1.1.1.1");
  const [pingResult, setPingResult] = useState<NetworkPingResult | null>(null);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingError, setPingError] = useState<string>();
  const [connectionsResult, setConnectionsResult] =
    useState<NetworkConnectionsResult | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState<string>();
  const [connectionFilter, setConnectionFilter] =
    useState<ConnectionFilter>("all");
  const [traceResult, setTraceResult] = useState<NetworkTraceResult | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string>();

  useEffect(() => {
    setSnapshot(null);
    setHistory([]);
    setError(undefined);
    setPingResult(null);
    setPingError(undefined);
    setConnectionsResult(null);
    setConnectionsError(undefined);
    setConnectionFilter("all");
    setTraceResult(null);
    setTraceError(undefined);
    setDiagnosticsVisible(false);
    if (session.status !== "connected") {
      setLoading(false);
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const collect = async () => {
      try {
        const next = await invoke<ServerMonitorSnapshot>(
          "ssh_monitor_snapshot",
          { sessionId: session.id },
        );
        if (disposed) return;
        setSnapshot(next);
        setHistory((current) => appendMonitorHistory(current, next));
        setError(undefined);
      } catch (collectionError) {
        if (!disposed) setError(String(collectionError));
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(collect, POLL_INTERVAL_MS);
        }
      }
    };

    void collect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [session.id, session.status]);

  const runPing = async (target = pingTarget) => {
    const nextTarget = target.trim();
    setPingTarget(nextTarget);
    setPingLoading(true);
    setPingError(undefined);
    try {
      const result = await invoke<NetworkPingResult>("ssh_ping", {
        sessionId: session.id,
        target: nextTarget,
      });
      setPingResult(result);
    } catch (pingFailure) {
      setPingResult(null);
      setPingError(String(pingFailure));
    } finally {
      setPingLoading(false);
    }
  };

  const loadNetworkConnections = async () => {
    setConnectionsLoading(true);
    setConnectionsError(undefined);
    try {
      const result = await invoke<NetworkConnectionsResult>(
        "ssh_network_connections",
        { sessionId: session.id },
      );
      setConnectionsResult(result);
    } catch (connectionFailure) {
      setConnectionsResult(null);
      setConnectionsError(String(connectionFailure));
    } finally {
      setConnectionsLoading(false);
    }
  };

  const runTraceRoute = async () => {
    const target = pingTarget.trim();
    setTraceLoading(true);
    setTraceError(undefined);
    try {
      const result = await invoke<NetworkTraceResult>("ssh_trace_route", {
        sessionId: session.id,
        target,
      });
      setTraceResult(result);
    } catch (traceFailure) {
      setTraceResult(null);
      setTraceError(String(traceFailure));
    } finally {
      setTraceLoading(false);
    }
  };

  const utilizationData = useMemo(
    () =>
      snapshot
        ? [
            { metric: "CPU", value: snapshot.cpuUsagePercent },
            { metric: "内存", value: snapshot.memoryUsagePercent },
            { metric: "磁盘", value: snapshot.diskUsagePercent },
          ]
        : [],
    [snapshot],
  );
  const trendData = useMemo(
    () =>
      history.flatMap((point) => {
        const time = new Date(point.collectedAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        return [
          { metric: "CPU", time, value: point.cpuUsagePercent },
          { metric: "内存", time, value: point.memoryUsagePercent },
        ];
      }),
    [history],
  );
  const networkTrendData = useMemo(
    () =>
      history.flatMap((point) => {
        const time = new Date(point.collectedAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        return [
          { metric: "下载", time, value: point.networkReceiveBytesPerSecond },
          { metric: "上传", time, value: point.networkTransmitBytesPerSecond },
        ];
      }),
    [history],
  );
  const latestHistoryPoint = history[history.length - 1];
  const filteredConnections = useMemo(() => {
    const connections = connectionsResult?.connections ?? [];
    if (connectionFilter === "listening") {
      return connections.filter(isListeningConnection);
    }
    if (connectionFilter === "connected") {
      return connections.filter((connection) => connection.state === "ESTAB");
    }
    return connections;
  }, [connectionFilter, connectionsResult]);
  const connectionColumns = useMemo<TableColumnProps<NetworkConnection>[]>(
    () => [
      {
        dataIndex: "protocol",
        title: "协议",
        width: 68,
      },
      {
        dataIndex: "state",
        title: "状态",
        width: 96,
        render: (state: string) => (
          <Tag color={connectionStateColor(state)}>
            {CONNECTION_STATE_LABELS[state] ?? state}
          </Tag>
        ),
      },
      {
        title: "本地地址",
        render: (_, connection) => (
          <Typography.Text ellipsis={{ showTooltip: true }}>
            {formatNetworkEndpoint(
              connection.localAddress,
              connection.localPort,
            )}
          </Typography.Text>
        ),
      },
      {
        title: "远端地址",
        render: (_, connection) => (
          <Typography.Text ellipsis={{ showTooltip: true }}>
            {formatNetworkEndpoint(
              connection.remoteAddress,
              connection.remotePort,
            )}
          </Typography.Text>
        ),
      },
      {
        dataIndex: "process",
        title: "进程",
        width: 150,
        render: (process?: string) => (
          <Typography.Text ellipsis={{ showTooltip: true }}>
            {process || "-"}
          </Typography.Text>
        ),
      },
    ],
    [],
  );

  if (session.status !== "connected") {
    return (
      <section className="server-monitor">
        <Typography.Text bold>服务器监控</Typography.Text>
      </section>
    );
  }

  return (
    <section className="server-monitor">
      <div className="server-monitor-heading">
        <Typography.Text bold>服务器监控</Typography.Text>
        <Tooltip content="网络诊断">
          <Button
            aria-label="打开网络诊断"
            icon={<IconWifi />}
            onClick={() => {
              setDiagnosticsVisible(true);
              if (!pingResult && !pingLoading) void runPing();
              if (!connectionsResult && !connectionsLoading) {
                void loadNetworkConnections();
              }
            }}
            size="mini"
            type="text"
          />
        </Tooltip>
      </div>
      {error && <Alert content={error} showIcon type="warning" />}
      {loading && !snapshot && (
        <Skeleton animation text={{ rows: 4, width: ["90%", "75%", "95%", "70%"] }} />
      )}
      {snapshot && (
        <>
          <dl className="monitor-system-facts">
            <div>
              <dt>系统</dt>
              <dd>{snapshot.operatingSystem}</dd>
            </div>
            <div>
              <dt>主机名</dt>
              <dd>{snapshot.hostname}</dd>
            </div>
            <div>
              <dt>内核</dt>
              <dd>{snapshot.kernel}</dd>
            </div>
            <div>
              <dt>运行时间</dt>
              <dd>{formatUptime(snapshot.uptimeSeconds)}</dd>
            </div>
            <div>
              <dt>负载</dt>
              <dd>{snapshot.loadAverage.map((value) => value.toFixed(2)).join(" / ")}</dd>
            </div>
          </dl>

          <div className="monitor-chart-section">
            <div className="monitor-chart-heading">
              <Typography.Text bold>资源占用</Typography.Text>
              <Typography.Text type="secondary">
                内存 {formatMonitorBytes(snapshot.memoryUsedBytes)} / {formatMonitorBytes(snapshot.memoryTotalBytes)}
              </Typography.Text>
            </div>
            <div className="monitor-current-values">
              {utilizationData.map((item) => (
                <span key={item.metric}>
                  <span>{item.metric}</span>
                  <strong>{formatMonitorPercent(item.value)}</strong>
                </span>
              ))}
            </div>
            <BarChart
              animation={false}
              axes={[
                {
                  orient: "left",
                  type: "band",
                  label: { style: { fill: "#4e5969", fontSize: 11 } },
                  tick: { visible: false },
                },
                {
                  max: 100,
                  min: 0,
                  orient: "bottom",
                  type: "linear",
                  label: { visible: false },
                  tick: { visible: false },
                },
              ]}
              bar={{ style: { cornerRadius: 2 } }}
              className="monitor-chart"
              color={["#165dff", "#00b42a", "#f7ba1e"]}
              data={[{ id: "utilization", values: utilizationData }]}
              direction="horizontal"
              height={105}
              padding={{ bottom: 8, left: 0, right: 0, top: 4 }}
              seriesField="metric"
              tooltip={{
                mark: {
                  content: [
                    { key: tooltipMetric, value: tooltipPercent },
                  ],
                },
              }}
              xField="value"
              yField="metric"
            />
          </div>

          <div className="monitor-chart-section">
            <div className="monitor-chart-heading">
              <Typography.Text bold>最近 2 分钟</Typography.Text>
              <Typography.Text type="secondary">
                磁盘 {formatMonitorBytes(snapshot.diskUsedBytes)} / {formatMonitorBytes(snapshot.diskTotalBytes)}
              </Typography.Text>
            </div>
            <AreaChart
              animation={false}
              area={{ style: { fillOpacity: 0.12 } }}
              axes={[
                {
                  orient: "bottom",
                  type: "band",
                  label: { visible: false },
                  tick: { visible: false },
                },
                {
                  max: 100,
                  min: 0,
                  orient: "left",
                  type: "linear",
                  label: {
                    formatMethod: (value) => `${value}%`,
                    style: { fill: "#86909c", fontSize: 10 },
                  },
                  tick: { visible: false },
                },
              ]}
              className="monitor-chart"
              color={["#165dff", "#00b42a"]}
              data={[{ id: "resource-trend", values: trendData }]}
              height={128}
              legends={{
                orient: "top",
                position: "start",
                item: { label: { style: { fill: "#4e5969", fontSize: 10 } } },
              }}
              line={{ style: { lineWidth: 2 } }}
              padding={{ bottom: 6, left: 0, right: 0, top: 22 }}
              point={{ style: { size: 2 }, visible: history.length < 2 }}
              seriesField="metric"
              tooltip={{
                dimension: {
                  content: [
                    { key: tooltipMetric, value: tooltipPercent },
                  ],
                },
                mark: {
                  content: [
                    { key: tooltipMetric, value: tooltipPercent },
                  ],
                },
              }}
              xField="time"
              yField="value"
            />
          </div>

          <div className="monitor-chart-section">
            <div className="monitor-chart-heading">
              <Typography.Text bold>网络流量</Typography.Text>
              <Typography.Text type="secondary">
                累计 ↓ {formatMonitorBytes(snapshot.networkReceiveBytes)} / ↑ {formatMonitorBytes(snapshot.networkTransmitBytes)}
              </Typography.Text>
            </div>
            <div className="monitor-current-values monitor-network-values">
              <span>
                <span>下载</span>
                <strong>{formatMonitorRate(latestHistoryPoint?.networkReceiveBytesPerSecond ?? 0)}</strong>
              </span>
              <span>
                <span>上传</span>
                <strong>{formatMonitorRate(latestHistoryPoint?.networkTransmitBytesPerSecond ?? 0)}</strong>
              </span>
            </div>
            <AreaChart
              animation={false}
              area={{ style: { fillOpacity: 0.12 } }}
              axes={[
                {
                  orient: "bottom",
                  type: "band",
                  label: { visible: false },
                  tick: { visible: false },
                },
                {
                  orient: "left",
                  type: "linear",
                  label: { visible: false },
                  tick: { visible: false },
                },
              ]}
              className="monitor-chart"
              color={["#165dff", "#f77234"]}
              data={[{ id: "network-trend", values: networkTrendData }]}
              height={128}
              legends={{
                orient: "top",
                position: "start",
                item: { label: { style: { fill: "#4e5969", fontSize: 10 } } },
              }}
              line={{ style: { lineWidth: 2 } }}
              padding={{ bottom: 6, left: 0, right: 0, top: 22 }}
              point={{ style: { size: 2 }, visible: history.length < 2 }}
              seriesField="metric"
              tooltip={{
                dimension: {
                  content: [
                    { key: tooltipMetric, value: tooltipRate },
                  ],
                },
                mark: {
                  content: [
                    { key: tooltipMetric, value: tooltipRate },
                  ],
                },
              }}
              xField="time"
              yField="value"
            />
          </div>
        </>
      )}
      <Drawer
        className="network-diagnostics-drawer"
        footer={null}
        onCancel={() => setDiagnosticsVisible(false)}
        title="网络诊断"
        visible={diagnosticsVisible}
        width={720}
      >
        <section className="network-diagnostics-section">
          <Typography.Text bold>Ping</Typography.Text>
          <Input.Search
            loading={pingLoading}
            onChange={setPingTarget}
            onSearch={(value) => void runPing(value)}
            placeholder="域名或 IP 地址"
            searchButton="测试"
            value={pingTarget}
          />
          {pingError && <Alert content={pingError} showIcon type="error" />}
          {pingLoading && !pingResult && (
            <Skeleton animation text={{ rows: 2, width: ["100%", "80%"] }} />
          )}
          {pingResult && (
            <Descriptions
              border
              column={2}
              data={[
                {
                  label: "状态",
                  value: (
                    <Tag color={pingResult.reachable ? "green" : "red"}>
                      {pingResult.reachable ? "可达" : "不可达"}
                    </Tag>
                  ),
                },
                {
                  label: "平均延迟",
                  value: formatLatency(pingResult.averageLatencyMs),
                },
                {
                  label: "丢包率",
                  value: formatMonitorPercent(pingResult.packetLossPercent),
                },
                {
                  label: "收发",
                  value: `${pingResult.received} / ${pingResult.transmitted}`,
                },
                {
                  label: "最低延迟",
                  value: formatLatency(pingResult.minimumLatencyMs),
                },
                {
                  label: "最高延迟",
                  value: formatLatency(pingResult.maximumLatencyMs),
                },
              ]}
              size="small"
            />
          )}
        </section>
        <section className="network-diagnostics-section">
          <div className="network-diagnostics-section-heading">
            <span>
              <Typography.Text bold>路由追踪</Typography.Text>
              {traceResult && (
                <Typography.Text type="secondary">
                  {traceResult.resolvedAddress ?? traceResult.target}
                </Typography.Text>
              )}
            </span>
            <Button
              icon={<IconBranch />}
              loading={traceLoading}
              onClick={() => void runTraceRoute()}
              size="small"
            >
              开始追踪
            </Button>
          </div>
          {traceError && <Alert content={traceError} showIcon type="error" />}
          {traceLoading && !traceResult && (
            <Skeleton animation text={{ rows: 3, width: ["70%", "85%", "60%"] }} />
          )}
          {traceResult && (
            <>
              <Tag color={traceResult.reached ? "green" : "orange"}>
                {traceResult.reached ? "已到达目标" : "未在最大跳数内到达"}
              </Tag>
              <Timeline className="network-trace-timeline" mode="left">
                {traceResult.hops.map((hop) => {
                  const reachedTarget =
                    hop.address ===
                    (traceResult.resolvedAddress ?? traceResult.target);
                  return (
                    <Timeline.Item
                      dotColor={
                        reachedTarget
                          ? "#00b42a"
                          : hop.address
                            ? "#165dff"
                            : "#c9cdd4"
                      }
                      key={hop.hop}
                      label={`第 ${hop.hop} 跳`}
                      lineType={hop.address ? "solid" : "dashed"}
                    >
                      <div className="network-trace-hop">
                        <Typography.Text>
                          {hop.address ?? "请求超时"}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {formatLatency(hop.latencyMs)}
                        </Typography.Text>
                      </div>
                    </Timeline.Item>
                  );
                })}
              </Timeline>
            </>
          )}
        </section>
        <section className="network-diagnostics-section">
          <div className="network-diagnostics-section-heading">
            <span>
              <Typography.Text bold>网络连接</Typography.Text>
              {connectionsResult && (
                <Typography.Text type="secondary">
                  {connectionsResult.connections.length} 条
                </Typography.Text>
              )}
            </span>
            <Tooltip content="刷新网络连接">
              <Button
                aria-label="刷新网络连接"
                icon={<IconRefresh />}
                loading={connectionsLoading}
                onClick={() => void loadNetworkConnections()}
                size="mini"
                type="text"
              />
            </Tooltip>
          </div>
          <Radio.Group
            mode="fill"
            onChange={setConnectionFilter}
            options={[
              { label: "全部", value: "all" },
              { label: "监听", value: "listening" },
              { label: "已连接", value: "connected" },
            ]}
            size="small"
            type="button"
            value={connectionFilter}
          />
          {connectionsError && (
            <Alert content={connectionsError} showIcon type="error" />
          )}
          {connectionsResult?.truncated && (
            <Alert content="连接数量较多，仅显示前 500 条" showIcon type="warning" />
          )}
          <Table
            border={false}
            columns={connectionColumns}
            data={filteredConnections}
            loading={connectionsLoading}
            noDataElement={<Empty description="暂无网络连接" />}
            pagination={false}
            rowKey="id"
            scroll={{ y: 320 }}
            size="small"
          />
        </section>
      </Drawer>
    </section>
  );
}

export default ServerMonitorPanel;
