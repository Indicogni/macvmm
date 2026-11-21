// exception-stepper: the view. Renders the model's state; turns clicks into model actions.
// DOM is built with createElement/textContent only (no innerHTML), and nothing outside `el`
// is touched except ctx.hash. See course/site/LABS.md.
import {
  CAUSES, CAUSE_LABEL, initialState, step, rows, summary, notes, plan, canTake, canEret,
  encodeHash, decodeHash, hex,
} from "./model.mjs";
import { decodePstate } from "./pstate.mjs";

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid) n.append(kid);
  return n;
}

const LEVELS = [
  { el: 2, text: "EL2: the hypervisor level (on a Mac, Apple's software)" },
  { el: 1, text: "EL1: the kernel" },
  { el: 0, text: "EL0: apps" },
];

export function mount(el, ctx) {
  const id = ctx.id || "lab-exception-stepper";
  let state;
  try {
    state = ctx.hash && ctx.hash.get() ? decodeHash(ctx.hash.get()) : initialState();
  } catch {
    state = initialState();
  }

  const root = h("div", { class: "es" + (ctx.reducedMotion ? " es--still" : "") });

  // --- controls ---------------------------------------------------------------------------
  const srcRadios = [0, 1].map((lvl) =>
    h("input", { type: "radio", name: `${id}-src`, id: `${id}-src${lvl}`, value: String(lvl) }));
  const srcSet = h("fieldset", { class: "es__group" },
    h("legend", { text: "Where the code runs" }),
    ...srcRadios.map((r, i) => h("label", { class: "es__choice", for: r.id }, r,
      document.createTextNode(i === 0 ? " an app, at EL0" : " the kernel, at EL1"))));

  const causeSel = h("select", { id: `${id}-cause` },
    ...CAUSES.map((c) => h("option", { value: c, text: CAUSE_LABEL[c] })));
  const causeBox = h("div", { class: "es__group" },
    h("label", { for: causeSel.id, text: "What happens" }), causeSel);

  const irqRadios = [1, 2].map((lvl) =>
    h("input", { type: "radio", name: `${id}-irq`, id: `${id}-irq${lvl}`, value: String(lvl) }));
  const irqSet = h("fieldset", { class: "es__group" },
    h("legend", { text: "The interrupt is routed to" }),
    ...irqRadios.map((r, i) => h("label", { class: "es__choice", for: r.id }, r,
      document.createTextNode(i === 0 ? " the kernel (EL1)" : " the hypervisor level (EL2)"))));

  const maskBox = h("input", { type: "checkbox", id: `${id}-mask` });
  const maskLabel = h("label", { class: "es__choice", for: maskBox.id }, maskBox,
    document.createTextNode(" the kernel has switched interrupts off (masked)"));

  const namesBox = h("input", { type: "checkbox", id: `${id}-names` });
  const namesLabel = h("label", { class: "es__choice", for: namesBox.id }, namesBox,
    document.createTextNode(" show the register names"));

  const takeBtn = h("button", { type: "button", class: "es__btn es__btn--primary", text: "Step: take the exception" });
  const eretBtn = h("button", { type: "button", class: "es__btn", text: "ERET" });
  const resetBtn = h("button", { type: "button", class: "es__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "es__btn", text: "Copy link to this state" });
  const buttons = h("div", { class: "es__buttons" }, takeBtn, eretBtn, resetBtn, shareBtn);

  const controls = h("div", { class: "es__controls" }, srcSet, causeBox, irqSet, maskLabel, namesLabel, buttons);

  // --- visualization -------------------------------------------------------------------
  const instr = h("p", { class: "es__instr" });
  const ladderItems = LEVELS.map((L) => {
    const marker = h("span", { class: "es__marker" });
    const li = h("li", { class: "es__level" }, h("span", { text: L.text }), marker);
    return { ...L, li, marker };
  });
  const ladder = h("ol", { class: "es__ladder", "aria-label": "Exception levels, most privileged first" },
    ...ladderItems.map((x) => x.li));

  const tbody = h("tbody");
  const table = h("table", { class: "es__table" },
    h("caption", { text: "CPU state" }),
    h("thead", {}, h("tr", {},
      h("th", { scope: "col" }, h("span", { class: "es__sr-only", text: "register" })),
      h("th", { scope: "col", text: "at the start" }),
      h("th", { scope: "col", text: "now" }))),
    tbody);
  // Focusable and named so keyboard users can scroll it if it ever overflows (axe:
  // scrollable-region-focusable). Below 480px the "at the start" column is dropped (style.css).
  const tableWrap = h("div", { class: "es__scroll", tabindex: "0", role: "region", "aria-label": "CPU state table" }, table);
  const viz = h("div", { class: "es__viz" }, instr, ladder, tableWrap);

  // --- readout -------------------------------------------------------------------------
  const live = h("p", { class: "es__summary", "aria-live": "polite", "aria-atomic": "true" });
  // Transient messages (share) go here, never into the summary node.
  const status = h("p", { class: "es__sr-only", role: "status" });
  const noteList = h("ul", { class: "es__notes" });
  const readout = h("div", { class: "es__readout" }, h("h3", { class: "es__h", text: "Readout" }), live, status, noteList);

  root.append(controls, viz, readout);
  el.replaceChildren(root);

  // --- render --------------------------------------------------------------------------
  function render() {
    const p = plan(state);
    srcRadios.forEach((r, i) => { r.checked = state.src === i; });
    causeSel.value = state.cause;
    irqRadios.forEach((r, i) => { r.checked = state.irqTo === i + 1; });
    irqSet.hidden = state.cause !== "irq";
    maskBox.checked = state.masked;
    maskLabel.hidden = !(state.cause === "irq" && state.src === 1);
    namesBox.checked = state.names;
    takeBtn.disabled = !canTake(state);
    eretBtn.disabled = !canEret(state);

    const who = state.src === 0 ? "the app, EL0" : "the kernel, EL1";
    const lead = state.cause === "irq"
      ? `Where the interrupt arrives (${who}, at ${hex(p.pc)}): `
      : `The instruction that causes the exception (${who}, at ${hex(p.pc)}): `;
    instr.replaceChildren(document.createTextNode(lead), h("code", { text: p.instr }));
    if (p.instrNote) instr.append(document.createTextNode(state.cause === "irq" ? `, ${p.instrNote}` : ` ${p.instrNote}`));

    const curEl = decodePstate(state.cpu.pstate).el;
    for (const x of ladderItems) {
      const here = x.el === curEl;
      x.li.classList.toggle("es__level--here", here);
      x.marker.textContent = here ? "running here" : "";
      if (here) x.li.setAttribute("aria-current", "true");
      else x.li.removeAttribute("aria-current");
    }

    tbody.replaceChildren(...rows(state).map((r) => {
      const label = h("th", { scope: "row" }, document.createTextNode(r.label));
      if (state.names && r.reg !== r.label) label.append(h("span", { class: "es__reg", text: ` ${r.reg}` }));
      const now = h("td", { class: r.changed ? "es__cell es__cell--changed" : "es__cell" },
        h("span", { class: "es__val", text: r.now }));
      if (r.changed) now.append(h("span", { class: "es__badge", text: "changed" }));
      if (r.detail) now.append(h("span", { class: "es__detail", text: r.detail }));
      return h("tr", {}, label, h("td", { class: "es__cell" }, h("span", { class: "es__val", text: r.before })), now);
    }));

    const sum = summary(state);
    if (live.textContent !== sum) live.textContent = sum; // no re-announce when nothing changed
    status.textContent = "";
    noteList.replaceChildren(...(state.phase === "before" ? [] : notes(state)).map((t) => h("li", { text: t })));
  }

  function update(action, opts = {}) {
    state = step(state, action);
    render();
    if (opts.share !== false) {
      try { ctx.hash && ctx.hash.set(encodeHash(state)); } catch { /* sharing is optional */ }
    }
  }

  // --- events (all inside el) ------------------------------------------------------------
  srcRadios.forEach((r, i) => r.addEventListener("change", () => update({ type: "setSource", el: i })));
  causeSel.addEventListener("change", () => update({ type: "setCause", cause: causeSel.value }));
  irqRadios.forEach((r, i) => r.addEventListener("change", () => update({ type: "setIrqTo", el: i + 1 })));
  maskBox.addEventListener("change", () => update({ type: "setMasked", on: maskBox.checked }));
  namesBox.addEventListener("change", () => update({ type: "setNames", on: namesBox.checked }));
  takeBtn.addEventListener("click", () => {
    update({ type: "take" });
    // Never leave focus on the Step button that was just disabled.
    if (canEret(state)) eretBtn.focus();
    else if (state.phase === "pending") maskBox.focus();
    else resetBtn.focus();
  });
  eretBtn.addEventListener("click", () => {
    update({ type: "eret" });
    resetBtn.focus();
  });
  resetBtn.addEventListener("click", () => {
    update({ type: "reset" });
    takeBtn.focus();
  });
  shareBtn.addEventListener("click", async () => {
    try { ctx.hash && ctx.hash.set(encodeHash(state)); } catch { /* ignore */ }
    let copied = false;
    try {
      if (navigator.clipboard && typeof location !== "undefined") {
        await navigator.clipboard.writeText(location.href);
        copied = true;
      }
    } catch { /* clipboard may be refused; the address bar still holds the link */ }
    const msg = copied ? "Link copied." : "The link to this state is in the address bar.";
    if (ctx.announce) ctx.announce(msg);
    else status.textContent = msg;
  });

  render();
  return { destroy() { el.replaceChildren(); } };
}
