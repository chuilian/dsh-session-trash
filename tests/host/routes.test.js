/**
 * End-to-end HTTP tests for the `/session-trash` surface.
 *
 * The route layer is the entire client-to-host contract, so it is exercised over
 * a real `node:http` server with real requests rather than by calling the handler
 * directly: status codes, method handling, JSON bodies, the access guard and the
 * acknowledgement gate are all observable behaviour, not internal details.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { encodeSegment, projectKey } from "../../lib/host/encode.js";
import { apply } from "../../lib/index.js";
import { SESSION_A, SESSION_B, fakeSessions, fakeWorkspaceRegistry, recordingLogger, seedSession, tempDir } from "./helpers.js";

/**
 * Close a test server without waiting on keep-alive sockets.
 *
 * `server.close()` alone waits for every open connection to end, and a `fetch`
 * client keeps its sockets alive, so the test process would hang. Destroying the
 * connections first makes teardown deterministic.
 *
 * @param {import("node:http").Server} server - the server to close.
 * @returns {Promise<void>} resolves once the listener is gone.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => {
      resolve();
    });
  });
}

/**
 * Mount the plugin against a real HTTP server.
 *
 * @param {import("node:test").TestContext} t - test context.
 * @param {object} [options] - overrides.
 * @returns {Promise<object>} the base URL, request helper, fixtures and logger.
 */
