import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoSelectsLocalComputer,
  busyCloudView,
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerSelectable,
  persistedComputerSelectionMatches,
  resolveCloudPanelAction,
  shouldPollCloudPreview,
} from "./local-computer";

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    const bot = {
      modelSelection: { instanceId: "claude", model: "test" },
    } satisfies Pick<Bot, "modelSelection">;
    const instances = [
      {
        instanceId: "claude",
        capabilities: { localComputerMcp: true },
      },
    ] satisfies Array<Pick<InstanceInfo, "instanceId" | "capabilities">>;
    expect(instanceSupportsLocalComputer(instances as InstanceInfo[], bot)).toBe(true);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: {} }] as InstanceInfo[],
        bot,
      ),
    ).toBe(false);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: { computerMcp: true } }] as InstanceInfo[],
        bot,
      ),
    ).toBe(true);
  });

  it("keeps This computer selectable on macOS before CUA is granted", () => {
    const capabilities = {
      host: { platform: "darwin" as const },
      localComputer: { available: false },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: {
          host: { platform: "linux" as const },
          localComputer: { available: false },
        } as DesktopCapabilities,
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("never offers This computer on another server's page, whatever the platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const capabilities = {
        host: { platform },
        localComputer: { available: false, reasonCode: "remote-server" },
      } as DesktopCapabilities;
      expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(false);
      expect(localComputerDisabledReason({ capabilities, providerSupportsLocal: true })).toBe(en["computer.problem.localRemoteServer"]);
    }
  });

  it("keeps This computer selectable on Windows before the driver is live", () => {
    const capabilities = {
      host: { platform: "win32" as const, label: "Windows" },
      localComputer: { available: false, enabled: false, status: "unavailable" },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(localComputerDisabledReason({ capabilities, providerSupportsLocal: true })).toBe(
      "Bots can't use this PC right now. Restart MausBot, and if that doesn't help, open Settings → Diagnostics.",
    );
  });

  it("states that Linux Auto never selects this computer", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "linux",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("explains the Wayland seat-safety block and names the supported session", () => {
    const capabilities = {
      host: { platform: "linux" as const },
      localComputer: {
        available: false,
        enabled: false,
        reasonCode: "linux-wayland-seat-safety-blocked",
      },
    } as DesktopCapabilities;

    expect(
      localComputerDisabledReason({ capabilities, providerSupportsLocal: true }),
    ).toBe(
      "Bots can't use this computer in this kind of desktop session yet. Sign out, choose “Ubuntu on Xorg” on the sign-in screen, and sign back in.",
    );
  });

  it("preserves the ready local fallback on supported non-Linux hosts", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(true);
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: "cloud",
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("reports an inherited team computer without choosing a private computer or local fallback", () => {
    for (const configured of [false, true]) {
      for (const cloudState of [null, "idle", "archived", "provisioning"]) {
        for (const canUseCloud of [false, true]) {
          expect(resolveCloudPanelAction({ computer: undefined, configured, cloudState, canUseCloud,
            autoLocal: true, teamComputer: true })).toBe("team-computer");
        }
      }
    }
    expect(resolveCloudPanelAction({ computer: "cloud", configured: true, cloudState: "idle",
      canUseCloud: true, autoLocal: true, teamComputer: true })).toBe("attach-ready-computer");
  });

  it("never creates a missing computer merely because an Auto panel opened", () => {
    expect(
      resolveCloudPanelAction({
        computer: undefined,
        configured: true,
        cloudState: null,
        canUseCloud: true,
        autoLocal: true,
      }),
    ).toBe("local");
    expect(
      resolveCloudPanelAction({
        computer: undefined,
        configured: true,
        cloudState: null,
        canUseCloud: true,
        autoLocal: false,
      }),
    ).toBe("auto-unavailable");
  });

  it("shows existing Auto computers without provisioning or waking them", () => {
    const base = {
      configured: true,
      canUseCloud: true,
      autoLocal: true,
      computer: undefined,
    };
    for (const cloudState of ["idle", "ready", "running"]) {
      expect(resolveCloudPanelAction({ ...base, cloudState })).toBe("show-ready-computer");
    }
    for (const cloudState of ["archived", "stopped"]) {
      expect(resolveCloudPanelAction({ ...base, cloudState })).toBe("show-sleeping-computer");
    }
    for (const cloudState of ["provisioning", "creating", "unknown-provider-state"]) {
      expect(resolveCloudPanelAction({ ...base, cloudState })).toBe("show-pending-computer");
    }
  });

  it("never creates or wakes a computer because the cloud surface was chosen or the panel opened", () => {
    const cloud = { computer: "cloud" as const, configured: true, canUseCloud: true, autoLocal: true };
    expect(resolveCloudPanelAction({ ...cloud, cloudState: null })).toBe("cloud-new");
    for (const cloudState of ["archived", "stopped"]) {
      expect(resolveCloudPanelAction({ ...cloud, cloudState })).toBe("cloud-asleep");
    }
    for (const cloudState of ["idle", "ready", "running"]) {
      expect(resolveCloudPanelAction({ ...cloud, cloudState })).toBe("attach-ready-computer");
    }
    expect(resolveCloudPanelAction({ ...cloud, cloudState: "provisioning" })).toBe("busy-computer");
  });

  it("watches instead of provisioning while a turn owns the box", () => {
    const cloud = { computer: "cloud" as const, configured: true, canUseCloud: true, autoLocal: true, busy: true };
    for (const cloudState of ["ready", "idle", "running"]) {
      expect(resolveCloudPanelAction({ ...cloud, cloudState })).toBe("attach-ready-computer");
    }
    for (const cloudState of ["archived", "stopped", "provisioning", null]) {
      expect(resolveCloudPanelAction({ ...cloud, cloudState })).toBe("busy-computer");
    }
    expect(resolveCloudPanelAction({ ...cloud, cloudState: "ready", canUseCloud: false })).toBe("auto-unavailable");
    expect(resolveCloudPanelAction({ ...cloud, computer: undefined, cloudState: "ready" })).toBe("show-ready-computer");
    expect(resolveCloudPanelAction({ ...cloud, computer: undefined, cloudState: null, autoLocal: false })).toBe("auto-unavailable");
  });

  it("while it watches, spins only for a cloud computer that is really starting", () => {
    expect(busyCloudView(null, true)).toEqual({ line: "computer.cloud.new", spinner: false });
    expect(busyCloudView(null, false)).toEqual({ line: "computer.cloud.new", spinner: false });
    for (const cloudState of ["archived", "stopped"]) {
      expect(busyCloudView(cloudState, true)).toEqual({ line: "computer.cloud.asleep", spinner: false });
      expect(busyCloudView(cloudState, false)).toEqual({ line: "computer.cloud.asleep", spinner: false });
    }
    expect(busyCloudView("provisioning", true)).toEqual({ line: "computer.phase.busyComputer", spinner: true });
    expect(busyCloudView("resuming", false)).toEqual({ line: "computer.phase.starting", spinner: true });
  });

  it("never gives any engine a passive Auto creation exception", () => {
    expect(resolveCloudPanelAction({
      computer: undefined,
      configured: true,
      cloudState: null,
      canUseCloud: true,
      autoLocal: false,
    })).toBe("auto-unavailable");
    expect(resolveCloudPanelAction({
      computer: undefined,
      configured: true,
      cloudState: "archived",
      canUseCloud: true,
      autoLocal: false,
    })).toBe("show-sleeping-computer");
  });

  it("falls back locally when the selected engine cannot use an existing computer", () => {
    expect(
      resolveCloudPanelAction({
        computer: undefined,
        configured: true,
        cloudState: "running",
        canUseCloud: false,
        autoLocal: true,
      }),
    ).toBe("local");
  });

  it("refuses cloud preview polling when a stale ready phase belongs to Auto or another destination", () => {
    const ready = {
      computer: "cloud" as const,
      cloudBackend: "vps" as const,
      phase: "ready",
      botId: "bot-a",
      resolvedBotId: "bot-a",
      resolvedComputer: "cloud" as const,
      resolvedCloudBackend: "vps" as const,
    };
    expect(shouldPollCloudPreview(ready)).toBe(true);
    expect(shouldPollCloudPreview({ ...ready, computer: undefined })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, computer: "local" })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, phase: "starting" })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, botId: "bot-b" })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, resolvedBotId: null })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, resolvedComputer: undefined })).toBe(false);
    expect(shouldPollCloudPreview({ ...ready, resolvedCloudBackend: undefined })).toBe(false);
  });

  it("rejects a stale persisted selection", () => {
    const expected = { computer: "cloud" as const, cloudBackend: "vps" as const };
    expect(persistedComputerSelectionMatches({ ...expected, persistedBot: expected })).toBe(true);
    expect(persistedComputerSelectionMatches({
      ...expected,
      persistedBot: { computer: "cloud", cloudBackend: undefined },
    })).toBe(true);
    expect(persistedComputerSelectionMatches({
      ...expected,
      persistedBot: { computer: "local", cloudBackend: "vps" },
    })).toBe(false);
    expect(persistedComputerSelectionMatches({
      ...expected,
      persistedBot: { computer: undefined, cloudBackend: "vps" },
    })).toBe(false);
  });
});

