import { describe, expect, it } from "vitest";

import { HOSTED_MCP_APPS, type HostedConnections } from "@/lib/hosted-mcp-apps";
import { hostedShown } from "./PluginsPanel";

const app = HOSTED_MCP_APPS[0]!;
const connections = (value: boolean): HostedConnections =>
  Object.fromEntries(HOSTED_MCP_APPS.map((hosted) => [hosted.id, value])) as HostedConnections;

describe("the hosted app cards", () => {
  it("shows every hosted app under All", () => {
    for (const hosted of HOSTED_MCP_APPS) {
      expect(hostedShown(hosted, "", "all", null), hosted.id).toBe(true);
    }
  });

  it("finds a hosted app by its own name, and hides the rest", () => {
    for (const hosted of HOSTED_MCP_APPS) {
      expect(hostedShown(hosted, hosted.label.toLowerCase(), "all", null), hosted.id).toBe(true);
      expect(hostedShown(hosted, "nothing else", "all", null), hosted.id).toBe(false);
    }
  });

  it("shows a hosted app under Connected only while it is not known to be disconnected", () => {
    expect(hostedShown(app, "", "connected", null)).toBe(true);
    expect(hostedShown(app, "", "connected", connections(false))).toBe(false);
    expect(hostedShown(app, "", "connected", connections(true))).toBe(true);
  });
});
