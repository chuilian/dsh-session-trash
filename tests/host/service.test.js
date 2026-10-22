/**
 * Service-layer tests: the safety rules, the accounting cleanup, and the audit
 * trail. These are the tests that matter most, because this layer decides
 * whether a delete is allowed to touch the filesystem at all.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SessionTrashService } from "../../lib/host/service.js";
import { TrashStore } from "../../lib/host/trash-store.js";
import {
  SESSION_A,
  SESSION_B,
  fakeCtx,
  fakePersistence,
  fakeSessions,
  fakeWorkspaceRegistry,
  recordingLogger,
  seedSession,
  tempDir
} from "./helpers.js";

/** A path-safe session id with no directory anywhere: the clear-only case. */
const MISSING_SESSION = "session-99999999-9999-9999-9999-999999999999";

/**
 * Build a service over a temp session store.
 *
 * @param {import("node:test").TestContext} t - test context.
 * @param {object} [options] - overrides.
 * @returns {Promise<object>} the service, ctx, store and paths.
 */
async function fixture(t, options = {}) {
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  const cwd = "/tmp/project";
  const sessionCwd = new Map([
    [SESSION_A, cwd],
    [SESSION_B, cwd]
  ]);
  await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_A, contents: "a".repeat(64) });
  await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_B, contents: "b".repeat(32) });
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd, exposeLocate: options.exposeLocate !== false });
  const registry = fakeWorkspaceRegistry({
    archived: options.archived ?? [],
    pinned: options.pinned ?? [],
    workspaces: options.workspaces ?? [{ path: cwd, sessionIds: [SESSION_A, SESSION_B] }]
  });
  const logger = recordingLogger();
  const ctx = fakeCtx(
    {
      sessionPersistence: persistence,
      workspaceRegistry: registry,
      sessions: fakeSessions(options.resident ?? []),
      ...(options.sessionController === undefined ? {} : { sessionController: options.sessionController })
    },
    { logger, waterfall: options.waterfall }
  );
  const store = new TrashStore({ root: path.join(root, "bin"), logger });
  const service = new SessionTrashService(ctx, { store });
  return { service, ctx, store, registry, logger, root, sessionRoot, cwd, sessions: ctx.get("sessions") };
}

test("status reports the bin root and capability flags", async (t) => {
  const { service } = await fixture(t);
  const status = await service.status({ retentionDays: 30 });
  assert.equal(typeof status.root, "string");
  assert.equal(status.count, 0);
  assert.equal(status.canDelete, true);
  assert.equal(status.hasWorkspaceRegistry, true);
  assert.equal(status.retentionDays, 30);
});

test("plan describes a quiet session as deletable and sizes it when asked", async (t) => {
  const { service } = await fixture(t);
  const [plan] = await service.plan([SESSION_A], { sizes: true });
  assert.equal(plan.sessionId, SESSION_A);
  assert.equal(plan.deletable, true);
  assert.equal(plan.exists, true);
  assert.equal(plan.resident, false);
  assert.equal(plan.running, false);
  assert.deepEqual(plan.activity, []);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.bytes, 64);
  assert.equal(plan.cwd, "/tmp/project");
  assert.equal(plan.via, "locate");
});

test("plan does not walk directories for a size nobody renders", async (t) => {
  // Sizing every session means a full recursive walk each, on every dialog open,
  // for a number the delete dialog never shows. Off by default; the rest of the
  // plan is identical.
  const { service } = await fixture(t);
  const [plan] = await service.plan([SESSION_A]);
  assert.equal(plan.deletable, true);
  assert.equal(plan.bytes, 0);
});

test("plan reports blocked reasons for a running session", async (t) => {
  const { service } = await fixture(t, {
    resident: [SESSION_A],
    waterfall: () => [{ kind: "turn" }, { kind: "job", items: [{ id: "j1", label: "build" }] }]
  });
  const [plan] = await service.plan([SESSION_A]);
  assert.equal(plan.deletable, true);
  assert.equal(plan.resident, true);
  assert.deepEqual(plan.blockers, ["session-live", "session-active"]);
  assert.equal(plan.activity.length, 2);
});

