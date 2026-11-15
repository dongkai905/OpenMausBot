import { Puzzle } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

import { ELEVATED_CONTROL, ELEVATED_HOVER } from "./elevated";
import { SIMPLE_TOP_BUTTON } from "./SidebarSimpleTop";

/** The way into the Apps panel: this workspace's MCP servers and the app connections it has. */
export function SidebarConnectApps({ circle = false }: { circle?: boolean }) {
  const { state, dispatch } = useStore();
  const label = t("sidebar.connectApps");
  return (
    <button
      type="button"
      data-tour="nav-apps"
      data-sidebar-nav="apps"
      aria-pressed={state.pluginsOpen}
      aria-label={circle ? label : undefined}
      title={circle ? label : undefined}
      onClick={() => dispatch({ type: "togglePlugins", open: true })}
      className={circle ? SIMPLE_TOP_BUTTON : cn("flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full pl-4 pr-3 text-[14px] font-medium leading-5 text-ink", ELEVATED_CONTROL, ELEVATED_HOVER)}
    >
      {circle ? <Puzzle size={18} strokeWidth={1.5} aria-hidden="true" /> : (
        <span className="min-w-0 truncate">{label}</span>
      )}
    </button>
  );
}
