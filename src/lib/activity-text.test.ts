import { afterEach, describe, expect, it } from "vitest";

import { activityText, routineLineText } from "./activity-text";
import { formatServerText } from "../../shared/server-text";
import { redactParams } from "../../shared/redact";
import en from "@/locales/en.json";
import { botLineText } from "./transcript-derivations";
import { routineRunText } from "./routine-display";
import type { RoutineRun } from "./routines";
import { serverLine } from "../../server/server-lines";
import "../../server/server-line-packs";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

describe("a delegating bot's resumed line", () => {
  it("shows the line in the language the server used without translating it twice", () => {
    const english = serverLine(undefined, "server.teammates.resumedQuestionRestart", { who: "Scout, Ada" });
    expect(english).toBe("Resumed with a question from Scout, Ada after a restart, reviewing");
    expect(activityText({}, english)).toBe(english);
    setLocale("pt-br");
    const portuguese = serverLine("pt-br", "server.teammates.resumedQuestionRestart", { who: "Scout, Ada" });
    expect(activityText({}, portuguese)).toBe("Após uma reinicialização, retomou o trabalho com uma pergunta de Scout, Ada e está revisando");
    expect(activityText({}, english)).toBe(english);
  });
});

describe("server notices", () => {
  const resets = {
    name: "error: This Claude account has reached its usage limit (Claude says: \"quota\"), which resets Oct 22, 3:00 PM (UTC). Until then, switch this bot to another AI.",
    nameCode: "chat.notice.usageLimitResets",
    nameParams: { provider: "Claude", detail: " (Claude says: \"quota\")", resets: "Oct 22, 3:00 PM (UTC)" },
  };
  const english = resets.name.slice("error: ".length);

  it("word the parts they name and the moment they reset, in the reader's language", () => {
    setLocale("pt-br");
    expect(activityText(resets, english)).toBe("Esta conta de Claude atingiu o limite de uso (Claude says: \"quota\"), que será renovado em Oct 22, 3:00 PM (UTC). Até lá, troque a IA deste bot.");
    expect(activityText({ nameCode: "chat.notice.usageLimit", nameParams: { provider: "Grok", detail: " (Grok says: \"quota\")" } }, "x"))
      .toBe("Esta conta de Grok atingiu o limite de uso (Grok says: \"quota\"). Espere o limite ser renovado ou troque a IA deste bot.");
  });

  it("show the server's own English in English, and when a part or the zone cannot be worded", () => {
    expect(activityText(resets, english)).toBe(english);
    setLocale("pt-br");
    // A line whose params cannot all be worded is shown as the server wrote it.
    expect(activityText({ ...resets, nameParams: { provider: "Claude", detail: " (Claude says: \"quota\")" } }, english)).toBe(english);
  });

  it("word a bot's fixed line, and leave its other lines as written", () => {
    setLocale("pt-br");
    expect(botLineText({ text: "English", textCode: "chat.notice.webhookHome", textParams: { name: "Orders" } }))
      .toBe("Voltei para este computador, então meu webhook “Orders” tem um endereço aqui novamente. Abra “Automações”, escolha “Copiar endereço” em “Orders” e cole no app que envia para ele.");
    expect(botLineText({ text: "Hello" })).toBe("Hello");
  });
});

describe("a routine's fixed lines", () => {
  it("are worded by their code, and only a routines.server code", () => {
    expect(routineLineText("routines.server.nothingNew", "Nothing new since the last check")).toBe("Nothing new since the last check");
    setLocale("pt-br");
    expect(routineLineText("routines.server.nothingNew", "Nothing new since the last check")).toBe("Nada novo desde a última verificação");
    expect(routineLineText("chat.notice.resumingAfterRestart", "x")).toBe("x");
    expect(routineLineText(undefined, "x")).toBe("x");
  });
});

