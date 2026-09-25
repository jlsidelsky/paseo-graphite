import { DEFAULT_PRESETS, PRESET_KINDS, type Preset } from "./actions";
import { fillSettings, inboxStyles, loadInboxSettings, orderSections } from "./inbox-view";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLDivElement>("list");
const saved = $<HTMLElement>("saved");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const KIND_LABELS: Record<Preset["kind"], string> = { review: "Review", ci: "Fix CI", "feedback-evaluate": "Feedback: evaluate", "feedback-address": "Feedback: address" };

// The DOM is the draft; Save reads it back.
function row(p: Preset) {
  const kind = el("select", { name: "kind" }, ...PRESET_KINDS.map((k) => el("option", { value: k, textContent: KIND_LABELS[k] })));
  kind.value = p.kind;
  const remove = el("button", { textContent: "Remove" });
  const node = el(
    "div",
    { className: "preset" },
    el("div", { className: "row" }, el("input", { name: "label", value: p.label, placeholder: "Label" }), kind, el("input", { name: "provider", value: p.provider ?? "", placeholder: "Provider (any)" }), remove),
    el("textarea", { name: "prompt", value: p.prompt }),
  );
  remove.onclick = () => node.remove();
  return node;
}

const render = (presets: Preset[]) => list.replaceChildren(...presets.map(row));

function read(): Preset[] {
  return [...list.children].flatMap((n) => {
    const v = (name: string) => (n.querySelector(`[name=${name}]`) as HTMLInputElement).value.trim();
    const provider = v("provider");
    return v("label") && v("prompt") ? [{ label: v("label"), kind: v("kind") as Preset["kind"], ...(provider ? { provider } : {}), prompt: v("prompt") }] : [];
  });
}

$("add").onclick = () => list.append(row({ label: "", kind: "review", prompt: "" }));
$("reset").onclick = () => render(DEFAULT_PRESETS);
$("save").onclick = async () => {
  try {
    // ponytail: one sync item holds every preset, so they share its 8 KB cap; split per preset if that's hit.
    await chrome.storage.sync.set({ presets: read() });
    saved.textContent = "Saved";
  } catch (err) {
    saved.textContent = `Not saved: ${err instanceof Error ? err.message : String(err)}`;
  }
  setTimeout(() => (saved.textContent = ""), 3000);
};

void chrome.storage.sync.get({ presets: DEFAULT_PRESETS }).then((r) => render(Array.isArray(r.presets) ? r.presets : DEFAULT_PRESETS));

// Inbox: section names come from the last inbox the panel saw.
void Promise.all([loadInboxSettings(), chrome.storage.local.get("inboxSections")]).then(([s, { inboxSections }]) => {
  inboxStyles();
  fillSettings($("inbox-options"), orderSections(Array.isArray(inboxSections) ? inboxSections : [], s), s);
});
