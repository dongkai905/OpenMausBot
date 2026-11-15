// Where a bot works, said once: one plain line and at most one next action for
// every state a place can be in. The server words a failed turn's row from it
// in English; the app renders the same state in the person's language. The
// English mirrors src/locales/en.json `place.*` exactly (a test holds them
// together): the server has no i18n.

export type Place = "cloud" | "vm" | "local" | "browser";

/** Every state a place can be in. */
export const PLACE_STATES = [
  "auto", "auto-team", "vps",
  "browser", "browser-off", "browser-cannot",
  "local", "local-unavailable", "vm", "vm-cannot", "place-failed",
  "off",
] as const;
export type PlaceState = (typeof PLACE_STATES)[number];

/** Where a failed place came from: the one control a person changes when it
 * can't be used. A routine and a room member are their own sources; Auto and
 * a team's shared computer name no place, so they never fail as one. */
export type PlaceSource = "works-on" | "pin" | "auto-pin" | "routine" | "room";

/** The next actions a place offers. Each is one button in the app and, on a
 * stored row, one sentence a phone can read. */
export const PLACE_ACTIONS = [
  "choose-model", "open-tools", "sign-in", "start", "wake", "watch", "see-plan", "manage-computers",
  "try-again", "open-my-cloud", "turn-on-browser", "open-team-map", "open-vm-settings",
  "clear-pin", "change-routine", "open-computer-panel",
] as const;
export type PlaceActionId = (typeof PLACE_ACTIONS)[number];

/** What a failed-turn row stores about its place, beside its English words,
 * so the app can word it again in the reader's language. */
export interface PlaceRow {
  state: PlaceState;
  params: PlaceParams;
  source: PlaceSource;
}

export interface PlaceParams {
  bot?: string;
  model?: string;
  engine?: string;
  computer?: string;
  reason?: string;
  cause?: string;
  /** A list of names a line lists, joined the way the reader's language lists them. */
  holders?: string[];
}

export interface PlaceAction {
  id: PlaceActionId;
  label: string;
}

export interface PlaceView {
  state: PlaceState;
  params: PlaceParams;
  /** A few words for a card, a grid tile or a chip row. */
  short: string;
  /** The one plain message. */
  line: string;
  action: PlaceAction | null;
}

/** Where this server runs, as the Auto line describes it. */
export type ServerKind = "my-cloud" | "mac" | "pc" | "linux" | "remote";

/** The facts a place's state is read from. */
export interface PlaceFacts {
  /** The place to describe: Auto, Off, or one of the four places. */
  place: Place | "auto" | "off";
  server: ServerKind;
  bot: string;
  engine: {
    name: string;
    model?: string;
    /** It can use computer tools. */
    computer: boolean;
    /** It can use the built-in browser. */
    browser: boolean;
  };
  /** The built-in browser is switched on for this installation and bot. */
  browserOn: boolean;
  role: "admin" | "user";
  mode?: "simple" | "advanced";
  /** This computer can be picked; `reason` says why not. */
  local?: { ready: boolean; reason?: string };
  /** Auto uses a team's shared computer by this name. */
  teamComputer?: string;
}

/** The English catalog, mirrored by en.json. */
export const PLACE_EN = {
  "place.view.auto.short": "Chooses for you",
  "place.view.auto.lineMyCloud": "Uses the built-in browser. In a chat, it starts its cloud desktop by itself when a task needs desktop apps.",
  "place.view.auto.lineDesktop": "Uses the built-in browser, a private desktop on this computer, or this computer's screen, whichever the task needs.",
  "place.view.auto.lineLinux": "Uses the built-in browser, or a running private desktop when a task needs one.",
  "place.view.autoTeam.short": "Shared",
  "place.view.autoTeam.line": "Uses {computer}, the cloud desktop this department shares.",
  "place.view.vps.short": "Your own machine",
  "place.view.vps.line": "Uses your own Linux machine, connected over SSH.",
  "place.view.browser.short": "Web pages only",
  "place.view.browser.line": "Works in the built-in browser only: web pages, no desktop apps.",
  "place.view.browserOff.short": "Switched off",
  "place.view.browserOff.line": "The bot's own browser is switched off, so it can't open web pages.",
  "place.view.browserCannot.short": "Not with this model",
  "place.view.browserCannot.line": "{model} can't use the built-in browser.",
  "place.view.local.short": "Your screen",
  "place.view.local.line": "Uses your screen, mouse, and keyboard.",
  "place.view.localUnavailable.short": "Can't use it yet",
  "place.view.localUnavailable.line": "{reason}",
  "place.view.vm.short": "Separate from your screen",
  "place.view.vm.line": "A private Linux desktop on this device, separate from your own screen.",
  "place.view.vmCannot.short": "Not with this model",
  "place.view.vmCannot.line": "{model} can't use a private desktop. Choose a model that can, such as Claude or ChatGPT.",
  "place.view.placeFailed.short": "Didn't start",
  "place.view.placeFailed.line": "{cause}",
  "place.view.off.short": "No screen",
  "place.view.off.line": "{bot} has no screen. It can still chat and do anything that doesn't need one.",
  "place.action.chooseModel": "Choose a model",
  "place.action.openTools": "Change what {bot} can use",
  "place.action.signIn": "Sign in",
  "place.action.start": "Start it now",
  "place.action.wake": "Wake it now",
  "place.action.watch": "Watch",
  "place.action.seePlan": "See your plan",
  "place.action.manageComputers": "Manage cloud desktops",
  "place.action.tryAgain": "Try again",
  "place.action.openMyCloud": "Open the Cloud",
  "place.action.turnOnBrowser": "Turn on the browser",
  "place.action.openTeamMap": "Open Team map",
  "place.action.openVmSettings": "Private desktop settings",
  "place.action.clearPin": "Clear this conversation's place",
  "place.action.usePlace": "Use {place}",
  "place.action.changeRoutine": "Change where it runs",
  "place.action.openComputerPanel": "Open the Screen panel",
  "place.askAdmin": "Ask an Admin to change it.",
  "place.backOnAuto": "This conversation is back on Auto.",
} as const;
export type PlaceKey = keyof typeof PLACE_EN;

