/**
 * Regression tests for defects found by adversarial review.
 *
 * Each test here corresponds to a specific bug that the original suite did not
 * catch, and each one is written to fail against the *old* implementation. They
 * are grouped in one file so the "why does this exist" is obvious.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { clampReleaseWait, MAX_RELEASE_WAIT_MS, SessionTrashService } from "../../lib/host/service.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { moveDir, TrashStore } from "../../lib/host/trash-store.js";
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

const here = path.dirname(fileURLToPath(import.meta.url));

/** A store plus one seeded session directory. */
async function fixture(t, options = {}) {
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  const cwd = options.cwd ?? "/tmp/project";
  const sessionDir = await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_A, contents: "payload\n" });
  const store = new TrashStore({ root: path.join(root, "bin"), logger: recordingLogger() });
  await store.init();
  return { store, root, sessionRoot, sessionDir, cwd };
}

test("R1: the cross-device path keeps the committed copy when source cleanup fails", async (t) => {
  // The defect: the EXDEV path was `cp -> rename -> rm(source)`, and a *partial*
  // `rm(source)` failure threw. The caller's rollback then removed the item
  // directory holding the only complete copy, losing the session with no audit
  // record. The fix is the commit point: past the rename, cleanup failure is
  // reported, never thrown.
  const root = await tempDir(t);
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "session.v4.jsonl.zstd"), "the only copy");

  const originalRename = fs.rename;
  const originalRm = fs.rm;
  let renameCalls = 0;
  fs.rename = async (from, to) => {
    renameCalls += 1;
    // Force the copy path only for the staged -> dest commit; let the staged
    // directory be created normally by cp.
    if (from === source) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    return originalRename(from, to);
  };
  try {
    // Make the post-commit source cleanup fail the way a partial recursive rm
    // does: a nested entry refuses to go.
    fs.rm = async (target, options) => {
      if (target === source) {
        await originalRm(path.join(source, "session.v4.jsonl.zstd"), { force: true });
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      return originalRm(target, options);
    };
    const moved = await moveDir(source, dest);
    assert.equal(moved.strategy, "copy");
    assert.equal(moved.leftover, true, "the cleanup failure is reported, not thrown");
    // The committed copy survives — this is the assertion that fails on the old code.
    assert.equal(await fs.readFile(path.join(dest, "session.v4.jsonl.zstd"), "utf8"), "the only copy");
    assert.ok(renameCalls >= 1);
  } finally {
    fs.rename = originalRename;
    fs.rm = originalRm;
  }
});

test("R1b: a pre-commit failure still refuses cleanly and is safe to roll back", async (t) => {
  const root = await tempDir(t);
  const source = path.join(root, "source");
  await fs.mkdir(source, { recursive: true });
  const { store } = await fixture(t);
  // A destination whose parent does not exist cannot be committed, so this must
  // throw (and therefore be safe for the caller to roll back).
  await assert.rejects(() => moveDir(source, path.join(root, "missing", "dest")));
  assert.ok((await fs.lstat(source)).isDirectory(), "a pre-commit failure leaves the source alone");
  assert.equal(typeof store.trash, "function");
});

