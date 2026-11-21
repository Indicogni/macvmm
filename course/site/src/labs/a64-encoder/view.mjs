// a64-encoder: view. Builds DOM once, then `render(state)` updates it. All logic is in model.mjs.
// CSP: no inline handlers, no innerHTML, no network. Element ids derive from ctx.id.

import {
  FAMILIES, OPS, OP_NAMES, PRESETS, PROGRAM, changedBits, decode, fieldMeaning,
  fromShare, hex32, initialState, leBytes, step, summary, toShare,
} from "./model.mjs";

const INITIAL_SHARE = toShare(initialState());

/** Tiny element builder: h("p", {class: "x"}, "text", child). Text is always textContent. */
function make(doc) {
  return function h(tag, attrs = {}, ...kids) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      if (typeof kid === "string") el.appendChild(doc.createTextNode(kid));
      else el.appendChild(kid);
    }
    return el;
  };
}

/** Field strip used by the overview: one box per field, name above, bits below. */
function fieldStrip(h, d, compact) {
  const strip = h("div", { class: "a64__strip" + (compact ? " a64__strip--compact" : "") });
  for (const f of d.fields) {
    const box = h("div", {
      class: "a64__sfield" + (f.fixed !== undefined ? " is-fixed" : ""),
      "data-w": String(f.width),
    },
    h("span", { class: "a64__sname" }, f.fixed !== undefined ? "fixed" : f.name),
    h("span", { class: "a64__sbits" }, f.binary),
    h("span", { class: "a64__srange" }, f.hi === f.lo ? `bit ${f.hi}` : `${f.hi}..${f.lo}`));
    box.style.flexGrow = String(f.width);
    strip.appendChild(box);
  }
  return strip;
}

