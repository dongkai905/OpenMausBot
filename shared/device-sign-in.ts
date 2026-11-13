// Where a person enters the one-time code that signs an engine's CLI in on
// the machine running OpenMausBot, or, for a CLI that prints no code, the one
// link that finishes its sign-in. The server reads the page and the code from
// the CLI's output with these rules, and the app checks them again before it
// shows a link. Neither ever turns arbitrary output into a link, or lets a token
// ride along in one.

/** The CLI whose sign-in this is. */
export type DeviceSignInProvider = string;

/** What one CLI's own sign-in looks like. */
interface DeviceSignInRule {
  /** The one-time code, as this CLI prints it. */
  code?: RegExp | null;
  /** The CLI's own sign-in page, from the address its output printed. */
  page?: (value: string) => URL | null;
  /** The label its output prints before the page. */
  label?: string;
}

const RULES: Record<string, DeviceSignInRule> = {};

/** Whether this provider's CLI prints a code to enter, or only a link that finishes the sign-in. */
export function deviceSignInHasCode(provider: DeviceSignInProvider): boolean {
  return RULES[provider]?.code != null;
}

/** The provider's own page for entering `userCode`, or null for anything
 * else. A code carried in the page's link must be that same code. */
export function deviceSignInLink(provider: DeviceSignInProvider, value: string | null | undefined, userCode?: string): string | null {
  const page = value ? RULES[provider]?.page?.(value) : null;
  if (!page) return null;
  const link = page.toString();
  if (!deviceSignInHasCode(provider)) return userCode === undefined ? link : null;
  return [...page.searchParams.values()].every((carried) => carried === userCode) ? link : null;
}

/** A one-time code as this provider formats it. */
export function isDeviceSignInCode(provider: DeviceSignInProvider, value: string | null | undefined): value is string {
  const code = RULES[provider]?.code;
  return typeof value === "string" && code != null && code.test(value);
}

/** The newest page and code from a CLI's output, once both lines have
 * arrived whole: output arrives in chunks that may stop halfway through a
 * code, so the last, unfinished line is never read. A CLI can print a new
 * pair when its code expires. `text` is already free of terminal styling. */
export function deviceSignInPrompt(provider: DeviceSignInProvider, text: string): { authorizationUrl: string; userCode?: string } | null {
  const rule = RULES[provider];
  const page = rule?.page;
  if (!page) return null;
  const label = rule.label;
  const lines = text.split(/\r?\n/).slice(0, -1).map((line) => (label ? line.trim().replace(label, "") : line.trim()));
  let prompt: { authorizationUrl: string; userCode?: string } | null = null;
  for (const [at, line] of lines.entries()) {
    if (page(line) === null) continue;
    if (!deviceSignInHasCode(provider)) {
      prompt = { authorizationUrl: page(line)!.toString() };
      continue;
    }
    const userCode = lines.slice(at + 1).map((next) => next.replace(/^code:\s*/i, "")).find((next) => isDeviceSignInCode(provider, next));
    const authorizationUrl = userCode ? deviceSignInLink(provider, line, userCode) : null;
    if (authorizationUrl && userCode) prompt = { authorizationUrl, userCode };
  }
  return prompt;
}
