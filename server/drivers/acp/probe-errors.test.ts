import { afterEach, expect, it, vi } from "vitest";
import * as procs from "../../procs.ts";
import { CustomAcpDriver } from "./custom.ts";

afterEach(() => vi.restoreAllMocks());

it.each([
  [{ code: "ENOENT" }, "isn't installed, or isn't on this app's PATH"],
  [{ code: "EACCES" }, "isn't executable"],
  [{ killed: true, signal: "SIGTERM" }, "timed out"],
  [{ code: 1 }, "version check failed"],
  [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "version check failed"],
  [null, "returned no version"],
])("does not call every failed version probe a missing CLI: %j", async (failure, reason) => {
  vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _opts, callback) => {
    callback(failure ? Object.assign(new Error("private stderr must not be displayed"), failure) : null, "", "");
  });
  const instance = await CustomAcpDriver.create({ instanceId: "fixture", displayName: undefined, environment: {}, enabled: true, config: { cli: "custom-acp", fullAuto: false } });
  try {
    const snapshot = await instance.snapshot();
    expect(snapshot.state).toBe("unavailable");
    expect(snapshot.reason).toContain(reason);
    expect(snapshot.reason).not.toContain("private stderr");
  } finally { await instance.dispose(); }
});
