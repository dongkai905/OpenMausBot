// The mailboxes fill_login may look in for one turn, and what it remembers between calls.
// Security: the code and the message's words stay in the server, so a conversation that used one has read no outside text.
import { createHash } from "node:crypto";

import { readMessage, recentInbox, type EmailGuard } from "../email/client.ts";
import type { EmailBot } from "../email/host.ts";
import type { EmailAccount } from "../email/store.ts";
import { waitForEmailCode, type CodeMailbox } from "../email-code.ts";
import type { EmailCodeAnswer, EmailCodeAsk } from "../login-fill.ts";

const LIST_LIMIT = 20;
const ACCOUNTS_PER_APP = 3;
/** A code box already on the page when fill_login is called was asked for by a step before it; this is how far back. */
const ASKED_BEFORE_CALL_MS = 120_000;
const REMEMBER_ASK_MS = 15 * 60_000;
const REMEMBER_USED_MS = 30 * 60_000;

type Turn = { botId: string; threadId: string; generation: string };
type Bot = EmailBot;

export interface LoginMailCodesDeps {
  /** The IMAP mailboxes this bot may read. */
  imapAccounts(bot: Bot): readonly EmailAccount[];
  imapGuard: EmailGuard;
  run?: Partial<{ recentInbox: typeof recentInbox; readMessage: typeof readMessage }>;
}

export function createLoginMailCodes(deps: LoginMailCodesDeps) {
  const run = { recentInbox, readMessage, ...deps.run };
  const asks = new Map<string, number>();
  const used = new Map<string, number>();

  const usedKey = (site: string, code: string) => createHash("sha256").update(`${site}\0${code}`).digest("hex");
  const forgetOld = (map: Map<string, number>, before: number) => { for (const [key, at] of map) if (at < before) map.delete(key); };

  function imapBox(account: EmailAccount): CodeMailbox {
    return {
      list: async (sinceMs) => (await run.recentInbox(account, deps.imapGuard, { sinceMs, limit: LIST_LIMIT })).map((mail) => ({ id: String(mail.uid), at: mail.at, from: mail.from, subject: mail.subject })),
      body: async (id) => (await run.readMessage(account, deps.imapGuard, { mailbox: "INBOX", uid: Number(id) })).text,
    };
  }

  /** The mailboxes this bot may read: the ones the host says it may. */
  function mailboxes(bot: Bot): CodeMailbox[] {
    return deps.imapAccounts(bot).slice(0, ACCOUNTS_PER_APP).map(imapBox);
  }

  return {
    async find(bot: Bot, turn: Turn, ask: EmailCodeAsk, active: () => boolean): Promise<EmailCodeAnswer> {
      if (ask.via === "other") return { kind: "skip" };
      const started = ask.now();
      forgetOld(asks, started - REMEMBER_ASK_MS);
      forgetOld(used, started - REMEMBER_USED_MS);
      const key = `${turn.threadId}\0${ask.site}`;
      const askedAt = ask.askedAt ?? asks.get(key) ?? started - ASKED_BEFORE_CALL_MS;
      asks.set(key, askedAt);
      const boxes = mailboxes(bot);
      if (!boxes.length) return ask.via === "email" ? { kind: "no-mailbox" } : { kind: "skip" };
      const found = await waitForEmailCode(boxes, {
        site: ask.site, askedAt, ...(ask.boxes > 1 ? { boxes: ask.boxes } : {}), isUsed: (code) => used.has(usedKey(ask.site, code)), active, now: ask.now, sleep: ask.sleep,
      });
      if (found.kind === "miss") return found;
      return { kind: "code", code: found.code, typed: () => { used.set(usedKey(ask.site, found.code), ask.now()); asks.delete(key); } };
    },
  };
}

export type LoginMailCodes = ReturnType<typeof createLoginMailCodes>;
