import type { AgentActionTransition } from "./tauri-protocol";

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
