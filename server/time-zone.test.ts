import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { adoptSavedTimeZone, currentTimeZone, knownTimeZone, TIME_ZONE_FILE, useTimeZone } from "./time-zone.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-time-zone-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the zone a Cloud home tells time in", () => {
  it("takes only IANA zone names the runtime knows", () => {
    for (const zone of ["UTC", "Asia/Kolkata", "Europe/London", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) expect(knownTimeZone(zone), zone).toBe(zone);
    for (const bad of ["+05:30", "IST", "Mars/Olympus_Mons", "../etc/passwd", "Asia/Kolkata\n", "", 330, null, "A".repeat(70)]) expect(knownTimeZone(bad), String(bad)).toBeNull();
  });

  it("saves the owner's zone, runs in it, and takes it back after a restart", () => {
    const dataDir = tempDir();
    const env: NodeJS.ProcessEnv = {};
    expect(adoptSavedTimeZone(dataDir, env)).toBeNull();
    expect(useTimeZone(dataDir, "Asia/Kolkata", env)).toBe(true);
    expect(env.TZ).toBe("Asia/Kolkata");
    expect(currentTimeZone(env)).toBe("Asia/Kolkata");
    expect(JSON.parse(readFileSync(join(dataDir, TIME_ZONE_FILE), "utf8"))).toEqual({ version: 1, timeZone: "Asia/Kolkata" });
    if (process.platform !== "win32") expect(statSync(join(dataDir, TIME_ZONE_FILE)).mode & 0o777).toBe(0o600);
    expect(useTimeZone(dataDir, "Asia/Kolkata", env)).toBe(false);
    const restarted: NodeJS.ProcessEnv = {};
    expect(adoptSavedTimeZone(dataDir, restarted)).toBe("Asia/Kolkata");
    expect(restarted.TZ).toBe("Asia/Kolkata");
  });

  it("moves this process's clock: a local hour reads in the new zone at once", () => {
    vi.stubEnv("TZ", "UTC");
    const at = Date.parse("2026-10-18T12:00:00Z");
    expect(new Date(at).getHours()).toBe(12);
    useTimeZone(tempDir(), "Asia/Kolkata");
    expect(new Date(at).getHours()).toBe(17);
    expect(new Date(at).getMinutes()).toBe(30);
  });


});
