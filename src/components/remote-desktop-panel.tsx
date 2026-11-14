import { useEffect, useRef, useState } from "react";
import { Globe, ImageOff, Loader2, Monitor, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { usePageVisible } from "@/lib/page-visible";
import { isRemoteScreenshotContention, remoteScreenshotSource } from "@/lib/remote-desktop";
import { t } from "@/lib/i18n";
import { api, ApiError, useStore, type Bot } from "@/state/store";
import { releaseComputerPanelFocus, takeComputerPanelBrowserView, useComputerPanelEntry } from "@/lib/computer-panel-focus";
import { BrowserPanel, type BrowserSignIn } from "./BrowserPanel";
import { SignInBanner } from "./SignInRequestCard";
import { productName } from "@/lib/brand";

function viewerAddress(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new Error(t("remoteDesktop.noLink"));
  if (raw.startsWith("/vps-viewer/")) return new URL(raw, window.location.origin).toString();
  return raw;
}

export function RemoteDesktopPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const panelRef = useComputerPanelEntry(bot.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [previewPending, setPreviewPending] = useState(true);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const pageVisible = usePageVisible();
  const previewBusy = useRef(bot.busy);
  useEffect(() => { previewBusy.current = bot.busy; }, [bot.busy]);
  const [view, setView] = useState<"desktop" | "browser">(() => takeComputerPanelBrowserView(bot.id) ? "browser" : "desktop");
  const [signIn, setSignIn] = useState<BrowserSignIn>();
  const help = state.computerControl[bot.id]?.help ?? null;
  const asker = help ? state.bots.find((candidate) => candidate.id === help.botId)?.name ?? bot.name : bot.name;
  const requestedSignIn = state.signInFocus?.botId === bot.id ? state.signInFocus : undefined;
  useEffect(() => {
    if (!requestedSignIn || requestedSignIn.consumed) return;
    setView(requestedSignIn.place === "browser" ? "browser" : "desktop");
    if (requestedSignIn.place === "browser") setSignIn({ url: requestedSignIn.url, site: requestedSignIn.site, nonce: requestedSignIn.requestId });
    dispatch({ type: "signInFocusConsumed", requestId: requestedSignIn.requestId });
  }, [dispatch, requestedSignIn]);
  useEffect(() => {
    setFrame(null);
    setPreviewPending(true);
    setPreviewUnavailable(false);
  }, [bot.id]);

  useEffect(() => {
    const viewer = window.ogb?.desktopViewer;
    if (!viewer) return;
    let alive = true;
    void viewer.currentState().then((state) => {
      if (alive) setViewerOpen(state.open && state.contextId === bot.id);
    }).catch(() => {});
    const dispose = viewer.onState((state) => {
      if (state.contextId === bot.id || !state.open) setViewerOpen(state.open && state.contextId === bot.id);
    });
    return () => {
      alive = false;
      dispose();
    };
  }, [bot.id]);

  useEffect(() => {
    if (view !== "desktop" || !pageVisible || viewerOpen || pending) return;
    const controller = new AbortController();
    let requestRunning = false;
    let lastAttemptAt = -Infinity;
    let retryDelay: number | null = null;
    let contentionSince: number | null = null;
    const shoot = async () => {
      if (requestRunning || controller.signal.aborted) return;
      if (Date.now() - lastAttemptAt < (retryDelay ?? (previewBusy.current ? 4000 : 30_000))) return;
      requestRunning = true;
      retryDelay = null;
      try {
        const source = remoteScreenshotSource(await api(`/api/bots/${bot.id}/computer/screenshot`, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        }));
        if (!controller.signal.aborted && source) {
          setFrame(source);
          setPreviewUnavailable(false);
          contentionSince = null;
        } else if (!controller.signal.aborted) {
          setPreviewUnavailable(true);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof ApiError && isRemoteScreenshotContention(cause)) {
            retryDelay = 1000;
            contentionSince ??= Date.now();
            const prolonged = Date.now() - contentionSince >= 10_000;
            setPreviewUnavailable(prolonged);
            setPreviewPending(!prolonged);
          } else {
            contentionSince = null;
            setPreviewUnavailable(true);
          }
        }
      } finally {
        if (!controller.signal.aborted && retryDelay === null) setPreviewPending(false);
        requestRunning = false;
        lastAttemptAt = Date.now();
      }
    };
    void shoot();
    const timer = window.setInterval(shoot, 1000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [bot.id, pageVisible, viewerOpen, pending, view]);

  const open = async () => {
    setPending(true);
    setError(null);
    let tookControl = false;
    try {
      if (!window.ogb?.desktopViewer) throw new Error(t("remoteDesktop.viewerUnavailable"));
      await api(`/api/bots/${bot.id}/computer/control`, {
        method: "POST",
        body: JSON.stringify({ action: "take" }),
      });
      tookControl = true;
      const joined = await api(`/api/bots/${bot.id}/computer/join`, {
        method: "POST",
        body: "{}",
      });
      const opened = await window.ogb.desktopViewer.open(
        viewerAddress(joined.joinUrl),
        t("computer.viewerTitle", { name: bot.name }),
        bot.id,
      );
      if (!opened) throw new Error(t("computer.err.openDesktop", { app: productName() }));
    } catch (cause) {
      if (tookControl) {
        await api(`/api/bots/${bot.id}/computer/control`, {
          method: "POST",
          body: JSON.stringify({ action: "release" }),
        }).catch(() => {});
      }
      await api(`/api/bots/${bot.id}/computer/viewer-close`, {
        method: "POST",
        body: "{}",
      }).catch(() => {});
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline bg-panel" ref={panelRef} data-computer-panel>
      <div {...dragProps} className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <div>
          <div className="text-[14px] font-medium text-ink">{t("remoteDesktop.title", { name: bot.name })}</div>
          <div className="mt-0.5 text-[11px] text-ink-secondary">
            {t(bot.cloudBackend === "vps" ? "botAccess.cloud.selfHostedVps" : "remoteDesktop.cloudDesktop")}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded-full bg-inset p-0.5" aria-label={t("computer.tabsAria")}>
            {(["desktop", "browser"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setView(option)}
                aria-pressed={view === option}
                className={cn("flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px]", view === option ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}
              >
                {option === "desktop" ? <Monitor size={12} /> : <Globe size={12} />}
                {t(option === "desktop" ? "remoteDesktop.desktop" : "place.browser")}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-computer-panel-close
            onClick={() => {
              releaseComputerPanelFocus(panelRef.current, bot.id);
              dispatch({ type: "toggleComputer", open: false });
            }}
            className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label={t("remoteDesktop.close")}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {view === "browser" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-1">
          {help?.place === "browser" && <div className="-mt-2 mb-3"><SignInBanner help={help} askerName={asker} onError={setError} /></div>}
          <BrowserPanel bot={bot} signIn={signIn} />
          {error && <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
            {t("remoteDesktop.browserHint")}
          </p>
        </div>
      ) : (
      <div className="flex flex-1 flex-col items-center gap-4 overflow-y-auto px-6 py-5 text-center">
        {help && help.place !== "browser" && <div className="-mt-3 w-full"><SignInBanner help={help} askerName={asker} onError={setError} /></div>}
        <button
          type="button"
          onClick={() => void open()}
          disabled={pending || !frame}
          className="group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-hairline bg-black disabled:cursor-default"
          aria-label={frame ? t("computer.openLiveDesktopAria", { name: bot.name }) : t("remoteDesktop.previewUnavailableLabel")}
        >
          {frame ? (
            <img src={frame} alt={t("remoteDesktop.previewAlt", { name: bot.name })} className="h-full w-full object-contain" />
          ) : previewPending ? (
            <Loader2 size={22} className="animate-spin text-ink-secondary" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-ink-secondary">
              <ImageOff size={24} />
              <span className="text-[11px]">{t(previewUnavailable ? "remoteDesktop.previewUnavailable" : "remoteDesktop.previewWaiting")}</span>
            </div>
          )}
          {frame && (
            <span className="absolute inset-x-0 bottom-0 bg-black/65 py-2 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
              {t("computer.openLiveDesktop")}
            </span>
          )}
        </button>
        <div>
          <div className="text-[14px] font-medium text-ink">{t("remoteDesktop.openLive")}</div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
            {t("remoteDesktop.relayHint")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void open()}
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Monitor size={15} />}
          {t(pending ? "settings.updates.opening" : "computer.takeControl")}
        </button>
        {error && (
          <div role="alert" className="w-full rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-left text-[12px] text-danger">
            {error}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-ink-secondary">
          {t("remoteDesktop.accessHint")}
        </p>

      </div>
      )}
    </aside>
  );
}
