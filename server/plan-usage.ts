// Provider plan usage.
//
// The vendor CLI engines were removed from this shell (route B: physical
// deprivation). What is left is the report shape the Usage page reads and the
// plumbing that fills it in. No engine in this build signs in to a provider
// plan, so the report is empty until an engine that reports its own allowance
// (the custom ACP engine) fills a row in.
import type { InstanceConfigMap } from "./contracts.ts";

/** The only driver kind this build can report a plan for. */
export type PlanDriver = "acp";

export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

/** Money in the provider's minor units: 4631 with exponent 2 is 46.31. */
export interface PlanSpend {
  usedMinor: number;
  limitMinor: number;
  currency: string;
  exponent: number;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
  /** The amounts behind the percent, on a budget in money. */
  spend?: PlanSpend;
}

export interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

export interface PlanWindows {
  plan: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanProviderRow {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProviderRow[];
}

export interface PlanAccount {
  id: string;
  name: string;
  driver: PlanDriver;
  environment: Record<string, string | undefined>;
  configDir?: string;
  /** No usage reading: this account has no plan of its own to report. */
  noUsage?: true;
}

export interface PlanCredential {
  token: string | null;
  accountId: string | null;
  expired: boolean;
}

export interface CredentialReader {
  read(account: PlanAccount): PlanCredential | Promise<PlanCredential>;
}

export interface PlanResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type PlanFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<PlanResponse>;

export interface PlanUsageDeps {
  fetch: PlanFetch;
  credentials: CredentialReader;
  now?: () => number;
  timeoutMs?: number;
}

export interface CredentialSource {
  readText: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const PLAN_USAGE_CACHE_MS = 45_000;

/** No engine in this build owns a provider plan of its own. */
export function planAccountsFromInstances(_instances: InstanceConfigMap): PlanAccount[] {
  return [];
}

let cachedReport: { at: number; key: string; report: PlanUsageReport } | null = null;

export function clearPlanUsageCache(): void {
  cachedReport = null;
}

export async function loadPlanUsage(input: {
  accounts: PlanAccount[];
  refresh?: boolean;
  now?: number;
  fetch?: PlanFetch;
  credentials?: CredentialReader;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<PlanUsageReport> {
  const now = input.now ?? Date.now();
  const key = `${input.accounts.length}:${input.accounts.map((account) => account.id).join(",")}`;
  if (!input.refresh && cachedReport && cachedReport.key === key && now - cachedReport.at < PLAN_USAGE_CACHE_MS) {
    return cachedReport.report;
  }
  const report: PlanUsageReport = { fetchedAt: new Date(now).toISOString(), providers: [] };
  cachedReport = { at: now, key, report };
  return report;
}

/** Whether a plan's paid extra usage is on and not used up, on a plan with rolling windows: sends then go on past a
 * full window and are paid from it. */
export function hasExtraUsageRoom(row: Pick<PlanProviderRow, "driver" | "fiveHour" | "weekly" | "extra">): boolean {
  const budget = row.extra[0];
  return !!budget && budget.usedPercent < 100;
}