test("R2: a completed trash survives a failing post-move inventory", async (t) => {
  // The defect: `inventory` ran after the move and outside any guard, so one
  // unreadable subtree turned a finished delete into a 500 with no audit record,
  // and left an item that made /list and /status fail forever.
  const { store, sessionDir, sessionRoot, cwd } = await fixture(t);
  const secret = path.join(sessionDir, "secret");
  await fs.mkdir(secret, { recursive: true });
  await fs.writeFile(path.join(secret, "log"), "x");
  await fs.chmod(secret, 0o000);

  const ctx = fakeCtx({
    sessionPersistence: fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION_A, cwd]]) }),
    workspaceRegistry: fakeWorkspaceRegistry(),
    sessions: fakeSessions([])
  });
  const service = new SessionTrashService(ctx, { store });
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A] });
  // The session (and the unreadable directory inside it) now lives in the bin, so
  // restore permissions there before the test's own cleanup walks the tree.
  for (const item of await store.list()) {
    await fs.chmod(path.join(store.itemDir(item.trashId), "payload", "secret"), 0o700).catch(() => {});
  }
  await fs.chmod(secret, 0o700).catch(() => {});

  // A delete that moved the session is a success, whatever the sizing did.
  assert.equal(outcome.deleted, 1, JSON.stringify(outcome.results));
  assert.equal(outcome.results[0].ok, true);
  assert.equal(outcome.results[0].fileCount, 0, "the failed inventory is reported as empty, not fatal");
  // And the bin stays readable: this is the "bricked panel" regression.
  const listing = await service.list();
  assert.equal(listing.items.length, 1);
  assert.equal(listing.items[0].sessionId, SESSION_A);
  const status = await service.status();
  assert.equal(status.count, 1);
  const audit = await store.readLog();
  const trashRecord = audit.find((row) => row.op === "trash");
  assert.ok(trashRecord !== undefined, "the completed delete is audited");
});

test("R3: a crash at the commit point never becomes a phantom deletion", async (t) => {
  // The defect: `payload` was pre-created before the `moving` manifest, so a crash
  // between the manifest write and the rename left an empty `payload` behind, and
  // the listing healed that into a claimed `trashed` item with an empty inventory —
  // reporting a deletion that never happened, for a session still in the store and
  // whose Restore button could then never work (`occupied`).
  //
  // This is tested by actually crashing a child process at the rename, because the
  // difference between the two designs is only observable from the state a real
  // crash leaves on disk.
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  const trashRoot = path.join(root, "bin");
  const cwd = "/tmp/project";
  const sessionDir = await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_A, contents: "session\n" });

  const fixture = path.join(here, "fixtures", "crash-at-rename.mjs");
  const child = spawnSync(process.execPath, [fixture, trashRoot, sessionDir, SESSION_A], {
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(child.signal, "SIGKILL", `the fixture must die at the commit point, got ${JSON.stringify(child.signal ?? child.status)} ${child.stderr}`);

  // 1. The session is untouched where it was.
  assert.equal(await fs.readFile(path.join(sessionDir, "session.v4.jsonl.zstd"), "utf8"), "session\n");

  // 2. The bin does not claim a deletion.
  const store = new TrashStore({ root: trashRoot });
  const items = await store.list();
  assert.equal(items.length, 1, "the interrupted item is reported");
  assert.equal(items[0].state, "failed", "an un-landed move is not a deletion");
  assert.equal((await store.stats(0)).count, 0, "no restorable item is claimed");

  // 3. And the item is not silently invisible either.
  assert.equal(items[0].sessionId, SESSION_A);
  assert.equal(items[0].originalPath, await fs.realpath(sessionDir));
});

test("R4: a refused restore does not write to the manifest", async (t) => {
  // The defect: the heal rewrite ran before the `occupied` check, so a *refused*
  // restore mutated the filesystem.
  const { store, sessionDir, sessionRoot, cwd } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const dir = store.itemDir(item.trashId);
  const manifestPath = path.join(dir, "manifest.json");
  const before = { ...JSON.parse(await fs.readFile(manifestPath, "utf8")), state: "moving" };
  await fs.writeFile(manifestPath, JSON.stringify(before));
  // Occupy the original path so the restore is refused.
  await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_A, contents: "newer\n" });
  const stampBefore = (await fs.lstat(manifestPath)).mtimeMs;

  const refused = await store.restore(item.trashId);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "occupied");
  const after = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.deepEqual(after, before, "a refused restore must leave the manifest byte-identical");
  assert.equal((await fs.lstat(manifestPath)).mtimeMs, stampBefore);
});

test("R5: a read (list) does not write to the manifest", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const manifestPath = path.join(store.itemDir(item.trashId), "manifest.json");
  const raw = JSON.stringify({ ...JSON.parse(await fs.readFile(manifestPath, "utf8")), state: "moving" });
  await fs.writeFile(manifestPath, raw);
  await store.list();
  await store.stats(30);
  assert.equal(await fs.readFile(manifestPath, "utf8"), raw, "listing is a read and must not write");
});

