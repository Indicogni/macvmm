// sysreg-smccc view: renders the model's state and turns events into model steps.
//
// Two halves behind one native radio pair: SMCCC function IDs (a 32-bit bit grid, a field builder
// and "what macvmm does with this call"), and mrs/msr words (an instruction word or an EC 0x18
// syndrome, its fields, the register's name and macvmm's policy for it). DOM is built with
// createElement/textContent only. Nothing from the hash or a text box reaches the page except
// through the model's strict parsers (decode, parseHex, lookupRegister).
import {
  initialState,
  step,
  encode,
  decode,
  parseHex,
  hex,
  rustHex,
  groupedHex,
  oenName,
  decodeCall,
  macvmmAnswer,
  regText,
  callSummary,
  analyzeWord,
  sysSummary,
  lookupRegister,
  fieldProblem,
  registerNames,
  INSN_LAYOUT,
  ESR_LAYOUT,
  SMCCC_PRESETS,
  SYSREG_PRESETS,
} from "./model.mjs";

const ANNOUNCE_GAP_MS = 300;

/** h("p", {class: "x"}, "text", child): attributes are set, never parsed as HTML. */
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

const FIELD_OF_BIT = (b) => (b === 31 ? "f" : b === 30 ? "w" : b >= 24 ? "oen" : b >= 16 ? "mbz" : "fn");
const FIELD_LABEL = { f: "fast call", w: "64-bit convention", oen: "owner", mbz: "must be zero", fn: "function number" };

// Fixed course URLs (the lab never fetches them; they are plain links).
const COURSE = "/build-your-own/vmm/";
const LINKS = [
  ["Chapter 08: system registers, injection, hypercalls and PSCI", `${COURSE}cpu/traps-psci/`],
  ["The smccc primer", `${COURSE}primers/smccc/`],
  ["The aarch64-reading primer", `${COURSE}primers/aarch64-reading/`],
];

/** A hex box mid-edit ("", "0x") is incomplete, not wrong: no error while typing. */
const incomplete = (text) => /^\s*(0x)?\s*$/i.test(text);

