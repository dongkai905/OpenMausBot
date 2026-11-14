import type { ServerText } from "../../shared/server-text.ts";
// The goal run card: one receipt per run in the conversation it runs in, a room's or a one-on-one chat's.
import type { GroupGoalRunCardData, GroupGoalRunStatus } from "../../shared/group-goal-run.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { GROUP_GOAL_MAX_TURNS } from "../group-goal-run.ts";
import type { Notification } from "../notify.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "../server-lines.ts";

export interface LiveGoalRun {
  runId: string;
  cardMessageId: string;
  goal: string;
  coordinatorBotId: string;
  coordinatorName: string;
  turnCount: number;
  maxTurns: number;
  startedAt: number;
  finished: boolean;
}

export interface GoalCardDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage">;
  notify(notification: Notification | null): void;
}

/** The detail as the card shows it: redacted, and cut to the card's line. */
function detailFields(detail: string, _text?: ServerText) {
  return { detail: redactSecretsInText(detail).slice(0, 500), detailCode: undefined, detailParams: undefined };
}

/** A goal card's text for clients that show no cards, by how the goal stands. */
const GOAL_STATE: Record<GroupGoalRunStatus, ServerLineKey> = {
  working: "server.teammates.goal.working",
  completed: "server.teammates.goal.completed",
  "needs-input": "server.teammates.goal.needsInput",
  blocked: "server.teammates.goal.blocked",
  "limit-reached": "server.teammates.goal.limitReached",
  paused: "server.teammates.goal.paused",
  stopped: "server.teammates.goal.stopped",
  failed: "server.teammates.goal.failed",
};

export function createGoalCards(deps: GoalCardDeps) {
  const { store } = deps;

  function start(threadId: string, coordinator: Pick<BotRecord, "id" | "name" | "color">, goal: string, runId: string): LiveGoalRun {
    const startedAt = Date.now(), language = conversationLanguage(threadId);
    const detail = serverLine(language, "server.teammates.goalCoordinating", { bot: coordinator.name });
    const card = store.appendMessage(threadId, {
      role: "bot",
      kind: "goal.run",
      text: serverLine(language, "server.teammates.goal.working", { detail }),
      from: { botId: coordinator.id, name: coordinator.name, color: coordinator.color },
      goalRun: {
        runId,
        goal,
        status: "working",
        coordinatorBotId: coordinator.id,
        coordinatorName: coordinator.name,
        turnCount: 0,
        maxTurns: GROUP_GOAL_MAX_TURNS,
        detail,
        startedAt,
      },
    });
    return {
      runId,
      cardMessageId: card.id,
      goal,
      coordinatorBotId: coordinator.id,
      coordinatorName: coordinator.name,
      turnCount: 0,
      maxTurns: GROUP_GOAL_MAX_TURNS,
      startedAt,
      finished: false,
    };
  }

  /** `stillHere` is false once the conversation is gone: the routine still settles, the card is not touched. */
  function finish(
    threadId: string,
    run: LiveGoalRun | undefined,
    status: Exclude<GroupGoalRunStatus, "working">,
    detail: string,
    stillHere: () => boolean,
    text?: ServerText,
  ): void {
    if (!run || run.finished) return;
    run.finished = true;
    const finishedAt = Date.now();
    const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
    const card: GroupGoalRunCardData = {
      runId: run.runId,
      goal: redactSecretsInText(run.goal),
      status,
      coordinatorBotId: run.coordinatorBotId,
      coordinatorName: redactSecretsInText(run.coordinatorName),
      turnCount: run.turnCount,
      maxTurns: run.maxTurns,
      ...detailFields(safeDetail, text),
      startedAt: run.startedAt,
      finishedAt,
    };
    if (!stillHere()) return;
    store.patchMessage(threadId, run.cardMessageId, {
      text: serverLine(conversationLanguage(threadId), GOAL_STATE[status] ?? "server.teammates.goal.failed", { detail: card.detail || card.goal }),
      goalRun: card,
    });
  }

  function progress(threadId: string, run: LiveGoalRun | undefined, detail: string, text?: ServerText): void {
    if (!run || run.finished) return;
    const safeDetail = redactSecretsInText(detail.trim()).slice(0, 500);
    const current = store.messagesFor(threadId).find((message: Message) => message.id === run.cardMessageId);
    const fields = detailFields(safeDetail, text);
    if (current?.goalRun?.status === "working" && current.goalRun.detail === safeDetail && current.goalRun.detailCode === fields.detailCode
      && JSON.stringify(current.goalRun.detailParams) === JSON.stringify(fields.detailParams)) return;
    store.patchMessage(threadId, run.cardMessageId, {
      text: serverLine(conversationLanguage(threadId), "server.teammates.goal.working", { detail: safeDetail || redactSecretsInText(run.goal) }),
      goalRun: {
        runId: run.runId,
        goal: redactSecretsInText(run.goal),
        status: "working",
        coordinatorBotId: run.coordinatorBotId,
        coordinatorName: redactSecretsInText(run.coordinatorName),
        turnCount: run.turnCount,
        maxTurns: run.maxTurns,
        ...fields,
        startedAt: run.startedAt,
      },
    });
  }

  return { start, finish, progress };
}

export type GoalCards = ReturnType<typeof createGoalCards>;
