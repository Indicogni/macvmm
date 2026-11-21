// hostile-guest view: renders the model and turns clicks into model calls. All fuzzing, walking
// and checking lives in model.mjs; this file only builds DOM (createElement + textContent, never parsed
// HTML strings) inside the element the lab shell hands us. See course/site/LABS.md.
import {
  INVARIANTS, RAM_A, RAM_B, RAM_B_SIZE, MAX_ITER, HANG_READS,
  plantById, generate, runInput, fuzz, failureLines, replayLines, minimise, nonZero, trimmedLength,
  threeBuffers, hex, flagNames, placeOf, describeOffset, parseSeed, parseIter,
  encodeShare, decodeShare,
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

const num = (n) => Number(n).toLocaleString("en-US");
const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const SLICE_MS = 30;
const RAM_END = RAM_B + RAM_B_SIZE;
const SHOW_READS = 64;
const SHOW_POPS = 24;

const CAPS = { 4096: "4 KiB", 65536: "64 KiB", 1048576: "1 MiB", 4294967296: "4 GiB" };
// The reference fuzzer's speed on the reference Mac: chapter 25's plant 5 run, 23,338,941
// iterations in 128 s. Browser seconds are not comparable, so the lab converts counts to this.
const NATIVE_RATE = 23338941 / 128;
// The select follows the chapter: the reference, the two plants of "Ten seconds, or never?",
// then the deliberate breaks the chapter asks you to predict later.
const FIRST_PLANTS = ["ref", "p2", "p5"];
const LATER_PLANTS = ["p1", "p3", "p4"];
const PREDICT_PLANTS = { p1: "Deliberate breakage 1", p3: "Deliberate breakage 2" };

export function mount(el, ctx) {
  const id = ctx.id;
  let plant = plantById("p2");
  let seed = 1n;
  let next = 0; // the next iteration the fuzzer runs
  let running = false;
  let busyMs = 0;
  let wallMs = 0; // elapsed fuzzing time, paused time excluded
  let runStart = 0;
  let timer = null;
  let shown = null; // { three, seed, iter, shrunk }
  let lines = [];
  let sayTimer = null;
  let lastAnnounce = 0;

  // `more` goes to the readout only (a next-step hint), not to the announcement.
  function say(text, more = "") {
    readout.textContent = more ? `${text} ${more}` : text;
    const t = Date.now();
    if (sayTimer) clearTimeout(sayTimer);
    sayTimer = setTimeout(() => {
      sayTimer = null;
      lastAnnounce = Date.now();
      ctx.announce(text);
    }, Math.max(0, 300 - (t - lastAnnounce)));
  }

  // ---- controls -------------------------------------------------------------------------
  const plantSel = h("select", { id: `${id}-plant`, "aria-describedby": `${id}-plantnote` });
  for (const pid of FIRST_PLANTS) plantSel.append(h("option", { value: pid, text: plantById(pid).name }));
  const later = h("optgroup", { label: "Later in this chapter: the deliberate breaks" });
  for (const pid of LATER_PLANTS) later.append(h("option", { value: pid, text: plantById(pid).name }));
  plantSel.append(later);
  plantSel.value = plant.id;
  const plantNote = h("p", { class: "hg-note", id: `${id}-plantnote` });
  const codeBox = h("fieldset", { class: "hg-box" },
    h("legend", { text: "The code under test" }),
    h("div", { class: "hg-field" }, h("label", { for: `${id}-plant`, text: "Chapter 16's walker and queue, with" }), plantSel),
    plantNote,
  );

  const seedIn = h("input", { id: `${id}-seed`, type: "text", inputmode: "numeric", autocomplete: "off", spellcheck: "false", value: "1", size: "12", maxlength: "20" });
  const runBtn = h("button", { type: "button", class: "hg-btn hg-btn--primary", text: "Run the fuzzer" });
  const stepBtn = h("button", { type: "button", class: "hg-btn", text: "One iteration" });
  const resetBtn = h("button", { type: "button", class: "hg-btn", text: "Reset" });
  const iterIn = h("input", { id: `${id}-iter`, type: "text", inputmode: "numeric", autocomplete: "off", spellcheck: "false", value: "0", size: "12", maxlength: "20" });
  const replayBtn = h("button", { type: "button", class: "hg-btn", text: "Replay iteration" });
  const threeBtn = h("button", { type: "button", class: "hg-btn", text: "Replay the hand-built three-buffer input" });
  // Not a live region: errors are spoken through say() (one voice, LABS.md section 6); this
  // note is what aria-describedby points the refused field at.
  const fuzzNote = h("p", { class: "hg-note", id: `${id}-fuzznote` });
  const fuzzBox = h("fieldset", { class: "hg-box" },
    h("legend", { text: "The fuzzer" }),
    h("div", { class: "hg-row" },
      h("div", { class: "hg-field" }, h("label", { for: `${id}-seed`, text: "Seed" }), seedIn),
      h("div", { class: "hg-buttons", role: "group", "aria-label": "Fuzzing" }, runBtn, stepBtn, resetBtn),
    ),
    h("div", { class: "hg-row" },
      h("div", { class: "hg-field" }, h("label", { for: `${id}-iter`, text: "Iteration to replay" }), iterIn),
      h("div", { class: "hg-buttons" }, replayBtn, threeBtn),
    ),
    fuzzNote,
  );

  const tryThis = h("div", { class: "hg-try" },
    h("h3", { text: "Try this" }),
    h("ol", {},
      h("li", { text: "Keep Plant 2, write down your guess, and press Run the fuzzer. A seed picks the random stream; each iteration draws one hostile ring from it and runs it." }),
      h("li", { text: "When it stops, read the verdict first, then which invariant (a rule correct code always keeps) is marked BROKEN, then the walk table." }),
      h("li", { text: "Press Shrink it and read the few bytes that are left." }),
      h("li", { text: "Pick \"No plant\" to see the same input pass against the correct code." }),
      h("li", { text: "Try Plant 5, the verdict cache, or replay its iteration once the chapter gives it." }),
    ),
  );
  const status = h("p", { class: "hg-status" });
  const readout = h("p", { class: "hg-readout" });
  const term = h("pre", { class: "hg-term" });
  const termBox = h("figure", { class: "hg-termbox" }, h("figcaption", { text: "Fuzzer output" }), term);

  // ---- inspector ------------------------------------------------------------------------
  const inspTitle = h("h3");
  const verdict = h("p", { class: "hg-verdict" });
  const invList = h("ol", { class: "hg-inv" });
  const specBody = h("tbody");
  const specTable = h("table", { class: "hg-table" },
    h("caption", { text: "The ring this input describes: header bytes 0 to 5, each row names its byte" }), specBody);
  const mutTitle = h("h4", { tabindex: "-1" });
  const mutKey = h("p", { class: "hg-note", text: "Key: shape = a structure-aware move (it knows where descriptors are); byte = a blind byte-level change. Most do not matter; Shrink it finds the bytes that do." });
  const mutList = h("ol", { class: "hg-muts" });
  const popsTitle = h("h4", { text: "Every pop of the run" });
  const popsList = h("ol", { class: "hg-pops" });
  const walkBody = h("tbody");
  const walkCaption = h("caption");
  const walkTable = h("table", { class: "hg-table hg-walk" }, walkCaption,
    h("thead", {}, h("tr", {},
      ...["#", "table", "entry", "descriptor at", "addr", "len", "flags", "next", "the walker's verdict"].map((t) => h("th", { scope: "col", text: t })))),
    walkBody);
  const walkMore = h("p", { class: "hg-note" });
  const strip = h("div", { class: "hg-strip", "aria-hidden": "true" },
    h("span", { class: "hg-seg hg-seg--a", text: "region A" }),
    h("span", { class: "hg-seg hg-seg--hole", text: "hole" }),
    h("span", { class: "hg-seg hg-seg--b", text: "B" }));
  const mark = h("span", { class: "hg-mark" });
  strip.append(mark);
  const stripText = h("p", { class: "hg-note" });
  const stripBox = h("div", { class: "hg-stripbox" },
    h("h4", { text: "Where the bad access lands" }), strip,
    h("p", { class: "hg-axis", "aria-hidden": "true" }, h("span", { text: "0x4000_0000" }), h("span", { text: "0x4009_0000" })),
    stripText);
  const shrinkBtn = h("button", { type: "button", class: "hg-btn", text: "Shrink it" });
  const shrinkNote = h("p", { class: "hg-note" });
  const bytesBody = h("tbody");
  const bytesTable = h("table", { class: "hg-table" },
    h("caption", { text: "The bytes that are not zero" }),
    h("thead", {}, h("tr", {}, ...["offset", "value", "field"].map((t) => h("th", { scope: "col", text: t })))),
    bytesBody);
  // Keyboard users scroll these sideways at narrow widths, so each box takes focus (Safari does
  // not make scroll containers focusable on its own).
  // A box takes a tab stop only while its table is wider than it (see fitScrollers).
  const scrollers = [];
  const scroller = (label, kid) => {
    const box = h("div", { class: "hg-scroll", role: "region", "aria-label": label }, kid);
    scrollers.push(box);
    return box;
  };
  const bytesBox = scroller("The bytes that are not zero, scrolls sideways", bytesTable);

  const inspector = h("section", { class: "hg-insp", "aria-label": "The inspected input" },
    inspTitle, verdict,
    h("div", { class: "hg-cols" },
      h("div", { class: "hg-col" }, h("h4", { text: "The five invariants" }), invList),
      h("div", { class: "hg-col" }, scroller("The ring this input describes, scrolls sideways", specTable)),
    ),
    mutTitle, mutKey, mutList,
    popsTitle, popsList,
    scroller("The last pop's walk, scrolls sideways", walkTable), walkMore,
    stripBox,
    h("div", { class: "hg-buttons" }, shrinkBtn), shrinkNote, bytesBox,
  );
  inspector.hidden = true;

  const honesty = h("details", { class: "hg-more" },
    h("summary", { text: "What this lab simplifies" }),
    h("ul", {},
      h("li", { text: "It is a port of the reference's fuzzer for the virtqueue target and of chapter 16's walker and queue, draw for draw: a seed and an iteration give the same bytes, and the same verdict, as cargo run -p fuzz -- virtqueue." }),
      h("li", { text: `The real fuzzer's watchdog calls an iteration over 2 seconds a hang. The lab cannot time Rust, so it counts descriptor reads: on the reference Mac a walk does about 35 million a second, so a pop past ${num(HANG_READS)} reads is reported as a hang. Close to that line, the real run could land on either side.` }),
      h("li", { text: "A walk with no hop budget that loops is skipped ahead whole loops at a time, not walked step by step. The read count comes out the same." }),
      h("li", { text: "The tags at the end of some messages (VQ-5, MEM-7, VQ-4, VQ-8, VQ-9) name rows of the reference's threat model; chapter 25 lists them. Invariant 4 has two checks: a buffer outside RAM reports VQ-4, a direction over the byte cap reports VQ-8 (no plant reaches the second)." }),
      h("li", { text: "The FAILURE messages are the real fuzzer's, word for word. The hang verdict in the inspector and the pass summaries are the lab's own wording; the real watchdog prints only the HANG line." }),
      h("li", { text: "There is no second thread, so the race-only variant of plant 4 cannot run here. Plant 4 is caught from the access log (invariant 3), as the plain target catches it." }),
      h("li", { text: `Your browser does 64-bit arithmetic more slowly than compiled Rust, and slows background tabs further, so a plant that takes minutes there takes longer here. Compare iteration counts, not seconds: the native fuzzer does about ${num(Math.round(NATIVE_RATE / 10000) * 10000)} iterations a second. After you have made your prediction, the chapter gives the iteration numbers to replay.` }),
      h("li", { text: "Nothing is saved to disk and nothing leaves the page; Shrink zeroes chunks only (halves, quarters, down to single bytes), one of the two moves the lesson describes." }),
    ),
  );

  el.append(h("div", { class: "hg-wrap" },
    tryThis,
    h("div", { class: "hg-controls" }, codeBox, fuzzBox),
    status, readout, termBox, inspector, honesty,
  ));

  // ---- rendering ------------------------------------------------------------------------
  function renderControls() {
    let note = plant.file ? `${plant.what} (crates/fuzz/planted/${plant.file})` : plant.what;
    if (PREDICT_PLANTS[plant.id]) note += ` The chapter's "${PREDICT_PLANTS[plant.id]}" asks you to predict which invariant this breaks; write your guess before you run it.`;
    plantNote.textContent = note;
    runBtn.textContent = running ? "Pause" : next > 0 ? "Keep fuzzing" : "Run the fuzzer";
    stepBtn.disabled = running;
    replayBtn.disabled = running;
    threeBtn.disabled = running;
    shrinkBtn.disabled = running || !shown || shown.shrunk;
  }

  function elapsed() {
    return wallMs + (running ? now() - runStart : 0);
  }

  function renderStatus() {
    const rate = busyMs > 0 ? Math.round((next * 1000) / busyMs) : 0;
    const secs = (elapsed() / 1000).toFixed(1);
    const slow = plant.n === 5 || elapsed() > 30000;
    const front = "Keep this tab in front: browsers slow background tabs.";
    if (next === 0) {
      status.textContent = `Seed ${seed}: no iterations run yet.${plant.n === 5 ? ` This plant needs millions of iterations. ${front}` : ""}`;
      return;
    }
    let text = `Seed ${seed}: ${num(next)} iteration${next === 1 ? "" : "s"} in ${secs} s of fuzzing${rate ? `, about ${num(rate)} per second in this browser` : ""}.`;
    if (slow) {
      const native = next / NATIVE_RATE;
      text += ` The native fuzzer (about ${num(Math.round(NATIVE_RATE / 10000) * 10000)} a second: the chapter's 23,338,941 in 128 s) would need about ${native < 10 ? native.toFixed(1) : num(Math.round(native))} s for this many; judge by the iteration count, not these seconds. ${front}`;
    }
    status.textContent = text;
  }

  function fitScrollers() {
    for (const box of scrollers) {
      const wide = !box.hidden && typeof box.scrollWidth === "number" && box.scrollWidth > box.clientWidth;
      if (wide) box.setAttribute("tabindex", "0");
      else box.removeAttribute("tabindex");
    }
  }

  function renderTerm() {
    term.textContent = lines.length ? lines.slice(-8).join("\n") : "fuzz virtqueue: waiting";
  }

  function print(...ls) {
    lines.push(...ls);
    if (lines.length > 40) lines = lines.slice(-40);
    renderTerm();
  }

  function setHash() {
    ctx.hash.set(shown ? encodeShare({ plant: plant.id, seed: shown.seed, iter: shown.iter, three: shown.three, shrunk: shown.shrunk }) : null);
  }

  function inputFor(s) {
    if (s.three) return { input: threeBuffers(), notes: null };
    const g = generate(s.seed, s.iter, true);
    return { input: g.input, notes: g.notes };
  }

  function renderInspector() {
    if (!shown) {
      inspector.hidden = true;
      return;
    }
    inspector.hidden = false;
    let { input, notes } = inputFor(shown);
    let shrinkInfo = null;
    if (shown.shrunk) {
      const before = input;
      const m = minimise(input, plant.n);
      input = m.bytes;
      shrinkInfo = { before, tries: m.tries };
    }
    const r = runInput(input, plant.n, true);
    const label = shown.three ? "The hand-built three-buffer input" : `Iteration ${num(shown.iter)} of seed ${shown.seed}`;
    inspTitle.textContent = `${label}${shown.shrunk ? ", shrunk" : ""}, against ${plant.n ? `plant ${plant.n}` : "the reference"}`;
    verdict.textContent = r.ok ? `Passed: ${r.outcome}.` : `FAILED, invariant ${r.invariant}: ${r.message}`;
    verdict.classList.toggle("hg-verdict--fail", !r.ok);

    invList.replaceChildren();
    for (const inv of INVARIANTS) {
      let state = "held";
      if (!r.ok && inv.n === r.invariant) state = "BROKEN";
      else if (!r.ok && inv.n > r.invariant && inv.n !== 1) state = "not reached";
      // A pass that ended on a refusal returned before checking the later invariants for that pop.
      else if (r.ok && r.notReached && inv.n >= r.notReached) state = "not reached";
      invList.append(h("li", { class: `hg-inv__${state === "BROKEN" ? "broken" : state === "held" ? "held" : "skip"}` },
        h("span", { class: "hg-tag", text: state }), ` ${inv.text}${inv.tag ? ` Reported as ${inv.tag}.` : ""}`));
    }

    const s = r.spec;
    specBody.replaceChildren(
      ...[
        ["queue size N (byte 0)", `${s.size}: how many descriptors the ring holds`],
        ["indirect tables (byte 1)", `${s.indirect ? "negotiated" : "not negotiated"}: whether a descriptor may point at a separate table of descriptors`],
        ["rings (byte 1)", s.packed ? `packed at the end of region B (descriptors ${hex(s.desc)}, used ${hex(s.used)})` : `descriptors ${hex(s.desc)}, avail ${hex(s.avail)}, used ${hex(s.used)}`],
        ["chains per round (bytes 2 and 3)", `${s.perRound}: how far the driver moves avail.idx each round${s.perRound > s.size ? "; more than N, so the index jumps past chains the ring cannot hold" : ""}`],
        ["byte cap per direction (byte 4)", `${CAPS[s.maxTotal] ?? String(s.maxTotal)}: the most bytes one chain may describe for reading, and again for writing`],
        ["rounds (byte 5)", `${s.rounds}: each round the driver bumps avail.idx and the device pops until nothing is pending`],
        ["descriptor reads allowed per pop", `${2 * s.size + 1} (2N + 1), invariant 2's budget`],
      ].map(([k, v]) => h("tr", {}, h("th", { scope: "row", text: k }), h("td", { text: v }))),
    );

    mutList.replaceChildren();
    mutKey.hidden = !(notes && notes.length && !shrinkInfo);
    if (shrinkInfo) {
      mutTitle.textContent = "How it was shrunk";
      mutList.append(h("li", { text: `${num(shrinkInfo.tries)} runs, zeroing chunks while invariant ${r.invariant ?? "?"} still failed: ${num(nonZero(shrinkInfo.before))} non-zero bytes down to ${num(nonZero(input))}; with trailing zeros cut, ${num(trimmedLength(input))} of ${num(input.length)} bytes.` }));
    } else if (notes === null) {
      mutTitle.textContent = "How it was made";
      mutList.append(h("li", { text: "By hand, from the input layout: a size-4 queue, one chain of three buffers (crates/fuzz/planted/05-three-buffers.bin, 568 bytes, 17 not zero)." }));
    } else {
      mutTitle.textContent = notes.length ? `The ${notes.length} mutation${notes.length === 1 ? "" : "s"} after a well-formed seed ring` : "No mutations: the seed ring as drawn";
      for (const n of notes) mutList.append(h("li", { text: n }));
    }

    popsList.replaceChildren();
    const pops = r.pops ?? [];
    // The first pops, then always the last (deciding) one, marked in text as well as weight.
    const popText = (p) => {
      let text;
      if (p.empty) text = "nothing pending";
      else if (p.error && p.head === undefined) text = `pop refused: ${p.error.text}`;
      else {
        text = `head ${p.head}: ${num(p.readCount ?? 0)} descriptor read${p.readCount === 1 ? "" : "s"}`;
        if (p.error) text += `, refused: ${p.error.text}`;
        else if (p.validated) {
          text += `, validated (${p.validated.readable.length} readable, ${p.validated.writable.length} writable)`;
          if (p.usedSlot !== undefined) text += `, used slot ${p.usedSlot}`;
        }
      }
      return `round ${p.round + 1}, avail.idx ${p.availIdx}: ${text}`;
    };
    const head = pops.length > SHOW_POPS ? pops.slice(0, SHOW_POPS - 1) : pops.slice(0, -1);
    for (const p of head) popsList.append(h("li", { text: popText(p) }));
    if (pops.length > SHOW_POPS) popsList.append(h("li", { class: "hg-pop--gap", text: `... ${num(pops.length - SHOW_POPS)} more pops` }));
    if (pops.length) {
      popsList.append(h("li", { class: "hg-pop--last", text: `${popText(pops.at(-1))} ${r.ok ? "(the last pop)" : "(the failing pop)"}` }));
    }

    const last = pops.filter((p) => p.reads).at(-1);
    walkBody.replaceChildren();
    walkMore.textContent = "";
    if (last) {
      const reads = last.reads;
      walkCaption.textContent = `The last pop's walk: head ${last.head ?? "?"}, round ${last.round + 1}`;
      reads.forEach((x, i) => {
        let v = x.verdict;
        if (x.again) v += " (then read again: a double fetch)";
        const tr = h("tr", { class: x.bad ? "hg-bad" : x.cached ? "hg-cached" : "" },
          h("td", { text: String(i + 1) }), h("td", { text: x.table }), h("td", { text: String(x.index) }),
          h("td", { class: "hg-mono", text: hex(x.at) }), h("td", { class: "hg-mono", text: `${hex(x.addr)} (${placeOf(x.addr)})` }),
          h("td", { class: "hg-mono", text: hex(x.len) }), h("td", { class: "hg-mono", text: flagNames(x.flags) }),
          h("td", { class: "hg-mono", text: String(x.next) }), h("td", { text: v }));
        walkBody.append(tr);
      });
      const total = reads.total ?? reads.length;
      if (total > reads.length) {
        const keys = new Set();
        const loops = total > 2 * s.size + 1 || reads.some((x) => {
          const k = `${x.table}:${x.index}`;
          if (keys.has(k)) return true;
          keys.add(k);
          return false;
        });
        walkMore.textContent = `Showing the first ${SHOW_READS} of ${num(total)} steps of this walk${loops ? "; the rest go round the same loop" : ""}.`;
      }
      if (!reads.length) walkMore.textContent = "The walk read no descriptor.";
    } else {
      walkCaption.textContent = "No pop reached the walker.";
    }

    const bad = pops.find((p) => p.bad)?.bad ?? null;
    const badWrite = pops.find((p) => p.badWrite)?.badWrite ?? null;
    const target = bad ?? badWrite;
    stripBox.hidden = !target;
    if (target) {
      const span = Number(RAM_END - RAM_A);
      const start = target.addr < RAM_A ? 0 : Number(target.addr - RAM_A);
      const end = target.addr + BigInt(target.len);
      const endOff = end > RAM_END ? span : Number(end - RAM_A);
      const left = Math.min(100, (100 * start) / span);
      mark.style.left = `${left}%`;
      mark.style.width = `${Math.max(0.6, Math.min(100 - left, (100 * Math.max(0, endOff - start)) / span))}%`;
      const what = bad ? "validated buffer" : "device write";
      stripText.textContent = `The ${what} ${hex(target.addr)}+${hex(target.len)} starts in ${placeOf(target.addr)} and ends at ${hex(end - 1n)}, in ${placeOf(end - 1n)}${end > RAM_END ? ", past the end of RAM" : ""}.`;
    }

    const nz = [];
    for (let i = 0; i < input.length && nz.length < 64; i++) if (input[i] !== 0) nz.push(i);
    const showBytes = shown.three || shown.shrunk;
    bytesBox.hidden = !showBytes;
    bytesBody.replaceChildren();
    if (showBytes) {
      for (const i of nz) bytesBody.append(h("tr", {}, h("td", { class: "hg-mono", text: `${i} (${hex(i)})` }), h("td", { class: "hg-mono", text: hex(input[i]) }), h("td", { text: describeOffset(i) })));
    }
    shrinkNote.textContent = r.ok || shown.shrunk ? "" : `${num(nonZero(input))} of ${num(input.length)} bytes are not zero.`;
    shrinkBtn.hidden = r.ok;
    fitScrollers();
    return r;
  }

  function render() {
    renderControls();
    renderStatus();
    renderTerm();
    return renderInspector();
  }

  // ---- actions --------------------------------------------------------------------------
  function nextHint() {
    return plant.n
      ? "Next: press Shrink it to see which bytes matter, or pick \"No plant\" to replay this input against the correct code."
      : "Next: press Shrink it to see which bytes matter.";
  }

  function markInvalid(input, bad) {
    if (bad) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", `${id}-fuzznote`);
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }

  function refuse(field, text) {
    fuzzNote.textContent = text;
    field.focus();
    say(text);
  }

  function readSeed() {
    const v = parseSeed(seedIn.value);
    markInvalid(seedIn, v === null);
    if (v === null) {
      refuse(seedIn, "The seed is a whole number from 0 to 18446744073709551615.");
      return null;
    }
    fuzzNote.textContent = "";
    if (v !== seed) {
      seed = v;
      next = 0;
      busyMs = 0;
      wallMs = 0;
    }
    return v;
  }

  function show(s) {
    shown = s;
    setHash();
    const r = renderInspector();
    renderControls();
    return r;
  }

  function stop() {
    if (running) wallMs += now() - runStart;
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function tick() {
    timer = null;
    if (!running) return;
    const t0 = now();
    let found = null;
    while (now() - t0 < SLICE_MS && !found && next < MAX_ITER) {
      const r = fuzz(seed, plant.n, next, 25);
      next = r.next;
      found = r.failure;
    }
    busyMs += now() - t0;
    if (found) {
      stop();
      print(...failureLines(seed, found.iter, found.message, found.hang));
      iterIn.value = String(found.iter);
      show({ three: false, seed, iter: found.iter, shrunk: false });
      say(`Failure at iteration ${num(found.iter)} after ${(elapsed() / 1000).toFixed(1)} s: invariant ${found.invariant}. ${found.message}`, nextHint());
    } else if (next >= MAX_ITER) {
      stop();
      print(`[lab] stopped at iteration ${num(next)}, the most this page can count; no failure`);
      say(`Stopped at iteration ${num(next)}, the most this page can count. No failure.`);
    }
    renderStatus();
    renderControls();
    if (running) timer = setTimeout(tick, 0);
  }

  runBtn.addEventListener("click", () => {
    if (running) {
      stop();
      print(`[lab] you paused the fuzzer after ${num(next)} iterations; no failure so far`);
      say(`Paused after ${num(next)} iterations, no failure.`);
      render();
      return;
    }
    if (readSeed() === null) return;
    running = true;
    runStart = now();
    say(`Fuzzing ${plant.n ? `plant ${plant.n}` : "the reference"} from iteration ${num(next)}.`);
    renderControls();
    renderStatus();
    timer = setTimeout(tick, 0);
  });

  stepBtn.addEventListener("click", () => {
    if (readSeed() === null) return;
    const iter = next;
    next += 1;
    iterIn.value = String(iter);
    const r = show({ three: false, seed, iter, shrunk: false });
    if (!r.ok) print(...failureLines(seed, iter, r.message, r.hang));
    else print(`[lab] iteration ${iter} passed: ${r.outcome}`);
    renderStatus();
    if (r.ok) say(`Iteration ${num(iter)} passed: ${r.outcome}.`);
    else say(`Iteration ${num(iter)} failed invariant ${r.invariant}: ${r.message}`, nextHint());
  });

  replayBtn.addEventListener("click", () => {
    if (readSeed() === null) return;
    const iter = parseIter(iterIn.value);
    markInvalid(iterIn, iter === null);
    if (iter === null) {
      refuse(iterIn, "The iteration is a whole number (commas are fine), at most 9007199254740991.");
      return;
    }
    const r = show({ three: false, seed, iter, shrunk: false });
    print(...replayLines(r));
    if (r.ok) say(`Iteration ${num(iter)} passes: ${r.outcome}.`);
    else say(`Iteration ${num(iter)} fails invariant ${r.invariant}: ${r.message}`, nextHint());
  });

  threeBtn.addEventListener("click", () => {
    const r = show({ three: true, seed, iter: null, shrunk: false });
    print(...replayLines(r));
    if (r.ok) say(`The three-buffer input passes: ${r.outcome}.`);
    else say(`The three-buffer input fails invariant ${r.invariant}: ${r.message}`, nextHint());
  });

  shrinkBtn.addEventListener("click", () => {
    if (!shown || shown.shrunk) return;
    const r = show({ ...shown, shrunk: true });
    // The button is now disabled, which would drop keyboard focus: move it to the result.
    mutTitle.focus();
    say(r.ok ? "Shrunk." : `Shrunk; it still fails invariant ${r.invariant}.`);
  });

  resetBtn.addEventListener("click", () => {
    stop();
    next = 0;
    busyMs = 0;
    wallMs = 0;
    lines = [];
    shown = null;
    setHash();
    say("Reset. No iterations run.");
    render();
  });

  plantSel.addEventListener("change", () => {
    const p = plantById(plantSel.value);
    if (!p) return;
    const wasRunning = running;
    stop();
    if (wasRunning) print(`[lab] fuzzing paused after ${num(next)} iterations: the plant changed`);
    plant = p;
    next = 0;
    busyMs = 0;
    wallMs = 0;
    if (shown) shown = { ...shown, shrunk: false };
    setHash();
    const r = render();
    const parts = [`${p.name}.`];
    if (wasRunning) parts.push("Fuzzing paused.");
    if (shown) {
      const what = shown.three ? "The three-buffer input" : `Iteration ${num(shown.iter)}`;
      print(...replayLines(r));
      parts.push(r.ok ? `Replayed ${what.toLowerCase()}: passes, ${r.outcome}.` : `Replayed ${what.toLowerCase()}: fails invariant ${r.invariant}: ${r.message}`);
    } else {
      parts.push(p.what);
    }
    say(parts.join(" "));
  });

  seedIn.addEventListener("change", () => {
    if (running) return;
    readSeed();
    renderStatus();
    renderControls();
  });

  // Browsers throttle timers in hidden tabs, so a long search crawls there. Say so when it happens.
  let hiddenAt = null;
  function onVisibility() {
    if (document.hidden) {
      if (running) hiddenAt = now();
    } else if (hiddenAt !== null) {
      const away = (now() - hiddenAt) / 1000;
      hiddenAt = null;
      if (running) print(`[lab] fuzzing slowed while this tab was hidden (${away.toFixed(0)} s): browsers throttle background tabs`);
    }
  }
  const canWatch = typeof document.addEventListener === "function";
  if (canWatch) document.addEventListener("visibilitychange", onVisibility);
  const canResize = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (canResize) window.addEventListener("resize", fitScrollers);

  // ---- start ----------------------------------------------------------------------------
  const shared = decodeShare(ctx.hash.get());
  if (shared) {
    plant = plantById(shared.plant);
    plantSel.value = plant.id;
    seed = shared.seed;
    seedIn.value = String(seed);
    if (!shared.three) iterIn.value = String(shared.iter);
    shown = { three: shared.three, seed: shared.seed, iter: shared.iter, shrunk: false };
    const input = inputFor(shown).input;
    const r = runInput(input, plant.n);
    // Shrinking needs a failing input; when it fails, the terminal replays the shrunk bytes,
    // the same ones the inspector shows.
    if (shared.shrunk && !r.ok) {
      shown.shrunk = true;
      lines = replayLines(runInput(minimise(input, plant.n).bytes, plant.n));
    } else {
      lines = replayLines(r);
    }
    setHash();
  }
  render();
  readout.textContent = shared
    ? "Showing the shared input. Change the plant to replay it against other code."
    : "Pick a plant and run the fuzzer. It stops at the first input that breaks an invariant. Before you press Run, write down a guess in iterations, so it does not depend on this browser's speed: will it fail within about 2 million iterations (10 seconds of the native fuzzer), within about 100 million (10 minutes), or never?";

  return {
    destroy() {
      stop();
      if (canWatch) document.removeEventListener("visibilitychange", onVisibility);
      if (canResize) window.removeEventListener("resize", fitScrollers);
      if (sayTimer) clearTimeout(sayTimer);
    },
  };
}
