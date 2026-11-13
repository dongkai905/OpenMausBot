import { describe, expect, it } from "vitest";
import { normalizeApiUrl } from "./cli-api-setup.ts";

const key = "sk-setup-fixture-secret";
const base = "https://provider.example/v1";

describe("a provider's API base URL", () => {
  it("normalizes HTTPS prefixes and permits only loopback HTTP", () => {
    expect(normalizeApiUrl("  https://PROVIDER.example:443/v1///  ")).toBe(base);
    expect(normalizeApiUrl("https://provider.example")).toBe("https://provider.example");
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(normalizeApiUrl(`http://${host}:1234/v1/`)).toBe(`http://${host}:1234/v1`);
  });

  it.each([
    "not a URL", "file:///tmp/provider", "ftp://provider.example/v1", "http://provider.example/v1",
    "http://localhost.example/v1", "http://192.168.1.1/v1", "http://0.0.0.0/v1",
    `https://user:${key}@provider.example/v1`, "https://@provider.example/v1",
    `https://provider.example/v1?key=${key}`, "https://provider.example/v1?", "https://provider.example/v1#",
    "https://provider.example/v1#fragment", "https://provider.example\\v1", "https://provi\nder.example/v1",
  ])("rejects an unsafe URL without echoing it: case %#", (url) => {
    expect(() => normalizeApiUrl(url)).toThrow(/HTTPS API base URL/u);
    try { normalizeApiUrl(url); } catch (error) { expect(String(error)).not.toContain(key); }
  });
});
