/**
 * `dsh-session-trash` — browser half.
 *
 * Loaded by DSH's client module system, which serves this file at
 * `/plugins/dsh-session-trash/client.js` and executes the `load({id, factory})`
 * call below. The factory body runs lazily on first materialization, so the
 * module registers a factory and nothing here runs at parse time.
 *
 * The bundle is hand-written in DSH's lazy-CJS dialect rather than produced by a
 * bundler, which keeps the plugin dependency-free and reviewable:
 *
 * - `require` resolves only the frozen platform table (React, the store, the
 *   component primitives). Those are exactly the specifiers used below.
 * - The module exports `apply` (the Cordis plugin body) and `inject`.
 *   `inject` is deliberately `[]`: services are acquired reactively inside
 *   `apply` with `ctx.inject`, so this entry can never leave the page boot
 *   waiting on a service it names, and a deployment missing an optional service
 *   degrades instead of failing the whole GUI's boot audit.
 *
 * Surface it contributes:
 *
 * | Slot | Purpose |
 * |---|---|
 * | `sidebar.workspaces.session.menu.item` | 删除 (order 500), 批量删除 (order 600) |
 * | `shell.overlay` | the two-step confirm dialog and the undo notice |
 * | `sidebar.panellist` | the 回收站 sidebar entry |
 * | `main` (keyed) | the 回收站 page |
 *
 * @module dsh-session-trash/client
 */

