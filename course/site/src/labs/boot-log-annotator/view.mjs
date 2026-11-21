// boot-log-annotator view: renders the model's annotation of a boot log and turns input into model
// calls. All log logic lives in model.mjs; this file only builds DOM inside the element the lab
// shell hands us (createElement + textContent, never innerHTML: every byte of a log is hostile).
// See course/site/LABS.md.
import {
  LIMITS, STAGES, SAMPLE_IDS, annotate, explain, defaultLine, parseDts, dtsNode, dtsFromCapture,
  encodeShare, decodeShare, spans, chList, primerHref,
} from "./model.mjs";
import SAMPLES from "./samples.mjs";

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

/** Text with backtick code spans, as DOM nodes. */
function rich(tag, text, attrs = {}) {
  const el = h(tag, attrs);
  for (const s of spans(text)) el.append(s.code ? h("code", { text: s.text }) : s.text);
  return el;
}

const KIND_LABEL = { milestone: "milestone", failure: "trouble", machine: "our machine", context: "report", info: "explained", plain: "" };
const STATUS_LABEL = { done: "done", partial: "partly done", started: "started, not finished", missing: "not reached", absent: "not in this log" };
const LEGEND = [
  ["milestone", "a stage's milestone line"],
  ["trouble", "the kernel reports a problem"],
  ["our machine", "a line about something our VMM provides: a device, a device-tree node, an answer to a call"],
  ["report", "part of a crash or warning report"],
  ["explained", "housekeeping, with a short note"],
];
const HIDDEN_WHEN_FILTERED = new Set(["info", "plain"]);
const DTS_INDEX = parseDts(dtsFromCapture(SAMPLES.dts.text));
const SAMPLE_BY_ID = new Map(SAMPLES.samples.map((s) => [s.id, s]));

