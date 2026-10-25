/**
 * Crash-safe session recycle bin ("回收站").
 *
 * A deleted session is never unlinked: its whole session directory is *moved*
 * into a trash item directory together with a JSON manifest that records enough
 * information to put it back byte-for-byte (`originalPath`, workspace, title,
 * file inventory). Permanent removal is a separate, explicit operation.
 *
 * This module owns only the filesystem and the manifest format, so it is
 * constructible with a temp directory in tests and knows nothing about Cordis,
 * HTTP, or sessions-as-services.
 *
 * ## Layout
 *
 * ```text
 * <root>/
 *   items/<trashId>/manifest.json   # single source of truth for one item
 *   items/<trashId>/payload/        # the moved session directory
 *   logs/trash-<YYYY-MM-DD>.ndjson  # append-only audit log
 * ```
 *
 * There is deliberately no persisted index: {@link TrashStore#list} derives
 * every listing from the per-item manifests, so the index can never disagree
 * with the payloads on disk.
 *
 * ## Crash safety
 *
 * A session directory is moved with `rename(2)`, which is atomic on one
 * filesystem. The manifest is written *before* the move in state `moving` and
 * rewritten in state `trashed` after it, so a crash always leaves either
 * (a) the session untouched where it was, or (b) a manifest that still knows
 * the original path. {@link TrashStore#list} heals the in-between state.
 * Across filesystems the copy falls back to a staged `payload.tmp` directory
 * that is renamed into place before the source is removed, so a partial copy is
 * never visible as a payload.
 *
 * @module dsh-session-trash/host/trash-store
 */

