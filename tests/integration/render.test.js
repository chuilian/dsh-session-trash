/**
 * Render check against real React.
 *
 * The stub-React tests in `tests/client/` verify the module contract and the pure
 * decision logic, but a stub cannot catch what actually breaks a component at
 * runtime: a conditionally called hook, a hook called in a loop, an invalid
 * element child, or a prop shape React rejects. This layer renders every
 * registered component with real `react` + `react-dom/server` and fails on any
 * throw.
 *
 * React is not a dependency of this package (DSH provides it at runtime), so the
 * whole file skips when React cannot be resolved. To run it:
 *
 * ```sh
 * mkdir -p /tmp/react-check && cd /tmp/react-check
 * npm install react@18.3.1 react-dom@18.3.1
 * NODE_PATH=/tmp/react-check/node_modules \
 *   node --test "/path/to/dsh-session-trash/tests/integration/render.test.js"
 * ```
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "..", "..", "lib", "client.js");
const require_ = createRequire(import.meta.url);

/** Resolve React from the ambient install, or report why we cannot. */
function resolveReact() {
  const candidates = [];
  for (const specifier of ["react", "react-dom/server"]) {
    try {
      candidates.push(require_.resolve(specifier));
    } catch (error) {
      return { ok: false, reason: `cannot resolve ${specifier}: ${String(error.message)}` };
    }
  }
  try {
    return { ok: true, react: require_("react"), server: require_("react-dom/server") };
  } catch (error) {
    return { ok: false, reason: `cannot load React: ${String(error.message)}` };
  }
}

/**
 * Primitives stand-in that renders the props it is given into the tree, so an
 * invalid prop shape still surfaces in the server-rendered markup.
 *
 * Each stub renders a real element so React's own child/hook validation applies.
 */
function stubPrimitives(React) {
  const h = React.createElement;
  const passthrough = (name) => (props) => {
    const { children, ...rest } = props ?? {};
    return h("div", { "data-stub": name, "data-props": Object.keys(rest).sort().join(",") }, children ?? null);
  };
  return {
    MenuItemButton: (props) => h("button", { type: "button", role: "menuitem", "data-danger": String(props.danger) }, props.icon ?? null, props.children ?? null),
    Modal: (props) => (props.open === true ? h("div", { "data-modal": props.title }, h("p", null, props.description ?? null), props.children ?? null, props.footer ?? null) : null),
    Button: passthrough("Button"),
    Checkbox: (props) => h("input", { type: "checkbox", checked: props.checked === true, disabled: props.disabled === true, "aria-label": props.label ?? "", readOnly: true }),
    Tooltip: (props) => h("div", { "data-tooltip": props.label }, props.children ?? null),
    Toast: (props) => h("div", { "data-toast": props.text }, (props.actions ?? []).map((action) => h("button", { key: action.label, type: "button" }, action.label))),
    Tag: (props) => h("span", { "data-tone": props.tone ?? "outline" }, props.children ?? null),
    IconTrashOutlineRegular: (props) => h("svg", { "data-icon": "trash", width: props.size ?? 16 }),
    IconUnarchiveOutlineRegular: (props) => h("svg", { "data-icon": "unarchive" }),
    IconRefreshOutlineRegular: (props) => h("svg", { "data-icon": "refresh" }),
    IconWarningOutlineRegular: (props) => h("svg", { "data-icon": "warning" }),
    IconLoadingOutlineRegular: (props) => h("svg", { "data-icon": "loading" }),
    IconCheckOutlineRegular: (props) => h("svg", { "data-icon": "check", width: props.size ?? 16 })
  };
}

/** A faithful `defineStore` over React state semantics. */
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

/** Load the bundle with real React. */
async function loadWithReact(React, primitives = stubPrimitives(React)) {
  const source = await fs.readFile(BUNDLE, "utf8");
  let registration = null;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } };
  try {
    vm.runInThisContext(source, { filename: BUNDLE });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  const modules = {
    react: React,
    "@deepseek-ai/dsh-client-ui-primitives": primitives,
    "@deepseek-ai/dsh-client-store": stubClientStore()
  };
  return registration.factory((specifier) => {
    if (!(specifier in modules)) throw new Error(`unexpected require("${specifier}")`);
    return modules[specifier];
  });
}

