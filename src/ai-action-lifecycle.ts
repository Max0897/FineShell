import type {
  AgentActionExecutionResult,
  AgentActionTransition,
} from "./tauri-protocol";

export interface AiActionTransitionDetail {
  error?: string;
  summary?: string;
}

export type AiActionTransitionHandler = (
  messageId: string,
  actionId: string,
  transition: AgentActionTransition,
  detail?: AiActionTransitionDetail,
) => Promise<void>;

export type AiActionExecutionHandler = (
  messageId: string,
  actionId: string,
  rollback?: boolean,
  contentOverride?: string,
  userConfirmed?: boolean,
) => Promise<AgentActionExecutionResult>;
