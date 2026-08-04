import { useRef, type ReactNode, type RefObject } from "react";
import { ResizeBox } from "@arco-design/web-react";
import { clampAiSidebarWidth } from "../ai-sidebar";
import CollapsibleSplitTrigger from "./CollapsibleSplitTrigger";

interface AppWorkspaceLayoutProps {
  aiAssistantPanel: ReactNode;
  aiAssistantVisible: boolean;
  aiSidebarWidth: number;
  frozenWorkspaceWidth: number | null;
  mainSplitRef: RefObject<HTMLElement | null>;
  onAiSidebarWidthChange: (width: number) => void;
  onServerMonitorCollapsedChange: (collapsed: boolean) => void;
  onSftpCollapsedChange: (collapsed: boolean) => void;
  serverMonitorCollapsed: boolean;
  serverMonitorPanel: ReactNode;
  sftpCollapsed: boolean;
  sftpPanel: ReactNode;
  terminalPanel: ReactNode;
}

export default function AppWorkspaceLayout({
  aiAssistantPanel,
  aiAssistantVisible,
  aiSidebarWidth,
  frozenWorkspaceWidth,
  mainSplitRef,
  onAiSidebarWidthChange,
  onServerMonitorCollapsedChange,
  onSftpCollapsedChange,
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
          size: sftpCollapsed ? 1 : rightPanelRatiosRef.current.terminal,
          min: "240px",
          resizable: !sftpCollapsed,
          trigger: (prevNode, _resizeNode, nextNode) => (
            <CollapsibleSplitTrigger
              collapsed={sftpCollapsed}
              direction="vertical"
              label="文件管理栏"
              nextNode={nextNode}
              onToggle={() => onSftpCollapsedChange(!sftpCollapsed)}
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
              size: serverMonitorCollapsed ? 0 : serverMonitorWidthRef.current,
              min: serverMonitorCollapsed ? 0 : "220px",
              max: "400px",
              resizable: !serverMonitorCollapsed,
              trigger: (prevNode, _resizeNode, nextNode) => (
                <CollapsibleSplitTrigger
                  collapsed={serverMonitorCollapsed}
                  direction="horizontal"
                  label="服务器监控栏"
                  nextNode={nextNode}
                  onToggle={() =>
                    onServerMonitorCollapsedChange(!serverMonitorCollapsed)
                  }
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
          className={`ai-assistant-sidebar${
            aiAssistantVisible ? "" : " ai-assistant-sidebar-hidden"
          }`}
          directions={["left"]}
          onMoving={(_, size) => {
            const workspaceWidth =
              mainSplitRef.current?.parentElement?.getBoundingClientRect().width ??
              window.innerWidth;
            onAiSidebarWidthChange(clampAiSidebarWidth(size.width, workspaceWidth));
          }}
          onMovingEnd={() => document.body.classList.remove("ai-sidebar-resizing")}
          onMovingStart={() => document.body.classList.add("ai-sidebar-resizing")}
          width={aiSidebarWidth}
        >
          {aiAssistantPanel}
        </ResizeBox>
      </div>
    </main>
  );
}
