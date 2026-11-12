import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MANIFEST_PATH, manifestProblems } from "./check-model-manifest.mjs";

const committed = readFileSync(MANIFEST_PATH, "utf8");
const problems = (value) => manifestProblems(JSON.stringify(value, null, 2));

/** A manifest that lists the one engine, so every rule about a catalog can be checked without the committed file. */
function withEngine() {
  return {
    version: 1,
    updatedAt: "2026-11-12T00:00:00Z",
    engines: {
      customAcp: {
        default: "synthetic-model",
        models: [
          { id: "synthetic-model", name: "Synthetic", status: "current", contextWindow: 1_000_000, minCliVersion: "2.1.321" },
          { id: "second-model", name: "Second", status: "legacy" },
        ],
      },
    },
    prices: {
      "synthetic-model": { inputPerMillion: 8, cachedInputPerMillion: 0.2, outputPerMillion: 40, asOf: "2026-11-10", source: "https://example.com/x" },
    },
  };
}

/** The same manifest with one more model in it, patched. */
const withModel = (patch) => {
  const manifest = withEngine();
  manifest.engines.customAcp.models.push({ id: "another-model", name: "Another", status: "current", ...patch });
  return manifest;
};

describe("the committed model manifest", () => {
  it("passes the strict check", () => {
    expect(manifestProblems(committed)).toEqual([]);
  });

  it("lists no engine, because the models come from the CLI the one engine drives", () => {
    expect(JSON.parse(committed).engines).toEqual({});
  });
});

describe("what the CI check refuses", () => {
  it("malformed JSON", () => {
    expect(manifestProblems("{ not json")).toEqual(["the manifest is not valid JSON"]);
  });

  it("a model id the engine would not accept", () => {
    expect(problems(withModel({ id: "--dangerously-skip-permissions" }))[0]).toMatch(/models/);
    expect(problems(withModel({ id: "model; rm -rf /" }))[0]).toMatch(/models/);
    expect(problems(withModel({ id: "default" }))[0]).toMatch(/reserved/);
    expect(problems(withModel({ id: "x".repeat(200) }))[0]).toMatch(/models/);
  });

  it("a missing required field, a bad status or a CLI floor that is not a version", () => {
    const missing = withEngine();
    delete missing.engines.customAcp.models[0].status;
    expect(problems(missing)[0]).toMatch(/status/);
    expect(problems(withModel({ status: "preview" }))[0]).toMatch(/status/);
    expect(problems(withModel({ minCliVersion: "latest" }))[0]).toMatch(/minCliVersion/);
  });

  it("an unknown field, which the check treats as a typo", () => {
    expect(problems(withModel({ contextWindw: 1 }))[0]).toMatch(/contextWindw/);
  });

  it("a default that is not a listed current model", () => {
    const manifest = withEngine();
    manifest.engines.customAcp.default = "not-listed-model";
    expect(problems(manifest)[0]).toMatch(/default/);
  });

  it("a duplicate id or an alias that repeats one", () => {
    const manifest = withModel({ id: "synthetic-model" });
    expect(problems(manifest)[0]).toMatch(/listed twice/);
    expect(problems(withModel({ aliases: ["synthetic-model"] }))[0]).toMatch(/listed twice/);
  });

  it("an engine it does not know, and a manifest with no engine at all", () => {
    const unknown = withEngine();
    unknown.engines.claude = unknown.engines.customAcp;
    expect(problems(unknown)[0]).toMatch(/claude/);
    // The models the one engine offers come from the CLI it drives, so a file that lists no engine is sound.
    expect(manifestProblems(JSON.stringify({ version: 1, updatedAt: "2026-11-12T00:00:00Z", engines: {}, prices: {} }))).toEqual([]);
  });

  it("a catalog that lists an engine but no prices", () => {
    const manifest = withEngine();
    manifest.prices = {};
    expect(problems(manifest)).toContain("prices is empty");
  });

  it("a future updatedAt, which would pin every install to it", () => {
    const manifest = withEngine();
    manifest.updatedAt = "2099-01-01T00:00:00Z";
    expect(problems(manifest)[0]).toMatch(/future/);
  });

  it("a price that is not a number, negative or absurd", () => {
    const manifest = withEngine();
    manifest.prices["synthetic-model"].inputPerMillion = "2";
    expect(problems(manifest)[0]).toMatch(/inputPerMillion/);
    manifest.prices["synthetic-model"].inputPerMillion = -1;
    expect(problems(manifest)[0]).toMatch(/inputPerMillion/);
    manifest.prices["synthetic-model"].inputPerMillion = 2_000_000;
    expect(problems(manifest)[0]).toMatch(/inputPerMillion/);
  });

  it("an edit whose updatedAt did not move forward", () => {
    const edited = withEngine();
    edited.engines.customAcp.models[1].name = "Edited name";
    expect(manifestProblems(JSON.stringify(edited), { previous: committed })[0]).toMatch(/updatedAt/);
    const bumped = { ...edited, updatedAt: new Date(Date.parse(edited.updatedAt) + 1000).toISOString() };
    expect(manifestProblems(JSON.stringify(bumped), { previous: committed })).toEqual([]);
    expect(manifestProblems(committed, { previous: committed })).toEqual([]);
  });
});
