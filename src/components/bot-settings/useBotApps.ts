import { useEffect, useState } from "react";

import { botAppScope } from "@/lib/bot-apps";
import { t } from "@/lib/i18n";
import { api, type Bot } from "@/state/store";
import type { ConnectorScope } from "../../../shared/connector-scopes";
import { EMAIL_SLUG, type EmailStatus } from "../../../shared/email";
import type { ToolkitCard } from "../ServiceIcon";

export interface BotApp {
  slug: string;
  label: string;
  blurb: string;
  card: Pick<ToolkitCard, "logo" | "domain" | "label">;
  scope: ConnectorScope | null;
}

export interface BotApps {
  phase: "loading" | "ready" | "unknown";
  apps: BotApp[];
  connectedSlugs: string[];
}

/** Email is connected natively, so it brings its own card. */
export function emailAppCard(): Pick<ToolkitCard, "logo" | "domain" | "label"> & { blurb: string } {
  return { logo: null, domain: null, label: t("email.title"), blurb: t("email.description") };
}

/**
 * The apps this bot may use, as the workspace has them. `email` is null while the mailbox is still being read, and
 * `unknown` says the read failed: nothing connected is better said than pretended.
 */
export function botAppsFrom(
  bot: Pick<Bot, "apps" | "connectorScopes" | "connectorTools">,
  email: EmailStatus | null,
  unknown = false,
): BotApps {
  if (unknown) return { phase: "unknown", apps: [], connectedSlugs: [] };
  if (!email) return { phase: "loading", apps: [], connectedSlugs: [] };
  if (email.state !== "connected") return { phase: "ready", apps: [], connectedSlugs: [] };
  const { blurb, ...card } = emailAppCard();
  return {
    phase: "ready",
    apps: [{ slug: EMAIL_SLUG, label: card.label, blurb, card, scope: botAppScope(bot, EMAIL_SLUG) }],
    connectedSlugs: [EMAIL_SLUG],
  };
}

export function useBotApps(bot: Bot): BotApps {
  const [email, setEmail] = useState<EmailStatus | null>(null);
  const [unknown, setUnknown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api("/api/email")
      .then((result: EmailStatus) => { if (!cancelled) setEmail(result); })
      .catch(() => { if (!cancelled) setUnknown(true); });
    return () => {
      cancelled = true;
    };
  }, []);

  return botAppsFrom(bot, email, unknown);
}
