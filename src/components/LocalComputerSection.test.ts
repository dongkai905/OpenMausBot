import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const storeFixture = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: storeFixture.config }, dispatch: vi.fn() }) };
});

import {
  LocalComputerSection,
  LocalVmIdleTimeoutSetting,
  LocalVmInventoryCard,
  confirmComputerAction,
  localVmInventoryState,
  parseLocalVmIdleTimeoutMinutes,
  perBotLocalVmDeletePlan,
  vpsComputerRemovePlan,
  vpsComputerInventoryState,
  vpsComputerShortId,
  type LocalVmInventoryInstance,
  type VpsComputerInventoryInstance,
} from "./LocalComputerSection";
import { computerInventoryRequest } from "@/lib/computer-requests";
import { VpsComputersCard } from "./VpsComputersCard";

const cloudVm: LocalVmInventoryInstance = {
  botId: "cloud-bot",
  name: "Research",
  destination: "cloud",
  container: "running",
  ready: true,
  managed: true,
  problem: null,
  inUse: false,
};

afterEach(() => setLocale("en"));

describe("computer inventory request wiring", () => {
  it("keeps every mount and refresh request observation-only", () => {
    const controller = new AbortController();
    const requests = ([
      ["status", "/api/local-computer"],
      ["local-vms", "/api/local-computer/instances"],
      ["vps", "/api/computers/vps"],
    ] as const).map(([kind, expectedUrl]) => ({
      expectedUrl,
      request: computerInventoryRequest(kind, controller.signal),
    }));

    for (const { expectedUrl, request: [url, init] } of requests) {
      expect(url).toBe(expectedUrl);
      expect(init).toEqual({ signal: controller.signal });
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
    }
  });

  it("does not expose a destructive request when confirmation is cancelled", () => {
    const confirm = vi.fn(() => false);
    const request = confirmComputerAction(perBotLocalVmDeletePlan(cloudVm), confirm);

    expect(request).toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      "Delete Research's private desktop? Its durable folder and website sign-ins are kept. Apps installed inside the desktop and files outside the durable folder are deleted.",
    );
  });

  it("builds the exact confirmed Local VM and VPS lifecycle requests", () => {
    const confirm = vi.fn(() => true);
    const local = confirmComputerAction(perBotLocalVmDeletePlan(cloudVm), confirm);
    const vpsName = "openmausbot-vps-current-123456abcdef";
    const vps = confirmComputerAction(vpsComputerRemovePlan({
      name: vpsName,
      state: "running",
      vpsAlias: "alpha-vps",
      ownerBotId: "current-owner",
      ownerName: "Research",
      orphaned: false,
      inUse: false,
    }), confirm);

    expect(local).toEqual([
      "/api/bots/cloud-bot/local-computer/remove",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ]);
    expect(vps).toEqual([
      `/api/computers/vps/${vpsName}/remove`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: vpsName, alias: "alpha-vps" }),
      },
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("Local VM inventory UI", () => {
  it("shows capacity, current destinations, health, and an in-use deletion guard", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [
        cloudVm,
        {
          botId: "off-bot",
          name: "Archive",
          destination: "off",
          container: "stopped",
          ready: false,
          managed: true,
          problem: "This desktop image cannot safely resume; recreate the Local VM",
          inUse: true,
        },
      ],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("2/4 created");
    expect(markup).toContain("Current destination: Cloud");
    expect(markup).toContain("Current destination: Off");
    expect(markup).toContain("In use");
    expect(markup).toContain("Stop this bot&#x27;s turn before deleting its desktop.");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).not.toMatch(/viewer_url|workspace_path|password=/);
  });

  it("keeps state labels honest", () => {
    expect(localVmInventoryState(cloudVm)).toBe("Running");
    expect(localVmInventoryState({ ...cloudVm, ready: false })).toBe("Needs attention");
    expect(localVmInventoryState({ ...cloudVm, container: "stopped", ready: false })).toBe("Stopped");
    expect(localVmInventoryState({ ...cloudVm, inUse: true })).toBe("In use");
  });

  it("does not claim there are no VMs when the runtime cannot be inspected", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: "Start docker first",
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("Inventory unavailable");
    expect(markup).toContain("Start docker first");
    expect(markup).not.toContain("No per-bot desktops have been created");
  });

  it("disables deletion while refreshing an existing inventory", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [cloudVm],
      maxInstances: 4,
      loading: true,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("shows unmanaged containers without offering an unsafe delete action", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [{
        ...cloudVm,
        managed: false,
        ready: false,
        problem: "Container labels do not match",
      }],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("Not managed");
    expect(markup).toContain("not managed by MausBot");
    expect(markup).toContain("remove it directly in Docker or Podman");
    expect(markup).not.toContain(">Delete</button>");
    expect(markup).not.toContain("Container labels do not match");
  });
});

