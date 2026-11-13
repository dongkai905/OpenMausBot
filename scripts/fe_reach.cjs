#!/usr/bin/env node
// Frontend reachability graph + vendor-literal scan.
//
// Usage:
//   node scripts/fe_reach.cjs                 # list reachable files
//   node scripts/fe_reach.cjs --scan          # vendor-literal hits in reachable files
//   node scripts/fe_reach.cjs --scan --json   # machine-readable
//   node scripts/fe_reach.cjs --scan --lines  # per-line hits (for surgical edits)
//   node scripts/fe_reach.cjs --entry src/main.tsx --scan
//
// A file is reachable when some reachable file imports it (static import, re-export,
// or a literal dynamic import). A test file is only reachable when a reachable
// file imports it, so the scan reports what the app ships, not what the suite holds.
//
// Vendor literals are the exact engine/provider identifiers of the engines removed
// in step 6 (路线 B 物理剥夺), plus the two generic runtimes removed in step 7.
// Matching is case-sensitive on a word boundary, so `metadata`, `Android` and
// `grokMovePopup` (a path fragment) never count as a vendor mention.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const VENDOR_IDS = [
  "openai-compat", "openaiCompat", "ollama",
  "claudeAgent", "codex", "codexAgent", "antigravityAgent", "grokAgent",
  "opencodeGo", "opencodeAgent", "piAgent", "kimiAgent", "deepseekAgent",
  "geminiAgent", "qwenAgent", "clineAgent", "cursorAgent", "copilotAgent",
  "hermes", "kiro", "commandCode", "mistral", "cerebras", "groq",
  "greenference", "modelgo", "xai", "minimax", "museCode",
];

const CODE_EXT = new Set([".ts", ".tsx"]);
const ALIASES = { "@": path.join(ROOT, "src") };

const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const readFile = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};

const resolveModule = (fromFile, spec) => {
  let base = null;
  if (spec.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    for (const [prefix, target] of Object.entries(ALIASES)) {
      if (spec === prefix || spec.startsWith(`${prefix}/`)) {
        base = path.resolve(target, spec.slice(prefix.length).replace(/^\//, ""));
        break;
      }
    }
    if (base === null) return null;
  }
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.mts`, `${base}.d.ts`,
    path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js"),
  ];
  // A `.js` specifier names the TypeScript source under a bundler/NodeNext resolution.
  if (/\.(js|jsx|mjs)$/.test(base)) {
    const stem = base.replace(/\.(js|jsx|mjs)$/, "");
    candidates.unshift(`${stem}.ts`, `${stem}.tsx`);
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
};

const reachableFrom = (entry) => {
  const seen = new Set();
  const queue = [path.resolve(ROOT, entry)];
  const missing = [];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) { missing.push(path.relative(ROOT, file)); continue; }
    seen.add(file);
    const source = readFile(file);
    if (source === null) continue;
    const specs = new Set();
    for (const re of [IMPORT_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(source)) !== null) specs.add(match[1]);
    }
    for (const spec of specs) {
      const resolved = resolveModule(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
      else if (!resolved && (spec.startsWith(".") || spec.startsWith("@/"))) {
        missing.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
  }
  return { seen, missing };
};

const vendorPattern = (token) =>
  new RegExp(`(?<![A-Za-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "g");

const countVendor = (source) => {
  let total = 0;
  for (const token of VENDOR_IDS) {
    const re = vendorPattern(token);
    let match;
    while ((match = re.exec(source)) !== null) total += 1;
  }
  return total;
};

const main = () => {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const opt = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const entry = opt("--entry", "src/main.tsx");
  const asJson = flag("--json");
  const scan = flag("--scan");
  const perLine = flag("--lines");

  const { seen, missing } = reachableFrom(entry);
  const files = [...seen].map((f) => path.relative(ROOT, f)).sort();

  if (!scan) {
    if (asJson) console.log(JSON.stringify({ entry, files, missing }, null, 2));
    else {
      console.log(`reachable(${entry}) = ${files.length} files`);
      for (const file of files) console.log(file);
      if (missing.length) {
        console.log(`\nunresolved relative imports (${missing.length}):`);
        for (const item of missing) console.log(`  ${item}`);
      }
    }
    return;
  }

  const hits = [];
  const lines = [];
  let total = 0;
  for (const file of files) {
    if (!CODE_EXT.has(path.extname(file))) continue;
    const source = readFile(path.join(ROOT, file));
    if (source === null) continue;
    const fileTotal = countVendor(source);
    if (fileTotal > 0) {
      total += fileTotal;
      hits.push({ file, count: fileTotal });
      if (perLine) {
        const rows = source.split("\n");
        for (let index = 0; index < rows.length; index += 1) {
          const rowCount = countVendor(rows[index]);
          if (rowCount > 0) lines.push({ file, line: index + 1, count: rowCount, text: rows[index].trim().slice(0, 200) });
        }
      }
    }
  }
  hits.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

  if (asJson) {
    console.log(JSON.stringify({ entry, reachableFiles: files.length, vendorFiles: hits.length, vendorOccurrences: total, hits, lines, missing }, null, 2));
    return;
  }
  console.log(`reachable(${entry}) = ${files.length} files`);
  console.log(`vendor literals: ${total} occurrences in ${hits.length} files`);
  for (const hit of hits) console.log(`  ${String(hit.count).padStart(4)}  ${hit.file}`);
  if (perLine) {
    console.log("");
    for (const row of lines) console.log(`${row.file}:${row.line}: ${row.text}`);
  }
  if (missing.length) {
    console.log(`\nunresolved relative imports (${missing.length}):`);
    for (const item of missing) console.log(`  ${item}`);
  }
  if (total > 0) process.exitCode = 1;
};

main();
