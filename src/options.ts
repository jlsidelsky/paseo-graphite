import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { DEFAULT_PRESETS, loadStore, parseHint, PRESET_KINDS, saveStore, type ArgValues, type DiscoveredCache, type Override, type Preset, type Store } from "./actions";
import { argControls, readArgs } from "./args-form";
import { DAEMON_URL } from "./pr";

type Provider = Awaited<ReturnType<ReturnType<typeof createPaseoApi>["providers"]["snapshot"]>>["entries"][number];
type Settings = Override & { provider?: string };
import { fillSettings, inboxStyles, loadInboxSettings, orderSections } from "./inbox-view";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const kindsBox = $<HTMLDivElement>("kinds");
const commandsBox = $<HTMLDivElement>("commands");
const saved = $<HTMLElement>("saved");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const KIND_LABELS: Record<Preset["kind"], string> = { review: "Review", ci: "Fix CI", "feedback-evaluate": "Feedback: evaluate", "feedback-address": "Feedback: address" };

let providers: Provider[] = [];
let discovered: DiscoveredCache = {};
let overrides: Store["overrides"] = {};
const lists = Object.fromEntries(PRESET_KINDS.map((k) => [k, el("div")])) as Record<Preset["kind"], HTMLDivElement>;

function select(name: string, options: [string, string][], value = "") {
  // A saved value Paseo doesn't offer right now (closed, provider off) stays selectable, so Save keeps it.
  const all: [string, string][] = value && !options.some(([v]) => v === value) ? [...options, [value, value]] : options;
  const s = el("select", { name }, ...all.map(([v, t]) => el("option", { value: v, textContent: t })));
  s.value = value;
  return s;
}
const field = (label: string, input: HTMLElement) => el("label", {}, el("small", { textContent: label }), input);
const value = (n: Element, name: string) => (n.querySelector(`[name=${name}]`) as HTMLInputElement | null)?.value.trim() ?? "";

// Scope, session and model / effort / mode, shared by presets and command overrides.
// `only`: a command's provider, the only one whose models fit it.
function defaults(o: Settings, only?: string) {
  const model = select(
    "model",
    [
      ["", only ? "Default model" : "Any provider"],
      ...providers
        .filter((p) => !only || p.provider === only)
        .flatMap((p): [string, string][] => [
          ...(only ? [] : [[`${p.provider}/`, `${p.label} · default model`] as [string, string]]),
          ...(p.models ?? []).map((m): [string, string] => [`${p.provider}/${m.id}`, `${p.label} · ${m.label}`]),
        ]),
    ],
    o.model ?? (o.provider && !only ? `${o.provider}/` : ""),
  );
  const effortBox = el("span");
  const modeBox = el("span");
  const fill = (effort?: string, mode?: string) => {
    const [pid, mid] = (model.value || `${only ?? ""}/`).split("/");
    const p = providers.find((x) => x.provider === pid);
    const m = p?.models?.find((x) => x.id === mid) ?? p?.models?.find((x) => x.isDefault) ?? p?.models?.[0];
    effortBox.replaceChildren(field("Effort", select("effort", [["", "Default"], ...(m?.thinkingOptions ?? []).map((t): [string, string] => [t.id, t.label])], effort)));
    modeBox.replaceChildren(field("Mode", select("mode", [["", "Default"], ...(p?.modes ?? []).map((x): [string, string] => [x.id, x.label])], mode)));
  };
  fill(o.effort, o.mode);
  model.onchange = () => fill();
  return el(
    "div",
    { className: "row wrap" },
    field("Scope", select("scope", [["", "Panel's choice"], ["this", "This PR"], ["stack", "Whole stack"], ["ask", "Ask (pick PRs)"]], o.scope)),
    field("Session", select("workspace", [["", "Action's default"], ["new", "New worktree"], ["existing", "PR's existing workspace"], ["selected", "Selected session"]], o.workspace)),
    field("Model", model),
    effortBox,
    modeBox,
  );
}

