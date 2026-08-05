import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { render } from "@testing-library/react";
import AppWorkspaceLayout from "./AppWorkspaceLayout";

function renderWorkspace({ opening = false } = {}) {
  return render(
    <AppWorkspaceLayout
      applicationTitleBar={<div>title</div>}
      aiAssistantMounted
      aiAssistantOpening={opening}
      aiAssistantPanel={<div>assistant</div>}
      aiSidebarWidth={440}
      frozenWorkspaceWidth={1_200}
      mainSplitRef={createRef<HTMLElement>()}
      onAiSidebarWidthChange={() => undefined}
      serverMonitorCollapsed={false}
      serverMonitorPanel={<div>monitor</div>}
      sftpCollapsed={false}
      sftpPanel={<div>sftp</div>}
      terminalPanel={<div>terminal</div>}
    />,
  );
}

describe("AppWorkspaceLayout", () => {
  test("stages the AI sidebar without exposing it while opening", () => {
    const { container } = renderWorkspace({ opening: true });
    const sidebar = container.querySelector(".ai-assistant-sidebar");

    expect(sidebar?.classList.contains("ai-assistant-sidebar-opening")).toBe(
      true,
    );
    expect(sidebar?.classList.contains("ai-assistant-sidebar-hidden")).toBe(
      false,
    );
    expect(sidebar?.getAttribute("aria-hidden")).toBe("true");
  });

  test("returns the AI sidebar to the normal split layout after opening", () => {
    const { container } = renderWorkspace();
    const sidebar = container.querySelector(".ai-assistant-sidebar");

    expect(sidebar?.classList.contains("ai-assistant-sidebar-opening")).toBe(
      false,
    );
    expect(sidebar?.getAttribute("aria-hidden")).toBe("false");
  });
});
