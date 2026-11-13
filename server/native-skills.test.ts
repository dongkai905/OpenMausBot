import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { setNativeSkillEnabled } from "./native-skill-choices.ts";
import { skillExport } from "./skill-export.ts";
import { installSkill, setSkillEnabled } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";
import { noteTypedSend } from "./typed-sends.ts";

// HOME and the data folder are this test file's own temporary ones (server/testing/setup.ts).
const HOME = join(DATA_DIR, "..");
const USER_SKILLS = join(HOME, ".claude", "skills");
afterEach(() => {
  if (!DATA_DIR.startsWith(join(tmpdir(), "omb-test-home-"))) throw new Error(`refusing to clean ${DATA_DIR}: not this test's home`);
  for (const dir of [USER_SKILLS, join(DATA_DIR, "skill-state")]) rmSync(dir, { recursive: true, force: true });
});

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Works with ${name}.\n---\n\nFollow the steps.\n`;
function plant(root: string, name: string): string {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), skillMd(name));
  return join(root, name, "SKILL.md");
}

function hostFor(driverKind: string, options: { cfg?: AppConfig } = {}) {
  const id = `bot-${randomUUID().slice(0, 8)}`;
  const bot = { id, threadId: "main", modelSelection: { instanceId: "engine", model: "m" } } as BotRecord;
  const host = createSkillsLibraryHost({
    store: {
      bot: () => undefined,
      messagesFor: () => [],
    } as unknown as Store,
    cfg: options.cfg ?? ({} as AppConfig),
    appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
    instanceOf: (instanceId) => ({ instanceId, driverKind }),
  });
  return { host, bot };
}

const listed = (skills: Array<{ name: string; origin?: string }>) => skills.map((skill) => `${skill.name}:${skill.origin ?? "own"}`);
const withUserSkills = { features: { claudeUserSkills: true } } as AppConfig;

describe("skills the engine loads by itself", () => {
  it("reach a bot's Skills page and /name from the person's own folder", () => {
    const { host, bot } = hostFor("customAcp", { cfg: withUserSkills });
    const personal = plant(USER_SKILLS, "personal-notes");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    setSkillEnabled(bot.id, "mine", true);
    expect(listed(host.listBotSkills(bot))).toEqual(["mine:own", "personal-notes:native"]);
    expect(host.listBotSkills(bot).find((skill) => skill.name === "personal-notes")).toMatchObject({ enabled: true, editable: false });
    expect(host.readBotSkillFile(bot, "personal-notes")).toBe(skillMd("personal-notes"));
    expect(host.expandSkillCommand(bot, "main", "/personal-notes", undefined, [], true)).toContain(`Read ${JSON.stringify(personal)}`);
  });

  it("run mid-message from what a person typed, alongside the bot's own, and stay off when switched off", () => {
    const { host, bot } = hostFor("customAcp", { cfg: withUserSkills });
    plant(USER_SKILLS, "growth-data-expert");
    plant(USER_SKILLS, "mine-off");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    setSkillEnabled(bot.id, "mine", true);
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine-off") }]);
    const typed = (text: string) => {
      const sendId = randomUUID();
      noteTypedSend("main", sendId, text);
      return host.expandSkillCommand(bot, "main", text, undefined, [{ sendId, text }]);
    };
    const both = typed("find churn with /growth-data-expert, then /mine");
    expect(both).toContain("ran 2 of your skills with /growth-data-expert, /mine");
    expect(both).toContain("/growth-data-expert");
    expect(both).toMatch(new RegExp(`${bot.id}[\\\\/]skills[\\\\/]mine[\\\\/]SKILL\\.md" for /mine`));
    expect(both).toContain("Request: find churn with /growth-data-expert, then /mine");
    expect(typed("Skip it, /mine-off")).toBe("Skip it, /mine-off");
    expect(host.expandSkillCommand(bot, "main", "find churn with /growth-data-expert")).toBe("find churn with /growth-data-expert");
  });

  it("stay out of a bot or team package, which carries only the bot's own, library and imported skills", () => {
    const { host, bot } = hostFor("customAcp", { cfg: withUserSkills });
    plant(USER_SKILLS, "personal-notes");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    setSkillEnabled(bot.id, "mine", true);
    expect(listed(host.listBotSkills(bot))).toEqual(["mine:own", "personal-notes:native"]);
    const team = skillExport(host).collectTeamSkills([bot], "all");
    expect(team.ok && [...team.skillsByBot.values()].flat().map((skill) => skill.name)).toEqual(["mine"]);
    expect(skillExport(host).checkedExportSkillNames(["personal-notes"], [bot])).toMatchObject({ ok: false });
  });

  it("never run one under the name of the bot's own skill that is switched off", () => {
    const { host, bot } = hostFor("customAcp", { cfg: withUserSkills });
    plant(USER_SKILLS, "mine");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    expect(listed(host.listBotSkills(bot))).toEqual(["mine:own"]);
    expect(host.expandSkillCommand(bot, "main", "/mine go", undefined, [], true)).toBe("/mine go");
  });

  it.skipIf(process.platform === "win32")("never read a SKILL.md that is itself a link", () => {
    const { host, bot } = hostFor("customAcp", { cfg: withUserSkills });
    mkdirSync(join(USER_SKILLS, "linked"), { recursive: true });
    symlinkSync(plant(join(DATA_DIR, "elsewhere"), "secret"), join(USER_SKILLS, "linked", "SKILL.md"));
    expect(host.listBotSkills(bot)).toEqual([]);
    expect(host.readBotSkillFile(bot, "linked")).toBeNull();
    expect(host.expandSkillCommand(bot, "main", "/linked go", undefined, [], true)).toBe("/linked go");
  });

  it("include the person's own folder only with \"Also use my Claude Code skills\", and none for another engine", () => {
    plant(USER_SKILLS, "personal-one");
    const off = hostFor("customAcp");
    expect(listed(off.host.listBotSkills(off.bot))).toEqual([]);
    const on = hostFor("customAcp", { cfg: withUserSkills });
    expect(listed(on.host.listBotSkills(on.bot))).toEqual(["personal-one:native"]);
    const other = hostFor("otherAcp", { cfg: withUserSkills });
    expect(listed(other.host.listBotSkills(other.bot))).toEqual([]);
    expect(other.host.expandSkillCommand(other.bot, "main", "/personal-one", undefined, [], true)).toBe("/personal-one");
  });

  it("keep a skill the engine may not run out of the / menu", () => {
    const { host, bot } = hostFor("customAcp", { cfg: withUserSkills });
    mkdirSync(join(USER_SKILLS, "model-only"), { recursive: true });
    writeFileSync(join(USER_SKILLS, "model-only", "SKILL.md"), `---\ndescription: Only for the model.\nuser-invocable: false\n---\n\nSteps.\n`);
    expect(listed(host.listBotSkills(bot))).toEqual([]);
  });
});

describe("switching a native skill off for one bot", () => {
  it("shows enabled false on the Skills page and keeps /name from expanding it", () => {
    const { host, bot } = hostFor("customAcp", { cfg: withUserSkills });
    plant(USER_SKILLS, "pdf");
    expect(host.listBotSkills(bot).find((skill) => skill.name === "pdf")).toMatchObject({ origin: "native", enabled: true });
    setNativeSkillEnabled(bot.id, "pdf", false);
    expect(host.listBotSkills(bot).find((skill) => skill.name === "pdf")).toMatchObject({ origin: "native", enabled: false });
    expect(host.expandSkillCommand(bot, "main", "/pdf summarise", undefined, [], true)).toBe("/pdf summarise");
  });
});
