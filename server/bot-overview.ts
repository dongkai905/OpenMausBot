import type { BotRecord } from "./store.ts";
import { approvalModeFor } from "../shared/approval-mode.ts";

export interface BotOverview {
  who: { name: string; title: string; blurb: string; soulLead: string };
  does: string[];
  /** The departments a Chief of Staff may also coordinate, "" for the unnamed department the English line calls "General". */
  managedSections?: string[];
  reaches: string[];
  wont: string[];
  recent: Array<{ at: number; summary: string }>;
  grants?: BotOverviewGrant[];
  setup: SetupStep[];
}

export interface BotOverviewGrant {
  slug: string;
  level: "all" | "partial" | "none";
  /** Granted tool count; 0 unless level is "partial". */
  toolCount: number;
}

export type SetupStepId = "identity" | "soul" | "folder" | "apps";
export type SetupStepSection = "identity" | "soul" | "access";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  done: boolean;
  section?: SetupStepSection;
}

export interface OverviewFacts {
  bot: Pick<
    BotRecord,
    | "name"
    | "title"
    | "description"
    | "soul"
    | "computer"
    | "cloudBackend"
    | "cwd"
    | "autoApprove"
    | "approvalMode"
    | "composio"
    | "connectorTools"
    | "browser"
    | "chiefOfStaff"
    | "managedSections"
  >;
  skills: Array<{ name: string; description: string; enabled: boolean }>;
  engine: { agentsMcp?: boolean; composioMcp?: boolean; browserMcp?: boolean; computerMcp?: boolean } | null;
  browserEnabled?: boolean;
  cloudHome?: boolean;
  connectedApps: { configured: boolean; authoritative: boolean; services: string[] };
  sectionPeers: number;
  timeZone: string;
  recent: Array<{ at: number; summary: string }>;
}

export function soulLead(soul: string | undefined): string {
  const trimmed = (soul ?? "").trim();
  if (!trimmed) return "";
  const paragraph = (trimmed.split(/\r?\n\s*\r?\n/)[0] ?? trimmed).trim();
  return paragraph.length > 240 ? `${paragraph.slice(0, 240).trimEnd()}…` : paragraph;
}

