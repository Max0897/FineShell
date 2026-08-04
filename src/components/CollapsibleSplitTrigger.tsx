import type { ReactNode } from "react";
import {
  IconDragDot,
  IconDragDotVertical,
} from "@arco-design/web-react/icon";

interface CollapsibleSplitTriggerProps {
  direction: "horizontal" | "vertical";
  label: string;
  nextNode: ReactNode;
  prevNode: ReactNode;
}

export default function CollapsibleSplitTrigger({
  direction,
  label,
  nextNode,
  prevNode,
}: CollapsibleSplitTriggerProps) {
  return (
    <div
      aria-label={`调整${label}大小`}
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      className="arco-resizebox-trigger-icon-wrapper collapsible-split-trigger"
      role="separator"
      title={`拖动调整${label}大小`}
    >
      {prevNode}
      <span className="arco-resizebox-trigger-icon">
        {direction === "horizontal" ? <IconDragDotVertical /> : <IconDragDot />}
      </span>
      {nextNode}
    </div>
  );
}
