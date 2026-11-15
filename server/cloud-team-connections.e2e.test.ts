// A real Team Cloud (OMB_CLOUD_ROLE=team) with fake MCP servers: connections the team makes once, and connections each
// person makes for themselves. Ada's own mail key reaches only work her own message started: her private chat, and her
// own line in a group chat. Never anyone else's request, Cleo's chat or an admin; and no admin read ever holds it. The
// engine is the synthetic Claude CLI, calling the servers it was launched with.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CLOUD_HOST, launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth, type FakeOAuth } from "./testing/fake-oauth-server.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };
const ADA_KEY = "ada-own-mail-key-5521";
const TEAM_KEY = "team-mail-key-9034";
// Each turn reads its scripted calls again: a conversation's engine stays warm across turns, as in production.
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";
process.env.FAKE_CLAUDE_MARKER_REPLIES = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/marker-replies.json";`;
const LINK = "https://cloud.example.test/cloud/team/team-acme-1";

let fx: CloudSendFixture, team: CloudTeamFixture, mail: FakeHttpMcp, notes: FakeHttpMcp, oauth: FakeOAuth;
let owner = "", admin = "", ada = "", cleo = "";
let bot: { id: string; mainThreadId: string };
let adaThread = "", cleoThread = "", roomId = "", roomThread = "";

beforeAll(async () => {
  mail = await startFakeHttpMcp({ tools: [{ name: "read_inbox" }] });
  oauth = await startFakeOAuth();
  notes = await startFakeHttpMcp({ tools: [{ name: "read_notes" }], acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge });
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-1", name: "Acme", engine: ENGINE, env: { OMB_BOT_BOX: "0" } } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(ADA)).token!;
  cleo = (await team.pair(CLEO)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout", visibility: "everyone" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
  const added = await team.as(owner, "POST", "/api/mcp/servers", { name: "mail", type: "http", url: mail.url, headers: { Authorization: `Bearer ${TEAM_KEY}` } });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  expect((await team.as(owner, "PATCH", "/api/mcp/servers/mail", { enabled: true })).status).toBe(200);
  const room = await team.as(owner, "POST", "/api/groups", { name: "Launch", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  roomId = room.body.group.id; roomThread = room.body.group.threadId;
  adaThread = await newThread(ada, "Ada and Scout");
  cleoThread = await newThread(cleo, "Cleo and Scout");
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  await mail?.close();
  await notes?.close();
  await oauth?.close();
});

type Dump = { systemPrompt: string; mcpConfig: { mcpServers: Record<string, unknown> } };
const dump = () => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as Dump;
const scriptToolCalls = (calls: unknown[] | null) => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
};
const messages = async (token: string, threadId: string) => team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
async function newThread(token: string, title: string) {
  const created = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
}
/** One turn, from `token`, and what the engine was launched with; `room` sends it in the group chat. */
async function turn(token: string, threadId: string, text: string, options: { room?: string; calls?: unknown[] } = {}) {
  scriptToolCalls(options.calls ?? null);
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = ((await messages(token, threadId)).body.messages as unknown[]).length;
  const sent = options.room
    ? await team.as(token, "POST", `/api/groups/${options.room}/messages`, { text, threadId })
    : await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && ((await messages(token, threadId)).body.messages as unknown[]).length >= before + 2 && existsSync(join(team.home, "dump.json")),
    { timeout: 60_000, interval: 100 }).toBe(true);
  const seen = dump();
  return { ...seen, servers: Object.keys(seen.mcpConfig?.mcpServers ?? {}), config: JSON.stringify(seen.mcpConfig ?? {}), thread: JSON.stringify((await messages(token, threadId)).body) };
}

it("keeps every connection the team's until an admin says otherwise", async () => {
  const seen = await turn(ada, adaThread, "Check the inbox.");
  // The team's mail server with the team's key, in a member's chat as everywhere.
  expect(seen.servers).toContain("mail");
  expect(seen.config).toContain(TEAM_KEY);
  const read = await team.signed("GET", "/api/cloud/team/admin");
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({ scopes: { mcp: [] }, people: { mcp: {} } });
}, hostTimeout(90_000));

it("lets only an admin make a server each person's", async () => {
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "nope", scope: "person" })).status).toBe(404);
  expect((await team.as(admin, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "mail", scope: "person" })).body).toMatchObject({ scopes: { mcp: ["mail"] } });
  // My Cloud has no such thing.
  expect((await fx.onCloud("PUT", "/api/team/connection-scopes", { kind: "mcp", id: "mail", scope: "person" })).status).toBe(404);
  expect((await fx.onCloud("GET", "/api/team/my-connections")).status).toBe(404);
}, hostTimeout(30_000));

