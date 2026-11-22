// ansi-filter: the view. It renders what model.mjs computes and turns events into model calls.
// DOM is built with createElement and textContent only: every string shown here may come from
// a reader's paste or a share link, so none of it is ever parsed as HTML. Nothing outside `el`
// is touched except ctx.hash and ctx.announce (and, when the reader presses "Copy link", the
// clipboard, which gets location.href). The reader's own text is never written to the address
// unless they press that button. Speech goes through ctx.announce only (the page's
// one polite live region); the readout on screen is a plain paragraph, so nothing is read twice.
import {
  PRESETS,
  EFFECTS,
  presetById,
  initialState,
  encodeHash,
  encodeAuto,
  decodeHash,
  MAX_INPUT,
  MAX_LINK_INPUT,
  analyze,
  checkPrediction,
  summary,
  safeCounts,
  escapeCompact,
} from "./model.mjs";

const MAX_TOKENS_SHOWN = 300;
const MAX_SEGMENTS_SHOWN = 400;
const MAX_CHARS = 120; // per token or segment
const MAX_OUTPUT_CHARS = 20000; // per output view

function h(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
}

function shown(bytes, start, end, cap = MAX_CHARS) {
  const r = escapeCompact(bytes, start, end, cap);
  return r.truncated ? `${r.text}... (${end - start} bytes)` : r.text;
}

const VERDICT_TEXT = { drop: "dropped", replace: "replaced", pending: "waiting", shown: "made visible", pass: "kept", text: "kept" };

