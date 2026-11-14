// The engines' usage limits and the automations that wait for them to reset. All four need admin scope
// (request-auth's default):
//   GET  /api/limit-resets              each engine's limit: how full, when it resets, whether it refuses work
//   POST /api/limit-resets/release      {engine}: "Try again now", end the engine's limit hold at once
import type { LimitResetClock } from "../limit-resets.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LimitResetRouteDeps {
  clock: LimitResetClock;
  now?: () => number;
}

// Ids are taken exactly as sent: the visibility checks before this route (a team phone, the relay) look at the raw id,
// so a padded id that only matched after trimming would reach a conversation those checks never saw.
const exactId = (value: unknown) => typeof value === "string" && value && value.length <= 128 && value === value.trim() ? value : null;

export function createLimitResetRoutes(deps: LimitResetRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === "/api/limit-resets" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      const fresh = deps.clock.ensureFresh();
      if (url.searchParams.get("refresh") === "1" || deps.clock.report().checkedAt === 0) await fresh;
      return json(res, 200, deps.clock.report());
    }
    if (path === "/api/limit-resets/release" && method === "POST") {
      const body = await readBody(req, 4096) as Record<string, unknown> | null;
      const engine = exactId(body?.engine);
      if (!engine) return json(res, 400, { error: "engine is required" });
      deps.clock.release(engine);
      return json(res, 200, deps.clock.report());
    }
    return PASS;
  };
}
