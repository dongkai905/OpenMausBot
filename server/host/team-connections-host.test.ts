import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Audience } from "../audience.ts";
import type { AppConfig } from "../config.ts";
import type { McpServerSpec } from "../contracts.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { personKey } from "../person-key.ts";
import { excludedWorkspaceAuthPath } from "../workspace-backup-policy.ts";
import { createTeamConnectionsHost } from "./team-connections-host.ts";

const ADA = personKey({ id: "", email: "ada@acme.test" });
const BEN = personKey({ id: "", email: "ben@acme.test" });
const CLEO = personKey({ id: "", email: "cleo@acme.test" });
const OLIVE = personKey({ id: "", email: "olive@acme.test" });

/** Ada's private chat, Cleo's, Olive's, a group chat, the bot's main chat and a thread a bot opened for work handed on. Who each
 * turn acts for is acting-person.ts's answer (the `requester`); "" is a turn that acts for nobody, as a routine's. */
const AUDIENCES: Record<string, Audience> = {
  "ada-chat": `member:${ADA}`, "cleo-chat": `member:${CLEO}`, "olive-chat": `member:${OLIVE}`, "room-chat": "room:launch", "main-chat": "team", "work-chat": "team",
  // Work her own request handed on, opened in the receiving bot's chat with her (handOnFor); Cleo's likewise.
  "ada-work": `member:${ADA}`, "cleo-work": `member:${CLEO}`,
};

/** The members the Admin paired: Olive owns the team, Ben is an admin, Ada and Cleo are Users. */
const ROSTER = [
  { person: OLIVE, email: "olive@acme.test", role: "owner" as const }, { person: BEN, email: "ben@acme.test", role: "admin" as const },
  { person: ADA, email: "ada@acme.test", role: "member" as const }, { person: CLEO, email: "cleo@acme.test", role: "member" as const },
];

function setup(options: { team?: boolean; requester?: Record<string, string>; servers?: Record<string, unknown>; roster?: typeof ROSTER } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-team-connections-"));
  const requester = { "ada-chat": ADA, "cleo-chat": CLEO, "room-chat": ADA, "main-chat": ADA, "work-chat": ADA, "ada-work": ADA, "cleo-work": CLEO, ...options.requester };
  const cfg = { mcpServers: options.servers ?? {
    mail: { type: "http", url: "https://mail.example/mcp", headers: { Authorization: "Bearer team-mail-key" }, enabled: true },
    console: { type: "http", url: "https://console.example/mcp", headers: { Authorization: "Bearer team-console-key" }, enabled: true },
  } } as unknown as AppConfig;
  const host = createTeamConnectionsHost({
    team: options.team === false ? null : { id: "team-acme-1", name: "Acme" },
    dataDir, cfg: () => cfg, adminOrigin: "https://cloud.example.test",
    audienceOf: (threadId) => (options.team === false ? "team" : AUDIENCES[threadId] ?? "team"),
    requester: (threadId) => requester[threadId as keyof typeof requester] ?? null,
    mcpOAuth: new McpOAuthManager({ file: join(dataDir, "mcp-oauth.json") }),
    botMcp: () => Object.fromEntries(Object.entries(cfg.mcpServers ?? {}).map(([name, raw]) => {
      const server = raw as { url: string; headers: Record<string, string> };
      return [name, { type: "http", url: server.url, headers: server.headers } as McpServerSpec];
    })),
    isOwnerLive: () => true,
    ...(options.roster ? { roster: () => options.roster! } : {}),
  });
  return { host, dataDir };
}

/** Ada has her own key for the mail server, and the mail server is each person's own. */
function adaConnected(host: ReturnType<typeof setup>["host"], dataDir: string) {
  host.scopes.set("mail", "person");
  host.people.putKey(ADA, "ada@acme.test", "mail", { url: "https://mail.example/mcp", header: "Authorization", value: "Bearer ada-own-mail-key" });
  return join(dataDir, "people-connections");
}

