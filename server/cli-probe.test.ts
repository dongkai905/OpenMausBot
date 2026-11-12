import { expect, it } from "vitest";

import { testCliBinary } from "./cli-probe.ts";
import { CustomAcpDriver } from "./drivers/acp/custom.ts";

it("offers the install steps for a CLI that is missing, without the server-only download pins", async () => {
  const result = await testCliBinary("omb-missing-cli-for-this-test", CustomAcpDriver);
  expect(result.ok).toBe(false);
  // The custom engine has no install command of its own, so there is nothing to
  // offer and nothing that could carry the server's own download pins.
  expect(result.install).toBeUndefined();
});