describe("what the person reads about using this computer", () => {
  const JARGON = /DevTools|CDP|profile[- ]access|grant\b|bind to|attach|endpoint|driver|\bCUA\b|Cua\b|Boat key|ACP|provider|Wayland|descriptor/i;
  const host = (platform: DesktopCapabilities["host"]["platform"], label = "Desktop") => ({ platform, label }) as DesktopCapabilities["host"];
  const reasons = [
    localComputerDisabledReason({ capabilities: { host: host("darwin"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: false }),
    localComputerDisabledReason({ capabilities: { host: host("darwin"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    localComputerDisabledReason({ capabilities: { host: host("win32"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    localComputerDisabledReason({ capabilities: { host: host("other", "Browser"), localComputer: { available: false } } as DesktopCapabilities, providerSupportsLocal: true }),
    ...["linux-wayland-seat-safety-blocked", "wayland-compositor-unsupported", "linux-hyprland-plugin-required", undefined].map((reasonCode) =>
      localComputerDisabledReason({ capabilities: { host: host("linux"), localComputer: { available: false, enabled: reasonCode !== undefined, reasonCode } } as DesktopCapabilities, providerSupportsLocal: true })),
    localComputerDisabledReason({ capabilities: { host: host("linux"), localComputer: { available: false, enabled: true } } as DesktopCapabilities, providerSupportsLocal: true }),
  ];

  it("says what to do in plain words, never the parts underneath", () => {
    expect(reasons.every((reason) => typeof reason === "string" && reason.length > 0)).toBe(true);
    for (const reason of reasons) expect(reason, reason!).not.toMatch(JARGON);
    expect(reasons[3]).toBe("Only the MausBot app on this computer can let a bot use it. Open the app here to use it.");
    expect(reasons[6]).toBe("Bots can use this computer on Omarchy once its Hyprland add-on is installed and turned on. Open Local control for the steps.");
  });

  it("keeps the same plain words in the questions and the place lines the app shows", () => {
    const shown = Object.entries(en as Record<string, string>).filter(([key]) =>
      key.startsWith("approval.yourComputer.") || key.startsWith("computer.problem.local") || key.startsWith("place.view.") || key.startsWith("place.action."));
    expect(shown.length).toBeGreaterThan(40);
    for (const [key, text] of shown) expect(text, key).not.toMatch(/DevTools|profile[- ]access|grant\b|bind to|\bCUA\b|Cua Driver|Boat key/i);
  });
});
