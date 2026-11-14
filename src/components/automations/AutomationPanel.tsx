import { Pause, Pencil, Play, Trash2, X } from "lucide-react";

import { automationStatus, automationSubtitle, STATUS_WORD, type Automation } from "@/lib/automations";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { AppEventsSection } from "./AppEventsSection";
import { useAllAutomationActions } from "./app-actions";
import { FixButton, StatusMark } from "./parts";

const BUTTON = "flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium disabled:opacity-50";

/** One automation, simply: its sentence, its status, what its app sent lately, and what can be done to it. */
export function AutomationPanel({ automation, sentence, onClose, onEdit, onDeleted }: {
  automation: Automation;
  sentence: string;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { state } = useStore();
  const actions = useAllAutomationActions();
  const status = automationStatus(automation);
  const statusWord = t(STATUS_WORD[status.state]);
  const name = automation.name.trim();
  const botName = state.bots.find((bot) => bot.id === automation.botId)?.name ?? t("automations.unavailableBot");
  const instructions = automation.instructions.trim();
  const reason = status.reason;

  return (
    <aside aria-label={t("automations.panel.label")} className="flex h-full w-[min(380px,100vw)] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-start gap-3 border-b border-hairline/40 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold leading-snug text-ink">{name || sentence}</h2>
          {name && <p className="mt-0.5 text-[13px] text-ink-secondary">{automationSubtitle(automation, botName)}</p>}
        </div>
        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("automations.panel.close")}><X size={16} /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px]" data-automation-status={status.state}>
          <StatusMark status={status} />
          <span className={cn("font-medium", status.state === "needs-you" ? "text-warning" : "text-ink")}>{statusWord}</span>
          {reason && <span className="min-w-0 text-ink-secondary">{reason}</span>}
          <FixButton status={status} actions={actions} onEdit={onEdit} />
        </div>

        {name && instructions && <p data-testid="automation-instructions" className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{instructions}</p>}

        <AppEventsSection trigger={automation.appTrigger} />

        {actions.error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{actions.error}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-hairline/40 px-5 py-3.5">
        <button type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.runNow(automation)} className={cn(BUTTON, "bg-accent text-accent-ink hover:brightness-110")}><Play size={14} />{actions.busy === `run:${automation.id}` ? t("automations.starting") : t("automations.runNow")}</button>
        <button type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.toggle(automation)} className={cn(BUTTON, "border border-hairline/50 bg-control text-ink hover:bg-raised-hover")}>{automation.enabled ? <Pause size={14} /> : <Play size={14} />}{automation.enabled ? t("automations.pause") : t("automations.resume")}</button>
        <button type="button" onClick={onEdit} className={cn(BUTTON, "text-ink hover:bg-raised")}><Pencil size={14} />{t("automations.edit")}</button>
        <button type="button" disabled={Boolean(actions.busy)} onClick={() => void actions.remove(automation, t("automations.deleteConfirm", { sentence })).then((gone) => { if (gone) onDeleted(); })} className={cn(BUTTON, "text-danger hover:bg-danger/10")}><Trash2 size={14} />{t("automations.delete")}</button>
      </div>
    </aside>
  );
}