/** Capture what a fake context registered, with a working `t`. */
function collectRegistrations(exports) {
  const registrations = [];
  const translations = new Map();
  const t = (key, params) => {
    translations.set(key, params);
    return params === undefined ? key : `${key}(${JSON.stringify(params)})`;
  };
  const scope = {
    slots: {
      inject: (_name, callback) => {
        const returned = callback();
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
  const services = {
    slots: scope.slots,
    locale: { register: () => () => {}, bind: () => t, subscribe: () => () => {} },
    layout: { selectPanel: () => {} },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) }, refreshList: async () => {} }
  };
  // Mirror Cordis's gate: an entry with `inject = []` cannot read `ctx.<service>`,
  // and an injected scope may only read the services it declared.
  const injectedScope = (deps) => {
    const target = { effect: scope.effect, get: (name) => services[name], inject: () => () => {} };
    for (const dep of deps) target[dep] = services[dep];
    return new Proxy(target, {
      get(object, property) {
        if (typeof property === "symbol" || property in object) return object[property];
        throw new Error(`cannot get property "${String(property)}" without inject`);
      }
    });
  };
  const target = {
    get: (name) => services[name],
    effect: scope.effect,
    inject: (deps, callback) => {
      if (deps.every((dep) => services[dep] !== undefined)) callback(injectedScope(deps));
      return () => {};
    }
  };
  exports.apply(
    new Proxy(target, {
      get(object, property) {
        if (typeof property === "symbol" || property in object) return object[property];
        throw new Error(`cannot get property "${String(property)}" without inject`);
      }
    })
  );
  return { registrations, translations };
}

const probe = resolveReact();

test("render check: real React is available or the layer is skipped", (t) => {
  if (!probe.ok) {
    t.skip(`optional layer skipped — ${probe.reason}`);
    return;
  }
  assert.equal(typeof probe.react.createElement, "function");
});

