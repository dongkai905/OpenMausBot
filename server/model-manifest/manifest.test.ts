import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUNDLED_MODEL_MANIFEST, bundledEngineCatalog, engineCatalogFrom } from "./bundled.ts";
import {
  MANIFEST_DISABLE_ENV,
  MANIFEST_ON_DEMAND_TTL_MS,
  MANIFEST_RETRY_MS,
  MANIFEST_TTL_MS,
  ModelManifestStore,
  currentEngineCatalog,
  modelManifestCachePath,
  withCliVersionGate,
} from "./manifest.ts";
import { SAFE_MODEL_ID, parseModelManifest, type ModelManifestData } from "./schema.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-model-manifest-"));
  scratchDirs.push(dir);
  return dir;
}

function manifest(updatedAt: string, ids = ["synthetic-current"], extra: Partial<ModelManifestData> = {}): ModelManifestData {
  return {
    version: 1,
    updatedAt,
    engines: {
      customAcp: { default: ids[0]!, models: ids.map((id) => ({ id, name: id, status: "current" as const })) },
    },
    ...extra,
  };
}

const bundled = manifest("2026-11-01T00:00:00Z", ["bundled-model"]);

function json(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
}

function store(options: Partial<ConstructorParameters<typeof ModelManifestStore>[0]> & { fetch?: typeof fetch; dir?: string } = {}) {
  const { dir = dataDir(), ...rest } = options;
  const log = vi.fn();
  let time = NOW;
  return {
    dir,
    log,
    advance: (ms: number) => { time += ms; },
    manifest: new ModelManifestStore({ dataDir: dir, bundled, now: () => time, log, env: {}, ...rest }),
  };
}

function writeCache(dir: string, data: unknown, fetchedAtMs = NOW - 1000): void {
  const path = modelManifestCachePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ fetchedAtMs, manifest: data }));
}

describe("reading the current list", () => {
  it("starts from the bundled copy and never touches the network", () => {
    const fetchMock = vi.fn();
    const { manifest: subject } = store({ fetch: fetchMock });
    expect(subject.current().engines.customAcp!.models[0]!.id).toBe("bundled-model");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads a newer disk cache", () => {
    const dir = dataDir();
    writeCache(dir, manifest("2026-11-05T00:00:00Z", ["cached-model"]));
    expect(store({ dir }).manifest.current().engines.customAcp!.models[0]!.id).toBe("cached-model");
  });

  it("an older or corrupt disk cache never overrides the bundled copy", () => {
    const dir = dataDir();
    writeCache(dir, manifest("2026-10-01T00:00:00Z", ["old-cached-model"]));
    expect(store({ dir }).manifest.current().engines.customAcp!.models[0]!.id).toBe("bundled-model");
    writeFileSync(modelManifestCachePath(dir), "{ corrupt");
    expect(store({ dir }).manifest.current().engines.customAcp!.models[0]!.id).toBe("bundled-model");
  });
});

