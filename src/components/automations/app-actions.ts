// What a person can do to an app-event automation: pause, run now and delete.
import { useState } from "react";

import { appTriggerApi } from "@/lib/app-triggers";
import type { Automation } from "@/lib/automations";

export function useAllAutomationActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** What the error is about, e.g. "toggle:<id>", so it shows beside the thing that was clicked. */
  const [errorFor, setErrorFor] = useState<string | null>(null);
  const attempt = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError("");
    setErrorFor(null);
    try { await work(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setErrorFor(key); }
    finally { setBusy(null); }
  };
  return {
    busy,
    error,
    errorFor,
    setError,
    toggle: (automation: Automation) => attempt(`toggle:${automation.id}`, () => appTriggerApi.update(automation.id, { enabled: !automation.enabled })),
    runNow: (automation: Automation) => attempt(`run:${automation.id}`, () => appTriggerApi.test(automation.id)),
    remove: async (automation: Automation, question: string): Promise<boolean> => {
      if (!window.confirm(question)) return false;
      await attempt(`delete:${automation.id}`, () => appTriggerApi.remove(automation.id));
      return true;
    },
  };
}
