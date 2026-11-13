// Whose About me a preference saved in a turn goes to: the person whose own words began this work, so one line there,
// which every bot reads in their work, replaces telling each bot. On a Team Cloud that is the person the turn acts for
// (acting-person.ts): their own message, or work handed on from it, and nobody's once another person's words joined.
// Elsewhere it is the one person, when their own message began the work. A bot's own work saves no one's preference.
import type { AboutMe } from "../about-me.ts";

type Turn = { threadId: string; generation: string };

/** Where a preference of this turn goes: whose About me it belongs to, and the line to add there. */
export interface PreferenceTarget {
  /** The person's name, when it is known. */
  person?: string;
  save(text: string): void;
}

export interface PersonPreferenceDeps<T extends Turn> {
  /** A Team Cloud, where each person has an About me of their own. */
  team: boolean;
  aboutMe: Pick<AboutMe, "append">;
  /** On a Team Cloud: the person this turn acts for, or null. */
  requester(threadId: string, generation: string): string | null;
  /** Off a team: whether a person's own message began this turn's work, directly or handed on. */
  userStarted(turn: T): boolean;
  personName(person: string): string | undefined;
}

export function createPersonPreference<T extends Turn>(deps: PersonPreferenceDeps<T>) {
  return {
    /** Where `bot`'s turn may save a preference; null when no one person's own words began its work. */
    target(turn: T, _bot: { id: string; name: string }): PreferenceTarget | null {
      if (deps.team) {
        const person = deps.requester(turn.threadId, turn.generation);
        if (!person) return null;
        const name = deps.personName(person);
        return { ...(name ? { person: name } : {}), save: (text) => deps.aboutMe.append(text) };
      }
      return deps.userStarted(turn) ? { save: (text) => deps.aboutMe.append(text) } : null;
    },
  };
}

export type PersonPreference<T extends Turn> = ReturnType<typeof createPersonPreference<T>>;
