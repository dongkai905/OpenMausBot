import { useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Search, Server, X } from "lucide-react";

import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import { McpServersPanel } from "./McpServersPanel";
import { HOSTED_MCP_APPS, mcpServerConnected, ownMcpServer, type HostedApp, type HostedConnections } from "@/lib/hosted-mcp-apps";
import { isRemoteMcpListing, type McpServerListing } from "./mcp-draft";
import { EmailCard } from "./EmailCard";
import { PostizCard } from "./PostizCard";
import { X_CARD_SEARCH, XCard } from "./XCard";
import { POSTIZ_SEARCH } from "@/lib/postiz";
import { SavedKeysReset } from "./SavedKeysReset";

export type AppsFilter = "all" | "connected" | "mcp";

/** Whether a hosted app's card shows: it matches the search, and the filter is All, or Connected and it isn't known to be
 * disconnected (unknown while its servers load). */
export function hostedShown(app: HostedApp, search: string, filter: AppsFilter, connected: HostedConnections | null): boolean {
  const matches = !search || `${app.label} ${app.keywords} ${t(app.description)}`.toLowerCase().includes(search.toLowerCase().trim());
  return matches && (filter === "all" || (filter === "connected" && connected?.[app.id] !== false));
}

/** Every word of the search has to appear in the text. */
function matchesSearch(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).every((word) => haystack.includes(word));
}

/**
 * The Apps panel: this workspace's MCP servers, the hosted apps they offer, and the app connections it has of its own
 * (email, X, Postiz). The app catalogue a vendor used to offer is gone; what a person connects here is theirs.
 */
