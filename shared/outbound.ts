// Outbound actions: calls that reach a person outside the app or move money.
// Below Full access they get their own confirmation unless the bot's rule sends
// without asking; at Full access they run unless the bot has a rule of its own.
// A read-and-draft routine run never reaches them: the relay refuses every send
// there. Shared by the harness (which enforces it) and the app.
export type OutboundPolicy = {
  /** ask: every outbound call waits for a tap. allow: outbound calls go out without asking. */
  policy: "ask" | "allow";
};

/** Tools whose action is one of these words send something somewhere. */
const SEND_VERBS = new Set([
  "SEND",
  "SENDS",
  "REPLY",
  "RESPOND",
  "FORWARD",
  "POST",
  "PUBLISH",
  "TWEET",
  "RETWEET",
  "BROADCAST",
  "INVITE",
  "SHARE",
  "REFUND",
  "CHARGE",
  "PAY",
  "PAYOUT",
  "TRANSFER",
  "BUY",
  "PURCHASE",
  "DIAL",
]);

/** Creating one of these is sending it: a created comment is a comment
 * someone reads, a created invoice is one someone receives, a created call rings someone. */
const CREATE_VERBS = new Set(["CREATE", "CREATION", "ADD", "NEW", "MAKE"]);
const SENT_NOUNS = new Set(["MESSAGE", "COMMENT", "POST", "EMAIL", "MAIL", "INVOICE", "PAYMENT", "REFUND", "REPLY", "TWEET", "DM", "CALL"]);

/** Telnyx's hosted server reaches its whole API through one tool, so any call of it may ring, text or buy. */
const RAW_API_ACTION = /^mcp__.+__invoke_api_endpoint$/;

/** A read verb first means the rest of the name is what is being read:
 * REDDIT_GET_POST fetches a post, it does not post. */
const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

/** The action part of a tool name, as upper-case word tokens. An app's
 * TOOLKIT_ACTION drops its toolkit; an MCP server's mcp__server__action
 * drops its server; a bare built-in like Bash stays as it is. */
function actionTokens(name: string): string[] {
  let action = name;
  if (name.startsWith("mcp__")) {
    const [, , ...rest] = name.split("__");
    action = rest.join("_");
  } else if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) {
    action = name.slice(name.indexOf("_") + 1);
  }
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Does the tool name describe a read-only action? This is deliberately
 * narrower than "not outbound": updates, deletes and other writes do not
 * become reads merely because they send nothing to another person. */
export function isReadOnlyTool(name: string): boolean {
  const tokens = actionTokens(name);
  return tokens.length > 0 && READ_VERBS.has(tokens[0]);
}

/** The built-in agents server's X research tools only read X: x_post reads a post, it does not post one. */
const AGENTS_X_READS = /^(?:mcp__agents__|agents__|agents_)?x_(?:search|user_posts|post|profile)$/;

/** Does this tool send something to someone, or move money? */
export function isOutboundTool(name: string): boolean {
  // A raw API call from the workbench can do anything an app tool can, and
  // nothing here can read which; it is treated as a send.
  if (RAW_API_ACTION.test(name)) return true;
  if (AGENTS_X_READS.test(name)) return false;
  const tokens = actionTokens(name);
  if (tokens.length === 0) return false;
  if (isReadOnlyTool(name)) return false;
  if (tokens.some((token) => SEND_VERBS.has(token))) return true;
  if (tokens.includes("DRAFT")) return false;
  return tokens.some((token) => CREATE_VERBS.has(token)) && tokens.some((token) => SENT_NOUNS.has(token));
}

/** The stored shape, or null when the value is not one. Fields other than `policy` are dropped. */
export function normalizeOutboundPolicy(value: unknown): OutboundPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { policy } = value as { policy?: unknown };
  return policy === "ask" || policy === "allow" ? { policy } : null;
}

/** What a bot without a stored policy does: ask, every time. */
export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = { policy: "ask" };

/** Drops from a stored bot's rule what `normalizeOutboundPolicy` drops, so every copy of one rule reads the same; true
 * when it changed. A rule that is not one is left as it is, and asks. */
export function trimOutboundPolicy(bot: { outbound?: OutboundPolicy }): boolean {
  const kept = bot.outbound && normalizeOutboundPolicy(bot.outbound);
  if (!kept || Object.keys(bot.outbound!).length === Object.keys(kept).length) return false;
  bot.outbound = kept;
  return true;
}

/** One app tool a connector request would run, with its arguments when the
 * request carries them. */
export interface ConnectorCall {
  slug: string;
  arguments?: unknown;
}

/** The app tools one call ran. A call that names no tool counts once, by its own name. */
export function connectorCallsIn(name: string, args: unknown): ConnectorCall[] {
  return [{ slug: name, ...(args !== undefined ? { arguments: args } : {}) }];
}

/** The subset of a request's app tools that would send something. */
export function outboundCallsIn(name: string, args: unknown): ConnectorCall[] {
  return connectorCallsIn(name, args).filter((call) => isOutboundTool(call.slug));
}
