#!/usr/bin/env node
// A sharded type check for machines that cannot hold the whole program in memory.
//
//   node scripts/tsc-shard.cjs [--root .] [--tsconfig tsconfig.server.json]
//                               [--max-files 60] [--heap 1400] [--out report.json]
//
// A whole-repo `tsc -p tsconfig.server.json` needs more memory than a small container has: the program is thousands of
// files, and V8 dies before it finishes (the upstream CI notes the same thing for its own runners). So the file set is
// split into shards by directory, each shard gets a tsconfig listing its files, and every shard runs in its own tsc
// process. The heap of one process is then bounded by the size of one shard, not of the repository.
//
// Three rules this tool keeps, each one learned from a wrong result:
//   - The tsc entry point is resolved with `require.resolve("typescript/bin/tsc")`. `node_modules/.bin/tsc` is a shell
//     wrapper, and running it with node exits on a syntax error: the shards then "pass" without checking anything.
//   - A shard's tsconfig is written in the repository root, because `files` is read relative to the config's own
//     directory. In a subdirectory every path resolves wrong and tsc reports the file as missing.
//   - A shard killed by a signal reported zero errors. Zero errors from a killed shard is a lower bound, not a result,
//     so it is counted separately and the run says so.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = {
    root: process.cwd(),
    tsconfig: "tsconfig.server.json",
    maxFiles: 60,
    heap: 1400,
    out: null,
    only: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") out.root = path.resolve(argv[++i]);
    else if (a === "--tsconfig") out.tsconfig = argv[++i];
    else if (a === "--max-files") out.maxFiles = Number(argv[++i]);
    else if (a === "--heap") out.heap = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--only") out.only = argv[++i].split(",");
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const ROOT = args.root;
const TS = require.resolve("typescript", { paths: [path.join(ROOT, "node_modules")] });
const ts = require(TS);
const TSC = require.resolve("typescript/bin/tsc", { paths: [path.join(ROOT, "node_modules")] });

const cfgPath = path.join(ROOT, args.tsconfig);
const cfgJson = ts.parseConfigFileTextToJson(cfgPath, fs.readFileSync(cfgPath, "utf8"));
if (cfgJson.error) {
  console.error("FATAL: cannot read the tsconfig:", ts.flattenDiagnosticMessageText(cfgJson.error.messageText, " "));
  process.exit(2);
}
const parsed = ts.parseJsonConfigFileContent(cfgJson.config, ts.sys, ROOT, undefined, cfgPath);
const allFiles = parsed.fileNames.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));

let files = allFiles;
if (args.only) {
  const want = new Set(args.only.map((p) => path.resolve(ROOT, p)));
  files = allFiles.filter((f) => want.has(f));
}
console.log(`[tsc-shard] root=${ROOT}`);
console.log(`[tsc-shard] tsconfig=${args.tsconfig} files_in_config=${allFiles.length} files_to_check=${files.length}`);
console.log(`[tsc-shard] tsc=${TSC}`);

// Files of one directory stay in one shard as far as possible: a file and the ones it imports are then checked together,
// which keeps a shard's program small instead of dragging a whole tree into every shard.
function clusterKey(file) {
  const parts = path.relative(ROOT, file).split(path.sep);
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || ".";
}
const clusters = new Map();
for (const f of files) {
  const key = clusterKey(f);
  if (!clusters.has(key)) clusters.set(key, []);
  clusters.get(key).push(f);
}
const shards = [];
for (const list of [...clusters.values()].sort((a, b) => b.length - a.length)) {
  for (let at = 0; at < list.length; at += args.maxFiles) shards.push(list.slice(at, at + args.maxFiles));
}
console.log(`[tsc-shard] clusters=${clusters.size} shards=${shards.length} max_files_per_shard=${args.maxFiles}`);

const shardConfigs = [];
const perCode = new Map();
const perFile = new Map();
const results = [];
let totalErrors = 0;
let killedShards = 0;

const errorRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;
const globalRe = /^error\s+(TS\d+):\s+(.*)$/;

shards.forEach((shardFiles, index) => {
  const name = `tsconfig.shard-${String(index).padStart(3, "0")}.json`;
  shardConfigs.push(name);
  fs.writeFileSync(path.join(ROOT, name), JSON.stringify({
    compilerOptions: cfgJson.config.compilerOptions ?? {},
    files: shardFiles.map((f) => path.relative(ROOT, f)),
  }, null, 2));

  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${args.heap}`, TSC, "-p", name, "--noEmit", "--pretty", "false"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );

  const killed = result.signal != null || result.status === 137 || result.status === 134;
  let errors = 0;
  const globalErrors = [];
  for (const line of `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n")) {
    const trimmed = line.trim();
    const match = errorRe.exec(trimmed);
    if (!match) {
      const whole = globalRe.exec(trimmed);
      if (whole) {
        errors += 1;
        perCode.set(whole[1], (perCode.get(whole[1]) ?? 0) + 1);
        globalErrors.push(trimmed);
      }
      continue;
    }
    errors += 1;
    const file = path.relative(ROOT, path.resolve(ROOT, match[1]));
    perCode.set(match[4], (perCode.get(match[4]) ?? 0) + 1);
    if (!perFile.has(file)) perFile.set(file, { count: 0, codes: {} });
    const record = perFile.get(file);
    record.count += 1;
    record.codes[match[4]] = (record.codes[match[4]] ?? 0) + 1;
  }
  if (killed) killedShards += 1;
  totalErrors += errors;

  const status = result.signal ? `KILLED(sig=${result.signal})` : `EXIT${result.status}`;
  console.log(`shard ${String(index).padStart(2, " ")}/${shards.length} files=${shardFiles.length} ${status} errors=${errors}`
    + (killed ? "  <- zero errors here is a lower bound, not a result" : ""));
  for (const line of globalErrors.slice(0, 5)) console.log(`   ${line}`);
  results.push({ index, files: shardFiles.length, status: result.status, signal: result.signal, killed, errors, globalErrors });
});

for (const name of shardConfigs) {
  try { fs.unlinkSync(path.join(ROOT, name)); } catch { /* the file is already gone */ }
}

console.log("");
console.log(`SHARDS=${shards.length} KILLED_SHARDS=${killedShards} TOTAL_ERRORS=${totalErrors}`);
if (killedShards > 0) console.log(`!!! ${killedShards} shards were killed: TOTAL_ERRORS is a lower bound, not the final count`);
console.log("--- by code ---");
for (const [code, n] of [...perCode.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${code}: ${n}`);
console.log("--- by file (top 20) ---");
for (const [file, record] of [...perFile.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20)) {
  console.log(`  ${String(record.count).padStart(5)}  ${file}  ${JSON.stringify(record.codes)}`);
}
console.log(`FILES_WITH_ERRORS=${perFile.size}`);

if (args.out) {
  fs.writeFileSync(path.resolve(ROOT, args.out), JSON.stringify({
    root: ROOT,
    tsconfig: args.tsconfig,
    filesChecked: files.length,
    shards: shards.length,
    killedShards,
    totalErrors,
    lowerBoundOnly: killedShards > 0,
    byCode: Object.fromEntries(perCode),
    byFile: Object.fromEntries([...perFile.entries()].map(([file, record]) => [file, record.count])),
    fileCodes: Object.fromEntries([...perFile.entries()].map(([file, record]) => [file, record.codes])),
    shards_detail: results,
  }, null, 2));
  console.log(`[tsc-shard] summary -> ${args.out}`);
}
process.exit(killedShards > 0 ? 3 : 0);
