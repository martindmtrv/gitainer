// Gitainer's manager UI: a thin layer over the JSON API, with no build step. Everything is
// rendered with DOM nodes rather than innerHTML, so stack names and env values can't inject markup.

const KEY_STORAGE = "gitainer-api-key";
const view = document.getElementById("view");

// ---- dom helper -----------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith("on")) el.addEventListener(name.slice(2), value);
    else if (name === "class") el.className = value;
    else el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...children.flat(Infinity).filter(child => child !== undefined && child !== null && child !== false));
  return el;
}

// the icons of the buttons, as the path data of a 24x24 stroked svg
const ICONS = {
  update: "M12 3v12M7 10l5 5 5-5M5 21h14",
  restart: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6",
  up: "M7 4l13 8-13 8z",
  down: "M6 6h12v12H6z",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
  reveal: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  hide: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 3l18 18",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M5 12l5 5 9-10",
  close: "M6 6l12 12M18 6L6 18",
  caret: "M6 9l6 6 6-6",
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

// a button showing only an icon: `label` is its tooltip and its name for screen readers
function iconButton(name, label, attrs = {}) {
  return h("button", { ...attrs, class: `btn icon ${attrs.class || ""}`.trim(), title: label, "aria-label": label }, icon(name));
}

// replaces the page, skipping the `condition && node` children that came out falsy
function show(...children) {
  view.replaceChildren(...children.flat(Infinity).filter(child => child !== undefined && child !== null && child !== false));
}

// asks before an action, in a modal. Resolves to whether it was confirmed
function confirmModal({ title, text, label, danger }) {
  const dialog = document.getElementById("confirm-dialog");
  const ok = document.getElementById("confirm-ok");
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  ok.textContent = label;
  ok.classList.toggle("danger", !!danger);

  return new Promise(resolve => {
    // a click on the backdrop is reported on the dialog itself, outside its box
    dialog.onclick = event => {
      const box = dialog.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (event.target === dialog && !inside) dialog.close("cancel");
    };
    // Escape closes it without a button, leaving the returnValue of the last time it was open
    dialog.oncancel = () => { dialog.returnValue = "cancel"; };
    dialog.onclose = () => resolve(dialog.returnValue === "confirm");
    dialog.returnValue = "cancel";
    dialog.showModal();
    // not the destructive button: Enter right after a misclick shouldn't take a stack down
    document.getElementById("confirm-cancel").focus();
  });
}

// ---- api ------------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function storedKey() {
  try { return sessionStorage.getItem(KEY_STORAGE); } catch (e) { return null; }
}

function storeKey(key) {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch (e) { /* private mode: the key lasts until reload */ }
  memoryKey = key;
  document.getElementById("forget-key").hidden = !key;
}

let memoryKey = storedKey();
let keyPrompt;

// one prompt at a time, shared by every request that got a 401
function askForKey(rejected) {
  keyPrompt ??= new Promise(resolve => {
    const dialog = document.getElementById("key-dialog");
    const input = document.getElementById("key-input");
    document.getElementById("key-error").hidden = !rejected;
    input.value = "";
    dialog.addEventListener("cancel", event => event.preventDefault());
    document.getElementById("key-form").onsubmit = () => {
      storeKey(input.value.trim());
      keyPrompt = undefined;
      resolve();
    };
    dialog.showModal();
    input.focus();
  });
  return keyPrompt;
}

async function api(path, options = {}) {
  const sentKey = memoryKey;
  const res = await fetch(path, {
    ...options,
    // the source labels this tab's actions as "UI" in notifications and the history
    headers: { "X-Gitainer-Source": "ui", ...(sentKey ? { "X-API-Key": sentKey } : {}) },
  });

  if (res.status === 401) {
    // another request may already have replaced the key that was rejected
    if (sentKey === memoryKey) await askForKey(!!sentKey);
    return api(path, options);
  }

  const text = await res.text();
  const isJson = (res.headers.get("Content-Type") || "").includes("json");
  let body = text;
  if (isJson) {
    // a long action streams whitespace keepalives before its JSON, which JSON.parse skips
    try { body = JSON.parse(text); } catch (e) { throw new ApiError(text.trim() || `Empty response (${res.status})`, res.status); }
  }
  // a failure after the keepalives started is a 200 that only says so in `err`
  if (!res.ok || (isJson && body && body.err)) {
    throw new ApiError((isJson && body && body.err) || text || `Request failed (${res.status})`, res.status);
  }
  return body;
}

// ---- stacks ---------------------------------------------------------------------------------

// actions this tab started, by stack: the server reports them as `busy` too, this covers the gap
const pending = new Map();
// the outcome of the last action per stack, shown until dismissed
const outcomes = new Map();

