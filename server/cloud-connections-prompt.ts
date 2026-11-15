// What a bot on My Cloud is told about the connections it reaches for that need the person, or another computer, read
// from this Cloud's own state on each turn: an MCP server that needs a sign-in here, an MCP server that runs on the
// person's computer, and what stayed on the computer the bots moved here from. So the bot says so in plain words, with
// the link that connects it.
import type { ConnectorToolGrant } from "../shared/wire.ts";
import type { McpAuthState } from "./mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";
import { stayedConnectors, stayedWhyText } from "./cloud-connections-stayed.ts";

export interface ConnectionPromptSources {
  mcpServers(): Record<string, unknown> | undefined;
  mcpAuth(name: string, url: string): McpAuthState;
  /** The computer the bots moved here from, once a move is done. */
  movedFrom?(): string | null;
  /** The programs this Cloud has. */
  programs?(): readonly string[];
}

export type ConnectionPromptBot = { mcpServers?: string[]; apps?: boolean; connectorTools?: Record<string, ConnectorToolGrant> };

/** `origin`: My Cloud's public address, where `/?connect=<id>` opens the page that connects it. `lent`, in a turn: by
 * name, why each of the bot's servers that runs on the person's computer can't be reached now; one left out reaches the
 * turn through that computer. */
export function createConnectionPrompt(sources: ConnectionPromptSources, origin: string): (bot: ConnectionPromptBot, lent?: ReadonlyMap<string, string>) => string {
  const link = (id: string) => `${origin}/?connect=${encodeURIComponent(id)}`;

  return (bot, lent) => {
    const toConnect: string[] = [];
    const elsewhere = new Map<string, string[]>();
    for (const stayed of stayedConnectors(sources.mcpServers(), sources.programs?.() ?? [])) {
      if (bot.mcpServers !== undefined && !bot.mcpServers.includes(stayed.name)) continue;
      elsewhere.set(stayed.computer, [...elsewhere.get(stayed.computer) ?? [], `${stayed.name} (${stayedWhyText(stayed)})`]);
    }
    for (const [name, raw] of Object.entries(sources.mcpServers() ?? {})) {
      if (bot.mcpServers !== undefined && !bot.mcpServers.includes(name)) continue;
      const parsed = parseStoredMcpServer(name, raw);
      if (!parsed.ok || !parsed.server.enabled) continue;
      const server = parsed.server;
      if (!server.runsOn && isRemoteMcpServer(server)) {
        const auth = sources.mcpAuth(name, server.url);
        if (auth === "needs-sign-in" || (auth === "none" && server.oauth)) toConnect.push(`${name} (sign in here: ${link(`mcp:${name}`)})`);
      }
    }
    const from = sources.movedFrom?.() ?? null;
    return [
      from ? ` You moved to My Cloud from the person's computer ${from}, with everything in OpenMausBot. What lives outside OpenMausBot stayed on ${from}: its other folders and files, passkeys, the person's own browser sessions and apps, Local VM disks and model servers on its home network. When a task needs one, use ${from} if it is lent to My Cloud and online; otherwise say in plain words that it stayed there.` : "",
      toConnect.length ? ` Not connected on My Cloud yet: ${toConnect.join("; ")}. When a task needs one, say in plain words that it needs the person once on My Cloud and give its link; do not try another way.` : "",
      ...(lent
        ? (lent.size ? [` Runs on the person's own computer and can't be reached now: ${[...lent.values()].join(" ")} If a task needs one, tell the person that in plain words, and do not write your own replacement.`] : [])
        : [...elsewhere].map(([computer, names]) => ` Runs only on the person's computer ${computer}, not on My Cloud: ${names.join("; ")}. It worked there before the bots moved here. If a task needs one, tell the person in plain words that it stayed on ${computer} and why, not that it was never set up, and do not write your own replacement.`)),
    ].join("");
  };
}
