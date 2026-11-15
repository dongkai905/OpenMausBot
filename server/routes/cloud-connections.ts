// The routes a one-time move to the person's own Cloud uses for connections. GET /api/cloud-connections, on either
// side, names this server's connections (never a secret) with the engines it runs and the programs it has. On a Cloud
// home: PUT /api/cloud-connections/mcp/<name>/sign-in takes a sign-in that moved; PUT /api/cloud-connections/email
// takes the person's mailboxes. Admin scope (request-auth's default): only the owner's app reaches them.
import type { ConnectionListing } from "../cloud-connections.ts";
import { parseMcpOAuthRecord, type McpOAuthRecord } from "../mcp-oauth-store.ts";
import type { McpRunsOn } from "../mcp-registry.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const SIGN_IN = /^\/api\/cloud-connections\/mcp\/([a-z][a-z0-9_-]{0,31})\/sign-in$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export interface ConnectionsAnswer {
  /** This server's own computer, which an MCP server that needs it is marked as running on. */
  computer: McpRunsOn;
  connections: ConnectionListing[];
  /** The engines (instance ids) ready to run here now. */
  engines: string[];
  /** Programs a command-line MCP server may start that this server has. */
  commands: string[];
}

export type Adopted = { ok: true; outcome: "adopted" | "kept" } | { ok: false; status: number; error: string };

export interface CloudConnectionRouteDeps {
  /** Only a Cloud home takes connections, and a server of one person's own from that person's session (`ownHome`). */
  cloudHome: boolean;
  ownHome?(auth: RequestAuth): boolean;
  /** A Team Cloud: a person's own connections (a sign-in, a mailbox) are refused with one plain line. */
  personalRefusal?: (what: string) => string | null;
  list(): Promise<ConnectionsAnswer>;
  /** `replaces`: the digest of the sign-in this computer moved here before, which a newer one may replace. */
  adoptSignIn(name: string, record: McpOAuthRecord, replaces: string | null): Adopted;
  /** The person's mailboxes with their passwords; one already here at that address stays. */
  adoptEmail?(accounts: unknown[]): { adopted: number; kept: number };
}

export function createCloudConnectionRoutes(deps: CloudConnectionRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== "/api/cloud-connections" && !path.startsWith("/api/cloud-connections/")) return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === "/api/cloud-connections") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, await deps.list());
    }
    if (!deps.cloudHome && deps.ownHome?.(auth) !== true) return json(res, 404, { error: "not found" });
    const signIn = SIGN_IN.exec(path);
    if (path !== "/api/cloud-connections/email" && !signIn) return json(res, 404, { error: "not found" });
    if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
    const refused = deps.personalRefusal?.(signIn ? signIn[1]! : "Email");
    if (refused) { req.resume(); return json(res, 403, { error: refused }); }
    const body = await readBody(req, 64 * 1024);
    const replaces = url.searchParams.get("replaces");
    if (replaces !== null && !DIGEST.test(replaces)) return json(res, 400, { error: "replaces is a sign-in's digest" });

    if (signIn) {
      const record = parseMcpOAuthRecord(body);
      if (!record) return json(res, 400, { error: "send the sign-in as this computer keeps it" });
      const adopted = deps.adoptSignIn(signIn[1]!, record, replaces);
      return adopted.ok ? json(res, 200, { [adopted.outcome]: true }) : json(res, adopted.status, { error: adopted.error });
    }
    const accounts = (body as { accounts?: unknown } | null)?.accounts;
    if (!Array.isArray(accounts) || !deps.adoptEmail) return json(res, 400, { error: "send { accounts } as this computer keeps them" });
    return json(res, 200, deps.adoptEmail(accounts));
  };
}
