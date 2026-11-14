import { afterEach, describe, expect, it } from "vitest";

import { activityText } from "./activity-text";
import { redactParams } from "../../shared/redact";
import { botLineText } from "./transcript-derivations";
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

describe("data that looks like a catalog key", () => {
  it("is shown as written: only the params a line declares as references are looked up", () => {
    setLocale("pt-br");
    expect(botLineText({ text: "x", textCode: "chat.notice.webhookHome", textParams: { name: "chat.notice.part.switchAccount" } }))
      .toContain("meu webhook “chat.notice.part.switchAccount”");
    expect(activityText({ nameCode: "chat.notice.toolCount", nameParams: { provider: "Grok", limit: "chat.notice.part.usageLimit" } }, "x"))
      .toBe("Grok recusou esta sessão porque o limite de ferramentas deste modelo é limite de uso e este bot oferece mais, mesmo com as listas reduzidas. Nada foi executado. Desligue alguns apps ou servidores MCP deste bot, ou mude para outro modelo.");
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
});
