/**
 * Client bundle tests.
 *
 * The bundle is the file DSH actually serves, so it is loaded here exactly the
 * way the browser loads it: a stub `window.__ModuleLoader__` captures the
 * registration, and a stub `require` answers only the specifiers the platform's
 * frozen module table provides. That verifies the two things a client plugin can
 * get wrong fatally — requiring a module the platform does not expose, and
 * declaring a service it cannot have — as well as the registration surface and
 * the pure decision logic behind the dialogs.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "..", "..", "lib", "client.js");

/** The platform module table the shell seeds, from `@deepseek-ai/dsh-client-modules`. */
const PLATFORM_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit"
];

/** A minimal React stand-in: element creation plus the hooks the bundle uses. */
function stubReact(options = {}) {
  // `stateful` keeps one state slot alive across calls, so a component that
  // reads state in an effect can be re-rendered the way React would.
  const slot = { value: null };
  return {
    Fragment: Symbol("Fragment"),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      if (options.stateful) {
        if (slot.value === null) slot.value = typeof initial === "function" ? initial() : initial;
        return [
          slot.value,
          (next) => {
            slot.value = typeof next === "function" ? next(slot.value) : next;
          }
        ];
      }
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useEffect: (callback) => {
      if (options.stateful) callback();
    },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial })
  };
}

/**
 * A stand-in for the component primitives: every named export is a marker
 * function, so an import the primitives package does not actually export would
 * still be caught by the explicit expected-export list below.
 */
function stubPrimitives() {
  return new Proxy(
    {},
    {
      get: (target, name) => {
        if (typeof name !== "string") return undefined;
        target[name] ??= function Stub() {
          return null;
        };
        return target[name];
      }
    }
  );
}

/**
 * A faithful-enough `defineStore` for the parts the bundle uses: initial state,
 * draft-mutating actions, and snapshot/subscribe.
 */
function stubClientStore() {
  return {
    defineStore(decl) {
      return {
        spec: decl,
        create() {
          let state = decl.init();
          const listeners = new Set();
          const actions = {};
          for (const key of Object.keys(decl.actions)) {
            actions[key] = (...params) => {
              const draft = structuredClone(state);
              decl.actions[key](draft, ...params);
              state = draft;
              for (const listener of listeners) listener();
            };
          }
          return {
            actions,
            getSnapshot: () => state,
            subscribe: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            store: {},
            clearPersisted: () => {}
          };
        }
      };
    }
  };
}

/**
 * Load the bundle the way the browser does.
 *
 * @returns {Promise<{exports: object, id: string, required: string[]}>} the module exports and what it required.
 */
async function loadBundle(options = {}) {
  const source = await fs.readFile(BUNDLE, "utf8");
  const required = [];
  let registration = null;
  // Run in this realm rather than a fresh context: `deepStrictEqual` compares
  // prototypes, so objects built inside another realm would never match the
  // literals they should equal.
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => {
        registration = entry;
      }
    }
  };
  try {
    // The stub must stay installed until the factory has run: the bundle injects
    // its stylesheet from the factory body, which the module system calls lazily.
    if (options.document !== undefined) globalThis.document = options.document;
    vm.runInThisContext(source, { filename: BUNDLE });
    assert.ok(registration !== null, "the bundle must call window.__ModuleLoader__.load");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  const modules = {
    react: options.react ?? stubReact(),
    "@deepseek-ai/dsh-client-ui-primitives": stubPrimitives(),
    "@deepseek-ai/dsh-client-store": stubClientStore()
  };
  const require = (specifier) => {
    required.push(specifier);
    if (!PLATFORM_MODULES.includes(specifier)) {
      throw new Error(`client-modules: cannot resolve "${specifier}" — it is not in the platform module table`);
    }
    if (!(specifier in modules)) throw new Error(`no stub for ${specifier}`);
    return modules[specifier];
  };
  try {
    if (options.document !== undefined) globalThis.document = options.document;
    return { exports: registration.factory(require), id: registration.id, required };
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

/** A fake browser context that records slot registrations. */
function fakeClientCtx(services = {}) {
  const registrations = [];
  const scope = {
    slots: {
      inject: (name, callback) => {
        const returned = callback();
        // Generator callbacks yield one registration disposer per entry.
        if (returned !== null && typeof returned === "object" && typeof returned.next === "function") {
          for (const entry of returned) void entry;
        }
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      }
    },
    effect: (callback) => {
      callback();
      return () => {};
    }
  };
  const provided = {
    slots: scope.slots,
    locale: {
      register: () => () => {},
      bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
      subscribe: () => () => {}
    },
    layout: { selectPanel: () => {} },
    sessions: {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      refreshList: async () => {}
    },
    sessionsRefreshCount: 0,
    ...services
  };
  const target = {
    registrations,
    get: (name) => provided[name],
    effect: scope.effect,
    inject: (deps, callback) => {
      // Only run the body when every declared service is present, which also
      // documents which services each surface actually needs.
      if (!deps.every((dep) => provided[dep] !== undefined)) return () => {};
      callback(injectedScope(deps, provided, scope.effect));
      return () => {};
    }
  };
  // An entry with `inject = []` may NOT read `ctx.<service>`: Cordis gates that on
  // the reading fiber's inject map and throws. Reproducing the gate here is what
  // lets these tests catch a module that would otherwise fail the whole page boot.
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === "symbol" || property in object) return object[property];
      throw new Error(`cannot get property "${String(property)}" without inject`);
    }
  });
}

/**
 * Build the scope Cordis hands to a `ctx.inject(deps, cb)` callback.
 *
 * Property access on the scope is gated to the declared dependencies, exactly as
 * Cordis gates it on the reading fiber's inject map: reading any other service
 * throws. That is what makes these tests able to catch a plugin that touches a
 * service it never declared — the mistake that fails DSH's whole page boot.
 *
 * @param {string[]} deps - declared dependencies.
 * @param {object} provided - the fake services.
 * @param {Function} effect - the effect registrar.
 * @returns {object} the injected scope.
 */
function injectedScope(deps, provided, effect) {
  const allowed = new Set([...deps, "effect", "inject", "get", "slots"]);
  const target = {
    effect,
    get: (name) => provided[name],
    inject: () => () => {}
  };
  for (const dep of deps) target[dep] = provided[dep];
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === "symbol" || property in object) return object[property];
      if (!allowed.has(property)) {
        throw new Error(`cannot get property "${String(property)}" without inject`);
      }
      return undefined;
    }
  });
}

test("the bundle registers under its package id and requires only platform modules", async () => {
  const { id, required, exports } = await loadBundle();
  assert.equal(id, "dsh-session-trash");
  for (const specifier of required) {
    assert.ok(PLATFORM_MODULES.includes(specifier), `${specifier} is not a platform module`);
  }
  assert.deepEqual([...new Set(required)].sort(), [
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-ui-primitives",
    "react"
  ]);
  assert.equal(typeof exports.apply, "function");
  assert.ok(Array.isArray(exports.inject));
  assert.deepEqual(exports.inject, [], "an empty inject is what keeps the boot audit safe");
});

test("apply registers the session menu rows with the archive-consistent order and danger styling", async () => {
  const { exports } = await loadBundle();
  const ctx = fakeClientCtx();
  exports.apply(ctx);
  const menu = ctx.registrations.filter((row) => row.options.name === "sidebar.workspaces.session.menu.item");
  assert.equal(menu.length, 2);
  assert.deepEqual(
    menu.map((row) => ({ id: row.options.id, order: row.options.order, locale: row.options.locale })),
    [
      { id: "session-trash.delete", order: 500, locale: "sessionTrash" },
      { id: "session-trash.delete-batch", order: 600, locale: "sessionTrash" }
    ]
  );
  for (const row of menu) assert.equal(typeof row.component, "function");
});