import { createHash, randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Current manifest schema version. */
export const MANIFEST_SCHEMA = 1;

/** Terminal states a trash item may be listed in. */
export const ITEM_TRASHED = "trashed";
/** Written before the payload move; healed by {@link TrashStore#list}. */
export const ITEM_MOVING = "moving";
/** Kept after a successful restore as an audit row; it holds no payload. */
export const ITEM_RESTORED = "restored";

/**
 * States a trash item may be listed in when it can no longer be restored.
 *
 * One source of truth: the statistics, the panel's broken list and "empty the
 * whole bin" must agree on which items are broken, or a damaged item ends up
 * counted in one place and ignored in another.
 *
 * @type {Set<string>}
 */
export const BROKEN_STATES = new Set(["failed", "corrupt", "orphan", "unknown-state"]);

/**
 * The manifest states this build knows how to read.
 *
 * A manifest naming anything else was written by another build (a newer plugin,
 * a hand edit) and cannot be interpreted here. Such an item is reported as
 * broken rather than dropped: dropped, it would be invisible in the panel and
 * skipped by "empty the whole bin", so its bytes would leak forever.
 *
 * @type {Set<string>}
 */
const KNOWN_STATES = new Set([ITEM_TRASHED, ITEM_MOVING, ITEM_RESTORED]);

/**
 * Whether a listed item is broken, and therefore can only be purged.
 *
 * @param {object} item - a listed trash item.
 * @returns {boolean} true when the item is in a broken state.
 */
export function isBroken(item) {
  return BROKEN_STATES.has(item?.state);
}

/** Strict trash-id shape, so an id from the wire can never name another path. */
const TRASH_ID_RE = /^t-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

/**
 * Longest session id accepted for deletion, in code units.
 *
 * DSH's own ids are `session-<uuid>`, but a `SessionId` is a branded string and
 * `session.create` accepts a caller-supplied id, so the guard must not assume the
 * conventional prefix — it only has to guarantee that the id cannot name a path.
 * {@link encodeSegment} neutralizes everything else, so the rule is: bounded,
 * non-empty, not `.`/`..`, and free of separators and NUL.
 */
const SESSION_ID_MAX = 200;

/** Separators and NUL: the only code units that could make an id name a path. */
const UNSAFE_ID_RE = /[/\\\u0000]/;

/** @returns {number} current epoch milliseconds. */
function defaultClock() {
  return Date.now();
}

/**
 * Whether a session id is safe to turn into a path segment.
 * @param {unknown} sessionId - candidate id.
 * @returns {boolean} true when the id can never name a path.
 */
export function isSafeSessionId(sessionId) {
  return (
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    sessionId.length <= SESSION_ID_MAX &&
    sessionId !== "." &&
    sessionId !== ".." &&
    !UNSAFE_ID_RE.test(sessionId)
  );
}

/**
 * Whether a trash id is safe to turn into a path segment.
 * @param {unknown} trashId - candidate id.
 * @returns {boolean} true when the id matches the strict shape.
 */
export function isSafeTrashId(trashId) {
  return typeof trashId === "string" && TRASH_ID_RE.test(trashId);
}

/** `YYYYMMDDTHHMMSSZ` for a timestamp, used inside trash ids and log names. */
function stamp(epochMs) {
  return new Date(epochMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** `YYYY-MM-DD` for a timestamp, used as the daily log name. */
function dayStamp(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Whether `inner` is `outer` itself or lives beneath it.
 *
 * Purely lexical on already-resolved paths; callers pass `realpath` output.
 *
 * @param {string} outer - containing directory.
 * @param {string} inner - candidate path.
 * @returns {boolean} true when `inner` is inside `outer`.
 */
export function isInside(outer, inner) {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Write a file atomically and durably: temporary sibling, fsync, rename, then a
 * best-effort directory fsync so the rename itself survives a power loss.
 *
 * @param {string} file - destination path.
 * @param {string|Uint8Array} data - payload.
 * @returns {Promise<void>} resolves once the destination names the payload.
 */
export async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  const handle = await fs.open(tmp, "w", 0o600);
  let written = false;
  try {
    await handle.writeFile(data);
    await handle.sync();
    written = true;
  } finally {
    await handle.close();
    // A failed write must not leave its temporary file behind: it would sit in
    // the item directory forever, with nothing reading or removing it.
    if (!written) await fs.rm(tmp, { force: true }).catch(() => {});
  }
  await fs.rename(tmp, file);
  await fsyncDir(path.dirname(file));
}

/**
 * Best-effort directory fsync. Windows and some filesystems reject directory
 * handles; failing there loses nothing this module promises.
 *
 * @param {string} dir - directory to sync.
 * @returns {Promise<void>} resolves even when the platform refuses.
 */
export async function fsyncDir(dir) {
  let handle;
  try {
    handle = await fs.open(dir, FS.O_RDONLY);
    await handle.sync();
  } catch {
    /* not supported here; the rename barrier is all this platform offers */
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Recursively size a directory and list its files, using `lstat` so a symlink is
 * recorded as a link rather than followed.
 *
 * @param {string} dir - directory to inventory.
 * @param {string} [base] - ancestor used to build relative names.
 * @returns {Promise<{files: Array<{rel: string, size: number, kind: string}>, totalBytes: number}>} inventory.
 */
export async function inventory(dir, base = dir) {
  const files = [];
  let totalBytes = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    const info = await fs.lstat(full);
    if (info.isDirectory()) {
      const nested = await inventory(full, base);
      files.push(...nested.files);
      totalBytes += nested.totalBytes;
    } else {
      files.push({ rel, size: info.size, kind: info.isSymbolicLink() ? "symlink" : "file" });
      totalBytes += info.size;
    }
  }
  return { files, totalBytes };
}

/**
 * {@link inventory} that reports failure instead of throwing.
 *
 * Inventory runs *after* a session's directory has already been moved, so a
 * failure here (an unreadable subtree, a file vanishing between `readdir` and
 * `lstat`) must never turn a completed delete into a reported failure, and must
 * never make the bin listing unreadable. Callers record the error and carry on
 * with an empty inventory.
 *
 * @param {string} dir - directory to inventory.
 * @returns {Promise<{files: Array<object>, totalBytes: number, error?: string}>} the inventory or the failure.
 */
export async function safeInventory(dir) {
  try {
    return await inventory(dir);
  } catch (error) {
    return { files: [], totalBytes: 0, error: String(error?.message ?? error) };
  }
}

/**
 * Move a directory, falling back to a staged copy across filesystems.
 *
 * The fallback copies into `<dest>.tmp` and renames it into place, so `dest`
 * either does not exist or is complete — a partial copy is never observable.
 *
 * **Commit point.** `rename` is the moment `dest` becomes the authoritative
 * copy. Everything after it is cleanup, and a cleanup failure is reported as
 * `leftover: true` rather than thrown: throwing would invite the caller to roll
 * back the item directory and destroy the only complete copy of a session. A
 * throw therefore means "nothing was committed" and is safe to roll back.
 *
 * @param {string} source - existing directory.
 * @param {string} dest - destination that must not exist.
 * @returns {Promise<{strategy: "rename"|"copy", leftover: boolean}>} how it moved, and whether the source survived cleanup.
 */
export async function moveDir(source, dest) {
  try {
    await fs.rename(source, dest);
    return { strategy: "rename", leftover: false };
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }
  const staged = `${dest}.tmp`;
  await fs.rm(staged, { recursive: true, force: true });
  await fs.cp(source, staged, { recursive: true, errorOnExist: true, force: false, dereference: false });
  await fs.rename(staged, dest);
  let leftover = false;
  try {
    await fs.rm(source, { recursive: true, force: true });
  } catch (error) {
    // `dest` already holds the complete session; the source could not be fully
    // removed. Report it so the operator can finish the job by hand.
    leftover = true;
  }
  return { strategy: "copy", leftover };
}

/**
 * Total size of a directory, for the confirmation dialog's numbers.
 *
 * @param {string} dir - directory to size.
 * @returns {Promise<number>} total bytes, or 0 when the directory is unreadable.
 */
export async function directorySize(dir) {
  try {
    const { totalBytes } = await inventory(dir);
    return totalBytes;
  } catch {
    return 0;
  }
}

/**
 * The session recycle bin.
 *
 * Every mutating method returns a plain result object and never throws for an
 * expected refusal (missing session, occupied restore target, unsafe id); the
 * caller maps results to HTTP and to the UI. Unexpected filesystem errors do
 * propagate.
 */
export class TrashStore {
  /** @type {string} absolute trash root. */
  #root;
  /** @type {string} absolute `items` directory. */
  #itemsDir;
  /** @type {string} absolute `logs` directory. */
  #logsDir;
  /** @type {() => number} injectable clock. */
  #clock;
  /** @type {{info: Function, warn: Function, error: Function}} sink for operations. */
  #logger;
  /** @type {Promise<void>|undefined} memoized one-time layout creation. */
  #ready;
  /** @type {Set<string>} trash ids whose item directory exists but is not published yet. */
  #inflight = new Set();

  /**
   * @param {object} options - construction options.
   * @param {string} options.root - absolute trash root directory.
   * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger] - optional log sink.
   * @param {() => number} [options.clock] - clock, for deterministic tests.
   */
  constructor({ root, logger, clock } = {}) {
    if (typeof root !== "string" || root.length === 0) throw new Error("TrashStore: root is required");
    this.#root = path.resolve(root);
    this.#itemsDir = path.join(this.#root, "items");
    this.#logsDir = path.join(this.#root, "logs");
    this.#clock = clock ?? defaultClock;
    this.#logger = {
      info: logger?.info?.bind(logger) ?? (() => {}),
      warn: logger?.warn?.bind(logger) ?? (() => {}),
      error: logger?.error?.bind(logger) ?? (() => {})
    };
  }

  /** @returns {string} the absolute trash root. */
  get root() {
    return this.#root;
  }

  /**
   * The store's clock, so callers that must agree with the store's own
   * timestamps (the per-item expired flag vs the expired count) read one source.
   * @returns {number} current epoch milliseconds.
   */
  now() {
    return this.#clock();
  }

  /**
   * Create the root directories. Safe to call repeatedly, and every public
   * method calls it first, so no caller can observe a half-built layout.
   * @returns {Promise<void>} resolves once the layout exists.
   */
  async init() {
    return this.#ensure();
  }

  /** @returns {Promise<void>} the memoized layout creation. */
  #ensure() {
    this.#ready ??= (async () => {
      await fs.mkdir(this.#itemsDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(this.#logsDir, { recursive: true, mode: 0o700 });
      await this.#fsyncRoot();
    })();
    return this.#ready;
  }

  /** @returns {Promise<void>} best-effort barrier on the root directory. */
  async #fsyncRoot() {
    await fsyncDir(this.#root);
  }

  /**
   * Resolve one item directory, refusing anything that escapes the items root.
   * @param {string} trashId - candidate id.
   * @returns {string} the absolute item directory.
   * @throws {Error} when the id is malformed or resolves outside the root.
   */
  itemDir(trashId) {
    if (!isSafeTrashId(trashId)) throw new Error(`TrashStore: malformed trash id ${JSON.stringify(trashId)}`);
    const dir = path.join(this.#itemsDir, trashId);
    if (!isInside(this.#itemsDir, dir)) throw new Error("TrashStore: trash id escapes the items root");
    return dir;
  }

  /**
   * Trash one session directory by moving it into a fresh item.
   *
   * Never silently overwrites: the caller supplies the exact directory the
   * persistence backend reported, and this method re-verifies that it is a
   * real directory (not a symlink) before moving it.
   *
   * @param {object} input - the delete request.
   * @param {string} input.sourceDir - absolute session directory to move.
   * @param {string} input.sessionId - the session the directory belongs to.
   * @param {string} [input.cwd] - owning workspace path, for display.
   * @param {string} [input.title] - display title at deletion time.
   * @param {string} [input.actor] - who asked, for the audit log.
   * @param {boolean} [input.wasArchived] - archive state before deletion.
   * @param {boolean} [input.wasPinned] - pin state before deletion.
   * @returns {Promise<object>} `{ok: true, item}` or `{ok: false, code, message}`.
   */
  async trash(input) {
    await this.#ensure();
    const { sourceDir, sessionId } = input ?? {};
    if (!isSafeSessionId(sessionId)) {
      return { ok: false, code: "invalid-session-id", message: `unsafe session id ${JSON.stringify(sessionId)}` };
    }
    if (typeof sourceDir !== "string" || !path.isAbsolute(sourceDir)) {
      return { ok: false, code: "invalid-path", message: "sourceDir must be an absolute path" };
    }
    const source = path.resolve(sourceDir);

    let before;
    try {
      before = await fs.lstat(source);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ok: false, code: "not-found", message: `session directory is missing: ${source}` };
      }
      throw error;
    }
    if (before.isSymbolicLink()) {
      return { ok: false, code: "symlink-refused", message: `refusing to move a symlinked session directory: ${source}` };
    }
    if (!before.isDirectory()) {
      return { ok: false, code: "not-a-directory", message: `not a directory: ${source}` };
    }
    // Containment is the locator's contract (`locate.js` verifies that the
    // directory is a non-symlink whose realpath stays inside the session store).
    // This store cannot know the session root, so it re-verifies only what it
    // can: the target is a real, non-symlinked directory. Callers must not pass
    // an unvalidated path.
    const resolvedSource = await fs.realpath(source);

    const now = this.#clock();
    const trashId = `t-${stamp(now)}-${randomBytes(4).toString("hex")}`;
    const dir = this.itemDir(trashId);
    const payload = path.join(dir, "payload");

    // `dir` is created for the manifest; `payload` deliberately is NOT. The move
    // itself creates `payload` atomically, which is what makes "a `moving`
    // manifest plus an existing payload" mean "the move landed". Pre-creating it
    // would make that inference unsound and could report a phantom deletion for a
    // session still sitting in the store.
    // Until the payload is in place the entry is half-created, and `list()` must
    // not report it: the panel would show a damaged item that is about to be fine.
    this.#inflight.add(trashId);

    /** Written before the move so a crash still knows where the session came from. */
    const pending = {
      schema: MANIFEST_SCHEMA,
      state: ITEM_MOVING,
      trashId,
      sessionId,
      originalPath: resolvedSource,
      cwd: input.cwd ?? null,
      title: input.title ?? null,
      wasArchived: input.wasArchived === true,
      wasPinned: input.wasPinned === true,
      // True when the runtime still held the session; recorded so a later
      // investigation can tell a clean delete from a forced one.
      forced: input.forced === true,
      deletedAt: now,
      deletedAtIso: new Date(now).toISOString(),
      actor: input.actor ?? "session-menu",
      fileCount: 0,
      totalBytes: 0,
      files: []
    };
    let created = false;
    let moved;
    try {
      // `dir` is created for the manifest; `payload` deliberately is NOT. The move
      // itself creates `payload` atomically, which is what makes "a `moving`
      // manifest plus an existing payload" mean "the move landed". Pre-creating it
      // would make that inference unsound and could report a phantom deletion for a
      // session still sitting in the store.
      await fs.mkdir(dir, { recursive: false, mode: 0o700 });
      created = true;
      await writeFileAtomic(path.join(dir, "manifest.json"), JSON.stringify(pending, null, 2));
      moved = await moveDir(resolvedSource, payload);
    } catch (error) {
      // Nothing was moved: `moveDir` throws only before its rename commit, and a
      // failed manifest write means the directory describes nothing at all.
      // Removing it cannot lose anything, and leaving it behind would put a
      // manifest-less item in the bin that the user has to recognize as debris.
      if (created) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      this.#inflight.delete(trashId);
    }

    // Past the commit point the session is in the bin. Nothing below may be
    // allowed to report the delete as failed, or to leave an item that makes the
    // whole bin unreadable.
    const sized = await safeInventory(payload);
    const item = {
      ...pending,
      state: ITEM_TRASHED,
      moveStrategy: moved.strategy,
      fileCount: sized.files.length,
      totalBytes: sized.totalBytes,
      files: sized.files,
      ...sized.error === undefined ? {} : { inventoryError: sized.error },
      ...moved.leftover ? { sourceLeftover: true } : {}
    };
    try {
      await writeFileAtomic(path.join(dir, "manifest.json"), JSON.stringify(item, null, 2));
    } catch (error) {
      // The `moving` manifest on disk still carries `originalPath`, so the item
      // remains restorable; only the file inventory is missing.
      this.#logger.warn?.(`session-trash: could not finalize the manifest for ${trashId}: ${String(error)}`);
    }
    await this.#appendLog({
      op: "trash",
      outcome: sized.error === undefined && !moved.leftover ? "ok" : "ok-with-warnings",
      sessionId,
      trashId,
      originalPath: resolvedSource,
      totalBytes: item.totalBytes,
      fileCount: item.fileCount,
      moveStrategy: moved.strategy,
      forced: item.forced === true,
      ...sized.error === undefined ? {} : { inventoryError: sized.error },
      ...moved.leftover ? { sourceLeftover: resolvedSource } : {},
      actor: item.actor
    });
    if (moved.leftover) {
      this.#logger.warn?.(
        `session-trash: ${sessionId} is safely in the bin as ${trashId}, but the original directory could not be fully removed: ${resolvedSource}`
      );
    }
    this.#logger.info?.(
      `session-trash: trashed ${sessionId} -> ${trashId} (${String(item.fileCount)} files, ${String(item.totalBytes)} bytes, ${moved.strategy})`
    );
    return { ok: true, item };
  }

  /**
   * List every trash item, healing the one crash window this design allows.
   *
   * An item whose manifest still says `moving` but whose payload exists means
   * the atomic rename completed and only the follow-up manifest write was lost;
   * that payload is complete, so the item is promoted to `trashed`. An item with
   * a `moving` manifest and no payload never moved the session and is reported
   * as `failed` so the UI can offer cleanup instead of a restore that cannot work.
   *
   * @returns {Promise<Array<object>>} items, newest deletion first.
   */
  async list() {
    await this.#ensure();
    let names;
    try {
      names = await fs.readdir(this.#itemsDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const items = [];
    for (const name of names) {
      if (!isSafeTrashId(name)) continue;
      // A half-created entry is not published yet: reporting it would show the
      // panel a damaged item that is about to become a normal one.
      if (this.#inflight.has(name)) continue;
      const dir = path.join(this.#itemsDir, name);
      const manifestPath = path.join(dir, "manifest.json");
      let manifest;
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          this.#logger.warn?.(`session-trash: unreadable manifest for ${name}: ${String(error)}`);
          items.push({ trashId: name, state: "corrupt", error: String(error?.message ?? error) });
          continue;
        }
        // No manifest: an orphan left by a crash between `mkdir` and the manifest
        // write, or by a rollback that could not finish. Reporting it (rather than
        // skipping it) is what makes its bytes visible and purgeable instead of
        // leaking forever.
        const orphanBytes = await safeInventory(path.join(dir, "payload"));
        items.push({
          trashId: name,
          state: "orphan",
          error: "item directory has no manifest",
          totalBytes: orphanBytes.totalBytes,
          fileCount: orphanBytes.files.length
        });
        continue;
      }
      // A record kept after a successful restore (`keepItem`) has no payload on
      // purpose; it is an audit row, not a broken item.
      if (manifest.state === ITEM_RESTORED) {
        items.push(manifest);
        continue;
      }
      const payload = path.join(dir, "payload");
      const payloadExists = await pathExists(payload);
      if (manifest.state === ITEM_MOVING) {
        if (!payloadExists) {
          // Nothing was moved: the session is still where it was. Read-only
          // reporting — a GET must not write.
          items.push({ ...manifest, state: "failed", error: "payload move never completed" });
          continue;
        }
        // The rename landed and only the follow-up manifest write was lost.
        // Healed in memory only: a listing is a read, and a refused or read-only
        // path must leave the filesystem untouched.
        const sized = await safeInventory(payload);
        this.#logger.warn?.(`session-trash: ${name} was interrupted after its move; reporting it as complete`);
        items.push({
          ...manifest,
          state: ITEM_TRASHED,
          fileCount: sized.files.length,
          totalBytes: sized.totalBytes,
          files: sized.files,
          healed: true,
          ...sized.error === undefined ? {} : { inventoryError: sized.error }
        });
        continue;
      }
      if (!KNOWN_STATES.has(manifest.state)) {
        // A state this build does not know: the manifest is readable but not
        // understandable. Reporting it as broken keeps its bytes visible and
        // purgeable instead of letting them leak.
        const sized = await safeInventory(payload);
        this.#logger.warn?.(
          `session-trash: ${name} carries an unknown manifest state ${JSON.stringify(manifest.state)}; reporting it as broken`
        );
        items.push({
          ...manifest,
          state: "unknown-state",
          error: `unknown manifest state ${JSON.stringify(manifest.state)}`,
          fileCount: sized.files.length,
          totalBytes: sized.totalBytes,
          files: sized.files
        });
        continue;
      }
      if (!payloadExists) {
        items.push({ ...manifest, state: "failed", error: "payload directory is missing" });
        continue;
      }
      items.push(manifest);
    }
    return items.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }

  /**
   * Read one item's manifest without healing.
   * @param {string} trashId - item to read.
   * @returns {Promise<object|undefined>} the manifest, or undefined when absent.
   */
  async get(trashId) {
    await this.#ensure();
    const dir = this.itemDir(trashId);
    try {
      return JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Put one trashed session back at the exact path it was removed from.
   *
   * Refuses when the original path is occupied: two sessions must never be
   * merged, and the newer directory is never overwritten.
   *
   * @param {string} trashId - item to restore.
   * @param {object} [options] - restore options.
   * @param {boolean} [options.keepItem] - keep the item directory as an audit record.
   * @returns {Promise<object>} `{ok: true, sessionId, originalPath}` or a refusal.
   */
  async restore(trashId, options = {}) {
    await this.#ensure();
    const dir = this.itemDir(trashId);
    let manifest = await this.get(trashId);
    if (manifest === undefined) {
      // An orphan directory has no manifest, so its original path is unknown and
      // it cannot be restored — but it can still be purged.
      if (await pathExists(dir)) {
        return { ok: false, code: "no-manifest", message: `item ${trashId} has no manifest and cannot be restored` };
      }
      return { ok: false, code: "unknown-item", message: `no trash item ${trashId}` };
    }
    const payload = path.join(dir, "payload");
    const payloadExists = await pathExists(payload);
    if (manifest.state === ITEM_MOVING && payloadExists) {
      // The rename landed and only the follow-up manifest write was lost; the
      // payload is complete. Healed in memory; the successful restore removes the
      // item anyway, so no write is needed here (and a refusal must not write).
      const sized = await safeInventory(payload);
      manifest = { ...manifest, state: ITEM_TRASHED, fileCount: sized.files.length, totalBytes: sized.totalBytes, healed: true };
    }
    if (manifest.state !== ITEM_TRASHED) {
      return { ok: false, code: "not-restorable", message: `item ${trashId} is ${String(manifest.state)}` };
    }
    const originalPath = manifest.originalPath;
    if (typeof originalPath !== "string" || !path.isAbsolute(originalPath)) {
      return { ok: false, code: "invalid-manifest", message: "manifest carries no absolute originalPath" };
    }
    if (await pathExists(originalPath)) {
      return {
        ok: false,
        code: "occupied",
        message: `the original session directory already exists: ${originalPath}`,
        originalPath
      };
    }
    if (!payloadExists) {
      return { ok: false, code: "payload-missing", message: `payload is missing for ${trashId}` };
    }
    await fs.mkdir(path.dirname(originalPath), { recursive: true, mode: 0o700 });
    const moved = await moveDir(payload, originalPath);
    if (options.keepItem === true) {
      manifest.state = ITEM_RESTORED;
      manifest.restoredAt = this.#clock();
      manifest.restoredAtIso = new Date(manifest.restoredAt).toISOString();
      manifest.moveStrategy = moved.strategy;
      await writeFileAtomic(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    } else {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (error) {
        // The payload has already been moved back: the session *is* restored, and
        // the only thing that failed is tidying up the now-empty bin item. Failing
        // the whole restore here would tell the user their session was not
        // restored, skip the workspace bookkeeping that follows a restore, and
        // leave a bin item offering a restore of something no longer in the bin.
        // Mark it restored instead (which also takes it out of every listing) and
        // report the leftover.
        manifest.state = ITEM_RESTORED;
        manifest.restoredAt = this.#clock();
        manifest.restoredAtIso = new Date(manifest.restoredAt).toISOString();
        manifest.moveStrategy = moved.strategy;
        await writeFileAtomic(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2)).catch(() => {});
        moved.leftover = true;
        this.#logger.warn?.(
          `session-trash: restored ${String(manifest.sessionId)} but the emptied bin item could not be removed: ${dir} (${String(error?.message ?? error)})`
        );
      }
    }
    await this.#appendLog({
      op: "restore",
      outcome: moved.leftover ? "ok-with-warnings" : "ok",
      sessionId: manifest.sessionId,
      trashId,
      originalPath,
      moveStrategy: moved.strategy,
      ...moved.leftover ? { itemLeftover: dir } : {},
      actor: options.actor ?? "session-menu"
    });
    if (moved.leftover) {
      this.#logger.warn?.(`session-trash: restored ${manifest.sessionId} but the bin item could not be fully removed: ${dir}`);
    }
    this.#logger.info?.(`session-trash: restored ${manifest.sessionId} from ${trashId}`);
    return {
      ok: true,
      sessionId: manifest.sessionId,
      originalPath,
      strategy: moved.strategy,
      cwd: manifest.cwd ?? null,
      wasArchived: manifest.wasArchived === true,
      wasPinned: manifest.wasPinned === true
    };
  }

  /**
   * Permanently remove trash items. This is the only irreversible operation and
   * it is never reached by the soft-delete path.
   *
   * @param {string[]} trashIds - items to remove for good.
   * @param {object} [options] - purge options.
   * @param {string} [options.actor] - who asked, for the audit log.
   * @returns {Promise<Array<object>>} one result per requested id.
   */
  async purge(trashIds, options = {}) {
    await this.#ensure();
    const results = [];
    for (const trashId of Array.isArray(trashIds) ? trashIds : []) {
      let dir;
      try {
        dir = this.itemDir(trashId);
      } catch (error) {
        results.push({ trashId, ok: false, code: "invalid-id", message: String(error.message) });
        continue;
      }
      const manifest = await this.get(trashId).catch(() => undefined);
      if (manifest === undefined && !(await pathExists(dir))) {
        results.push({ trashId, ok: false, code: "unknown-item", message: `no trash item ${trashId}` });
        continue;
      }
      // A manifest-less directory is still this bin's own data (an interrupted
      // delete), so it must be purgeable or its bytes leak forever.
      const freedBytes = manifest?.totalBytes ?? (await safeInventory(path.join(dir, "payload"))).totalBytes;
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (error) {
        this.#logger.warn?.(`session-trash: purging ${trashId} failed: ${String(error)}`);
        await this.#appendLog({
          op: "purge",
          outcome: "failed",
          sessionId: manifest?.sessionId ?? null,
          trashId,
          error: String(error?.message ?? error),
          actor: options.actor ?? "session-menu"
        });
        results.push({ trashId, ok: false, code: "purge-failed", message: String(error?.message ?? error) });
        continue;
      }
      await this.#appendLog({
        op: "purge",
        outcome: manifest === undefined ? "ok-orphan" : "ok",
        sessionId: manifest?.sessionId ?? null,
        trashId,
        totalBytes: freedBytes,
        actor: options.actor ?? "session-menu"
      });
      results.push({ trashId, ok: true, sessionId: manifest?.sessionId ?? null, freedBytes, orphan: manifest === undefined });
    }
    this.#logger.info?.(`session-trash: purged ${String(results.filter((r) => r.ok).length)} item(s)`);
    return results;
  }

  /**
   * Items whose retention window has elapsed. Reported, never deleted here:
   * destroying a user's data stays an explicit act.
   *
   * @param {number} retentionDays - window length in days; `0` disables the report.
   * @param {Array<object>} [items] - an already-read listing, to avoid a second walk.
   * @returns {Promise<Array<object>>} expired items.
   */
  async expired(retentionDays, items) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
    const cutoff = this.#clock() - retentionDays * 86_400_000;
    const rows = items ?? (await this.list());
    return rows.filter((item) => item.state === ITEM_TRASHED && (item.deletedAt ?? 0) < cutoff);
  }

  /**
   * Counts and sizes for the status endpoint and the panel header.
   * @param {number} [retentionDays] - window used for the expiry count.
   * @param {Array<object>} [existing] - an already-read listing, to avoid a second walk.
   * @returns {Promise<object>} `{count, bytes, expiredCount, retentionDays, root}`.
   */
  async stats(retentionDays = 0, existing) {
    const items = existing ?? (await this.list());
    const restorable = items.filter((item) => item.state === ITEM_TRASHED);
    const broken = items.filter((item) => isBroken(item));
    return {
      count: restorable.length,
      brokenCount: broken.length,
      bytes: restorable.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0),
      expiredCount: (await this.expired(retentionDays, items)).length,
      retentionDays,
      root: this.#root
    };
  }

  /**
   * Append one audit record. A logging failure is reported but never fails the
   * operation the record describes.
   *
   * @param {object} record - fields to record.
   * @returns {Promise<void>} resolves after a best-effort append.
   */
  async #appendLog(record) {
    const now = this.#clock();
    const line = `${JSON.stringify({
      ts: now,
      tsIso: new Date(now).toISOString(),
      pid: process.pid,
      host: safeHostname(),
      ...record
    })}\n`;
    const file = path.join(this.#logsDir, `trash-${dayStamp(now)}.ndjson`);
    try {
      await fs.mkdir(this.#logsDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(file, line, { mode: 0o600 });
    } catch (error) {
      this.#logger.warn?.(`session-trash: audit log append failed: ${String(error)}`);
    }
  }

  /**
   * Append one caller-owned audit record (refusals, plans, cleanup outcomes).
   *
   * Kept public so the service layer can audit decisions that never reach a
   * filesystem mutation; the append itself is shared with the store's own
   * records, so the log stays in one ordered stream.
   *
   * @param {object} record - fields to record; `op` is required by convention.
   * @returns {Promise<void>} resolves after a best-effort append.
   */
  async record(record) {
    await this.#ensure();
    await this.#appendLog(record);
  }

  /**
   * Read audit records, newest first, for the log viewer.
   *
   * @param {object} [options] - read options.
   * @param {number} [options.limit] - maximum records to return.
   * @returns {Promise<Array<object>>} parsed records, skipping undecodable lines.
   */
  async readLog({ limit = 200 } = {}) {
    await this.#ensure();
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 200;
    if (max === 0) return [];
    let names;
    try {
      names = (await fs.readdir(this.#logsDir)).filter((name) => name.endsWith(".ndjson")).sort().reverse();
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    // Day files are already newest-first by name; within a day the file is
    // append-ordered oldest-first, so each day's rows are reversed as they are
    // read. Concatenating then gives one newest-first stream, which is what the
    // panel's `slice(0, 50)` and this method's contract both assume.
    const records = [];
    for (const name of names) {
      const text = await fs.readFile(path.join(this.#logsDir, name), "utf8");
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          records.push(JSON.parse(lines[index]));
        } catch {
          /* a torn final line is expected after an abrupt exit */
        }
        if (records.length >= max) return records;
      }
    }
    return records;
  }
}

/** @returns {boolean} whether a path exists, without following a final symlink. */
async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * A stable, non-identifying host label for audit records.
 *
 * `HOSTNAME` is a shell convention, not a runtime guarantee: a GUI-launched
 * process (which is how DSH runs) usually has no `HOSTNAME` at all, and hashing
 * the empty string would give every machine the same label and the audit trail
 * would not say which host did what. `os.hostname()` is always there.
 *
 * @returns {string} the hashed host label.
 */
function safeHostname() {
  try {
    const name = process.env.HOSTNAME ?? os.hostname();
    return createHash("sha256").update(name).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}
