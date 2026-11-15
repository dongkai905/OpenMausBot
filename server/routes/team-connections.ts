import { userError } from "../user-errors.ts";
// A Team Cloud's connections, the team's or each person's.
//   PUT /api/team/connection-scopes { kind: "mcp", id, scope: "team" | "person" }   an admin: who connects it
//   GET /api/team/my-connections                                                           the person's own
//   POST /api/team/my-connections/mcp/:name/sign-in             → { auth }  their own sign-in to the server (a new tab)
//   PUT /api/team/my-connections/mcp/:name/key { value, url? }              their own key, never read back
//   DELETE /api/team/my-connections/mcp/:name
// The Admin's Cloud page calls these with a session it opened for the person asking (a User's is a client session).
// Every one acts on the session's own person only, and none answers with a key, a token or a path of an address.
import type { AdminActionRow } from "../admin-activity.ts";
import type { AppConfig } from "../config.ts";
import type { TeamConnectionsHost } from "../host/team-connections-host.ts";
import { McpOAuthError, McpSignInError, mcpCallbackOrigin } from "../mcp-oauth.ts";
import { isRemoteMcpServer, mcpServerNotFound, parseStoredMcpServer } from "../mcp-registry.ts";
import { personKey } from "../person-key.ts";
import { provesSameOrigin, requestOrigin, type RequestAuth } from "../request-auth.ts";
import { MCP_NAME, personKeyHeader } from "../team-connections.ts";
import { sessionMember } from "./team-phone.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const CONNECTION_SCOPES_PATH = "/api/team/connection-scopes";
export const MY_CONNECTIONS_PATH = "/api/team/my-connections";

export interface TeamConnectionRouteDeps {
  host: TeamConnectionsHost;
  cfg: () => AppConfig;
  /** This server's own https address, where a member's MCP sign-in comes back. */
  publicOrigin: string | null;
  /** The team's rules: a server they don't allow can't be connected by anyone. */
  policy?: { mcpRefusal(name: string, url?: string): string | undefined };
  /** An admin's change, for the team's admin activity. */
  record?(auth: RequestAuth, row: Omit<AdminActionRow, "at" | "actor">): void;
}

const host = (url: string) => { try { return new URL(url).host; } catch { return null; } };