/** A stored row's next action as one English sentence: what a phone, which
 * shows only the row's words, reads instead of a button. English only, like
 * the row it ends. */
export const PLACE_WORDS: Record<PlaceActionId, string> = {
  "choose-model": "Choose another model in {bot}'s settings.",
  "open-tools": "Change what {bot} can use in its settings.",
  "sign-in": "Sign in to {engine} in Settings.",
  start: "Start it from the Screen panel.",
  wake: "Wake it from the Screen panel.",
  watch: "Watch it from the Screen panel.",
  "see-plan": "See your plan on the Plan page.",
  "manage-computers": "Manage your cloud desktops in Settings → Bot desktops.",
  "try-again": "Try again.",
  "open-my-cloud": "Open My Cloud from the menu at the top of the sidebar.",
  "turn-on-browser": "Turn on the built-in browser in the Screen panel.",
  "open-team-map": "Open Team map to manage it.",
  "open-vm-settings": "Check it in Settings → Bot desktops.",
  "clear-pin": "Clear this conversation's place in the composer to continue.",
  "change-routine": "Change where this routine runs.",
  "open-computer-panel": "Check it in the Screen panel.",
};

/** The words a person reads, in some language: the app passes its t(), the
 * server the English mirror. */
export type PlaceTranslate = (key: PlaceKey, params?: Record<string, string | number>) => string;

function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

export const english: PlaceTranslate = (key, params) => fill(PLACE_EN[key], params);

/** Each state's key segment, short and line keys, and own action. */
const STATE: Record<PlaceState, { key: string; action: PlaceActionId | null }> = {
  auto: { key: "auto", action: null },
  "auto-team": { key: "autoTeam", action: "open-team-map" },
  vps: { key: "vps", action: null },
  browser: { key: "browser", action: null },
  "browser-off": { key: "browserOff", action: "turn-on-browser" },
  "browser-cannot": { key: "browserCannot", action: "choose-model" },
  local: { key: "local", action: null },
  "local-unavailable": { key: "localUnavailable", action: null },
  vm: { key: "vm", action: "open-vm-settings" },
  "vm-cannot": { key: "vmCannot", action: "choose-model" },
  "place-failed": { key: "placeFailed", action: "open-computer-panel" },
  off: { key: "off", action: null },
};

/** A passing cause: nothing to fix, so where the place came from decides the
 * way on (sourceAction). Every other state's action removes its cause. */
const PASSING: ReadonlySet<PlaceState> = new Set(["place-failed"]);

/** Actions that change a setting, a sign-in or the plan: a User can't take
 * them, so the line ends "Ask an Admin to change it." instead. */
const ADMIN_ONLY: ReadonlySet<PlaceActionId> = new Set([
  "choose-model", "open-tools", "sign-in", "see-plan", "manage-computers", "open-my-cloud",
  "turn-on-browser", "open-team-map", "open-vm-settings", "change-routine",
]);

const ACTION_KEY: Record<PlaceActionId, PlaceKey> = {
  "choose-model": "place.action.chooseModel",
  "open-tools": "place.action.openTools",
  "sign-in": "place.action.signIn",
  start: "place.action.start",
  wake: "place.action.wake",
  watch: "place.action.watch",
  "see-plan": "place.action.seePlan",
  "manage-computers": "place.action.manageComputers",
  "try-again": "place.action.tryAgain",
  "open-my-cloud": "place.action.openMyCloud",
  "turn-on-browser": "place.action.turnOnBrowser",
  "open-team-map": "place.action.openTeamMap",
  "open-vm-settings": "place.action.openVmSettings",
  "clear-pin": "place.action.clearPin",
  "change-routine": "place.action.changeRoutine",
  "open-computer-panel": "place.action.openComputerPanel",
};