const placement = (o: Settings) =>
  el(
    "div",
    { className: "row wrap" },
    field("Order", el("input", { name: "order", type: "number", value: o.order === undefined ? "" : String(o.order), className: "order" })),
    el("label", { className: "check" }, el("input", { name: "favorite", type: "checkbox", checked: !!o.favorite }), "Favorite"),
    el("label", { className: "check" }, el("input", { name: "hidden", type: "checkbox", checked: !!o.hidden }), "Hidden"),
  );

function readSettings(n: Element): Settings {
  const on = (name: string) => (n.querySelector(`[name=${name}]`) as HTMLInputElement).checked;
  const [provider, model] = value(n, "model").split("/");
  const o: Settings = {
    provider: provider || undefined,
    model: model ? value(n, "model") : undefined,
    effort: value(n, "effort") || undefined,
    mode: value(n, "mode") || undefined,
    scope: (value(n, "scope") || undefined) as Settings["scope"],
    workspace: (value(n, "workspace") || undefined) as Settings["workspace"],
    order: value(n, "order") === "" ? undefined : Number(value(n, "order")),
    favorite: on("favorite") || undefined,
    hidden: on("hidden") || undefined,
  };
  return JSON.parse(JSON.stringify(o)); // drops the unset ones
}

// A command's argument hint, from the panel's last look at its provider (any provider's, for a preset that names none).
const hintOf = (name: string, provider?: string) =>
  Object.entries(discovered)
    .filter(([p]) => !provider || p === provider)
    .flatMap(([, d]) => d.commands)
    .find((c) => c.name === name)?.argumentHint;
const argsField = (name: string, provider: string | undefined, values: ArgValues) =>
  el("div", {}, el("small", { textContent: "Default arguments" }), argControls(parseHint(hintOf(name, provider)), values));
const argsOf = (n: Element) => {
  const args = readArgs(n);
  return Object.keys(args).length ? { args } : {};
};

const newId = () => crypto.randomUUID().slice(0, 8);

