// vmapple-map: the view. Renders the model's inventory; turns clicks and typing into model
// actions. DOM is built with createElement/textContent only (no innerHTML), and nothing outside
// `el` is touched except ctx.hash. See course/site/LABS.md.
//
// Every focusable control is built once at mount and only updated afterwards, so pressing a
// row button never destroys the button that has focus. When a chip has to move to another
// column (the evidence changed), focus is put back on it.
import {
  REGIONS, REGION_IDS, RUNS, SOURCES, COLUMNS, QEMU_TAG,
  initialState, step, inventory, classify, lookup, lookupFor, parseAddr, hex, fallbackText, runLines, nextText,
  encodeHash, decodeHash, summary, announcement, region,
} from "./model.mjs";

const GLOSSARY = "/build-your-own/vmm/glossary/";
const ANNOUNCE_DELAY_MS = 400; // typing in the address box: speak once the reader pauses

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid) n.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  return n;
}
function link(anchor, text) { return h("a", { href: `${GLOSSARY}#${anchor}`, text }); }

const COLUMN_TITLE = { observed: "Observed", inferred: "Inferred", unknown: "Unknown" };
const COLUMN_MEANS = {
  observed: "someone ran it and has the output (here, the reference Mac's runs, which you repeat in sitting B)",
  inferred: "it follows from observations plus a public source you can name",
  unknown: "nobody has shown it, or the only way to show it is closed to you",
};
const MARK = { observed: "●", inferred: "◐", unknown: "○" };

function badge(entry) {
  return h("span", { class: `vm__badge vm__badge--${entry.column}` },
    h("span", { class: "vm__mark", "aria-hidden": "true", text: MARK[entry.column] }),
    ` ${entry.tag}`);
}

function irqOf(r) { return r.spi ? `SPI ${r.spi} (INTID ${32 + r.spi})` : ""; }

function sameKids(list, want) {
  const have = Array.from(list.children);
  return have.length === want.length && have.every((n, i) => n === want[i]);
}

