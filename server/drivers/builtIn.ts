import type { AnyProviderDriver } from "../contracts.ts";
import { CustomAcpDriver } from "./acp/custom.ts";

// 步 6 / Task-135（路线 B 物理剥夺）：原生大模型引擎层已**物理删除**
// （嫁接方案 v4 §2.4「明确不接清单」）。
// 只留 `customAcp` 一个引擎位 —— 外壳自己的引擎能力不再存在于代码里，
// 因此**不能靠运行时拦截绕过**（强制力来自架构剥夺）。
export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  CustomAcpDriver,
];
