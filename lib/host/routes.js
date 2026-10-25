/**
 * HTTP surface of the session recycle bin.
 *
 * One prefix route (`/session-trash`) carries the whole API, so the plugin adds
 * exactly one row to the webserver's route table and cannot collide with another
 * plugin's paths. Every response is JSON; every mutating verb is a POST.
 *
 * The client half calls these with same-origin `fetch`, which is the transport a
 * third-party DSH plugin can rely on: DSH's typed Remote namespaces are
 * assembled at build time from an explicit package list, so an out-of-tree
 * plugin cannot contribute one, while the webserver's route registry is a
 * documented public seam.
 *
 * @module dsh-session-trash/host/routes
 */

import { isTrustedCaller } from "./access.js";

/** Request-body cap: several hundred sessions fit comfortably. */
const BODY_MAX_BYTES = 256 * 1024;

/** JSON response headers. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer"
};

/**
 * Write one JSON response.
 * @param {import("node:http").ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON-serializable body.
 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Sentinel returned when a body exceeds {@link BODY_MAX_BYTES}. */
const BODY_TOO_LARGE = Symbol("body-too-large");

/**
 * Read a bounded JSON object body.
 *
 * An oversized body is *drained* rather than destroyed: destroying the request
 * mid-body resets the connection, so the caller would see a network failure
 * instead of the 413 the handler is about to write. Draining costs one wasted
 * read of an already-refused request and keeps the failure legible.
 *
 * @param {import("node:http").IncomingMessage} req - request.
 * @returns {Promise<object|null|typeof BODY_TOO_LARGE>} the parsed object, null when absent/invalid, or the overflow sentinel.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    if (overflow) continue;
    size += chunk.length;
    if (size > BODY_MAX_BYTES) {
      overflow = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) return BODY_TOO_LARGE;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate a requested id list against {@link BODY_MAX_BYTES} peers.
 *
 * @param {object} live - the live config.
 * @param {unknown} value - the raw request field.
 * @param {string} label - what the ids name, for the message.
 * @param {number} [cap] - maximum ids accepted; defaults to the mutation cap.
 * @returns {{ok: true, ids: string[]}|{ok: false, body: object}} the ids or the refusal body.
 */
function boundedIds(live, value, label, cap = live.maxBatch) {
  const ids = stringArray(value);
  if (ids.length === 0) {
    return { ok: false, body: { ok: false, code: "empty-selection", message: `未选择任何${label}` } };
  }
  if (ids.length > cap) {
    return {
      ok: false,
      body: { ok: false, code: "batch-too-large", message: `一次最多处理 ${String(cap)} 个${label}` }
    };
  }
  return { ok: true, ids };
}

/**
 * Upper bound on one preflight call.
 *
 * Reads are not mutations: refusing to *describe* a row the user can see would
 * make the whole list undeletable the moment it is longer than a batch, which is
 * the worst possible failure mode for this dialog. The cap exists only to bound
 * one request's work, and the client chunks anything larger.
 */
const PLAN_MAX_IDS = 500;

/**
 * Upper bound on one audit-log read.
 *
 * The log is append-only and never rotated, so an unbounded limit would let a
 * single request pull the whole history into memory. The ceiling is far above
 * any realistic read (the panel asks for 50).
 */
const LOG_MAX_LIMIT = 10_000;

/** @returns {string[]} a validated string array, dropping non-strings. */
function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * Register the `/session-trash` route.
 *
 * @param {object} ctx - host context carrying `webServer`.
 * @param {object} options - wiring.
 * @param {import("./service.js").SessionTrashService} options.service - the service to expose.
 * @param {() => object} options.config - live config thunk.
 * @returns {() => void} the route disposer.
 */
