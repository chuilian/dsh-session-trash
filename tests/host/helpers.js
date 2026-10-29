/**
 * Shared test scaffolding for the host half.
 *
 * The host half talks to DSH only through `ctx.get(name)` plus a handful of
 * events, so a small fake context keeps the tests free of Cordis and of any
 * installed DSH package.
 *
 * @module dsh-session-trash/tests/host/helpers
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { encodeSegment, projectKey } from "../../lib/host/encode.js";

/**
 * A recording logger.
 * @returns {{info: Function, warn: Function, error: Function, debug: Function, lines: string[]}} logger.
 */
export function recordingLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level}: ${String(message)}`);
  return { info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug"), lines };
}

/**
 * A minimal host context.
 *
 * @param {object} [services] - services by name.
 * @param {object} [options] - extra wiring.
 * @returns {object} a fake context.
 */
export function fakeCtx(services = {}, options = {}) {
  const logger = options.logger ?? recordingLogger();
  const emitted = [];
  const stopped = [];
  const ctx = {
    logger,
    emitted,
    stopped,
    get(name) {
      return services[name];
    },
    emit(event, ...args) {
      emitted.push({ event, args });
    },
    async waterfall(_event, payload, fallback) {
      const handler = options.waterfall;
      if (handler === undefined) return fallback();
      return handler(payload, fallback);
    },
    async parallel(event, payload) {
      stopped.push({ event, sessionId: payload?.sessionId });
      options.onParallel?.(payload);
    }
  };
  // Cordis exposes services both through ctx.get(name) and as ctx.<name>, and
  // the service layer uses whichever reads better, so the fake offers both.
  for (const [name, value] of Object.entries(services)) if (!(name in ctx)) ctx[name] = value;
  return ctx;
}

/**
 * A fake workspace registry recording the accounting cleanup the service asks for.
 *
 * @param {object} [options] - initial durable sets.
 * @returns {object} the fake registry plus its recorded calls.
 */
export function fakeWorkspaceRegistry({ archived = [], pinned = [], workspaces = [] } = {}) {
  const calls = [];
  const entities = workspaces.map((entry) => ({
    path: entry.path,
    sessionIds: [...entry.sessionIds],
    async detachSession(sessionId) {
      calls.push({ op: "detach", sessionId, workspace: entry.path });
      this.sessionIds = this.sessionIds.filter((id) => id !== sessionId);
    },
    async attachSession(sessionId) {
      calls.push({ op: "attach", sessionId, workspace: entry.path });
      if (!this.sessionIds.includes(sessionId)) this.sessionIds = [...this.sessionIds, sessionId];
    }
  }));
  return {
    archivedSessionIds: [...archived],
    pinnedSessionIds: [...pinned],
    calls,
    list() {
      return entities;
    },
    async unarchiveSession(sessionId) {
      calls.push({ op: "unarchive", sessionId });
      this.archivedSessionIds = this.archivedSessionIds.filter((id) => id !== sessionId);
    },
    async archiveSession(sessionId) {
      calls.push({ op: "archive", sessionId });
      if (!this.archivedSessionIds.includes(sessionId)) this.archivedSessionIds = [...this.archivedSessionIds, sessionId];
    },
    async unpinSession(sessionId) {
      calls.push({ op: "unpin", sessionId });
      this.pinnedSessionIds = this.pinnedSessionIds.filter((id) => id !== sessionId);
    },
    async pinSession(sessionId) {
      calls.push({ op: "pin", sessionId });
      if (!this.pinnedSessionIds.includes(sessionId)) this.pinnedSessionIds = [sessionId, ...this.pinnedSessionIds];
    },
    async stopSessionActivity(sessionId) {
      calls.push({ op: "stop", sessionId });
    }
  };
}

/**
 * A fake `sessions` registry; ids listed in `resident` are reported as live.
 *
 * It mirrors the shape the host's live registry really has: a `store` map whose
 * entries own a `detach()` disposer, and a `get()` that reports the session
 * itself. Calling `detach()` is what removes the entry from the live set, which
 * is how the plugin's release path is exercised.
 *
 * @param {string[]} [resident] - ids that are resident in this process.
 * @returns {object} the fake registry.
 */
export function fakeSessions(resident = []) {
  const live = new Set(resident);
  const store = new Map();
  /** Recording of flush/detach order, so a test can assert the barrier runs first. */
  const order = [];
  for (const id of resident) {
    const entry = {
      id,
      session: { id },
      detach() {
        // The host's own detach is idempotent: a second call finds no entry.
        if (store.get(id) !== entry) return;
        order.push(`detach:${id}`);
        store.delete(id);
        live.delete(id);
      }
    };
    store.set(id, entry);
  }
  return {
    live,
    store,
    order,
    get(id) {
      return live.has(id) ? { id } : undefined;
    },
    async flush(session) {
      // Mirrors `SessionStore.flush`: it requires the session to still be live.
      if (store.get(session?.id) === undefined) throw new Error(`session "${session?.id}" is not live in this store`);
      order.push(`flush:${session.id}`);
      return true;
    }
  };
}

/**
 * A fake `sessionPersistence` exposing only what the plugin uses, over a real
 * temp directory so the filesystem behaviour is genuine.
 *
 * @param {object} options - construction options.
 * @param {string} options.root - session store root.
 * @param {Map<string, string>} options.sessionCwd - session id → workspace path.
 * @param {boolean} [options.exposeLocate] - whether `locate()` is available.
 * @returns {object} the fake service.
 */
export function fakePersistence({ root, sessionCwd, exposeLocate = true }) {
  const service = {
    root,
    async stat(sessionId) {
      const cwd = sessionCwd.get(sessionId);
      if (cwd === undefined) return undefined;
      return { header: { id: sessionId, cwd, createdAt: 0, type: "session" } };
    },
    async list() {
      return [...sessionCwd.keys()];
    }
  };
  if (exposeLocate) {
    // Mirrors the shipped backend: `<root>/<projectKey>/<encodeSegment(id)>/session.v4.jsonl.zstd`.
    service.locate = (header) => ({
      kind: "jsonl",
      path: path.join(root, projectKey(header.cwd), encodeSegment(header.id), "session.v4.jsonl.zstd")
    });
  }
  return service;
}

/**
 * Create an isolated temp directory that is removed afterwards.
 *
 * @param {import("node:test").TestContext} t - the running test's context.
 * @param {string} [prefix] - directory prefix.
 * @returns {Promise<string>} absolute temp directory.
 */
export async function tempDir(t, prefix = "session-trash-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Materialize a session directory the way the JSONL backend would.
 *
 * @param {object} options - what to create.
 * @param {string} options.root - session store root.
 * @param {string} options.cwd - owning workspace path.
 * @param {string} options.sessionId - session id.
 * @param {string} [options.contents] - log contents.
 * @returns {Promise<string>} the created session directory.
 */
export async function seedSession({ root, cwd, sessionId, contents = "v4-header\n" }) {
  const dir = path.join(root, projectKey(cwd), encodeSegment(sessionId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "session.v4.jsonl.zstd"), contents);
  await fs.writeFile(path.join(dir, "session.lock"), "");
  return dir;
}

/** A representative session id. */
export const SESSION_A = "session-11111111-2222-3333-4444-555555555555";
/** A second representative session id. */
export const SESSION_B = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
