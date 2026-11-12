// Where a person enters the one-time code that signs an engine's CLI in on
// the machine running OpenMausBot (`codex login --device-auth`, `grok login
// --device-auth`, `kimi login`), or, for a CLI that prints no code (`cursor-agent
// login`), the one link that finishes its sign-in. The server reads the page and
// the code from the CLI's output with these rules, and the app checks them again
// before it shows a link. Neither ever turns arbitrary output into a link, or lets
// a token ride along in one.

export type DeviceSignInProvider = "codex" | "grok" | "kimi" | "cursor";


/** An https page on one of the provider's hosts, with no login, port or fragment. */
function providerPage(value: string, hosts: RegExp): URL | null {
  if (!/^https:\/\/[^\s#]+$/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return url.username || url.password || url.port || !hosts.test(url.hostname) ? null : url;
}

const RULES: Record<string, { code?: RegExp; page?: string }> = {};

/** Whether this provider's CLI prints a code to enter, or only a link that finishes the sign-in. */
export function deviceSignInHasCode(provider: DeviceSignInProvider): boolean {
  return RULES[provider].code !== null;
}

/** The provider's own page for entering `userCode`, or null for anything
 * else. A code carried in the page's link must be that same code. */
export function deviceSignInLink(provider: DeviceSignInProvider, value: string | null | undefined, userCode?: string): string | null {
  const page = value ? RULES[provider].page(value) : null;
  if (!page) return null;
  if (!deviceSignInHasCode(provider)) return userCode === undefined ? page : null;
  return [...new URL(page).searchParams.values()].every((carried) => carried === userCode) ? page : null;
}

/** A one-time code as this provider formats it. */
export function isDeviceSignInCode(provider: DeviceSignInProvider, value: string | null | undefined): value is string {
  const code = RULES[provider].code;
  return typeof value === "string" && code !== null && code.test(value);
}

/** The newest page and code from a CLI's output, once both lines have
 * arrived whole: output arrives in chunks that may stop halfway through a
 * code, so the last, unfinished line is never read. A CLI can print a new
 * pair when its code expires (kimi-code 2.4.1 does). `text` is already free
 * of terminal styling. */
export function deviceSignInPrompt(provider: DeviceSignInProvider, text: string): { authorizationUrl: string; userCode?: string } | null {
  const { page, label } = RULES[provider];
  const lines = text.split(/\r?\n/).slice(0, -1).map((line) => (label ? line.trim().replace(label, "") : line.trim()));
  let prompt: { authorizationUrl: string; userCode?: string } | null = null;
  for (const [at, line] of lines.entries()) {
    if (page(line) === null) continue;
    if (!deviceSignInHasCode(provider)) {
      prompt = { authorizationUrl: page(line)! };
      continue;
    }
    const userCode = lines.slice(at + 1).map((next) => next.replace(/^code:\s*/i, "")).find((next) => isDeviceSignInCode(provider, next));
    const authorizationUrl = userCode ? deviceSignInLink(provider, line, userCode) : null;
    if (authorizationUrl && userCode) prompt = { authorizationUrl, userCode };
  }
  return prompt;
}
