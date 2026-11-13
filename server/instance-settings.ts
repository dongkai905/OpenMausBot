// The settings a person can change on one instance.
//
// The vendor account types that used to live here (a Claude account, a ChatGPT account, a Codex account) are gone with
// their engines, and so is the module that held them. What is left is the generic part, and it is what the routes take
// for a settings patch: a name, a directory, and whether the instance is hidden.
import { z } from "zod";

const displayName = z.string().trim().min(1).max(80).refine((value) => !/\p{Cc}/u.test(value), "Name cannot contain control characters");
const configDir = z.string().trim().max(4096).refine((value) => !/\p{Cc}/u.test(value), "Directory cannot contain control characters");

export const instanceSettingsSchema = z.object({
  cli: z.string().max(4096).refine((value) => !/\p{Cc}/u.test(value), "CLI cannot contain control characters").optional(),
  displayName: displayName.optional(),
  configDir: configDir.optional(),
  hidden: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No settings supplied");