export function placeState(facts: PlaceFacts): { state: PlaceState; params: PlaceParams } {
  const bot = facts.bot;
  const model = facts.engine.model || facts.engine.name;
  if (facts.place === "off") return { state: "off", params: { bot } };
  if (facts.place === "auto") {
    return facts.teamComputer
      ? { state: "auto-team", params: { bot, computer: facts.teamComputer } }
      : { state: "auto", params: { bot } };
  }
  if (facts.place === "browser") {
    if (!facts.engine.browser) return { state: "browser-cannot", params: { bot, model } };
    return facts.browserOn ? { state: "browser", params: { bot } } : { state: "browser-off", params: { bot } };
  }
  if (facts.place === "local") {
    return facts.local?.ready === false
      ? { state: "local-unavailable", params: { bot, reason: facts.local.reason ?? "" } }
      : { state: "local", params: { bot } };
  }
  if (facts.place === "vm") {
    return facts.engine.computer ? { state: "vm", params: { bot } } : { state: "vm-cannot", params: { bot, model } };
  }
  // The cloud desktop is the person's own machine now. A model that cannot
  // drive a desktop cannot use that one either, so it says the same thing the
  // private desktop does: no other desktop wording is left.
  if (!facts.engine.computer) return { state: "vm-cannot", params: { bot, model } };
  return { state: "vps", params: { bot } };
}

/** Where the person goes when a passing cause stops a place: try again in
 * place, clear the pin that holds this conversation, change where the
 * routine runs. A room member's turn has no retry of its own. */
function sourceAction(source: PlaceSource, state: PlaceState): PlaceActionId | null {
  switch (source) {
    case "works-on": return state === "place-failed" ? "open-computer-panel" : "try-again";
    case "auto-pin": return "try-again";
    case "pin": return "clear-pin";
    case "routine": return "change-routine";
    case "room": return null;
  }
}

function lineKey(state: PlaceState, server?: ServerKind): PlaceKey {
  const segment = STATE[state].key;
  if (state === "auto") {
    return server === "my-cloud" ? "place.view.auto.lineMyCloud" : server === "linux" || server === "remote" ? "place.view.auto.lineLinux" : "place.view.auto.lineDesktop";
  }
  return `place.view.${segment}.line` as PlaceKey;
}

/** Join names the way a sentence lists them, in the reader's language. */
export function listNames(names: readonly string[], locale = "en"): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

function templateParams(params: PlaceParams, locale: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? listNames(value, locale) : value;
  }
  return out;
}

export interface PlaceContext {
  server?: ServerKind;
  role: "admin" | "user";
  mode?: "simple" | "advanced";
  source?: PlaceSource;
  /** Simple mode words a pin's way back as "Use {place}", the grid's own label. */
  worksOnLabel?: string;
  translate?: PlaceTranslate;
  locale?: string;
}

/** One state, worded: its short label, its one line and its one action. */
export function placeViewOf(state: PlaceState, params: PlaceParams, context: PlaceContext): PlaceView {
  const translate = context.translate ?? english;
  const values = templateParams(params, context.locale ?? "en");
  const segment = STATE[state].key;
  let line = translate(lineKey(state, context.server), values);
  let action: PlaceActionId | null = context.source && PASSING.has(state) ? sourceAction(context.source, state) : STATE[state].action;
  if (context.source === "auto-pin") line = `${line} ${translate("place.backOnAuto")}`;
  // Simple mode leaves Local VM setup to Advanced.
  if (action === "open-vm-settings" && context.mode === "simple") action = null;
  if (action && context.role === "user" && ADMIN_ONLY.has(action)) {
    action = null;
    line = `${line} ${translate("place.askAdmin")}`;
  }
  // Simple mode has no composer chip, so a pin's way back is the grid's
  // choice, by the grid's own name for it.
  const label = !action ? null
    : action === "clear-pin" && context.mode === "simple" && context.worksOnLabel
      ? translate("place.action.usePlace", { place: context.worksOnLabel })
      : translate(ACTION_KEY[action], values);
  return {
    state,
    params,
    short: translate(`place.view.${segment}.short` as PlaceKey, values),
    line,
    action: action && label ? { id: action, label } : null,
  };
}

/** The view of a place from its facts. */
export function placeView(facts: PlaceFacts, options: { translate?: PlaceTranslate; locale?: string } = {}): PlaceView {
  const { state, params } = placeState(facts);
  return placeViewOf(state, params, { server: facts.server, role: facts.role, mode: facts.mode, ...options });
}

/** A stored failed-turn row, worded for this reader. */
export function placeRowView(row: PlaceRow, context: Omit<PlaceContext, "source">): PlaceView {
  return placeViewOf(row.state, row.params, { ...context, source: row.source });
}

/** What the server stores as the row's words: the line and its action as a
 * sentence, in English, so a phone that reads only the words knows both. */
export function placeRowText(row: PlaceRow, server?: ServerKind): string {
  const view = placeViewOf(row.state, row.params, { server, role: "admin", source: row.source });
  if (!view.action) return view.line;
  const words = row.source === "auto-pin" && view.action.id === "try-again"
    ? "Send your message again."
    : fill(PLACE_WORDS[view.action.id], templateParams(row.params, "en"));
  return `${view.line} ${words}`;
}
