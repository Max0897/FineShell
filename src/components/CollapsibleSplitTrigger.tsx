import { useRef, type ReactNode } from "react";
import {
  IconDragDot,
  IconDragDotVertical,
} from "@arco-design/web-react/icon";

interface CollapsibleSplitTriggerProps {
  collapsed: boolean;
  direction: "horizontal" | "vertical";
  label: string;
  nextNode: ReactNode;
  onToggle: () => void;
  prevNode: ReactNode;
}

export default function CollapsibleSplitTrigger({
  collapsed,
  direction,
  label,
  nextNode,
  onToggle,
  prevNode,
}: CollapsibleSplitTriggerProps) {
  const lastPressAtRef = useRef(0);

  return (
    <div
      aria-label={`双击${collapsed ? "显示" : "隐藏"}${label}`}
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      className="arco-resizebox-trigger-icon-wrapper collapsible-split-trigger"
      data-collapsed={collapsed}
      onMouseDownCapture={(event) => {
        if (event.button !== 0) return;
        const now = performance.now();
        const doublePress =
          lastPressAtRef.current > 0 && now - lastPressAtRef.current <= 400;
        lastPressAtRef.current = doublePress ? 0 : now;
        if (doublePress) {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }
      }}
      role="separator"
      title={`双击${collapsed ? "显示" : "隐藏"}${label}`}
    >
      {prevNode}
      <span className="arco-resizebox-trigger-icon">
        {direction === "horizontal" ? <IconDragDotVertical /> : <IconDragDot />}
      </span>
      {nextNode}
    </div>
  );
}