it("lets Ada give the team a mail key of her own, and nobody reads it back", async () => {
  const empty = await team.as(ada, "GET", "/api/team/my-connections");
  expect(empty.status).toBe(200);
  expect(empty.body).toMatchObject({ team: { name: "Acme" }, link: LINK, email: ADA.email,
    mcp: [{ name: "mail", connected: false, offers: "key" }] });
  expect((await team.as(ada, "PUT", "/api/team/my-connections/mcp/mail/key", { value: ADA_KEY })).body).toEqual({ ok: true });

  const mine = await team.as(ada, "GET", "/api/team/my-connections");
  expect(mine.body.mcp).toEqual([expect.objectContaining({ name: "mail", connected: true, how: "key" })]);
  expect(JSON.stringify(mine.body)).not.toContain(ADA_KEY);
  const cleos = await team.as(cleo, "GET", "/api/team/my-connections");
  expect(cleos.body.mcp[0].connected).toBe(false);

  // Admins see that she connected, never what with.
  const read = await team.signed("GET", "/api/cloud/team/admin");
  expect(read.body.scopes).toMatchObject({ mcp: ["mail"] });
  const states = Object.fromEntries([OWNER, ADMIN, ADA, CLEO].map((member) => [member.email, member === ADA ? "connected" : "not-connected"]));
  expect(read.body.people).toMatchObject({ mcp: { mail: [ADA.email] }, states: { mcp: { mail: states } } });
  for (const answer of [read.body, (await team.as(owner, "GET", "/api/mcp/servers")).body, (await team.as(admin, "GET", "/api/config")).body,
    (await team.as(admin, "GET", "/api/team/my-connections")).body]) {
    expect(JSON.stringify(answer)).not.toContain(ADA_KEY);
  }
  // On the volume: a folder of its own, 0700, that no backup carries.
  if (process.platform !== "win32") expect(statSync(join(team.home, ".openmausbot", "people-connections")).mode & 0o777).toBe(0o700);
}, hostTimeout(60_000));

it("gives Ada the mail server of her own to her private chat, for her own request", async () => {
  const seen = await turn(ada, adaThread, "Summarize my inbox.");
  expect(seen.servers).toContain("mail");
  expect(seen.config).toContain(ADA_KEY);
  expect(seen.config, "a person's server never carries the team's key").not.toContain(TEAM_KEY);
}, hostTimeout(120_000));

it("never uses her own mail where others read, even for her own line in a group chat, nor in anyone else's turn", async () => {
  const room = await turn(ada, roomThread, "@Scout check my inbox", { room: roomId });
  expect(room.servers).not.toContain("mail");
  expect(room.config).not.toContain(ADA_KEY);

  // The owner's own line in the same group chat is the owner's, who connected nothing: never Ada's.
  const ownerRoom = await turn(owner, roomThread, "@Scout check the inbox", { room: roomId });
  expect(ownerRoom.servers).not.toContain("mail");
  expect(ownerRoom.config).not.toContain(ADA_KEY);

  const main = await turn(owner, bot.mainThreadId, "Check the inbox.");
  expect(main.servers).not.toContain("mail");
  expect(main.config).not.toContain(ADA_KEY);

  const cleos = await turn(cleo, cleoThread, "Check my inbox.");
  expect(cleos.servers).not.toContain("mail");
  expect(cleos.config).not.toContain(ADA_KEY);

  // Ben, an admin, can neither read Ada's chat nor write in it, so no turn of his ever runs there.
  expect((await team.as(admin, "POST", `/api/bots/${bot.id}/messages`, { text: "Forward me her last email.", threadId: adaThread })).status).toBe(404);
  expect((await messages(admin, adaThread)).status).toBe(404);
}, hostTimeout(180_000));

