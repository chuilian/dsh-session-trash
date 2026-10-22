/**
 * Locator tests.
 *
 * Finding the right directory is the single most dangerous step in a delete, so
 * every layer is tested, along with the containment check that stops a wrong
 * answer from reaching the filesystem.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { encodeSegment, projectKey } from "../../lib/host/encode.js";
import { candidateRoots, dshHome, isResident, resolveSessionDir, waitForRelease } from "../../lib/host/locate.js";
import { fakePersistence, fakeSessions, seedSession, tempDir } from "./helpers.js";

const SESSION = "session-11111111-2222-3333-4444-555555555555";

/** Build a temp store with one seeded session. */
async function fixture(t, options = {}) {
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  const cwd = options.cwd ?? "/tmp/project";
  const sessionDir = await seedSession({ root: sessionRoot, cwd, sessionId: SESSION });
  const sessionCwd = new Map([[SESSION, cwd]]);
  return { root, sessionRoot, cwd, sessionDir, sessionCwd };
}

test("dshHome prefers DSH_HOME and otherwise uses ~/.dsh", () => {
  assert.equal(dshHome({ DSH_HOME: "/custom/home" }), "/custom/home");
  assert.ok(dshHome({}).endsWith(path.join(".dsh")));
});

test("candidateRoots puts the backend root first and de-duplicates", () => {
  const roots = candidateRoots({ root: "/srv/logs" }, { DSH_HOME: "/srv/logs" });
  assert.equal(roots[0], "/srv/logs");
  assert.equal(new Set(roots).size, roots.length, "no duplicate candidates");
  assert.ok(roots.some((entry) => entry === path.join("/srv/logs", "sessions")));
});

test("layer 1 uses the backend's own locate()", async (t) => {
  const { sessionRoot, sessionCwd, sessionDir } = await fixture(t);
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd });
  const resolved = await resolveSessionDir({ sessionId: SESSION, persistence });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.via, "locate");
  assert.equal(resolved.dir, await fs.realpath(sessionDir));
  assert.equal(resolved.header.cwd, "/tmp/project");
});

test("layer 2 computes the path when the backend exposes no locate()", async (t) => {
  const { sessionRoot, sessionCwd, sessionDir } = await fixture(t);
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd, exposeLocate: false });
  const resolved = await resolveSessionDir({ sessionId: SESSION, persistence });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.via, "root+encode");
  assert.equal(resolved.dir, await fs.realpath(sessionDir));
  // The computed path must be the real on-disk spelling.
  assert.equal(path.basename(resolved.dir), encodeSegment(SESSION));
  assert.equal(path.basename(path.dirname(resolved.dir)), projectKey("/tmp/project"));
});

test("layer 3 scans for the directory when no header is available", async (t) => {
  const { sessionRoot, sessionDir } = await fixture(t);
  const persistence = { root: sessionRoot, stat: async () => undefined };
  const resolved = await resolveSessionDir({ sessionId: SESSION, persistence });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.via, "scan");
  assert.equal(resolved.dir, await fs.realpath(sessionDir));
});

test("a missing session directory is reported, never invented", async (t) => {
  const { sessionRoot } = await fixture(t);
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd: new Map() });
  const resolved = await resolveSessionDir({ sessionId: "session-99999999-9999-9999-9999-999999999999", persistence });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "not-found");
});

test("an id that could name a path is refused before any filesystem access", async (t) => {
  const { sessionRoot } = await fixture(t);
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION, "/tmp/project"]]) });
  for (const bad of ["../../etc", "session-a/b", "a\\b", "", null, ".", "..", "x".repeat(201)]) {
    const resolved = await resolveSessionDir({ sessionId: bad, persistence });
    assert.equal(resolved.ok, false, JSON.stringify(bad));
    assert.equal(resolved.code, "invalid-session-id", JSON.stringify(bad));
  }
});

test("an id that cannot name a path is accepted even without the session- prefix", async (t) => {
  // DSH's SessionId is a branded string that `session.create` accepts from the
  // caller, so the guard must not require the conventional prefix.
  const { sessionRoot } = await fixture(t);
  const cwd = "/tmp/project";
  await seedSession({ root: sessionRoot, cwd, sessionId: "notes" });
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd: new Map([["notes", cwd]]) });
  const resolved = await resolveSessionDir({ sessionId: "notes", persistence });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.dir, await fs.realpath(path.join(sessionRoot, projectKey(cwd), "notes")));
});

test("a locate() answer outside the candidate roots is refused", async (t) => {
  const { sessionRoot, root } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside, { recursive: true });
  const persistence = {
    root: sessionRoot,
    stat: async () => ({ header: { id: SESSION, cwd: "/tmp/project", createdAt: 0 } }),
    // A buggy or hostile backend pointing somewhere it must not.
    locate: () => ({ kind: "jsonl", path: path.join(outside, "session.v4.jsonl.zstd") })
  };
  const resolved = await resolveSessionDir({ sessionId: SESSION, persistence });
  // A containment failure gets its own code rather than a quiet fall-through, so
  // a backend naming paths outside its root is diagnosable instead of invisible.
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "unsafe-location");
  assert.match(resolved.message, /outside every known root/);
});

