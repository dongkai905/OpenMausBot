// This computer's connections, moved once with the rest of the person's things to their own Cloud: MCP servers with
// their secrets and sign-ins, the AI keys bots run on, and mailboxes. Secrets reach main only over the
// server's private port (cloud-logins.mjs) and go only to the move's owner session on My Cloud. A sign-in that
// refreshes itself moves: once My Cloud has it, this computer forgets its own copy, so only My Cloud uses it.
//
//   const collected = await collectConnections(local);
//   const result = await sendConnections(collected, target, { local });
//
// `local`: this computer's server, `{ json(route), handoff(what) }`: a loopback read, and the private port's answer.
// `target`: the owner session on My Cloud, `{ call(method, route, body?) }` answering `{ ok, status, body }`.

import nativeText from "./native-text.cjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null);
const pick = (source, names) => Object.fromEntries(names.filter((name) => source[name] !== undefined && source[name] !== null).map((name) => [name, source[name]]));
const ID = /^(?:mcp:[a-z][a-z0-9_-]{0,31}|key:\w{1,40}|email)$/u;
const ENVIRONMENT = /^[\w-]{1,128}$/u;
const ENGINE = /^[\w.:-]{1,128}$/u;
const LAUNCHER = /^[a-z0-9._+-]{1,40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const KINDS = new Set(["mcp", "key", "email"]);
/** Keys first, so the engines they run are ready before anything that follows them. */
const ORDER = { key: 0, mcp: 1, email: 2 };
const MCP_FIELDS = ["command", "args", "env", "type", "url", "headers", "oauth", "resultBudget", "enabled", "runsOn"];
/** How long a move waits for My Cloud to run the engines whose keys just went. */
const ENGINE_WAIT_MS = 10_000;

export class ConnectionMoveError extends Error {
  /** `final`: trying again can't fix it (My Cloud's policy or limits refused it). */
  constructor(code, message, final = false) {
    super(message);
    this.name = "ConnectionMoveError";
    this.code = code;
    this.final = final;
  }
}

/** A server's answer to GET /api/cloud-connections, kept to its known shape; null when it is not one. */
export function parseConnections(value) {
  if (!record(value) || !Array.isArray(value.connections) || !record(value.computer)) return null;
  const { environmentId, label } = value.computer;
  if (typeof environmentId !== "string" || !ENVIRONMENT.test(environmentId) || typeof label !== "string" || !label.trim()) return null;
  const strings = (list, pattern, max) => (Array.isArray(list) ? [...new Set(list.filter((entry) => typeof entry === "string" && pattern.test(entry)))].slice(0, max) : []);
  const connections = value.connections.filter((item) => record(item) && typeof item.id === "string" && ID.test(item.id) && KINDS.has(item.kind)
    && item.id.split(":")[0] === item.kind && typeof item.label === "string" && item.label.trim())
    .slice(0, 200).map((item) => ({
      id: item.id, kind: item.kind, label: item.label.trim().slice(0, 120),
      ...(item.runsHere === true ? { runsHere: true } : {}),
      ...(typeof item.launcher === "string" && LAUNCHER.test(item.launcher) ? { launcher: item.launcher } : {}),
      ...(Array.isArray(item.for) ? { for: strings(item.for, ENGINE, 20) } : {}),
      ...(item.signIn === true ? { signIn: true } : {}),
    }));
  return { computer: { environmentId, label: label.trim().slice(0, 120) }, connections, engines: strings(value.engines, ENGINE, 200), commands: strings(value.commands, LAUNCHER, 40),
    ...(value.vaultKeys === true ? { vaultKeys: true } : {}) };
}

/** This computer's connections, by name only, and the computer they are on. */
export async function collectConnections(local) {
  const listed = parseConnections(await local.json("/api/cloud-connections").catch(() => null));
  if (!listed) throw new ConnectionMoveError("local", "OpenMausBot on this computer did not list its apps and keys. Try again in a moment.");
  return { computer: listed.computer, connections: listed.connections };
}

function refused(answer, fallback) {
  if (answer.status === 401) return new ConnectionMoveError("refused", "My Cloud did not let this app make the change. Open My Cloud in this app once, then try again.");
  const said = sentence(answer.body?.error);
  return new ConnectionMoveError("refused", said ? `My Cloud said: ${said}` : fallback, answer.status === 400 || answer.status === 403);
}

async function secrets(local, item) {
  const answer = await local.handoff({ kind: "connection", id: item.id }).catch(() => null);
  if (!record(answer?.connection)) throw new ConnectionMoveError("local", `${item.label} could not be read on this computer.`);
  return { connection: answer.connection, ...(typeof answer.digest === "string" && DIGEST.test(answer.digest) ? { digest: answer.digest } : {}) };
}

/** My Cloud's connections once it runs every one of these engines, asked every half second; the last ones read when it
 * does not get there in time. */
async function runningEngines(target, engines, waitMs, cloud) {
  for (const started = Date.now(); ; await new Promise((resolve) => setTimeout(resolve, 500))) {
    const answer = await target.call("GET", "/api/cloud-connections").catch(() => null);
    const read = answer?.ok ? parseConnections(answer.body) : null;
    if (read) cloud = read;
    if ([...engines].every((engine) => cloud.engines.includes(engine)) || Date.now() - started >= waitMs) return cloud;
  }
}

const signInRoute = (item) => `/api/cloud-connections/mcp/${item.id.slice("mcp:".length)}/sign-in`;

/** This computer's newer copy of a sign-in, in place of the one My Cloud took from it (`onCloud`); its digest, or null. */
async function sendAgain(local, target, item, onCloud) {
  const fresh = await secrets(local, item).catch(() => null);
  const signIn = fresh?.connection.mcp?.signIn;
  if (!record(signIn) || !fresh.digest) return null;
  const answer = await target.call("PUT", `${signInRoute(item)}?replaces=${onCloud}`, signIn).catch(() => null);
  return answer?.ok && answer.body?.adopted === true ? fresh.digest : null;
}

/** This computer lets go of a sign-in My Cloud took (`digest`: what My Cloud has); one that refreshed here meanwhile
 * goes again first. True once let go of. */
async function letGo(local, target, item, digest) {
  let onCloud = digest;
  for (let tries = 0; tries < 3 && onCloud; tries++) {
    const answer = await local.handoff({ kind: "connection-release", id: item.id, digest: onCloud }).catch(() => null);
    if (answer?.release?.released === true) return { released: true };
    if (answer?.release?.changed !== true) break;
    onCloud = await sendAgain(local, target, item, onCloud);
  }
  return { released: false, digest: onCloud ?? digest };
}

/**
 * Moves each of this computer's connections to My Cloud, keys first: each over My Cloud's own routes, with its secrets.
 * An MCP server that needs this computer (its program, files or address are here, or My Cloud lacks its program) goes
 * marked as running on this computer, which My Cloud never starts. A sign-in that refreshes itself goes too, and this
 * computer lets go of its copy once My Cloud has it (with `release: false`, the result lists it instead, for
 * releaseConnections). One connection failing never stops the others.
 *
 * With `signIns: false`, a sign-in that refreshes itself stays here for a later pass (`later`), and the rest goes.
 *
 * Returns { moved, runsHere, kept, failed, release, later }: what My Cloud has now; what went marked as
 * running here (`needs`: a program My Cloud lacks; `off`: it was switched off here too); what My Cloud kept of its own
 * (its own sign-in); what failed (`final`: trying again can't fix it); the sign-ins My Cloud took that this computer
 * still holds; and the sign-ins left for a later pass.
 */
export async function sendConnections(collected, target, { local, release = true, signIns = true, waitMs = ENGINE_WAIT_MS, onProgress = () => {}, t = nativeText.englishText.t } = {}) {
  const answer = await target.call("GET", "/api/cloud-connections").catch(() => null);
  if (answer?.status === 404) throw new ConnectionMoveError("outdated", "My Cloud needs an update before it can take this computer's apps and keys. It updates by itself.");
  let cloud = answer?.ok ? parseConnections(answer.body) : null;
  if (!cloud) throw new ConnectionMoveError("unreachable", "My Cloud did not answer. Try again in a moment.");
  const result = { moved: [], runsHere: [], kept: [], failed: [], release: [], later: [] };
  const done = (item) => result.moved.push({ id: item.id, label: item.label });

  /** A sign-in to My Cloud; one that refreshes itself (`digest`) is then let go of here. My Cloud keeps one of its own. */
  async function moveSignIn(item, signIn, digest) {
    const put = await target.call("PUT", signInRoute(item), signIn);
    if (!put.ok) throw refused(put, `My Cloud did not take ${item.label}'s sign-in.`);
    if (put.body?.kept === true) return void result.kept.push({ id: item.id, label: item.label });
    if (!digest) return;
    const outcome = release ? await letGo(local, target, item, digest) : { released: false, digest };
    if (!outcome.released) result.release.push({ id: item.id, label: item.label, digest: outcome.digest });
  }

  const steps = {
    async key(item) {
      const { connection } = await secrets(local, item);
      if (!record(connection.config)) throw new ConnectionMoveError("local", `${item.label} could not be read on this computer.`);
      const saved = await target.call("PATCH", "/api/config", connection.config);
      if (!saved.ok) throw refused(saved, `My Cloud did not take the ${item.label} key.`);
      done(item);
      // Nothing holds a key back any more, so the engines this key runs are
      // collected and waited for before whatever follows the move.
      return false;
    },
    async mcp(item) {
      const { connection, digest } = await secrets(local, item);
      const { name, server, signIn, keys } = record(connection.mcp) ? connection.mcp : {};
      if (typeof name !== "string" || !record(server)) throw new ConnectionMoveError("local", `${item.label} could not be read on this computer.`);
      // A Cloud too old to read a `vault:<id>` key would save the pointer as the key itself: it goes once the Cloud has updated.
      if (Array.isArray(keys) && keys.length && !cloud.vaultKeys) throw new ConnectionMoveError("outdated", "My Cloud needs an update before it can take this computer's apps and keys. It updates by itself.");
      const { enabled, runsOn: marked, ...definition } = pick(server, MCP_FIELDS);
      const missing = item.launcher && !cloud.commands.includes(item.launcher) ? item.launcher : null;
      const runsOn = record(marked) ? marked : item.runsHere || missing ? collected.computer : null;
      const keysField = Array.isArray(keys) && keys.length ? { vaultKeys: keys } : {};
      let saved;
      if (cloud.connections.some((theirs) => theirs.id === item.id)) {
        saved = await target.call("PUT", `/api/mcp/servers/${name}`, { ...definition, enabled: enabled === true, runsOn, ...keysField });
      } else {
        saved = await target.call("POST", "/api/mcp/servers", { name, ...definition, ...(runsOn ? { runsOn } : {}), ...keysField });
        if (saved.ok && enabled === true) saved = await target.call("PATCH", `/api/mcp/servers/${name}`, { enabled: true });
      }
      if (!saved.ok) throw refused(saved, `My Cloud did not take ${item.label}.`);
      if (runsOn) return void result.runsHere.push({ id: item.id, label: item.label, ...(missing && !item.runsHere && !record(marked) ? { needs: missing } : {}), ...(enabled === true ? {} : { off: true }) });
      done(item);
      if (record(signIn)) {
        if (!digest) throw new ConnectionMoveError("local", `${item.label}'s sign-in could not be read on this computer.`);
        if (!signIns) return void result.later.push({ id: item.id, label: item.label });
        await moveSignIn(item, signIn, digest);
      }
    },
    async email(item) {
      const accounts = (await secrets(local, item)).connection.email;
      if (!Array.isArray(accounts)) throw new ConnectionMoveError("local", t("native.cloud.mailRead"));
      const answer = await target.call("PUT", "/api/cloud-connections/email", { accounts });
      if (answer.status === 404) throw new ConnectionMoveError("outdated", t("native.cloud.mailOutdated"), true);
      if (!answer.ok) throw refused(answer, t("native.cloud.mailRefused"));
      done(item);
    },
  };

  const items = [...collected.connections].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const engines = new Set();
  let count = 0;
  for (const item of items) {
    if (item.kind !== "key" && engines.size) {
      cloud = await runningEngines(target, engines, waitMs, cloud);
      engines.clear();
    }
    try {
      const held = await steps[item.kind](item);
      if (item.kind === "key" && !held) for (const engine of item.for ?? []) if (!cloud.engines.includes(engine)) engines.add(engine);
    } catch (error) {
      result.failed.push({ id: item.id, label: item.label, message: sentence(error?.message) ?? `${item.label} did not move.`, final: error?.final === true });
    }
    onProgress({ done: ++count, total: items.length, label: item.label });
  }
  if (engines.size) await runningEngines(target, engines, waitMs, cloud);
  return result;
}

/** Lets go of sign-ins My Cloud took that this computer still holds (`release` of a move's result); the ones it could
 * not let go of yet. */
export async function releaseConnections(pending, { local, target }) {
  const held = [];
  for (const entry of pending) {
    if (!record(entry) || typeof entry.id !== "string" || !ID.test(entry.id) || typeof entry.digest !== "string" || !DIGEST.test(entry.digest)) continue;
    const item = { id: entry.id, kind: entry.id.startsWith("mcp:") ? "mcp" : entry.id, label: typeof entry.label === "string" ? entry.label : entry.id };
    const outcome = await letGo(local, target, item, entry.digest);
    if (!outcome.released) held.push({ id: item.id, label: item.label, digest: outcome.digest });
  }
  return held;
}
