#!/usr/bin/env node
// Sharded type check.
//
// Usage:
//   node scripts/tsc_shard.cjs                       # check every project, default shard count
//   node scripts/tsc_shard.cjs --shards 24
//   node scripts/tsc_shard.cjs --project tsconfig.json --json
//   node scripts/tsc_shard.cjs --codes               # only the per-code histogram
//
// A whole-project `tsc --noEmit` on this repository needs more memory than a
// sandbox has, so the roots are partitioned: each shard is a project whose
// `files` are one slice of the roots, and the compiler still follows the
// imports it needs. Errors are deduplicated across shards, because a file
// imported by two shards is reported by both.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRATCH = path.join(ROOT, ".omb-scratch", "tsc-shards");
const PROJECTS = ["tsconfig.json", "tsconfig.server.json"];
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);

const stripJsonComments = (text) => text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const readProject = (relative) => {
  const raw = fs.readFileSync(path.join(ROOT, relative), "utf8");
  return JSON.parse(stripJsonComments(raw));
};

const walkFiles = (dir, out = []) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walkFiles(full, out);
    } else if (SOURCE_EXT.has(path.extname(entry.name)) || entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
};

const matchGlob = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
};

const excluded = (relative, excludes) => excludes.some((pattern) => matchGlob(pattern).test(relative));

const rootsFor = (project) => {
  const roots = [];
  const includes = project.include ?? ["**/*"];
  const excludes = project.exclude ?? [];
  for (const include of includes) {
    const target = path.join(ROOT, include);
    if (/\.(ts|tsx|mts|cts)$/.test(include)) { roots.push(target); continue; }
    if (include.includes("*")) {
      const dir = path.dirname(target);
      const walker = walkFiles(dir);
      for (const file of walker) {
        const relative = path.relative(ROOT, file);
        if (matchGlob(include).test(relative) && !excluded(relative, excludes)) roots.push(file);
      }
      continue;
    }
    for (const file of walkFiles(target)) {
      const relative = path.relative(ROOT, file);
      if (!excluded(relative, excludes)) roots.push(file);
    }
  }
  return [...new Set(roots)].sort();
};

const partition = (roots, shards) => {
  const buckets = Array.from({ length: shards }, () => []);
  const weight = (file) => {
    try { return Math.max(1, fs.statSync(file).size); } catch { return 1; }
  };
  const sorted = [...roots].sort((a, b) => weight(b) - weight(a));
  for (const file of sorted) {
    let smallest = 0;
    for (let index = 1; index < buckets.length; index += 1) {
      if (buckets[index].length < buckets[smallest].length) smallest = index;
    }
    buckets[smallest].push(file);
  }
  return buckets.filter((bucket) => bucket.length > 0);
};

const parseErrors = (output) => {
  const errors = [];
  const line = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  for (const row of output.split("\n")) {
    const match = row.match(line);
    if (!match) continue;
    errors.push({ file: path.relative(ROOT, match[1]), line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5] });
  }
  return errors;
};

const main = () => {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const shardCount = Number(opt("--shards", "16"));
  const onlyProject = opt("--project", "");
  const projects = onlyProject ? [onlyProject] : PROJECTS;

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });

  const all = new Map();
  let shards = 0;
  let oom = 0;

  for (const relative of projects) {
    const project = readProject(relative);
    const roots = rootsFor(project);
    const buckets = partition(roots, shardCount);
    const options = { ...project.compilerOptions };
    options.baseUrl = path.join(ROOT, options.baseUrl ?? ".");
    if (options.paths) {
      options.paths = Object.fromEntries(Object.entries(options.paths).map(([key, values]) => [key, values.map((value) => path.join(ROOT, value))]));
    }
    for (const [index, bucket] of buckets.entries()) {
      shards += 1;
      const name = `${relative.replace(/\W/g, "_")}-${String(index).padStart(2, "0")}`;
      const shardPath = path.join(SCRATCH, `${name}.json`);
      fs.writeFileSync(shardPath, JSON.stringify({ compilerOptions: options, files: bucket }, null, 2));
      const result = spawnSync("node", [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", shardPath, "--pretty", "false"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim() },
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (/heap out of memory|Allocation failed/i.test(output)) oom += 1;
      for (const error of parseErrors(output)) {
        const key = `${error.file}:${error.line}:${error.column}:${error.code}`;
        if (!all.has(key)) all.set(key, error);
      }
    }
  }

  const errors = [...all.values()];
  const byCode = new Map();
  for (const error of errors) byCode.set(error.code, (byCode.get(error.code) ?? 0) + 1);
  const byFile = new Map();
  for (const error of errors) byFile.set(error.file, (byFile.get(error.file) ?? 0) + 1);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ shards, oomShards: oom, totalErrors: errors.length, byCode: Object.fromEntries([...byCode].sort((a, b) => b[1] - a[1])), byFile: Object.fromEntries([...byFile].sort((a, b) => b[1] - a[1])), errors }, null, 2));
    return;
  }
  console.log(`shards: ${shards} (oom: ${oom})`);
  console.log(`type errors: ${errors.length} in ${byFile.size} files`);
  for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${code}  ${count}`);
  if (argv.includes("--codes")) return;
  fs.writeFileSync(path.join(ROOT, ".omb-scratch", "tsc-errors.json"), JSON.stringify({ shards, oomShards: oom, totalErrors: errors.length, byCode: Object.fromEntries([...byCode].sort((a, b) => b[1] - a[1])), errors }, null, 2));
  console.log("");
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`  ${String(count).padStart(4)}  ${file}`);
  console.log("");
  for (const error of errors.slice(0, 40)) console.log(`${error.file}:${error.line}:${error.column} ${error.code} ${error.message.slice(0, 140)}`);
};

main();