describe("VPS computer inventory UI", () => {
  const ownedVps: VpsComputerInventoryInstance = {
    name: "openmausbot-vps-current-123456abcdef",
    state: "running",
    vpsAlias: "production-vps",
    ownerBotId: "current-owner",
    ownerName: "Research",
    orphaned: false,
    inUse: false,
  };
  const renderCard = (overrides: Partial<Parameters<typeof VpsComputersCard>[0]> = {}) =>
    renderToStaticMarkup(createElement(VpsComputersCard, {
      instances: [],
      configured: true,
      aliases: ["production-vps"],
      loading: false,
      removingName: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onRemove: vi.fn(),
      ...overrides,
    }));

  it("shows the configured host, owners, orphans, and status without raw container details", () => {
    const orphanName = "openmausbot-vps-deleted-abcdef123456";
    const markup = renderCard({
      instances: [
        ownedVps,
        {
          name: orphanName,
          state: "exited",
          vpsAlias: "production-vps",
          ownerBotId: null,
          ownerName: null,
          orphaned: true,
          inUse: false,
        },
      ],
    });

    expect(markup).toContain("SSH host: production-vps");
    expect(markup).toContain("Research");
    expect(markup).toContain("Owned by this bot");
    expect(markup).toContain("Leftover desktop · ID ef123456");
    expect(markup).toContain("Its bot no longer exists");
    expect(markup).toContain("Running");
    expect(markup).toContain("Stopped");
    expect(markup).not.toMatch(new RegExp(`${ownedVps.name}|${orphanName}|containerId|VNC_PW|password`));
  });

  it("derives a stable identifier without exposing the bot-derived container name", () => {
    expect(vpsComputerShortId("openmausbot-vps-deleted-abcdef123456")).toBe("ef123456");
    expect(vpsComputerShortId("unexpected-provider-name")).toBe("unknown");
  });

  it("disables removal while the owner is working", () => {
    const markup = renderCard({ instances: [{ ...ownedVps, inUse: true }] });

    expect(markup).toContain("In use");
    expect(markup).toContain("Stop this bot&#x27;s work before removing its desktop.");
    expect(markup).toContain("disabled=\"\"");
  });

  it("disables removal while refreshing an existing inventory", () => {
    const markup = renderCard({ instances: [ownedVps], loading: true });

    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("keeps disconnected, unavailable, and empty states distinct", () => {
    const disconnected = renderCard({ configured: false, aliases: [] });
    expect(disconnected).toContain("To use your own VPS, add its SSH alias");
    expect(disconnected.match(/No VPS is set up yet/g)).toHaveLength(1);
    expect(disconnected).not.toContain("aria-busy");
    expect(renderCard({ unavailableReason: "SSH host cannot be reached" })).toContain("SSH host cannot be reached");
    expect(renderCard()).toContain("No MausBot desktops found on your VPS");
  });

  it("tags computers on more than one server and keeps reachable rows beside the warning", () => {
    const second = {
      ...ownedVps,
      name: "openmausbot-vps-second-123456abcdef",
      vpsAlias: "alpha-vps",
      ownerName: "Ops",
    };
    const multi = renderCard({ aliases: ["production-vps", "alpha-vps"], instances: [ownedVps, second] });
    expect(multi).toContain("SSH host: production-vps, alpha-vps");
    expect(multi).toContain("alpha-vps");
    expect(multi).not.toMatch(new RegExp(`${second.name}|containerId|VNC_PW`));

    // One unreachable server must not hide the computers it could still list.
    const partial = renderCard({
      aliases: ["production-vps", "alpha-vps"],
      instances: [ownedVps, second],
      unavailableReason: "Docker over SSH could not list managed computers on alpha-vps",
    });
    expect(partial).toContain("Docker over SSH could not list managed computers on alpha-vps");
    expect(partial).toContain("Research");
    expect(partial).toContain("Ops");
  });

  it("uses honest status labels", () => {
    expect(vpsComputerInventoryState(ownedVps)).toBe("Running");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "exited" })).toBe("Stopped");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "paused" })).toBe("Paused");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "restarting" })).toBe("Restarting");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "dead" })).toBe("Needs attention");
    expect(vpsComputerInventoryState({ ...ownedVps, inUse: true })).toBe("In use");
  });

  it("keeps running and paused VPS badge colors when labels are translated", () => {
    setLocale("pt-br");
    const running = renderCard({ instances: [ownedVps] });
    expect(running).toContain('bg-success/15 text-success">Em execução</span>');
    expect(running).toContain("Remover");
    expect(running).not.toContain(">Remove</button>");
    expect(renderCard({ instances: [{ ...ownedVps, state: "paused" }] }))
      .toContain('bg-control text-ink-secondary">Pausado</span>');
  });
});