export function mount(el, ctx) {
  const id = ctx.id;
  const shared = decodeShare(ctx.hash.get());
  const ui = {
    sample: shared ? shared.sample : "boot",
    colour: shared ? shared.colour : "s",
    onlyAnnotated: shared ? shared.onlyAnnotated : false,
    line: shared ? shared.line : null,
    pasted: "",
    message: "",
  };
  let result = null;
  let lineEls = [];
  let marked = { sel: null, tab: null }; // the line buttons markSelection() last changed
  let visCache = null;
  let detailHead = null;
  let timer = null;
  let lastSaid = 0;

  /** The lab's one summary voice (the shell's live region). `settle` waits for input to stop,
   *  so stepping through the sample menu with the arrow keys announces only where it lands. */
  function say(text, settle = 0) {
    if (timer) clearTimeout(timer);
    const wait = Math.max(settle, 300 - (Date.now() - lastSaid));
    timer = setTimeout(() => { timer = null; lastSaid = Date.now(); ctx.announce(text); }, wait);
  }
  const isQuiz = () => ui.sample !== "paste" && !!SAMPLE_BY_ID.get(ui.sample)?.quiz;

  // ---- controls -------------------------------------------------------------------------
  const sampleSel = h("select", { id: `${id}-sample` });
  for (const sid of SAMPLE_IDS) sampleSel.append(h("option", { value: sid, text: SAMPLE_BY_ID.get(sid).label }));
  sampleSel.append(h("option", { value: "paste", text: "Your own log (paste or open a file)" }));
  const about = h("p", { class: "bla-note" });
  const prov = h("p", { class: "bla-prov" });

  const pasteArea = h("textarea", { id: `${id}-paste`, rows: "6", spellcheck: "false", autocomplete: "off", placeholder: "[    0.000000] Booting Linux on physical CPU 0x0000000000 ..." });
  const annotateBtn = h("button", { type: "button", class: "bla-btn bla-btn--primary", text: "Annotate" });
  const fileIn = h("input", { id: `${id}-file`, type: "file", accept: ".txt,.log,text/plain" });
  const pasteBox = h("div", { class: "bla-paste", hidden: true },
    h("label", { for: `${id}-paste`, text: "Paste a boot log: a serial log, dmesg output or a capture file" }),
    pasteArea,
    h("div", { class: "bla-row" },
      annotateBtn,
      h("span", { class: "bla-file" }, h("label", { for: `${id}-file`, text: "or open a file" }), fileIn)),
    h("p", { class: "bla-note", text: "The log is parsed in your browser and never uploaded. Links never carry its text." }));

  const colourStage = h("input", { type: "radio", name: `${id}-colour`, id: `${id}-c-s`, value: "s" });
  const colourKind = h("input", { type: "radio", name: `${id}-colour`, id: `${id}-c-k`, value: "k" });
  const onlyBox = h("input", { type: "checkbox", id: `${id}-only` });
  const resetBtn = h("button", { type: "button", class: "bla-btn", text: "Reset" });
  // Not a live region: its text is spoken once, through say(), with the rest of the update.
  const msg = h("p", { class: "bla-msg", hidden: true });

  const controls = h("div", { class: "bla-controls" },
    h("div", { class: "bla-field" }, h("label", { for: `${id}-sample`, text: "Log" }), sampleSel),
    about, prov, pasteBox,
    h("div", { class: "bla-row" },
      h("fieldset", { class: "bla-radios" },
        h("legend", { text: "Colour lines by" }),
        h("span", {}, colourStage, h("label", { for: `${id}-c-s`, text: "Stage" })),
        h("span", {}, colourKind, h("label", { for: `${id}-c-k`, text: "Line type" }))),
      h("span", { class: "bla-check" }, onlyBox, h("label", { for: `${id}-only`, text: "Key lines only" })),
      resetBtn),
    h("p", { class: "bla-note", text: "Key lines only hides housekeeping, explained or not; milestones, trouble, our-machine and report lines stay." }),
    msg);

  // ---- verdict and stage strip -----------------------------------------------------------
  // A plain region: the summary is spoken through say(), never by a live region here.
  const verdictBox = h("div", { class: "bla-verdict" });
  const intro = h("p", { class: "bla-intro" },
    "Linux boots in eight stages, each depending on the one before, and each prints a milestone line. The ",
    h("a", { href: primerHref("linux-boot-sequence"), text: "Linux boot sequence primer" }),
    " explains them. A stage below is done when its milestone appears.");
  const stageList = h("ol", { class: "bla-stages", "aria-label": "The eight boot stages" });
  const legend = h("ul", { class: "bla-legend", "aria-label": "Line types" });
  for (const [word, meaning] of LEGEND) legend.append(h("li", {}, h("span", { class: "bla-legend__w", text: word }), `: ${meaning}`));

  // ---- log and detail ---------------------------------------------------------------------
  const logTitleId = `${id}-logtitle`;
  const logList = h("ol", { class: "bla-log", "aria-labelledby": logTitleId });
  const logHead = h("h3", { id: logTitleId, text: "Boot log" });
  const logBox = h("div", { class: "bla-logbox" }, logList);
  const keysNote = h("p", { class: "bla-note", text: "Up and Down move between lines, Home and End jump to the ends, Page Up and Page Down move ten lines. The panel follows the selected line." });
  const detail = h("section", { class: "bla-detail", "aria-labelledby": `${id}-dtitle` });

  el.append(h("div", { class: "bla-wrap" },
    controls,
    verdictBox,
    intro,
    stageList,
    h("div", { class: "bla-main" },
      h("div", { class: "bla-col" }, logHead, keysNote, legend, logBox),
      detail)));

  // ---- rendering --------------------------------------------------------------------------
  function load() {
    let text = "";
    if (ui.sample === "paste") text = ui.pasted;
    else text = SAMPLE_BY_ID.get(ui.sample).text;
    result = annotate(text);
    if (ui.line !== null && (ui.line < 1 || ui.line > result.lines.length)) ui.line = null;
  }

  function renderControls() {
    sampleSel.value = ui.sample;
    colourStage.checked = ui.colour === "s";
    colourKind.checked = ui.colour === "k";
    onlyBox.checked = ui.onlyAnnotated;
    pasteBox.hidden = ui.sample !== "paste";
    if (ui.sample === "paste") {
      about.textContent = "Paste a log from your own macvmm (or any arm64 Linux boot) and press Annotate.";
      prov.textContent = "";
    } else {
      const s = SAMPLE_BY_ID.get(ui.sample);
      about.textContent = s.about;
      // For a broken run the header's second line says what was broken: it waits in the verdict.
      const header = headerLines();
      prov.replaceChildren(h("span", { class: "bla-prov__src", text: `${s.source}: ` }), (isQuiz() ? header.slice(0, 1) : header).join(" "));
    }
    msg.hidden = !ui.message;
    msg.textContent = ui.message;
  }

  function headerLines() {
    return result.info.header.filter((l) => !/^Regenerate with\b/.test(l));
  }

  function renderVerdict() {
    verdictBox.replaceChildren(h("h3", { text: "What the log says" }));
    if (!isQuiz()) {
      for (const s of result.summary.sentences) verdictBox.append(rich("p", s));
      return;
    }
    // A broken run the lesson asks you to read yourself: the stage strip first, the verdict on request.
    const reveal = h("details", { class: "bla-reveal" }, h("summary", { text: "Show the verdict" }));
    for (const s of result.summary.sentences) reveal.append(rich("p", s));
    const changed = headerLines().slice(1);
    if (changed.length) reveal.append(h("p", { class: "bla-note" }, h("strong", { text: "What was changed: " }), changed.join(" ")));
    verdictBox.append(h("p", { class: "bla-note", text: "Read the stage strip and the log first, then check your answer." }), reveal);
  }

  function renderStages() {
    stageList.replaceChildren();
    for (const st of result.summary.stages) {
      const target = st.milestones.find((m) => m.line !== null)?.line ?? st.firstLine;
      const isNext = result.summary.waiting === st.n && result.lines.length > 0;
      const btn = h("button", {
        type: "button", class: `bla-stage bla-s${st.n} bla-stage--${st.status}${isNext ? " bla-stage--next" : ""}`,
        disabled: target === null,
        "aria-label": `Stage ${st.n}, ${st.name}: ${STATUS_LABEL[st.status]}${isNext ? ", the next stage the boot was waiting for" : ""}${target !== null ? `. Go to line ${target}` : ""}`,
      },
      h("span", { class: "bla-stage__n", text: String(st.n) }),
      h("span", { class: "bla-stage__name", text: st.name }),
      h("span", { class: "bla-stage__status", text: isNext ? `${STATUS_LABEL[st.status]} · next` : STATUS_LABEL[st.status] }));
      if (target !== null) btn.addEventListener("click", () => select(target, true));
      stageList.append(h("li", {}, btn));
    }
  }

  function renderLog() {
    logList.replaceChildren();
    lineEls = [];
    marked = { sel: null, tab: null };
    visCache = null;
    logList.className = `bla-log bla-log--${ui.colour === "k" ? "kind" : "stage"}${ui.onlyAnnotated ? " bla-log--only" : ""}`;
    const n = result.lines.length;
    logHead.textContent = n ? `Boot log, ${n.toLocaleString("en-US")} line${n === 1 ? "" : "s"}` : "Boot log: empty";
    if (!n) {
      logList.append(h("li", { class: "bla-empty", text: "No lines. The serial port showed nothing." }));
      return;
    }
    for (const l of result.lines) {
      const tag = l.stage ? `S${l.stage}` : "·";
      const btn = h("button", {
        type: "button", tabindex: "-1", id: `${id}-l${l.n}`,
        class: `bla-line bla-s${l.stage || 0} bla-k-${l.kind}`,
        "aria-label": `Line ${l.n}${l.stage ? `, stage ${l.stage}` : ""}${KIND_LABEL[l.kind] ? `, ${KIND_LABEL[l.kind]}` : ""}: ${l.text}`,
      },
      h("span", { class: "bla-line__n", "aria-hidden": "true", text: String(l.n) }),
      h("span", { class: "bla-line__tag", "aria-hidden": "true", text: tag }),
      h("span", { class: "bla-line__kind", "aria-hidden": "true", text: KIND_LABEL[l.kind] }),
      h("span", { class: "bla-line__text", "aria-hidden": "true", text: l.text || " " }));
      btn.addEventListener("click", () => select(l.n, false, true));
      btn.addEventListener("keydown", (e) => onKey(e, l.n));
      lineEls.push(btn);
      logList.append(h("li", { class: HIDDEN_WHEN_FILTERED.has(l.kind) ? "bla-li bla-li--quiet" : "bla-li" }, btn));
    }
  }

  /** Visible line numbers, and each one's index; rebuilt only when the log or the filter changes. */
  function visibleLines() {
    if (!visCache) {
      const list = result.lines.filter((l) => !(ui.onlyAnnotated && HIDDEN_WHEN_FILTERED.has(l.kind))).map((l) => l.n);
      visCache = { list, index: new Map(list.map((n, i) => [n, i])) };
    }
    return visCache;
  }
  const startLine = () => ui.line ?? defaultLine(result, { quiz: isQuiz() });

  function renderDetail() {
    detail.replaceChildren();
    const n = startLine();
    if (n === null || !result.lines[n - 1]) {
      detailHead = h("h3", { id: `${id}-dtitle`, text: "No line selected" });
      detail.append(detailHead,
        h("p", { text: result.lines.length ? "Pick a line in the log, or a stage above." : "There is nothing to explain: the log is empty. The verdict above says what an empty serial port can mean." }));
      return;
    }
    const line = result.lines[n - 1];
    const x = explain(line);
    detail.append(h("p", { class: "bla-detail__where", text: `Line ${x.n}${x.stage ? ` · stage ${x.stage}: ${x.stageName}${x.stageBy === "position" ? " (by position)" : ""}` : ""}${KIND_LABEL[x.kind] ? ` · ${KIND_LABEL[x.kind]}` : ""}` }));
    detailHead = h("h3", { id: `${id}-dtitle`, text: x.title });
    detail.append(detailHead);
    detail.append(h("pre", { class: "bla-detail__line" }, h("code", { text: line.text || " " })));
    if (line.cut) detail.append(h("p", { class: "bla-note", text: `This line was longer than ${LIMITS.maxLineLen.toLocaleString("en-US")} characters and was cut.` }));
    detail.append(rich("p", x.what));
    if (x.cause) detail.append(h("h4", { text: "Caused by, in our machine" }), rich("p", x.cause));
    if (x.notes.length) {
      const ul = h("ul", { class: "bla-notes" });
      for (const t of x.notes) ul.append(rich("li", t));
      detail.append(h("h4", { text: "Checked against macvmm" }), ul);
    }
    if (x.node) {
      const dts = dtsNode(DTS_INDEX, x.node);
      detail.append(h("h4", {}, "Device-tree node ", h("code", { text: x.node })));
      if (dts) {
        detail.append(h("pre", { class: "bla-dts", tabindex: "0", "aria-label": `The ${x.node} node, as dtc printed it` }, h("code", { text: dts })));
        detail.append(h("p", { class: "bla-note", text: x.node === "/chosen"
          ? `A --dry-run dump of the healthy run's command (${SAMPLES.dts.source}). rng-seed and kaslr-seed are zeroed in dumps; the guest received random bytes (chapter 10).`
          : `From a --dry-run dump of the healthy run's device tree (${SAMPLES.dts.source}). A deliberate breakage changes it.` }));
      }
    }
    if (x.link) detail.append(h("p", {}, h("a", { href: x.link.href, text: x.link.label })));
    if (x.chapters.length || x.primers.length) {
      const ul = h("ul", { class: "bla-links" });
      for (const c of x.chapters) ul.append(h("li", {}, h("a", { href: c.href, text: `Chapter ${c.id}: ${c.title}` })));
      for (const p of x.primers) ul.append(h("li", {}, h("a", { href: p.href, text: `Primer: ${p.title}` })));
      detail.append(h("h4", { text: "Read more" }), ul);
    }
    if (x.stage && line.kind !== "milestone") {
      const st = STAGES[x.stage];
      detail.append(rich("p", `Stage ${x.stage}'s milestone: ${st.milestones.map((m) => `\`${m.label}\``).join(" and ")}. If it never appears, suspect: ${st.suspect} (${chList(st.ch)}).`, { class: "bla-note" }));
    }
  }

  /** Mark the selected line and the one Tab stop in the log. Touches only the lines that change. */
  function markSelection() {
    const n = startLine();
    const vis = visibleLines();
    const focusN = n !== null && vis.index.has(n) ? n : vis.list[0] ?? null;
    const sel = n !== null ? lineEls[n - 1] || null : null;
    const tab = focusN !== null ? lineEls[focusN - 1] || null : null;
    if (marked.sel && marked.sel !== sel) { marked.sel.setAttribute("aria-current", "false"); marked.sel.classList.toggle("bla-line--sel", false); }
    if (marked.tab && marked.tab !== tab) marked.tab.setAttribute("tabindex", "-1");
    if (sel) { sel.setAttribute("aria-current", "true"); sel.classList.toggle("bla-line--sel", true); }
    if (tab) tab.setAttribute("tabindex", "0");
    marked = { sel, tab };
  }

  /** Scroll the log box (never the page) so line n is in view. */
  function revealInLog(n) {
    const b = lineEls[n - 1];
    if (!b || typeof b.offsetTop !== "number" || typeof logBox.clientHeight !== "number") return;
    const top = b.offsetTop;
    const bottom = top + (b.offsetHeight || 0);
    if (top < logBox.scrollTop) logBox.scrollTop = Math.max(0, top - 8);
    else if (bottom > logBox.scrollTop + logBox.clientHeight) logBox.scrollTop = bottom - logBox.clientHeight + 8;
  }

  function writeHash() {
    try { ctx.hash.set(encodeShare({ sample: ui.sample, colour: ui.colour, onlyAnnotated: ui.onlyAnnotated, line: ui.line })); } catch { /* works without share state */ }
  }

  function renderAll() {
    renderControls();
    renderVerdict();
    renderStages();
    renderLog();
    renderDetail();
    markSelection();
    const n = startLine();
    if (n !== null) revealInLog(n);
  }

  function select(n, focus, fromClick = false) {
    ui.line = n;
    if (ui.onlyAnnotated && HIDDEN_WHEN_FILTERED.has(result.lines[n - 1]?.kind)) {
      ui.onlyAnnotated = false;
      logList.classList.toggle("bla-log--only", false);
      onlyBox.checked = false;
      visCache = null;
    }
    renderDetail();
    markSelection();
    writeHash();
    const b = lineEls[n - 1];
    if (b && focus && typeof b.focus === "function") b.focus({ preventScroll: true });
    revealInLog(n);
    // A click (not a key press) on a narrow screen may leave the panel below the fold: bring its
    // heading into view, without smooth scrolling.
    if (fromClick) {
      const head = detailHead;
      if (head && typeof head.scrollIntoView === "function") {
        try { head.scrollIntoView({ block: "nearest", behavior: "auto" }); } catch { /* old browsers */ }
      }
    }
    const x = explain(result.lines[n - 1]);
    say(`Line ${n}${x.stage ? `, stage ${x.stage}` : ""}: ${x.title}.`);
  }

  function onKey(e, n) {
    const { list: vis, index } = visibleLines();
    let i = index.has(n) ? index.get(n) : -1;
    if (i === -1) { // the focused line was just hidden by the filter: start from its neighbour
      const after = vis.findIndex((v) => v > n);
      i = after === -1 ? vis.length - 1 : Math.max(0, after - (e.key === "ArrowDown" ? 1 : 0));
    }
    let to = null;
    if (e.key === "ArrowDown") to = vis[Math.min(vis.length - 1, i + 1)];
    else if (e.key === "ArrowUp") to = vis[Math.max(0, i - 1)];
    else if (e.key === "Home") to = vis[0];
    else if (e.key === "End") to = vis[vis.length - 1];
    else if (e.key === "PageDown") to = vis[Math.min(vis.length - 1, i + 10)];
    else if (e.key === "PageUp") to = vis[Math.max(0, i - 10)];
    if (to === null || to === undefined) return;
    if (typeof e.preventDefault === "function") e.preventDefault();
    select(to, true);
  }

  function change(announce, settle = 0) {
    load();
    renderAll();
    writeHash();
    if (!announce) return;
    const n = result.lines.length;
    const name = ui.sample === "paste" ? "Your log" : SAMPLE_BY_ID.get(ui.sample).label;
    const gist = isQuiz() ? "The verdict is hidden: read the stage strip, then open Show the verdict." : result.summary.sentences[0].replace(/`/g, "");
    say(`${name}, ${n.toLocaleString("en-US")} line${n === 1 ? "" : "s"}. ${gist}${ui.message ? ` ${ui.message}` : ""}`, settle);
  }

  // ---- events -----------------------------------------------------------------------------
  sampleSel.addEventListener("change", () => {
    const v = sampleSel.value;
    if (v !== "paste" && !SAMPLE_IDS.includes(v)) return;
    ui.sample = v;
    ui.line = null;
    ui.message = "";
    // Focus stays on the menu (the paste box, when shown, is next in Tab order), and the
    // announcement waits until the arrow keys stop.
    change(true, 600);
  });
  annotateBtn.addEventListener("click", () => {
    ui.sample = "paste";
    ui.pasted = String(pasteArea.value || "");
    ui.line = null;
    ui.message = ui.pasted.length > LIMITS.maxChars ? `Only the first ${LIMITS.maxChars / 1024 / 1024} MiB were read.` : "";
    change(true);
  });
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    if (f.size > LIMITS.maxFileBytes) {
      ui.message = `That file is ${(f.size / 1024 / 1024).toFixed(1)} MiB; the lab reads files up to 16 MiB.`;
      renderControls();
      say(ui.message);
      fileIn.value = "";
      return;
    }
    try {
      const text = await f.slice(0, LIMITS.maxChars * 2).text();
      ui.sample = "paste";
      ui.pasted = text;
      pasteArea.value = text.length > 200000 ? `${text.slice(0, 200000)}\n...` : text;
      ui.line = null;
      ui.message = `Read ${f.name.slice(0, 80)}.`;
      change(true);
    } catch (err) {
      ui.message = `Could not read that file: ${err && err.message ? err.message : String(err)}`;
      renderControls();
      say(ui.message);
    }
    fileIn.value = ""; // so opening the same file again fires `change`
  });
  colourStage.addEventListener("change", () => { ui.colour = "s"; logList.classList.toggle("bla-log--stage", true); logList.classList.toggle("bla-log--kind", false); writeHash(); });
  colourKind.addEventListener("change", () => { ui.colour = "k"; logList.classList.toggle("bla-log--stage", false); logList.classList.toggle("bla-log--kind", true); writeHash(); });
  onlyBox.addEventListener("change", () => {
    ui.onlyAnnotated = !!onlyBox.checked;
    logList.classList.toggle("bla-log--only", ui.onlyAnnotated);
    visCache = null;
    markSelection();
    writeHash();
  });
  resetBtn.addEventListener("click", () => {
    ui.sample = "boot"; ui.colour = "s"; ui.onlyAnnotated = false; ui.line = null; ui.message = ""; ui.pasted = "";
    pasteArea.value = "";
    fileIn.value = "";
    change(true);
  });

  // ---- start ------------------------------------------------------------------------------
  if (shared && shared.sample === "paste") ui.message = "This link was made from a pasted log, and links never carry the log itself. Paste it again to see it.";
  load();
  renderAll();
  writeHash();

  return {
    destroy() { if (timer) clearTimeout(timer); timer = null; },
  };
}
