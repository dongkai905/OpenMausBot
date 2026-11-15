// Whose connection a turn on a Team Cloud may use. The team's connections serve every turn; a `person` MCP server is
// offered to a turn only for the person it acts for (server/host/acting-person.ts), and only in that person's own
// private chat, where nobody else reads what it brings back. Work their own message started in a group chat or the bot's
// main chat reaches their own connections by being handed on (handOnFor): it opens in the receiving bot's chat with them,
// and the shared place gets only a line saying where the result is (acting-person.ts privateHandBack).
// Security: nothing else ever gets a member's connection: not another person's request or the work it hands on, not a
// turn someone else wrote into, not a chat anyone else reads, a routine or a webhook. The relay checks it again on every
// call. Off a team nothing changes.
import { join } from "node:path";

import { audienceMember, type Audience } from "../audience.ts";
import type { CloudTeam, TeamRole } from "../cloud-team.ts";
import type { AppConfig } from "../config.ts";
import type { McpServerSpec } from "../contracts.ts";
import { type McpOAuthManager, type McpRefreshOutcome, type McpSignInPhase, withMcpSignIn, withoutPendingSignIn } from "../mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type McpOAuthClientConfig } from "../mcp-registry.ts";
import { ConnectionScopes, PeopleConnections, SCOPES_FILE } from "../team-connections.ts";

type McpBot = { id: string; name: string; mcpServers?: string[] };

export interface TeamConnectionsHostDeps {
  team: CloudTeam | null;
  dataDir: string;
  cfg: () => AppConfig;
  /** The Admin's origin (OMB_CLOUD_ADMIN_URL): a member connects their own on their team's page there. */
  adminOrigin: string | null;
  audienceOf(threadId: string): Audience;
  /** The person this turn generation acts for (the latest one when none is named), or null: server/host/acting-person.ts. */
  requester(threadId: string, generation?: string): string | null;
  /** What a person is called in a bot's words: the name they chose, else their address. */
  personName?(person: string): string | undefined;
  /** The members the Admin paired here, by person key, with their address and role (server/team-people.ts). */
  roster?(): ReadonlyArray<{ person: string; email: string; role: TeamRole }>;
  mcpOAuth: McpOAuthManager;
  /** The bot's enabled MCP servers, as policy allows them, before any sign-in is attached. */
  botMcp(bot: McpBot): Record<string, McpServerSpec>;
  /** An admin's OAuth app as a member's sign-in uses it: its client secret read from the Vault when it is kept there. */
  oauthClient?(name: string, oauth: McpOAuthClientConfig): McpOAuthClientConfig;
  /** Whether whoever started a member's sign-in (a session, or a chat's Sign in card) is still there to finish it. */
  isOwnerLive(owner: string): boolean;
  onSettled?(name: string, phase: McpSignInPhase, owner: string): void;
  /** How each refresh of a member's own MCP sign-in ended. */
  onRefresh?(person: string, name: string, outcome: McpRefreshOutcome): void;
  /** A member signed in again or saved a key of their own. */
  onPersonChanged?(person: string, kind: "mcp", id: string): void;
}

