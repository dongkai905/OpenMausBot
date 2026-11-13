// Settles a Cloud home's people before anything is served: who the owner is (cloud-owner.ts) and whether anyone but the
// owner has ever used it (cloud-sharing.ts).
import { recordCloudSharing, settleCloudOwnership, type CloudOwnership, type CloudOwnershipOptions } from "./cloud-owner.ts";
import { CLOUD_OUTSIDE_KEY, cloudShared } from "./cloud-sharing.ts";
import type { Message, Store } from "./store.ts";
import type { ThreadStarters } from "./thread-starters.ts";

export interface CloudHomeSettleDeps {
  file: string;
  machineId: string;
  ownerKey: string;
  nobodyKey: string;
  sessions: CloudOwnershipOptions["sessions"];
  personKey: CloudOwnershipOptions["personKey"];
  starters: ThreadStarters;
  store: Pick<Store, "bots" | "tasks" | "groups" | "messagesFor" | "botByThread" | "groupByThread" | "unpinTaskCwd">;
  linePersonKey(line: Message): string | undefined;
  restoredNow?: string;
  lastRestore?: string;
  /** Runs as soon as earlier owners are settled, before anything below asks who the owner is. */
  settled(ownership: CloudOwnership): void;
  /** Proven the owner's, as lending and memory require. */
  provenPerson(person: string | undefined): boolean;
  /** The owner's key, a current admin device's, or a marker that names no person. */
  ownersOrNone(key: string): boolean;
  log(line: string): void;
}

/** Nothing owns a conversation's words but the people who wrote them. */
const NO_WRITERS = { people: () => [] as Iterable<string>, reassign: () => [] as string[] };

export function settleCloudHome(deps: CloudHomeSettleDeps): { solo(): boolean; share(): void } {
  const { store } = deps;
  /** Every conversation once: who wrote and answered. */
  const search = () => {
    const senders = new Set<string>(), answerers = new Set<string>();
    for (const threadId of new Set([...store.bots.flatMap((bot) => store.tasks(bot.id).map((task) => task.threadId)), ...store.groups.map((group) => group.threadId)])) {
      for (const line of store.messagesFor(threadId)) {
        const sender = deps.linePersonKey(line);
        if (sender) senders.add(sender);
        const answerer = line.card?.answeredBy?.kind === "session" ? line.card.answeredBy.person : undefined;
        if (answerer) answerers.add(answerer);
      }
    }
    return { senders, answerers, approvals: [] as Array<[string, string, string]> };
  };
  let searched: ReturnType<typeof search> | undefined;
  const ownership = settleCloudOwnership({
    file: deps.file, machineId: deps.machineId, ownerKey: deps.ownerKey, nobodyKey: deps.nobodyKey, outsideKey: CLOUD_OUTSIDE_KEY,
    sessions: deps.sessions, personKey: deps.personKey, starters: deps.starters, writers: NO_WRITERS,
    routines: { ids: () => [], writer: () => undefined, fingerprinted: () => false, resultsOpener: () => undefined, shape: () => undefined, name: () => {}, pause: () => {} },
    unpin: (threadIds) => { for (const threadId of threadIds) store.unpinTaskCwd(threadId); },
    lines: () => (searched ??= search()),
    ...(deps.restoredNow ? { restoredNow: deps.restoredNow } : {}),
    ...(deps.lastRestore ? { lastRestore: deps.lastRestore } : {}),
    log: deps.log,
  });
  deps.settled(ownership);

  // Once per machine, and after a restore, while the Cloud is not known to be shared.
  const found = ownership.sharedSince === undefined && (!ownership.soloBefore || ownership.restoring) ? (searched ??= search()) : undefined;
  const record = { file: deps.file, machineId: deps.machineId, log: deps.log };
  let solo = !cloudShared({ ownership, ownersOrNone: deps.ownersOrNone, recorded: [...deps.starters.people()],
    ...(found ? { seen: [...found.senders, ...found.answerers] } : {}) });
  if (!solo && ownership.sharedSince === undefined) {
    recordCloudSharing(record, { sharedSince: Date.now() });
    deps.log("cloud home: someone besides the owner has used this Cloud, so what they start runs confined from now on");
  } else if (solo && found) {
    recordCloudSharing(record, { peopleChecked: true });
  }
  return {
    solo: () => solo,
    share: () => {
      if (!solo) return;
      recordCloudSharing(record, { sharedSince: Date.now() });
      solo = false;
    },
  };
}
