/**
 * Delete / restore / purge orchestration for session trashing.
 *
 * This is the layer that decides whether a delete is *allowed*. It owns the
 * safety rules, the interaction with DSH's own services, and the audit trail;
 * the filesystem mechanics live in `trash-store.js` and the directory lookup in
 * `locate.js`.
 *
 * ## Safety rules
 *
 * | Situation | Behaviour |
 * |---|---|
 * | Session running, caller did not opt in | Refuse `session-active`, listing the work |
 * | Host tasks alive (jobs, reminders), no opt-in | Refuse `session-active`, listing the work |
 * | Session resident in this process, no opt-in | Refuse `session-live` (a live writer may recreate the log) |
 * | Opted in (`stopActivity`) | Stop the work, ask the client to release, wait, then move |
 * | Still resident after the wait | Refuse `session-live` |
 * | Forced delete, session still resident | Take the session down through the live registry, then move |
 * | Forced delete, the runtime refuses to let go | Move anyway; the row stays archived and the caller is told |
 * | Directory missing | Clear the row instead: nothing to move, so release it and take it off the list |
 *
 * A refused delete never touches the filesystem, and a partially successful
 * batch reports per-session results instead of failing the whole request.
 *
 * @module dsh-session-trash/host/service
 */

import { describeActivity, isResident, resolveSessionDir, waitForRelease } from "./locate.js";
import { ITEM_TRASHED, directorySize, isBroken, isSafeSessionId, isSafeTrashId } from "./trash-store.js";

/** Longest display title accepted from a caller, in code units. */
const TITLE_MAX = 200;

/**
 * Host-half API revision.
 *
 * Reported by `/status` so a client (and a support conversation) can tell which
 * host behaviour is actually loaded — the host half is reloaded separately from
 * the browser bundle.
 */
export const API_VERSION = 2;

/**
 * Longest a caller may ask us to wait for a session to leave memory.
 *
 * The wait runs inside the shared mutation queue, so an unbounded value would
 * let one request block every other delete, restore and purge. A session either
 * releases promptly once its reference is dropped or it is not going to.
 */
export const MAX_RELEASE_WAIT_MS = 15_000;

/**
 * How long a restore waits for the host to bring the restored session back to
 * life.
 *
 * A delete takes the session down in the host's live registry, and moving its
 * files back does not recreate that registry entry: the restored session is on
 * disk but has no agent behind it, so a message sent to it goes nowhere. The
 * host's own resume path is the only thing that can recreate the entry, so a
 * restore asks for it — and the wait is bounded, because the resume runs inside
 * the shared mutation queue and an unbounded one would block every later
 * delete, restore and purge.
 */
export const REVIVE_TIMEOUT_MS = 8_000;

/**
 * How long a **consented forced** delete still polls for a clean release.
 *
 * The full wait exists to buy a *clean* delete: the runtime disposes the session
 * and no residue row is left behind. But the runtime only disposes a session once
 * every reference to it is gone, and the one reference that matters here is the
 * client's — so in practice the session stays resident for as long as the
 * process does. Every single audited delete in the field came back `forced: true`,
 * i.e. the whole window was spent learning the answer we were going to force
 * anyway. So a caller who already consented to a forced delete gets a short
 * probe: sessions that release instantly still get a clean delete, and the
 * common case pays 250 ms instead of the full window.
 *
 * When the probe fails, the forced delete does not give up: it takes the session
 * down itself through the live registry (see {@link SessionTrashService}) and
 * only reports a residue if even that is refused.
 */
export const FORCE_RELEASE_PROBE_MS = 250;

/**
 * How long a released session is given to finish its last write.
 *
 * Releasing a session closes its writer, and the close drains whatever the
 * session still had buffered. Moving the directory during that drain would put
 * the final events into the bin payload under a byte count that no longer
 * matches it, so the move waits for the drain to finish. The wait is short
 * because the buffered remainder is a few kilobytes of a single session's tail.
 */
export const RELEASE_SETTLE_MS = 300;

/**
 * How many sessions one preflight call inspects at the same time.
 *
 * Each inspection is a couple of `stat`s plus a directory walk — nothing that
 * wants a hundred of itself in flight, and nothing that has to be serial either.
 */
const PLAN_CONCURRENCY = 4;

/**
 * Map over items with at most `limit` promises in flight, preserving input order.
 *
 * Used by preflight, where the per-item work is independent. Deliberately not
 * used for deletes: those mutate shared runtime state and stay serial in the
 * queue.
 *
 * @template T, R
 * @param {T[]} items - inputs.
 * @param {number} limit - maximum concurrent calls (at least 1).
 * @param {(item: T, index: number) => Promise<R>} run - the per-item work.
 * @returns {Promise<R[]>} results in the same order as `items`.
 */
async function mapWithConcurrency(items, limit, run) {
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(size, items.length)).fill(undefined).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Bound a caller-supplied release wait.
 *
 * Exported because it is a policy the caller-visible contract depends on: an
 * unbounded value would let one request occupy the shared mutation queue.
 *
 * @param {unknown} value - requested milliseconds.
 * @returns {number} a value in `[0, MAX_RELEASE_WAIT_MS]`.
 */
export function clampReleaseWait(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Math.floor(numeric), MAX_RELEASE_WAIT_MS);
}

