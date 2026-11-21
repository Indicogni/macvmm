// pl011-poke view: renders the model's state and turns form input into model actions. All device
// logic lives in model.mjs; this file only builds DOM (createElement + textContent, never
// innerHTML) inside the element the lab shell hands us. See course/site/LABS.md.
import {
  REGISTERS, REG, SIZES, FR_BITS, INT_BITS, REFERENCE, MAX_ACTIONS, HOST_CAP,
  apply, replay, formatTable, fr, ris, mis, depth, hex, quoteBytes, bitNames, describeAction,
  validateAction, parseNumber, textToBytes, scoreLine, encodeShare, decodeShare,
} from "./model.mjs";

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

function byteText(b) {
  return b >= 0x20 && b < 0x7f ? `${String.fromCharCode(b)} ${hex(b)}` : hex(b);
}

const OTHER = "other";
// The untouched lab (the lesson's walk, nothing applied) writes no hash, so a reader who never
// touches the lab gets a clean URL.
const DEFAULT_SHARE = encodeShare({ actions: REFERENCE, cursor: 0 });

/** A visible key for a bit table: "RXFE: receive FIFO empty", built from the model's tables. */
function bitKey(table, label) {
  const dl = h("dl", { class: "pp-key", "aria-label": label });
  for (const b of [...table].reverse()) dl.append(h("div", {}, h("dt", { text: b.name }), h("dd", { text: b.meaning })));
  return dl;
}
const SHOW_HOST = 16;