export function mount(el, ctx) {
  const id = (s) => `${ctx.id}-${s}`;
  // Text for screen readers only: del, ins and strike-through are not announced by default.
  const vh = (text) => h("span", { class: "af__vh", text });
  // A footnote link to rule n. It moves focus to the rule without touching location.hash,
  // which holds the share state.
  const ruleLink = (n) => {
    const a = h("a", { href: `#${id(`rule-${n}`)}`, class: "af__ref", text: `[${n}]` });
    a.addEventListener("click", (e) => {
      if (e.preventDefault) e.preventDefault();
      const target = typeof document.getElementById === "function" ? document.getElementById(id(`rule-${n}`)) : null;
      if (target) target.focus();
    });
    return a;
  };
  const fromHash = decodeHash(ctx.hash.get());
  let state = fromHash || initialState();
  // Text that came in the link (not a preset). While the input is still exactly that text it is
  // held to MAX_LINK_INPUT: the link was analysed on load, with nobody asking.
  const linkText = fromHash && !fromHash.preset ? fromHash.text : null;
  // The one `t:` share string the reader has asked for: the link they opened, or the last
  // "Copy link". Text typed or pasted since then is never put in the address by itself.
  let asked = linkText === null ? null : encodeHash(fromHash);
  let result = null;
  let announceTimer = null;
  let lastAnnounce = 0;

  const root = h("div", { class: "af" + (ctx.reducedMotion ? " af--still" : "") });
  el.append(root);

  // ---- Controls ---------------------------------------------------------------------------------
  const controls = h("div", { class: "af__controls" });
  const lead = h("p", { class: "af__lead", text: "The guest is untrusted, and your terminal obeys the bytes it prints: a guest could change your window title, write your clipboard or make the terminal type for you. So macvmm filters everything the guest prints before it reaches your terminal." });
  if (ctx.standalone && ctx.base) {
    try {
      const primer = new URL("../../../primers/tty-termios/", ctx.base);
      lead.append(" New to terminals and escape sequences? Read the ", h("a", { href: primer.pathname, text: "TTYs, termios and escape sequences primer" }), " first.");
    } catch {
      /* no link without a base URL */
    }
  }
  controls.append(lead);
  const presetSel = h("select", { id: id("preset") });
  presetSel.append(h("option", { value: "", text: "Your own input" }));
  for (const p of PRESETS) presetSel.append(h("option", { value: p.id, text: p.label }));
  const presetNote = h("p", { class: "af__hint", id: id("pnote") });

  const input = h("textarea", {
    id: id("input"), rows: "3", spellcheck: "false", autocomplete: "off", autocapitalize: "off",
    "aria-describedby": `${id("help")} ${id("err")}`,
  });
  const err = h("p", { class: "af__err", id: id("err") });
  const help = h("p", { class: "af__hint", id: id("help") }, [
    "Notation: ", h("code", { text: "\\x1b" }), " is one byte in hex (", h("code", { text: "\\e" }), " and ",
    h("code", { text: "\\033" }), " also mean ESC), ", h("code", { text: "\\n \\r \\t \\a \\b \\\\" }), " as in C, ",
    h("code", { text: "\\u{9b}" }), " a character encoded as UTF-8, and ", h("code", { text: "\\x41{1000}" }),
    " the byte 0x41 a thousand times. Ctrl+Enter runs.",
  ]);
  const predict = h("input", { id: id("predict"), type: "text", spellcheck: "false", autocomplete: "off", "aria-describedby": id("pres") });
  const predictResult = h("p", { class: "af__pres", id: id("pres") });
  const runBtn = h("button", { type: "button", class: "af__btn", text: "Run" });
  const resetBtn = h("button", { type: "button", class: "af__btn af__btn--quiet", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "af__btn af__btn--quiet", text: "Copy link" });

  controls.append(
    h("div", { class: "af__row" }, [h("label", { for: id("preset"), text: "Example" }), presetSel]),
    presetNote,
    h("label", { class: "af__label", for: id("input"), text: "Bytes the guest writes" }),
    input,
    err,
    help,
    h("label", { class: "af__label", for: id("predict"), text: "Your prediction of the safe output (optional, same notation)" }),
    predict,
    h("div", { class: "af__row" }, [runBtn, resetBtn, copyBtn]),
    predictResult,
  );

  // ---- Readout and the three views --------------------------------------------------------------
  const readout = h("p", { class: "af__readout", id: id("readout") });
  const views = h("div", { class: "af__views" });
  const scroll = (label, child) => h("div", { class: "af__scroll", tabindex: "0", role: "region", "aria-label": label }, [child]);

  // What the marks mean, and the abbreviations the tokens use.
  const legend = h("div", { class: "af__legend" }, [
    h("p", { class: "af__hint" }, [
      "Marks: ", h("span", { class: "af__seq", text: "dotted underline" }), " = control sequence kept; ",
      h("span", { class: "af__drop" }, [h("del", { text: "struck through" })]), " = removed; ",
      h("span", { class: "af__repl" }, [h("ins", { text: "\u{FFFD}" })]), " = invalid UTF-8 replaced by U+FFFD; ",
      h("mark", { class: "af__shown", text: "highlighted" }), " = control made visible as text (strict).",
    ]),
    h("p", { class: "af__hint", text: "CSI: control sequence introducer (ESC [), the start of most commands. OSC: operating system command (ESC ]), a string for the terminal's host: title, clipboard, links. DCS: device control string (ESC P). C1: the 8-bit controls 0x80 to 0x9F, which some terminals obey like their ESC forms." }),
  ]);

  const tokView = h("section", { class: "af__view", "aria-labelledby": id("h-tok") });
  tokView.append(
    h("h3", { class: "af__h", id: id("h-tok"), text: "1. What a terminal would do" }),
    h("p", { class: "af__hint", text: "The bytes split the way a terminal emulator reads them, with no filter in between. A terminal that honours 8-bit controls also reads 0x9B as ESC [. A query makes the terminal answer as if you had typed the answer: macvmm passes your typing to the guest, and after macvmm exits your shell would read any answer still waiting." }),
  );
  const tokList = h("ol", { class: "af__tokens" });
  const tokMore = h("p", { class: "af__hint" });
  tokView.append(scroll("Tokens", tokList), tokMore);

  const safeView = h("section", { class: "af__view", "aria-labelledby": id("h-safe") });
  safeView.append(
    h("h3", { class: "af__h", id: id("h-safe"), text: "2. safe: what macvmm writes to your terminal (the default)" }),
    h("p", { class: "af__hint", text: "Kept bytes in the input notation; what was removed is struck through in place, with a numbered link to the rule below." }),
  );
  const safeOut = h("p", { class: "af__out af__out--escaped" });
  const safeStats = h("p", { class: "af__stats" });
  const safeRules = h("ol", { class: "af__rules" });
  const safeMore = h("p", { class: "af__hint" });
  safeView.append(scroll("safe output", safeOut), safeStats, safeRules, safeMore);

  const strictView = h("section", { class: "af__view", "aria-labelledby": id("h-strict") });
  strictView.append(
    h("h3", { class: "af__h", id: id("h-strict"), text: "3. strict: what a log file gets" }),
    h("p", { class: "af__hint", text: "Exactly the text strict writes: every control shown, none sent (ESC becomes ^[, raw 0x9B becomes \\x9b). Highlighted parts are controls made visible." }),
  );
  const strictOut = h("pre", { class: "af__out af__out--strict" });
  const strictStats = h("p", { class: "af__stats" });
  const strictRules = h("ul", { class: "af__rules af__rules--strict", "aria-label": "Why each control was made visible" });
  strictView.append(scroll("strict output", strictOut), strictStats, strictRules);

  const idle = h("p", { class: "af__idle", text: "Predict what safe keeps, then press Run." });
  views.append(idle, legend, tokView, safeView, strictView);
  root.append(controls, readout, views);

  // ---- Rendering --------------------------------------------------------------------------------
  function announce(text, shownText = text) {
    readout.textContent = shownText;
    const now = Date.now();
    clearTimeout(announceTimer);
    const wait = Math.max(0, 300 - (now - lastAnnounce));
    announceTimer = setTimeout(() => {
      lastAnnounce = Date.now();
      ctx.announce(text);
    }, wait);
  }

  function renderControls() {
    if (input.value !== state.text) input.value = state.text;
    presetSel.value = state.preset && presetById(state.preset)?.text === state.text ? state.preset : "";
    const p = presetById(presetSel.value);
    presetNote.textContent = p ? p.note : "Type or paste bytes, or pick an example.";
    if (predict.value !== state.prediction) predict.value = state.prediction;
  }

  function renderTokens(a) {
    tokList.replaceChildren();
    for (const t of a.tokens.slice(0, MAX_TOKENS_SHOWN)) {
      const li = h("li", { class: `af__tok af__tok--${t.effect}` });
      const head = h("div", { class: "af__tokhead" });
      head.append(h("code", { class: "af__bytes", text: shown(a.bytes, t.start, t.end) }));
      if (t.kind !== "text") head.append(h("span", { class: "af__toklabel", text: t.label }));
      head.append(h("span", { class: `af__effect af__effect--${t.effect}`, text: EFFECTS[t.effect] || t.effect }));
      li.append(head);
      if (t.parts && t.parts.final !== undefined) {
        const parts = h("p", { class: "af__parts" });
        const part = (name, v) => h("span", { class: "af__part" }, [h("span", { class: "af__pname", text: name }), h("code", { text: v === "" ? "(none)" : v })]);
        parts.append(part("introducer", t.parts.intro), part("parameters", t.parts.params), part("intermediates", t.parts.inter), part("final", t.parts.final || "(missing)"));
        li.append(parts);
      }
      if (t.kind !== "text") li.append(h("p", { class: "af__meaning", text: t.meaning }));
      if (t.executed) {
        const sub = h("ul", { class: "af__exec", "aria-label": "Controls run in the middle of this sequence" });
        for (const x of t.executed) {
          sub.append(h("li", {}, [h("code", { text: shown(a.bytes, x.start, x.end) }), " ", h("span", { class: "af__toklabel", text: x.label }), `: ${x.meaning}`]));
        }
        li.append(sub);
      }
      tokList.append(li);
    }
    const more = a.tokens.length - MAX_TOKENS_SHOWN + a.tokensOmitted;
    tokMore.textContent = more > 0 ? `...and ${more} more tokens.` : "";
  }

  function renderSafe(a) {
    const r = a.safe;
    safeOut.replaceChildren();
    safeRules.replaceChildren();
    let chars = 0;
    let shownSegs = 0;
    let ruleCount = 0;
    for (const s of r.segments) {
      if (chars > MAX_OUTPUT_CHARS || shownSegs >= MAX_SEGMENTS_SHOWN) break;
      shownSegs += 1;
      if (s.verdict === "text" || s.verdict === "pass") {
        const t = shown(r.out, s.outStart, s.outEnd, MAX_OUTPUT_CHARS - chars + 1);
        chars += t.length;
        safeOut.append(h("span", { class: s.verdict === "pass" ? "af__seq" : "", text: t }));
        continue;
      }
      ruleCount += 1;
      const n = ruleCount;
      const inBytes = shown(a.bytes, s.start, s.end);
      chars += inBytes.length;
      const ref = h("sup", {}, [ruleLink(n)]);
      if (s.verdict === "replace") {
        safeOut.append(h("span", { class: "af__repl" }, [
          vh(" replaced: "), h("del", { text: inBytes }), vh(" with U+FFFD: "), h("ins", { text: "\u{FFFD}" }), ref, vh(" end replaced. "),
        ]));
      } else {
        const what = s.verdict === "pending" ? "waiting, not written yet" : "removed";
        safeOut.append(h("span", { class: `af__drop af__drop--${s.verdict}` }, [vh(` ${what}: `), h("del", { text: inBytes }), ref, vh(` end ${what}. `)]));
      }
      safeRules.append(h("li", { value: String(n), id: id(`rule-${n}`), tabindex: "-1", class: `af__rule af__rule--${s.verdict}` }, [
        h("span", { class: "af__vtag", text: VERDICT_TEXT[s.verdict] }),
        " ",
        h("code", { text: inBytes }),
        `: ${s.rule}.`,
      ]));
    }
    if (shownSegs < r.segments.length || r.segmentsOmitted || chars > MAX_OUTPUT_CHARS) {
      safeMore.textContent = "The output is longer than this view shows; the counts below cover all of it.";
    } else {
      safeMore.textContent = "";
    }
    if (r.out.length === 0) safeOut.append(h("span", { class: "af__empty", text: " (nothing reaches the terminal)" }));
    const c = safeCounts(a);
    const or = c.more ? " or more" : "";
    safeStats.textContent =
      `${r.out.length} bytes written, ${a.bytes.length} read: ${c.removed}${or} piece${c.removed === 1 && !c.more ? "" : "s"} removed, ` +
      `${c.replaced}${or} replaced by U+FFFD. The filter's dropped counter, roughly the number of bytes removed: ${r.dropped} ` +
      "(macvmm prints it as serial_filtered in its stats line)." + (r.pending ? ` At the end, ${r.pending}.` : "");
  }

  function renderStrict(a) {
    const r = a.strict;
    strictOut.replaceChildren();
    let chars = 0;
    let n = 0;
    const dec = new TextDecoder();
    for (const s of r.segments) {
      if (chars > MAX_OUTPUT_CHARS || n >= MAX_SEGMENTS_SHOWN * 4) break;
      n += 1;
      const end = Math.min(s.outEnd, s.outStart + (MAX_OUTPUT_CHARS - chars) + 1);
      const t = dec.decode(r.out.subarray(s.outStart, end)) + (end < s.outEnd ? `... (${s.outEnd - s.outStart} bytes)` : "");
      chars += t.length;
      if (s.verdict === "shown") strictOut.append(h("mark", { class: "af__shown" }, [vh(" control: "), t]));
      else if (s.verdict === "pending") strictOut.append(h("span", { class: "af__drop af__drop--pending", text: `(waiting: ${shown(a.bytes, s.start, s.end)})` }));
      else strictOut.append(t);
    }
    // One line per distinct reason, with how often it applied.
    const reasons = new Map();
    for (const s of r.segments) if (s.verdict === "shown" || s.verdict === "pending") reasons.set(s.rule, (reasons.get(s.rule) || 0) + 1);
    strictRules.replaceChildren();
    for (const [rule, times] of [...reasons].slice(0, 40)) {
      strictRules.append(h("li", { class: "af__rule" }, [`${rule}${times > 1 ? ` (${times} times)` : ""}.`]));
    }
    const shownCount = r.segments.filter((s) => s.verdict === "shown").length;
    strictStats.textContent = `${r.out.length} bytes written. ${shownCount}${r.segmentsOmitted ? " or more" : ""} control${shownCount === 1 ? "" : "s"} or invalid bytes made visible; the dropped counter is ${r.dropped}.`;
  }

  /** Shows the verdict on the reader's prediction; returns a short spoken form ("" if none). */
  function renderPrediction(a) {
    if (!state.ran || !a || !a.ok || state.prediction.trim() === "") {
      predictResult.textContent = "";
      predictResult.className = "af__pres";
      return "";
    }
    const c = checkPrediction(state.prediction, a.safe.out);
    if (!c.ok) {
      predictResult.textContent = `Your prediction could not be read: ${c.error}.`;
      predictResult.className = "af__pres af__pres--bad";
      return `Prediction could not be read: ${c.error}.`;
    }
    if (c.match) {
      predictResult.textContent = "Your prediction matches the safe output exactly.";
      predictResult.className = "af__pres af__pres--ok";
      return "Prediction correct.";
    }
    const out = shown(a.safe.out, 0, a.safe.out.length, 300);
    predictResult.textContent = `Your prediction differs. The safe policy wrote: ${out}`;
    predictResult.className = "af__pres af__pres--bad";
    return `Prediction differs. The safe policy wrote: ${out}.`;
  }

  function render() {
    renderControls();
    err.textContent = "";
    input.removeAttribute("aria-invalid");
    if (!state.ran) {
      idle.hidden = false;
      tokView.hidden = true;
      safeView.hidden = true;
      strictView.hidden = true;
      predictResult.textContent = "";
      strictRules.replaceChildren();
      legend.hidden = true;
      return;
    }
    const fromLink = linkText !== null && state.text === linkText;
    result = analyze(state.text, { maxTokens: MAX_TOKENS_SHOWN, maxSegments: 2000, max: fromLink ? MAX_LINK_INPUT : MAX_INPUT });
    if (!result.ok) {
      err.textContent = `Cannot read the input at character ${result.at + 1}: ${result.error}.` +
        (fromLink && result.tooLong ? ` This text came in a link, and a link's text may expand to at most ${MAX_LINK_INPUT} bytes (64 KiB); text you type here may be larger.` : "");
      input.setAttribute("aria-invalid", "true");
      idle.hidden = false;
      legend.hidden = true;
      tokView.hidden = true;
      safeView.hidden = true;
      strictView.hidden = true;
      announce(summary(result));
      renderPrediction(null);
      return;
    }
    idle.hidden = true;
    legend.hidden = false;
    tokView.hidden = false;
    safeView.hidden = false;
    strictView.hidden = false;
    renderTokens(result);
    renderSafe(result);
    renderStrict(result);
    const verdict = renderPrediction(result);
    const sum = summary(result);
    announce(verdict ? `${verdict} ${sum}` : sum, sum);
  }

  // ---- Events -----------------------------------------------------------------------------------
  function run() {
    state = { ...state, text: input.value, prediction: predict.value, ran: true };
    if (state.preset && presetById(state.preset)?.text !== state.text) state.preset = null;
    render();
    writeHash(false);
  }

  // A preset's id is reflected in the address when it is run. The reader's own text only on
  // request (`byAsking`), and it stays there only while it is still the text that was asked for.
  function writeHash(byAsking) {
    let enc = null;
    if (result && result.ok) {
      enc = encodeAuto(state);
      if (enc === null) {
        const own = encodeHash(state);
        if (byAsking) asked = own;
        enc = own !== null && own === asked ? own : null;
      }
    }
    ctx.hash.set(enc);
  }

  const onCopy = async () => {
    if (!state.ran || !result || !result.ok || input.value !== state.text) {
      announce("Press Run first: the link holds the input that was run.");
      return;
    }
    if (encodeAuto(state) === null && encodeHash(state) === null) {
      ctx.hash.set(null);
      announce("This input is too long to fit in a link.");
      return;
    }
    writeHash(true);
    const own = encodeAuto(state) === null;
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard || typeof location === "undefined") throw new Error("no clipboard");
      await navigator.clipboard.writeText(location.href);
      announce(own ? "Link copied. It holds the text you typed." : "Link copied.");
    } catch {
      announce(own ? "Copy the address from the address bar: it now holds the text you typed." : "Copy the address from the address bar: it holds this example.");
    }
  };

  const onPreset = () => {
    const p = presetById(presetSel.value);
    if (!p) return;
    state = { text: p.text, preset: p.id, prediction: "", ran: false };
    render();
    ctx.hash.set(null);
    announce(`Loaded: ${p.label}. Predict the safe output, then press Run.`);
  };
  const onInput = () => {
    if (state.ran) {
      state = { ...state, text: input.value, ran: false };
      if (state.preset && presetById(state.preset)?.text !== state.text) state.preset = null;
      render();
      ctx.hash.set(null);
      announce("Input changed: press Run.");
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (e.preventDefault) e.preventDefault();
      run();
    }
  };
  const onPredictKey = (e) => {
    if (e.key === "Enter") run();
  };
  const onReset = () => {
    state = initialState();
    predict.value = "";
    render();
    ctx.hash.set(null);
    announce("Reset to the first example.");
  };

  presetSel.addEventListener("change", onPreset);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKey);
  predict.addEventListener("keydown", onPredictKey);
  runBtn.addEventListener("click", run);
  resetBtn.addEventListener("click", onReset);
  copyBtn.addEventListener("click", onCopy);

  render();

  return {
    destroy() {
      clearTimeout(announceTimer);
    },
  };
}