test("plan reports an unsafe id and a missing session without throwing", async (t) => {
  const { service } = await fixture(t);
  const plans = await service.plan(["../../etc", "session-99999999-9999-9999-9999-999999999999"]);
  assert.equal(plans[0].code, "invalid-session-id");
  assert.equal(plans[0].deletable, false);
  assert.equal(plans[1].code, "not-found");
  assert.equal(plans[1].deletable, false);
  // An unusual but path-safe id is a real id, not a rejected one.
  const [odd] = await service.plan(["notes"]);
  assert.equal(odd.code, "not-found", "a valid-shaped id with no directory is merely missing");
});

test("delete refuses a running session unless the caller opts in", async (t) => {
  const { service, store } = await fixture(t, { waterfall: () => [{ kind: "turn" }] });
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A] });
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.results[0].code, "session-active");
  assert.deepEqual(outcome.results[0].activity, [{ kind: "turn" }]);
  assert.deepEqual(await store.list(), [], "a refused delete must not touch the bin");
});

test("delete refuses a resident session even when work has stopped", async (t) => {
  const { service, store } = await fixture(t, { resident: [SESSION_A] });
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A] });
  assert.equal(outcome.results[0].code, "session-live");
  assert.deepEqual(await store.list(), []);
});

test("delete with consent stops the work, waits for release, then moves the session", async (t) => {
  const { service, registry, store, sessions } = await fixture(t, {
    resident: [SESSION_A],
    waterfall: () => [{ kind: "turn" }]
  });
  // Simulate the client navigating away: the session leaves memory shortly after.
  const timer = setTimeout(() => sessions.live.delete(SESSION_A), 30);
  t.after(() => clearTimeout(timer));
  const outcome = await service.deleteSessions({
    sessionIds: [SESSION_A],
    stopActivity: true,
    waitForReleaseMs: 2000,
    titles: [{ sessionId: SESSION_A, title: "My session" }]
  });
  assert.equal(outcome.deleted, 1, JSON.stringify(outcome.results));
  // Stopping goes through the registry's own capability seam, which is what the
  // archive flow uses, rather than re-implementing a stop here.
  assert.deepEqual(
    registry.calls.filter((call) => call.op === "stop"),
    [{ op: "stop", sessionId: SESSION_A }]
  );
  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "My session");
  assert.equal(items[0].sessionId, SESSION_A);
});

test("delete refuses when the session never leaves memory", async (t) => {
  const { service, store } = await fixture(t, { resident: [SESSION_A] });
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A], stopActivity: true, waitForReleaseMs: 60 });
  assert.equal(outcome.results[0].code, "session-live");
  assert.deepEqual(await store.list(), []);
});

test("a quiet delete drops archive and pin but keeps the workspace link", async (t) => {
  const { service, registry, ctx } = await fixture(t, { archived: [SESSION_A], pinned: [SESSION_A] });
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A] });
  assert.equal(outcome.deleted, 1);
  assert.equal(outcome.results[0].forced, false);
  assert.equal(outcome.results[0].residue, false);
  assert.deepEqual(outcome.results[0].cleanup, []);
  const ops = registry.calls.map((call) => call.op).sort();
  assert.deepEqual(ops, ["unarchive", "unpin"], "no detach: see #cleanupAccounting");
  assert.deepEqual(registry.archivedSessionIds, []);
  assert.deepEqual(registry.pinnedSessionIds, []);
  // The workspace link stays, so a restore lands back in its own workspace and a
  // residue can never resurface in the ungrouped bucket.
  assert.deepEqual(registry.list()[0].sessionIds, [SESSION_A, SESSION_B]);
  // Other tabs learn the row is gone.
  assert.deepEqual(ctx.emitted.filter((row) => row.event === "api-session/removed"), [
    { event: "api-session/removed", args: [SESSION_A] }
  ]);
});

test("the accounting cleanup is a no-op when the sets are already in order", async (t) => {
  const { service, registry } = await fixture(t, { workspaces: [] });
  await service.deleteSessions({ sessionIds: [SESSION_A] });
  // The archive and pin drops are unconditional (a no-op when absent); there is no
  // detach step at all, so no workspace is consulted.
  assert.deepEqual(
    registry.calls.map((call) => call.op).sort(),
    ["unarchive", "unpin"]
  );
  assert.deepEqual(registry.archivedSessionIds, []);
  assert.deepEqual(registry.pinnedSessionIds, []);
});

test("a cleanup failure is reported without turning the delete into a failure", async (t) => {
  const { service, registry } = await fixture(t, { archived: [SESSION_A] });
  registry.unarchiveSession = async () => {
    throw new Error("registry offline");
  };
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A] });
  assert.equal(outcome.deleted, 1);
  assert.equal(outcome.results[0].ok, true);
  assert.deepEqual(outcome.results[0].cleanup, ["unarchive"]);
});

