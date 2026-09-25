// A command's argument hint as form controls, for the panel's command form and the options page's defaults.
import type { ArgSpec, ArgValues } from "./actions";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// One control per hint part in its order (none for the target: scope decides it), then a free-text box.
export function argControls(spec: ArgSpec, values: ArgValues, onInput = () => {}) {
  const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : "");
  const tag = <T extends HTMLElement>(node: T, key: string) => ((node.dataset.arg = key), node);
  const controls = spec.parts.flatMap((p): HTMLElement[] => {
    if (p.kind === "target") return [];
    if (p.kind === "flag") return [el("label", { className: "check" }, tag(el("input", { type: "checkbox", checked: !!values[p.key] }), p.key), p.key)];
    if (p.kind === "text") return [tag(el("input", { placeholder: p.key, title: p.key, required: p.required, value: str(p.key) }), p.key)];
    const s = el("select", { title: `[${p.key}]` }, ...(p.required ? [] : [el("option", { value: "", textContent: "default" })]), ...p.options.map((o) => el("option", { value: o, textContent: o })));
    s.value = str(p.key) || (p.required ? p.options[0] : "");
    return [tag(s, p.key)];
  });
  const extra = tag(el("input", { placeholder: spec.extra ? `more: ${spec.extra}` : "extra args", title: spec.extra, value: str("extra"), className: "extra" }), "extra");
  const box = el("div", { className: "args" }, ...controls, extra);
  box.oninput = box.onchange = onInput;
  return box;
}

export function readArgs(box: Element): ArgValues {
  const out: ArgValues = {};
  for (const i of box.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-arg]")) {
    const v = i instanceof HTMLInputElement && i.type === "checkbox" ? i.checked : i.value.trim();
    if (v) out[i.dataset.arg!] = v;
  }
  return out;
}
