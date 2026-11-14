// About me, the profile every bot reads: the lines a person wrote about themselves, and the lines they ask a bot to forget.
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** A line is judged by its fact, never by who wrote it. */
export function withoutMentionedLines(aboutMe: string, mentions: (text: string) => boolean): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept = aboutMe.split("\n").filter((line) => {
    const fact = line.replace(BULLET, "").trim();
    if (!fact || !mentions(fact)) return true;
    removed.push(fact);
    return false;
  });
  return { text: kept.join("\n"), removed };
}

export interface AboutMeDeps {
  read(): string;
  write(text: string): void;
  /** Clients are told after the About me changed, so a reload sees it. */
  changed(): void;
}

export type AboutMe = ReturnType<typeof createAboutMe>;

export function createAboutMe(deps: AboutMeDeps) {
  /** One line of the person's own, as it reads in the file. */
  const line = (text: string): string => `- ${text.replace(/\s+/g, " ").trim()}`;
  return {
    /** A line of the person's own, added to their About me. */
    append(text: string): void {
      const current = deps.read();
      const body = current.trim() ? `${current.replace(/\n*$/, "\n")}${line(text)}\n` : `${line(text)}\n`;
      deps.write(body);
      deps.changed();
    },
    /** The facts removed from the About me the person asked a bot to forget. */
    forget(mentions: (text: string) => boolean): string[] {
      const kept = withoutMentionedLines(deps.read(), mentions);
      if (!kept.removed.length) return [];
      deps.write(kept.text);
      deps.changed();
      return kept.removed;
    },
  };
}