describe("whose connection a turn may use", () => {
  it("defaults every server to the team's", () => {
    const { host } = setup();
    expect(host.scopes.scope("mail")).toBe("team");
    expect(host.personMcp()).toEqual([]);
  });

  it("is the person the turn acts for, only in a chat that is theirs alone, where nobody else reads what their connections bring back", () => {
    const { host } = setup({ requester: { "room-chat": ADA, "main-chat": BEN, "work-chat": CLEO } });
    expect(host.turnPerson("ada-chat")).toBe(ADA);
    expect(host.turnPerson("ada-work"), "work her request handed on, in the receiving bot's chat with her").toBe(ADA);
    expect(host.turnPerson("cleo-chat")).toBe(CLEO);
    expect(host.turnPerson("room-chat"), "her own line in a group chat: others read it").toBeNull();
    expect(host.turnPerson("main-chat"), "his own line in the bot's main chat: others read it").toBeNull();
    expect(host.turnPerson("work-chat"), "work handed on into a thread others read").toBeNull();
    const admin = setup({ requester: { "ada-chat": BEN, "ada-work": BEN } }).host;
    for (const thread of ["ada-chat", "ada-work"]) expect(admin.turnPerson(thread), `Ben's request never acts for anyone in Ada's chat (${thread})`).toBeNull();
    const routine = setup({ requester: { "ada-chat": "", "ada-work": "" } }).host;
    for (const thread of ["ada-chat", "ada-work"]) expect(routine.turnPerson(thread), `a routine or a webhook acts for nobody (${thread})`).toBeNull();
    expect(setup({ team: false }).host.turnPerson("ada-chat"), "off a team nothing is anyone's").toBeNull();
  });

  it("tests a personal server with the member's own sign-in, and their key only at the address it was saved for", () => {
    const { host } = setup();
    host.people.putKey(ADA, "ada@acme.test", "mail", { url: "https://mail.example/mcp", header: "Authorization", value: "Bearer ada-own-mail-key" });
    const own = host.people.connection(ADA, "mail", "https://mail.example/mcp");
    expect(own.oauth).toBe(host.people.oauth(ADA));
    expect(own.key).toMatchObject({ header: "Authorization", value: "Bearer ada-own-mail-key" });
    expect(host.people.connection(ADA, "mail", "https://elsewhere.example/mcp").key).toBeUndefined();
    expect(host.people.connection(CLEO, "mail", "https://mail.example/mcp")).toEqual({ oauth: host.people.oauth(CLEO) });
  });

  it("lets a turn change the team's MCP servers only when the person it acts for is an owner or admin", () => {
    const team = setup({ roster: ROSTER, requester: { "main-chat": OLIVE, "work-chat": BEN, "ada-chat": ADA, "room-chat": "" } }).host;
    expect(team.actsForAdmin("main-chat"), "the owner").toBe(true);
    expect(team.actsForAdmin("work-chat"), "an admin").toBe(true);
    expect(team.actsForAdmin("ada-chat"), "a User").toBe(false);
    expect(team.actsForAdmin("room-chat"), "a turn that acts for nobody").toBe(false);
    expect(setup({ team: false }).host.actsForAdmin("ada-chat"), "off a Team Cloud").toBe(true);
  });

  it("opens work a person's request hands on in the receiving bot's chat with them, when they connected anything of their own", () => {
    const { host, dataDir } = setup({ requester: { "main-chat": CLEO, "work-chat": "" } });
    expect(host.handOnFor("room-chat", "g"), "nothing of hers connected: the work opens where it always did").toBeNull();
    adaConnected(host, dataDir);
    for (const thread of ["room-chat", "ada-chat"]) expect(host.handOnFor(thread, "g"), thread).toBe(ADA);
    expect(host.handOnFor("main-chat", "g"), "Cleo connected nothing of hers").toBeNull();
    expect(host.handOnFor("work-chat", "g"), "work nobody's request started").toBeNull();
    expect(setup({ team: false }).host.handOnFor("room-chat", "g")).toBeNull();
  });
});

describe("MCP servers each person connects", () => {
  it("gives a turn that acts for her her key, never the team's, and no other turn either", async () => {
    const { host, dataDir } = setup({ requester: { "main-chat": "" } });
    adaConnected(host, dataDir);
    const own = await host.turnMcp(BOT, "ada-chat", "g");
    expect(own.mail).toEqual({ type: "http", url: "https://mail.example/mcp", headers: { Authorization: "Bearer ada-own-mail-key" } });
    expect(own.console, "the team's server is the team's, with its key").toEqual({ type: "http", url: "https://console.example/mcp", headers: { Authorization: "Bearer team-console-key" } });
    expect((await host.turnMcp(BOT, "ada-work", "g")).mail, "work her request handed on, in its chat with her").toEqual(own.mail);
    for (const thread of ["room-chat", "work-chat", "main-chat", "cleo-chat"]) {
      const elsewhere = await host.turnMcp(BOT, thread, "g");
      expect(elsewhere.mail, thread).toBeUndefined();
      expect(JSON.stringify(elsewhere), thread).not.toContain("ada-own-mail-key");
      expect(JSON.stringify(elsewhere), thread).not.toContain("team-mail-key");
    }
    const admin = setup({ requester: { "ada-chat": BEN } });
    adaConnected(admin.host, admin.dataDir);
    expect((await admin.host.turnMcp(BOT, "ada-chat", "g")).mail, "Ben writing in Ada's chat").toBeUndefined();
    expect(host.engineMcp(BOT).mail, "with no conversation in view: the team's only").toBeUndefined();
  });

  it("pins a member's key to the server's address: re-pointed, it is not sent", async () => {
    const { host, dataDir } = setup({ servers: { mail: { type: "http", url: "https://elsewhere.example/mcp", headers: {}, enabled: true } } });
    adaConnected(host, dataDir);
    expect((await host.turnMcp(BOT, "ada-chat", "g")).mail).toBeUndefined();
  });

  it("keeps members' keys in a folder of its own that no backup carries", () => {
    const { host, dataDir } = setup();
    adaConnected(host, dataDir);
    const folder = join(dataDir, "people-connections");
    if (process.platform !== "win32") {
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(join(folder, "mcp-keys.json")).mode & 0o777).toBe(0o600);
    }
    for (const file of ["people-connections/mcp-keys.json", `people-connections/mcp-oauth/${ADA}.json`]) expect(excludedWorkspaceAuthPath(file), file).toBe(true);
    expect(excludedWorkspaceAuthPath("team-connection-scopes.json"), "the scopes hold no secret").toBe(false);
    host.forgetServer("mail");
    expect(readFileSync(join(folder, "mcp-keys.json"), "utf8")).not.toContain("ada-own-mail-key");
    expect(host.scopes.scope("mail")).toBe("team");
  });
});

