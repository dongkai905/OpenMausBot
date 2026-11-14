// What a failed turn turns into: one more start after a short wait, unless a second start could only repeat or undo
// it (a stall the turn watchdog stopped, a stop someone pressed or typed, a refusal, a spent cap); a busy target is
// waited for, a usage limit with a known reset is waited out, and what only the owner can fix fails at once. A
// teammate's failed thread takes the same verdict (host/chief-notices.ts).
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { ServerText } from "../shared/server-text.ts";
import { engineFailureKind } from "./drivers/engine-errors.ts";
import { classifyError } from "./drivers/retry.ts";
import { classifyContinuable } from "./turn-continuation.ts";

/** Why a turn was started again. */
export type RetryCause = "stalled" | "restarted" | "rate_limited" | "provider" | "usage_limit" | "failed";

export type OwnerCause = "signed_out" | "credits" | "usage_limit" | "setup";

/** What is known about a failure besides its words: a cause the server words itself, and the engine's own flags. */
export interface FailureFacts {
  /** stalled: the turn watchdog stopped it; cap: a spend or turn cap (or the repeat guard) ended it; refused: the server
   * would not start it, or its start failed before the turn began (judged by its words, never retried as a crash). */
  cause?: "stalled" | "busy" | "cap" | "refused";
  stopReason?: string | null;
  setup?: boolean;
  stalled?: boolean;
  trialCredit?: string;
  limitResetsAt?: number;
  /** A usage limit refused it (the runtime error's `limit`). */
  limit?: "engine" | "model" | "credits";
  /** A backup engine takes over from one whose usage limit refused the turn, or that is signed out. */
  backupReady?: boolean;
  text?: ServerText;
  /** The turn's reply came back; only a step it ran failed or wasn't allowed (the runtime error's `partial`). */
  partial?: boolean;
}

export type FailureClass =
  | { kind: "retry"; cause: Exclude<RetryCause, "usage_limit"> }
  | { kind: "busy" }
  | { kind: "owner"; cause: OwnerCause; resetsAt?: number }
  | { kind: "final" };

/** startTurn's codes for a bot or thread that is busy for now. */
const BUSY_CODES = new Set(["thread_busy", "thread_limit", "workspace_busy", "settling"]);
/** Stop reasons of a turn someone ended on purpose (Stop, a typed "stop", a settings change that cut it short), the AI
 * declined, or a tool call the person denied or that failed after its corrective rounds: a second start would undo or
 * repeat it. */
const NOT_RETRIED_STOPS = new Set(["cancelled", "interrupted", "refusal", "tool_error"]);
/** What the provider answered for a reason a second start would meet again. */
const REFUSED_KINDS = new Set(["refused", "tool_schema", "tool_count"]);

/** Any failure gets one automatic retry, except a stall the turn watchdog stopped (its Chief hears instead), a
 * stop someone pressed or typed, a refusal, and a spent cap. */
export function classifyFailure(failure: string, facts: FailureFacts = {}): FailureClass {
  if (facts.cause === "busy") return { kind: "busy" };
  if (facts.cause === "stalled" || facts.cause === "cap") return { kind: "final" };
  if (facts.stopReason && NOT_RETRIED_STOPS.has(facts.stopReason)) return { kind: "final" };
  if (classifyContinuable(facts.stopReason, failure) === "cap") return { kind: "final" };
  if (facts.stalled) return { kind: "retry", cause: "stalled" };
  const engine = engineFailureKind(failure);
  const { reason, transient } = classifyError({ text: failure });
  if (facts.trialCredit || (engine === "credits" && !facts.limit)) return { kind: "owner", cause: "credits" };
  if (facts.limit || facts.limitResetsAt || facts.stopReason === "quota" || engine === "usage_limit") {
    return { kind: "owner", cause: "usage_limit", ...(facts.limitResetsAt ? { resetsAt: facts.limitResetsAt } : {}) };
  }
  if (facts.stopReason === "auth_required" || reason === "auth") return { kind: "owner", cause: "signed_out" };
  if (reason === "quota") return { kind: "owner", cause: "credits" };
  if (facts.setup || facts.stopReason === "update_required" || facts.stopReason === "setup_required") return { kind: "owner", cause: "setup" };
  if (engine === "rate_limit" || reason === "rate_limited") return { kind: "retry", cause: "rate_limited" };
  if (engine === "overloaded" || engine === "server" || transient) return { kind: "retry", cause: "provider" };
  // A failure nothing above names (a crash, an exit before the result): one more start. A refused start or a named refusal never.
  return reason === "unknown" && facts.cause !== "refused" && !(engine && REFUSED_KINDS.has(engine)) ? { kind: "retry", cause: "failed" } : { kind: "final" };
}

/** Why startTurn would not start a turn: busy for now, the workspace spend cap, or any other refusal. A start that threw
 * without a status or code (an engine that would not spawn) is a failure like any other. */
export function dispatchRefusal(error: unknown): FailureFacts {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (typeof code === "string" && BUSY_CODES.has(code)) return { cause: "busy" };
  if (code === "spend_cap") return { cause: "cap" };
  return typeof code === "string" || (typeof status === "number" && status >= 400 && status < 500) ? { cause: "refused" } : {};
}

/** Whether OpenMausBot runs a failed teammate thread once more by itself before its Chief hears of it. */
export function retriesTeammateThread(failure: string, facts: FailureFacts = {}): boolean {
  return classifyFailure(failure, facts).kind === "retry";
}

export function engineFacts({ setup, stalled, trialCredit, limitResetsAt, limit, partial, text }: RuntimeEvent & { type: "runtime.error" }): FailureFacts {
  return { setup, stalled, trialCredit, limitResetsAt, limit, partial, text };
}
