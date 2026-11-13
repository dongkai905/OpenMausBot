// Both routes take the section as a query parameter, required even for General ("").
import { z } from "zod";

import { SECTION_CONTEXT_MAX_BYTES, readSectionContext, sectionContextKey, sectionContextLabel, writeSectionContext } from "../section-context.ts";
import { sectionKey, type Store } from "../store.ts";
import { userError } from "../user-errors.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamContextRouteDeps {
  store: Pick<Store, "sections" | "bots" | "groups">;
}

export function createTeamContextRoutes(deps: TeamContextRouteDeps): RouteHandler {
  const { store } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === "/api/section-context" && (method === "GET" || method === "PUT")) {
      if (!url.searchParams.has("section")) return json(res, 400, { error: "section is required" });
      const requested = url.searchParams.get("section") ?? "";
      const section = sectionContextKey(requested);
      if (section.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
      const exists =
        section === "" ||
        store.sections.includes(section) ||
        store.bots.some((bot) => !bot.hidden && sectionKey(bot.section) === section) ||
        store.groups.some((group) => sectionKey(group.section) === section);
      if (!exists) return json(res, 404, userError("serverError.department.missing"));

      if (method === "GET") {
        const context = readSectionContext(section);
        return json(res, 200, {
          section,
          label: sectionContextLabel(section),
          text: context?.text ?? "",
          updatedAt: context?.updatedAt ?? null,
          maxBytes: SECTION_CONTEXT_MAX_BYTES,
        });
      }

      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      if (Buffer.byteLength(parsed.data.text, "utf8") > SECTION_CONTEXT_MAX_BYTES) {
        return json(res, 400, { error: `section context is capped at ${SECTION_CONTEXT_MAX_BYTES / 1000}KB` });
      }
      const context = writeSectionContext(section, parsed.data.text);
      return json(res, 200, {
        ok: true,
        section,
        label: sectionContextLabel(section),
        text: context?.text ?? "",
        updatedAt: context?.updatedAt ?? null,
        maxBytes: SECTION_CONTEXT_MAX_BYTES,
      });
    }
    return PASS;
  };
}
