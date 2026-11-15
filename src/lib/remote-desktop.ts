import type { InstanceInfo } from "@/state/store";

/** The engine fact the computer rule reads: the renderer's instance and the server's provider instance both carry it. */
export interface ComputerEngine {
  computerMcp?: boolean;
}

/** One rule for the server and the renderer: an engine with computer tools can drive a computer, on the person's own VPS
 * alike. The shared module that keeps the server's copy still carries the name of the vendor that is gone, so the
 * renderer keeps its own copy of the same line until that module is renamed with it. */
export function canWorkOnComputer(engine: ComputerEngine | undefined): boolean {
  return engine?.computerMcp === true;
}

/** The contention the server writes for a computer that is already in use or on the way: its own wording, matched as it
 * stands so a refusal reads as a wait and not as a fault. */
export function isRemoteScreenshotContention(error: { status: number; message: string }): boolean {
  return error.status === 409 && [
    "this bot's remote computer is being changed — wait for it to finish",
    "the VPS is being prepared — try again shortly",
    "VPS connection settings are being updated — wait for them to finish",
  ].includes(error.message);
}

export function remoteScreenshotSource(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as { png?: unknown; format?: unknown };
  if (typeof frame.png !== "string" || !frame.png || !/^[A-Za-z0-9+/=]+$/.test(frame.png)) return null;
  if (frame.format !== "png" && frame.format !== "jpeg") return null;
  return `data:${frame.format === "jpeg" ? "image/jpeg" : "image/png"};base64,${frame.png}`;
}

export function computerEngineOf(instance: InstanceInfo | undefined): ComputerEngine {
  return { computerMcp: instance?.capabilities?.computerMcp };
}

export function computerCapableEngine(instances: readonly InstanceInfo[], selectedId?: string): InstanceInfo | undefined {
  const selected = selectedId ? instances.find(instance => instance.instanceId === selectedId) : undefined;
  return selected && canWorkOnComputer(computerEngineOf(selected)) ? selected : undefined;
}
