// Company-wide or per-person connections on a Team Cloud. Every MCP server has a scope: `team`, the default, is one
// connection an admin makes and every turn uses; `person` is one connection per member, used only in that member's own
// turns in their private chat.
//   - team-connection-scopes.json: which servers are `person` (no secret; backups carry it);
//   - people-connections/: each member's own MCP keys and their own MCP sign-ins.
// Security: 0600 files in a 0700 folder that no backup carries and no bot box binds; a member's key and sign-in are pinned
// to the server's address, so an admin re-pointing a server never sends them on.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { McpOAuthManager, type McpRefreshOutcome, type McpSignInPhase } from "./mcp-oauth.ts";
import type { McpOAuthClientConfig } from "./mcp-registry.ts";

export type ConnectionScope = "team" | "person";
/** What a member connects for themselves: an MCP server. */
export type ConnectionKind = "mcp";

export const SCOPES_FILE = "team-connection-scopes.json";
export const PEOPLE_CONNECTIONS_DIR = "people-connections";
/** An MCP server's name as mcp-registry.ts allows it. */
export const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PERSON = /^p_[\w-]{22}$/;

const scopesSchema = z.object({
  v: z.literal(1),
  mcp: z.record(z.string(), z.literal("person")).default({}),
});
type ScopesFile = z.infer<typeof scopesSchema>;

/** Which MCP servers each person connects for themselves; everything else is the team's. */
export class ConnectionScopes {
  private data: ScopesFile;
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    let parsed: ScopesFile | null = null;
    try { parsed = scopesSchema.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { parsed = null; }
    this.data = parsed ?? { v: 1, mcp: {} };
  }
  /** The `person` servers (names), sorted. */
  person(): string[] {
    return Object.keys(this.data.mcp).sort();
  }
  scope(id: string): ConnectionScope {
    return Object.hasOwn(this.data.mcp, id) ? "person" : "team";
  }
  set(id: string, scope: ConnectionScope): void {
    const next: ScopesFile = { v: 1, mcp: { ...this.data.mcp } };
    if (scope === "person") next.mcp[id] = "person"; else delete next.mcp[id];
    writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.data = next;
  }
}

