import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { initialState } from "@/state/store";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: initialState, dispatch: vi.fn() }) }));

import { SidebarConnectApps } from "./SidebarConnectApps";

describe("the Connect apps pill", () => {
  it("draws a 36px pill with a 14px medium label that opens the apps panel", () => {
    const html = renderToStaticMarkup(createElement(SidebarConnectApps));
    expect(html).toMatch(/class="flex h-9 min-w-0 flex-1 items-center justify-center gap-1\.5 rounded-full pl-4 pr-3 text-\[14px\] font-medium leading-5 text-ink /);
    expect(html).toContain("Connect apps");
    expect(html).toContain('data-sidebar-nav="apps"');
  });

  it("is a round 36px puzzle button on the collapsed rail, named for screen readers", () => {
    const html = renderToStaticMarkup(createElement(SidebarConnectApps, { circle: true }));
    expect(html).toMatch(/data-tour="nav-apps"[^>]*aria-label="Connect apps" title="Connect apps" class="[^"]*\bsize-9\b[^"]*\brounded-full\b/);
    expect(html).toContain("lucide-puzzle");
  });
});
