/**
 * `dsh-session-trash` — host half.
 *
 * DSH can archive a session but cannot delete one: the persistence seam exposes
 * only create/open/stat/list/flush, and nothing in the product removes a stored
 * session. This plugin adds that capability without patching DSH, by moving a
 * session's own directory into a recycle bin and removing the id from DSH's
 * durable accounting afterwards.
 *
 * The host half owns the routes, the recycle bin, and every safety decision; the
 * client half (`./client`, served by DSH's client module system) owns the menu
 * entry, the confirmations, and the bin UI.
 *
 * Config (all optional, read from this plugin row's `config:` block):
 *
 * | Key | Default | Meaning |
 * |---|---|---|
 * | `enabled` | `true` | Mount routes at all |
 * | `root` | `<dshHome>/session-trash` | Recycle-bin root |
 * | `retentionDays` | `30` | Window used to *mark* items expired (never deletes) |
 * | `maxBatch` | `100` | Largest accepted batch for any action |
 * | `actor` | `session-menu` | Audit label written to the log |
 * | `quickDelete` | `true` | Delete a quiet session straight from the menu, with no dialog |
 * | `trustedHosts` | `[]` | Extra non-loopback authorities allowed to call the routes |
 *
 * @module dsh-session-trash
 */

import path from "node:path";

import { dshHome } from "./host/locate.js";
import { registerTrashRoutes } from "./host/routes.js";
import { SessionTrashService } from "./host/service.js";
import { TrashStore } from "./host/trash-store.js";

/** Package id; also the browser module id the client bundle registers under. */
export const name = "dsh-session-trash";

/** Largest accepted batch, mirrored here so validation cannot be configured away. */
const MAX_BATCH_CEILING = 1000;

/** Largest accepted retention window. */
const MAX_RETENTION_DAYS = 3650;

/** Longest authority string accepted in `trustedHosts`. */
const AUTHORITY_MAX = 255;

/**
 * Read one config value, tolerating the live references a settings write leaves
 * behind (such values expose `get()` instead of the value itself).
 *
 * @param {object|undefined} config - the row's config.
 * @param {string} key - field name.
 * @param {*} fallback - value used when the field is absent or null.
 * @returns {*} the effective value.
 */
function readConfigValue(config, key, fallback) {
  const raw = config?.[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "object" && typeof raw.get === "function") {
    const value = raw.get();
    return value === undefined || value === null ? fallback : value;
  }
  return raw;
}

/**
 * Resolve the effective configuration.
 * @param {object|undefined} config - the row's config.
 * @returns {object} validated configuration.
 */
function effectiveConfig(config) {
  const rawRoot = readConfigValue(config, "root", undefined);
  const root =
    typeof rawRoot === "string" && rawRoot.trim() !== ""
      ? path.resolve(rawRoot)
      : path.join(dshHome(), "session-trash");
  const retentionDays = Number(readConfigValue(config, "retentionDays", 30));
  const maxBatch = Number(readConfigValue(config, "maxBatch", 100));
  const rawTrusted = readConfigValue(config, "trustedHosts", []);
  return {
    // Non-loopback authorities this deployment serves. Values are shape-checked
    // because they widen an access decision.
    trustedHosts: (Array.isArray(rawTrusted) ? rawTrusted : [])
      .filter((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= AUTHORITY_MAX)
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z0-9._:\-\[\]]+$/.test(entry)),
    enabled: readConfigValue(config, "enabled", true) !== false,
    root,
    retentionDays:
      Number.isFinite(retentionDays) && retentionDays >= 0
        ? Math.min(retentionDays, MAX_RETENTION_DAYS)
        : 30,
    maxBatch: Number.isFinite(maxBatch) && maxBatch >= 1 ? Math.min(Math.floor(maxBatch), MAX_BATCH_CEILING) : 100,
    // The menu can delete a quiet session outright. Off means "always show the
    // dialog", which is the pre-1.2 flow; it is a preference, not a safety gate.
    quickDelete: readConfigValue(config, "quickDelete", true) !== false,
    actor: typeof readConfigValue(config, "actor", undefined) === "string" ? readConfigValue(config, "actor") : "session-menu"
  };
}

/**
 * Mount the recycle bin: one store, one service, one prefix route.
 *
 * @param {object} ctx - host context.
 * @param {object} [config] - this plugin row's config.
 */
export function apply(ctx, config) {
  const live = () => effectiveConfig(config);

  // A bin nested under the session store would be scanned by the locator and
  // could be mistaken for stored sessions; warn once instead of failing, since
  // the operator may have a reason.
  const initial = live();
  if (initial.root === dshHome() || initial.root.startsWith(path.join(dshHome(), "sessions"))) {
    ctx.logger?.warn?.(
      `dsh-session-trash: trash root ${initial.root} overlaps the session store; choose a directory outside ${path.join(dshHome(), "sessions")}`
    );
  }

  const store = new TrashStore({ root: initial.root, logger: ctx.logger });
  const service = new SessionTrashService(ctx, { store });

  // Create the layout eagerly so a broken (unwritable) root is reported at
  // mount time rather than on the user's first delete.
  ctx.effect(() => {
    let alive = true;
    store
      .init()
      .then(() => {
        if (alive) ctx.logger?.info?.(`dsh-session-trash: recycle bin ready at ${store.root}`);
      })
      .catch((error) => {
        ctx.logger?.error?.(`dsh-session-trash: recycle bin is not writable at ${store.root}: ${String(error)}`);
      });
    return () => {
      alive = false;
    };
  }, "dsh-session-trash: recycle-bin layout");

  // `webServer` is the only hard requirement: without it there is no transport
  // to the client, so the plugin simply stays dormant rather than half-mounting.
  //
  // The route is registered unconditionally and `enabled` is read per request, so
  // turning the plugin off in the profile takes effect immediately instead of
  // requiring a remount. A disabled plugin answers 404 with a reason rather than
  // silently having no route.
  ctx.inject(["webServer"], (scope) => {
    scope.effect(() => registerTrashRoutes(scope, { service, config: live }), "dsh-session-trash: /session-trash routes");
  });
}

export { SessionTrashService, TrashStore };