test("apply registers the overlays, the 更多 menu row and the keyed main panel", async () => {
  const { exports } = await loadBundle();
  const ctx = fakeClientCtx();
  exports.apply(ctx);
  const byName = (name) => ctx.registrations.filter((row) => row.options.name === name);
  assert.equal(byName("shell.overlay").length, 1);
  assert.equal(byName("shell.overlay")[0].options.id, "session-trash.overlays");
  // The recycle bin no longer owns a permanent sidebar row: it is a row in the
  // sidebar's 更多 menu instead.
  assert.equal(byName("sidebar.panellist").length, 0, "the recycle bin must not draw a sidebar row");
  const more = byName("sidebar.panellist.actions");
  assert.equal(more.length, 1);
  assert.equal(more[0].options.id, "session-trash.more");
  // The shell sorts a list slot's rows on `order` alone, and its own rows
  // register without an order (0), so a negative order puts ours first.
  assert.equal(more[0].options.order, -20, "the row sorts above the shell's own menu rows");
  assert.equal(more[0].options.priority, undefined, "priority does not reach the rendered order");
  assert.equal(typeof more[0].component, "function");
  const main = byName("main");
  assert.equal(main.length, 1);
  assert.equal(main[0].options.key, "session-trash", "the main panel is keyed by the active panel id");
});

test("the 更多 row closes the menu and opens the recycle-bin panel", async () => {
  const { exports } = await loadBundle();
  const ctx = fakeClientCtx();
  exports.apply(ctx);
  const row = ctx.registrations.find((entry) => entry.options.name === "sidebar.panellist.actions").component;
  const calls = [];
  exports.__test.setContext({
    get: (name) =>
      name === "layout"
        ? { selectPanel: (id) => calls.push(["select", id]) }
        : undefined
  });
  const element = row({ onDismiss: () => calls.push(["dismiss"]) });
  element.props.onSelect();
  assert.deepEqual(calls, [
    ["dismiss"],
    ["select", "session-trash"]
  ]);
});

test("the 更多 row marks itself current while the recycle bin is the open panel", async () => {
  const { exports } = await loadBundle({ react: stubReact({ stateful: true }) });
  const ctx = fakeClientCtx();
  exports.apply(ctx);
  const row = ctx.registrations.find((entry) => entry.options.name === "sidebar.panellist.actions").component;
  exports.__test.setContext({
    get: (name) =>
      name === "layout"
        ? {
            panelInfo: {
              getSnapshot: () => ({ activePanelId: "session-trash" }),
              subscribe: () => () => {}
            }
          }
        : undefined
  });
  row({ onDismiss: () => {} });
  const element = row({ onDismiss: () => {} });
  assert.equal(element.props.current, true, "the open panel marks its own menu row");
  const label = element.children[0];
  const parts = label.children.flat();
  assert.ok(parts[1], "the current row draws the check mark");
});

test("every registration shares one store instance", async () => {
  const { exports } = await loadBundle();
  const ctx = fakeClientCtx();
  exports.apply(ctx);
  const seats = ctx.registrations.filter((row) => row.options.store !== undefined);
  // The two surfaces that read shared state: the overlay host and the panel page.
  assert.deepEqual(
    seats.map((row) => row.options.id ?? row.options.key).sort(),
    ["session-trash", "session-trash.overlays"]
  );
  const instances = seats.map((row) => row.options.store.create());
  for (const instance of instances) assert.equal(instance, instances[0], "one store instance, shared");
});

test("a composition without a layout service still registers the destructive action", async () => {
  const { exports } = await loadBundle();
  const ctx = fakeClientCtx({ layout: undefined });
  exports.apply(ctx);
  const names = ctx.registrations.map((row) => row.options.name);
  assert.ok(names.includes("sidebar.workspaces.session.menu.item"), "the delete action must survive");
  assert.ok(names.includes("shell.overlay"));
  assert.ok(names.includes("sidebar.panellist.actions"), "the 更多 menu row must survive");
  assert.ok(!names.includes("main"), "the panel degrades away with its service");
});

test("pure helpers: sizes and ages", async () => {
  const { exports } = await loadBundle();
  const { formatBytes, formatAge } = exports.__test;
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
  assert.equal(formatAge(0, 30_000), "30 秒前".replace("30 秒前", "刚刚"));
  assert.equal(formatAge(0, 5 * 60_000), "5 分钟前");
  assert.equal(formatAge(0, 3 * 3_600_000), "3 小时前");
  assert.equal(formatAge(0, 2 * 86_400_000), "2 天前");
});

test("pure helpers: consent and activity flattening", async () => {
  const { exports } = await loadBundle();
  const { isDeletable, needsConsent, activityRows } = exports.__test;
  assert.equal(isDeletable({ deletable: true }), true);
  assert.equal(isDeletable({}), false);
  assert.equal(needsConsent({ resident: true }), true);
  assert.equal(needsConsent({ activity: [{ kind: "turn" }] }), true);
  assert.equal(needsConsent({ activity: [] }), false);
  // An unknown activity state is not an idle one: the client must ask for
  // consent instead of pretending the session is quiet.
  assert.equal(needsConsent({ activityKnown: false }), true);
  assert.equal(needsConsent({ activityKnown: true, activity: [] }), false);
  assert.deepEqual(activityRows([{ kind: "turn" }, { kind: "job", items: [{ id: "1", label: "build" }] }]), [
    { kind: "turn", label: "turn" },
    { kind: "job", label: "build" }
  ]);
  assert.deepEqual(activityRows(undefined), []);
  // The label shown for an unknown activity state must not claim that work is in
  // progress; the host only knows that it could not find out.
  assert.equal(exports.__test.dictionaries.zh["dialog.activityUnknown"], "无法确认该会话是否仍有正在进行的工作");
  assert.equal(exports.__test.dictionaries.en["dialog.activityUnknown"], "Cannot confirm whether work is still in progress");
});

test("pure helpers: the consent tag names the reason that actually applies", async () => {
  // The live report: a conversation that had long finished still carried the
  // label 「仍有进行中的工作」, because the runtime merely holding it was
  // reported with the same label as work under way.
  const { exports } = await loadBundle();
  const { consentTag } = exports.__test;

  // Work under way: the original label, and it is the only one.
  const busy = { sessionId: "busy", resident: true, activityKnown: true, activity: [{ kind: "turn", items: [{ id: "1" }] }] };
  assert.deepEqual(consentTag(busy), { key: "dialog.activity", tone: "warning" });

  // A scheduled delivery aimed at the session is not work under way: it has its
  // own label, and it says how many tasks are aimed at the session.
  const scheduled = {
    sessionId: "scheduled",
    resident: false,
    activityKnown: true,
    activity: [{ kind: "schedule", items: [{ id: "s1" }, { id: "s2" }] }]
  };
  assert.deepEqual(consentTag(scheduled), { key: "dialog.scheduled", tone: "warning", params: { count: 2 } });

  // The runtime merely holding an idle session: 「运行时仍持有」, not 「工作进行中」.
  const held = { sessionId: "held", resident: true, activityKnown: true, activity: [] };
  assert.deepEqual(consentTag(held), { key: "dialog.resident", tone: null });

  // A quiet session needs no label at all.
  assert.equal(consentTag({ sessionId: "quiet", resident: false, activityKnown: true, activity: [] }), null);

  // An unknown work state says so, and does not claim that work is in progress.
  const unknown = { sessionId: "unknown", resident: false, activityKnown: false };
  assert.deepEqual(consentTag(unknown), { key: "dialog.activityUnknown", tone: "warning" });

  // A scheduled task aimed at a session the runtime still holds is described by
  // the scheduled delivery: that is the reason the user has to act.
  const both = {
    sessionId: "both",
    resident: true,
    activityKnown: true,
    activity: [{ kind: "schedule", items: [{ id: "s1" }] }]
  };
  assert.deepEqual(consentTag(both), { key: "dialog.scheduled", tone: "warning", params: { count: 1 } });
});

test("pure helpers: the selection summary counts each reason separately", async () => {
  const { exports } = await loadBundle();
  const { summarizeSelection } = exports.__test;
  const plans = [
    // Work under way.
    { sessionId: "busy", deletable: true, resident: true, activityKnown: true, activity: [{ kind: "turn" }] },
    // Held by the runtime, nothing running.
    { sessionId: "held", deletable: true, resident: true, activityKnown: true, activity: [] },
    // Two scheduled tasks aimed at it.
    {
      sessionId: "scheduled",
      deletable: true,
      resident: false,
      activityKnown: true,
      activity: [{ kind: "schedule", items: [{ id: "s1" }, { id: "s2" }] }]
    },
    // Work state could not be confirmed.
    { sessionId: "unknown", deletable: true, resident: false, activityKnown: false },
    // Quiet: no consent, no label.
    { sessionId: "quiet", deletable: true, resident: false, activityKnown: true, activity: [] }
  ];
  const summary = summarizeSelection(plans, ["busy", "held", "scheduled", "unknown", "quiet"]);
  assert.equal(summary.liveWorkCount, 1, "only the session with work under way counts as busy");
  assert.equal(summary.residentIdleCount, 1, "the held session is idle as far as work goes");
  assert.equal(summary.scheduledSessionCount, 1, "one session has scheduled tasks aimed at it");
  assert.equal(summary.scheduledDeliveryCount, 2, "two scheduled tasks in total");
  assert.equal(summary.unknownActivityCount, 1);
  // The consent itself still covers every one of them: the count that decides
  // the force-delete button is unchanged.
  assert.equal(summary.consentCount, 4);
});

