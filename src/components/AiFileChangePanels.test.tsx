import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  AiFileChangeRecord,
  AiFileEditProposal,
} from "../ai-file-edits";
import type { AiFileOperationProposal } from "../ai-file-operations";
import type { AiRemoteFileContext } from "../ai-utils";
import AiFileChangePanels, {
  aiFileProposalStatus,
} from "./AiFileChangePanels";

const FILE: AiRemoteFileContext = {
  content: "port=80\n",
  name: "app.conf",
  path: "/etc/app.conf",
  size: 8,
};

function editProposal(
  id: string,
  reviewed = true,
): AiFileEditProposal {
  return {
    content: "port=8080\n",
    id,
    originalFile: FILE,
    reviewed,
    sessionId: "session-1",
    status: "pending",
  };
}

function operationProposal(): AiFileOperationProposal {
  return {
    content: "enabled=true\n",
    id: "operation-1",
    operation: "create",
    path: "/etc/worker.conf",
    reviewed: true,
    sessionId: "session-1",
    status: "pending",
  };
}

function renderPanels(options: {
  changes?: AiFileChangeRecord[];
  editProposals?: AiFileEditProposal[];
  operationProposals?: AiFileOperationProposal[];
} = {}) {
  const callbacks = {
    onApplyAllEdits: mock(() => undefined),
    onApplyAllOperations: mock(() => undefined),
    onOpenEditReview: mock(() => undefined),
    onOpenOperationReview: mock(() => undefined),
    onRejectEdit: mock(() => undefined),
    onRejectOperation: mock(() => undefined),
    onRetryEdit: mock(() => undefined),
    onRetryOperation: mock(() => undefined),
    onRollbackAllEdits: mock(() => undefined),
    onRollbackAllOperations: mock(() => undefined),
    onRollbackEdit: mock(() => undefined),
    onRollbackOperation: mock(() => undefined),
  };
  return {
    ...callbacks,
    ...render(
      <AiFileChangePanels
        applying={false}
        changes={options.changes}
        editProposals={options.editProposals}
        operationProposals={options.operationProposals}
        {...callbacks}
      />,
    ),
  };
}

describe("AiFileChangePanels", () => {
  test("requires every pending edit to be reviewed before batch apply", () => {
    const first = editProposal("edit-1");
    const second = editProposal("edit-2");
    const view = renderPanels({ editProposals: [first, second] });

    const applyAll = screen.getByRole("button", { name: "应用全部" });
    expect((applyAll as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(applyAll);
    fireEvent.click(screen.getAllByRole("button", { name: "查看差异" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "拒绝" })[0]);

    expect(view.onApplyAllEdits).toHaveBeenCalledWith([first, second]);
    expect(view.onOpenEditReview).toHaveBeenCalledWith(first);
    expect(view.onRejectEdit).toHaveBeenCalledWith("edit-1");
  });

  test("keeps batch apply disabled while an edit is not reviewed", () => {
    renderPanels({
      editProposals: [editProposal("edit-1"), editProposal("edit-2", false)],
    });

    expect(
      (screen.getByRole("button", { name: "应用全部" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("renders file operations and delegates review without writing directly", () => {
    const proposal = operationProposal();
    const view = renderPanels({ operationProposals: [proposal] });

    expect(screen.getByText("新建文件 · worker.conf")).not.toBeNull();
    expect(screen.getByText("+1")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "审阅" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    expect(view.onOpenOperationReview).toHaveBeenCalledWith(proposal);
    expect(view.onRejectOperation).toHaveBeenCalledWith("operation-1");
  });

  test("renders metadata-only history when live proposals are absent", () => {
    renderPanels({
      changes: [
        {
          addedLines: 2,
          fileName: "app.conf",
          id: "change-1",
          operation: "rename",
          removedLines: 0,
          status: "not-applied",
          targetFileName: "app.old.conf",
        },
      ],
    });

    expect(screen.getByText("变更记录")).not.toBeNull();
    expect(screen.getByText("重命名 · app.conf → app.old.conf")).not.toBeNull();
    expect(screen.getByText("未应用")).not.toBeNull();
    expect(screen.queryByText("/etc/app.conf")).toBeNull();
  });

  test("keeps proposal status labels stable", () => {
    expect(aiFileProposalStatus("pending", false).label).toBe("等待审阅");
    expect(aiFileProposalStatus("pending", true).label).toBe("已审阅");
    expect(aiFileProposalStatus("conflict").label).toBe("远端已变化");
  });
});
