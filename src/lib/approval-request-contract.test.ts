import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import { readMessage } from "../../server/message-db";
import { chatNotice, type ChatNoticeKey } from "../../server/chat-notices";
import { runtimeRequestCardFields } from "../../server/request-card";
import { Store } from "../../server/store";
import { ApprovalCard } from "@/components/ApprovalCard";
import { PendingApprovalPanel, pendingApprovals, spokenApprovalPrompt } from "@/components/PendingApproval";
import type { Message } from "@/state/store";
import { approvalDetailText } from "./approval-summary";
import { setLocale } from "./i18n";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
const selection = () => ({ instanceId: "fixture", model: "fixture-model" });

/** The event an MCP server's elicitation arrives as: the driver raises it, and
 * the card reads the summary and its code from here. */
function elicitationRequest(server: string, message: string): RequestOpened {
  const named = server ? { server } : undefined;
  const summaryCode = message ? "chat.notice.elicitationMessageGeneric" : named ? "chat.notice.elicitationContinue" : "chat.notice.elicitationContinueGeneric";
  const summaryParams = message ? { message } : named;
  return {
    eventId: randomUUID(), provider: "fixture", threadId: randomUUID(), createdAt: new Date().toISOString(),
    type: "request.opened", requestId: randomUUID(), requestType: "question", tool: "elicitation",
    summary: chatNotice(summaryCode as ChatNoticeKey, summaryParams), summaryCode, summaryParams,
  } as RequestOpened;
}

function persistedRequest(event: RequestOpened): Message {
  const store = new Store(selection);
  const sent = store.appendMessage(event.threadId, {
    role: "bot", kind: "options",
    card: { title: "Approval needed", ...runtimeRequestCardFields(event, { permission: true, guestDriven: false }) },
  });
  const stored = readMessage(event.threadId, sent.id);
  expect(stored?.card?.subtitle).toBe(sent.card?.subtitle);
  expect(stored?.card?.summaryCode).toBe(event.summaryCode);
  expect(stored?.card?.summaryParams).toEqual(sent.card?.summaryParams);
  return JSON.parse(JSON.stringify(stored));
}

function expectDetails(message: Message, detail: string) {
  expect(approvalDetailText(message.card!)).toBe(detail);
  const [pending] = pendingApprovals([message]);
  expect(pending?.detail).toBe(detail);
  expect(renderToStaticMarkup(createElement(ApprovalCard, { message }))).toContain(detail);
  expect(renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending!, count: 1, index: 0 }))).toContain(detail);
  expect(spokenApprovalPrompt(pending!, "Scout")).toContain(detail);
}

afterEach(() => {
  setLocale("en");
  vi.unstubAllEnvs();
});

describe("approval summary from driver event through persisted card to renderer", () => {
  it.each([
    ["github", "", "github asks to continue", "github pede para continuar"],
    ["", "", "An MCP server asks to continue", "Um servidor MCP pede para continuar"],
    ["", "External words", "An MCP server: External words", "Um servidor MCP: External words"],
  ])("renders and speaks the MCP server's %s / %s without rewriting provider text", (server, words, english, portuguese) => {
    const event = elicitationRequest(server!, words!);
    const message = persistedRequest(event);
    expect(message.card?.subtitle).toBe(english);
    expectDetails(message, english!);
    setLocale("pt-br");
    expectDetails(message, portuguese!);
    expect(message.card?.subtitle).toBe(english);
  });

  it("rewords an already collected pending approval when the language changes", () => {
    const message = persistedRequest(elicitationRequest("github", ""));
    const [pending] = pendingApprovals([message]);
    setLocale("pt-br");
    expect(spokenApprovalPrompt(pending!, "Scout")).toContain("github pede para continuar");
    expect(renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending!, count: 1, index: 0 })))
      .toContain("github pede para continuar");
  });

  it.each([undefined, "chat.notice.unknown", "approval.someone", "chat.notice.elicitationContinue"])("keeps the English fallback for a legacy, unknown, out-of-namespace or incomplete code %j", (summaryCode) => {
    const message = persistedRequest(elicitationRequest("", ""));
    message.card!.summaryCode = summaryCode;
    setLocale("pt-br");
    expectDetails(message, "An MCP server asks to continue");
  });

  it("scrubs coded card params at the persistence boundary too", () => {
    const secret = `sk-${"b".repeat(24)}`;
    const event = elicitationRequest("", "External words");
    event.summary = `An MCP server: ${secret}`;
    event.summaryParams = { message: secret };
    const message = persistedRequest(event);
    expect(JSON.stringify(message)).not.toContain(secret);
    expect(message.card?.summaryParams?.message).toBe("«redacted 27 chars»");
    setLocale("pt-br");
    expectDetails(message, "Um servidor MCP: «redacted 27 chars»");
  });

  it("keeps secrets out of both the stored fallback and its params", () => {
    const secret = `sk-${"a".repeat(24)}`;
    const event = elicitationRequest("", secret);
    const message = persistedRequest(event);
    expect(JSON.stringify(message)).not.toContain(secret);
    expect(message.card?.summaryParams?.message).toBe("«redacted 27 chars»");
    setLocale("pt-br");
    expectDetails(message, "Um servidor MCP: «redacted 27 chars»");
  });
});
