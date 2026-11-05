/**
 * Restore-and-revive tests.
 *
 * A restore that only moves the files back leaves a session that is on disk but
 * has no agent behind it: the host released it when the session was deleted, and
 * nothing recreates that entry on its own. These tests pin the revive step that
 * asks the host to resume the session, and the reporting around it.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { SessionTrashService } from "../../lib/host/service.js";
import { TrashStore } from "../../lib/host/trash-store.js";
import {
  SESSION_A,
  fakeCtx,
  fakePersistence,
  fakeSessions,
  fakeWorkspaceRegistry,
  recordingLogger,
  seedSession,
  tempDir
} from "./helpers.js";

/** The workspace path the fixture session belongs to. */
const CWD = "/tmp/project";

/**
 * Build a service over a temp session store.
 *
 * @param {import("node:test").TestContext} t - test context.
 * @param {object} [options] - overrides.
 * @returns {Promise<object>} the service, store and paths.
 */
async function fixture(t, options = {}) {
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  const cwd = CWD;
  const sessionCwd = new Map([[SESSION_A, cwd]]);
  await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_A, contents: "a".repeat(64) });
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd });
  const registry = fakeWorkspaceRegistry({ workspaces: [{ path: cwd, sessionIds: [SESSION_A] }] });
  const logger = recordingLogger();
  const ctx = fakeCtx(
    {
      sessionPersistence: persistence,
      workspaceRegistry: registry,
      sessions: fakeSessions(options.resident ?? []),
      ...(options.sessionController === undefined ? {} : { sessionController: options.sessionController })
    },
    { logger }
  );
  const store = new TrashStore({ root: path.join(root, "bin"), logger });
  const service = new SessionTrashService(ctx, { store, reviveTimeoutMs: options.reviveTimeoutMs ?? 8_000 });
  return { service, store, ctx, sessionRoot, cwd };
}

/**
 * A session controller whose list reports the restored session as a live row.
 *
 * @param {string} cwd - the workspace path.
 * @returns {object} the controller.
 */
function listingController(cwd) {
  return {
    listState: {
      list: async () => [{ sessionId: SESSION_A, updatedAt: 1, running: false, blank: false, cwd }]
    }
  };
}

test("a restore resumes the session, so it can be talked to again", async (t) => {
  const resumed = [];
  const { service, store, sessionRoot } = await fixture(t, {
    sessionController: {
      ...listingController(CWD),
      resolveAgent: async (sessionId) => {
        resumed.push(sessionId);
        return { agent: { id: sessionId } };
      }
    }
  });
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  const outcome = await service.restoreSessions({ trashIds: [item.trashId] });
  assert.equal(outcome.restored, 1);
  assert.deepEqual(resumed, [SESSION_A], "the host was asked to bring the session back");
  assert.equal(outcome.results[0].revived, true);
  assert.equal(outcome.results[0].reviveCode, "resumed");
});

test("a resume that fails is reported, and the restore still counts", async (t) => {
  const { service, store, sessionRoot } = await fixture(t, {
    sessionController: {
      ...listingController(CWD),
      resolveAgent: async () => ({ error: new Error("no agent for you") })
    }
  });
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  const outcome = await service.restoreSessions({ trashIds: [item.trashId] });
  assert.equal(outcome.restored, 1, "the files are back, so the restore itself succeeded");
  assert.equal(outcome.results[0].revived, false);
  assert.equal(outcome.results[0].reviveCode, "resume-failed");
  assert.match(outcome.results[0].reviveMessage, /no agent for you/);
});

test("a resume that never settles does not hold the restore hostage", async (t) => {
  const { service, store, sessionRoot } = await fixture(t, {
    reviveTimeoutMs: 40,
    sessionController: {
      ...listingController(CWD),
      resolveAgent: () => new Promise(() => {})
    }
  });
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  const outcome = await service.restoreSessions({ trashIds: [item.trashId] });
  assert.equal(outcome.restored, 1);
  assert.equal(outcome.results[0].revived, false);
  assert.match(outcome.results[0].reviveMessage, /timed out/);
});

test("a session that is still resident is not resumed again", async (t) => {
  let calls = 0;
  const { service, store, sessionRoot } = await fixture(t, {
    resident: [SESSION_A],
    sessionController: {
      ...listingController(CWD),
      resolveAgent: async () => {
        calls += 1;
        return { agent: {} };
      }
    }
  });
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  const outcome = await service.restoreSessions({ trashIds: [item.trashId] });
  assert.equal(calls, 0, "a live session is not resumed a second time");
  assert.equal(outcome.results[0].revived, true);
  assert.equal(outcome.results[0].reviveCode, "already-live");
});

test("a host without a resume API restores the files and says so", async (t) => {
  const { service, store, sessionRoot } = await fixture(t, {
    sessionController: listingController(CWD)
  });
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  const outcome = await service.restoreSessions({ trashIds: [item.trashId] });
  assert.equal(outcome.restored, 1);
  assert.equal(outcome.results[0].revived, false);
  assert.equal(outcome.results[0].reviveCode, "no-resume-api");
});

test("the revive outcome is written to the audit log", async (t) => {
  const { service, store, sessionRoot } = await fixture(t, {
    sessionController: {
      ...listingController(CWD),
      resolveAgent: async () => ({ error: new Error("nope") })
    }
  });
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  await service.restoreSessions({ trashIds: [item.trashId] });
  const records = await store.readLog();
  const revived = records.filter((row) => row.op === "restore-revive");
  assert.equal(revived.length, 1);
  assert.equal(revived[0].outcome, "failed");
  assert.equal(revived[0].sessionId, SESSION_A);
  assert.equal(revived[0].code, "resume-failed");
});