export function registerTrashRoutes(ctx, { service, config }) {
  // The store's root is fixed when the plugin mounts, while the config is read
  // per request. Warn once when they disagree, so a profile edit that only takes
  // effect after a restart does not look like it was ignored.
  let rootMismatchWarned = false;
  const handler = async (req, res) => {
    const live = config();
    if (!rootMismatchWarned) {
      const mounted = service?.store?.root;
      if (typeof live.root === "string" && typeof mounted === "string" && live.root !== mounted) {
        rootMismatchWarned = true;
        ctx.logger?.warn?.(
          `session-trash: the configured root (${live.root}) differs from the mounted recycle bin (${mounted}); the mounted one stays in use until DSH restarts`
        );
      }
    }
    if (!isTrustedCaller(req, live.trustedHosts)) {
      writeJson(res, 403, { ok: false, code: "forbidden", message: "仅允许本机或受信任的主机调用" });
      return;
    }
    // Read per request, so flipping `enabled` in the profile takes effect without
    // waiting for a remount.
    if (!live.enabled) {
      writeJson(res, 404, { ok: false, code: "disabled", message: "session-trash is disabled" });
      return;
    }
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const action = url.pathname.replace(/^\/session-trash\/?/, "").replace(/\/+$/, "");

    if (method !== "GET" && method !== "POST") {
      writeJson(res, 405, { ok: false, code: "method-not-allowed", message: `${method} is not supported` });
      return;
    }
    if (method === "GET" && action !== "" && action !== "status" && action !== "list" && action !== "log") {
      writeJson(res, 405, { ok: false, code: "method-not-allowed", message: `${action} requires POST` });
      return;
    }

    try {
      if (method === "GET") {
        if (action === "" || action === "status") {
          writeJson(res, 200, { ok: true, value: await service.status({ retentionDays: live.retentionDays }) });
          return;
        }
        if (action === "list") {
          // The batch cap travels with the listing: the panel restores and purges
          // a selection in as many requests as the cap needs, so it has to know
          // the cap without asking for it separately.
          const value = await service.list({ retentionDays: live.retentionDays });
          writeJson(res, 200, { ok: true, value: { ...value, maxBatch: live.maxBatch } });
          return;
        }
        const requested = Number(url.searchParams.get("limit") ?? "200");
        // The audit log is append-only and never rotated, so an unbounded `limit`
        // would let one request read the whole history into memory. Clamp it:
        // the panel asks for 50, and the ceiling still allows far more.
        const limit = Number.isFinite(requested)
          ? Math.min(Math.max(Math.floor(requested), 0), LOG_MAX_LIMIT)
          : 200;
        writeJson(res, 200, {
          ok: true,
          value: { records: await service.log({ limit }) }
        });
        return;
      }

      const body = await readJsonBody(req);
      if (body === BODY_TOO_LARGE) {
        writeJson(res, 413, { ok: false, code: "body-too-large", message: `请求体超过 ${String(BODY_MAX_BYTES)} 字节` });
        return;
      }
      const payload = body ?? {};
      switch (action) {
        case "plan": {
          // Planning walks every session's directory, so it is bounded — but by a
          // read budget, not the mutation cap: see PLAN_MAX_IDS.
          const bounded = boundedIds(live, payload.sessionIds, "会话", Math.max(live.maxBatch, PLAN_MAX_IDS));
          if (!bounded.ok) {
            writeJson(res, 400, bounded.body);
            return;
          }
          // One round trip carries everything the dialog needs to render — the
          // plans, the bin root the description names, and the batch size the
          // client chunks its delete request by. Asking for `/status` separately
          // only made the dialog's first paint wait for a second request.
          const [plans, status] = await Promise.all([
            // Sizes are opt-in (`sizes: true`): the delete dialog never renders
            // them, and walking every directory on every open is work nobody reads.
            service.plan(bounded.ids, { sizes: payload.sizes === true }),
            service.status({ retentionDays: live.retentionDays })
          ]);
          writeJson(res, 200, {
            ok: true,
            value: {
              plans,
              root: status.root,
              maxBatch: live.maxBatch,
              quickDelete: live.quickDelete !== false,
              retentionDays: status.retentionDays,
              canDelete: status.canDelete
            }
          });
          return;
        }
        case "delete": {
          const bounded = boundedIds(live, payload.sessionIds, "会话");
          if (!bounded.ok) {
            writeJson(res, 400, bounded.body);
            return;
          }
          const value = await service.deleteSessions({
            sessionIds: bounded.ids,
            titles: Array.isArray(payload.titles) ? payload.titles : [],
            stopActivity: payload.stopActivity === true,
            // An explicit "delete anyway" from a client that already told the user
            // its work would be stopped. Without it, a session the runtime refuses
            // to let go of can only ever be refused.
            force: payload.force === true,
            waitForReleaseMs: payload.waitForReleaseMs,
            actor: live.actor
          });
          writeJson(res, 200, { ok: true, value });
          return;
        }
        case "restore": {
          const bounded = boundedIds(live, payload.trashIds, "回收站项目");
          if (!bounded.ok) {
            writeJson(res, 400, bounded.body);
            return;
          }
          const value = await service.restoreSessions({ trashIds: bounded.ids, actor: live.actor });
          writeJson(res, 200, { ok: true, value });
          return;
        }
        case "purge": {
          const requested = stringArray(payload.trashIds);
          if (requested.length === 0) {
            writeJson(res, 400, { ok: false, code: "empty-selection", message: "未选择任何回收站项目" });
            return;
          }
          // The `["*"]` sentinel is exempt from the batch cap: it names the bin's
          // own contents rather than a caller-chosen set.
          const isSentinel = requested.length === 1 && requested[0] === "*";
          if (!isSentinel && requested.length > live.maxBatch) {
            writeJson(res, 400, {
              ok: false,
              code: "batch-too-large",
              message: `一次最多彻底删除 ${String(live.maxBatch)} 个项目`
            });
            return;
          }
          const value = await service.purgeSessions({
            trashIds: requested,
            acknowledge: payload.acknowledge === true,
            actor: live.actor
          });
          if (value.refused === true) {
            writeJson(res, 428, { ok: false, code: value.code, message: "彻底删除需要显式确认" });
            return;
          }
          writeJson(res, 200, { ok: true, value });
          return;
        }
        default:
          writeJson(res, 404, { ok: false, code: "unknown-action", message: `unknown action ${JSON.stringify(action)}` });
      }
    } catch (error) {
      ctx.logger?.error?.(`session-trash: route ${method} /${action} failed: ${String(error?.stack ?? error)}`);
      writeJson(res, 500, { ok: false, code: "internal", message: String(error?.message ?? error) });
    }
  };

  return ctx.webServer.register({ kind: "prefix", path: "/session-trash", handler });
}