/** @returns {string|undefined} a trimmed, bounded title or undefined. */
function normalizeTitle(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1)}…` : trimmed;
}

/** Added to a delete result when the release archive could not be lifted. */
const UNARCHIVE_FAILED_NOTE = "；该会话仍处于归档状态（其文件仍在磁盘上）";

/**
 * Fold a failed un-archive into a delete result.
 *
 * A delete that cannot lift its own release archive leaves the session hidden
 * from the default list while its files are still on disk. That is a fact the
 * caller has to be told, not a detail to log away.
 *
 * @param {object} result - the delete result to complete.
 * @returns {object} the result with the rollback failure reported.
 */
function withUnarchiveFailure(result) {
  return {
    ...result,
    message: `${result.message ?? ""}${UNARCHIVE_FAILED_NOTE}`,
    cleanupFailures: [...(result.cleanupFailures ?? []), "unarchive"]
  };
}

/**
 * Let a released session finish its last write.
 *
 * Releasing a session closes its writer, and the close drains whatever the
 * session still had buffered. Moving the directory during that drain would put
 * the final events into the bin payload under a byte count that no longer
 * matches it, so the move waits for the drain to finish.
 *
 * @param {number} ms - how long to wait.
 * @returns {Promise<void>} resolves after the wait.
 */
async function settleRelease(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize mutating operations so two requests cannot race on one session. */
class SerialQueue {
  #tail = Promise.resolve();

  /**
   * @param {() => Promise<any>} task - work to run alone.
   * @returns {Promise<any>} the task's result.
   */
  run(task) {
    const next = this.#tail.then(task, task);
    this.#tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

/**
 * The session trash service.
 */
export class SessionTrashService {
  /** @type {object} host context. */
  #ctx;
  /** @type {import("./trash-store.js").TrashStore} backing store. */
  #store;
  /**
   * How long a restore waits for the host to resume the restored session.
   * @type {number}
   */
  #reviveTimeoutMs = REVIVE_TIMEOUT_MS;
  /**
   * Mutation serializer.
   *
   * Every mutating entry point runs through this, which is what makes a single
   * session's delete, a concurrent second delete of the same id, and a purge of
   * the item it produced mutually exclusive without any per-id bookkeeping.
   * @type {SerialQueue}
   */
  #queue = new SerialQueue();

  /**
   * @param {object} ctx - host context.
   * @param {object} options - wiring.
   * @param {import("./trash-store.js").TrashStore} options.store - backing store.
   * @param {number} [options.reviveTimeoutMs] - how long a restore waits for the
   *   host to bring a restored session back to life.
   */
  constructor(ctx, { store, reviveTimeoutMs = REVIVE_TIMEOUT_MS }) {
    this.#ctx = ctx;
    this.#store = store;
    this.#reviveTimeoutMs = reviveTimeoutMs;
  }

  /** @returns {import("./trash-store.js").TrashStore} the backing store. */
  get store() {
    return this.#store;
  }

  /**
   * Preflight one or more sessions without changing anything.
   *
   * The confirm dialog renders this answer, so the user sees exactly which
   * sessions are deletable, which are still running, and what work would be
   * stopped — before anything is moved.
   *
   * @param {string[]} sessionIds - sessions to inspect.
   * @param {object} [options] - inspection options.
   * @param {boolean} [options.sizes] - walk each directory to report its size.
   *   Off by default: sizing every session costs a full recursive walk each and
   *   the delete dialog does not display the number, so preflight should not pay
   *   for it.
   * @returns {Promise<Array<object>>} one plan per id, in request order.
   */
  async plan(sessionIds, { sizes = false } = {}) {
    // Read the host's session list once for the whole batch: it is the expensive
    // part, and doing it per id made planning quadratic.
    let summaries = [];
    try {
      summaries = await this.#summaries();
    } catch {
      /* a summary read is a hint, never a gate */
    }
    const ids = Array.isArray(sessionIds) ? sessionIds : [];
    // Planning is I/O bound (one directory walk per session), so a hundred of them
    // run a few at a time instead of one after another — but the input order is
    // preserved, because the dialog lists the rows in the order it sent them.
    const plans = await mapWithConcurrency(ids, PLAN_CONCURRENCY, (sessionId) =>
      this.#planOne(sessionId, summaries, { sizes })
    );
    return plans;
  }

  /**
   * @param {string} sessionId - session to inspect.
   * @param {Array<object>} summaries - the batch's already-read host summary list.
   * @param {object} [options] - inspection options (see {@link SessionTrashService#plan}).
   * @returns {Promise<object>} one session's preflight answer.
   */
  async #planOne(sessionId, summaries = [], { sizes = false } = {}) {
    if (!isSafeSessionId(sessionId)) {
      return { sessionId, deletable: false, code: "invalid-session-id", message: "会话 id 不安全" };
    }
    const persistence = this.#ctx.get("sessionPersistence");
    const located = await resolveSessionDir({ sessionId, persistence });
    const resident = isResident(this.#ctx, sessionId);
    const activity = await describeActivity(this.#ctx, sessionId);
    const activityKnown = activity !== undefined;
    const activityFamilies = activity ?? [];
    const archived = this.#isArchived(sessionId);
    const pinned = this.#isPinned(sessionId);
    const running = summaries.find((row) => row.sessionId === sessionId)?.running === true;
    // Sizes make the confirmation concrete; a failed sizing is only a missing
    // number, never a reason to block a delete. Skipped unless asked for: the
    // dialog does not render it, so walking every directory on every open would
    // be work nobody reads.
    const bytes = located.ok && sizes ? await directorySize(located.dir) : 0;
    const blockers = [];
    if (!located.ok) blockers.push(located.code);
    if (resident) blockers.push("session-live");
    if (activityFamilies.length > 0) blockers.push("session-active");
    // An unanswered probe cannot rule activity out; the dialog asks for the stop
    // consent instead of presenting the session as safely idle.
    if (!activityKnown) blockers.push("session-activity-unknown");
    return {
      sessionId,
      deletable: located.ok,
      // "Can we move it into the bin" and "can we take the row off the list" are
      // two different questions, and a session whose files are already gone only
      // fails the first one. It is still clearable — there is nothing left to
      // move, only a row the runtime keeps drawing. The dialog needs to know
      // which of the two it is offering.
      clearable: located.code === "not-found",
      // "Are the session's files on disk" is not the same question as "can we
      // move them": a directory that exists but is out of reach under the
      // containment rules is neither gone nor deletable.
      exists: located.exists ?? located.ok,
      via: located.ok ? located.via : undefined,
      dir: located.ok ? located.dir : undefined,
      bytes,
      cwd: located.header?.cwd ?? undefined,
      resident,
      running,
      activity: activityFamilies,
      activityKnown,
      archived,
      pinned,
      blockers,
      code: located.ok ? undefined : located.code,
      message: located.ok ? undefined : located.message
    };
  }

  /**
   * Delete sessions into the recycle bin.
   *
   * @param {object} request - the delete request.
   * @param {string[]} request.sessionIds - sessions to delete.
   * @param {boolean} [request.stopActivity] - consent to stop running work first.
   * @param {number} [request.waitForReleaseMs] - how long to wait for the session to leave memory.
   * @param {Array<{sessionId: string, title?: string}>} [request.titles] - display titles from the caller.
   * @param {string} [request.actor] - audit actor label.
   * @returns {Promise<object>} `{results, deleted, failed}`.
   */
  async deleteSessions(request = {}) {
    const sessionIds = Array.isArray(request.sessionIds) ? request.sessionIds : [];
    const titles = new Map(
      (Array.isArray(request.titles) ? request.titles : [])
        .filter((row) => row !== null && typeof row === "object")
        .map((row) => [row.sessionId, normalizeTitle(row.title)])
    );
    return this.#queue.run(async () => {
      const results = [];
      for (const sessionId of sessionIds) {
        try {
          results.push(
            await this.#deleteOne(sessionId, {
              stopActivity: request.stopActivity === true,
              force: request.force === true,
              waitForReleaseMs: clampReleaseWait(request.waitForReleaseMs),
              title: titles.get(sessionId),
              actor: request.actor
            })
          );
        } catch (error) {
          // A delete that throws mid-batch (a filesystem error the store did not
          // turn into a verdict, say) must not discard the verdicts already
          // reached: the sessions before it are in the bin, and losing their ids
          // would take away the undo that is the user's only way back. Report the
          // failure against that one session and keep going.
          this.#ctx.logger.warn(`session-trash: deleting ${sessionId} failed: ${String(error?.message ?? error)}`);
          results.push({
            sessionId,
            ok: false,
            code: "internal",
            message: `删除时出错：${String(error?.message ?? error)}${error?.rollbackNote ?? ""}`,
            cleanupFailures: error?.cleanupFailures ?? []
          });
          try {
            await this.#audit({ op: "delete", outcome: "failed", sessionId, code: "internal", actor: request.actor });
          } catch {
            /* an audit write is not worth failing a reported failure */
          }
        }
      }
      const deleted = results.filter((row) => row.ok);
      return { results, deleted: deleted.length, failed: results.length - deleted.length };
    });
  }

  /**
   * @param {string} sessionId - the session to delete.
   * @param {object} options - the resolved per-session options.
   * @returns {Promise<object>} one session's delete outcome.
   */
  async #deleteOne(sessionId, options) {
    // Per-phase timings ride along on the result so a slow delete can be explained
    // instead of guessed at; the client surfaces them when the delete took long.
    const timings = {};
    let mark = Date.now();
    const phase = (name) => {
      const now = Date.now();
      timings[name] = now - mark;
      mark = now;
    };

    const persistence = this.#ctx.get("sessionPersistence");
    const located = await resolveSessionDir({ sessionId, persistence });
    phase("locate");
    if (!located.ok) {
      // A session whose files are already gone is not a dead end. The user asked
      // for the row to go, and DSH keeps listing it for as long as the live
      // registry holds it, so ask the clear path to take it off the list. Only a
      // session that is genuinely not materialized qualifies: a directory that
      // exists but is out of reach under the containment rules ("not-visible")
      // still has files, and clearing the row would claim they are gone. Every
      // other locate refusal is a path we cannot vouch for, and deleting what we
      // cannot identify stays refused: the caller is told why instead of being
      // pre-empted by a disabled control.
      if (located.code === "not-found") return await this.#clearFileless(sessionId, options, located, timings);
      const result = { sessionId, ok: false, code: located.code, message: located.message, timings };
      await this.#audit({ op: "delete", outcome: "refused", sessionId, code: located.code, actor: options.actor });
      return result;
    }
    const activity = await describeActivity(this.#ctx, sessionId);
    const activityKnown = activity !== undefined;
    const activityFamilies = activity ?? [];
    const resident = isResident(this.#ctx, sessionId);
    phase("inspect");

    // Captured before anything is touched: a forced release archives the session,
    // and the manifest must record the state the user actually saw so a restore
    // gives that state back rather than the one our own release left behind.
    const wasArchived = this.#isArchived(sessionId);
    const wasPinned = this.#isPinned(sessionId);

    // Two distinct consents are required, because the two hazards are different:
    // running work loses progress the user can still see, while a resident
    // session risks a live writer recreating the log after the move. An
    // unanswered probe is treated as possibly active: refusing until the caller
    // consents to stopping work is the fail-closed direction.
    if ((!activityKnown || activityFamilies.length > 0) && !options.stopActivity) {
      const result = {
        sessionId,
        ok: false,
        code: "session-active",
        message: activityKnown ? "该会话仍有正在进行的工作" : "无法确认该会话是否仍有正在进行的工作",
        activity: activityFamilies,
        timings
      };
      await this.#audit({ op: "delete", outcome: "refused", sessionId, code: "session-active", actor: options.actor });
      return result;
    }
    if (resident && !options.stopActivity) {
      const result = {
        sessionId,
        ok: false,
        code: "session-live",
        message: "该会话仍处于打开状态，需要先释放后再删除",
        activity: activityFamilies,
        timings
      };
      await this.#audit({ op: "delete", outcome: "refused", sessionId, code: "session-live", actor: options.actor });
      return result;
    }

    let archivedForRelease = false;
    // Whether the runtime let go of the session. A session that was never
    // resident was never held, so it counts as released from the start.
    let released = true;
    // The caller consented to a forced delete: its work may be stopped and the
    // session may be taken down even if the runtime does not let go by itself.
    const forced = options.force === true;
    if (options.stopActivity) {
      if (!activityKnown || activityFamilies.length > 0) {
        await this.#stopActivity(sessionId);
        phase("stop");
      }
      if (isResident(this.#ctx, sessionId)) {
        // Releasing the session is the host's job, not the user's: quitting the
        // view, reloading, or waiting for garbage collection are not reasonable
        // things to demand mid-delete. Archiving is DSH's own mechanism for this —
        // it gates every wake the stops could induce, and it makes a client holding
        // the main reference drop it — so it is what we use to let the runtime
        // dispose the session and close its writer.
        archivedForRelease = await this.#archiveForRelease(sessionId);
        phase("archive");
        // A caller who consented to a forced delete is not waiting for a clean
        // release, it already accepted the residue; polling it for the full window
        // only delays the answer they asked for (see FORCE_RELEASE_PROBE_MS).
        const budget = forced ? FORCE_RELEASE_PROBE_MS : options.waitForReleaseMs;
        released = await waitForRelease(this.#ctx, sessionId, budget);
        // The wait is timed, not the budget: a session that lets go at once
        // waited for as long as it actually took, and the budget was never
        // spent. Timing the budget instead would report every fast release as a
        // long wait and name the move phase with the wait's time.
        phase("wait");
        if (!released) {
          if (!forced) {
            const unarchived = archivedForRelease && !wasArchived ? await this.#unarchiveQuietly(sessionId) : true;
            const result = {
              sessionId,
              ok: false,
              code: "session-live",
              message: "该会话未能及时释放；已停止的工作不会自动继续",
              activity: activityFamilies,
              timings
            };
            await this.#audit({ op: "delete", outcome: "refused", sessionId, code: "session-live", actor: options.actor });
            return unarchived ? result : withUnarchiveFailure(result);
          }
          // The user explicitly asked for a forced delete, so refusing is not an
          // option. What used to happen here is what produced the zombie row: the
          // files were moved while the runtime still held the session, the
          // session was left archived, and the row stayed on screen as a session
          // that could no longer be opened ("已归档对话暂时无法查看"). The live
          // registry hands out a detach disposer for every resident session, so
          // the session can be taken down directly instead: the writer closes,
          // the host stops listing it, and the row goes with it.
          // Durability barrier BEFORE the detach: `session/disposed` makes the
          // persistence backend drain asynchronously (close() is fire-and-forget
          // on that event), so detaching first and sleeping afterwards let the
          // final batch land while — or after — this function moved the
          // directory. The plugin's own data-safety note says a writer that
          // flushes after the move recreates the directory and leaves a split
          // log behind; `sessions.flush()` only works while the session is still
          // in the live registry, so it has to run first.
          await this.#flushResidentSession(sessionId);
          phase("flush");
          released = this.#releaseResidentSession(sessionId);
          phase("release");
          if (released) {
            // The writer still drains once on disposal (its routed buffer is
            // empty after the flush above); this short settle covers the close
            // bookkeeping, not the data.
            await settleRelease(RELEASE_SETTLE_MS);
            phase("settle");
          }
          // A session the runtime refused to let go even when asked directly keeps
          // its row: the files still move — the user asked for the delete and the
          // work is stopped — but the row stays behind as an archived residue, and
          // the caller is told so instead of being handed a row nobody can act on.
        }
      }
    }

    let trashed;
    try {
      trashed = await this.#store.trash({
        sourceDir: located.dir,
        sessionId,
        cwd: located.header?.cwd,
        title: options.title,
        actor: options.actor,
        wasArchived,
        wasPinned,
        forced
      });
    } catch (error) {
      // The store rolls its own move back, but the release archive is ours to
      // undo: without this a throwing trash leaves the session archived (gone
      // from the default list) while its files are still on disk and no bin item
      // exists to restore it from.
      if (archivedForRelease && !wasArchived) {
        const unarchived = await this.#unarchiveQuietly(sessionId);
        if (!unarchived && typeof error === "object" && error !== null) {
          // The rollback failed: the caller has to be told that the session stays
          // hidden while its files are still there.
          error.cleanupFailures = [...(error.cleanupFailures ?? []), "unarchive"];
          error.rollbackNote = UNARCHIVE_FAILED_NOTE;
        }
      }
      throw error;
    }
    phase("move");
    if (!trashed.ok) {
      const unarchived = archivedForRelease && !wasArchived ? await this.#unarchiveQuietly(sessionId) : true;
      const result = { sessionId, ok: false, code: trashed.code, message: trashed.message, timings };
      await this.#audit({ op: "delete", outcome: "failed", sessionId, code: trashed.code, actor: options.actor });
      return unarchived ? result : withUnarchiveFailure(result);
    }

    // The bytes are safe in the bin; everything below is bookkeeping and must
    // not be allowed to turn a successful delete into a reported failure.
    // `residue` is the one thing that decides what the bookkeeping looks like:
    // a session the runtime still holds has to stay archived (that is the only
    // state that hides it), a session the runtime let go of is simply gone.
    const residue = !released;
    const cleanup = await this.#cleanupAccounting(sessionId, residue);
    this.#emitRemoved(sessionId);
    phase("cleanup");
    // A successful delete has to leave a trace of what actually happened to the
    // session, not only that its files moved. `forced` says the caller consented
    // to stopping the work; `released` says whether the runtime let go of the
    // session (the row is gone) or still holds it (the row stays archived until
    // DSH restarts). Without this line the audit trail cannot answer the one
    // question a zombie row raises: did the session really go away?
    await this.#audit({
      op: "delete",
      outcome: residue ? "ok-residue" : "ok",
      sessionId,
      released,
      forced,
      residue,
      cleanup,
      actor: options.actor
    });
    if (residue) {
      this.#ctx.logger?.warn?.(
        `session-trash: forced delete of ${sessionId} could not take the session down; it stays archived until DSH restarts`
      );
    }
    return {
      sessionId,
      ok: true,
      trashId: trashed.item.trashId,
      totalBytes: trashed.item.totalBytes,
      fileCount: trashed.item.fileCount,
      // Whether the runtime let go of the session: the host stops listing it and
      // the row is gone from every client.
      released,
      // Whether the caller consented to a forced delete (its work was stopped
      // even if it had not finished).
      forced,
      // True when a move left a session the host still holds: it stays archived
      // until DSH restarts. The UI explains it instead of showing a broken row
      // it cannot act on.
      residue,
      cleanup,
      timings
    };
  }

  /**
   * Clear a session the store has no directory for.
   *
   * There is nothing to move into the bin, so "deleting" it can only mean taking
   * it off the list: releasing it from the host's live registry, dropping the
   * durable bookkeeping that would otherwise draw it again, and telling every
   * client the row is gone. The same consents as a real delete still gate the
   * destructive half (stopping work, archiving a live session), so this is never
   * a silent action the user did not ask for — the difference is only that the
   * answer is a result, not a refusal.
   *
   * The release is what makes the row go. DSH has no public dispose-by-id call,
   * so the plugin reaches for the live registry's own disposer (see
   * {@link SessionTrashService.#releaseResidentSession}); when even that is
   * refused, the session stays archived — hidden under the default view — and
   * the answer says exactly what is left and what makes it disappear.
   *
   * @param {string} sessionId - the fileless session.
   * @param {object} options - the resolved per-session delete options.
   * @param {{code: string, message: string}} located - the store's locate refusal.
   * @param {object} timings - the caller's per-phase timings, extended in place.
   * @returns {Promise<object>} one session's delete outcome.
   */
  async #clearFileless(sessionId, options, located, timings = {}) {
    const activity = await describeActivity(this.#ctx, sessionId);
    const activityKnown = activity !== undefined;
    const activityFamilies = activity ?? [];
    const resident = isResident(this.#ctx, sessionId);
    if ((!activityKnown || activityFamilies.length > 0) && !options.stopActivity) {
      await this.#audit({ op: "delete", outcome: "refused", sessionId, code: "session-active", actor: options.actor });
      return {
        sessionId,
        ok: false,
        code: "session-active",
        message: activityKnown ? "该会话仍有正在进行的工作" : "无法确认该会话是否仍有正在进行的工作",
        activity: activityFamilies,
        timings
      };
    }
    if (resident && !options.stopActivity) {
      await this.#audit({ op: "delete", outcome: "refused", sessionId, code: "session-live", actor: options.actor });
      return {
        sessionId,
        ok: false,
        code: "session-live",
        message: "该会话仍处于打开状态，需要先释放后再删除",
        activity: activityFamilies,
        timings
      };
    }
    const cleanup = [];
    if (!activityKnown || activityFamilies.length > 0) {
      await this.#stopActivity(sessionId);
      cleanup.push("stop");
    }
    // Hiding is not enough, and it is not what the user asked for either. A
    // session the runtime still holds keeps being listed, and the sidebar's
    // "show archived" view draws an archived row exactly like a normal one (in
    // grey) — that is the 「已归档且删不掉」 report: the delete worked, and what
    // was left behind was a row without a session under it. So the row has to
    // leave the list altogether, which means the runtime has to let the session
    // go.
    let released = !resident;
    // Whether this clear had to TEAR the session down instead of letting it
    // finish on its own. The response used to hardcode `forced: false`, so an
    // audit trail (and any client reading it) could not tell a clean release
    // from a forced teardown.
    let forcedRelease = false;
    if (resident) {
      // Archiving first is still the right order: it gates every wake the stops
      // could induce, and it hides the row while the release is being tried.
      if (await this.#archiveForRelease(sessionId)) cleanup.push("archive");
      // A caller who consented is not waiting for a clean release (see
      // FORCE_RELEASE_PROBE_MS): the runtime keeps a session for as long as the
      // process lives, so a short probe is followed by the teardown below
      // instead of by a long wait.
      const budget = options.force === true ? FORCE_RELEASE_PROBE_MS : options.waitForReleaseMs;
      released = await waitForRelease(this.#ctx, sessionId, budget);
      if (!released) {
        released = this.#releaseResidentSession(sessionId);
        if (released) {
          cleanup.push("release");
          forcedRelease = true;
        }
      }
    }
    if (released) {
      // The runtime let the session go, so the durable bookkeeping can go too:
      // an archived id would keep the session in the archive set forever, and a
      // workspace slot is a link to a session that no longer exists.
      cleanup.push(...(await this.#clearResidueAccounting(sessionId)));
    } else if (this.#isPinned(sessionId)) {
      // Not released: the row stays where it is, archived (hidden under the
      // default view), and the answer says so — a pin is not worth keeping for a
      // session that is not there.
      try {
        await this.#ctx.get("workspaceRegistry")?.unpinSession?.(sessionId);
        cleanup.push("unpin");
      } catch (error) {
        this.#ctx.logger?.warn?.(`session-trash: un-pinning ${sessionId} after a clear failed: ${String(error)}`);
      }
    }
    this.#emitRemoved(sessionId);
    // `released` is the whole point of a clear: it says the row is gone for good
    // (false means the runtime still holds it and it only stays hidden).
    await this.#audit({
      op: "delete",
      outcome: "cleared",
      sessionId,
      code: located.code,
      released,
      residue: !released,
      cleanup,
      actor: options.actor
    });
    this.#ctx.logger?.info?.(
      released
        ? `session-trash: ${sessionId} has no session directory under any known root; released it from the runtime and cleared it from the list`
        : `session-trash: ${sessionId} has no session directory under any known root; it is still held by the runtime, so it stays archived and hidden`
    );
    return {
      sessionId,
      ok: true,
      // No bin item exists, so the UI must not promise a restore for this row.
      cleaned: true,
      trashId: null,
      totalBytes: 0,
      fileCount: 0,
      // Whether the runtime actually let the session go. `false` means the row
      // is still on screen (archived, so hidden under the default view) and the
      // caller has to be told what makes it go away.
      released,
      forced: forcedRelease,
      residue: !released,
      code: located.code,
      message: located.message,
      note: released
        ? undefined
        : "该会话的运行时引用没能释放：它已被归档隐藏，重启 DSH 后彻底消失",
      cleanup,
      timings
    };
  }

  /**
   * Take one session out of the host's live registry.
   *
   * DSH exposes no public "dispose this session" call, and a session the runtime
   * still holds keeps being listed — which is why a session whose files are gone
   * can linger on screen as a row with nothing behind it. The live registry
   * (`ctx.sessions`) keeps one entry per live session, and that entry owns a
   * `detach()` disposer: calling it removes the entry, closes the session's
   * writer through the `session/disposed` event, and tells every client the
   * session is gone — the same teardown the runtime performs when the session's
   * own agent unloads. A second detach is a no-op, so the agent's own teardown
   * afterwards is harmless.
   *
   * This is used in two places, and both are places where the user has already
   * asked for the session to be gone: a session whose files are already gone (a
   * row with nothing behind it), and a forced delete of a session the runtime
   * still holds. In both cases the alternative — leaving the row on the list —
   * is the bug being fixed. A second detach is a no-op, so the agent's own
   * teardown afterwards is harmless.
   *
   * @param {string} sessionId - the session to release.
   * @returns {boolean} whether the session left the live registry.
   */
  /**
   * Make a resident session's buffered events durable before it is detached.
   *
   * `SessionStore.flush(session)` is the documented durability barrier and the
   * only supported one: it dispatches `session/flush`, which the JSONL backend
   * answers by draining its routed live buffer and fsyncing. It also requires a
   * live session (`liveEntryFor`), so it cannot run after `detach()` — which is
   * exactly the order this plugin used to rely on. Best-effort by design: a
   * failed flush must not block a delete the user already consented to, but it
   * is logged instead of silently skipped.
   *
   * @param {string} sessionId - the session to flush.
   * @returns {Promise<boolean>} whether a flush was attempted and succeeded.
   */
  async #flushResidentSession(sessionId) {
    try {
      const sessions = this.#ctx.get?.("sessions");
      if (sessions === undefined || sessions === null || typeof sessions.flush !== "function") return false;
      const entry = typeof sessions.store?.get === "function" ? sessions.store.get(sessionId) : undefined;
      const session = entry?.session;
      if (session === undefined || session === null) return false;
      await sessions.flush(session);
      return true;
    } catch (error) {
      this.#ctx.logger?.warn?.(`session-trash: flushing ${sessionId} before release failed: ${String(error)}`);
      return false;
    }
  }

  #releaseResidentSession(sessionId) {
    try {
      const sessions = this.#ctx.get("sessions");
      const entry = typeof sessions?.store?.get === "function" ? sessions.store.get(sessionId) : undefined;
      if (entry === undefined) return !isResident(this.#ctx, sessionId);
      if (typeof entry.detach !== "function") return false;
      entry.detach();
      const released = !isResident(this.#ctx, sessionId);
      if (!released) {
        this.#ctx.logger?.warn?.(
          `session-trash: detaching ${sessionId} from the live registry did not release it`
        );
      }
      return released;
    } catch (error) {
      this.#ctx.logger?.warn?.(
        `session-trash: releasing ${sessionId} from the live registry failed: ${String(error)}`
      );
      return false;
    }
  }

  /**
   * Drop the durable bookkeeping of a session that no longer exists.
   *
   * Two leftovers survive a delete: the id in the durable archive set, and the id
   * in a workspace's `sessionIds` slot. Both are inert while nothing lists the
   * session, and both put the row back the moment it is listed again — the
   * archive set decides whether the row is drawn at all, the workspace slot
   * decides which group it lands in. This runs only *after* the runtime has let
   * the session go, so the id cannot resurface as an ungrouped row (the failure
   * that made a forced delete push its residue into 未分组).
   *
   * @param {string} sessionId - the cleared session.
   * @returns {Promise<string[]>} names of the cleanup steps that ran.
   */
  async #clearResidueAccounting(sessionId) {
    const registry = this.#ctx.get("workspaceRegistry");
    if (registry === undefined) return [];
    const done = [];
    // Only the bookkeeping that actually holds this id is touched: a session the
    // runtime never held was never archived, pinned or attached, and writing to
    // those sets anyway would be a change to state that has nothing to do with
    // this delete.
    const archived = registry.archivedSessionIds ?? [];
    if (archived.includes(sessionId)) {
      try {
        await registry.unarchiveSession?.(sessionId);
        done.push("unarchive");
      } catch (error) {
        this.#ctx.logger?.warn?.(
          `session-trash: un-archiving the cleared ${sessionId} failed: ${String(error)}`
        );
      }
    }
    try {
      for (const entity of registry.list?.() ?? []) {
        // A detach for an id the workspace does not hold is a no-op, so this
        // walks every workspace instead of guessing which one owns the id.
        if (!(entity?.sessionIds ?? []).includes(sessionId)) continue;
        await entity?.detachSession?.(sessionId);
        done.push("detach");
      }
    } catch (error) {
      this.#ctx.logger?.warn?.(
        `session-trash: detaching the cleared ${sessionId} from its workspace failed: ${String(error)}`
      );
    }
    const pinned = registry.pinnedSessionIds ?? [];
    if (pinned.includes(sessionId)) {
      try {
        await registry.unpinSession?.(sessionId);
        done.push("unpin");
      } catch (error) {
        this.#ctx.logger?.warn?.(
          `session-trash: un-pinning the cleared ${sessionId} failed: ${String(error)}`
        );
      }
    }
    return done;
  }

  /**
   * Bring DSH's durable accounting in line with files that are now in the bin.
   *
   * Two decisions here are load-bearing, and both come from how the sidebar picks
   * its rows. It renders each workspace's `sessionIds` that still have a summary,
   * plus a catch-all "ungrouped" bucket holding every listed session no workspace
   * claims — and {@link sessionVisible} hides any id in the archive set under the
   * default filter.
   *
   * 1. **No detach.** Detaching dropped the id out of its workspace, and the row
   *    immediately resurfaced in the ungrouped bucket — reported by a user as a
   *    deleted session "appearing in 未分组". The stale id is inert (`groupByWorkspace`
   *    skips ids with no summary), and leaving it in place is also what makes a
   *    restore land back in its original workspace.
   * 2. **A forced delete stays archived — but only when the runtime kept it.** A
   *    forced delete now takes the session down through the live registry first
   *    (see {@link SessionTrashService}), so the row leaves the list for good and
   *    the release archive is lifted like any other. What is left is the one case
   *    the runtime refused: the host keeps listing a live session whose files are
   *    gone, and archived is the only state that hides it — `sessionVisible`
   *    returns `!archived.has(id)` under the default filter. That residue is
   *    reported to the caller rather than hidden behind a silent success.
   *
   * @param {string} sessionId - the deleted session.
   * @param {boolean} residue - whether the runtime still holds the session, so its
   *   row has to stay archived instead of being lifted.
   * @returns {Promise<string[]>} names of the cleanup steps that failed.
   */
  async #cleanupAccounting(sessionId, residue) {
    const registry = this.#ctx.get("workspaceRegistry");
    if (registry === undefined) return [];
    const failures = [];
    const attempt = async (name, run) => {
      try {
        await run();
      } catch (error) {
        failures.push(name);
        this.#ctx.logger?.warn?.(`session-trash: ${name} cleanup for ${sessionId} failed: ${String(error)}`);
      }
    };
    if (residue) {
      // A no-op when the release already archived it.
      await attempt("archive", () => registry.archiveSession(sessionId, { stopActivity: true }));
    } else {
      await attempt("unarchive", () => registry.unarchiveSession(sessionId));
    }
    await attempt("unpin", () => registry.unpinSession(sessionId));
    return failures;
  }

  /**
   * Archive a session so the runtime can let go of it.
   *
   * `stopActivity: true` is deliberate: the caller already stopped the work, and
   * the durable archive set is what gates every wake those stops could induce, so
   * re-running the activity check would only race the stops.
   *
   * @param {string} sessionId - the session to release.
   * @returns {Promise<boolean>} whether the session is archived.
   */
  async #archiveForRelease(sessionId) {
    const registry = this.#ctx.get("workspaceRegistry");
    if (registry === undefined || typeof registry.archiveSession !== "function") return false;
    try {
      await registry.archiveSession(sessionId, { stopActivity: true });
      return true;
    } catch (error) {
      this.#ctx.logger?.warn?.(`session-trash: archiving ${sessionId} to release it failed: ${String(error)}`);
      return false;
    }
  }

  /**
   * Undo {@link #archiveForRelease} when the delete did not happen, so a failed
   * attempt never leaves a session hidden that the user did not archive.
   *
   * A failure here is not a detail to log away: the session stays hidden from
   * the default list while its files are still on disk, so the caller has to
   * report it.
   *
   * @param {string} sessionId - the session to make visible again.
   * @returns {Promise<boolean>} true when the session is visible again.
   */
  async #unarchiveQuietly(sessionId) {
    try {
      await this.#ctx.get("workspaceRegistry")?.unarchiveSession?.(sessionId);
      return true;
    } catch (error) {
      this.#ctx.logger?.warn?.(`session-trash: un-archiving ${sessionId} after a failed delete failed: ${String(error)}`);
      return false;
    }
  }

  /**
   * Stop the work a session is still doing, the way archive does.
   *
   * Three seams, because only one of them exists in every deployment:
   *
   * - `sessionController.cancel({ sessionId })` is the shipped API for ending an
   *   active Agent turn without dropping its pending inbox. This is the step that
   *   actually stops a model stream or a tool call.
   * - `workspaceRegistry.stopSessionActivity(id)` is what older/forrowed DSHs
   *   expose for the same purpose; it is called when present.
   * - `ctx.parallel("workspace/session-stop", { sessionId })` is the **public**
   *   waterfall DSH's own archive flow ends a session's work through. It is the
   *   fallback: `stopSessionActivity` is a *private* member of the registry, and
   *   a private member can be renamed or made truly private without notice —
   *   the guard above would then skip the stop silently, and the session would
   *   be deleted with its work still running even though the user consented to
   *   "stop and delete".
   *
   * The archive that follows (`archiveSession(id, { stopActivity: true })`) still
   * runs: it is what gates every wake the stops could induce. Failures here are
   * logged, never thrown — a delete that could not stop the work cleanly is still
   * the delete the user asked for, and the archive keeps it from resuming.
   *
   * @param {string} sessionId - the session whose work must stop.
   * @returns {Promise<void>} resolves after every available stop seam was tried.
   */
  async #stopActivity(sessionId) {
    const controller = this.#ctx.get("sessionController");
    if (controller !== undefined && typeof controller.cancel === "function") {
      try {
        await controller.cancel({ sessionId });
      } catch (error) {
        this.#ctx.logger?.warn?.(`session-trash: cancelling the active turn of ${sessionId} failed: ${String(error)}`);
      }
    }
    const registry = this.#ctx.get("workspaceRegistry");
    if (typeof registry?.stopSessionActivity === "function") {
      try {
        await registry.stopSessionActivity(sessionId);
      } catch (error) {
        this.#ctx.logger?.warn?.(`session-trash: stopping activity for ${sessionId} failed: ${String(error)}`);
      }
      return;
    }
    // No registry seam: ask the providers directly, the way the registry does.
    try {
      await this.#ctx.parallel?.("workspace/session-stop", { sessionId });
    } catch (error) {
      this.#ctx.logger?.warn?.(`session-trash: stopping activity for ${sessionId} failed: ${String(error)}`);
    }
  }

  /**
   * Tell every connected client the row is gone.
   *
   * The caller's own client refreshes its list regardless, so this is a
   * best-effort courtesy for other tabs and must never fail a delete.
   */
  #emitRemoved(sessionId) {
    try {
      this.#ctx.emit("api-session/removed", sessionId);
    } catch (error) {
      this.#ctx.logger?.debug?.(`session-trash: removal emit failed: ${String(error)}`);
    }
  }

  /**
   * Announce a restored session so other clients show it again.
   *
   * @param {string} sessionId - the restored session.
   * @returns {Promise<boolean>} whether a summary was found and emitted.
   */
  async #emitAdded(sessionId) {
    try {
      const summary = (await this.#summaries()).find((row) => row.sessionId === sessionId);
      if (summary === undefined) return false;
      this.#ctx.emit("api-session/added", summary);
      return true;
    } catch (error) {
      this.#ctx.logger?.debug?.(`session-trash: re-add emit failed: ${String(error)}`);
      return false;
    }
  }

  /** @returns {Promise<Array<object>>} host list summaries, or an empty array. */
  async #summaries() {
    const controller = this.#ctx.get("sessionController");
    const list = controller?.listState;
    if (list === undefined || typeof list.list !== "function") return [];
    const rows = await list.list();
    return Array.isArray(rows) ? rows : [];
  }

  /** @returns {boolean} whether the id is in the durable archive set. */
  #isArchived(sessionId) {
    try {
      return this.#ctx.get("workspaceRegistry")?.archivedSessionIds?.includes(sessionId) === true;
    } catch {
      return false;
    }
  }

  /** @returns {boolean} whether the id is in the durable pin set. */
  #isPinned(sessionId) {
    try {
      return this.#ctx.get("workspaceRegistry")?.pinnedSessionIds?.includes(sessionId) === true;
    } catch {
      return false;
    }
  }

  /**
   * List the recycle bin.
   * @param {object} [options] - listing options.
   * @param {number} [options.retentionDays] - window used to mark expiry.
   * @returns {Promise<object>} `{items, stats}`.
   */
  async list({ retentionDays = 0 } = {}) {
    const items = await this.#store.list();
    const stats = await this.#store.stats(retentionDays, items);
    // The store's own clock, so a per-item `expired` flag can never disagree with
    // the `expiredCount` beside it.
    const cutoff = retentionDays > 0 ? this.#store.now() - retentionDays * 86_400_000 : 0;
    return {
      items: items
        .filter((item) => item.state === ITEM_TRASHED)
        .map((item) => ({
          trashId: item.trashId,
          sessionId: item.sessionId,
          title: item.title ?? null,
          cwd: item.cwd ?? null,
          originalPath: item.originalPath,
          deletedAt: item.deletedAt,
          deletedAtIso: item.deletedAtIso,
          totalBytes: item.totalBytes ?? 0,
          fileCount: item.fileCount ?? 0,
          expired: cutoff > 0 && (item.deletedAt ?? 0) < cutoff
        })),
      broken: items
        .filter((item) => isBroken(item))
        .map((item) => ({ trashId: item.trashId, state: item.state, error: item.error ?? null })),
      stats
    };
  }

  /**
   * Restore trashed sessions.
   *
   * @param {object} request - restore request.
   * @param {string[]} request.trashIds - items to restore.
   * @param {object} [request.titles] - unused; reserved for future naming.
   * @param {string} [request.actor] - audit actor label.
   * @returns {Promise<object>} `{results, restored, failed}`.
   */
  async restoreSessions(request = {}) {
    const trashIds = Array.isArray(request.trashIds) ? request.trashIds : [];
    return this.#queue.run(async () => {
      const results = [];
      for (const trashId of trashIds) {
        results.push(await this.#restoreOne(trashId, request.actor));
      }
      const restored = results.filter((row) => row.ok);
      return { results, restored: restored.length, failed: results.length - restored.length };
    });
  }

  /**
   * Restore one item, then put its accounting back.
   *
   * A bad id or a failing item must not throw out of the batch: the items before
   * it have already been restored, so the caller needs per-item results rather
   * than a bare 500 that hides what happened.
   *
   * @param {string} trashId - item to restore.
   * @param {string} [actor] - audit actor label.
   * @returns {Promise<object>} this item's outcome.
   */
  async #restoreOne(trashId, actor) {
    if (!isSafeTrashId(trashId)) {
      await this.#audit({ op: "restore", outcome: "refused", trashId, code: "invalid-trash-id", actor });
      return { trashId, ok: false, code: "invalid-trash-id", message: "回收站 id 不安全" };
    }
    let outcome;
    try {
      outcome = await this.#store.restore(trashId, { actor });
    } catch (error) {
      await this.#audit({
        op: "restore",
        outcome: "failed",
        trashId,
        error: String(error?.message ?? error),
        actor
      });
      return { trashId, ok: false, code: "restore-failed", message: String(error?.message ?? error) };
    }
    if (!outcome.ok) {
      await this.#audit({ op: "restore", outcome: "refused", trashId, code: outcome.code, actor });
      return { trashId, ok: false, code: outcome.code, message: outcome.message, sessionId: outcome.sessionId };
    }
    const cleanup = await this.#restoreAccounting(outcome);
    // Put the session back into the runtime before anyone is told it is back: a
    // restored row without a live session behind it is a row that cannot be
    // talked to, and the user sees a message that goes nowhere.
    const revive = await this.#reviveSession(outcome.sessionId);
    await this.#audit({
      op: "restore-revive",
      outcome: revive.revived ? "ok" : "failed",
      trashId,
      sessionId: outcome.sessionId,
      code: revive.code,
      message: revive.message ?? null,
      actor
    });
    const announced = await this.#emitAdded(outcome.sessionId);
    return {
      trashId,
      ok: true,
      sessionId: outcome.sessionId,
      originalPath: outcome.originalPath,
      announced,
      revived: revive.revived,
      reviveCode: revive.code,
      reviveMessage: revive.message ?? null,
      cleanup
    };
  }

  /**
   * Put a restored session back into DSH's own durable accounting.
   *
   * Delete removes the id from the workspace, archive and pin sets, so restore
   * must put it back or the session would come home as an ungrouped orphan whose
   * archived/pinned state had silently changed. Everything here is best-effort:
   * the files are already back, so a bookkeeping failure is reported, not fatal.
   *
   * @param {object} outcome - the store's restore result, carrying the manifest facts.
   * @returns {Promise<string[]>} names of the steps that failed.
   */
  async #restoreAccounting(outcome) {
    const registry = this.#ctx.get("workspaceRegistry");
    if (registry === undefined) return [];
    const failures = [];
    const attempt = async (name, run) => {
      try {
        await run();
      } catch (error) {
        failures.push(name);
        this.#ctx.logger?.warn?.(`session-trash: ${name} restore for ${outcome.sessionId} failed: ${String(error)}`);
      }
    };
    if (typeof outcome.cwd === "string" && outcome.cwd.length > 0) {
      await attempt("attach", async () => {
        const entity = (registry.list() ?? []).find(
          (candidate) => candidate.path === outcome.cwd && !candidate.sessionIds.includes(outcome.sessionId)
        );
        if (entity !== undefined) await entity.attachSession(outcome.sessionId);
      });
    }
    // Authoritative rather than one-directional: a forced delete deliberately leaves
    // the id archived to keep the residue hidden, so a restore must be able to clear
    // that state again when the session was not archived before it was deleted.
    if (outcome.wasPinned) await attempt("pin", () => registry.pinSession(outcome.sessionId));
    else await attempt("unpin", () => registry.unpinSession(outcome.sessionId));
    if (outcome.wasArchived) await attempt("archive", () => registry.archiveSession(outcome.sessionId));
    else await attempt("unarchive", () => registry.unarchiveSession(outcome.sessionId));
    return failures;
  }

  /**
   * Put a restored session back into the runtime.
   *
   * Deleting a session takes it down in the host's live registry, and moving its
   * files back does not bring it back: the runtime holds no entry for it any
   * more, so a message sent to it goes nowhere and the client shows nothing at
   * all. The host's own resume path is the only thing that recreates that
   * entry, so a restore asks for it explicitly and reports what came of it.
   *
   * A failure here is not a failed restore: the files are back on disk and the
   * session is readable, so the outcome is reported and the caller can tell the
   * user that a restart will bring it back to life.
   *
   * @param {string} sessionId - the restored session.
   * @returns {Promise<{revived: boolean, code: string, message?: string}>} the outcome.
   */
  async #reviveSession(sessionId) {
    // The live registry is asked directly instead of through the fail-closed
    // residency probe: that probe treats an unavailable registry as "possibly
    // resident", and a session that is only *possibly* resident still has to be
    // revived, or the restore would leave it dead without saying so.
    const registry = this.#ctx.get("sessions");
    const live = typeof registry?.get === "function" ? registry.get(sessionId) !== undefined : false;
    if (live) return { revived: true, code: "already-live" };
    const controller = this.#ctx.get("sessionController");
    if (controller === undefined || typeof controller.resolveAgent !== "function") {
      return { revived: false, code: "no-resume-api", message: "当前 DSH 没有提供会话恢复接口" };
    }
    let timer;
    try {
      const resume = Promise.resolve(controller.resolveAgent(sessionId));
      // A resume that fails after the timeout would otherwise surface as an
      // unhandled rejection long after this request already answered.
      resume.catch(() => {});
      const found = await Promise.race([
        resume,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`resume timed out after ${String(this.#reviveTimeoutMs)}ms`)),
            this.#reviveTimeoutMs
          );
        })
      ]);
      if (found !== null && typeof found === "object") {
        if (found.error !== undefined && found.error !== null) {
          return { revived: false, code: "resume-failed", message: String(found.error?.message ?? found.error) };
        }
        if ("agent" in found && (found.agent === undefined || found.agent === null)) {
          return { revived: false, code: "resume-failed", message: "会话恢复没有返回可用的 agent" };
        }
      }
      return { revived: true, code: "resumed" };
    } catch (error) {
      return { revived: false, code: "resume-failed", message: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Permanently remove trashed sessions. Irreversible.
   *
   * @param {object} request - purge request.
   * @param {string[]} request.trashIds - items to erase, or the sentinel `["*"]` for all.
   * @param {boolean} [request.acknowledge] - must be `true`; the explicit consent gate.
   * @param {string} [request.actor] - audit actor label.
   * @returns {Promise<object>} `{results, purged, freedBytes}`.
   */
  async purgeSessions(request = {}) {
    if (request.acknowledge !== true) {
      return { results: [], purged: 0, freedBytes: 0, refused: true, code: "not-acknowledged" };
    }
    let trashIds = Array.isArray(request.trashIds) ? request.trashIds : [];
    const purgeAll = trashIds.length === 1 && trashIds[0] === "*";
    return this.#queue.run(async () => {
      // Expanding the sentinel *inside* the queue keeps it honest: listed outside,
      // an item trashed by a delete that was already queued would slip past the
      // snapshot and survive an "empty the whole bin".
      if (purgeAll) {
        // Broken items have no manifest (so nothing can restore them) but are
        // still bytes the bin owns; "empty the bin" must not leave them behind.
        trashIds = (await this.#store.list())
          .filter((item) => item.state === ITEM_TRASHED || isBroken(item))
          .map((item) => item.trashId);
      }
      const results = await this.#store.purge(trashIds, { actor: request.actor });
      for (const row of results) {
        if (row.ok !== true) {
          await this.#audit({ op: "purge", outcome: "refused", trashId: row.trashId, code: row.code, actor: request.actor });
        }
      }
      const purged = results.filter((row) => row.ok);
      // A purge destroys the last copy of a session: nothing can restore it any
      // more. The durable bookkeeping that still points at it is then dead
      // weight — and in the archive set it is worse than weight, because the
      // id names a row that can never be opened again and can never be deleted
      // either (there is no session left to select). The delete path leaves
      // those ids alone on purpose (a restore has to land back in its
      // workspace), but a purge is the user saying "gone for good".
      for (const row of purged) {
        // The bytes are already gone: clearing the dead bookkeeping is best-effort,
        // and the delete path already treats a mid-batch cleanup throw the same way.
        // A throw here (a persistence probe error, a registry getter throwing) must
        // not turn a purge that destroyed the last copy into a reported failure the
        // caller then thinks it can retry.
        try {
          await this.#clearPurgedAccounting(row.sessionId);
        } catch (error) {
          this.#ctx.logger?.warn?.(
            `session-trash: clearing purged accounting for ${row.sessionId} failed: ${String(error?.message ?? error)}`
          );
          try {
            await this.#audit({ op: "purge", outcome: "accounting-failed", trashId: row.trashId, sessionId: row.sessionId, code: "accounting-error", actor: request.actor });
          } catch {
            /* an audit write is not worth failing a purge that already destroyed the bytes */
          }
        }
      }
      return {
        results,
        purged: purged.length,
        freedBytes: purged.reduce((sum, row) => sum + (row.freedBytes ?? 0), 0)
      };
    });
  }

  /**
   * Drop the bookkeeping of a session the user destroyed for good.
   *
   * The id is only touched when the session really is gone: a session whose
   * files are back on disk (it was restored) is alive, and a session the
   * runtime still holds is released first — otherwise the host keeps listing a
   * session whose last copy was just destroyed, and the row stays behind as an
   * archive entry nobody can open. When the runtime refuses to let go, the id
   * stays archived on purpose: that is the only state that hides the row.
   *
   * @param {string|undefined|null} sessionId - the purged session, if the item had one.
   * @returns {Promise<string[]>} names of the cleanup steps that ran.
   */
  async #clearPurgedAccounting(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return [];
    const persistence = this.#ctx.get("sessionPersistence");
    const located = await resolveSessionDir({ sessionId, persistence });
    // A session is only provably dead when the probe answers "not-found". "ok"
    // means a copy is on disk again (it was restored), and "not-visible" /
    // "unsafe-location" mean a copy still exists but is out of reach under the
    // containment rules. Clearing the bookkeeping of a session whose bytes still
    // exist would orphan a row the user could still open, so every refusal other
    // than "not-found" is treated as "still alive" (fail-closed).
    if (located.ok || located.code !== "not-found") return [];
    if (isResident(this.#ctx, sessionId) && !this.#releaseResidentSession(sessionId)) {
      // Still held by the runtime: it stays archived, hidden under the default
      // view, until DSH restarts and the registry lets it go.
      return [];
    }
    return await this.#clearResidueAccounting(sessionId);
  }

  /**
   * The status/read model for the panel header.
   * @param {object} [options] - options.
   * @param {number} [options.retentionDays] - configured retention window.
   * @returns {Promise<object>} capability and count summary.
   */
  async status({ retentionDays = 0 } = {}) {
    const stats = await this.#store.stats(retentionDays);
    return {
      root: stats.root,
      count: stats.count,
      brokenCount: stats.brokenCount,
      bytes: stats.bytes,
      expiredCount: stats.expiredCount,
      retentionDays: stats.retentionDays,
      canDelete: this.#ctx.get("sessionPersistence") !== undefined,
      hasWorkspaceRegistry: this.#ctx.get("workspaceRegistry") !== undefined,
      apiVersion: API_VERSION
    };
  }

  /**
   * Read the audit log.
   * @param {object} [options] - read options.
   * @param {number} [options.limit] - maximum records.
   * @returns {Promise<Array<object>>} newest first.
   */
  async log({ limit = 200 } = {}) {
    return this.#store.readLog({ limit });
  }

  /**
   * Append a service-level audit record.
   *
   * @param {object} record - fields to record.
   */
  async #audit(record) {
    // Explicit `undefined` must not erase the default actor.
    const actor = typeof record.actor === "string" && record.actor !== "" ? record.actor : "session-menu";
    const { actor: _ignored, ...rest } = record;
    await this.#store.record({ ...rest, actor });
  }
}