test("a batch reports per-session outcomes instead of failing wholesale", async (t) => {
  const { service, store, ctx } = await fixture(t, {
    waterfall: ({ sessionId }) => (sessionId === SESSION_B ? [{ kind: "turn" }] : [])
  });
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A, SESSION_B, "../../etc"] });
  assert.equal(outcome.deleted, 1);
  assert.equal(outcome.failed, 2);
  assert.equal(outcome.results[0].ok, true);
  assert.equal(outcome.results[1].code, "session-active");
  assert.equal(outcome.results[2].code, "invalid-session-id");
  assert.equal((await store.list()).length, 1);
  assert.equal(ctx.emitted.length, 1);
});

test("every refusal is written to the audit log", async (t) => {
  const { service, store } = await fixture(t, { waterfall: () => [{ kind: "turn" }] });
  await service.deleteSessions({ sessionIds: [SESSION_A] });
  await service.deleteSessions({ sessionIds: ["../../etc"] });
  const records = await store.readLog();
  const refusals = records.filter((row) => row.op === "delete" && row.outcome === "refused");
  assert.equal(refusals.length, 2);
  assert.deepEqual(
    refusals.map((row) => row.code).sort(),
    ["invalid-session-id", "session-active"]
  );
  assert.equal(typeof refusals[0].tsIso, "string");
  assert.equal(typeof refusals[0].pid, "number");
});

test("restore brings a session back and announces it", async (t) => {
  const { service, store, sessionRoot, cwd } = await fixture(t, {
    sessionController: {
      listState: {
        list: async () => [{ sessionId: SESSION_A, updatedAt: 1, running: false, blank: false, cwd }]
      }
    }
  });
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  const outcome = await service.restoreSessions({ trashIds: [item.trashId] });
  assert.equal(outcome.restored, 1);
  assert.equal(outcome.results[0].announced, true);
  assert.equal((await store.list()).length, 0);
  assert.equal((await service.list()).items.length, 0);
});

test("restore reports an occupied original path as a failure for that item only", async (t) => {
  const { service, store, sessionRoot } = await fixture(t);
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  await seedSession({ root: sessionRoot, cwd: "/tmp/project", sessionId: SESSION_A });
  const outcome = await service.restoreSessions({ trashIds: [item.trashId] });
  assert.equal(outcome.restored, 0);
  assert.equal(outcome.results[0].code, "occupied");
  assert.equal((await store.list()).length, 1, "the bin item survives a refused restore");
});

test("purge requires an explicit acknowledgement", async (t) => {
  const { service, store, sessionRoot } = await fixture(t);
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  const refused = await service.purgeSessions({ trashIds: [item.trashId] });
  assert.equal(refused.refused, true);
  assert.equal(refused.code, "not-acknowledged");
  assert.equal((await store.list()).length, 1, "a refused purge must erase nothing");

  const purged = await service.purgeSessions({ trashIds: [item.trashId], acknowledge: true });
  assert.equal(purged.purged, 1);
  assert.ok(purged.freedBytes > 0);
  assert.equal((await store.list()).length, 0);
});

test("purge accepts the all-items sentinel only with acknowledgement", async (t) => {
  const { service, store, sessionRoot } = await fixture(t);
  await store.trash({ sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A), sessionId: SESSION_A });
  await store.trash({ sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_B), sessionId: SESSION_B });
  const outcome = await service.purgeSessions({ trashIds: ["*"], acknowledge: true });
  assert.equal(outcome.purged, 2);
  assert.equal((await store.list()).length, 0);
});

test("list separates restorable items from broken ones", async (t) => {
  const { service, store, sessionRoot } = await fixture(t);
  const { item } = await store.trash({
    sourceDir: path.join(sessionRoot, "--tmp-project--", SESSION_A),
    sessionId: SESSION_A
  });
  await fs.rm(path.join(store.itemDir(item.trashId), "payload"), { recursive: true, force: true });
  const listing = await service.list();
  assert.equal(listing.items.length, 0);
  assert.equal(listing.broken.length, 1);
  assert.equal(listing.broken[0].state, "failed");
  assert.equal(listing.stats.brokenCount, 1);
});

