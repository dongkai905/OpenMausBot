#!/usr/bin/env node
// Change-set guard for the vendor-removal work.
//
// Usage:
//   node scripts/guard.cjs                  # check the working tree against the base commit
//   node scripts/guard.cjs --base <sha>     # check against a specific base
//   node scripts/guard.cjs --json           # machine-readable
//
// Every rule here is a regression this repository has already paid for:
//   - the reserved paths are the ACP tee artery and the approval / question cards;
//   - a save-list that loses a product setting wipes it from every user's config;
//   - the notice catalog and the locale file must stay the same set;
//   - a removed engine must not come back through a stale import.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

const VENDOR_IDS = [
  "openai-compat", "openaiCompat", "ollama",
  "claudeAgent", "codex", "codexAgent", "antigravityAgent", "grokAgent",
  "opencodeGo", "opencodeAgent", "piAgent", "kimiAgent", "deepseekAgent",
  "geminiAgent", "qwenAgent", "clineAgent", "cursorAgent", "copilotAgent",
  "hermes", "kiro", "commandCode", "mistral", "cerebras", "groq",
  "greenference", "modelgo", "xai", "minimax", "museCode",
];

/** Files that carry the surviving engine's message tee, its approval card and its question card. */
const RESERVED = [
  "server/drivers/native.ts",
  "server/drivers/acp/custom.ts",
  "server/drivers/acp/core.ts",
  "server/drivers/acp/question-requests.ts",
  "server/drivers/acp/background-text.ts",
  "server/drivers/acp/tool-log.ts",
];

/** The scanner and the guard carry the vendor list themselves. */
const SELF = new Set(["scripts/fe_reach.cjs", "scripts/guard.cjs", "scripts/calibrate.cjs"]);

/** Config segments that are product settings. A save-list that drops one wipes it for every user. */
const PRODUCT_SAVE_SEGMENTS = [
  "postiz", "tts", "decider", "imageGen", "live", "profile",
  "rooms", "mcp", "threads", "context", "memory", "localVm", "features", "budgets",
  "billing", "decisions", "loopGuard", "onboarding", "browserEngine", "newBots",
  "safetyFloor",
];

const results = [];
const fail = (id, title, detail) => results.push({ id, title, ok: false, detail });
const pass = (id, title, detail) => results.push({ id, title, ok: true, detail });

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const readText = (relative) => {
  try { return fs.readFileSync(path.join(ROOT, relative), "utf8"); } catch { return null; }
};

const resolveBase = (argv) => {
  const at = argv.indexOf("--base");
  if (at !== -1 && argv[at + 1]) return argv[at + 1];
  const roots = git("rev-list", "--max-parents=0", "HEAD").trim().split("\n");
  return roots[roots.length - 1];
};

const changedFiles = (base) =>
  git("diff", "--name-status", base).trim().split("\n").filter(Boolean).map((row) => {
    const parts = row.split("\t");
    return { status: parts[0], file: parts[parts.length - 1] };
  });

// G1 — reserved paths stay untouched, except where the change set only takes
// the removed vendor out of them. A reserved file may lose a line that names
// the removed subsystem (the driver's dead capability flag); it may not gain
// a code line, and it may not lose anything else. A comment may be reworded:
// the gate protects behaviour, not prose.
const g1 = (base) => {
  const touched = changedFiles(base).filter(({ file }) => RESERVED.includes(file));
  const offenders = [];
  const isComment = (text) => /^\s*(\/\/|\/\*|\*|\*\/)/.test(text);
  for (const { file } of touched) {
    const patch = git("diff", base, "--", file);
    const added = [];
    const removed = [];
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added.push(line.slice(1));
      else if (line.startsWith("-")) removed.push(line.slice(1));
    }
    for (const text of added) {
      if (isComment(text)) continue;
      offenders.push(`${file}: added code line: ${text.trim().slice(0, 80)}`);
    }
    for (const text of removed) {
      if (isComment(text)) continue;
      if (!/composio/i.test(text)) offenders.push(`${file}: removed line is not the vendor's: ${text.trim().slice(0, 80)}`);
    }
  }
  if (offenders.length) fail("G1", "reserved paths untouched", offenders.slice(0, 10).join("\n"));
  else if (touched.length) pass("G1", "reserved paths untouched", `${RESERVED.length} reserved files, ${touched.map((t) => t.file).join(", ")}: only the vendor's line removed`);
  else pass("G1", "reserved paths untouched", `${RESERVED.length} reserved files, none modified`);
};