/** A name as people read it: "linear" → "Linear". */
export const appLabel = (name: string): string =>
  name.split(/[-_]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || name;

const keysSchema = z.object({
  v: z.literal(1),
  people: z.record(z.string(), z.object({
    email: z.string(),
    servers: z.record(z.string(), z.object({ url: z.string(), header: z.string(), value: z.string() })).default({}),
  })).default({}),
});
type KeysFile = z.infer<typeof keysSchema>;
export interface PersonKey { url: string; header: string; value: string }

export interface PeopleConnectionsOptions {
  dataDir: string;
  /** The team server's sign-in app for an MCP server, when an admin set one (config.json `oauth`). */
  clients: (name: string, url: string) => McpOAuthClientConfig | undefined;
  isOwnerLive: (owner: string) => boolean;
  /** Each member's sign-in ending, as McpOAuthManager's own option hears it. */
  onSettled?: (name: string, phase: McpSignInPhase, owner: string) => void;
  /** How each refresh of a member's own sign-in ended. */
  onRefresh?: (person: string, name: string, outcome: McpRefreshOutcome) => void;
  /** A member signed in again or saved a key: what was known about their old one is stale. */
  onChanged?: (person: string, kind: ConnectionKind, id: string) => void;
}

/** Each member's own connections: never read by a route that answers with them, never copied into a turn but theirs. */
export class PeopleConnections {
  readonly dir: string;
  private readonly managers = new Map<string, McpOAuthManager>();
  private readonly options: PeopleConnectionsOptions;
  constructor(options: PeopleConnectionsOptions) {
    this.options = options;
    this.dir = join(options.dataDir, PEOPLE_CONNECTIONS_DIR);
  }

  private ensureDir(): void {
    mkdirSync(join(this.dir, "mcp-oauth"), { recursive: true, mode: 0o700 });
    try { chmodSync(this.dir, 0o700); } catch {}
  }
  private read<T>(name: string, schema: z.ZodType<T>, empty: T): T {
    try { return schema.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8"))); } catch { return empty; }
  }
  private write(name: string, value: unknown): void {
    this.ensureDir();
    writeFileAtomic(join(this.dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }
  private keys(): KeysFile {
    return this.read<KeysFile>("mcp-keys.json", keysSchema, { v: 1, people: {} });
  }

  key(person: string, name: string, url: string): PersonKey | null {
    const held = this.keys().people[person]?.servers[name];
    return held && held.url === url ? held : null;
  }
  putKey(person: string, email: string, name: string, key: PersonKey): void {
    if (!PERSON.test(person)) throw new Error("invalid person");
    const file = this.keys();
    const own = file.people[person] ?? { email, servers: {} };
    file.people[person] = { email, servers: { ...own.servers, [name]: key } };
    this.write("mcp-keys.json", file);
    this.remember(person, email);
    this.options.onChanged?.(person, "mcp", name);
  }
  deleteKey(person: string, name: string): void {
    const file = this.keys();
    if (!file.people[person]?.servers[name]) return;
    delete file.people[person]!.servers[name];
    this.write("mcp-keys.json", file);
  }
  /** Who added their own key to a server at this address. */
  keyPeople(name: string, url: string): Array<{ person: string; email: string }> {
    return Object.entries(this.keys().people).flatMap(([person, record]) => record.servers[name]?.url === url ? [{ person, email: record.email }] : []);
  }

  /** The member's own MCP sign-ins: a manager of their own, so flows and tokens never meet another person's. */
  oauth(person: string): McpOAuthManager {
    if (!PERSON.test(person)) throw new Error("invalid person");
    let manager = this.managers.get(person);
    if (!manager) {
      this.ensureDir();
      manager = new McpOAuthManager({
        file: join(this.dir, "mcp-oauth", `${person}.json`), clients: this.options.clients, isOwnerLive: this.options.isOwnerLive,
        onSettled: (name: string, phase: McpSignInPhase, owner: string) => {
          if (phase === "succeeded") this.options.onChanged?.(person, "mcp", name);
          this.options.onSettled?.(name, phase, owner);
        },
        ...(this.options.onRefresh ? { onRefresh: (name: string, outcome: McpRefreshOutcome) => this.options.onRefresh?.(person, name, outcome) } : {}),
      });
      this.managers.set(person, manager);
    }
    return manager;
  }
  /** The member's own sign-in and key for a personal server, to test it as them. */
  connection(person: string, name: string, url: string): { oauth: McpOAuthManager; key?: PersonKey } {
    const key = this.key(person, name, url);
    return { oauth: this.oauth(person), ...(key ? { key } : {}) };
  }
  /** Managers with a flow that may be waiting for its callback (made in this process). */
  liveManagers(): McpOAuthManager[] {
    return [...this.managers.values()];
  }
  /** Everyone who signed in to a server at this address. */
  signedInPeople(name: string, url: string): Array<{ person: string; email: string }> {
    const folder = join(this.dir, "mcp-oauth");
    if (!existsSync(folder)) return [];
    return readdirSync(folder).flatMap((file) => {
      const person = file.replace(/\.json$/, "");
      if (!PERSON.test(person) || !file.endsWith(".json")) return [];
      return this.oauth(person).authState(name, url) === "signed-in" ? [{ person, email: this.emailOf(person) ?? "" }] : [];
    });
  }
  /** The address a person used here (who connected is shown by address; it is not a secret). */
  emailOf(person: string): string | null {
    return this.read("people.json", z.record(z.string(), z.string()), {})[person] ?? null;
  }
  remember(person: string, email: string): void {
    if (!PERSON.test(person) || !email) return;
    const file = this.read("people.json", z.record(z.string(), z.string()), {});
    if (file[person] === email) return;
    this.write("people.json", { ...file, [person]: email });
  }
  /** An MCP server was removed: every person's key and sign-in for it go too. */
  forgetServer(name: string): void {
    const file = this.keys();
    let changed = false;
    for (const record of Object.values(file.people)) if (record.servers[name]) { delete record.servers[name]; changed = true; }
    if (changed) this.write("mcp-keys.json", file);
    const folder = join(this.dir, "mcp-oauth");
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder)) {
      const person = entry.replace(/\.json$/, "");
      if (PERSON.test(person)) this.oauth(person).forget(name);
    }
  }
  /** Everything a person connected here. */
  forgetPerson(person: string): void {
    const keys = this.keys();
    if (keys.people[person]) { delete keys.people[person]; this.write("mcp-keys.json", keys); }
    this.managers.get(person)?.dispose();
    this.managers.delete(person);
    rmSync(join(this.dir, "mcp-oauth", `${person}.json`), { force: true });
  }
}

/** A member's key as the header the server expects: the header an admin's key used, else Authorization, as a bearer. */
export function personKeyHeader(teamHeaders: readonly string[], value: string): { header: string; value: string } {
  const header = teamHeaders[0] ?? "Authorization";
  const trimmed = value.trim();
  return { header, value: header.toLowerCase() === "authorization" && !/^\w+\s/.test(trimmed) ? `Bearer ${trimmed}` : trimmed };
}
