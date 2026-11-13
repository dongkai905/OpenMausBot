export interface BotOverview {
  who: { name: string; title: string; blurb: string; soulLead: string };
  does: string[];
  managedSections?: string[];
  reaches: string[];
  wont: string[];
  recent: Array<{ at: number; summary: string }>;
  setup?: SetupStep[];
}

export interface SetupStep {
  id: "identity" | "soul" | "folder" | "apps";
  label: string;
  done: boolean;
  section?: "identity" | "soul" | "access";
}
