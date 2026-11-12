import { failedTurnTool, type FailedTurnTool } from "../shared/failed-turn.ts";
import { formatServerText, isReferenceParam, type ServerText, type ServerTextParams } from "../shared/server-text.ts";
import { redactParams } from "../shared/redact.ts";
import { DRIVER_NOTICE } from "./drivers/driver-notices.ts";

/** The client translates by key and falls back to this English, which the row keeps for phones, exports and older clients. */
export const CHAT_NOTICE = {
  ...DRIVER_NOTICE,

} as const;

export type ChatNoticeKey = keyof typeof CHAT_NOTICE;

export function chatNotice(key: ChatNoticeKey, params?: ServerTextParams): string {
  const words = params && Object.fromEntries(Object.entries(params).map(([name, value]) =>
    [name, isReferenceParam(name, value) && Object.hasOwn(CHAT_NOTICE, value) ? CHAT_NOTICE[value as ChatNoticeKey] : value]));
  return formatServerText(CHAT_NOTICE[key], words);
}

export function noticeLine<Key extends ChatNoticeKey, Params extends ServerTextParams = ServerTextParams>(key: Key, params?: Params) {
  const safe = params && redactParams(params);
  return { text: chatNotice(key, safe), textCode: key, ...(safe ? { textParams: safe } : {}) };
}

export function runtimeNoticeTool(event: { message: string; text?: ServerText }) {
  return { name: `notice: ${event.message.slice(0, 240)}`, ok: true,
    ...(event.text ? { nameCode: event.text.key, ...(event.text.params ? { nameParams: redactParams(event.text.params) } : {}) } : {}) };
}

export function noticeSummary<Params extends ServerTextParams = ServerTextParams>(key: ChatNoticeKey, params?: Params) {
  const line = noticeLine(key, params);
  return { summary: line.text, summaryCode: key, ...(line.textParams ? { summaryParams: line.textParams } : {}) };
}

export function noticeFailure(key: ChatNoticeKey, params?: ServerTextParams): { message: string; text: ServerText } {
  const line = noticeLine(key, params);
  return { message: line.text, text: { key, ...(line.textParams ? { params: line.textParams } : {}) } };
}

export function noticeTool<T extends object>(
  key: ChatNoticeKey,
  params: ServerTextParams | undefined,
  extra: T,
): T & { name: string; nameCode: ChatNoticeKey; nameParams?: ServerTextParams } {
  const safe = params && redactParams(params);
  return { ...extra, name: chatNotice(key, safe), nameCode: key, ...(safe ? { nameParams: safe } : {}) };
}

export function failedNoticeTool(key: ChatNoticeKey, params?: ServerTextParams): FailedTurnTool {
  return failedTurnTool(chatNotice(key, params), { text: { key, ...(params ? { params } : {}) } });
}