test("the consent copy exists in both languages and names each reason", async () => {
  const { exports } = await loadBundle();
  const { zh, en } = exports.__test.dictionaries;
  for (const key of [
    "dialog.consentWork",
    "dialog.consentScheduled",
    "dialog.consentResident",
    "dialog.consentUnknown",
    "dialog.scheduled",
    "dialog.resident"
  ]) {
    assert.ok(typeof zh[key] === "string" && zh[key] !== "", `zh is missing ${key}`);
    assert.ok(typeof en[key] === "string" && en[key] !== "", `en is missing ${key}`);
  }
  // The resident reason must not tell the user their work will be stopped: for
  // these sessions nothing is running, they are only held open.
  assert.ok(!/停止这些工作/.test(zh["dialog.consentResident"]), "a held session has no work to stop");
  assert.ok(/运行时/.test(zh["dialog.consentResident"]), "the resident reason names the runtime");
  assert.ok(/定时任务/.test(zh["dialog.consentScheduled"]), "the scheduled reason names the scheduled tasks");
  // The old single-reason key is gone: it claimed every consented session was
  // busy.
  assert.equal(zh["dialog.consent"], undefined);
  assert.equal(en["dialog.consent"], undefined);
});

test("the row shows the reason that applies, not a blanket \"work in progress\"", async () => {
  // The label is what the user reads before deciding to force the delete, so the
  // rendered tree has to carry the real reason — a finished conversation that
  // the runtime merely holds must not say its work is still running.
  const { exports } = await loadBundle();
  const { DeletePickStep, storeInstance, dictionaries } = exports.__test;
  const t = (key, params) => {
    const template = dictionaries.zh[key] ?? key;
    return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ""));
  };
  const plans = [
    { sessionId: "busy", cwd: "/w", deletable: true, exists: true, resident: true, activityKnown: true, activity: [{ kind: "turn" }] },
    { sessionId: "held", cwd: "/w", deletable: true, exists: true, resident: true, activityKnown: true, activity: [] },
    {
      sessionId: "scheduled",
      cwd: "/w",
      deletable: true,
      exists: true,
      resident: false,
      activityKnown: true,
      activity: [{ kind: "schedule", items: [{ id: "s1" }] }]
    }
  ];
  storeInstance.actions.setDialog({
    mode: "batch",
    plans,
    selectedIds: [],
    titleById: { busy: "忙", held: "闲", scheduled: "定时" },
    collapsedGroups: []
  });

  /** Every element in the tree, depth first. */
  const walk = (node, out = []) => {
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (typeof node !== "object") return out;
    out.push(node);
    walk(node.children, out);
    return out;
  };

  const tree = walk(DeletePickStep({ dialog: storeInstance.getSnapshot().dialog, t }));
  const texts = [];
  for (const node of tree) {
    for (const child of node.children ?? []) {
      if (typeof child === "string") texts.push(child);
    }
  }
  assert.ok(texts.includes("仍有进行中的工作"), "the busy session says work is in progress");
  assert.ok(texts.includes("运行时仍持有"), "the merely held session says the runtime holds it");
  assert.ok(texts.includes("1 个定时任务会投递到此会话"), "the scheduled session names its scheduled task");
});

test("pure helpers: selection summary carries real sizes", async () => {
  const { exports } = await loadBundle();
  const { summarizeSelection, canAdvance } = exports.__test;
  const plans = [
    { sessionId: "a", deletable: true, bytes: 100, running: false },
    { sessionId: "b", deletable: true, bytes: 250, running: true, resident: true },
    { sessionId: "c", deletable: false, bytes: 10 }
  ];
  const summary = summarizeSelection(plans, ["a", "b"]);
  assert.equal(summary.count, 2);
  assert.equal(summary.bytes, 350);
  assert.equal(summary.runningCount, 1);
  assert.equal(summary.consentCount, 1);
  assert.equal(summary.blockedCount, 0);
  assert.equal(canAdvance({ plans, selectedIds: ["a"] }), true);
  // Every listed row can be advanced now: a row with no files is cleared from the
  // list, so the user's choice is never taken away before the host answers.
  assert.equal(canAdvance({ plans, selectedIds: ["c"] }), true, "a fileless row is still the user's call");
  assert.equal(canAdvance({ plans, selectedIds: [] }), false);
  assert.equal(canAdvance(null), false);
});

test("pure helpers: the delete payload carries every selected session", async () => {
  const { exports } = await loadBundle();
  const { buildDeletePayload } = exports.__test;
  const dialog = {
    plans: [
      { sessionId: "a", deletable: true, resident: false, activity: [] },
      { sessionId: "b", deletable: true, resident: true, activity: [] },
      { sessionId: "c", deletable: false, resident: false, activity: [] }
    ],
    selectedIds: ["a", "b", "c", "ghost"]
  };
  const payload = buildDeletePayload(dialog, [{ sessionId: "a", displayTitle: "Alpha" }]);
  assert.deepEqual(payload.sessionIds, ["a", "b", "c"]);
  assert.deepEqual(payload.titles, [
    { sessionId: "a", title: "Alpha" },
    { sessionId: "b", title: undefined },
    { sessionId: "c", title: undefined }
  ]);
  assert.equal(payload.stopActivity, true, "one resident row is enough to require consent");
  assert.ok(payload.waitForReleaseMs > 0);
  const quiet = buildDeletePayload({ plans: [dialog.plans[0]], selectedIds: ["a"] }, []);
  assert.equal(quiet.stopActivity, false);
});

test("pure helpers: response envelopes", async () => {
  const { exports } = await loadBundle();
  const { readEnvelope } = exports.__test;
  assert.deepEqual(readEnvelope(200, { ok: true, value: { a: 1 } }), { ok: true, value: { a: 1 } });
  assert.deepEqual(readEnvelope(500, { ok: false, code: "internal", message: "boom" }), {
    ok: false,
    code: "internal",
    message: "boom"
  });
  assert.equal(readEnvelope(502, null).ok, false);
  assert.match(readEnvelope(502, null).message, /502/);
});

test("pure helpers: batch candidates exclude blanks and subagent children", async () => {
  const { exports } = await loadBundle();
  const { batchCandidates } = exports.__test;
  const rows = batchCandidates({
    ids: ["a", "b", "c", "d", "e"],
    byId: {
      a: { id: "a", displayTitle: "Alpha", blank: false },
      b: { id: "b", displayTitle: "Blank", blank: true },
      // A subagent child: DSH marks it with `origin`, exactly as its own
      // `sessionVisible` rule reads.
      c: { id: "c", displayTitle: "Child", parentId: "a", origin: "subagent" },
      d: { id: "d", displayTitle: "Delta", running: true },
      // An ordinary fork: it carries a parent too, but it is a conversation the
      // user may mean to delete, so the picker must keep it.
      e: { id: "e", displayTitle: "Fork", parentId: "a" }
    }
  });
  assert.deepEqual(rows.map((row) => row.sessionId), ["a", "d", "e"]);
  assert.equal(rows[1].running, true);
  assert.deepEqual(batchCandidates(undefined), []);
});

