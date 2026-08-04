import {
  aiCommandApprovalToolResult,
  aiCommandProposalToolResult,
  createAiCommandProposal,
  isAiCommandProposalToolCall,
  type AiCommandApprovalDecision,
  type AiCommandProposal,
} from "../ai-command-proposals";
import {
  aiFileApprovalToolResult,
  type AiFileApprovalDecision,
} from "../ai-file-approvals";
import {
  aiFileEditToolResult,
  createAiFileEditProposal,
  isAiFileEditToolCall,
  type AiFileEditProposal,
} from "../ai-file-edits";
import {
  aiFileOperationToolResult,
  createAiFileOperationProposal,
  isAiFileOperationToolCall,
  type AiFileOperationProposal,
} from "../ai-file-operations";
import type { AiRemoteFileContext } from "../ai-utils";
import {
  commandErrorMessage,
  type AiToolCall,
  type AiToolResult,
} from "../tauri-protocol";

interface PrepareAiProposalRoundOptions {
  calls: AiToolCall[];
  currentOperationDirectory: string | null;
  editableFiles: AiRemoteFileContext[];
  fileProposalEnabled: boolean;
  proposedCommands: Set<string>;
  proposedFilePaths: Set<string>;
  requestId: string;
  targetDirectory: string | null;
  targetSessionId: string;
  terminalProposalEnabled: boolean;
  waitForCommandApproval: (
    proposalId: string,
    requestId: string,
  ) => Promise<AiCommandApprovalDecision>;
  waitForFileApproval: (
    proposalId: string,
    requestId: string,
  ) => Promise<AiFileApprovalDecision>;
}

export interface AiPreparedProposalRound {
  commandApprovalDecisions: Map<
    string,
    Promise<AiCommandApprovalDecision>
  >;
  commandProposals: AiCommandProposal[];
  fileApprovalDecisions: Map<string, Promise<AiFileApprovalDecision>>;
  fileEditProposals: AiFileEditProposal[];
  fileOperationProposals: AiFileOperationProposal[];
  proposalResults: Map<string, AiToolResult>;
}

function assertSupportedProposalCalls(calls: AiToolCall[]) {
  const unsupportedCall = calls.find(
    (call) =>
      !isAiFileEditToolCall(call) &&
      !isAiFileOperationToolCall(call) &&
      !isAiCommandProposalToolCall(call),
  );
  if (unsupportedCall) {
    throw new Error(
      `AI 后端返回了未处理的工具调用：${unsupportedCall.name}`,
    );
  }
}