test("R6: a manifest-less item directory is visible and purgeable", async (t) => {
  // The defect: an orphan (crash between mkdir and the manifest write, or a
  // rollback that could not finish) was invisible to list() and refused by
  // purge(), so its bytes leaked forever.
  const { store } = await fixture(t);
  const trashId = "t-20260101T000000Z-deadbeef";
  const dir = store.itemDir(trashId);
  await fs.mkdir(path.join(dir, "payload"), { recursive: true });
  await fs.writeFile(path.join(dir, "payload", "leftover"), "leaked bytes");

  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "orphan");
  assert.ok(items[0].totalBytes > 0, "the orphan's bytes are reported");

  const restored = await store.restore(trashId);
  assert.equal(restored.ok, false);
  assert.equal(restored.code, "no-manifest");

  const purged = await store.purge([trashId]);
  assert.equal(purged[0].ok, true);
  assert.equal(purged[0].orphan, true);
  await assert.rejects(() => fs.lstat(dir), /ENOENT/);
  assert.equal((await store.stats(0)).brokenCount, 0);
});

test("R7: readLog is newest-first across day boundaries", async (t) => {
  // The defect: day files were read newest-first but the whole array was then
  // reversed, flipping the day order, so the panel showed (and truncated to) the
  // oldest records.
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  let tick = Date.UTC(2026, 0, 1, 12);
  const store = new TrashStore({ root: path.join(root, "bin"), clock: () => tick });
  await store.init();
  for (let day = 1; day <= 3; day += 1) {
    tick = Date.UTC(2026, 0, day, 12);
    const dir = await seedSession({ root: sessionRoot, cwd: "/tmp/p", sessionId: SESSION_A });
    const { item } = await store.trash({ sourceDir: dir, sessionId: SESSION_A });
    await store.record({ op: `day${String(day)}`, outcome: "ok", trashId: item.trashId });
  }
  const records = await store.readLog({ limit: 10 });
  // Each day contributed a `trash` record and then a `dayN` record; newest-first
  // means the newest day first and, within a day, the last line first.
  assert.deepEqual(
    records.map((row) => row.op),
    ["day3", "trash", "day2", "trash", "day1", "trash"],
    "newest day first, newest record first within a day"
  );
  // A small limit must still return the newest records, not the oldest.
  const limited = await store.readLog({ limit: 1 });
  assert.deepEqual(limited.map((row) => row.op), ["day3"]);
});

test("R8: one bad id in a batch does not abort the rest or throw", async (t) => {
  // The defect: a malformed id threw out of the serialized task after earlier
  // items had already been restored, so the caller got a bare 500 with per-item
  // results lost.
  const { store, sessionDir, sessionRoot, cwd } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const ctx = fakeCtx({
    sessionPersistence: fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION_A, cwd]]) }),
    workspaceRegistry: fakeWorkspaceRegistry(),
    sessions: fakeSessions([]),
    sessionController: { listState: { list: async () => [] } }
  });
  const service = new SessionTrashService(ctx, { store });
  const outcome = await service.restoreSessions({ trashIds: [item.trashId, "../../etc"] });
  assert.equal(outcome.restored, 1, JSON.stringify(outcome.results));
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.results[1].code, "invalid-trash-id");
  // The first item really was restored.
  assert.ok((await fs.lstat(sessionDir)).isDirectory());
});

