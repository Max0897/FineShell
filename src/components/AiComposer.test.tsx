import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import AiComposer from "./AiComposer";

const textareaStyles = document.createElement("style");
textareaStyles.textContent = `
  textarea.arco-textarea {
    box-sizing: border-box;
    width: 320px;
    padding: 4px 0;
    border-top: 0 solid transparent;
    border-bottom: 0 solid transparent;
    line-height: 20px;
  }
`;

beforeAll(() => document.head.appendChild(textareaStyles));
afterAll(() => textareaStyles.remove());

function renderComposer({
  onChange = mock(() => undefined),
  onSend = mock(() => undefined),
  prompt = "检查系统状态",
}: {
  onChange?: ReturnType<typeof mock>;
  onSend?: ReturnType<typeof mock>;
  prompt?: string;
} = {}) {
  const onCancel = mock(() => undefined);
  const onRemoveRemoteFile = mock(() => undefined);
  const onToggleRemoteFile = mock(() => undefined);
  return {
    onCancel,
    onChange,
    onRemoveRemoteFile,
    onSend,
    onToggleRemoteFile,
    ...render(
      <AiComposer
        activeConversationAvailable
        contextSources={[
          {
            content: "root@server:~# uptime",
            id: "terminal-output",
            label: "最近终端输出",
          },
        ]}
        editableRemoteFileCount={1}
        model="deepseek-chat"
        onCancel={onCancel}
        onChange={onChange}
        onRemoveRemoteFile={onRemoveRemoteFile}
        onSend={onSend}
        onToggleRemoteFile={onToggleRemoteFile}
        prompt={prompt}
        remoteFiles={[]}
        selectedContextIds={[]}
        sendEnabled
        sending={false}
      />,
    ),
  };
}

describe("AiComposer", () => {
  test("sends with Enter and inserts a newline with Shift+Enter", () => {
    const onChange = mock(() => undefined);
    const onSend = mock(() => undefined);
    renderComposer({ onChange, onSend, prompt: "第一行" });
    const input = screen.getByRole("textbox", {
      name: "向 AI 提问",
    }) as HTMLTextAreaElement;

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);

    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith("第一行\n");
  });

  test("leaves Enter to the mentions menu while a mention is active", () => {
    const onSend = mock(() => undefined);
    renderComposer({ onSend, prompt: "@最近终端" });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "向 AI 提问" }), {
      key: "Enter",
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  test("shows remote file context and delegates its selection", () => {
    const onToggleRemoteFile = mock(() => undefined);
    render(
      <AiComposer
        activeConversationAvailable
        contextSources={[]}
        editableRemoteFileCount={1}
        model="deepseek-chat"
        onCancel={() => undefined}
        onChange={() => undefined}
        onRemoveRemoteFile={() => undefined}
        onSend={() => undefined}
        onToggleRemoteFile={onToggleRemoteFile}
        prompt=""
        remoteFiles={[
          {
            content: "server { listen 80; }",
            name: "nginx.conf",
            path: "/etc/nginx/nginx.conf",
            size: 21,
          },
        ]}
        selectedContextIds={[]}
        sendEnabled={false}
        sending={false}
      />,
    );

    fireEvent.click(screen.getByText("nginx.conf"));
    expect(screen.getByText("1/8 ·1/512 KiB")).not.toBeNull();
    expect(onToggleRemoteFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/etc/nginx/nginx.conf" }),
      true,
    );
  });
});
