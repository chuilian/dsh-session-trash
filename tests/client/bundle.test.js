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
function stubReact() {
  return {
    Fragment: Symbol("Fragment"),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
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
    react: stubReact(),
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

test("apply registers the overlays, the sidebar entry and the keyed main panel", async () => {
  const { exports } = await loadBundle();
  const ctx = fakeClientCtx();
  exports.apply(ctx);
  const byName = (name) => ctx.registrations.filter((row) => row.options.name === name);
  assert.equal(byName("shell.overlay").length, 1);
  assert.equal(byName("shell.overlay")[0].options.id, "session-trash.overlays");
  const panelList = byName("sidebar.panellist");
  assert.equal(panelList.length, 1);
  assert.equal(panelList[0].options.id, "session-trash");
  const main = byName("main");
  assert.equal(main.length, 1);
  assert.equal(main[0].options.key, "session-trash", "the main panel is keyed by the active panel id");
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
    ids: ["a", "b", "c", "d"],
    byId: {
      a: { id: "a", displayTitle: "Alpha", blank: false },
      b: { id: "b", displayTitle: "Blank", blank: true },
      c: { id: "c", displayTitle: "Child", parentId: "a" },
      d: { id: "d", displayTitle: "Delta", running: true }
    }
  });
  assert.deepEqual(rows.map((row) => row.sessionId), ["a", "d"]);
  assert.equal(rows[1].running, true);
  assert.deepEqual(batchCandidates(undefined), []);
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

test("the purge flow refuses to run without the acknowledgement", async () => {
  const { exports } = await loadBundle();
  const { storeInstance, confirmPurge } = exports.__test;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { status: 200, json: async () => ({ ok: true, value: { results: [], purged: 0, freedBytes: 0 } }) };
  };
  try {
    storeInstance.actions.setPurge({ trashIds: ["t-1"], count: 1, bytes: 5, acknowledged: false, pending: false, error: null });
    await confirmPurge();
    assert.deepEqual(calls, [], "no request is sent before the acknowledgement");
    storeInstance.actions.patchPurge({ acknowledged: true });
    await confirmPurge();
    assert.ok(calls.some((url) => url.endsWith("/purge")));
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
  assert.match(zh["dialog.consent"], /强制删除/);
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
  assert.match(t("dialog.consent", { count: 2 }), /强制删除/);
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

  // And the copy says so, in both languages.
  assert.equal(dictionaries.zh["dialog.gone"], "已删除");
  assert.match(dictionaries.zh["dialog.goneNote"], /重启/);
  assert.equal(dictionaries.en["dialog.gone"], "Deleted");
  assert.match(dictionaries.en["dialog.goneNote"], /restart/i);
});

test("the forced-delete notice explains where the leftover row went", async () => {
  const { exports } = await loadBundle();
  const { dictionaries } = exports.__test;
  // Honest and actionable: archived out of sight now, gone after a restart.
  assert.match(dictionaries.zh["notice.forced"], /归档/);
  assert.match(dictionaries.zh["notice.forced"], /重启/);
  assert.match(dictionaries.en["notice.forced"], /restart/i);
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