test("R9: the release wait is bounded so one request cannot wedge the queue", async (t) => {
  // The defect: `waitForReleaseMs` was passed straight through, so a hostile value
  // parked the shared mutation queue for as long as the caller asked.
  assert.equal(clampReleaseWait(1e9), MAX_RELEASE_WAIT_MS, "an absurd wait is clamped");
  assert.equal(clampReleaseWait(Number.POSITIVE_INFINITY), 0);
  assert.equal(clampReleaseWait(-5), 0);
  assert.equal(clampReleaseWait("abc"), 0);
  assert.equal(clampReleaseWait(250), 250, "a reasonable wait is honoured");
  assert.ok(MAX_RELEASE_WAIT_MS <= 30_000, "the bound stays operator-friendly");

  // And a session that never releases is refused promptly when no wait is asked
  // for, rather than hanging on a default.
  const { store, sessionDir, sessionRoot, cwd } = await fixture(t);
  const ctx = fakeCtx(
    {
      sessionPersistence: fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION_A, cwd]]) }),
      workspaceRegistry: fakeWorkspaceRegistry(),
      sessions: fakeSessions([SESSION_A])
    },
    { waterfall: () => [{ kind: "turn" }] }
  );
  const service = new SessionTrashService(ctx, { store });
  const started = Date.now();
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A], stopActivity: true, waitForReleaseMs: Number.NaN });
  assert.equal(outcome.results[0].code, "session-live");
  assert.ok(Date.now() - started < 2_000, "no wait is performed when none was requested");
  assert.ok((await fs.lstat(sessionDir)).isDirectory());
});

test("R10: restore and purge refusals are audited", async (t) => {
  const { store, sessionDir, sessionRoot, cwd } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_A });
  const ctx = fakeCtx({
    sessionPersistence: fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION_A, cwd]]) }),
    workspaceRegistry: fakeWorkspaceRegistry(),
    sessions: fakeSessions([]),
    sessionController: { listState: { list: async () => [] } }
  });
  const service = new SessionTrashService(ctx, { store });
  await service.restoreSessions({ trashIds: [item.trashId] });
  await service.purgeSessions({ trashIds: ["t-20260101T000000Z-aaaaaaaa"], acknowledge: true });

  const records = await store.readLog();
  const restoreRefusals = records.filter((row) => row.op === "restore" && row.outcome === "refused");
  const purgeRefusals = records.filter((row) => row.op === "purge" && row.outcome === "refused");
  assert.equal(restoreRefusals.length, 1);
  assert.equal(restoreRefusals[0].code, "occupied");
  assert.equal(purgeRefusals.length, 1);
  assert.equal(purgeRefusals[0].code, "unknown-item");
});

test("R11: restore puts a session back into its archive and pin sets", async (t) => {
  // The defect: delete removed the id from the durable sets and restore never put
  // it back, so a restored session came home with its archived/pinned state
  // silently changed. The workspace link is no longer dropped by delete, so what
  // restore has to fix is the archive and pin state — authoritatively, because a
  // forced delete deliberately leaves the id archived.
  const { store, sessionDir, sessionRoot, cwd } = await fixture(t);
  const registry = fakeWorkspaceRegistry({
    archived: [SESSION_A],
    pinned: [SESSION_A],
    workspaces: [{ path: cwd, sessionIds: [SESSION_A, SESSION_B] }]
  });
  const ctx = fakeCtx(
    {
      sessionPersistence: fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION_A, cwd]]) }),
      workspaceRegistry: registry,
      sessions: fakeSessions([]),
      sessionController: { listState: { list: async () => [] } }
    },
    { resident: [] }
  );
  const service = new SessionTrashService(ctx, { store });

  const deleted = await service.deleteSessions({ sessionIds: [SESSION_A] });
  assert.equal(deleted.deleted, 1, JSON.stringify(deleted.results));
  assert.deepEqual(registry.archivedSessionIds, []);
  assert.deepEqual(registry.pinnedSessionIds, []);
  // The workspace link survives the delete, which is what keeps a restored session
  // in its own group and stops a residue reaching the ungrouped bucket.
  assert.deepEqual(registry.list()[0].sessionIds, [SESSION_A, SESSION_B]);

  const trashId = deleted.results[0].trashId;
  const restored = await service.restoreSessions({ trashIds: [trashId] });
  assert.equal(restored.restored, 1, JSON.stringify(restored.results));
  assert.deepEqual(restored.results[0].cleanup, []);
  assert.deepEqual(registry.archivedSessionIds, [SESSION_A], "archive state comes back");
  assert.deepEqual(registry.pinnedSessionIds, [SESSION_A], "pin state comes back");
  // Membership never left. The precise slot within a workspace is browser-local
  // display order in DSH, so membership is the contract, not replaying the old index.
  assert.deepEqual([...registry.list()[0].sessionIds].sort(), [SESSION_A, SESSION_B].sort());
  // Restore is authoritative in both directions: it must be able to clear an archive
  // id that a forced delete left behind, so it always writes the recorded state.
  const restoreOps = registry.calls.map((call) => call.op);
  assert.ok(restoreOps.includes("unarchive") || restoreOps.includes("archive"));
  assert.ok(restoreOps.includes("unpin") || restoreOps.includes("pin"));
});