const ACTIONS = [
  {
    id: "update", label: "Update", path: "", title: "Update: pull images, then down and up",
    confirm: "Pulls the stack's images, then takes it down and brings it back up. Its containers are recreated, with the current values of its env variables.",
  },
  {
    id: "restart", label: "Restart", path: "/restart", title: "Restart: down, then up --force-recreate, without pulling",
    confirm: "Takes the stack down and brings it back up with new containers, without pulling images. The current values of its env variables are applied.",
  },
  { id: "up", label: "Up", path: "/up", title: "Up: docker compose up -d" },
  {
    id: "down", label: "Down", path: "/down", title: "Down: run the shutdown hook, then docker compose down", danger: true,
    confirm: "Runs the stack's shutdown hook, then docker compose down. It stays down until it's brought up again or its compose file changes.",
  },
];

// the same guards the API applies: the self-stack can only be updated, a disabled one only downed
function allowedActions(stack) {
  if (stack.self) return ACTIONS.filter(action => action.id === "update" && !stack.disabled);
  // a disabled stack is normally down already. It only needs the button if it still has
  // containers (e.g. the flag came from an env var and env updates are off), or its state is unknown
  if (stack.disabled) return ACTIONS.filter(action => action.id === "down" && (!stack.containers || stack.containers.length > 0));
  return ACTIONS;
}

// a remote stack from the list, whose state is still being fetched on its own
function isStatusPending(stack) {
  return !!stack.remoteHost && !stack.err && !stack.containers && !stack.statusErr;
}

function stackStatus(stack) {
  if (stack.err) return { kind: "bad", text: "invalid", title: stack.err };
  if (!stack.containers) return { kind: "idle", text: "unknown", title: stack.statusErr };
  const total = stack.containers.length;
  if (total === 0) return { kind: "idle", text: "down" };
  const running = stack.containers.filter(container => container.state === "running").length;
  const unhealthy = stack.containers.some(container => /unhealthy/.test(container.status));
  if (stack.containers.some(container => container.state === "restarting")) return { kind: "warn", text: `restarting · ${running}/${total}` };
  if (running === total) return unhealthy ? { kind: "warn", text: `unhealthy · ${running}/${total}` } : { kind: "ok", text: `running · ${running}/${total}` };
  if (running === 0) return { kind: "bad", text: `stopped · 0/${total}` };
  return { kind: "warn", text: `partial · ${running}/${total}` };
}

function statusEl(stack) {
  const busy = pending.get(stack.name) || stack.busy;
  if (busy) return h("span", { class: "status" }, h("span", { class: "spinner" }), `${busy}…`);
  if (isStatusPending(stack)) return h("span", { class: "status idle" }, h("span", { class: "spinner" }), "checking…");
  const status = stackStatus(stack);
  return h("span", { class: `status ${status.kind}`, title: status.title }, h("span", { class: "dot" }), status.text);
}

// the variables a running stack has old values of. A stack with no containers has nothing stale
function staleEnv(stack) {
  return stack.containers && stack.containers.length > 0 && stack.staleEnv ? stack.staleEnv : [];
}

