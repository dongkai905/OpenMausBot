import { describe, expect, it } from "vitest";

import type { ConnectorToolGrant } from "../shared/wire.ts";
import {
  connectorCallFromFrame,
  connectorRefusalText,
  connectorScopeRefusalText,
  connectorUnrecognizedText,
  evaluateConnectorTools,
  serviceSlugFor,
  serviceSlugForCandidates,
} from "./connector-verdict.ts";

const toolsCall = (name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("connectorCallFromFrame", () => {
  it("passes non-tool traffic through untouched", () => {
    expect(connectorCallFromFrame({ jsonrpc: "2.0", id: 1, method: "initialize" })).toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame(null)).toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame("notifications/initialized")).toEqual({ kind: "passthrough" });
  });

  it("reads a direct app-tool call", () => {
    expect(connectorCallFromFrame(toolsCall("EMAIL_SEND_MESSAGE", { to: "a@b.c" })))
      .toEqual({ kind: "tools", invoked: "EMAIL_SEND_MESSAGE", names: ["EMAIL_SEND_MESSAGE"] });
  });

  it("denies unrecognized shapes by default", () => {
    expect(connectorCallFromFrame(toolsCall("email_send_message", {})).kind).toBe("unrecognized");
    expect(connectorCallFromFrame(toolsCall("Email Send Message", {})).kind).toBe("unrecognized");
    expect(connectorCallFromFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }).kind)
      .toBe("unrecognized");
    expect(connectorCallFromFrame({ jsonrpc: "2.0", id: 4, method: "tools/call" }).kind).toBe("unrecognized");
  });

  it("reads a name that is not an app tool name as unreadable, and says so in vendor-neutral words", () => {
    const call = connectorCallFromFrame(toolsCall("email_send_message", {}));
    expect(call).toMatchObject({ kind: "unrecognized", invoked: "email_send_message" });
    expect(call.kind === "unrecognized" ? call.reason : "").toBe("the tool name is not an app tool name");
  });
});

describe("serviceSlugFor", () => {
  it("maps a tool name to its service slug", () => {
    expect(serviceSlugFor("EMAIL_SEND_MESSAGE")).toBe("email");
    expect(serviceSlugFor("SLACK_POST_MESSAGE")).toBe("slack");
    expect(serviceSlugFor("GMAIL")).toBeNull();
    expect(serviceSlugFor("_SEND")).toBeNull();
  });
});

describe("serviceSlugForCandidates", () => {
  it("prefers the longest known slug across an underscore boundary", () => {
    expect(serviceSlugForCandidates("BLAND_AI_MAKE_CALL", ["bland", "bland_ai"])).toBe("bland_ai");
    expect(serviceSlugForCandidates("GITHUB_CREATE_ISSUE", ["git", "github"])).toBe("github");
  });

  it("matches whole slug segments only and reports no match for the caller's fallback", () => {
    // "git" must not claim GITHUB_* — the candidate has to end at an underscore.
    expect(serviceSlugForCandidates("GITHUB_CREATE_ISSUE", ["git"])).toBeNull();
    expect(serviceSlugForCandidates("BLAND_AI_MAKE_CALL", ["gmail", "slack"])).toBeNull();
    expect(serviceSlugForCandidates("EMAIL_SEND_MESSAGE", [])).toBeNull();
  });
});

