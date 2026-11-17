/**
 * Render the batch picker's partition list with the real React, outside DSH.
 *
 * The plugin's own tests render through a stub React (the platform's React is
 * not installed in the plugin repo). This harness uses a real React 19 so the
 * render path is exercised for real: hooks, keys, the event handlers, and the
 * state updates that fold a partition away.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "..", "lib", "client.js");

/**
 * Where to find a React to render with.
 *
 * The plugin itself has no dependencies — the platform provides React at run
 * time — so this tool borrows one from wherever the machine happens to keep
 * it. `DSH_REACT_MODULES` wins; otherwise any `~/.dsh/plugin-test-deps/*`
 * checkout with react + react-dom will do.
 *
 * @returns {string} the node_modules directory that holds react.
 */
function resolveReactModules() {
  const candidates = [];
  if (process.env.DSH_REACT_MODULES !== undefined && process.env.DSH_REACT_MODULES !== "") {
    candidates.push(process.env.DSH_REACT_MODULES);
  }
  const depsRoot = path.join(process.env.HOME ?? "", ".dsh", "plugin-test-deps");
  try {
    for (const entry of fsSync.readdirSync(depsRoot)) {
      candidates.push(path.join(depsRoot, entry, "node_modules"));
    }
  } catch {
    /* no test deps on this machine */
  }
  for (const candidate of candidates) {
    if (fsSync.existsSync(path.join(candidate, "react")) && fsSync.existsSync(path.join(candidate, "react-dom"))) {
      return candidate;
    }
  }
  throw new Error("no React found — set DSH_REACT_MODULES to a node_modules directory that has react and react-dom");
}

const DEPS = resolveReactModules();
const require_ = createRequire(`${DEPS}/`);
const React = require_("react");
const ReactDOMServer = require_("react-dom/server");

/** The primitives, rendered as plain HTML — enough to see the structure. */
function primitives() {
  const passthrough = (name) => (props) =>
    React.createElement("div", { "data-primitive": name, className: props?.className }, props?.children);
  const Checkbox = (props) =>
    React.createElement(
      "label",
      { "data-primitive": "Checkbox" },
      React.createElement("input", { type: "checkbox", checked: props?.checked === true, readOnly: true }),
      props?.label
    );
  const Button = (props) =>
    React.createElement("button", { "data-primitive": "Button", type: "button" }, props?.children);
  const Tag = (props) => React.createElement("span", { "data-primitive": "Tag" }, props?.children);
  const Modal = (props) => React.createElement("div", { "data-primitive": "Modal" }, props?.children);
  const Tooltip = (props) => React.createElement("div", { "data-primitive": "Tooltip" }, props?.children);
  const Toast = () => null;
  const icon = (name) => (props) =>
    React.createElement("span", { "data-primitive": name, "data-size": props?.size }, name);
  return new Proxy(
    {
      Checkbox,
      Button,
      Tag,
      Modal,
      Tooltip,
      Toast,
      MenuItemButton: Button,
      IconTrashOutlineRegular: icon("IconTrash"),
      IconUnarchiveOutlineRegular: icon("IconUnarchive"),
      IconRefreshOutlineRegular: icon("IconRefresh"),
      IconLoadingOutlineRegular: icon("IconLoading"),
      IconCheckOutlineRegular: icon("IconCheck"),
      IconWarningOutlineRegular: icon("IconWarning")
    },
    {
      get: (target, name) => {
        if (typeof name !== "string") return undefined;
        if (name in target) return target[name];
        target[name] = icon(String(name));
        return target[name];
      }
    }
  );
}

/** A store good enough for the dialog: state plus patchDialog. */
function clientStore() {
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

const source = await fs.readFile(BUNDLE, "utf8");
let registration = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry; } } };
vm.runInThisContext(source, { filename: BUNDLE });
const modules = {
  react: React,
  "@deepseek-ai/dsh-client-ui-primitives": primitives(),
  "@deepseek-ai/dsh-client-store": clientStore()
};
const exports = registration.factory((specifier) => {
  if (!(specifier in modules)) throw new Error(`no stub for ${specifier}`);
  return modules[specifier];
});