function lowerFirst(value: string): string {
  return value.length ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function doesLines(facts: OverviewFacts): string[] {
  const lines: string[] = [];
  for (const skill of facts.skills) {
    if (!skill.enabled) continue;
    lines.push(`Knows how to ${lowerFirst(skill.description || skill.name)}.`);
  }
  return lines;
}

export async function connectedAppsFacts(
  configured: boolean,
  availability: "configured" | "unconfigured" | "unreadable",
  read: () => Promise<Record<string, { connected: boolean }>>,
): Promise<OverviewFacts["connectedApps"]> {
  let authoritative = availability !== "unreadable";
  let services: string[] = [];
  if (configured && authoritative) {
    try {
      services = Object.entries(await read())
        .filter(([, state]) => state.connected)
        .map(([slug]) => slug);
    } catch {
      authoritative = false;
    }
  }
  return { configured, authoritative, services };
}

function couldUseApps(facts: OverviewFacts): boolean {
  return facts.bot.composio !== false && facts.connectedApps.configured && Boolean(facts.engine?.composioMcp);
}

export function grantsSummary(connectorTools: BotRecord["connectorTools"]): BotOverviewGrant[] | undefined {
  if (connectorTools === undefined) return undefined;
  return Object.entries(connectorTools)
    .map(([slug, grant]): BotOverviewGrant => {
      if (grant.tools === "*") return { slug, level: "all", toolCount: 0 };
      if (grant.tools.length > 0) return { slug, level: "partial", toolCount: grant.tools.length };
      return { slug, level: "none", toolCount: 0 };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

function computerReach(computer: BotRecord["computer"], cloudHome = false): string | null {
  const unavailable = cloudHome ? ", which isn't available on My Cloud" : "";
  switch (computer) {
    case "cloud":
      return "Computer preference: cloud computer.";
    case "vm":
      return `Computer preference: Local VM${unavailable}.`;
    case "local":
      return `Computer preference: this computer${unavailable}.`;
    case "browser":
      return "Computer preference: browser only.";
    case "off":
      return null;
    default:
      return "Computer preference: Auto; availability is checked when a task starts.";
  }
}

function reachesLines(facts: OverviewFacts): string[] {
  const lines: string[] = [];
  const computer = computerReach(facts.bot.computer, facts.cloudHome);
  if (computer) lines.push(computer);
  lines.push(facts.bot.cwd ? `Works in ${facts.bot.cwd}.` : "Works in its private workspace.");
  const apps = facts.connectedApps;
  if (couldUseApps(facts) && apps.authoritative && apps.services.length > 0) {
    const count = apps.services.length;
    lines.push(`Can use ${count} connected app${count === 1 ? "" : "s"}: ${apps.services.join(", ")}.`);
  } else if (couldUseApps(facts) && !apps.authoritative) {
    lines.push("Connected apps could not be checked.");
  }
  if (facts.browserEnabled && facts.engine?.browserMcp && facts.bot.browser !== false && facts.bot.computer !== "off") lines.push("Has the built-in browser.");
  const peers = facts.sectionPeers;
  if (facts.engine?.agentsMcp && peers > 0) lines.push(peers === 1 ? "Can talk to the other bot." : `Can talk to all ${peers} other bots, in any department.`);
  if (facts.bot.chiefOfStaff) lines.push("Coordinates its department as Chief of Staff.");
  if (facts.bot.chiefOfStaff && facts.bot.managedSections?.length) {
    lines.push(`Also in charge of these departments: ${facts.bot.managedSections.map(name => name || "General").join(", ")}.`);
  }
  return lines;
}

function wontLines(facts: OverviewFacts): string[] {
  const lines: string[] = [];
  const mode = approvalModeFor(facts.bot);
  if (mode === "ask") lines.push("Command approvals use Ask mode; saved permissions and provider rules still apply.");
  if (mode === "custom") lines.push("Command approvals follow the provider's custom configuration.");
  if (!couldUseApps(facts) || (facts.connectedApps.authoritative && facts.connectedApps.services.length === 0)) {
    lines.push("Has no connected apps.");
  }
  if (facts.bot.computer === "off") lines.push("Can't use a computer.");
  if (mode !== "full") lines.push("Profile proposal cards require your approval.");
  return lines;
}

export function buildBotOverview(facts: OverviewFacts): BotOverview {
  return {
    who: {
      name: facts.bot.name,
      title: facts.bot.title,
      blurb: facts.bot.description,
      soulLead: soulLead(facts.bot.soul),
    },
    does: doesLines(facts),
    ...(facts.bot.chiefOfStaff && facts.bot.managedSections?.length ? { managedSections: [...facts.bot.managedSections] } : {}),
    reaches: reachesLines(facts),
    wont: wontLines(facts),
    recent: facts.recent,
    grants: grantsSummary(facts.bot.connectorTools),
    setup: setupSteps(facts),
  };
}

const DEFAULT_BOT_NAMES = /^(new bot|bot|untitled)(\s*\d+)?$/i;

export function setupSteps(facts: OverviewFacts): SetupStep[] {
  const named = facts.bot.name.trim() !== "" && !DEFAULT_BOT_NAMES.test(facts.bot.name.trim());
  const described = facts.bot.title.trim() !== "" || facts.bot.description.trim() !== "";
  const apps = facts.connectedApps;
  const steps: SetupStep[] = [
    { id: "identity", label: "Give it a name and a role", done: named && described, section: "identity" },
    { id: "soul", label: "Write its standing instructions", done: (facts.bot.soul ?? "").trim() !== "", section: "soul" },
    { id: "folder", label: "Choose a working folder", done: Boolean(facts.bot.cwd), section: "access" },
  ];
  if (couldUseApps(facts)) {
    steps.push({
      id: "apps",
      label: "Connect the apps it needs",
      done: apps.authoritative && apps.services.length > 0,
      section: "access",
    });
  }
  return steps;
}
