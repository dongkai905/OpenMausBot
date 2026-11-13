import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LimitResetClock, nearLimitNote, UNNAMED_LIMIT_MS } from "./limit-resets.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { PlanProviderRow, PlanUsageReport, PlanWindow } from "./plan-usage.ts";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 3_600_000;
/** Past this after its time, a hold is forgotten. */
const REFUSAL_GRACE_FOR_TEST = 10 * 60_000 + 1;
const iso = (at: number) => new Date(at).toISOString();

/** One engine's usage row: the rolling window and the weekly one. */
const window = (usedPercent: number, resetsAt: number | null): PlanWindow => ({
  available: true, remainingPercent: 100 - usedPercent, usedPercent, resetsAt: resetsAt === null ? null : iso(resetsAt),
});
const acp = (fiveHour: [number, number | null], weekly: [number, number | null]): PlanProviderRow => ({
  id: "acp", name: "ACP", driver: "acp", plan: null, ok: true, error: null,
  fiveHour: window(fiveHour[0], fiveHour[1]), weekly: window(weekly[0], weekly[1]), extra: [], models: [],
});
const report = (...providers: PlanProviderRow[]): PlanUsageReport => ({ fetchedAt: iso(NOW), providers });

describe("LimitResetClock", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OMB_TEST_PLAN_USAGE_FILE;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const accounts = [{ id: "acp", name: "ACP", driver: "acp" as const, environment: {} }];
  const clock = (options: Partial<ConstructorParameters<typeof LimitResetClock>[0]> = {}) => {
    let now = NOW;
    const instance = new LimitResetClock({ accounts: () => accounts, now: () => now, ...options });
    return { instance, at: (next: number) => { now = next; } };
  };



  it("keeps a passed refusal briefly, then forgets it", () => {
    const { instance, at } = clock();
    instance.noteRefusal("acp", NOW + HOUR);
    at(NOW + HOUR + 60_000);
    expect(instance.blockedUntil("acp")).toBeNull();
    expect(instance.resetAt("acp")).toBe(NOW + HOUR);
    at(NOW + 2 * HOUR);
    expect(instance.resetAt("acp")).toBeNull();
  });

  it("ignores a refusal that names no engine, no time or a time already past", () => {
    const { instance } = clock();
    instance.noteRefusal(undefined, NOW + HOUR);
    instance.noteRefusal("acp", undefined);
    instance.noteRefusal("acp", NOW - 1);
    expect(instance.report().engines).toEqual([]);
  });

  it("reports a refused engine as blocked even before its usage was read", () => {
    const { instance } = clock();
    instance.noteRefusal("acp", NOW + HOUR);
    expect(instance.report().engines).toEqual([expect.objectContaining({ engine: "acp", name: "ACP", blocked: true, usedPercent: 100, resetsAt: NOW + HOUR })]);
  });



  it("reads usage once an account is added after a refresh that had none", async () => {
    const load = vi.fn(async () => report(acp([50, NOW + HOUR], [5, NOW + 90 * HOUR])));
    let current: typeof accounts = [];
    const instance = new LimitResetClock({ accounts: () => current, now: () => NOW, loadUsage: load });
    await instance.refresh(true);
    current = accounts;
    await instance.refresh(true);
    expect(load).toHaveBeenCalledTimes(1);
  });
});


describe("nearLimitNote", () => {
  it("tells the turn when its engine is at 90% or more, with the reset", () => {
    const limit = { engine: "acp", name: "ACP", driver: "acp" as const, window: "5-hour" as const, usedPercent: 92, resetsAt: Date.UTC(2026, 9, 19, 15, 40), blocked: false };
    expect(nearLimitNote(limit, "ACP", "UTC")).toBe(" ACP's usage limit is 92% used; it resets Mon 3:40 PM (UTC).");
    expect(nearLimitNote({ ...limit, usedPercent: 89 }, "ACP", "UTC")).toBe("");
    expect(nearLimitNote(undefined, "ACP", "UTC")).toBe("");
  });
});

