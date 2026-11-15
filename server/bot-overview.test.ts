import { describe, expect, it } from "vitest";

import { buildBotOverview, grantsSummary, setupSteps, soulLead, type OverviewFacts } from "./bot-overview.ts";

function baseFacts(overrides: Partial<OverviewFacts> = {}): OverviewFacts {
  return {
    bot: {
      name: "Kiwi",
      title: "Tracker",
      description: "Files bugs.",
      soul: "",
      computer: "off",
      cloudBackend: undefined,
      cwd: undefined,
      autoApprove: false,
      apps: undefined,
      browser: undefined,
      chiefOfStaff: undefined,
    },
    skills: [],
    engine: null,
    sectionPeers: 0,
    timeZone: "UTC",
    recent: [],
    ...overrides,
  };
}

const WONT_ORDER = [
  "Command approvals use Ask mode; saved permissions and provider rules still apply.",
  "Can't use a computer.",
  "Profile proposal cards require your approval.",
];

describe("buildBotOverview", () => {
  it("describes additional departments only for an authorized Chief", () => {
    const facts = baseFacts({ bot: { ...baseFacts().bot, chiefOfStaff: true, managedSections: ["Engineering", "Research"] }, engine: { agentsMcp: true }, sectionPeers: 3 });
    expect(buildBotOverview(facts).reaches).toContain("Also in charge of these departments: Engineering, Research.");
    expect(buildBotOverview(facts).managedSections).toEqual(facts.bot.managedSections);
    facts.bot.chiefOfStaff = false;
    expect(buildBotOverview(facts).reaches.join(" ")).not.toContain("Engineering");
  });

  it("says a bot can talk to every other bot", () => {
    const open = baseFacts({ bot: baseFacts().bot, engine: { agentsMcp: true }, sectionPeers: 3 });
    expect(buildBotOverview(open).reaches).toContain("Can talk to all 3 other bots, in any department.");
    expect(buildBotOverview({ ...open, sectionPeers: 1 }).reaches).toContain("Can talk to the other bot.");
  });
  it("yields all wont lines in order and no does lines for a bot on Ask", () => {
    const overview = buildBotOverview(baseFacts({ bot: { ...baseFacts().bot, approvalMode: "ask" } }));
    expect(overview.wont).toEqual(WONT_ORDER);
    expect(overview.does).toEqual([]);
  });

  it("describes a fresh bot at the default level, Full access", () => {
    expect(buildBotOverview(baseFacts()).wont).toEqual(WONT_ORDER.slice(1, -1));
  });

  it("drops the first wont line when autoApprove is on", () => {
    const overview = buildBotOverview(baseFacts({ bot: { ...baseFacts().bot, autoApprove: true } }));
    expect(overview.wont).toEqual(WONT_ORDER.slice(1));
  });

  it("uses the effective approval level rather than the legacy Auto bit", () => {
    const bot = { ...baseFacts().bot, approvalMode: "full" as const, autoApprove: false };
    expect(buildBotOverview(baseFacts({ bot })).wont).not.toContain(WONT_ORDER[0]);
    expect(buildBotOverview(baseFacts({ bot: { ...bot, approvalMode: "custom" } })).wont)
      .toContain("Command approvals follow the provider's custom configuration.");
  });

  it("does not promise profile approvals in Full Access", () => {
    const bot = { ...baseFacts().bot, approvalMode: "full" as const, autoApprove: false };
    expect(buildBotOverview(baseFacts({ bot })).wont).not.toContain("Profile proposal cards require your approval.");
    for (const approvalMode of ["ask", "custom"] as const) {
      expect(buildBotOverview(baseFacts({ bot: { ...bot, approvalMode, autoApprove: true } })).wont).toContain("Profile proposal cards require your approval.");
    }
  });

  it("does not advertise a browser disabled globally or unsupported by the engine", () => {
    const facts = baseFacts({ bot: { ...baseFacts().bot, computer: "browser" }, browserEnabled: true, engine: { browserMcp: false } });
    expect(buildBotOverview(facts).reaches).not.toContain("Has the built-in browser.");
    facts.engine = { browserMcp: true };
    facts.browserEnabled = false;
    expect(buildBotOverview(facts).reaches).not.toContain("Has the built-in browser.");
    facts.browserEnabled = true;
    expect(buildBotOverview(facts).reaches).toContain("Has the built-in browser.");
  });

  it("renders enabled skills as their own does lines", () => {
    const facts = baseFacts({
      skills: [
        { name: "triage", description: "Triage incoming bug reports", enabled: true },
        { name: "disabled-skill", description: "Should not appear", enabled: false },
      ],
    });
    const overview = buildBotOverview(facts);
    expect(overview.does).toEqual([
      "Knows how to triage incoming bug reports.",
    ]);
  });

  it("picks a computer automatically when the computer is unset", () => {
    const facts = baseFacts({ bot: { ...baseFacts().bot, computer: undefined } });
    const overview = buildBotOverview(facts);
    expect(overview.reaches).toContain("Computer preference: Auto; availability is checked when a task starts.");
    expect(overview.wont).not.toContain("Can't use a computer.");
    expect(overview.wont).not.toContain("Won't contact other bots without asking.");
  });

  it("says a Cloud home cannot use this computer or a Local VM, and changes nothing elsewhere", () => {
    const reach = (computer: OverviewFacts["bot"]["computer"], cloudHome?: boolean) =>
      buildBotOverview(baseFacts({ bot: { ...baseFacts().bot, computer }, ...(cloudHome === undefined ? {} : { cloudHome }) })).reaches[0];
    expect(reach("local", true)).toBe("Computer preference: this computer, which isn't available on My Cloud.");
    expect(reach("vm", true)).toBe("Computer preference: Local VM, which isn't available on My Cloud.");
    expect(reach("cloud", true)).toBe("Computer preference: cloud computer.");
    expect(reach("browser", true)).toBe("Computer preference: browser only.");
    expect(reach(undefined, true)).toBe("Computer preference: Auto; availability is checked when a task starts.");
    for (const cloudHome of [undefined, false]) {
      expect(reach("local", cloudHome)).toBe("Computer preference: this computer.");
      expect(reach("vm", cloudHome)).toBe("Computer preference: Local VM.");
    }
  });
});