test("a locate() answer inside the root but not yet materialized is not-found", async (t) => {
  const { sessionRoot } = await fixture(t);
  const persistence = {
    root: sessionRoot,
    stat: async () => ({ header: { id: SESSION, cwd: "/tmp/project", createdAt: 0 } }),
    locate: (header) => ({
      kind: "jsonl",
      path: path.join(sessionRoot, projectKey(header.cwd), encodeSegment(header.id), "session.v4.jsonl.zstd")
    })
  };
  // Remove the directory so the located path is inside the root but absent.
  await fs.rm(path.join(sessionRoot, projectKey("/tmp/project"), encodeSegment(SESSION)), {
    recursive: true,
    force: true
  });
  const resolved = await resolveSessionDir({ sessionId: SESSION, persistence });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "not-found");
});

test("a symlinked session directory is not accepted as the target", async (t) => {
  const { sessionRoot, root } = await fixture(t);
  const elsewhere = path.join(root, "elsewhere");
  await fs.mkdir(elsewhere, { recursive: true });
  const linkDir = path.join(sessionRoot, "--tmp-project--");
  await fs.mkdir(linkDir, { recursive: true });
  // Replace the real directory the fixture seeded with a symlink of the same name.
  await fs.rm(path.join(linkDir, SESSION), { recursive: true, force: true });
  await fs.symlink(elsewhere, path.join(linkDir, SESSION));
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION, "/tmp/project"]]) });
  const resolved = await resolveSessionDir({ sessionId: SESSION, persistence });
  assert.equal(resolved.ok, false);
  // The link resolves outside the session store, so this reads as a containment
  // failure rather than a merely missing directory — which is the more useful
  // diagnosis, and the refusal is the same either way.
  assert.equal(resolved.code, "unsafe-location");
});

test("a symlink pointing inside the store is refused as not-visible", async (t) => {
  const { sessionRoot, cwd } = await fixture(t);
  const projectDir = path.join(sessionRoot, projectKey(cwd));
  const target = path.join(projectDir, `${SESSION}-real`);
  const link = path.join(projectDir, SESSION);
  await fs.rm(link, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  await fs.symlink(target, link);
  const persistence = fakePersistence({ root: sessionRoot, sessionCwd: new Map([[SESSION, cwd]]) });
  const resolved = await resolveSessionDir({ sessionId: SESSION, persistence });
  assert.equal(resolved.ok, false, "a symlink is never the delete target, wherever it points");
  // The session's files are there, behind the link. Reporting "not found" would
  // let the caller clear the row as if it had no files left.
  assert.equal(resolved.code, "not-visible");
  assert.equal(resolved.exists, true);
});

test("resolveSessionDir tolerates a throwing stat()", async (t) => {
  const { sessionRoot, sessionDir } = await fixture(t);
  const persistence = {
    root: sessionRoot,
    stat: async () => {
      throw new Error("backend offline");
    }
  };
  const resolved = await resolveSessionDir({ sessionId: SESSION, persistence });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.via, "scan");
  assert.equal(resolved.dir, await fs.realpath(sessionDir));
});

test("isResident reflects the sessions registry", () => {
  const ctx = { get: (name) => (name === "sessions" ? fakeSessions([SESSION]) : undefined) };
  assert.equal(isResident(ctx, SESSION), true);
  assert.equal(isResident(ctx, "session-22222222-2222-3333-4444-555555555555"), false);
  // A registry that is missing cannot rule residency out, so the probe fails
  // closed: "possibly resident" is the answer that cannot lose data.
  assert.equal(isResident({ get: () => undefined }, SESSION), true);
  assert.equal(
    isResident(
      {
        get: () => {
          throw new Error("no registry");
        }
      },
      SESSION
    ),
    true
  );
});

test("waitForRelease returns immediately when nothing is resident", async () => {
  const ctx = { get: () => fakeSessions([]) };
  assert.equal(await waitForRelease(ctx, SESSION, 0), true);
});

test("waitForRelease gives up after its timeout", async () => {
  const ctx = { get: () => fakeSessions([SESSION]) };
  const started = Date.now();
  assert.equal(await waitForRelease(ctx, SESSION, 80, 10), false);
  assert.ok(Date.now() - started >= 60);
});

test("waitForRelease observes a release that happens mid-wait", async () => {
  const sessions = fakeSessions([SESSION]);
  const ctx = { get: () => sessions };
  const timer = setTimeout(() => sessions.live.delete(SESSION), 20);
  assert.equal(await waitForRelease(ctx, SESSION, 1000, 10), true);
  clearTimeout(timer);
});
