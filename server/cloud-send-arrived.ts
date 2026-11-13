// POST /api/cloud-send/arrived, at the end of the move, over the owner's own session: My Cloud keeps which computer the
// bots came from, so each bot knows what stayed there (cloud-connections-prompt.ts), and each bot whose webhook has a new
// address here says so once in its own chat. The address itself never goes in a chat: it stays on the webhook's card.
// POST /api/cloud-send/automations-off: the automations a computer brought stop on My Cloud as its bots go home to it.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { CloudOwner } from "./cloud-owner-lines.ts";
import { switchAutomationsOff, type MoveAutomations } from "./move-freeze.ts";
import type { LineLanguage } from "./server-lines.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";
import type { Store } from "./store.ts";

const FILE = "moved-from.json";

export interface MovedFrom { computer: string; at: number; told: string[] }

export function movedFrom(dataDir: string): MovedFrom | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as Partial<MovedFrom>;
    if (typeof raw.computer !== "string" || !raw.computer.trim() || !Number.isSafeInteger(raw.at)) return null;
    return { computer: raw.computer, at: raw.at!, told: Array.isArray(raw.told) ? raw.told.filter((id): id is string => typeof id === "string") : [] };
  } catch { return null; }
}

export interface ArrivedDeps {
  dataDir: string;
  store: Pick<Store, "bot" | "appendMessage">;
  owner(auth: RequestAuth): CloudOwner | null;
  lineLanguage?: LineLanguage;
  /** The person hears what stayed on the computer the bots came from (cloud-connections-stayed.ts). */
  stayed?(language?: string): void;
}

const arrivedBody = z.object({ v: z.literal(1), computer: z.string().trim().min(1).max(120),
  place: z.string().trim().min(1).max(120).optional() });

/** False when the path is not this route. */
export async function arrivedRoute(deps: ArrivedDeps, { req, res, path, method, auth, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/arrived") return false;
  const refuse = (status: number, error: string) => { json(res, status, { error }); return true; };
  if (method !== "POST") return refuse(405, "method not allowed");
  const owner = deps.owner(auth);
  if (!owner) return refuse(403, "Only My Cloud's owner can finish a move into it.");
  const body = arrivedBody.safeParse(await readBody(req, 64 * 1024));
  if (!body.success) return refuse(400, "send { v: 1, computer }");
  const kept = movedFrom(deps.dataDir);
  const told = new Set(kept?.told ?? []);
  // Recorded before the lines go: a move cut short here never has a bot say it twice.
  writeFileAtomic(join(deps.dataDir, FILE), JSON.stringify({ computer: body.data.computer, at: kept?.at ?? Date.now(), told: [...told] }), { mode: 0o600 });
  deps.stayed?.(deps.lineLanguage?.(owner.person));
  json(res, 200, { v: 1, told: 0 });
  return true;
}

const homeBody = z.object({ v: z.literal(1) });

/** POST /api/cloud-send/home, on this computer once the bots came home with what they did on My Cloud: the record of
 * where the bots came from came home with them and goes now. False when the path is not this route. */
export async function homeRoute(deps: Omit<ArrivedDeps, "owner">, { req, res, path, method, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/home") return false;
  if (method !== "POST") { req.resume(); json(res, 405, { error: "method not allowed" }); return true; }
  const body = homeBody.safeParse(await readBody(req, 64 * 1024));
  if (!body.success) { json(res, 400, { error: "send { v: 1 }" }); return true; }
  // Gone before the lines go: coming home again after a crash here never has a bot say it twice.
  rmSync(join(deps.dataDir, FILE), { force: true });
  json(res, 200, { v: 1, told: 0 });
  return true;
}

export interface AutomationsOffDeps {
  automations: MoveAutomations;
  owner(auth: RequestAuth): CloudOwner | null;
}

const KEY = /^(?:wait):[\w-]{1,128}$/u;
const offBody = z.object({ v: z.literal(1), keys: z.array(z.string().regex(KEY)).max(2_000) });

/** POST /api/cloud-send/automations-off on My Cloud, over its owner's own session, as a computer's bots go home to it while
 * My Cloud goes on: the automations that computer brought, by key, stop here, so none of them runs on both. `off`: those
 * that were on. False when the path is not this route. */
export async function automationsOffRoute(deps: AutomationsOffDeps, { req, res, path, method, auth, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/automations-off") return false;
  const refuse = (status: number, error: string) => { json(res, status, { error }); return true; };
  if (method !== "POST") { req.resume(); return refuse(405, "method not allowed"); }
  if (!deps.owner(auth)) { req.resume(); return refuse(403, "Only My Cloud's owner can stop its waits."); }
  const body = offBody.safeParse(await readBody(req, 256 * 1024));
  if (!body.success) return refuse(400, "send { v: 1, keys }");
  json(res, 200, { v: 1, off: await switchAutomationsOff(deps.automations, new Set(body.data.keys)) });
  return true;
}
