// ESR decoder lab: the view. Renders the model's state and turns events into model actions.
// Builds DOM with createElement/textContent only (no innerHTML), touches nothing outside `el`
// except ctx.hash and ctx.announce, and keeps every id under ctx.id. Two read-only exceptions,
// noted in this lab's LABS.md row: the page path (to tell the primer from a chapter, which ctx
// does not say) and, only when the reader presses "Copy link", location.href and the clipboard.
import * as M from "./model.mjs";
import { CARDS } from "./cards.mjs";

const REASON_LABELS = {
  exception: "EXCEPTION (a guest exception; the syndrome is valid)",
  canceled: "CANCELED (the VMM's own kick)",
  vtimer: "VTIMER_ACTIVATED (the virtual timer fired)",
  unknown: "UNKNOWN (the syndrome is kept for the dump)",
};

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (v === false && !(k in node)) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k in node && !k.startsWith("aria") && k !== "for") node[k] = v;
    else node.setAttribute(k === "for" ? "for" : k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

export function mount(el, ctx) {
  const id = (s) => `${ctx.id}-${s}`;
  let state = M.initialState(ctx.hash?.get?.() ?? null);
  let announceTimer = null;
  let errorTimer = null;
  let lastAnnounced = "";
  // The spec-hunt cards belong to the reading-arm-specs primer; in a chapter several would spoil
  // later material, so they appear only there and on the lab's own page.
  let pagePath = "";
  try { pagePath = String(globalThis.location?.pathname ?? ""); } catch { /* no location: a chapter */ }
  const showCards = ctx.standalone === true || /\/primers\//.test(pagePath);

  // --- Controls ---------------------------------------------------------------------------
  const input = h("input", {
    id: id("input"), type: "text", class: "esr__input", value: state.text,
    spellcheck: false, autocomplete: "off", autocapitalize: "off", inputMode: "text",
    "aria-describedby": id("error"), maxLength: 64,
  });
  const presetSel = h("select", { id: id("preset"), class: "esr__select" },
    h("option", { value: "", text: "Choose a preset..." }),
    M.PRESETS.map((p) => h("option", { value: p.id, text: `${p.label} (${M.hex(p.esr)})` })));
  const reasonSel = h("select", { id: id("reason"), class: "esr__select", "aria-describedby": id("reasonhint") },
    M.REASONS.map((r) => h("option", { value: r, text: REASON_LABELS[r] })));
  const resetBtn = h("button", { type: "button", class: "esr__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "esr__btn", text: "Copy link to this value" });
  // Not a live region: errors reach screen readers once, through the debounced ctx.announce.
  const errorP = h("p", { id: id("error"), class: "esr__error" });

  const controls = h("div", { class: "esr__controls" },
    h("div", { class: "esr__control esr__control--wide" },
      h("label", { for: id("input"), text: "Syndrome (ESR_EL2), in hex" }), input),
    h("div", { class: "esr__control" }, h("label", { for: id("preset"), text: "Preset (seen on real hardware)" }), presetSel),
    h("div", { class: "esr__control" }, h("label", { for: id("reason"), text: "Exit reason from hv_vcpu_run" }), reasonSel,
      h("p", { class: "esr__hint", id: id("reasonhint"), text: "Most exits are EXCEPTION; the others carry no syndrome." })),
    h("div", { class: "esr__buttons" }, resetBtn, shareBtn),
    errorP);

  // --- Bit bar ----------------------------------------------------------------------------
  const help = h("p", { class: "esr__help", id: id("help"), text: "Bits: Tab into the bar, then Left and Right arrows move, Home and End jump, Space or Enter flips the bit. Each bit's name ends with its value, 0 or 1." });
  const labelRow = h("div", { class: "esr__labels", "aria-hidden": "true" });
  const bitRow = h("div", { class: "esr__bits", role: "group", "aria-label": "Bits 31 to 0 of the syndrome", "aria-describedby": id("help") });
  const indexRow = h("div", { class: "esr__index", "aria-hidden": "true" });
  const bitBtns = [];
  let focusIdx = 0; // 0 is bit 31
  for (let i = 0; i < 32; i++) {
    const n = 31 - i;
    const btn = h("button", { type: "button", class: "esr__bit", tabIndex: i === 0 ? 0 : -1 });
    btn.dataset.bit = String(n);
    btn.addEventListener("click", () => {
      // Safari does not focus a clicked button, so the focus listener may never run.
      focusIdx = i;
      syncTabIndex();
      dispatch({ type: "toggle", bit: n }, { toggled: n });
    });
    btn.addEventListener("focus", () => { focusIdx = i; syncTabIndex(); showFocus(); });
    btn.addEventListener("mouseenter", () => showFocus(i));
    bitBtns.push(btn);
    bitRow.append(btn);
    indexRow.append(h("span", { class: "esr__idx", text: String(n) }));
  }
  // Hover previews a bit; leaving the row gives the line back to the focused bit, if any.
  bitRow.addEventListener("mouseleave", () => {
    if (bitRow.contains(document.activeElement)) showFocus();
    else focusInfo.textContent = "";
  });
  bitRow.addEventListener("keydown", (e) => {
    let next = focusIdx;
    if (e.key === "ArrowLeft") next = Math.max(0, focusIdx - 1);
    else if (e.key === "ArrowRight") next = Math.min(31, focusIdx + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 31;
    else return;
    e.preventDefault();
    focusIdx = next;
    syncTabIndex();
    bitBtns[focusIdx].focus();
  });
  function showFocus(i = focusIdx) {
    const btn = bitBtns[i];
    focusInfo.textContent = `Bit ${btn.dataset.bit}: ${btn.dataset.field} = ${btn.textContent}`;
  }
  function syncTabIndex() {
    bitBtns.forEach((b, i) => { b.tabIndex = i === focusIdx ? 0 : -1; });
  }

  const focusInfo = h("p", { class: "esr__focusinfo", "aria-hidden": "true" });
  // On a phone the readout sits far below the bar: echo the summary under it (narrow screens
  // only, by CSS). Hidden from screen readers, which hear the summary through ctx.announce.
  const echoP = h("p", { class: "esr__echo", "aria-hidden": "true" });
  // While the syndrome box does not parse, say in words that everything shows the old value.
  const staleP = h("p", { class: "esr__stale", hidden: true });
  const hexOut = h("p", { class: "esr__hex" });
  const highP = h("p", { class: "esr__high" });
  const scrollHint = h("p", { class: "esr__scrollhint", id: id("scrollhint"), hidden: true, text: "The bar is wider than the screen: scroll it sideways for the lower bits (WnR, DFSC and the rest, down to bit 0)." });
  const scroller = h("div", { class: "esr__scroll" }, h("div", { class: "esr__grid" }, labelRow, bitRow, indexRow));
  const scrollWrap = h("div", { class: "esr__scrollwrap" }, scroller);
  const viz = h("div", { class: "esr__viz" },
    staleP,
    hexOut,
    scrollHint,
    scrollWrap,
    focusInfo, echoP, help, highP);
  function syncScrollHint() {
    const over = scroller.scrollWidth > scroller.clientWidth + 1;
    const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
    scrollHint.hidden = !over;
    scrollWrap.classList.toggle("esr__scrollwrap--more", over && !atEnd);
  }
  scroller.addEventListener("scroll", syncScrollHint, { passive: true });
  let resizeObs = null;
  if (typeof ResizeObserver === "function") {
    resizeObs = new ResizeObserver(() => { syncScrollHint(); syncTableScroll(); });
    resizeObs.observe(scroller);
  }

  // --- Readout ----------------------------------------------------------------------------
  const summaryP = h("p", { class: "esr__summary", id: id("summary") });
  const presetNote = h("p", { class: "esr__muted", hidden: true });
  const fieldMsg = h("p", { class: "esr__fieldmsg", id: id("fieldmsg") });
  const displayCode = h("code", { class: "esr__display" });
  const layoutP = h("p", { class: "esr__layout" });
  // Explicit roles: below 720px the CSS stacks each row as a card, and a table whose display
  // changes loses its implicit table semantics in some browsers.
  const fieldsBody = h("tbody", { role: "rowgroup" });
  const fieldsTable = h("table", { class: "esr__fields", role: "table" },
    h("caption", { text: "Fields, most significant first. Greyed, hatched rows are bits macvmm's decoder does not use." }),
    h("thead", { role: "rowgroup" }, h("tr", { role: "row" }, ["Field", "Bits", "Value", "Meaning"].map((t) => h("th", { scope: "col", role: "columnheader", text: t })))),
    fieldsBody);
  const tableWrap = h("div", { class: "esr__tablewrap" }, fieldsTable);
  // If the table still overflows (a wide screen with a narrow column), the wrapper scrolls
  // sideways: then it takes focus and has a name, so a keyboard reader can scroll it.
  function syncTableScroll() {
    const over = tableWrap.scrollWidth > tableWrap.clientWidth + 1;
    if (over) {
      tableWrap.setAttribute("tabindex", "0");
      tableWrap.setAttribute("role", "region");
      tableWrap.setAttribute("aria-label", "Fields table, scrolls sideways");
    } else {
      tableWrap.removeAttribute("tabindex");
      tableWrap.removeAttribute("role");
      tableWrap.removeAttribute("aria-label");
    }
    tableWrap.classList.toggle("esr__tablewrap--more", over && tableWrap.scrollLeft + tableWrap.clientWidth < tableWrap.scrollWidth - 1);
  }
  tableWrap.addEventListener("scroll", syncTableScroll, { passive: true });
  const vmmArm = h("code");
  const vmmNote = h("p", { class: "esr__muted", hidden: true });
  const vmmDoes = h("p");
  const vmmPc = h("p");
  const vmmLinks = h("ul", { class: "esr__links" });
  const readout = h("div", { class: "esr__readout" },
    h("h3", { class: "esr__h", text: "Readout" }),
    summaryP,
    presetNote,
    h("p", { class: "esr__prints" }, h("span", { text: "macvmm's dump prints: " }), displayCode),
    layoutP,
    h("p", { class: "esr__muted", text: "Type a field's value, then press Enter or leave the box. Register numbers, and the other fields macvmm's dump prints in decimal (SAS, SRT, Rt, Op0 to CRm, TI), take decimal, such as 31; the rest take hex, such as 0x16. Every box also takes 0x for hex and 0b for binary." }),
    fieldMsg,
    tableWrap,
    h("h3", { class: "esr__h", text: "What the VMM does" }),
    h("p", { class: "esr__muted", text: "The match arm in crates/vmm/src/vcpu/exit.rs that handles this exit, copied from the file (\"// ...\" marks arms left out):" }),
    // Long Rust lines scroll sideways: tabindex lets a keyboard reader scroll the block.
    h("pre", { class: "esr__code", tabIndex: 0, role: "region", "aria-label": "Match arm from exit.rs" }, vmmArm),
    vmmNote, vmmDoes, vmmPc, vmmLinks);

  // --- Spec-hunt cards --------------------------------------------------------------------
  const cards = !showCards
    ? h("p", { class: "esr__muted" }, "Spec-hunt cards for this lab, questions to answer with the ARM ARM open, are in the ",
      h("a", { href: "/build-your-own/vmm/primers/reading-arm-specs/", text: "reading-arm-specs primer" }), ".")
    : h("details", { class: "esr__cards" },
    h("summary", { text: `Spec-hunt cards (${CARDS.length}): answer with the document open, then reveal` }),
    h("p", { class: "esr__muted", text: "For each card, write down the document, the page or section title, and the answer before you reveal it." }),
    h("ol", { class: "esr__cardlist" }, CARDS.map((c) => {
      const body = [
        h("p", {}, h("strong", { text: "Where: " }), c.where),
        h("p", {}, h("strong", { text: "Answer: " }), c.answer),
      ];
      if (c.esr !== undefined) {
        const btn = h("button", { type: "button", class: "esr__btn", text: `Open ${M.hex(c.esr)} in the decoder` });
        btn.addEventListener("click", () => { dispatch({ type: "set", esr: c.esr }); input.focus(); });
        body.push(btn);
      }
      return h("li", { class: "esr__card" },
        h("p", { class: "esr__q", text: c.question }),
        h("details", {}, h("summary", { text: "Reveal", "aria-label": `Reveal answer: ${c.question}` }), body));
    })));

  const tryThis = ctx.standalone === true
    ? h("p", { class: "esr__try" }, h("strong", { text: "Try this: " }), "start with chapter 05's stop (the default). Clear ISV and watch SAS, SRT and SF turn hatched; set it again, then set SRT to 31 and see which register the VMM would use.")
    : null;
  el.append(...[tryThis, controls, viz, readout, cards].filter(Boolean));

  // --- Events -----------------------------------------------------------------------------
  input.addEventListener("input", () => dispatch({ type: "input", text: input.value }, { fromInput: true }));
  // Typing updates the decode at once, but the share link is written only when the reader
  // commits the value (change: Enter in some browsers, or leaving the box).
  input.addEventListener("change", () => { if (!state.error) pushHash(); });
  input.addEventListener("blur", () => { if (!state.error) { state = { ...state, text: M.hexGrouped(state.esr) }; input.value = state.text; } });
  presetSel.addEventListener("change", () => { if (presetSel.value) dispatch({ type: "preset", id: presetSel.value }); });
  reasonSel.addEventListener("change", () => dispatch({ type: "reason", reason: reasonSel.value }));
  resetBtn.addEventListener("click", () => {
    state = M.step(state, { type: "reset" });
    try { ctx.hash?.set?.(null); } catch { /* the lab works without share state */ }
    render(true);
  });
  shareBtn.addEventListener("click", async () => {
    pushHash();
    try {
      await globalThis.navigator.clipboard.writeText(String(globalThis.location.href));
      say("Link copied.");
    } catch {
      say("Could not copy; the link is in the address bar.");
    }
  });

  function dispatch(action, opts = {}) {
    state = M.step(state, action);
    if (!state.error && !opts.fromInput) pushHash();
    render(!opts.fromInput, opts);
  }

  function pushHash() {
    try { ctx.hash?.set?.(M.encodeHash(state)); } catch { /* ignore */ }
  }

  function say(text) {
    if (typeof ctx.announce === "function") ctx.announce(text);
  }

  // 300 ms for a click or a committed value; 800 ms while typing in the syndrome box, so a
  // half-typed value ("0x9", "0x93") is not read out unless the reader pauses on it.
  const TYPING_PAUSE = 800;
  function scheduleAnnounce(text, delay = 300) {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      announceTimer = null;
      if (text !== lastAnnounced) { lastAnnounced = text; say(text); }
    }, delay);
  }

  // A parse error is shown (and announced) only after the reader pauses, or at once when they
  // leave the box, so a half-typed "0x" is not flagged mid-word.
  function showError(now) {
    if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
    const apply = () => {
      errorTimer = null;
      const err = state.error;
      input.setAttribute("aria-invalid", err ? "true" : "false");
      errorP.textContent = err ? `Not a syndrome: ${err}` : "";
      staleP.hidden = !err;
      staleP.textContent = err ? `Not updated: the bar, the table and the readout still show the last valid value, ${M.hexGrouped(state.esr)}.` : "";
      readout.classList.toggle("esr__readout--stale", Boolean(err));
      if (err) scheduleAnnounce(`Not a syndrome: ${err}`);
    };
    if (now || !state.error) apply();
    else errorTimer = setTimeout(apply, 700);
  }
  input.addEventListener("blur", () => { if (state.error) showError(true); });

  // --- Render -----------------------------------------------------------------------------
  let tableSig = "";
  let lastSummary = "";
  function render(syncInput, opts = {}) {
    const v = M.view(state);
    const prevSummary = lastSummary;
    lastSummary = v.summary;
    if (syncInput && document.activeElement !== input) input.value = state.text;
    showError(!opts.fromInput);
    presetSel.value = v.preset ? v.preset.id : "";
    reasonSel.value = state.reason;
    hexOut.textContent = `ESR_EL2 = ${v.hex}`;
    highP.textContent = v.high ?? "";
    highP.hidden = !v.high;

    // Field labels and bit buttons.
    labelRow.replaceChildren();
    const fieldOf = new Array(32);
    v.fields.forEach((f, fi) => {
      const span = f.hi - f.lo + 1;
      const cell = h("span", { class: `esr__label${f.used ? "" : " esr__label--unused"}${fi % 2 ? " esr__label--alt" : ""}`, text: span >= 2 || f.name.length <= 3 ? f.name : f.name.slice(0, 3), title: `${f.name} [${f.hi === f.lo ? f.hi : `${f.hi}:${f.lo}`}]` });
      cell.style.gridColumn = `span ${span}`;
      labelRow.append(cell);
      for (let n = f.lo; n <= f.hi; n++) fieldOf[n] = { f, fi };
    });
    bitBtns.forEach((btn) => {
      const n = Number(btn.dataset.bit);
      const on = M.bit(state.esr, n);
      const { f, fi } = fieldOf[n];
      btn.textContent = on ? "1" : "0";
      // The value is in the name: "pressed" would leave the reader to guess that it means 1.
      btn.setAttribute("aria-label", `Bit ${n}, ${f.name}, value ${on ? 1 : 0}`);
      btn.dataset.field = `${f.name} [${f.hi === f.lo ? f.hi : `${f.hi}:${f.lo}`}]`;
      btn.className = "esr__bit" + (on ? " esr__bit--on" : "") + (f.used ? "" : " esr__bit--unused") + (fi % 2 ? " esr__bit--alt" : "") + (n === f.lo && n !== 0 ? " esr__bit--edge" : "");
    });

    if (bitRow.contains(document.activeElement)) showFocus();
    syncScrollHint();

    // Readout.
    summaryP.textContent = v.summary;
    echoP.textContent = v.summary;
    presetNote.textContent = v.preset?.note ?? "";
    presetNote.hidden = !v.preset?.note;
    displayCode.textContent = v.display;
    layoutP.textContent = state.reason === "exception"
      ? `ISS layout: ${v.layoutName === "raw" ? "not split for this class" : v.layoutName}.`
      : "This exit reason carries no syndrome; the bits are shown but not used.";
    if (!opts.keepFieldMsg) fieldMsg.textContent = "";
    renderFields(v.fields);
    syncTableScroll();

    vmmArm.textContent = v.vmm.arm;
    vmmNote.textContent = v.vmm.note ?? "";
    vmmNote.hidden = !v.vmm.note;
    vmmDoes.textContent = v.vmm.does;
    vmmPc.textContent = `PC: ${v.vmm.pc}`;
    vmmLinks.replaceChildren(...v.vmm.links.map((l) => h("li", {}, h("a", { href: l.href, text: l.text }))));

    if (opts.initial) lastAnnounced = v.summary; // nothing the reader did; do not speak over the lesson
    else if (state.error) { /* showError speaks */ }
    else if (opts.toggled !== undefined) scheduleAnnounce(toggleText(opts.toggled, v, prevSummary));
    else scheduleAnnounce(opts.say ? `${opts.say} ${v.summary}` : v.summary, opts.fromInput ? TYPING_PAUSE : 300);
  }

  /** "ISV is now 0." (or "Bit 22 is now 1; SAS is now 3."), then the summary or that it held. */
  function toggleText(n, v, prevSummary) {
    const f = v.fields.find((x) => x.lo <= n && n <= x.hi);
    const bitVal = M.bit(state.esr, n) ? 1 : 0;
    const head = f.hi === f.lo
      ? `${f.name} is now ${bitVal}.`
      : `Bit ${n} is now ${bitVal}; ${f.name} is now ${M.fieldText(f.value, f.radix)}.`;
    return v.summary === prevSummary ? `${head} The summary does not change.` : `${head} ${v.summary}`;
  }

  function renderFields(fields) {
    const sig = fields.map((f) => f.key).join(",");
    if (sig !== tableSig) {
      tableSig = sig;
      // Changing EC can switch the ISS layout and rebuild every row. Keep the reader's place:
      // refocus the control for the same field (EC and IL exist in every layout), else the
      // control in the same row.
      const active = document.activeElement;
      const had = active && fieldsBody.contains(active) ? active : null;
      const key = had?.dataset.key ?? null;
      const rowIdx = had ? [...fieldsBody.querySelectorAll("input")].indexOf(had) : -1;
      const sel = had && had.type === "text" ? [had.selectionStart, had.selectionEnd] : null;
      fieldsBody.replaceChildren(...fields.map((f) => fieldRow(f)));
      // The new rows are empty: fill every control before focus moves into one, so the
      // refocused box shows its value (the loop below skips a focused text box).
      fields.forEach((f, i) => {
        const ctl = fieldsBody.children[i].querySelector("input");
        if (!ctl) return;
        if (ctl.type === "checkbox") ctl.checked = f.value === 1;
        else ctl.value = M.fieldText(f.value, f.radix);
      });
      if (had) {
        const ctls = [...fieldsBody.querySelectorAll("input")];
        const next = ctls.find((c) => c.dataset.key === key) ?? ctls[Math.min(rowIdx, ctls.length - 1)];
        if (next) {
          next.focus();
          if (sel && next.type === "text" && next.dataset.key === key) {
            // Same text: keep the caret where it was. Reformatted text (16 -> 0x16): caret at end.
            const end = next.value.length;
            const [a, b] = had.value === next.value ? sel : [end, end];
            try { next.setSelectionRange(a, b); } catch { /* not a text control */ }
          }
        }
      }
    }
    fields.forEach((f, i) => {
      const row = fieldsBody.children[i];
      row.className = f.used ? "" : "esr__row--unused";
      const ctl = row.querySelector("input");
      const width = f.hi - f.lo + 1;
      if (ctl && (document.activeElement !== ctl || ctl.type === "checkbox")) {
        if (ctl.type === "checkbox") ctl.checked = f.value === 1;
        else {
          ctl.value = M.fieldText(f.value, f.radix);
          // The box now holds a valid value: drop any error left from an earlier bad entry.
          ctl.setAttribute("aria-invalid", "false");
        }
      }
      row.querySelector(".esr__val").textContent = width === 1 ? "" : ` = ${M.bin(f.value, width)}`;
      const unused = f.used || state.reason !== "exception" ? "" : "Not used by macvmm.";
      row.querySelector(".esr__meaning").textContent = [f.meaning, unused, f.note].filter(Boolean).join(". ").replace(/\.\./g, ".");
    });
  }

  function fieldRow(f) {
    const width = f.hi - f.lo + 1;
    const bits = f.hi === f.lo ? `bit ${f.hi}` : `bits ${f.hi} to ${f.lo}`;
    let ctl;
    let cell;
    if (width === 1) {
      ctl = h("input", { type: "checkbox", "aria-label": `${f.name}, ${bits}` });
      ctl.dataset.key = f.key;
      ctl.addEventListener("change", () => dispatch({ type: "field", lo: f.lo, width, value: ctl.checked ? 1 : 0 }));
      // A label around the checkbox gives it a 44px hit area without enlarging the box.
      cell = h("td", { class: "esr__valcell" }, h("label", { class: "esr__hit" }, ctl), h("span", { class: "esr__val" }));
    } else {
      ctl = h("input", {
        type: "text", class: "esr__num", "aria-label": `${f.name}, ${bits}, in ${f.radix === 10 ? "decimal" : "hex"}`,
        "aria-describedby": id("fieldmsg"), spellcheck: false, autocomplete: "off", autocapitalize: "off", maxLength: 40,
      });
      ctl.dataset.key = f.key;
      const preview = () => {
        const p = M.parseFieldValue(ctl.value, width, f.name, f.radix);
        const out = ctl.parentNode?.querySelector(".esr__val");
        if (out) out.textContent = p.ok ? ` = ${M.bin(p.value, width)}${p.masked ? " (masked)" : ""}` : " ?";
      };
      // Commit on Enter, or on change (leaving the box); typing only previews, so the table is
      // never rebuilt under the reader's fingers.
      const commit = () => {
        const p = M.parseFieldValue(ctl.value, width, f.name, f.radix);
        if (!p.ok) {
          fieldMsg.textContent = p.error;
          ctl.setAttribute("aria-invalid", "true");
          scheduleAnnounce(p.error);
          return;
        }
        ctl.setAttribute("aria-invalid", "false");
        const same = p.value === M.field(state.esr, f.lo, width);
        if (same && !p.masked) {
          ctl.value = M.fieldText(p.value, f.radix);
          fieldMsg.textContent = "";
          return;
        }
        fieldMsg.textContent = p.message;
        dispatch({ type: "field", lo: f.lo, width, value: p.value }, { keepFieldMsg: true, say: p.message });
        // A layout change replaces this row; the new control was filled by renderFields.
        if (ctl.isConnected) ctl.value = M.fieldText(M.field(state.esr, f.lo, width), f.radix);
      };
      ctl.addEventListener("input", preview);
      ctl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
      // Deferred, so a Tab has already moved focus when a layout change rebuilds the rows.
      ctl.addEventListener("change", () => setTimeout(commit, 0));
      cell = h("td", { class: "esr__valcell" }, ctl, h("span", { class: "esr__val" }));
    }
    cell.setAttribute("role", "cell");
    return h("tr", { role: "row" },
      h("th", { scope: "row", role: "rowheader", text: f.name }),
      h("td", { class: "esr__bitsrange", role: "cell", text: f.hi === f.lo ? String(f.hi) : `${f.hi}:${f.lo}` }),
      cell,
      h("td", { class: "esr__meaning", role: "cell" }));
  }

  render(true, { initial: true });

  return {
    destroy() {
      if (announceTimer) clearTimeout(announceTimer);
      if (errorTimer) clearTimeout(errorTimer);
      announceTimer = null;
      errorTimer = null;
      resizeObs?.disconnect();
    },
  };
}