// G2 — the change set never introduces a vendor identifier into production code.
// Judged per file against the base: a vendor the file already named is not
// introduced by this change set, whatever the diff looks like (a moved line, a
// rewritten fixture). A vendor that appears in a file which never mentioned it
// before is introduced, and that is what fails.
const g2 = (base) => {
  const offenders = [];
  const fixtures = [];
  const pattern = `(?<![A-Za-z0-9_-])(${VENDOR_IDS.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_-])`;
  // The base tree, in one pass: which file already named which vendor.
  const before = new Map(); // file -> Set(id)
  let grep = "";
  try { grep = git("grep", "-n", "-P", pattern, base, "--"); } catch { grep = ""; }
  for (const line of grep.split("\n")) {
    if (!line.startsWith(`${base}:`)) continue;
    const rest = line.slice(base.length + 1);
    const at = rest.indexOf(":");
    if (at === -1) continue;
    const name = rest.slice(0, at);
    const content = rest.slice(at + 1);
    const ids = before.get(name) || new Set();
    for (const id of VENDOR_IDS) {
      const re = new RegExp(`(?<![A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`);
      if (re.test(content)) ids.add(id);
    }
    before.set(name, ids);
  }
  const files = new Set();
  for (const line of git("diff", base, "--name-only").split("\n")) {
    const name = line.trim();
    if (name && !SELF.has(name)) files.add(name);
  }
  for (const name of files) {
    const after = readText(name);
    if (after === null) continue; // deleted in this change set
    const isTest = /\.(test|spec)\.[tj]sx?$/.test(name) || /\.(test|spec)\.mjs$/.test(name);
    const known = before.get(name) || new Set();
    for (const id of VENDOR_IDS) {
      const re = new RegExp(`(?<![A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`);
      if (!re.test(after)) continue;
      if (known.has(id)) continue;
      const row = `${name}: ${id} :: introduced by this change set`;
      // A test may still name a removed engine in a saved-config fixture: an old
      // config must still load. Production code may not.
      if (isTest) fixtures.push(row); else offenders.push(row);
    }
  }
  if (offenders.length) fail("G2", "no vendor identifier added to production code", offenders.slice(0, 20).join("\n"));
  else pass("G2", "no vendor identifier added to production code", fixtures.length ? `clean (${fixtures.length} legacy-config fixture lines in tests)` : "clean");
};

// G3 — the engine registry holds exactly the surviving engine.
const g3 = () => {
  const source = readText("server/drivers/builtIn.ts");
  if (!source) { fail("G3", "engine registry holds one engine", "server/drivers/builtIn.ts is missing"); return; }
  const drivers = [...source.matchAll(/^\s*([A-Za-z0-9_]+Driver),?\s*$/gm)].map((m) => m[1]);
  if (drivers.length === 1 && drivers[0] === "CustomAcpDriver") pass("G3", "engine registry holds one engine", "CustomAcpDriver");
  else fail("G3", "engine registry holds one engine", `found: ${drivers.join(", ") || "(none)"}`);
};

// G4 — the config save-list still carries every product segment.
const g4 = () => {
  const source = readText("server/config.ts");
  if (!source) { fail("G4", "config save-list keeps every product setting", "server/config.ts is missing"); return; }
  const match = source.match(/for \(const key of \[([\s\S]*?)\] as const\)/);
  if (!match) { fail("G4", "config save-list keeps every product setting", "no save-list found in server/config.ts"); return; }
  const keys = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const missing = PRODUCT_SAVE_SEGMENTS.filter((segment) => !keys.includes(segment));
  if (missing.length) fail("G4", "config save-list keeps every product setting", `missing: ${missing.join(", ")}`);
  else pass("G4", "config save-list keeps every product setting", `${PRODUCT_SAVE_SEGMENTS.length} product segments present (${keys.length} total)`);
};

