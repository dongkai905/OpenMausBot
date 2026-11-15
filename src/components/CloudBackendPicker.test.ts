import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import en from "@/locales/en.json";

const fixture = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config }, dispatch: vi.fn() }) };
});

const { CloudBackendPicker } = await import("./CloudBackendPicker");
const picker = (compact = false) => renderToStaticMarkup(createElement(CloudBackendPicker, { value: "vps", compact, onChange: () => {} }));

describe("CloudBackendPicker", () => {
  afterEach(() => { fixture.config = null; });

  it("names the one backend that is left: the person's own VPS", () => {
    fixture.config = { cloudHome: false };
    const markup = picker();
    expect(markup).toContain("Self-hosted VPS");
    expect(markup).toContain("Auto reuses a running desktop on your VPS.");
    expect(picker(true)).toContain("Your own server, connected over SSH.");
  });

  it("is hidden on My Cloud", () => {
    fixture.config = { cloudHome: true };
    expect(picker()).toBe("");
  });

  it("offers no other backend, and no message that asks for one", () => {
    fixture.config = { cloudHome: false };
    const markup = picker();
    expect(markup).not.toContain("Boat");
    expect(markup).not.toMatch(/disabled/);
    expect(markup).not.toMatch(/ACP model provider/);
  });

  it("leaves no message that tells someone to switch backends for an engine", () => {
    expect(Object.keys(en)).not.toContain("computer.err.vpsEngine");
    expect(Object.values(en).filter((value) => /switch the cloud backend to Boat/i.test(value))).toEqual([]);
  });
});
