export { ContextManager, compactionTrigger, contextKey, levelFor, outputReserve, requestMaxOutput, summaryRequest } from "./context-manager";
export type { ContextSettings, ContextSnapshot, CompactionAction, FitResult, ReportedUsage } from "./context-manager";
export { HarnessLog } from "./diagnostics";
export type { HarnessEvent, HarnessEventKind } from "./diagnostics";
export { profileFor, manualMaxOutput, learn, modelKey, rememberReported } from "./profile-for";
export { resolveModelProfile } from "./model-profile";
export type { ModelProfile, LearnedModelInfo } from "./model-profile";
export { formatTokens } from "./tokens";

import { ContextManager } from "./context-manager";
import { HarnessLog } from "./diagnostics";

/** What the orchestrators of one plugin share: the log, and the token calibration that learns across chats. */
export interface HarnessServices {
  log: HarnessLog;
  context: ContextManager;
  /** Persists settings (learned limits live there). */
  save: () => void | Promise<void>;
}

export function createHarnessServices(save: () => void | Promise<void>): HarnessServices {
  return { log: new HarnessLog(), context: new ContextManager(), save };
}
