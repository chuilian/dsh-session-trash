/**
 * Recycle-bin store tests: the filesystem behaviour that makes a delete
 * recoverable, and the refusals that keep it from touching anything it should
 * not.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { TrashStore, isInside, isSafeSessionId, isSafeTrashId } from "../../lib/host/trash-store.js";
import { SESSION_A, SESSION_B, recordingLogger, seedSession, tempDir } from "./helpers.js";

/**
 * Build a store over a temp root plus one seeded session directory.
 * @param {import("node:test").TestContext} t - test context.
 * @returns {Promise<{store: TrashStore, root: string, sessionRoot: string, sessionDir: string}>} fixtures.
 */
async function fixture(t) {
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  const sessionDir = await seedSession({ root: sessionRoot, cwd: "/tmp/project", sessionId: SESSION_A });
  const store = new TrashStore({ root: path.join(root, "bin"), logger: recordingLogger() });
  await store.init();
  return { store, root, sessionRoot, sessionDir };
}

test("trash moves the session directory out of the store and into the bin", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const result = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A, cwd: "/tmp/project", title: "T" });
  assert.equal(result.ok, true);
  assert.equal(result.item.state, "trashed");
  assert.equal(result.item.sessionId, SESSION_A);
  assert.equal(result.item.title, "T");
  assert.equal(result.item.fileCount, 2);
  assert.ok(result.item.totalBytes > 0);
  await assert.rejects(() => fs.lstat(sessionDir), /ENOENT/);
  const payload = path.join(store.itemDir(result.item.trashId), "payload");
  assert.deepEqual((await fs.readdir(payload)).sort(), ["session.lock", "session.v4.jsonl.zstd"]);
});

test("trash refuses an unsafe session id without touching the filesystem", async (t) => {
  const { store, sessionDir } = await fixture(t);
  for (const sessionId of ["../escape", "session-ok/../..", "", ".", "..", "x".repeat(201), "a/b"]) {
    const result = await store.trash({ sourceDir: sessionDir, sessionId });
    assert.equal(result.ok, false, `expected ${JSON.stringify(sessionId)} to be refused`);
    assert.equal(result.code, "invalid-session-id");
  }

  assert.ok((await fs.lstat(sessionDir)).isDirectory());
});

test("a path-safe id without the session- prefix is accepted", async (t) => {
  const { store } = await fixture(t);
  const sessionRoot = path.join(store.root, "..", "sessions");
  const dir = await seedSession({ root: sessionRoot, cwd: "/tmp/project", sessionId: "notes" });
  // The guard exists to stop path naming, not to police DSH's id vocabulary: a
  // SessionId is a branded string that `session.create` accepts from the caller.
  const outcome = await store.trash({ sourceDir: dir, sessionId: "notes" });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.item.sessionId, "notes");
  const restored = await store.restore(outcome.item.trashId);
  assert.equal(restored.ok, true);
  assert.ok((await fs.lstat(dir)).isDirectory());
});

test("trash refuses a symlinked session directory", async (t) => {
  const { store, root, sessionRoot } = await fixture(t);
  const real = path.join(root, "elsewhere");
  await fs.mkdir(real, { recursive: true });
  const link = path.join(sessionRoot, "link-dir");
  await fs.symlink(real, link);
  const result = await store.trash({ sourceDir: link, sessionId: SESSION_A });
  assert.equal(result.ok, false);
  assert.equal(result.code, "symlink-refused");
  assert.ok((await fs.lstat(real)).isDirectory());
});

test("trash reports a missing directory instead of inventing one", async (t) => {
  const { store } = await fixture(t);
  const result = await store.trash({ sourceDir: path.join(store.root, "nope", SESSION_B), sessionId: SESSION_B });
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-found");
});

test("list returns items newest first and reports nothing for an empty bin", async (t) => {
  const { store, sessionRoot } = await fixture(t);
  assert.deepEqual(await store.list(), []);

  let tick = 1_000;
  const clocked = new TrashStore({ root: store.root, clock: () => tick });
  const first = await clocked.trash({ sourceDir: await seedSession({ root: sessionRoot, cwd: "/tmp/p", sessionId: SESSION_A }), sessionId: SESSION_A });
  tick = 2_000;
  const second = await clocked.trash({ sourceDir: await seedSession({ root: sessionRoot, cwd: "/tmp/p", sessionId: SESSION_B }), sessionId: SESSION_B });
  const items = await clocked.list();
  assert.deepEqual(items.map((item) => item.trashId), [second.item.trashId, first.item.trashId]);
});

