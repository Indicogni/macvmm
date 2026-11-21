// pstate-builder view: renders the model's state and turns events into model steps.
//
// Three ways to change the value, all sending the same model actions:
//   1. type a hex value (or pick a preset);
//   2. click a bit in the 32-bit bar (an ARIA toolbar with roving tabindex: arrow keys move, Space or Enter toggles);
//   3. use the named field controls (level, stack select, D A I F, N Z C V).
// DOM is built with createElement/textContent only. Nothing typed or read from the hash reaches the
// page except through parseHex()/decode(), which accept at most 8 hex digits.
import {
  BITS,
  PRESETS,
  DAIF_BITS,
  FLAG_BITS,
  initialState,
  step,
  describe,
  summary,
  changeText,
  parseHex,
  encode,
  decode,
  hex,
} from "./model.mjs";

const ANNOUNCE_GAP_MS = 300;

const MASK_WORDS = { D: "debug", A: "SError", I: "IRQ", F: "FIQ" };
const FLAG_WORDS = { N: "negative", Z: "zero", C: "carry", V: "overflow" };

/** Small element builder: h("p", {class: "x"}, "text", child, ...). Attributes are set, never parsed. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function mount(el, ctx) {
  let state = decode(ctx.hash.get()) ?? initialState();
  const pid = ctx.id;

  // ---- throttled announcements (about one per 300 ms; the last message wins) ----
  let lastSpoke = 0;
  let pendingTimer = null;
  let pendingText = "";
  function say(text) {
    pendingText = text;
    const now = Date.now();
    const wait = lastSpoke + ANNOUNCE_GAP_MS - now;
    if (wait <= 0 && pendingTimer === null) {
      lastSpoke = now;
      ctx.announce(text);
      return;
    }
    if (pendingTimer === null) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastSpoke = Date.now();
        ctx.announce(pendingText);
      }, Math.max(wait, 0));
    }
  }

  // ---- value box, presets, reset, copy ----
  const inputId = `${pid}-hex`;
  const errId = `${pid}-hex-err`;
  const input = h("input", {
    id: inputId,
    class: "psb__input",
    type: "text",
    inputmode: "text",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: "32",
    "aria-describedby": errId,
  });
  const setBtn = h("button", { type: "submit", class: "psb__btn psb__btn--primary", text: "Set" });
  const inputErr = h("p", { class: "psb__err", id: errId });
  const form = h(
    "form",
    { class: "psb__form", novalidate: true },
    h("label", { class: "psb__label", for: inputId, text: "Value (hex)" }),
    h("div", { class: "psb__row" }, input, setBtn),
    inputErr,
  );

  const presetId = `${pid}-preset`;
  const preset = h("select", { id: presetId, class: "psb__select" });
  preset.append(h("option", { value: "", text: "Choose a value to try" }));
  for (const p of PRESETS) preset.append(h("option", { value: hex(p.value), text: p.label }));
  const presetBox = h("div", { class: "psb__form" }, h("label", { class: "psb__label", for: presetId, text: "Try" }), preset);

  const resetBtn = h("button", { type: "button", class: "psb__btn", text: "Reset to 0x3c5" });
  const copyBtn = h("button", { type: "button", class: "psb__btn", text: "Copy link to this value" });
  const controls = h("div", { class: "psb__controls" }, form, presetBox, h("div", { class: "psb__buttons" }, resetBtn, copyBtn));

  // ---- the 32-bit bar ----
  const barHelpId = `${pid}-barhelp`;
  const bar = h("div", {
    class: "psb__bar",
    role: "toolbar",
    "aria-orientation": "horizontal",
    "aria-label": "PSTATE bits 31 to 0",
    "aria-describedby": barHelpId,
  });
  const groups = [
    { from: 31, to: 28, text: "N Z C V flags" },
    { from: 27, to: 10, text: "mostly not used here" },
    { from: 9, to: 6, text: "D A I F masks" },
    { from: 5, to: 5, text: "" },
    { from: 4, to: 0, text: "M[4:0] mode" },
  ];
  // Grid placement without inline styles (CSP forbids style attributes): one class per column span.
  // Bit b sits in grid column 32 - b, so bits from..to span columns (32 - from) to (33 - to).
  for (const g of groups) {
    bar.append(h("span", { class: `psb__group psb__g--${32 - g.from}-${33 - g.to}`, "aria-hidden": "true", text: g.text }));
  }
  const cells = [];
  BITS.forEach((b, i) => {
    const btn = h("button", {
      type: "button",
      class: `psb__bit${b.modelled ? "" : " psb__bit--unused"}`,
      "data-bit": b.bit,
      tabindex: i === BITS.length - 1 ? "0" : "-1",
    });
    const label = h("span", { class: "psb__bitname", "aria-hidden": "true", text: b.short || "·" });
    const val = h("span", { class: "psb__bitval", "aria-hidden": "true" });
    const num = h("span", { class: "psb__bitnum", "aria-hidden": "true", text: String(b.bit) });
    btn.append(label, val, num);
    cells.push({ b, btn, val });
    bar.append(btn);
  });
  // Under M3 and M2: the 2-bit level read as one number ("01 = EL1"). Shown, not spoken: the
  // cells' accessible names carry the place values and the readout says the level.
  const elCaption = h("span", { class: "psb__elcap psb__g--29-31", "aria-hidden": "true" });
  bar.append(elCaption);
  const scroller = h("div", { class: "psb__scroll" }, bar);
  const barBox = h(
    "div",
    { class: "psb__barbox" },
    h("p", { class: "psb__help", id: barHelpId, text: "Click a bit to flip it. With the keyboard: Tab into the bar, arrow keys move, Home and End jump, Space or Enter flips." }),
    h("p", { class: "psb__scrollcue", "aria-hidden": "true", text: "The bar scrolls sideways: the N Z C V flags and bits 31 to 10 are to the left." }),
    scroller,
  );

  // ---- named fields ----
  const levelName = `${pid}-el`;
  const levelRadios = [0, 1, 2, 3].map((el) => {
    const id = `${pid}-el${el}`;
    const r = h("input", { type: "radio", name: levelName, id, value: String(el), class: "psb__check" });
    return { el, r, wrap: h("label", { class: "psb__opt", for: id }, r, ` EL${el}`) };
  });
  const spId = `${pid}-sp`;
  const spBox = h("input", { type: "checkbox", id: spId, class: "psb__check" });
  const spHint = h("span", { class: "psb__hint" });
  const maskBoxes = Object.keys(DAIF_BITS).map((k) => {
    const id = `${pid}-m${k}`;
    const c = h("input", { type: "checkbox", id, class: "psb__check", "data-mask": k });
    return { k, c, wrap: h("label", { class: "psb__opt", for: id }, c, ` ${k} (${MASK_WORDS[k]})`) };
  });
  const flagBoxes = Object.keys(FLAG_BITS).map((k) => {
    const id = `${pid}-f${k}`;
    const c = h("input", { type: "checkbox", id, class: "psb__check", "data-flag": k });
    return { k, c, wrap: h("label", { class: "psb__opt", for: id }, c, ` ${k} (${FLAG_WORDS[k]})`) };
  });
  const fields = h(
    "div",
    { class: "psb__fields" },
    h("fieldset", { class: "psb__fs" }, h("legend", { text: "Exception level (bits 3 to 2)" }), ...levelRadios.map((x) => x.wrap)),
    h(
      "fieldset",
      { class: "psb__fs" },
      h("legend", { text: "Stack pointer (bit 0)" }),
      h("label", { class: "psb__opt", for: spId }, spBox, " Use the level's own stack pointer"),
      spHint,
    ),
    h("fieldset", { class: "psb__fs" }, h("legend", { text: "Masked: 1 holds that kind off (bits 9 to 6)" }), ...maskBoxes.map((x) => x.wrap)),
    h("fieldset", { class: "psb__fs" }, h("legend", { text: "Condition flags (bits 31 to 28)" }), ...flagBoxes.map((x) => x.wrap)),
  );

  // ---- readout ----
  const big = h("p", { class: "psb__big" });
  const dl = h("dl", { class: "psb__dl" });
  const sumLine = h("p", { class: "psb__summary", id: `${pid}-summary` });
  const readout = h(
    "div",
    { class: "psb__readoutbox" },
    h("span", { class: "psb__rlabel", text: "Readout" }),
    big,
    sumLine,
    dl,
  );

  const tryList = h(
    "ol",
    { class: "psb__try" },
    h("li", {}, "Set the value to 0, then build 0x3c5 with the named fields: mask D A I F, pick EL1, tick the own stack pointer. Watch Built from match the lesson's sum."),
    h("li", {}, "Find the single bit that turns 0x3c5 into 0x3c4, and read what happened when our VMM booted that value."),
    h("li", {}, "From 0x3c5, pick EL2 and read why HVF refused 0x3c9."),
  );
  el.append(
    h("p", { class: "psb__help", text: "PSTATE in SPSR layout, the value our VMM writes as a vCPU's CPSR." }),
    h("p", { class: "psb__trytitle", text: "Try this" }),
    tryList,
    controls,
    barBox,
    h("div", { class: "psb__body" }, fields, readout),
  );

  // ---- state changes ----
  function apply(action) {
    const next = step(state, action);
    if (next === state) return false;
    const prev = state.value;
    state = next;
    if (next.value === prev) {
      render();
      return false;
    }
    ctx.hash.set(encode(state));
    render();
    let text = changeText(prev, state.value);
    if (action.type === "level" && action.el === 0 && state.savedSp) text += ". EL0 cleared the stack-pointer bit; picking EL1 or above turns it back on";
    say(text);
    return true;
  }

  // ---- rendering ----
  function code(text) {
    return h("code", { class: "psb__code", text });
  }

  function render() {
    const x = describe(state.value);
    if (document.activeElement !== input) input.value = x.hex;
    input.removeAttribute("aria-invalid");
    inputErr.textContent = "";
    preset.value = PRESETS.some((p) => p.value === x.value) ? x.hex : "";

    for (const { b, btn, val } of cells) {
      const on = ((x.value >>> b.bit) & 1) === 1;
      val.textContent = on ? "1" : "0";
      btn.classList.toggle("psb__bit--on", on);
      btn.classList.toggle("psb__bit--bad", on && !b.modelled);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("aria-label", `bit ${b.bit}, ${b.name}${on && !b.modelled ? ", set but should be 0" : ""}`);
    }
    elCaption.textContent = x.value & 0x10 ? "" : `${((x.value >>> 2) & 3).toString(2).padStart(2, "0")} = EL${x.el}`;

    for (const { el: lv, r } of levelRadios) r.checked = x.el === lv;
    spBox.checked = (x.value & 1) === 1;
    spBox.disabled = x.el === 0 && (x.value & 1) === 0;
    if (x.el === 0) {
      spHint.textContent = state.savedSp
        ? "EL0 has only SP_EL0, so picking EL0 cleared this bit. Picking EL1 or above turns it back on."
        : "EL0 has only SP_EL0, so there is no own stack to pick.";
    } else {
      spHint.textContent = `On: sp means SP_EL${x.el} ("h"). Off: sp means SP_EL0 ("t").`;
    }
    for (const { k, c } of maskBoxes) c.checked = x.masked.includes(k);
    for (const { k, c } of flagBoxes) c.checked = x.flags.includes(k);

    big.replaceChildren(code(x.hex), " = ", x.ok ? h("strong", { text: x.mode }) : h("strong", { class: "psb__bad", text: "not a mode we use" }));
    sumLine.textContent = summary(x.value);

    const rows = [];
    const row = (k, ...v) => rows.push(h("dt", { text: k }), h("dd", {}, ...v));
    if (!x.ok) row("Problem", h("span", { class: "psb__bad" }, h("span", { class: "psb__mark", "aria-hidden": "true", text: "!" }), ` ${x.error}.`));
    if (x.value & 0x10) row("M[3:0]", code(x.m30), " (bit 4 set: M[4:0] is an AArch32 mode number, so there is no EL or stack choice to read)");
    else row("M[3:0]", code(x.m30), x.ok ? ` = EL${x.el}, sp means ${x.stack}` : "");
    row("Masked", x.masked.length ? x.masked.map((k) => `${k} (${MASK_WORDS[k]})`).join(", ") : "nothing", x.unmasked.length && x.masked.length ? `; not masked: ${x.unmasked.join(" ")}` : "");
    row("Flags", x.flags.length ? `${x.flags.join(" ")} set` : "none set");
    if (x.cpuBits.length) row("Also set", `${x.cpuBits.join(" and ")} (the CPU sets these on exception entry; see the Aside). Neither changes the mode.`);

    const steps = h("ol", { class: "psb__steps" });
    for (const t of x.steps.terms) steps.append(h("li", {}, `${t.what}: `, code(hex(t.value)), t.detail !== hex(t.value) ? h("span", { class: "psb__muted", text: ` (${t.detail})` }) : ""));
    row("Built from", x.steps.terms.length ? steps : "", code(x.steps.formula));

    if (x.ok && x.readsNote) {
      row("The guest reads", x.readsNote);
    } else if (x.ok) {
      const reads = h("ul", { class: "psb__reads" });
      for (const r of x.reads) {
        if (r.value === null) reads.append(h("li", {}, code(r.insn), `: ${r.note}`));
        else reads.append(h("li", {}, code(r.insn), " gives ", code(hex(r.value)), h("span", { class: "psb__muted", text: ` (${r.note})` })));
      }
      row("The guest reads", reads);
    }
    row("Register dump prints", code(x.dump));

    if (x.observed) {
      row("As our boot CPSR", "Seen on a real Mac in chapter 06: ", x.observed.text, h("br"), code(x.observed.lastLine));
    } else {
      row("As our boot CPSR", "Chapter 06 ran only 0x3c5, 0x3c4 and 0x3c9 as boot values; this one was not run.", x.hvfNote ? ` ${x.hvfNote}` : "");
    }
    dl.replaceChildren(...rows);
  }

  // ---- events ----
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const r = parseHex(input.value);
    if (!r.ok) {
      input.setAttribute("aria-invalid", "true");
      inputErr.textContent = `Not set: ${r.error}.`;
      say(`Not set: ${r.error}.`);
      return;
    }
    if (!apply({ type: "set", value: r.value })) {
      input.value = hex(state.value);
      say(changeText(state.value, state.value));
    }
  });
  input.addEventListener("blur", () => {
    if (input.getAttribute("aria-invalid") !== "true") input.value = hex(state.value);
  });

  preset.addEventListener("change", () => {
    const r = parseHex(preset.value);
    if (r.ok) apply({ type: "set", value: r.value });
  });

  resetBtn.addEventListener("click", () => {
    if (!apply({ type: "reset" })) say(`Already 0x3c5. ${changeText(state.value, state.value).replace(/^no change: /, "")}`);
  });

  copyBtn.addEventListener("click", async () => {
    ctx.hash.set(encode(state));
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(location.href);
      say(`Link copied. It reopens the lab at ${hex(state.value)}.`);
    } catch {
      say("Could not copy here. The address bar already holds a link to this value.");
    }
  });

  // Bit bar: click toggles, arrows rove (ARIA APG toolbar-style roving tabindex).
  function focusCell(i) {
    const j = Math.max(0, Math.min(cells.length - 1, i));
    for (const c of cells) c.btn.tabIndex = -1;
    cells[j].btn.tabIndex = 0;
    cells[j].btn.focus();
  }
  bar.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".psb__bit") : null;
    if (!btn || !bar.contains(btn)) return;
    const bit = Number(btn.dataset.bit);
    for (const c of cells) c.btn.tabIndex = c.btn === btn ? 0 : -1;
    apply({ type: "toggle", bit });
  });
  bar.addEventListener("keydown", (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".psb__bit") : null;
    if (!btn) return;
    const i = cells.findIndex((c) => c.btn === btn);
    const moves = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: cells.length - 1 };
    if (Object.hasOwn(moves, e.key)) {
      e.preventDefault();
      focusCell(moves[e.key]);
    }
  });

  fields.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.type === "radio" && t.name === levelName) apply({ type: "level", el: Number(t.value) });
    else if (t === spBox) {
      if (!apply({ type: "ownSp", on: t.checked })) {
        t.checked = (state.value & 1) === 1;
        say("EL0 has no stack pointer of its own; pick EL1 or above first.");
      }
    } else if (t.dataset.mask) apply({ type: "mask", key: t.dataset.mask, on: t.checked });
    else if (t.dataset.flag) apply({ type: "flag", key: t.dataset.flag, on: t.checked });
  });

  render();
  // The first readout is shown, not spoken: announcing on page load is noise.
  // On a narrow screen the bar scrolls; start at the right end, where D A I F and M[4:0] are.
  if (typeof scroller.scrollWidth === "number" && scroller.scrollWidth > 0) scroller.scrollLeft = scroller.scrollWidth;

  return {
    destroy() {
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = null;
    },
  };
}