test("every registered component renders under real React", async (t) => {
  if (!probe.ok) {
    t.skip(`optional layer skipped — ${probe.reason}`);
    return;
  }
  const { react, server } = probe;
  const exports = await loadWithReact(react);
  const { registrations } = collectRegistrations(exports);
  assert.ok(registrations.length >= 5, "all five surfaces should have registered");

  const rendered = [];
  const seat = registrations.find((row) => row.options.store !== undefined)?.options.store;
  // Seed representative state so the panel and the overlays render real content.
  const dialogStore = seat.create();

  for (const { options, component } of registrations) {
    const props = {
      sessionId: "session-11111111-2222-3333-4444-555555555555",
      displayTitle: "示例会话",
      t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
      useMenuOpenState: () => [true, () => {}],
      useStore: (selector) => (typeof selector === "function" ? selector(dialogStore.getSnapshot()) : dialogStore.getSnapshot()),
      actions: dialogStore.actions
    };
    // The overlay host and the panel render differently depending on state, so
    // exercise each of them in the states that reach their subcomponents.
    const cases = [];
    if (options.name === "shell.overlay") {
      cases.push({ label: "idle" });
      cases.push({
        label: "step 1 (batch)",
        state: {
          dialog: {
            mode: "batch",
            sessionIds: ["a", "b"],
            titleById: { a: "Alpha", b: "Beta" },
            plans: [
              { sessionId: "a", deletable: true, bytes: 10, resident: false, activity: [], running: false },
              { sessionId: "b", deletable: true, bytes: 20, resident: true, running: true, activity: [{ kind: "turn" }, { kind: "job", items: [{ id: "j", label: "build" }] }] },
              { sessionId: "c", deletable: false, bytes: 0, activity: [] }
            ],
            selectedIds: ["a", "b"],
            step: 1,
            pending: false,
            error: null,
            root: "/tmp/bin"
          },
          bin: { status: "idle", items: [], broken: [], stats: null, error: null, selected: [], log: [] },
          purge: null,
          notice: null
        }
      });
      cases.push({
        label: "step 2 with consent + pending",
        state: {
          dialog: {
            mode: "batch",
            sessionIds: ["a", "b"],
            titleById: { a: "Alpha", b: "Beta" },
            plans: [
              { sessionId: "a", deletable: true, bytes: 10, resident: false, activity: [] },
              { sessionId: "b", deletable: true, bytes: 20, resident: true, activity: [{ kind: "turn" }] }
            ],
            selectedIds: ["a", "b"],
            step: 2,
            pending: true,
            error: "示例错误",
            root: "/tmp/bin"
          },
          bin: { status: "idle", items: [], broken: [], stats: null, error: null, selected: [], log: [] },
          purge: null,
          notice: null
        }
      });
      cases.push({
        label: "single session, blocked",
        state: {
          dialog: {
            mode: "single",
            sessionIds: ["x"],
            titleById: { x: "X" },
            singleTitle: "X",
            plans: [],
            selectedIds: ["x"],
            step: 1,
            pending: false,
            error: null,
            root: null
          },
          bin: { status: "idle", items: [], broken: [], stats: null, error: null, selected: [], log: [] },
          purge: null,
          notice: null
        }
      });
      cases.push({
        label: "purge dialog",
        state: {
          dialog: null,
          bin: { status: "idle", items: [], broken: [], stats: null, error: null, selected: [], log: [] },
          purge: { trashIds: ["t-20260101T000000Z-deadbeef"], count: 2, bytes: 4096, acknowledged: true, pending: false, error: null },
          notice: null
        }
      });
      cases.push({
        label: "notice with undo",
        state: {
          dialog: null,
          bin: { status: "idle", items: [], broken: [], stats: null, error: null, selected: [], log: [] },
          purge: null,
          notice: { text: "会话已移入回收站", tone: "success", undo: { trashIds: ["t-1"] } }
        }
      });
    }
    if (options.name === "main") {
      cases.push({
        label: "loading",
        state: { dialog: null, bin: { status: "loading", items: [], broken: [], stats: null, error: null, selected: [], log: [] }, purge: null, notice: null }
      });
      cases.push({
        label: "empty",
        state: { dialog: null, bin: { status: "ready", items: [], broken: [], stats: { count: 0, bytes: 0, retentionDays: 30, brokenCount: 0 }, error: null, selected: [], log: [] }, purge: null, notice: null }
      });
      cases.push({
        label: "populated with broken + error + expired",
        state: {
          dialog: null,
          bin: {
            status: "ready",
            items: [
              { trashId: "t-20260101T000000Z-deadbeef", sessionId: "a", title: "Alpha", cwd: "/tmp/p", deletedAt: Date.now() - 3600_000, totalBytes: 2048, fileCount: 2, expired: true },
              { trashId: "t-20260102T000000Z-deadbeef", sessionId: "b", title: null, cwd: null, deletedAt: Date.now(), totalBytes: 0, fileCount: 0, expired: false }
            ],
            broken: [{ trashId: "t-20260103T000000Z-deadbeef", state: "failed", error: "payload missing" }],
            stats: { count: 2, bytes: 2048, retentionDays: 30, brokenCount: 1 },
            error: "示例读取错误",
            selected: ["t-20260101T000000Z-deadbeef"],
            log: [{ ts: 1, tsIso: "2026-01-01T00:00:00.000Z", op: "trash", outcome: "ok", sessionId: "a" }]
          },
          purge: null,
          notice: null
        }
      });
    }
    if (cases.length === 0) cases.push({ label: "default" });

    for (const testCase of cases) {
      if (testCase.state !== undefined) {
        dialogStore.actions.setDialog(testCase.state.dialog);
        dialogStore.actions.setBin(testCase.state.bin);
        dialogStore.actions.setPurge(testCase.state.purge);
        dialogStore.actions.setNotice(testCase.state.notice);
      }
      let markup;
      try {
        markup = server.renderToStaticMarkup(react.createElement(component, props));
      } catch (error) {
        assert.fail(`${options.id ?? options.key} [${testCase.label}] threw: ${String(error?.stack ?? error)}`);
      }
      assert.equal(typeof markup, "string");
      assert.ok(markup.length > 0 || options.name === "shell.overlay", `${options.id} [${testCase.label}] rendered nothing`);
      rendered.push({ id: options.id ?? options.key, label: testCase.label, markup });
    }
  }
});