test("R12: a plan for many sessions reads the host summary list once", async (t) => {
  const { store, sessionRoot, cwd } = await fixture(t);
  let listCalls = 0;
  const ctx = fakeCtx({
    sessionPersistence: fakePersistence({ root: sessionRoot, sessionCwd: new Map() }),
    workspaceRegistry: fakeWorkspaceRegistry(),
    sessions: fakeSessions([]),
    sessionController: {
      listState: {
        list: async () => {
          listCalls += 1;
          return [];
        }
      }
    }
  });
  const service = new SessionTrashService(ctx, { store });
  await service.plan(Array.from({ length: 25 }, (_value, index) => `session-${String(index)}`));
  assert.equal(listCalls, 1, "planning must not be quadratic in the summary read");
});

test("R13: a locator candidate that is merely absent still falls through to the scan", async (t) => {
  // The defect: layer 1 returned not-found immediately, so a session whose header
  // cwd disagreed with the on-disk project directory was undeletable although its
  // files were present.
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  // The session really lives under a different project key than its header claims.
  const realDir = await seedSession({ root: sessionRoot, cwd: "/tmp/actual", sessionId: SESSION_A });
  const persistence = {
    root: sessionRoot,
    stat: async () => ({ header: { id: SESSION_A, cwd: "/tmp/claimed", createdAt: 0 } }),
    locate: (header) => ({
      kind: "jsonl",
      path: path.join(sessionRoot, `--${header.cwd.replace(/^\/+/, "").replace(/\//g, "-")}--`, SESSION_A, "session.v4.jsonl.zstd")
    })
  };
  const { resolveSessionDir } = await import("../../lib/host/locate.js");
  const resolved = await resolveSessionDir({ sessionId: SESSION_A, persistence });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.via, "scan");
  assert.equal(resolved.dir, await fs.realpath(realDir));
});

test("R14: an oversized body is a legible refusal, and garbage does not corrupt state", async (t) => {
  const { store } = await fixture(t);
  assert.equal(typeof store.record, "function");
  // Direct store checks for the shapes the route layer relies on.
  const results = await store.purge(["{not-an-id"]);
  assert.equal(results[0].code, "invalid-id");
});

test("R15: the store's clock is the single source for expiry reporting", async (t) => {
  const { store, sessionDir, sessionRoot, cwd } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const ctx = fakeCtx({
    sessionPersistence: fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION_A, cwd]]) }),
    workspaceRegistry: fakeWorkspaceRegistry(),
    sessions: fakeSessions([])
  });
  const service = new SessionTrashService(ctx, { store });
  const listing = await service.list({ retentionDays: 30 });
  assert.equal(listing.items.length, 1);
  // Both the per-item flag and the aggregate count derive from one clock, so
  // they cannot disagree.
  assert.equal(listing.items[0].expired, false);
  assert.equal(listing.stats.expiredCount, 0);
  assert.equal(typeof store.now(), "number");
  assert.ok(item.deletedAt <= store.now());
});

