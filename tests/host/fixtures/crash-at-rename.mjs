/**
 * Crash fixture: die at the commit point of a session move.
 *
 * Spawned by the regression suite. It patches `rename` so that the rename from the
 * session directory into the recycle bin kills the process with SIGKILL instead of
 * running — reproducing a power loss or `kill -9` in the exact window between the
 * `moving` manifest write and the move.
 *
 * What the parent then inspects is the whole point of the fix: the session must
 * still be in the store and the bin must NOT claim it was deleted. A design that
 * pre-creates the payload directory leaves an empty `payload` behind in this
 * window, and the listing then heals it into a phantom `trashed` item with an
 * empty inventory.
 *
 * Usage: node crash-at-rename.mjs <trashRoot> <sourceDir> <sessionId>
 */

import fs from "node:fs/promises";
import path from "node:path";

import { TrashStore } from "../../../lib/host/trash-store.js";

const [trashRoot, sourceDir, sessionId] = process.argv.slice(2);
if (trashRoot === undefined || sourceDir === undefined || sessionId === undefined) {
  process.stderr.write("crash-at-rename: expected <trashRoot> <sourceDir> <sessionId>\n");
  process.exit(2);
}

// `trash()` realpaths its source, so match on the canonical spelling.
const canonicalSource = await fs.realpath(sourceDir);

const originalRename = fs.rename;
fs.rename = async (from, to) => {
  if (from === canonicalSource) {
    process.kill(process.pid, "SIGKILL");
    // Unreachable; kept so a platform that ignores SIGKILL fails loudly instead
    // of silently committing the move.
    throw new Error("crash fixture: SIGKILL did not terminate the process");
  }
  return originalRename(from, to);
};

const store = new TrashStore({
  root: trashRoot,
  logger: { info() {}, warn() {}, error() {} }
});
await store.trash({ sourceDir, sessionId });
process.stderr.write(`crash-at-rename: trash() returned instead of crashing (${path.basename(trashRoot)})\n`);
process.exit(3);
