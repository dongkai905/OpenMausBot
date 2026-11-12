import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { listPriceFor } from "../model-prices.ts";
import { readStartupModelCache, writeStartupModelCache } from "../startup-model-catalog.ts";
import { currentEngineCatalog, ModelManifestStore, modelManifestCachePath } from "./manifest.ts";

// The store is one per process and the drivers read it as they load, so its cache is seeded before they are imported,
// as a later start of the app would find it.
const newer = new Date(Date.now() + 60_000).toISOString();
const path = modelManifestCachePath(DATA_DIR);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify({
  fetchedAtMs: Date.now(),
  manifest: {
    version: 1,
    updatedAt: newer,
    engines: {
      customAcp: {
        default: "acp-synthetic-9",
        models: [
          { id: "acp-synthetic-9", name: "ACP Synthetic 9", status: "current", contextWindow: 1_000_000, minCliVersion: "9.9.9" },
          { id: "acp-sonnet-5", name: "ACP Sonnet 5", status: "current" },
        ],
      },
    },
    prices: { "acp-synthetic-9": { inputPerMillion: 7, outputPerMillion: 9, asOf: "2026-11-10", source: "https://example.test/x" } },
  },
}));

it("a list on disk reaches the picker and the price table", () => {
  const store = new ModelManifestStore({ dataDir: DATA_DIR });
  const catalog = currentEngineCatalog("customAcp", store);
  expect(catalog?.options.map((option) => option.id)).toEqual(["acp-synthetic-9", "acp-sonnet-5"]);
  expect(catalog?.options[0]).toMatchObject({ contextWindow: 1_000_000 });
  expect(catalog?.default).toBe("acp-synthetic-9");
  expect(listPriceFor("acp-synthetic-9")).toMatchObject({ inputPerMillion: 7, outputPerMillion: 9 });
});

it("the startup list keeps a model's update mark", () => {
  const id = "manifest-wiring";
  writeStartupModelCache(id, { default: "a", options: [{ id: "a", label: "A", needsCliUpdate: "2.1.321" }] });
  expect(readStartupModelCache(id)?.options[0]?.needsCliUpdate).toBe("2.1.321");
});