export function PluginsPanel() {
  const { state, dispatch } = useStore();
  const surface = state.pluginsSurface;
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"marketplace" | "connected">("marketplace");
  const [hostedConnected, setHostedConnected] = useState<HostedConnections | null>(null);
  const [cardsRefresh, setCardsRefresh] = useState(0);
  const [xConnected, setXConnected] = useState<boolean | null>(null);
  const [postizConnected, setPostizConnected] = useState<boolean | null>(null);
  const [emailConnected, setEmailConnected] = useState<boolean | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerListing[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);

    const controls = focusable();
    (controls.find((element) => element.matches("input")) ?? controls[0] ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "togglePlugins", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (!items.some((element) => element === document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus();
    };
  }, [dispatch]);

  const filter: AppsFilter = surface === "mcp" ? "mcp" : tab === "connected" ? "connected" : "all";
  const searching = search.trim().length > 0;
  /** A search covers the whole panel, whichever view it was typed in. */
  const listing: AppsFilter = searching && filter === "connected" ? "all" : filter;
  const shownHosted = new Set(HOSTED_MCP_APPS.filter((app) => hostedShown(app, search, listing, hostedConnected)).map((app) => app.id));
  const showEmail = (!search || `email mail imap smtp mailbox ${t("email.description")}`.toLowerCase().includes(search.toLowerCase().trim())) && (listing === "all" || (listing === "connected" && emailConnected !== false));
  const showX = (!search || `${X_CARD_SEARCH} ${t("apps.x.description")}`.toLowerCase().includes(search.toLowerCase().trim())) && (listing === "all" || (listing === "connected" && xConnected !== false));
  const showPostiz = (!search || `${POSTIZ_SEARCH} ${t("postiz.description")}`.toLowerCase().includes(search.toLowerCase().trim())) && (listing === "all" || (listing === "connected" && postizConnected !== false));
  const ownServers = mcpServers.filter((server) => ownMcpServer(server));
  const ownServerShown = (server: McpServerListing) => matchesSearch(`${server.name} ${isRemoteMcpListing(server) ? server.url : [server.command, ...server.args].join(" ")}`, search);
  const connectedHosted = HOSTED_MCP_APPS.filter((app) => hostedConnected?.[app.id]);
  const connectedCount = connectedHosted.length + ownServers.filter(mcpServerConnected).length + Number(emailConnected === true) + Number(xConnected === true) + Number(postizConnected === true);
  const close = () => dispatch({ type: "togglePlugins", open: false });
  const chooseFilter = (next: AppsFilter) => {
    if (next === "mcp") {
      dispatch({ type: "togglePlugins", open: true, surface: "mcp" });
      return;
    }
    setTab(next === "connected" ? "connected" : "marketplace");
    if (surface !== "apps") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  };
  const pill = "inline-flex h-7 shrink-0 items-center justify-center gap-2 rounded-full px-3 text-[13px] font-medium leading-5 transition-colors";

  return (
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        data-tour="apps-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex max-w-[780px] flex-col overflow-hidden rounded-2xl"
      >
        <header className="flex flex-col gap-4 px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div>
          <div className="flex items-center justify-between gap-3">
            <h2 id="plugins-title" className="min-w-0 truncate text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t("apps.title")}</h2>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                data-apps-filter="connected"
                aria-pressed={filter === "connected"}
                onClick={() => chooseFilter(filter === "connected" ? "all" : "connected")}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full ps-1.5 pe-2 text-[13px] font-medium leading-5 transition-colors",
                  filter === "connected" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                <span className="whitespace-nowrap">
                  {connectedCount > 0 ? t("apps.connectedCount", { count: connectedCount }) : t("apps.filter.connected")}
                </span>
                <ChevronRight size={14} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
              </button>
              <button
                onClick={() => setCardsRefresh((value) => value + 1)}
                className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
                title={t("connectors.refreshTitle")}
                aria-label={t("connectors.refreshTitle")}
              >
                <RefreshCw size={16} />
              </button>
              <button data-tour="apps-close"
                onClick={close}
                aria-label={t("connectors.closeAria")}
                className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{t("apps.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-control/70 px-3.5 focus-within:ring-1 focus-within:ring-accent">
              <Search size={15} className="shrink-0 text-ink-secondary" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("connectors.searchPlaceholder")}
                aria-label={t("connectors.searchPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </label>
            <button
              type="button"
              data-apps-filter="mcp"
              aria-pressed={filter === "mcp"}
              onClick={() => chooseFilter(filter === "mcp" ? "all" : "mcp")}
              className={cn(pill, "h-9 border border-hairline/40 px-3.5", filter === "mcp" ? "bg-ink text-app" : "text-ink hover:bg-raised")}
            >
              <Server size={14} aria-hidden="true" />
              <span className="hidden sm:inline">{t("apps.filter.mcp")}</span>
              <span className="sr-only sm:hidden">{t("apps.filter.mcp")}</span>
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-7 sm:px-7">
          <SavedKeysReset notice />
          {filter !== "mcp" && (
            <div data-apps-grid className="@container flex flex-col gap-7 pt-1">
              <McpServersPanel hostedCards={{ shown: (id) => shownHosted.has(id), onConnections: setHostedConnected, onServers: setMcpServers, ...(filter === "connected" ? { ownServers: { shown: ownServerShown, manage: () => chooseFilter("mcp") } } : {}) }} refreshKey={cardsRefresh} />
              <div data-native-card="x" className={showX ? "contents" : "hidden"}><XCard refreshKey={cardsRefresh} onConnection={setXConnected} /></div>
              <div data-native-card="email" className={showEmail ? "contents" : "hidden"}><EmailCard refreshKey={cardsRefresh} onConnection={setEmailConnected} /></div>
              <div data-native-card="postiz" className={showPostiz ? "contents" : "hidden"}><PostizCard refreshKey={cardsRefresh} onConnection={setPostizConnected} /></div>
            </div>
          )}

          {filter !== "connected" && (
            <div className={cn(filter === "all" && "mt-8 border-t border-hairline/30 pt-6", filter === "mcp" && "pt-1")}>
              <McpServersPanel embedded hideHosted={filter === "all"} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
