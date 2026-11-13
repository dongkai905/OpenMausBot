import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PROVIDER_ICON_PRESETS } from "../../shared/provider-icon";
import { FADED_PROVIDER_MARK, providerMarkTone } from "./provider-mark-fade";
import { InstanceProviderMark, PresetProviderMark, ProviderMark } from "./ProviderIcons";

const coloured = (html: string) => /#[0-9a-f]{3,8}\b|url\(#/i.test(html);

describe("the faded provider mark", () => {
  it("draws every engine's mark as its own initial, in the monochrome tone", () => {
    for (const driverKind of ["customAcp", "agent-two", "anEngineWithNoMark"]) {
      const html = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 14 }));
      expect(html).toContain(`>${driverKind.slice(0, 1).toUpperCase()}<`);
      expect(providerMarkTone({ driverKind })).toBe("mono");
    }
  });

  it.each([...PROVIDER_ICON_PRESETS])("treats the %s preset logo as brand-coloured exactly when it carries its own colours", (preset) => {
    const html = renderToStaticMarkup(createElement(PresetProviderMark, { preset, size: 14 }));
    expect(providerMarkTone({ driverKind: "customAcp", icon: { kind: "preset", preset } })).toBe(coloured(html) ? "brand" : "mono");
  });

  it("treats an engine's own picture as brand-coloured", () => {
    expect(providerMarkTone({ driverKind: "customAcp", icon: { kind: "custom", dataUrl: "data:image/png;base64,AA==" } })).toBe("brand");
  });

  it("dims a brand mark to 60% and inks a monochrome one in tertiary, both full again on hover", () => {
    const brand = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: { driverKind: "customAcp", icon: { kind: "custom", dataUrl: "data:image/png;base64,AA==" } }, size: 14, subtle: true }));
    expect(brand).toMatch(/^<span data-provider-mark="brand" class="[^"]*\bopacity-60\b[^"]*\bgroup-hover:opacity-100\b/);
    expect(brand).toContain("group-focus-within:opacity-100 touch:opacity-60");
    expect(brand).toContain('style="width:14px;height:14px"');
    const mono = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: { driverKind: "customAcp" }, size: 14, subtle: true }));
    expect(mono).toContain('data-provider-mark="mono"');
    expect(mono).toContain("[--color-ink:var(--color-ink-tertiary)]");
    expect(mono).toContain("group-hover:[--color-ink:inherit]");
    expect(mono).toContain("group-focus-within:[--color-ink:inherit]");
    expect(mono).not.toContain("opacity-60");
    expect(FADED_PROVIDER_MARK.mono).not.toContain("opacity");
  });

  it("leaves the full-strength mark alone without subtle", () => {
    const html = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: { driverKind: "customAcp" }, size: 14 }));
    expect(html).toMatch(/^<span/);
    expect(html).toContain(">C<");
    expect(html).not.toContain("data-provider-mark");
  });
});
