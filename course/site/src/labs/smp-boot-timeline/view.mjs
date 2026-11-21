// smp-boot-timeline: the view. Renders the model's snapshots and turns events into model actions.
// DOM is built with createElement/textContent only (no innerHTML, no inline styles), and nothing
// outside `el` is touched except ctx.hash and ctx.announce. See course/site/LABS.md.
import {
  SCENARIOS, SCENARIO_IDS, BREAKS, MIN_CPUS, MAX_CPUS, initialState, step, snapshots,
  lastStep, encodeHash, decodeHash, summary, eventLine, eventSentence, vcpuLines, lookups,
  quickMoves, parseU64, hx, hxu, codeText, paperAnswers, scenarioLabel, encodeAct,
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

/** Slow enough to read a step's note; Play announces only the short head of each step. */
const PLAY_MS = 2800;
const PREDICT_CHOICES = [
  ["", "(no prediction)"], ["0", "0"], ["1", "1"], ["2", "2"], ["-2", "-2 INVALID_PARAMETERS"],
  ["-4", "-4 ALREADY_ON"], ["-5", "-5 ON_PENDING"], ["-9", "-9 INVALID_ADDRESS"],
];

export function mount(el, ctx) {
  const id = ctx.id || "lab-smp-boot-timeline";
  let state;
  try {
    const got = ctx.hash && ctx.hash.get();
    state = got ? decodeHash(got) : initialState();
  } catch {
    state = initialState();
  }
  let playing = null;
  let message = "";
  const predictions = new Map(); // paper step -> predicted code (this visit only)
  const answers = paperAnswers();

  const root = h("div", { class: "sbt" + (ctx.reducedMotion ? " sbt--still" : "") });

  // --- controls -------------------------------------------------------------------------------
  const scSelect = h("select", { id: `${id}-sc`, class: "sbt__select" },
    ...SCENARIO_IDS.map((s) => h("option", { value: s, text: scenarioLabel(s) })));
  const scField = h("div", { class: "sbt__field" }, h("label", { for: scSelect.id, text: "Scenario" }), scSelect);
  const prevBtn = h("button", { type: "button", class: "sbt__btn", text: "Step back" });
  const nextBtn = h("button", { type: "button", class: "sbt__btn sbt__btn--primary", text: "Step" });
  const playBtn = h("button", { type: "button", class: "sbt__btn", text: "Play" });
  const resetBtn = h("button", { type: "button", class: "sbt__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "sbt__btn", text: "Copy link to this state" });
  const buttons = h("div", { class: "sbt__buttons" }, prevBtn, nextBtn, playBtn, resetBtn, shareBtn);
  const source = h("p", { class: "sbt__source" });

  // paper: predict, reveal
  const predSelect = h("select", { id: `${id}-pred`, class: "sbt__select" },
    ...PREDICT_CHOICES.map(([v, t]) => h("option", { value: v, text: t })));
  const predLabel = h("label", { for: predSelect.id });
  const revealBox = h("input", { type: "checkbox", id: `${id}-reveal` });
  const paperBox = h("div", { class: "sbt__group" },
    h("div", { class: "sbt__field" }, predLabel, predSelect),
    h("label", { class: "sbt__choice", for: revealBox.id }, revealBox, document.createTextNode(" Show every answer")));

  // free: configuration and calls
  const cpusIn = h("input", { type: "number", id: `${id}-cpus`, class: "sbt__input sbt__input--num", min: String(MIN_CPUS), max: String(MAX_CPUS), step: "1" });
  const brkSelect = h("select", { id: `${id}-brk`, class: "sbt__select" },
    ...Object.entries(BREAKS).map(([k, t]) => h("option", { value: k, text: t })));
  const cfgBtn = h("button", { type: "button", class: "sbt__btn", text: "Build this machine" });
  const fromSel = h("select", { id: `${id}-from`, class: "sbt__select" });
  const targetIn = h("input", { type: "text", id: `${id}-target`, class: "sbt__input", value: "1", spellcheck: "false", autocomplete: "off", maxlength: "24" });
  const entryIn = h("input", { type: "text", id: `${id}-entry`, class: "sbt__input", value: "0x4008_0000", spellcheck: "false", autocomplete: "off", maxlength: "24" });
  const ctxIn = h("input", { type: "text", id: `${id}-ctx`, class: "sbt__input", value: "0", spellcheck: "false", autocomplete: "off", maxlength: "24" });
  const levelSel = h("select", { id: `${id}-level`, class: "sbt__select" }, h("option", { value: "0", text: "0 (one CPU)" }), h("option", { value: "1", text: "1 (a cluster)" }));
  const onBtn = h("button", { type: "button", class: "sbt__btn sbt__btn--primary", text: "Call CPU_ON" });
  const aiBtn = h("button", { type: "button", class: "sbt__btn", text: "Call AFFINITY_INFO" });
  const quick = h("div", { class: "sbt__buttons" });
  const freeErr = h("p", { class: "sbt__err", role: "status", id: `${id}-err` });
  targetIn.value = "1";
  entryIn.value = "0x4008_0000";
  ctxIn.value = "0";
  const field = (input, text) => h("div", { class: "sbt__field" }, h("label", { for: input.id, text }), input);
  const freeBox = h("div", { class: "sbt__free" },
    h("fieldset", { class: "sbt__group" }, h("legend", { text: "Machine (rebuilding clears the calls)" }),
      field(cpusIn, `vCPUs (${MIN_CPUS} to ${MAX_CPUS})`), field(brkSelect, "Breakage"), cfgBtn),
    h("fieldset", { class: "sbt__group" }, h("legend", { text: "A call from a running vCPU (hex)" }),
      field(fromSel, "Caller"), field(targetIn, "Target affinity (x1)"), field(entryIn, "Entry point (x2, CPU_ON)"),
      field(ctxIn, "Context ID (x3, CPU_ON)"), field(levelSel, "Lowest affinity level (AFFINITY_INFO)"),
      h("div", { class: "sbt__buttons" }, onBtn, aiBtn)),
    h("fieldset", { class: "sbt__group" }, h("legend", { text: "Other moves" }), quick),
    freeErr);

  const controls = h("div", { class: "sbt__controls" }, scField, buttons, source, paperBox, freeBox);

  // --- visualization -------------------------------------------------------------------------
  const start = h("p", { class: "sbt__start" });
  const help = h("p", { class: "sbt__help", text: "One row per step, time running down; after the step's description comes one column per vCPU. Rows you have not reached show ? so you can predict them. In the step column, Up and Down arrows move between steps." });
  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", { class: "sbt__table" }, h("caption", { text: "Timeline: what each vCPU did at each step" }), thead, tbody);
  const scroll = h("div", { class: "sbt__scroll", tabindex: "0", role: "region", "aria-label": "Timeline" }, table);
  const cards = h("div", { class: "sbt__cards" });
  const cardsScroll = h("div", { class: "sbt__scroll", tabindex: "0", role: "region", "aria-label": "vCPU state" }, cards);
  const lkBody = h("tbody");
  const lkTable = h("table", { class: "sbt__table sbt__lk" },
    h("caption", { text: "Three places that look up each vCPU's MPIDR (and the redistributor frame)" }),
    h("thead", {}, h("tr", {}, ...["vCPU", "Device tree reg", "Power table", "MPIDR_EL1", "Redistributor frame", "Agree?"].map((t) => h("th", { scope: "col", text: t })))),
    lkBody);
  const lkScroll = h("div", { class: "sbt__scroll", tabindex: "0", role: "region", "aria-label": "MPIDR lookups" }, lkTable);
  const viz = h("div", { class: "sbt__viz" }, start, help, scroll, h("h3", { class: "sbt__h", text: "vCPUs now" }), cardsScroll, lkScroll);

  // --- readout ---------------------------------------------------------------------------------
  const live = h("p", { class: "sbt__summary", "aria-live": "polite", "aria-atomic": "true" });
  const events = h("ul", { class: "sbt__events" });
  const note = h("p", { class: "sbt__note" });
  const out = h("div", { class: "sbt__out" });
  const readout = h("div", { class: "sbt__readout" }, h("h3", { class: "sbt__h", text: "Readout" }), live, events, note, out);

  root.append(controls, viz, readout);
  el.replaceChildren(root);

  // --- render ----------------------------------------------------------------------------------
  let snaps = snapshots(state);
  let stepBtns = [];

  function laneCell(s, lane, hidden) {
    const td = h("td", { class: "sbt__cell" });
    if (hidden) {
      const evs = s.events.filter((e) => e.lane === lane);
      if (evs.length) {
        td.classList.toggle("sbt__cell--future", true);
        td.append(h("span", { class: "sbt__q", text: "?" }));
      }
      return td;
    }
    for (const e of s.events.filter((x) => x.lane === lane)) {
      const bad = (e.code !== undefined && e.code < 0) || e.mismatch;
      const span = h("span", { class: "sbt__ev sbt__ev--" + e.kind + (bad ? " sbt__ev--bad" : "") + (e.stops ? " sbt__ev--stop" : ""), text: eventLine(e) });
      td.append(span);
    }
    for (const r of s.trace.filter((x) => x.reason === "canceled" && x.vcpu === lane)) {
      td.append(h("span", { class: "sbt__ev sbt__ev--stop", text: `canceled exit at pc ${r.pc}` }));
    }
    return td;
  }

  function renderTable() {
    const n = snaps[0].m.cpus;
    const traced = !!(SCENARIOS[state.sc] && SCENARIOS[state.sc].traceRecs);
    const free = state.sc === "free";
    const head = [h("th", { scope: "col", class: "sbt__stepcol", text: "Step" }), h("th", { scope: "col", class: "sbt__whatcol", text: "What happens" })];
    if (traced) head.push(h("th", { scope: "col", text: "Trace time (ns)" }));
    for (let i = 0; i < n; i++) head.push(h("th", { scope: "col", text: `vCPU ${i}` }));
    thead.replaceChildren(h("tr", {}, ...head));
    stepBtns = [];
    const rows = [];
    const cur = state.sc === "free" ? snaps.length - 1 : state.step;
    for (let k = 1; k < snaps.length; k++) {
      const s = snaps[k];
      const future = k > cur;
      // In the sandbox the latest step is plain text (there is nowhere to go), and every earlier
      // step is an undo back to it; in a scenario every step is a "go to" button.
      let b = null;
      let mark;
      if (free && k === cur) {
        mark = h("span", { class: "sbt__stepnum", "aria-current": "step", text: String(k) });
      } else {
        const roving = free ? k === cur - 1 : k === Math.max(cur, 1);
        b = h("button", { type: "button", class: "sbt__stepbtn", tabindex: roving ? "0" : "-1", text: String(k), "aria-label": free ? `Undo back to step ${k}` : `Go to step ${k}` });
        if (k === cur) b.setAttribute("aria-current", "step");
        mark = b;
      }
      stepBtns.push(b);
      const cells = [h("th", { scope: "row", class: "sbt__stepcol" }, mark), h("td", { class: "sbt__what", text: s.text || "" })];
      if (traced) cells.push(h("td", { class: "sbt__t", text: s.trace.length ? s.trace.map((r) => String(r.t_ns)).join(", ") : "not traced" }));
      for (let i = 0; i < n; i++) cells.push(laneCell(s, i, future && (state.sc !== "paper" || !state.reveal)));
      const tr = h("tr", { class: "sbt__row" + (k === cur ? " sbt__row--now" : "") + (future ? " sbt__row--future" : "") }, ...cells);
      rows.push(tr);
    }
    if (rows.length === 0) rows.push(h("tr", {}, h("td", { colspan: String(n + 2), class: "sbt__empty", text: state.sc === "free" ? "No calls yet. Make one with the controls." : "" })));
    tbody.replaceChildren(...rows);
    const buttonsLast = stepBtns.filter(Boolean).length;
    stepBtns.forEach((b, i) => {
      if (!b) return;
      const k = i + 1;
      b.addEventListener("click", () => {
        stopPlay();
        update({ type: "goto", step: k });
        // The table was rebuilt: put focus back on the same step (in the sandbox, step k is now
        // the latest and plain text, so focus the step before it, or the first call control).
        const again = stepBtns[k - 1] || stepBtns[k - 2];
        if (again) again.focus();
        else focusFreeStart();
      });
      b.addEventListener("keydown", (e) => {
        let to = null;
        const lastBtn = free ? buttonsLast : snaps.length - 1;
        if (e.key === "ArrowDown") to = Math.min(lastBtn, k + 1);
        else if (e.key === "ArrowUp") to = Math.max(1, k - 1);
        else if (e.key === "Home") to = 1;
        else if (e.key === "End") to = lastBtn;
        if (to === null) return;
        if (e.preventDefault) e.preventDefault();
        if (!free) { stopPlay(); update({ type: "goto", step: to }); }
        if (stepBtns[to - 1]) stepBtns[to - 1].focus();
      });
    });
  }

  function renderCards(m) {
    cards.replaceChildren(...m.vcpus.map((v) => {
      const dl = h("dl", { class: "sbt__dl" });
      for (const [k, val] of vcpuLines(v)) dl.append(h("dt", { text: k }), h("dd", { text: val }));
      const hid = `${id}-card-${v.index}`;
      return h("div", { class: `sbt__card sbt__card--${v.thread} sbt__card--${v.power}`, role: "group", "aria-labelledby": hid },
        h("h4", { class: "sbt__cardh", id: hid }, document.createTextNode(`vCPU ${v.index} `), h("span", { class: "sbt__badge", text: v.thread === "running" ? "running" : v.thread })),
        dl);
    }));
  }

  function renderLookups(m) {
    lkBody.replaceChildren(...lookups(m).map((r) => h("tr", { class: r.ok ? "" : "sbt__lk--bad" },
      h("th", { scope: "row", text: String(r.index) }),
      h("td", {}, h("code", { text: hx(r.dt) })),
      h("td", {}, h("code", { text: hx(r.table & 0xff_00ff_ffffn) })),
      h("td", {}, h("code", { text: hxu(r.reg) })),
      h("td", { text: `${hxu(r.frame, 8)}, reports ${hx(r.frameAff)}${r.frameGuess ? " (likely; not checked)" : ""}` }),
      h("td", { text: r.ok ? "yes" : "NO: " + r.problems.join("; ") }))));
  }

  function lines(title, arr, cls) {
    if (!arr.length) return null;
    return h("figure", { class: "sbt__fig" }, h("figcaption", { text: title }), h("pre", { class: "sbt__pre " + cls }, h("code", { text: arr.join("\n") })));
  }

  function renderFree(m) {
    cpusIn.value = String(state.free.cpus);
    brkSelect.value = state.free.brk;
    const running = m.vcpus.filter((v) => v.thread === "running");
    const prev = fromSel.value;
    fromSel.replaceChildren(...running.map((v) => h("option", { value: String(v.index), text: `vCPU ${v.index}` })));
    if (running.some((v) => String(v.index) === prev)) fromSel.value = prev;
    const can = running.length > 0;
    onBtn.disabled = !can;
    aiBtn.disabled = !can;
    quick.replaceChildren(...quickMoves(m).map((q) => {
      const key = encodeAct(q.act);
      const b = h("button", { type: "button", class: "sbt__btn sbt__btn--small", "data-move": key, text: q.label });
      b.addEventListener("click", () => {
        freeAct(q.act);
        // quick was rebuilt: keep focus on the same move if it is still offered.
        const btns = [...quick.children].filter((c) => c.tagName === "BUTTON");
        const again = btns.find((c) => c.getAttribute("data-move") === key) || btns[0];
        if (again) again.focus();
        else focusFreeStart();
      });
      return b;
    }));
    const allOff = m.vcpus.every((v) => v.power === "off");
    if (!quick.children.length) {
      const text = m.stopped ? "The machine has stopped. Undo the last call, or rebuild it."
        : allOff ? "Every vCPU is off, so no one can call CPU_ON: the real VM idles until --timeout or Ctrl-C. Undo the last call, or rebuild the machine."
          : "Nothing else to do right now.";
      quick.append(h("p", { class: "sbt__help", text }));
    }
    freeErr.textContent = message;
  }

  function render() {
    snaps = snapshots(state);
    const last = lastStep(state);
    const free = state.sc === "free";
    const k = free ? snaps.length - 1 : state.step;
    const s = snaps[k];
    scSelect.value = state.sc;
    prevBtn.disabled = k === 0;
    prevBtn.textContent = free ? "Undo last call" : "Step back";
    nextBtn.hidden = free;
    playBtn.hidden = free || state.sc === "paper";
    nextBtn.disabled = k === last;
    paperBox.hidden = state.sc !== "paper";
    freeBox.hidden = !free;
    source.textContent = free ? "A machine of your own, with the same rules as the reference VMM. RAM is 64 MiB at 0x4000_0000." : `From ${SCENARIOS[state.sc].source}.`;
    if (state.sc === "paper") {
      revealBox.checked = state.reveal;
      predLabel.textContent = k < last ? `Your prediction for call ${k + 1}` : "All nine calls made";
      predSelect.disabled = k >= last;
      predSelect.value = predictions.has(k + 1) ? String(predictions.get(k + 1)) : "";
    }

    start.textContent = free
      ? "Make a call with the controls: CPU_ON from vCPU 0 first, then let the target's thread take its mailbox."
      : "Press Step to advance one step. Before each step, guess what the ? cells will show.";
    renderTable();
    renderCards(s.m);
    renderLookups(s.m);
    if (free) renderFree(s.m);

    let verdict = "";
    if (state.sc === "paper" && k > 0 && predictions.has(k)) {
      const p = predictions.get(k);
      const a = answers[k - 1];
      verdict = p === a ? `You predicted ${codeText(p)}: right.` : `You predicted ${codeText(p)}; the answer is ${codeText(a)}.`;
    }
    // While playing, announce only the short head of each step, so speech keeps up.
    const said = summary(state, snaps, { short: playing !== null });
    live.textContent = verdict ? `${verdict} ${said}` : said;
    events.replaceChildren(...s.events.map((e) => h("li", { text: eventSentence(e) })));
    let noteText = s.note || "";
    if (verdict) noteText = verdict + (noteText ? " " + noteText : "");
    note.textContent = noteText;
    note.hidden = !noteText;
    out.replaceChildren(...[
      lines("Guest console (this step)", s.console, "sbt__pre--console"),
      lines("Linux log (this step)", s.log, "sbt__pre--console"),
      lines("Trace records (this step)", s.trace.map((r) => JSON.stringify(r)), "sbt__pre--trace"),
      lines("macvmm on stderr", s.stderr, "sbt__pre--console"),
    ].filter(Boolean));
  }

  function writeHash() {
    try { ctx.hash && ctx.hash.set(encodeHash(state)); } catch { /* sharing is optional */ }
  }

  function update(action) {
    const next = step(state, action);
    message = next.error || "";
    delete next.error;
    state = next;
    render();
    writeHash();
  }

  // A refused move is reported once, through freeErr (role=status), not also by ctx.announce.
  function freeAct(act) {
    update({ type: "freeAct", act });
  }

  function markInvalid(input, bad) {
    if (bad) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", freeErr.id);
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }

  function readHex(input, what) {
    const r = parseU64(input.value);
    if (!r.ok) {
      markInvalid(input, true);
      message = `${what}: ${r.error}.`;
      freeErr.textContent = message;
      return null;
    }
    markInvalid(input, false);
    return r.value;
  }

  /** Where focus goes in the sandbox when the control that had it is gone. */
  function focusFreeStart() {
    if (!onBtn.disabled) onBtn.focus();
    else if (!prevBtn.disabled) prevBtn.focus();
    else cfgBtn.focus();
  }

  // The label says what pressing it does (Play or Pause); no aria-pressed, so it is never
  // announced as "Pause, pressed". The playing state is styled with a class.
  function stopPlay() {
    if (playing !== null) {
      clearInterval(playing);
      playing = null;
      live.textContent = summary(state, snaps); // the full sentence once, on pause
    }
    playBtn.textContent = "Play";
    playBtn.classList.toggle("sbt__btn--playing", false);
  }

  // --- events (all inside el) ----------------------------------------------------------------
  scSelect.addEventListener("change", () => { stopPlay(); update({ type: "scenario", sc: scSelect.value }); });
  prevBtn.addEventListener("click", () => {
    stopPlay();
    update({ type: "prev" });
    if (prevBtn.disabled) {
      if (state.sc === "free") focusFreeStart();
      else nextBtn.focus();
    }
  });
  nextBtn.addEventListener("click", () => {
    stopPlay();
    update({ type: "next" });
    if (state.step === lastStep(state)) prevBtn.focus();
  });
  resetBtn.addEventListener("click", () => { stopPlay(); predictions.clear(); update({ type: "reset" }); });
  playBtn.addEventListener("click", () => {
    if (playing !== null) { stopPlay(); return; }
    if (state.step === lastStep(state)) update({ type: "goto", step: 0 });
    playBtn.textContent = "Pause";
    playBtn.classList.toggle("sbt__btn--playing", true);
    playing = setInterval(() => {
      update({ type: "next" });
      if (state.step === lastStep(state)) stopPlay();
    }, PLAY_MS);
  });
  predSelect.addEventListener("change", () => {
    const k = state.step + 1;
    if (predSelect.value === "") predictions.delete(k);
    else predictions.set(k, Number(predSelect.value));
  });
  revealBox.addEventListener("change", () => update({ type: "reveal", on: revealBox.checked }));
  cfgBtn.addEventListener("click", () => {
    const n = Number(cpusIn.value);
    if (!Number.isInteger(n) || n < MIN_CPUS || n > MAX_CPUS) {
      markInvalid(cpusIn, true);
      message = `vCPUs: a whole number from ${MIN_CPUS} to ${MAX_CPUS}.`;
      freeErr.textContent = message;
      return;
    }
    markInvalid(cpusIn, false);
    update({ type: "freeConfig", cpus: n, brk: brkSelect.value });
  });
  onBtn.addEventListener("click", () => {
    const target = readHex(targetIn, "Target");
    const entry = target === null ? null : readHex(entryIn, "Entry point");
    const c = entry === null ? null : readHex(ctxIn, "Context ID");
    if (c === null) return;
    freeAct({ t: "on", from: Number(fromSel.value), target, entry, ctx: c });
  });
  aiBtn.addEventListener("click", () => {
    const target = readHex(targetIn, "Target");
    if (target === null) return;
    freeAct({ t: "ai", from: Number(fromSel.value), target, level: BigInt(levelSel.value) });
  });
  shareBtn.addEventListener("click", async () => {
    writeHash();
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
      el.replaceChildren();
    },
  };
}