export function mount(el, ctx) {
  const id = ctx.id || "lab-vmapple-map";
  let state;
  try {
    const shared = ctx.hash && ctx.hash.get();
    state = shared ? decodeHash(shared) : initialState();
  } catch {
    state = initialState();
  }

  const root = h("div", { class: "vm" + (ctx.reducedMotion ? " vm--still" : "") });

  // --- controls ---------------------------------------------------------------------------
  const evBoxes = {};
  const evLabels = {};
  for (const s of SOURCES) {
    const box = h("input", { type: "checkbox", id: `${id}-ev-${s.key}` });
    evBoxes[s.key] = box;
    box.addEventListener("change", () => update({ type: "toggle", key: s.key }));
    evLabels[s.key] = h("label", { class: "vm__choice", for: box.id }, box, ` ${s.label}`);
  }
  const revealBtn = h("button", { type: "button", class: "vm__btn", text: "Show the all-ones run" });
  const revealNote = h("p", { class: "vm__hint", text: "Sitting B asks you to predict this run before you see it: show it after its Predict step." });
  const evField = h("fieldset", { class: "vm__group vm__evidence" },
    h("legend", { text: "Evidence you have" }),
    h("p", { class: "vm__hint", text: "Switch a source off to see which claims rest on it." }),
    evLabels.q, evLabels.z, evLabels.o, revealNote, revealBtn);

  const addrInput = h("input", {
    type: "text", id: `${id}-addr`, class: "vm__input", inputmode: "text", autocomplete: "off",
    spellcheck: "false", maxlength: "64", placeholder: "0x0040_0000", "aria-describedby": `${id}-addr-hint`,
  });
  // A short, fixed description: the results are in addrOut (visible) and the live region, so
  // focusing the box does not read a stale result back.
  const addrHint = h("p", { class: "vm__hint", id: `${id}-addr-hint`, text: "Hex, for example 0x0040_0000. Escape clears." });
  const addrOut = h("div", { class: "vm__addrout", id: `${id}-addr-out` });
  const addrBox = h("div", { class: "vm__group" },
    h("label", { for: addrInput.id, text: "Where does an access land? (guest-physical address, hex)" }),
    addrInput, addrHint,
    h("p", { class: "vm__hint" }, "The guest-physical address is the ", link("ipa", "IPA"), " of chapter 05."),
    addrOut);

  const resetBtn = h("button", { type: "button", class: "vm__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "vm__btn", text: "Copy link to this state" });
  const controls = h("div", { class: "vm__controls" }, evField, addrBox, h("div", { class: "vm__buttons" }, resetBtn, shareBtn));

  // --- try this ---------------------------------------------------------------------------
  const tryList = h("ol", { class: "vm__try" },
    h("li", { text: "Read why cfg, already selected, sits in Observed; then press pvpanic and compare." }),
    h("li", { text: "Switch off the zero run: which rows are left resting on QEMU's sources alone?" }),
    h("li", { text: "Switch off QEMU's sources: which rows lose their names, and which become unknown?" }),
    h("li", { text: "Type 0x0900_0000 in the address box: the serial port on virt, empty space on vmapple." }),
    h("li", { text: "In sitting B, after its Predict step: show the all-ones run and check every row against what you predicted." }));

  // --- the three columns: one chip per row, built once ---------------------------------------
  const chips = {};
  const chipItems = {};
  for (const r of REGIONS) {
    const b = h("button", { type: "button", class: "vm__chip" });
    b.addEventListener("click", () => update({ type: "select", id: r.id }));
    chips[r.id] = b;
    chipItems[r.id] = h("li", {}, b);
  }
  const colLists = {};
  const colHeads = {};
  const noneItems = {};
  const columns = h("div", { class: "vm__columns" }, ...COLUMNS.map((c) => {
    colHeads[c] = h("h3", { class: "vm__h" });
    colLists[c] = h("ul", { class: "vm__collist", "aria-label": `${COLUMN_TITLE[c]} rows` });
    noneItems[c] = h("li", { class: "vm__none", text: "none" });
    return h("section", { class: `vm__col vm__col--${c}` }, colHeads[c],
      h("p", { class: "vm__means", text: COLUMN_MEANS[c] }), colLists[c]);
  }));

  // --- the inventory table: one row per region, built once; no controls inside --------------
  const caption = h("caption");
  const rowCells = {};
  const tbody = h("tbody", {}, ...REGIONS.map((r) => {
    const cells = {
      tr: h("tr", { class: "vm__tr" }),
      name: h("th", { scope: "row" }),
      base: h("td", { class: "vm__mono" }),
      size: h("td"),
      irq: h("td"),
      col: h("td"),
      seen: h("td"),
      source: h("td"),
      macvmm: h("td", { class: "vm__muted" }),
    };
    cells.tr.append(cells.name, cells.base, cells.size, cells.irq, cells.col, cells.seen, cells.source, cells.macvmm);
    rowCells[r.id] = cells;
    return cells.tr;
  }));
  const table = h("table", { class: "vm__table" }, caption,
    h("thead", {}, h("tr", {}, ...["Region", "Base", "Size", "Interrupt", "Evidence column", "Seen in the reference runs", "Source", "What macvmm does"]
      .map((t) => h("th", { scope: "col", text: t })))),
    tbody);
  const irqNote = h("p", { class: "vm__hint" },
    "Interrupt: SPI n is shared peripheral interrupt n of the ", link("gic", "GIC"), " (chapter 12), ",
    link("intid", "INTID"), " 32 + n. Accesses with no device model behind them in macvmm (unmodelled) go to the ",
    link("unknown-mmio-logger", "unknown-MMIO logger"), ".");

  // --- the selected row ---------------------------------------------------------------------
  const detHead = h("h3", { class: "vm__h vm__dethead" });
  const detWhat = h("p", { class: "vm__what" });
  const detTag = h("p", { class: "vm__dettag" });
  const detWhy = h("p", { class: "vm__why" });
  const detList = h("dl", { class: "vm__dl" });
  const detail = h("section", { class: "vm__detail", "aria-label": "The selected row" }, detHead, detWhat, detTag, detWhy, detList);

  // --- the runs (no controls inside, so rebuilding them never moves focus) -------------------
  const runBoxes = { z: h("section", { class: "vm__run" }), o: h("section", { class: "vm__run" }) };
  const runs = h("div", { class: "vm__runs" }, runBoxes.z, runBoxes.o);

  // --- plain-text table ---------------------------------------------------------------------
  const pre = h("pre", { class: "vm__pre", tabindex: "0", "aria-label": "The map as a plain-text table" });
  const plain = h("details", { class: "vm__plain" },
    h("summary", { text: "The same rows as the lesson's plain-text table (with the evidence above)" }), pre);

  const viz = h("div", { class: "vm__viz" },
    h("h3", { class: "vm__h", text: "Try this" }), tryList,
    h("p", { class: "vm__hint", text: "Each name in the three columns below is a button: press one to see why it sits in its column and what would move it. The table and the panel under it follow your choice." }),
    columns,
    h("div", { class: "vm__scroll", tabindex: "0", role: "region", "aria-label": "Memory map table, scrolls sideways" }, table),
    irqNote,
    detail,
    h("h3", { class: "vm__h", text: "The two runs, counts only" }),
    h("p", { class: "vm__hint", text: "These are the reference Mac's runs, shown in this chapter's sitting B, where you make your own. Per-access lines, values and guesses about the ROM's code are not published here." }),
    runs, plain);

  // --- readout ------------------------------------------------------------------------------
  // The full summary is plain text on the page; a short sentence goes to the live region, and
  // only once typing pauses (LABS.md section 6: no stream of announcements).
  const full = h("p", { class: "vm__summary" });
  const live = h("p", { class: "vm__sr", "aria-live": "polite", "aria-atomic": "true" });
  const readout = h("div", { class: "vm__readout" }, h("h3", { class: "vm__h", text: "Readout" }), full, live);

  // .vm is a size container: the layout follows the lab's own width (a lesson column is far
  // narrower than the window), not the viewport's (style.css).
  root.append(h("div", { class: "vm__grid" }, controls, viz, readout));
  el.replaceChildren(root);

  // --- render -------------------------------------------------------------------------------
  function dd(term, value) {
    detList.append(h("dt", { text: term }), h("dd", { text: value }));
  }

  function renderRun(k) {
    const run = RUNS[k];
    const box = runBoxes[k];
    if (k === "o" && !state.reveal) {
      box.className = "vm__run vm__run--off";
      box.replaceChildren(
        h("h4", { class: "vm__h4", text: `${run.label} (hidden)` }),
        h("p", { class: "vm__cap", text: "Sitting B asks you to predict this run before you see it. Once you have written your prediction, use Show the all-ones run in the evidence box." }));
      return;
    }
    const on = state.ev.includes(k);
    box.className = "vm__run" + (on ? "" : " vm__run--off");
    box.replaceChildren(
      h("h4", { class: "vm__h4", text: `${run.label}${on ? "" : " (switched off)"}` }),
      h("ul", { class: "vm__runlist" }, ...runLines(k).map((t) => h("li", { text: t }))),
      h("p", { class: "vm__cap", text: k === "z" ? "From the reference run in sitting B's The first probe." : "From the reference run in sitting B's Breaking it on purpose." }));
  }

  function renderColumns(inv) {
    const active = document.activeElement;
    const focusId = REGION_IDS.find((rid) => chips[rid] === active) || null;
    for (const c of COLUMNS) {
      colHeads[c].textContent = `${COLUMN_TITLE[c]} (${inv.counts[c]})`;
      const items = inv.rows.filter((x) => x.column === c);
      const want = items.length ? items.map((x) => chipItems[x.region.id]) : [noneItems[c]];
      if (!sameKids(colLists[c], want)) colLists[c].replaceChildren(...want);
    }
    for (const x of inv.rows) {
      const b = chips[x.region.id];
      const here = state.sel === x.region.id;
      if (b.textContent !== x.name) b.textContent = x.name;
      b.className = here ? "vm__chip vm__chip--sel" : "vm__chip";
      if (here) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
    if (focusId && document.activeElement !== chips[focusId]) chips[focusId].focus();
  }

  function render() {
    for (const s of SOURCES) evBoxes[s.key].checked = state.ev.includes(s.key);
    evLabels.o.hidden = !state.reveal;
    revealBtn.hidden = state.reveal;
    revealNote.hidden = state.reveal;
    if (addrInput.value !== state.addr) addrInput.value = state.addr;
    const q = state.ev.includes("q");

    const inv = inventory(state.ev);
    renderColumns(inv);

    caption.textContent = q
      ? `The vmapple board, names from QEMU's hw/vmapple/ at ${QEMU_TAG}, with what macvmm does at each row`
      : "The vmapple board with QEMU's sources switched off: the names, sizes and interrupts that come from QEMU are hidden";
    for (const x of inv.rows) {
      const r = x.region;
      const cells = rowCells[r.id];
      const here = state.sel === r.id;
      cells.tr.className = here ? "vm__tr vm__tr--sel" : "vm__tr";
      if (here) cells.tr.setAttribute("aria-current", "true");
      else cells.tr.removeAttribute("aria-current");
      cells.name.textContent = here ? `${x.name} (selected)` : x.name;
      cells.base.textContent = x.known ? hex(r.base) : "not known";
      cells.size.textContent = q ? r.sizeText : "not known";
      cells.irq.textContent = q ? irqOf(r) : "";
      cells.col.replaceChildren(badge(x));
      cells.seen.textContent = x.seen;
      cells.source.textContent = x.source;
      cells.macvmm.textContent = x.known ? r.macvmm : "not shown: macvmm's map is built from QEMU's";
    }

    const r = region(state.sel);
    const c = classify(r.id, state.ev);
    const end = r.id === "ram" ? null : r.base + (r.size ?? r.span);
    detHead.textContent = !c.known ? `${c.name}: address not known`
      : q ? `${c.name}: ${hex(r.base)}${end ? ` to ${hex(end)}` : " upward"} (${r.sizeText})`
        : `${c.name}: size not known without QEMU's sources`;
    detWhat.textContent = q ? `QEMU's board: ${r.what}.` : "QEMU's board: switched off, so no source says what is here.";
    detWhat.className = q ? "vm__what" : "vm__what vm__muted";
    detTag.replaceChildren("Evidence column: ", badge(c));
    detWhy.textContent = c.why;
    detList.replaceChildren();
    dd("Seen in the reference runs", c.seen);
    dd("Source of the row", c.source === "none" ? "none switched on" : c.source);
    if (c.known) {
      dd("What macvmm does there", r.macvmm);
      dd(`On virt, ${hex(r.base)} is`, lookup(BigInt(r.base)).virt);
    }
    if (q) dd("What would move it (a suggestion, not run)", nextText(r.id, state));

    if (!state.addr.trim()) {
      addrOut.replaceChildren(h("p", { class: "vm__hint", text: "Try 0x0040_0010 (inside cfg), 0x1003_0000 (a redistributor frame past the first), 0x4000_0000 (RAM on virt, PCI Express here) or 0x0900_0000 (virt's serial port)." }));
    } else {
      const p = parseAddr(state.addr);
      if (typeof p !== "bigint") {
        addrOut.replaceChildren(h("p", { class: "vm__error", text: `Not an address: ${p.error}` }));
      } else {
        const l = lookupFor(p, state.ev);
        addrOut.replaceChildren(h("dl", { class: "vm__dl" },
          h("dt", { text: "vmapple row" }), h("dd", { text: l.rowText }),
          h("dt", { text: "macvmm, with --unhandled-mmio log" }), h("dd", { text: l.macvmm }),
          h("dt", { text: "Same address on virt" }), h("dd", { text: l.virt })));
      }
    }

    renderRun("z");
    renderRun("o");
    pre.textContent = fallbackText(state.ev);
    full.textContent = summary(state);
  }

  let liveTimer = null;
  function speak(now, prev) {
    if (liveTimer !== null) { clearTimeout(liveTimer); liveTimer = null; }
    if (now) { live.textContent = announcement(state, prev); return; }
    liveTimer = setTimeout(() => { liveTimer = null; live.textContent = announcement(state); }, ANNOUNCE_DELAY_MS);
  }

  let lastHash;
  function update(action) {
    const prev = state;
    state = step(state, action);
    render();
    // After an evidence change, say which rows moved (announcement compares prev with state).
    speak(action.type !== "addr", action.type === "toggle" || action.type === "reveal" ? prev : null);
    const enc = encodeHash(state);
    if (enc !== lastHash) {
      lastHash = enc;
      try { ctx.hash && ctx.hash.set(enc); } catch { /* sharing is optional */ }
    }
  }

  // --- events (all inside el) -----------------------------------------------------------
  addrInput.addEventListener("input", () => update({ type: "addr", text: addrInput.value }));
  addrInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && addrInput.value) { addrInput.value = ""; update({ type: "addr", text: "" }); }
  });
  revealBtn.addEventListener("click", () => {
    update({ type: "reveal" });
    evBoxes.o.focus(); // the button is gone; the checkbox it revealed takes its place
  });
  resetBtn.addEventListener("click", () => update({ type: "reset" }));
  shareBtn.addEventListener("click", async () => {
    try { ctx.hash && ctx.hash.set(encodeHash(state)); } catch { /* ignore */ }
    let copied = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof location !== "undefined") {
        await navigator.clipboard.writeText(location.href);
        copied = true;
      }
    } catch { /* clipboard may be refused; the address bar still holds the link */ }
    live.textContent = copied ? "Link copied." : "The link to this state is in the address bar.";
  });

  render();
  return {
    destroy() {
      if (liveTimer !== null) clearTimeout(liveTimer);
      el.replaceChildren();
    },
  };
}
