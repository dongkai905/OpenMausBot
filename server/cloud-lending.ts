// Who may use a Mac lent to an OMB Cloud home: only a turn the harness can prove acts for the owner (a conversation they
// started from their own admin-scoped device, a room member answering their own line there, or a routine they wrote or
// started by hand), in a conversation they opened that has never held anybody else's words, since a resumed session
// carries everything said in it. Webhooks, guests, work handed in from elsewhere and anything unprovable never can.
import type { WorkOrigin } from "./peer-provenance.ts";

/** What started a run of its own accord. */
export type RoutineRunTrigger = "schedule" | "manual" | "webhook" | "startup" | "api";

type Card = { requestId?: string; answered?: string; answeredText?: string; dismissed?: boolean; autoApplied?: boolean; answeredBy?: { kind: string; person?: string } };
type Line = { id: string; role: string; peerAsk?: unknown; sender?: { id?: string }; card?: Card };

export interface CloudLendingTurn {
  request: { messageId?: string; generations: ReadonlySet<string>; stopped?: boolean; automation?: RoutineRunTrigger; origin?: WorkOrigin } | undefined;
  generation: string;
  thread: readonly Line[];
  /** Whoever opened the conversation chose its title, so they must be the owner too. */
  starters?: readonly (string | undefined)[];
  /** Words someone else chose: a "post" webhook's payload, or a report of a routine the owner did not write. */
  reportsFromOthers?: boolean;
  /** A bot opened the conversation: with work another bot handed in, or with its own words from wherever it was. Those
   * words start the conversation's session, but they are no line in it. */
  botOpened?: boolean;
  /** A hand-off from a turn that could itself use the lent computer opened it, and nothing else has been handed in since
   * (`TaskOpenedBy.forOwner`): counts for the lent computer alone. */
  openedForOwner?: boolean;
  ownerPerson: (person: string | undefined) => boolean;
  cardAnswerer: (card: Card) => string | undefined;
  routineRun: () => { triggerSource: RoutineRunTrigger; ownerStarted: boolean; ownerAuthored: boolean } | null;
}

const personOf = (line: Line | undefined) => line?.role === "user" && !line.peerAsk ? line.sender?.id : undefined;

/** Security invariant: work handed on inherits the lent computer only from a turn that could itself use it when it handed
 * it on, recorded by the harness at that moment (HandedPeople, the origin's `lends`). So it never reaches further than
 * that turn already did, and only the owner's own line ever starts such a chain: a routine, a webhook or an unproven
 * hand-off has no such record. */
export function handedOnForOwner(turn: CloudLendingTurn): boolean {
  const origin = turn.request?.automation === undefined ? turn.request?.origin : undefined;
  return origin?.kind === "user" && origin.lends === true && turn.ownerPerson(origin.person);
}

/** This turn answers a line the owner wrote: no run of a routine or a webhook, and no line a bot handed in. */
export function answersOwnersLine(turn: CloudLendingTurn): boolean {
  const { request } = turn;
  if (!request?.messageId || request.stopped || request.automation !== undefined || !request.generations.has(turn.generation)) return false;
  return turn.ownerPerson(personOf(turn.thread.find((line) => line.id === request.messageId)));
}

export type CloudLendingRefusal = "unproven" | "not-owner" | "someone-else";

/** What a refused call hears after the words for the person, since a bot told "start a new conversation" does it itself. */
export const ONLY_THE_PERSON = "Only the person can change this. Stop trying to reach it: asking again, a conversation you open yourself and work you hand to another bot can't use it either. Tell them the above in their language, then end your turn.";

/** What a refused call hears when a card in the chat lets the owner lift the refusal right there. */
export const ON_THE_CARD = "Don't call this again or try another way. End your turn and say in one line that you're waiting for them: you carry on by itself once they allow it.";

/** Why a turn can't use the lent computer, in the words its bot says and a refused call answers, once every gate is
 * checked: each way out it names works. `room`: a group chat. `fromBefore`: each line that is not the owner's is one of theirs
 * the Cloud cannot prove, written before My Cloud carried their name on their lines. `botOpened`: a bot opened it. `outside`: no other person wrote here,
 * a webhook or a routine they didn't write did. `memoryChanged`: this bot is locked whichever conversation asks. `onCard`: a
 * card in this chat lets them lift it. */