function badgesEl(stack) {
  const stale = staleEnv(stack);
  return h("span", { class: "badges" },
    stale.length > 0 && h("span", {
      class: "badge warn",
      title: `Running with old values of ${stale.join(", ")}. Restart it to apply the current ones.`,
    }, "stale env"),
    stack.self && h("span", { class: "badge", title: "Gitainer's own stack (GITAINER_SELF_STACK)" }, "self"),
    stack.disabled && h("span", { class: "badge warn", title: "x-gitainer-disabled: true" }, "disabled"),
    stack.remoteHost && h("span", { class: "badge", title: "Remote docker host" }, stack.remoteHost.replace(/^ssh:\/\//, "")),
  );
}

function actionButtons(stack, rerender) {
  const busy = pending.get(stack.name) || stack.busy;
  return h("div", { class: "actions" }, allowedActions(stack).map(action =>
    h("button", {
      class: `btn icon${action.danger ? " danger" : ""}`,
      title: action.title,
      "aria-label": action.label,
      disabled: !!busy || !!stack.err,
      onclick: () => runAction(stack.name, action, rerender),
    }, icon(action.id))));
}

async function runAction(name, action, rerender) {
  if (pending.has(name)) return;
  if (action.confirm && !await confirmModal({ title: `${action.label} ${name}?`, text: action.confirm, label: action.label, danger: action.danger })) return;
  // another action may have started on it while the modal was open
  if (pending.has(name)) return;

  pending.set(name, action.id);
  outcomes.delete(name);
  rerender();
  const startedAt = Date.now();
  let outcome;
  try {
    const result = await api(`api/stacks/${encodeURIComponent(name)}${action.path}`, { method: "POST" });
    outcome = { ok: true, text: `${action.label} of ${name} succeeded` + (result.output ? `: ${result.output.trim()}` : "") };
  } catch (e) {
    // anything but an answer from the API is the connection dropping, which a deploy can cause
    // itself (e.g. a reverse proxy reloading). The action carries on, so read how it ended
    outcome = e instanceof ApiError
      ? { ok: false, text: `${action.label} of ${name} failed: ${e.message.trim()}` }
      : await storedOutcome(name, action, startedAt);
  }
  outcomes.set(name, outcome);
  pending.delete(name);
  rerender();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// how an action whose response was lost ended: waits for it to finish, then reads its stored deploy
async function storedOutcome(name, action, startedAt) {
  const stack = encodeURIComponent(name);
  for (let attempt = 0; attempt < 150; attempt++) {
    await sleep(2000);
    try {
      if ((await api(`api/stacks/${stack}/status`)).busy) continue;
      const [deploy] = await api(`api/deploys?stack=${stack}&limit=1`);
      // a minute of slack for the server's clock differing from this one
      if (deploy && deploy.action === action.id && new Date(deploy.finishedAt) >= startedAt - 60_000) {
        return deploy.ok
          ? { ok: true, text: `${action.label} of ${name} succeeded` }
          : { ok: false, text: `${action.label} of ${name} failed: ${deploy.output}` };
      }
      break;
    } catch (e) {
      if (e instanceof ApiError) break;
    }
  }
  return { ok: false, text: `Lost the connection during the ${action.id} of ${name}. Check its deploys to see how it ended.` };
}

function outcomeNotices(names, rerender) {
  return names.filter(name => outcomes.has(name)).map(name => {
    const outcome = outcomes.get(name);
    return h("div", { class: `notice ${outcome.ok ? "ok" : "bad"}`, role: "status" },
      h("div", { class: "body" }, outcome.text),
      iconButton("close", "Dismiss", { class: "quiet", onclick: () => { outcomes.delete(name); rerender(); } }));
  });
}

// a click anywhere on a stack's row opens its page, unless it was on a button or link in the
// row, or ended a text selection
function openStack(event, name) {
  if (event.target.closest("button, a") || String(window.getSelection())) return;
  navigate(`/stacks/${encodeURIComponent(name)}`);
}

// where to clone the stacks repo from: GITAINER_CLONE_URL if it's set, otherwise the git server's
// port on the host this page was opened at
let cloneUrl;

async function loadCloneUrl() {
  if (!cloneUrl) {
    const info = await api("api/info");
    cloneUrl = info.cloneUrl || `http://${location.hostname}:3000/${info.repoName}.git`;
  }
  return cloneUrl;
}

// whether the clone dropdown is open: the page is rebuilt on every refresh, which would close it
let cloneOpen = false;

// a "Clone" button that drops down a panel with the repo's url and a copy button
function cloneDropdown() {
  return h("details", { class: "dropdown", open: cloneOpen, ontoggle: event => { cloneOpen = event.target.open; } },
    h("summary", { class: "btn" }, "Clone", icon("caret")),
    h("div", { class: "dropdown-panel" },
      h("div", { class: "dropdown-title" }, "Clone the stacks repo"),
      h("div", { class: "clone" },
        h("input", { class: "env-value", readonly: true, value: cloneUrl, "aria-label": "Git clone URL", onfocus: event => event.target.select() }),
        h("div", { class: "actions" }, iconButton("copy", "Copy the git clone URL", { onclick: event => copyValue(event.currentTarget, cloneUrl) }))),
      h("div", { class: "dropdown-hint muted" }, "A push to it deploys the stacks it changes.")));
}

// a click outside an open dropdown, or Escape, closes it
document.addEventListener("click", event => {
  document.querySelectorAll("details.dropdown[open]").forEach(dropdown => {
    if (!dropdown.contains(event.target)) dropdown.open = false;
  });
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  document.querySelectorAll("details.dropdown[open]").forEach(dropdown => {
    dropdown.open = false;
    dropdown.querySelector("summary").focus();
  });
});

async function stacksPage(isCurrent) {
  let stacks;
  let timer;
  // the last state loaded for each remote stack, shown while it's being fetched again
  const remoteStates = new Map();
  const fetching = new Set();

  const withRemoteState = stack => isStatusPending(stack) && remoteStates.has(stack.name)
    ? { ...stack, ...remoteStates.get(stack.name) }
    : stack;

  const load = async () => {
    try {
      // a remote host is an ssh round trip that can time out, so those load one by one below
      // the clone url is only for a button, so the list shows without it
      [stacks] = await Promise.all([api("api/stacks?status=local"), loadCloneUrl().catch(() => undefined)]);
      stacks = stacks.map(withRemoteState);
    } catch (e) {
      if (!isCurrent()) return;
      // a refresh that fails keeps the list that's there, and tries again
      clearTimeout(timer);
      if (stacks) timer = setTimeout(load, 4000);
      else show(errorNotice(e));
      return;
    }
    render();

    stacks.filter(stack => stack.remoteHost && !stack.err && !fetching.has(stack.name)).forEach(async (stack) => {
      fetching.add(stack.name);
      let state;
      try {
        const { containers, statusErr } = await api(`api/stacks/${encodeURIComponent(stack.name)}/status`);
        state = { containers, statusErr };
      } catch (e) {
        state = { statusErr: e.message };
      }
      fetching.delete(stack.name);
      remoteStates.set(stack.name, state);
      stacks = stacks.map(other => other.name === stack.name ? { ...other, containers: undefined, statusErr: undefined, ...state } : other);
      render();
    });
  };

  const render = () => {
    if (!isCurrent()) return;
    clearTimeout(timer);
    // poll while something is in flight, so an action started elsewhere shows its result too
    if (stacks.some(stack => stack.busy || pending.has(stack.name))) timer = setTimeout(load, 4000);

    show(
      h("div", { class: "page-head" },
        h("h1", {}, "Stacks"),
        h("span", { class: "muted" }, `${stacks.length} in the repo`),
        h("span", { class: "spacer" }),
        cloneUrl && cloneDropdown(),
        iconButton("refresh", "Refresh", { onclick: load })),
      ...outcomeNotices(stacks.map(stack => stack.name), reload),
      h("div", { class: "card" },
        stacks.length === 0
          ? h("div", { class: "empty" }, "No stacks yet. Push a stacks/<name>/docker-compose.yaml to the repo.")
          : h("div", { class: "table-wrap" }, h("table", { class: "stacks-table" },
            h("thead", {}, h("tr", {}, h("th", {}, "Stack"), h("th", {}, "Status"), h("th", { class: "right" }, "Actions"))),
            h("tbody", {}, stacks.map(stack => h("tr", { class: "clickable", onclick: event => openStack(event, stack.name) },
              h("td", {},
                h("a", { class: "stack-name", href: `/stacks/${encodeURIComponent(stack.name)}` }, stack.name), " ", badgesEl(stack),
                (stack.err || stack.statusErr) && h("div", { class: "row-note" }, stack.err || `Status unavailable: ${stack.statusErr}`)),
              h("td", {}, statusEl(stack)),
              h("td", { class: "right" }, actionButtons(stack, reload)))))))),
    );
  };

  // after an action: show the spinner or outcome straight away, then fetch the new states
  const reload = () => { render(); load(); };

  show(loadingEl());
  await load();
}

// ---- stack detail ---------------------------------------------------------------------------

// comments and ${VARS} get a colour, the rest is left as it is
function highlightYaml(text, markVariables) {
  const pre = h("pre", { class: "code" });
  for (const line of text.replace(/^\n+|\n+$/g, "").split("\n")) {
    if (/^\s*#/.test(line)) {
      pre.append(h("span", { class: "c" }, line), "\n");
      continue;
    }
    const parts = markVariables ? line.split(/(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)/) : [line];
    pre.append(...parts.map((part, index) => index % 2 ? h("span", { class: "v" }, part) : part), "\n");
  }
  return pre;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString();
}

function duration(from, to) {
  const seconds = Math.round((new Date(to) - new Date(from)) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function stackPage(name, isCurrent) {
  const base = `api/stacks/${encodeURIComponent(name)}`;
  let stack, compose, variables, variablesErr;
  let deploys = [];
  // the interpolated compose holds secrets: it's fetched on demand and dropped when hidden
  let resolved;
  let timer;

  const loadStatus = async () => {
    try {
      [stack, deploys] = await Promise.all([
        api(`${base}/status`),
        api(`api/deploys?stack=${encodeURIComponent(name)}&limit=20`),
      ]);
    } catch (e) {
      if (!isCurrent()) return;
      // a refresh that fails keeps the page that's there, and tries again
      clearTimeout(timer);
      if (stack) timer = setTimeout(loadStatus, 4000);
      else show(crumb(), errorNotice(e));
      return;
    }
    render();
  };

  const crumb = () => h("a", { class: "crumb", href: "/" }, "← Stacks");

  const showResolved = async (show) => {
    if (!show) {
      resolved = undefined;
      return render();
    }
    if (resolved) return;
    const confirmed = await confirmModal({
      title: "Show secrets?",
      text: `This shows the compose file of ${name} with its env values filled in, including any secrets it reads.`,
      label: "Show with envs",
    });
    if (!confirmed) return;
    resolved = { loading: true };
    render();
    try {
      resolved = { text: await api(`${base}/resolved`) };
    } catch (e) {
      resolved = { err: e.message };
    }
    render();
  };

  const render = () => {
    if (!isCurrent() || !stack) return;
    clearTimeout(timer);
    if (stack.busy || pending.has(name)) timer = setTimeout(loadStatus, 4000);

    const unset = (variables || []).filter(variable => !variable.set);
    const stale = staleEnv(stack);

    show(
      crumb(),
      h("div", { class: "page-head" },
        h("h1", { class: "mono" }, name),
        badgesEl(stack),
        statusEl(stack),
        h("span", { class: "spacer" }),
        actionButtons(stack, reload),
        iconButton("refresh", "Refresh", { class: "quiet", onclick: loadStatus })),
      ...outcomeNotices([name], reload),
      stack.err && h("div", { class: "notice bad" }, h("div", { class: "body" }, stack.err)),
      stale.length > 0 && h("div", { class: "notice warn" }, h("div", { class: "body" },
        "This stack is running with old values of ", stale.map((name, index) => [index > 0 && ", ", h("a", { class: "mono", href: `/env?q=${encodeURIComponent(name)}`, title: "View in env" }, name)]),
        ". Restart it to apply the current ones.")),
      stack.statusErr && h("div", { class: "notice warn" }, h("div", { class: "body" }, `Status unavailable: ${stack.statusErr}`)),

      h("section", {},
        h("h2", {}, "Containers"),
        h("div", { class: "card" }, !stack.containers || stack.containers.length === 0
          ? h("div", { class: "empty" }, stack.containers ? "No containers: the stack is down."
            : isStatusPending(stack) ? h("span", { class: "spinner" }) : "Unknown")
          : h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, h("th", {}, "Service"), h("th", {}, "Container"), h("th", {}, "State"))),
            h("tbody", {}, stack.containers.map(container => h("tr", {},
              h("td", { class: "mono" }, container.service),
              h("td", { class: "mono muted" }, container.name),
              h("td", {}, h("span", { class: `status ${container.state === "running" ? (/unhealthy/.test(container.status) ? "warn" : "ok") : "bad"}` },
                h("span", { class: "dot" }), container.status))))))))),

      h("section", {},
        h("div", { class: "section-head" },
          h("h2", {}, "Compose"),
          h("div", { class: "segmented" },
            h("button", { "aria-pressed": String(!resolved), onclick: () => showResolved(false) }, "Without envs"),
            h("button", { "aria-pressed": String(!!resolved), onclick: () => showResolved(true) }, "With envs"))),
        h("div", { class: "card" },
          !resolved
            ? highlightYaml(compose, true)
            : resolved.loading ? h("div", { class: "empty" }, h("span", { class: "spinner" }))
            : resolved.err ? h("div", { class: "empty error-text" }, resolved.err)
            : [
              h("div", { class: "code-note muted" }, "What would deploy now, as docker compose config normalises it. It contains secrets."),
              highlightYaml(resolved.text, false),
            ])),

      h("section", {},
        h("div", { class: "section-head" },
          h("h2", {}, "Variables"),
          unset.length > 0 && h("span", { class: "badge warn" }, `${unset.length} unset`)),
        h("div", { class: "card" }, variablesErr
          ? h("div", { class: "empty error-text" }, variablesErr)
          : variables.length === 0 ? h("div", { class: "empty" }, "This stack reads no variables.")
          : h("div", { class: "table-wrap" }, h("table", {},
            h("tbody", {}, variables.map(variable => h("tr", {},
              h("td", { class: "env-key" }, variable.name),
              h("td", {}, stale.includes(variable.name)
                ? h("span", { class: "badge warn", title: "Its value changed since the stack was last deployed" }, "changed since deploy")
                : variable.set ? h("span", { class: "badge ok" }, "set")
                : variable.required ? h("span", { class: "badge bad", title: "${VAR:?}: the stack won't deploy without it" }, "unset · required")
                : variable.hasDefault ? h("span", { class: "badge", title: "Falls back to the default in the compose file" }, "unset · has default")
                : h("span", { class: "badge warn", title: "Interpolates to an empty string" }, "unset")),
              h("td", { class: "right" }, variable.set && h("a", { href: `/env?q=${encodeURIComponent(variable.name)}` }, "View in env"))))))))),

      h("section", {},
        h("div", { class: "section-head" },
          h("h2", {}, "Deploys"),
          h("a", { href: "/history" }, "All history")),
        h("div", { class: "card" }, deploys.length === 0
          ? h("div", { class: "empty" }, "Nothing recorded for this stack yet.")
          : deploys.map(deployEntry))),
    );
  };

  const reload = () => { render(); loadStatus(); };

  show(crumb(), loadingEl());
  try {
    let stacks;
    [compose, variables, stacks, deploys] = await Promise.all([
      api(base),
      api(`${base}/variables`).catch(e => { variablesErr = e.message; return []; }),
      // quick, unlike the status of a stack on a remote host that doesn't answer: the page
      // shows with it, and loadStatus() fills in the remote stack's state when it arrives
      api("api/stacks?status=local"),
      api(`api/deploys?stack=${encodeURIComponent(name)}&limit=20`),
    ]);
    stack = stacks.find(other => other.name === name);
  } catch (e) {
    if (!isCurrent()) return;
    if (e.status === 404) notFoundPage(`There's no stack called ${name} in the repo.`);
    else show(crumb(), errorNotice(e));
    return;
  }
  render();
  if (!stack || isStatusPending(stack)) await loadStatus();
}

// one stored deploy, opening to its output
function deployEntry(deploy) {
  return h("details", { class: "entry" },
    h("summary", {},
      h("span", { class: `badge ${deploy.ok ? "ok" : "bad"}` }, `${deploy.action} ${deploy.ok ? "ok" : "failed"}`),
      h("span", { class: "entry-main muted" }, `${deploy.trigger}${deploy.commit ? ` · ${deploy.commit.slice(0, 7)}` : ""}`),
      h("span", { class: "entry-meta" }, `${formatTime(deploy.finishedAt)} · ${duration(deploy.startedAt, deploy.finishedAt)}`)),
    h("div", { class: "entry-body" }, h("pre", { class: "code" }, deploy.output || "(no output)")));
}

// ---- history --------------------------------------------------------------------------------

// a short line for an event's row: what it did to which stacks, e.g. "deploy web, db · down legacy".
// The full message is long (it's written for notifications), so it's only shown once opened
function eventSummary(event) {
  const stacksByAction = new Map();
  for (const deploy of event.deploys) {
    stacksByAction.set(deploy.action, [...(stacksByAction.get(deploy.action) ?? []), deploy.stack]);
  }
  if (stacksByAction.size > 0) {
    return [...stacksByAction].map(([action, stacks]) => `${action} ${stacks.join(", ")}`).join(" · ");
  }
  // no stack was touched: a label stop/start, a registry cleanup, a named command or an empty push
  const { identifier, containerName, name } = event.payload;
  return identifier ? `label ${identifier}`
    : containerName ? `registry cleanup ${containerName}`
    : name ? `command ${name}`
    : "no stack changes";
}

// the event's message without the command output it ends with on a failure: that output is
// shown under the deploy it belongs to
function eventMessage(event) {
  let message = event.message;
  for (const output of [event.payload.output, ...event.deploys.map(deploy => deploy.output)]) {
    if (typeof output === "string" && output.trim()) message = message.replace(output, "").replace(output.trim(), "");
  }
  return message.trim().replace(/\s*Error:$/, "").replace(/:$/, "");
}

async function historyPage(isCurrent) {
  let events;

  const load = async () => {
    try {
      events = await api("api/events?limit=100");
    } catch (e) {
      if (isCurrent()) show(errorNotice(e));
      return;
    }
    if (!isCurrent()) return;

    show(
      h("div", { class: "page-head" },
        h("h1", {}, "History"),
        h("span", { class: "muted" }, events.length === 100 ? "the last 100 events" : `${events.length} events`),
        h("span", { class: "spacer" }),
        iconButton("refresh", "Refresh", { onclick: load })),
      h("div", { class: "card" }, events.length === 0
        ? h("div", { class: "empty" }, "Nothing recorded yet. Pushes, env updates and API actions show up here.")
        : events.map(event => h("details", { class: "entry" },
          h("summary", {},
            h("span", { class: `badge ${event.ok ? "ok" : "bad"}` }, event.ok ? "ok" : "failed"),
            h("span", { class: "badge" }, event.type),
            h("span", { class: "entry-main mono" }, eventSummary(event)),
            h("span", { class: "entry-meta" }, formatTime(event.createdAt))),
          h("div", { class: "entry-body nested" },
            eventMessage(event) && h("div", { class: "entry-message" }, eventMessage(event)),
            // one block per stack the event touched, with that stack's log inside it
            event.deploys.map(deploy => h("div", { class: `stack-log ${deploy.ok ? "ok" : "bad"}` },
              h("div", { class: "stack-log-head" },
                h("a", { class: "stack-name", href: `/stacks/${encodeURIComponent(deploy.stack)}` }, deploy.stack),
                h("span", { class: `badge ${deploy.ok ? "ok" : "bad"}` }, `${deploy.action} ${deploy.ok ? "ok" : "failed"}`),
                h("span", { class: "entry-meta" }, `took ${duration(deploy.startedAt, deploy.finishedAt)}`)),
              deploy.output
                ? h("pre", { class: "code" }, deploy.output)
                : h("div", { class: "stack-log-empty muted" }, "No output"))),
            // an event that touched no stack has its output in the payload only
            event.deploys.length === 0 && typeof event.payload.output === "string" && event.payload.output.trim()
              && h("div", { class: "stack-log" }, h("pre", { class: "code" }, event.payload.output.trim())),
            h("details", { class: "raw" },
              h("summary", {}, "Raw payload"),
              h("pre", { class: "code" }, JSON.stringify(event.payload, null, 2))))))),
    );
  };

  show(loadingEl());
  await load();
}

// ---- env ------------------------------------------------------------------------------------

// copies a value, and says so on the button for a moment: a check, or a cross if it couldn't copy
async function copyValue(button, value) {
  const label = button.title;
  let copied = false;
  try {
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch (e) {
    // no clipboard API on plain http (other than localhost): copy from the input beside the
    // button instead, without scrolling the page or table to bring it into view
    const input = button.parentElement.parentElement.querySelector("input[readonly]");
    if (input) {
      input.focus({ preventScroll: true });
      input.select();
      try { copied = document.execCommand("copy"); } catch (e) { /* reported below */ }
    }
  }
  const outcome = copied ? "Copied" : "Copy failed";
  button.replaceChildren(icon(copied ? "check" : "close"));
  button.title = outcome;
  button.setAttribute("aria-label", outcome);
  button.classList.toggle("done", copied);
  setTimeout(() => {
    button.replaceChildren(icon("copy"));
    button.title = label;
    button.setAttribute("aria-label", label);
    button.classList.remove("done");
  }, 1500);
}

async function envPage(query, isCurrent) {
  let data;
  let filter = query.get("q") || "";
  let usedOnly = !filter;
  // values are held only while they're shown
  const revealed = new Map();
  const tableHost = h("div", {});

  // asked once per visit to the page, not for every key
  let revealConfirmed = false;

  const reveal = async (key) => {
    revealConfirmed ||= await confirmModal({
      title: "Show secret values?",
      text: `This shows the value of ${key} on screen. Other keys you reveal on this page won't ask again.`,
      label: "Reveal",
    });
    if (!revealConfirmed) return;
    try {
      revealed.set(key, { value: (await api(`api/env/${encodeURIComponent(key)}`)).value });
    } catch (e) {
      revealed.set(key, { err: e.message });
    }
    renderTable();
  };

  // `stale` are the stacks deployed with another value of the key: the link says so, and leads
  // to the stack, where it can be restarted
  const stackLinks = (stacks, stale = []) => stacks.length === 0
    ? h("span", { class: "muted" }, "—")
    : h("div", { class: "stack-links" }, stacks.map(stack => stale.includes(stack)
      ? h("a", { class: "stale", href: `/stacks/${encodeURIComponent(stack)}`, title: "Deployed with another value of this key. Restart it to apply the current one." }, stack, h("span", { class: "badge warn" }, "stale"))
      : h("a", { href: `/stacks/${encodeURIComponent(stack)}` }, stack)));

  const renderTable = () => {
    const needle = filter.trim().toLowerCase();
    const rows = data.env.filter(entry =>
      (!usedOnly || entry.stacks.length > 0) && (!needle || entry.key.toLowerCase().includes(needle)));

    // the table is rebuilt on every reveal, hide and filter: keep it scrolled where it was
    const scrollLeft = tableHost.querySelector(".table-wrap")?.scrollLeft ?? 0;

    tableHost.replaceChildren(h("div", { class: "card" }, rows.length === 0
      ? h("div", { class: "empty" }, "No keys match.")
      : h("div", { class: "table-wrap" }, h("table", { class: "env-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Key"), h("th", {}, "Source"), h("th", {}, "Used by"), h("th", {}, "Value"))),
        h("tbody", {}, rows.map(entry => {
          const shown = revealed.get(entry.key);
          return h("tr", {},
            h("td", {},
              h("span", { class: "env-key" }, entry.key)),
            h("td", {}, h("span", { class: "badge" }, entry.source)),
            h("td", { class: entry.stacks.length === 0 && "unused" }, stackLinks(entry.stacks, entry.staleStacks)),
            h("td", {}, h("div", { class: "value-cell" },
              !shown ? h("span", { class: "masked" }, "••••••••")
                : shown.err ? h("span", { class: "error-text" }, shown.err)
                // a read-only input: a long value scrolls inside it instead of widening the table
                : h("input", { class: "env-value", readonly: true, value: shown.value, placeholder: "(empty)", "aria-label": `Value of ${entry.key}` }),
              h("div", { class: "actions" },
                shown && !shown.err && iconButton("copy", "Copy", { onclick: event => copyValue(event.currentTarget, shown.value) }),
                !entry.revealable ? h("span", { class: "muted", title: "Never revealed" }, "hidden")
                  : shown ? iconButton("hide", "Hide", { class: "quiet", onclick: () => { revealed.delete(entry.key); renderTable(); } })
                  : iconButton("reveal", "Reveal", { onclick: () => reveal(entry.key) })))));
        }))))));

    const wrap = tableHost.querySelector(".table-wrap");
    if (wrap) wrap.scrollLeft = scrollLeft;
  };

  show(loadingEl());
  try {
    data = await api("api/env");
  } catch (e) {
    if (isCurrent()) show(errorNotice(e));
    return;
  }
  if (!isCurrent()) return;

  const stackErrors = Object.entries(data.stackErrors || {});
  const usedCount = data.env.filter(entry => entry.stacks.length > 0).length;

  show(
    h("div", { class: "page-head" },
      h("h1", {}, "Env"),
      h("span", { class: "muted" }, `${data.env.length} keys, ${usedCount} read by stacks`)),
    ...stackErrors.map(([stack, err]) => h("div", { class: "notice bad" },
      h("div", { class: "body" }, `Could not read the variables of ${stack}: ${err}`))),

    data.unset.length > 0 && h("section", { style: "margin-top:0;margin-bottom:28px" },
      h("h2", {}, "Referenced but unset"),
      h("div", { class: "card" }, h("div", { class: "table-wrap" }, h("table", {},
        h("tbody", {}, data.unset.map(entry => h("tr", {},
          h("td", { class: "env-key" }, entry.key),
          h("td", {}, entry.required ? h("span", { class: "badge bad", title: "${VAR:?}: the stack won't deploy without it" }, "required")
            : entry.hasDefault ? h("span", { class: "badge", title: "Every stack reading it has a default" }, "has default")
            : h("span", { class: "badge warn", title: "Interpolates to an empty string" }, "empty string")),
          h("td", {}, stackLinks(entry.stacks))))))))),

    h("div", { class: "toolbar" },
      h("input", { type: "search", placeholder: "Filter keys", value: filter, "aria-label": "Filter keys", oninput: event => { filter = event.target.value; renderTable(); } }),
      h("label", { class: "check" },
        h("input", { type: "checkbox", checked: usedOnly, onchange: event => { usedOnly = event.target.checked; renderTable(); } }),
        "Only keys read by stacks")),
    tableHost,
  );
  renderTable();
}

