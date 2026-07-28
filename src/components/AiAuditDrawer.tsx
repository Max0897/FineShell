import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Drawer,
  Empty,
  Message,
  Select,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconCode,
  IconFile,
  IconNav,
  IconRefresh,
} from "@arco-design/web-react/icon";
import {
  loadAiAuditEntries,
  type AiAuditCategory,
  type AiAuditEntry,
  type AiAuditStatus,
} from "../ai-audit";
import { commandErrorMessage } from "../tauri-protocol";

interface AiAuditDrawerProps {
  loadEntries?: () => Promise<AiAuditEntry[]>;
  onClose: () => void;
  visible: boolean;
}

const CATEGORY_OPTIONS = [
  { label: "只读诊断", value: "diagnostic" },
  { label: "命令提案", value: "command" },
  { label: "文件变更", value: "file" },
];

const STATUS_LABELS: Record<AiAuditStatus, string> = {
  success: "已完成",
  failed: "失败",
  cancelled: "已取消",
  pending: "待确认",
  inserted: "已填入",
  executed: "已提交",
  verified: "已分析",
  applied: "已应用",
  "rolled-back": "已回滚",
  rejected: "已拒绝",
  conflict: "冲突",
};

function statusColor(status: AiAuditStatus) {
  if (status === "success" || status === "applied" || status === "verified") {
    return "green";
  }
  if (status === "failed" || status === "conflict") return "red";
  if (status === "cancelled" || status === "rejected") return "gray";
  if (status === "pending" || status === "inserted") return "orange";
  return "blue";
}

function categoryIcon(category: AiAuditCategory) {
  if (category === "command") return <IconCode />;
  if (category === "file") return <IconFile />;
  return <IconNav />;
}

function formatAuditTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "-";
}

function AiAuditDrawer({
  loadEntries = loadAiAuditEntries,
  onClose,
  visible,
}: AiAuditDrawerProps) {
  const [entries, setEntries] = useState<AiAuditEntry[]>([]);
  const [category, setCategory] = useState<AiAuditCategory>();
  const [hostId, setHostId] = useState<string>();
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await loadEntries());
    } catch (error) {
      Message.error(
        `读取 AI 操作审计失败：${commandErrorMessage(error)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [loadEntries]);

  useEffect(() => {
    if (visible) void refresh();
  }, [refresh, visible]);

  const hostOptions = useMemo(
    () =>
      Array.from(
        new Map(
          entries.map((entry) => [entry.hostId, entry.hostName]),
        ).entries(),
      ).map(([value, label]) => ({ label, value })),
    [entries],
  );
  const visibleEntries = entries.filter(
    (entry) =>
      (!category || entry.category === category) &&
      (!hostId || entry.hostId === hostId),
  );

  return (
    <Drawer
      className="ai-audit-drawer"
      footer={null}
      getChildrenPopupContainer={() => document.body}
      onCancel={onClose}
      title={
        <div className="ai-audit-title">
          <span>AI 操作审计</span>
          <Typography.Text type="secondary">
            {visibleEntries.length} 条
          </Typography.Text>
        </div>
      }
      unmountOnExit={false}
      visible={visible}
      width={520}
    >
      <div className="ai-audit-toolbar">
        <Select
          allowClear
          aria-label="按主机筛选 AI 审计记录"
          onChange={(value) => setHostId(value || undefined)}
          options={hostOptions}
          placeholder="全部主机"
          value={hostId}
        />
        <Select
          allowClear
          aria-label="按动作筛选 AI 审计记录"
          onChange={(value) =>
            setCategory((value as AiAuditCategory) || undefined)
          }
          options={CATEGORY_OPTIONS}
          placeholder="全部动作"
          value={category}
        />
        <Tooltip content="刷新">
          <Button
            aria-label="刷新 AI 操作审计"
            icon={<IconRefresh />}
            loading={loading}
            onClick={() => void refresh()}
          />
        </Tooltip>
      </div>
      <Spin className="ai-audit-loading" loading={loading}>
        <div className="ai-audit-list">
          {!loading && !visibleEntries.length ? (
            <Empty description="暂无 AI 操作记录" />
          ) : (
            visibleEntries.map((entry) => (
              <div className="ai-audit-entry" key={entry.id}>
                <span className="ai-audit-entry-icon">
                  {categoryIcon(entry.category)}
                </span>
                <div className="ai-audit-entry-content">
                  <div className="ai-audit-entry-heading">
                    <Typography.Text ellipsis title={entry.label}>
                      {entry.label}
                    </Typography.Text>
                    <Tag color={statusColor(entry.status)}>
                      {STATUS_LABELS[entry.status]}
                    </Tag>
                  </div>
                  <Typography.Text type="secondary">
                    {entry.hostName} · {formatAuditTime(entry.occurredAt)}
                    {entry.planId
                      ? ` · 计划 ${entry.planId.slice(-8)}`
                      : ""}
                    {entry.durationMs !== undefined
                      ? ` · ${entry.durationMs} ms`
                      : ""}
                  </Typography.Text>
                </div>
              </div>
            ))
          )}
        </div>
      </Spin>
    </Drawer>
  );
}

export default AiAuditDrawer;