test("pure helpers: the batch picker drops rows the user can no longer act on", async () => {
  const { exports } = await loadBundle();
  const { batchVisiblePlans, isGone } = exports.__test;
  const plans = [
    { sessionId: "keep", deletable: true, exists: true, archived: false, activity: [] },
    // Archived: the sidebar hides it under the default filter, so a bulk
    // selection must not sweep it in behind the user's back.
    { sessionId: "archived", deletable: true, exists: true, archived: true, activity: [] },
    // Already deleted: its files are in the recycle bin and only a residue row
    // is left. Offering it promised a deletion that already happened.
    { sessionId: "gone", deletable: false, exists: false, code: "not-found", archived: false, activity: [] },
    // Same story, told the other way round.
    { sessionId: "gone-by-code", deletable: false, code: "not-found", archived: false, activity: [] },
    // A row that is merely blocked still stays: it has files, and the host
    // explains why it cannot be moved.
    { sessionId: "blocked", deletable: false, exists: true, archived: false, code: "not-visible", activity: [] }
  ];
  assert.deepEqual(
    batchVisiblePlans(plans).map((plan) => plan.sessionId),
    ["keep", "blocked"],
    "only rows the user can still act on belong in a bulk-delete picker"
  );
  // The gone test is the one that regressed in the field: a deleted session
  // kept showing up in the batch list with a 「已删除」 tag next to a checkbox.
  assert.equal(isGone(plans[2]), true);
  assert.equal(isGone(plans[3]), true);
  assert.equal(isGone(plans[0]), false);
  assert.deepEqual(batchVisiblePlans(undefined), []);
  assert.deepEqual(batchVisiblePlans([]), []);
});

test("the delete flow publishes plans and deletes in one action", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, openDeleteDialog, confirmDelete, setContext } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), init: options });
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/plan")) {
      return respond({
        plans: [
          { sessionId: "a", deletable: true, bytes: 10, resident: false, activity: [] },
          { sessionId: "b", deletable: true, bytes: 20, resident: true, activity: [{ kind: "turn" }] }
        ],
        // The preflight answer carries the bin root and the batch cap, so the
        // dialog paints from one request instead of two.
        root: "/tmp/bin",
        maxBatch: 2,
        quickDelete: true
      });
    }
    if (String(url).endsWith("/status")) return respond({ root: "/tmp/bin" });
    if (String(url).endsWith("/delete")) {
      return respond({
        results: [
          { sessionId: "a", ok: true, trashId: "t-1" },
          { sessionId: "b", ok: false, code: "session-live", message: "still live" }
        ],
        deleted: 1,
        failed: 1
      });
    }
    return respond({});
  };
  try {
    const ctx = {
      get: (name) =>
        name === "sessions"
          ? {
              list: { getSnapshot: () => ({ ids: ["a", "b"], byId: { a: { id: "a", displayTitle: "Alpha", blank: false }, b: { id: "b", displayTitle: "Beta", blank: false } } }) },
              refreshList: async () => {}
            }
          : undefined
    };
    setContext(ctx);
    await openDeleteDialog({ mode: "batch" }, ctx);
    const dialog = storeInstance.getSnapshot().dialog;
    assert.equal(dialog.plans.length, 2);
    assert.equal(dialog.root, "/tmp/bin");
    assert.equal(dialog.titleById.a, "Alpha");

    // Nothing selected means the primary button cannot fire.
    assert.equal(exports.__test.canAdvance(dialog), false);
    // There is no second step: selecting is all it takes, then the one button
    // moves the selection into the bin.
    assert.equal(storeInstance.getSnapshot().dialog.step, undefined);
    storeInstance.actions.patchDialog({ selectedIds: ["a", "b"] });
    assert.equal(exports.__test.canAdvance(storeInstance.getSnapshot().dialog), true);

    await confirmDelete();
    assert.equal(storeInstance.getSnapshot().dialog, null, "the dialog closes after the attempt");
    const notice = storeInstance.getSnapshot().notice;
    assert.equal(notice.undo.trashIds.length, 1, "only the successful item offers undo");
    const deleteCall = calls.find((call) => call.url.endsWith("/delete"));
    const payload = JSON.parse(deleteCall.init.body);
    assert.deepEqual(payload.sessionIds, ["a", "b"]);
    assert.equal(payload.stopActivity, true, "the resident row forces the stop-then-delete path");
    assert.equal(payload.force, true, "consenting to the stop also consents to the delete not being refused");
    assert.ok(payload.waitForReleaseMs > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the batch dialog never lists a session that is already deleted or archived", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, openDeleteDialog, setContext } = exports.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/plan")) {
      // The host is the only side that can tell a residue row from a session
      // that was merely hidden, so the answer it gives is what the picker obeys.
      return respond({
        plans: (body.sessionIds ?? []).map((sessionId) => {
          if (sessionId === "gone") {
            return { sessionId, deletable: false, exists: false, code: "not-found", archived: false, activity: [] };
          }
          if (sessionId === "archived") {
            return { sessionId, deletable: true, exists: true, archived: true, activity: [] };
          }
          return { sessionId, deletable: true, exists: true, archived: false, activity: [] };
        }),
        root: "/tmp/bin",
        maxBatch: 100,
        quickDelete: false
      });
    }
    if (String(url).endsWith("/status")) return respond({ root: "/tmp/bin" });
    return respond({});
  };
  try {
    const ctx = {
      get: (name) =>
        name === "sessions"
          ? {
              list: {
                getSnapshot: () => ({
                  ids: ["keep", "gone", "archived"],
                  byId: {
                    keep: { id: "keep", displayTitle: "Keep", blank: false },
                    gone: { id: "gone", displayTitle: "Gone", blank: false },
                    archived: { id: "archived", displayTitle: "Archived", blank: false }
                  }
                })
              },
              refreshList: async () => {}
            }
          : undefined
    };
    setContext(ctx);
    await openDeleteDialog({ mode: "batch" }, ctx);
    const dialog = storeInstance.getSnapshot().dialog;
    assert.deepEqual(
      dialog.plans.map((plan) => plan.sessionId),
      ["keep"],
      "the batch list must not offer a deleted session or an archived one"
    );
    assert.deepEqual(
      dialog.sessionIds,
      ["keep"],
      "the dialog's id list must follow the rows it shows, or a stale id would travel into the delete payload"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the single-session dialog still shows a residue row it was asked about", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, openDeleteDialog, setContext } = exports.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/plan")) {
      return respond({
        plans: (body.sessionIds ?? []).map((sessionId) => ({
          sessionId,
          deletable: false,
          exists: false,
          code: "not-found",
          archived: false,
          activity: []
        })),
        root: "/tmp/bin",
        maxBatch: 100,
        quickDelete: false
      });
    }
    if (String(url).endsWith("/status")) return respond({ root: "/tmp/bin" });
    return respond({});
  };
  try {
    const ctx = {
      get: (name) =>
        name === "sessions"
          ? {
              list: {
                getSnapshot: () => ({
                  ids: ["gone"],
                  byId: { gone: { id: "gone", displayTitle: "Gone", blank: false } }
                })
              },
              refreshList: async () => {}
            }
          : undefined
    };
    setContext(ctx);
    await openDeleteDialog({ mode: "single", sessionId: "gone", displayTitle: "Gone" }, ctx);
    const dialog = storeInstance.getSnapshot().dialog;
    assert.equal(
      dialog.plans.length,
      1,
      "asking about one session by name keeps that row — the batch filter must not swallow it"
    );
    assert.equal(dialog.plans[0].sessionId, "gone");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("confirming the purge dialog sends the request with no extra acknowledgement step", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, confirmPurge } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body === undefined ? {} : JSON.parse(options.body) });
    return { status: 200, json: async () => ({ ok: true, value: { results: [], purged: 0, freedBytes: 0 } }) };
  };
  try {
    storeInstance.actions.setPurge({ trashIds: ["t-1"], count: 1, bytes: 5, pending: false, error: null });
    await confirmPurge();
    const purges = calls.filter((call) => call.url.endsWith("/purge"));
    assert.equal(purges.length, 1, "the request goes out as soon as the dialog is confirmed");
    assert.equal(purges[0].body.acknowledge, true, "pressing the button is carried as the consent");
    assert.equal(storeInstance.getSnapshot().purge, null);
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setPurge(null);
  }
});

test("a failed host call surfaces its message instead of throwing", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, openDeleteDialog, setContext } = exports.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 500, json: async () => ({ ok: false, code: "internal", message: "host is down" }) });
  try {
    setContext({ get: () => undefined });
    await openDeleteDialog({ mode: "single", sessionId: "a", displayTitle: "Alpha" }, { get: () => undefined });
    const dialog = storeInstance.getSnapshot().dialog;
    assert.equal(dialog.error, "host is down");
    assert.deepEqual(dialog.plans, []);
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setDialog(null);
  }
});

