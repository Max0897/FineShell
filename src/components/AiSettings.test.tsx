import { describe, expect, mock, test } from "bun:test";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_APP_SETTINGS } from "../app-settings";
import type { TauriCommand } from "../tauri-protocol";
import AiSettings, { type AiSettingsInvoke } from "./AiSettings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AiSettings", () => {
  test("probes and displays service capabilities without flattening unknown states", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const invokeCommandMock = mock(async (command: TauriCommand) => {
      if (command === "ai_api_key_status") return true;
      if (command === "ai_list_models") return [];
      if (command === "ai_probe_capabilities") {
        return {
          chat: { state: "supported", detail: "基础对话请求成功" },
          models: { state: "unsupported", detail: "HTTP 404" },
          streaming: { state: "supported", detail: "标准 SSE" },
          tools: { state: "unknown", detail: "模型未返回工具调用" },
        };
      }
      return undefined;
    });
    const invokeCommand = invokeCommandMock as unknown as AiSettingsInvoke;
    render(
      <AiSettings
        invokeCommand={invokeCommand}
        settings={{ ...DEFAULT_APP_SETTINGS, aiModel: "test-model" }}
        updateSetting={() => undefined}
      />,
    );

    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith("ai_api_key_status"),
    );
    await user.click(screen.getByRole("button", { name: "检测能力" }));

    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith("ai_probe_capabilities", {
        request: {
          baseUrl: "https://api.openai.com/v1",
          model: "test-model",
        },
      }),
    );
    const capability = (label: string) =>
      screen.getByText(label).closest(".ai-capability-item") as HTMLElement;
    expect(within(capability("基础对话")).getByText("支持")).not.toBeNull();
    expect(within(capability("模型列表")).getByText("不支持")).not.toBeNull();
    expect(within(capability("流式输出")).getByText("支持")).not.toBeNull();
    expect(within(capability("工具调用")).getByText("未确认")).not.toBeNull();
  });

  test("ignores a capability response for an obsolete model", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const probe = deferred<{
      chat: { state: "supported"; detail: string };
      models: { state: "supported"; detail: string };
      streaming: { state: "supported"; detail: string };
      tools: { state: "supported"; detail: string };
    }>();
    const invokeCommandMock = mock(async (command: TauriCommand) => {
      if (command === "ai_api_key_status") return true;
      if (command === "ai_list_models") return [];
      if (command === "ai_probe_capabilities") return probe.promise;
      return undefined;
    });
    const invokeCommand = invokeCommandMock as unknown as AiSettingsInvoke;
    const settings = { ...DEFAULT_APP_SETTINGS, aiModel: "model-a" };
    const view = render(
      <AiSettings
        invokeCommand={invokeCommand}
        settings={settings}
        updateSetting={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(invokeCommandMock).toHaveBeenCalledWith("ai_api_key_status"),
    );
    await user.click(screen.getByRole("button", { name: "检测能力" }));
    view.rerender(
      <AiSettings
        invokeCommand={invokeCommand}
        settings={{ ...settings, aiModel: "model-b" }}
        updateSetting={() => undefined}
      />,
    );
    await act(async () => {
      probe.resolve({
        chat: { state: "supported", detail: "ok" },
        models: { state: "supported", detail: "ok" },
        streaming: { state: "supported", detail: "ok" },
        tools: { state: "supported", detail: "ok" },
      });
      await probe.promise;
    });

    expect(screen.queryByText("基础对话")).toBeNull();
  });
});
