// A provider's API base URL, as a request may carry it.
export function normalizeApiUrl(value: string): string {
  const input = value.trim();
  const invalid = () => new Error("Enter an HTTPS API base URL without credentials, a query, or a fragment. HTTP is allowed only for localhost.");
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    // Reject invisible URL characters and ambiguous authority/path separators.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0020\u007f\\?#]/u.test(input) || url.username || url.password ||
    input.slice(input.indexOf("://") + 3).split("/")[0]?.includes("@") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  ) throw invalid();
  return url.href.replace(/\/+$/u, "");
}
