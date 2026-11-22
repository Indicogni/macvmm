// repr-c-layout: the view. Renders the model's answer and turns events into model calls.
// No innerHTML anywhere: every node is built with createElement and textContent, so text the
// reader types can never become markup.
import {
  analyze,
  initialState,
  step,
  encodeShare,
  decodeShare,
  PRESETS,
  TRY_THIS,
  HEADER_TEXT,
  HEADER_FILE,
  HEADER_NOTES,
  LIMITS,
} from "./model.mjs";

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("aria-") || k === "role" || k === "for" || k === "scope" || k === "colspan" || k === "tabindex") el.setAttribute(k, String(v));
      else el[k] = v;
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return el;
}

const hex = (n) => `0x${n.toString(16).padStart(2, "0")}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const leafName = (path) => path.slice(path.lastIndexOf(".") + 1);

// A sideways-scrolling box that a keyboard can reach (tables and code at phone width).
const scroller = (label, child) => h("div", { class: "rcl__scroll", tabindex: 0, role: "region", "aria-label": label }, child);

export function mount(el, ctx) {
  const id = (s) => `${ctx.id}-${s}`;
  let state = initialState();
  const fromHash = ctx.hash && decodeShare(ctx.hash.get());
  if (fromHash) state = fromHash;

  let analysis = null;
  let editTimer = 0;
  let idleTimer = 0;
  let lastSpoken = "";
  let lastAnnounceAt = 0;
  let announceTimer = 0;

  // ctx.announce, throttled to about one call per 300 ms (LABS.md section 2).
  function announce(text) {
    if (!ctx.announce || !text) return;
    clearTimeout(announceTimer);
    const wait = Math.max(0, 300 - (Date.now() - lastAnnounceAt));
    announceTimer = setTimeout(() => {
      lastAnnounceAt = Date.now();
      lastSpoken = text;
      ctx.announce(text);
    }, wait);
  }

  // ---- controls -----------------------------------------------------------------------------
  const presetSel = h(
    "select",
    { id: id("preset") },
    h("option", { value: "", text: "(your own struct)" }),
    // Presets are numbered in teaching order; the "Try this" list below follows the numbers.
    PRESETS.map((p) => h("option", { value: p.id, text: p.label })),
  );
  const source = h("textarea", {
    id: id("source"),
    class: "rcl__source",
    rows: 16,
    spellcheck: false,
    autocomplete: "off",
    maxLength: LIMITS.maxSource,
    "aria-describedby": id("src-help"),
  });
  source.setAttribute("autocapitalize", "off");
  source.setAttribute("wrap", "off");
  const errorBox = h("p", { id: id("error"), class: "rcl__error", hidden: true });
  const compareSel = h(
    "select",
    { id: id("compare") },
    h("option", { value: "exit", text: "the header's hv_vcpu_exit_t" }),
    h("option", { value: "none", text: "nothing" }),
  );
  const viewSel = h("select", { id: id("view") });
  const viewWrap = h("div", { class: "rcl__field", hidden: true }, h("label", { for: id("view"), text: "Show struct" }), viewSel);
  const resetBtn = h("button", { type: "button", class: "rcl__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "rcl__btn", text: "Share state" });

  const tryThis = h(
    "div",
    { class: "rcl__try" },
    h("h3", { id: id("try-h"), text: "Try this" }),
    h("ol", { "aria-labelledby": id("try-h") }, TRY_THIS.map((t) => h("li", { text: t }))),
  );

  const controls = h(
    "div",
    { class: "rcl__controls" },
    tryThis,
    h(
      "div",
      { class: "rcl__field" },
      h("label", { for: id("preset"), text: "Preset" }),
      presetSel,
      h("p", { class: "rcl__help", text: "Choosing a preset keeps your own text: pick (your own struct) to get it back." }),
    ),
    h(
      "div",
      { class: "rcl__field" },
      h("label", { for: id("source"), text: "Your Rust struct" }),
      h("p", {
        id: id("src-help"),
        class: "rcl__help",
        text: "Type one or more structs (and type aliases). Primitives, core::ffi C types, raw pointers, arrays and the hv_* types are known. Target: Apple silicon (arm64 macOS).",
      }),
      source,
      errorBox,
    ),
    h("div", { class: "rcl__field" }, h("label", { for: id("compare"), text: "Compare with" }), compareSel),
    viewWrap,
    h("div", { class: "rcl__buttons" }, resetBtn, shareBtn),
  );

  // ---- output -------------------------------------------------------------------------------
  const out = h("div", { class: "rcl__out" });
  // The visible summary. It is not a live region: typing would make it talk over the reader.
  // Discrete actions, a pause in typing (when the struct parses) and leaving the box announce
  // it through ctx.announce instead.
  const readout = h("p", { class: "rcl__readout", id: id("readout") });

  // The rule the whole lab is about, said once in plain words above the byte map.
  const rules = h(
    "div",
    { class: "rcl__rules" },
    h("h3", { text: "How C lays out a struct" }),
    h("p", {
      text: "Fields go in the order written. Each field starts at the next offset that is a multiple of its alignment (for these types, its size: a u64 needs a multiple of 8). Bytes skipped to get there are padding. The struct's size is then rounded up to a multiple of its largest alignment, so an array of them stays aligned too.",
    }),
  );

  el.append(h("div", { class: "rcl" }, controls, out, h("div", { class: "rcl__readout-wrap" }, h("span", { class: "rcl__tag", text: "Readout" }), readout)));

  // ---- rendering ----------------------------------------------------------------------------
  function syncControls() {
    presetSel.value = state.preset || "";
    if (source.value !== state.source) source.value = state.source;
    compareSel.value = state.compare;
  }

  function renderByteMap(a) {
    const rows = [];
    let row = null;
    let rowStart = -1;
    let fieldNo = 0;
    const kindOf = new Map();
    for (const seg of a.bytes.segments) {
      if (seg.kind === "field" && !kindOf.has(seg.label)) kindOf.set(seg.label, fieldNo++ % 2 ? "b" : "a");
      let at = seg.offset;
      let left = seg.size;
      let first = true;
      while (left > 0) {
        const start = at - (at % 8);
        if (start !== rowStart) {
          rowStart = start;
          row = h("div", { class: "rcl__row" }, h("span", { class: "rcl__off", text: hex(start) }));
          rows.push(row);
        }
        const n = Math.min(left, 8 - (at % 8));
        const piece = h("span", {
          class: `rcl__seg ${seg.kind === "pad" ? "rcl__seg--pad" : `rcl__seg--${kindOf.get(seg.label)}`}${first ? "" : " rcl__seg--cont"}`,
          title: `${seg.label}: bytes ${seg.offset} to ${seg.offset + seg.size - 1}`,
          text: seg.kind === "pad" ? "pad" : first ? seg.label : `${leafName(seg.label)} (cont.)`,
        });
        piece.style.gridColumn = `span ${n}`;
        row.append(piece);
        at += n;
        left -= n;
        first = false;
      }
    }
    const l = a.layout;
    return h(
      "figure",
      { class: "rcl__map" },
      h("figcaption", {
        text: `Memory, 8 bytes per row: ${l.name}, ${l.size} bytes.${a.bytes.truncated ? ` First ${LIMITS.byteMapBytes} bytes shown.` : ""} The table below lists the same layout.`,
      }),
      // Decorative (aria-hidden) and not focusable: the table below carries the same facts.
      h("div", { class: "rcl__scroll" }, h("div", { class: "rcl__grid", "aria-hidden": "true" }, rows)),
    );
  }

  function renderTable(a) {
    const l = a.layout;
    // At most LIMITS.maxFields rows: the parser refuses a longer struct (second line, as below).
    const body = l.fields.slice(0, LIMITS.maxFields).map((f) =>
      h(
        "tr",
        null,
        h("th", { scope: "row", text: f.name }),
        h("td", null, h("code", { text: f.rust })),
        h("td", null, h("code", { text: f.c })),
        h("td", { class: "rcl__num", text: String(f.offset) }),
        h("td", { class: "rcl__num", text: String(f.size) }),
        h("td", { class: "rcl__num", text: String(f.effAlign) }),
        h("td", { class: "rcl__pad", text: f.padBefore ? `${f.padBefore} before: ${f.name} needs an offset that is a multiple of ${f.effAlign}` : "0" }),
      ),
    );
    if (l.tailPad) {
      body.push(
        h(
          "tr",
          { class: "rcl__padrow" },
          h("th", { scope: "row", text: "(end)" }),
          h("td", { colspan: 5, text: `size rounded up to a multiple of ${l.align}, the largest alignment` }),
          h("td", { class: "rcl__pad", text: `${l.tailPad} at the end` }),
        ),
      );
    }
    let reprNote;
    if (l.repr.kind === "Rust") reprNote = "No #[repr(C)]: Rust promises no order. This is one order it is allowed to pick (largest alignment first).";
    else if (l.repr.kind === "transparent") reprNote = "#[repr(transparent)]: the same layout as its one non-zero-sized field.";
    else reprNote = `#[repr(${l.repr.written})]: fields stay in the order written.`;
    if (l.repr.kind !== "Rust" && !l.promised) reprNote += ` But ${l.brokenBy}, inside it, has no #[repr(C)], so this layout is not promised either.`;
    const extra = l.bestSize !== null && l.bestSize < l.size ? ` Reordered by alignment, the same fields would take ${l.bestSize} bytes.` : "";
    const capId = id("layout-cap");
    return h(
      "div",
      { class: "rcl__layout" },
      h("p", { id: capId, class: "rcl__cap", text: `${l.name}: size ${l.size}, align ${l.align}, padding ${l.padding}. ${reprNote}${extra}` }),
      h(
        "div",
        { class: "rcl__scroll", tabindex: 0, role: "region", "aria-label": "Field table, scrolls sideways" },
        h(
          "table",
          { class: "rcl__table", "aria-labelledby": capId },
          h("thead", null, h("tr", null, ["Field", "Rust type", "C type", "Offset", "Size", "Align", "Padding"].map((t) => h("th", { scope: "col", text: t })))),
          h("tbody", null, body),
        ),
      ),
    );
  }

  // When more than one struct is typed, a one-line size list makes the contrast visible.
  function renderAll(a) {
    if (a.names.length < 2) return null;
    return h(
      "p",
      { class: "rcl__all" },
      h("strong", { text: "All structs: " }),
      a.names
        .map((n) => {
          const l = a.layouts.get(n);
          return `${n} ${plural(l.size, "byte")} (${l.padding} padding)`;
        })
        .join(" · "),
    );
  }

  function renderCompare(a) {
    const c = a.compare;
    const cell = (x) => (x ? `${x.path} @ ${x.offset}, ${x.size} B` : "(none)");
    const label = { ok: "Match: ", renamed: "Check: ", bad: "Differs: " };
    // The model refuses a struct with more than LIMITS.maxLeaves leaves; the cap here is a second
    // line, so that no model bug can turn one share link into an unbounded number of DOM rows.
    const hiddenRows = Math.max(0, c.rows.length - LIMITS.maxLeaves);
    const rows = c.rows.slice(0, LIMITS.maxLeaves).map((r) =>
      h(
        "tr",
        { class: `rcl__${r.status}` },
        h("td", null, h("code", { text: cell(r.header) })),
        h("td", null, h("code", { text: cell(r.yours) })),
        h("td", null, h("strong", { text: label[r.status] }), r.why, r.effect ? h("span", { class: "rcl__effect", text: ` ${r.effect}` }) : null),
      ),
    );
    let head;
    let verdict;
    if (!c.promised) {
      head = "Not promised.";
      verdict =
        c.brokenBy === a.layout.name
          ? " Without #[repr(C)], Rust may lay the fields out differently on any build, so no comparison can be trusted."
          : ` ${c.brokenBy}, inside this struct, has no #[repr(C)], so its fields may be in any order, and so may this struct's bytes.`;
    } else if (c.match && !c.renamed) {
      head = "Match.";
      verdict = " Your struct matches the header field by field: same names, offsets, sizes and kinds of value.";
    } else if (c.match) {
      head = "Match, with other names.";
      verdict = ` Same offsets, sizes and kinds of value as the header, but ${plural(c.renamed, "field")} ${c.renamed === 1 ? "has" : "have"} another name. That is fine if each holds the data the header puts there.`;
    } else {
      head = "No match.";
      verdict = ` Not the same layout as the header.${c.sizeOk ? "" : ` Size ${a.layout.size}; the header's is ${c.refSize}.`}${c.alignOk ? "" : ` Align ${a.layout.align}; the header's is ${c.refAlign}.`}`;
    }
    const ok = c.promised && c.match;
    return h(
      "section",
      { class: "rcl__cmp", "aria-labelledby": id("cmp-h") },
      h("h3", { id: id("cmp-h"), text: "Against the header" }),
      h("p", { class: ok ? "rcl__verdict rcl__verdict--ok" : "rcl__verdict rcl__verdict--bad" }, h("strong", { text: head }), verdict),
      h("p", { class: "rcl__help", text: "Fields are paired by name where the names agree, otherwise by position. Each pair is checked for offset, size and kind of value (integer, float, pointer, bool); signedness is ignored." }),
      scroller(
        "Comparison table, scrolls sideways",
        h(
          "table",
          { class: "rcl__table rcl__table--cmp", "aria-labelledby": id("cmp-h") },
          h("thead", null, h("tr", null, ["Header field", "Your field", "Result"].map((t) => h("th", { scope: "col", text: t })))),
          h("tbody", null, rows),
        ),
      ),
      hiddenRows ? h("p", { class: "rcl__help", text: `${plural(hiddenRows, "more row")} not shown: this table lists at most ${LIMITS.maxLeaves}.` }) : null,
    );
  }

  function renderCode(a) {
    return h(
      "div",
      { class: "rcl__code" },
      h("figure", null, h("figcaption", { text: "Your struct, as a C header would declare it" }), h("pre", { tabindex: 0, "aria-label": "Your struct in C, scrolls sideways" }, h("code", { text: a.c }))),
      h(
        "figure",
        null,
        h("figcaption", { text: `The header (read only): ${HEADER_FILE}, macOS 27.2 SDK, lines 61-86` }),
        h("pre", { tabindex: 0, "aria-label": "The header excerpt, scrolls sideways" }, h("code", { text: HEADER_TEXT })),
        h("ul", { class: "rcl__notes" }, HEADER_NOTES.map((n) => h("li", { text: n }))),
      ),
    );
  }

  function render() {
    syncControls();
    analysis = analyze(state.source, { compare: state.compare, view: state.view });
    const a = analysis;
    out.replaceChildren();
    if (!a.ok) {
      errorBox.hidden = false;
      errorBox.replaceChildren(h("strong", { text: "Error. " }), `Line ${a.error.line}: ${a.error.message}`);
      source.setAttribute("aria-invalid", "true");
      source.setAttribute("aria-describedby", `${id("src-help")} ${id("error")}`);
      viewWrap.hidden = true;
      out.append(h("p", { class: "rcl__empty", text: "Fix the error to see the layout. The header's struct is below for reference." }), h("div", { class: "rcl__code" }, h("figure", null, h("figcaption", { text: `The header (read only): ${HEADER_FILE}` }), h("pre", { tabindex: 0, "aria-label": "The header excerpt, scrolls sideways" }, h("code", { text: HEADER_TEXT })))));
    } else {
      errorBox.hidden = true;
      errorBox.textContent = "";
      source.removeAttribute("aria-invalid");
      source.setAttribute("aria-describedby", id("src-help"));
      viewWrap.hidden = a.names.length < 2;
      viewSel.replaceChildren(...a.names.map((n) => h("option", { value: n, text: n })));
      viewSel.value = a.root;
      out.append(rules, renderByteMap(a), renderTable(a));
      const all = renderAll(a);
      if (all) out.append(all);
      if (a.compare) out.append(renderCompare(a));
      if (a.warnings.length) {
        out.append(
          h(
            "section",
            { class: "rcl__warn", "aria-labelledby": id("warn-h") },
            h("h3", { id: id("warn-h"), text: "Warnings" }),
            h("ul", null, a.warnings.map((w) => h("li", { text: `${w.line ? `Line ${w.line}: ` : ""}${w.message}` }))),
          ),
        );
      }
      out.append(renderCode(a));
    }
    readout.textContent = summaryText();
  }

  const summaryText = () => (analysis ? (analysis.ok ? analysis.summary : `Error on line ${analysis.error.line}: ${analysis.error.message}`) : "");

  // Speak the current summary unless it was the last thing said.
  function speakSummary() {
    const t = summaryText();
    if (t && t !== lastSpoken) announce(t);
  }

  function dispatch(action) {
    state = step(state, action);
    render();
  }

  // ---- events -------------------------------------------------------------------------------
  const onPreset = () => {
    if (presetSel.value) {
      dispatch({ type: "preset", id: presetSel.value });
      const p = PRESETS.find((q) => q.id === state.preset);
      announce(`Loaded preset ${p.label}.${state.custom ? " Your own text is kept under (your own struct)." : ""} ${summaryText()}`);
    } else {
      dispatch({ type: "custom" });
      announce(`Your own struct. ${summaryText()}`);
    }
  };
  const onInput = () => {
    state = step(state, { type: "edit", source: source.value });
    presetSel.value = state.preset || "";
    clearTimeout(editTimer);
    clearTimeout(idleTimer);
    editTimer = setTimeout(() => {
      editTimer = 0;
      render();
    }, 150);
    // After a longer pause, speak the summary, but never an error while the reader is typing:
    // the error stays in the visible box, which the textarea's aria-describedby points at.
    idleTimer = setTimeout(() => {
      if (analysis && analysis.ok) speakSummary();
    }, 1500);
  };
  const onBlur = () => {
    clearTimeout(idleTimer);
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = 0;
      render();
    }
    speakSummary();
  };
  const onCompare = () => {
    dispatch({ type: "compare", value: compareSel.value });
    announce(summaryText());
  };
  const onView = () => {
    dispatch({ type: "view", name: viewSel.value });
    announce(summaryText());
  };
  const onReset = () => {
    dispatch({ type: "reset" });
    if (ctx.hash) ctx.hash.set(null);
    announce(`Lab reset to the first preset.${state.custom ? " Your own text is kept under (your own struct)." : ""}`);
  };
  const onShare = async () => {
    if (!ctx.hash) return;
    const enc = encodeShare(state);
    if (enc === null) {
      announce("This struct is too long to share as a link. Shorten it (comments count too) and try again.");
      return;
    }
    ctx.hash.set(enc);
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(location.href);
        copied = true;
      }
    } catch {
      copied = false;
    }
    announce(copied ? "Link to this state copied." : "Link to this state is now in the address bar.");
  };

  presetSel.addEventListener("change", onPreset);
  source.addEventListener("input", onInput);
  source.addEventListener("blur", onBlur);
  compareSel.addEventListener("change", onCompare);
  viewSel.addEventListener("change", onView);
  resetBtn.addEventListener("click", onReset);
  shareBtn.addEventListener("click", onShare);

  render();

  return {
    destroy() {
      clearTimeout(editTimer);
      clearTimeout(idleTimer);
      clearTimeout(announceTimer);
    },
  };
}
