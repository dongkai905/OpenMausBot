// Append-only per-bot profile history (0600, redacted); a history write never fails the change it records.
import { appendFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { PROFILE_REQUEST_FIELDS, type ProfileRequestChanges } from "../shared/profile-request.ts";
import { botFolder, SOUL_FILE } from "./bot-folder.ts";
import { redactSecrets } from "./redact.ts";

/** A diff of two texts, as the version history shows it. */
const DIFF_CAP = 8_000;
const LCS_CELL_CAP = 4_000_000;
const CONTEXT = 2;

type Op = { tag: " " | "-" | "+"; line: string };

function editScript(fullA: string[], fullB: string[]): Op[] {
  if (fullA.length * fullB.length > LCS_CELL_CAP) {
    return [...fullA.map((line) => ({ tag: "-" as const, line })), ...fullB.map((line) => ({ tag: "+" as const, line }))];
  }
  let shared = 0;
  while (shared < fullA.length && shared < fullB.length && fullA[shared] === fullB[shared]) shared++;
  const ops: Op[] = fullA.slice(0, shared).map((line) => ({ tag: " ", line }));
  const a = fullA.slice(shared);
  const b = fullB.slice(shared);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ tag: "-", line: a[i++] });
    } else {
      ops.push({ tag: "+", line: b[j++] });
    }
  }
  while (i < a.length) ops.push({ tag: "-", line: a[i++] });
  while (j < b.length) ops.push({ tag: "+", line: b[j++] });
  return ops;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface UnifiedDiff {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

export function unifiedDiff(before: string, after: string, path: string, cap = DIFF_CAP): UnifiedDiff {
  if (before === after) return { text: "", added: 0, removed: 0, truncated: false };
  const ops = editScript(splitLines(before), splitLines(after));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.tag === "+") added++;
    else if (op.tag === "-") removed++;
  }
  const changes: number[] = [];
  ops.forEach((op, k) => {
    if (op.tag !== " ") changes.push(k);
  });
  const hunks: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < changes.length) {
    let lastChange = changes[index];
    let next = index + 1;
    while (next < changes.length && changes[next] - lastChange <= CONTEXT * 2 + 1) lastChange = changes[next++];
    hunks.push({ start: Math.max(0, changes[index] - CONTEXT), end: Math.min(ops.length - 1, lastChange + CONTEXT) });
    index = next;
  }
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const hunk of hunks) {
    for (; cursor < hunk.start; cursor++) {
      if (ops[cursor].tag !== "+") oldLine++;
      if (ops[cursor].tag !== "-") newLine++;
    }
    const slice = ops.slice(hunk.start, hunk.end + 1);
    const oldCount = slice.filter((op) => op.tag !== "+").length;
    const newCount = slice.filter((op) => op.tag !== "-").length;
    // an empty side is conventionally anchored on the line before it
    lines.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const op of slice) lines.push(`${op.tag}${op.line}`);
    for (; cursor <= hunk.end; cursor++) {
      if (ops[cursor].tag !== "+") oldLine++;
      if (ops[cursor].tag !== "-") newLine++;
    }
  }
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > cap) {
    text = `${text.slice(0, cap)}\n… (diff cut here)`;
    truncated = true;
  }
  return { text, added, removed, truncated };
}

export type HistoryActor = "user" | "bot" | "file" | "import" | "system";

export interface HistoryRow {
  id: string;
  at: number;
  actor: HistoryActor;
  via: string;
  field: string;
  summary: string;
  before?: string;
  after?: string;
  canRestore?: boolean;
  restoreUnavailableReason?: string;
}

const FILE_NAME = "history.ndjson";
const ONE_LINER = 200;
const MAX_HISTORY_READ_BYTES = 8 * 1024 * 1024;
const writeQueues = new Map<string, Promise<void>>();

export function historyFile(botId: string): string {
  return join(botFolder(botId), FILE_NAME);
}

function oneLiner(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, ONE_LINER);
}

function rowFor(field: string, at: number, actor: HistoryActor, via: string, before: string, after: string): HistoryRow {
  if (field === "soul") {
    const b = Buffer.byteLength(before, "utf8");
    const a = Buffer.byteLength(after, "utf8");
    return { id: randomUUID(), at, actor, via, field, summary: `soul: ${b} → ${a} bytes`, before, after };
  }
  const b = oneLiner(before);
  const a = oneLiner(after);
  return { id: randomUUID(), at, actor, via, field, summary: `${field}: ${JSON.stringify(b)} → ${JSON.stringify(a)}`, before: b, after: a };
}