test("a delete of a missing session clears the row instead of refusing", async (t) => {
  const { service, registry, store } = await fixture(t);
  const outcome = await service.deleteSessions({ sessionIds: ["session-99999999-9999-9999-9999-999999999999"] });
  assert.equal(outcome.deleted, 1, JSON.stringify(outcome.results));
  assert.equal(outcome.results[0].ok, true);
  assert.equal(outcome.results[0].cleaned, true, "the caller must be able to say it was cleared, not trashed");
  assert.equal(outcome.results[0].trashId, null, "nothing moved, so there is no bin item and no undo target");
  // Nothing to move and nothing to hide: a non-resident row is already unlistable.
  assert.deepEqual(registry.calls, []);
  assert.deepEqual(await store.list(), []);
  const records = await store.readLog();
  assert.ok(
    records.some((row) => row.op === "delete" && row.outcome === "cleared"),
    "a clear is audited, not silent"
  );
});

test("a delete of a fileless resident session hides it and tells clients it left", async (t) => {
  // The live case: DSH keeps listing a session whose files are gone, so clearing it
  // must hide it as well as emit the removal, or the row comes straight back.
  const { service, ctx, registry, store } = await fixture(t, { resident: [MISSING_SESSION] });
  const outcome = await service.deleteSessions({ sessionIds: [MISSING_SESSION], stopActivity: true });
  assert.equal(outcome.results[0].ok, true, JSON.stringify(outcome.results));
  assert.equal(outcome.results[0].cleaned, true);
  assert.deepEqual(registry.archivedSessionIds, [MISSING_SESSION], "a live fileless row is hidden by archiving it");
  assert.ok(
    ctx.emitted.some((row) => row.event === "api-session/removed" && row.args[0] === MISSING_SESSION),
    "every client is told the row is gone"
  );
  assert.deepEqual(await store.list(), []);
});

test("a fileless session still needs consent before it is cleared", async (t) => {
  // Same gate as a real delete: nothing is stopped or hidden behind the user's back.
  const { service, registry, ctx } = await fixture(t, { resident: [MISSING_SESSION] });
  const outcome = await service.deleteSessions({ sessionIds: [MISSING_SESSION] });
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].code, "session-live");
  assert.deepEqual(registry.calls, []);
  assert.deepEqual(ctx.emitted, []);
});

test("without a persistence service the service reports nothing to delete", async (t) => {
  const { service } = await fixture(t);
  // Point the service at a context whose persistence is absent. The sessions
  // registry stays: a missing one cannot rule residency out, so the probe would
  // fail closed and ask for the stop consent.
  const bare = new SessionTrashService(fakeCtx({ sessions: fakeSessions([]) }), { store: service.store });
  const status = await bare.status();
  assert.equal(status.canDelete, false);
  const outcome = await bare.deleteSessions({ sessionIds: [SESSION_A] });
  assert.equal(outcome.results[0].ok, true);
  assert.equal(outcome.results[0].cleaned, true, "with no store to search, the row can only be cleared");
});
test("one session throwing mid-batch does not discard the verdicts already reached", async (t) => {
  // The store can throw (a filesystem error it did not turn into a verdict). If
  // that rejects the whole batch, the sessions already in the bin lose their ids
  // and with them the undo that is the user's only way back.
  const { service, store, ctx } = await fixture(t);
  const original = store.trash.bind(store);
  store.trash = async (options) => {
    if (options.sessionId === SESSION_B) throw new Error("disk exploded");
    return await original(options);
  };
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A, SESSION_B] });
  assert.equal(outcome.deleted, 1, JSON.stringify(outcome.results));
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.results[0].ok, true);
  assert.ok(typeof outcome.results[0].trashId === "string", "the successful move still reports its bin id");
  assert.equal(outcome.results[1].ok, false);
  assert.equal(outcome.results[1].code, "internal");
  assert.match(outcome.results[1].message, /disk exploded/);
  assert.equal((await store.list()).length, 1, "the first session really is in the bin");
  assert.ok(ctx.logger.lines.some((line) => /deleting .* failed/.test(String(line))));
});

test("plan keeps the request order while inspecting several at once", async (t) => {
  const { service } = await fixture(t);
  const ids = [SESSION_B, SESSION_A];
  const plans = await service.plan(ids);
  assert.deepEqual(plans.map((plan) => plan.sessionId), ids);
  assert.equal(plans[0].deletable, true);
  assert.equal(plans[1].deletable, true);
});