export function createTeamConnectionRoutes(deps: TeamConnectionRouteDeps): RouteHandler {
  const team = deps.host.team;
  const server = (name: string) => {
    const raw = deps.cfg().mcpServers?.[name];
    const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
    return parsed?.ok ? parsed.server : null;
  };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== CONNECTION_SCOPES_PATH && path !== MY_CONNECTIONS_PATH && !path.startsWith(`${MY_CONNECTIONS_PATH}/`)) return PASS;
    if (!team) return json(res, 404, { error: "Only a team's Cloud has connections for each person." });

    if (path === CONNECTION_SCOPES_PATH) {
      if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
      const body = await readBody(req);
      const kind = body?.kind, id = typeof body?.id === "string" ? body.id.trim().toLowerCase() : "", scope = body?.scope;
      if (kind !== "mcp" || (scope !== "team" && scope !== "person") || !MCP_NAME.test(id)) {
        return json(res, 400, { error: "Name an MCP server, and who connects it: the team or each person." });
      }
      const found = server(id);
      if (!found) return json(res, 404, { error: mcpServerNotFound(id) });
      if (scope === "person" && !isRemoteMcpServer(found)) return json(res, 409, { error: "Only a server reached by its address can be connected by each person." });
      const before = deps.host.scopes.scope(id);
      if (before !== scope) {
        deps.host.scopes.set(id, scope);
        deps.record?.(auth, { category: "mcp", action: "mcp.update", target: { kind, id },
          changed: [scope === "person" ? "each person connects their own" : "connected for the whole team"] });
      }
      return json(res, 200, { scopes: { apps: [] as string[], mcp: deps.host.scopes.person() } });
    }

    // Everything below is the person's own: a session the Admin opened for a member, never the loopback or a device.
    const member = auth.kind === "session" ? sessionMember(auth.session) : null;
    if (!member || auth.kind !== "session") return json(res, 403, { error: `Sign in to ${team.name} to connect your own servers.` });
    const person = personKey({ id: "", email: member.member.email });
    const email = member.member.email;

    if (path === MY_CONNECTIONS_PATH) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, {
        team: { id: team.id, name: team.name },
        link: deps.host.link(),
        email,
        mcp: deps.host.personMcp().flatMap((name) => {
          const stored = server(name);
          if (!stored || !isRemoteMcpServer(stored)) return [];
          const signedIn = deps.host.people.oauth(person).authState(name, stored.url) === "signed-in";
          const key = deps.host.people.key(person, name, stored.url) !== null;
          return [{ name, host: host(stored.url), connected: signedIn || key, how: signedIn ? "sign-in" : key ? "key" : null,
            offers: stored.oauth || !Object.keys(stored.headers).length ? "sign-in" : "key" }];
        }),
      });
    }

    const mcp = /^\/api\/team\/my-connections\/mcp\/([a-z][a-z0-9_-]{0,31})(\/sign-in|\/key)?$/.exec(path);
    if (mcp) {
      const name = mcp[1]!, stored = server(name);
      if (!stored || !deps.host.personMcp().includes(name) || !isRemoteMcpServer(stored)) {
        return json(res, 409, { error: `${name} is ${team.name}'s, connected once for everyone by an admin.` });
      }
      deps.host.people.remember(person, email);
      if ((mcp[2] === "/sign-in" || mcp[2] === "/key") && method !== "DELETE") {
        const refused = deps.policy?.mcpRefusal(name, stored.url);
        if (refused) return json(res, 403, { error: refused, code: "managed_policy" });
      }
      if (mcp[2] === "/sign-in" && method === "POST") {
        const origin = mcpCallbackOrigin(provesSameOrigin(req) ? requestOrigin(req) : null, [deps.publicOrigin]);
        try {
          res.setHeader("Cache-Control", "no-store");
          return json(res, 200, { auth: await deps.host.people.oauth(person).start(name, stored.url, undefined, auth.session.id, { remote: origin !== null, origin }) });
        } catch (error) {
          if (error instanceof McpOAuthError && error.code === "not-oauth") return json(res, 400, { error: "This server doesn't offer a sign-in. Add your own key instead.", code: error.code });
          if (error instanceof McpOAuthError) return json(res, 400, { error: error.message, code: error.code });
          if (error instanceof McpSignInError) return json(res, error.status, { error: error.message });
          return json(res, 502, { error: error instanceof Error ? error.message : "Sign-in could not start." });
        }
      }
      if (mcp[2] === "/key" && method === "PUT") {
        const body = await readBody(req, 4096);
        const value = typeof body?.value === "string" ? body.value.trim() : "";
        if (value.length < 8 || value.length > 512 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)?$/.test(value)) return json(res, 400, { error: "Paste the key alone." });
        if (body?.url !== undefined && (typeof body.url !== "string" || !body.url)) return json(res, 400, { ...userError("serverError.mcp.addressAsText") });
        const current = server(name);
        if (!current || !isRemoteMcpServer(current) || (body?.url !== undefined && current.url !== body.url)) return json(res, 409, { ...userError("serverError.mcp.addressChanged") });
        const headerKeys = Object.keys(current.headers);
        deps.host.people.putKey(person, email, name, { url: current.url, ...personKeyHeader(headerKeys, value) });
        return json(res, 200, { ok: true });
      }
      if (!mcp[2] && method === "DELETE") {
        await deps.host.people.oauth(person).signOut(name, stored.url);
        deps.host.people.deleteKey(person, name);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    return json(res, 404, { error: "not found" });
  };
}