describe("soulLead", () => {
  it("cuts at the first blank line", () => {
    expect(soulLead("First paragraph.\n\nSecond paragraph.")).toBe("First paragraph.");
  });

  it("cuts at 240 characters", () => {
    const long = "A".repeat(300);
    const result = soulLead(long);
    expect(result).toBe(`${"A".repeat(240)}…`);
  });

  it("returns an empty string for an unset soul", () => {
    expect(soulLead(undefined)).toBe("");
  });
});

describe("grantsSummary", () => {
  it("stays off the wire for a bot with no grants record", () => {
    expect(grantsSummary(undefined)).toBeUndefined();
    expect(buildBotOverview(baseFacts()).grants).toBeUndefined();
  });

  it("summarizes wildcards, exact lists and an explicit no-tools record", () => {
    const grants = grantsSummary({
      slack: { tools: "*" },
      gmail: { tools: ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"] },
    });
    expect(grants).toEqual([
      { slug: "gmail", level: "partial", toolCount: 2 },
      { slug: "slack", level: "all", toolCount: 0 },
    ]);
    // {} is the explicit no-tools record: an empty list, not an absent one
    expect(grantsSummary({})).toEqual([]);
    expect(buildBotOverview(baseFacts({ bot: { ...baseFacts().bot, connectorTools: {} } })).grants).toEqual([]);
  });

  it("rides along in the built overview for a partial grant set", () => {
    const connectorTools = { gmail: { tools: ["GMAIL_SEND_EMAIL"] } };
    const overview = buildBotOverview(baseFacts({ bot: { ...baseFacts().bot, connectorTools } }));
    expect(overview.grants).toEqual([{ slug: "gmail", level: "partial", toolCount: 1 }]);
  });
});

describe("setupSteps", () => {
  it("lists optional setup ideas without inspecting conversation history", () => {
    const steps = setupSteps(baseFacts({ bot: { ...baseFacts().bot, name: "New bot", title: "", description: "" } }));
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["identity", false],
      ["soul", false],
      ["folder", false],
    ]);
    expect(steps.find((step) => step.id === "apps")).toBeUndefined();
    expect(steps.every((step) => step.section)).toBe(true);
  });

  it("marks steps done from the same facts the sentences use", () => {
    const facts = baseFacts({
      bot: { ...baseFacts().bot, name: "Kiwi", title: "Tracker", soul: "Be brief.", cwd: "/work", apps: true },
    });
    expect(setupSteps(facts).every((step) => step.done)).toBe(true);
    expect(buildBotOverview(facts).setup).toEqual(setupSteps(facts));
  });
});
