import { describe, expect, test } from "bun:test";
import {
  aiContextMentionIds,
  aiRemoteFileContextError,
  aiRemoteFileContextSource,
  aiRemoteFileContextSourceId,
  appendAiContextMentions,
  assessAiTerminalCommand,
  buildAiContextPayload,
  buildAiRequestMessages,
  normalizeAiTerminalCommand,
  mergeAiRemoteFileContexts,
  redactAiContext,
  stripAiContextMentions,
} from "./ai-utils";

describe("AI terminal command safety", () => {
  test("keeps a single command without submitting it", () => {
    expect(normalizeAiTerminalCommand("  uname -a  ")).toBe("uname -a");
  });

  test("rejects multiline and control-character payloads", () => {
    expect(() => normalizeAiTerminalCommand("pwd\nwhoami")).toThrow(
      "多行命令不能直接填入终端",
    );
    expect(() => normalizeAiTerminalCommand("printf '\u0007'")).toThrow(
      "多行命令不能直接填入终端",
    );
  });

  test("keeps a bounded valid conversation history", () => {
    const history = buildAiRequestMessages(
      [
        { role: "assistant", content: "orphan" },
        { role: "user", content: "first" },
        { role: "assistant", content: "failed", failed: true },
        { role: "assistant", content: "answer" },
        { role: "user", content: "latest" },
      ],
      4,
    );

    expect(history).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "latest" },
    ]);
  });

  test("keeps the newest complete messages within the character budget", () => {
    expect(
      buildAiRequestMessages(
        [
          { role: "user", content: "old request" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "new" },
          { role: "assistant", content: "reply" },
        ],
        20,
        8,
      ),
    ).toEqual([
      { role: "user", content: "new" },
      { role: "assistant", content: "reply" },
    ]);
  });

  test("redacts credentials before displaying or sending context", () => {
    const redacted = redactAiContext(
      [
        "password=hunter2",
        '{"password":"json-secret"}',
        "worker --password process-secret",
        "Authorization: Bearer secret-token",
        "OPENAI_API_KEY=sk-12345678901234567890",
        "https://max:private@example.com/api",
        "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      ].join("\n"),
    );

    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("json-secret");
    expect(redacted).not.toContain("process-secret");
    expect(redacted).not.toContain("secret-token");
    expect(redacted).not.toContain("sk-12345678901234567890");
    expect(redacted).not.toContain("max:private@");
    expect(redacted).not.toContain("\nsecret\n");
  });

  test("builds only selected context sections within the configured limit", () => {
    const context = buildAiContextPayload(
      [
        { id: "terminal-selection", label: "终端选区", content: "line one" },
        { id: "terminal-output", label: "最近输出", content: "line two" },
        { id: "sftp-path", label: "当前远程目录", content: "/srv/app" },
      ],
      ["terminal-output", "sftp-path"],
      1_000,
    );

    expect(context).toContain("## 最近输出\nline two");
    expect(context).toContain("## 当前远程目录\n/srv/app");
    expect(context).not.toContain("line one");
    expect(context.length).toBeLessThanOrEqual(1_000);
  });

  test("keeps every selected source visible when one context is very long", () => {
    const context = buildAiContextPayload(
      [
        {
          id: "terminal-output",
          label: "最近输出",
          content: "terminal ".repeat(200),
        },
        {
          id: "server-monitor",
          label: "服务器状态",
          content: "server ".repeat(200),
        },
        { id: "sftp-path", label: "当前远程目录", content: "/srv/app" },
      ],
      ["terminal-output", "server-monitor", "sftp-path"],
      300,
    );

    expect(context).toContain("## 最近输出");
    expect(context).toContain("## 服务器状态");
    expect(context).toContain("## 当前远程目录\n/srv/app");
    expect(context.length).toBeLessThanOrEqual(300);
  });

  test("bounds remote files before adding them to AI context", () => {
    expect(aiRemoteFileContextError(256 * 1024)).toBeNull();
    expect(aiRemoteFileContextError(256 * 1024 + 1)).toContain("256 KiB");
    expect(aiRemoteFileContextError(Number.NaN)).toBe("无法确认远程文件大小");
  });

  test("keeps remote file metadata and the beginning of bounded content", () => {
    const source = aiRemoteFileContextSource({
      content: `server {\n${"x".repeat(1_000)}\n}`,
      name: "nginx.conf",
      path: "/etc/nginx/nginx.conf",
      size: 1_012,
    });
    const context = buildAiContextPayload([source], [source.id], 180);

    expect(source.id).toBe(
      aiRemoteFileContextSourceId("/etc/nginx/nginx.conf"),
    );
    expect(source.label).toBe("文件:/etc/nginx/nginx.conf");
    expect(context).toContain("远程路径: /etc/nginx/nginx.conf");
    expect(context).toContain("server {");
    expect(context).not.toContain("\n}");
    expect(context.length).toBeLessThanOrEqual(180);
  });

  test("deduplicates and bounds remote file context collections", () => {
    const current = [
      { content: "old", name: "a.conf", path: "/etc/a.conf", size: 3 },
    ];
    expect(
      mergeAiRemoteFileContexts(current, [
        { content: "new", name: "a.conf", path: "/etc/a.conf", size: 3 },
        { content: "b", name: "b.conf", path: "/etc/b.conf", size: 1 },
      ]),
    ).toEqual([
      { content: "new", name: "a.conf", path: "/etc/a.conf", size: 3 },
      { content: "b", name: "b.conf", path: "/etc/b.conf", size: 1 },
    ]);
    expect(() =>
      mergeAiRemoteFileContexts(
        [],
        Array.from({ length: 9 }, (_, index) => ({
          content: "x",
          name: `${index}.txt`,
          path: `/tmp/${index}.txt`,
          size: 1,
        })),
      ),
    ).toThrow("最多可同时添加 8 个");
    expect(() =>
      mergeAiRemoteFileContexts([], [
        {
          content: "x",
          name: "large.txt",
          path: "/tmp/large.txt",
          size: 512 * 1024 + 1,
        },
      ]),
    ).toThrow("512 KiB");
  });

  test("derives available context from exact mentions", () => {
    const sources = [
      { id: "terminal-output" as const, label: "最近终端输出", content: "log" },
      { id: "server-monitor" as const, label: "服务器状态", content: "" },
      { id: "sftp-path" as const, label: "当前远程目录", content: "/srv/app" },
    ];

    expect(
      aiContextMentionIds(
        "分析 @最近终端输出 和 @当前远程目录\n@服务器状态",
        sources,
      ),
    ).toEqual(["terminal-output", "sftp-path"]);
    expect(aiContextMentionIds("分析 @最近终端输出详情", sources)).toEqual([]);
  });

  test("keeps remote file mentions distinct by absolute path", () => {
    const first = aiRemoteFileContextSource({
      content: "first",
      name: "app.conf",
      path: "/srv/a/app.conf",
      size: 5,
    });
    const second = aiRemoteFileContextSource({
      content: "second",
      name: "app.conf",
      path: "/srv/b/app.conf",
      size: 6,
    });
    expect(
      aiContextMentionIds(`检查 @${second.label}`, [first, second]),
    ).toEqual([second.id]);
  });

  test("appends missing context mentions without duplicates", () => {
    const sources = [
      { id: "terminal-output" as const, label: "最近终端输出", content: "log" },
      { id: "sftp-path" as const, label: "当前远程目录", content: "/srv/app" },
    ];

    expect(
      appendAiContextMentions(
        "分析故障\n\n@最近终端输出",
        sources,
        ["terminal-output", "sftp-path"],
      ),
    ).toBe("分析故障\n\n@最近终端输出\n\n@当前远程目录");
  });

  test("removes known context mentions from the submitted question", () => {
    const sources = [
      { id: "terminal-output" as const, label: "最近终端输出", content: "log" },
      { id: "sftp-path" as const, label: "当前远程目录", content: "/srv/app" },
    ];

    expect(
      stripAiContextMentions(
        "请分析 @最近终端输出\n\n@当前远程目录",
        sources,
      ),
    ).toBe("请分析");
    expect(stripAiContextMentions("联系 @max", sources)).toBe("联系 @max");
  });

  test("classifies command suggestions without ever executing them", () => {
    expect(assessAiTerminalCommand("uname -a")).toMatchObject({
      canInsert: true,
      risk: "safe",
    });
    expect(assessAiTerminalCommand("sudo systemctl restart nginx")).toMatchObject(
      { canInsert: true, risk: "caution" },
    );
    expect(assessAiTerminalCommand("rm -rf /tmp/cache")).toMatchObject({
      canInsert: true,
      risk: "danger",
    });
    expect(assessAiTerminalCommand("pwd\nwhoami")).toMatchObject({
      canInsert: false,
    });
  });
});