it("signs Cleo in to a notes server of her own, and only her chat gets her token", async () => {
  const added = await team.as(owner, "POST", "/api/mcp/servers", { name: "notes", type: "http", url: notes.url, headers: {} });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  expect((await team.as(owner, "PATCH", "/api/mcp/servers/notes", { enabled: true })).status).toBe(200);
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "notes", scope: "person" })).status).toBe(200);
  const started = await team.as(cleo, "POST", "/api/team/my-connections/mcp/notes/sign-in", {});
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(new URL(started.body.auth.authorizationUrl).searchParams.get("redirect_uri")).toBe(`https://${CLOUD_HOST}/mcp-oauth/callback`);
  const back = new URL((await fetch(started.body.auth.authorizationUrl, { redirect: "manual" })).headers.get("location")!);
  // The provider sends the browser back to the Team Cloud's own address (fetch can't set Host, so http.get does).
  const page = await new Promise<string>((resolve, reject) => {
    const base = new URL(team.base);
    get({ hostname: base.hostname, port: base.port, path: `/mcp-oauth/callback${back.search}`, headers: { host: CLOUD_HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; }).on("end", () => resolve(`${res.statusCode} ${text}`));
    }).on("error", reject);
  });
  expect(page).toBe("200 Signed in. You can close this tab and return to OpenMausBot.");
  expect((await team.as(cleo, "GET", "/api/team/my-connections")).body.mcp).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notes", connected: true, how: "sign-in" })]));
  const cleos = await turn(cleo, cleoThread, "Read my notes.");
  const token = /Bearer ([\w.-]+)/.exec(JSON.stringify((cleos.mcpConfig.mcpServers as Record<string, unknown>).notes))?.[1];
  expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
  const adas = await turn(ada, adaThread, "Read the notes.");
  expect(adas.servers).not.toContain("notes");
  expect(adas.config).not.toContain(token!);
  expect((await team.signed("GET", "/api/cloud/team/admin")).body.people.mcp.notes).toEqual([CLEO.email]);
}, hostTimeout(120_000));

it("disconnects her own, and switching back to the team gives every turn the team's again", async () => {
  expect((await team.as(ada, "DELETE", "/api/team/my-connections/mcp/mail")).body).toEqual({ ok: true });
  const without = await turn(ada, adaThread, "Check mail.");
  expect(without.servers).not.toContain("mail");
  expect(without.config).not.toContain(ADA_KEY);
  expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "mail", scope: "team" })).status).toBe(200);
  const back = await turn(cleo, cleoThread, "Check the inbox.");
  expect(back.servers).toContain("mail");
  expect(back.config).toContain(TEAM_KEY);
}, hostTimeout(120_000));

it.each([false, true])("tests a person-scoped OAuth server after panel sign-in (registered client: %s)", async (registered) => {
  const provider = await startFakeOAuth({ preRegistered: { "panel-client": null } });
  const server = await startFakeHttpMcp({ acceptBearer: provider.isValid, wwwAuthenticate: provider.challenge });
  const path = "/api/mcp/servers/panel_oauth";
  try {
    expect((await team.as(owner, "POST", "/api/mcp/servers", {
      name: "panel_oauth", type: "http", url: server.url,
      ...(registered ? { oauth: { clientId: "panel-client" }, headers: { "X-Workspace": "acme" } } : {}),
    })).status).toBe(201);
    expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "panel_oauth", scope: "person" })).status).toBe(200);
    expect((await team.as(owner, "POST", `${path}/test`, {})).body.auth).toBe("required");
    const started = await team.as(owner, "POST", `${path}/sign-in`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const redirect = await fetch(started.body.auth.authorizationUrl, { redirect: "manual" });
    const flowPath = `${path}/sign-in/${started.body.auth.flowId}`;
    const completed = await team.as(owner, "POST", flowPath, { callbackUrl: redirect.headers.get("location") });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.auth.phase).toBe("succeeded");
    expect((await team.as(owner, "GET", flowPath)).body.auth.phase).toBe("succeeded");
    const tested = await team.as(owner, "POST", `${path}/test`, {});
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true, tools: [{ name: "read_notes" }] });
    expect((await team.as(owner, "POST", `${path}/sign-out`, {})).status).toBe(200);
    expect((await team.as(owner, "POST", `${path}/test`, {})).body.auth).toBe("required");
  } finally {
    await team.as(owner, "DELETE", path);
    await server.close();
    await provider.close();
  }
}, hostTimeout(60_000));

