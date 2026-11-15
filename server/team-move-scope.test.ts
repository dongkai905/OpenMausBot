import { describe, expect, it } from "vitest";

import { moveItems, type MoveKindsDeps } from "./cloud-send-kinds.ts";
import { cloudSendSummary, type CloudSendSources } from "./cloud-send.ts";
import { installLibrarySkill } from "./skill-library.ts";
import type { BotRecord } from "./store.ts";

const bot = (id: string, extra: Partial<BotRecord> = {}): BotRecord => ({
  id, threadId: `${id}-main`, name: id, title: "", description: "", soul: "", notifications: true, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, resumeCursors: {}, createdAt: 1, tasks: [], ...extra,
} as unknown as BotRecord);

function kinds(): MoveKindsDeps {
  return {
    dataDir: "/omb", store: { bots: [], bot: () => undefined, group: () => undefined } as never,
    claudeCodeSkills: () => [{ name: "my-own-skill", entry: { description: "", source: "claudeCode", root: "/r", origin: "/o", label: "x", sha256: "a".repeat(64), warnings: [] }, skillMd: "---\nname: my-own-skill\n---\n", files: [] }] as never,
    instanceExists: () => true, owner: () => null,
  };
}

describe("a move of one bot into a team", () => {
  it("compares only that bot, its skills and the library skills it uses: nothing of the person's", () => {
    for (const name of ["trip-plan", "unused-one"]) expect(installLibrarySkill({ name, instructions: `---\nname: ${name}\ndescription: ${name}.\n---\n\n${name}.\n`, source: "test" })).not.toHaveProperty("error");
    const deps = kinds();
    const scout = bot("scout", { assignedSkills: ["trip-plan"], soul: "Plans trips.", chiefOfStaff: true });
    const sources: CloudSendSources = {
      appVersion: "0.1.121", bots: () => [scout, bot("pip", { soul: "Pip." })], greetingOnly: () => true,
      skills: (owner) => (owner.id === "scout" ? [{ name: "packing", sha256: "b".repeat(64), enabled: true }] : []), picture: () => null,
      logins: () => [{ id: "l1", site: "example.test", hosts: ["example.test"], exactHost: false, username: "ada", updatedAt: 1 }],
      onePassword: () => ({ connectedAt: 1, grants: {} }), settings: () => ({ profile: { name: "Ada", aboutMe: "Partner is Fernando." } }),
      move: { items: (bots, only) => moveItems(deps, bots, only), botParts: () => ({ chief: "c", library: "l", projects: "p" }) },
    };
    const items = cloudSendSummary(sources, { move: true, bot: "scout" }).items;
    expect(items.map((item) => item.key)).toEqual(["bot:scout", "skill:scout:packing", "library-skill:trip-plan"]);
    expect(Object.keys(items[0]!.parts), "never someone's Chief of Staff in the team").not.toContain("chief");
    expect(Object.keys(items[0]!.parts)).toEqual(expect.arrayContaining(["library", "projects", "soul"]));
    const whole = cloudSendSummary(sources, { move: true }).items.map((item) => item.key);
    expect(whole).toEqual(expect.arrayContaining(["login:example.test|ada", "1password", "setting:profile", "imported-skill:my-own-skill"]));
    expect(cloudSendSummary({ ...sources, bots: () => [bot("quiet")] }, { move: true, bot: "quiet" }).items.map((item) => item.key), "a bot chosen to move goes even if never used").toEqual(["bot:quiet"]);
    expect(cloudSendSummary(sources, { move: true, bot: "nobody" }).items).toEqual([]);
  });
});
