/**
 * Render the delete picker's reason labels with the real React, outside DSH.
 *
 * The bug this guards against is a wording one: a conversation that had long
 * finished used to be labelled 「仍有进行中的工作」, because the runtime merely
 * holding it was reported with the same label as work under way. So the labels
 * have to be seen, not only asserted.
 *
 * The plans come from the live host when `DSH_WEB_URL` is set (or from a saved
 * `/session-trash/plan` response given as the first argument), so what is
 * rendered is what the user's own sessions look like right now.
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
  const Tag = (props) =>
    React.createElement(
      "span",
      { "data-primitive": "Tag", "data-tone": props?.tone ?? "default" },
      props?.children
    );
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

/**
 * The plans to render.
 *
 * @param {string[]} [argv] - command line arguments.
 * @returns {Promise<object[]>} the plans the host reported.
 */
async function loadPlans(argv) {
  if (argv[0] !== undefined && argv[0] !== "") {
    const saved = JSON.parse(await fs.readFile(argv[0], "utf8"));
    return saved.value?.plans ?? saved.plans ?? [];
  }
  const base = process.env.DSH_WEB_URL;
  if (base === undefined || base === "") {
    throw new Error("pass a saved plan JSON as the first argument, or set DSH_WEB_URL");
  }
  const idsRoot = path.join(process.env.HOME ?? "", ".dsh", "sessions");
  const ids = [];
  for (const workspace of fsSync.readdirSync(idsRoot)) {
    const workspaceDir = path.join(idsRoot, workspace);
    for (const entry of fsSync.readdirSync(workspaceDir)) {
      if (entry.startsWith("session-")) ids.push(entry);
    }
  }
  const response = await fetch(`${base.replace(/\/+$/, "")}/session-trash/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionIds: ids })
  });
  const payload = await response.json();
  return payload.value?.plans ?? [];
}

const plans = await loadPlans(process.argv.slice(2));

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

const { DeletePickStep, DeleteConsequences, storeInstance, dictionaries, consentTag } = exports.__test;
const t = (key, params) => {
  const template = dictionaries.zh[key] ?? key;
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ""));
};

// Only the rows that need the user's consent are interesting here: the rest
// carry no reason at all.
const interesting = plans.filter((plan) => consentTag(plan) !== null);
const titles = {
  "session-1a6614fb-0c1a-4336-9496-9b778e5c3651": "股票看台与买入提醒（两个定时任务投递到这里）",
  "session-ee1f581d-9db": "【BUG修复】删除会话插件（正在跑）"
};
const titleById = Object.fromEntries(
  interesting.map((plan, index) => [plan.sessionId, titles[plan.sessionId] ?? `会话 ${String(index + 1).slice(0, 8)}`])
);

storeInstance.actions.setDialog({
  mode: "batch",
  plans: interesting,
  selectedIds: interesting.map((plan) => plan.sessionId),
  titleById,
  collapsedGroups: []
});

const dialog = storeInstance.getSnapshot().dialog;
const picker = ReactDOMServer.renderToStaticMarkup(React.createElement(DeletePickStep, { dialog, t }));
const consequences = ReactDOMServer.renderToStaticMarkup(React.createElement(DeleteConsequences, { dialog, t }));

const cssMatch = source.match(/const CSS = `([\s\S]*?)`;/);
const pluginCss = cssMatch === null ? "" : cssMatch[1];
const page = (body) => `<!doctype html><meta charset="utf-8"><style>
:root { --dsw-alias-label-primary:#1b1b1f; --dsw-alias-label-secondary:#4a4a52; --dsw-alias-label-tertiary:#8a8a93;
  --dsw-alias-bg-layer-1:#f4f4f6; --dsw-alias-bg-layer-0:#ffffff; --dsw-alias-border-l3:#d9d9de;
  --dsw-alias-interactive-bg-hover:#eaeaee; --dsw-alias-state-warn-primary:#9a6400; --dsw-alias-state-error-primary:#c0392b;
  --dsw-radius-md:8px; --dsw-radius-sm:5px; --dsw-font-xs-13:13px; --dsw-focus-ring-width:2px; --dsw-focus-ring-color:#4c8dff; }
body { font-family: -apple-system, system-ui, "PingFang SC", sans-serif; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-0); padding:20px; font-size:13px; }
${pluginCss}
[data-primitive="Tag"] { display:inline-block; padding:1px 7px; border-radius:10px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l3); margin-left:6px; }
[data-primitive="Tag"][data-tone="warning"] { color:var(--dsw-alias-state-warn-primary); }
.dsh-trash-summary { margin-top:18px; padding-top:12px; border-top:1px solid var(--dsw-alias-border-l3); }
</style><body><h3 style="margin:0 0 10px">需要同意的会话，各自带的原因标签</h3>${body}<div class="dsh-trash-summary"><h3 style="margin:0 0 6px">对话框说明（逐类分开）</h3>${consequences}</div></body>`;

await fs.writeFile("/tmp/consent-tags.html", page(picker));
console.log("rows with a reason:", interesting.length);
for (const plan of interesting) {
  const tag = consentTag(plan);
  console.log(`  ${plan.sessionId.slice(0, 20)}  resident=${plan.resident}  activity=${JSON.stringify((plan.activity ?? []).map((f) => f.kind))}  ->  ${t(tag.key, tag.params)}`);
}
console.log("wrote /tmp/consent-tags.html");