describe("evaluateConnectorTools", () => {
  it("passes everything for a legacy bot with no grants record", () => {
    const verdict = evaluateConnectorTools(["EMAIL_SEND_MESSAGE", "SLACK_POST_MESSAGE"], undefined);
    expect(verdict).toMatchObject({ allowed: true, legacy: true });
  });

  it("denies everything when the grants record is empty", () => {
    const verdict = evaluateConnectorTools(["EMAIL_SEND_MESSAGE"], {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.denials).toEqual([{ tool: "EMAIL_SEND_MESSAGE", service: "email", onGrantedService: false }]);
  });

  it("treats inherited object keys as no grant", () => {
    // CONSTRUCTOR_X resolves to "constructor": without the own-property check the prototype's constructor poses as a grant and the relay 500s.
    const verdict = evaluateConnectorTools(["CONSTRUCTOR_X", "TOSTRING_Y"], {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.denials).toEqual([
      { tool: "CONSTRUCTOR_X", service: "constructor", onGrantedService: false },
      { tool: "TOSTRING_Y", service: "tostring", onGrantedService: false },
    ]);
  });

  it("allows only the exact tools a service's list names", () => {
    const grants: Record<string, ConnectorToolGrant> = { email: { tools: ["EMAIL_SEND_MESSAGE"] } };
    expect(evaluateConnectorTools(["EMAIL_SEND_MESSAGE"], grants)).toMatchObject({
      allowed: true,
      rule: "connectorTools.email",
    });
    expect(evaluateConnectorTools(["EMAIL_LIST_MESSAGES"], grants).denials).toEqual([
      { tool: "EMAIL_LIST_MESSAGES", service: "email", onGrantedService: true },
    ]);
    expect(evaluateConnectorTools(["SLACK_POST_MESSAGE"], grants).denials).toEqual([
      { tool: "SLACK_POST_MESSAGE", service: "slack", onGrantedService: false },
    ]);
  });

  it("widens to every tool on a star-granted service and denies others", () => {
    const grants: Record<string, ConnectorToolGrant> = { email: { tools: "*" } };
    expect(evaluateConnectorTools(["EMAIL_SEND_MESSAGE", "EMAIL_LIST_MESSAGES"], grants).allowed).toBe(true);
    expect(evaluateConnectorTools(["SLACK_POST_MESSAGE"], grants).allowed).toBe(false);
  });

  it("keeps an underscored service's tools under its own grant", () => {
    const grants: Record<string, ConnectorToolGrant> = {
      bland: { tools: "*" },
      bland_ai: { tools: ["BLAND_AI_MAKE_CALL"] },
    };
    expect(evaluateConnectorTools(["BLAND_AI_MAKE_CALL"], grants, ["bland", "bland_ai"])).toMatchObject({
      allowed: true,
      rule: "connectorTools.bland_ai",
    });
    expect(evaluateConnectorTools(["BLAND_AI_SEND_SMS"], grants, ["bland", "bland_ai"]).denials).toEqual([
      { tool: "BLAND_AI_SEND_SMS", service: "bland_ai", onGrantedService: true },
    ]);
  });

  it("does not let a plain-prefix grant capture an underscored connected service", () => {
    // bland_ai is the connected service, so its tools must resolve there
    // even when the record only holds a wildcard for the plain prefix.
    const grants: Record<string, ConnectorToolGrant> = { bland: { tools: "*" } };
    expect(evaluateConnectorTools(["BLAND_AI_MAKE_CALL"], grants, ["bland_ai"]).denials).toEqual([
      { tool: "BLAND_AI_MAKE_CALL", service: "bland_ai", onGrantedService: false },
    ]);
  });

  it("denies a name that maps to no service and judges a batch once per distinct tool", () => {
    const grants: Record<string, ConnectorToolGrant> = { email: { tools: "*" } };
    const verdict = evaluateConnectorTools(["EMAIL_SEND_MESSAGE", "EMAIL_SEND_MESSAGE", "EMAIL"], grants);
    expect(verdict.allowed).toBe(false);
    expect(verdict.denials).toEqual([{ tool: "EMAIL", service: null, onGrantedService: false }]);
  });
});

describe("refusal text", () => {
  it("names the refused tools and the person, never the grants", () => {
    const grants: Record<string, ConnectorToolGrant> = {
      email: { tools: "*" },
      slack: { tools: ["SLACK_POST_MESSAGE"] },
    };
    const verdict = evaluateConnectorTools(["SLACK_CREATE_CHANNEL"], grants);
    const text = connectorRefusalText(verdict.denials);
    expect(text).toContain("SLACK_CREATE_CHANNEL");
    expect(text).toContain("Ask the person");
    expect(text).not.toContain("SLACK_POST_MESSAGE");
    expect(text).not.toContain("EMAIL");
  });

  it("names every refused tool in a batch", () => {
    const text = connectorRefusalText([
      { tool: "SLACK_CREATE_CHANNEL", service: "slack", onGrantedService: true },
      { tool: "NOTION_CREATE_PAGE", service: "notion", onGrantedService: false },
    ]);
    expect(text).toContain("SLACK_CREATE_CHANNEL");
    expect(text).toContain("NOTION_CREATE_PAGE");
    expect(text).toContain("are not granted");
  });

  it("explains an unrecognized shape without pointing at any tool list", () => {
    const text = connectorUnrecognizedText("EMAIL_SEND_MESSAGE", "the tool name is not an app tool name");
    expect(text).toContain("EMAIL_SEND_MESSAGE");
    expect(text).toContain("the tool name is not an app tool name");
    expect(text).toContain("Send a well-formed call that names the tools to execute.");
    expect(text).toContain("Ask the person");
  });

  it("tells a scoped bot its call was unreadable before it blames access", () => {
    const unreadable = connectorCallFromFrame(toolsCall("email_send_message", {}));
    const text = connectorScopeRefusalText(unreadable, "app", "Scout", "Email", "Send message");
    expect(text).toContain("could not read");
    expect(text).not.toContain("has not been given access");
    const tools = connectorCallFromFrame(toolsCall("EMAIL_SEND_MESSAGE", {}));
    expect(connectorScopeRefusalText(tools, "app", "Scout", "Email", "Send message")).toContain("Scout has not been given access to Email");
    expect(connectorScopeRefusalText(tools, "write", "Scout", "Email", "Send message")).toContain("Email is read-only for Scout, and Send message would write to it");
  });
});