describe("downloads", () => {
  it("keeps a newer download, caches it on disk and tells listeners once", async () => {
    const fetchMock = vi.fn(async () => json(manifest("2026-11-09T00:00:00Z", ["remote-model"])));
    const subject = store({ fetch: fetchMock as unknown as typeof fetch });
    const changed = vi.fn();
    subject.manifest.onChange(changed);
    await subject.manifest.refresh();
    expect(subject.manifest.current().engines.customAcp!.models[0]!.id).toBe("remote-model");
    expect(changed).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(readFileSync(modelManifestCachePath(subject.dir), "utf8")) as { manifest: ModelManifestData };
    expect(saved.manifest.updatedAt).toBe("2026-11-09T00:00:00Z");
  });

  it("rejects a stale download older than the current list", async () => {
    const fetchMock = vi.fn(async () => json(manifest("2026-10-20T00:00:00Z", ["stale-model"])));
    const subject = store({ fetch: fetchMock as unknown as typeof fetch });
    await subject.manifest.refresh();
    expect(subject.manifest.current().engines.customAcp!.models[0]!.id).toBe("bundled-model");
    expect(existsSync(modelManifestCachePath(subject.dir))).toBe(false);
    expect(subject.log).toHaveBeenCalledWith(expect.stringMatching(/older/));
  });

  it("ignores a bad download and keeps the last good list", async () => {
    const bodies: Array<() => Response> = [
      () => json("{ not json"),
      () => json({ ...manifest("2026-11-09T00:00:00Z"), version: 2 }),
      () => json({ ...manifest("2026-11-09T00:00:00Z"), engines: { customAcp: { default: "a", models: [{ id: "a", name: "a", status: "bogus" }] } } }),
      () => json("", { status: 500 }),
      () => json(manifest("2099-01-01T00:00:00Z", ["future-model"])),
    ];
    for (const body of bodies) {
      const subject = store({ fetch: vi.fn(async () => body()) as unknown as typeof fetch });
      await subject.manifest.refresh({ force: true });
      expect(subject.manifest.current().engines.customAcp!.models[0]!.id).toBe("bundled-model");
      expect(existsSync(modelManifestCachePath(subject.dir))).toBe(false);
    }
  });

  it("refuses an oversized download, stated or streamed, even when its JSON is valid", async () => {
    const body = JSON.stringify(manifest("2026-11-09T00:00:00Z", ["big-model"]));
    const maxBytes = body.length - 1;
    const stream = () => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } });
    for (const { response, maxBytes: limit } of [
      { response: new Response(body, { status: 200, headers: { "content-length": String(body.length + 2) } }), maxBytes: body.length + 1 },
      { response: new Response(stream(), { status: 200 }), maxBytes },
    ]) {
      const subject = store({ fetch: vi.fn(async () => response) as unknown as typeof fetch, maxBytes: limit });
      await subject.manifest.refresh({ force: true });
      expect(subject.manifest.current().engines.customAcp!.models[0]!.id).toBe("bundled-model");
    }
    const fits = store({ fetch: vi.fn(async () => new Response(stream(), { status: 200 })) as unknown as typeof fetch, maxBytes: body.length });
    await fits.manifest.refresh({ force: true });
    expect(fits.manifest.current().engines.customAcp!.models[0]!.id).toBe("big-model");
  });

  it("drops a model id that would not reach the CLI safely", async () => {
    for (const id of ["--skip-permissions", "bad id", "`whoami`"]) {
      const payload = manifest("2026-11-09T00:00:00Z", ["ok-model"]);
      payload.engines.customAcp!.models.push({ id, name: "x", status: "current" });
      const subject = store({ fetch: vi.fn(async () => json(payload)) as unknown as typeof fetch });
      await subject.manifest.refresh({ force: true });
      expect(subject.manifest.current().engines.customAcp!.models[0]!.id).toBe("bundled-model");
    }
    expect(SAFE_MODEL_ID.test("--skip-permissions")).toBe(false);
  });

  it("offline: a failed fetch keeps the current list and backs off", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const subject = store({ fetch: fetchMock as unknown as typeof fetch });
    await subject.manifest.refresh();
    expect(subject.manifest.current().engines.customAcp!.models[0]!.id).toBe("bundled-model");
    await subject.manifest.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    subject.advance(MANIFEST_RETRY_MS + 1);
    await subject.manifest.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing when fetching is switched off", async () => {
    const fetchMock = vi.fn();
    const subject = store({ fetch: fetchMock as unknown as typeof fetch, env: { [MANIFEST_DISABLE_ENV]: "1" } });
    await subject.manifest.refresh({ force: true });
    await subject.manifest.refreshOnDemand();
    subject.manifest.refreshInBackground();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits an hour in the background and five minutes when the list is opened", async () => {
    const fetchMock = vi.fn(async () => json(manifest("2026-11-09T00:00:00Z", ["remote-model"])));
    const subject = store({ fetch: fetchMock as unknown as typeof fetch });
    await subject.manifest.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await subject.manifest.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    subject.advance(MANIFEST_ON_DEMAND_TTL_MS + 1);
    await subject.manifest.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await subject.manifest.refreshOnDemand();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    subject.advance(MANIFEST_TTL_MS + 1);
    await subject.manifest.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares one request between concurrent refreshes", async () => {
    let answer!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const subject = store({ fetch: fetchMock as unknown as typeof fetch });
    const first = subject.manifest.refresh({ force: true });
    const second = subject.manifest.refreshOnDemand();
    await Promise.resolve();
    await Promise.resolve();
    answer(json(manifest("2026-11-09T00:00:00Z", ["remote-model"])));
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a download that left the engine out leaves the current list without one", async () => {
    const withoutEngines = manifest("2026-11-09T00:00:00Z");
    withoutEngines.engines = {};
    const subject = store({ fetch: vi.fn(async () => json(withoutEngines)) as unknown as typeof fetch });
    await subject.manifest.refresh();
    // The download has no engine, so the current list offers none for it.
    expect(engineCatalogFrom(subject.manifest.current(), "customAcp")).toBeNull();
    // The fallback is the bundled file, which carries no catalog either.
    expect(currentEngineCatalog("customAcp", subject.manifest)).toBeNull();
  });
});