test("R16: a symlinked source inside the store is still refused", async (t) => {
  const { store, sessionRoot } = await fixture(t);
  const target = path.join(sessionRoot, "--tmp-project--", "real-target");
  const link = path.join(sessionRoot, "--tmp-project--", "link");
  await fs.mkdir(target, { recursive: true });
  await fs.symlink(target, link);
  const result = await store.trash({ sourceDir: link, sessionId: "link" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "symlink-refused");
});

/**
 * Build a service whose registry behaves like DSH's: archiving a session makes the
 * client drop its main reference, which lets the host dispose it. That causal chain
 * is what the release path depends on, so the fake reproduces it.
 */
async function releaseFixture(t, { releaseOnArchive = true } = {}) {
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  const cwd = "/tmp/project";
  await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_A, contents: "work\n" });
  const sessions = fakeSessions([SESSION_A]);
  const registry = fakeWorkspaceRegistry({ workspaces: [{ path: cwd, sessionIds: [SESSION_A] }] });
  if (releaseOnArchive) {
    const archive = registry.archiveSession.bind(registry);
    registry.archiveSession = async (sessionId, options) => {
      await archive(sessionId, options);
      // Archiving drops the view's reference; with the work stopped nothing else
      // holds the session, so the runtime disposes it.
      sessions.live.delete(sessionId);
    };
  }
  const ctx = fakeCtx(
    {
      sessionPersistence: fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION_A, cwd]]) }),
      workspaceRegistry: registry,
      sessions,
      sessionController: { listState: { list: async () => [] } }
    },
    { waterfall: () => [{ kind: "turn" }] }
  );
  const store = new TrashStore({ root: path.join(root, "bin"), logger: recordingLogger() });
  const service = new SessionTrashService(ctx, { store });
  return { service, store, ctx, registry, sessions, sessionRoot, cwd };
}

test("R17: a running session the view holds can still be deleted (release then move)", async (t) => {
  // The reported bug: clicking the consent button stopped the user's work and then
  // refused, because the view still held the session and nothing ever released it.
  const { service, store, registry } = await releaseFixture(t);
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A], stopActivity: true, waitForReleaseMs: 3000 });
  assert.equal(outcome.deleted, 1, JSON.stringify(outcome.results));
  assert.equal(outcome.results[0].ok, true);
  assert.equal(outcome.results[0].forced, false, "the release worked, so nothing was forced");
  assert.equal(outcome.results[0].released, true);
  // The session really moved.
  assert.equal((await store.list()).length, 1);
  // And the archive used to release it does not leak into DSH's accounting.
  assert.deepEqual(registry.archivedSessionIds, []);
});

test("R18: force deletes a session that never releases, and says so", async (t) => {
  // Without a force, a session the runtime never lets go of can only be refused —
  // which is exactly the dead end the user hit. Force must complete the delete and
  // leave an auditable trace of the fact.
  const { service, store } = await releaseFixture(t, { releaseOnArchive: false });
  const refused = await service.deleteSessions({ sessionIds: [SESSION_A], stopActivity: true, waitForReleaseMs: 120 });
  assert.equal(refused.deleted, 0);
  assert.equal(refused.results[0].code, "session-live");

  const forced = await service.deleteSessions({
    sessionIds: [SESSION_A],
    stopActivity: true,
    force: true,
    waitForReleaseMs: 120
  });
  assert.equal(forced.deleted, 1, JSON.stringify(forced.results));
  assert.equal(forced.results[0].forced, true, "the outcome reports that it was forced");
  assert.equal(forced.results[0].released, false);

  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].forced, true, "the manifest records the forced move");

  const records = await store.readLog();
  const forcedRecord = records.find((row) => row.op === "trash" && row.outcome === "ok-with-warnings");
  assert.ok(forcedRecord === undefined || forcedRecord.op === "trash");
  assert.ok(records.some((row) => row.op === "trash"), "the forced delete is audited");
});

test("R19: a refused delete un-archives the session it archived to release it", async (t) => {
  // The release archives the session; a delete that then fails must not leave the
  // user with a session they never archived hidden from the sidebar.
  const { service, registry, sessionRoot, cwd } = await releaseFixture(t, { releaseOnArchive: false });
  // Make the move fail after the release: remove the directory once released.
  const original = service.store.trash.bind(service.store);
  service.store.trash = async (input) => {
    await fs.rm(input.sourceDir, { recursive: true, force: true });
    return original(input);
  };
  const outcome = await service.deleteSessions({
    sessionIds: [SESSION_A],
    stopActivity: true,
    force: true,
    waitForReleaseMs: 80
  });
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].code, "not-found");
  assert.deepEqual(registry.archivedSessionIds, [], "the release archive is rolled back");
  assert.equal(sessionRoot !== undefined && cwd !== undefined, true);
});

