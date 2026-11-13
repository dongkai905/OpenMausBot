// What only the one-time move to the person's own Cloud carries, each under its own id: imported and library skills, and
// the bot fields My Cloud sets over this route. GET /api/cloud-send/kind?key= answers one item's record from this
// computer; PUT has My Cloud take it under the same id, as its owner's, with this computer's folder named as its own.
// Admin scope; My Cloud takes an item only over its owner's session.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { EMPTY, MOVE_BOT_PARTS, itemKey } from "../electron/cloud-send-parts.mjs";
import type { MoveKind } from "../electron/cloud-send-parts.mjs";
import { isSkillName } from "../shared/skill-md.ts";
import type { InstalledPlaybook, InstalledPackageMetadata } from "../shared/wire.ts";
import type { CloudOwner } from "./cloud-owner-lines.ts";
import type { CloudSendItem } from "./cloud-send.ts";
import { keptDefaultBot, retireUnusedStarter, takeArrivingDefaultBot } from "./default-bot.ts";
import { IMPORTED_SKILLS_DIR, readImportedSkills, storeImportedSkills, type ImportedSkillInput } from "./imported-skills.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";
import { installLibrarySkill, readLibrarySkillFile, readSkillLibraryIndex, setLibrarySkillReviewState, updateLibrarySkill, type SkillLibraryEntry } from "./skill-library.ts";
import type { BotRecord, Store } from "./store.ts";
import { validRelative } from "./workspace-backup-paths.ts";

const KIND_BODY_MAX = 8 * 1024 * 1024;
export const MOVE_BOT_FIELDS: readonly string[] = Object.values(MOVE_BOT_PARTS).flat();