test("the bundle injects its stylesheet once, attributed to the package", async () => {
  const tags = [];
  const styleTags = [];
  const document = {
    querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
    createElement: () => {
      const tag = { dataset: {}, textContent: "" };
      tags.push(tag);
      return tag;
    },
    head: {
      appendChild: (tag) => {
        styleTags.push(tag);
      }
    }
  };
  const first = await loadBundle({ document });
  assert.equal(tags.length, 1, "exactly one style tag per materialization");
  const tag = tags[0];
  assert.equal(tag.dataset.plugin, "dsh-session-trash");
  assert.equal(typeof tag.dataset.pluginCss, "string");
  assert.match(tag.textContent, /\.dsh-trash-panel/);
  assert.match(tag.textContent, /--dsw-alias-label-primary/, "styles must follow the app's design tokens");
  assert.match(tag.textContent, /--dsw-radius-md/);
  assert.ok(first.exports.apply);

  // A second materialization sees the existing tag and does not double-inject.
  const before = styleTags.length;
  await loadBundle({ document });
  assert.equal(styleTags.length, before);
});

test("the bundle loads without a document (no DOM side effects at import)", async () => {
  const { exports } = await loadBundle();
  assert.equal(typeof exports.apply, "function");
});

test("confirmDelete hands the open session back before asking the host to move it", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, confirmDelete, setContext } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body === undefined ? undefined : JSON.parse(options.body) });
    if (String(url).endsWith("/delete")) {
      return { status: 200, json: async () => ({ ok: true, value: { results: [{ sessionId: "open", ok: true, trashId: "t-1" }], deleted: 1, failed: 0 } }) };
    }
    return { status: 200, json: async () => ({ ok: true, value: {} }) };
  };
  try {
    const opened = [];
    let cleared = 0;
    const ctx = {
      get: (name) => {
        if (name === "sessions") {
          return {
            list: {
              getSnapshot: () => ({
                ids: ["open", "survivor"],
                byId: {
                  open: { id: "open", displayTitle: "Open", blank: false },
                  survivor: { id: "survivor", displayTitle: "Survivor", blank: false }
                }
              })
            },
            refresh: async () => {}
          };
        }
        if (name === "uiWorkspace") {
          return {
            mainReference: { sessionId: "open" },
            openSession: (id) => opened.push(id),
            clearMain: () => {
              cleared += 1;
            }
          };
        }
        return undefined;
      }
    };
    setContext(ctx);

    // The open session is among the targets, and another session survives: the view
    // must move to the survivor so the host can dispose the target.
    storeInstance.actions.setDialog({
      mode: "single",
      sessionIds: ["open"],
      titleById: { open: "Open" },
      singleTitle: "Open",
      plans: [{ sessionId: "open", deletable: true, bytes: 1, resident: true, activity: [{ kind: "turn" }] }],
      selectedIds: ["open"],
      pending: false,
      error: null,
      root: "/tmp/bin"
    });
    await confirmDelete();
    assert.deepEqual(opened, ["survivor"], "the view navigates to a surviving session first");
    assert.equal(cleared, 0);
    const payload = calls.find((call) => call.url.endsWith("/delete")).body;
    assert.equal(payload.force, true, "the force consent travels with the stop consent");

    // Nothing survives: the main selection is dropped instead.
    opened.length = 0;
    storeInstance.actions.setDialog({
      mode: "single",
      sessionIds: ["open"],
      titleById: { open: "Open" },
      singleTitle: "Open",
      plans: [{ sessionId: "open", deletable: true, bytes: 1, resident: false, activity: [] }],
      selectedIds: ["open"],
      pending: false,
      error: null,
      root: "/tmp/bin"
    });
    const ctxOnly = {
      get: (name) => (name === "sessions" ? { list: { getSnapshot: () => ({ ids: ["open"], byId: { open: { id: "open", blank: false } } }) }, refresh: async () => {} } : name === "uiWorkspace" ? { mainReference: { sessionId: "open" }, clearMain: () => { cleared += 1; } } : undefined)
    };
    setContext(ctxOnly);
    await confirmDelete();
    assert.equal(cleared, 1, "with no survivor the main selection is released");
    assert.deepEqual(opened, []);
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setDialog(null);
    storeInstance.actions.setNotice(null);
  }
});

test("confirmDelete leaves an unrelated open session alone", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, confirmDelete, setContext } = exports.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, value: { results: [], deleted: 0, failed: 0 } }) });
  try {
    let touched = 0;
    setContext({
      get: (name) =>
        name === "sessions"
          ? { list: { getSnapshot: () => ({ ids: ["other"], byId: { other: { id: "other", blank: false } } }) }, refresh: async () => {} }
          : name === "uiWorkspace"
            ? { mainReference: { sessionId: "unrelated" }, openSession: () => { touched += 1; }, clearMain: () => { touched += 1; } }
            : undefined
    });
    storeInstance.actions.setDialog({
      mode: "single",
      sessionIds: ["other"],
      titleById: { other: "Other" },
      singleTitle: "Other",
      plans: [{ sessionId: "other", deletable: true, bytes: 1, resident: false, activity: [] }],
      selectedIds: ["other"],
      pending: false,
      error: null,
      root: "/tmp/bin"
    });
    await confirmDelete();
    assert.equal(touched, 0, "an unrelated open session must not be navigated away from");
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setDialog(null);
    storeInstance.actions.setNotice(null);
  }
});

test("the confirm button says 删除, not 移入回收站", async () => {
  // This was asked for twice, so the copy is pinned as a contract rather than left
  // to drift: the dialog confirms a *deletion*. Where the files land is explained in
  // the description and in the notice's actions, not in the button's name.
  const { exports } = await loadBundle();
  const { zh, en } = exports.__test.dictionaries;
  assert.equal(zh["dialog.action.delete"], "删除");
  assert.equal(en["dialog.action.delete"], "Delete");
  assert.equal(zh["dialog.action.stopAndDelete"], "强制删除", "the consent variant is the force delete");
  assert.equal(en["dialog.action.stopAndDelete"], "Force delete");
  assert.ok(!/移入回收站/.test(zh["dialog.action.delete"]), "the button must not name the recycle bin");
  // The destination is still stated where it belongs: ahead of the click, and in
  // the result's wording.
  assert.match(zh["dialog.desc.single"], /回收站/);
  assert.match(zh["dialog.desc.batch"], /回收站/);
  assert.match(zh["dialog.consentWork"], /强制删除/);
  // Each reason the consent covers gets its own sentence: a session the
  // runtime merely holds is not told that its work will be stopped.
  assert.match(zh["dialog.consentResident"], /运行时/);
  assert.match(zh["dialog.consentScheduled"], /定时任务/);
  assert.equal(zh["notice.trashed"], "会话已删除");
  assert.match(zh["notice.trashedMany"], /已删除/);
  // No locale may keep the old two-step wording.
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(!key.startsWith("dialog.step2"), `stale two-step key ${key}`);
    assert.ok(!/下一步/.test(String(value)), `stale two-step copy at ${key}`);
  }
});

test("the rendered dialog offers exactly one destructive action", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, dictionaries } = exports.__test;
  // Render the dialog's footer decision the same way the component does: a consent
  // row must swap the label and nothing else.
  const t = (key, params) => {
    const template = dictionaries.zh[key] ?? key;
    return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ""));
  };
  assert.equal(t("dialog.action.delete"), "删除");
  assert.match(t("dialog.consentWork", { count: 2 }), /强制删除/);
  assert.equal(t("notice.trashed"), "会话已删除");
  assert.equal(typeof storeInstance.getSnapshot, "function");
});

