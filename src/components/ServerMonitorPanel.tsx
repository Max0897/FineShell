import { useEffect, useMemo, useState } from "react";
import { Alert, Skeleton, Typography } from "@arco-design/web-react";
import { invoke } from "@tauri-apps/api/core";
import { AreaChart, BarChart } from "@visactor/react-vchart";
import type {
  ServerMonitorHistoryPoint,
  ServerMonitorSnapshot,
  TerminalSession,
} from "../models";
import {
  appendMonitorHistory,
  formatMonitorBytes,
  formatUptime,
} from "../monitor-utils";

interface ServerMonitorPanelProps {
  session: TerminalSession;
}

const POLL_INTERVAL_MS = 5_000;

function percentLabel(value: number) {
  return `${Math.round(value)}%`;
}

function ServerMonitorPanel({ session }: ServerMonitorPanelProps) {
  const [snapshot, setSnapshot] = useState<ServerMonitorSnapshot | null>(null);
  const [history, setHistory] = useState<ServerMonitorHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSnapshot(null);
    setHistory([]);
    setError(undefined);
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

  if (session.status !== "connected") {
    return (
      <section className="server-monitor">
        <Typography.Text bold>服务器监控</Typography.Text>
        <Typography.Text type="secondary">连接后开始采集</Typography.Text>
      </section>
    );
  }

  return (
    <section className="server-monitor">
      <div className="server-monitor-heading">
        <Typography.Text bold>服务器监控</Typography.Text>
        <Typography.Text type="secondary">5 秒</Typography.Text>
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
                  <strong>{percentLabel(item.value)}</strong>
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
              color={["#165dff", "#00b42a", "#f7ba1e"]}
              data={[{ id: "utilization", values: utilizationData }]}
              direction="horizontal"
              height={105}
              padding={{ bottom: 8, left: 38, right: 8, top: 4 }}
              seriesField="metric"
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
                  label: { style: { fill: "#86909c", fontSize: 10 } },
                  tick: { visible: false },
                },
              ]}
              color={["#165dff", "#00b42a"]}
              data={[{ id: "resource-trend", values: trendData }]}
              height={128}
              legends={{
                orient: "top",
                position: "start",
                item: { label: { style: { fill: "#4e5969", fontSize: 10 } } },
              }}
              line={{ style: { lineWidth: 2 } }}
              padding={{ bottom: 6, left: 30, right: 8, top: 22 }}
              point={{ style: { size: 2 }, visible: history.length < 2 }}
              seriesField="metric"
              xField="time"
              yField="value"
            />
          </div>
        </>
      )}
    </section>
  );
}

export default ServerMonitorPanel;