describe("the CLI version gate", () => {
  const payload = (): ModelManifestData => manifest("2026-11-09T00:00:00Z", ["base-model", "new-model"]);
  const gated = () => {
    const data = payload();
    data.engines.customAcp!.models[1]!.minCliVersion = "2.1.321";
    return store({ bundled: data }).manifest;
  };
  const catalog = () => ({ default: "base-model", options: [{ id: "base-model", label: "b" }, { id: "new-model", label: "n" }, { id: "local", label: "l", custom: true as const }] });

  it("marks a model the installed CLI is too old for and leaves the rest", () => {
    const options = withCliVersionGate(catalog(), "customAcp", [2, 1, 320], gated()).options;
    expect(options.find((option) => option.id === "new-model")?.needsCliUpdate).toBe("2.1.321");
    expect(options.find((option) => option.id === "base-model")?.needsCliUpdate).toBeUndefined();
    expect(options.find((option) => option.id === "local")?.needsCliUpdate).toBeUndefined();
  });

  it("clears the mark once the CLI is new enough, and marks nothing for an unknown version", () => {
    const store = gated();
    const marked = withCliVersionGate(catalog(), "customAcp", [2, 1, 320], store);
    expect(withCliVersionGate(marked, "customAcp", [2, 1, 321], store).options.find((option) => option.id === "new-model")?.needsCliUpdate).toBeUndefined();
    expect(withCliVersionGate(marked, "customAcp", null, store).options.find((option) => option.id === "new-model")?.needsCliUpdate).toBeUndefined();
  });

  it("moves a gated default to the first usable model", () => {
    const data = payload();
    data.engines.customAcp!.models[1]!.minCliVersion = "9.0.0";
    const subject = store({ bundled: data }).manifest;
    expect(withCliVersionGate({ ...catalog(), default: "new-model" }, "customAcp", [2, 1, 320], subject).default).toBe("base-model");
  });
});

describe("the picker list", () => {
  it("offers only current models and keeps the default", () => {
    const data = manifest("2026-11-01T00:00:00Z", ["keep-model", "retired-model"]);
    data.engines.customAcp!.models[1]!.status = "legacy";
    const catalog = engineCatalogFrom(data, "customAcp")!;
    expect(catalog.options.map((option) => option.id)).toEqual(["keep-model"]);
    expect(catalog.default).toBe("keep-model");
  });

  it("the bundled manifest is valid and lists no catalog of its own", () => {
    expect(parseModelManifest(BUNDLED_MODEL_MANIFEST, { strict: true }).ok).toBe(true);
    // The only engine is customAcp and the models it offers come from the CLI it drives, so the file carries no catalog.
    expect(BUNDLED_MODEL_MANIFEST.engines.customAcp).toBeUndefined();
    expect(bundledEngineCatalog("customAcp")).toBeNull();
  });
});

describe("the schema", () => {
  const fine = (extra: object = {}) => ({ ...manifest("2026-11-09T00:00:00Z"), ...extra });

  it("tolerates a field added on main later, so older installs keep updating", () => {
    const parsed = parseModelManifest({ ...fine(), somethingNew: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest).not.toHaveProperty("somethingNew");
  });

  it("is strict when asked, so a typo fails the CI check", () => {
    expect(parseModelManifest({ ...fine(), somethingNew: true }, { strict: true }).ok).toBe(false);
  });

  it("rejects a schema version it does not know", () => {
    expect(parseModelManifest({ ...fine(), version: 2 }).ok).toBe(false);
  });

  it("rejects a default that is not a current listed model", () => {
    const data = manifest("2026-11-09T00:00:00Z", ["only-model"]);
    data.engines.customAcp!.default = "other-model";
    expect(parseModelManifest(data).ok).toBe(false);
  });
});
