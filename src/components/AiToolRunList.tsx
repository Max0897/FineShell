import {
  Button,
  Spin,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import {
  IconCheckCircle,
  IconCloseCircle,
  IconCopy,
  IconDown,
  IconPlus,
  IconRefresh,
  IconRight,
  IconStop,
} from "@arco-design/web-react/icon";
import type { AiToolRun } from "../ai-tools";

interface AiToolRunListProps {
  expandedRuns: ReadonlySet<string>;
  messageId: string;
  onAddToDraft: (run: AiToolRun) => void;
  onCopy: (run: AiToolRun) => void | Promise<void>;
  onRerun: (messageId: string, run: AiToolRun) => void | Promise<void>;
  onToggle: (key: string) => void;
  runs: AiToolRun[];
  sending: boolean;
  sessionAvailable: boolean;
}

export function aiToolRunDuration(durationMs?: number) {
  if (durationMs === undefined) return "";
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(1)} 秒`;
}

function runStatus(run: AiToolRun) {
  if (run.status === "pending") return "等待确认";
  if (run.status === "running") return "读取中";
  if (run.status === "success") {
    return `已完成 · ${aiToolRunDuration(run.durationMs)}`;
  }
  if (run.status === "cancelled") return "已取消";
  if (run.status === "skipped") return "已跳过";
  if (run.status === "unavailable") return "不可用";
  return `不可用 · ${aiToolRunDuration(run.durationMs)}`;
}

function runStatusIcon(run: AiToolRun) {
  if (run.status === "pending") return <IconRight />;
  if (run.status === "running") return <Spin size={12} />;
  if (run.status === "success") return <IconCheckCircle />;
  if (run.status === "cancelled") return <IconStop />;
  return <IconCloseCircle />;
}

function AiToolRunList({
  expandedRuns,
  messageId,
  onAddToDraft,
  onCopy,
  onRerun,
  onToggle,
  runs,
  sending,
  sessionAvailable,
}: AiToolRunListProps) {
  if (!runs.length) return null;

  return (
    <div className="ai-tool-runs">
      {runs.map((run, runIndex) => {
        const runKey = `${messageId}:${run.callId}:${runIndex}`;
        const expanded = expandedRuns.has(runKey);
        const hasDetail = Boolean(run.summary ?? run.error);
        return (
          <div
            className={`ai-tool-run ai-tool-run-${run.status}`}
            key={`${run.callId}-${runIndex}`}
          >
            <div className="ai-tool-run-heading">
              <span className="ai-tool-run-icon">{runStatusIcon(run)}</span>
              <Typography.Text
                title={run.detail ? `${run.label} · ${run.detail}` : run.label}
              >
                {run.label}
                {run.detail ? ` · ${run.detail}` : ""}
              </Typography.Text>
              <Typography.Text type="secondary">
                {runStatus(run)}
              </Typography.Text>
              <span className="ai-tool-run-actions">
                {hasDetail && (
                  <Tooltip content={expanded ? "收起结果" : "展开结果"}>
                    <Button
                      aria-label={expanded ? "收起诊断结果" : "展开诊断结果"}
                      icon={expanded ? <IconDown /> : <IconRight />}
                      onClick={() => onToggle(runKey)}
                      size="mini"
                      type="text"
                    />
                  </Tooltip>
                )}
                {hasDetail && (
                  <Tooltip content="复制摘要">
                    <Button
                      aria-label="复制诊断摘要"
                      icon={<IconCopy />}
                      onClick={() => void onCopy(run)}
                      size="mini"
                      type="text"
                    />
                  </Tooltip>
                )}
                {hasDetail && (
                  <Tooltip content="加入下一次提问">
                    <Button
                      aria-label="将诊断摘要加入下一次提问"
                      disabled={sending}
                      icon={<IconPlus />}
                      onClick={() => onAddToDraft(run)}
                      size="mini"
                      type="text"
                    />
                  </Tooltip>
                )}
                {run.status !== "running" && run.status !== "pending" && (
                  <Tooltip content="重新执行">
                    <Button
                      aria-label="重新执行诊断工具"
                      disabled={sending || !sessionAvailable}
                      icon={<IconRefresh />}
                      onClick={() => void onRerun(messageId, run)}
                      size="mini"
                      type="text"
                    />
                  </Tooltip>
                )}
              </span>
            </div>
            {expanded && hasDetail && (
              <pre className="ai-tool-run-summary">{run.summary ?? run.error}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default AiToolRunList;