test("a listed session with no files reads as already deleted, not as a failure", async () => {
  // The live report: after deleting a session, its row stayed in the sidebar and the
  // dialog called it 不可删除 — which reads as "your delete failed" even though it
  // succeeded. Such a row is a leftover, so it must not be counted as a blocker.
  const { exports } = await loadBundle();
  const { isGone, summarizeSelection, dictionaries } = exports.__test;

  const gone = { sessionId: "gone", deletable: false, exists: false, code: "not-found" };
  const blocked = { sessionId: "blocked", deletable: false, exists: true };
  const ok = { sessionId: "ok", deletable: true, exists: true, bytes: 10 };

  assert.equal(isGone(gone), true);
  assert.equal(isGone({ sessionId: "x", code: "not-found" }), true, "the refusal code is enough");
  assert.equal(isGone(blocked), false);
  assert.equal(isGone(ok), false);

  const summary = summarizeSelection([gone, blocked, ok], ["gone", "blocked", "ok"]);
  assert.equal(summary.count, 3);
  assert.equal(summary.goneCount, 1);
  assert.equal(summary.blockedCount, 1, "only the genuinely blocked row counts");
  assert.equal(summary.bytes, 10, "an already-deleted row reports no size");

  // And the copy says so, in both languages. The note now promises the
  // stronger thing the release path actually delivers: the row leaves the list
  // and DSH's runtime, so it does not need a restart to disappear.
  assert.equal(dictionaries.zh["dialog.gone"], "已删除");
  assert.match(dictionaries.zh["dialog.goneNote"], /清除/);
  assert.match(dictionaries.zh["dialog.goneNote"], /运行时/);
  assert.equal(dictionaries.en["dialog.gone"], "Deleted");
  assert.match(dictionaries.en["dialog.goneNote"], /Clearing/i);
  assert.match(dictionaries.en["dialog.goneNote"], /runtime/i);
});

test("the forced-delete notice says the session was released; the residue notice says where the row went", async () => {
  const { exports } = await loadBundle();
  const { dictionaries } = exports.__test;
  // A forced delete now takes the session down: the notice says so instead of
  // promising a restart.
  assert.match(dictionaries.zh["notice.forced"], /运行时/);
  assert.match(dictionaries.zh["notice.forced"], /列表/);
  assert.match(dictionaries.en["notice.forced"], /runtime/i);
  // The residue notice is the one that still has to explain where a leftover row
  // went: archived out of sight now, gone after a restart.
  assert.match(dictionaries.zh["notice.residue"], /归档/);
  assert.match(dictionaries.zh["notice.residue"], /重启/);
  assert.match(dictionaries.en["notice.residue"], /restart/i);
});

test("the dialog says when the selection includes the session on screen", async () => {
  const { exports } = await loadBundle();
  const { dictionaries } = exports.__test;
  // Deleting the session the user is in the middle of ends that conversation:
  // the copy has to say so before the click, not after.
  assert.match(dictionaries.zh["dialog.current"], /当前/);
  assert.match(dictionaries.zh["dialog.current"], /回收站/);
  assert.match(dictionaries.en["dialog.current"], /conversation/i);
  assert.match(dictionaries.en["dialog.current"], /recycle bin/i);
  assert.equal(typeof dictionaries.zh["dialog.currentTag"], "string");
});

test("a row the runtime still holds is a residue, and it is named as one", async () => {
  // The 「已归档且删不掉」 case: the files are gone, but the runtime still holds
  // the session, so the sidebar keeps drawing the row. Calling that 已删除 hides
  // the fact that something still holds it, and the user is left with a grey row
  // and a button that does nothing.
  const { exports } = await loadBundle();
  const { isGone, isResidue, summarizeSelection, dictionaries } = exports.__test;

  const residue = { sessionId: "residue", deletable: false, clearable: true, exists: false, code: "not-found", resident: true };
  const gone = { sessionId: "gone", deletable: false, clearable: true, exists: false, code: "not-found", resident: false };

  assert.equal(isResidue(residue), true, "files gone + still held = a leftover");
  assert.equal(isResidue(gone), false, "files gone + not held = a clean clear");
  assert.equal(isGone(residue), true, "it is still a session without files");

  const summary = summarizeSelection([residue, gone], ["residue", "gone"]);
  assert.equal(summary.residueCount, 1, "only the one the runtime holds is a residue");
  assert.equal(summary.goneCount, 2, "both rows have no files left");

  // The copy has to name the way out, in both languages.
  assert.match(dictionaries.zh["dialog.residueNote"], /重启 DSH/);
  assert.match(dictionaries.zh["dialog.residueNote"], /隐藏已归档/);
  assert.match(dictionaries.en["dialog.residueNote"], /restart/i);
  assert.equal(dictionaries.zh["dialog.action.clearResidue"], "清除残留");
  assert.equal(dictionaries.en["dialog.action.clearResidue"], "Clear residue");
  assert.match(dictionaries.zh["notice.residue"], /重启 DSH/);
  assert.match(dictionaries.en["notice.residue"], /restart/i);
});

test("the client closes the session scopes it opened for the sessions it deletes", async () => {
  // Navigating the main view away is only half of the release: the session
  // controller keeps a scope per opened session, and that scope is one of the
  // things that keeps the host's runtime holding the session.
  const { exports } = await loadBundle();
  const { releaseClientScopes } = exports.__test;
  const retired = [];
  const dropped = [];
  const sessions = {
    scopes: new Map([["s1", { id: "s1" }]]),
    retireScope(id) {
      retired.push(id);
      this.scopes.delete(id);
    },
    manager: {
      sessions: new Map([["s2", { id: "s2" }]]),
      async drop(id) {
        dropped.push(id);
      }
    }
  };
  const ctx = {
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "uiWorkspace") return { mainReference: { sessionId: "s3" } };
      return undefined;
    }
  };
  const closed = await releaseClientScopes(["s1", "s2", "s3"], ctx);
  assert.equal(closed, 2, "the open one is closed by the navigation, not by the scope release");
  assert.deepEqual(retired, ["s1"]);
  assert.deepEqual(dropped, ["s2"]);
  // A host without the session controller must not break the delete.
  assert.equal(await releaseClientScopes(["s1"], { get: () => undefined }), 0);
});
test("pure helpers: ids are chunked by the host's batch size", async () => {
  const { exports } = await loadBundle();
  const { chunkIds } = exports.__test;
  assert.deepEqual(chunkIds([], 2), []);
  assert.deepEqual(chunkIds(["a"], 2), [["a"]]);
  assert.deepEqual(chunkIds(["a", "b", "c", "d", "e"], 2), [["a", "b"], ["c", "d"], ["e"]]);
  // A nonsensical cap must not produce a zero-length chunk and loop forever.
  assert.deepEqual(chunkIds(["a", "b"], 0), [["a"], ["b"]]);
  assert.deepEqual(chunkIds(undefined, 3), []);
});

test("pure helpers: only a session with nothing running is a quick delete", async () => {
  const { exports } = await loadBundle();
  const { isQuickDelete } = exports.__test;
  assert.equal(isQuickDelete({ deletable: true, resident: false, activity: [] }), true);
  // Anything that would stop work, or that cannot be located, keeps the dialog so
  // the consequence is on screen before anything moves.
  assert.equal(isQuickDelete({ deletable: true, resident: true, activity: [] }), false);
  assert.equal(isQuickDelete({ deletable: true, resident: false, activity: [{ kind: "turn" }] }), false);
  assert.equal(isQuickDelete({ deletable: false, resident: false, activity: [] }), false);
  assert.equal(isQuickDelete({ deletable: true, resident: false, activity: [], running: true }), false);
  assert.equal(isQuickDelete(null), false);
});

test("a single quiet session is deleted without the confirmation dialog", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, openDeleteDialog, setContext } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), init: options });
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/plan")) {
      return respond({
        plans: [{ sessionId: "a", deletable: true, resident: false, activity: [], running: false }],
        root: "/tmp/bin",
        maxBatch: 100
      });
    }
    if (String(url).endsWith("/delete")) {
      return respond({ results: [{ sessionId: "a", ok: true, trashId: "t-1" }], deleted: 1, failed: 0 });
    }
    return respond({});
  };
  try {
    const ctx = {
      get: (name) =>
        name === "sessions"
          ? {
              list: { getSnapshot: () => ({ ids: ["a"], byId: { a: { id: "a", displayTitle: "Alpha", blank: false } } }) },
              refreshList: async () => {}
            }
          : undefined
    };
    setContext(ctx);
    await openDeleteDialog({ mode: "single", sessionId: "a", displayTitle: "Alpha" }, ctx);
    assert.equal(storeInstance.getSnapshot().dialog, null, "no dialog is left behind");
    assert.equal(calls.filter((call) => call.url.endsWith("/delete")).length, 1, "one click, one delete");
    const payload = JSON.parse(calls.find((call) => call.url.endsWith("/delete")).init.body);
    assert.deepEqual(payload.sessionIds, ["a"]);
    const notice = storeInstance.getSnapshot().notice;
    assert.ok(notice !== null, "the outcome is still reported, with its undo");
    assert.deepEqual(notice.undo.trashIds, ["t-1"]);
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setNotice(null);
  }
});

