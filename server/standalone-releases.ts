// Every AI build the app can install itself. Only these are put on PATH at start-up: a folder under tools/standalone
// that no release here names is never trusted.
import type { StandaloneRelease } from "./contracts.ts";

// 步 6（Task-135 路线 B 物理剥夺）：OpenCode 与 Cursor 两个引擎已物理删除，
// 它们的 standalone 构建也随引擎一起不存在了 —— 外壳不再能自行安装任何引擎构建。
export const STANDALONE_RELEASES: readonly StandaloneRelease[] = [];
