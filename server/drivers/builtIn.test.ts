import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "./builtIn.ts";

/**
 * 步 6 / Task-135（路线 B 物理剥夺）的守卫。
 *
 * 路线 B 的承诺不是「配置里不选厂商引擎」，而是「厂商引擎在代码里**不存在**」。
 * 这条测试把那个承诺钉死：任何人再加回一个厂商引擎，它就变红。
 *
 * 两道断言：
 *  ① 引擎注册表里只有一个引擎位，且是 customAcp；
 *  ② 服务端源码里**任何驱动实现**声明的 `driverKind: "…"` 字面量都只能是 "customAcp"
 *     —— 这条比 ① 更硬：它连「注册表没挂上、但驱动文件还在」的情况也堵死。
 *     （判据只认驱动实现里 `driverKind:` 的字符串字面量这个形状；
 *       引擎能力表里的 map key 是另一套形状，由 server/runtime/capabilities.test.ts 守。）
 */

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 扫出服务端源码里所有 driverKind 的字符串字面量（带位置，出错时能直接定位）。 */
function driverKindLiterals(): { kind: string; where: string }[] {
  const found: { kind: string; where: string }[] = [];
  const skip = new Set(["node_modules", "dist", "dist-server", "dist-companion", "build", "release", ".git"]);

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|cjs)$/.test(entry.name)) continue;
      // 测试文件里的 driverKind 是夹具，不是引擎位
      if (/\.(test|spec)\./.test(entry.name) || entry.name.endsWith(".node-test.mjs")) continue;
      const text = readFileSync(full, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = /driverKind\s*:\s*["'`]([^"'`]+)["'`]/.exec(line);
        if (m) found.push({ kind: m[1]!, where: `${relative(SERVER_DIR, full)}:${i + 1}` });
      }
    }
  };
  walk(SERVER_DIR);
  return found;
}

describe("the engine registry after the physical deprivation", () => {
  it("holds exactly one engine, and it is customAcp", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual(["customAcp"]);
  });

  it("has no other engine kind anywhere in the server's source", () => {
    const literals = driverKindLiterals();
    const offenders = literals.filter((entry) => entry.kind !== "customAcp");
    expect(
      offenders.map((entry) => `${entry.kind} @ ${entry.where}`),
      "a driver kind other than customAcp is still in the server's source: the native engine layer is back",
    ).toEqual([]);
  });
});
