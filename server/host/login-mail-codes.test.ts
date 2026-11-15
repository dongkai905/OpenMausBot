import { describe, expect, it, vi } from "vitest";

import type { EmailAccount } from "../email/store.ts";
import type { EmailCodeAsk } from "../login-fill.ts";
import { createLoginMailCodes, type LoginMailCodesDeps } from "./login-mail-codes.ts";

const NOW = 1_700_000_000_000;
const CODE = "483920";
const turn = { botId: "b1", threadId: "t1", generation: "g1" };
const bot = { id: "b1", name: "Ada" };

function ask(over: Partial<EmailCodeAsk> = {}): EmailCodeAsk {
  let clock = NOW;
  return { site: "acme.test", boxes: 1, askedAt: NOW, via: "email", now: () => clock, sleep: async (ms) => { clock += ms; }, ...over };
}

function setup(over: Partial<LoginMailCodesDeps> = {}) {
  const deps: LoginMailCodesDeps = {
    imapAccounts: () => [],
    imapGuard: async ({ host }) => ({ host }),
    ...over,
  };
  return { codes: createLoginMailCodes(deps), deps };
}

describe("emailed codes through an IMAP mailbox", () => {
  it("lists by arrival and reads only the matching message", async () => {
    const account = { address: "ada@acme.test" } as EmailAccount;
    const readMessage = vi.fn(async () => ({ text: `Your code is ${CODE}` }) as never);
    const { codes } = setup({
      imapAccounts: () => [account],
      run: { recentInbox: async () => [{ uid: 7, at: NOW + 2_000, from: "no-reply@acme.test", subject: "Code" }, { uid: 8, at: NOW + 2_000, from: "x@evil.test", subject: "Hello" }], readMessage },
    });
    expect(await codes.find(bot, turn, ask(), () => true)).toMatchObject({ kind: "code", code: CODE });
    expect(readMessage).toHaveBeenCalledOnce();
    expect(readMessage.mock.calls[0]![2 as never]).toMatchObject({ uid: 7, mailbox: "INBOX" });
  });

  it("does not open the body of a message from another site", async () => {
    const account = { address: "ada@acme.test" } as EmailAccount;
    const readMessage = vi.fn(async () => ({ text: `Your code is ${CODE}` }) as never);
    const { codes } = setup({
      imapAccounts: () => [account],
      run: { recentInbox: async () => [{ uid: 7, at: NOW + 2_000, from: "no-reply@evil.test", subject: "Your code" }], readMessage },
    });
    expect(await codes.find(bot, turn, ask(), () => true)).toEqual({ kind: "miss", why: "wrong-sender" });
    expect(readMessage).not.toHaveBeenCalled();
  });

  it("will not hand the same code out twice", async () => {
    const account = { address: "ada@acme.test" } as EmailAccount;
    const { codes } = setup({
      imapAccounts: () => [account],
      run: { recentInbox: async () => [{ uid: 7, at: NOW + 2_000, from: "no-reply@acme.test", subject: "Code" }], readMessage: async () => ({ text: `Your code is ${CODE}` }) as never },
    });
    const first = await codes.find(bot, turn, ask(), () => true);
    if (first.kind !== "code") throw new Error("expected a code");
    first.typed();
    expect(await codes.find(bot, turn, ask({ askedAt: NOW }), () => true)).toEqual({ kind: "miss", why: "used" });
  });
});

describe("no mailbox to read", () => {
  it("answers no-mailbox when the page said the code was emailed", async () => {
    const { codes } = setup();
    expect(await codes.find(bot, turn, ask(), () => true)).toEqual({ kind: "no-mailbox" });
  });

  it("does not ask when the page did not say the code was emailed", async () => {
    const { codes } = setup();
    expect(await codes.find(bot, turn, ask({ via: "unknown" }), () => true)).toEqual({ kind: "skip" });
  });

  it("reads only the mailboxes the host says this bot may read", async () => {
    const imapAccounts = vi.fn(() => []);
    const { codes } = setup({ imapAccounts });
    expect(await codes.find(bot, turn, ask(), () => true)).toEqual({ kind: "no-mailbox" });
    expect(imapAccounts).toHaveBeenCalledWith(bot);
  });
});
