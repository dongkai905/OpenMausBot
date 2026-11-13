import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { needsSignIn } from "@/components/EngineSetup";
import { t } from "@/lib/i18n";
import { plainSignIn } from "@/lib/onboarding";
import { api, useStore, type InstanceInfo } from "@/state/store";

export const PILL = "ui-button ui-button-pill ui-button-lg ui-button-primary w-[288px] max-w-full";

type Slot =
  | { kind: "start" }
  | { kind: "busy" };

/** How the first screen's pill connects `instance`: in place for an install the app does itself, else through the
 * Connect an AI dialog. */
export function pillWay(instance: InstanceInfo | undefined): "install" | "dialog" {
  if (!instance || !plainSignIn(instance)) return "dialog";
  return needsSignIn(instance) ? "dialog" : "install";
}

/** One AI connected from the first screen's pill: installed when the app installs it, else set up in the Connect an AI
 * dialog. */
export function useSignInPill(instance: InstanceInfo | undefined) {
  const { refreshInstances } = useStore();
  const [slot, setSlot] = useState<Slot>({ kind: "start" });
  const [error, setError] = useState<string | null>(null);
  const id = instance?.instanceId ?? "";
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const fail = (cause: unknown) => {
    if (!live.current) return;
    setError(cause instanceof Error ? cause.message : String(cause));
    setSlot({ kind: "start" });
  };

  const install = async () => {
    setSlot({ kind: "busy" });
    setError(null);
    try {
      await api(`/api/instances/${encodeURIComponent(id)}/install`, { method: "POST" });
      try { await refreshInstances(); } catch {}
      if (live.current) setSlot({ kind: "start" });
    } catch (cause) { fail(cause); }
  };

  return { slot, error, install };
}

type PillState = ReturnType<typeof useSignInPill>;

/** The first screen's 288×36 slot while an AI is still to connect: its one button. */
export function SignInPill({ pill, instance, waiting, onDialog }: {
  pill: PillState;
  instance: InstanceInfo | undefined;
  /** The test message after a sign-in is under way: the pill waits with it. */
  waiting: boolean;
  onDialog: () => void;
}) {
  const { slot, install } = pill;
  const name = instance?.displayName ?? "";
  if (waiting || slot.kind === "busy") {
    return (
      <button type="button" data-sign-in="waiting" className={PILL} aria-disabled>
        <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin" />{t("onboarding.meet.waiting", { name })}
      </button>
    );
  }
  const way = pillWay(instance);
  const label = way === "install" ? t("onboarding.meet.install", { name })
    : instance ? t("onboarding.meet.connectNamed", { name }) : t("onboarding.meet.connectAi");
  return (
    <button type="button" data-primary="" data-sign-in={way} className={PILL}
      onClick={() => (way === "install" ? void install() : onDialog())}>
      {label}
    </button>
  );
}
