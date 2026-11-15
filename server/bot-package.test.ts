import { describe, expect, it } from "vitest";

import { parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import { memberFromAgent } from "./package-import.ts";

const validPackage: any = {
  format: "openmaus.package",
  version: 1,
  package: {
    id: "research-desk",
    release: "1.0.0",
    name: "Research Desk",
    tagline: "Turn a question into a sourced brief.",
    summary: "A small research team.",
    category: "Research",
    author: { name: "OpenMausBot" },
    license: "MIT",
    outcomes: ["Produce a sourced brief."],
    setupMinutes: 3,
    requirements: { apps: [], capabilities: [] },
    agents: [
      {
        key: "lead",
        name: "Ada",
        title: "Research Lead",
        description: "Own the brief.",
        appearance: { color: "purple" },
        playbooks: ["source-check"],
        approvalMode: "full",
        autoApprove: true,
      },
    ],
    chiefOfStaff: "lead",
    rooms: [
      {
        key: "desk",
        name: "Research Desk",
        members: ["lead"],
        bulletin: "Cite sources.",
        defaultResponder: { kind: "agent", agent: "lead" },
      },
    ],
    playbooks: [
      {
        key: "source-check",
        name: "Source Check",
        summary: "Verify sources.",
        triggers: ["research brief"],
        instructions: "Separate facts from inference.",
      },
    ],
  },
};

describe("bot packages", () => {
  const portableSkill = {
    name: "source-check",
    description: "Check sources before writing.",
    source: "conversation:source-check",
    instructions: "---\nname: source-check\ndescription: Check sources before writing.\n---\n\n# Source check\n",
  };

  it("round-trips portable skills and rejects dangling or mismatched references", () => {
    const withSkill = {
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{ ...validPackage.package.agents[0], skills: [portableSkill.name] }],
        skills: { version: 1, entries: [portableSkill] },
      },
    };
    const parsed = parseBotPackage(withSkill);
    expect(parsed.package.agents[0]?.skills).toEqual(["source-check"]);
    expect(parseBotPackage(renderBotPackageMarkdown(parsed)).package.skills?.entries).toEqual([portableSkill]);
    expect(() => parseBotPackage({
      ...withSkill,
      package: { ...withSkill.package, agents: [{ ...withSkill.package.agents[0], skills: ["missing"] }] },
    })).toThrow("unknown skill");
    expect(() => parseBotPackage({
      ...withSkill,
      package: { ...withSkill.package, skills: { version: 1, entries: [{ ...portableSkill, description: "Different" }] } },
    })).toThrow("does not match its description");
  });

  it("round-trips optional soul through Markdown and the import persona, with the profile byte cap", () => {
    const input = structuredClone(validPackage);
    const soul = "  Preserve precise instructions. 🐭\n";
    input.package.agents[0].soul = soul;
    const parsed = parseBotPackage(renderBotPackageMarkdown(parseBotPackage(input)));
    expect(memberFromAgent(parsed.package.agents[0]).soul).toBe(soul);
    input.package.agents[0].soul = "🐭".repeat(6_001);
    expect(() => parseBotPackage(input)).toThrow("24000 bytes");
  });
  it.each([
    { name: "../escape" },
    { instructions: "not frontmatter" },
    { source: "/private/skill" },
    { source: "file:///private/skill" },
    { license: "not the SKILL.md license" },
    { compatibility: "not the SKILL.md compatibility" },
    { instructions: "---\nname: source-check\ndescription: Check sources before writing.\n---\n" + "🐭".repeat(65_536) },
  ])("rejects invalid portable skill data: %j", (patch) => {
    expect(() => parseBotPackage({
      ...validPackage,
      package: { ...validPackage.package, agents: [{ ...validPackage.package.agents[0], skills: ["source-check"] }],
        skills: { version: 1, entries: [{ ...portableSkill, ...patch }] } },
    })).toThrow();
  });

  it("rejects duplicate, unassigned and excessive packaged skills", () => {
    const document = structuredClone(validPackage);
    document.package.skills = { version: 1, entries: [portableSkill] };
    expect(() => parseBotPackage(document)).toThrow("not referenced");
    document.package.agents[0].skills = ["source-check"];
    document.package.skills.entries.push(portableSkill);
    expect(() => parseBotPackage(document)).toThrow("Duplicate skill");
    document.package.skills.entries = Array(21).fill(portableSkill);
    expect(() => parseBotPackage(document)).toThrow();
  });
  it("refuses to render a skill bundle larger than the Markdown import limit", () => {
    const document = structuredClone(validPackage);
    document.package.agents[0].skills = Array.from({ length: 5 }, (_, i) => `large-${i}`);
    document.package.skills = { version: 1, entries: document.package.agents[0].skills.map((name: string) => ({
      name, description: "Large fixture", instructions: `---\nname: ${name}\ndescription: Large fixture\n---\n${"a".repeat(210_000)}`,
    })) };
    expect(() => renderBotPackageMarkdown(parseBotPackage(document))).toThrow("too large");
  });
  it("parses the complete portable structure and strips authority fields", () => {
    const parsed = parseBotPackage(validPackage);
    expect(parsed.package.rooms![0]?.defaultResponder).toEqual({ kind: "agent", agent: "lead" });
    expect(parsed.package.agents[0]).not.toHaveProperty("approvalMode");
    expect(parsed.package.agents[0]).not.toHaveProperty("autoApprove");
    expect(memberFromAgent(parsed.package.agents[0]!)).toEqual({
      key: "lead",
      name: "Ada",
      title: "Research Lead",
      description: "Own the brief.",
      appearance: { color: "purple" },
    });
  });

  it("round-trips one Chief-of-Staff-readable Markdown playbook", () => {
    const markdown = renderBotPackageMarkdown(parseBotPackage(validPackage));
    expect(markdown).toContain("## Activation");
    expect(markdown).toContain("Give this file to your Chief of Staff");
    expect(markdown).not.toContain("autoApprove");
    expect(markdown).not.toContain("approvalMode");
    expect(parseBotPackage(markdown).package).toMatchObject({
      id: "research-desk",
      chiefOfStaff: "lead",
      agents: [{ key: "lead", name: "Ada" }],
    });
  });

  it("rejects dangling agent, room, playbook, and chief references", () => {
    expect(() => parseBotPackage({
      ...validPackage,
      package: { ...validPackage.package, chiefOfStaff: "missing" },
    })).toThrow("Unknown Chief of Staff");
    expect(() => parseBotPackage({
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{ ...validPackage.package.agents[0], playbooks: ["missing"] }],
      },
    })).toThrow("unknown playbook");
  });
});