describe("a routine run's coded error and attention", () => {
  it.each([
    ["stalled", "the AI stalled", "um travamento da IA"],
    ["rateLimited", "a rate limit", "atingir um limite de requisições"],
    ["provider", "a temporary error", "um erro temporário"],
    ["failed", "a failure", "um problema"],
  ])("composes the %s retry reason as a complete sentence", (part, english, portuguese) => {
    setLocale("pt-br");
    expect(routineLineText("routines.server.retryAfter", `Starting again shortly after ${english}: 429`, { why: `routines.server.part.${part}`, failure: "429" }))
      .toBe(`Vai começar novamente em instantes, depois de ${portuguese}. Detalhe: 429`);
  });

  const limitWait = "Waiting for the AI's usage limit to reset; this run starts again at Oct 22, 3:00 PM (UTC)";
  const params = { resets: "Oct 22, 3:00 PM (UTC)", resetsAt: Date.UTC(2026, 9, 22, 15), timeZone: "UTC" };

  it("words parts and moments, and only while the field still reads as the line's English", () => {
    setLocale("pt-br");
    expect(routineLineText("routines.server.limitWait", limitWait, params)).toBe("Esperando a renovação do limite de uso da IA. Esta execução começa novamente em 22 de out., 15:00 (UTC)");
    expect(routineLineText("routines.server.retryAfter", "Starting again shortly after a rate limit: 429", { why: "routines.server.part.rateLimited", failure: "429" }))
      .toBe("Vai começar novamente em instantes, depois de atingir um limite de requisições. Detalhe: 429");
    expect(routineLineText("routines.server.limitWait", "The routine was paused before this run started", params)).toBe("The routine was paused before this run started");
    expect(routineLineText("settings.title", "Settings")).toBe("Settings");
  });
});

describe("data that looks like a catalog key", () => {
  it("is shown as written: only the params a line declares as references are looked up", () => {
    setLocale("pt-br");
    expect(botLineText({ text: "x", textCode: "chat.notice.webhookHome", textParams: { name: "chat.notice.part.switchAccount" } }))
      .toContain("meu webhook “chat.notice.part.switchAccount”");
    expect(activityText({ nameCode: "chat.notice.toolCount", nameParams: { provider: "Grok", limit: "chat.notice.part.usageLimit" } }, "x"))
      .toBe("Grok recusou esta sessão porque o limite de ferramentas deste modelo é limite de uso e este bot oferece mais, mesmo com as listas reduzidas. Nada foi executado. Desligue alguns apps ou servidores MCP deste bot, ou mude para outro modelo.");
    expect(routineLineText("routines.server.waitingToStart", "Waiting to start: routines.server.part.stalled", { failure: "routines.server.part.stalled" }))
      .toBe("Esperando para começar. Motivo: routines.server.part.stalled");
  });
});

describe("what a reader is shown of a stored line", () => {
  const SECRET = `sk-ant-${"a1B2".repeat(8)}`;

  it("never holds a secret its params were scrubbed of", () => {
    setLocale("pt-br");
    const textParams = redactParams({ name: SECRET });
    expect(botLineText({ text: "x", textCode: "chat.notice.webhookHome", textParams })).not.toContain(SECRET);
    expect(activityText({ nameCode: "chat.notice.goalWaiting", nameParams: redactParams({ name: SECRET }) }, "x")).not.toContain(SECRET);
  });

  it("is worded at the length limit, where the server cut the quoted failure to fit", () => {
    setLocale("pt-br");
    const params = { why: "routines.server.part.provider", failure: `${"x".repeat(450)}…` };
    const english = formatServerText(en["routines.server.retryAfter"], { ...params, why: en["routines.server.part.provider"] });
    expect(english.length).toBeLessThanOrEqual(500);
    expect(routineLineText("routines.server.retryAfter", english, params)).toMatch(/^Vai começar novamente em instantes, depois de um erro temporário\. Detalhe: x+…$/);
  });
});

describe("a run's coded engine error as the routine page shows it", () => {
  const whole = "Grok refused this turn because this model takes at most usage limit tools and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.";
  const params = { provider: "Grok", limit: "chat.notice.part.usageLimit" };

  it("is worded while it is whole, and shown in English once the server cut it and dropped its code", () => {
    setLocale("pt-br");
    expect(routineRunText({ error: whole, errorCode: "chat.notice.toolCount", errorParams: params } as unknown as RoutineRun, "error"))
      .toBe("Grok recusou esta sessão porque o limite de ferramentas deste modelo é limite de uso e este bot oferece mais, mesmo com as listas reduzidas. Nada foi executado. Desligue alguns apps ou servidores MCP deste bot, ou mude para outro modelo.");
    const cut = `Grok refused this turn because this model takes at most ${"x".repeat(500)}`.slice(0, 500);
    expect(routineRunText({ error: cut } as unknown as RoutineRun, "error")).toBe(cut);
    expect(routineRunText({ error: cut, errorCode: "chat.notice.toolCount", errorParams: { ...params, limit: "x".repeat(500) } } as unknown as RoutineRun, "error")).toBe(cut);
  });
});