export function mount(el, ctx) {
  const doc = el.ownerDocument;
  const h = make(doc);
  const id = (s) => `${ctx.id}-${s}`;
  let state;
  try {
    state = fromShare(ctx.hash.get());
  } catch {
    state = initialState();
  }

  // ---- announce, throttled to one call per 300 ms (LABS.md section 2)
  let lastAnnounce = 0;
  let pendingTimer = null;
  function announce(text) {
    const now = Date.now();
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    const wait = Math.max(0, 300 - (now - lastAnnounce));
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      lastAnnounce = Date.now();
      ctx.announce(text);
    }, wait);
  }

  const root = h("div", { class: "a64" + (ctx.reducedMotion ? " is-reduced" : "") });

  // ---- overview: chapter 02's guest, field by field (the first screen shows all three layouts)
  const overview = h("div", { class: "a64__overview" },
    h("h3", { class: "a64__h" }, "Chapter 02's guest, field by field"),
    h("p", { class: "a64__hint" },
      "Fixed bits say which instruction a word is; the other fields carry a register number or a constant. Pick a row to take it apart below."));
  const progList = h("ol", { class: "a64__program" });
  for (const p of PROGRAM) {
    const d = decode(p.word, p.addr);
    const btn = h("button", { type: "button", class: "a64__btn a64__btn--small" }, "Take apart");
    btn.setAttribute("aria-label", `Take apart ${d.asm}`);
    btn.addEventListener("click", () => {
      const preset = PRESETS.find((x) => x.word === p.word && x.mode === "encode");
      if (preset) update({ type: "preset", id: preset.id });
      // Start the reader at the left of the word (bit 31 side). The heading's name is short, so
      // the summary stays the one real announcement.
      bitsHeading.focus();
    });
    progList.appendChild(h("li", { class: "a64__prow" },
      h("div", { class: "a64__phead" },
        h("code", {}, "0x" + p.addr.toString(16)),
        h("code", { class: "a64__pword" }, hex32(p.word)),
        h("code", { class: "a64__pasm" }, d.asm),
        h("span", { class: "a64__pwhy" }, p.why),
        btn),
      fieldStrip(h, d, true),
      h("p", { class: "a64__family" }, FAMILIES[d.family].title)));
  }
  overview.appendChild(progList);

  // ---- controls
  const modeName = id("mode");
  const modeEncode = h("input", { type: "radio", name: modeName, id: id("mode-e"), value: "encode" });
  const modeDecode = h("input", { type: "radio", name: modeName, id: id("mode-d"), value: "decode" });
  const modeSet = h("fieldset", { class: "a64__modes" },
    h("legend", {}, "Mode"),
    h("label", { for: id("mode-e") }, modeEncode, " Encode: fields to word"),
    h("label", { for: id("mode-d") }, modeDecode, " Decode: word to fields"));

  const opSelect = h("select", { id: id("op") });
  for (const name of OP_NAMES) opSelect.appendChild(h("option", { value: name }, OPS[name].label));

  const sfSelect = h("select", { id: id("sf") },
    h("option", { value: "1" }, "x: 64-bit (sf = 1)"),
    h("option", { value: "0" }, "w: 32-bit (sf = 0)"));
  const rdInput = h("input", { id: id("rd"), type: "text", inputmode: "numeric", autocomplete: "off", spellcheck: "false", size: "4" });
  const immInput = h("input", { id: id("imm16"), type: "text", autocomplete: "off", spellcheck: "false", size: "8" });
  const hwSelect = h("select", { id: id("hw") },
    h("option", { value: "0" }, "none (hw = 00)"),
    h("option", { value: "1" }, "lsl #16 (hw = 01)"),
    h("option", { value: "2" }, "lsl #32 (hw = 10)"),
    h("option", { value: "3" }, "lsl #48 (hw = 11)"));
  const offInput = h("input", { id: id("offset"), type: "text", autocomplete: "off", spellcheck: "false", size: "10" });
  const hexInput = h("input", { id: id("hex"), type: "text", autocomplete: "off", spellcheck: "false", size: "12" });
  const pcInput = h("input", { id: id("pc"), type: "text", autocomplete: "off", spellcheck: "false", size: "18" });
  const revealBtn = h("button", { type: "button", class: "a64__btn", "aria-label": "Tell me what this word is" }, "Tell me");

  const field = (key, labelText, control, help) => h("div", { class: "a64__field", "data-key": key },
    h("label", { for: control.getAttribute("id") }, labelText),
    control,
    help ? h("span", { class: "a64__help", id: id(key + "-help") }, help) : null);

  const rowOp = field("op", "Instruction", opSelect);
  const rowSf = field("sf", "Register size", sfSelect);
  const rowRd = field("rd", "Register number (Rd)", rdInput, "0 to 31");
  const rowImm = field("imm16", "Constant (imm16)", immInput, "0 to 0xffff, decimal or 0x hex");
  const rowHw = field("hw", "Shift", hwSelect);
  const rowOff = field("offset", "Offset in bytes", offInput, "multiple of 4, may be negative: -36 or -0x24");
  const rowHex = field("hex", "Instruction word (hex)", hexInput, "for example d4000003 or 0x97fffff7, or four bytes as a dump prints them: 40 05 80 d2");
  const rowPc = field("pc", "Address of this instruction", pcInput, "used to print the branch target; the bits store only the distance");
  for (const [inp, key] of [[rdInput, "rd"], [immInput, "imm16"], [offInput, "offset"], [hexInput, "hex"], [pcInput, "pc"]]) {
    inp.setAttribute("aria-describedby", id(key + "-help") + " " + id("error"));
  }

  const presetSelect = h("select", { id: id("preset") }, h("option", { value: "" }, "Choose an example"));
  for (const p of PRESETS) presetSelect.appendChild(h("option", { value: p.id }, p.label));
  const rowPreset = field("preset", "Examples from the lessons", presetSelect);

  const errorLine = h("p", { class: "a64__error", id: id("error") });
  const noteLine = h("p", { class: "a64__note" });

  const controls = h("div", { class: "a64__controls" },
    modeSet, rowPreset, rowOp, rowSf, rowRd, rowImm, rowHw, rowOff, rowHex,
    h("div", { class: "a64__revealrow" }, revealBtn), rowPc, errorLine, noteLine);

  // ---- visualization: the 32 bits, with the field layout above them
  const gridHelp = h("p", { class: "a64__hint", id: id("grid-help") },
    "Bit 31 is on the left. Left and Right arrows move between bits; Space or Enter flips one. Hatched fields are fixed.");
  const fieldRow = h("div", { class: "a64__fields", "aria-hidden": "true" });
  const bitRow = h("div", { class: "a64__bits", role: "group", "aria-label": "The 32 bits of the instruction word, bit 31 first", "aria-describedby": id("grid-help") });
  const numRow = h("div", { class: "a64__nums", "aria-hidden": "true" });
  const bitButtons = [];
  let focusBit = 31;
  for (let b = 31; b >= 0; b--) {
    const btn = h("button", { type: "button", class: "a64__bit", tabindex: b === focusBit ? "0" : "-1" });
    btn.style.gridColumn = String(32 - b);
    btn.addEventListener("click", () => {
      focusBit = b;
      update({ type: "toggle", bit: b });
    });
    btn.addEventListener("focus", () => {
      focusBit = b;
      for (let i = 0; i < 32; i++) bitButtons[i].setAttribute("tabindex", i === b ? "0" : "-1");
    });
    bitButtons[b] = btn;
    bitRow.appendChild(btn);
    const n = h("span", { class: "a64__num" }, String(b));
    n.style.gridColumn = String(32 - b);
    numRow.appendChild(n);
  }
  bitRow.addEventListener("keydown", (ev) => {
    let target = null;
    if (ev.key === "ArrowLeft") target = Math.min(31, focusBit + 1);
    else if (ev.key === "ArrowRight") target = Math.max(0, focusBit - 1);
    else if (ev.key === "Home") target = 31;
    else if (ev.key === "End") target = 0;
    if (target === null) return;
    ev.preventDefault();
    bitButtons[target].focus();
  });
  const grid = h("div", { class: "a64__scroll a64__gridwrap" }, h("div", { class: "a64__grid" }, fieldRow, bitRow, numRow));
  const bitsHeading = h("h3", { class: "a64__h", tabindex: "-1" }, "Bits");
  const viz = h("div", { class: "a64__viz" }, bitsHeading, gridHelp, grid);

  // ---- readout
  const outWord = h("code", { class: "a64__big" });
  const outBytes = h("code", {});
  const outAsm = h("code", {});
  const outDump = h("code", {});
  const outDumpNote = h("p", { class: "a64__hint" });
  const outMeaning = h("p", { class: "a64__meaning" });
  const outChanged = h("p", { class: "a64__changed" });
  const fieldTable = h("table", { class: "a64__table" });
  const summaryLine = h("p", { class: "a64__summary" });
  const dl = h("dl", { class: "a64__dl" },
    h("dt", {}, "Word"), h("dd", {}, outWord),
    h("dt", {}, "Bytes in memory (little-endian)"), h("dd", {}, outBytes),
    h("dt", {}, "Assembly"), h("dd", {}, outAsm),
    h("dt", {}, "objdump -d prints"), h("dd", {}, outDump));
  const readoutHeading = h("h3", { class: "a64__h", tabindex: "-1" }, "Readout");
  // The table scrolls sideways on narrow screens and holds nothing focusable, so the box itself
  // takes focus (keyboard users can scroll it) and has a name.
  const tableBox = h("div", {
    class: "a64__scroll", tabindex: "0", role: "region",
    "aria-label": "Field table, scrolls sideways on narrow screens",
  }, fieldTable);
  const readout = h("div", { class: "a64__readout" },
    readoutHeading, dl, outDumpNote, outMeaning, outChanged, tableBox, summaryLine);

  // ---- actions
  const resetBtn = h("button", { type: "button", class: "a64__btn" }, "Reset");
  const shareBtn = h("button", { type: "button", class: "a64__btn" }, "Copy link to this state");
  const actions = h("div", { class: "a64__actions" }, resetBtn, shareBtn);

  root.append(overview, h("div", { class: "a64__work" }, controls, viz, readout), actions);
  el.appendChild(root);

  // ---- events
  modeEncode.addEventListener("change", () => update({ type: "mode", mode: "encode" }));
  modeDecode.addEventListener("change", () => update({ type: "mode", mode: "decode" }));
  opSelect.addEventListener("change", () => update({ type: "op", op: opSelect.value }));
  sfSelect.addEventListener("change", () => update({ type: "input", name: "sf", text: sfSelect.value }));
  hwSelect.addEventListener("change", () => update({ type: "input", name: "hw", text: hwSelect.value }));
  rdInput.addEventListener("input", () => update({ type: "input", name: "rd", text: rdInput.value }));
  immInput.addEventListener("input", () => update({ type: "input", name: "imm16", text: immInput.value }));
  offInput.addEventListener("input", () => update({ type: "input", name: "offset", text: offInput.value }));
  hexInput.addEventListener("input", () => update({ type: "hex", text: hexInput.value }));
  pcInput.addEventListener("input", () => update({ type: "pc", text: pcInput.value }));
  revealBtn.addEventListener("click", () => {
    // The button hides once the answer is shown; move focus to the answer first so keyboard and
    // screen-reader users are not dropped back at the top of the page.
    readoutHeading.focus();
    update({ type: "reveal" });
  });
  // The select stays on the chosen example (render clears it once the word no longer matches),
  // so arrowing through a closed select on Windows/Linux applies each example in turn and the
  // reader can always see which one is loaded.
  presetSelect.addEventListener("change", () => {
    if (presetSelect.value) update({ type: "preset", id: presetSelect.value });
  });
  resetBtn.addEventListener("click", () => update({ type: "reset" }));
  shareBtn.addEventListener("click", async () => {
    const href = globalThis.location ? globalThis.location.href : "";
    try {
      await globalThis.navigator.clipboard.writeText(href);
      noteLine.textContent = "Link copied.";
    } catch {
      noteLine.textContent = "The link to this state is in your address bar.";
    }
    announce(noteLine.textContent);
  });

  function update(action) {
    state = step(state, action);
    render(true);
  }

  /** Set an input's value unless the reader is typing in it (keeps the caret where it is). */
  function setValue(input, value) {
    if (doc.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  function render(changed) {
    const s = state;
    const enc = s.mode === "encode";
    const fam = OPS[s.op].family;
    const d = decode(s.word, s.pc);
    const showFields = d.known && (enc || s.revealed);
    const isBranch = enc ? fam === "branch" : true;

    modeEncode.checked = enc;
    modeDecode.checked = !enc;
    rowOp.hidden = !enc;
    rowSf.hidden = !(enc && fam === "movewide");
    rowRd.hidden = rowSf.hidden;
    rowHw.hidden = rowSf.hidden;
    rowImm.hidden = !(enc && (fam === "movewide" || fam === "exception"));
    rowOff.hidden = !(enc && fam === "branch");
    rowHex.hidden = enc;
    revealBtn.parentNode.hidden = enc || s.revealed;
    rowPc.hidden = !isBranch;

    const matching = PRESETS.find((p) => p.word === s.word && p.mode === s.mode);
    presetSelect.value = matching ? matching.id : "";
    opSelect.value = s.op;
    sfSelect.value = s.inputs.sf ?? "1";
    hwSelect.value = s.inputs.hw ?? "0";
    for (const opt of hwSelect.children) {
      opt.disabled = sfSelect.value === "0" && Number(opt.value) > 1;
    }
    setValue(rdInput, s.inputs.rd ?? "");
    setValue(immInput, s.inputs.imm16 ?? "");
    setValue(offInput, s.inputs.offset ?? "");
    setValue(hexInput, s.hexText);
    setValue(pcInput, s.pcText);

    for (const [inp, key] of [[rdInput, "rd"], [immInput, "imm16"], [offInput, "offset"], [hexInput, "hex"], [pcInput, "pc"], [hwSelect, "hw"], [sfSelect, "sf"]]) {
      if (s.error && s.error.field === key) inp.setAttribute("aria-invalid", "true");
      else inp.removeAttribute("aria-invalid");
    }
    errorLine.textContent = s.error ? `Not applied: ${s.error.message}` : "";
    noteLine.textContent = s.note ?? "";

    // Field header row.
    fieldRow.replaceChildren();
    if (showFields) {
      for (const f of d.fields) {
        const cell = h("div", { class: "a64__fh" + (f.fixed !== undefined ? " is-fixed" : "") },
          h("span", { class: "a64__fname" }, f.fixed !== undefined ? "fixed" : f.name),
          h("span", { class: "a64__frange" }, f.hi === f.lo ? `${f.hi}` : `${f.hi}..${f.lo}`));
        cell.style.gridColumn = `${32 - f.hi} / span ${f.width}`;
        cell.setAttribute("title", f.label);
        fieldRow.appendChild(cell);
      }
    } else {
      const cell = h("div", { class: "a64__fh a64__fh--blank" },
        h("span", { class: "a64__fname" }, d.known || !s.revealed ? "fields hidden until you ask" : "not decoded by this lab"));
      cell.style.gridColumn = "1 / span 32";
      fieldRow.appendChild(cell);
    }

    // Bits.
    const ch = changedBits(s);
    for (let b = 0; b < 32; b++) {
      const v = (s.word >>> b) & 1;
      const f = showFields ? d.fields.find((x) => b >= x.lo && b <= x.hi) : null;
      const btn = bitButtons[b];
      btn.textContent = String(v);
      btn.setAttribute("aria-pressed", v ? "true" : "false");
      const locked = enc && !!(f && f.fixed !== undefined);
      const parts = [`Bit ${b}`];
      if (f) parts.push(f.fixed !== undefined ? "fixed" : f.name);
      parts.push(`value ${v}`);
      if (ch[b]) parts.push("changed");
      if (locked) parts.push("cannot flip in Encode mode");
      btn.setAttribute("aria-label", parts.join(", "));
      // Fixed bits stay focusable (the note explains them) but do not promise a toggle.
      if (locked) btn.setAttribute("aria-disabled", "true");
      else btn.removeAttribute("aria-disabled");
      btn.classList.toggle("is-one", v === 1);
      btn.classList.toggle("is-fixed", !!(f && f.fixed !== undefined));
      btn.classList.toggle("is-changed", ch[b]);
      btn.classList.toggle("is-edge", !!(f && f.lo === b && b !== 0));
    }

    // Readout.
    outWord.textContent = hex32(s.word);
    outBytes.textContent = leBytes(s.word).join(" ");
    const hide = !enc && !s.revealed;
    outAsm.textContent = hide ? "?" : d.known ? d.asm : d.name ?? "(not decoded)";
    outDump.textContent = hide ? "?" : d.known ? d.dump : "(see the primer)";
    outDumpNote.textContent = !hide && d.known && d.dumpNote ? d.dumpNote : "";
    outDumpNote.hidden = !outDumpNote.textContent;
    outMeaning.textContent = hide
      ? "Compare the fixed bits with the three diagrams at the top (move wide: bits 28 to 23 = 100101; exception call: bits 31 to 24 = 11010100; branch: bits 30 to 26 = 00101), then press Tell me."
      : d.known ? d.meaning : d.name ? `${d.name}: ${d.meaning}. It is ${d.reason}.` : d.reason;
    const changedList = ch.flatMap((c, i) => (c ? [i] : [])).reverse();
    outChanged.textContent = changedList.length ? `Bits changed by your last edit (marked with a dashed outline): ${changedList.join(", ")}.` : "";

    fieldTable.replaceChildren();
    if (showFields) {
      fieldTable.appendChild(h("caption", {}, FAMILIES[d.family].title));
      fieldTable.appendChild(h("thead", {}, h("tr", {},
        h("th", { scope: "col" }, "Field"), h("th", { scope: "col" }, "Bits"),
        h("th", { scope: "col" }, "Value"), h("th", { scope: "col" }, "Means"))));
      const tb = h("tbody");
      for (const f of d.fields) {
        tb.appendChild(h("tr", {},
          h("th", { scope: "row" }, f.fixed !== undefined ? "fixed" : f.name),
          h("td", {}, f.hi === f.lo ? `${f.hi}` : `${f.hi} to ${f.lo}`),
          h("td", {}, h("code", {}, f.binary)),
          h("td", {}, f.fixed !== undefined ? f.label : fieldMeaning(d, f),
            f.fixed !== undefined ? null : h("span", { class: "a64__flabel" }, f.label))));
      }
      fieldTable.appendChild(tb);
    }

    const text = summary(s);
    summaryLine.textContent = text;
    if (changed) {
      announce(s.error ? `Not applied: ${s.error.message}` : s.note ?? text);
      try {
        const share = toShare(s);
        ctx.hash.set(share === INITIAL_SHARE ? null : share);
      } catch {
        // Share state is a convenience; the lab works without it.
      }
    }
  }

  render(false);

  return {
    destroy() {
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = null;
    },
  };
}
