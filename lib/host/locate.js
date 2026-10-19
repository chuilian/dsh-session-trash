/**
 * Resolving a session id to the directory that actually holds its log.
 *
 * Deleting a session means moving *the session's own directory*, so the
 * dangerous part of this plugin is finding that directory. A wrong answer
 * deletes the wrong bytes, so the resolver is layered from most to least
 * authoritative and every layer is containment-checked:
 *
 * 1. **Backend `locate()`** — the shipped JSONL backend exposes
 *    `locate(meta)`, which returns the absolute artifact path it would use for a
 *    stored header. This is the backend's own answer, so it cannot drift from
 *    the backend's naming rules.
 * 2. **Backend `root` + header `cwd`** — the same thing computed from the
 *    backend's resolved root and the documented `<root>/<projectKey>/<id>`
 *    layout. Used when `locate` is absent (another backend implementation).
 * 3. **Scan** — one `readdir` over each candidate root's project directories,
 *    looking for `<encoded id>` beneath them. Needs no header at all, so it
 *    still works when the backend is cold or the header cannot be read.
 *
 * A result is only accepted when it is a real directory (not a symlink) that
 * resolves inside its candidate root, which is what makes it safe to hand to
 * {@link module:dsh-session-trash/host/trash-store.TrashStore#trash}.
 *
 * @module dsh-session-trash/host/locate
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { encodeSegment, projectKey } from "./encode.js";
import { isInside, isSafeSessionId } from "./trash-store.js";

/**
 * The DSH home directory, matching the launcher's own resolution order.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute DSH home.
 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === "string" && configured.length > 0) return path.resolve(configured);
  return path.join(os.homedir(), ".dsh");
}

/**
 * Candidate session-store roots, most specific first.
 *
 * @param {object} persistence - the `sessionPersistence` service, if mounted.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string[]} distinct absolute candidate roots.
 */
export function candidateRoots(persistence, env = process.env) {
  const roots = [];
  const push = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  push(persistence?.root);
  push(path.join(dshHome(env), "sessions"));
  return roots;
}

/**
 * Whether a path is an existing, non-symlink directory that resolves inside
 * `root`.
 *
 * @param {string} root - the root the directory must stay beneath.
 * @param {string} dir - candidate directory.
 * @returns {Promise<string|undefined>} the real path when acceptable.
 */