const list = (names: readonly string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function createTeamConnectionsHost(deps: TeamConnectionsHostDeps) {
  const team = deps.team;
  const scopes = new ConnectionScopes(join(deps.dataDir, SCOPES_FILE));
  /** The sign-in app an admin set for a server (config.json), read when a member signs in: never copied anywhere. */
  const teamServer = (name: string) => {
    const raw = deps.cfg().mcpServers?.[name];
    const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
    return parsed?.ok ? parsed.server : null;
  };
  const people = new PeopleConnections({
    dataDir: deps.dataDir,
    clients: (name, url) => { const server = teamServer(name); return server && isRemoteMcpServer(server) && server.url === url ? (server.oauth && deps.oauthClient ? deps.oauthClient(name, server.oauth) : server.oauth) : undefined; },
    isOwnerLive: deps.isOwnerLive,
    ...(deps.onSettled ? { onSettled: deps.onSettled } : {}),
    ...(deps.onRefresh ? { onRefresh: deps.onRefresh } : {}),
    ...(deps.onPersonChanged ? { onChanged: deps.onPersonChanged } : {}),
  });
  const link = () => (team && deps.adminOrigin ? `${deps.adminOrigin}/cloud/team/${encodeURIComponent(team.id)}` : null);
  const personMcp = () => (team ? scopes.person() : []);
  const without = <T,>(servers: Record<string, T>, names: readonly string[]) =>
    Object.fromEntries(Object.entries(servers).filter(([name]) => !names.includes(name)));

  /** The member a turn acts for, in a chat nobody else reads: theirs. */
  const actingFor = (threadId: string, generation?: string): string | null => (team ? deps.requester(threadId, generation) : null);
  /** The member a turn may use the own connections of: the one it acts for, in their own private chat only. */
  const turnPerson = (threadId: string, generation?: string): string | null => {
    const member = team ? audienceMember(deps.audienceOf(threadId)) : null;
    return member && actingFor(threadId, generation) === member ? member : null;
  };
  const rosterEntry = (person: string) => deps.roster?.().find((entry) => entry.person === person);
  const nameOf = (person: string): string => deps.personName?.(person) || rosterEntry(person)?.email || people.emailOf(person) || "this person";
  const roleOf = (person: string): TeamRole | null => rosterEntry(person)?.role ?? null;
  const isAdmin = (person: string): boolean => roleOf(person) === "owner" || roleOf(person) === "admin";
  /** How work a person started where others read reaches their own connections: handed on into a chat that is theirs alone. */
  const handOnHow = (who: string) => `To use it, hand that part on: to yourself with start_thread, or to a teammate with coordinate_bots. It runs in that bot's chat with ${who}, with ${who}'s own connections, and only a line saying where the result comes back here: say only that here.`;

  /** Whether a person connected anything of their own here: a key or a sign-in for a server. */
  const hasOwn = (person: string): boolean => {
    return personMcp().some((name) => {
      const server = teamServer(name);
      return Boolean(server && isRemoteMcpServer(server) && (people.key(person, name, server.url) || people.oauth(person).authState(name, server.url) === "signed-in"));
    });
  };

  const personSpec = async (person: string, name: string, spec: Extract<McpServerSpec, { url: string }>): Promise<McpServerSpec | null> => {
    const manager = people.oauth(person);
    if (manager.authState(name, spec.url) === "signed-in") {
      const token = await manager.accessToken(name, spec.url);
      if (token) return { ...spec, headers: { Authorization: `Bearer ${token}` } };
    }
    const key = people.key(person, name, spec.url);
    // The team's own headers never ride along: only this person's.
    return key ? { ...spec, headers: { [key.header]: key.value } } : null;
  };

  return {
    team,
    scopes,
    people,
    personMcp,
    link,
    turnPerson,
    nameOf,
    /** Off a Team Cloud, always; on one, the person this turn acts for is its owner or an admin, as Settings requires. */
    actsForAdmin(threadId: string, generation?: string): boolean {
      if (!team) return true;
      const person = actingFor(threadId, generation);
      return person !== null && isAdmin(person);
    },
    /** The person whose private chat work this turn hands on opens in, so it can use their own connections there: the
     * person the turn acts for, when they connected anything of their own. Null: it opens where it always did. */
    handOnFor(threadId: string, generation: string): string | null {
      const person = actingFor(threadId, generation);
      return person && hasOwn(person) ? person : null;
    },

    /** A turn's MCP servers: the team's (never a `person` server's team credential), plus, in a turn that acts for a
     * member, the `person` servers they connected, with their own key or sign-in. What isn't mounted, prompt() says. */
    async turnMcp(bot: McpBot, threadId: string, generation: string): Promise<Record<string, McpServerSpec>> {
      const all = deps.botMcp(bot), names = personMcp();
      const out = await withMcpSignIn(without(all, names), deps.mcpOAuth);
      const person = names.length ? turnPerson(threadId, generation) : null;
      if (!person) return out;
      for (const name of names) {
        const spec = all[name];
        if (!spec || !("url" in spec)) continue;
        const own = await personSpec(person, name, spec);
        if (own) out[name] = own;
      }
      return out;
    },

    /** The bot's servers with no conversation in view (the setup preview, approval keys, chat apps): the team's only. */
    engineMcp(bot: McpBot): Record<string, McpServerSpec> {
      return withoutPendingSignIn(without(deps.botMcp(bot), personMcp()), deps.mcpOAuth);
    },

    /** What the bot is told: in a turn that acts for a member, what is theirs and how to connect what isn't; in one that
     * acts for nobody, why none of these can be used and what the person can do. Empty off a team or with no `person`
     * connection. */
    prompt(threadId: string, generation: string | undefined, mounted: { custom?: Record<string, unknown> }): string {
      const servers = personMcp();
      if (!team || !servers.length) return "";
      const person = turnPerson(threadId, generation);
      const acting = person ? null : actingFor(threadId, generation);
      if (acting) {
        const who = nameOf(acting);
        const these = `${list(servers)} ${servers.length === 1 ? "is" : "are"} each person's own in ${team.name}`;
        return hasOwn(acting)
          ? ` ${these}, used only in a chat that is theirs alone. Others read this chat, so ${who}'s own aren't here: what they bring back would be read here. If the task needs one, don't try it another way (the browser or another tool). ${handOnHow(who)}`
          : ` ${these}, and ${who} hasn't connected any yet. If the task needs one, don't try it another way (the browser or another tool): reply with one plain line and nothing more about it: "Connect your <name> here: ${link() ?? "your team's page in MausBot Cloud"}".`;
      }
      if (!person) {
        const where = link();
        return ` ${list(servers)} ${servers.length === 1 ? "is" : "are"} each person's own in ${team.name}: ${servers.length === 1 ? "it works" : "they work"} for the person whose own message started the work, and this work doesn't act for one person (a routine, an outside app or a bot started it, or more than one person wrote in it). `
          + `If the task needs one, don't try it another way (the browser or another tool): reply with one plain line and nothing more about it: "<name> is each person's own, so I can't use it here. Ask me yourself and I'll use yours${where ? `, or an admin can connect <name> for the whole team: ${where}` : ""}."`;
      }
      const who = nameOf(person);
      const whose = `${who}'s`;
      const ownServers = servers.filter((name) => Object.hasOwn(mounted.custom ?? {}, name));
      const missing = servers.filter((name) => !ownServers.includes(name));
      const where = link();
      const only = `They are used only for ${who}'s request: if someone else asks for something from them, say they are ${whose}.`;
      return (ownServers.length ? ` The MCP ${ownServers.length === 1 ? "server" : "servers"} ${list(ownServers)} act${ownServers.length === 1 ? "s" : ""} as ${whose} own account.` : "")
        + (ownServers.length ? ` ${only}` : "")
        + (missing.length ? ` Each person connects these for themselves, and ${who} hasn't connected ${missing.length === 1 ? "it" : "them"} yet, or their sign-in ended: ${list(missing)}. If the task needs one, don't try it another way (the browser or another tool): reply with one plain line and nothing more about it: "Connect your <name> here: ${where ?? "your team's page in MausBot Cloud"}".` : "");
    },

    /** Whose own account a tool call uses, for its step ("using Ada's notes"): a `person` MCP server, in a turn that acts
     * for them. Empty for anything else. */
    toolWhose(threadId: string, generation: string | undefined, tool: string): { whose?: { person: string; app: string } } {
      const servers = personMcp();
      if (!team || !generation || !servers.length) return {};
      const named = /^mcp__(.+?)__(.+)$/.exec(tool);
      const server = named?.[1];
      if (!server || !servers.includes(server)) return {};
      const spec = teamServer(server);
      const url = spec && isRemoteMcpServer(spec) ? spec.url : null;
      if (!url) return {};
      const person = turnPerson(threadId, generation);
      if (!person) return {};
      const theirs = Boolean(people.key(person, server, url) || people.oauth(person).authState(server, url) === "signed-in");
      return theirs ? { whose: { person: nameOf(person), app: server } } : {};
    },

    /** An MCP server was removed: every person's key and sign-in for it go, and it is the team's again if re-added. */
    forgetServer(name: string): void {
      people.forgetServer(name);
      if (scopes.scope(name) === "person") scopes.set(name, "team");
    },

    /** The public MCP sign-in callback: the team's flows first, then each member's own. */
    async mcpCallback(host: string | undefined, search: string): Promise<{ status: number; text: string }> {
      const shared = await deps.mcpOAuth.publicCallback(host, search);
      if (shared.status !== 400) return shared;
      for (const manager of people.liveManagers()) {
        const answer = await manager.publicCallback(host, search);
        if (answer.status !== 400) return answer;
      }
      return shared;
    },

    /** A person who left the team (host/team-member-left.ts): every connection, key and sign-in of theirs goes. */
    forgetPerson: (person: string) => people.forgetPerson(person),
    /** For the Admin's signed read: what is `person`, and who has connected each (addresses, never a secret). */
    async adminExtras(): Promise<{ scopes: { apps: string[]; mcp: string[] }; people: { apps: Record<string, string[]>; mcp: Record<string, string[]> } } | Record<string, never>> {
      if (!team) return {};
      const servers = personMcp();
      const byServer: Record<string, string[]> = {};
      for (const name of servers) {
        const server = teamServer(name);
        const url = server && isRemoteMcpServer(server) ? server.url : null;
        const who = url ? [...people.keyPeople(name, url), ...people.signedInPeople(name, url)] : [];
        byServer[name] = [...new Set(who.map((entry) => entry.email).filter(Boolean))].sort();
      }
      return { scopes: { apps: [], mcp: servers }, people: { apps: {}, mcp: byServer } };
    },
  };
}

export type TeamConnectionsHost = ReturnType<typeof createTeamConnectionsHost>;
