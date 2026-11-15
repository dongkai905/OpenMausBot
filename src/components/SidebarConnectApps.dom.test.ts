// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { initialState } from "@/state/store";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: initialState, dispatch: vi.fn() }) }));

import { SidebarConnectApps } from "./SidebarConnectApps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function pill(circle = false) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root.render(createElement(SidebarConnectApps, { circle })); });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const button = document.querySelector<HTMLButtonElement>('[data-sidebar-nav="apps"]')!;
  const seen = { label: circle ? button.getAttribute("aria-label") : button.firstElementChild!.textContent, faces: [...button.querySelectorAll("[data-app-face]")].map((face) => face.getAttribute("data-app-face")) };
  act(() => root.unmount());
  document.body.innerHTML = "";
  return seen;
}

it("is the way into the apps panel, on the rail too", async () => {
  expect(await pill()).toEqual({ label: "Connect apps", faces: [] });
  expect((await pill(true)).label, "and on the collapsed rail").toBe("Connect apps");
});