export function cloudLendingRefusalText(why: CloudLendingRefusal | "memory-changed", { room, fromBefore, botOpened = false, outside = false, memoryChanged = false, onCard = false, device }: { room: boolean; fromBefore: boolean; botOpened?: boolean; outside?: boolean; memoryChanged?: boolean; onCard?: boolean; device: "Mac" | "PC" | "computer" | "Chrome" }): string {
  const yours = `your ${device}`;
  const fresh = room ? "Start a new thread in this group chat to use it." : "Start a new conversation with this bot to use it.";
  if (onCard) return `${why === "memory-changed" || memoryChanged ? "This bot's memory was changed in a conversation you didn't write" : botOpened ? "A bot opened this conversation" : "A webhook or a routine you didn't write posted in this conversation"}, so it can't use ${yours} until you allow it on the card in this chat.`;
  if (why === "memory-changed" || memoryChanged) {
    const next = why === "memory-changed" ? "ask again here"
      : room ? (why === "someone-else" ? "start a new thread in this group chat and ask there" : "ask here yourself")
      : "start a new conversation with this bot and ask there";
    return `This bot's memory was changed in a conversation you didn't write, so it can't use ${yours}. In this bot's settings, open Memory, check what changed and tap Mark reviewed, then ${next}.`;
  }
  if (why === "someone-else" && fromBefore) return `This conversation has messages from before My Cloud, so it can't use ${yours}. ${fresh}`;
  if (why === "someone-else" && botOpened) return `A bot opened this conversation, so it can't use ${yours}. ${fresh}`;
  if (why === "someone-else" && outside) return `A webhook or a routine you didn't write posted in this conversation, so it can't use ${yours}. ${fresh}`;
  if (why === "someone-else") return `Someone else wrote in this conversation, so it can't use ${yours}. ${room ? fresh : "Start a new conversation to use it."}`;
  if (room) return `Only your own messages in a group chat, and the bots that answer them there, can use ${yours}. Ask here yourself to use it.`;
  return `Only conversations you start with a bot, and routines you wrote, can use ${yours}. Start a new conversation with this bot to use it.`;
}

/** On a team nobody's own computer is lent: the team's bots use the team's cloud computer. */
export function teamLendingRefusal(team: string): string {
  return `${team}'s bots never use anyone's own computer; they use ${team}'s cloud computer.`;
}

/** Who may use the lent computer. */
export function cloudHomeLendingRefusal(turn: CloudLendingTurn): CloudLendingRefusal | null {
  return judgeCloudTurn(turn, true);
}

/** Security invariant: everything else a turn gets for being the owner's (writing the bot's memory, the owner's phones, not
 * being watched for what it writes) takes the owner's own conversation: work handed on for them never counts. */
export function cloudHomeOwnTurnRefusal(turn: CloudLendingTurn): CloudLendingRefusal | null {
  return judgeCloudTurn(turn, false);
}

function judgeCloudTurn(turn: CloudLendingTurn, handOffsCount: boolean): CloudLendingRefusal | null {
  const { request } = turn;
  if (!request || request.stopped || !request.generations.has(turn.generation)) return "unproven";
  // A hand-off carries its request with no line of the owner's, only the harness's record that it was handed on for them.
  const handed = handOffsCount && handedOnForOwner(turn);
  let owner = handed;
  if (!handed) {
    if (!request.messageId) return "unproven";
    const index = turn.thread.findIndex(line => line.id === request.messageId);
    if (index < 0) return "unproven";
    if (request.automation === undefined) {
      owner = turn.ownerPerson(personOf(turn.thread[index]));
    } else {
      const run = turn.routineRun();
      owner = request.automation !== "webhook" && request.automation !== "api" && Boolean(run) && run!.triggerSource !== "webhook" &&
        run!.ownerAuthored && (run!.triggerSource !== "manual" || run!.ownerStarted);
    }
  }
  if (!owner) return "not-owner";
  // A conversation someone else opened (and named) is theirs, whoever writes in it.
  if (turn.starters?.some((person) => person !== undefined && !turn.ownerPerson(person))) return "someone-else";
  if ((turn.botOpened && !(handOffsCount && turn.openedForOwner)) || turn.reportsFromOthers) return "someone-else";
  // No line (sent, queued, steered or handed in) and no card answer by anyone else, ever; a routine's own prompt names nobody.
  const clean = ownerOnlyConversation(turn.thread, turn.ownerPerson, turn.cardAnswerer,
    request.automation !== undefined ? request.messageId : undefined);
  return clean ? null : "someone-else";
}

/** Every user line and every answered card is the owner's; the same test gates what feeds a turn on a Cloud home. */
export function ownerOnlyConversation(
  thread: readonly Line[],
  ownerPerson: (person: string | undefined) => boolean,
  cardAnswerer: (card: Card) => string | undefined,
  exempt?: string,
): boolean {
  return thread.every(line =>
    (line.role !== "user" || line.id === exempt || ownerPerson(personOf(line))) &&
    (!answeredByPerson(line.card) || ownerPerson(cardAnswerer(line.card!))));
}

/** The harness's own settlements (dismissed, unavailable, a bot's change applied on its own, or a question a bot decided)
 * carry nobody's words. */
export function answeredByPerson(card: Card | undefined): boolean {
  if (!card || card.answeredBy?.kind === "bot") return false;
  return (Boolean(card.answered) && card.answered !== "unavailable" && card.dismissed !== true && card.autoApplied !== true) || Boolean(card.answeredText);
}
