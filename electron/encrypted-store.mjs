// A record this computer keeps in its own file, encrypted with the operating system's key.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { unreadableRecord } from "./record-read.mjs";

const MAX_BYTES = 64 * 1024;
const decryptedText = decrypted => (typeof decrypted === "string" ? decrypted : decrypted?.result);
const unreadable = message => Object.assign(new Error(message), { code: "unreadable_record" });

/** OS-encrypted; a Cloud account's token never goes into config.json, backups, renderer storage, environment variables or CLI homes. */
export function createEncryptedStore({ file, encryption }) {
  let tail = Promise.resolve();
  const available = async () => {
    if (!(await encryption.available())) throw new Error("Unlock your system keychain to use MausBot Cloud on this computer.");
  };
  return {
    async read() {
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) throw unreadable("Invalid saved account record.");
        await available();
        const encrypted = await handle.readFile();
        let text;
        try { text = decryptedText(await encryption.decrypt(encrypted)); } catch { throw unreadable("This computer can no longer decrypt the record."); }
        // Not unreadable(): an unknown decrypt shape is this app's mistake, and the record must not be removed.
        if (typeof text !== "string") throw new Error("Unexpected decrypt result.");
        try { return JSON.parse(text); } catch { throw unreadable("The record is not JSON."); }
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw Object.assign(new Error("Your saved MausBot Cloud account could not be read. Unlock your system keychain and try again."),
          unreadableRecord(error) ? { code: error.code } : {});
      }
      finally { await handle?.close(); }
    },
    write(value) {
      const operation = tail.catch(() => {}).then(async () => {
        // Forgetting must work while the keychain is locked; the file is removed in the same queue as pending writes.
        if (value === null) {
          try { await fs.unlink(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
          return;
        }
        await available();
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const encrypted = await encryption.encrypt(JSON.stringify(value));
          const handle = await fs.open(temporary, "wx", 0o600);
          try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
      });
      tail = operation;
      return operation;
    },
  };
}