// ---- info -----------------------------------------------------------------------------------

function settingValue(setting) {
  if (!setting.set) {
    return h("span", { class: "muted" }, "not set");
  }
  if (setting.visibility === "hidden") {
    return h("span", { class: "muted", title: "Never shown" }, "set · never shown");
  }
  if (setting.visibility === "reveal") {
    // it can hold credentials, so it's revealed like any other env value
    return h("a", { href: `/env?q=${encodeURIComponent(setting.key)}` }, "set · view in Env");
  }
  return h("span", { class: "setting-value" }, setting.value === "" ? h("span", { class: "muted" }, "(empty)") : setting.value);
}

async function infoPage(isCurrent) {
  let settings;
  show(loadingEl());
  try {
    settings = await api("api/settings");
  } catch (e) {
    if (isCurrent()) show(errorNotice(e));
    return;
  }
  if (!isCurrent()) return;

  const groups = [...new Set(settings.map(setting => setting.group))];
  show(
    h("div", { class: "page-head" },
      h("h1", {}, "Info"),
      h("span", { class: "muted" }, "Gitainer's own settings, read from its environment")),
    groups.map(group => h("section", {},
      h("h2", {}, group),
      h("div", { class: "card" }, settings.filter(setting => setting.group === group).map(setting =>
        h("div", { class: "setting" },
          h("div", { class: "setting-main" },
            h("div", {},
              h("span", { class: "env-key" }, setting.key), " ",
              setting.enabled !== undefined && h("span", { class: `badge ${setting.enabled ? "ok" : ""}` }, setting.enabled ? "enabled" : "disabled")),
            h("div", { class: "setting-description muted" }, setting.description)),
          h("div", { class: "setting-side" },
            settingValue(setting),
            !setting.set && setting.default !== undefined && h("div", { class: "setting-default muted" }, `image default: ${setting.default}`))))))),
  );
}