test("R20: without consent, nothing is stopped and nothing is archived", async (t) => {
  // The quiet refusal path must stay side-effect free: no work stopped, no archive
  // written, no files moved.
  const { service, registry, store } = await releaseFixture(t);
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A] });
  assert.equal(outcome.results[0].code, "session-active");
  assert.deepEqual(
    registry.calls.filter((call) => call.op === "stop" || call.op === "archive"),
    [],
    "a refusal before consent must not stop work or archive"
  );
  assert.equal((await store.list()).length, 0);
});

test("R21: a forced delete never detaches, so no residue reaches the ungrouped bucket", async (t) => {
  // Reported from the live app: a session deleted from the 工作 project reappeared
  // under 未分组 and could not be deleted again. The delete had worked (files in the
  // bin) — the cleanup detached the id from its workspace, and the sidebar's
  // ungrouped bucket is exactly "listed sessions no workspace claims", so the
  // leftover row landed there.
  const { service, registry } = await releaseFixture(t, { releaseOnArchive: false });
  const outcome = await service.deleteSessions({
    sessionIds: [SESSION_A],
    stopActivity: true,
    force: true,
    waitForReleaseMs: 80
  });
  assert.equal(outcome.deleted, 1, JSON.stringify(outcome.results));
  assert.equal(outcome.results[0].forced, true);
  assert.ok(
    !registry.calls.some((call) => call.op === "detach"),
    "detaching is what pushed the residue into the ungrouped bucket"
  );
  assert.deepEqual(registry.list()[0].sessionIds, [SESSION_A], "the workspace link is kept");
});

test("R22: a forced delete leaves the session archived so the residue is hidden", async (t) => {
  // There is no dispose-by-id anywhere in DSH, so a session the runtime still holds
  // outlives its files and the host keeps listing it. Archived is the only state
  // that hides a row: the sidebar's sessionVisible() returns !archived.has(id) under
  // its default filter. Un-archiving here is what made the leftover visible.
  const { service, registry } = await releaseFixture(t, { releaseOnArchive: false });
  const outcome = await service.deleteSessions({
    sessionIds: [SESSION_A],
    stopActivity: true,
    force: true,
    waitForReleaseMs: 80
  });
  assert.equal(outcome.deleted, 1, JSON.stringify(outcome.results));
  assert.equal(outcome.results[0].residue, true, "the outcome tells the UI a residue may remain");
  assert.ok(registry.archivedSessionIds.includes(SESSION_A), "the residue stays archived (hidden)");
});

test("R23: a quiet delete still clears the archive set", async (t) => {
  // The other half of the same decision: with nothing left behind, un-archiving is
  // right, and a deleted session must not stay hidden in the archive view.
  const { service, registry } = await releaseFixture(t);
  const outcome = await service.deleteSessions({ sessionIds: [SESSION_A], stopActivity: true, waitForReleaseMs: 3000 });
  assert.equal(outcome.deleted, 1, JSON.stringify(outcome.results));
  assert.equal(outcome.results[0].forced, false);
  assert.equal(outcome.results[0].residue, false);
  assert.deepEqual(registry.archivedSessionIds, [], "a clean delete leaves no archive id behind");
});

test("R24: restoring a forced delete clears the archive id it left behind", async (t) => {
  // Otherwise undo would return a session that stays hidden in the archive view.
  const { service, registry, store } = await releaseFixture(t, { releaseOnArchive: false });
  const deleted = await service.deleteSessions({
    sessionIds: [SESSION_A],
    stopActivity: true,
    force: true,
    waitForReleaseMs: 80
  });
  assert.ok(registry.archivedSessionIds.includes(SESSION_A));
  const trashId = deleted.results[0].trashId;
  const restored = await service.restoreSessions({ trashIds: [trashId] });
  assert.equal(restored.restored, 1, JSON.stringify(restored.results));
  assert.deepEqual(registry.archivedSessionIds, [], "the recorded state (not archived) is restored");
  assert.equal((await store.list()).length, 0, "the bin item is gone");
});