export function mount(el, ctx) {
  let state = decode(ctx.hash.get()) ?? initialState();
  const pid = ctx.id;
  const id = (s) => `${pid}-${s}`;

  // ---- throttled announcements (the last message wins) ----
  let lastSpoke = 0;
  let timer = null;
  let pending = "";
  function say(text) {
    pending = text;
    const wait = lastSpoke + ANNOUNCE_GAP_MS - Date.now();
    if (wait <= 0 && timer === null) {
      lastSpoke = Date.now();
      ctx.announce(text);
      return;
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        lastSpoke = Date.now();
        ctx.announce(pending);
      }, Math.max(wait, 0));
    }
  }

  // ---- small builders ----
  const field = (labelText, control, hint) => {
    const wrap = h("div", { class: "ss__field" });
    wrap.append(h("label", { for: control.id, class: "ss__label", text: labelText }), control);
    if (hint) wrap.append(hint);
    return wrap;
  };
  const textInput = (name, extra = {}) =>
    h("input", { type: "text", id: id(name), class: "ss__input ss__mono", spellcheck: "false", autocomplete: "off", autocapitalize: "off", ...extra });
  const select = (name, options) => {
    const s = h("select", { id: id(name), class: "ss__select" });
    for (const [v, t] of options) s.append(h("option", { value: v, text: t }));
    return s;
  };
  // Error notes are plain text tied to their input by aria-describedby: never a live region, so
  // typing is not interrupted. A committed (change) edit that is still wrong is spoken once.
  const errorNote = (name) => h("p", { id: id(name), class: "ss__error", hidden: true });
  const showError = (node, input, text) => {
    node.textContent = text || "";
    node.hidden = !text;
    if (text) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };

  // ---- top bar ----
  const help = h(
    "p",
    { class: "ss__help" },
    "Two 32-bit numbers that are really sets of fields. The first is an SMCCC call number: SMCCC is the standard way a guest asks the layer below it (here, the VMM) for a service. The guest puts the number in w0, the low half of register x0, and runs hvc #0, the instruction that traps to the hypervisor. The second is an mrs or msr instruction, which reads or writes one system register (a CPU control register); its fields name the register. Change a number or a field and watch the rest follow.",
  );
  const tryList = h("ol", { class: "ss__try" });
  for (const t of [
    "SYSTEM_OFF is loaded. Predict: if you flip bit 30 (the 64-bit convention), is that 64-bit form defined? Click bit 30 in the grid and check the notes.",
    "Set any bit from 23 to 16. Which rule does the ID break now, and what does macvmm answer?",
    "Before looking, decode 0xC400_0004 on paper: fast or yielding, 32 or 64, owner, function. Then type it into x0.",
    "Switch to the system-register number, type 0x62280520 (a trap syndrome) and find the register, the direction and Rt. Is that what you got by hand in chapter 08?",
  ]) tryList.append(h("li", { text: t }));
  const intro = h(
    "details",
    { class: "ss__intro" },
    h("summary", { class: "ss__label", text: "Try this (four predict-then-check steps)" }),
    tryList,
  );
  if (ctx.standalone) {
    const links = h("ul", { class: "ss__links" });
    for (const [t, href] of LINKS) links.append(h("li", {}, h("a", { href, text: t })));
    intro.append(h("p", { class: "ss__note", text: "Background:" }), links);
    intro.setAttribute("open", "");
  }
  const halfSmccc = h("input", { type: "radio", name: id("half"), id: id("half-smccc"), value: "smccc" });
  const halfSys = h("input", { type: "radio", name: id("half"), id: id("half-sysreg"), value: "sysreg" });
  const halves = h(
    "fieldset",
    { class: "ss__halves" },
    h("legend", { class: "ss__legend", text: "Which number to explore" }),
    h("label", { class: "ss__radio", for: halfSmccc.id }, halfSmccc, " An SMCCC call number (what the guest asks the VMM)"),
    h("label", { class: "ss__radio", for: halfSys.id }, halfSys, " A system-register instruction (mrs or msr)"),
  );
  const resetBtn = h("button", { type: "button", class: "ss__btn", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "ss__btn", text: "Copy link to this state" });
  const bar = h("div", { class: "ss__bar" }, halves, h("div", { class: "ss__actions" }, resetBtn, copyBtn));

  // ================================ SMCCC half ================================
  const callPreset = select("call-preset", [["", "Choose an example…"], ...SMCCC_PRESETS.map((p) => [p.id, p.label])]);
  const x0In = textInput("x0", { "aria-describedby": id("x0-err") });
  const x0Err = errorNote("x0-err");
  const fastCb = h("input", { type: "checkbox", id: id("fast") });
  const wideCb = h("input", { type: "checkbox", id: id("wide") });
  const oenSel = select(
    "oen",
    Array.from({ length: 64 }, (_, o) => [String(o), `${o}: ${oenName(o)}`]),
  );
  const mbzIn = textInput("mbz", { "aria-describedby": id("mbz-err"), maxlength: "6" });
  const mbzErr = errorNote("mbz-err");
  const fnIn = textInput("fn", { "aria-describedby": id("fn-err"), maxlength: "8" });
  const fnErr = errorNote("fn-err");
  const conduitSel = select("conduit", [["hvc", "hvc (hypervisor call)"], ["smc", "smc (secure monitor call)"]]);
  const immIn = textInput("imm", { "aria-describedby": id("imm-err"), maxlength: "8" });
  const immErr = errorNote("imm-err");
  const guestSel = select("guest", [["test", "A macvmm test guest"], ["os", "A real OS, such as Linux"]]);
  const x1In = textInput("x1", { "aria-describedby": id("x1-err") });
  const x1Err = errorNote("x1-err");

  const builder = h(
    "fieldset",
    { class: "ss__group" },
    h("legend", { class: "ss__legend", text: "Build it from its fields" }),
    h("label", { class: "ss__check", for: fastCb.id }, fastCb, " Fast call (bit 31)"),
    h("label", { class: "ss__check", for: wideCb.id }, wideCb, " 64-bit convention (bit 30)"),
    field("Owner, OEN (bits 29 to 24)", oenSel),
    field("Bits 23 to 16, hex (must be zero in a fast call)", mbzIn, mbzErr),
    field("Function number, hex (bits 15 to 0)", fnIn, fnErr),
  );
  const context = h(
    "details",
    { class: "ss__more" },
    h("summary", { class: "ss__label", text: "More: conduit, immediate, guest kind, x1" }),
    h(
      "fieldset",
      { class: "ss__group" },
      h("legend", { class: "ss__legend", text: "How the guest makes the call" }),
      field("Conduit (the trapping instruction)", conduitSel),
      field("Immediate, hex (the number after hvc; SMCCC uses #0)", immIn, immErr),
      field("Guest (debug calls answer only for test guests)", guestSel),
      field("x1, hex (the first argument; the FEATURES calls ask about the ID in x1)", x1In, x1Err),
    ),
  );
  const callControls = h(
    "div",
    { class: "ss__controls" },
    field("Example", callPreset),
    field("x0, hex (the function ID is w0, its low 32 bits)", x0In, x0Err),
    builder,
    context,
  );

  // The bit grid: 32 native buttons, one tab stop (roving tabindex, ARIA APG toolbar pattern).
  const gridNote = h("p", { class: "ss__note", id: id("grid-note"), text: "Bit grid: Tab into it, move with the left and right arrow keys (Home and End jump to the ends), and press Space to flip a bit." });
  const fieldRow = h("div", { class: "ss__gridrow ss__gridrow--fields", "aria-hidden": "true" });
  for (const [f, span, text] of [["f", 1, "F"], ["w", 1, "W"], ["oen", 6, "owner"], ["mbz", 8, "zero"], ["fn", 16, "function number"]]) {
    fieldRow.append(h("span", { class: `ss__fieldcap ss__b--${f} ss__span${span}`, text }));
  }
  const bitRow = h("div", { class: "ss__gridrow", role: "toolbar", "aria-label": "Bits 31 to 0 of w0", "aria-describedby": gridNote.id });
  const bitBtns = [];
  for (let b = 31; b >= 0; b--) {
    const btn = h("button", { type: "button", class: `ss__bit ss__b--${FIELD_OF_BIT(b)}`, "data-bit": String(b), tabindex: b === 31 ? "0" : "-1" });
    bitBtns[b] = btn;
    bitRow.append(btn);
  }
  const numRow = h("div", { class: "ss__gridrow ss__gridrow--nums", "aria-hidden": "true" });
  for (let b = 31; b >= 0; b--) numRow.append(h("span", { class: "ss__bitnum", text: String(b) }));
  const hexRow = h("div", { class: "ss__gridrow ss__gridrow--hex", "aria-hidden": "true" });
  const hexCells = [];
  for (let n = 7; n >= 0; n--) {
    const c = h("span", { class: "ss__hexdigit ss__span4" });
    hexCells[n] = c;
    hexRow.append(c);
  }
  const grid = h("div", { class: "ss__scroll" }, h("div", { class: "ss__grid" }, fieldRow, bitRow, numRow, hexRow));
  const callViz = h("div", { class: "ss__viz" }, h("h3", { class: "ss__h", text: "w0, bit by bit" }), gridNote, grid);

  const callFields = h("dl", { class: "ss__dl" });
  const callFlags = h("ul", { class: "ss__flags" });
  const callAnswer = h("div", { class: "ss__answer" });
  const callReadout = h(
    "div",
    { class: "ss__readout" },
    h("h3", { class: "ss__h", text: "Decoded" }),
    callFields,
    callFlags,
    h("h3", { class: "ss__h", text: "What macvmm does with it" }),
    callAnswer,
  );
  // DOM order is the visual order at every width: the picture, then the controls, then the readout.
  const smcccPanel = h("section", { class: "ss__panel", "aria-label": "SMCCC call number" }, callViz, callControls, callReadout);

  // ================================ sysreg half ================================
  const sysPreset = select("sys-preset", [["", "Choose an example…"], ...SYSREG_PRESETS.map((p) => [p.id, p.label])]);
  const wordIn = textInput("word", { "aria-describedby": id("word-err") });
  const wordErr = errorNote("word-err");
  const modeSel = select("mode", [["auto", "Guess from the top six bits"], ["insn", "An instruction word"], ["esr", "An EC 0x18 syndrome"]]);
  const dirSel = select("dir", [["1", "mrs (read the register)"], ["0", "msr (write the register)"]]);
  const op0Sel = select("op0", [["2", "2"], ["3", "3"]]);
  const num = (name, max) => h("input", { type: "number", id: id(name), class: "ss__input ss__num ss__mono", min: "0", max: String(max), step: "1", inputmode: "numeric", "aria-describedby": id("fields-err") });
  const op1In = num("op1", 7);
  const crnIn = num("crn", 15);
  const crmIn = num("crm", 15);
  const op2In = num("op2", 7);
  const rtIn = num("rt", 31);
  const fieldsErr = h("p", { id: id("fields-err"), class: "ss__error", hidden: true });
  const listId = id("names");
  const nameList = h("datalist", { id: listId });
  for (const n of registerNames()) nameList.append(h("option", { value: n }));
  const nameIn = textInput("name", { list: listId, "aria-describedby": id("name-err") });
  const nameErr = errorNote("name-err");

  const coordsNote = h("p", { class: "ss__note", id: id("coords-note"), hidden: true, text: "These fields describe no register right now: the word is not a register move. Type a register name, or pick an example, to start one." });
  const coords = h(
    "fieldset",
    { class: "ss__group ss__coords", "aria-describedby": coordsNote.id },
    h("legend", { class: "ss__legend", text: "Coordinates and direction" }),
    field("Direction", dirSel),
    h("div", { class: "ss__nums" }, field("op0 (2: debug)", op0Sel), field("op1", op1In), field("CRn", crnIn), field("CRm", crmIn), field("op2", op2In), field("Rt (31 = xzr)", rtIn)),
    fieldsErr,
  );
  const sysEditor = h(
    "fieldset",
    { class: "ss__group" },
    h("legend", { class: "ss__legend", text: "Edit the fields" }),
    field("Register name (or S3_0_C15_C0_0 style)", nameIn, nameErr),
    nameList,
    coordsNote,
    coords,
  );
  const sysControls = h(
    "div",
    { class: "ss__controls" },
    field("Example", sysPreset),
    field("Word, hex", wordIn, wordErr),
    field("Read it as (top six bits 0x18 means a syndrome)", modeSel),
    sysEditor,
  );
  const layoutTable = h("table", { class: "ss__table" });
  // The table can be wider than a phone; its scroll box takes focus so a keyboard can scroll it.
  const sysViz = h(
    "div",
    { class: "ss__viz" },
    h("h3", { class: "ss__h", text: "The fields, by bit position" }),
    h("div", { class: "ss__scroll ss__scroll--focus", tabindex: "0", role: "region", "aria-label": "Field table, scrolls sideways" }, layoutTable),
  );
  const sysOut = h("dl", { class: "ss__dl" });
  const sysNotes = h("ul", { class: "ss__flags" });
  const sysPolicy = h("div", { class: "ss__answer" });
  const sysPolicyHead = h("h3", { class: "ss__h", text: "If it traps: what macvmm does" });
  const sysReadout = h(
    "div",
    { class: "ss__readout" },
    h("h3", { class: "ss__h", text: "Decoded" }),
    sysOut,
    sysNotes,
    sysPolicyHead,
    sysPolicy,
  );
  const sysPanel = h("section", { class: "ss__panel", "aria-label": "System-register instruction" }, sysViz, sysControls, sysReadout);

  // A visible readout only: it is spoken through ctx.announce (throttled), never as a live region,
  // so rewriting it on every keystroke is silent.
  const summary = h("p", { class: "ss__summary", id: id("summary") });
  const summaryBox = h("div", { class: "ss__summarybox" }, h("span", { class: "ss__label", text: "Readout" }), summary);

  el.append(help, intro, bar, smcccPanel, sysPanel, summaryBox);

  // ---- state changes ----
  const CALL_ACTIONS = new Set(["x0", "x1", "conduit", "guest", "imm", "fid", "bit"]);
  const SYS_ACTIONS = new Set(["word", "mode", "fields"]);
  function apply(action, speak = true) {
    const next = step(state, action);
    if (next === state) return false;
    // An Example select keeps showing the loaded example until the learner changes something.
    if (CALL_ACTIONS.has(action.type)) callPreset.value = "";
    if (SYS_ACTIONS.has(action.type)) sysPreset.value = "";
    state = next;
    ctx.hash.set(encode(state));
    render();
    if (speak) say(summary.textContent);
    return true;
  }

  // ---- rendering ----
  // A box the reader is typing in is left alone, except right after a committed (change) edit,
  // when every box is rewritten in its canonical spelling.
  let forceAll = false;
  const setIfIdle = (input, value) => {
    if (forceAll || document.activeElement !== input) input.value = value;
  };
  const renderAll = () => {
    forceAll = true;
    try {
      render();
    } finally {
      forceAll = false;
    }
  };
  const dlRow = (dl, k, v, mono = false) => {
    dl.append(h("dt", { text: k }), h("dd", { class: mono ? "ss__mono" : null, text: v }));
  };
  const flagItem = (list, level, text) => {
    list.append(h("li", { class: `ss__flag ss__flag--${level}` }, h("strong", { class: "ss__flagtag", text: level === "error" ? "Breaks the rules: " : level === "warn" ? "Warning: " : "Note: " }), text.replace(/^Breaks the rules: /, "")));
  };

  function renderCall() {
    const c = state.call;
    const d = decodeCall(c.x0);
    setIfIdle(x0In, c.x0 > 0xffff_ffffn ? hex(c.x0, 16) : hex(d.fid));
    fastCb.checked = d.fast;
    wideCb.checked = d.wide;
    oenSel.value = String(d.oen);
    setIfIdle(mbzIn, hex(d.mbz, 2));
    setIfIdle(fnIn, hex(d.func, 4));
    conduitSel.value = c.conduit;
    setIfIdle(immIn, rustHex(c.imm));
    guestSel.value = c.guest;
    setIfIdle(x1In, rustHex(c.x1));

    for (let b = 0; b < 32; b++) {
      const on = ((d.fid >>> b) & 1) === 1;
      const btn = bitBtns[b];
      btn.textContent = on ? "1" : "0";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("aria-label", `Bit ${b}, ${FIELD_LABEL[FIELD_OF_BIT(b)]}: ${on ? 1 : 0}`);
      btn.classList.toggle("ss__bit--on", on);
      btn.classList.toggle("ss__bit--bad", FIELD_OF_BIT(b) === "mbz" && on && d.fast);
    }
    for (let n = 0; n < 8; n++) hexCells[n].textContent = ((d.fid >>> (n * 4)) & 0xf).toString(16).toUpperCase();

    callFields.replaceChildren();
    dlRow(callFields, "Function ID (w0)", groupedHex(d.fid), true);
    dlRow(callFields, "Bit 31", d.fast ? "1: fast call, runs to completion" : "0: yielding call");
    dlRow(callFields, "Bit 30", d.wide ? "1: 64-bit convention (SMC64/HVC64): x registers" : "0: 32-bit convention (SMC32/HVC32): only w registers count");
    dlRow(callFields, "Bits 29 to 24", d.fast ? `${d.oen}: ${d.owner}` : `${d.oen}: yielding calls have no owner table; this ID is in the range ${d.owner}`);
    dlRow(callFields, "Bits 23 to 16", hex(d.mbz, 2), true);
    dlRow(callFields, "Bits 15 to 0", `${rustHex(d.func)} (${d.func})`, true);
    dlRow(callFields, "Name", d.name ? (d.nameSource === "macvmm" ? d.name : `${d.name} (${d.otherNote}; not served by macvmm)`) : d.psci ? "in the PSCI range (owner 4, functions 0x00 to 0x1F), but not a function macvmm serves" : "not one macvmm or this lab knows");
    callFlags.replaceChildren();
    if (d.upperIgnored) flagItem(callFlags, "note", `The upper half of x0 (${hex(c.x0 >> 32n)}) is ignored: only w0 is the function ID.`);
    for (const f of d.flags) flagItem(callFlags, f.level, f.text);

    const a = macvmmAnswer(c);
    callAnswer.replaceChildren();
    const dl = h("dl", { class: "ss__dl" });
    dlRow(dl, "Who answers", a.by === "hvf" ? "Hypervisor.framework, inside the macOS kernel" : a.untested ? "macvmm's SMCCC dispatcher, if HVF passes the call on (not tested)" : "macvmm's SMCCC dispatcher");
    if (a.untested) dlRow(dl, "Not measured", a.untested);
    dlRow(dl, "x0 afterwards", a.x0 === null ? (a.stop ? "nothing: the VM stops" : "depends on the arguments") : regText(a.x0), a.x0 !== null);
    dlRow(dl, "Why", a.result);
    if (a.stop) dlRow(dl, "macvmm says", `${a.stop}; exit code ${a.exitCode}`);
    dlRow(dl, "PC", a.stop ? "Irrelevant: the vCPU does not resume." : a.pc);
    callAnswer.append(dl);
    if (a.warn) callAnswer.append(h("p", { class: "ss__label", text: "Warning on macvmm's standard error (rate-limited)" }), h("pre", { class: "ss__pre" }, h("code", { text: `macvmm: warn: [vcpu0] guest: ${a.warn}` })));
    return callSummary(c);
  }

  function renderSys() {
    const s = state.sys;
    const a = analyzeWord(s.word, s.mode);
    setIfIdle(wordIn, hex(s.word));
    modeSel.value = s.mode;
    layoutTable.replaceChildren();
    sysOut.replaceChildren();
    sysNotes.replaceChildren();
    sysPolicy.replaceChildren();
    const layout = a.as === "esr" ? ESR_LAYOUT : INSN_LAYOUT;
    const head = h("tr", {}, h("th", { scope: "col", text: "Field" }), h("th", { scope: "col", text: "Bits" }), h("th", { scope: "col", text: "Binary" }), h("th", { scope: "col", text: "Value" }));
    layoutTable.append(h("caption", { text: a.as === "esr" ? "Read as an EC 0x18 syndrome (note the order: Op2 above Op1, CRm below Rt)" : "Read as an mrs/msr instruction word" }), h("thead", {}, head));
    const body = h("tbody");
    for (const row of layout) {
      const n = row.hi - row.lo + 1;
      const v = (s.word >>> row.lo) & (n === 32 ? 0xffff_ffff : (1 << n) - 1);
      const bin = v.toString(2).padStart(n, "0");
      body.append(h("tr", {}, h("th", { scope: "row", text: row.name }), h("td", { class: "ss__mono", text: n === 1 ? String(row.hi) : `${row.hi}:${row.lo}` }), h("td", { class: "ss__mono", text: bin }), h("td", { class: "ss__mono", text: String(v) })));
    }
    layoutTable.append(body);

    coords.disabled = !a.ok;
    coordsNote.hidden = a.ok;
    if (!a.ok) {
      flagItem(sysNotes, "warn", a.error);
      sysPolicyHead.textContent = "If it traps: what macvmm does";
      sysPolicy.append(h("p", { text: "Nothing to decide: this word is not a system-register access. Pick an example or type a register name to make one." }));
      setIfIdle(nameIn, "");
      return sysSummary(s);
    }
    const f = a.fields;
    dirSel.value = f.read ? "1" : "0";
    op0Sel.value = String(f.op0);
    setIfIdle(op1In, String(f.op1));
    setIfIdle(crnIn, String(f.crn));
    setIfIdle(crmIn, String(f.crm));
    setIfIdle(op2In, String(f.op2));
    setIfIdle(rtIn, String(f.rt));
    setIfIdle(nameIn, a.name);

    dlRow(sysOut, "Assembly", a.asm, true);
    dlRow(sysOut, "Register", a.named ? a.name : `${a.name} (no name in macvmm's tables; the spelling assemblers accept)`, true);
    dlRow(sysOut, "Coordinates (op0, op1, CRn, CRm, op2)", `(${f.op0}, ${f.op1}, ${f.crn}, ${f.crm}, ${f.op2})`, true);
    dlRow(sysOut, "Rt and direction", `${f.rt === 31 ? "xzr (31)" : `x${f.rt}`}, ${f.read ? "read (mrs)" : "write (msr)"}`);
    dlRow(sysOut, "Instruction word", groupedHex(a.insn), true);
    dlRow(sysOut, "Syndrome if it traps (ESR_EL2)", groupedHex(a.esr), true);
    dlRow(sysOut, "hv_sys_reg_t (Hypervisor.framework's number for this register; the trace's sysreg_enc)", rustHex(a.enc), true);
    for (const n of a.notes) flagItem(sysNotes, "note", n);

    const p = a.policy;
    const r = a.reach;
    const dl = h("dl", { class: "ss__dl" });
    // Reach first: whether macvmm sees the access at all decides how to read the policy.
    dlRow(dl, "Does it reach macvmm?", r.text);
    sysPolicyHead.textContent = p.hypothetical ? "What macvmm would do (it never gets the chance)" : "If it traps: what macvmm does";
    dlRow(dl, "Policy row", p.row ?? "none: the default applies");
    dlRow(dl, p.hypothetical ? "Outcome, hypothetically" : "Outcome", p.text);
    sysPolicy.append(dl);
    if (a.warn) sysPolicy.append(h("p", { class: "ss__label", text: r.exits === "nogic" ? "Warning on macvmm's standard error, when it reaches macvmm (with --irqchip none)" : "Warning on macvmm's standard error, if it reaches macvmm" }), h("pre", { class: "ss__pre" }, h("code", { text: `macvmm: warn: [vcpu0] guest: vcpu0: ${a.warn}` })));
    return sysSummary(s);
  }

  function render() {
    const smccc = state.half === "smccc";
    halfSmccc.checked = smccc;
    halfSys.checked = !smccc;
    smcccPanel.hidden = !smccc;
    sysPanel.hidden = smccc;
    const callText = renderCall();
    const sysText = renderSys();
    summary.textContent = smccc ? callText : sysText;
  }

  // ---- events: SMCCC ----
  // While typing: apply what parses, mark what does not (silently), and treat "" or "0x" as
  // unfinished. On commit (change): a still-bad value is spoken once; a good one is applied.
  const hexHandler = (input, err, bitsMax, toAction) => {
    input.addEventListener("input", () => {
      if (incomplete(input.value)) return showError(err, input, "");
      const r = parseHex(input.value, bitsMax);
      showError(err, input, r.error);
      if (!r.error) apply(toAction(r.value), false);
    });
    input.addEventListener("change", () => {
      const r = parseHex(input.value, bitsMax);
      showError(err, input, r.error);
      if (r.error) {
        say(r.error);
        return;
      }
      apply(toAction(r.value), false);
      renderAll();
      say(summary.textContent);
    });
  };
  hexHandler(x0In, x0Err, 64, (v) => ({ type: "x0", value: v }));
  hexHandler(x1In, x1Err, 64, (v) => ({ type: "x1", value: v }));
  hexHandler(mbzIn, mbzErr, 8, (v) => ({ type: "fid", field: "mbz", value: Number(v) }));
  hexHandler(fnIn, fnErr, 16, (v) => ({ type: "fid", field: "func", value: Number(v) }));
  hexHandler(immIn, immErr, 16, (v) => ({ type: "imm", value: Number(v) }));
  fastCb.addEventListener("change", () => apply({ type: "fid", field: "fast", value: fastCb.checked }));
  wideCb.addEventListener("change", () => apply({ type: "fid", field: "wide", value: wideCb.checked }));
  oenSel.addEventListener("change", () => apply({ type: "fid", field: "oen", value: Number(oenSel.value) }));
  conduitSel.addEventListener("change", () => apply({ type: "conduit", value: conduitSel.value }));
  guestSel.addEventListener("change", () => apply({ type: "guest", value: guestSel.value }));
  callPreset.addEventListener("change", () => {
    if (callPreset.value) {
      for (const [n, i] of [[x0Err, x0In], [x1Err, x1In], [mbzErr, mbzIn], [fnErr, fnIn], [immErr, immIn]]) showError(n, i, "");
      apply({ type: "callPreset", id: callPreset.value }, false);
      renderAll();
      say(summary.textContent);
    }
  });

  let focusBit = 31;
  bitRow.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest(".ss__bit") : null;
    if (!btn) return;
    const b = Number(btn.dataset.bit);
    if (!Number.isInteger(b)) return;
    moveFocus(b, false);
    const before = decodeCall(state.call.x0).fid;
    if (apply({ type: "bit", bit: b }, false)) {
      say(`Bit ${b} is now ${(before >>> b) & 1 ? 0 : 1}. ${summary.textContent}`);
    }
  });
  function moveFocus(b, focus = true) {
    bitBtns[focusBit].setAttribute("tabindex", "-1");
    focusBit = b;
    bitBtns[b].setAttribute("tabindex", "0");
    if (focus) bitBtns[b].focus();
  }
  bitRow.addEventListener("keydown", (e) => {
    const keys = { ArrowLeft: Math.min(31, focusBit + 1), ArrowRight: Math.max(0, focusBit - 1), Home: 31, End: 0 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    moveFocus(keys[e.key]);
  });

  // ---- events: sysreg ----
  hexHandler(wordIn, wordErr, 32, (v) => ({ type: "word", value: Number(v) }));
  modeSel.addEventListener("change", () => apply({ type: "mode", value: modeSel.value }));
  sysPreset.addEventListener("change", () => {
    if (sysPreset.value) {
      showError(wordErr, wordIn, "");
      showError(nameErr, nameIn, "");
      clearFieldsError();
      apply({ type: "sysPreset", id: sysPreset.value }, false);
      renderAll();
      say(summary.textContent);
    }
  });
  const currentFields = () => {
    const a = analyzeWord(state.sys.word, state.sys.mode);
    return a.ok ? { ...a.fields } : { op0: 3, op1: 0, crn: 0, crm: 0, op2: 0, rt: 0, read: true };
  };
  const intOf = (input) => (/^\d{1,2}$/.test(input.value.trim()) ? Number(input.value.trim()) : NaN);
  const NUM_INPUTS = { op1: op1In, crn: crnIn, crm: crmIn, op2: op2In, rt: rtIn };
  function clearFieldsError() {
    fieldsErr.textContent = "";
    fieldsErr.hidden = true;
    for (const inp of Object.values(NUM_INPUTS)) inp.removeAttribute("aria-invalid");
  }
  // Returns the problem (or null); marks the offending box with aria-invalid, silently.
  function fromEditor(speak) {
    const f = {
      ...currentFields(),
      read: dirSel.value === "1",
      op0: Number(op0Sel.value),
      op1: intOf(op1In),
      crn: intOf(crnIn),
      crm: intOf(crmIn),
      op2: intOf(op2In),
      rt: intOf(rtIn),
    };
    const prob = fieldProblem(f);
    clearFieldsError();
    if (prob) {
      fieldsErr.textContent = prob.text;
      fieldsErr.hidden = false;
      if (NUM_INPUTS[prob.field]) NUM_INPUTS[prob.field].setAttribute("aria-invalid", "true");
      return prob;
    }
    apply({ type: "fields", fields: f }, speak);
    return null;
  }
  for (const ctl of Object.values(NUM_INPUTS)) {
    ctl.addEventListener("input", () => {
      if (ctl.value.trim() !== "") fromEditor(false);
    });
    ctl.addEventListener("change", () => {
      const prob = fromEditor(true);
      if (prob) say(prob.text);
      else renderAll();
    });
  }
  for (const sel of [dirSel, op0Sel]) {
    sel.addEventListener("change", () => {
      const prob = fromEditor(true);
      if (prob) say(prob.text);
    });
  }
  nameIn.addEventListener("change", () => {
    if (nameIn.value.trim() === "") return showError(nameErr, nameIn, "");
    const c = lookupRegister(nameIn.value);
    if (!c || c.op0 < 2) {
      const msg = c ? "That register has op0 0 or 1, so no mrs or msr reaches it." : "No register by that name in macvmm's tables. Try PMCR_EL0, or the S3_0_C15_C0_0 spelling.";
      showError(nameErr, nameIn, msg);
      say(msg);
      return;
    }
    showError(nameErr, nameIn, "");
    const f = { ...currentFields(), ...c };
    apply({ type: "fields", fields: f });
    renderAll();
  });

  // ---- events: shared ----
  for (const r of [halfSmccc, halfSys]) r.addEventListener("change", () => r.checked && apply({ type: "half", half: r.value }));
  resetBtn.addEventListener("click", () => {
    for (const [n, i] of [[x0Err, x0In], [x1Err, x1In], [mbzErr, mbzIn], [fnErr, fnIn], [immErr, immIn], [wordErr, wordIn], [nameErr, nameIn]]) showError(n, i, "");
    clearFieldsError();
    callPreset.value = "";
    sysPreset.value = "";
    state = initialState();
    ctx.hash.set(null);
    renderAll();
    say(`Reset. ${summary.textContent}`);
  });
  copyBtn.addEventListener("click", async () => {
    ctx.hash.set(encode(state));
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(location.href);
      say("Link copied. It reopens the lab in this state.");
    } catch {
      say("Could not copy here. The address bar already holds a link to this state.");
    }
  });

  renderAll();
  // Shown, not spoken: announcing on page load is noise.

  return {
    destroy() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
