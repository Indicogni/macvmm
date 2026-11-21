// toy-vmm view: renders the model's state and turns controls into model calls.
// All logic lives in model.mjs. DOM is built with createElement and textContent only.
import {
  BUDGET,
  COST,
  MODES,
  MODE_INFO,
  VMM_BASE,
  VMM_LIMIT,
  breakdown,
  createState,
  describe,
  formatShare,
  formatTime,
  guestImage,
  guestMode,
  guestPc,
  isDone,
  runSteps,
  runToEnd,
  stateFromShare,
  step,
  summary,
} from "./model.mjs";

const TRACE_ROWS = 40;
const PLAY_MS = 120;
/** Play's pace when the reader prefers reduced motion. */
const PLAY_MS_REDUCED = 500;
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
const hex = (n) => "0x" + hex2(n);
const num = (n) => n.toLocaleString("en-US");

/** Tiny element builder: attributes are set with setAttribute, children appended as text or nodes. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
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

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el, ctx) {
  const id = ctx.id;
  const reduced = Boolean(ctx.reducedMotion);
  let state = (ctx.hash && stateFromShare(ctx.hash.get())) || createState("A");
  let timer = null;
  const compareRows = {};

  // Throttled announcements through the page's polite live region.
  let lastSaid = 0;
  let pendingSay = null;
  function say(text) {
    if (typeof ctx.announce !== "function") return;
    const now = Date.now();
    clearTimeout(pendingSay);
    if (now - lastSaid >= 300) {
      lastSaid = now;
      ctx.announce(text);
    } else {
      pendingSay = setTimeout(() => {
        lastSaid = Date.now();
        ctx.announce(text);
      }, 300 - (now - lastSaid));
    }
  }

  function saveHash() {
    if (!ctx.hash) return;
    const fresh = state.mode === "A" && state.n.steps === 0;
    ctx.hash.set(fresh ? null : formatShare(state));
  }

  // ---- Controls ---------------------------------------------------------------------------
  const root = h("div", { class: "tv" });
  const controls = h("div", { class: "tv__controls" });

  // A suggested path: the lab appears early in chapter 00, before modes D to H are taught.
  const tryThis = h(
    "div",
    { class: "tv__try" },
    h("p", { class: "tv__try-head", text: "Try this" }),
    h(
      "ol",
      {},
      h("li", { text: "Run mode A to the end: the console prints 123, the reference." }),
      h("li", { text: "Step mode B once." }),
      h("li", { text: "Run mode C and compare the VMM interventions." }),
      h("li", { text: "Modes D to H are explained further down chapter 00; come back for them, and predict before you run." }),
    ),
  );
  if (ctx.standalone && ctx.base) {
    try {
      const chapter = new URL("../../../start/orientation/", ctx.base);
      tryThis.append(h("p", { class: "tv__note" }, "The strategies are explained in ", h("a", { href: chapter.pathname, text: "chapter 00" }), "."));
    } catch {
      /* no link without a base URL */
    }
  }
  controls.append(tryThis);

  const modeSet = h("fieldset", { class: "tv__modes" }, h("legend", { text: "Strategy (run mode)" }));
  const modeInputs = {};
  for (const m of MODES) {
    const input = h("input", { type: "radio", name: `${id}-mode`, id: `${id}-mode-${m}`, value: m });
    input.addEventListener("change", () => {
      if (input.checked) setMode(m);
    });
    modeInputs[m] = input;
    modeSet.append(h("label", { class: "tv__mode", for: `${id}-mode-${m}` }, input, h("span", { class: "tv__mode-letter", text: m }), h("span", { text: MODE_INFO[m].name })));
  }
  controls.append(modeSet);

  const about = h("p", { class: "tv__about" });
  controls.append(about);

  const optSet = h("fieldset", { class: "tv__opts" }, h("legend", { text: "What traps" }));
  const optDefs = [
    { key: "getmodePrivileged", modes: ["E"], short: "Make GETMODE privileged", label: "Make GETMODE privileged (the fix Popek and Goldberg ask of processor designers; this turns mode E into mode D)" },
    { key: "trapBase", modes: ["H"], short: "Trap base-register writes", label: "Trap base-register writes (SETBASE)" },
    { key: "trapIE", modes: ["H"], short: "Also trap the interrupt switch", label: "Also trap the interrupt switch (CLI and STI). Real hardware does not: it keeps a virtual interrupt mask for the guest" },
    { key: "trapConsole", modes: ["H"], short: "Trap the console range", label: "Trap the console range (0xF0 to 0xFF). Unticked, the VMM maps plain memory there instead" },
  ];
  const optInputs = {};
  for (const d of optDefs) {
    const input = h("input", { type: "checkbox", id: `${id}-opt-${d.key}` });
    input.addEventListener("change", () => {
      stop();
      state = createState(state.mode, { ...state.opts, [d.key]: input.checked });
      saveHash();
      render();
      say(`${d.short}: ${input.checked ? "on" : "off"}. Run restarted.`);
    });
    optInputs[d.key] = input;
    d.row = h("div", { class: "tv__opt" }, input, h("label", { for: `${id}-opt-${d.key}`, text: d.label }));
    optSet.append(d.row);
  }
  controls.append(optSet);

  const btn = (text, fn, extra = {}) => {
    const b = h("button", { type: "button", class: "tv__btn", ...extra, text });
    b.addEventListener("click", fn);
    return b;
  };
  const bStep = btn("Step", () => act((s) => step(s), "step"));
  const bStep10 = btn("Step 10", () => act((s) => runSteps(s, 10), "step10"));
  const bRun = btn(`Run to ${num(BUDGET)}`, () => act((s) => runToEnd(s), "run"));
  // The label changes between Play and Pause, so it is not also an aria-pressed toggle.
  const bPlay = btn("Play", togglePlay);
  const bReset = btn("Reset", () => {
    stop();
    state = createState(state.mode, state.opts);
    saveHash();
    render();
    say(`Mode ${state.mode} reset.`);
  });
  controls.append(h("div", { class: "tv__buttons" }, bStep, bStep10, bRun, bPlay, bReset));
  controls.append(
    h("p", {
      class: "tv__hint",
      text: reduced
        ? "Step shows who executes each instruction: the CPU natively, or the VMM. Play steps on its own, slowly, until you pause it; the trace scrolls when you pause."
        : "Step shows who executes each instruction: the CPU natively, or the VMM. Play steps on its own until you pause it.",
    }),
  );

  // ---- Visualization ------------------------------------------------------------------------
  const listingWrap = h("div", { class: "tv__scroll", tabindex: "0", role: "region", "aria-label": "Guest listing" });
  const stateBox = h("dl", { class: "tv__state" });
  const vmmBox = h("dl", { class: "tv__state" });
  const vmmHead = h("h3", { class: "tv__h", text: "The VMM" });
  // Not an <output>: that is a live region, and the console is reported through ctx.announce.
  const consoleOut = h("pre", { class: "tv__console", id: `${id}-console` });
  let shownConsole = null;
  const main = h(
    "div",
    { class: "tv__main" },
    h("div", { class: "tv__col" }, h("h3", { class: "tv__h", text: "The guest" }), listingWrap),
    h(
      "div",
      { class: "tv__col" },
      h("h3", { class: "tv__h", text: "Processor state" }),
      stateBox,
      vmmHead,
      vmmBox,
      h("h3", { class: "tv__h", text: "Console" }),
      consoleOut,
    ),
  );

  // ---- Readout ------------------------------------------------------------------------------
  const summaryP = h("p", { class: "tv__summary" });
  const counters = h("dl", { class: "tv__counters" });
  const readout = h(
    "div",
    { class: "tv__readout" },
    h("h3", { class: "tv__h", text: "Readout" }),
    summaryP,
    counters,
    h("p", { class: "tv__note", text: `Toy model: ${COST.nativeNs} ns per native instruction, 1 µs per VMM intervention. The cost model is invented; the real exit cost is measured in chapter 03.` }),
  );

  const traceWrap = h("div", { class: "tv__scroll tv__trace-wrap", tabindex: "0", role: "region", "aria-label": "Step trace" });
  const trace = h("section", { class: "tv__trace" }, h("h3", { class: "tv__h", text: "Step trace: who executes each instruction" }), traceWrap);

  // The table answers the lesson's predictions for modes D and E, so it sits behind a button.
  const compareBody = h("div", {});
  const bShowAnswers = btn("Show the answers", () => {
    const table = compareTable();
    clear(compareBody);
    compareBody.append(table);
    renderCompareHighlight(state);
    table.focus();
  });
  compareBody.append(h("p", { class: "tv__note", text: "This table holds the answers to chapter 00's predictions for modes D and E. Make your predictions first." }), bShowAnswers);
  const compare = h(
    "details",
    { class: "tv__details" },
    h("summary", { text: `Answers: all eight modes run to ${num(BUDGET)} guest instructions (open after your predictions)` }),
    compareBody,
  );

  const honesty = h(
    "details",
    { class: "tv__details" },
    h("summary", { text: "Where the toy is wrong" }),
    h(
      "ul",
      {},
      h("li", { text: "The toy has two privilege modes (three in mode H); Arm has four, EL0 to EL3. Chapter 02 meets them." }),
      h("li", { text: "A toy trap leaves no record of why it happened: the VMM re-reads the instruction at or just before the saved PC. A real trap leaves the reason and the return address in registers." }),
      h("li", { text: "Mode F rewrites only GETMODE. A real binary translator rewrites the privileged instructions in kernel code too, so translated code rarely traps." }),
      h("li", { text: "Mode H can trap the interrupt switch, as an experiment. Real hardware keeps a virtual interrupt mask for the guest instead; on Arm, the guest's own mask switch cannot be trapped at all." }),
      h("li", { text: "QEMU's emulator translates blocks of guest code rather than interpreting one instruction at a time, so mode C overstates its cost." }),
      h("li", { text: "The interrupt-enable bit is kept, but no interrupt or clock tick arrives in this run." }),
      h("li", { text: "The cost model is invented. Chapter 03 measures what a real exit costs." }),
    ),
  );

  root.append(controls, main, readout, trace, compare, honesty);
  el.append(root);

  // ---- Actions ------------------------------------------------------------------------------
  function setMode(m) {
    stop();
    state = createState(m, m === state.mode ? state.opts : undefined);
    saveHash();
    render();
    say(`Mode ${m}, ${MODE_INFO[m].name}. ${MODE_INFO[m].about}`);
  }

  function act(fn, kind) {
    stop();
    const before = state;
    state = fn(state);
    saveHash();
    render();
    say(kind === "run" ? finishNote(describe(state)) : stepAnnouncement(before, state, kind));
  }

  /** The step's own explanation, then only what changed. */
  function stepAnnouncement(before, after, kind) {
    const r = after.trace[after.trace.length - 1];
    if (!r || after === before) return finishNote("");
    const parts = [];
    const ran = after.trace.length - before.trace.length;
    if (kind === "step10" && ran > 1) parts.push(`${ran} instructions run, the last:`);
    if (r.translated) parts.push(`The VMM first translates block ${hex2(r.translated.start)}-${hex2(r.translated.end)}.`);
    parts.push(`${r.region} ${hex2(r.addr)}, ${r.text}: ${r.who}. ${r.what}`);
    const ib = summary(before).interventions;
    const ia = summary(after).interventions;
    if (ia !== ib) parts.push(`VMM interventions: ${num(ia)}.`);
    if (after.console !== before.console) parts.push(`Console: ${after.console === "" ? "empty" : after.console}.`);
    return finishNote(parts.join(" "));
  }

  function finishNote(text) {
    return isDone(state) ? `${text} Run finished; press Reset to run again.`.trim() : text;
  }

  function togglePlay() {
    if (timer) {
      stop();
      saveHash();
      say("Paused. " + describe(state));
      return;
    }
    if (isDone(state)) return;
    timer = setInterval(() => {
      state = step(state);
      render();
      if (isDone(state)) {
        stop();
        saveHash();
        render(); // with the timer cleared, Play is disabled too (and focus moves to Reset)
        say(finishNote(describe(state)));
      }
    }, reduced ? PLAY_MS_REDUCED : PLAY_MS);
    bPlay.textContent = "Pause";
  }

  function stop() {
    const wasPlaying = timer !== null;
    if (timer) clearInterval(timer);
    timer = null;
    bPlay.textContent = "Play";
    // Under reduced motion the trace does not follow Play; catch it up once it stops.
    if (wasPlaying && reduced) traceWrap.scrollTop = traceWrap.scrollHeight;
  }

  // ---- Rendering ----------------------------------------------------------------------------
  function render() {
    const s = state;
    modeInputs[s.mode].checked = true;
    about.textContent = MODE_INFO[s.mode].about;
    let anyOpt = false;
    for (const d of optDefs) {
      const show = d.modes.includes(s.mode);
      d.row.hidden = !show;
      anyOpt = anyOpt || show;
      optInputs[d.key].checked = s.opts[d.key];
    }
    optSet.hidden = !anyOpt;
    const done = isDone(s);
    const runButtons = [bStep, bStep10, bRun, bPlay];
    const willDisable = runButtons.filter((b, k) => (k === 3 ? done && !timer : done));
    // A disabled button loses focus to <body>; keep keyboard users in the lab by moving it to Reset.
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (active && willDisable.includes(active) && typeof bReset.focus === "function") bReset.focus();
    for (const b of runButtons) b.disabled = willDisable.includes(b);
    renderListing(s);
    renderState(s);
    if (s.console !== shownConsole) {
      shownConsole = s.console;
      consoleOut.textContent = s.console === "" ? "(empty)" : s.console;
      consoleOut.classList.toggle("is-empty", s.console === "");
    }
    renderReadout(s);
    renderTrace(s);
    renderCompareHighlight(s);
  }

  // The listing is built once per mode; each step only moves the current-row marker and fills
  // in the translation column, so a screen reader reading the table keeps its place.
  let listingMode = null;
  let listingRows = {}; // "region:addr" -> {tr, ptr, cache, row}
  let listingCur = null;

  function renderListing(s) {
    if (listingMode !== s.mode) buildListing(s);
    const done = isDone(s);
    const last = s.trace[s.trace.length - 1];
    let cur = null;
    if (!done) {
      const gm = guestMode(s);
      cur = gm === "kernel" ? { region: "kernel", addr: guestPc(s) } : { region: "app", addr: s.cpu.pc };
    } else if (s.halted && last) {
      cur = { region: last.region, addr: last.addr };
    }
    const curKey = cur ? `${cur.region}:${cur.addr}` : null;
    const ptrText = s.halted ? "stopped" : "next";
    if (listingCur && listingCur !== curKey && listingRows[listingCur]) {
      const o = listingRows[listingCur];
      o.tr.classList.toggle("is-current", false);
      o.tr.removeAttribute("aria-current");
      setText(o.ptr, "");
    }
    if (curKey && listingRows[curKey]) {
      const o = listingRows[curKey];
      o.tr.classList.toggle("is-current", true);
      o.tr.setAttribute("aria-current", "step");
      setText(o.ptr, ptrText);
    }
    listingCur = curKey;
    if (s.mode === "F") {
      for (const o of Object.values(listingRows)) {
        const r = o.row;
        const start = r.region === "kernel" ? s.tcache.covered[r.gpa] : undefined;
        const b = start === undefined ? null : s.tcache.blocks.find((x) => x.start === start);
        setText(o.cache, b ? `block ${hex2(b.start)}-${hex2(b.end)}${r.text.startsWith("GETMODE") ? ", rewritten" : ""}` : "");
      }
    }
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function buildListing(s) {
    listingMode = s.mode;
    listingRows = {};
    listingCur = null;
    const rows = guestImage(s.mode);
    const showCache = s.mode === "F";
    const head = h(
      "tr",
      {},
      h("th", { scope: "col" }, h("span", { class: "visually-hidden tv__sr", text: "Position" })),
      h("th", { scope: "col", text: "Addr" }),
      h("th", { scope: "col", text: "Instruction" }),
      h("th", { scope: "col", text: "Mark" }),
    );
    if (showCache) head.append(h("th", { scope: "col", text: "Translated" }));
    head.append(h("th", { scope: "col", text: "What it does" }));
    const tbody = h("tbody");
    let region = null;
    const cols = showCache ? 6 : 5;
    for (const r of rows) {
      if (r.region !== region) {
        region = r.region;
        tbody.append(
          h("tr", { class: "tv__sect" }, h("th", { scope: "colgroup", colspan: String(cols), text: region === "kernel" ? "Toy kernel, loaded at 0x00" : "Toy app, at 0x20 (it sees itself at 0x00)" })),
        );
      }
      const tr = h("tr", {});
      const ptr = h("td", { class: "tv__ptr" });
      tr.append(ptr);
      tr.append(h("td", { class: "tv__mono", text: hex2(r.addr) }));
      tr.append(h("td", { class: "tv__mono", text: r.text }));
      tr.append(h("td", { class: "tv__mono", text: r.mark, title: markName(r.mark) }));
      let cache = null;
      if (showCache) {
        cache = h("td", { class: "tv__mono" });
        tr.append(cache);
      }
      tr.append(h("td", { class: "tv__noteCell", text: r.note }));
      listingRows[`${r.region}:${r.addr}`] = { tr, ptr, cache, row: r };
      tbody.append(tr);
    }
    const table = h(
      "table",
      { class: "tv__table" },
      h("caption", { text: "Marks: P privileged, S sensitive but unprivileged, C console store, T traps by design." }),
      h("thead", {}, head),
      tbody,
    );
    clear(listingWrap);
    listingWrap.append(table);
  }

  function markName(mark) {
    return { P: "privileged", S: "sensitive but unprivileged", C: "console store", T: "traps by design" }[mark] || "";
  }

  function dlRow(dl, term, value) {
    dl.append(h("dt", { text: term }), h("dd", { class: "tv__mono", text: value }));
  }

  function renderState(s) {
    const c = s.cpu;
    const gm = guestMode(s);
    clear(stateBox);
    let realMode;
    if (s.mode === "C") realMode = `${c.priv} mode (in the interpreter's software copy)`;
    else if (s.mode === "B") realMode = "user mode (an ordinary process)";
    else if (s.mode === "H") realMode = `${c.priv} mode (the VMM holds the hardware-assist mode)`;
    else if (s.v) realMode = "user mode (always, while the guest runs)";
    else realMode = `${c.priv} mode`;
    dlRow(stateBox, "privilege mode", realMode);
    if (s.mode !== "A" && s.mode !== "C") dlRow(stateBox, "the guest believes it is in", `${gm} mode`);
    const where = gm === "kernel" ? `kernel ${hex2(c.pc)}` : `app ${hex2(c.pc)}`;
    const hostPc = translatePcForDisplay(s);
    dlRow(stateBox, "PC", hostPc === null ? where : `${where} (memory word ${hex(hostPc)})`);
    dlRow(stateBox, "saved return address", s.lastTrap ? hex(s.lastTrap.saved) : "none yet");
    dlRow(stateBox, "reason", s.lastTrap ? `${s.lastTrap.reason}; taken by the ${s.lastTrap.to}` : "none yet");
    dlRow(stateBox, "registers", c.r.map((v, k) => `r${k}=${v}`).join("  "));
    dlRow(stateBox, "base, limit", `${hex(c.base)}, ${hex(c.limit)}`);
    dlRow(stateBox, "interrupts", c.ie ? "enabled" : "disabled");

    clear(vmmBox);
    if (!s.v) {
      vmmHead.hidden = true;
      vmmBox.hidden = true;
      return;
    }
    vmmHead.hidden = false;
    vmmBox.hidden = false;
    if (s.mode === "H") {
      dlRow(vmmBox, "second base register", `${hex(s.v.s2base)}, limit ${hex(s.v.s2limit)}`);
      dlRow(vmmBox, "virtual interrupt enable", s.opts.trapIE ? (s.v.ie ? "on (the VMM's copy)" : "off (the VMM's copy)") : `kept by the hardware: the guest's own switch is ${s.cpu.ie ? "on" : "off"}`);
      dlRow(vmmBox, "console range", s.opts.trapConsole ? "trapped: the VMM plays the console" : `mapped as plain memory; word 0xF0 holds ${s.v.consoleRam[0]}`);
    } else {
      dlRow(vmmBox, "virtual mode", `${s.v.mode} mode`);
      dlRow(vmmBox, "virtual base, limit", `${hex(s.v.base)}, ${hex(s.v.limit)}`);
      dlRow(vmmBox, "virtual interrupt enable", s.v.ie ? "on" : "off");
      dlRow(vmmBox, "guest memory", `starts at word ${hex(VMM_BASE)}, limit ${hex(VMM_LIMIT)}`);
      if (s.mode === "F") dlRow(vmmBox, "translation cache", `${s.tcache.blocks.length} block${s.tcache.blocks.length === 1 ? "" : "s"}`);
    }
  }

  function translatePcForDisplay(s) {
    const gpa = guestPc(s);
    if (!Number.isInteger(gpa)) return null;
    const host = s.load + gpa;
    return host < 256 ? host : null;
  }

  function renderReadout(s) {
    const r = summary(s);
    summaryP.textContent = describe(s);
    clear(counters);
    const row = (t, v) => counters.append(h("dt", { text: t }), h("dd", { text: v }));
    row("Guest instructions run", `${num(r.steps)} of ${num(BUDGET)}`);
    row("Run natively by the CPU", num(r.native));
    row("VMM interventions", num(r.interventions) + breakdown(r));
    row("Console output equals mode A", r.done ? (r.matches ? "yes" : "no") : "run to the end to compare");
    row("Toy-model time", formatTime(r.timeNs));
    if (r.halted) row("Stopped", r.halted.text);
  }

  // The trace grows by appending rows; it is rebuilt only when the run restarts or jumps ahead
  // by more than the rows it shows.
  let traceShown = 0; // trace records rendered so far
  let traceLast = null; // the last record rendered, to tell a continuation from a new run
  let traceGroups = []; // per shown record, the <tr> elements it produced
  let traceBody = null;
  let traceCaption = null;
  let traceEmpty = false; // the "No instructions yet" note is showing

  function traceRows(r) {
    const out = [];
    if (r.translated) {
      const b = r.translated;
      out.push(
        h(
          "tr",
          { class: "tv__who-vmm" },
          h("td", { class: "tv__mono", text: "scan" }),
          h("td", { class: "tv__mono", text: `kernel ${hex2(b.start)}` }),
          h("td", { class: "tv__mono", text: "(scan)" }),
          h("td", { class: "tv__who", text: "VMM" }),
          h("td", { text: `Translates block ${hex2(b.start)}-${hex2(b.end)} before it runs${b.rewrites ? `, rewriting ${b.rewrites} GETMODE into a call into the VMM` : ""}. Cached: it is never translated again.` }),
        ),
      );
    }
    const cls = r.who === "VMM" ? "tv__who-vmm" : r.who === "CPU" ? "tv__who-cpu" : "tv__who-other";
    out.push(
      h(
        "tr",
        { class: cls },
        h("td", { class: "tv__mono", text: String(r.n) }),
        h("td", { class: "tv__mono", text: `${r.region} ${hex2(r.addr)}` }),
        h("td", { class: "tv__mono", text: r.text }),
        h("td", { class: "tv__who", text: r.who }),
        h("td", { text: r.what }),
      ),
    );
    return out;
  }

  function renderTrace(s) {
    const n = s.trace.length;
    if (n === 0) {
      if (traceEmpty) return;
      clear(traceWrap);
      traceBody = null;
      traceShown = 0;
      traceLast = null;
      traceGroups = [];
      traceEmpty = true;
      traceWrap.append(h("p", { class: "tv__note", text: "No instructions yet. Press Step." }));
      return;
    }
    if (traceBody && n === traceShown && s.trace[n - 1] === traceLast) return; // nothing new
    const continues = traceBody !== null && n > traceShown && s.trace[traceShown - 1] === traceLast && n - traceShown <= TRACE_ROWS;
    if (!continues) {
      traceEmpty = false;
      clear(traceWrap);
      traceGroups = [];
      traceBody = h("tbody");
      traceCaption = h("caption");
      traceWrap.append(
        h(
          "table",
          { class: "tv__table" },
          traceCaption,
          h(
            "thead",
            {},
            h("tr", {}, h("th", { scope: "col", text: "#" }), h("th", { scope: "col", text: "Address" }), h("th", { scope: "col", text: "Instruction" }), h("th", { scope: "col", text: "Who executes it" }), h("th", { scope: "col", text: "What happened" })),
          ),
          traceBody,
        ),
      );
      traceShown = Math.max(0, n - TRACE_ROWS);
    }
    for (const r of s.trace.slice(traceShown)) {
      const group = traceRows(r);
      for (const tr of group) traceBody.append(tr);
      traceGroups.push(group);
    }
    while (traceGroups.length > TRACE_ROWS) for (const tr of traceGroups.shift()) traceBody.removeChild(tr);
    traceShown = n;
    traceLast = s.trace[n - 1];
    traceCaption.textContent = n > TRACE_ROWS ? `The last ${TRACE_ROWS} of ${num(n)} instructions.` : `${num(n)} instruction${n === 1 ? "" : "s"} so far.`;
    // Under reduced motion the box does not scroll while Play runs; stop() catches it up.
    if (!(reduced && timer)) traceWrap.scrollTop = traceWrap.scrollHeight;
  }

  function compareTable() {
    const tbody = h("tbody");
    const add = (key, label, strategy, st) => {
      const r = summary(st);
      const tr = h(
        "tr",
        {},
        h("th", { scope: "row", text: label }),
        h("td", { text: strategy }),
        h("td", { class: "tv__num", text: num(r.interventions) }),
        h("td", { class: "tv__num", text: num(r.native) }),
        h("td", { class: "tv__mono", text: r.output === "" ? "(empty)" : r.output }),
        h("td", { text: r.matches ? "yes" : r.halted ? "no: killed" : r.panicked ? "no: panicked" : "no" }),
      );
      compareRows[key] = tr;
      tbody.append(tr);
    };
    for (const m of MODES) add(m, m, MODE_INFO[m].name, runToEnd(createState(m)));
    add("E-p", "E, fixed", "GETMODE made privileged", runToEnd(createState("E", { getmodePrivileged: true })));
    return h(
      "div",
      { class: "tv__scroll", tabindex: "0", role: "region", "aria-label": "Answers: all eight modes" },
      h(
        "table",
        { class: "tv__table" },
        h("caption", { text: "Default options. The row for the mode you are running is marked." }),
        h(
          "thead",
          {},
          h("tr", {}, h("th", { scope: "col", text: "Mode" }), h("th", { scope: "col", text: "Strategy" }), h("th", { scope: "col", text: "VMM interventions" }), h("th", { scope: "col", text: "Run natively" }), h("th", { scope: "col", text: "Console" }), h("th", { scope: "col", text: "Same as mode A?" })),
        ),
        tbody,
      ),
    );
  }

  function renderCompareHighlight(s) {
    const current = s.mode === "E" && s.opts.getmodePrivileged ? "E-p" : s.mode;
    for (const [key, tr] of Object.entries(compareRows)) {
      const on = key === current;
      tr.classList.toggle("is-current", on);
      const label = key === "E-p" ? "E, fixed" : key;
      tr.firstChild.textContent = on ? `${label} (this run)` : label;
    }
  }

  render();

  return {
    destroy() {
      stop();
      clearTimeout(pendingSay);
    },
  };
}