test("the rendered markup carries the real content, not an empty shell", async (t) => {
  if (!probe.ok) {
    t.skip(`optional layer skipped — ${probe.reason}`);
    return;
  }
  const { react, server } = probe;
  const exports = await loadWithReact(react);
  const { registrations } = collectRegistrations(exports);
  const seat = registrations.find((row) => row.options.store !== undefined)?.options.store;
  const store = seat.create();
  const t_ = (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`);

  const byId = (id) => registrations.find((row) => row.options.id === id || row.options.key === id);
  // The sidebar entry and the main panel deliberately share the id "session-trash"
  // (the panel id *is* the main key), so select the page by its slot name.
  const panel = registrations.find((row) => row.options.name === "main");

  // The menu row is a destructive menu item carrying the delete label.
  const menu = byId("session-trash.delete");
  const menuMarkup = server.renderToStaticMarkup(
    react.createElement(menu.component, {
      sessionId: "s1",
      displayTitle: "示例",
      t: t_,
      useMenuOpenState: () => [true, () => {}]
    })
  );
  assert.match(menuMarkup, /menu\.delete/);
  assert.match(menuMarkup, /data-danger="true"/, "the delete row must carry the destructive styling");

  // The populated panel shows titles, sizes, the expiry mark, the broken count and the log.
  store.actions.setBin({
    status: "ready",
    items: [
      { trashId: "t-20260101T000000Z-deadbeef", sessionId: "a", title: "Alpha", cwd: "/tmp/p", deletedAt: Date.now() - 3_600_000, totalBytes: 2048, fileCount: 2, expired: true },
      { trashId: "t-20260102T000000Z-deadbeef", sessionId: "b", title: null, cwd: null, deletedAt: Date.now(), totalBytes: 0, fileCount: 0, expired: false }
    ],
    broken: [{ trashId: "t-20260103T000000Z-deadbeef", state: "failed", error: "payload missing" }],
    stats: { count: 2, bytes: 2048, retentionDays: 30, brokenCount: 1 },
    error: null,
    selected: [],
    log: [{ ts: 1, tsIso: "2026-01-01T00:00:00.000Z", op: "trash", outcome: "ok", sessionId: "a" }]
  });
  const panelMarkup = server.renderToStaticMarkup(
    react.createElement(panel.component, {
      t: t_,
      useStore: (selector) => selector(store.getSnapshot())
    })
  );
  assert.match(panelMarkup, /Alpha/, "the item title must appear");
  assert.match(panelMarkup, /2 KB/, "the size must be formatted");
  assert.match(panelMarkup, /panel\.expired/, "expired items must be marked");
  assert.match(panelMarkup, /panel\.broken/, "broken items must be reported");
  assert.match(panelMarkup, /1 小时前|panel\.deletedAt/, "the deletion age must appear");
  assert.match(panelMarkup, /trash/, "the audit log must be listed");

  // The empty state offers guidance rather than a blank pane.
  store.actions.setBin({ status: "ready", items: [], broken: [], stats: { count: 0, bytes: 0, retentionDays: 30, brokenCount: 0 }, error: null, selected: [], log: [] });
  const emptyMarkup = server.renderToStaticMarkup(
    react.createElement(panel.component, { t: t_, useStore: (selector) => selector(store.getSnapshot()) })
  );
  assert.match(emptyMarkup, /panel\.empty/);
  assert.match(emptyMarkup, /panel\.emptyHint/);

  // A bin that holds only damaged items is not empty: the damaged entry has to be
  // listed, selectable and purgeable, and the bulk bar has to stay reachable.
  store.actions.setBin({
    status: "ready",
    items: [],
    broken: [{ trashId: "t-20260104T000000Z-deadbeef", state: "orphan", error: "item directory has no manifest" }],
    stats: { count: 0, bytes: 0, retentionDays: 30, brokenCount: 1 },
    error: null,
    selected: [],
    log: []
  });
  const brokenMarkup = server.renderToStaticMarkup(
    react.createElement(panel.component, { t: t_, useStore: (selector) => selector(store.getSnapshot()) })
  );
  assert.doesNotMatch(brokenMarkup, /panel\.empty/, "a bin with damaged items is not empty");
  assert.match(brokenMarkup, /panel\.brokenItem/, "the damaged item must be listed as a row of its own");
  assert.match(brokenMarkup, /orphan/, "the damaged state must be shown");
  assert.match(brokenMarkup, /type="checkbox"/, "a damaged item must be selectable");
  assert.match(brokenMarkup, /panel\.purgeAll/, "the bulk bar must stay reachable");

  // A failed bin read is surfaced, not swallowed.
  store.actions.setBin({ status: "error", items: [], broken: [], stats: null, error: "boom", selected: [], log: [] });
  const errorMarkup = server.renderToStaticMarkup(
    react.createElement(panel.component, { t: t_, useStore: (selector) => selector(store.getSnapshot()) })
  );
  assert.match(errorMarkup, /panel\.error/);
  assert.match(errorMarkup, /role="alert"/);

  // The picker must not pre-decide deletion for the user (FR-2.9): a row whose
  // session has no files on disk still gets a working checkbox, and the only
  // thing that may grey out is the footer button when nothing is selected.
  const overlay = registrations.find((row) => row.options.name === "shell.overlay");
  assert.ok(overlay, "the overlay host must be registered");
  store.actions.setDialog({
    mode: "batch",
    sessionIds: ["a", "c", "g"],
    titleById: { a: "Alpha", c: "Residue", g: "Gone" },
    plans: [
      { sessionId: "a", deletable: true, exists: true, bytes: 10, resident: false, activity: [], running: false },
      { sessionId: "c", deletable: false, exists: false, bytes: 0, code: "not-found", resident: true, archived: true, activity: [] },
      { sessionId: "g", deletable: false, exists: false, bytes: 0, code: "not-found", resident: false, activity: [] }
    ],
    selectedIds: [],
    pending: false,
    error: null,
    root: "/tmp/bin"
  });
  const pickMarkup = server.renderToStaticMarkup(
    react.createElement(overlay.component, { t: t_, useStore: (selector) => selector(store.getSnapshot()) })
  );
  assert.equal((pickMarkup.match(/type="checkbox"/g) ?? []).length, 3, "every candidate row must offer a checkbox");
  assert.doesNotMatch(pickMarkup, /<input[^>]*disabled/, "no candidate checkbox may be disabled — the user decides");
  assert.match(pickMarkup, /Residue/, "the fileless residue row must still be listed");
  assert.match(
    pickMarkup,
    /dialog\.residue/,
    "a fileless row the runtime still holds is a residue — calling it 已删除 would hide what holds it"
  );
  assert.match(
    pickMarkup,
    /dialog\.gone/,
    "a fileless row the runtime does not hold is simply gone, and must still say why it has nothing behind it"
  );

  // An unknown activity state is not "work in progress": the host could not find
  // out, and the row has to say exactly that.
  store.actions.setDialog({
    mode: "batch",
    sessionIds: ["u"],
    titleById: { u: "Unknown" },
    plans: [{ sessionId: "u", deletable: true, exists: true, bytes: 10, resident: false, activity: [], activityKnown: false }],
    selectedIds: ["u"],
    pending: false,
    error: null,
    root: "/tmp/bin"
  });
  const unknownMarkup = server.renderToStaticMarkup(
    react.createElement(overlay.component, { t: t_, useStore: (selector) => selector(store.getSnapshot()) })
  );
  assert.match(unknownMarkup, /dialog\.activityUnknown/, "an unknown activity state needs its own label");
  assert.doesNotMatch(unknownMarkup, /dialog\.activity(?!Unknown)/, "an unknown state must not be shown as work in progress");
});

test("the picker's controls reach the store and the host", async (t) => {
  if (!probe.ok) {
    t.skip(`optional layer skipped — ${probe.reason}`);
    return;
  }
  const { react, server } = probe;
  // Server rendering cannot click, so capture the props the picker hands its
  // controls and drive them exactly as a click would. This is the only layer
  // that can catch a handler wired to a name which does not exist: the markup of
  // a row looks identical whether ticking it works or throws on the first click,
  // and that exception is why the selection stayed empty in the field.
  const seen = [];
  const primitives = stubPrimitives(react);
  for (const name of ["Checkbox", "Button"]) {
    const base = primitives[name];
    primitives[name] = (props) => {
      seen.push({ name, props });
      return base(props);
    };
  }
  const exports = await loadWithReact(react, primitives);
  const { registrations } = collectRegistrations(exports);
  const store = registrations.find((row) => row.options.store !== undefined)?.options.store.create();
  const overlay = registrations.find((row) => row.options.name === "shell.overlay");
  assert.ok(overlay, "the overlay host must be registered");
  const t_ = (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`);
  const render = () => {
    seen.length = 0;
    server.renderToStaticMarkup(react.createElement(overlay.component, { t: t_, useStore: (selector) => selector(store.getSnapshot()) }));
  };
  const control = (name, match) => seen.find((row) => row.name === name && match(row.props));

  store.actions.setDialog({
    mode: "batch",
    sessionIds: ["a", "c"],
    titleById: { a: "Alpha", c: "Residue" },
    plans: [
      { sessionId: "a", deletable: true, exists: true, bytes: 10, resident: false, activity: [], running: false },
      { sessionId: "c", deletable: false, exists: false, bytes: 0, code: "not-found", resident: true, archived: true, activity: [] }
    ],
    selectedIds: [],
    pending: false,
    error: null,
    root: "/tmp/bin"
  });

  render();
  const tick = control("Checkbox", (props) => props.label === "Alpha");
  assert.ok(tick, "each row must render a checkbox");
  tick.props.onChange(true);
  assert.deepEqual(store.getSnapshot().dialog.selectedIds, ["a"], "ticking a row must select it");

  render();
  const selectAll = control("Button", (props) => props.children === "panel.selectAll");
  assert.ok(selectAll, "the bulk row must offer select-all");
  selectAll.props.onClick();
  assert.deepEqual(store.getSnapshot().dialog.selectedIds, ["a", "c"], "select-all must not skip a listed row");

  render();
  const clear = control("Button", (props) => props.children === "panel.clearSelection");
  assert.ok(clear, "the bulk row must offer clear-selection");
  clear.props.onClick();
  assert.deepEqual(store.getSnapshot().dialog.selectedIds, [], "clearing must empty the selection");

  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(init.body) });
    return {
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          deleted: 2,
          failed: 0,
          results: [
            { sessionId: "a", ok: true, trashId: "t-20260101T000000Z-deadbeef" },
            { sessionId: "c", ok: true, trashId: null, cleaned: true }
          ]
        }
      })
    };
  };
  try {
    tick.props.onChange(true);
    render();
    const remove = control("Button", (props) => props.className === "dsh-trash-danger");
    assert.ok(remove, "the dialog must carry its destructive action");
    await remove.props.onClick();
  } finally {
    globalThis.fetch = previousFetch;
  }
  const posted = requests.find((row) => row.url.endsWith("/session-trash/delete"));
  assert.ok(posted, `the selection must reach the host (requests: ${requests.map((row) => row.url).join(", ") || "none"})`);
  assert.deepEqual(posted.body.sessionIds, ["a"], "the host receives exactly what the user selected");
  assert.equal(posted.body.force, false, "a row with no work in progress needs no force");
  assert.equal(store.getSnapshot().dialog, null, "the dialog closes once the host answered");
  assert.deepEqual(store.getSnapshot().notice.undo, { trashIds: ["t-20260101T000000Z-deadbeef"] }, "undo only offers real bin items");
});
