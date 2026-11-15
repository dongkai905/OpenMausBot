import type { CloudBackend } from "../../shared/wire";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

/** The only cloud backend left: the person's own VPS. The control keeps its
 * shape (two other components render it) but offers one option, so it names
 * the provider instead of choosing between two. */
export function CloudBackendPicker({
  value,
  compact = false,
  onChange,
}: {
  value: CloudBackend;
  compact?: boolean;
  onChange: (backend: CloudBackend) => void;
}) {
  const { state } = useStore();
  if (state.config?.cloudHome) return null;
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[12px] font-medium text-ink">{compact ? t("botAccess.cloud.provider") : t("botAccess.cloud.backend")}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {compact ? t("botAccess.cloud.vpsDescription") : t("botAccess.cloud.vpsAutoDescription")}
      </div>
      <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
        <button
          type="button"
          aria-pressed={value === "vps"}
          onClick={() => onChange("vps")}
          className="flex-1 bg-raised py-1.5 text-[12px] text-ink"
        >
          {t("botAccess.cloud.selfHostedVps")}
        </button>
      </div>
    </div>
  );
}
