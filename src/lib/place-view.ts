import { activeLocale, t } from "@/lib/i18n";
import { browserAvailable, builtInBrowserEnabled, type FeatureFlagConfig } from "@/lib/feature-flags";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { useAdvancedMode } from "@/lib/interface-mode";
import { pageOnRemoteServer } from "@/lib/local-computer";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { openBotSettings } from "@/components/bot-panel/panel-link";
import type { Action, Bot, ConfigStatus, InstanceInfo } from "@/state/store";
import type { LocaleKey } from "@/locales";
import {
  placeRowView, placeView, type Place, type PlaceActionId, type PlaceFacts, type PlaceRow, type PlaceTranslate, type PlaceView,
  type ServerKind,
} from "../../shared/place-view";

export const placeTranslate: PlaceTranslate = (key, params) => t(key as LocaleKey, params);

export interface PlaceSeat {
  server: ServerKind;
  role: "admin" | "user";
  mode: "simple" | "advanced";
}

export function serverKind(config: Pick<ConfigStatus, "cloudHome"> | null | undefined, capabilities: DesktopCapabilities): ServerKind {
  if (config?.cloudHome) return "my-cloud";
  if (pageOnRemoteServer(capabilities)) return "remote";
  const { platform } = capabilities.host;
  return platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "linux";
}

function engineFacts(instance: InstanceInfo | undefined, model: string | undefined): PlaceFacts["engine"] {
  const label = instance?.models?.options?.find((option) => option.id === model)?.label;
  return {
    name: instance?.displayName || instance?.driverKind || model || "",
    model: label || model || instance?.displayName || "",
    computer: instance?.capabilities?.computerMcp === true,
    browser: instance?.capabilities?.browserMcp === true,
  };
}

export function placeFacts(input: {
  bot: Pick<Bot, "name" | "modelSelection" | "toolScope" | "cloudBackend">;
  place: PlaceFacts["place"];
  seat: PlaceSeat;
  config: FeatureFlagConfig | null | undefined;
  instances: InstanceInfo[];
  local?: PlaceFacts["local"];
  teamComputer?: string;
}): PlaceFacts {
  const { bot, config, seat } = input;
  const instance = input.instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  return {
    place: input.place,
    server: seat.server,
    bot: bot.name,
    engine: engineFacts(instance, bot.modelSelection.model),
    browserOn: builtInBrowserEnabled(config) && browserAvailable(config),
    role: seat.role,
    mode: seat.mode,
    ...(input.local ? { local: input.local } : {}),
    ...(input.teamComputer ? { teamComputer: input.teamComputer } : {}),
  };
}

export function placeViewFor(facts: PlaceFacts): PlaceView {
  return placeView(facts, { translate: placeTranslate, locale: activeLocale() });
}

export function placeRowViewFor(row: PlaceRow, seat: PlaceSeat, worksOnLabel?: string): PlaceView {
  return placeRowView(row, { server: seat.server, role: seat.role, mode: seat.mode, worksOnLabel, translate: placeTranslate, locale: activeLocale() });
}

export function placeBlocked(view: PlaceView): boolean {
  return view.state === "browser-off" || view.state === "browser-cannot"
    || view.state === "vm-cannot" || view.state === "local-unavailable";
}

export function usePlaceSeat(config: Pick<ConfigStatus, "cloudHome"> | null | undefined, capabilities: DesktopCapabilities): PlaceSeat {
  const ownerOrAdmin = useOwnerOrAdmin();
  const advanced = useAdvancedMode();
  return { server: serverKind(config, capabilities), role: ownerOrAdmin === false ? "user" : "admin", mode: advanced ? "advanced" : "simple" };
}

export function openPlaceAction(
  id: PlaceActionId,
  target: { botId: string; threadId?: string; place?: Place },
  dispatch: (action: Action) => void,
): boolean {
  const appSettings = (section: "engines" | "computer" | "cloudAccount") =>
    dispatch({ type: "toggleAppSettings", open: true, section });
  switch (id) {
    case "choose-model": openBotSettings(dispatch, "model", { botId: target.botId }); return true;
    case "open-tools": openBotSettings(dispatch, "access", { botId: target.botId, page: "tools" }); return true;
    case "sign-in": appSettings("engines"); return true;
    case "manage-computers": appSettings("computer"); return true;
    case "open-vm-settings":
      window.sessionStorage?.setItem("openmausbot.settings.section", "computer");
      appSettings("computer");
      return true;
    case "open-team-map": dispatch({ type: "showTeamMap" }); return true;
    case "see-plan": {
      const desktop = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
      if (desktop) { void desktop.openDashboard().catch(() => {}); return true; }
      if (window.ogb?.cloudPlan) { void window.ogb.cloudPlan.manage().catch(() => {}); return true; }
      appSettings("cloudAccount");
      return true;
    }
    case "open-my-cloud": {
      const desktop = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
      if (desktop) void desktop.connectHome().catch(() => {});
      else appSettings("cloudAccount");
      return true;
    }
    case "clear-pin":
      if (!target.threadId) return false;
      dispatch({ type: "updateTask", botId: target.botId, threadId: target.threadId, patch: { surface: null } });
      return true;
    case "watch":
    case "open-computer-panel":
    case "turn-on-browser":
      writeComputerPanelView(target.botId, id === "turn-on-browser" ? "browser" : "computer");
      dispatch({ type: "toggleComputer", open: true });
      return true;
    default:
      return false;
  }
}

export const SIMPLE_PLACE_LABEL = {
  auto: "vm.dest.auto",
  cloud: "place.cloud",
  vm: "vm.dest.vm",
  browser: "vm.dest.browser",
  off: "vm.dest.off",
} as const satisfies Record<string, LocaleKey>;

export function worksOnSimpleLabel(computer: Bot["computer"], platform: DesktopCapabilities["host"]["platform"]): string {
  if (computer === "local") return t(platform === "darwin" ? "computer.simple.dest.thisMac" : "computer.simple.dest.thisPc");
  return t(SIMPLE_PLACE_LABEL[computer ?? "auto"]);
}