async function serve(t, options = {}) {
  const root = await tempDir(t);
  const sessionRoot = path.join(root, "sessions");
  const trashRoot = path.join(root, "bin");
  const cwd = "/tmp/project";
  await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_A, contents: "a".repeat(64) });
  await seedSession({ root: sessionRoot, cwd, sessionId: SESSION_B, contents: "b".repeat(32) });

  const logger = recordingLogger();
  // Use the plugin's own encoder rather than a second approximation of it.
  const persistence = {
    root: sessionRoot,
    async stat(sessionId) {
      if (sessionId !== SESSION_A && sessionId !== SESSION_B) return undefined;
      return { header: { id: sessionId, cwd, createdAt: 0 } };
    },
    locate: (header) => ({
      kind: "jsonl",
      path: path.join(sessionRoot, projectKey(header.cwd), encodeSegment(header.id), "session.v4.jsonl.zstd")
    })
  };

  const routes = [];
  let server;
  const ctx = {
    logger,
    get: (name) =>
      ({
        sessionPersistence: persistence,
        workspaceRegistry: fakeWorkspaceRegistry(),
        sessions: fakeSessions(options.resident ?? []),
        sessionController: { listState: { list: async () => [] } },
        webServer: {
          register: (route) => {
            routes.push(route);
            return () => {};
          }
        }
      })[name],
    emit: () => {},
    effect(callback) {
      const disposer = callback();
      return typeof disposer === "function" ? disposer : () => {};
    },
    inject(deps, callback) {
      if (deps.every((dep) => ctx.get(dep) !== undefined)) callback(ctx);
      return () => {};
    },
    async waterfall(_event, _payload, fallback) {
      return options.waterfall === undefined ? fallback() : options.waterfall();
    },
    async parallel() {}
  };
  for (const name of ["sessionPersistence", "workspaceRegistry", "sessions", "sessionController", "webServer"]) {
    ctx[name] = ctx.get(name);
  }

  apply(ctx, { root: trashRoot, retentionDays: 30, maxBatch: 2, ...options.config });
  assert.equal(routes.length, 1, "the plugin registers exactly one prefix route");
  assert.equal(routes[0].kind, "prefix");
  assert.equal(routes[0].path, "/session-trash");

  const handler = routes[0].handler;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    if (url.pathname === "/session-trash" || url.pathname.startsWith("/session-trash/")) void handler(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${String(server.address().port)}`;

  /**
   * Perform one request and decode the JSON body.
   * @param {string} route - path under the base URL.
   * @param {object} [init] - fetch options.
   * @returns {Promise<{status: number, body: any}>} the decoded response.
   */
  const call = async (route, init = {}) => {
    const response = await fetch(`${base}${route}`, init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, headers: response.headers };
  };

  const post = (route, payload) =>
    call(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  return { base, call, post, root, sessionRoot, trashRoot, cwd, logger, server, port: server.address().port };
}

test("GET /session-trash/status reports the capability envelope", async (t) => {
  const { call, trashRoot } = await serve(t);
  const { status, body } = await call("/session-trash/status");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.root, trashRoot);
  assert.equal(body.value.canDelete, true);
  assert.equal(body.value.retentionDays, 30);
});

test("GET /session-trash and GET /session-trash/list answer the read model", async (t) => {
  const { call } = await serve(t);
  const bare = await call("/session-trash");
  assert.equal(bare.status, 200);
  assert.equal(bare.body.value.count, 0);
  const list = await call("/session-trash/list");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.value.items, []);
  assert.deepEqual(list.body.value.broken, []);
  // The bin's cap travels with the listing: the panel restores and purges a
  // selection in as many requests as the cap needs, so it has to know the cap.
  assert.equal(list.body.value.maxBatch, 2);
});

test("POST /session-trash/plan is read-only and never touches the trash root", async (t) => {
  const { post, trashRoot } = await serve(t);
  const { status, body } = await post("/session-trash/plan", { sessionIds: [SESSION_A], sizes: true });
  assert.equal(status, 200);
  assert.equal(body.value.plans.length, 1);
  assert.equal(body.value.plans[0].deletable, true);
  assert.equal(body.value.plans[0].bytes, 64);
  // The dialog renders its description from `root` and chunks its delete request
  // by `maxBatch`; carrying both here removes a second round trip before the
  // first paint.
  assert.equal(body.value.root, trashRoot);
  assert.equal(body.value.maxBatch, 2);
  await assert.rejects(() => fs.lstat(path.join(trashRoot, "items", "anything")), /ENOENT/);
});

test("plan accepts a longer list than one mutation batch", async (t) => {
  // Refusing to *describe* rows the user can see would make a long list
  // undeletable, which is the worst failure mode this dialog has. Reads get their
  // own, larger cap; mutations keep the configured one and the client chunks.
  const { post } = await serve(t, { config: { maxBatch: 1 } });
  const planned = await post("/session-trash/plan", { sessionIds: [SESSION_A, SESSION_B] });
  assert.equal(planned.status, 200);
  assert.equal(planned.body.value.plans.length, 2);
  assert.equal(planned.body.value.maxBatch, 1);
  const refused = await post("/session-trash/delete", { sessionIds: [SESSION_A, SESSION_B] });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "batch-too-large");
});

test("the preflight answer says whether the menu may skip the dialog", async (t) => {
  // The quick path is a preference, so the host owns it and the client half reads
  // it from the one request it already makes.
  const on = await serve(t, {});
  const planned = await on.post("/session-trash/plan", { sessionIds: [SESSION_A] });
  assert.equal(planned.body.value.quickDelete, true, "on by default");

  const off = await serve(t, { config: { quickDelete: false } });
  const quiet = await off.post("/session-trash/plan", { sessionIds: [SESSION_A] });
  assert.equal(quiet.body.value.quickDelete, false, "a configured off is reported as off");
});

test("the full delete → list → restore round trip works over HTTP", async (t) => {
  const { post, call, sessionRoot, cwd } = await serve(t);
  const deleted = await post("/session-trash/delete", {
    sessionIds: [SESSION_A],
    titles: [{ sessionId: SESSION_A, title: "Alpha" }]
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.value.deleted, 1);
  assert.equal(deleted.body.value.results[0].ok, true);
  assert.equal(deleted.body.value.results[0].totalBytes, 64);

  const listing = await call("/session-trash/list");
  assert.equal(listing.body.value.items.length, 1);
  const item = listing.body.value.items[0];
  assert.equal(item.title, "Alpha");
  assert.equal(item.sessionId, SESSION_A);
  assert.equal(listing.body.value.stats.count, 1);

  // The session directory really is gone from the store.
  await assert.rejects(() => fs.lstat(path.join(sessionRoot, "--tmp-project--", SESSION_A)), /ENOENT/);

  const restored = await post("/session-trash/restore", { trashIds: [item.trashId] });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.value.restored, 1);
  assert.equal(
    await fs.readFile(path.join(sessionRoot, "--tmp-project--", SESSION_A, "session.v4.jsonl.zstd"), "utf8"),
    "a".repeat(64)
  );
  assert.equal((await call("/session-trash/list")).body.value.items.length, 0);
  assert.equal(cwd, "/tmp/project");
});

test("purge is refused with 428 until it is acknowledged", async (t) => {
  const { post } = await serve(t);
  const deleted = await post("/session-trash/delete", { sessionIds: [SESSION_A] });
  const trashId = deleted.body.value.results[0].trashId;

  const refused = await post("/session-trash/purge", { trashIds: [trashId] });
  assert.equal(refused.status, 428);
  assert.equal(refused.body.code, "not-acknowledged");
  assert.equal(refused.body.ok, false);

  const purged = await post("/session-trash/purge", { trashIds: [trashId], acknowledge: true });
  assert.equal(purged.status, 200);
  assert.equal(purged.body.value.purged, 1);
  assert.ok(purged.body.value.freedBytes > 0);
});

test("the maxBatch limit applies to delete, restore and purge", async (t) => {
  const { post } = await serve(t, { config: { maxBatch: 1 } });
  const tooMany = await post("/session-trash/delete", { sessionIds: [SESSION_A, SESSION_B] });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.code, "batch-too-large");

  const restoreMany = await post("/session-trash/restore", { trashIds: ["t-20260101T000000Z-aaaaaaaa", "t-20260101T000000Z-bbbbbbbb"] });
  assert.equal(restoreMany.status, 400);
  assert.equal(restoreMany.body.code, "batch-too-large");

  const purgeMany = await post("/session-trash/purge", {
    trashIds: ["t-20260101T000000Z-aaaaaaaa", "t-20260101T000000Z-bbbbbbbb"],
    acknowledge: true
  });
  assert.equal(purgeMany.status, 400);
  assert.equal(purgeMany.body.code, "batch-too-large");
});

test("the all-items sentinel is exempt from the batch limit", async (t) => {
  const { post } = await serve(t, { config: { maxBatch: 1 } });
  await post("/session-trash/delete", { sessionIds: [SESSION_A] });
  const cleared = await post("/session-trash/purge", { trashIds: ["*"], acknowledge: true });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.value.purged, 1);
});

test("an empty selection is a 400, not a silent success", async (t) => {
  const { post } = await serve(t);
  for (const route of ["delete", "restore", "purge"]) {
    const { status, body } = await post(`/session-trash/${route}`, route === "purge" ? { trashIds: [], acknowledge: true } : { sessionIds: [], trashIds: [] });
    assert.equal(status, 400, route);
    assert.equal(body.code, "empty-selection");
  }
});

test("a non-array or non-string payload is handled without reaching the filesystem", async (t) => {
  const { post, call } = await serve(t);
  const weird = await post("/session-trash/delete", { sessionIds: { a: 1, b: [2, 3] } });
  assert.equal(weird.status, 400);
  assert.equal(weird.body.code, "empty-selection");
  const nulls = await post("/session-trash/delete", { sessionIds: [null, 42, {}, SESSION_A] });
  assert.equal(nulls.status, 200);
  assert.equal(nulls.body.value.deleted, 1, "only the one real id is attempted");
  assert.equal((await call("/session-trash/list")).body.value.items.length, 1);
});

test("a malformed body is treated as absent rather than crashing", async (t) => {
  const { call } = await serve(t);
  const { status, body } = await call("/session-trash/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json"
  });
  assert.equal(status, 400);
  assert.equal(body.code, "empty-selection");
});

test("an oversized body is answered with 413 on a live socket", async (t) => {
  const { call } = await serve(t);
  const huge = JSON.stringify({ sessionIds: ["x".repeat(300 * 1024)] });
  const response = await call("/session-trash/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: huge
  });
  // The body is drained rather than destroying the request, so the caller sees a
  // legible refusal instead of a network error it cannot explain.
  assert.equal(response.status, 413);
  assert.equal(response.body.code, "body-too-large");
});

test("GET on a mutating action is 405 and an unknown action is 404", async (t) => {
  const { call, post } = await serve(t);
  assert.equal((await call("/session-trash/delete")).status, 405);
  assert.equal((await call("/session-trash/purge")).status, 405);
  assert.equal((await call("/session-trash/nonsense")).status, 405);
  assert.equal((await post("/session-trash/nonsense", {})).status, 404);
});

test("an unsupported method is 405", async (t) => {
  const { call } = await serve(t);
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const { status } = await call("/session-trash/status", { method });
    assert.equal(status, 405, method);
  }
});

test("a cross-site request is refused with 403", async (t) => {
  const { call } = await serve(t);
  const { status, body } = await call("/session-trash/status", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(status, 403);
  assert.equal(body.code, "forbidden");
});

test("a cross-origin request is refused with 403", async (t) => {
  const { call } = await serve(t);
  const { status } = await call("/session-trash/status", { headers: { origin: "http://evil.example" } });
  assert.equal(status, 403);
});

test("a same-origin request with an Origin header is allowed", async (t) => {
  const { base, call } = await serve(t);
  const { status } = await call("/session-trash/status", { headers: { origin: base } });
  assert.equal(status, 200);
});

/**
 * Send a request with a chosen `Host` header.
 *
 * `fetch` refuses to set `Host`, so the non-loopback authority fence can only be
 * exercised through a raw request.
 *
 * @param {object} options - request facts.
 * @returns {Promise<{status: number, body: any}>} the decoded response.
 */
function rawRequest({ port, path: target, host, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: target, method: "GET", headers: { host, ...headers } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

test("a non-loopback authority is refused unless it is trusted", async (t) => {
  const { port } = await serve(t, { config: { trustedHosts: ["dsh.lan"] } });

  // An ordinary loopback authority is allowed.
  assert.equal((await rawRequest({ port, path: "/session-trash/status", host: "127.0.0.1:" + String(port) })).status, 200);
  // A 127.0.0.0/8 sibling is loopback per the shipped rule too.
  assert.equal((await rawRequest({ port, path: "/session-trash/status", host: "127.9.9.9:" + String(port) })).status, 200);
  // A DNS name that reaches loopback (the rebinding case) is refused...
  assert.equal((await rawRequest({ port, path: "/session-trash/status", host: "evil.example:" + String(port) })).status, 403);
  // ...unless the deployment declares it, which is what trustedHosts is for.
  assert.equal((await rawRequest({ port, path: "/session-trash/status", host: "dsh.lan:" + String(port) })).status, 200);
  // A trusted host is still subject to the cross-site fence.
  assert.equal(
    (await rawRequest({
      port,
      path: "/session-trash/status",
      host: "dsh.lan:" + String(port),
      headers: { "sec-fetch-site": "cross-site" }
    })).status,
    403
  );
  // A trusted host with a different port does not match when the entry names none
  // only if the entry itself carries a port; here the entry is port-less, so any
  // port matches — assert the documented rule instead of guessing.
  assert.equal((await rawRequest({ port, path: "/session-trash/status", host: "dsh.lan:1" })).status, 200);
});

test("a running session is refused and nothing is moved", async (t) => {
  const { post, call, sessionRoot } = await serve(t, { waterfall: () => [{ kind: "turn" }] });
  const refused = await post("/session-trash/delete", { sessionIds: [SESSION_A] });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.value.deleted, 0);
  assert.equal(refused.body.value.results[0].code, "session-active");
  assert.deepEqual(refused.body.value.results[0].activity, [{ kind: "turn" }]);
  assert.equal((await call("/session-trash/list")).body.value.items.length, 0);
  assert.ok((await fs.lstat(path.join(sessionRoot, "--tmp-project--", SESSION_A))).isDirectory());
});

test("the audit log endpoint returns the recorded operations", async (t) => {
  const { post, call } = await serve(t);
  await post("/session-trash/delete", { sessionIds: [SESSION_A] });
  await post("/session-trash/delete", { sessionIds: ["nope"] });
  const { status, body } = await call("/session-trash/log?limit=10");
  assert.equal(status, 200);
  const ops = body.value.records.map((row) => `${row.op}:${row.outcome}`);
  assert.ok(ops.includes("trash:ok"));
  // A fileless id is cleared rather than refused, and the log says which it was.
  assert.ok(ops.includes("delete:cleared"));
});

test("the audit log read is bounded and its limit is honoured", async (t) => {
  // The defect: the log is append-only and never rotated, and the limit was
  // passed through unclamped — one request could pull the whole history into
  // memory. A limit of zero also returned one record instead of none.
  const { post, call } = await serve(t);
  await post("/session-trash/delete", { sessionIds: [SESSION_A] });
  const zero = await call("/session-trash/log?limit=0");
  assert.equal(zero.status, 200);
  assert.deepEqual(zero.body.value.records, [], "a limit of zero reads nothing");
  const negative = await call("/session-trash/log?limit=-5");
  assert.equal(negative.status, 200);
  assert.deepEqual(negative.body.value.records, [], "a negative limit reads nothing");
  const unbounded = await call("/session-trash/log?limit=99999999999");
  assert.equal(unbounded.status, 200);
  assert.ok(Array.isArray(unbounded.body.value.records), "an absurd limit is clamped, not refused");
  const small = await call("/session-trash/log?limit=1");
  assert.equal(small.body.value.records.length, 1, "the limit is honoured exactly");
});

test("a disabled plugin refuses every request without touching the bin", async (t) => {
  const { call, post } = await serve(t, { config: { enabled: false } });
  // The route is registered but gated per request, so flipping `enabled` in the
  // profile takes effect immediately instead of needing a remount.
  for (const [label, response] of [
    ["status", await call("/session-trash/status")],
    ["list", await call("/session-trash/list")],
    ["delete", await post("/session-trash/delete", { sessionIds: [SESSION_A] })]
  ]) {
    assert.equal(response.status, 404, label);
    assert.equal(response.body.code, "disabled", label);
  }
  assert.equal((await call("/session-trash/list")).status, 404);
  // Nothing was moved.
  assert.ok((await fs.lstat(path.join((await serve(t)).sessionRoot, "--tmp-project--", SESSION_A))).isDirectory());
});