test("the quick path can be turned off by the host's setting", async () => {
  // `quickDelete: false` is the pre-1.2 flow, kept reachable for anyone who wants
  // to read the dialog before every single delete.
  const { exports } = await loadBundle();
  const { storeInstance, openDeleteDialog, setContext } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), init: options });
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/plan")) {
      return respond({
        plans: [{ sessionId: "a", deletable: true, resident: false, activity: [], running: false }],
        root: "/tmp/bin",
        maxBatch: 100,
        quickDelete: false
      });
    }
    return respond({});
  };
  try {
    await openDeleteDialog({ mode: "single", sessionId: "a", displayTitle: "Alpha" }, setContext({}));
    const dialog = storeInstance.getSnapshot().dialog;
    assert.notEqual(dialog, null, "the dialog is shown when the host turns the quick path off");
    assert.equal(dialog.plans.length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith("/delete")).length, 0, "nothing is deleted without a click");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a single session that needs consent keeps the dialog", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, openDeleteDialog, setContext } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      json: async () => ({
        ok: true,
        value: { plans: [{ sessionId: "a", deletable: true, resident: true, activity: [{ kind: "turn" }], running: true }], root: "/tmp/bin", maxBatch: 100 }
      })
    };
  };
  try {
    const ctx = {
      get: (name) =>
        name === "sessions"
          ? {
              list: { getSnapshot: () => ({ ids: ["a"], byId: { a: { id: "a", displayTitle: "Alpha", blank: false } } }) },
              refreshList: async () => {}
            }
          : undefined
    };
    setContext(ctx);
    await openDeleteDialog({ mode: "single", sessionId: "a", displayTitle: "Alpha" }, ctx);
    const dialog = storeInstance.getSnapshot().dialog;
    assert.ok(dialog !== null, "the consequence of stopping work must be on screen");
    assert.equal(dialog.plans.length, 1);
    assert.equal(dialog.root, "/tmp/bin");
    assert.deepEqual(calls.filter((url) => url.endsWith("/delete")), [], "nothing is deleted before consent");
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setDialog(null);
  }
});

test("a selection longer than one batch is deleted in several requests", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, openDeleteDialog, confirmDelete, setContext } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  const ids = ["a", "b", "c"];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    calls.push({ url: String(url), body });
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/plan")) {
      return respond({
        plans: ids.map((id) => ({ sessionId: id, deletable: true, resident: false, activity: [] })),
        root: "/tmp/bin",
        maxBatch: 2
      });
    }
    if (String(url).endsWith("/delete")) {
      return respond({
        results: body.sessionIds.map((id) => ({ sessionId: id, ok: true, trashId: `t-${id}` })),
        deleted: body.sessionIds.length,
        failed: 0
      });
    }
    return respond({});
  };
  try {
    const ctx = {
      get: (name) =>
        name === "sessions"
          ? {
              list: {
                getSnapshot: () => ({
                  ids,
                  byId: Object.fromEntries(ids.map((id) => [id, { id, displayTitle: id.toUpperCase(), blank: false }]))
                })
              },
              refreshList: async () => {}
            }
          : undefined
    };
    setContext(ctx);
    await openDeleteDialog({ mode: "batch" }, ctx);
    storeInstance.actions.patchDialog({ selectedIds: ids });
    await confirmDelete();
    const deletes = calls.filter((call) => call.url.endsWith("/delete"));
    assert.equal(deletes.length, 2, "the cap is respected instead of the whole delete being refused");
    assert.deepEqual(deletes.map((call) => call.body.sessionIds), [["a", "b"], ["c"]]);
    const notice = storeInstance.getSnapshot().notice;
    assert.deepEqual(notice.undo.trashIds.sort(), ["t-a", "t-b", "t-c"]);
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setNotice(null);
  }
});

test("a restore selection longer than one batch is sent in several requests", async () => {
  // The defect: the restore sent the whole selection in one request, and the
  // host refuses a request carrying more ids than its batch cap — so a bin
  // holding more items than one request accepts could not be restored at all.
  const { exports } = await loadBundle();
  const { storeInstance, restoreSelected } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    calls.push({ url: String(url), body });
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/restore")) {
      return respond({
        results: body.trashIds.map((trashId) => ({ trashId, ok: true })),
        restored: body.trashIds.length,
        failed: 0
      });
    }
    return respond({});
  };
  try {
    // The host's cap, as the listing reported it.
    storeInstance.actions.patchBin({ maxBatch: 2 });
    await restoreSelected(["t-a", "t-b", "t-c"]);
    const restores = calls.filter((call) => call.url.endsWith("/restore"));
    assert.equal(restores.length, 2, "the cap is respected instead of the whole restore being refused");
    assert.deepEqual(
      restores.map((call) => call.body.trashIds),
      [["t-a", "t-b"], ["t-c"]]
    );
    assert.equal(storeInstance.getSnapshot().bin.error, null, "the selection was not refused");
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setNotice(null);
    storeInstance.actions.patchBin({ maxBatch: 100 });
  }
});

test("a purge selection longer than one batch is sent in several requests", async () => {
  // The same cap applies to the purge, and the `["*"]` sentinel must stay one
  // request: it names the bin's own contents, not a caller-chosen set.
  const { exports } = await loadBundle();
  const { storeInstance, confirmPurge } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    calls.push({ url: String(url), body });
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/purge")) {
      return respond({
        results: body.trashIds.map((trashId) => ({ trashId, ok: true, freedBytes: 1 })),
        purged: body.trashIds.length,
        freedBytes: body.trashIds.length
      });
    }
    return respond({});
  };
  try {
    storeInstance.actions.patchBin({ maxBatch: 2 });
    storeInstance.actions.setPurge({
      trashIds: ["t-a", "t-b", "t-c"],
      count: 3,
      bytes: 3,
      pending: false,
      error: null
    });
    await confirmPurge();
    const purges = calls.filter((call) => call.url.endsWith("/purge"));
    assert.equal(purges.length, 2, "the cap is respected instead of the whole purge being refused");
    assert.deepEqual(
      purges.map((call) => call.body.trashIds),
      [["t-a", "t-b"], ["t-c"]]
    );
    assert.ok(purges.every((call) => call.body.acknowledge === true), "every request carries the consent");

    calls.length = 0;
    storeInstance.actions.setPurge({
      trashIds: ["*"],
      count: 3,
      bytes: 3,
      pending: false,
      error: null
    });
    await confirmPurge();
    const sentinel = calls.filter((call) => call.url.endsWith("/purge"));
    assert.equal(sentinel.length, 1, "the sentinel is one request");
    assert.deepEqual(sentinel[0].body.trashIds, ["*"]);
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setPurge(null);
    storeInstance.actions.setNotice(null);
    storeInstance.actions.patchBin({ maxBatch: 100 });
  }
});

test("a restore drops the tombstone the delete left behind and reopens the session", async () => {
  // The defect: deleting the session on screen kept its client-side instance,
  // flagged `removed` and with a closed event stream. The restore announced the
  // session again but reused that instance, so every message went into a dead
  // stream and nothing came back — no error, no reply.
  const { exports } = await loadBundle();
  const { storeInstance, confirmDelete, restoreSelected, setContext } = exports.__test;
  const originalFetch = globalThis.fetch;
  const dropped = [];
  const reopened = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/delete")) {
      return respond({ results: [{ sessionId: "open", ok: true, trashId: "t-1" }], deleted: 1, failed: 0 });
    }
    if (String(url).endsWith("/restore")) {
      return respond({
        results: body.trashIds.map((trashId) => ({ trashId, ok: true, sessionId: "open", revived: true })),
        restored: body.trashIds.length,
        failed: 0
      });
    }
    return respond({});
  };
  try {
    // The delete leaves the instance of the session on screen behind as a
    // tombstone; that is what the restore has to clear.
    const tombstone = { removed: true };
    const ctx = {
      get: (name) => {
        if (name === "sessions") {
          return {
            list: {
              getSnapshot: () => ({
                ids: ["open", "survivor"],
                byId: {
                  open: { id: "open", displayTitle: "Open", blank: false },
                  survivor: { id: "survivor", displayTitle: "Survivor", blank: false }
                }
              })
            },
            manager: {
              sessions: new Map([["open", tombstone]]),
              drop: async (sessionId) => dropped.push(sessionId)
            },
            scopes: new Map(),
            refresh: async () => {}
          };
        }
        if (name === "uiWorkspace") {
          return {
            mainReference: { sessionId: "open" },
            openSession: (id) => reopened.push(id),
            clearMain: () => {}
          };
        }
        return undefined;
      }
    };
    setContext(ctx);
    storeInstance.actions.setDialog({
      mode: "single",
      sessionIds: ["open"],
      titleById: { open: "Open" },
      singleTitle: "Open",
      plans: [{ sessionId: "open", deletable: true, bytes: 1, resident: true, activity: [{ kind: "turn" }] }],
      selectedIds: ["open"],
      pending: false,
      error: null,
      root: "/tmp/bin"
    });
    await confirmDelete();
    reopened.length = 0;

    await restoreSelected(["t-1"]);
    assert.deepEqual(dropped, ["open"], "the tombstone instance is dropped instead of being reused");
    assert.deepEqual(reopened, ["open"], "the session that was on screen is opened again");
  } finally {
    globalThis.fetch = originalFetch;
    storeInstance.actions.setDialog(null);
    storeInstance.actions.setNotice(null);
  }
});