// The DOM is the draft; Save reads it back.
function presetCard(p: Preset) {
  const kind = select("kind", PRESET_KINDS.map((k) => [k, KIND_LABELS[k]]), p.kind);
  const command = el("input", { name: "command", value: p.command ? `/${p.command}` : "", placeholder: "/command (optional)", className: "command" });
  const argsSlot = el("div");
  const fillArgs = (values: ArgValues) => {
    const name = command.value.trim().replace(/^\//, "");
    argsSlot.replaceChildren(...(name ? [argsField(name, p.provider, values)] : []));
  };
  fillArgs(p.args ?? {});
  command.onchange = () => fillArgs(readArgs(argsSlot));
  const dup = el("button", { textContent: "Duplicate" });
  const remove = el("button", { textContent: "Delete" });
  const node = el(
    "div",
    { className: "preset" },
    el(
      "div",
      { className: "row" },
      el("input", { name: "label", value: p.label, placeholder: "Label" }),
      kind,
      command,
      dup,
      remove,
    ),
    argsSlot,
    el("textarea", { name: "prompt", value: p.prompt, placeholder: "Prompt; or, with a command, extra instructions after its arguments" }),
    el("div", { className: "row wrap" }, defaults(p), placement(p)),
  );
  node.dataset.id = p.id;
  kind.onchange = () => lists[kind.value as Preset["kind"]].append(node);
  dup.onclick = () => {
    const copy = readPreset(node);
    node.after(presetCard({ ...copy, id: newId(), label: `${copy.label} (copy)` }));
  };
  remove.onclick = () => node.remove();
  return node;
}

function readPreset(n: HTMLElement): Preset {
  const command = value(n, "command").replace(/^\//, "");
  return { id: n.dataset.id!, kind: value(n, "kind") as Preset["kind"], label: value(n, "label"), ...(command ? { command } : {}), prompt: value(n, "prompt"), ...(command ? argsOf(n) : {}), ...readSettings(n) };
}

function commandRow(key: string, description: string, o: Override = overrides[key] ?? {}) {
  const [provider, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const clear = el("button", { textContent: "Clear" });
  const node = el(
    "div",
    { className: "preset" },
    el(
      "div",
      { className: "row" },
      el("b", { textContent: `/${name}` }),
      el("small", { textContent: discovered[provider]?.label ?? provider }),
      el("input", { name: "label", value: o.label ?? "", placeholder: `Menu label (default /${name})` }),
      placement(o),
      clear,
    ),
    el(
      "details",
      { open: !!(o.prompt || o.args || o.scope || o.workspace || o.model || o.effort || o.mode), title: description },
      el("summary", { textContent: "Arguments, instructions and defaults" }),
      argsField(name, provider, o.args ?? {}),
      el("textarea", { name: "prompt", value: o.prompt ?? "", placeholder: "Extra instructions after the command's arguments (optional)", className: "short" }),
      defaults(o, provider),
    ),
  );
  node.dataset.key = key;
  clear.onclick = () => node.replaceWith(commandRow(key, description, {}));
  return node;
}

function readOverride(n: HTMLElement): Override {
  const { provider: _, ...o } = readSettings(n);
  return { ...(value(n, "label") ? { label: value(n, "label") } : {}), ...(value(n, "prompt") ? { prompt: value(n, "prompt") } : {}), ...argsOf(n), ...o };
}

function render(s: Store) {
  overrides = s.overrides;
  for (const k of PRESET_KINDS) lists[k].replaceChildren(...s.presets.filter((p) => p.kind === k).map(presetCard));
  kindsBox.replaceChildren(
    ...PRESET_KINDS.map((k) => {
      const add = el("button", { textContent: `Add ${KIND_LABELS[k]} preset` });
      add.onclick = () => lists[k].append(presetCard({ id: newId(), kind: k, label: "", prompt: "" }));
      return el("div", {}, el("h3", { textContent: KIND_LABELS[k] }), lists[k], add);
    }),
  );
  // Commands the panel has seen, plus any with saved changes whose provider it hasn't seen lately.
  const rows = new Map<string, string>();
  for (const [provider, d] of Object.entries(discovered)) for (const c of d.commands) rows.set(`${provider}:${c.name}`, c.description ?? "");
  for (const key of Object.keys(s.overrides)) if (!rows.has(key)) rows.set(key, "");
  commandsBox.replaceChildren(
    ...(rows.size
      ? [...rows].map(([key, description]) => commandRow(key, description))
      : [el("p", { textContent: "None seen yet. Open the panel's Review or Feedback menu on a PR, then reload this page." })]),
  );
}

function read(): Store {
  const presets = PRESET_KINDS.flatMap((k) => [...lists[k].children].map((n) => readPreset(n as HTMLElement))).filter((p) => p.label && (p.prompt || p.command));
  return { presets, overrides: Object.fromEntries([...commandsBox.querySelectorAll<HTMLElement>("[data-key]")].map((n) => [n.dataset.key!, readOverride(n)])) };
}

$("reset").onclick = () => render({ presets: DEFAULT_PRESETS, overrides: {} });
$("save").onclick = async () => {
  try {
    await saveStore(chrome.storage.sync, read());
    saved.textContent = "Saved";
  } catch (err) {
    saved.textContent = `Not saved: ${err instanceof Error ? err.message : String(err)}`;
  }
  setTimeout(() => (saved.textContent = ""), 3000);
};

// Models, efforts and modes come from Paseo; without it the pickers only keep what's saved.
async function loadProviders() {
  const daemon = new DaemonClient({ url: DAEMON_URL, clientId: "paseo-graphite-options", clientType: "browser" });
  try {
    await Promise.race([daemon.connect(), new Promise((_, fail) => setTimeout(() => fail(new Error("timeout")), 3000))]);
    return (await createPaseoApi(daemon).providers.snapshot()).entries.filter((p) => p.enabled);
  } catch {
    $("offline").hidden = false;
    return [];
  } finally {
    void daemon.close().catch(() => {});
  }
}

void Promise.all([loadStore(chrome.storage.sync), chrome.storage.local.get<{ discovered: DiscoveredCache }>({ discovered: {} }), loadProviders()]).then(([s, local, p]) => {
  discovered = local.discovered;
  providers = p;
  render(s);
});

// Inbox: section names come from the last inbox the panel saw.
void Promise.all([loadInboxSettings(), chrome.storage.local.get("inboxSections")]).then(([s, { inboxSections }]) => {
  inboxStyles();
  fillSettings($("inbox-options"), orderSections(Array.isArray(inboxSections) ? inboxSections : [], s), s);
});
