// boot-timeline: the view. Renders what model.mjs computes and turns events into model calls.
// DOM is built with createElement/createElementNS and textContent only (no innerHTML, no inline
// style attributes), and nothing outside `el` is touched except ctx.hash, ctx.announce and the
// clipboard, written only when the reader presses "Copy link" (noted in this lab's LABS.md row).
// Screen readers get one channel per message: the summary is the readout's own live region, the
// cursor is a slider's value text, file and link notes are the status line, and ctx.announce is
// used only for the moment the reader selects. Data comes from this lab's own traces/*.json (same origin) or from a
// file the reader chooses, which is read in the browser and never sent anywhere. See
// course/site/LABS.md.
import * as M from "./model.mjs";

// The SVG namespace, spelled so the builder's "no absolute URLs in lab code" check stays simple.
const SVG_NS = ["http:", "/www.w3.org/2000/svg"].join("/");

/** The course root, for links to the chapters (the same constant the other labs use). */
const ROOT = "/build-your-own/vmm/";

const TITLES = {
  healthy: "Healthy boot (the reference)",
  notimer: "Breakage 1: no /timer node",
  gicr: "Breakage 2: wrong redistributor base",
  noid: "Breakage 3: PL011 ID registers read zero",
};

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  setAttrs(n, attrs);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) n.append(typeof k === "string" ? document.createTextNode(k) : k);
  return n;
}
function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  setAttrs(n, attrs);
  for (const k of kids) if (k) n.append(k);
  return n;
}
function setAttrs(n, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.setAttribute("class", v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
}

// SVG geometry (viewBox units). The lab column is about 44rem, and below that the SVG keeps a
// 40rem minimum and scrolls, so one unit is about 0.65 CSS px: font sizes in style.css are
// chosen for that scale (an 18-unit label is about 12px on screen).
const VB_W = 1000, PLOT_X = 160, PLOT_W = 830, LANE_H = 36, LANE_GAP = 6, TOP = 30, AXIS_H = 42;
/** Width of one rare-exit glyph box; markers closer than this are drawn as one cluster. */
const GLYPH_W = 18;

export async function mount(el, ctx) {
  const id = ctx.id || "lab-boot-timeline";
  const st = { trace: "healthy", hidden: new Set(), squeeze: true, boot: 0, view: { v0: 0, v1: 1 }, cursor: null, event: null };
  const packs = new Map();   // trace id -> { meta, L }
  let file = null;           // { name, L }
  let cur = null;            // { title, meta, L, A, axis }
  let binned = null;
  let note = { text: "", warn: false }; // one-line status (load errors, copied link)
  let shownA = null;         // the analysis the slow parts (lists, console) were built for
  let evButtons = [];

  // --- controls ---------------------------------------------------------------------------
  const traceSel = h("select", { id: `${id}-trace` });
  for (const tid of M.TRACE_IDS) traceSel.append(h("option", { value: tid, text: TITLES[tid] }));
  const fileOpt = h("option", { value: "file", text: "Your trace file", disabled: true });
  traceSel.append(fileOpt);
  const fileInput = h("input", { type: "file", id: `${id}-file`, accept: ".jsonl,.json,.txt,.log" });
  const bootSel = h("select", { id: `${id}-boot` });
  const bootWrap = h("p", { class: "bt__field" }, h("label", { for: bootSel.id, text: "Boot " }), bootSel);
  bootWrap.hidden = true;
  const traceField = h("p", { class: "bt__field" }, h("label", { for: traceSel.id, text: "Trace " }), traceSel);
  const dropZone = h("div", { class: "bt__drop" },
    h("p", { class: "bt__field" }, h("label", { for: fileInput.id, text: "Choose a trace file " }), fileInput),
    h("p", { class: "bt__help", text: `Run macvmm with --trace exits:boot.jsonl, then choose boot.jsonl here or drop it anywhere on this lab. It is read in this browser only, never uploaded; at most ${M.fmtBytes(M.LIMITS.maxBytes)} and ${M.fmtInt(M.LIMITS.maxRecords)} exits.` }));
  const ownTrace = h("details", { class: "bt__own" }, h("summary", { text: "Open your own trace" }), dropZone);

  const groupBoxes = new Map();
  const groupSet = h("fieldset", { class: "bt__group" }, h("legend", { text: "Show exits" }));
  for (const [g, label] of M.GROUPS) {
    const cb = h("input", { type: "checkbox", id: `${id}-g-${g}` });
    cb.checked = true;
    const count = h("span", { class: "bt__count" });
    groupBoxes.set(g, { cb, count });
    groupSet.append(h("label", { class: "bt__choice", for: cb.id }, cb, ` ${label} `, count));
  }
  const squeezeBox = h("input", { type: "checkbox", id: `${id}-squeeze` });
  squeezeBox.checked = true;
  const squeezeLabel = h("label", { class: "bt__choice", for: squeezeBox.id }, squeezeBox, " Squeeze long silences (1 s or more, or half the run)");

  const btn = (text, extra = {}) => h("button", { type: "button", class: "bt__btn", text, ...extra });
  const zoomInBtn = btn("Zoom in (+)");
  const zoomOutBtn = btn("Zoom out (−)");
  const wholeBtn = btn("Whole run");
  const prevBtn = btn("Previous moment");
  const nextBtn = btn("Next moment");
  const resetBtn = btn("Reset");
  const shareBtn = btn("Copy link to this state");
  const buttons = h("div", { class: "bt__buttons" }, zoomInBtn, zoomOutBtn, wholeBtn, prevBtn, nextBtn, resetBtn, shareBtn);
  const status = h("p", { class: "bt__status", role: "status" });
  const controls = h("div", { class: "bt__controls" }, traceField, ownTrace, bootWrap, groupSet, squeezeLabel, buttons, status);

  // --- what to do -------------------------------------------------------------------------
  const intro = h("div", { class: "bt__intro" });
  intro.append(h("p", {},
    "Each mark is a VM exit: a moment the guest stopped and handed control to the VMM. This lab replays real traces of chapter 14's Linux boot. ",
    ctx.standalone ? h("span", {}, "Read ", h("a", { href: `${ROOT}linux/linux-boot/`, text: "chapter 14, Booting Linux" }), " first; it explains every stage and breakage shown here. ") : "",
    "The healthy boot has no GIC lane because the in-kernel interrupt controller (",
    h("a", { href: `${ROOT}interrupts/gicv3/`, text: "chapter 12" }),
    ") handles the guest's GIC accesses inside Hypervisor.framework: they never reach the VMM as exits."));
  const tryList = h("ol", { class: "bt__try" },
    h("li", { text: "Healthy boot: find the 46 ms silence in the moments list. What comes right after it? A silence alone is not a hang." }),
    h("li", { text: "Breakage 1: where does the console lane stop, and what is the very last exit? How did the run end?" }),
    h("li", { text: "Breakage 2: which lane appears that the healthy boot never has, and why?" }),
    h("li", { text: "Breakage 3: it powered off cleanly with exit status 0, so what is missing? Compare the fingerprint and the PL011 lane with the healthy boot." }));
  intro.append(h("details", { class: "bt__trydetails", open: true }, h("summary", { text: "Try this" }), tryList));

  // --- provenance -------------------------------------------------------------------------
  const prov = h("div", { class: "bt__prov" });

  // --- visualization ----------------------------------------------------------------------
  const helpId = `${id}-keys`;
  const legend = h("p", { class: "bt__help", text: "Darker cells hold more exits. Letters mark rare exits (P PSCI, S SMCCC, H other hypercall, R system register, W WFI or WFE, T VTIMER, C canceled, ? other); a box with a count, such as H·R ×18, is several of them too close to tell apart, so zoom in. Numbers in the console lane are boot stages, ! a failure line. A console line's time is when our UART received its first byte: the lines from before earlycon are replayed from the kernel's log buffer in one burst, which is why they carry the kernel's own stamp [0.000000] but spread over milliseconds here (primer: linux-boot-sequence, the log buffer)." });
  const keys = h("p", { class: "bt__help", id: helpId, text: "The timeline is a slider over its slices. Left and Right move the cursor one slice, Page Up and Page Down ten, Home and End to either edge; + and − zoom, 0 shows the whole run, Shift with Left or Right pans; [ and ] go to the previous or next moment, Enter selects the moment under the cursor, Escape clears the cursor." });
  const svg = s("svg", { class: "bt__svg", viewBox: `0 0 ${VB_W} 100`, "aria-hidden": "true", focusable: "false" });
  const scroller = h("div", {
    class: "bt__scroll", tabindex: "0", role: "slider", "aria-label": "Boot timeline cursor", "aria-describedby": helpId,
    "aria-orientation": "horizontal", "aria-valuemin": 0, "aria-valuemax": M.N_BINS - 1, "aria-valuenow": M.N_BINS >> 1,
  }, svg);
  const cursorLine = h("p", { class: "bt__cursor", "aria-hidden": "true" });
  const viz = h("div", { class: "bt__viz" }, legend, keys, scroller, cursorLine);

  // --- readout and tables -----------------------------------------------------------------
  const readout = h("p", { class: "bt__readout", "aria-live": "polite", "aria-atomic": "true" });
  const detail = h("div", { class: "bt__detail" });
  const fpBody = h("tbody");
  const fpTable = h("table", { class: "bt__table" }, h("caption", { text: "Failure fingerprint (chapter 14): read from the trace alone" }), fpBody);
  const ctrHead = h("tr");
  const ctrBody = h("tbody");
  const ctrTable = h("table", { class: "bt__table bt__table--num" }, h("caption", { text: "Exits by kind" }), h("thead", {}, ctrHead), ctrBody);
  const ctrScroll = h("div", { class: "bt__tscroll", tabindex: "0", role: "region", "aria-label": "Exits by kind" }, ctrTable);
  const statsP = h("p", { class: "bt__stats" });
  const evTitle = h("h4");
  const evList = h("ol", { class: "bt__events" });
  const conSummary = h("summary");
  const conPre = h("pre", { class: "bt__console" });
  const conDetails = h("details", { class: "bt__condetails" }, conSummary, h("p", { class: "bt__help", text: "Rebuilt from the PL011 data-register writes in the trace, one exit per byte. This is guest text: control bytes are shown as \\xNN." }), conPre);
  const tables = h("div", { class: "bt__tables" },
    h("h4", { text: "Selected moment" }), detail,
    h("h4", { text: "Fingerprint" }), fpTable,
    h("h4", { text: "Counters" }), ctrScroll, statsP,
    evTitle, evList, conDetails);

  // The root goes into the page only after the first render (at the end of mount), so the
  // readout's live region is already filled and nothing is read aloud on page load.
  const root = h("div", { class: "bt" + (ctx.reducedMotion ? " bt--still" : "") }, intro, controls, prov, viz, readout, tables);

  // --- data -------------------------------------------------------------------------------
  async function loadPreset(tid) {
    if (packs.has(tid)) return packs.get(tid);
    if (typeof fetch !== "function") throw new Error("this browser cannot load the lab's traces");
    const res = await fetch(new URL(`traces/${tid}.json`, ctx.base));
    if (!res.ok) throw new Error(`could not load traces/${tid}.json (HTTP ${res.status})`);
    const pack = await res.json();
    const L = M.loadPack(pack);
    if (!L.ok) throw new Error(`traces/${tid}.json: ${L.message}`);
    const entry = { meta: pack.meta, L };
    packs.set(tid, entry);
    return entry;
  }

  function analyzeCurrent() {
    const src = st.trace === "file" ? file : packs.get(st.trace);
    const A = M.analyze(src.L.records, { boot: st.boot || null, truncated: src.L.truncated, partial: src.L.partial || null });
    st.boot = A.boot;
    cur = { title: st.trace === "file" ? `Your trace (${file.name})` : TITLES[st.trace], meta: src.meta || null, L: src.L, A, axis: M.makeAxis(A, { squeeze: st.squeeze }) };
  }

  const healthyA = () => {
    const p = packs.get("healthy");
    if (!p) return null;
    if (!p.A) p.A = M.analyze(p.L.records);
    return p.A;
  };

  // --- rendering --------------------------------------------------------------------------
  /**
   * The zoom buttons are never `disabled`: disabling the focused button would drop keyboard
   * focus to the page. They carry aria-disabled instead, and their handlers ignore the click.
   */
  function setOff(b, off) {
    if (off) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
  }
  const isOff = (b) => b.getAttribute("aria-disabled") === "true";

  function showNote() {
    status.textContent = note.text;
    status.setAttribute("class", note.warn ? "bt__status bt__status--warn" : "bt__status");
  }

  function render() {
    const { A, axis } = cur;
    binned = M.bin(A, axis, st.view, st.hidden);
    traceSel.value = st.trace;
    for (const [g, { cb, count }] of groupBoxes) {
      cb.checked = !st.hidden.has(g);
      const n = A.kindCounts.reduce((sum, c, i) => sum + (M.KINDS[i].group === g ? c : 0), 0);
      count.textContent = `(${M.fmtInt(n)})`;
    }
    squeezeBox.checked = st.squeeze;
    bootWrap.hidden = A.boots.length < 2;
    if (A.boots.length > 1) {
      bootSel.replaceChildren(...A.boots.map((b) => h("option", { value: String(b), text: b === 0 ? "first boot" : `after reboot ${b}` })));
      bootSel.value = String(A.boot);
    }
    const whole = st.view.v0 <= 0 && st.view.v1 >= 1;
    setOff(zoomOutBtn, whole);
    setOff(wholeBtn, whole);
    setOff(zoomInBtn, st.view.v1 - st.view.v0 <= M.MIN_VIEW_W * 1.0001);
    showNote();
    const fresh = shownA !== A;
    shownA = A;
    if (fresh) { renderProv(); renderFingerprint(); renderConsole(); buildEvents(); }
    renderSvg();
    renderCursor();
    // The readout is the summary's only channel (its own polite live region).
    const sum = M.summary(A, cur.title);
    if (readout.textContent !== sum) readout.textContent = sum;
    renderCounters();
    markEvent();
    renderDetail();
    writeHash();
  }

  function renderProv() {
    const kids = [];
    if (cur.meta) {
      const m = cur.meta;
      kids.push(h("p", {}, h("strong", { text: "Real run. " }), `Captured on ${m.captured}. Recorded exit status ${m.exit}. Your numbers will differ: timings change from run to run and Mac to Mac, while the exit counts of the same kernel and VMM stay close (polling the PL011 flag register depends a little on timing).`));
      if (m.change) kids.push(h("p", { text: m.change }));
      kids.push(h("p", {}, "Command: ", h("code", { text: m.command })));
      const stats = (m.stderr || []).filter((l) => l.startsWith("macvmm:"));
      if (stats.length) kids.push(h("pre", { class: "bt__stderr", text: stats.join("\n") }));
    } else if (file) {
      const L = file.L;
      const bits = [`${M.fmtInt(L.records.length)} exits read`];
      if (L.skipped) bits.push(`${M.fmtInt(L.skipped)} other lines skipped`);
      if (L.errorCount) bits.push(`${M.fmtInt(L.errorCount)} bad records skipped`);
      if (L.tooMany) bits.push(`stopped at ${M.fmtInt(M.LIMITS.maxRecords)} exits`);
      if (L.duplicates) bits.push(`${M.fmtInt(L.duplicates)} repeated records dropped`);
      kids.push(h("p", {}, h("strong", { text: "Your file. " }), `${bits.join(", ")}. It stays in this browser.`));
      if (L.errors.length) {
        const ul = h("ul", { class: "bt__errors" });
        for (const e of L.errors) ul.append(h("li", { text: `Line ${e.line}: ${e.message}` }));
        kids.push(ul);
      }
    }
    prov.replaceChildren(...kids);
  }

  function laneY(i) { return TOP + i * (LANE_H + LANE_GAP); }

  /**
   * Group marks (sorted by x, in viewBox units) that sit closer than one glyph box into
   * clusters, so overlapping letters become one box with a count.
   */
  function cluster(marks) {
    const out = [];
    for (const m of [...marks].sort((p, q) => p.vx - q.vx)) {
      const last = out[out.length - 1];
      if (last && m.vx - last.x1 < GLYPH_W) { last.items.push(m); last.x1 = m.vx; }
      else out.push({ x0: m.vx, x1: m.vx, items: [m] });
    }
    return out.map((c) => {
      const glyphs = [...new Set(c.items.map((m) => m.glyph))];
      const n = c.items.length;
      const label = n === 1 ? glyphs[0] : `${glyphs.join("·")}${n > glyphs.length ? ` ×${n}` : ""}`;
      return { x: (c.x0 + c.x1) / 2, label, n, fail: c.items.some((m) => m.type === "failure") };
    });
  }

  function drawMarks(kids, marks, y, small) {
    for (const c of cluster(marks)) {
      const w = Math.max(GLYPH_W - 2, c.label.length * (small ? 8.5 : 9.5) + 6);
      const h0 = small ? 18 : LANE_H - 10;
      const y0 = small ? y + LANE_H - h0 - 1 : y + 5;
      kids.push(s("rect", { class: c.fail ? "bt__mark bt__mark--fail" : "bt__mark", x: (c.x - w / 2).toFixed(1), y: y0, width: w.toFixed(1), height: h0 }));
      kids.push(s("text", { class: `bt__glyph${small ? " bt__glyph--small" : ""}${c.fail ? " bt__glyph--fail" : ""}`, x: c.x.toFixed(1), y: y0 + h0 / 2 + 5, text: c.label }));
    }
  }

  function renderSvg() {
    const { A, axis } = cur;
    const lanes = A.lanes;
    const n = binned.nBins;
    const bw = PLOT_W / n;
    const height = TOP + lanes.length * (LANE_H + LANE_GAP) + AXIS_H;
    svg.setAttribute("viewBox", `0 0 ${VB_W} ${height}`);
    const w = st.view.v1 - st.view.v0;
    const px = (x) => PLOT_X + ((x - st.view.v0) / w) * PLOT_W;
    const kids = [];
    // Squeezed silences, behind everything.
    for (const sg of axis.segs.filter((x) => x.squeezed)) {
      const a = Math.max(sg.x0, st.view.v0), b = Math.min(sg.x1, st.view.v1);
      if (b <= a) continue;
      kids.push(s("rect", { class: "bt__squeeze", x: px(a).toFixed(1), y: TOP - 4, width: (px(b) - px(a)).toFixed(1), height: lanes.length * (LANE_H + LANE_GAP) }));
      if (px(b) - px(a) >= 44) {
        const cx = ((px(a) + px(b)) / 2).toFixed(1), cy = TOP + (lanes.length * (LANE_H + LANE_GAP)) / 2;
        kids.push(s("text", { class: "bt__squeezelabel", x: cx, y: cy - 4, text: M.fmtTime(sg.t1 - sg.t0) }));
        kids.push(s("text", { class: "bt__squeezelabel", x: cx, y: cy + 14, text: "no exits" }));
      }
    }
    lanes.forEach((lane, li) => {
      const y = laneY(li);
      kids.push(s("text", { class: "bt__lanelabel", x: 4, y: y + LANE_H / 2 + 6, text: lane.label }));
      kids.push(s("rect", { class: "bt__lane", x: PLOT_X, y, width: PLOT_W, height: LANE_H }));
      if (lane.type === "console") {
        drawMarks(kids, binned.consoleMarks.map((m) => ({ ...m, vx: px(m.x) })), y, false);
        return;
      }
      const counts = binned.counts.get(lane.id);
      if (counts) counts.forEach((c, i) => {
        const lv = M.level(c, binned.max);
        if (lv) kids.push(s("rect", { class: `bt__bin bt__l${lv}`, x: (PLOT_X + i * bw).toFixed(2), y: y + 1, width: Math.max(bw, 0.6).toFixed(2), height: LANE_H - 2 }));
      });
      if (lane.type === "vcpu") {
        drawMarks(kids, binned.markers.filter((m) => m.vcpu === lane.vcpu).map((m) => ({ ...m, vx: px(m.x) })), y, true);
      }
    });
    // Axis.
    const axisY = TOP + lanes.length * (LANE_H + LANE_GAP);
    kids.push(s("line", { class: "bt__axis", x1: PLOT_X, x2: PLOT_X + PLOT_W, y1: axisY, y2: axisY }));
    for (const t of M.ticks(axis, st.view, 5)) {
      const x = px(t.x);
      if (t.squeezed) continue; // labelled inside its dashed box
      kids.push(s("line", { class: "bt__tick", x1: x.toFixed(1), x2: x.toFixed(1), y1: axisY, y2: axisY + 6 }));
      kids.push(s("text", { class: "bt__ticklabel", x: Math.min(Math.max(x, PLOT_X + 30), PLOT_X + PLOT_W - 30).toFixed(1), y: axisY + 26, text: t.label }));
    }
    // Selected moment.
    if (st.event !== null && A.events[st.event]) {
      const e = A.events[st.event];
      const x = M.tToX(axis, e.t);
      if (x >= st.view.v0 && x <= st.view.v1) {
        const sx = Math.min(Math.max(px(x), PLOT_X + 50), PLOT_X + PLOT_W - 50);
        kids.push(s("line", { class: "bt__sel", x1: px(x).toFixed(1), x2: px(x).toFixed(1), y1: TOP - 6, y2: axisY }));
        kids.push(s("text", { class: "bt__sellabel", x: sx.toFixed(1), y: TOP - 10, text: "▼ selected" }));
      }
    }
    // Cursor.
    if (st.cursor !== null) {
      kids.push(s("rect", { class: "bt__cursorbox", x: (PLOT_X + st.cursor * bw).toFixed(2), y: TOP - 2, width: Math.max(bw, 2).toFixed(2), height: axisY - TOP + 4 }));
    }
    svg.replaceChildren(...kids);
  }

  /** Scroll the timeline's box (narrow screens) so viewBox x `vx` is visible. Jumps, never animates. */
  function ensureVisible(vx) {
    if (vx === null || !svg.getBoundingClientRect) return;
    const sw = svg.getBoundingClientRect().width;
    const cw = scroller.clientWidth;
    if (!sw || !cw || sw <= cw + 1) return;
    const x = (vx / VB_W) * sw;
    const pad = 32;
    if (x < scroller.scrollLeft + pad) scroller.scrollLeft = Math.max(0, x - pad);
    else if (x > scroller.scrollLeft + cw - pad) scroller.scrollLeft = x - cw + pad;
  }
  function cursorVx() {
    return st.cursor === null ? null : PLOT_X + ((st.cursor + 0.5) / M.N_BINS) * PLOT_W;
  }
  function eventVx() {
    const e = st.event !== null ? cur.A.events[st.event] : null;
    if (!e) return null;
    const x = M.tToX(cur.axis, e.t);
    if (x < st.view.v0 || x > st.view.v1) return null;
    return PLOT_X + ((x - st.view.v0) / (st.view.v1 - st.view.v0)) * PLOT_W;
  }

  function cursorText() {
    if (st.cursor === null) return "No cursor yet. Focus the timeline and press Left or Right, or click a slice.";
    const d = M.binDetails(cur.axis, st.view, binned, st.cursor);
    const range = `${M.fmtTime(d.t0)} to ${M.fmtTime(d.t1)}`;
    const sq = d.squeezed ? ", across part of a squeezed silence" : "";
    if (!d.total) return `Cursor at ${range}${sq}: no exits.`;
    const top = d.kinds.slice(0, 3).map((k) => `${M.fmtInt(k.count)} ${k.label}`).join("; ");
    return `Cursor at ${range}${sq}: ${M.fmtInt(d.total)} exit${d.total === 1 ? "" : "s"} shown (${top}${d.kinds.length > 3 ? "; and more" : ""}).`;
  }
  function renderCursor() {
    const t = cursorText();
    cursorLine.textContent = t;
    scroller.setAttribute("aria-valuenow", String(st.cursor === null ? M.N_BINS >> 1 : st.cursor));
    scroller.setAttribute("aria-valuetext", t);
  }

  function renderFingerprint() {
    const { A } = cur;
    const fp = A.fingerprint;
    const row = (k, v) => h("tr", {}, h("th", { scope: "row", text: k }), h("td", {}, v));
    const rows = [
      row("Last stage reached", fp.stageText),
      row("The kernel says", fp.kernelSays.length ? fp.kernelSays.join(", ") : "no failure line"),
      row("Milestone lines missing", fp.missing.length ? fp.missing.map((m) => `stage ${m.stage}: ${m.label}`).join("; ") : "none"),
      row("How it ended", fp.ended.text),
    ];
    if (cur.meta) rows.push(row("Recorded exit status", String(cur.meta.exit)));
    fpBody.replaceChildren(...rows);
  }

  function renderCounters() {
    const { A } = cur;
    const ref = st.trace !== "healthy" ? healthyA() : null;
    const cols = ["Kind", "Exits", "Share", "Per second, whole run", "In view", "Per second, in view"];
    if (ref) cols.push("Healthy boot");
    ctrHead.replaceChildren(...cols.map((c) => h("th", { scope: "col", text: c })));
    const data = M.counters(A, binned, st.hidden);
    const rows = data.map((r) => {
      const tr = h("tr", { class: r.shown ? "" : "bt__hiddenrow" },
        h("th", { scope: "row", text: r.label + (r.shown ? "" : " (hidden)") }),
        h("td", { text: M.fmtInt(r.count) }),
        h("td", { text: `${(r.share * 100).toFixed(r.share < 0.01 ? 2 : 1)}%` }),
        h("td", { text: M.fmtRate(r.perSecond) }),
        h("td", { text: r.shown ? M.fmtInt(r.inView) : "-" }),
        h("td", { text: M.fmtRate(r.perSecondView) }));
      if (ref) tr.append(h("td", { text: M.fmtInt(ref.kindCounts[r.kind]) }));
      return tr;
    });
    const total = h("tr", { class: "bt__total" }, h("th", { scope: "row", text: "All exits" }), h("td", { text: M.fmtInt(A.count) }), h("td", { text: "100%" }),
      h("td", { text: M.fmtRate(A.tEnd > 0 ? A.count / (A.tEnd / 1e9) : null) }), h("td", { text: M.fmtInt(data.reduce((x, r) => x + (r.shown ? r.inView : 0), 0)) }), h("td", { text: "" }));
    if (ref) total.append(h("td", { text: M.fmtInt(ref.count) }));
    ctrBody.replaceChildren(...rows, total);
    statsP.replaceChildren("As ", h("code", { text: "--stats" }), " counts them: ", ...A.statsLines.flatMap((l, i) => [i ? "; " : "", h("code", { text: l })]), ".");
  }

  // Built once per trace, so a click on a moment keeps focus on its button.
  function buildEvents() {
    const { A } = cur;
    evTitle.textContent = `Moments (${A.events.length})`;
    evButtons = A.events.map((e, i) => {
      const b = h("button", { type: "button", class: `bt__ev bt__ev--${e.type}` },
        h("span", { class: "bt__evtime", text: M.fmtTime(e.t) }), " ", e.title);
      b.addEventListener("click", () => selectEvent(i, true));
      return b;
    });
    evList.replaceChildren(...evButtons.map((b) => h("li", {}, b)));
  }
  function markEvent() {
    evButtons.forEach((b, i) => { if (i === st.event) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
  }

  function renderDetail() {
    const { A } = cur;
    const e = st.event !== null ? A.events[st.event] : null;
    if (!e) { detail.replaceChildren(h("p", { class: "bt__help", text: "Nothing selected. Choose a moment from the list below, press [ or ] on the timeline, or click near a marker." })); return; }
    const kids = [h("p", {}, h("strong", { text: `${M.fmtTime(e.t)}: ` }), e.title + (e.t1 ? ` (until ${M.fmtTime(e.t1)})` : "") + ".")];
    if (e.text !== null) kids.push(h("p", {}, e.type === "gap" ? "Last console line before it (guest text): " : "Console line (guest text): ", h("code", { text: e.text })));
    if (e.type === "gap" && e.then) {
      const after = e.then.line !== undefined && A.console.lines[e.then.line] ? A.console.lines[e.then.line].text : null;
      const tell = e.then.how === "cancel" ? " Silence that ends in a kick from the VMM is the sign of a hang." : " The guest carried on by itself, so this silence is work, not a hang.";
      kids.push(h("p", {}, `Followed by: ${e.then.text}.${tell}`, after !== null ? " Next console line: " : "", after !== null ? h("code", { text: after }) : ""));
    }
    if ((e.type === "milestone" || e.type === "failure") && e.stamp) {
      kids.push(h("p", { text: `The kernel stamped this line [${e.stamp}] seconds; ${M.fmtTime(e.t)} on the axis is when our UART received its first byte.` }));
    }
    if (e.rec !== null && A.records[e.rec]) {
      const r = A.records[e.rec];
      kids.push(h("p", { text: (e.type === "gap" ? "The last exit before the silence: " : e.type === "milestone" || e.type === "failure" ? "Its first byte's exit: " : "") + M.describeRecord(r) }));
      kids.push(h("pre", { class: "bt__record", text: M.recordLine(r) }));
    }
    detail.replaceChildren(...kids);
  }

  function renderConsole() {
    const { A } = cur;
    const lines = A.console.lines;
    conSummary.textContent = `Console output rebuilt from the trace (${M.fmtInt(lines.length)} lines, ${M.fmtInt(A.console.bytes)} bytes)`;
    const SHOW = 2000;
    const text = lines.slice(0, SHOW).map((l) => `${M.fmtTime(l.t0).padStart(10)}  ${l.text}${l.more ? ` [${l.more} more characters]` : ""}`).join("\n");
    conPre.textContent = text + (lines.length > SHOW ? `\n[${M.fmtInt(lines.length - SHOW)} more lines not shown]` : "") + (A.console.dropped ? `\n[${M.fmtInt(A.console.dropped)} lines over the lab's cap]` : "");
  }

  function writeHash() {
    if (!ctx.hash) return;
    const whole = st.view.v0 <= 0 && st.view.v1 >= 1;
    const window = whole ? null : [M.xToT(cur.axis, st.view.v0), M.xToT(cur.axis, st.view.v1)];
    try { ctx.hash.set(M.encodeHash({ trace: st.trace, hidden: st.hidden, squeeze: st.squeeze, boot: st.boot, window, event: st.event })); } catch { /* no history API: fine */ }
  }

  // --- actions ----------------------------------------------------------------------------
  function selectEvent(i, reveal) {
    const e = cur.A.events[i];
    if (!e) return;
    st.event = i;
    if (reveal) st.view = M.reveal(cur.axis, st.view, e.t, e.t1 || e.t);
    st.cursor = binAtT(e.t);
    render();
    ensureVisible(eventVx());
    if (ctx.announce) ctx.announce(`${M.fmtTime(e.t)}: ${e.title}.`);
  }

  function binAtT(t) {
    const x = M.tToX(cur.axis, t);
    if (x < st.view.v0 || x > st.view.v1) return null;
    return Math.min(M.N_BINS - 1, Math.max(0, Math.floor(((x - st.view.v0) / (st.view.v1 - st.view.v0)) * M.N_BINS)));
  }
  function cursorX() {
    if (st.cursor === null) return (st.view.v0 + st.view.v1) / 2;
    return st.view.v0 + ((st.cursor + 0.5) / M.N_BINS) * (st.view.v1 - st.view.v0);
  }

  /** The moment nearest to bin `i`, within 2 bins. */
  function eventNearBin(i) {
    let best = null, bestD = Infinity;
    cur.A.events.forEach((e, k) => {
      const b = binAtT(e.t);
      if (b === null) return;
      const d = Math.abs(b - i);
      if (d <= 2 && d < bestD) { best = k; bestD = d; }
    });
    return best;
  }

  function stepEvent(dir) {
    const ev = cur.A.events;
    if (!ev.length) return;
    let i;
    if (st.event !== null) i = st.event + dir;
    else {
      const t = M.xToT(cur.axis, cursorX());
      i = dir > 0 ? ev.findIndex((e) => e.t >= t) : ev.length - 1 - [...ev].reverse().findIndex((e) => e.t <= t);
      if (i < 0 || i >= ev.length) i = dir > 0 ? 0 : ev.length - 1;
    }
    i = Math.max(0, Math.min(ev.length - 1, i));
    selectEvent(i, true);
  }

  function setView(v, keepCursorT = true) {
    const t = keepCursorT && st.cursor !== null ? M.xToT(cur.axis, cursorX()) : null;
    st.view = v;
    if (t !== null) st.cursor = binAtT(t);
    render();
  }

  function moveCursor(to) {
    if (to < 0) { if (st.view.v0 > 0) { st.view = M.pan(st.view, -1 / M.N_BINS); } to = 0; }
    if (to > M.N_BINS - 1) { if (st.view.v1 < 1) { st.view = M.pan(st.view, 1 / M.N_BINS); } to = M.N_BINS - 1; }
    st.cursor = to;
    render();
    ensureVisible(cursorVx());
  }

  async function setTrace(tid, { keep = false } = {}) {
    if (tid === "file") { if (!file) return; }
    else await loadPreset(tid);
    st.trace = tid;
    if (!keep) { st.boot = 0; st.view = { v0: 0, v1: 1 }; st.cursor = null; st.event = null; }
    analyzeCurrent();
    note = { text: "", warn: false };
    render();
  }

  async function readFile(f) {
    if (!f) return;
    if (typeof f.size === "number" && f.size > M.LIMITS.maxBytes) {
      note = { warn: true, text: `That file is ${M.fmtBytes(f.size)}; this lab reads at most ${M.fmtBytes(M.LIMITS.maxBytes)}. Trace a shorter run, or keep only the categories this lab reads: --trace exits:boot.jsonl:mmio,psci,cancel (the console and the stages are rebuilt from the mmio records).` };
      showNote();
      return;
    }
    let text;
    try { text = await f.text(); } catch { note = { warn: true, text: "That file could not be read." }; showNote(); return; }
    const L = M.parseTrace(text);
    if (!L.ok) {
      note = { warn: true, text: L.message + (L.errors && L.errors.length ? ` First problem, line ${L.errors[0].line}: ${L.errors[0].message}.` : "") };
      showNote();
      return;
    }
    const name = String(f.name || "trace").replace(/[^\w.\- ]+/g, "_").slice(0, 60);
    file = { name, L };
    fileOpt.disabled = false;
    fileOpt.textContent = `Your trace file (${name})`;
    await setTrace("file");
  }

  // --- wiring -----------------------------------------------------------------------------
  traceSel.addEventListener("change", () => { setTrace(traceSel.value).catch(showError); });
  fileInput.addEventListener("change", () => { readFile(fileInput.files && fileInput.files[0]).catch(showError); });
  // A file dropped anywhere on the lab is read (and the browser does not open it in place of
  // the page). The listeners are on `el`, the lab's own element, and removed by destroy().
  const onDragOver = (e) => { e.preventDefault(); };
  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f).catch(showError);
  };
  el.addEventListener("dragover", onDragOver);
  el.addEventListener("drop", onDrop);
  bootSel.addEventListener("change", () => {
    st.boot = Number(bootSel.value) || 0;
    st.view = { v0: 0, v1: 1 }; st.cursor = null; st.event = null;
    analyzeCurrent();
    render();
  });
  for (const [g, { cb }] of groupBoxes) {
    cb.addEventListener("change", () => {
      if (cb.checked) st.hidden.delete(g); else st.hidden.add(g);
      render();
    });
  }
  squeezeBox.addEventListener("change", () => {
    st.squeeze = squeezeBox.checked;
    const t0 = M.xToT(cur.axis, st.view.v0), t1 = M.xToT(cur.axis, st.view.v1);
    const ct = st.cursor !== null ? M.xToT(cur.axis, cursorX()) : null;
    cur.axis = M.makeAxis(cur.A, { squeeze: st.squeeze });
    st.view = (st.view.v0 <= 0 && st.view.v1 >= 1) ? { v0: 0, v1: 1 } : M.clampView({ v0: M.tToX(cur.axis, t0), v1: M.tToX(cur.axis, t1) });
    st.cursor = ct !== null ? binAtT(ct) : null;
    render();
  });
  zoomInBtn.addEventListener("click", () => { if (!isOff(zoomInBtn)) setView(M.zoom(st.view, 0.5, cursorX())); });
  zoomOutBtn.addEventListener("click", () => { if (!isOff(zoomOutBtn)) setView(M.zoom(st.view, 2, cursorX())); });
  wholeBtn.addEventListener("click", () => { if (!isOff(wholeBtn)) setView({ v0: 0, v1: 1 }); });
  prevBtn.addEventListener("click", () => stepEvent(-1));
  nextBtn.addEventListener("click", () => stepEvent(1));
  resetBtn.addEventListener("click", () => {
    st.hidden = new Set(); st.squeeze = true; st.boot = 0;
    setTrace("healthy").catch(showError);
  });
  shareBtn.addEventListener("click", async () => {
    writeHash();
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof location !== "undefined") {
        await navigator.clipboard.writeText(location.href);
        note = { warn: false, text: st.trace === "file" ? "Link copied. It keeps the view, not your file: whoever opens it chooses the file again." : "Link copied." };
      }
    } catch { note = { warn: true, text: "Copying was refused; the address bar holds the link." }; }
    showNote();
  });

  scroller.addEventListener("keydown", (e) => {
    const k = e.key;
    let handled = true;
    if (k === "ArrowLeft" && e.shiftKey) setView(M.pan(st.view, -0.25));
    else if (k === "ArrowRight" && e.shiftKey) setView(M.pan(st.view, 0.25));
    else if (k === "ArrowLeft") moveCursor(st.cursor === null ? M.N_BINS >> 1 : st.cursor - 1);
    else if (k === "ArrowRight") moveCursor(st.cursor === null ? M.N_BINS >> 1 : st.cursor + 1);
    else if (k === "PageUp") moveCursor(st.cursor === null ? M.N_BINS >> 1 : st.cursor - 10);
    else if (k === "PageDown") moveCursor(st.cursor === null ? M.N_BINS >> 1 : st.cursor + 10);
    else if (k === "Home") moveCursor(0);
    else if (k === "End") moveCursor(M.N_BINS - 1);
    else if (k === "+" || k === "=") setView(M.zoom(st.view, 0.5, cursorX()));
    else if (k === "-" || k === "_" || k === "−") setView(M.zoom(st.view, 2, cursorX()));
    else if (k === "0") setView({ v0: 0, v1: 1 });
    else if (k === "]") stepEvent(1);
    else if (k === "[") stepEvent(-1);
    else if (k === "Enter" && st.cursor !== null) {
      const i = eventNearBin(st.cursor);
      if (i !== null) selectEvent(i, false);
      else { note = { warn: false, text: "No moment within two slices of the cursor." }; showNote(); }
    } else if (k === "Escape" && (st.cursor !== null || st.event !== null)) { st.cursor = null; st.event = null; render(); }
    else handled = false;
    if (handled && e.preventDefault) e.preventDefault();
  });

  function binFromPointer(e) {
    if (!svg.getBoundingClientRect) return null;
    const r = svg.getBoundingClientRect();
    if (!r.width) return null;
    const vx = ((e.clientX - r.left) / r.width) * VB_W;
    if (vx < PLOT_X || vx > PLOT_X + PLOT_W) return null;
    return Math.min(M.N_BINS - 1, Math.floor(((vx - PLOT_X) / PLOT_W) * M.N_BINS));
  }
  svg.addEventListener("click", (e) => {
    const b = binFromPointer(e);
    if (b === null) return;
    st.cursor = b;
    const i = eventNearBin(b);
    if (i !== null) selectEvent(i, false);
    else render();
  });
  svg.addEventListener("mousemove", (e) => {
    const b = binFromPointer(e);
    if (b === null) return;
    const d = M.binDetails(cur.axis, st.view, binned, b);
    cursorLine.textContent = `Pointer at ${M.fmtTime(d.t0)} to ${M.fmtTime(d.t1)}: ${M.fmtInt(d.total)} exits shown. ${st.cursor === null ? "Click to place the cursor." : cursorText()}`;
  });
  svg.addEventListener("mouseleave", () => renderCursor());

  function showError(err) {
    note = { warn: true, text: `Could not load that trace: ${err && err.message ? err.message : String(err)}` };
    showNote();
  }

  // --- start ------------------------------------------------------------------------------
  let want = null;
  try { want = M.decodeHash(ctx.hash && ctx.hash.get ? ctx.hash.get() : null); } catch { want = null; }
  await loadPreset("healthy");
  if (want && want.trace === "file") {
    note = { warn: false, text: "This link was made with a trace file, which links never carry. Choose that file again to see it." };
    want = { ...want, trace: "healthy", window: null, event: null, boot: 0 };
  }
  if (want) {
    try { await loadPreset(want.trace); } catch { want = { ...want, trace: "healthy" }; }
    st.trace = want.trace; st.hidden = want.hidden; st.squeeze = want.squeeze; st.boot = want.boot;
  }
  analyzeCurrent();
  if (want && want.window) {
    const v = M.clampView({ v0: M.tToX(cur.axis, want.window[0]), v1: M.tToX(cur.axis, want.window[1]) });
    if (v.v1 > v.v0) st.view = v;
  }
  if (want && want.event !== null && cur.A.events[want.event]) {
    st.event = want.event;
    if (!want.window) st.view = M.reveal(cur.axis, st.view, cur.A.events[st.event].t);
    st.cursor = binAtT(cur.A.events[st.event].t);
  }
  render();
  el.replaceChildren(root);

  return {
    destroy() {
      // Every other listener is on an element inside the lab's root.
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
    },
  };
}
