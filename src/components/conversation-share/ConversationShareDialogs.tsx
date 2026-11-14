import { useEffect, useId, useRef, useState } from "react";
import { UserPlus, Users } from "lucide-react";

import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { teamChats } from "@/state/team-chats";
import { setTeamSide } from "@/state/team-side";
import { ConfirmDialog } from "../ConfirmDialog";
import { Select } from "../Select";
import { UndoToast, useTeamName } from "../bot-access/ShareBotButton";
import {
  closeConversationDialog, shareConversation, sharingOf, useConversationDialog,
  type ConversationDialog, type Sharing,
} from "./conversation-share";

/** The confirm step of sharing a conversation, wherever it was chosen. */
export function ConversationShareDialogs() {
  const dialog = useConversationDialog();
  const teamName = useTeamName();
  const { state } = useStore();
  const bot = dialog ? state.bots.find((candidate) => candidate.id === dialog.botId) : undefined;
  if (!dialog || !teamName || !bot) return null;
  const key = `${dialog.kind}:${dialog.threadId}`;
  return <ShareConversation key={key} dialog={dialog} botName={bot.name} teamName={teamName} />;
}

function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError("");
    void work().then(closeConversationDialog, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    });
  };
  return { pending, error, run };
}

function ShareConversation({ dialog, botName, teamName }: { dialog: ConversationDialog & { kind: "team" | "person" }; botName: string; teamName: string }) {
  const { pending, error, run } = useSubmit();
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [email, setEmail] = useState("");
  const fieldId = useId();
  useEffect(() => {
    if (dialog.kind !== "person") return;
    let live = true;
    void sharingOf(dialog).then((answer) => {
      if (!live) return;
      setSharing(answer);
      setEmail(answer.people[0]?.email ?? "");
    }, () => { if (live) setSharing({ shared: null, people: [] }); });
    return () => { live = false; };
  }, [dialog.kind, dialog.botId, dialog.threadId]);
  const share = (to: "team" | { email: string }) => run(async () => {
    await shareConversation(dialog, to);
    setTeamSide("team", teamChats());
  });
  const failed = error && <span role="alert" className="mt-3 block text-danger">{error}</span>;

  if (dialog.kind === "team") {
    return (
      <ConfirmDialog open tone="neutral" icon={<Users size={18} />} title={t("conversationShare.teamTitle")}
        body={<span data-conversation-share="team">{t("conversationShare.teamBody", { team: teamName, bot: botName })}{failed}</span>}
        confirmLabel={t("conversationShare.withTeam")} pending={pending} onCancel={closeConversationDialog} onConfirm={() => share("team")} />
    );
  }
  const person = sharing?.people.find((candidate) => candidate.email === email) ?? null;
  return (
    <ConfirmDialog open tone="neutral" icon={<UserPlus size={18} />} title={t("conversationShare.personTitle")}
      body={<span data-conversation-share="person">
        {sharing === null ? t("common.checking") : sharing.people.length === 0 ? t("conversationShare.nobody", { bot: botName }) : <>
          <label htmlFor={fieldId} className="block text-[12px] font-medium text-ink">{t("conversationShare.personField")}</label>
          <Select id={fieldId} className="mt-1 w-full" value={email} disabled={pending} onChange={(event) => setEmail(event.target.value)}>
            {sharing.people.map((candidate) => <option key={candidate.email} value={candidate.email}>{candidate.name}</option>)}
          </Select>
          {person && <span className="mt-3 block">{t("conversationShare.personBody", { name: person.name, bot: botName })}</span>}
        </>}
        {failed}
      </span>}
      confirmLabel={person ? t("conversationShare.personConfirm", { name: person.name }) : t("conversationShare.withPerson")}
      confirmDisabled={!person} pending={pending} onCancel={closeConversationDialog} onConfirm={() => { if (person) share({ email: person.email }); }} />
  );
}
