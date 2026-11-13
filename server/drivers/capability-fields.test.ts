// Whether an engine can work on the cloud computer is one rule over one fact: it has computer tools (computerMcp).
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canWorkOnCloud } from "../../shared/cloud-computer.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { CustomAcpDriver } from "./acp/custom.ts";

const created: ProviderInstance[] = [];
const onBoat = (instance: ProviderInstance) =>
  canWorkOnCloud({ computerMcp: instance.adapter.capabilities.computerMcp });
const keep = async (promise: Promise<ProviderInstance>): Promise<ProviderInstance> => {
  const instance = await promise;
  created.push(instance);
  return instance;
};

describe("typed capability fields for the cloud computer", () => {
  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    for (const instance of created.splice(0)) await instance.dispose();
  });

  it("lets host-harness drivers with computer tools use the cloud computer on their own engine", async () => {
    const custom = await keep(CustomAcpDriver.create({
      instanceId: "caps-custom", displayName: "Caps Custom", environment: {}, enabled: true,
      config: { cli: "echo", fullAuto: false },
    }));
    expect(onBoat(custom)).toBe(true);
  });

  it("registers no driver that runs a turn somewhere other than its own engine", async () => {
    expect(BUILT_IN_DRIVERS.map(driver => driver.driverKind)).not.toContain("boxAgent");
    for (const driver of BUILT_IN_DRIVERS) {
      const instance = await keep(driver.create({
        instanceId: `caps-fleet-${driver.driverKind}`, displayName: "Caps Fleet", environment: {}, enabled: true,
        config: driver.driverKind === "customAcp" ? { cli: "echo", fullAuto: false } : {},
      }));
      expect(instance.adapter.capabilities, driver.driverKind).not.toHaveProperty("remoteAgent");
    }
  });
});
