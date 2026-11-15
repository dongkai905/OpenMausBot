import { afterAll, describe, expect, it, vi } from "vitest";

import type { EmailStatus } from "../../../shared/email";

// The i18n module reads the window when it loads; the src suite runs without one.
vi.hoisted(() => {
  vi.stubGlobal("window", {});
});
afterAll(() => vi.unstubAllGlobals());

const { botAppsFrom } = await import("./useBotApps");

const email = (state: "connected" | "signed-out" | "unavailable") =>
  ({ state, accounts: state === "connected" ? [{ address: "ana@example.test" }] : [] }) as unknown as EmailStatus;

describe("the apps one bot sees", () => {
  it("is still checking until the mailbox has been read", () => {
    expect(botAppsFrom({}, null)).toEqual({ phase: "loading", apps: [], connectedSlugs: [] });
  });

  it("says it does not know, rather than nothing is connected, when the mailbox cannot be read", () => {
    expect(botAppsFrom({}, null, true)).toEqual({ phase: "unknown", apps: [], connectedSlugs: [] });
  });

  it("lists no app until a mailbox is connected", () => {
    expect(botAppsFrom({}, email("signed-out"))).toEqual({ phase: "ready", apps: [], connectedSlugs: [] });
    expect(botAppsFrom({}, email("unavailable")).apps).toEqual([]);
  });

  it("lists Email, by name, once the server reports a mailbox connected", () => {
    const connected = botAppsFrom({}, email("connected"));
    expect(connected.connectedSlugs).toEqual(["email"]);
    expect(connected.apps[0]).toMatchObject({
      slug: "email",
      label: "Email",
      blurb: "Read and send mail on any mail host, with your address and password.",
      scope: "write",
      card: { logo: null, domain: null, label: "Email" },
    });
  });

  it("reads Email's switch from the bot: scoped, read-only, or all off", () => {
    expect(botAppsFrom({ connectorScopes: { apps: { email: "read" } } }, email("connected")).apps.map((app) => app.scope)).toEqual(["read"]);
    expect(botAppsFrom({ apps: false }, email("connected")).apps.map((app) => app.scope)).toEqual([null]);
  });
});
