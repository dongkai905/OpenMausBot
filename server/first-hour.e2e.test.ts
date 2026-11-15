// A new personal Cloud's first hour end to end on a real Cloud home (temporary home, the fake Claude CLI): the greeting
// by name, with no setup screen. Nothing here reaches a real account or a model.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0f1e2d3c4b5a.fly.dev";
const secret = randomBytes(32).toString("base64url");

let home = "", dataDir = "", base = "", log = "", token = "";
let child: ChildProcess | undefined;
const dumpFile = () => join(home, "turn.json");
const toolCalls = () => join(home, "tool-calls.json");

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => null) as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}\n${log.slice(-2000)}`).toBeLessThan(300);
  return value;
}

/** The Admin's own signed reads of the home. */
async function signed(path: string, method = "GET", body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const signature = method === "POST" && path === "/api/cloud/pairing" ? cloudPairingSignature(secret, timestamp, nonce, body) : cloudRequestSignature(secret, timestamp, nonce, method, path, body);
  const response = await fetch(`${base}${path}`, { method, headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", ...(body ? { "content-type": "application/json" } : {}),
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${signature}`,
  }, ...(body ? { body } : {}) });
  return response.json() as Promise<any>;
}

describe("a new Cloud's first hour", () => {
  let chief: { id: string; threadId: string };
  const messages = async () => (await api("GET", `/api/threads/${chief.threadId}/messages?limit=200`)).messages as any[];

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    home = mkdtempSync(join(tmpdir(), "omb-first-hour-"));
    dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    const markers = join(home, "markers.json");
    writeFileSync(markers, JSON.stringify({}));
    writeFileSync(toolCalls(), "[]");
    const cli = join(home, "fake-claude.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "sam.lee@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dumpFile())};
process.env.FAKE_CLAUDE_MARKER_REPLIES = ${JSON.stringify(markers)};
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = ${JSON.stringify(toolCalls())};
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      profile: { name: "Sam Lee" },
      instances: {
        ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", displayName: "Fixture", config: { cli } },
      },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
    child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_CLOUD_ROLE: "home", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { log += chunk; });
    child.stderr?.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const pairing = await signed("/api/cloud/pairing", "POST", JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 }));
    token = (await api("POST", "/api/auth/pair", { code: pairing.code })).token;
    const bots = (await api("GET", "/api/bots")).bots as any[];
    const found = bots.find((bot) => bot.defaultBot && !bot.defaultBot.person);
    chief = { id: found.id, threadId: found.mainThreadId ?? found.threadId };
  }, 120_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
    vi.restoreAllMocks();
  });

  it("opens on the Chief, who greets the person by name and asks one question, with no setup screen", async () => {
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "bot", kind: "text" });
    expect(rows[0].text).toBe("Hi Sam! I'm MausBot, your Chief of Staff. I live on the Cloud, so I keep working while your computer is off. What do you want off your plate?");
    expect(rows[0].helperIntro).toBeUndefined();
    expect((await api("GET", "/api/config")).onboarding.hintsSeen).toContain("cloud-welcome-done");
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === chief.id).welcomed).toBe(true);
  });
});