window.__ModuleLoader__.load({
  id: "dsh-session-trash",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const clientStore = require("@deepseek-ai/dsh-client-store");

    const h = React.createElement;
    const { useState, useEffect, useMemo } = React;
    const {
      MenuItemButton,
      Modal,
      Button,
      Checkbox,
      Tooltip,
      Toast,
      Tag,
      IconTrashOutlineRegular,
      IconUnarchiveOutlineRegular,
      IconRefreshOutlineRegular,
      IconLoadingOutlineRegular
    } = primitives;

    /**
     * Stylesheet for this plugin's surfaces.
     *
     * Injected at materialization, attributed with `data-plugin` so DSH's module
     * system can retire it when the plugin unloads, and keyed with
     * `data-plugin-css` so a re-materialization cannot double-inject. Every colour
     * comes from a `--dsw-*` design token, so the panel follows the app's theme
     * (including dark mode) instead of pinning its own palette.
     */
    const CSS = `
.dsh-trash-panel { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; overflow-y: auto; height: 100%; box-sizing: border-box; }
.dsh-trash-panelHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-trash-panelHead h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-trash-panelActions { display: flex; align-items: center; gap: 4px; }
.dsh-trash-stats { margin: 0; font-size: var(--dsw-font-xs-13); color: var(--dsw-alias-label-tertiary); }
.dsh-trash-muted { color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xs-13); }
.dsh-trash-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: var(--dsw-font-xs-13); }
.dsh-trash-warning { margin: 0; color: var(--dsw-alias-state-warn-primary); font-size: var(--dsw-font-xs-13); }
.dsh-trash-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-trash-bulk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-trash-search { width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: var(--dsw-font-xs-13); }
.dsh-trash-search:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.dsh-trash-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.dsh-trash-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--dsw-radius-md); }
.dsh-trash-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-trash-rowMeta { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
.dsh-trash-rowActions { display: flex; align-items: center; gap: 2px; }
.dsh-trash-iconButton { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-trash-iconButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-trash-iconButton:disabled { opacity: 0.5; cursor: default; }
.dsh-trash-iconButton:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.dsh-trash-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 40px 0; color: var(--dsw-alias-label-tertiary); text-align: center; }
.dsh-trash-empty p { margin: 0; }
.dsh-trash-summary { display: flex; flex-direction: column; gap: 8px; }
.dsh-trash-summary p { margin: 0; font-size: var(--dsw-font-xs-13); color: var(--dsw-alias-label-secondary); line-height: 1.6; word-break: break-all; }
.dsh-trash-activity { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--dsw-font-xs-13); color: var(--dsw-alias-label-secondary); }
.dsh-trash-activity li { display: flex; gap: 8px; }
.dsh-trash-activityKind { color: var(--dsw-alias-label-tertiary); min-width: 64px; }
.dsh-trash-log { color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xs-13); }
.dsh-trash-log summary { cursor: pointer; }
.dsh-trash-log ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-variant-numeric: tabular-nums; }
`;

    /** Install {@link CSS} once per document. */
    function injectStyles() {
      if (typeof document === "undefined") return;
      const tagId = "dsh-session-trash/styles.css";
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-trash";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    injectStyles();

    /** Dictionary namespace owned by this plugin. */
    const NS = "sessionTrash";
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = "session-trash";
    /** Host route prefix. */
    const ROUTE = "/session-trash";
    /** Menu order: after archive (400), so the destructive action is last. */
    const ORDER_SINGLE = 500;
    /** Menu order for the batch entry. */
    const ORDER_BATCH = 600;
    /** How long to wait for a session to leave memory after the user navigates away. */
    const RELEASE_WAIT_MS = 8000;
    /**
     * Batch size assumed before the host has said otherwise.
     *
     * The host reports its real cap in the preflight answer; this is only the
     * chunk size used to *ask*, and matching the host default keeps the common
     * case to a single request.
     */
    const DEFAULT_MAX_BATCH = 100;
    /**
     * Total delete time above which the notice explains where the time went.
     *
     * A consented forced delete no longer waits this long (the host probes for
     * `FORCE_RELEASE_PROBE_MS` instead), so anything crossing this line is a real
     * signal: a slow stop, a big directory, or a second thing slowing the host down.
     */
    const SLOW_DELETE_MS = 1500;
    /**
     * How long the dialog stays on plain "working" before it says what it is doing.
     *
     * A spinner that never changes tells the user nothing about the few seconds
     * they are now expected to wait; naming the steps does.
     */
    const PENDING_HINT_MS = 700;

    //#region pure helpers (exported for tests)

    /**
     * Human byte size, matching the panel's compact style.
     * @param {number} bytes - size in bytes.
     * @returns {string} display text.
     */
    function formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let index = 0;
      let scaled = value;
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
      }
      const rounded = scaled >= 10 || index === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
      return `${String(rounded)} ${units[index]}`;
    }

    /**
     * Relative age text for a deletion timestamp.
     * @param {number} epochMs - when the item was deleted.
     * @param {number} [now] - reference time.
     * @returns {string} display text.
     */
    function formatAge(epochMs, now = Date.now()) {
      if (!Number.isFinite(epochMs)) return "";
      const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
      if (seconds < 60) return "刚刚";
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${String(minutes)} 分钟前`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${String(hours)} 小时前`;
      const days = Math.round(hours / 24);
      return `${String(days)} 天前`;
    }

    /**
     * Whether a preflight plan can be deleted at all.
     * @param {object} plan - one plan from the host.
     * @returns {boolean} true when the session directory was found.
     */
    function isDeletable(plan) {
      return plan?.deletable === true;
    }

    /**
     * Whether a plan describes a session whose files are already gone.
     *
     * The sidebar keeps rendering a session until the client's list drops it, and a
     * session the runtime still holds cannot be dropped (DSH has no dispose-by-id),
     * so a deleted session can linger as a row with nothing behind it. Calling that
     * row "不可删除" reads as a failure of the delete the user just performed; it is
     * really the leftover of one, and it clears when the app restarts.
     *
     * @param {object} plan - one plan from the host.
     * @returns {boolean} true when the session is listed but has no files.
     */
    function isGone(plan) {
      return plan?.exists === false || plan?.code === "not-found";
    }

    /**
     * Whether a plan needs the user's explicit consent to stop running work.
     * A failed activity probe is unknown, not idle, so it needs that consent too.
     * @param {object} plan - one plan from the host.
     * @returns {boolean} true when work or a live runtime blocks a quiet delete.
     */
    function needsConsent(plan) {
      return (
        plan?.resident === true ||
        plan?.activityKnown === false ||
        (Array.isArray(plan?.activity) && plan.activity.length > 0)
      );
    }

    /**
     * Flatten the host's activity families into display rows.
     * @param {Array<object>} activity - activity families.
     * @returns {Array<{kind: string, label: string}>} rows.
     */
    function activityRows(activity) {
      const rows = [];
      for (const family of Array.isArray(activity) ? activity : []) {
        const kind = String(family?.kind ?? "work");
        const items = Array.isArray(family?.items) ? family.items : [];
        if (items.length === 0) {
          rows.push({ kind, label: kind });
          continue;
        }
        for (const item of items) {
          rows.push({ kind, label: String(item?.label ?? item?.title ?? item?.id ?? kind) });
        }
      }
      return rows;
    }

    /**
     * Summarize a selection so both confirmation steps show the same numbers.
     *
     * @param {object[]} plans - preflight plans.
     * @param {string[]} selectedIds - ids currently checked.
     * @param {(plan: object) => boolean} [isExpired] - unused; reserved.
     * @returns {object} counts used by the dialog.
     */
    function summarizeSelection(plans, selectedIds) {
      const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
      const rows = (Array.isArray(plans) ? plans : []).filter((plan) => selected.has(plan.sessionId));
      return {
        count: rows.length,
        bytes: rows.reduce((sum, plan) => sum + (Number(plan.bytes) || 0), 0),
        runningCount: rows.filter((plan) => plan.running === true).length,
        consentCount: rows.filter(needsConsent).length,
        goneCount: rows.filter(isGone).length,
        // Already-deleted rows are excluded: they are not a blocker, and counting them
        // would tell the user their own successful delete had failed.
        blockedCount: rows.filter((plan) => !isDeletable(plan) && !isGone(plan)).length
      };
    }

    /**
     * Whether the primary action may run.
     * @param {object} dialog - the dialog state.
     * @returns {boolean} true when at least one session is selected.
     */
    function canAdvance(dialog) {
      if (dialog === null || !Array.isArray(dialog.plans)) return false;
      const selected = new Set(dialog.selectedIds ?? []);
      return dialog.plans.some((plan) => selected.has(plan.sessionId));
    }

    /**
     * Split ids into the host's batch size.
     *
     * @param {string[]} ids - ids to split.
     * @param {number} size - maximum per chunk.
     * @returns {string[][]} chunks in input order (empty input ⇒ no chunks).
     */
    function chunkIds(ids, size) {
      const list = Array.isArray(ids) ? ids : [];
      const limit = Math.max(1, Math.floor(Number(size) || 1));
      const chunks = [];
      for (let index = 0; index < list.length; index += limit) chunks.push(list.slice(index, index + limit));
      return chunks;
    }

    /**
     * Whether a single session can be deleted without a confirmation step.
     *
     * This is the shortcut that removes a whole dialog from the common case: the
     * menu item the user just chose *is* the decision, nothing running will be
     * stopped, and nothing is resident, so there is no consent to collect and no
     * consequence to spell out. Anything that would stop work, or that has no
     * files to move, keeps the dialog — the impact has to be visible there.
     *
     * @param {object} plan - one preflight answer.
     * @returns {boolean} true when the delete is unremarkable.
     */
    function isQuickDelete(plan) {
      return (
        plan !== null &&
        typeof plan === "object" &&
        isDeletable(plan) === true &&
        needsConsent(plan) === false &&
        plan.running !== true
      );
    }

    /**
     * Where a delete actually spent its time — but only when that is worth saying.
     *
     * The host times each phase of every session it deletes (locate / inspect /
     * stop / archive / wait / move / cleanup) and ships the numbers back. A fast
     * delete has nothing to explain; a slow one is far easier to fix when the
     * notice says which phase burned the budget instead of leaving the user
     * watching a spinner and guessing.
     *
     * @param {unknown} results - the per-session results from the host.
     * @returns {{total: number, stop: number, wait: number, move: number}|null}
     *   summed phase totals, or `null` when no session reported timings or the
     *   delete was fast enough that naming a phase would be noise.
     */
    function deleteTimings(results) {
      const rows = (Array.isArray(results) ? results : []).filter(
        (row) => row !== null && typeof row === "object" && row.timings !== undefined && row.timings !== null
      );
      if (rows.length === 0) return null;
      const sum = (name) => rows.reduce((total, row) => total + (Number(row.timings?.[name]) || 0), 0);
      const total = rows.reduce(
        (all, row) => all + Object.values(row.timings ?? {}).reduce((phaseTotal, value) => phaseTotal + (Number(value) || 0), 0),
        0
      );
      return total < SLOW_DELETE_MS ? null : { total, stop: sum("stop"), wait: sum("wait"), move: sum("move") };
    }

    /**
     * The request body for `POST /session-trash/delete`.
     *
     * Every selected session is sent: the host decides per session what it can do
     * with it (move it to the bin, or clear a row whose files are already gone)
     * and reports a reason for anything it will not touch. `stopActivity` is set
     * when any of them needs consent — the host re-checks every one of those
     * facts, so this is convenience, not authority.
     *
     * @param {object} dialog - the dialog state.
     * @param {Array<{sessionId: string, displayTitle?: string}>} titles - display titles by id.
     * @returns {object} the request body.
     */
    function buildDeletePayload(dialog, titles = []) {
      const selected = new Set(dialog?.selectedIds ?? []);
      const chosen = (dialog?.plans ?? []).filter((plan) => selected.has(plan.sessionId));
      const titleById = new Map((Array.isArray(titles) ? titles : []).map((row) => [row.sessionId, row.displayTitle]));
      const consent = chosen.some(needsConsent);
      return {
        sessionIds: chosen.map((plan) => plan.sessionId),
        titles: chosen.map((plan) => ({ sessionId: plan.sessionId, title: titleById.get(plan.sessionId) })),
        // One consent, two consequences: stop the work, and do not refuse merely
        // because the runtime still holds the session. A user who has been told
        // their work will stop and has clicked anyway must not then be told the
        // delete failed.
        stopActivity: consent,
        force: consent,
        waitForReleaseMs: RELEASE_WAIT_MS
      };
    }

    /**
     * Classify a host response envelope.
     * @param {number} status - HTTP status.
     * @param {object} body - decoded body.
     * @returns {{ok: boolean, value?: any, code?: string, message?: string}} normalized outcome.
     */
    function readEnvelope(status, body) {
      if (body !== null && typeof body === "object" && body.ok === true) return { ok: true, value: body.value };
      const message = body !== null && typeof body === "object" && typeof body.message === "string"
        ? body.message
        : `请求失败（HTTP ${String(status)}）`;
      return { ok: false, code: body?.code ?? "http-error", message };
    }

    /**
     * The rows the batch picker shows: ordinary sessions, newest first, blank
     * sessions and subagent children excluded because neither is a conversation a
     * user means to delete.
     *
     * The subagent bit is `origin === "subagent"`, exactly the rule DSH's own
     * sidebar uses to decide what a user sees (`sessionVisible`). `parentId` is
     * *not* that bit: an ordinary fork carries one too, and a fork is a
     * conversation the user may well mean to delete, so filtering on it would
     * silently drop fork rows the sidebar still shows.
     *
     * This list is the *candidate* set only. Whether a candidate may actually be
     * deleted is decided later, by the host's preflight and by the user — see
     * {@link batchVisiblePlans} for the rows the picker ends up offering.
     *
     * @param {object} snapshot - `sessions.list` snapshot.
     * @returns {Array<object>} candidate rows.
     */
    function batchCandidates(snapshot) {
      const byId = snapshot?.byId ?? {};
      const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : Object.keys(byId);
      return ids
        .map((id) => byId[id])
        .filter((row) => row !== undefined && row.blank !== true && row.origin !== "subagent")
        .map((row) => ({
          sessionId: row.id,
          displayTitle: row.displayTitle ?? row.id,
          running: row.running === true,
          cwd: row.cwd,
          archived: false
        }));
    }

    /**
     * The preflight answers the batch picker actually offers.
     *
     * The candidate list comes from the live session list, which still holds rows
     * the user can no longer act on: a session whose files already moved into the
     * recycle bin, and a session the user archived (the sidebar hides those under
     * the default filter). Offering them in a *bulk delete* picker was the bug —
     * the row said 「已删除」 next to a checkbox, so the list promised a deletion
     * that had already happened, and a bulk selection could sweep in rows the
     * user never saw in the sidebar.
     *
     * Both kinds are dropped from the batch list. The single-session dialog keeps
     * them: there the user asked for *that* row, and 「已删除」 there tells the
     * truth about a row that is still on screen.
     *
     * The host's answer is what decides, not the client's guess — the client
     * cannot see the archive set, and only the host can tell a residue row from
     * a session that was merely hidden.
     *
     * @param {Array<object>} plans - the host's preflight answers.
     * @returns {Array<object>} the rows the batch picker may offer.
     */
    function batchVisiblePlans(plans) {
      return (Array.isArray(plans) ? plans : []).filter(
        (plan) => plan?.archived !== true && !isGone(plan)
      );
    }

    //#endregion

    //#region locale

    /** Chinese copy; the key set is shared with {@link en}. */
    const zh = {
      "menu.delete": "删除会话",
      "menu.deleteBatch": "批量删除会话…",
      "panel.title": "回收站",
      "panel.empty": "回收站是空的",
      "panel.emptyHint": "删除的会话会先移到这里，可随时恢复。",
      "panel.count": "共 {count} 个",
      "panel.size": "占用 {size}",
      "panel.restore": "恢复",
      "panel.restoreAll": "恢复选中",
      "panel.purge": "彻底删除",
      "panel.purgeAll": "清空回收站",
      "panel.refresh": "刷新",
      "panel.selectAll": "全选",
      "panel.clearSelection": "取消选择",
      "panel.selected": "已选择 {count} 个",
      "panel.expired": "已超过保留期",
      "panel.broken": "{count} 个项目已损坏，无法恢复",
      "panel.brokenItem": "已损坏的项目",
      "panel.deletedAt": "删除于 {age}",
      "panel.retention": "保留 {days} 天",
      "panel.originalCwd": "原工作区：{cwd}",
      "panel.unknownTitle": "未命名会话",
      "panel.loading": "正在读取回收站…",
      "panel.error": "读取回收站失败：{message}",
      "panel.log": "操作日志",
      "panel.logEmpty": "暂无日志",
      "dialog.title.single": "删除此会话？",
      "dialog.title.batch": "批量删除会话",
      "dialog.desc.single": "“{title}”将被删除。会话文件会移到回收站：{root}，之后可随时在那里恢复。",
      "dialog.desc.batch": "已选择 {count} 个会话，它们将被删除。会话文件会移到回收站：{root}，之后可随时在那里恢复。",
      "dialog.consent": "{count} 个会话仍有进行中的工作。点击「强制删除」会先停止这些工作，再删除；被停止的工作不会自动继续。",
      "dialog.skipped": "{count} 个会话的目录无法安全确认，这些删除会被拒绝。",
      "dialog.gone": "已删除",
      "dialog.goneNote": "{count} 个会话已经没有会话文件了（可能已删除或已在回收站里）；删除只会把它们从列表里移除，如果 DSH 仍持有它们，重启后才会彻底消失。",
      "dialog.selectHint": "选择要删除的会话",
      "dialog.search": "搜索会话",
      "dialog.noSessions": "没有可删除的会话",
      "dialog.blocked": "目录无法确认",
      "dialog.blocked.running": "仍在运行",
      "dialog.blocked.missing": "找不到会话文件",
      "dialog.running": "运行中",
      "dialog.archived": "已归档",
      "dialog.pinned": "已置顶",
      "dialog.activity": "仍有进行中的工作",
      "dialog.activityUnknown": "无法确认该会话是否仍有正在进行的工作",
      "dialog.action.delete": "删除",
      "dialog.action.stopAndDelete": "强制删除",
      "dialog.action.cancel": "取消",
      "dialog.action.purge": "彻底删除",
      "dialog.action.purgeConfirm": "确认彻底删除",
      "dialog.purge.title": "彻底删除？",
      "dialog.purge.desc": "将永久删除 {count} 个会话，占用 {size}。此操作无法撤销，会话文件会被直接抹除。",
      "dialog.purge.ack": "我了解此操作无法恢复",
      "dialog.restoreFailed": "恢复失败",
      "dialog.busy": "正在处理…",
      "dialog.working": "正在停止该会话的工作、让它被释放，然后移入回收站；会话运行得越久，这一步越慢。",
      "dialog.result.deleted": "已删除 {count} 个会话",
      "dialog.result.failed": "{count} 个会话删除失败",
      "dialog.result.restored": "已恢复 {count} 个会话",
      "dialog.result.purged": "已彻底删除 {count} 个会话，释放 {size}",
      "notice.trashed": "会话已删除",
      "notice.trashedMany": "{count} 个会话已删除",
      "notice.undo": "撤销",
      "notice.openBin": "查看回收站",
      "notice.restored": "会话已恢复",
      "notice.forced": "{count} 个会话被强制删除；它们已被归档隐藏，重启 DSH 后彻底消失",
      "notice.cleaned": "{count} 个会话未找到会话目录，只从列表里移除了",
      "notice.unarchiveFailed": "{count} 个会话删除失败后未能取消归档（其文件仍在磁盘上）",
      "notice.slow": "本次删除耗时 {total}ms（停止工作 {stop}ms、等待释放 {wait}ms、移动文件 {move}ms）",
      "notice.join": "；",
      "notice.purged": "已彻底删除",
      "common.close": "关闭",
      "common.cancel": "取消",
      "noWorkspace": "未分组"
    };

    /** English copy. */
    const en = {
      "menu.delete": "Delete session",
      "menu.deleteBatch": "Delete multiple sessions…",
      "panel.title": "Recycle bin",
      "panel.empty": "The recycle bin is empty",
      "panel.emptyHint": "Deleted sessions arrive here first and can always be restored.",
      "panel.count": "{count} item(s)",
      "panel.size": "{size} used",
      "panel.restore": "Restore",
      "panel.restoreAll": "Restore selected",
      "panel.purge": "Delete forever",
      "panel.purgeAll": "Empty recycle bin",
      "panel.refresh": "Refresh",
      "panel.selectAll": "Select all",
      "panel.clearSelection": "Clear selection",
      "panel.selected": "{count} selected",
      "panel.expired": "Past retention",
      "panel.broken": "{count} broken item(s) cannot be restored",
      "panel.brokenItem": "Damaged item",
      "panel.deletedAt": "Deleted {age}",
      "panel.retention": "{days}-day retention",
      "panel.originalCwd": "Was in: {cwd}",
      "panel.unknownTitle": "Untitled session",
      "panel.loading": "Reading the recycle bin…",
      "panel.error": "Could not read the recycle bin: {message}",
      "panel.log": "Activity log",
      "panel.logEmpty": "No records yet",
      "dialog.title.single": "Delete this session?",
      "dialog.title.batch": "Delete sessions",
      "dialog.desc.single": "“{title}” will be deleted. Its files move to the recycle bin at {root} and can be restored from there at any time.",
      "dialog.desc.batch": "{count} session(s) will be deleted. Their files move to the recycle bin at {root} and can be restored from there at any time.",
      "dialog.consent": "{count} session(s) still have work in progress. “Force delete” stops that work first, then deletes; stopped work does not resume automatically.",
      "dialog.skipped": "{count} session(s) have a directory that cannot be safely confirmed; those deletions will be refused.",
      "dialog.gone": "Deleted",
      "dialog.goneNote": "{count} session(s) have no session files left (they may be deleted, or already in the bin). Deleting only removes them from this list; if DSH still holds them, they clear for good on the next restart.",
      "dialog.selectHint": "Choose the sessions to delete",
      "dialog.search": "Search sessions",
      "dialog.noSessions": "No sessions to delete",
      "dialog.blocked": "Not located",
      "dialog.blocked.running": "Still running",
      "dialog.blocked.missing": "Session files not found",
      "dialog.running": "Running",
      "dialog.archived": "Archived",
      "dialog.pinned": "Pinned",
      "dialog.activity": "Work still in progress",
      "dialog.activityUnknown": "Cannot confirm whether work is still in progress",
      "dialog.action.delete": "Delete",
      "dialog.action.stopAndDelete": "Force delete",
      "dialog.action.cancel": "Cancel",
      "dialog.action.purge": "Delete forever",
      "dialog.action.purgeConfirm": "Delete permanently",
      "dialog.purge.title": "Delete forever?",
      "dialog.purge.desc": "{count} session(s) totalling {size} will be erased permanently. This cannot be undone; the session files are removed outright.",
      "dialog.purge.ack": "I understand this cannot be undone",
      "dialog.restoreFailed": "Restore failed",
      "dialog.busy": "Working…",
      "dialog.working": "Stopping the session's work, letting it be released, then moving it to the bin; the longer a session has been running, the longer this takes.",
      "dialog.result.deleted": "Deleted {count} session(s)",
      "dialog.result.failed": "{count} session(s) failed to delete",
      "dialog.result.restored": "Restored {count} session(s)",
      "dialog.result.purged": "Permanently deleted {count} session(s), freeing {size}",
      "notice.trashed": "Session deleted",
      "notice.trashedMany": "{count} sessions deleted",
      "notice.undo": "Undo",
      "notice.openBin": "Open recycle bin",
      "notice.restored": "Session restored",
      "notice.forced": "{count} session(s) were force-deleted; they are archived out of sight and clear on the next DSH restart",
      "notice.cleaned": "{count} session(s) had no session directory found and were only removed from the list",
      "notice.unarchiveFailed": "{count} session(s) could not be un-archived after a failed delete (their files are still on disk)",
      "notice.slow": "this delete took {total}ms (stopping work {stop}ms, waiting for release {wait}ms, moving files {move}ms)",
      "notice.join": "; ",
      "notice.purged": "Permanently deleted",
      "common.close": "Close",
      "common.cancel": "Cancel",
      "noWorkspace": "Ungrouped"
    };

    //#endregion

    //#region host transport

    /**
     * Call the host half over same-origin fetch.
     *
     * @param {string} action - route action (`list`, `delete`, …).
     * @param {object} [options] - call options.
     * @param {"GET"|"POST"} [options.method] - HTTP method.
     * @param {object} [options.body] - JSON body for POST.
     * @param {AbortSignal} [options.signal] - cancellation.
     * @returns {Promise<object>} a normalized `{ok, value|code, message}` envelope.
     */
    async function callHost(action, { method = "GET", body, signal } = {}) {
      const response = await fetch(`${ROUTE}/${action}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
      let decoded = null;
      try {
        decoded = await response.json();
      } catch {
        decoded = null;
      }
      return readEnvelope(response.status, decoded);
    }

    //#endregion

    //#region store

    /**
     * The plugin's single shared store.
     *
     * One instance is created here and handed to every slot registration, so the
     * menu row, the dialogs, the notice, and the panel all read and write the same
     * state. `create` is overridden deliberately: the renderer would otherwise be
     * free to build one instance per entry, and the dialog would never see what the
     * menu row wrote.
     */
    const storeHandle = clientStore.defineStore({
      init: () => ({
        dialog: null,
        bin: { status: "idle", items: [], broken: [], stats: null, error: null, selected: [], maxBatch: DEFAULT_MAX_BATCH },
        purge: null,
        notice: null
      }),
      actions: {
        setDialog: (draft, dialog) => {
          draft.dialog = dialog;
        },
        patchDialog: (draft, patch) => {
          if (draft.dialog !== null) draft.dialog = { ...draft.dialog, ...patch };
        },
        setBin: (draft, bin) => {
          draft.bin = bin;
        },
        patchBin: (draft, patch) => {
          draft.bin = { ...draft.bin, ...patch };
        },
        setPurge: (draft, purge) => {
          draft.purge = purge;
        },
        patchPurge: (draft, patch) => {
          if (draft.purge !== null) draft.purge = { ...draft.purge, ...patch };
        },
        setNotice: (draft, notice) => {
          draft.notice = notice;
        }
      }
    });

    /** The shared store instance. */
    const storeInstance = storeHandle.create();

    /** The registration-facing handle that pins the shared instance. */
    const storeSeat = { ...storeHandle, create: () => storeInstance };

    //#endregion

    //#region components

    /**
     * One activity family rendered as a list of labelled rows.
     * @param {object} props - `{ activity, t }`.
     * @returns {any} the rows, or null.
     */
    function ActivityList({ activity, t }) {
      const rows = activityRows(activity);
      if (rows.length === 0) return null;
      return h(
        "ul",
        { className: "dsh-trash-activity" },
        rows.map((row, index) =>
          h(
            "li",
            { key: `${row.kind}-${String(index)}` },
            h("span", { className: "dsh-trash-activityKind" }, row.kind),
            h("span", null, row.label)
          )
        )
      );
    }

    /**
     * The session context-menu row that deletes one session.
     *
     * The only action that opens the dialog; the dialog itself lives in
     * `shell.overlay` because this row unmounts with the menu.
     *
     * @param {object} props - slot props: owner share, store hooks, and the locale seat.
     * @returns {any} the menu row.
     */
    function SessionTrashMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      const [busy, setBusy] = useState(false);
      return h(MenuItemButton, {
        danger: true,
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        disabled: busy,
        onSelect: () => {
          setMenuOpen(false);
          setBusy(true);
          Promise.resolve()
            .then(() => openDeleteDialog({ mode: "single", sessionId, displayTitle }, ctxRef))
            .catch(() => {})
            .finally(() => setBusy(false));
        },
        children: t("menu.delete")
      });
    }

    /**
     * The session context-menu row that opens the batch picker.
     *
     * It sits in the session menu because that is the only session-list menu the
     * workspace browser exposes; opening it from any row starts an unanchored
     * batch selection.
     *
     * @param {object} props - slot props.
     * @returns {any} the menu row.
     */
    function BatchTrashMenuItem(props) {
      const { useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      return h(MenuItemButton, {
        danger: true,
        separatorBefore: true,
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false);
          openDeleteDialog({ mode: "batch" }, ctxRef).catch(() => {});
        },
        children: t("menu.deleteBatch")
      });
    }

    /**
     * The `shell.overlay` seat: the delete dialog, the purge dialog, and the undo
     * notice. Kept separate from the panels so a dialog outlives the row that
     * raised it.
     *
     * @param {object} props - slot props including the store hooks and locale seat.
     * @returns {any} whichever overlay is active, or null.
     */
    function TrashOverlays(props) {
      const { useStore, t } = props;
      const dialog = useStore((state) => state.dialog);
      const purge = useStore((state) => state.purge);
      const notice = useStore((state) => state.notice);
      return h(
        React.Fragment,
        null,
        dialog === null ? null : h(DeleteDialog, { dialog, t }),
        purge === null ? null : h(PurgeDialog, { purge, t }),
        notice === null ? null : h(NoticeToast, { notice, t })
      );
    }

    /**
     * Shared shell for the two confirmation steps: a titled modal whose body
     * carries the explanation and whose footer carries the actions.
     *
     * @param {object} props - `{title, description, children, footer, t}`.
     * @returns {any} the modal.
     */
    function DialogShell({ title, description, children, footer, t }) {
      return h(
        Modal,
        {
          open: true,
          onClose: () => closeDialog(),
          closeLabel: t("common.close"),
          title,
          description,
          footer
        },
        children
      );
    }

    /** Step one: choose what to delete, with per-session blockers visible. */
    function DeletePickStep({ dialog, t }) {
      const [query, setQuery] = useState("");
      const plans = Array.isArray(dialog.plans) ? dialog.plans : [];
      const selected = useMemo(() => new Set(dialog.selectedIds ?? []), [dialog.selectedIds]);
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle === "") return plans;
        return plans.filter(
          (plan) =>
            plan.sessionId.toLowerCase().includes(needle) ||
            String(dialog.titleById?.[plan.sessionId] ?? "").toLowerCase().includes(needle)
        );
      }, [plans, query, dialog.titleById]);

      const toggle = (sessionId) => {
        const next = new Set(selected);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        storeInstance.actions.patchDialog({ selectedIds: [...next] });
      };
      // Every listed row is selectable: whether a delete can go through is the
      // user's call, and the host answers with a per-session result (a row whose
      // files are already gone is cleared from the list instead of being refused).
      // The row tags describe what will happen; they never take the choice away.
      const selectable = filtered;

      return h(
        React.Fragment,
        null,
        dialog.mode === "batch"
          ? h("input", {
              className: "dsh-trash-search",
              type: "search",
              placeholder: t("dialog.search"),
              value: query,
              onChange: (event) => setQuery(event.target.value)
            })
          : null,
        dialog.mode === "batch"
          ? h(
              "div",
              { className: "dsh-trash-bulk" },
              h(
                Button,
                {
                  variant: "ghost",
                  size: "sm",
                  onClick: () => storeInstance.actions.patchDialog({ selectedIds: selectable.map((plan) => plan.sessionId) })
                },
                t("panel.selectAll")
              ),
              h(Button, { variant: "ghost", size: "sm", onClick: () => storeInstance.actions.patchDialog({ selectedIds: [] }) }, t("panel.clearSelection")),
              h("span", { className: "dsh-trash-muted" }, t("panel.selected", { count: selected.size }))
            )
          : null,
        plans.length === 0
          ? h("p", { className: "dsh-trash-muted" }, t(dialog.mode === "batch" ? "dialog.noSessions" : "dialog.blocked.missing"))
          : h(
              "ul",
              { className: "dsh-trash-list", "aria-label": t("dialog.selectHint") },
              filtered.map((plan) => {
                const deletable = isDeletable(plan);
                const gone = isGone(plan);
                const title = dialog.titleById?.[plan.sessionId] ?? plan.sessionId;
                return h(
                  "li",
                  { key: plan.sessionId, className: "dsh-trash-row" },
                  h(Checkbox, {
                    checked: selected.has(plan.sessionId),
                    onChange: () => toggle(plan.sessionId),
                    label: title
                  }),
                  h(
                    "div",
                    { className: "dsh-trash-rowMeta" },
                    plan.running ? h(Tag, { tone: "warning" }, t("dialog.running")) : null,
                    plan.archived ? h(Tag, null, t("dialog.archived")) : null,
                    plan.pinned ? h(Tag, null, t("dialog.pinned")) : null,
                    gone ? h(Tag, null, t("dialog.gone")) : null,
                    !deletable && !gone ? h(Tag, { tone: "danger" }, t("dialog.blocked")) : null,
                    needsConsent(plan) && deletable
                      ? h(
                          Tag,
                          { tone: "warning" },
                          // The host only knows the activity state when its probe worked;
                          // "unknown" must not be rendered as "work is in progress".
                          plan.activityKnown === false ? t("dialog.activityUnknown") : t("dialog.activity")
                        )
                      : null
                  )
                );
              })
            )
      );
    }

    /**
     * The consequences of what is about to happen.
     *
     * This is the *only* confirmation step: one click on the dialog's primary
     * button moves the selection into the recycle bin. The safety comes from the
     * bin being recoverable plus telling the user up front what will move and what
     * work will be stopped, not from making them click twice.
     */
    function DeleteConsequences({ dialog, t }) {
      const summary = summarizeSelection(dialog.plans, dialog.selectedIds);
      return h(
        "div",
        { className: "dsh-trash-summary" },
        summary.consentCount > 0
          ? h(
              "p",
              { className: "dsh-trash-warning" },
              t("dialog.consent", { count: summary.consentCount })
            )
          : null,
        summary.blockedCount > 0
          ? h("p", { className: "dsh-trash-muted" }, t("dialog.skipped", { count: summary.blockedCount }))
          : null,
        summary.goneCount > 0
          ? h("p", { className: "dsh-trash-muted" }, t("dialog.goneNote", { count: summary.goneCount }))
          : null,
        dialog.error == null ? null : h("p", { className: "dsh-trash-error", role: "alert" }, String(dialog.error))
      );
    }

    /** The delete dialog: pick, see the consequences, delete into the bin. */
    function DeleteDialog({ dialog, t }) {
      const summary = summarizeSelection(dialog.plans, dialog.selectedIds);
      const canDelete = canAdvance(dialog);
      // The first moments of a delete are normal. Past that, say what the host is
      // actually doing instead of leaving a spinner that looks stuck.
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        if (dialog.pending !== true) {
          setBusy(false);
          return undefined;
        }
        const timer = setTimeout(() => setBusy(true), PENDING_HINT_MS);
        return () => clearTimeout(timer);
      }, [dialog.pending]);
      const footer = h(
        React.Fragment,
        null,
        h(
          Button,
          { variant: "outline", disabled: dialog.pending === true, onClick: () => closeDialog() },
          t("dialog.action.cancel")
        ),
        h(
          Button,
          {
            variant: "outline",
            className: "dsh-trash-danger",
            disabled: dialog.pending === true || !canDelete,
            onClick: () => confirmDelete()
          },
          summary.consentCount > 0 ? t("dialog.action.stopAndDelete") : t("dialog.action.delete")
        )
      );
      const title = t(dialog.mode === "batch" ? "dialog.title.batch" : "dialog.title.single");
      const description =
        dialog.mode === "single"
          ? t("dialog.desc.single", {
              title: dialog.singleTitle ?? dialog.sessionIds?.[0] ?? "",
              root: String(dialog.root ?? "")
            })
          : t("dialog.desc.batch", { count: summary.count, root: String(dialog.root ?? "") });
      return h(
        DialogShell,
        { title, description, footer, t },
        dialog.pending === true
          ? h("p", { className: "dsh-trash-muted" }, h(IconLoadingOutlineRegular, { size: 14 }), t("dialog.busy"))
          : null,
        dialog.pending === true && busy === true
          ? h("p", { className: "dsh-trash-muted" }, t("dialog.working"))
          : null,
        h(DeletePickStep, { dialog, t }),
        h(DeleteConsequences, { dialog, t })
      );
    }

    /** The irreversible purge confirmation, gated on an explicit acknowledgement. */
    function PurgeDialog({ purge, t }) {
      const count = Number(purge.count ?? 0);
      const size = formatBytes(purge.bytes ?? 0);
      return h(
        DialogShell,
        {
          title: t("dialog.purge.title"),
          description: t("dialog.purge.desc", { count, size }),
          t,
          footer: h(
            React.Fragment,
            null,
            h(Button, { variant: "outline", disabled: purge.pending === true, onClick: () => storeInstance.actions.setPurge(null) }, t("dialog.action.cancel")),
            h(
              Button,
              {
                variant: "outline",
                className: "dsh-trash-danger",
                disabled: purge.pending !== true ? purge.acknowledged !== true : true,
                onClick: () => confirmPurge().catch(() => {})
              },
              t("dialog.action.purgeConfirm")
            )
          )
        },
        h(Checkbox, {
          checked: purge.acknowledged === true,
          onChange: () => storeInstance.actions.patchPurge({ acknowledged: purge.acknowledged !== true }),
          label: t("dialog.purge.ack")
        }),
        purge.error == null ? null : h("p", { className: "dsh-trash-error", role: "alert" }, String(purge.error))
      );
    }

    /** The undo notice, matching the archive flow's affordance. */
    function NoticeToast({ notice, t }) {
      const actions = [];
      if (notice.undo !== null && notice.undo !== undefined) {
        actions.push({
          prefix: " ",
          label: t("notice.undo"),
          onClick: () => {
            undoNotice(notice).catch(() => {});
          }
        });
      }
      actions.push({
        prefix: " ",
        label: t("notice.openBin"),
        onClick: () => openBinPanel()
      });
      return h(Toast, {
        text: notice.detail == null ? notice.text : `${notice.text} · ${String(notice.detail)}`,
        tone: notice.tone ?? "success",
        actions,
        onDone: () => storeInstance.actions.setNotice(null)
      });
    }

    /** The sidebar entry that opens the recycle-bin panel. */
    function TrashPanelIcon({ size }) {
      // `sidebar.panellist` renders its entries with the sidebar's own size, so
      // honour it rather than pinning a size that would not match its neighbours.
      return h(IconTrashOutlineRegular, { size: size ?? 16 });
    }

    /**
     * The recycle-bin page: list, restore, purge, and the audit log.
     *
     * @param {object} props - slot props including the store hooks and locale seat.
     * @returns {any} the page.
     */
    function TrashPanel(props) {
      const { useStore, t } = props;
      const bin = useStore((state) => state.bin);
      const selected = useMemo(() => new Set(bin.selected ?? []), [bin.selected]);
      const rows = Array.isArray(bin.items) ? bin.items : [];
      // Damaged items are reported by the host in a separate list: they cannot be
      // restored, but the user must still see them and be able to purge them.
      const brokenRows = Array.isArray(bin.broken) ? bin.broken : [];
      const loading = bin.status === "loading";

      useEffect(() => {
        refreshBin().catch(() => {});
      }, []);

      const toggle = (trashId) => {
        const next = new Set(selected);
        if (next.has(trashId)) next.delete(trashId);
        else next.add(trashId);
        storeInstance.actions.patchBin({ selected: [...next] });
      };
      const selectedRows = rows.filter((row) => selected.has(row.trashId));
      const selectedBroken = brokenRows.filter((row) => selected.has(row.trashId));
      // Only intact items can be restored; both kinds can be purged.
      const selectedBytes = selectedRows.reduce((sum, row) => sum + (row.totalBytes ?? 0), 0);
      const selectedCount = selectedRows.length + selectedBroken.length;
      const selectedPurgeIds = [...selectedRows.map((row) => row.trashId), ...selectedBroken.map((row) => row.trashId)];

      return h(
        "section",
        { className: "dsh-trash-panel", "aria-label": t("panel.title") },
        h(
          "header",
          { className: "dsh-trash-panelHead" },
          h("h2", null, t("panel.title")),
          h(
            "div",
            { className: "dsh-trash-panelActions" },
            h(
              Tooltip,
              { label: t("panel.refresh"), side: "bottom", delayMs: 400 },
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-trash-iconButton",
                  "aria-label": t("panel.refresh"),
                  onClick: () => {
                    refreshBin().catch(() => {});
                  },
                  disabled: loading
                },
                h(IconRefreshOutlineRegular, { size: 14 })
              )
            )
          )
        ),
        bin.stats === null
          ? null
          : h(
              "p",
              { className: "dsh-trash-stats" },
              t("panel.count", { count: bin.stats.count ?? rows.length }),
              bin.stats.bytes > 0 ? ` · ${t("panel.size", { size: formatBytes(bin.stats.bytes) })}` : "",
              bin.stats.retentionDays > 0 ? ` · ${t("panel.retention", { days: bin.stats.retentionDays })}` : ""
            ),
        loading && rows.length === 0 ? h("p", { className: "dsh-trash-muted" }, t("panel.loading")) : null,
        bin.error == null ? null : h("p", { className: "dsh-trash-error", role: "alert" }, t("panel.error", { message: String(bin.error) })),
        bin.broken !== null && Array.isArray(bin.broken) && bin.broken.length > 0
          ? h("p", { className: "dsh-trash-warning" }, t("panel.broken", { count: bin.broken.length }))
          : null,
        rows.length === 0 && brokenRows.length === 0
          ? h(
              "div",
              { className: "dsh-trash-empty" },
              h(IconTrashOutlineRegular, { size: 24 }),
              h("p", null, t("panel.empty")),
              h("p", { className: "dsh-trash-muted" }, t("panel.emptyHint"))
            )
          : h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "dsh-trash-bulk" },
                h(
                  Button,
                  {
                    variant: "ghost",
                    size: "sm",
                    onClick: () =>
                      storeInstance.actions.patchBin({
                        selected: [...rows.map((row) => row.trashId), ...brokenRows.map((row) => row.trashId)]
                      })
                  },
                  t("panel.selectAll")
                ),
                h(Button, { variant: "ghost", size: "sm", onClick: () => storeInstance.actions.patchBin({ selected: [] }) }, t("panel.clearSelection")),
                h(
                  Button,
                  {
                    variant: "outline",
                    size: "sm",
                    disabled: selectedRows.length === 0,
                    onClick: () => {
                      restoreSelected(selectedRows.map((row) => row.trashId)).catch(() => {});
                    }
                  },
                  t("panel.restoreAll")
                ),
                h(
                  Button,
                  {
                    variant: "outline",
                    size: "sm",
                    className: "dsh-trash-danger",
                    disabled: selectedCount === 0,
                    onClick: () => {
                      storeInstance.actions.setPurge({
                        trashIds: selectedPurgeIds,
                        count: selectedCount,
                        bytes: selectedBytes,
                        acknowledged: false,
                        pending: false,
                        error: null
                      });
                    }
                  },
                  t("panel.purge")
                ),
                h(
                  Button,
                  {
                    variant: "outline",
                    size: "sm",
                    className: "dsh-trash-danger",
                    onClick: () => {
                      // The `["*"]` sentinel asks the host to erase whatever the bin
                      // holds; the host expands it only after the acknowledgement.
                      storeInstance.actions.setPurge({
                        trashIds: ["*"],
                        count: rows.length + brokenRows.length,
                        bytes: bin.stats?.bytes ?? 0,
                        acknowledged: false,
                        pending: false,
                        error: null
                      });
                    }
                  },
                  t("panel.purgeAll")
                )
              ),
              h(
                "ul",
                { className: "dsh-trash-list" },
                rows.map((row) =>
                  h(
                    "li",
                    { key: row.trashId, className: "dsh-trash-row" },
                    h(Checkbox, { checked: selected.has(row.trashId), onChange: () => toggle(row.trashId), label: row.title ?? t("panel.unknownTitle") }),
                    h(
                      "div",
                      { className: "dsh-trash-rowMeta" },
                      h("span", { className: "dsh-trash-muted" }, t("panel.deletedAt", { age: formatAge(row.deletedAt) })),
                      row.expired ? h(Tag, { tone: "warning" }, t("panel.expired")) : null,
                      h("span", { className: "dsh-trash-muted" }, formatBytes(row.totalBytes)),
                      row.cwd ? h("span", { className: "dsh-trash-muted" }, row.cwd) : null
                    ),
                    h(
                      "div",
                      { className: "dsh-trash-rowActions" },
                      h(
                        Tooltip,
                        { label: t("panel.restore"), side: "bottom", delayMs: 400 },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "dsh-trash-iconButton",
                            "aria-label": t("panel.restore"),
                            onClick: () => {
                              restoreSelected([row.trashId]).catch(() => {});
                            }
                          },
                          h(IconUnarchiveOutlineRegular, { size: 14 })
                        )
                      )
                    )
                  )
                )
              ),
              // Damaged items are listed as rows of their own: a count alone would
              // leave the user with an entry they cannot act on.
              brokenRows.length === 0
                ? null
                : h(
                    "ul",
                    { className: "dsh-trash-list" },
                    brokenRows.map((row) =>
                      h(
                        "li",
                        { key: row.trashId, className: "dsh-trash-row" },
                        h(Checkbox, {
                          checked: selected.has(row.trashId),
                          onChange: () => toggle(row.trashId),
                          label: `${t("panel.brokenItem")} (${String(row.state ?? "broken")})`
                        }),
                        h(
                          "div",
                          { className: "dsh-trash-rowMeta" },
                          h(Tag, { tone: "danger" }, String(row.state ?? "broken")),
                          row.error ? h("span", { className: "dsh-trash-muted" }, String(row.error)) : null
                        )
                      )
                    )
                  )
            ),
        Array.isArray(bin.log) && bin.log.length > 0
          ? h(
              "details",
              { className: "dsh-trash-log" },
              h("summary", null, t("panel.log")),
              h(
                "ul",
                null,
                bin.log.slice(0, 50).map((record, index) =>
                  h(
                    "li",
                    { key: `${String(record.ts)}-${String(index)}` },
                    `${String(record.tsIso ?? "")} · ${String(record.op ?? "")} · ${String(record.outcome ?? "")} · ${String(record.sessionId ?? record.trashId ?? "")}`
                  )
                )
              )
            )
          : h("details", { className: "dsh-trash-log" }, h("summary", null, t("panel.log")), h("p", { className: "dsh-trash-muted" }, t("panel.logEmpty")))
      );
    }

    //#endregion

    //#region verbs

    /**
     * Read the session rows the batch picker offers, tolerating a late `sessions`
     * service: the picker simply shows nothing to delete rather than throwing.
     *
     * @param {object} ctx - browser plugin context.
     * @returns {Array<object>} candidate rows with display titles.
     */
    function sessionRows(ctx) {
      try {
        const sessions = ctx.get("sessions");
        const snapshot = sessions?.list?.getSnapshot?.();
        return batchCandidates(snapshot);
      } catch {
        return [];
      }
    }

    /**
     * Ask the host for the bin root the description names.
     *
     * Only needed against a host half that predates the richer preflight answer:
     * the two halves reload independently, so this file can be newer than the
     * process serving it.
     *
     * @returns {Promise<string|null>} the root, or null when even that fails.
     */
    async function fallbackRoot() {
      const status = await callHost("status").catch(() => ({ ok: false }));
      return status.ok === true ? status.value?.root ?? null : null;
    }

    /**
     * Open the delete dialog: preflight the host's sessions, then show step one.
     *
     * A single session with nothing running and nothing resident skips the dialog
     * entirely: choosing 「删除」 in its menu already is the decision, there is no
     * consent to collect, and the undo in the notice is the way back. Anything
     * that would stop work, or that cannot be located, still gets the dialog so
     * the consequence is on screen before anything moves.
     *
     * @param {object} request - `{mode, sessionId?, displayTitle?}`.
     * @param {object} ctx - browser plugin context.
     * @returns {Promise<void>} resolves once the dialog state is published (or the
     *   quick delete has settled).
     */
    async function openDeleteDialog(request, ctx) {
      const rows = sessionRows(ctx);
      const titleById = Object.fromEntries(rows.map((row) => [row.sessionId, row.displayTitle]));
      let sessionIds;
      let singleTitle;
      if (request.mode === "single") {
        sessionIds = [request.sessionId];
        singleTitle = request.displayTitle ?? titleById[request.sessionId] ?? request.sessionId;
        titleById[request.sessionId] = singleTitle;
      } else {
        sessionIds = rows.map((row) => row.sessionId);
      }
      if (request.mode === "single") {
        const outcome = await callHost("plan", { method: "POST", body: { sessionIds } });
        if (outcome.ok === true) {
          const plans = outcome.value?.plans ?? [];
          const plan = plans[0];
          // Absent means on: a host half that predates the flag has no setting to
          // honour, and the caller can always turn it off with `quickDelete: false`.
          const quick = outcome.value?.quickDelete !== false;
          const singleRoot = outcome.value?.root ?? (await fallbackRoot());
          const singleMaxBatch =
            Number(outcome.value?.maxBatch) > 0 ? Number(outcome.value.maxBatch) : DEFAULT_MAX_BATCH;
          if (quick === true && plans.length === 1 && isQuickDelete(plan)) {
            const result = await performDelete({
              mode: "single",
              sessionIds,
              titleById,
              singleTitle,
              plans,
              selectedIds: sessionIds,
              maxBatch: singleMaxBatch
            });
            if (result.ok === true) return;
            // The quick path failed for a reason the dialog can explain and retry
            // (the host refused it, say), so fall through with the plan in hand.
            storeInstance.actions.setDialog({
              mode: "single",
              sessionIds,
              titleById,
              singleTitle,
              plans,
              selectedIds: sessionIds,
              pending: false,
              error: result.message,
              root: singleRoot,
              maxBatch: singleMaxBatch
            });
            return;
          }
          storeInstance.actions.setDialog({
            mode: "single",
            sessionIds,
            titleById,
            singleTitle,
            plans,
            selectedIds: sessionIds,
            pending: false,
            error: null,
            root: singleRoot,
            maxBatch: singleMaxBatch
          });
          return;
        }
        // A failed preflight still opens the dialog, so the reason is visible.
      }
      storeInstance.actions.setDialog({
        mode: request.mode,
        sessionIds,
        titleById,
        singleTitle,
        plans: [],
        selectedIds: request.mode === "single" ? sessionIds : [],
        pending: false,
        error: null,
        root: null,
        maxBatch: DEFAULT_MAX_BATCH
      });
      const plans = [];
      let root = null;
      let maxBatch = DEFAULT_MAX_BATCH;
      // The host caps one preflight call. Chunking here instead of letting the
      // whole dialog fail on a long list is the difference between "the first 100
      // rows open normally" and "the batch entry does not work at all".
      for (const chunk of chunkIds(sessionIds, DEFAULT_MAX_BATCH)) {
        const outcome = await callHost("plan", { method: "POST", body: { sessionIds: chunk } });
        if (outcome.ok !== true) {
          storeInstance.actions.patchDialog({ plans, error: outcome.message, pending: false });
          return;
        }
        for (const plan of outcome.value?.plans ?? []) plans.push(plan);
        root = outcome.value?.root ?? root;
        maxBatch = Number(outcome.value?.maxBatch) > 0 ? Number(outcome.value.maxBatch) : maxBatch;
      }
      for (const plan of plans) {
        if (plan.cwd && titleById[plan.sessionId] === undefined) titleById[plan.sessionId] = plan.sessionId;
      }
      // A host half that predates this change answers `/plan` without the bin root
      // (the two halves reload independently: a page refresh picks up this file
      // while the host keeps running its old code until DSH restarts). Ask for it
      // separately rather than render a description with a hole in it.
      if (root === null) root = await fallbackRoot();
      if (request.mode !== "batch") {
        storeInstance.actions.patchDialog({ plans, titleById, root, maxBatch, error: null });
        return;
      }
      // The batch picker only offers rows the user can still act on. A session
      // whose files already moved into the recycle bin, and a session the user
      // archived (the sidebar hides those), are still in the live list and would
      // otherwise sit in a bulk-delete picker with a checkbox next to them —
      // promising a deletion that already happened, and letting a bulk selection
      // sweep in rows the user never saw. The single-session dialog keeps them:
      // there the user asked for that row by name.
      const visible = batchVisiblePlans(plans);
      const visibleIds = new Set(visible.map((plan) => plan.sessionId));
      storeInstance.actions.patchDialog({
        plans: visible,
        // The dialog's id list must follow the rows it shows, or a stale id would
        // travel into the delete payload as a session the list no longer offers.
        sessionIds: sessionIds.filter((id) => visibleIds.has(id)),
        titleById,
        root,
        maxBatch,
        error: null
      });
    }

    /** @returns {void} close the dialog. */
    function closeDialog() {
      storeInstance.actions.setDialog(null);
    }

    /**
     * Summarize why a batch partly failed, so a count is never the whole answer.
     *
     * @param {Array<object>} results - per-session results from the host.
     * @returns {string} a short, deduplicated reason list.
     */
    function describeFailures(results) {
      const seen = new Map();
      for (const row of Array.isArray(results) ? results : []) {
        if (row?.ok === true) continue;
        const label = String(row?.message ?? row?.code ?? "unknown");
        seen.set(label, (seen.get(label) ?? 0) + 1);
      }
      return [...seen.entries()]
        .map(([label, count]) => (count > 1 ? `${label} ×${String(count)}` : label))
        .slice(0, 5)
        .join("；");
    }

    /**
     * @returns {string[]} the trash ids created by a delete response.
     *
     * A fileless session that was merely cleared has no bin item, so its null id
     * is dropped: the undo action must never offer to restore something the bin
     * does not hold.
     */
    function trashIdsOf(results) {
      return (Array.isArray(results) ? results : [])
        .filter((row) => row.ok === true)
        .map((row) => row.trashId)
        .filter((trashId) => typeof trashId === "string" && trashId !== "");
    }

    /**
     * Release this client's reference to any session it is about to delete.
     *
     * A session the view still holds cannot be disposed by the host, so the delete
     * would stall and then refuse — while the user's work had already been stopped.
     * Releasing is therefore the client's responsibility, and it is done by
     * navigating to a surviving session (or by dropping the main selection when
     * nothing survives). The host additionally archives as a fallback, so this is an
     * accelerant rather than the only defence.
     *
     * @param {string[]} targets - sessions about to be deleted.
     * @param {object} ctx - browser plugin context.
     * @returns {boolean} whether a release was attempted.
     */
    function releaseOpenTargets(targets, ctx) {
      try {
        const uiWorkspace = ctx?.get("uiWorkspace");
        if (uiWorkspace === undefined) return false;
        const open = uiWorkspace.mainReference?.sessionId;
        if (typeof open !== "string" || !targets.includes(open)) return false;
        const rows = sessionRows(ctx);
        const survivor = rows.find((row) => !targets.includes(row.sessionId));
        if (survivor !== undefined && typeof uiWorkspace.openSession === "function") {
          uiWorkspace.openSession(survivor.sessionId);
          return true;
        }
        if (typeof uiWorkspace.clearMain === "function") {
          // Nothing survives: drop the selection rather than leave the view on a
          // session whose files are about to move.
          uiWorkspace.clearMain();
          return true;
        }
        return false;
      } catch {
        /* the host's archive-based release still applies */
        return false;
      }
    }

    /**
     * Move a resolved selection into the recycle bin and publish the outcome.
     *
     * Shared by the confirm dialog and the single-session shortcut, so both paths
     * report identically: what was deleted, what failed and why, what was cleared
     * instead of moved, how long it took, and the undo that is the user's only way
     * back.
     *
     * The selection is chunked by the host's batch cap, so a list longer than one
     * request can delete is handled by several requests instead of being refused
     * outright. A refused chunk stops the run and is reported: continuing past it
     * would keep deleting after the user has already been told something is wrong.
     *
     * @param {object} dialogLike - `{plans, selectedIds, titleById, maxBatch}`.
     * @returns {Promise<{ok: true}|{ok: false, message: string}>} the outcome for the caller's UI.
     */
    async function performDelete(dialogLike) {
      const payload = buildDeletePayload(
        dialogLike,
        Object.entries(dialogLike.titleById ?? {}).map(([sessionId, displayTitle]) => ({ sessionId, displayTitle }))
      );
      if (payload.sessionIds.length === 0) return { ok: false, message: "没有可删除的会话" };
      // Hand the sessions back before asking the host to move them.
      releaseOpenTargets(payload.sessionIds, ctxRef);
      const chunks = chunkIds(payload.sessionIds, dialogLike.maxBatch ?? DEFAULT_MAX_BATCH);
      const results = [];
      for (const chunk of chunks) {
        const inside = new Set(chunk);
        const body = {
          ...payload,
          sessionIds: chunk,
          titles: payload.titles.filter((row) => inside.has(row.sessionId))
        };
        const outcome = await callHost("delete", { method: "POST", body }).catch((error) => ({
          ok: false,
          message: String(error?.message ?? error)
        }));
        if (outcome.ok !== true) {
          if (results.length === 0) return { ok: false, message: outcome.message };
          results.push({ ok: false, code: "batch-aborted", message: outcome.message });
          break;
        }
        for (const row of outcome.value?.results ?? []) results.push(row);
      }
      const deleted = results.filter((row) => row?.ok === true).length;
      const failed = results.length - deleted;
      const ids = trashIdsOf(results);
      const reasons = describeFailures(results);
      closeDialog();
      // Navigating away releases the deleted session's client reference, which is
      // what lets the host delete the session the user is looking at.
      refreshBin().catch(() => {});
      refreshSessions(ctxRef).catch(() => {});
      const rows = results;
      const forcedCount = rows.filter((row) => row?.forced === true).length;
      // A row whose files were already gone is cleared from the list instead of
      // being moved, and saying "moved to the bin" about it would be a lie.
      const cleanedCount = rows.filter((row) => row?.cleaned === true).length;
      const timing = deleteTimings(rows);
      // A failed rollback leaves the session hidden in the archive while its files
      // are still on disk; that has to be said out loud, not only logged.
      const rollbackFailed = rows.filter(
        (row) => Array.isArray(row?.cleanupFailures) && row.cleanupFailures.includes("unarchive")
      ).length;
      const notes = [];
      if (forcedCount > 0) notes.push(activeT("notice.forced", { count: forcedCount }));
      else if (cleanedCount > 0 && deleted > cleanedCount) notes.push(activeT("notice.cleaned", { count: cleanedCount }));
      if (rollbackFailed > 0) notes.push(activeT("notice.unarchiveFailed", { count: rollbackFailed }));
      if (timing !== null) notes.push(activeT("notice.slow", timing));
      const detail = notes.length === 0 ? null : notes.join(activeT("notice.join"));
      storeInstance.actions.setNotice({
        text:
          failed > 0
            ? `${activeT("dialog.result.deleted", { count: deleted })}；${activeT("dialog.result.failed", { count: failed })}${
                reasons === "" ? "" : `（${reasons}）`
              }`
            : cleanedCount > 0 && cleanedCount === deleted
              ? activeT("notice.cleaned", { count: cleanedCount })
              : deleted === 1
                ? activeT("notice.trashed")
                : activeT("notice.trashedMany", { count: deleted }),
        detail,
        tone: failed > 0 ? "warning" : "success",
        undo: ids.length > 0 ? { trashIds: ids } : null
      });
      return { ok: true };
    }

    /**
     * Apply the dialog: release what this view holds, then move the selection into
     * the recycle bin, reporting per-session failures instead of hiding them.
     *
     * @returns {Promise<void>} resolves once the dialog settles.
     */
    async function confirmDelete() {
      const dialog = storeInstance.getSnapshot().dialog;
      if (dialog === null) return;
      storeInstance.actions.patchDialog({ pending: true, error: null });
      const result = await performDelete(dialog);
      if (result.ok !== true) storeInstance.actions.patchDialog({ pending: false, error: result.message });
    }

    /**
     * The host's batch cap for bin mutations, as the last listing reported it.
     *
     * The cap belongs to the host: it refuses a request carrying more ids than
     * it accepts, so a selection longer than the cap has to travel in several
     * requests — the same way the delete path already does it. Falling back to
     * the default keeps the panel working against a host half that predates the
     * cap in the listing answer.
     *
     * @returns {number} the largest number of ids one request may carry.
     */
    function binMaxBatch() {
      const configured = Number(storeInstance.getSnapshot().bin?.maxBatch);
      return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_BATCH;
    }

    /**
     * Restore trashed sessions and refresh both the bin and the session list.
     *
     * The selection is sent in as many requests as the host's cap needs, so a bin
     * holding more items than one request accepts is fully restorable instead of
     * being refused as a whole.
     *
     * @param {string[]} trashIds - items to restore.
     * @returns {Promise<void>} resolves once state is published.
     */
    async function restoreSelected(trashIds) {
      if (!Array.isArray(trashIds) || trashIds.length === 0) return;
      const results = [];
      let restored = 0;
      let failed = 0;
      let refusal = null;
      for (const chunk of chunkIds(trashIds, binMaxBatch())) {
        const outcome = await callHost("restore", { method: "POST", body: { trashIds: chunk } }).catch((error) => ({
          ok: false,
          message: String(error?.message ?? error)
        }));
        if (outcome.ok !== true) {
          refusal = outcome.message;
          break;
        }
        for (const row of outcome.value?.results ?? []) results.push(row);
        restored += Number(outcome.value?.restored ?? 0);
        failed += Number(outcome.value?.failed ?? 0);
      }
      // Whatever was already restored is reported even when a later chunk was
      // refused: those items are back, and the user is the only one who can undo
      // the rest.
      const reasons = describeFailures(results);
      if (restored > 0 || failed > 0) {
        storeInstance.actions.setNotice({
          text:
            failed > 0
              ? `${activeT("dialog.result.restored", { count: restored })}；${activeT("dialog.result.failed", { count: failed })}${
                  reasons === "" ? "" : `（${reasons}）`
                }`
              : activeT("dialog.result.restored", { count: restored }),
          tone: failed > 0 ? "warning" : "success",
          undo: null
        });
      }
      if (refusal !== null) {
        storeInstance.actions.patchBin({ error: refusal });
        return;
      }
      storeInstance.actions.patchBin({ selected: [] });
      await refreshBin().catch(() => {});
      await refreshSessions(ctxRef);
    }

    /** Reissue the restore that the notice's undo action offers. */
    async function undoNotice(notice) {
      const trashIds = notice?.undo?.trashIds ?? [];
      storeInstance.actions.setNotice(null);
      await restoreSelected(trashIds);
    }

    /**
     * Purge after the acknowledgement gate; the host refuses without it too.
     *
     * Like the restore, the selection travels in as many requests as the host's
     * cap needs, so purging more items than one request accepts is possible.
     *
     * @returns {Promise<void>} resolves once state is published.
     */
    async function confirmPurge() {
      const purge = storeInstance.getSnapshot().purge;
      if (purge === null || purge.acknowledged !== true) return;
      if (!Array.isArray(purge.trashIds) || purge.trashIds.length === 0) return;
      storeInstance.actions.patchPurge({ pending: true, error: null });
      let purged = 0;
      let freed = 0;
      let refusal = null;
      for (const chunk of chunkIds(purge.trashIds, binMaxBatch())) {
        const outcome = await callHost("purge", {
          method: "POST",
          body: { trashIds: chunk, acknowledge: true }
        }).catch((error) => ({ ok: false, message: String(error?.message ?? error) }));
        if (outcome.ok !== true) {
          refusal = outcome.message;
          break;
        }
        purged += Number(outcome.value?.purged ?? 0);
        freed += Number(outcome.value?.freedBytes ?? 0);
      }
      if (refusal !== null) {
        storeInstance.actions.patchPurge({ pending: false, error: refusal });
        return;
      }
      storeInstance.actions.setPurge(null);
      storeInstance.actions.setNotice({
        text: activeT("dialog.result.purged", { count: purged, size: formatBytes(freed) }),
        tone: "success",
        undo: null
      });
      storeInstance.actions.patchBin({ selected: [] });
      await refreshBin().catch(() => {});
    }

    /**
     * Reload the recycle bin and its log.
     * @returns {Promise<void>} resolves once the store reflects the host.
     */
    async function refreshBin() {
      storeInstance.actions.patchBin({ status: "loading", error: null });
      try {
        const [list, log] = await Promise.all([callHost("list"), callHost("log?limit=50")]);
        if (list.ok !== true) {
          storeInstance.actions.patchBin({ status: "error", error: list.message });
          return;
        }
        storeInstance.actions.patchBin({
          status: "ready",
          items: list.value?.items ?? [],
          broken: list.value?.broken ?? [],
          stats: list.value?.stats ?? null,
          error: null,
          // The host's batch cap, so a selection longer than one request is sent
          // in several requests instead of being refused wholesale.
          maxBatch: Number(list.value?.maxBatch) > 0 ? Number(list.value.maxBatch) : DEFAULT_MAX_BATCH,
          log: log.ok === true ? (log.value?.records ?? []) : []
        });
      } catch (error) {
        // The refresh button is disabled while the bin is "loading", so a rejected
        // request that left the status alone would freeze the whole panel.
        storeInstance.actions.patchBin({ status: "error", error: String(error?.message ?? error) });
      }
    }

    /**
     * Ask the session service to re-read its list so a deleted or restored row
     * appears or disappears without a page reload.
     *
     * @param {object} ctx - browser plugin context.
     * @returns {Promise<void>} resolves once the refresh settles.
     */
    async function refreshSessions(ctx) {
      try {
        // The client `sessions` service exposes `refresh()`; `refreshList()` is an
        // internal method of its sub-manager, so calling only that was a no-op.
        const sessions = ctx?.get("sessions");
        if (typeof sessions?.refresh === "function") await sessions.refresh();
        else if (typeof sessions?.refreshList === "function") await sessions.refreshList();
      } catch {
        /* the list refreshes on its own schedule; this is an accelerant */
      }
    }

    /**
     * Open the recycle-bin panel in the main area.
     * @returns {void}
     */
    function openBinPanel() {
      try {
        ctxRef?.get("layout")?.selectPanel?.(PANEL_ID);
      } catch {
        /* without a layout service the sidebar entry still opens it */
      }
    }

    //#endregion

    //#region plugin body

    /** The bound translation function, replaced when `apply` runs. */
    let activeT = (key) => key;
    /** The live context, used only for ungated `ctx.get(service)` lookups. */
    let ctxRef = null;
    /** Whether the dictionaries were registered already (register() rejects repeats). */
    let dictionariesInstalled = false;

    /**
     * Register this plugin's dictionaries and bind `t`.
     *
     * This must run inside a scope that declares `locale`. Cordis gates service
     * *property* access on the reading fiber's inject map, so touching
     * `ctx.locale` from an entry whose exported `inject` is `[]` throws
     * `cannot get property "locale" without inject`; that would fail this entry's
     * fiber and make DSH's boot audit fail the whole page. `ctx.get(name)` is not
     * gated, but `locale.register`/`bind` are reached through the scope instead.
     *
     * @param {object} scope - a context with `locale` injected.
     */
    function installDictionaries(scope) {
      if (dictionariesInstalled) {
        activeT = scope.locale.bind(NS);
        return;
      }
      dictionariesInstalled = true;
      scope.effect(() => scope.locale.register(NS, { zh, en }), "session-trash: dictionaries");
      activeT = scope.locale.bind(NS);
    }

    /**
     * Client plugin body: register the dictionaries, then the four surfaces.
     *
     * The service acquisition is split so the destructive action keeps working in
     * a composition without a layout service: menu rows and dialogs need only
     * `slots` + `locale`, while the recycle-bin panel additionally needs `layout`.
     *
     * @param {object} ctx - browser plugin context.
     */
    function apply(ctx) {
      ctxRef = ctx;

      const core = ["slots", "locale"];
      const withPanel = ["slots", "locale", "layout"];

      ctx.inject(core, (scope) => {
        installDictionaries(scope);
        // Menu rows only need the parent slot's inherited hooks plus `t`; they
        // raise verbs through module scope, so no per-entry inject is needed.
        scope.slots.inject("sidebar.workspaces.session.menu.item", function* () {
          yield scope.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "session-trash.delete",
              order: ORDER_SINGLE,
              locale: NS
            },
            SessionTrashMenuItem
          );
          yield scope.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "session-trash.delete-batch",
              order: ORDER_BATCH,
              locale: NS
            },
            BatchTrashMenuItem
          );
        });
        scope.slots.inject("shell.overlay", function* () {
          yield scope.slots.register(
            {
              name: "shell.overlay",
              id: "session-trash.overlays",
              locale: NS,
              store: storeSeat
            },
            TrashOverlays
          );
        });
      });

      ctx.inject(withPanel, (scope) => {
        installDictionaries(scope);
        scope.slots.inject("sidebar.panellist", () =>
          scope.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 50,
              label: () => activeT("panel.title"),
              locale: NS
            },
            TrashPanelIcon
          )
        );
        scope.slots.inject("main", function* () {
          yield scope.slots.register(
            {
              name: "main",
              key: PANEL_ID,
              locale: NS,
              store: storeSeat
            },
            TrashPanel
          );
        });
      });
    }

    /**
     * Exported `[]` on purpose: every service this module needs is acquired with
     * `ctx.inject` inside {@link apply}, so this entry always reaches the active
     * state and can never stall the shell's boot audit on a missing service.
     */
    const inject = [];

    exports.apply = apply;
    exports.inject = inject;
    exports.NS = NS;
    exports.PANEL_ID = PANEL_ID;
    // Test-only surface: the pure helpers, so they can be exercised without a DOM.
    exports.__test = {
      formatBytes,
      formatAge,
      isDeletable,
      needsConsent,
      activityRows,
      summarizeSelection,
      canAdvance,
      deleteTimings,
      chunkIds,
      isQuickDelete,
      buildDeletePayload,
      readEnvelope,
      batchCandidates,
      batchVisiblePlans,
      storeHandle,
      storeInstance,
      openDeleteDialog: (request, ctx) => openDeleteDialog(request, ctx),
      closeDialog,
      confirmDelete,
      restoreSelected,
      confirmPurge,
      refreshBin,
      refreshSessions,
      sessionRows,
      trashIdsOf,
      describeFailures,
      releaseOpenTargets,
      isGone,
      dictionaries: { zh, en },
      setContext: (ctx) => {
        ctxRef = ctx;
      },
      setTranslator: (t) => {
        activeT = t;
      }
    };
    return module.exports;
  }
});
