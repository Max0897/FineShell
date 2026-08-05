import { Radio, Typography } from "@arco-design/web-react";
import { Highlight, themes, type RenderProps } from "prism-react-renderer";
import { useMemo, type ReactNode } from "react";
import {
  aiFileEditDiffLines,
  aiFileEditLineSummary,
  aiFileEditSideBySideRows,
  type AiFileEditDiffLine,
  type AiFileEditSideBySideRow,
} from "../ai-file-edits";
import { useResolvedAppearance } from "../hooks/useResolvedAppearance";

export type AiFileDiffMode = "split" | "unified";

interface AiFileDiffViewProps {
  mode: AiFileDiffMode;
  onChangeMode: (mode: AiFileDiffMode) => void;
  originalContent: string;
  path: string;
  proposedContent: string;
}

interface BoundedItem<T> {
  item?: T;
  omitted?: number;
}

const MAX_RENDERED_DIFF_ROWS = 2_000;
const DIFF_CONTEXT_LINES = 3;

const EXTENSION_LANGUAGES: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  htm: "markup",
  html: "markup",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  sql: "sql",
  svg: "markup",
  swift: "swift",
  ts: "typescript",
  tsx: "tsx",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
};

export function aiFileLanguage(path: string) {
  const fileName = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === fileName.length - 1) {
    return "plain";
  }
  return EXTENSION_LANGUAGES[fileName.slice(extensionIndex + 1)] ?? "plain";
}

function boundedItems<T>(
  items: T[],
  isChanged: (item: T) => boolean,
): BoundedItem<T>[] {
  if (items.length <= MAX_RENDERED_DIFF_ROWS) {
    return items.map((item) => ({ item }));
  }

  const visibleIndexes = new Set<number>();
  items.forEach((item, index) => {
    if (!isChanged(item)) return;
    for (
      let contextIndex = Math.max(0, index - DIFF_CONTEXT_LINES);
      contextIndex <= Math.min(items.length - 1, index + DIFF_CONTEXT_LINES);
      contextIndex += 1
    ) {
      visibleIndexes.add(contextIndex);
    }
  });

  if (!visibleIndexes.size) {
    const half = Math.floor(MAX_RENDERED_DIFF_ROWS / 2);
    for (let index = 0; index < half; index += 1) visibleIndexes.add(index);
    for (let index = items.length - half; index < items.length; index += 1) {
      visibleIndexes.add(index);
    }
  }

  const indexes = [...visibleIndexes]
    .sort((left, right) => left - right)
    .slice(0, MAX_RENDERED_DIFF_ROWS);
  const bounded: BoundedItem<T>[] = [];
  let previousIndex = -1;
  for (const index of indexes) {
    if (index > previousIndex + 1) {
      bounded.push({ omitted: index - previousIndex - 1 });
    }
    bounded.push({ item: items[index] });
    previousIndex = index;
  }
  if (previousIndex < items.length - 1) {
    bounded.push({ omitted: items.length - previousIndex - 1 });
  }
  return bounded;
}

function renderTokens(
  line: AiFileEditDiffLine | undefined,
  side: "new" | "old",
  render: RenderProps,
): ReactNode {
  if (!line) return null;
  const lineNumber = side === "old" ? line.oldLineNumber : line.newLineNumber;
  const tokens = lineNumber ? render.tokens[lineNumber - 1] : undefined;
  if (!tokens) return line.content || " ";
  return tokens.map((token, index) => (
    <span key={index} {...render.getTokenProps({ token })} />
  ));
}

function OmittedRows({ count }: { count: number }) {
  return (
    <div className="ai-file-diff-omitted" role="note">
      为保证性能，省略 {count} 行内容
    </div>
  );
}

function UnifiedDiff({
  items,
  newRender,
  oldRender,
}: {
  items: BoundedItem<AiFileEditDiffLine>[];
  newRender: RenderProps;
  oldRender: RenderProps;
}) {
  return (
    <div className="ai-file-diff-lines ai-file-diff-lines-unified">
      {items.map((entry, index) => {
        if (!entry.item) {
          return (
            <OmittedRows count={entry.omitted ?? 0} key={`omitted-${index}`} />
          );
        }
        const line = entry.item;
        return (
          <div
            className={`ai-file-diff-line ai-file-diff-line-${line.kind}`}
            data-new-line={line.newLineNumber}
            data-old-line={line.oldLineNumber}
            key={`${line.kind}-${line.oldLineNumber ?? ""}-${line.newLineNumber ?? ""}`}
          >
            <span className="ai-file-diff-line-number">
              {line.oldLineNumber ?? ""}
            </span>
            <span className="ai-file-diff-line-number">
              {line.newLineNumber ?? ""}
            </span>
            <span className="ai-file-diff-marker" aria-hidden>
              {line.kind === "added"
                ? "+"
                : line.kind === "removed"
                  ? "-"
                  : " "}
            </span>
            <code>
              {renderTokens(
                line,
                line.kind === "removed" ? "old" : "new",
                line.kind === "removed" ? oldRender : newRender,
              )}
            </code>
          </div>
        );
      })}
    </div>
  );
}