test("restore puts the session back byte-for-byte and removes the bin item", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const before = await fs.readFile(path.join(sessionDir, "session.v4.jsonl.zstd"), "utf8");
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const restored = await store.restore(item.trashId);
  assert.equal(restored.ok, true);
  assert.equal(restored.sessionId, SESSION_A);
  // The manifest records the canonical path, which is where the session returns.
  assert.equal(restored.originalPath, await fs.realpath(sessionDir));
  assert.equal(await fs.readFile(path.join(sessionDir, "session.v4.jsonl.zstd"), "utf8"), before);
  await assert.rejects(() => fs.lstat(store.itemDir(item.trashId)), /ENOENT/);
  assert.deepEqual(await store.list(), []);
});

test("restore refuses to overwrite a directory that reappeared at the original path", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  await seedSession({ root: path.dirname(path.dirname(sessionDir)), cwd: "/tmp/project", sessionId: SESSION_A, contents: "newer\n" });
  const restored = await store.restore(item.trashId);
  assert.equal(restored.ok, false);
  assert.equal(restored.code, "occupied");
  assert.equal(await fs.readFile(path.join(sessionDir, "session.v4.jsonl.zstd"), "utf8"), "newer\n");
  // The bin item survives the refusal, so nothing is lost either way.
  assert.equal((await store.list()).length, 1);
});

test("restore keeps the item as a record when asked", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  await store.restore(item.trashId, { keepItem: true });
  const manifest = await store.get(item.trashId);
  assert.equal(manifest.state, "restored");
  assert.ok(manifest.restoredAt > 0);
  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "restored");
  const stats = await store.stats(0);
  assert.equal(stats.count, 0, "a restored record is not a restorable item");
  assert.equal(stats.brokenCount, 0, "a restored record is not a broken item");
});

test("purge erases an item for good and reports freed bytes", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const results = await store.purge([item.trashId]);
  assert.equal(results[0].ok, true);
  assert.ok(results[0].freedBytes > 0);
  await assert.rejects(() => fs.lstat(store.itemDir(item.trashId)), /ENOENT/);
  const again = await store.purge([item.trashId]);
  assert.equal(again[0].code, "unknown-item");
});

test("purge refuses a malformed id rather than resolving a path", async (t) => {
  const { store } = await fixture(t);
  const results = await store.purge(["../../etc"]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].code, "invalid-id");
});

test("an interrupted trash is reported as complete without writing on a read", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  // Recreate the reachable crash window: the manifest still says "moving" while
  // the rename has landed, so the payload exists.
  const manifestPath = path.join(store.itemDir(item.trashId), "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, state: "moving", fileCount: 0, files: [] }));
  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "trashed");
  assert.equal(items[0].healed, true);
  assert.equal(items[0].fileCount, 2);
  // The heal is in memory only: listing is a read, so the disk is untouched.
  assert.equal(JSON.parse(await fs.readFile(manifestPath, "utf8")).state, "moving");
  // Restoring it works, and the successful restore is what rewrites state.
  const restored = await store.restore(item.trashId);
  assert.equal(restored.ok, true);
  await assert.rejects(() => fs.lstat(store.itemDir(item.trashId)), /ENOENT/);
});

test("an interrupted trash with no payload is reported as failed, not restorable", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  await fs.rm(path.join(store.itemDir(item.trashId), "payload"), { recursive: true, force: true });
  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "failed");
  const restored = await store.restore(item.trashId);
  assert.equal(restored.ok, false);
  assert.equal(restored.code, "payload-missing");
  assert.equal((await store.stats(0)).brokenCount, 1);
});

test("restore heals the same interrupted trash that list heals", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const manifestPath = path.join(store.itemDir(item.trashId), "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, state: "moving" }));
  const restored = await store.restore(item.trashId);
  assert.equal(restored.ok, true);
  assert.equal(restored.sessionId, SESSION_A);
  assert.ok((await fs.lstat(sessionDir)).isDirectory());
});

