import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { locales } from "@/locales";
import { rowsBody, secretRow } from "./mcp-draft";
import { ConnectorCard } from "./ConnectorCard";
import { McpServersPanel } from "./McpServersPanel";

vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }),
}));

afterEach(() => {
  setLocale("en");
});

describe("plugins modal translation", () => {
  it("translates an MCP environment parse error without touching the offending line", () => {
    setLocale("de");
    expect(rowsBody([secretRow({ name: "NOT A KEY", value: "value" })], "env")).toEqual({
      ok: false,
      error: { key: "mcp.env.invalidName", params: { key: "NOT A KEY" } },
    });
  });

  it("translates the Agentcard card's generic strings and leaves its untranslated copy in English", () => {
    setLocale("ja");
    const html = renderToStaticMarkup(createElement(() => McpServersPanel({ hostedCards: { shown: () => true, onConnections: () => {} } })));
    expect(html).toContain(`aria-label="${locales.ja!["hostedMcp.connect"]!.replace("{service}", "Agentcard")}"`);
    expect(html).toContain(locales.ja!["hostedMcp.access"]);
    expect(html).not.toContain("Connect Agentcard");
    expect(locales.ja).not.toHaveProperty("agentcard.description");
    expect(html).toContain("Shop and pay from your own Agentcard account.");
  });

  it("translates the in-chat sign-in card", () => {
    setLocale("ja");
    const html = renderToStaticMarkup(createElement(ConnectorCard, {
      botId: "atlas",
      threadId: "thread",
      message: {
        id: "m1",
        role: "bot",
        kind: "connector",
        at: 1,
        connector: { source: "mcp", slug: "linear", label: "Linear", description: "Read issues", status: "required", resumeKey: "resume1" },
      },
    }));
    expect(html).toContain(locales.ja!["connectors.card.signInTo"]!.replace("{label}", "Linear"));
    expect(html).toContain(locales.ja!["connectors.card.signIn"]);
    expect(html).not.toContain("Sign in");
  });
});
