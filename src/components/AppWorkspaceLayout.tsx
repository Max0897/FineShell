import { useRef, type ReactNode, type RefObject } from "react";
import { ResizeBox } from "@arco-design/web-react";
import { clampAiSidebarWidth } from "../ai-sidebar";
import CollapsibleSplitTrigger from "./CollapsibleSplitTrigger";

interface AppWorkspaceLayoutProps {
  applicationTitleBar: ReactNode;
  aiAssistantPanel: ReactNode;
  aiAssistantMounted: boolean;
  aiAssistantOpening: boolean;
  aiSidebarWidth: number;
  frozenWorkspaceWidth: number | null;
  mainSplitRef: RefObject<HTMLElement | null>;
  onAiSidebarWidthChange: (width: number) => void;
  serverMonitorCollapsed: boolean;
  serverMonitorPanel: ReactNode;
  sftpCollapsed: boolean;
  sftpPanel: ReactNode;
  terminalPanel: ReactNode;
}

export default function AppWorkspaceLayout({
  applicationTitleBar,
  aiAssistantPanel,
  aiAssistantMounted,
  aiAssistantOpening,
  aiSidebarWidth,
  frozenWorkspaceWidth,
  mainSplitRef,
  onAiSidebarWidthChange,
  serverMonitorCollapsed,
  serverMonitorPanel,
  sftpCollapsed,
  sftpPanel,
  terminalPanel,
}: AppWorkspaceLayoutProps) {
  const serverMonitorWidthRef = useRef("220px");
  const rightPanelRatiosRef = useRef({ terminal: 0.64, sftp: 0.36 });
  const rightPanels = (
    <ResizeBox.SplitGroup
      className={`right-split${sftpCollapsed ? " right-split-sftp-collapsed" : ""}`}
      direction="vertical"
      onMoving={(_, sizes) => {
        if (sftpCollapsed) return;
        const terminalSize = Number.parseFloat(sizes[0]);
        const sftpSize = Number.parseFloat(sizes[1]);
        const totalSize = terminalSize + sftpSize;
        if (Number.isFinite(totalSize) && totalSize > 0) {
          rightPanelRatiosRef.current = {
            terminal: terminalSize / totalSize,
            sftp: sftpSize / totalSize,
          };
        }
      }}
      panes={[
        {
          content: terminalPanel,
          disabled: sftpCollapsed,
          size: sftpCollapsed ? 1 : rightPanelRatiosRef.current.terminal,
          min: "240px",
          resizable: !sftpCollapsed,
          trigger: (prevNode, _resizeNode, nextNode) => (
            <CollapsibleSplitTrigger
              direction="vertical"
              label="文件管理栏"
              nextNode={nextNode}
              prevNode={prevNode}
            />
          ),
        },
        {
          content: sftpPanel,
          size: sftpCollapsed ? 0 : rightPanelRatiosRef.current.sftp,
          min: sftpCollapsed ? 0 : "180px",
        },
      ]}
    />
  );

  return (
    <main className="app-shell">
      {applicationTitleBar}
      <div className="app-workspace">
        <ResizeBox.SplitGroup
          className={`main-split${serverMonitorCollapsed ? " main-split-left-collapsed" : ""}`}
          direction="horizontal"
          onMoving={(_, sizes) => {
            if (serverMonitorCollapsed) return;
            const width = Number.parseFloat(sizes[0]);
            if (Number.isFinite(width)) {
              serverMonitorWidthRef.current = `${width}px`;
            }
          }}
          panes={[
            {
              content: serverMonitorPanel,
              disabled: serverMonitorCollapsed,
              size: serverMonitorCollapsed ? 0 : serverMonitorWidthRef.current,
              min: serverMonitorCollapsed ? 0 : "220px",
              max: "400px",
              resizable: !serverMonitorCollapsed,
              trigger: (prevNode, _resizeNode, nextNode) => (
                <CollapsibleSplitTrigger
                  direction="horizontal"
                  label="服务器监控栏"
                  nextNode={nextNode}
                  prevNode={prevNode}
                />
              ),
            },
            {
              content: rightPanels,
              min: "480px",
              size: serverMonitorCollapsed ? 1 : undefined,
            },
          ]}
          ref={mainSplitRef}
          style={
            frozenWorkspaceWidth === null
              ? undefined
              : {
                  flex: `0 0 ${frozenWorkspaceWidth}px`,
                  width: frozenWorkspaceWidth,
                }
          }
        />
        <ResizeBox
          aria-hidden={aiAssistantOpening}
          className={`ai-assistant-sidebar${
            aiAssistantMounted ? "" : " ai-assistant-sidebar-hidden"
          }${aiAssistantOpening ? " ai-assistant-sidebar-opening" : ""}`}
          directions={["left"]}
          onMoving={(_, size) => {
            const workspaceWidth =
              mainSplitRef.current?.parentElement?.getBoundingClientRect()
                .width ?? window.innerWidth;
            onAiSidebarWidthChange(
              clampAiSidebarWidth(size.width, workspaceWidth),
            );
          }}
          onMovingEnd={() =>
            document.body.classList.remove("ai-sidebar-resizing")
          }
          onMovingStart={() =>
            document.body.classList.add("ai-sidebar-resizing")
          }
          width={aiSidebarWidth}
        >
          {aiAssistantPanel}
        </ResizeBox>
      </div>
    </main>
  );
}