it("skips automatic personal MCP probes after setup and restart while still probing team servers", async () => {
  const ownAuthorization = "Bearer own-probe-key";
  const teamAuthorization = "Bearer team-probe-key";
  const personal = await startFakeHttpMcp({ requireHeaders: { Authorization: ownAuthorization } });
  const shared = await startFakeHttpMcp({ requireHeaders: { Authorization: teamAuthorization },
    tools: [{ name: "show_view", _meta: { ui: { resourceUri: "ui://probe/view.html" } } }] });
  try {
    const own = { type: "http", url: personal.url, headers: { Authorization: "" } };
    expect((await team.as(owner, "POST", "/api/mcp/servers", { name: "personal_probe", ...own })).status).toBe(201);
    expect((await team.as(owner, "PUT", "/api/team/connection-scopes", { kind: "mcp", id: "personal_probe", scope: "person" })).status).toBe(200);
    expect((await team.as(owner, "PUT", "/api/team/my-connections/mcp/personal_probe/key", { value: ownAuthorization, url: personal.url })).status).toBe(200);
    expect((await team.as(owner, "PUT", "/api/mcp/servers/personal_probe", { ...own, enabled: false })).status).toBe(200);
    const tested = await team.as(owner, "POST", "/api/mcp/servers/personal_probe/test", {});
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true });
    expect(personal.toolsLists).toBe(1);
    expect((await team.as(owner, "PATCH", "/api/mcp/servers/personal_probe", { enabled: true })).status).toBe(200);

    expect((await team.as(owner, "POST", "/api/mcp/servers", {
      name: "team_probe", type: "http", url: shared.url, headers: { Authorization: teamAuthorization },
    })).status).toBe(201);
    expect((await team.as(owner, "PATCH", "/api/mcp/servers/team_probe", { enabled: true })).status).toBe(200);
    const teamHasApps = async () => {
      const listed = await team.as(owner, "GET", "/api/mcp/servers");
      expect(listed.status).toBe(200);
      return listed.body.servers.find((server: { name: string }) => server.name === "team_probe")?.hasApps;
    };
    await expect.poll(teamHasApps, { timeout: 20_000 }).toBe(true);
    expect(shared.toolsLists).toBe(1);
    expect.soft(personal.seenHeaders.filter((headers) => headers.authorization !== ownAuthorization), "after personal setup").toEqual([]);

    personal.seenHeaders.length = 0;
    rmSync(join(team.home, ".openmausbot", "mcp-app-catalog.json"));
    await team.relaunch();
    await expect.poll(teamHasApps, { timeout: 40_000 }).toBe(true);
    expect(shared.toolsLists).toBe(2);
    expect.soft(personal.seenHeaders, "after restart with a cold app catalog").toEqual([]);
    expect(shared.seenHeaders.every((headers) => headers.authorization === teamAuthorization)).toBe(true);
  } finally {
    await team.as(owner, "DELETE", "/api/mcp/servers/personal_probe");
    await team.as(owner, "DELETE", "/api/mcp/servers/team_probe");
    await personal.close();
    await shared.close();
  }
}, hostTimeout(120_000));