// G5 — the notice catalog and the locale file carry the same set.
const g5 = () => {
  const notices = readText("server/chat-notices.ts");
  const driverNotices = readText("server/drivers/driver-notices.ts");
  let locale = null;
  try { locale = JSON.parse(readText("src/locales/en.json") || "{}"); } catch { locale = null; }
  if (!notices || !driverNotices || !locale) { fail("G5", "notice catalog matches the locale", "a source file is missing or unreadable"); return; }
  const collect = (source) => [...source.matchAll(/"(chat\.notice\.[^"]+)":/g)].map((m) => m[1]);
  const catalog = new Set([...collect(notices), ...collect(driverNotices)]);
  const clientLabels = new Set(["chat.notice.signIn", "chat.notice.signInHint"]);
  const expected = new Set(Object.keys(locale).filter((key) => key.startsWith("chat.notice.") && !clientLabels.has(key)));
  const missing = [...expected].filter((key) => !catalog.has(key));
  const extra = [...catalog].filter((key) => !expected.has(key));
  if (missing.length || extra.length) {
    fail("G5", "notice catalog matches the locale", `missing: ${missing.join(", ") || "(none)"} | extra: ${extra.join(", ") || "(none)"}`);
  } else pass("G5", "notice catalog matches the locale", `${catalog.size} notices`);
};

// G6 — the frontend reachability graph carries no vendor literal.
const g6 = () => {
  let output = "";
  try {
    output = execFileSync("node", [path.join(__dirname, "fe_reach.cjs"), "--scan", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    output = error.stdout || "";
  }
  let parsed;
  try { parsed = JSON.parse(output); } catch { fail("G6", "frontend reachable graph has no vendor literal", "the scan produced no readable result"); return; }
  if (parsed.vendorOccurrences === 0) pass("G6", "frontend reachable graph has no vendor literal", "0 occurrences");
  else fail("G6", "frontend reachable graph has no vendor literal", `${parsed.vendorOccurrences} occurrences in ${parsed.vendorFiles} files`);
};

// G7 — no server source imports the removed runtime.
const g7 = () => {
  const removed = ["openai-compat.ts", "ollama.ts", "ollama-context.ts", "openai-chat.ts", "openai-responses.ts", "openrouter-free.ts"];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[tj]sx?$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, "utf8");
      for (const module of removed) {
        if (source.includes(`/${module}"`) || source.includes(`/${module}'`)) offenders.push(`${path.relative(ROOT, full)} imports ${module}`);
      }
    }
  };
  walk(path.join(ROOT, "server"));
  if (offenders.length) fail("G7", "no server source imports the removed runtime", offenders.join("\n"));
  else pass("G7", "no server source imports the removed runtime", "clean");
};