describe("LimitResetClock and the turns that follow a refusal", () => {
  const accounts = [{ id: "acp", name: "ACP", driver: "acp" as const, environment: {} }];
  const base = { eventId: "e", provider: "customAcp", createdAt: "2026-10-19T10:00:00Z" };
  const started = (threadId: string) => ({ ...base, threadId, type: "turn.started" }) as RuntimeEvent;
  const refused = (threadId: string, limitResetsAt?: number) => ({ ...base, threadId, type: "runtime.error", message: "limit", ...(limitResetsAt ? { limitResetsAt } : {}) }) as RuntimeEvent;
  const completed = (threadId: string, ok: boolean) => ({ ...base, threadId, type: "turn.completed", ok }) as RuntimeEvent;
  const clock = (onChange = vi.fn()) => ({ onChange, instance: new LimitResetClock({ accounts: () => accounts, now: () => NOW, onChange }) });

  it("ends the hold when a later turn on the same engine works, even after the engine's turn map forgot it", () => {
    const { instance, onChange } = clock();
    instance.noteRuntimeEvent("acp", started("t1"));
    instance.noteRuntimeEvent(undefined, refused("t1", NOW + 11 * 24 * HOUR));
    instance.noteRuntimeEvent(undefined, completed("t1", false));
    expect(instance.blockedUntil("acp")).toBe(NOW + 11 * 24 * HOUR);
    onChange.mockClear();
    instance.noteRuntimeEvent("acp", started("t2"));
    instance.noteRuntimeEvent(undefined, completed("t2", true));
    expect(instance.blockedUntil("acp")).toBeNull();
    expect(instance.report().engines).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the hold through a failed turn, a working turn on another engine, or a turn whose engine is unknown", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("acp", refused("t1", NOW + HOUR));
    instance.noteRuntimeEvent("acp", started("t2"));
    instance.noteRuntimeEvent(undefined, completed("t2", false));
    instance.noteRuntimeEvent("other", started("t3"));
    instance.noteRuntimeEvent(undefined, completed("t3", true));
    instance.noteRuntimeEvent(undefined, completed("t4", true));
    expect(instance.blockedUntil("acp")).toBe(NOW + HOUR);
  });

  it("holds nothing for a refusal without an engine-wide reset", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("acp", started("t1"));
    instance.noteRuntimeEvent(undefined, refused("t1"));
    expect(instance.blockedUntil("acp")).toBeNull();
  });

  it("holds an engine an hour when its own limit names no reset, never showing that guess as a reset, until one is named or a turn works", () => {
    let now = NOW;
    const instance = new LimitResetClock({ accounts: () => accounts, now: () => now });
    const limited = (threadId: string) => ({ ...refused(threadId), limit: "engine" }) as RuntimeEvent;
    instance.noteRuntimeEvent("acp", started("t1"));
    instance.noteRuntimeEvent(undefined, limited("t1"));
    expect(instance.blockedUntil("acp")).toBe(NOW + UNNAMED_LIMIT_MS);
    expect(instance.resetAt("acp"), "a guess is no reset time").toBeNull();
    expect(instance.report().engines).toEqual([expect.objectContaining({ engine: "acp", blocked: true, resetsAt: null })]);
    instance.noteRefusal("acp", NOW + 3 * HOUR);
    expect(instance.resetAt("acp"), "a reset the engine names replaces the guess").toBe(NOW + 3 * HOUR);
    instance.noteLimit("acp", undefined);
    expect(instance.blockedUntil("acp"), "and a refusal naming none never shortens it").toBe(NOW + 3 * HOUR);
    instance.noteRuntimeEvent("acp", started("t2"));
    instance.noteRuntimeEvent(undefined, completed("t2", true));
    expect(instance.blockedUntil("acp")).toBeNull();

    instance.noteLimit("acp", undefined);
    now = NOW + UNNAMED_LIMIT_MS + 1;
    expect(instance.blockedUntil("acp"), "the guess runs out on its own").toBeNull();
  });

  it("keeps a refusal's hold through a restart, so a new conversation does not go to the limited engine first", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-limit-holds-"));
    try {
      const file = join(dir, "limit-holds.json");
      let now = NOW;
      const boot = () => new LimitResetClock({ accounts: () => accounts, now: () => now, file });
      const first = boot();
      first.noteRuntimeEvent("acp", started("t1"));
      first.noteRuntimeEvent(undefined, { ...refused("t1", NOW + 50 * HOUR), limit: "engine" } as RuntimeEvent);
      first.noteLimit("other", undefined);
      now = NOW + 10 * 60_000;
      const restarted = boot();
      expect(restarted.blockedUntil("acp"), "the engine is still held after the restart").toBe(NOW + 50 * HOUR);
      expect(restarted.resetAt("acp")).toBe(NOW + 50 * HOUR);
      expect(restarted.blockedUntil("other"), "a hold that named no reset keeps its re-check time").toBe(NOW + UNNAMED_LIMIT_MS);
      expect(restarted.resetAt("other"), "and stays a guess").toBeNull();
      restarted.noteRuntimeEvent("acp", started("t2"));
      restarted.noteRuntimeEvent(undefined, completed("t2", true));
      expect(boot().blockedUntil("acp"), "a turn that worked ends it for good").toBeNull();
      now = NOW + UNNAMED_LIMIT_MS + REFUSAL_GRACE_FOR_TEST;
      expect(boot().blockedUntil("other")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds the engine until it is checked again when its refusal names a reset that already passed", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("acp", started("t1"));
    instance.noteRuntimeEvent(undefined, { ...refused("t1", NOW - 5 * 60_000), limit: "engine" } as RuntimeEvent);
    expect(instance.blockedUntil("acp")).toBe(NOW + UNNAMED_LIMIT_MS);
    expect(instance.resetAt("acp"), "a past time is no reset time").toBeNull();
  });







  it("stops re-reading usage once the last hold ran out, a guessed one included", async () => {
    vi.useFakeTimers({ now: NOW });
    const loadUsage = vi.fn(async () => ({ ...report(acp([40, NOW + 3 * HOUR], [8, NOW + 5 * 24 * HOUR])), fetchedAt: iso(Date.now()) }));
    const instance = new LimitResetClock({ accounts: () => accounts, loadUsage, waiting: () => false });
    instance.start();
    instance.noteLimit("acp", undefined);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(loadUsage, "a guessed hold is polled too").toHaveBeenCalled();
    // Nothing reads the hold meanwhile, so only the poll itself can notice it ran out.
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    loadUsage.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(loadUsage).not.toHaveBeenCalled();
    expect(instance.blockedUntil("acp"), "the guessed hold ran out").toBeNull();
    instance.stop();
    vi.useRealTimers();
  });


  it("ends a hold at once on Try again now, saved across a restart, and a new refusal holds it again", () => {
    const dir = mkdtempSync(join(tmpdir(), "limit-release-"));
    try {
      const file = join(dir, "holds.json");
      const changed = vi.fn();
      const boot = () => new LimitResetClock({ accounts: () => accounts, now: () => NOW, file, onChange: changed });
      const instance = boot();
      expect(instance.release("acp"), "nothing held").toBe(false);
      instance.noteRefusal("acp", NOW + 23 * HOUR);
      expect(instance.limit("acp")?.held, "only a hold offers Try again now").toBe(true);
      changed.mockClear();
      expect(instance.release("acp")).toBe(true);
      expect(changed).toHaveBeenCalled();
      expect(instance.blockedUntil("acp")).toBeNull();
      expect(boot().blockedUntil("acp"), "still released after a restart").toBeNull();
      instance.noteRefusal("acp", NOW + 23 * HOUR);
      expect(instance.blockedUntil("acp")).toBe(NOW + 23 * HOUR);
      instance.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never holds the engine for one model's own limit", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("acp", { ...refused("t1", NOW + 50 * HOUR), limit: "model" } as RuntimeEvent);
    instance.noteRuntimeEvent("acp", { ...refused("t1"), limit: "credits" } as RuntimeEvent);
    expect(instance.blockedUntil("acp")).toBeNull();
    expect(instance.report().engines).toEqual([]);
  });
});
