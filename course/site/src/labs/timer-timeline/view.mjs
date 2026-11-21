// timer-timeline: the view. Renders the model's snapshots; turns clicks into model actions.
// DOM is built with createElement/textContent only (no innerHTML, no inline styles), and
// nothing outside `el` is touched except ctx.hash and ctx.announce. See course/site/LABS.md.
import {
  LAST_STEP, buildRound, initialState, step, encodeHash, decodeHash, stepLine,
  signalRows, arithmetic, notes, summary, ms, dec, hex, parseU64, calc, calcPresets, readCtl,
} from "./model.mjs";

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

const PLAY_MS = 1600;
/** Quiet time before a key- or typing-driven announcement (LABS.md: about one per 300 ms). */
const SAY_MS = 400;

export function mount(el, ctx) {
  const id = ctx.id || "lab-timer-timeline";
  let state;
  try {
    const got = ctx.hash && ctx.hash.get();
    state = got ? decodeHash(got) : initialState();
  } catch {
    state = initialState();
  }
  let playing = null;
  let sayTimer = null;
  let calcSayTimer = null;

  const root = h("div", { class: "tt" + (ctx.reducedMotion ? " tt--still" : "") });

  // --- controls ---------------------------------------------------------------------------
  const prevBtn = h("button", { type: "button", class: "tt__btn", text: "Step back" });
  const nextBtn = h("button", { type: "button", class: "tt__btn tt__btn--primary", text: "Step" });
  const playBtn = h("button", { type: "button", class: "tt__btn", text: "Play" });
  const resetBtn = h("button", { type: "button", class: "tt__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "tt__btn", text: "Copy link to this state" });
  const buttons = h("div", { class: "tt__buttons" }, prevBtn, nextBtn, playBtn, resetBtn, shareBtn);

  function radioSet(name, legend, options) {
    const radios = options.map(([value, label]) => {
      const r = h("input", { type: "radio", name: `${id}-${name}`, id: `${id}-${name}-${value}`, value });
      return { value, r, label: h("label", { class: "tt__choice", for: r.id }, r, document.createTextNode(" " + label)) };
    });
    const set = h("fieldset", { class: "tt__group" }, h("legend", { text: legend }), ...radios.map((x) => x.label));
    return { set, radios };
  }
  const offsetSet = radioSet("offset", "Counter offset", [
    ["ref", "the host count at boot (the reference)"],
    ["zero", "0 (the guest sees the Mac's own count)"],
  ]);
  const timingSet = radioSet("timing", "Timing of each step", [
    ["trace", "measured on the reference Mac (exit trace)"],
    ["ideal", "ideal: woken exactly at the deadline"],
  ]);
  const revealBox = h("input", { type: "checkbox", id: `${id}-reveal` });
  const revealLabel = h("label", { class: "tt__choice", for: revealBox.id }, revealBox,
    document.createTextNode(" Show why exit 3 happens (chapter 11, sitting B)"));

  const controls = h("div", { class: "tt__controls" }, buttons, offsetSet.set, timingSet.set, revealLabel);

  // --- visualization -----------------------------------------------------------------------
  const nowLine = h("p", { class: "tt__line" });
  const help = h("p", { class: "tt__help", text: "Columns are moments in one round. Future columns show ? so you can predict them. ≈ marks a time the trace does not record. Each column heading is a button: Tab to the highlighted one, then use Left/Right (Home/End) to jump between steps." });
  const headRow = h("tr", {}, h("th", { scope: "col", class: "tt__sig", text: "Signal" }));
  const stepBtns = [];
  for (let i = 0; i <= LAST_STEP; i++) {
    const b = h("button", { type: "button", class: "tt__colbtn", tabindex: "-1" });
    stepBtns.push(b);
    headRow.append(h("th", { scope: "col", class: "tt__col" }, b));
  }
  const tbody = h("tbody");
  const table = h("table", { class: "tt__table" },
    h("caption", { text: "One round, step by step (state after each step)" }),
    h("thead", {}, headRow), tbody);
  const scroll = h("div", { class: "tt__scroll", tabindex: "0", role: "region", "aria-label": "Timeline table" }, table);
  const viz = h("div", { class: "tt__viz" }, nowLine, help, scroll);

  // --- readout -------------------------------------------------------------------------------
  const live = h("p", { class: "tt__summary", "aria-live": "polite", "aria-atomic": "true" });
  const arith = h("ul", { class: "tt__arith" });
  const noteList = h("ul", { class: "tt__notes" });
  const readout = h("div", { class: "tt__readout" }, h("h3", { class: "tt__h", text: "Readout" }), live, arith, noteList);

  // --- the WFI deadline calculator ------------------------------------------------------------
  const cEnable = h("input", { type: "checkbox", id: `${id}-c-en` });
  const cImask = h("input", { type: "checkbox", id: `${id}-c-im` });
  const cIstOut = h("p", { class: "tt__istatus" });
  const cBits = h("fieldset", { class: "tt__group" }, h("legend", { text: "CNTV_CTL_EL0 as the VMM reads it" }),
    h("label", { class: "tt__choice", for: cEnable.id }, cEnable, document.createTextNode(" ENABLE (the guest writes it)")),
    h("label", { class: "tt__choice", for: cImask.id }, cImask, document.createTextNode(" IMASK (the guest writes it)")),
    cIstOut);
  const istSet = radioSet("c-ist", "What if ISTATUS is not what the hardware computes?", [
    ["hw", "no: ISTATUS as the hardware computes it"],
    ["race", "race: CTL read just before the count reached CVAL (reads 0)"],
    ["one", "inconsistent read: ISTATUS = 1 whatever CVAL says"],
  ]);
  const cForget = h("input", { type: "checkbox", id: `${id}-c-forget` });
  const cForgetLabel = h("label", { class: "tt__choice", for: cForget.id }, cForget,
    document.createTextNode(" Bug: the VMM forgets the offset (compares CVAL with the host count)"));
  const cVal = h("input", { type: "text", id: `${id}-c-cval`, class: "tt__input", spellcheck: "false", autocomplete: "off", maxlength: "32" });
  const cValBox = h("div", { class: "tt__field" },
    h("label", { for: cVal.id, text: "CNTV_CVAL_EL0 (decimal, or 0x and hex)" }), cVal);
  const presetBox = h("div", { class: "tt__buttons" });
  const cOut = h("div", { class: "tt__calcout" });
  const cSay = h("p", { class: "tt__vh", "aria-live": "polite", "aria-atomic": "true" });
  const calcBody = h("div", { class: "tt__calc" },
    h("p", { text: "The guest writes ENABLE, IMASK and CVAL, so the VMM's WFI sleep rule must give a bounded answer for anything. ISTATUS is read-only: the hardware computes it. This uses the round's WFI exit (step 2) for the host count and the offset." }),
    cBits, cValBox, presetBox, istSet.set, cForgetLabel, cOut, cSay);
  const details = h("details", { class: "tt__details" },
    h("summary", { text: "Try your own CVAL: the WFI sleep rule" }), calcBody);

  root.append(controls, viz, readout, details);
  el.replaceChildren(root);

  // --- render ----------------------------------------------------------------------------------
  let snaps = buildRound(state);
  let calcFor = null; // the offset and timing the calculator's inputs were filled for

  function cellNode(c, i) {
    const td = h("td", { class: "tt__cell" });
    if (i > state.step) {
      td.classList.toggle("tt__cell--future", true);
      td.append(h("span", { class: "tt__q", text: "?" }));
      return td;
    }
    if (c.high === true) td.classList.toggle("tt__cell--hi", true);
    if (c.high === false) td.classList.toggle("tt__cell--lo", true);
    if (c.muted) td.classList.toggle("tt__cell--muted", true);
    if (i === state.step) td.classList.toggle("tt__cell--now", true);
    td.append(h("span", { text: c.text }));
    return td;
  }

  let shownStep = null; // the step the last render showed
  function render(opts = {}) {
    const prevStep = shownStep;
    shownStep = state.step;
    snaps = buildRound(state);
    const s = snaps[state.step];
    prevBtn.disabled = state.step === 0;
    nextBtn.disabled = state.step === LAST_STEP;
    for (const x of offsetSet.radios) x.r.checked = x.value === state.offset;
    for (const x of timingSet.radios) x.r.checked = x.value === state.timing;
    revealBox.checked = state.reveal;

    const line = stepLine(state.step, state.reveal);
    nowLine.replaceChildren(h("span", { class: "tt__tag", text: `Step ${state.step} of ${LAST_STEP}` }), document.createTextNode(" "), h("code", { text: line }));

    stepBtns.forEach((b, i) => {
      const x = snaps[i];
      const name = i === 0 ? "start" : `step ${i}`;
      b.replaceChildren(h("span", { class: "tt__n", text: name }),
        h("span", { class: "tt__t", text: (x.traced ? "" : "≈ ") + ms(x.tNs) }));
      b.setAttribute("aria-label", x.traced ? `${name}, ${ms(x.tNs)}, from the trace` : `${name}, about ${ms(x.tNs)}, estimated`);
      b.setAttribute("tabindex", i === state.step ? "0" : "-1");
      if (i === state.step) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });

    tbody.replaceChildren(...signalRows(snaps, state.reveal).map((r) =>
      h("tr", { class: `tt__row tt__row--${r.key}` }, h("th", { scope: "row", class: "tt__sig", text: r.label }),
        ...r.cells.map(cellNode))));

    const text = summary(s, state);
    if (sayTimer !== null) { clearTimeout(sayTimer); sayTimer = null; }
    if (opts.quiet) {
      // Key-driven: announce once the keys stop, not on every press.
      sayTimer = setTimeout(() => { sayTimer = null; live.textContent = text; }, SAY_MS);
    } else {
      live.textContent = text;
    }
    if (prevStep !== null && prevStep !== state.step) revealColumn();
    arith.replaceChildren(...arithmetic(s).map((t) => h("li", {}, h("code", { text: t }))));
    noteList.replaceChildren(...notes(s, state).map((t) => h("li", { text: t })));
    const calcKey = `${state.offset}-${state.timing}`;
    if (calcKey !== calcFor) { applyPreset(calcPresets(snaps[2])[0]); calcFor = calcKey; }
    renderPresets();
    renderCalc({ quiet: true });
  }

  // On a narrow screen the table scrolls sideways: keep the current column in view (without
  // moving focus). The CSS scroll padding keeps it clear of the sticky Signal column.
  function revealColumn() {
    const b = stepBtns[state.step];
    if (b && typeof b.scrollIntoView === "function") {
      b.scrollIntoView({ block: "nearest", inline: "nearest", behavior: ctx.reducedMotion ? "auto" : "smooth" });
    }
  }

  function renderPresets() {
    presetBox.replaceChildren(...calcPresets(snaps[2]).map((p) => {
      const b = h("button", { type: "button", class: "tt__btn tt__btn--small", text: p.label });
      b.addEventListener("click", () => { applyPreset(p); renderCalc({ now: true }); });
      return b;
    }));
  }

  function applyPreset(p) {
    cEnable.checked = p.enable;
    cImask.checked = p.imask;
    for (const x of istSet.radios) x.r.checked = x.value === p.istatus;
    cVal.value = dec(p.cval);
  }

  function istMode() {
    const on = istSet.radios.find((x) => x.r.checked);
    return on ? on.value : "hw";
  }

  // The full result is rendered silently; only its one-line answer is announced, once typing
  // has paused (opts.now for a single click, opts.quiet for re-renders the learner did not ask for).
  function sayCalc(text, opts) {
    if (calcSayTimer !== null) { clearTimeout(calcSayTimer); calcSayTimer = null; }
    if (opts.quiet) return;
    if (opts.now) { cSay.textContent = text; return; }
    calcSayTimer = setTimeout(() => { calcSayTimer = null; cSay.textContent = text; }, SAY_MS);
  }

  function renderCalc(opts = {}) {
    const wfi = snaps[2];
    const parsed = parseU64(cVal.value);
    if (!parsed.ok) {
      cVal.setAttribute("aria-invalid", "true");
      cIstOut.textContent = "ISTATUS (read-only, computed by the hardware): needs a CVAL";
      cOut.replaceChildren(h("p", { class: "tt__err", text: `Not a 64-bit value: ${parsed.error}.` }));
      sayCalc(`Not a 64-bit value: ${parsed.error}.`, opts);
      return;
    }
    cVal.removeAttribute("aria-invalid");
    const cval = parsed.value;
    const mode = istMode();
    const rd = readCtl({ enable: cEnable.checked, imask: cImask.checked, istatus: mode }, cval, wfi);
    const why = !cEnable.checked ? "the timer is off (with ENABLE = 0 its value means nothing; the VMM ignores it)"
      : rd.computed ? `because CNTVCT ${dec(wfi.cntvct)} ≥ CVAL` : `because CNTVCT ${dec(wfi.cntvct)} < CVAL`;
    cIstOut.textContent = `ISTATUS (read-only, computed by the hardware): ${rd.computed ? 1 : 0}, ${why}`
      + (mode === "hw" ? "" : `. What-if: the VMM reads ${rd.istatus ? 1 : 0}.`);
    const r = calc(rd.ctl, cval, wfi, { forgetOffset: cForget.checked });
    const lines = [
      `host now ${dec(r.now)}, CVAL ${dec(cval)} (${hex(cval)}), guest CNTVCT ${dec(wfi.cntvct)}`,
      r.forgot ? `offset used: 0 (bug: the real offset is ${dec(wfi.offset)})` : `offset ${dec(r.offset)}`,
      r.overflow ? "CVAL + offset does not fit in 64 bits (the checked add you write in chapter 11, sitting B, finds no answer)"
        : `host deadline = CVAL + offset = ${dec(r.deadline)}`,
    ];
    if (r.result.left !== undefined) lines.push(`ticks left = ${dec(r.result.left)}`);
    const kids = [
      h("ul", { class: "tt__arith" }, ...lines.map((t) => h("li", {}, h("code", { text: t })))),
      h("p", { class: "tt__answer" }, h("strong", { text: r.answer.text }), document.createTextNode(`: ${r.answer.why}.`)),
    ];
    if (r.forgot) {
      kids.push(h("p", { text: wfi.offset === 0n
        ? "With offset 0 the bug gives the right answer, so a fresh test boot hides it. Switch the counter offset to the reference to see it bite."
        : "CVAL is in guest time, a few million ticks; the host count is in the trillions. The deadline looks long past, so every WFI wakes at once and the guest spins in WFI exits instead of sleeping." }));
    }
    cOut.replaceChildren(...kids);
    sayCalc(`${r.answer.text}: ${r.answer.why}.`, opts);
  }

  function update(action, opts) {
    state = step(state, action);
    render(opts);
    try { ctx.hash && ctx.hash.set(encodeHash(state)); } catch { /* sharing is optional */ }
    // A button that just became disabled drops focus to <body>: hand it to its sibling.
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (active === prevBtn && prevBtn.disabled) nextBtn.focus();
    else if (active === nextBtn && nextBtn.disabled) prevBtn.focus();
  }

  function stopPlay() {
    if (playing !== null) { clearInterval(playing); playing = null; }
    playBtn.textContent = "Play";
  }

  // --- events (all inside el) ---------------------------------------------------------------
  prevBtn.addEventListener("click", () => { stopPlay(); update({ type: "prev" }); });
  nextBtn.addEventListener("click", () => { stopPlay(); update({ type: "next" }); });
  resetBtn.addEventListener("click", () => { stopPlay(); update({ type: "reset" }); nextBtn.focus(); });
  playBtn.addEventListener("click", () => {
    if (playing !== null) { stopPlay(); return; }
    if (state.step === LAST_STEP) update({ type: "goto", step: 0 });
    playBtn.textContent = "Pause";
    playing = setInterval(() => {
      update({ type: "next" });
      if (state.step === LAST_STEP) stopPlay();
    }, PLAY_MS);
  });
  for (const x of offsetSet.radios) x.r.addEventListener("change", () => { update({ type: "setOffset", offset: x.value }); });
  for (const x of timingSet.radios) x.r.addEventListener("change", () => { update({ type: "setTiming", timing: x.value }); });
  revealBox.addEventListener("change", () => update({ type: "setReveal", on: revealBox.checked }));
  stepBtns.forEach((b, i) => {
    b.addEventListener("click", () => { stopPlay(); update({ type: "goto", step: i }); });
    b.addEventListener("keydown", (e) => {
      let to = null;
      if (e.key === "ArrowRight") to = Math.min(LAST_STEP, i + 1);
      else if (e.key === "ArrowLeft") to = Math.max(0, i - 1);
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = LAST_STEP;
      if (to === null) return;
      if (e.preventDefault) e.preventDefault();
      stopPlay();
      update({ type: "goto", step: to }, { quiet: true });
      stepBtns[to].focus();
    });
  });
  for (const c of [cEnable, cImask, cForget]) c.addEventListener("change", () => renderCalc({ now: true }));
  for (const x of istSet.radios) x.r.addEventListener("change", () => renderCalc({ now: true }));
  cVal.addEventListener("input", () => renderCalc());
  shareBtn.addEventListener("click", async () => {
    try { ctx.hash && ctx.hash.set(encodeHash(state)); } catch { /* ignore */ }
    let copied = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof location !== "undefined") {
        await navigator.clipboard.writeText(location.href);
        copied = true;
      }
    } catch { /* clipboard may be refused; the address bar still holds the link */ }
    const msg = copied ? "Link copied." : "The link to this state is in the address bar.";
    if (ctx.announce) ctx.announce(msg);
    else live.textContent = msg;
  });

  render();
  return {
    destroy() {
      stopPlay();
      if (sayTimer !== null) clearTimeout(sayTimer);
      if (calcSayTimer !== null) clearTimeout(calcSayTimer);
      el.replaceChildren();
    },
  };
}