// G8 — every relative import in the changed sources resolves.
const g8 = () => {
  const dead = [];
  const check = (relative) => {
    const source = readText(relative);
    if (source === null) return;
    const dir = path.dirname(path.join(ROOT, relative));
    const specs = new Set();
    // Anchored at the line start: an import statement, not a string inside a fixture.
    const patterns = [
      /^\s*import\s+(?:[^\n]*?\s+from\s+)?["']([^"']+)["']/gm,
      /^\s*export\s+(?:[^\n]*?\s+from\s+)?["']([^"']+)["']/gm,
      /^\s*import\s*\(\s*["']([^"']+)["']\s*\)/gm,
    ];
    for (const re of patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(source)) !== null) specs.add(match[1]);
    }
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      const base = path.resolve(dir, spec);
      const stem = base.replace(/\.(js|jsx|mjs)$/, "");
      const candidates = [
        base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}.js`, `${base}.mjs`,
        `${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`,
        path.join(base, "index.ts"), path.join(base, "index.tsx"),
      ];
      if (!candidates.some((candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } })) {
        dead.push(`${relative} -> ${spec}`);
      }
    }
  };
  for (const root of ["src", "server", "shared"]) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue;
        check(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, root));
  }
  if (dead.length) fail("G8", "no dead relative import", dead.slice(0, 25).join("\n") + (dead.length > 25 ? `\n… ${dead.length} total` : ""));
  else pass("G8", "no dead relative import", "clean");
};

// G9 — the working tree carries nothing the index does not.
// The PR #7 push dropped two files because the payload came from
// `git diff HEAD` (tracked files only) while the gates had read the working
// tree. A file that exists on disk but not in the index is exactly the kind of
// source that vanishes on the way to the remote. This gate is the guard-side
// mirror of LOCK 1 in scripts/gitdata_push.py.
const g9 = () => {
  let raw = "";
  try {
    raw = git("status", "--porcelain", "--untracked-files=all");
  } catch (error) {
    fail("G9", "no untracked file in the change set", `git status failed: ${error.message}`);
    return;
  }
  const untracked = [];
  const unstaged = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === "??") untracked.push(file);
    else if (code[1] !== " ") unstaged.push(`${file} (${code.trim()})`);
  }
  if (untracked.length || unstaged.length) {
    const detail = [];
    if (untracked.length) detail.push(`untracked: ${untracked.slice(0, 12).join(", ")}${untracked.length > 12 ? ` … +${untracked.length - 12}` : ""}`);
    if (unstaged.length) detail.push(`unstaged: ${unstaged.slice(0, 12).join(", ")}${unstaged.length > 12 ? ` … +${unstaged.length - 12}` : ""}`);
    fail("G9", "no untracked file in the change set", detail.join(" | ") || "clean");
  } else {
    pass("G9", "no untracked file in the change set", "working tree and index agree");
  }
};

// G10 — the push evidence reconciles with the local tree.
// scripts/gitdata_push.py records what it pushed; this gate re-derives the
// local tree and refuses a stale or mismatching receipt.
const g10 = () => {
  const required = process.argv.includes("--require-push-evidence");
  let evidence = null;
  try {
    evidence = JSON.parse(fs.readFileSync(path.join(ROOT, ".git", "push-evidence.json"), "utf8"));
  } catch { evidence = null; }
  if (!evidence) {
    const detail = "no push evidence yet — run scripts/gitdata_push.py first";
    if (required) fail("G10", "push evidence reconciles with the local tree", detail);
    else pass("G10", "push evidence reconciles with the local tree", `${detail} (not required)`);
    return;
  }
  let localTree = "";
  try { localTree = git("write-tree").trim(); } catch (error) {
    fail("G10", "push evidence reconciles with the local tree", `git write-tree failed: ${error.message}`);
    return;
  }
  const problems = [];
  if (evidence.localTreeSha !== localTree) problems.push(`local tree moved: evidence ${evidence.localTreeSha} vs now ${localTree}`);
  if (evidence.remoteTreeSha !== evidence.localTreeSha) problems.push(`remote tree ${evidence.remoteTreeSha} != local tree ${evidence.localTreeSha}`);
  if (problems.length) fail("G10", "push evidence reconciles with the local tree", problems.join(" | "));
  else pass("G10", "push evidence reconciles with the local tree", `${evidence.remoteTreeSha} (${evidence.fileCount ?? "?"} files, branch ${evidence.branch ?? "?"})`);
};

const main = () => {
  const argv = process.argv.slice(2);
  const base = resolveBase(argv);
  g1(base); g2(base); g3(); g4(); g5(); g6(); g7(); g8(); g9(); g10();
  const failed = results.filter((r) => !r.ok);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ base, results, ok: failed.length === 0 }, null, 2));
  } else {
    for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.id}  ${result.title}\n      ${result.detail}`);
    console.log(`\n${results.length - failed.length}/${results.length} guards passed (base ${base.slice(0, 9)})`);
  }
  if (failed.length) process.exitCode = 1;
};

main();
