import { useEffect, useRef, type Ref } from "react";
import { Check, FolderOpen, Plug } from "lucide-react";
import { useCloudEngineChoices } from "@/components/CloudEngineSignIn";
import { engineReady } from "@/components/EngineLibrary";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { CARD, CARD_IDLE, CardIcon, Footer, PRIMARY, QUIET, SECONDARY, StepHeading } from "./parts";

/** Connecting an AI: an AI that already works when the step opens (one signed in here) is used as
 * it is and the step finishes itself; otherwise one recommended sign-in, every other way folded under it. */
export function WelcomeEngine({ name, headingRef, onFinish }: { name: string; headingRef: Ref<HTMLHeadingElement>; onFinish: () => void }) {
  const engines = useCloudEngineChoices();
  const own = engines.instances.some((instance) => engineReady(instance));
  const readyOnOpen = useRef(own);
  useEffect(() => {
    if (readyOnOpen.current) onFinish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (readyOnOpen.current) return null;
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="engine" className="flex flex-col">
    <StepHeading headingRef={headingRef} title={t("cloudSetup.engine.title")} sub={t("cloudWelcome.engine.sub", { name })} />
    <Footer className="mt-7">
      {own
        ? <button type="button" className={PRIMARY} onClick={onFinish}>{t("onboarding.continue")}</button>
        : <button type="button" className={QUIET} onClick={onFinish}>{t("cloudIntent.skip")}</button>}
    </Footer>
  </section>;
}

/** "folders": in the app on a Cloud of the person's own, this computer is lent to it by itself; from a browser or on a
 * Team Cloud, the desktop app shares folders through Files. */
export function WelcomeFiles({ name, headingRef, onFinish }: { name: string; headingRef: Ref<HTMLHeadingElement>; onFinish: () => void }) {
  const { state, dispatch } = useStore();
  const lent = Boolean(window.ogb?.cloudPlan) && !state.config?.team;
  const card = (id: string, icon: typeof Plug, title: string, body: string, action?: { label: string; run: () => void }) =>
    <div data-welcome-files={id} className={cn(CARD, CARD_IDLE)}>
      <CardIcon icon={icon} />
      <span className="text-[15px] font-semibold text-ink">{title}</span>
      <span className="text-[13px] leading-relaxed text-ink-secondary">{body}</span>
      {action && <span className="mt-1"><button type="button" className={SECONDARY} onClick={action.run}>{action.label}</button></span>}
    </div>;
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="files" className="flex flex-col gap-5">
    <StepHeading headingRef={headingRef} title={t("cloudWelcome.files.title")} aside={t("cloudWelcome.files.optional")} sub={t("cloudWelcome.files.sub")} />
    <div className="grid gap-3 @lg/step:grid-cols-2">
      {card("folders", FolderOpen, t("cloudWelcome.files.folders"), t(lent ? "cloudWelcome.files.foldersLent" : "cloudWelcome.files.foldersDesktop", { name }))}
      {card("apps", Plug, t("cloudWelcome.files.apps"), t("cloudWelcome.files.appsHint"),
        { label: t("cloudWelcome.files.appsAction"), run: () => dispatch({ type: "togglePlugins", open: true, surface: "apps" }) })}
    </div>
    <Footer>
      <button type="button" className={PRIMARY} onClick={onFinish}>{t("cloudWelcome.files.finish")}</button>
      <button type="button" className={QUIET} onClick={onFinish}>{t("cloudIntent.skip")}</button>
    </Footer>
  </section>;
}

export function WelcomeDone({ name, bot, team = false, headingRef, onSayHi, onJob, invite = null }: {
  name: string; bot: Bot | null; headingRef: Ref<HTMLHeadingElement>; onSayHi: () => void; onJob: () => void;
  /** A Team Cloud: its first bot is named, never called anyone's Chief of Staff. */
  team?: boolean;
  /** The team's People page on MausBot Cloud, for its Owner: the last step is bringing people in. */
  invite?: string | null;
}) {
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="done" className="flex flex-col items-start gap-4">
    <span aria-hidden="true" className="check-in flex size-[42px] items-center justify-center rounded-full bg-success">
      <Check size={22} strokeWidth={2.5} />
    </span>
    <StepHeading headingRef={headingRef} title={t("cloudWelcome.done.title", { name })} sub={t("cloudWelcome.done.body")} />
    {invite && <div data-welcome-invite className="flex w-full max-w-[520px] flex-col items-start gap-2 rounded-2xl border border-hairline/50 bg-card/50 p-4">
      <p className="text-[14px] font-medium text-ink">{t("cloudWelcome.invite.title", { name })}</p>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudWelcome.invite.body", { name })}</p>
      <a href={invite} target="_blank" rel="noreferrer" className={SECONDARY}>{t("cloudWelcome.invite.action")}</a>
    </div>}
    <Footer>
      <button type="button" className={PRIMARY} onClick={onSayHi}>
        {bot && (team || !bot.chiefOfStaff) ? t("cloudWelcome.done.bot", { name: bot.name }) : t("cloudWelcome.done.chief")}
      </button>
      {bot && <button type="button" className={SECONDARY} onClick={onJob}>{t("cloudSetup.job.action")}</button>}
    </Footer>
  </section>;
}