describe("Settings → Computers on an OMB Cloud home", () => {
  afterEach(() => { storeFixture.config = null; });
  const cards = () => [...renderToStaticMarkup(createElement(LocalComputerSection)).matchAll(/<div class="text-\[16px\] font-semibold text-ink[^"]*">([^<]+)<\/div>/g)].map((match) => match[1]);

  it("sets up a Local VM on a desktop or self-hosted server", () => {
    const titles = cards();
    expect(titles).toEqual(expect.arrayContaining(["Self-hosted VPS computers", "Private desktops", "Setup"]));
    // The provider's computer card is gone for good: no provider desktops, and no key to add them.
    expect(titles).not.toContain("Cloud desktops");
  });

  it("shows no Local VM, and no steps to install one, where it cannot exist", () => {
    storeFixture.config = { cloudHome: true };
    const titles = cards();
    expect(titles).toContain("Self-hosted VPS computers");
    expect(titles).not.toContain("Private desktops");
    expect(titles).not.toContain("Setup");
    expect(titles).not.toContain("Cloud desktops");
  });
});

describe("Local VM idle timeout setting", () => {
  it.each([["5", 5], ["30", 30], [" 480 ", 480], ["1440", 1_440]])("accepts %j", (value, minutes) => {
    expect(parseLocalVmIdleTimeoutMinutes(value)).toBe(minutes);
  });

  it.each(["", "4", "1441", "1.5", "-30", "30m", "1e2"])("rejects %j", (value) => {
    expect(parseLocalVmIdleTimeoutMinutes(value)).toBeNull();
  });

  it("shows the confirmed window as a bounded, labelled minutes field", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmIdleTimeoutSetting, {
      minutes: 30,
      disabled: false,
      onSave: async () => {},
    }));
    expect(markup).toContain('for="local-vm-idle-timeout"');
    expect(markup).toContain("Stop idle desktops after");
    expect(markup).toContain('min="5"');
    expect(markup).toContain('max="1440"');
    expect(markup).toContain('value="30"');
    expect(markup).toContain("minutes");
  });
});