export interface MoveKindsDeps {
  dataDir: string;
  store: Pick<Store, "bots" | "bot" | "group" | "patchBot" | "setChiefOfStaff" | "appendMessage" | "messagesFor">;
  /** The person's Claude Code skills while this server uses them where they are; a move keeps them as imported skills. */
  claudeCodeSkills(): ImportedSkillInput[];
  instanceExists(id: string): boolean;
  /** My Cloud's owner, when the request is the owner's own session on a Cloud home; null otherwise. */
  owner(auth: RequestAuth): CloudOwner | null;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const pick = (source: object, names: readonly string[]) => Object.fromEntries(names.filter((name) => (source as Record<string, unknown>)[name] !== undefined)
  .map((name) => [name, structuredClone((source as Record<string, unknown>)[name])]));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** One hash both servers agree on: a Windows computer's separators read as forward slashes. */

/** An imported skill's files as they are kept here, SKILL.md apart. */
function importedSkillFiles(name: string): { skillMd: string; files: Array<{ path: string; content: string; executable: boolean }> } | null {
  const root = join(IMPORTED_SKILLS_DIR, name);
  const files: Array<{ path: string; content: string; executable: boolean }> = [];
  let skillMd: string | null = null;
  const walk = (folder: string, prefix: string, depth: number): boolean => {
    if (depth > 8) return false;
    for (const entry of readdirSync(folder).sort()) {
      const full = join(folder, entry), path = prefix ? `${prefix}/${entry}` : entry;
      const info = lstatSync(full);
      if (info.isDirectory()) { if (!walk(full, path, depth + 1)) return false; continue; }
      if (!info.isFile()) return false;
      const content = readFileSync(full, "utf8");
      if (path === "SKILL.md") skillMd = content;
      else files.push({ path, content, executable: (info.mode & 0o100) !== 0 });
    }
    return true;
  };
  try { if (!walk(root, "", 0)) return null; } catch { return null; }
  return skillMd === null ? null : { skillMd, files };
}

/** An imported skill by its content: SKILL.md and each file with its executable bit. */
export function importedSkillHash(skill: { skillMd: string; files: ReadonlyArray<{ path: string; content: string; executable: boolean }> }): string {
  const lines = [`SKILL.md ${sha256(skill.skillMd)}`, ...[...skill.files].sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.executable ? "x" : "-"} ${file.path} ${sha256(file.content)}`)];
  return sha256(lines.join("\n")).slice(0, 24);
}

/** The imported skills a move carries: those kept here, and the person's Claude Code skills this server uses where they
 * are, unless one of the same name was imported. */
function importedSkills(deps: MoveKindsDeps): ImportedSkillInput[] {
  const out: ImportedSkillInput[] = [];
  for (const [name, entry] of Object.entries(readImportedSkills())) {
    const files = importedSkillFiles(name);
    if (!files) continue;
    const { filesSha256: _files, importedAt: _at, ...kept } = entry;
    out.push({ name, entry: kept, ...files });
  }
  const held = new Set(out.map((skill) => skill.name));
  for (const skill of deps.claudeCodeSkills()) if (!held.has(skill.name)) out.push(skill);
  return out;
}

function librarySkills(): Array<{ entry: SkillLibraryEntry; text: string }> {
  return Object.values(readSkillLibraryIndex()).flatMap((entry) => {
    const text = readLibrarySkillFile(entry.name);
    return text === null ? [] : [{ entry, text }];
  });
}

/** A bot's parts only a move compares, as Send to My Cloud hashes the others (cloud-send.ts). */
export function moveBotParts(bot: BotRecord, hash: (value: unknown) => string): Record<string, string> {
  const fields = bot as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(MOVE_BOT_PARTS).map(([part, names]) => [part,
    hash(names.length === 1 ? fields[names[0]!] : Object.fromEntries(names.map((name) => [name, fields[name]])))]));
}

/** This server's skill extras, as a move compares them: the library skills of the bots it carries, and the person's
 * imported skills. `only`: a move of that one bot into a team carries the library skills it uses; the person's imported
 * skills stay. */
export function moveItems(deps: MoveKindsDeps, _bots: ReadonlySet<string>, only?: Pick<BotRecord, "id" | "assignedSkills">): CloudSendItem[] {
  const items: CloudSendItem[] = [];
  const add = (kind: MoveKind, id: string, label: string, parts: Record<string, string>, bot?: string) =>
    items.push({ key: itemKey.moved(kind, id), kind, label: label.slice(0, 200), id, ...(bot ? { bot } : {}), parts });
  if (only) {
    const uses = new Set(only.assignedSkills ?? []);
    for (const { entry } of librarySkills()) if (uses.has(entry.name)) add("library-skill", entry.name, entry.name, { text: entry.sha256.slice(0, 24) || EMPTY, state: entry.reviewState });
    return items;
  }
  for (const skill of importedSkills(deps)) add("imported-skill", skill.name, skill.name, { files: importedSkillHash(skill) });
  for (const { entry } of librarySkills()) add("library-skill", entry.name, entry.name, { text: entry.sha256.slice(0, 24) || EMPTY, state: entry.reviewState });
  return items;
}

type Kind = MoveKind | "bot";
function parseKey(key: string | null): { kind: Kind; id: string } | null {
  const match = /^(bot|imported-skill|library-skill):([\w-]{1,128})$/u.exec(key ?? "");
  if (!match) return null;
  const kind = match[1] as Kind;
  return (kind === "imported-skill" || kind === "library-skill") && !isSkillName(match[2]!) ? null : { kind, id: match[2]! };
}

/** One item's whole record on this server, for a move to carry; null when it is not here. */
export function kindRecord(deps: MoveKindsDeps, kind: Kind, id: string): { record: unknown; changedAt?: number } | null {
  if (kind === "bot") { const bot = deps.store.bot(id); return bot ? { record: pick(bot, MOVE_BOT_FIELDS) } : null; }
  if (kind === "imported-skill") { const skill = importedSkills(deps).find((candidate) => candidate.name === id); return skill ? { record: skill } : null; }
  const skill = librarySkills().find((candidate) => candidate.entry.name === id);
  return skill ? { record: skill } : null;
}

/** `final`: sending it again cannot help until the person changes something, so the move goes on without it. */
class Refused extends Error {
  status: number;
  final: boolean;
  constructor(status: number, message: string, final = false) { super(message); this.status = status; this.final = final; }
}
const refuse = (status: number, message: string, final = false): never => { throw new Refused(status, message, final); };

const playbookSchema = z.object({ key: z.string().max(200), name: z.string().max(200), summary: z.string().max(4000), triggers: z.array(z.string().max(400)).max(50),
  instructions: z.string().max(50_000) }).passthrough();
const botFieldsSchema = z.object({
  hidden: z.boolean().nullable().optional(),
  pinned: z.boolean().nullable().optional(),
  chiefOfStaff: z.boolean().nullable().optional(),
  managedSections: z.array(z.string().trim().max(60)).max(100).nullable().optional(),
  fallback: z.array(z.object({ instanceId: z.string().regex(/^[\w.-]{1,128}$/u), model: z.string().min(1).max(500) })).max(5).nullable().optional(),
  projects: z.array(z.object({ id: z.string().regex(/^[\w-]{1,128}$/u), name: z.string().min(1).max(80), emoji: z.string().max(16).optional() }).passthrough()).max(200).nullable().optional(),
  playbooks: z.array(playbookSchema).max(50).nullable().optional(),
  installedPackage: z.record(z.string(), z.unknown()).nullable().optional(),
  assignedSkills: z.array(z.string().max(64)).max(200).nullable().optional(),
  defaultBot: z.object({ person: z.string().max(320).optional() }).strict().nullable().optional(),
  sidebarHidden: z.boolean().nullable().optional(),
  welcomed: z.boolean().nullable().optional(),
}).strict();
const skillFileSchema = z.object({ path: z.string().max(400).refine(validRelative), content: z.string().max(512 * 1024), executable: z.boolean() });
const importedSkillSchema = z.object({ name: z.string().refine(isSkillName), skillMd: z.string().max(512 * 1024), files: z.array(skillFileSchema).max(200),
  entry: z.object({ description: z.string().max(4000), source: z.enum(["customAcp"]), root: z.string().max(4096), origin: z.string().max(4096),
    label: z.string().max(400), sha256: z.string().regex(/^[a-f0-9]{64}$/u), warnings: z.array(z.string().max(2000)).max(100),
    license: z.string().max(400).optional(), compatibility: z.string().max(400).optional() }) });
const librarySkillSchema = z.object({ text: z.string().max(512 * 1024), entry: z.object({ name: z.string().refine(isSkillName), description: z.string().max(4000),
  source: z.string().max(2000), reviewState: z.enum(["approved", "disabled"]), license: z.string().max(400).optional(), compatibility: z.string().max(400).optional(),
  tags: z.array(z.string().max(80)).max(40).optional(), warnings: z.array(z.string().max(2000)).max(100).optional() }).passthrough() });

/** My Cloud sets a bot's move-only fields as they are on this computer: absent ones it clears, its own projects it keeps
 * beside the ones that arrive, and an engine, team or library skill it lacks it leaves out. */
function applyBotFields(deps: MoveKindsDeps, id: string, raw: unknown, source: ArrivingSource = {}): void {
  const bot = deps.store.bot(id) ?? refuse(409, "This bot is not on My Cloud yet.");
  const parsed = botFieldsSchema.safeParse(raw);
  if (!parsed.success) refuse(400, "send the bot's fields as this computer holds them");
  const fields = parsed.data!;
  const patch: Partial<BotRecord> = {};
  const set = <K extends keyof BotRecord>(key: K, value: BotRecord[K] | undefined) => { if (Object.hasOwn(fields, key)) patch[key] = value as BotRecord[K]; };
  set("hidden", fields.hidden ?? undefined);
  set("pinned", fields.pinned ?? undefined);
  set("sidebarHidden", fields.sidebarHidden ?? undefined);
  set("welcomed", fields.welcomed ?? undefined);
  set("managedSections", fields.managedSections ? [...new Set(fields.managedSections.filter(Boolean))] : undefined);
  set("fallback", fields.fallback ? fields.fallback.filter((entry) => deps.instanceExists(entry.instanceId)) : undefined);
  if (fields.projects) {
    const arriving = new Set(fields.projects.map((project) => project.id));
    set("projects", [...fields.projects.map((project) => pick(project, ["id", "name", "emoji"]) as { id: string; name: string; emoji?: string }),
      ...(bot.projects ?? []).filter((project) => !arriving.has(project.id))]);
  }
  set("playbooks", (fields.playbooks ?? undefined) as InstalledPlaybook[] | undefined);
  set("installedPackage", (fields.installedPackage ?? undefined) as InstalledPackageMetadata | undefined);
  if (Object.hasOwn(fields, "assignedSkills")) {
    const library = readSkillLibraryIndex();
    patch.assignedSkills = fields.assignedSkills ? fields.assignedSkills.filter((name) => library[name]) : undefined;
  }
  if (Object.hasOwn(fields, "chiefOfStaff") && fields.chiefOfStaff !== true) patch.chiefOfStaff = fields.chiefOfStaff ?? undefined;
  if (fields.chiefOfStaff === true) delete patch.hidden;
  deps.store.patchBot(id, patch);
  // A MausBot arriving where the person's own MausBot stays (takeArrivingDefaultBot) doesn't take the crown from this
  // place's Chief, whichever bot that is, also when a later pass sends its Chief fields without its MausBot mark.
  const keepsCrown = (fields.defaultBot || source.defaultBot) && keptDefaultBot(deps.store, id)
    && deps.store.bots.some((other) => other.id !== id && other.chiefOfStaff);
  if (fields.chiefOfStaff === true && !keepsCrown) {
    deps.store.setChiefOfStaff(id);
    if (patch.managedSections) deps.store.patchBot(id, { managedSections: patch.managedSections });
  }
  if (fields.defaultBot) takeArrivingDefaultBot(deps.store, id, source.computer);
  retireUnusedStarter(deps.store, deps.dataDir);
}

async function adopt(deps: MoveKindsDeps, kind: Kind, id: string, raw: unknown, source: ArrivingSource = {}): Promise<void> {
  if (!record(raw) && kind !== "bot") refuse(400, "send the item's record");
  const same = (value: unknown) => record(value) && (value.id === undefined || value.id === id);
  if (kind === "bot") return applyBotFields(deps, id, raw, source);
  if (!same(raw) && kind !== "imported-skill" && kind !== "library-skill") refuse(400, "the record names another item");
  if (kind === "imported-skill") {
    const parsed = importedSkillSchema.safeParse(raw);
    if (!parsed.success || parsed.data.name !== id) refuse(400, "send the skill's files as this computer holds them");
    if (!storeImportedSkills([parsed.data!])[0]?.stored) refuse(500, "My Cloud could not keep this skill.");
    return;
  }
  const parsed = librarySkillSchema.safeParse(raw);
  if (!parsed.success || parsed.data.entry.name !== id) refuse(400, "send the library skill as this computer holds it");
  const { entry, text } = parsed.data!;
  const held = readSkillLibraryIndex()[id];
  const outcome = !held
    ? installLibrarySkill({ name: id, description: entry.description, instructions: text, source: entry.source, reviewState: entry.reviewState,
      ...(entry.license ? { license: entry.license } : {}), ...(entry.compatibility ? { compatibility: entry.compatibility } : {}), ...(entry.tags ? { tags: entry.tags } : {}),
      ...(entry.warnings ? { warnings: entry.warnings } : {}) })
    : held.sha256 === sha256(text) ? setLibrarySkillReviewState(id, entry.reviewState)
      : updateLibrarySkill({ name: id, instructions: text, expectSha256: held.sha256, source: entry.source });
  if ("error" in outcome) refuse(400, outcome.error);
  if ("stale" in outcome) refuse(409, "My Cloud's copy of this library skill changed while it was being replaced.");
  if (held && held.sha256 !== sha256(text) && held.reviewState !== entry.reviewState) {
    const state = setLibrarySkillReviewState(id, entry.reviewState);
    if ("error" in state) refuse(400, state.error);
  }
}

const putSchema = z.object({ v: z.literal(1), key: z.string().max(200), dataDir: z.string().min(1).max(4096), record: z.unknown(), runs: z.array(z.unknown()).max(2_000).optional(),
  computer: z.string().max(120).optional(), sourceDefault: z.boolean().optional() });

type ArrivingSource = { computer?: string; defaultBot?: boolean };

/** This computer's name as a person knows it, which a MausBot that moves away is named for when the place it goes keeps its own. */
function thisComputerName(): string {
  return (process.env.OMB_ENVIRONMENT_LABEL?.trim() || hostname()).replace(/\.local$/iu, "").slice(0, 120);
}

/** False when the path is not this route. */
export async function moveKindsRoute(deps: MoveKindsDeps, { req, res, path, method, url, auth, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/kind") return false;
  res.setHeader("cache-control", "no-store");
  try {
    if (method === "GET") {
      const key = parseKey(url.searchParams.get("key"));
      const found = key && kindRecord(deps, key.kind, key.id);
      if (!found) json(res, 404, { error: "not here" });
      else json(res, 200, { v: 1, dataDir: deps.dataDir, ...(key.kind === "bot" ? { computer: thisComputerName() } : {}), ...found });
      return true;
    }
    if (method === "PUT") {
      const owner = deps.owner(auth);
      if (!owner) { json(res, 403, { error: "Only My Cloud's owner can move things into it." }); return true; }
      const body = putSchema.safeParse(await readBody(req, KIND_BODY_MAX));
      const key = body.success ? parseKey(body.data.key) : null;
      if (!body.success || !key) { json(res, 400, { error: "send { v: 1, key, dataDir, record }" }); return true; }
      await adopt(deps, key.kind, key.id, body.data.record, { computer: body.data.computer, defaultBot: body.data.sourceDefault });
      json(res, 200, { v: 1, ok: true });
      return true;
    }
    json(res, 405, { error: "method not allowed" });
  } catch (error) {
    const status = error instanceof Refused ? error.status : Number.isInteger((error as { status?: unknown }).status) ? (error as { status: number }).status : 500;
    json(res, status, { error: (error as Error).message?.slice(0, 300) || "It could not be moved.", ...(error instanceof Refused && error.final ? { final: true } : {}) });
  }
  return true;
}