// ---- shell ----------------------------------------------------------------------------------

function loadingEl() {
  return h("div", { class: "empty" }, h("span", { class: "spinner" }));
}

function errorNotice(e) {
  return h("div", { class: "notice bad" }, h("div", { class: "body" }, e.message || String(e)));
}

// the page for a path the UI doesn't have, or a stack that isn't in the repo
function notFoundPage(message = "There's no page at this address.") {
  document.title = "Not found · Gitainer";
  show(h("div", { class: "not-found" },
    h("div", { class: "not-found-code" }, "404"),
    h("h1", {}, "Not found"),
    h("p", { class: "muted" }, message),
    h("a", { class: "btn", href: "/" }, "Go to stacks")));
}

// goes to another page of the UI without loading it again
function navigate(path) {
  history.pushState(null, "", path);
  window.scrollTo(0, 0);
  route();
}

let routeId = 0;

function route() {
  const id = ++routeId;
  const isCurrent = () => id === routeId;
  // a trailing slash is the same page
  const path = location.pathname.replace(/(.)\/$/, "$1");
  const stackMatch = /^\/stacks\/([^/]+)$/.exec(path);

  // no tab is lit on a page that doesn't exist
  const section = ["env", "history", "info"].find(name => path === `/${name}`)
    || ((path === "/" || stackMatch) && "stacks");
  document.querySelectorAll("nav a").forEach(link => link.classList.toggle("active", link.dataset.nav === section));

  if (stackMatch) {
    document.title = `${decodeURIComponent(stackMatch[1])} · Gitainer`;
    stackPage(decodeURIComponent(stackMatch[1]), isCurrent);
  } else if (path === "/env") {
    document.title = "Env · Gitainer";
    envPage(new URLSearchParams(location.search), isCurrent);
  } else if (path === "/info") {
    document.title = "Info · Gitainer";
    infoPage(isCurrent);
  } else if (path === "/history") {
    document.title = "History · Gitainer";
    historyPage(isCurrent);
  } else if (path === "/") {
    document.title = "Stacks · Gitainer";
    stacksPage(isCurrent);
  } else {
    notFoundPage();
  }
}

document.getElementById("forget-key").hidden = !memoryKey;
document.getElementById("forget-key").addEventListener("click", async () => {
  // it's this tab's logout: the page can't show anything until the key is typed in again
  const confirmed = await confirmModal({
    title: "Log out?",
    text: "This tab forgets the API key. You'll need to enter it again to see or change anything.",
    label: "Logout",
  });
  if (!confirmed) return;
  storeKey(null);
  route();
});

// a click on a link to another page of the UI switches page in place. Left alone: links that
// open elsewhere (a modifier key, another button), and anything that isn't a page
document.addEventListener("click", event => {
  const link = event.target.closest("a[href]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link.target || link.origin !== location.origin || /^\/(api|ui)\//.test(link.pathname)) return;
  event.preventDefault();
  navigate(link.pathname + link.search);
});

// back and forward
window.addEventListener("popstate", route);

// links from before the UI had real paths: /#/stacks/web is /stacks/web now
if (location.hash.startsWith("#/")) {
  history.replaceState(null, "", location.hash.slice(1));
}
route();