test("a restore that could not re-attach the session says so", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, restoreSelected, setTranslator } = exports.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body === undefined ? {} : JSON.parse(options.body);
    const respond = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
    if (String(url).endsWith("/restore")) {
      return respond({
        results: body.trashIds.map((trashId) => ({
          trashId,
          ok: true,
          sessionId: "open",
          revived: false,
          reviveCode: "resume-failed",
          reviveMessage: "no agent for you"
        })),
        restored: body.trashIds.length,
        failed: 0
      });
    }
    return respond({});
  };
  try {
    // The locale's own binding shape: the key plus the parameters it was given.
    setTranslator((key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`));
    await restoreSelected(["t-1"]);
    const notice = storeInstance.getSnapshot().notice;
    assert.equal(notice.tone, "warning");
    assert.match(notice.text, /notice\.restoreNotLive/);
    assert.match(notice.text, /no agent for you/, "the reason the session stayed dead is in the notice");
  } finally {
    setTranslator((key) => key);
    globalThis.fetch = originalFetch;
    storeInstance.actions.setNotice(null);
  }
});

test("pure helpers: the batch rows are partitioned by the workspace they belong to", async () => {
  const { exports } = await loadBundle();
  const { partitionPlans, workspaceKey, workspaceName } = exports.__test;
  const plans = [
    { sessionId: "a", cwd: "/Users/example/Desktop/work/project-alpha" },
    { sessionId: "b", cwd: "/Users/example/Desktop/work/project-beta" },
    { sessionId: "c", cwd: "/Users/example/Desktop/work/project-alpha" },
    // A trailing slash must not turn one directory into two partitions.
    { sessionId: "d", cwd: "/Users/example/Desktop/work/project-alpha/" },
    // No workspace at all: one shared partition, not one per row.
    { sessionId: "e" }
  ];
  const groups = partitionPlans(plans);
  assert.deepEqual(
    groups.map((group) => group.path),
    ["/Users/example/Desktop/work/project-alpha", "/Users/example/Desktop/work/project-beta", null],
    "the partitions are the workspaces, and the rows without one share a partition"
  );
  assert.deepEqual(
    groups.map((group) => group.rows.map((row) => row.sessionId)),
    [["a", "c", "d"], ["b"], ["e"]],
    "the rows keep the order they arrived in"
  );
  assert.equal(workspaceKey("/a/b/"), "/a/b");
  assert.equal(workspaceKey("   "), "");
  assert.equal(workspaceName("/a/b/project-alpha"), "project-alpha");
  assert.equal(workspaceName(""), null);
  assert.deepEqual(partitionPlans(undefined), []);
});

test("pure helpers: a partition remembers whether it is folded away", async () => {
  const { exports } = await loadBundle();
  const { toggleCollapsed } = exports.__test;
  assert.deepEqual(toggleCollapsed([], "/a"), ["/a"]);
  assert.deepEqual(toggleCollapsed(["/a", "/b"], "/a"), ["/b"], "only that partition is unfolded again");
  assert.deepEqual(toggleCollapsed(undefined, "/a"), ["/a"]);
});

test("pure helpers: a partition reports how much of it is selected", async () => {
  const { exports } = await loadBundle();
  const { groupSelection } = exports.__test;
  const rows = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];
  assert.deepEqual(groupSelection(rows, []), { total: 3, picked: 0, all: false, none: true });
  assert.deepEqual(groupSelection(rows, ["a"]), { total: 3, picked: 1, all: false, none: false });
  assert.deepEqual(groupSelection(rows, ["a", "b", "c"]), { total: 3, picked: 3, all: true, none: false });
  // An empty partition is never "all selected": it has nothing to select.
  assert.deepEqual(groupSelection([], []), { total: 0, picked: 0, all: false, none: true });
});

test("the partition copy exists in both languages", async () => {
  const { exports } = await loadBundle();
  const { zh, en } = exports.__test.dictionaries;
  for (const key of [
    "dialog.groupCount",
    "dialog.groupSelected",
    "dialog.expandAll",
    "dialog.collapseAll",
    "dialog.groupExpand",
    "dialog.groupCollapse"
  ]) {
    assert.ok(typeof zh[key] === "string" && zh[key] !== "", `zh is missing ${key}`);
    assert.ok(typeof en[key] === "string" && en[key] !== "", `en is missing ${key}`);
  }
});

test("the batch picker renders as collapsible partitions", async () => {
  // The picker is rendered through the stub React (the platform's React is not
  // installed here), so this asserts the *shape* of the tree the component
  // builds: the partitions, their fold buttons, and the fact that folding one
  // really takes its rows out of the tree.
  const { exports } = await loadBundle();
  const { DeletePickStep, storeInstance, dictionaries } = exports.__test;
  const t = (key, params) => {
    const template = dictionaries.zh[key] ?? key;
    return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ""));
  };
  const plans = [
    { sessionId: "a", cwd: "/w/one", deletable: true, exists: true, activity: [] },
    { sessionId: "b", cwd: "/w/one", deletable: true, exists: true, activity: [] },
    { sessionId: "c", cwd: "/w/two", deletable: true, exists: true, activity: [] }
  ];
  storeInstance.actions.setDialog({
    mode: "batch",
    plans,
    selectedIds: [],
    titleById: { a: "A", b: "B", c: "C" },
    collapsedGroups: []
  });

  /** Every element in the tree, depth first. */
  const walk = (node, out = []) => {
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (typeof node !== "object") return out;
    out.push(node);
    walk(node.children, out);
    return out;
  };

  const tree = walk(DeletePickStep({ dialog: storeInstance.getSnapshot().dialog, t }));
  const groups = tree.filter((node) => node.props?.className === "dsh-trash-group");
  assert.equal(groups.length, 2, "one partition per workspace");
  const toggles = tree.filter((node) => node.props?.className === "dsh-trash-groupToggle");
  assert.equal(toggles.length, 2, "every partition can be folded away");
  assert.equal(toggles[0].props["aria-expanded"], true, "a partition starts open");
  const headers = tree.filter((node) => node.props?.className === "dsh-trash-groupHead");
  assert.equal(headers.length, 2);

  // Folding the first partition removes its rows from the tree.
  toggles[0].props.onClick();
  const after = walk(DeletePickStep({ dialog: storeInstance.getSnapshot().dialog, t }));
  const folded = after.filter((node) => node.props?.className === "dsh-trash-group");
  assert.equal(folded.length, 2, "the partition is still listed, only its rows are gone");
  const foldedToggles = after.filter((node) => node.props?.className === "dsh-trash-groupToggle");
  assert.equal(foldedToggles[0].props["aria-expanded"], false, "the folded partition says so");
  const rowLists = after.filter((node) => node.props?.className === "dsh-trash-list");
  assert.equal(rowLists.length, 1, "only the open partition still draws its rows");

  // Unfolding it brings the rows back.
  foldedToggles[0].props.onClick();
  const reopened = walk(DeletePickStep({ dialog: storeInstance.getSnapshot().dialog, t }));
  assert.equal(
    reopened.filter((node) => node.props?.className === "dsh-trash-list").length,
    2,
    "the rows come back when the partition is unfolded again"
  );
  storeInstance.actions.setDialog(null);
});
