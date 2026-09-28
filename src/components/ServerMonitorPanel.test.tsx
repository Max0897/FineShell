import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import type { HostRecord, TerminalSession } from "../models";

mock.module("@visactor/react-vchart", () => ({
  AreaChart: () => <div data-testid="area-chart" />,
  BarChart: () => <div data-testid="bar-chart" />,
}));

import ServerMonitorPanel from "./ServerMonitorPanel";

function session(status: TerminalSession["status"]): TerminalSession {
  const host: HostRecord = {
    id: "host-1",
    name: "测试主机",
    address: "192.0.2.10",
    port: 22,
    username: "tester",
    authMethod: "password",
    connectTimeoutSeconds: 10,
    keepAliveIntervalSeconds: 30,
    autoReconnect: false,
    maxReconnectAttempts: 3,
  };
  return {
    id: "session-1",
    host,
    openedAt: "2026-09-28T00:00:00.000Z",
    status,
  };
}

describe("ServerMonitorPanel", () => {
  test("clears monitor data and uses muted placeholders when disconnected", () => {
    const onSnapshotChange = mock(() => undefined);
    const { container } = render(
      <ServerMonitorPanel
        onPortForwardStatusChange={() => undefined}
        onReconnect={() => undefined}
        onSendToAi={() => undefined}
        onSnapshotChange={onSnapshotChange}
        refreshIntervalSeconds={30}
        session={session("disconnected")}
      />,
    );

    const monitor = container.querySelector(".server-monitor");
    expect(monitor?.classList.contains("is-unavailable")).toBe(true);
    expect(container.querySelector(".monitor-system-facts")?.textContent).toBe(
      "系统-主机名-内核-运行时间-负载-",
    );
    expect(onSnapshotChange).toHaveBeenCalledWith("session-1", null);
  });

  test("resets monitor state while a session is reconnecting", () => {
    const onSnapshotChange = mock(() => undefined);
    const { container } = render(
      <ServerMonitorPanel
        onPortForwardStatusChange={() => undefined}
        onReconnect={() => undefined}
        onSendToAi={() => undefined}
        onSnapshotChange={onSnapshotChange}
        refreshIntervalSeconds={30}
        session={session("reconnecting")}
      />,
    );

    expect(container.querySelector(".server-monitor.is-unavailable")).not.toBeNull();
    expect(onSnapshotChange).toHaveBeenCalledWith("session-1", null);
  });
});