const BOT = { id: "bot-1", name: "Bot" };

describe("what the bot and the admins are told", () => {
  it("tells a turn that acts for her what is hers and how to connect the rest; one that acts for nobody, why and what to do", () => {
    const { host, dataDir } = setup({ requester: { "main-chat": "" } });
    adaConnected(host, dataDir);
    const own = host.prompt("ada-work", "g", { custom: { mail: {} } });
    expect(own).toContain("The MCP server mail acts as ada@acme.test's own account.");
    expect(own, "never for anyone else's request").toContain("They are used only for ada@acme.test's request: if someone else asks for something from them, say they are ada@acme.test's.");
    const shared = host.prompt("room-chat", "g", {});
    expect(shared, "her own room line: others read it").toContain("mail is each person's own in Acme, used only in a chat that is theirs alone. Others read this chat, so ada@acme.test's own aren't here");
    expect(shared).toContain("hand that part on: to yourself with start_thread, or to a teammate with coordinate_bots. It runs in that bot's chat with ada@acme.test");
    expect(shared).toContain("with ada@acme.test's own connections");
    const cleos = setup({ requester: { "room-chat": CLEO } }).host;
    cleos.scopes.set("mail", "person");
    expect(cleos.prompt("room-chat", "g", {}), "Cleo connected nothing yet").toMatch(/and this person hasn't connected any yet\. .*"Connect your <name> here: https:\/\/cloud\.example\.test\/cloud\/team\/team-acme-1"\./);
    const missing = host.prompt("ada-chat", "g", { custom: {} });
    expect(missing).toContain("Each person connects these for themselves, and ada@acme.test hasn't connected it yet, or their sign-in ended: mail.");
    expect(missing).toContain("\"Connect your <name> here: https://cloud.example.test/cloud/team/team-acme-1\"");
    expect(missing).toContain("don't try it another way (the browser or another tool)");
    const nobody = host.prompt("main-chat", "g", {});
    expect(nobody).toContain("mail is each person's own in Acme: it works for the person whose own message started the work");
    expect(nobody).toContain("\"<name> is each person's own, so I can't use it here. Ask me yourself and I'll use yours, or an admin can connect <name> for the whole team: https://cloud.example.test/cloud/team/team-acme-1.\"");
    expect(nobody).not.toMatch(/private chat/);
    expect(setup().host.prompt("room-chat", "g", {}), "nothing each person's: nothing said").toBe("");
  });

  it("says whose own account a step used: a person's server, in a turn that acts for them", () => {
    const { host, dataDir } = setup({ requester: { "main-chat": "" } });
    adaConnected(host, dataDir);
    const named = (tool: string, thread = "ada-work") => host.toolWhose(thread, "g", tool);
    expect(named("mcp__mail__read_inbox")).toEqual({ whose: { person: "ada@acme.test", app: "mail" } });
    expect(named("mcp__console__query"), "the team's server").toEqual({});
    expect(named("GMAIL_FETCH_EMAILS"), "an app tool of a connected app").toEqual({});
    expect(host.toolWhose("ada-work", undefined, "mcp__mail__read_inbox"), "no turn running").toEqual({});
    expect(named("mcp__mail__read_inbox", "room-chat"), "a chat others read uses none of hers").toEqual({});
    const cleos = setup();
    adaConnected(cleos.host, cleos.dataDir);
    expect(cleos.host.toolWhose("cleo-work", "g", "mcp__mail__read_inbox"), "Cleo connected nothing of hers").toEqual({});
  });

  it("says who connected what for the admin read, by address, never a secret", async () => {
    const { host, dataDir } = setup();
    adaConnected(host, dataDir);
    const extras = await host.adminExtras();
    expect(extras).toEqual({ scopes: { apps: [], mcp: ["mail"] }, people: { apps: {}, mcp: { mail: ["ada@acme.test"] } } });
    expect(JSON.stringify(extras)).not.toMatch(/ada-own-mail-key/);
    expect(await setup({ team: false }).host.adminExtras()).toEqual({});
  });
});
