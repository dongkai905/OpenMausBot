import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Info, KeyRound } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { startCloudSetup } from "@/components/CloudIntent";
import { engineReady } from "@/components/EngineLibrary";
import { staggerIndex } from "@/components/onboarding/beats/shared";
import { productName } from "@/lib/brand";
import { reopenCloudIntent, setPendingIntent, useCloudIntent } from "@/lib/cloud-intent";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausMotion, MausState } from "@/lib/mascot";
import { withViewTransition } from "@/components/onboarding/view-transition";
import { useStore } from "@/state/store";
import { openKeySettings } from "./keys/key-focus";

export function useCloudEngineChoices() {
  const { state, dispatch, refreshInstances } = useStore();
  const [checking, setChecking] = useState(false);
  const recheck = async () => {
    setChecking(true);
    try {
      await refreshInstances();
    } finally {
      setChecking(false);
    }
  };
  return { instances: state.instances, dispatch, checking, recheck };
}

export type CloudEngineChoices = ReturnType<typeof useCloudEngineChoices>;

/** The page's one route to an AI: a key of the person's own. */
export function cloudEngineChoices(engines: CloudEngineChoices): ReactNode {
  const { dispatch, checking, recheck } = engines;
  return <>
    <div data-cloud-choice="api-key" className="animate-rise mt-4 flex flex-col items-center text-center" style={staggerIndex(4)}>
      <button
        type="button"
        onClick={() => dispatch(openKeySettings())}
        className="group inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[14px] font-medium text-ink transition-[background-color,transform] duration-150 ease-out hover:bg-raised/60 active:scale-[0.97]"
      >
        <KeyRound size={15} aria-hidden="true" className="text-ink-secondary" />
        {t("cloudSignIn.apiKey")}
        <ArrowUpRight size={14} aria-hidden="true" className="text-ink-secondary transition-transform duration-150 ease-out group-hover:-translate-y-px group-hover:translate-x-px" />
      </button>
      <p className="mt-1 max-w-[380px] text-[12px] leading-relaxed text-ink-secondary">{t("cloudSignIn.apiKeyHint")}</p>
    </div>

    <p role="note" className="animate-rise mx-auto mt-8 flex max-w-[440px] gap-2 text-[12px] leading-relaxed text-ink-secondary" style={staggerIndex(5)}>
      <Info size={13} aria-hidden="true" className="mt-[3px] shrink-0" />
      <span>{t("cloudSignIn.limits")}</span>
    </p>

    <div className="animate-rise mt-5 flex items-center justify-center gap-1.5 text-[13px] text-ink-secondary" style={staggerIndex(6)}>
      <span>{t("cloudSignIn.signedIn")}</span>
      <button
        type="button"
        onClick={() => void recheck()}
        disabled={checking}
        className="rounded-md px-2 py-1 font-medium text-ink transition-[background-color,transform] duration-150 ease-out hover:bg-ink active:scale-[0.97] disabled:opacity-60"
      >
        {checking ? t("common.checking") : t("common.checkAgain")}
      </button>
    </div>
  </>;
}

export function CloudEngineSignIn() {
  const engines = useCloudEngineChoices();
  const { state, dispatch } = useStore();
  const [motion, setMotion] = useState<{ kind: MausMotion; key: number }>({ kind: "none", key: 0 });
  // One frame late: a motion issued in the avatar's mounting commit is lost.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotion({ kind: "arrive", key: 1 }));
    return () => cancelAnimationFrame(frame);
  }, []);
  const { pending } = useCloudIntent();
  const ready = state.instances.some(engineReady);
  const latest = useRef(state);
  latest.current = state;
  const [handing, setHanding] = useState(false);
  useEffect(() => {
    if (!pending || !ready) return;
    setHanding(true);
    setMotion({ kind: "success", key: 2 });
    const timer = setTimeout(() => {
      if (!startCloudSetup(pending, latest.current, dispatch)) setPendingIntent(null);
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, ready]);
  let face: MausState = "curious";
  if (handing) face = "proud";
  else if (engines.checking) face = "searching";
  const credit = state.instances.find((instance) => instance.trialCredit && instance.trialCredit !== "active")?.trialCredit;

  return (
    <main data-cloud-sign-in className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(55%_100%_at_50%_0%,color-mix(in_oklab,var(--color-accent)_9%,transparent),transparent)]"
      />
      <div className="stagger relative mx-auto flex w-full max-w-[540px] flex-col px-6 pb-12 pt-[clamp(48px,10vh,112px)]">
        <div className="animate-rise flex flex-col items-center text-center" style={staggerIndex(0)}>
          <MausAvatar color="green" state={face} motion={motion.kind} motionKey={motion.key} size={64} label={productName()} />
        </div>
        {pending && (
          <figure data-cloud-intent-pending className="mt-6 rounded-2xl bg-composer px-4 pb-3 pt-2.5 ring-1 ring-composer-ring" style={{ viewTransitionName: "cloud-intent" }}>
            <figcaption className="flex items-center justify-between gap-3 text-[12px] text-ink-secondary">
              {t("cloudIntent.pending")}
              {!handing && (
                <button type="button" onClick={() => withViewTransition(() => reopenCloudIntent(true))} className="rounded-md px-1.5 py-0.5 font-medium text-ink-secondary transition-colors hover:bg-raised hover:text-ink">
                  {t("cloudIntent.edit")}
                </button>
              )}
            </figcaption>
            <p className="mt-1 text-[14px] leading-relaxed text-ink">
              <span className="mr-1.5 inline-flex h-[21px] items-center rounded-md bg-accent/15 px-1.5 align-[1px] text-[13px] font-semibold text-accent">/setup</span>
              {pending}
            </p>
            {handing && (
              <p role="status" className="animate-rise mt-2 flex items-center gap-1.5 text-[13px] font-medium text-success">
                <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                {t("cloudSignIn.connected")}
              </p>
            )}
          </figure>
        )}
        <h1 className={cn("animate-rise text-center text-[22px] font-semibold tracking-[-0.01em] text-ink", pending ? "mt-7" : "mt-5")} style={staggerIndex(1)}>
          {t(pending ? "cloudSignIn.titleForJob" : "cloudSignIn.title")}
        </h1>
        {credit && <p role="status" data-trial-credit={credit} className="animate-rise mx-auto mt-2 max-w-[440px] text-center text-[14px] font-medium leading-relaxed text-ink" style={staggerIndex(2)}>
          {t(credit === "used_up" ? "cloudSignIn.creditUsedUp" : "cloudSignIn.creditEnded")}
        </p>}
        <p className="animate-rise mx-auto mt-2 max-w-[440px] text-center text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(2)}>
          {t(pending ? "cloudSignIn.introForJob" : "cloudSignIn.intro")}
        </p>

        {cloudEngineChoices(engines)}
      </div>
    </main>
  );
}
