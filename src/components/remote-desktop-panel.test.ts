import { describe, expect, it } from "vitest";

import { computerCapableEngine, isRemoteScreenshotContention, remoteScreenshotSource } from "@/lib/remote-desktop";
import type { InstanceInfo } from "@/state/store";

describe("remote VPS preview", () => {
  it("runs the remote computer on the bot's own engine, never on a swapped-in runner", () => {
    const plain = { instanceId: "plain", driverKind: "customAcp", snapshot: { state: "available" }, capabilities: { computerMcp: false } } as InstanceInfo;
    const tools = { ...plain, instanceId: "tools", driverKind: "claude", capabilities: { computerMcp: true } } as InstanceInfo;
    expect(computerCapableEngine([plain, tools], "plain")).toBeUndefined();
    expect(computerCapableEngine([plain, tools], "tools")).toBe(tools);
    expect(computerCapableEngine([plain, { ...tools, snapshot: { state: "unavailable" } }], "tools")?.snapshot.state).toBe("unavailable");
    expect(computerCapableEngine([plain, tools])).toBeUndefined();
  });
  it("retries only known transient contention, not permanent 409 failures", () => {
    expect(isRemoteScreenshotContention({ status: 409, message: "this bot's remote computer is being changed — wait for it to finish" })).toBe(true);
    expect(isRemoteScreenshotContention({ status: 409, message: "the VPS is being prepared — try again shortly" })).toBe(true);
    for (const message of ["VPS is not configured", "The VPS computer is not ready", "Choose a computer before changing or opening it."]) {
      expect(isRemoteScreenshotContention({ status: 409, message })).toBe(false);
    }
    expect(isRemoteScreenshotContention({ status: 503, message: "this bot's remote computer is being changed — wait for it to finish" })).toBe(false);
  });

  it("accepts only validated screenshot response shapes", () => {
    expect(remoteScreenshotSource({ png: "aGVsbG8=", format: "png" }))
      .toBe("data:image/png;base64,aGVsbG8=");
    expect(remoteScreenshotSource({ png: "aGVsbG8=", format: "jpeg" }))
      .toBe("data:image/jpeg;base64,aGVsbG8=");
  });

  it("rejects malformed formats and payloads", () => {
    expect(remoteScreenshotSource({ png: "<svg onload=alert(1)>", format: "png" })).toBeNull();
    expect(remoteScreenshotSource({ png: "aGVsbG8=", format: "image/svg+xml" })).toBeNull();
    expect(remoteScreenshotSource({ format: "png" })).toBeNull();
    expect(remoteScreenshotSource(null)).toBeNull();
  });
});
