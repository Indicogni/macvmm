// mmio-trap view: renders the model's frames and turns controls into model calls. All logic
// lives in model.mjs; this file only builds DOM (createElement + textContent, never innerHTML)
// inside the element the lab shell hands us. See course/site/LABS.md.
import {
  PROGRAMS, PROGRAM_IDS, DEFAULT_PROGRAM, PHASES, PHASE_LABELS, MAX_LINE,
  timeline, defaultOptions, encodeShare, decodeShare, parseLine, registersUsed, memoryMap,
  hex, hex64, summarize, IPA_BITS,
} from "./model.mjs";

/** A sideways-scrolling wrapper. Focusable and named, so a keyboard user can scroll it too. */
function scroller(label, child) {
  return h("div", { class: "mt-scroll", tabindex: "0", role: "region", "aria-label": `${label}, scrollable` }, child);
}

/** Buttons stay focusable when unavailable (aria-disabled, not disabled), so focus never drops
 *  to the page when the button just pressed reaches the end. */
function setAvailable(btn, on) {
  if (on) btn.removeAttribute("aria-disabled"); else btn.setAttribute("aria-disabled", "true");
}
const unavailable = (btn) => btn.getAttribute("aria-disabled") === "true";

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}

const OPTION_LABELS = [
  ["testdev", "Test device on the bus (--testdev)"],
  ["uart", "UART on the bus (chapter 09 adds it)"],
];
const BREAK_LABELS = [
  ["noAdvance", "Breakage 1: forget to advance the PC"],
  ["xzrAsReg", "Breakage 2: pass register 31 through (it is the PC in Hypervisor.framework)"],
  ["guess", "Breakage 3: when ISV = 0, guess (8 bytes, register SRT)"],
];

const DECODE_ROWS = [
  ["ISV", "isv", "bit 24", (d) => (d.isv ? "1: the note is valid" : "0: no note, bits 23 to 14 mean nothing")],
  ["SAS", "sas", "bits 23:22", (d) => `${d.sas}: ${1 << d.sas} byte${d.sas ? "s" : ""}`],
  ["SSE", "sse", "bit 21", (d) => (d.sse ? "1: sign-extend the load" : "0: no sign extension")],
  ["SRT", "srt", "bits 20:16", (d) => `${d.srt}${d.srt === 31 ? ": xzr (never sp, never the PC)" : `: register ${d.srt}`}`],
  ["SF", "sf", "bit 15", (d) => (d.sf ? "1: a 64-bit x register" : "0: a 32-bit w register")],
  ["WnR", "wnr", "bit 6", (d) => (d.wnr ? "1: write (store)" : "0: read (load)")],
  ["DFSC", "dfsc", "bits 5:0", (d) => `0x${d.dfsc.toString(16)}${d.dfsc >= 4 && d.dfsc <= 7 ? `: translation fault, level ${d.dfsc - 4}` : ""}`],
];