test("a corrupt manifest is reported without breaking the listing", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  await fs.writeFile(path.join(store.itemDir(item.trashId), "manifest.json"), "{not json");
  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "corrupt");
});

test("stats and expiry report without deleting anything", async (t) => {
  const { store, sessionDir } = await fixture(t);
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const stats = await store.stats(30);
  assert.equal(stats.count, 1);
  assert.equal(stats.bytes, item.totalBytes);
  assert.equal(stats.expiredCount, 0);
  assert.equal((await store.expired(30)).length, 0);
  // A zero-length window disables expiry entirely.
  assert.deepEqual(await store.expired(0), []);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.stats(0)).expiredCount, 0);
});

test("expiry marks an old item without purging it", async (t) => {
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  let tick = 0;
  const store = new TrashStore({ root: path.join(root, "bin"), clock: () => tick });
  const sessionDir = await seedSession({ root: sessionRoot, cwd: "/tmp/p", sessionId: SESSION_A });
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  tick = 40 * 86_400_000;
  assert.equal((await store.expired(30)).length, 1);
  assert.equal((await store.stats(30)).expiredCount, 1);
  assert.equal((await store.list()).length, 1, "expiry is a report, never a silent purge");
  assert.equal((await store.get(item.trashId)).state, "trashed");
});

test("the audit log records trash, restore, purge and caller records as NDJSON", async (t) => {
  const { store, sessionDir } = await fixture(t);
  await store.record({ op: "delete", outcome: "refused", sessionId: SESSION_A, code: "session-live" });
  const { item } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  await store.restore(item.trashId);
  const { item: second } = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  await store.purge([second.trashId]);
  const records = await store.readLog();
  const ops = records.map((row) => row.op).sort();
  assert.deepEqual(ops, ["delete", "purge", "restore", "trash", "trash"]);
  for (const row of records) {
    assert.equal(typeof row.ts, "number");
    assert.equal(typeof row.tsIso, "string");
  }
  assert.equal(records[0].op, "purge", "readLog returns newest first");
  assert.equal(records.at(-1).op, "delete", "the oldest record is the refused attempt");
});

test("the bin root and item ids are containment-checked", async () => {
  assert.equal(isSafeSessionId(SESSION_A), true);
  assert.equal(isSafeSessionId("session-a b"), true, "a space cannot name a path");
  assert.equal(isSafeSessionId("a/b"), false);
  assert.equal(isSafeSessionId(".."), false);
  assert.equal(isSafeTrashId("t-20260101T000000Z-deadbeef"), true);
  assert.equal(isSafeTrashId("t-20260101T000000Z-DEADBEEF"), false);
  assert.equal(isSafeTrashId("../../etc"), false);
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
  const store = new TrashStore({ root: "/tmp/bin" });
  assert.throws(() => store.itemDir("../escape"), /malformed trash id/);
});
test("a restore that cannot tidy the emptied bin item still reports the session as restored", async (t) => {
  // The payload is moved back *before* the bin item is removed, so a failing rm
  // means only the tidy-up failed. Reporting a failure would tell the user their
  // session is gone from its old place (it is not), skip the bookkeeping that
  // follows a restore, and leave an item offering a restore of nothing.
  const { store, sessionDir } = await fixture(t);
  const trashed = await store.trash({ sourceDir: sessionDir, sessionId: SESSION_A });
  const itemsDir = path.join(store.root, "items");
  await fs.chmod(itemsDir, 0o500);
  t.after(async () => {
    await fs.chmod(itemsDir, 0o700).catch(() => {});
  });
  const outcome = await store.restore(trashed.item.trashId);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.sessionId, SESSION_A);
  assert.ok((await fs.lstat(sessionDir)).isDirectory(), "the session is back where it was");
  await fs.chmod(itemsDir, 0o700);
  const listed = await store.list();
  assert.deepEqual(listed.filter((item) => item.state === "trashed"), [], "the stale item is not offered again");
});

test("purge refuses anything unsafe before removing a byte", async (t) => {
  const { store } = await fixture(t);
  const results = await store.purge(["../escape", ",*"], { actor: "test" });
  assert.equal(results.length, 2);
  for (const row of results) assert.equal(row.ok, false);
});