const { DeletePickStep, storeInstance, dictionaries } = exports.__test;
const t = (key, params) => {
  const template = dictionaries.zh[key] ?? key;
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ""));
};

// A realistic picker: six workspaces, dozens of sessions, one of them running.
const workspaces = [
  "/Users/example/Desktop/work/project-alpha",
  "/Users/example/Desktop/work/project-beta",
  "/Users/example/Desktop/work/project-gamma",
  "/Users/example/Desktop/work/project-delta",
  "/Users/example/Desktop/work/project-epsilon",
  "/Users/example/Desktop/work/project-zeta"
];
const plans = [];
let counter = 0;
for (const cwd of workspaces) {
  for (let index = 0; index < 9; index += 1) {
    const id = `session-${String(counter).padStart(4, "0")}`;
    plans.push({
      sessionId: id,
      cwd,
      deletable: true,
      exists: true,
      running: counter === 3,
      archived: false,
      pinned: counter === 7,
      activity: [],
      activityKnown: true
    });
    counter += 1;
  }
}
// One session whose workspace the host could not report.
plans.push({ sessionId: "session-9999", deletable: true, exists: true, activity: [], activityKnown: true });

const titleById = Object.fromEntries(plans.map((plan, index) => [plan.sessionId, `会话标题 ${String(index + 1)}`]));

storeInstance.actions.setDialog({
  mode: "batch",
  plans,
  selectedIds: plans.slice(0, 3).map((plan) => plan.sessionId),
  titleById,
  collapsedGroups: []
});

const html = ReactDOMServer.renderToStaticMarkup(
  React.createElement(DeletePickStep, { dialog: storeInstance.getSnapshot().dialog, t })
);
// The plugin ships its own stylesheet; pull it out of the bundle so the
// screenshot shows what the user will actually see.
const cssMatch = source.match(/const CSS = `([\s\S]*?)`;/);
const pluginCss = cssMatch === null ? "" : cssMatch[1];
const page = (body) => `<!doctype html><meta charset="utf-8"><style>
:root { --dsw-alias-label-primary:#1b1b1f; --dsw-alias-label-secondary:#4a4a52; --dsw-alias-label-tertiary:#8a8a93;
  --dsw-alias-bg-layer-1:#f4f4f6; --dsw-alias-bg-layer-0:#ffffff; --dsw-alias-border-l3:#d9d9de;
  --dsw-alias-interactive-bg-hover:#eaeaee; --dsw-alias-state-warn-primary:#9a6400; --dsw-alias-state-error-primary:#c0392b;
  --dsw-radius-md:8px; --dsw-radius-sm:5px; --dsw-font-xs-13:13px; --dsw-focus-ring-width:2px; --dsw-focus-ring-color:#4c8dff; }
body { font-family: -apple-system, system-ui, "PingFang SC", sans-serif; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-0); padding:20px; font-size:13px; }
${pluginCss}
</style><body>${body}</body>`;
await fs.writeFile("/tmp/partitions.html", page(html));
console.log("rendered bytes:", html.length);
console.log("partitions:", (html.match(/dsh-trash-groupHead/g) ?? []).length);
console.log("toggles:", (html.match(/dsh-trash-groupToggle/g) ?? []).length);
console.log("rows:", (html.match(/dsh-trash-row"/g) ?? []).length);

// Fold the first partition and render again.
const toggles = [];
const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  out.push(node);
  return walk(node.props?.children, out);
};
void walk;
storeInstance.actions.patchDialog({ collapsedGroups: [workspaces[0]] });
const folded = ReactDOMServer.renderToStaticMarkup(
  React.createElement(DeletePickStep, { dialog: storeInstance.getSnapshot().dialog, t })
);
await fs.writeFile("/tmp/partitions-folded.html", page(folded));
console.log("after folding one partition, rows:", (folded.match(/dsh-trash-row"/g) ?? []).length);
console.log("collapsed markers:", (folded.match(/aria-expanded="false"/g) ?? []).length);