export function mount(el, ctx) {
  const id = ctx.id;
  const shared = decodeShare(ctx.hash.get());
  const ui = {
    program: shared ? shared.program : DEFAULT_PROGRAM,
    options: shared ? shared.options : defaultOptions(DEFAULT_PROGRAM),
    edits: shared ? shared.edits : {},
    step: shared ? shared.step : 0,
  };
  let tl = null;
  let playTimer = null;
  let sayTimer = null;
  let lastSaid = 0;

  function say(text) {
    const wait = Math.max(0, 300 - (Date.now() - lastSaid));
    if (sayTimer) clearTimeout(sayTimer);
    sayTimer = setTimeout(() => {
      sayTimer = null;
      lastSaid = Date.now();
      ctx.announce(text);
    }, wait);
  }

  // ---- controls ---------------------------------------------------------------------------
  const programSel = h("select", { id: `${id}-program` });
  for (const pid of PROGRAM_IDS) programSel.append(h("option", { value: pid, text: PROGRAMS[pid].title }));
  const stepBtn = h("button", { type: "button", class: "mt-btn mt-btn--primary", text: "Step" });
  const backBtn = h("button", { type: "button", class: "mt-btn", text: "Back" });
  const playBtn = h("button", { type: "button", class: "mt-btn", text: "Play", "aria-pressed": "false" });
  const endBtn = h("button", { type: "button", class: "mt-btn", text: "Run to end" });
  const resetBtn = h("button", { type: "button", class: "mt-btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "mt-btn", text: "Copy link to this step" });

  const optionBoxes = {};
  const optList = h("div", { class: "mt-checks" });
  for (const [key, label] of [...OPTION_LABELS, ...BREAK_LABELS]) {
    const box = h("input", { type: "checkbox", id: `${id}-opt-${key}` });
    optionBoxes[key] = box;
    optList.append(h("div", { class: "mt-check" }, box, h("label", { for: `${id}-opt-${key}`, text: label })));
    box.addEventListener("change", () => {
      ui.options = { ...ui.options, [key]: box.checked };
      rebuild(0);
      commit();
    });
  }
  const policySel = h("select", { id: `${id}-policy` },
    h("option", { value: "fatal", text: "fatal: stop the VM (default)" }),
    h("option", { value: "log", text: "log: ignore it, warn, carry on" }));
  policySel.addEventListener("change", () => {
    ui.options = { ...ui.options, log: policySel.value === "log" };
    rebuild(0);
    commit();
  });

  const controls = h("div", { class: "mt-controls" },
    h("div", { class: "mt-field" }, h("label", { for: `${id}-program`, text: "Program" }), programSel),
    h("div", { class: "mt-buttons", role: "group", "aria-label": "Stepping" }, stepBtn, backBtn, playBtn, endBtn, resetBtn),
  );
  const summary = h("p", { class: "mt-summary" });
  const source = h("p", { class: "mt-source" });
  const options = h("details", { class: "mt-more" },
    h("summary", { text: "Machine, policy and deliberate breakages" }),
    h("div", { class: "mt-options" },
      optList,
      h("div", { class: "mt-field" }, h("label", { for: `${id}-policy`, text: "Unhandled MMIO policy (--unhandled-mmio)" }), policySel),
    ),
  );

  // ---- guest pane -------------------------------------------------------------------------
  const listing = h("ol", { class: "mt-code", "aria-label": "Guest instructions" });
  const regBody = h("tbody");
  const regTable = h("table", { class: "mt-regs" },
    h("caption", { text: "Registers this program uses" }),
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Register" }), h("th", { scope: "col", text: "Value" }), h("th", { scope: "col", text: "This step" }))),
    regBody);
  const guestPane = h("section", { class: "mt-pane", "aria-labelledby": `${id}-guest-h` },
    h("h3", { id: `${id}-guest-h`, text: "Guest" }),
    h("p", { class: "mt-note", text: "Address, instruction word, instruction. The marked line is the one the PC points at." }),
    scroller("Guest instructions", listing),
    scroller("Registers", regTable));

  // ---- exit and VMM pane ------------------------------------------------------------------
  const phaseList = h("ol", { class: "mt-phases", "aria-label": "The five steps of one exit" });
  const phaseItems = {};
  for (const ph of PHASES) {
    const state = h("span", { class: "mt-phase-state" });
    const li = h("li", { class: "mt-phase" }, h("span", { class: "mt-phase-name", text: PHASE_LABELS[ph] }), state);
    phaseItems[ph] = { li, state };
    phaseList.append(li);
  }
  // "This step": the explanation sits right under the buttons, so a phone reader does not have
  // to scroll between Step and the text. Announced through ctx.announce (say), not a live region.
  const frameTitle = h("p", { class: "mt-frame-title" });
  const frameDetail = h("p", { class: "mt-frame-detail" });
  const exitBody = h("tbody");
  const exitTable = h("table", { class: "mt-kv" }, h("caption", { text: "Exit record" }), exitBody);
  const decodeBody = h("tbody");
  const decodeTable = h("table", { class: "mt-kv" }, h("caption", { text: "Syndrome fields (the hardware's note)" }),
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Field" }), h("th", { scope: "col", text: "Bits" }), h("th", { scope: "col", text: "Value" }))),
    decodeBody);
  const haltBox = h("p", { class: "mt-halt", hidden: true });
  const stepBox = h("section", { class: "mt-step", "aria-label": "This step" }, frameTitle, frameDetail, haltBox);
  const vmmPane = h("section", { class: "mt-pane", "aria-labelledby": `${id}-vmm-h` },
    h("h3", { id: `${id}-vmm-h`, text: "Exit and VMM" }),
    phaseList,
    scroller("Exit record", exitTable),
    scroller("Syndrome fields", decodeTable));

  // ---- memory map pane --------------------------------------------------------------------
  const mapBody = h("tbody");
  const mapTable = h("table", { class: "mt-map" },
    h("caption", { text: "Guest physical address space (the parts this lab uses)" }),
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Base" }), h("th", { scope: "col", text: "Region" }), h("th", { scope: "col", text: "Now" }))),
    mapBody);
  const slotBody = h("tbody");
  const slotTable = h("table", { class: "mt-kv" }, h("caption", { text: "Test device registers that are not zero" }),
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Offset" }), h("th", { scope: "col", text: "Value" }))), slotBody);
  const mapPane = h("section", { class: "mt-pane", "aria-labelledby": `${id}-map-h` },
    h("h3", { id: `${id}-map-h`, text: "Memory map" }),
    scroller("Memory map", mapTable),
    h("p", { class: "mt-note", text: "Every other address below RAM is a hole too: stage 2 maps nothing there, so any access exits." }),
    scroller("Test device registers", slotTable));

  // ---- outputs ----------------------------------------------------------------------------
  const termOut = h("pre", { class: "mt-out mt-out--term", tabindex: "0", "aria-label": "Virtual terminal" });
  const consoleOut = h("pre", { class: "mt-out", tabindex: "0", "aria-label": "Guest output" });
  const stderrOut = h("pre", { class: "mt-out", tabindex: "0", "aria-label": "VMM messages" });
  const traceOut = h("pre", { class: "mt-out", tabindex: "0", "aria-label": "Exit trace" });
  const outputs = h("div", { class: "mt-outputs" },
    h("div", { class: "mt-outbox" }, h("h3", { text: "Virtual terminal (UART)" }), termOut),
    h("div", { class: "mt-outbox" }, h("h3", { text: "Guest output" }), consoleOut),
    h("div", { class: "mt-outbox" }, h("h3", { text: "VMM messages (standard error)" }), stderrOut),
    h("div", { class: "mt-outbox mt-outbox--wide" },
      h("h3", { text: "Exit trace (--trace exits:FILE:mmio)" }),
      h("p", { class: "mt-note", text: "One record per data abort, written when the handler returns. The t_ns timestamp is left out." }),
      traceOut));

  // ---- line editor ------------------------------------------------------------------------
  const lineSel = h("select", { id: `${id}-line` });
  const lineInput = h("input", { type: "text", id: `${id}-text`, maxlength: String(MAX_LINE), spellcheck: "false", autocomplete: "off", class: "mt-input" });
  const applyBtn = h("button", { type: "button", class: "mt-btn", text: "Apply" });
  const revertBtn = h("button", { type: "button", class: "mt-btn", text: "Revert this line" });
  const revertAllBtn = h("button", { type: "button", class: "mt-btn", text: "Revert all lines" });
  const editMsg = h("p", { class: "mt-edit-msg", id: `${id}-edit-msg` });
  lineInput.setAttribute("aria-describedby", `${id}-edit-msg`);
  const editor = h("details", { class: "mt-more" },
    h("summary", { text: "Change a line (address, value, or instruction)" }),
    h("p", { class: "mt-note", text: "Change an address in a mov or movk line, a value, or a load or store itself. Try a writeback form such as strb w8, [x9], #1, or a pair such as stp x8, x9, [x9]. The program restarts from step 0." }),
    h("div", { class: "mt-edit" },
      h("div", { class: "mt-field" }, h("label", { for: `${id}-line`, text: "Line" }), lineSel),
      h("div", { class: "mt-field mt-field--grow" }, h("label", { for: `${id}-text`, text: "Instruction" }), lineInput),
      h("div", { class: "mt-buttons" }, applyBtn, revertBtn, revertAllBtn)),
    editMsg);

  const simplifies = h("details", { class: "mt-more" },
    h("summary", { text: "What this lab simplifies" }),
    h("ul", {},
      h("li", { text: "Listings leave out instructions that touch no memory (nop, adr, string lengths); their addresses are skipped, not renumbered. The probes' check and print functions run in one step." }),
      h("li", { text: "With the MMU off, the guest's virtual address is the IPA. With isv0-probe's MMU on, the lab follows that guest's own page tables, aliases included. The exit record shows how the IPA is rebuilt from FAR_EL2 and HPFAR_EL2." }),
      h("li", { text: "A hole inside the VM's 36-bit IPA space reports DFSC 0x6 (translation fault, level 2), as ours did on a real Mac; the level really depends on how deep stage 2's tables go for that address. From 1 << 36 up, stage 2 reports DFSC 0x4 (level 0), as chapter 05's capture shows. From 1 << 40 up, with the MMU off, the guest faults on its own before stage 2 is asked." }),
      h("li", { text: "The UART models only its data register (offset 0) and flag register (0x18). Chapter 09 builds the real PL011." }),
      h("li", { text: "The real fatal stop also prints every register and the last exits. The stack pointer of the mmio-probe programs is made up; no capture shows it." }),
      h("li", { text: "Whether a real core reports an unaligned, straddling access with ISV = 1 varies. The VMM must stay safe either way, which is the point of the bus's check." }),
    ),
  );

  el.append(h("div", { class: "mt-wrap" },
    controls, stepBox, summary, source, options,
    h("div", { class: "mt-main" }, guestPane, vmmPane, mapPane),
    outputs, editor, simplifies,
    h("div", { class: "mt-buttons" }, shareBtn),
  ));

  // ---- rendering --------------------------------------------------------------------------
  function rebuild(step) {
    stopPlay();
    tl = timeline(ui.program, ui.options, ui.edits);
    ui.step = Math.min(Math.max(0, step), tl.frames.length - 1);
    renderStatic();
    render();
  }

  function renderStatic() {
    const p = PROGRAMS[ui.program];
    programSel.value = ui.program;
    summary.textContent = p.summary;
    source.textContent = `Source: ${p.source}.`;
    for (const [key] of [...OPTION_LABELS, ...BREAK_LABELS]) optionBoxes[key].checked = Boolean(ui.options[key]);
    policySel.value = ui.options.log ? "log" : "fatal";
    const keep = lineSel.value;
    lineSel.replaceChildren();
    tl.program.lines.forEach((l, i) => {
      lineSel.append(h("option", { value: String(i), text: `${i + 1}: ${hex(l.pc)}  ${l.text}${l.edited ? " (changed)" : ""}` }));
    });
    lineSel.value = keep && Number(keep) < tl.program.lines.length ? keep : "0";
    lineInput.value = tl.program.lines[Number(lineSel.value)].text;
    setAvailable(revertAllBtn, Object.keys(ui.edits).length > 0);
  }

  function render() {
    const frames = tl.frames;
    const f = frames[ui.step];
    const prev = ui.step > 0 ? frames[ui.step - 1] : null;
    const lines = tl.program.lines;

    // Listing.
    listing.replaceChildren();
    // The next line to run: the first listed line at or after the PC (skipped lines have no row).
    const nextIdx = ["ready", "cpu", "resume"].includes(f.phase) && !f.halted ? lines.findIndex((l) => l.pc >= f.pc) : -1;
    const nextOk = nextIdx >= 0 && f.pc >= lines[0].pc;
    lines.forEach((l, i) => {
      const atPc = nextOk && i === nextIdx;
      const handling = i === f.line && ["exit", "decode", "dispatch", "effect", "stop", "loop"].includes(f.phase);
      const cls = ["mt-line"];
      if (atPc) cls.push("mt-line--next");
      if (handling) cls.push("mt-line--trap");
      if (l.error) cls.push("mt-line--error");
      const li = h("li", { class: cls.join(" ") },
        h("span", { class: "mt-marker", "aria-hidden": "true", text: handling ? "!" : atPc ? "▶" : "" }),
        h("span", { class: "mt-addr", text: hex(l.pc).replace(/^0x/, "") }),
        h("span", { class: "mt-word", text: l.word === null ? "--------" : l.word.toString(16).padStart(8, "0") }),
        h("code", { class: "mt-ins", text: l.text }),
        l.edited ? h("span", { class: "mt-tag", text: "changed" }) : null,
        l.error ? h("span", { class: "mt-tag mt-tag--bad", text: "does not parse" }) : null,
      );
      if (atPc) {
        li.setAttribute("aria-current", "step");
        li.prepend(h("span", { class: "mt-vh", text: "Next to run: " }));
      }
      if (handling) li.prepend(h("span", { class: "mt-vh", text: "Trapped, being handled: " }));
      listing.append(li);
    });

    // Registers.
    regBody.replaceChildren();
    const changed = new Set(f.changed);
    for (const n of registersUsed(tl.program)) {
      const did = changed.has(n);
      regBody.append(h("tr", { class: did ? "mt-changed" : null },
        h("th", { scope: "row", text: `x${n}` }), h("td", { class: "mt-mono", text: hex64(f.regs[n]) }), h("td", { text: did ? "changed" : "" })));
    }
    const pcChanged = prev ? prev.pc !== f.pc : false;
    regBody.append(h("tr", { class: pcChanged ? "mt-changed" : null },
      h("th", { scope: "row", text: "pc" }), h("td", { class: "mt-mono", text: hex64(f.pc) }), h("td", { text: pcChanged ? "changed" : "" })));
    regBody.append(h("tr", {}, h("th", { scope: "row", text: "sp" }), h("td", { class: "mt-mono", text: hex64(f.sp) }), h("td", { text: "" })));

    // Phases.
    const pi = PHASES.indexOf(f.phase);
    const stopAt = f.phase === "stop" ? (f.dispatch ? 2 : 1) : f.phase === "loop" ? 5 : -1;
    for (const [k, ph] of PHASES.entries()) {
      const it = phaseItems[ph];
      let st = "";
      if (pi >= 0) st = k < pi ? "done" : k === pi ? "now" : "";
      else if (stopAt >= 0) st = k < stopAt ? "done" : k === stopAt ? "stopped here" : "";
      it.state.textContent = st ? ` (${st})` : "";
      it.li.className = "mt-phase" + (st === "now" ? " mt-phase--now" : st === "done" ? " mt-phase--done" : st ? " mt-phase--stop" : "");
      if (st === "now") it.li.setAttribute("aria-current", "step"); else it.li.removeAttribute("aria-current");
    }
    phaseList.classList.toggle("mt-phases--idle", pi < 0 && stopAt < 0);
    frameTitle.textContent = `Step ${ui.step} of ${frames.length - 1}: ${f.title}`;
    frameDetail.textContent = f.detail;
    haltBox.hidden = !f.halted;
    haltBox.textContent = f.halted ? f.halted.text : "";

    // Exit record.
    exitBody.replaceChildren();
    if (f.exit) {
      const e = f.exit;
      const rows = [
        ["reason", "exception (HV_EXIT_REASON_EXCEPTION)"],
        ["ESR_EL2", `0x${e.esr.toString(16).padStart(8, "0")}: EC 0x24, data abort from a lower exception level`],
        ["FAR_EL2", `${hex(e.far)} (the guest's virtual address)`],
        ["HPFAR_EL2", `${hex(e.hpfar)} (the IPA's page number, shifted left by 4)`],
        ["IPA", `${hex(e.ipa)} = page ${hex(e.ipa >> 12n)} plus the low 12 bits of FAR_EL2`],
        ["saved PC", `${hex(e.pc)} (the faulting instruction)`],
      ];
      for (const [k, v] of rows) exitBody.append(h("tr", {}, h("th", { scope: "row", text: k }), h("td", { class: "mt-mono", text: v })));
    } else {
      exitBody.append(h("tr", {}, h("td", { colspan: "2", class: "mt-empty", text: "No exit on this step." })));
    }
    decodeBody.replaceChildren();
    if (f.decode) {
      const d = f.decode;
      for (const [name, , bits, fmt] of DECODE_ROWS) {
        const stale = !d.isv && ["SAS", "SSE", "SRT", "SF"].includes(name);
        decodeBody.append(h("tr", { class: stale ? "mt-res0" : null },
          h("th", { scope: "row", text: name }), h("td", { text: bits }),
          h("td", { class: "mt-mono", text: stale ? `${fmt(d).split(":")[0]}: RES0, do not use` : fmt(d) })));
      }
      if (d.access?.guessed) decodeBody.append(h("tr", { class: "mt-res0" }, h("th", { scope: "row", text: "guess" }), h("td", { text: "" }), h("td", { text: `8 bytes, x${d.access.srt}: made up (breakage 3)` })));
    } else {
      decodeBody.append(h("tr", {}, h("td", { colspan: "3", class: "mt-empty", text: f.exit ? "Not decoded yet. Press Step." : "Nothing to decode." })));
    }

    // Memory map.
    mapBody.replaceChildren();
    const ipa = f.exit ? f.exit.ipa : null;
    for (const r of memoryMap(ui.options)) {
      const here = ipa !== null && ipa >= r.base && ipa < r.base + r.size;
      const state = r.state === "ram" ? "mapped RAM: no exits" : r.state === "device" ? "hole, device on the bus" : "hole, nothing on the bus";
      mapBody.append(h("tr", { class: here ? "mt-here" : null },
        h("td", { class: "mt-mono", text: hex(r.base) }),
        h("td", { text: `${r.label} (${hex(r.size)} bytes)` }),
        h("td", { text: state + (here ? ". This access is here." : "") })));
    }
    if (ipa !== null && !memoryMap(ui.options).some((r) => ipa >= r.base && ipa < r.base + r.size)) {
      const beyond = ipa >= 1n << IPA_BITS;
      mapBody.append(h("tr", { class: "mt-here" }, h("td", { class: "mt-mono", text: hex(ipa) }),
        h("td", { text: beyond ? `past the ${IPA_BITS}-bit IPA space` : "another hole" }), h("td", { text: "This access is here." })));
    }
    slotBody.replaceChildren();
    const slots = [...f.testdev.entries()].filter(([, v]) => v !== 0n).sort((a, b) => a[0] - b[0]);
    if (slots.length === 0) slotBody.append(h("tr", {}, h("td", { colspan: "2", class: "mt-empty", text: "All zero." })));
    for (const [i, v] of slots) slotBody.append(h("tr", {}, h("td", { class: "mt-mono", text: hex(i * 8) }), h("td", { class: "mt-mono", text: hex64(v) })));

    // Outputs (textContent only: guest-controlled text is never parsed as HTML).
    termOut.textContent = f.uart || "(nothing yet)";
    consoleOut.textContent = f.console.join("\n") || "(nothing yet)";
    stderrOut.textContent = f.stderr.join("\n") || "(nothing yet)";
    traceOut.textContent = f.trace.join("\n") || "(no records yet)";

    setAvailable(stepBtn, !f.halted);
    setAvailable(endBtn, !f.halted);
    setAvailable(playBtn, !f.halted || playTimer !== null);
    setAvailable(backBtn, ui.step > 0);
  }

  // Share state is written only after the reader does something, never on mount, so a link to
  // a section anchor keeps its fragment until the lab is used.
  function commit() {
    ctx.hash.set(encodeShare({ program: ui.program, step: ui.step, options: ui.options, edits: ui.edits }));
  }
  function current() {
    return summarize(tl.frames[ui.step], ui.step, tl.frames.length - 1);
  }

  function go(step) {
    ui.step = Math.min(Math.max(0, step), tl.frames.length - 1);
    if (tl.frames[ui.step].halted) stopPlay();
    render();
    commit();
    say(current());
  }

  function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    playBtn.textContent = "Play";
    playBtn.setAttribute("aria-pressed", "false");
  }

  // ---- events -----------------------------------------------------------------------------
  stepBtn.addEventListener("click", () => { if (!unavailable(stepBtn)) go(ui.step + 1); });
  backBtn.addEventListener("click", () => { if (unavailable(backBtn)) return; stopPlay(); go(ui.step - 1); });
  endBtn.addEventListener("click", () => { if (unavailable(endBtn)) return; stopPlay(); go(tl.frames.length - 1); });
  resetBtn.addEventListener("click", () => { stopPlay(); go(0); });
  playBtn.addEventListener("click", () => {
    if (playTimer) { stopPlay(); render(); return; }
    if (unavailable(playBtn)) return;
    playBtn.textContent = "Pause";
    playBtn.setAttribute("aria-pressed", "true");
    playTimer = setInterval(() => go(ui.step + 1), ctx.reducedMotion ? 1500 : 900);
  });
  programSel.addEventListener("change", () => {
    if (!PROGRAM_IDS.includes(programSel.value)) return;
    ui.program = programSel.value;
    ui.options = defaultOptions(ui.program);
    ui.edits = {};
    editMsg.textContent = "";
    rebuild(0);
    commit();
    say(current());
  });
  lineSel.addEventListener("change", () => {
    const l = tl.program.lines[Number(lineSel.value)];
    if (l) lineInput.value = l.text;
    editMsg.textContent = "";
  });
  function applyEdit() {
    const i = Number(lineSel.value);
    const p = PROGRAMS[ui.program];
    if (!Number.isInteger(i) || i < 0 || i >= p.lines.length) return;
    const text = lineInput.value.trim();
    const r = parseLine(text, p.funcs);
    if (!r.ok) {
      editMsg.textContent = `Not applied: ${r.error}.`;
      say(editMsg.textContent);
      return;
    }
    const edits = { ...ui.edits };
    if (text === p.lines[i][2]) delete edits[i]; else edits[i] = text;
    if (Object.keys(edits).length > 24) {
      editMsg.textContent = "Not applied: too many changed lines. Revert some first.";
      say(editMsg.textContent);
      return;
    }
    ui.edits = edits;
    editMsg.textContent = `Line ${i + 1} is now: ${text}. Restarted at step 0.`;
    rebuild(0);
    commit();
    say(editMsg.textContent);
  }
  applyBtn.addEventListener("click", applyEdit);
  lineInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); applyEdit(); }
  });
  revertBtn.addEventListener("click", () => {
    const i = Number(lineSel.value);
    const edits = { ...ui.edits };
    delete edits[i];
    ui.edits = edits;
    editMsg.textContent = `Line ${i + 1} reverted. Restarted at step 0.`;
    rebuild(0);
    commit();
    say(editMsg.textContent);
  });
  revertAllBtn.addEventListener("click", () => {
    if (unavailable(revertAllBtn)) return;
    ui.edits = {};
    editMsg.textContent = "All lines reverted. Restarted at step 0.";
    rebuild(0);
    commit();
    say(editMsg.textContent);
  });
  shareBtn.addEventListener("click", async () => {
    commit();
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this step is in the address bar.");
    }
  });

  rebuild(ui.step);

  return {
    destroy() {
      stopPlay();
      if (sayTimer) clearTimeout(sayTimer);
      sayTimer = null;
    },
  };
}
