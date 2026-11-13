// A Team Cloud's conversation actions: sharing a private conversation (with the team, or with one person). Which actions
// show follows the server's answer on the task; the server refuses anything else in any case.
import { useSyncExternalStore } from "react";

import { api, type Bot, type Task } from "@/state/store";

export interface ConversationTarget { botId: string; threadId: string }
export type ConversationDialog = ConversationTarget & { kind: "team" | "person" };

export interface Sharing { shared: "team" | { email: string; name: string } | null; people: Array<{ email: string; name: string }> }

let dialog: ConversationDialog | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

export function openConversationDialog(next: ConversationDialog): void {
  dialog = next;
  changed();
}

export function closeConversationDialog(): void {
  dialog = null;
  changed();
}

export function useConversationDialog(): ConversationDialog | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => dialog, () => dialog);
}

/** What this person can do with a conversation's sharing: its own person shares a private one either way, and widens one
 * they shared with one person to the team. Never a bot's shared chat or a chat with their own MausBot. */
export function shareChoices(bot: Pick<Bot, "defaultBot">, task: Pick<Task, "private" | "shared" | "sharedWith" | "sharedChat"> | undefined, onTeam: boolean): { team: boolean; person: boolean } {
  if (!onTeam || !task || bot.defaultBot?.person || task.sharedChat) return { team: false, person: false };
  if (task.private === true && !task.shared) return { team: true, person: true };
  return { team: task.sharedWith?.byYou === true, person: false };
}

const sharePath = ({ botId, threadId }: ConversationTarget) => `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(threadId)}/share`;

export const sharingOf = (target: ConversationTarget) => api<Sharing>(sharePath(target));

export const shareConversation = (target: ConversationTarget, to: "team" | { email: string }) =>
  api<{ shared: Sharing["shared"] }>(sharePath(target), { method: "POST", body: JSON.stringify({ with: to }) });

