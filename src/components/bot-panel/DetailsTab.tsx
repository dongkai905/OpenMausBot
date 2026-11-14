import { CalendarPlus, ChevronRight, Sparkles } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { useChatMoreItems } from "../ChatMoreMenu";
import { ModelPicker } from "../ModelPicker";
import type { SidebarMenuItem } from "../SidebarPopoverMenu";
import { BotConversations } from "./Conversations";
import { TryAsking } from "./TryAsking";
import { CardLabel, LabelAction, panelActionCls, RowIcon, rowCls, RowText } from "./rows";

export const CONVERSATION_ITEMS = ["find", "start-fresh", "share-team", "share-person", "usage", "activity", "inspector"];

/** A ⋯ menu item drawn as a panel row: the same label, icon, value and handler. */
export function ItemRow({ item }: { item: SidebarMenuItem }) {
  // Only the usage value is long text that should wrap; shortcuts and other values keep their full width.
  const wrapsValue = item.key === "usage";
  return (
    <button
      type="button"
      data-panel-item={item.key}
      disabled={item.disabled}
      title={item.title}
      aria-pressed={item.active || undefined}
      onClick={item.onSelect}
      className={cn(rowCls, "w-full rounded-[8px] text-left enabled:hover:bg-ink/[0.04] disabled:cursor-default disabled:opacity-45")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary [&_svg]:size-4" aria-hidden="true">
        {item.icon}
      </span>
      <span className={cn("min-w-0 truncate text-[14px] font-medium", !wrapsValue && "flex-1", item.active ? "text-accent-text" : "text-ink")}>{item.label}</span>
      {item.trailing && <span className={cn("flex items-center", wrapsValue ? "min-w-0 flex-1 justify-end text-right" : "shrink-0")}>{item.trailing}</span>}
      {item.key !== "find" && item.key !== "start-fresh" && <ChevronRight size={15} aria-hidden="true" className="shrink-0 text-ink-tertiary rtl:-scale-x-100" />}
    </button>
  );
}

export function DetailsTab({ bot }: { bot: Bot }) {
  const { items } = useChatMoreItems(bot);
  const { dispatch } = useStore();
  const conversationItems = CONVERSATION_ITEMS.flatMap((key) => items.filter((item) => item.key === key));

  return (
    <div data-panel-tabpanel="details">
      {/* One row style down the whole tab: flat rows under quiet labels, no cards. */}
      <section data-panel-card="model" className="pt-2">
        <div data-panel-row="model" className={cn(rowCls, "rounded-[8px]")}>
          <ModelPicker
            bot={bot}
            contained
            threadId={bot.threadId}
            label={<span className="flex shrink-0 items-center gap-2.5"><RowIcon icon={Sparkles} /><RowText title={t("model.simple.model")} /></span>}
          />
        </div>
      </section>

      <BotConversations bot={bot} />

      <TryAsking bot={bot} />

      {conversationItems.length > 0 && (
        <section data-panel-card="conversation">
          <CardLabel>{t("botPanel.section.conversation")}</CardLabel>
          {conversationItems.map((item) => <ItemRow key={item.key} item={item} />)}
        </section>
      )}

      <section data-panel-empty="automations">
        <CardLabel action={<LabelAction data-panel-automations="" onClick={() => dispatch({ type: "showAutomations" })}>{t("sidebar.nav.automations")}</LabelAction>}>
          {t("automations.title")}
        </CardLabel>
        <button
          type="button"
          data-panel-page="automations"
          title={t("automations.title")}
          onClick={() => dispatch({ type: "showAutomations" })}
          className={cn(panelActionCls, "w-full")}
        >
          <CalendarPlus size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <span className="truncate">{t("automations.new")}</span>
        </button>
      </section>
    </div>
  );
}