function SplitDiff({
  items,
  newRender,
  oldRender,
}: {
  items: BoundedItem<AiFileEditSideBySideRow>[];
  newRender: RenderProps;
  oldRender: RenderProps;
}) {
  return (
    <div className="ai-file-diff-lines ai-file-diff-lines-split">
      <div className="ai-file-diff-split-heading">
        <span>原文件</span>
        <span>建议文件</span>
      </div>
      {items.map((entry, index) => {
        if (!entry.item) {
          return (
            <OmittedRows count={entry.omitted ?? 0} key={`omitted-${index}`} />
          );
        }
        const row = entry.item;
        return (
          <div className="ai-file-diff-split-row" key={index}>
            <div
              className={`ai-file-diff-cell ai-file-diff-line-${row.left?.kind ?? "empty"}`}
            >
              <span className="ai-file-diff-line-number">
                {row.left?.oldLineNumber ?? ""}
              </span>
              <span className="ai-file-diff-marker" aria-hidden>
                {row.left?.kind === "removed" ? "-" : " "}
              </span>
              <code>{renderTokens(row.left, "old", oldRender)}</code>
            </div>
            <div
              className={`ai-file-diff-cell ai-file-diff-line-${row.right?.kind ?? "empty"}`}
            >
              <span className="ai-file-diff-line-number">
                {row.right?.newLineNumber ?? ""}
              </span>
              <span className="ai-file-diff-marker" aria-hidden>
                {row.right?.kind === "added" ? "+" : " "}
              </span>
              <code>{renderTokens(row.right, "new", newRender)}</code>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AiFileDiffView({
  mode,
  onChangeMode,
  originalContent,
  path,
  proposedContent,
}: AiFileDiffViewProps) {
  const appearance = useResolvedAppearance();
  const syntaxTheme = appearance === "dark" ? themes.oneDark : themes.oneLight;
  const language = aiFileLanguage(path);
  const summary = useMemo(
    () => aiFileEditLineSummary(originalContent, proposedContent),
    [originalContent, proposedContent],
  );
  const unifiedItems = useMemo(
    () =>
      boundedItems(
        aiFileEditDiffLines(originalContent, proposedContent),
        (line) => line.kind !== "unchanged",
      ),
    [originalContent, proposedContent],
  );
  const splitItems = useMemo(
    () =>
      boundedItems(
        aiFileEditSideBySideRows(originalContent, proposedContent),
        (row) =>
          row.left?.kind !== "unchanged" || row.right?.kind !== "unchanged",
      ),
    [originalContent, proposedContent],
  );

  return (
    <div className="ai-file-diff-view">
      <div className="ai-file-diff-toolbar">
        <Typography.Text type="secondary">
          <span className="ai-file-lines-added">+{summary.addedLines}</span>{" "}
          <span className="ai-file-lines-removed">-{summary.removedLines}</span>
        </Typography.Text>
        <Radio.Group
          aria-label="差异显示模式"
          mode="fill"
          onChange={(value) => onChangeMode(value as AiFileDiffMode)}
          options={[
            { label: "统一", value: "unified" },
            { label: "左右", value: "split" },
          ]}
          size="mini"
          type="button"
          value={mode}
        />
      </div>
      <div
        className="ai-file-edit-diff"
        role="region"
        aria-label="文件修改差异"
      >
        <Highlight
          code={originalContent}
          language={language}
          theme={syntaxTheme}
        >
          {(oldRender) => (
            <Highlight
              code={proposedContent}
              language={language}
              theme={syntaxTheme}
            >
              {(newRender) =>
                mode === "unified" ? (
                  <UnifiedDiff
                    items={unifiedItems}
                    newRender={newRender}
                    oldRender={oldRender}
                  />
                ) : (
                  <SplitDiff
                    items={splitItems}
                    newRender={newRender}
                    oldRender={oldRender}
                  />
                )
              }
            </Highlight>
          )}
        </Highlight>
      </div>
    </div>
  );
}

export default AiFileDiffView;
