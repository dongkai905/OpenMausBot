// GET /api/cloud-send/manifest: everything of the person's this server holds that a move carries, by id with a
// fingerprint per kind, on this computer and on their Cloud alike, so the desktop can check that a move carried it all.
// Read only, never a secret: credentials are named here and checked by fingerprint (cloud-send-verify.ts).
import type { ChatStore } from "./cloud-chat-merge.ts";
import { listBotFiles, type BotFile } from "./cloud-send-files.ts";
import { chatHeads, conversationSettings } from "./cloud-send-chats.ts";
import { activeLeaves, attachmentNamesOf } from "./cloud-send-rows.ts";
import { roomGoes } from "./cloud-send-scope.ts";
import type { CloudSendSummary } from "./cloud-send.ts";
import type { BotRecord } from "./store.ts";

export interface ManifestConversation { threadId: string; bot?: string; room?: string; rows: number; newest: string; leaf: string; settings: Record<string, unknown> }

export interface CloudSendManifest {
  v: 1;
  appVersion: string;
  /** Bots, skills, logins, 1Password, settings and what only a move carries, as a move compares them (cloud-send.ts). */
  items: CloudSendSummary["items"];
  /** Each memory file of the bots a move carries, with its pieces' identities. */
  memory: Array<{ bot: string; path: string; hash: string; lines: string[] }>;
  /** Each bot's latest memory journal rows, by id. */
  journal: Array<{ bot: string; ids: string[] }>;
  /** What bots learned about the person, and what the person removed of it, by identity. */
  learned: string[];
  forgotten: string[];
  teams: Array<{ section: string; context: string[] | null; memory: string[] }>;
  rooms: Array<{ id: string; name: string; members: string[]; threads: string[] }>;
  /** "mcp:<name>", "key:<provider>", "composio" or "email". */
  connections: string[];
  conversations: ManifestConversation[];
  /** The stored attachments the conversations' rows name; left out when not asked for. */
  attachments?: string[];
  /** Left out when not asked for: GET /api/cloud-send/files?bot= lists them a bot at a time. */
  files?: BotFile[];
  /** Each automation and whether it is on: the switch turns on there what was on here. */
  automations: Array<{ key: string; on: boolean }>;
  /** The routines' finished runs, by id with their routine's. */
  runs: Array<{ id: string; routine: string }>;
}

export interface ManifestSources {
  summary(): CloudSendSummary;
  store: ChatStore & { bots: BotRecord[] };
  dataDir: string;
  connections(): Promise<ReadonlyArray<{ id: string }>>;
  /** Each conversation's stored rows and its newest. */
  heads(): Map<string, { lastId: string; rows: number }>;
  /** A move of this one bot into a team: what it carries only (its summary is already kept to it). */
  bot?: string;
  /** False: the attachments, or the bot files, are not listed (the desktop's check never reads My Cloud's attachments). */
  attachments?: boolean;
  files?: boolean;
  /** A move of only these bots: their conversations, and the rooms that go with all their bots. */
  scope?: ReadonlySet<string>;
}

export async function cloudSendManifest(sources: ManifestSources): Promise<CloudSendManifest> {
  const summary = sources.summary();
  const { store } = sources;
  const sent = [...new Set(summary.items.filter((item) => item.kind === "bot" && item.id).map((item) => item.id!))];
  const only = sources.bot;
  const chosen = sources.scope;
  const rooms = only === undefined ? store.groups.filter((room) => !room.dm && (!chosen || roomGoes(room, chosen, (id) => store.bot(id)))) : [];
  const counts = sources.heads();
  const leaves = activeLeaves();
  const conversations: ManifestConversation[] = chatHeads(only !== undefined ? store.bots.filter((bot) => bot.id === only) : chosen ? store.bots.filter((bot) => chosen.has(bot.id)) : store.bots, rooms).map((head) => ({
    threadId: head.threadId, ...(head.bot ? { bot: head.bot } : { room: head.room }), rows: counts.get(head.threadId)?.rows ?? 0, newest: head.lastId, leaf: leaves.get(head.threadId) ?? head.lastId,
    settings: conversationSettings(store, head),
  }));
  const attachments = sources.attachments === false ? {} : { attachments: [...attachmentNamesOf(new Set(conversations.map((head) => head.threadId)), sources.dataDir)].sort() };
  const files = sources.files === false ? {} : { files: await listBotFiles(sources.dataDir, sent) };
  if (only !== undefined) {
    return { v: 1, appVersion: summary.appVersion, items: summary.items, memory: [], journal: [], learned: [], forgotten: [], teams: [], rooms: [], connections: [],
      conversations, ...attachments, ...files, automations: [], runs: [] };
  }
  return {
    v: 1,
    appVersion: summary.appVersion,
    items: summary.items,
    memory: [],
    journal: [],
    learned: [],
    forgotten: [],
    teams: [],
    rooms: rooms.map((room) => ({ id: room.id, name: room.name, members: [...room.memberIds].sort(),
      threads: room.tasks?.length ? room.tasks.map((task) => task.threadId) : [room.threadId] })),
    connections: (await sources.connections()).map((item) => item.id).sort(),
    conversations,
    ...attachments,
    ...files,
    automations: [],
    runs: [],
  };
}
