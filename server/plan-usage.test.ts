import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPlanUsageCache,
  hasExtraUsageRoom,
  loadPlanUsage,
  planAccountsFromInstances,
  type PlanAccount,
  type PlanFetch,
  type PlanProviderRow,
} from "./plan-usage.ts";

const NOW = 1_800_000_000_000;

beforeEach(() => {
  clearPlanUsageCache();
});

const account = (id: string): PlanAccount => ({ id, name: id, driver: "acp", environment: {} });

describe("the accounts a plan usage report covers", () => {
  it("is none: no engine in this build owns a provider plan", () => {
    expect(planAccountsFromInstances({ acp: { driver: "customAcp", displayName: "Custom" } })).toEqual([]);
  });
});

describe("the plan usage report", () => {
  it("has no providers, and asks no provider for anything", async () => {
    const fetchImpl = vi.fn<PlanFetch>();
    const report = await loadPlanUsage({ accounts: [account("work")], fetch: fetchImpl, now: NOW });
    expect(report.providers).toEqual([]);
    expect(report.fetchedAt).toBe(new Date(NOW).toISOString());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is cached for 45 seconds unless a refresh is asked for", async () => {
    const accounts = [account("work")];
    const first = await loadPlanUsage({ accounts, now: NOW });
    const second = await loadPlanUsage({ accounts, now: NOW + 10_000 });
    expect(second).toBe(first);
    const refreshed = await loadPlanUsage({ accounts, refresh: true, now: NOW + 11_000 });
    expect(refreshed).not.toBe(first);
    expect(refreshed.fetchedAt).toBe(new Date(NOW + 11_000).toISOString());
  });

  it("is read again once the cache is cleared", async () => {
    const accounts = [account("work")];
    const first = await loadPlanUsage({ accounts, now: NOW });
    clearPlanUsageCache();
    expect(await loadPlanUsage({ accounts, now: NOW })).not.toBe(first);
  });
});

describe("room in a plan's paid extra usage", () => {
  const row = (extra: PlanProviderRow["extra"]): Pick<PlanProviderRow, "driver" | "fiveHour" | "weekly" | "extra"> => ({
    driver: "acp",
    fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
    weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
    extra,
  });

  it("is there while the budget is not used up", () => {
    expect(hasExtraUsageRoom(row([{ label: "Monthly", remainingPercent: 60, usedPercent: 40, resetsAt: null }]))).toBe(true);
  });

  it("is not there once the budget is spent, or when there is no budget", () => {
    expect(hasExtraUsageRoom(row([{ label: "Monthly", remainingPercent: 0, usedPercent: 100, resetsAt: null }]))).toBe(false);
    expect(hasExtraUsageRoom(row([]))).toBe(false);
  });
});
