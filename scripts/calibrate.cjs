#!/usr/bin/env node
// Calibration harness: try candidate vendor-token sets against the frontend reachability
// graph and report (files, occurrences) so the chosen set matches the recorded baseline.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const files = JSON.parse(execFileSync("node", [path.join(__dirname, "fe_reach.cjs"), "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).files;

const SETS = {
  driverKinds: ["claudeAgent", "codex", "codexAgent", "antigravityAgent", "grokAgent", "opencodeGo", "opencodeAgent", "opencode",
    "claude", "piAgent", "kimiAgent", "grok", "deepseekAgent", "geminiAgent", "qwenAgent", "clineAgent", "cursorAgent",
    "copilotAgent", "hermes", "kiro", "commandCode", "mistral", "cerebras", "groq", "greenference", "modelgo", "meta",
    "xai", "minimax", "museCode", "openai", "openai-compat", "openaiCompat", "ollama"],
  brands: ["openai", "openai-compat", "ollama", "claude", "anthropic", "grok", "xai", "gemini", "qwen", "kimi", "mistral",
    "cerebras", "groq", "greenference", "modelgo", "deepseek", "antigravity", "opencode", "cline", "codex", "cursor",
    "copilot", "hermes", "kiro", "minimax", "museCode", "pi"],
};

const EXT = new Set([".ts", ".tsx"]);
const countToken = (source, token) => {
  const re = new RegExp(`(?<![A-Za-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "g");
  let count = 0;
  while (re.exec(source) !== null) count += 1;
  return count;
};

for (const [name, tokens] of Object.entries(SETS)) {
  for (const mode of ["codeOnly", "all"]) {
    let files_ = 0;
    let total = 0;
    const perFile = [];
    for (const file of files) {
      if (mode === "codeOnly" && !EXT.has(path.extname(file))) continue;
      let source;
      try { source = fs.readFileSync(path.join(ROOT, file), "utf8"); } catch { continue; }
      let fileTotal = 0;
      for (const token of tokens) fileTotal += countToken(source, token);
      if (fileTotal > 0) { files_ += 1; total += fileTotal; perFile.push([file, fileTotal]); }
    }
    perFile.sort((a, b) => b[1] - a[1]);
    console.log(`\n### ${name} / ${mode}: ${total} occurrences in ${files_} files`);
    for (const [f, c] of perFile.slice(0, 12)) console.log(`   ${String(c).padStart(4)}  ${f}`);
  }
}
