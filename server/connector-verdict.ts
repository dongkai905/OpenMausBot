// The verdict for an app tool call: which of the tools it names this bot may run, judged from the bot's per-app grants.
// Unrecognized argument shapes are denied: "this bot may call exactly these tools" must hold even against a model that
// garbles the protocol.
import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/wire.ts";
import { EMAIL_SLUG } from "../shared/email.ts";

export type ConnectorCall =
  | { kind: "passthrough" }
  | { kind: "tools"; invoked: string; names: string[] }
  | { kind: "unrecognized"; invoked: string; reason: string };

export interface ConnectorDenial {
  tool: string;
  /** null when the name carries no service prefix at all. */
  service: string | null;
  /** the service is granted but the exact tool is not on its list. */
  onGrantedService: boolean;
}

export interface ConnectorVerdict {
  allowed: boolean;
  legacy: boolean;
  denials: ConnectorDenial[];
  rule: string;
}

/** An app's upper-snake prefix before the first underscore, lowercased (EMAIL_SEND_MESSAGE → email); no underscore, no service. */
export function serviceSlugFor(tool: string): string | null {
  const underscore = tool.indexOf("_");
  if (underscore <= 0) return null;
  return tool.slice(0, underscore).toLowerCase();
}

/** Real slugs may contain underscores (bland_ai), so the longest matching candidate wins over the plain split. */
export function serviceSlugForCandidates(tool: string, candidates: readonly string[]): string | null {
  let match: string | null = null;
  for (const candidate of candidates) {
    if (tool.startsWith(candidate.toUpperCase() + "_") && (match === null || candidate.length > match.length)) {
      match = candidate;
    }
  }
  return match;
}

export function connectorCallFromFrame(payload: unknown): ConnectorCall {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "passthrough" };
  const frame = payload as { method?: unknown; params?: unknown };
  if (frame.method !== "tools/call") return { kind: "passthrough" };
  const params = frame.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { kind: "unrecognized", invoked: "tools/call", reason: "the call carried no params object" };
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string" || !name) {
    return { kind: "unrecognized", invoked: "tools/call", reason: "the call named no tool" };
  }
  if (!CONNECTOR_TOOL_NAME_PATTERN.test(name)) {
    return { kind: "unrecognized", invoked: name, reason: "the tool name is not an app tool name" };
  }
  return { kind: "tools", invoked: name, names: [name] };
}

/** No record is the legacy all-tools bot; a record, even empty, allows only what it names. Service keys are own properties
 * only, so CONSTRUCTOR_X never matches an inherited property. Empty `candidates` (no app list at hand) degrades open. */
export function evaluateConnectorTools(
  names: string[],
  grants: Record<string, ConnectorToolGrant> | undefined,
  candidates: readonly string[] = [],
): ConnectorVerdict {
  if (grants === undefined) {
    return { allowed: true, legacy: true, denials: [], rule: "apps" };
  }
  const denials: ConnectorDenial[] = [];
  let rule = "";
  for (const tool of new Set(names)) {
    const service = serviceSlugForCandidates(tool, candidates) ?? serviceSlugFor(tool);
    const grant = service !== null && Object.hasOwn(grants, service)
      ? grants[service]
      : undefined;
    if (grant && (grant.tools === "*" || grant.tools.includes(tool))) {
      if (!rule) rule = "connectorTools." + service;
      continue;
    }
    denials.push({ tool, service, onGrantedService: Boolean(grant) });
  }
  return { allowed: denials.length === 0, legacy: false, denials, rule };
}

/** Never lists what the bot could have called instead: enumerating adjacent grants teaches the model to probe. */
export function connectorRefusalText(denials: ConnectorDenial[]): string {
  const named = denials.map((denial) => '"' + denial.tool + '"').join(", ");
  const one = denials.length === 1;
  return [
    named + " " + (one ? "is" : "are") + " not granted to this bot.",
    "This call was not performed.",
    "Ask the person to grant " + (one ? "it" : "these tools") + " in OpenMausBot if they want " + (one ? "it" : "them") + " run.",
  ].join(" ");
}

export function connectorUnrecognizedText(invoked: string, reason: string): string {
  return [
    "A " + invoked + " call arrived in a shape OpenMausBot could not read (" + reason + "), so it was not performed.",
    "Send a well-formed call that names the tools to execute.",
    "Ask the person to grant any tool this bot needs.",
  ].join(" ");
}

export function connectorScopeRefusalText(call: ConnectorCall, reason: "app" | "write", bot: string, app: string, tool: string): string {
  if (call.kind === "unrecognized") return connectorUnrecognizedText(call.invoked, call.reason);
  return reason === "app"
    ? `OpenMausBot did not run this: ${bot} has not been given access to ${app}. Ask the user to allow it under the bot's Access settings, and do not retry.`
    : `OpenMausBot did not run this: ${app} is read-only for ${bot}, and ${tool} would write to it. Ask the user before trying again.`;
}

/** Connected-app services a connectorTools grant names. The built-in Email app is never in the connected-apps inventory or
 * catalog; its own tools check its grant when called. */
export function connectedAppGrantSlugs(grants: Record<string, ConnectorToolGrant>): string[] {
  return Object.keys(grants).filter((slug) => slug !== EMAIL_SLUG);
}
