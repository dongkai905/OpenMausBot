import { describe, expect, it } from "vitest";
import { itemKey } from "../electron/cloud-send-parts.mjs";
import { importedSkillHash, kindRecord, moveItems, moveKindsRoute, type MoveKindsDeps } from "./cloud-send-kinds.ts";
import { readImportedSkills } from "./imported-skills.ts";
import { installLibrarySkill, readSkillLibraryIndex } from "./skill-library.ts";

const HERE = "/Users/amit/.openmausbot";
const OWNER = { person: "p_owner0000000000000000", name: "Amit" };

function deps(dataDir: string, over: Partial<MoveKindsDeps> = {}): MoveKindsDeps & { owned: Array<[string, string]>; patched: Array<[string, unknown]>; chief: string[] } {
  const bots = new Map<string, Record<string, unknown>>([["b1", { id: "b1", projects: [{ id: "p-cloud", name: "Mine" }] }]]);
  const owned: Array<[string, string]> = [], patched: Array<[string, unknown]> = [], chief: string[] = [];
  return {
    dataDir, owned, patched, chief,
    store: { bots: [...bots.values()] as never, bot: (id: string) => bots.get(id) as never, group: () => undefined,
      patchBot: (id: string, patch: object) => { patched.push([id, patch]); Object.assign(bots.get(id)!, patch); return bots.get(id) as never; },
      setChiefOfStaff: (id: string | null) => { chief.push(String(id)); return []; } } as never,
    claudeCodeSkills: () => [],
    instanceExists: (id) => id === "claude", owner: () => OWNER,
    ...over,
  };
}

async function ask(d: MoveKindsDeps, method: string, query: string, body?: unknown) {
  let answered: { status: number; body: any } | undefined;
  await moveKindsRoute(d, { path: "/api/cloud-send/kind", method, url: new URL(`http://127.0.0.1/api/cloud-send/kind${query}`), auth: {} as never, req: {} as never,
    res: { setHeader() {} } as never, json: ((_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }) as never, readBody: (async () => body) as never });
  return answered!;
}
const take = (d: MoveKindsDeps, key: string, record: unknown, runs?: unknown[]) => ask(d, "PUT", "", { v: 1, key, dataDir: HERE, record, ...(runs ? { runs } : {}) });

describe("what a move compares", () => {
});

describe("My Cloud sets a bot's move-only fields", () => {
  it("as this computer has them: its own projects kept beside, an engine or library skill it lacks left out, and absent ones cleared", async () => {
    installLibrarySkill({ name: "digest", instructions: "---\nname: digest\ndescription: Digest.\n---\n\nDigest.\n", source: "test" });
    const d = deps("/data");
    const fields = { hidden: null, pinned: true, chiefOfStaff: true, managedSections: ["Ops", "Ops"], fallback: [{ instanceId: "claude", model: "h" }, { instanceId: "gone", model: "x" }],
      projects: [{ id: "p1", name: "Launch", emoji: "🚀" }], playbooks: [{ key: "k", name: "Close", summary: "s", triggers: ["t"], instructions: "i" }], installedPackage: null,
      assignedSkills: ["digest", "missing"] };
    expect((await take(d, "bot:b1", fields)).status).toBe(200);
    expect(d.patched[0]![1]).toEqual({ pinned: true, managedSections: ["Ops"], fallback: [{ instanceId: "claude", model: "h" }],
      projects: [{ id: "p1", name: "Launch", emoji: "🚀" }, { id: "p-cloud", name: "Mine" }], playbooks: fields.playbooks, installedPackage: undefined, assignedSkills: ["digest"] });
    expect(d.chief).toEqual(["b1"]);
    expect((await take(d, "bot:b1", { hidden: true, chiefOfStaff: false })).status).toBe(200);
    expect(d.patched.at(-1)![1]).toEqual({ hidden: true, chiefOfStaff: false });
    expect((await take(d, "bot:b1", { soul: "not a move field" })).status).toBe(400);
    expect((await take(d, "bot:nobody", { pinned: true })).status).toBe(409);
  });

  it("this computer answers a bot's record with its own name, which a MausBot that moves is named for when the place it goes keeps its own (email 1a1c22b6)", async () => {
    const before = process.env.OMB_ENVIRONMENT_LABEL;
    process.env.OMB_ENVIRONMENT_LABEL = "Amits-MacBook-Pro.local";
    try {
      const answer = await ask(deps("/data"), "GET", `?key=${encodeURIComponent("bot:b1")}`);
      expect(answer).toMatchObject({ status: 200, body: { computer: "Amits-MacBook-Pro" } });
      expect((await ask(deps("/data"), "PUT", "", { v: 1, key: "bot:b1", dataDir: HERE, record: { pinned: true }, computer: "x".repeat(121) })).status).toBe(400);
    } finally {
      if (before === undefined) delete process.env.OMB_ENVIRONMENT_LABEL; else process.env.OMB_ENVIRONMENT_LABEL = before;
    }
  });
});

describe("skill extras", () => {
  it("an imported skill arrives with every file and hashes the same as the copy this computer keeps", async () => {
    const input = { name: "invoice-check", skillMd: "---\nname: invoice-check\ndescription: Check.\n---\n\nCheck.\n", files: [{ path: "references/rules.md", content: "Add up.\n", executable: false }],
      entry: { description: "Check.", source: "customAcp" as const, root: "~/.claude/skills", origin: "~/.claude/skills/invoice-check", label: "Custom ACP/invoice-check", sha256: "a".repeat(64), warnings: [] } };
    const d = deps("/data", { claudeCodeSkills: () => [input] });
    const [listed] = moveItems(d, new Set()).filter((item) => item.kind === "imported-skill");
    expect(listed).toEqual({ key: itemKey.moved("imported-skill", "invoice-check"), kind: "imported-skill", label: "invoice-check", id: "invoice-check", parts: { files: importedSkillHash(input) } });
    expect((await take(deps("/data"), listed!.key, kindRecord(d, "imported-skill", "invoice-check")!.record)).status).toBe(200);
    expect(readImportedSkills()["invoice-check"]).toMatchObject({ source: "customAcp", label: "Custom ACP/invoice-check" });
    const kept = moveItems(deps("/data"), new Set()).find((item) => item.key === listed!.key);
    expect(kept, "the copy kept here now hashes as the person's own folder did").toEqual(listed);
    expect((await take(deps("/data"), listed!.key, { ...input, files: [{ path: "../escape.md", content: "x", executable: false }] })).status).toBe(400);
  });

  it("a library skill arrives with its review state, and a changed one replaces My Cloud's copy", async () => {
    const text = (body: string) => `---\nname: weekly\ndescription: ${body}\n---\n\n${body}\n`;
    const record = (body: string, reviewState: "approved" | "disabled") => ({ entry: { name: "weekly", description: body, source: "here", reviewState, warnings: [] }, text: text(body) });
    expect((await take(deps("/data"), itemKey.moved("library-skill", "weekly"), record("Weekly.", "approved"))).status).toBe(200);
    expect(readSkillLibraryIndex().weekly).toMatchObject({ reviewState: "approved" });
    expect((await take(deps("/data"), itemKey.moved("library-skill", "weekly"), record("Weekly, shorter.", "approved"))).status).toBe(200);
    expect(readSkillLibraryIndex().weekly).toMatchObject({ description: "Weekly, shorter.", reviewState: "approved" });
  });
});
