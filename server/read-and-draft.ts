// The prompt parts and integrations a read-and-draft run keeps, and how what a connected app answered is framed for
// the engine: as records, so the words it read cannot act as instructions.
import { recordsText } from "./records-block.ts";


/** The system prompt a read-and-draft run keeps: who the person is, where its files are, its connected apps and what a
 * run of its own is. No memory, recent work, team notes, skills or tool guides: less to leak, and a smaller turn. */
export const READ_AND_DRAFT_PARTS: ReadonlySet<string> = new Set(["user-profile", "files", "composio", "routine-execution", "automation-reply", "webhook"]);
/** The integrations a read-and-draft run keeps: OpenMausBot's own tools (fenced by route), the connected apps (fenced
 * by call) and the engine's hooks. */
export const READ_AND_DRAFT_TOOLS: ReadonlySet<string> = new Set(["agents", "composio", "hooks"]);

export const READ_AND_DRAFT_REFUSAL = "This work reads and drafts only: OpenMausBot refused this. Do not try another way.";


export const DRAFT_TOOL = "GMAIL_CREATE_EMAIL_DRAFT";

export interface DraftReply { threadId: string; to?: string }

/** The reply a draft call writes, or null when it is not a reply in one thread to one person. */
export function draftReply(args: unknown): DraftReply | null {
  if (!isRecord(args) || typeof args.thread_id !== "string" || !args.thread_id) return null;
  if (OTHER_RECIPIENTS.some((name) => args[name] !== undefined && args[name] !== null && !(Array.isArray(args[name]) && (args[name] as unknown[]).length === 0) && args[name] !== "")) return null;
  const to = args.recipient_email;
  if (to !== undefined && typeof to !== "string") return null;
  return { threadId: args.thread_id, ...(typeof to === "string" ? { to } : {}) };
}

/** Fields of a draft that would add someone the reply is not to. */
const OTHER_RECIPIENTS = ["cc", "bcc", "extra_recipients", "recipients"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function recordsAnswer(bytes: Uint8Array, contentType: string): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const wrapFrame = (raw: string): string => {
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return raw; }
    const content = isRecord(frame) && isRecord(frame.result) && Array.isArray(frame.result.content) ? frame.result.content : null;
    if (!content) return raw;
    for (const part of content) if (isRecord(part) && typeof part.text === "string") part.text = recordsText("a connected app (Gmail or Google Calendar)", part.text);
    return JSON.stringify(frame);
  };
  const wrapped = contentType.includes("text/event-stream")
    ? text.split("\n").map((line) => (line.startsWith("data: ") ? `data: ${wrapFrame(line.slice(6))}` : line)).join("\n")
    : wrapFrame(text);
  return new TextEncoder().encode(wrapped);
}
