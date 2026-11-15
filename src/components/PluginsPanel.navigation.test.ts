import { Children, createElement, isValidElement, type DependencyList, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PluginsPanel's own state, seeded by call order: effects never run under server rendering, so a panel that is
// already loaded is drawn as a finished fetch would leave it.
const fixture = vi.hoisted(() => ({
  surface: "apps" as "apps" | "mcp",
  dispatch: vi.fn(),
  bots: [] as unknown[],
  instances: [] as unknown[],
  overrides: new Map<number, unknown>(),
  index: 0,
  counting: false,
  effects: [] as Array<{ effect: EffectCallback; deps?: DependencyList }>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: EffectCallback, deps?: DependencyList) => { fixture.effects.push({ effect, deps }); },
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      const seeded = fixture.overrides.has(index) ? fixture.overrides.get(index) : typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [seeded, (value: unknown) => {
        const current = fixture.overrides.has(index) ? fixture.overrides.get(index) : seeded;
        fixture.overrides.set(index, typeof value === "function" ? (value as (current: unknown) => unknown)(current) : value);
      }];
    },
  };
});
vi.mock("@/state/store", () => ({
  api: vi.fn(() => new Promise(() => {})),
  useStore: () => ({
    state: { pluginsSurface: fixture.surface, bots: fixture.bots, instances: fixture.instances },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("./McpServersPanel", async () => {
  const { HOSTED_MCP_APPS } = await import("@/lib/hosted-mcp-apps");
  return {
    McpServersPanel: ({ embedded, hostedCards }: { embedded?: boolean; hostedCards?: { shown(id: string): boolean } }) => hostedCards
      ? createElement("div", { "data-hosted-cards": true }, HOSTED_MCP_APPS.filter((app) => hostedCards.shown(app.id)).map((app) => createElement("div", { key: app.id, "data-hosted-app": app.id }, `Connect ${app.label}`)))
      : createElement("div", { "data-embedded": String(Boolean(embedded)) }, "MCP inventory"),
  };
});
vi.mock("./Avatar", () => ({ BotAvatar: () => createElement("span", { "data-avatar": true }) }));
vi.mock("./XCard", () => ({
  X_CARD_SEARCH: "x twitter treg tweets posts",
  XCard: () => createElement("div", { "data-x-card": true }, "X (Twitter)"),
}));
vi.mock("./EmailCard", () => ({
  EmailCard: () => createElement("div", { "data-email-card": true }, "Email"),
}));
vi.mock("./PostizCard", () => ({
  PostizCard: () => createElement("div", { "data-postiz-card": true }, "Postiz"),
}));
import { HOSTED_MCP_APPS } from "@/lib/hosted-mcp-apps";
import { PluginsPanel } from "./PluginsPanel";

const SEARCH = 0;
const TAB = 1;
const HOSTED_CONNECTED = 2;
const X_CONNECTED = 4;
const POSTIZ_CONNECTED = 5;
const EMAIL_CONNECTED = 6;

type Node = ReactElement<{ children?: ReactNode; "aria-pressed"?: boolean; "data-apps-filter"?: string; onClick?: () => void; [key: string]: unknown }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree!: ReturnType<typeof PluginsPanel>;
  function Capture() {
    fixture.index = 0;
    fixture.counting = true;
    try { tree = PluginsPanel(); } finally { fixture.counting = false; }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const chip = (tree: Node[], id: string) => tree.find((node) => node.props["data-apps-filter"] === id)!;

beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.surface = "apps";
  fixture.dispatch.mockReset();
  fixture.effects = [];
  fixture.bots = [];
  fixture.instances = [];
  fixture.overrides = new Map<number, unknown>();
});
afterEach(() => vi.unstubAllGlobals());

describe("Apps pop-up", () => {
  it("offers every hosted app inside the apps grid", () => {
    const { html, nodes: tree } = render();
    const grid = tree.find((node) => node.props["data-apps-grid"] !== undefined)!;
    expect(nodes(grid).some((node) => node.props.hostedCards !== undefined)).toBe(true);
    for (const app of HOSTED_MCP_APPS) {
      expect(html).toContain(`Connect ${app.label}`);
    }
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("counts every connected hosted app among connected apps", () => {
    const everyApp = (connected: boolean) => Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, connected]));
    fixture.overrides.set(HOSTED_CONNECTED, everyApp(true));
    expect(render().html).toContain(`${HOSTED_MCP_APPS.length} connected`);
    fixture.overrides.set(HOSTED_CONNECTED, { ...everyApp(false), [HOSTED_MCP_APPS[0].id]: true });
    expect(render().html).toContain("1 connected");
  });

  it.each(HOSTED_MCP_APPS)("finds $label by its own name and shows no other hosted card", (app) => {
    fixture.overrides.set(SEARCH, app.label.toLowerCase());
    const html = render().html;
    expect(html).toContain(`data-hosted-app="${app.id}"`);
    expect(html.match(/data-hosted-app="/g)).toHaveLength(1);
  });

  it("shows a hosted card under Connected only while it is not known to be disconnected", () => {
    fixture.overrides.set(TAB, "connected");
    expect(render().html).toContain(`data-hosted-app="${HOSTED_MCP_APPS[0].id}"`);
    fixture.overrides.set(HOSTED_CONNECTED, Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, app === HOSTED_MCP_APPS[0]])));
    const html = render().html;
    expect(html).toContain(`data-hosted-app="${HOSTED_MCP_APPS[0].id}"`);
    for (const other of HOSTED_MCP_APPS.slice(1)) expect(html).not.toContain(`data-hosted-app="${other.id}"`);
  });

  it("keeps the native app cards in the grid, and counts them once they are connected", () => {
    const { html, nodes: tree } = render();
    expect(html).toContain("data-x-card");
    expect(html).toContain("data-email-card");
    expect(html).toContain("data-postiz-card");
    expect(tree.find((node) => node.props["data-native-card"] === "x")?.props.className).toBe("contents");
    expect(html).toContain("Connected");

    fixture.overrides.set(X_CONNECTED, true);
    expect(render().html).toContain("1 connected");
    fixture.overrides.set(EMAIL_CONNECTED, true);
    expect(render().html).toContain("2 connected");
    fixture.overrides.set(POSTIZ_CONNECTED, true);
    expect(render().html).toContain("3 connected");
  });

  it("hides a native card under Connected once it is known to be disconnected", () => {
    fixture.overrides.set(TAB, "connected");
    fixture.overrides.set(X_CONNECTED, false);
    expect(render().nodes.find((node) => node.props["data-native-card"] === "x")?.props.className).toBe("hidden");
    fixture.overrides.set(X_CONNECTED, true);
    expect(render().nodes.find((node) => node.props["data-native-card"] === "x")?.props.className).toBe("contents");
  });

  it("keeps the MCP servers on their own tab", () => {
    fixture.surface = "mcp";
    const { html, nodes: tree } = render();
    expect(tree.find((node) => node.props["data-apps-grid"])).toBeUndefined();
    expect(html).toContain("MCP inventory");
  });

  it("keeps the MCP servers panel under the apps too, without the hosted cards' servers", () => {
    const { html } = render();
    expect(html).toContain("MCP inventory");
    expect(html).toContain("data-hosted-cards");
  });

  it("switches to the MCP servers tab from the MCP chip", () => {
    const tree = render().nodes;
    chip(tree, "mcp").props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true, surface: "mcp" });
  });

  it("keeps the connected view on the apps surface, with no second tab to leave", () => {
    const tree = render().nodes;
    chip(tree, "connected").props.onClick!();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("says what is connected in the header, and how many", () => {
    const { html, nodes: tree } = render();
    expect(tree.find((node) => node.props["data-apps-filter"] === "connected")?.props["aria-pressed"]).toBe(false);
    expect(html).toContain("Apps");
  });
});
