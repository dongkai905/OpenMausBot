import { t } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";

export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const capabilities = instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  )?.capabilities;
  return capabilities?.localComputerMcp === true || capabilities?.computerMcp === true;
}

export function pageOnRemoteServer(capabilities: DesktopCapabilities): boolean {
  return capabilities.localComputer?.reasonCode === "remote-server";
}

export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  if (pageOnRemoteServer(capabilities)) return false;
  return capabilities.host.platform === "darwin" || capabilities.host.platform === "win32";
}

/** Why a bot can't use this computer, in words for the person: what to do, never the parts underneath. */
export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) return t("computer.problem.localAiCannot");
  if (capabilities.localComputer.available) return null;
  if (pageOnRemoteServer(capabilities)) return t("computer.problem.localRemoteServer");
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") return t("computer.problem.localWaylandBlocked");
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") return t("computer.problem.localWaylandDesktop");
    if (capabilities.localComputer.reasonCode === "linux-hyprland-plugin-required") return t("computer.problem.localHyprlandPlugin");
    if (!capabilities.localComputer.enabled) return t("computer.problem.localTurnOn");
    return capabilities.localComputer.message ?? t("computer.problem.localNotReady");
  }
  if (capabilities.host.label === "Browser") return t("computer.problem.localNeedsApp");
  if (capabilities.host.platform === "win32") return t("computer.problem.localWindows");
  return t("computer.problem.localMac");
}

export type CloudPanelAction =
  | "cloud-new"
  | "cloud-asleep"
  | "attach-ready-computer"
  | "busy-computer"
  | "team-computer"
  | "show-ready-computer"
  | "show-sleeping-computer"
  | "show-pending-computer"
  | "local"
  | "unconfigured"
  | "auto-unavailable";

const READY_CLOUD_STATES = new Set(["idle", "ready", "running"]);

export function isReadyCloudState(state: string | null | undefined): boolean {
  return typeof state === "string" && READY_CLOUD_STATES.has(state);
}
const SLEEPING_CLOUD_STATES = new Set(["archived", "stopped"]);

/** A passive panel open never provisions: nothing creates, wakes or opens the person's own VPS computer without an
 * explicit Cloud choice. */
export function resolveCloudPanelAction({
  computer,
  configured,
  cloudState,
  canUseCloud,
  autoLocal,
  teamComputer = false,
  busy = false,
}: {
  computer: Bot["computer"];
  configured: boolean;
  cloudState: string | null;
  canUseCloud: boolean;
  autoLocal: boolean;
  teamComputer?: boolean;
  busy?: boolean;
}): CloudPanelAction {
  if (computer === undefined && teamComputer) return "team-computer";
  const explicitCloud = computer === "cloud";

  if (!configured) {
    if (explicitCloud) return "unconfigured";
    return autoLocal ? "local" : "auto-unavailable";
  }
  if (explicitCloud) {
    if (!canUseCloud) return "auto-unavailable";
    if (cloudState && READY_CLOUD_STATES.has(cloudState)) return "attach-ready-computer";
    if (busy || (cloudState && !SLEEPING_CLOUD_STATES.has(cloudState))) return "busy-computer";
    return cloudState ? "cloud-asleep" : "cloud-new";
  }
  if (canUseCloud && cloudState) {
    if (READY_CLOUD_STATES.has(cloudState)) return "show-ready-computer";
    if (SLEEPING_CLOUD_STATES.has(cloudState)) return "show-sleeping-computer";
    return "show-pending-computer";
  }
  return autoLocal ? "local" : "auto-unavailable";
}

export function busyCloudView(cloudState: string | null, busy: boolean): {
  line: "computer.cloud.new" | "computer.cloud.asleep" | "computer.phase.busyComputer" | "computer.phase.starting";
  spinner: boolean;
} {
  if (!cloudState) return { line: "computer.cloud.new", spinner: false };
  if (SLEEPING_CLOUD_STATES.has(cloudState)) return { line: "computer.cloud.asleep", spinner: false };
  return { line: busy ? "computer.phase.busyComputer" : "computer.phase.starting", spinner: true };
}

/** A stale ready phase can survive one render, so preview POSTs also need the durable, explicit Cloud choice. */
export function shouldPollCloudPreview(
  {
    computer,
    cloudBackend,
    phase,
    botId,
    resolvedBotId,
    resolvedComputer,
    resolvedCloudBackend,
  }: {
    computer: Bot["computer"];
    cloudBackend: NonNullable<Bot["cloudBackend"]>;
    phase: string;
    botId: string;
    resolvedBotId: string | null;
    resolvedComputer: Bot["computer"] | null;
    resolvedCloudBackend: Bot["cloudBackend"] | null;
  },
): boolean {
  return computer === "cloud"
    && phase === "ready"
    && resolvedBotId === botId
    && resolvedComputer === "cloud"
    && resolvedCloudBackend === cloudBackend;
}

/** Provider work only once the settled server bot confirms the destination and backend this render expects. */
export function persistedComputerSelectionMatches({
  computer,
  cloudBackend,
  persistedBot,
}: {
  computer: Bot["computer"];
  cloudBackend: NonNullable<Bot["cloudBackend"]>;
  persistedBot: Pick<Bot, "computer" | "cloudBackend">;
}): boolean {
  return persistedBot.computer === computer
    && (persistedBot.cloudBackend ?? "vps") === cloudBackend;
}

export function autoSelectsLocalComputer({
  platform,
  computer,
  capabilitiesReady,
  localSelectable,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computer: Bot["computer"];
  capabilitiesReady: boolean;
  localSelectable: boolean;
}): boolean {
  return platform !== "linux" && computer !== "cloud" && capabilitiesReady && localSelectable;
}