export function prepareAiProposalRound({
  calls,
  currentOperationDirectory,
  editableFiles,
  fileProposalEnabled,
  proposedCommands,
  proposedFilePaths,
  requestId,
  targetDirectory,
  targetSessionId,
  terminalProposalEnabled,
  waitForCommandApproval,
  waitForFileApproval,
}: PrepareAiProposalRoundOptions): AiPreparedProposalRound {
  assertSupportedProposalCalls(calls);

  const round: AiPreparedProposalRound = {
    commandApprovalDecisions: new Map(),
    commandProposals: [],
    fileApprovalDecisions: new Map(),
    fileEditProposals: [],
    fileOperationProposals: [],
    proposalResults: new Map(),
  };

  for (const call of calls.filter(isAiFileEditToolCall)) {
    let proposalError: string | undefined;
    try {
      if (!fileProposalEnabled || !editableFiles.length) {
        throw new Error("当前文件上下文不允许生成可应用的修改");
      }
      const proposal = createAiFileEditProposal(
        call,
        editableFiles,
        targetSessionId,
      );
      if (proposedFilePaths.has(proposal.originalFile.path)) {
        throw new Error("AI 重复返回了同一文件的修改建议");
      }
      proposedFilePaths.add(proposal.originalFile.path);
      round.fileEditProposals.push(proposal);
      round.fileApprovalDecisions.set(
        call.id,
        waitForFileApproval(call.id, requestId),
      );
    } catch (error) {
      proposalError = commandErrorMessage(error);
    }
    round.proposalResults.set(
      call.id,
      aiFileEditToolResult(call, proposalError),
    );
  }

  for (const call of calls.filter(isAiFileOperationToolCall)) {
    let proposalError: string | undefined;
    try {
      if (!fileProposalEnabled) {
        throw new Error("文件变更提案权限已关闭");
      }
      const proposal = createAiFileOperationProposal(
        call,
        editableFiles,
        currentOperationDirectory,
        targetSessionId,
      );
      const touchedPaths = [proposal.path, proposal.targetPath].filter(
        (path): path is string => Boolean(path),
      );
      if (touchedPaths.some((path) => proposedFilePaths.has(path))) {
        throw new Error("AI 返回了相互冲突的文件变更建议");
      }
      touchedPaths.forEach((path) => proposedFilePaths.add(path));
      round.fileOperationProposals.push(proposal);
      round.fileApprovalDecisions.set(
        call.id,
        waitForFileApproval(call.id, requestId),
      );
    } catch (error) {
      proposalError = commandErrorMessage(error);
    }
    round.proposalResults.set(
      call.id,
      aiFileOperationToolResult(call, proposalError),
    );
  }

  for (const call of calls.filter(isAiCommandProposalToolCall)) {
    let proposalError: string | undefined;
    try {
      if (!terminalProposalEnabled) {
        throw new Error("当前终端会话不允许提交命令");
      }
      const proposal = createAiCommandProposal(
        call,
        targetSessionId,
        targetDirectory,
      );
      if (proposedCommands.has(proposal.command)) {
        throw new Error("AI 重复返回了同一条终端命令");
      }
      proposedCommands.add(proposal.command);
      round.commandProposals.push(proposal);
      round.commandApprovalDecisions.set(
        call.id,
        waitForCommandApproval(call.id, requestId),
      );
    } catch (error) {
      proposalError = commandErrorMessage(error);
    }
    if (proposalError) {
      round.proposalResults.set(
        call.id,
        aiCommandProposalToolResult(call, proposalError),
      );
    }
  }

  return round;
}

export function aiProposalRoundHasPendingApprovals(
  round: AiPreparedProposalRound,
) {
  return (
    round.commandApprovalDecisions.size > 0 ||
    round.fileApprovalDecisions.size > 0
  );
}

export async function resolveAiProposalRound(
  calls: AiToolCall[],
  round: AiPreparedProposalRound,
  isCancelled: () => boolean,
) {
  const toolResults: AiToolResult[] = [];

  for (const call of calls) {
    if (isCancelled()) throw new Error("AI 请求已取消");

    if (isAiFileEditToolCall(call)) {
      const decision = round.fileApprovalDecisions.get(call.id);
      toolResults.push(
        decision
          ? aiFileApprovalToolResult(call, await decision)
          : (round.proposalResults.get(call.id) ??
              aiFileEditToolResult(call, "文件修改建议未通过本地校验")),
      );
      continue;
    }
    if (isAiFileOperationToolCall(call)) {
      const decision = round.fileApprovalDecisions.get(call.id);
      toolResults.push(
        decision
          ? aiFileApprovalToolResult(call, await decision)
          : (round.proposalResults.get(call.id) ??
              aiFileOperationToolResult(
                call,
                "文件操作建议未通过本地校验",
              )),
      );
      continue;
    }
    if (isAiCommandProposalToolCall(call)) {
      const decision = round.commandApprovalDecisions.get(call.id);
      toolResults.push(
        decision
          ? aiCommandApprovalToolResult(call, await decision)
          : (round.proposalResults.get(call.id) ??
              aiCommandProposalToolResult(
                call,
                "终端命令建议未通过本地校验",
              )),
      );
      continue;
    }
    throw new Error(`AI 请求了不支持的工具：${call.name}`);
  }

  return toolResults;
}