async function acceptableDir(root, dir) {
  let info;
  try {
    info = await fs.lstat(dir);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
  let real;
  let realRoot;
  try {
    real = await fs.realpath(dir);
    realRoot = await fs.realpath(root);
  } catch {
    return undefined;
  }
  return isInside(realRoot, real) ? real : undefined;
}

/**
 * Whether a path lies outside every candidate root, judged lexically on the
 * canonical spellings.
 *
 * Used only to separate "not materialized yet" from "the backend named a path
 * outside its own root"; the containment check that guards a delete remains
 * {@link acceptableDir}, which re-verifies with `realpath`.
 *
 * @param {string[]} roots - candidate roots.
 * @param {string} target - path to test.
 * @returns {Promise<boolean>} true when no root contains the target.
 */
async function isOutsideEveryRoot(roots, target) {
  const canonical = await canonicalize(target);
  for (const root of roots) {
    try {
      if (isInside(await fs.realpath(root), canonical)) return false;
    } catch {
      /* an unresolvable root cannot contain anything */
    }
  }
  return true;
}

/**
 * Canonical absolute spelling of a path that may not exist yet.
 *
 * `realpath` needs an existing target, and comparing a canonical root against a
 * non-canonical path is wrong wherever a root itself is reached through a
 * symlink (on macOS `/var` is a symlink to `/private/var`, so `/private/var/x`
 * never lexically contains `/var/x`). This walks up to the nearest existing
 * ancestor, canonicalizes that, and re-appends the missing segments.
 *
 * @param {string} target - absolute path, existing or not.
 * @returns {Promise<string>} the canonical absolute path.
 */
async function canonicalize(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve one session id to its directory using every available layer.
 *
 * @param {object} input - resolution input.
 * @param {string} input.sessionId - the session to locate.
 * @param {object} [input.persistence] - the `sessionPersistence` service.
 * @param {NodeJS.ProcessEnv} [input.env] - environment for home resolution.
 * @returns {Promise<object>} `{ok: true, dir, root, via, header}` or a refusal with `code`.
 */
export async function resolveSessionDir({ sessionId, persistence, env = process.env }) {
  if (!isSafeSessionId(sessionId)) {
    return { ok: false, code: "invalid-session-id", message: `unsafe session id ${JSON.stringify(sessionId)}` };
  }
  const roots = candidateRoots(persistence, env);
  if (roots.length === 0) {
    return { ok: false, code: "no-store", message: "no session store root is known" };
  }

  // A header is useful for layers 1 and 2 and for restoring the workspace later.
  let header;
  if (persistence !== undefined && typeof persistence.stat === "function") {
    try {
      const snapshot = await persistence.stat(sessionId);
      header = snapshot?.header;
    } catch {
      /* a cold or unreadable header only costs us the cheap layers */
    }
  }

  /** The layer-1 candidate, kept only to explain a final refusal. */
  let locatedMiss;

  // Layer 1: the backend's own artifact path.
  if (header !== undefined && typeof persistence?.locate === "function") {
    try {
      const located = persistence.locate(header);
      if (typeof located?.path === "string") {
        const dir = path.dirname(located.path);
        for (const root of roots) {
          const accepted = await acceptableDir(root, dir);
          if (accepted !== undefined) return { ok: true, dir: accepted, root, via: "locate", header };
        }
        // Distinguish a containment failure from "not materialized yet". A path
        // outside every root means we were handed a directory we must never move,
        // so that refusal is final: falling through to the computed layers could
        // mask a backend bug, and the failure is worth its own code.
        const outside = await isOutsideEveryRoot(roots, dir);
        if (outside) {
          return {
            ok: false,
            code: "unsafe-location",
            message: `the session store reported a path outside every known root: ${dir}`,
            header
          };
        }
        // The located candidate is simply absent. That is *not* final: the stored
        // header's `cwd` can disagree with the on-disk project directory (a moved
        // or renamed workspace), and the scan layer finds the directory regardless.
        // Remember the guess for the final message and keep resolving.
        locatedMiss = dir;
      }
    } catch {
      /* fall through to the computed layers */
    }
  }

  // Layer 2: computed from the backend root and the stored workspace path.
  if (header !== undefined && typeof header.cwd === "string" && header.cwd.length > 0) {
    for (const root of roots) {
      let dir;
      try {
        dir = path.join(root, projectKey(header.cwd), encodeSegment(sessionId));
      } catch {
        continue;
      }
      const accepted = await acceptableDir(root, dir);
      if (accepted !== undefined) return { ok: true, dir: accepted, root, via: "root+encode", header };
    }
  }

  // Layer 3: scan one project-directory level for the encoded session id. The
  // encoded id is all we need, so this layer needs no header.
  let encoded;
  try {
    encoded = encodeSegment(sessionId);
  } catch {
    return { ok: false, code: "invalid-session-id", message: "session id cannot be encoded" };
  }
  for (const root of roots) {
    let projects;
    try {
      projects = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const accepted = await acceptableDir(root, path.join(root, project.name, encoded));
      if (accepted !== undefined) return { ok: true, dir: accepted, root, via: "scan", header };
    }
  }

  return {
    ok: false,
    code: "not-found",
    message:
      locatedMiss === undefined
        ? `no stored session directory for ${sessionId}`
        : `no session directory exists for ${sessionId} (the store named ${locatedMiss})`,
    header
  };
}

/**
 * What is still running for a session, in the shape the archive dialog uses.
 *
 * Reuses the Workspace registry's own capability seam rather than inventing one,
 * so this plugin reports exactly the work DSH itself would report.
 *
 * @param {object} ctx - host context carrying the waterfall.
 * @param {string} sessionId - the session to describe.
 * @returns {Promise<Array<{kind: string, items?: Array<{id: string, label?: string}>}>>} activity families.
 */
export async function describeActivity(ctx, sessionId) {
  try {
    const activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
    return Array.isArray(activity) ? activity : [];
  } catch (error) {
    ctx.logger?.warn?.(`session-trash: activity probe failed for ${sessionId}: ${String(error)}`);
    return [];
  }
}

/**
 * Whether the session is resident in this process (a runtime may still hold a
 * write handle for it).
 *
 * Moving a resident session's directory is refused: the runtime would recreate
 * the directory on its next flush and leave a split, partial log behind. See the
 * README's data-safety section.
 *
 * @param {object} ctx - host context carrying the sessions registry.
 * @param {string} sessionId - the session to test.
 * @returns {boolean} true when the session is resident.
 */
export function isResident(ctx, sessionId) {
  try {
    return ctx.get("sessions")?.get(sessionId) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Wait, briefly, for a session to stop being resident.
 *
 * Used after the caller has released its own reference (for example by
 * navigating away), so deleting the session a user is looking at can still
 * succeed without ever moving a directory a live writer still owns.
 *
 * @param {object} ctx - host context carrying the sessions registry.
 * @param {string} sessionId - the session to wait for.
 * @param {number} timeoutMs - how long to wait; `0` checks once.
 * @param {number} [intervalMs] - poll interval.
 * @returns {Promise<boolean>} true once the session is no longer resident.
 */
export async function waitForRelease(ctx, sessionId, timeoutMs, intervalMs = 100) {
  if (!isResident(ctx, sessionId)) return true;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    if (!isResident(ctx, sessionId)) return true;
  }
  return !isResident(ctx, sessionId);
}