export function mount(el, ctx) {
  const id = ctx.id;
  const shared = decodeShare(ctx.hash.get());
  let ui = shared
    ? { actions: shared.actions, cursor: shared.cursor }
    : { actions: [...REFERENCE], cursor: 0 };
  let guess = null;
  let lastScore = null;
  let message = "";
  let timer = null;
  let lastAnnounce = 0;

  function say(text) {
    const now = Date.now();
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, 300 - (now - lastAnnounce));
    timer = setTimeout(() => {
      timer = null;
      lastAnnounce = Date.now();
      ctx.announce(text);
    }, wait);
  }

  // ---- guest side: register accesses ----------------------------------------------------
  const regSel = h("select", { id: `${id}-reg` });
  for (const r of REGISTERS) regSel.append(h("option", { value: String(r.off), text: `${r.name} (${hex(r.off, 3)})` }));
  regSel.append(h("option", { value: OTHER, text: "Another offset (try RAZ/WI)..." }));
  const offIn = h("input", { id: `${id}-off`, type: "text", inputmode: "text", autocomplete: "off", spellcheck: "false", value: "0x050", size: "7" });
  const offField = h("div", { class: "pp-field", hidden: true }, h("label", { for: `${id}-off`, text: "Offset (0x000 to 0xfff)" }), offIn);
  const sizeSel = h("select", { id: `${id}-size` });
  for (const s of SIZES) sizeSel.append(h("option", { value: String(s), text: `${8 * s}-bit` }));
  sizeSel.value = "4";
  const valIn = h("input", { id: `${id}-val`, type: "text", autocomplete: "off", spellcheck: "false", value: "0x41", size: "11" });
  const writeBtn = h("button", { type: "submit", class: "pp-btn", text: "Write" });
  const readBtn = h("button", { type: "button", class: "pp-btn", text: "Read" });
  const regNote = h("p", { class: "pp-note" });
  const guestBox = h("form", { class: "pp-form", novalidate: true }, h("fieldset", { class: "pp-box" },
    h("legend", { text: "Guest: read and write registers" }),
    h("p", { class: "pp-note pp-note--lead", text: "These are the reads and writes (loads and stores) the guest's driver makes. Each one traps to the VMM, which hands it to the device model. A width is 8, 16, 32 or 64 bits; the chapter's \"An answer for every access\" says which ones reach a register. Pick a 64-bit width or another offset to see RAZ/WI: the read gives 0, the write is ignored." }),
    h("div", { class: "pp-row" },
      h("div", { class: "pp-field" }, h("label", { for: `${id}-reg`, text: "Register" }), regSel),
      offField,
      h("div", { class: "pp-field" }, h("label", { for: `${id}-size`, text: "Width" }), sizeSel),
      h("div", { class: "pp-field" }, h("label", { for: `${id}-val`, text: "Value to write" }), valIn),
      h("div", { class: "pp-buttons" }, writeBtn, readBtn),
    ),
    regNote,
    h("p", { class: "pp-note", text: "A read or write made in the middle of the walk replaces the walk's remaining steps." }),
  ));

  // ---- host side: typing ----------------------------------------------------------------
  const textIn = h("input", { id: `${id}-text`, type: "text", autocomplete: "off", spellcheck: "false", value: "ok", size: "12", maxlength: "64" });
  const pushBtn = h("button", { type: "submit", class: "pp-btn", text: "Type it" });
  const enterBtn = h("button", { type: "button", class: "pp-btn", text: "Press Enter (0x0d)" });
  const hostBox = h("form", { class: "pp-form", novalidate: true }, h("fieldset", { class: "pp-box" },
    h("legend", { text: "Host: the keyboard" }),
    h("p", { class: "pp-note pp-note--lead", text: "This is the other side: you, at the Mac, typing into the VMM's terminal. The guest never sees your keys directly; the VMM's input thread feeds them to the device, and the guest finds them only by reading DR." }),
    h("div", { class: "pp-row" },
      h("div", { class: "pp-field" }, h("label", { for: `${id}-text`, text: "Bytes the host types" }), textIn),
      h("div", { class: "pp-buttons" }, pushBtn, enterBtn),
    ),
    h("p", { class: "pp-note", text: "In raw mode a terminal sends Enter as 0x0d. Bytes go into the host's input queue (4 KiB) first, then into the UART's receive FIFO when it has room." }),
  ));

  // ---- the walk -------------------------------------------------------------------------
  const stepBtn = h("button", { type: "button", class: "pp-btn pp-btn--primary", text: "Step" });
  const backBtn = h("button", { type: "button", class: "pp-btn", text: "Back" });
  const runBtn = h("button", { type: "button", class: "pp-btn", text: "Run to end" });
  const startBtn = h("button", { type: "button", class: "pp-btn", text: "Back to start" });
  const resetBtn = h("button", { type: "button", class: "pp-btn", text: "Clear all steps" });
  const lessonBtn = h("button", { type: "button", class: "pp-btn", text: "Load the lesson's walk" });
  const shareBtn = h("button", { type: "button", class: "pp-btn", text: "Copy link" });
  const nextLine = h("p", { class: "pp-next" });
  const guessSel = h("select", { id: `${id}-guess` },
    h("option", { value: "", text: "no guess" }),
    h("option", { value: "high", text: "high" }),
    h("option", { value: "low", text: "low" }),
  );
  const guessField = h("div", { class: "pp-field pp-field--inline" },
    h("label", { for: `${id}-guess`, text: "Predict (scored when you move forward): after the next step the interrupt line is" }), guessSel);
  const scoreLineEl = h("p", { class: "pp-score" });
  const walkBox = h("div", { class: "pp-walk" },
    h("p", { class: "pp-start", text: "Start here: the steps below are the lesson's walk, the same sequence as the capture in the chapter. Predict the interrupt line, then press Step. When the walk ends, try your own reads, writes and typing in the two boxes below." }),
    h("div", { class: "pp-buttons", role: "group", "aria-label": "Stepping" }, stepBtn, backBtn, runBtn, startBtn, resetBtn, lessonBtn, shareBtn),
    nextLine, guessField, scoreLineEl,
  );

  // ---- the device -----------------------------------------------------------------------
  const fifoTitle = h("h3");
  const fifoList = h("ol", { class: "pp-fifo", "aria-label": "Receive FIFO, oldest byte first" });
  const hostTitle = h("h3");
  const hostList = h("ol", { class: "pp-fifo pp-fifo--host", "aria-label": "Host input queue, oldest byte first" });
  const hostNote = h("p", { class: "pp-note" });

  const frBody = h("tr");
  const frHead = h("tr", {}, h("th", { scope: "col", text: "FR" }));
  for (const b of [...FR_BITS].reverse()) frHead.append(h("th", { scope: "col", text: b.name }));
  frHead.append(h("th", { scope: "col", text: "value" }));
  const frTable = h("table", { class: "pp-bits" },
    h("caption", { text: "FR, computed on every read (bits 7 to 3)" }), h("thead", {}, frHead), h("tbody", {}, frBody));
  const frKey = bitKey(FR_BITS, "What the FR bits mean");

  const intHead = h("tr", {}, h("th", { scope: "col", text: "register" }));
  for (const b of [...INT_BITS].reverse()) intHead.append(h("th", { scope: "col", text: b.name }));
  intHead.append(h("th", { scope: "col", text: "value" }));
  const intBody = h("tbody");
  const intTable = h("table", { class: "pp-bits" },
    h("caption", { text: "Interrupt bits (6 to 4): MIS = RIS & IMSC" }), h("thead", {}, intHead), intBody);
  const intKey = bitKey(INT_BITS, "What the interrupt bits mean");
  const intKeyNote = h("p", { class: "pp-note", text: "IMSC is the mask the guest writes, RIS the raw status, MIS what reaches the line. IMSC also stores the modem and error bits (0 to 3 and 7 to 10), but nothing here ever raises them." });

  const lineEl = h("p", { class: "pp-line" });
  const termEl = h("p", { class: "pp-term" });

  const device = h("div", { class: "pp-device" },
    h("div", { class: "pp-col" },
      fifoTitle, h("div", { class: "pp-scroll" }, fifoList),
      hostTitle, h("div", { class: "pp-scroll" }, hostList), hostNote,
    ),
    h("div", { class: "pp-col" },
      h("div", { class: "pp-scroll" }, frTable), frKey,
      h("div", { class: "pp-scroll" }, intTable), intKey, intKeyNote,
      lineEl, termEl,
    ),
  );

  // ---- readout and log ------------------------------------------------------------------
  // The readout is the summary; it is spoken once per change through ctx.announce (say), so it
  // is deliberately not a live region of its own (LABS.md section 6: one channel).
  const readout = h("p", { class: "pp-readout" });
  const msgEl = h("p", { class: "pp-msg" });
  const logBody = h("tbody");
  const log = h("div", { class: "pp-scroll" }, h("table", { class: "pp-log" },
    h("caption", { text: "Every step so far (later steps of a loaded walk are shown dimmed)" }),
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: "#" }), h("th", { scope: "col", text: "step" }),
      h("th", { scope: "col", text: "read" }), h("th", { scope: "col", text: "status after the step" }))),
    logBody));
  const plain = h("pre", { class: "pp-plain" });
  const plainBox = h("details", { class: "pp-more" },
    h("summary", { text: "The applied steps as plain text, in the capture's format" }), plain);
  const honesty = h("details", { class: "pp-more" },
    h("summary", { text: "What this model simplifies" }),
    h("ul", {},
      h("li", { text: "It is the course's reference PL011, not the hardware: RX and RT stay set in RIS while the FIFO holds data, so ICR cannot clear them (the manual raises them at a trigger level and after a timeout)." }),
      h("li", { text: "Sending is instant: TXFE is always 1, TXFF and BUSY always 0, and TX latches on every DR write." }),
      h("li", { text: "The terminal line shows the bytes the guest sent. The real VMM filters them first, dropping escape sequences a guest must not send to your terminal (the ansi-filter lab in the tty-termios primer)." }),
      h("li", { text: "One push from the host side is at most 64 bytes; the host queue holds 4 KiB and drops what does not fit, never blocking." }),
      h("li", { text: "Accesses that name no register read as zero and ignore writes; the real VMM also logs a rate-limited warning." }),
    ),
  );

  el.append(h("div", { class: "pp-wrap" },
    walkBox,
    h("div", { class: "pp-controls" }, guestBox, hostBox),
    msgEl,
    readout,
    device,
    log,
    plainBox,
    honesty,
  ));

  // ---- rendering ------------------------------------------------------------------------
  function bitCells(tr, v, table) {
    for (const b of [...table].reverse()) {
      const on = (v & b.mask) !== 0;
      tr.append(h("td", { class: on ? "pp-bit pp-bit--on" : "pp-bit", text: on ? "1" : "0" }));
    }
    tr.append(h("td", { class: "pp-hex", text: hex(v) }));
  }

  function renderFifo(list, bytes, slots, max) {
    list.replaceChildren();
    const shown = bytes.slice(0, max);
    shown.forEach((b, i) => list.append(h("li", { class: "pp-slot pp-slot--full" },
      h("span", { class: "pp-visually-hidden", text: i === 0 ? "next out: " : "" }), byteText(b))));
    // One summary item for the empty slots, so a 32-byte FIFO is not read out as 32 "empty"s.
    const empty = Math.min(slots, max) - shown.length;
    if (empty === 1) list.append(h("li", { class: "pp-slot", text: "empty" }));
    else if (empty > 1) list.append(h("li", { class: "pp-slot pp-slot--rest", text: `${empty} empty slots` }));
  }

  function selectedRegister() {
    if (regSel.value === OTHER) return parseNumber(offIn.value, 0xfff);
    return Number(regSel.value);
  }

  function renderRegNote() {
    offField.hidden = regSel.value !== OTHER;
    const off = selectedRegister();
    const r = REGISTERS.find((x) => x.off === off);
    regNote.textContent = r ? `${r.name}: ${r.note}.` : (off === null ? "Type an offset like 0x050." : `${hex(off, 3)}: no register here, or not 4-byte aligned.`);
  }

  function render() {
    const rows = replay(ui.actions.slice(0, ui.cursor));
    const last = rows[rows.length - 1];
    const s = last.state;

    // Walk.
    const hasNext = ui.cursor < ui.actions.length;
    setDisabled([[stepBtn, !hasNext], [runBtn, !hasNext], [backBtn, ui.cursor === 0], [startBtn, ui.cursor === 0]]);
    guessField.hidden = !hasNext;
    guessSel.value = guess ?? "";
    if (hasNext) {
      const preview = apply(s, ui.actions[ui.cursor]).label;
      nextLine.textContent = `Next step (${ui.cursor + 1} of ${ui.actions.length}): ${preview}.`;
    } else {
      nextLine.textContent = ui.actions.length
        ? `All ${ui.actions.length} steps applied. Poke the registers below, or press Back.`
        : "No steps yet. Write or read a register, or type on the host side.";
    }
    scoreLineEl.textContent = lastScore
      ? (lastScore.right
        ? `You predicted ${lastScore.guess} after step ${lastScore.step}: right.`
        : `You predicted ${lastScore.guess} after step ${lastScore.step}; the line is ${lastScore.actual}.`)
      : "";

    // Device.
    const d = depth(s);
    fifoTitle.textContent = `Receive FIFO: ${s.rx.length} of ${d} byte${d === 1 ? "" : "s"} (${d === 1 ? "LCR_H.FEN clear" : "LCR_H.FEN set"})`;
    renderFifo(fifoList, s.rx, d, 32);
    hostTitle.textContent = `Host input queue: ${s.host.length} byte${s.host.length === 1 ? "" : "s"} waiting`;
    renderFifo(hostList, s.host, 0, SHOW_HOST);
    if (s.host.length === 0) hostList.append(h("li", { class: "pp-slot", text: "empty" }));
    const extra = [];
    if (s.host.length > SHOW_HOST) extra.push(`showing the first ${SHOW_HOST} of ${s.host.length}`);
    if (s.hostDropped) extra.push(`${s.hostDropped} dropped because the ${HOST_CAP}-byte queue was full`);
    hostNote.textContent = extra.join("; ");

    frBody.replaceChildren(h("th", { scope: "row", text: "now" }));
    bitCells(frBody, fr(s), FR_BITS);
    intBody.replaceChildren();
    for (const [name, v] of [["IMSC", s.imsc], ["RIS", ris(s)], ["MIS", mis(s)]]) {
      const tr = h("tr", {}, h("th", { scope: "row", text: name }));
      bitCells(tr, v, INT_BITS);
      intBody.append(tr);
    }
    lineEl.textContent = `Interrupt line: ${s.line ? "HIGH" : "low"}${s.transitions.length ? ` (changes so far: ${s.transitions.map((x) => (x ? "high" : "low")).join(", ")})` : ""}`;
    lineEl.classList.toggle("pp-line--high", s.line);
    termEl.textContent = `Sent to the terminal: ${quoteBytes(s.tx)}`;

    // Readout.
    const where = `FR ${hex(fr(s))} (${bitNames(fr(s), FR_BITS)}), RIS ${hex(ris(s))}, MIS ${hex(mis(s))}, line ${s.line ? "high" : "low"}.`;
    readout.textContent = ui.cursor === 0
      ? `${last.effect} ${where}`
      : `Step ${ui.cursor}, ${last.label}${last.read === null ? "" : ` returned ${hex(last.read)}`}. ${last.effect} Now: ${where}`;
    msgEl.textContent = message;
    msgEl.hidden = !message;

    // Log.
    logBody.replaceChildren();
    const future = ui.actions.slice(ui.cursor);
    rows.forEach((r, i) => {
      const current = i === rows.length - 1;
      logBody.append(h("tr", { class: current ? "pp-current" : "", "aria-current": current ? "step" : null },
        h("td", {}, String(i), current ? h("span", { class: "pp-visually-hidden", text: " (current)" }) : null),
        h("td", { class: "pp-mono", text: r.label }),
        h("td", { class: "pp-mono", text: r.read === null ? "" : hex(r.read) }), h("td", { class: "pp-mono", text: r.status })));
    });
    future.forEach((a, j) => logBody.append(h("tr", { class: "pp-future" },
      h("td", { text: String(ui.cursor + j + 1) }),
      h("td", { class: "pp-mono", text: describeAction(a) }),
      h("td", { text: "" }), h("td", { text: "not yet" }))));
    plain.textContent = formatTable(rows);

    renderRegNote();
    // "~0" is the share string for an empty walk (encodeShare gives ""), so a cleared lab
    // survives a reload instead of coming back as the lesson's walk.
    const str = encodeShare(ui);
    ctx.hash.set(str === DEFAULT_SHARE ? null : (str === "" ? "~0" : str));
  }

  // Disabling the focused button would drop focus to <body>; move it to a neighbour that stays
  // enabled first, so keyboard and screen reader users keep their place.
  function setDisabled(pairs) {
    const active = document.activeElement;
    const losing = pairs.some(([btn, off]) => off && btn === active);
    for (const [btn, off] of pairs) btn.disabled = off;
    if (losing) {
      const next = [stepBtn, backBtn, startBtn, lessonBtn].find((b) => !b.disabled);
      if (next && typeof next.focus === "function") next.focus();
    }
  }

  function go(cursor, { score = false } = {}) {
    const target = Math.max(0, Math.min(ui.actions.length, cursor));
    lastScore = null;
    message = "";
    if (guess && score && target > ui.cursor) {
      // Scored against the state after the next step, also on Run to end.
      const after = replay(ui.actions.slice(0, ui.cursor + 1));
      const r = scoreLine(guess, after[after.length - 1].state.line);
      lastScore = r && { ...r, step: ui.cursor + 1 };
    } else if (guess) {
      message = "Your prediction was not scored: predictions are scored when you move forward with Step or Run to end.";
    }
    ui.cursor = target;
    guess = null;
    render();
    say((lastScore ? scoreLineEl.textContent + " " : "") + (message ? message + " " : "") + readout.textContent);
  }

  function poke(a) {
    const err = validateAction(a);
    if (err) {
      message = `Not applied: ${err}.`;
      render();
      say(message);
      return;
    }
    if (ui.cursor >= MAX_ACTIONS) {
      message = `Not applied: the lab keeps at most ${MAX_ACTIONS} steps. Press Clear all steps to start again.`;
      render();
      say(message);
      return;
    }
    const dropped = ui.actions.length - ui.cursor;
    ui = { actions: [...ui.actions.slice(0, ui.cursor), a], cursor: ui.cursor + 1 };
    lastScore = null;
    guess = null;
    message = dropped ? `The ${dropped} remaining step${dropped === 1 ? "" : "s"} of the loaded walk ${dropped === 1 ? "was" : "were"} replaced by your step.` : "";
    render();
    say(readout.textContent);
  }

  function access(op) {
    const off = selectedRegister();
    if (off === null) {
      message = "Not applied: the offset must be a number from 0x000 to 0xfff.";
      render();
      say(message);
      return;
    }
    const size = Number(sizeSel.value);
    if (op === "r") return poke({ op: "r", off, size });
    const val = parseNumber(valIn.value);
    if (val === null) {
      message = "Not applied: the value must be a number like 0x41 or 65, at most 32 bits.";
      render();
      say(message);
      return;
    }
    poke({ op: "w", off, size, val });
  }

  // ---- events ---------------------------------------------------------------------------
  stepBtn.addEventListener("click", () => go(ui.cursor + 1, { score: true }));
  backBtn.addEventListener("click", () => go(ui.cursor - 1));
  runBtn.addEventListener("click", () => go(ui.actions.length, { score: true }));
  startBtn.addEventListener("click", () => go(0));
  resetBtn.addEventListener("click", () => {
    ui = { actions: [], cursor: 0 };
    go(0);
  });
  lessonBtn.addEventListener("click", () => {
    ui = { actions: [...REFERENCE], cursor: 0 };
    go(0);
  });
  guessSel.addEventListener("change", () => {
    guess = guessSel.value === "high" || guessSel.value === "low" ? guessSel.value : null;
  });
  regSel.addEventListener("change", renderRegNote);
  offIn.addEventListener("input", renderRegNote);
  // Write and "Type it" are submit buttons, so Enter in a text field does what a keyboard user
  // expects. The forms never actually submit.
  guestBox.addEventListener("submit", (e) => {
    e.preventDefault();
    access("w");
  });
  readBtn.addEventListener("click", () => access("r"));
  hostBox.addEventListener("submit", (e) => {
    e.preventDefault();
    const r = textToBytes(textIn.value);
    if (r.error) {
      message = `Not typed: ${r.error}.`;
      render();
      say(message);
      return;
    }
    poke({ op: "h", bytes: r.bytes });
  });
  enterBtn.addEventListener("click", () => poke({ op: "h", bytes: [0x0d] }));
  shareBtn.addEventListener("click", async () => {
    render();
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this state is in the address bar.");
    }
  });

  regSel.value = String(REG.DR);
  render();

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
