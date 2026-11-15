import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { ConnectorCard } from "./ConnectorCard";

const view = (connector: Partial<NonNullable<Message["connector"]>>) => renderToStaticMarkup(createElement(ConnectorCard, {
  botId: "atlas",
  threadId: "thread",
  message: {
    id: "m1",
    role: "bot",
    kind: "connector",
    at: 1,
    connector: { source: "mcp", slug: "linear", label: "Linear", description: "Read issues", status: "required", resumeKey: "resume1", ...connector },
  },
}));

describe("ConnectorCard ask card", () => {
  it("asks for the sign-in in the shared ask card, the app its title in clear ink", () => {
    const html = view({});
    expect(html).toContain('data-ask-card="pending"');
    expect(html).toContain('data-tour="connector"');
    expect(html).toMatch(/font-medium leading-\[22px\] text-ink"><bdi dir="auto">/);
    expect(html).not.toContain("text-accent-text\"><bdi");
    expect(html).toContain(t("connectors.card.signInTo", { label: "Linear" }));
    expect(html).toContain(t("connectors.card.signIn"));
    expect(html).toContain(`aria-label="${t("connectors.card.notNow")}"`);
  });

  it("folds into one line once connected and the bot is continuing", () => {
    const html = view({ status: "connected", resumed: true });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain(t("connectors.card.connected"));
    expect(html).toContain(t("connectors.card.continuing"));
    expect(html).not.toContain(t("connectors.card.signIn"));
    expect(html).not.toContain(t("connectors.card.notNow"));
  });

  it("keeps Continue task on the line while the task is still paused", () => {
    const html = view({ status: "connected" });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain(t("connectors.card.continueTask"));
  });

  it("says what went wrong on a card that failed", () => {
    const html = view({ status: "failed", error: "Connection FAILED" });
    expect(html).toContain("Connection FAILED");
    expect(html).toContain(t("connectors.card.tryAgain"));
  });

  it("draws nothing for a card that is not an MCP sign-in", () => {
    expect(view({ source: undefined })).toBe("");
  });

  it("draws nothing once superseded", () => {
    expect(view({ superseded: true })).toBe("");
  });

  it("draws nothing once dismissed", () => {
    expect(view({ dismissed: true })).toBe("");
  });
});
