// Per-bot workspaces (~/.openmausbot/workspaces/<botId>/): each bot's own working folder.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export const WORKSPACES_DIR = join(DATA_DIR, "workspaces");
export const TASK_WORKSPACES_DIR = join(DATA_DIR, "task-workspaces");

export function supportsWorkspaceFiles(driverKind: string): boolean {
  return !["openai-compat"].includes(driverKind);
}

/** Directory organization, not a shell sandbox. */
export function ensureTaskWorkspace(botId: string, threadId: string): string {
  if (![botId, threadId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new Error("Invalid bot or thread id for a task workspace.");
  }
  const dir = join(TASK_WORKSPACES_DIR, botId, threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ensureWorkspace(botId: string): string {
  const dir = join(WORKSPACES_DIR, botId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function workspaceDir(botId: string): string {
  return join(WORKSPACES_DIR, botId);
}

/** One per bot, for every thread: its working folder's Claude Code settings, else its own folder's. */
export function botSettingsFile(bot: { id: string; cwd?: string }): string {
  return join(bot.cwd ?? workspaceDir(bot.id), ".claude", "settings.json");
}

export function workspaceLocationsPrompt(botId: string, cwd: string | undefined, botCwd?: string, opts: { attachFile?: boolean } = {}): string {
  return "\n\nFile locations for this bot (absolute paths): " + JSON.stringify({
    currentWorkingFolder: cwd ?? "Provider default; inspect the working directory before using relative paths",
    sharedBotFolder: workspaceDir(botId),
    otherThreadFiles: join(TASK_WORKSPACES_DIR, botId),
    ...(botCwd ? { configuredProjectFolder: botCwd } : {}),
  }) + ". Different conversations can have different working folders. For an existing file, use the exact path from the conversation; if missing here, check this bot's listed folders before saying it is gone or recreating it." +
    " Follow an explicitly requested destination. Otherwise put new task output in the current working folder and report its absolute path so another thread or room can use it." +
    " Do not move old files, edit another active thread's work, or read another bot's private folders without authorization. These paths do not grant additional access." +
    " Chat links and inline images open only files in currentWorkingFolder and sharedBotFolder." +
    (opts.attachFile
      ? " When you save a file or picture for the person somewhere else, also attach it with attach_file in the same turn so it opens from chat. For many files, attach the few that matter most, such as a preview."
      : " Save a file or picture you want to show in chat there.");
}
