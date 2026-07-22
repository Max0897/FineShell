import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Input,
  Skeleton,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import { IconWifi } from "@arco-design/web-react/icon";
import { invoke } from "@tauri-apps/api/core";
import { AreaChart, BarChart } from "@visactor/react-vchart";
import type {
  ServerMonitorHistoryPoint,
  ServerMonitorSnapshot,
  TerminalSession,
  NetworkPingResult,
} from "../models";
import {
  appendMonitorHistory,
  formatLatency,
  formatMonitorBytes,
  formatMonitorPercent,
  formatMonitorRate,
  formatUptime,
} from "../monitor-utils";

interface ServerMonitorPanelProps {
  session: TerminalSession;
}

const POLL_INTERVAL_MS = 5_000;

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

  useEffect(() => {
    setSnapshot(null);
    setHistory([]);
    setError(undefined);
    setPingResult(null);
    setPingError(undefined);
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
        width={480}
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
      </Drawer>
    </section>
  );
}

export default ServerMonitorPanel;