function withRestoreEligibility(row: HistoryRow): HistoryRow {
  const redacted = redactSecrets(row) as HistoryRow;
  const canRestore = row.field === "soul" && typeof row.before === "string" &&
    row.canRestore !== false && row.before === redacted.before &&
    !/«redacted \d+ chars»/.test(row.before);
  return {
    ...redacted,
    canRestore,
    restoreUnavailableReason: row.field === "soul" && !canRestore
      ? "This version is missing exact text or contains redacted sensitive text and cannot be restored."
      : undefined,
  };
}

async function writeRows(botId: string, rows: HistoryRow[]): Promise<void> {
  if (!existsSync(botFolder(botId))) return;
  const file = historyFile(botId);
  mkdirSync(botFolder(botId), { recursive: true, mode: 0o700 });
  const text = rows.map((row) => JSON.stringify(withRestoreEligibility(row))).join("\n") + "\n";
  await appendFile(file, text, { mode: 0o600 });
}

function queueHistoryRows(botId: string, rows: HistoryRow[]): void {
  if (!rows.length) return;
  const previous = writeQueues.get(botId) ?? Promise.resolve();
  const queued = previous.then(() => writeRows(botId, rows)).catch(() => {
  });
  writeQueues.set(botId, queued);
  void queued.finally(() => {
    if (writeQueues.get(botId) === queued) writeQueues.delete(botId);
  });
}

export function recordProfileChange(
  botId: string,
  actor: HistoryActor,
  via: string,
  before: ProfileRequestChanges,
  after: ProfileRequestChanges,
): void {
  const at = Date.now();
  const rows: HistoryRow[] = [];
  const historyText = (value: string | boolean | undefined): string =>
    value === undefined ? "" : typeof value === "boolean" ? (value ? "on" : "off") : value;
  for (const field of PROFILE_REQUEST_FIELDS) {
    const b = before[field];
    const a = after[field];
    if (b !== a) rows.push(rowFor(field, at, actor, via, historyText(b), historyText(a)));
  }
  queueHistoryRows(botId, rows);
}

export async function flushProfileHistory(botId: string): Promise<void> {
  await writeQueues.get(botId);
}

export async function flushAllProfileHistory(): Promise<void> {
  await Promise.allSettled(writeQueues.values());
}

const isRow = (value: unknown): value is HistoryRow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as HistoryRow).at === "number" &&
  typeof (value as HistoryRow).field === "string" &&
  typeof (value as HistoryRow).actor === "string";

export function readHistory(botId: string, limit = 100): HistoryRow[] {
  let text: string;
  let offset: number;
  let end: number;
  try {
    const fd = openSync(historyFile(botId), "r");
    try {
      const size = fstatSync(fd).size;
      offset = Math.max(0, size - MAX_HISTORY_READ_BYTES);
      const buffer = Buffer.alloc(size - offset);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, offset + length);
        if (!count) break;
        length += count;
      }
      end = offset + length;
      text = buffer.subarray(0, length).toString("utf8");
    } finally { closeSync(fd); }
  } catch {
    return [];
  }
  const rows: HistoryRow[] = [];
  const lines = text.split("\n");
  const maxRows = Math.min(500, Math.max(1, limit));
  for (let index = lines.length - 1; index >= (offset > 0 ? 1 : 0) && rows.length < maxRows; index--) {
    const line = lines[index];
    end -= Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRow(value)) {
        const id = typeof value.id === "string" && value.id
          ? value.id
          : `legacy-${createHash("sha256").update(`${end}:${line}`).digest("hex")}`;
        rows.push(withRestoreEligibility({ ...value, id }));
      }
    } catch {
    }
  }
  return rows;
}

const CHANGE_ACTOR = { user: "person", bot: "bot", file: "person", import: "import", system: "import" } as const;

export function soulChanges(botId: string, rows: readonly HistoryRow[]) {
  return rows.filter((row) => row.field === "soul").map((row) => {
    const diff = unifiedDiff(row.before ?? "", row.after ?? "", SOUL_FILE);
    return {
      id: row.id, at: row.at, botId, path: SOUL_FILE, actor: CHANGE_ACTOR[row.actor] ?? "person",
      via: row.actor === "file" ? "disk" : row.via === "rollback" || row.via.startsWith("undo:") ? "revert" : row.via,
      kind: "edited" as const, beforeHash: null, afterHash: null, diff: diff.text, added: diff.added, removed: diff.removed,
      canRevert: row.canRestore === true, ...(row.restoreUnavailableReason ? { revertUnavailableReason: row.restoreUnavailableReason } : {}),
    };
  });
}
