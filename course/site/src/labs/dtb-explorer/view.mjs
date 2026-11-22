// dtb-explorer view: renders the model's parse of one blob as a tree, a coloured hex dump, a
// header table and a reg/ranges table, and keeps the four in step through one selected byte offset.
//
// Input paths (all end in model.step): the sample list, a file the reader opens or drops (read with
// File.arrayBuffer, never uploaded, capped at 16 MiB), pasted hex (model.parseHexText), a one-byte
// change form, clicks and arrow keys in the tree and the hex dump.
// Security: every string from a blob reaches the page through textContent only; no innerHTML, no
// network, no storage. CSP: no inline handlers or styles; listeners are attached here.
import {
  parse,
  byteOwners,
  describe,
  regInfo,
  rangesInfo,
  headerChecks,
  toDts,
  propLine,
  parseHexText,
  sha256,
  hex,
  hexGrouped,
  sizeWords,
  initialState,
  step,
  encode,
  decode,
  bytesFor,
  changedBytes,
  loadSamples,
  summary,
  HEADER_FIELDS,
  MAX_FILE,
  MAX_PATCHES,
  FDT_MAX_SIZE,
} from "./model.mjs";
import samplesDef from "./samples.mjs";

const PAGE = 4096; // bytes of hex dump drawn at once
const NARROW = "(max-width: 30rem)"; // below this the dump draws 8 bytes a row, no ASCII column
const GROUPS = [
  ["start", "Start here"],
  ["cells", "For \u201cOne cell fewer\u201d"],
  ["blob", "After \u201cThe blob: header, structure, strings\u201d"],
  ["tests", "More trees from macvmm's tests"],
  ["corrupt", "Corrupt blobs the reader must refuse"],
];
const TREE_CAP = 3000; // tree items drawn at most
const REG_ROWS_CAP = 200; // rows of the reg/ranges table drawn at most
const REG_ENTRIES_SHOWN = 8; // entries of one reg/ranges property written out in its row
const DTS_CAP = 256 * 1024; // characters of dtc-style text put in the page
const KIND_WORDS = {
  hdr: "header field",
  rsv: "reservation map",
  tok: "token",
  field: "property length or name offset",
  name: "node name",
  val: "property value",
  pad: "padding",
  str: "strings block",
  gap: "not part of the blob's blocks",
};

/** Small element builder: h("p", {class: "x"}, "text", child, ...). Attributes are set, never parsed. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
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

/**
 * Scroll `box` (a positioned scroll container) just enough to show `item`, without moving the
 * page: scrollIntoView would also scroll the lesson, which a hash link on load must not do.
 */
function scrollWithin(box, item) {
  if (!item || typeof box.clientHeight !== "number" || typeof item.offsetTop !== "number") return;
  const top = item.offsetTop;
  const bottom = top + (item.offsetHeight || 0);
  if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
    box.scrollTop = Math.max(0, top - Math.floor(box.clientHeight / 3));
  }
  // Sideways too: at phone widths a hex row is wider than the box, and the arrow keys are ours.
  if (typeof box.clientWidth !== "number" || typeof item.offsetLeft !== "number") return;
  const left = item.offsetLeft;
  const right = left + (item.offsetWidth || 0);
  if (left < box.scrollLeft || right > box.scrollLeft + box.clientWidth) {
    box.scrollLeft = Math.max(0, left - Math.floor(box.clientWidth / 3));
  }
}

function attrUp(node, name, stop) {
  for (let n = node; n && n !== stop; n = n.parentNode || n.parent) {
    if (typeof n.getAttribute === "function") {
      const v = n.getAttribute(name);
      if (v !== null) return v;
    }
  }
  return null;
}

export function mount(el, ctx) {
  const SAMPLES = loadSamples(samplesDef);
  const pid = ctx.id;
  let state = decode(ctx.hash.get(), SAMPLES) ?? initialState();
  let bytes = null;
  let r = null;
  let owners = null;
  let changed = new Map();
  let page = 0;
  const mq = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia(NARROW) : null;
  let perRow = mq && mq.matches ? 8 : 16; // bytes per hex row
  const shaCache = new Map(); // source (sample id or custom object) -> sha256 of its unpatched bytes
  let lastDesc = null; // describe() of the current selection, for the short announcement
  let byteEls = []; // byte spans of the drawn page, index = offset - page * PAGE
  let lit = []; // elements currently highlighted
  let treeItems = []; // { el, kind: "node"|"prop", id, parent (index), group, expanded }
  let treeByNode = new Map();
  let treeByProp = new Map();

  // ---------- controls ----------
  const selId = `${pid}-sample`;
  const sampleSel = h("select", { id: selId, class: "dtx__select" });
  // Grouped by the chapter section each belongs to, so a newcomer knows when to open which.
  for (const [g, gLabel] of GROUPS) {
    const og = h("optgroup", { label: gLabel });
    for (const s of SAMPLES.filter((x) => (x.group || "tests") === g)) og.append(h("option", { value: s.id, text: s.label }));
    if (og.children.length) sampleSel.append(og);
  }
  sampleSel.append(h("option", { value: "__custom", text: "Your file or pasted bytes", disabled: true }));

  const fileId = `${pid}-file`;
  const fileIn = h("input", { id: fileId, class: "dtx__file", type: "file", accept: ".dtb,application/octet-stream", "aria-describedby": `${pid}-file-err` });
  const pasteId = `${pid}-paste`;
  const pasteBox = h("textarea", { id: pasteId, class: "dtx__paste", rows: "4", spellcheck: "false", autocomplete: "off", "aria-describedby": `${pid}-paste-err` });
  const pasteBtn = h("button", { type: "button", class: "dtx__btn", text: "Read these bytes" });
  const pasteErr = h("p", { class: "dtx__err", id: `${pid}-paste-err` });
  const paste = h(
    "details",
    { class: "dtx__more" },
    h("summary", { text: "Paste hex instead" }),
    h("label", { class: "dtx__label", for: pasteId, text: "Hex bytes, or xxd output" }),
    pasteBox,
    h("div", { class: "dtx__row" }, pasteBtn),
    pasteErr,
  );
  const fileErr = h("p", { class: "dtx__err", id: `${pid}-file-err` });
  const source = h("p", { class: "dtx__source" });
  const sourceSet = h(
    "fieldset",
    { class: "dtx__set" },
    h("legend", { text: "Blob" }),
    h("label", { class: "dtx__label", for: selId, text: "Load" }),
    sampleSel,
    h("label", { class: "dtx__label", for: fileId, text: "Or open your own .dtb (read in this browser, never uploaded)" }),
    fileIn,
    fileErr,
    paste,
    source,
  );

  const offId = `${pid}-poff`;
  const valId = `${pid}-pval`;
  const offIn = h("input", { id: offId, class: "dtx__num", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "10", "aria-describedby": `${pid}-perr` });
  const valIn = h("input", { id: valId, class: "dtx__num dtx__num--short", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "4", "aria-describedby": `${pid}-perr` });
  const patchBtn = h("button", { type: "submit", class: "dtx__btn", text: "Change" });
  const patchNow = h("p", { class: "dtx__hint" });
  const patchErr = h("p", { class: "dtx__err", id: `${pid}-perr` });
  const patchList = h("ul", { class: "dtx__patches" });
  const patchForm = h(
    "form",
    { class: "dtx__set dtx__form", novalidate: true },
    h("p", { class: "dtx__legend", text: "Change one byte" }),
    h(
      "div",
      { class: "dtx__row" },
      h("label", { class: "dtx__label", for: offId, text: "Offset (hex)" }),
      offIn,
      h("label", { class: "dtx__label", for: valId, text: "New byte (hex)" }),
      valIn,
      patchBtn,
    ),
    patchNow,
    patchErr,
    patchList,
  );

  const viewName = `${pid}-view`;
  const viewSet = h("fieldset", { class: "dtx__set dtx__views" }, h("legend", { text: "Show" }));
  const viewRadios = {};
  for (const [v, label] of [["both", "Tree and bytes"], ["tree", "Tree"], ["bytes", "Bytes"]]) {
    const id = `${pid}-view-${v}`;
    const radio = h("input", { type: "radio", name: viewName, id, value: v });
    viewRadios[v] = radio;
    viewSet.append(h("span", { class: "dtx__radio" }, radio, h("label", { for: id, text: label })));
  }
  const resetBtn = h("button", { type: "button", class: "dtx__btn dtx__btn--quiet", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "dtx__btn dtx__btn--quiet", text: "Copy link to this view" });
  const copyMsg = h("span", { class: "dtx__hint", role: "status" });
  const controls = h("div", { class: "dtx__controls" }, sourceSet, patchForm, viewSet, h("div", { class: "dtx__row" }, resetBtn, copyBtn, copyMsg));

  // ---------- verdict ----------
  const verdict = h("div", { class: "dtx__verdict" });

  // ---------- tree ----------
  const treeHelp = `${pid}-treehelp`;
  const tree = h("ul", { class: "dtx__tree", role: "tree", "aria-label": "Device tree nodes and properties", "aria-describedby": treeHelp });
  const treeScroll = h("div", { class: "dtx__scroll dtx__scroll--tree" }, tree);
  const treePane = h(
    "section",
    { class: "dtx__pane dtx__pane--tree", "aria-labelledby": `${pid}-tree-h` },
    h("h3", { class: "dtx__h", id: `${pid}-tree-h`, text: "Tree" }),
    h("p", { class: "dtx__hint", id: treeHelp, text: "Up and Down move, Right opens a node, Left closes it or goes to its parent. The bytes follow." }),
    treeScroll,
  );

  // ---------- hex ----------
  const hexHelp = `${pid}-hexhelp`;
  // A listbox (screen readers switch to focus mode for it, so the arrow keys reach us); the
  // selected byte is its active descendant and carries a spoken label.
  const hexBox = h("div", { class: "dtx__hex", tabindex: "0", role: "listbox", "aria-label": "Blob bytes in hex", "aria-roledescription": "hex dump", "aria-describedby": hexHelp });
  // The pager's buttons are built once, so a click never destroys the focused button.
  const prevBtn = h("button", { type: "button", class: "dtx__btn dtx__btn--small", "data-page": "-1", text: "Previous 4 KiB" });
  const nextBtn = h("button", { type: "button", class: "dtx__btn dtx__btn--small", "data-page": "1", text: "Next 4 KiB" });
  const pagerLabel = h("span", { class: "dtx__hint" });
  const pager = h("div", { class: "dtx__row dtx__pager" }, prevBtn, pagerLabel, nextBtn);
  pager.hidden = true;
  const hexScroll = h("div", { class: "dtx__scroll dtx__scroll--hex" }, hexBox);
  const legend = h("ul", { class: "dtx__legend-list", "aria-label": "Colour key" });
  for (const [k, w] of Object.entries(KIND_WORDS)) legend.append(h("li", {}, h("span", { class: `dtx__chip dtx__b--${k}`, "aria-hidden": "true", text: "00" }), ` ${w}`));
  legend.append(h("li", {}, h("span", { class: "dtx__chip dtx__b--chg", "aria-hidden": "true", text: "00" }), " wavy red underline: a byte you changed"));
  legend.append(h("li", {}, h("span", { class: "dtx__chip dtx__b is-rel", "aria-hidden": "true", text: "00" }), " solid bar under: part of what goes with the selection"));
  const hexPane = h(
    "section",
    { class: "dtx__pane dtx__pane--bytes", "aria-labelledby": `${pid}-hex-h` },
    h("h3", { class: "dtx__h", id: `${pid}-hex-h`, text: "Bytes" }),
    h("p", { class: "dtx__hint", id: hexHelp, text: "Click a byte, or focus the dump: Left and Right jump by region, Up and Down by one row. The selected region is filled; what goes with it has a solid bar under it; a byte you changed has a wavy red underline." }),
    pager,
    hexScroll,
    h("details", { class: "dtx__more" }, h("summary", { text: "Colour key" }), legend),
  );
  const panes = h("div", { class: "dtx__panes" }, treePane, hexPane);

  // ---------- details, reg, header, dts ----------
  const detTitle = h("p", { class: "dtx__dtitle" });
  const detLines = h("ul", { class: "dtx__dlines" });
  const details = h("section", { class: "dtx__card", "aria-labelledby": `${pid}-det-h` }, h("h3", { class: "dtx__h", id: `${pid}-det-h`, text: "Selected" }), detTitle, detLines);

  const regBody = h("tbody");
  const regNote = h("p", { class: "dtx__hint" });
  const regTable = h(
    "table",
    { class: "dtx__table" },
    h("caption", { text: "Each reg read with its parent's #address-cells and #size-cells; each ranges with the node's and the parent's" }),
    h("thead", {}, h("tr", {}, ...["Node", "Property", "Cells used", "Bytes", "Reads as", "Check"].map((t) => h("th", { scope: "col", text: t })))),
    regBody,
  );
  const regs = h("section", { class: "dtx__card", "aria-labelledby": `${pid}-reg-h` }, h("h3", { class: "dtx__h", id: `${pid}-reg-h`, text: "reg and ranges, interpreted" }), h("div", { class: "dtx__scroll", tabindex: "0", role: "region", "aria-label": "reg and ranges table, scrolls sideways" }, regTable), regNote);

  const hdrBody = h("tbody");
  const hdrTable = h(
    "table",
    { class: "dtx__table" },
    h("caption", { text: "The ten big-endian header fields, and the checks a careful reader makes before trusting any offset" }),
    h("thead", {}, h("tr", {}, ...["Bytes", "Field", "Value", "Check"].map((t) => h("th", { scope: "col", text: t })))),
    hdrBody,
  );
  const header = h("section", { class: "dtx__card", "aria-labelledby": `${pid}-hdr-h` }, h("h3", { class: "dtx__h", id: `${pid}-hdr-h`, text: "Header" }), h("div", { class: "dtx__scroll", tabindex: "0", role: "region", "aria-label": "Header table, scrolls sideways" }, hdrTable));

  const dtsPre = h("pre", { class: "dtx__dts" });
  const dts = h("details", { class: "dtx__more dtx__card" }, h("summary", { text: "As dtc -I dtb -O dts would print it" }), dtsPre);

  // The summary is spoken through ctx.announce only (one channel, throttled by the shell), so the
  // node itself is not a live region.
  const readout = h("p", { class: "dtx__readout", id: `${pid}-summary` });

  // ---------- try this ----------
  const tryBtn = (hashStr, text) => h("button", { type: "button", class: "dtx__btn dtx__btn--small", "data-try": hashStr, text });
  const tryList = h(
    "ol",
    { class: "dtx__try" },
    h("li", {}, tryBtn("v@348", "Select the PL011's reg"), " and count its bytes in the dump: 16, that is 2 address cells and 2 size cells of 4 bytes each."),
    h("li", {}, tryBtn("cells", "Load \u201cRoot #address-cells = 1\u201d"), " and read the reg table's Check column: memory, pl011 and pl031 no longer divide, cpu@0 still does."),
    h("li", {}, "After the chapter's section on the blob: ", tryBtn("strings-minus", "Load \u201coff_dt_strings one too low\u201d"), " and look at the property names in the tree."),
  );
  const tryBox = h("details", { class: "dtx__more dtx__card", open: true }, h("summary", { text: "Try this" }), tryList);
  if (ctx.standalone && ctx.base) {
    try {
      const chapter = new URL("../../../devices/device-tree/", ctx.base);
      tryBox.append(h("p", { class: "dtx__hint" }, "What a device tree is, and why a VMM writes one: ", h("a", { href: chapter.pathname, text: "chapter 10" }), "."));
    } catch {
      /* no link without a base URL */
    }
  }

  el.append(h("div", { class: "dtx" }, tryBox, controls, verdict, panes, details, regs, header, dts, readout));

  // ---------- helpers ----------
  const sampleOf = () => (state.custom ? null : SAMPLES.find((s) => s.id === state.sample));
  const label = () => (state.custom ? state.custom.name : sampleOf().label);

  /** `announce`: true speaks the whole summary, "short" only the selection (arrow keys), false nothing. */
  function commit(next, { announce = true } = {}) {
    const blobChanged =
      next.sample !== state.sample || next.custom !== state.custom || next.patches !== state.patches;
    const before = encode(state);
    state = next;
    const after = encode(state);
    ctx.hash.set(after);
    if (after !== before || blobChanged) copyMsg.textContent = "";
    if (blobChanged) reparse();
    renderSelection();
    renderViews();
    if (announce === "short" && lastDesc) ctx.announce(`${lastDesc.title}. ${lastDesc.lines[0] || ""}`.trim());
    else if (announce) ctx.announce(readout.textContent);
  }

  /** Show a validation error: in its paragraph, spoken, and with focus on the input to fix. */
  function showErr(node, text, input) {
    node.textContent = text;
    if (!text) return;
    ctx.announce(text);
    if (input && typeof input.focus === "function") input.focus();
  }

  function sourceSha() {
    const key = state.custom || state.sample;
    if (!shaCache.has(key)) {
      const base = bytesFor({ ...state, patches: [] }, SAMPLES);
      // Hashing is pure JS on the main thread: skip what no DTB can be (2 MiB, booting.rst).
      shaCache.set(key, base.length > FDT_MAX_SIZE ? null : sha256(base));
    }
    return shaCache.get(key);
  }

  function reparse() {
    bytes = bytesFor(state, SAMPLES);
    r = parse(bytes);
    owners = byteOwners(r);
    changed = changedBytes(state, SAMPLES);
    if (state.sel !== null && state.sel >= bytes.length) state = { ...state, sel: null };
    page = state.sel !== null ? Math.floor(state.sel / PAGE) : 0;
    renderSource();
    renderVerdict();
    renderTree();
    renderHex();
    renderRegs();
    renderHeader();
    renderPatches();
    dtsPre.textContent = r.ok ? dtsText() : "dtc-style text appears once the blob parses.";
  }

  // The whole tree as text, cut at DTS_CAP characters: a 2 MiB blob prints as several megabytes.
  function dtsText() {
    const text = toDts(r);
    return text.length > DTS_CAP ? `${text.slice(0, DTS_CAP)}\n/* ... ${text.length - DTS_CAP} more characters not shown: this box shows the first ${DTS_CAP}. */\n` : text;
  }

  function renderSource() {
    sampleSel.value = state.custom ? "__custom" : state.sample;
    source.replaceChildren();
    const s = sampleOf();
    const sha = sourceSha();
    const shaText = sha === null ? "not hashed: larger than a DTB may be (2 MiB)" : `sha256 ${sha}${state.patches.length ? " (before your changes)" : ""}`;
    source.append(
      h("span", { class: "dtx__meta", text: `${bytes.length} bytes · ${shaText}` }),
      h("br"),
      state.custom
        ? `Your bytes (${state.custom.name}). Not put in the share link.`
        : `${s.about} From ${s.source}.`,
    );
    if (s && s.dtc) {
      const q = h("ul", { class: "dtx__dtc" });
      for (const line of s.dtc) q.append(h("li", {}, h("code", { text: line })));
      source.append(h("br"), "What dtc printed in the chapter:", q);
    }
  }

  function renderVerdict() {
    verdict.replaceChildren();
    verdict.className = `dtx__verdict ${r.ok ? (r.warnings.length ? "dtx__verdict--warn" : "dtx__verdict--ok") : "dtx__verdict--bad"}`;
    if (r.ok) {
      verdict.append(h("p", { class: "dtx__vline" }, h("strong", { text: "Parsed. " }), `${r.nodes.length} nodes, ${r.props.length} properties, ${r.reservations.length} reservation${r.reservations.length === 1 ? "" : "s"}.`));
    } else {
      const at = r.error.at !== null ? ` at byte ${hex(r.error.at)}` : "";
      const go = r.error.at !== null ? h("button", { type: "button", class: "dtx__btn dtx__btn--small", "data-goto": String(r.error.at), text: "Show the byte" }) : null;
      verdict.append(
        h("p", { class: "dtx__vline" }, h("strong", { text: "Refused: " }), h("code", { text: r.error.text }), `${at}. `, go),
        h("p", { class: "dtx__hint", text: r.error.lab ? r.error.explain : `${r.error.explain} macvmm's reader refuses it with the same error.` }),
      );
    }
    if (r.warnings.length) {
      const ul = h("ul", { class: "dtx__warns", "aria-label": "Warnings" });
      const shown = r.warnings.slice(0, 12);
      for (const w of shown) ul.append(h("li", {}, h("strong", { text: "Warning: " }), w.text));
      if (r.warnings.length > shown.length) ul.append(h("li", { text: `... and ${r.warnings.length - shown.length} more.` }));
      verdict.append(ul);
    }
  }

  // ---------- tree ----------
  function renderTree() {
    tree.replaceChildren();
    treeItems = [];
    treeByNode = new Map();
    treeByProp = new Map();
    if (!r.nodes.length) {
      tree.append(h("li", { role: "none", class: "dtx__hint", text: r.ok ? "No nodes." : "No nodes were read before the parser stopped." }));
      return;
    }
    const add = (nodeId, parentIdx, container, level) => {
      if (treeItems.length >= TREE_CAP) return;
      const n = r.nodes[nodeId];
      const idx = treeItems.length;
      const group = h("ul", { role: "group", class: "dtx__group" });
      const name = n.name === "" ? "/" : n.name;
      // Named by its own row only, never by the nested group's text.
      const li = h(
        "li",
        { role: "treeitem", class: "dtx__item dtx__item--node", "aria-level": String(level), "aria-expanded": "true", "aria-selected": "false", tabindex: "-1", "data-ti": String(idx), "aria-labelledby": `${pid}-ti-${idx}` },
        h("span", { class: "dtx__iname", id: `${pid}-ti-${idx}` }, h("span", { class: "dtx__twisty", "aria-hidden": "true" }), name, n.closed ? "" : h("span", { class: "dtx__tag", text: "not closed" })),
        group,
      );
      container.append(li);
      treeItems.push({ el: li, kind: "node", id: nodeId, parent: parentIdx, group, expanded: true });
      treeByNode.set(nodeId, idx);
      for (const p of n.props) {
        if (treeItems.length >= TREE_CAP) break;
        const pi = treeItems.length;
        const prop = r.props[p];
        let text = propLine(prop);
        if (text.length > 90) text = `${text.slice(0, 87)}...`;
        const pli = h("li", { role: "treeitem", class: "dtx__item dtx__item--prop", "aria-level": String(level + 1), "aria-selected": "false", tabindex: "-1", "data-ti": String(pi), "aria-labelledby": `${pid}-ti-${pi}` }, h("span", { class: "dtx__iname", id: `${pid}-ti-${pi}` }, text));
        group.append(pli);
        treeItems.push({ el: pli, kind: "prop", id: p, parent: idx, group: null, expanded: false });
        treeByProp.set(p, pi);
      }
      for (const c of n.children) add(c, idx, group, level + 1);
    };
    for (const n of r.nodes) if (n.parent === -1) add(n.id, -1, tree, 1);
    if (treeItems.length >= TREE_CAP) tree.append(h("li", { role: "none", class: "dtx__hint", text: `Only the first ${TREE_CAP} items are shown.` }));
    treeItems[0].el.setAttribute("tabindex", "0");
  }

  function visible(i) {
    for (let p = treeItems[i].parent; p >= 0; p = treeItems[p].parent) if (!treeItems[p].expanded) return false;
    return true;
  }
  function setExpanded(i, on) {
    const t = treeItems[i];
    if (t.kind !== "node") return;
    t.expanded = on;
    t.el.setAttribute("aria-expanded", on ? "true" : "false");
    t.group.hidden = !on;
  }
  function offsetOfItem(i) {
    const t = treeItems[i];
    return t.kind === "node" ? r.nodes[t.id].begin : r.props[t.id].tok;
  }
  function focusItem(i, announce = true) {
    for (const t of treeItems) t.el.setAttribute("tabindex", "-1");
    treeItems[i].el.setAttribute("tabindex", "0");
    treeItems[i].el.focus();
    commit({ ...state, sel: offsetOfItem(i) }, { announce });
  }
  tree.addEventListener("click", (e) => {
    const ti = attrUp(e.target, "data-ti", tree);
    if (ti === null) return;
    const i = Number(ti);
    const twisty = e.target && e.target.className === "dtx__twisty";
    if (twisty) setExpanded(i, !treeItems[i].expanded);
    focusItem(i);
  });
  tree.addEventListener("keydown", (e) => {
    const ti = attrUp(e.target, "data-ti", tree);
    if (ti === null) return;
    const i = Number(ti);
    const t = treeItems[i];
    const vis = treeItems.map((_, k) => k).filter(visible);
    const at = vis.indexOf(i);
    let to = null;
    if (e.key === "ArrowDown") to = vis[Math.min(at + 1, vis.length - 1)];
    else if (e.key === "ArrowUp") to = vis[Math.max(at - 1, 0)];
    else if (e.key === "Home") to = vis[0];
    else if (e.key === "End") to = vis[vis.length - 1];
    else if (e.key === "ArrowRight") {
      if (t.kind === "node" && !t.expanded) setExpanded(i, true);
      else if (t.kind === "node" && vis[at + 1] !== undefined && treeItems[vis[at + 1]].parent === i) to = vis[at + 1];
    } else if (e.key === "ArrowLeft") {
      if (t.kind === "node" && t.expanded) setExpanded(i, false);
      else if (t.parent >= 0) to = t.parent;
    } else if (e.key === "Enter" || e.key === " ") to = i;
    else return;
    e.preventDefault();
    if (to !== null && to !== undefined) focusItem(to, "short");
  });

  // ---------- hex ----------
  function renderHex() {
    hexBox.replaceChildren();
    hexBox.removeAttribute("aria-activedescendant");
    byteEls = [];
    lit = [];
    const pages = Math.max(1, Math.ceil(bytes.length / PAGE));
    pager.hidden = pages <= 1;
    const hadFocus = document.activeElement;
    prevBtn.disabled = page === 0;
    nextBtn.disabled = page >= pages - 1;
    pagerLabel.textContent = pages > 1 ? `Bytes ${hex(page * PAGE)} to ${hex(Math.min(bytes.length, (page + 1) * PAGE) - 1)} of ${hex(bytes.length)}` : "";
    // A button that just became disabled loses focus in some browsers: hand it to its partner.
    if (hadFocus === prevBtn && prevBtn.disabled && !nextBtn.disabled) nextBtn.focus();
    if (hadFocus === nextBtn && nextBtn.disabled && !prevBtn.disabled) prevBtn.focus();
    const start = page * PAGE;
    const end = Math.min(bytes.length, start + PAGE);
    for (let row = start; row < end; row += perRow) {
      const line = h("div", { class: "dtx__line", role: "none" }, h("span", { class: "dtx__off", "aria-hidden": "true", text: row.toString(16).padStart(8, "0") }));
      let ascii = "";
      for (let o = row; o < Math.min(end, row + perRow); o++) {
        const k = owners[o];
        const kind = k >= 0 ? r.spans[k].kind : "gap";
        const cls = `dtx__b dtx__b--${kind}${changed.has(o) ? " dtx__b--chg" : ""}${(o & 3) === 3 ? " dtx__b--w" : ""}`;
        const b = h("span", { class: cls, role: "option", id: `${pid}-b-${o}`, "aria-selected": "false", "data-o": String(o), text: bytes[o].toString(16).padStart(2, "0") });
        line.append(b);
        byteEls.push(b);
        ascii += bytes[o] >= 0x20 && bytes[o] < 0x7f ? String.fromCharCode(bytes[o]) : ".";
      }
      line.append(h("span", { class: "dtx__ascii", "aria-hidden": "true", text: ascii }));
      hexBox.append(line);
    }
    if (!bytes.length) hexBox.append(h("p", { class: "dtx__hint", text: "No bytes." }));
  }
  // Paging moves the selection to the first byte of the new page, so the two never disagree.
  pager.addEventListener("click", (e) => {
    const p = attrUp(e.target, "data-page", pager);
    if (p === null || !bytes.length) return;
    const pages = Math.max(1, Math.ceil(bytes.length / PAGE));
    const to = Math.min(pages - 1, Math.max(0, page + Number(p)));
    if (to === page) return;
    commit({ ...state, sel: to * PAGE });
  });
  hexBox.addEventListener("click", (e) => {
    const o = attrUp(e.target, "data-o", hexBox);
    if (o !== null) commit({ ...state, sel: Number(o) });
  });
  hexBox.addEventListener("keydown", (e) => {
    if (!bytes.length) return;
    const cur = state.sel ?? -1;
    let to = null;
    const k = cur >= 0 ? owners[cur] : -1;
    if (e.key === "ArrowRight") to = k >= 0 ? Math.min(r.spans[k].end, bytes.length - 1) : 0;
    else if (e.key === "ArrowLeft") {
      if (k < 0) to = 0;
      else {
        const s = r.spans[k];
        to = s.start > 0 ? r.spans[owners[s.start - 1]].start : 0;
      }
    } else if (e.key === "ArrowDown") to = Math.min(bytes.length - 1, Math.max(cur, 0) + perRow);
    else if (e.key === "ArrowUp") to = Math.max(0, cur - perRow);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = bytes.length - 1;
    else return;
    e.preventDefault();
    commit({ ...state, sel: to }, { announce: "short" });
  });

  // ---------- selection ----------
  function renderSelection() {
    for (const x of lit) {
      x.classList.remove("is-sel");
      x.classList.remove("is-rel");
    }
    lit = [];
    for (const t of treeItems) t.el.setAttribute("aria-selected", "false");
    const prevActive = hexBox.getAttribute("aria-activedescendant");
    if (prevActive) {
      const old = byteEls.find((b) => b.getAttribute("id") === prevActive);
      if (old) {
        old.setAttribute("aria-selected", "false");
        old.removeAttribute("aria-label");
      }
      hexBox.removeAttribute("aria-activedescendant");
    }
    const d = state.sel !== null ? describe(r, owners, state.sel) : null;
    lastDesc = d;
    detLines.replaceChildren();
    if (!d) {
      detTitle.textContent = "Nothing selected. Click a node, a property or a byte.";
      patchNow.textContent = "";
    } else {
      const want = Math.floor(state.sel / PAGE);
      if (want !== page) {
        page = want;
        renderHex();
      }
      detTitle.replaceChildren(h("code", { text: d.title }), ` · ${KIND_WORDS[d.span.kind]}, byte ${hex(state.sel)} = ${hex(bytes[state.sel])}`);
      for (const line of d.lines) detLines.append(h("li", { text: line }));
      const ch = changed.get(state.sel);
      if (ch) detLines.append(h("li", { text: `You changed this byte from ${hex(ch.from)} to ${hex(ch.to)}.` }));
      for (const role of ["related", "primary"]) {
        for (const rg of d.ranges.filter((x) => x.role === role)) {
          for (let o = Math.max(rg.start, page * PAGE); o < Math.min(rg.end, (page + 1) * PAGE, bytes.length); o++) {
            const b = byteEls[o - page * PAGE];
            if (!b) continue;
            b.classList.add(role === "primary" ? "is-sel" : "is-rel");
            lit.push(b);
          }
        }
      }
      const active = byteEls[state.sel - page * PAGE];
      if (active) {
        active.setAttribute("aria-selected", "true");
        active.setAttribute("aria-label", `byte ${hex(state.sel)}, ${KIND_WORDS[d.span.kind]}, ${bytes[state.sel].toString(16).padStart(2, "0")}`);
        hexBox.setAttribute("aria-activedescendant", active.getAttribute("id"));
      }
      scrollWithin(hexScroll, active);
      const ti = d.prop >= 0 ? treeByProp.get(d.prop) : d.node >= 0 ? treeByNode.get(d.node) : undefined;
      if (ti !== undefined) {
        for (let p = treeItems[ti].parent; p >= 0; p = treeItems[p].parent) if (!treeItems[p].expanded) setExpanded(p, true);
        treeItems[ti].el.setAttribute("aria-selected", "true");
        for (const t of treeItems) t.el.setAttribute("tabindex", "-1");
        treeItems[ti].el.setAttribute("tabindex", "0");
        scrollWithin(treeScroll, treeItems[ti].el);
      }
      if (document.activeElement !== offIn && document.activeElement !== valIn) {
        offIn.value = state.sel.toString(16);
      }
      patchNow.textContent = `Byte ${hex(state.sel)} is ${hex(bytes[state.sel])} now.`;
    }
    readout.textContent = summary(r, d, label());
  }

  function renderViews() {
    for (const [v, radio] of Object.entries(viewRadios)) radio.checked = state.view === v;
    treePane.hidden = state.view === "bytes";
    hexPane.hidden = state.view === "tree";
    panes.className = `dtx__panes${state.view === "both" ? "" : " dtx__panes--one"}`;
  }

  // ---------- reg / header tables ----------
  function renderRegs() {
    regBody.replaceChildren();
    let rows = 0;
    let hiddenRows = 0;
    // The first `REG_ENTRIES_SHOWN` entries of a property, then how many were left out.
    const listed = (list, one) => {
      const text = list.slice(0, REG_ENTRIES_SHOWN).map(one).join("; ");
      return list.length > REG_ENTRIES_SHOWN ? `${text}; ... and ${list.length - REG_ENTRIES_SHOWN} more` : text;
    };
    for (const n of r.nodes) {
      const reg = regInfo(r, n.id);
      const rng = rangesInfo(r, n.id);
      for (const [what, info] of [["reg", reg], ["ranges", rng]]) {
        if (!info) continue;
        rows++;
        // A blob can hold tens of thousands of nodes with reg: the table stops at REG_ROWS_CAP.
        if (rows > REG_ROWS_CAP) {
          hiddenRows++;
          continue;
        }
        const prop = r.props[info.prop];
        let used;
        let reads;
        if (what === "reg") {
          // Each count marked on its own: the half-specified case is the one the defaults rule is about.
          const mark = (from, bad) => (bad ? " (not one cell; default used)" : from === "default" ? " (default)" : "");
          used = `${info.ac} address${mark(info.acFrom, info.acBad)}, ${info.sc} size${mark(info.scFrom, info.scBad)}`;
          const list = info.entries.length ? info.entries : info.loose ? [info.loose] : [];
          reads = listed(list, (e) => (info.sc === 0 ? `${hexGrouped(e.addr)}` : `${hexGrouped(e.addr)} + ${hexGrouped(e.size)} (${sizeWords(e.size)})`));
          if (!info.entries.length && info.loose) reads = `if read anyway: ${reads}`;
        } else {
          used = `child ${info.widths[0]}, parent ${info.widths[1]}, size ${info.widths[2]}`;
          reads = info.identity ? "1:1 (empty ranges)" : listed(info.entries, (e) => `${hexGrouped(e.child)} -> ${hexGrouped(e.parent)} + ${hexGrouped(e.size)}`);
        }
        const unitBad = what === "reg" && info.unit && info.unit.matches === false;
        const ok = info.ok && !unitBad;
        const check = ok ? "ok" : !info.ok ? info.message : `unit address @${info.unit.name} does not match`;
        regBody.append(
          h(
            "tr",
            { class: ok ? "dtx__pass" : "dtx__fail" },
            h("th", { scope: "row" }, h("button", { type: "button", class: "dtx__link", "data-goto": String(prop.tok), text: n.path })),
            h("td", {}, h("code", { text: what })),
            h("td", { text: used }),
            h("td", { text: String(prop.len) }),
            h("td", { class: "dtx__mono", text: reads || "nothing" }),
            h("td", {}, h("span", { class: "dtx__badge", text: ok ? "ok" : "check" }), " ", ok ? "" : check),
          ),
        );
      }
    }
    if (hiddenRows) {
      regBody.append(h("tr", {}, h("td", { colspan: "6", class: "dtx__hint", text: `Only the first ${REG_ROWS_CAP} rows are shown: ${hiddenRows} more reg or ranges properties are not listed.` })));
    }
    regNote.replaceChildren();
    const rule = "#address-cells and #size-cells belong to the parent: they say how its direct children write addresses, and no deeper.";
    if (!rows) {
      regNote.textContent = r.ok ? "No node in this tree has reg or ranges." : "Nothing to interpret: the blob was refused.";
    } else if (!state.custom && state.sample === "v" && !state.patches.length) {
      regNote.append(
        `${rule} Byte 0x87 is the root's #address-cells. Change it from 02 to 01 and every reg directly under the root (memory, pl011, pl031) is misread; cpu@0 is unchanged because /cpus sets its own counts. `,
        h("button", { type: "button", class: "dtx__btn dtx__btn--small", "data-try": "v+87=1@87", text: "Make that change" }),
      );
    } else if (!state.custom && state.sample === "cells" && !state.patches.length) {
      regNote.textContent = `${rule} This sample already made that change: compare the Check column with the chapter's tree.`;
    } else {
      regNote.textContent = rule;
    }
  }

  function renderHeader() {
    hdrBody.replaceChildren();
    if (!r.header) {
      hdrBody.append(h("tr", {}, h("td", { colspan: "4", text: `Fewer than 40 bytes (${bytes.length}): no header to read.` })));
      return;
    }
    const checks = new Map(headerChecks(r).map((c) => [c.field, c]));
    HEADER_FIELDS.forEach((f, i) => {
      const c = checks.get(f.key);
      const v = r.header[f.key];
      hdrBody.append(
        h(
          "tr",
          { class: c && !c.pass ? "dtx__fail" : "" },
          h("td", { class: "dtx__mono", text: `${i * 4} to ${i * 4 + 3}` }),
          h("th", { scope: "row" }, h("button", { type: "button", class: "dtx__link", "data-goto": String(i * 4), text: f.key })),
          h("td", { class: "dtx__mono", text: `${hex(v)}${f.key.includes("version") ? ` = ${v}` : ""}` }),
          h("td", {}, c ? h("span", { class: "dtx__badge", text: c.pass ? "ok" : "fails" }) : "", c ? ` ${c.why}` : ` ${f.what}`),
        ),
      );
    });
  }

  function renderPatches() {
    patchList.replaceChildren();
    const s = sampleOf();
    for (const [o, v] of (s && s.patches) || []) {
      const from = s.bytes[o];
      patchList.append(h("li", { text: `This sample changes byte ${hex(o)}: ${hex(from)} to ${hex(v)}.` }));
    }
    for (const [o, v] of state.patches) {
      const base = state.custom ? state.custom.bytes : s.bytes;
      patchList.append(
        h(
          "li",
          {},
          `You changed byte ${hex(o)}: ${hex(base[o])} to ${hex(v)}. `,
          h("button", { type: "button", class: "dtx__btn dtx__btn--small", "data-unpatch": String(o), "aria-label": `Undo the change at ${hex(o)}`, text: "Undo" }),
        ),
      );
    }
  }

  // ---------- events ----------
  sampleSel.addEventListener("change", () => {
    if (sampleSel.value !== "__custom") commit(step(state, { type: "sample", id: sampleSel.value }, SAMPLES));
  });

  async function takeFile(f) {
    fileErr.textContent = "";
    if (!f) return;
    if (f.size > MAX_FILE) {
      showErr(fileErr, `Not read: ${f.name} is ${sizeWords(f.size)}; the lab reads at most 16 MiB (a DTB may be at most 2 MiB).`, fileIn);
      return;
    }
    ctx.announce("Reading file...");
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      commit(step(state, { type: "custom", name: String(f.name).slice(0, 120), bytes: buf }, SAMPLES));
    } catch (e) {
      showErr(fileErr, `Could not read the file: ${e && e.message ? e.message : String(e)}`, fileIn);
    }
  }
  fileIn.addEventListener("change", async () => {
    await takeFile(fileIn.files && fileIn.files[0]);
    fileIn.value = ""; // so choosing the same file again fires change again
  });
  el.addEventListener("dragover", (e) => {
    if (e.dataTransfer) e.preventDefault();
  });
  el.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    takeFile(e.dataTransfer.files[0]);
  });

  pasteBtn.addEventListener("click", () => {
    const res = parseHexText(pasteBox.value);
    if (res.error) {
      pasteBox.setAttribute("aria-invalid", "true");
      showErr(pasteErr, res.error, pasteBox);
      return;
    }
    pasteErr.textContent = "";
    pasteBox.removeAttribute("aria-invalid");
    commit(step(state, { type: "custom", name: "pasted bytes", bytes: res.bytes }, SAMPLES));
  });

  patchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const o = /^(0x)?[0-9a-f]{1,8}$/i.test(offIn.value.trim()) ? parseInt(offIn.value.trim().replace(/^0x/i, ""), 16) : NaN;
    const v = /^(0x)?[0-9a-f]{1,2}$/i.test(valIn.value.trim()) ? parseInt(valIn.value.trim().replace(/^0x/i, ""), 16) : NaN;
    offIn.removeAttribute("aria-invalid");
    valIn.removeAttribute("aria-invalid");
    if (!(o >= 0 && o < bytes.length)) {
      offIn.setAttribute("aria-invalid", "true");
      showErr(patchErr, `Not changed: the offset must be hex, from 0 to ${hex(bytes.length - 1)}.`, offIn);
      return;
    }
    if (!(v >= 0 && v <= 255)) {
      valIn.setAttribute("aria-invalid", "true");
      showErr(patchErr, "Not changed: the new byte must be one or two hex digits.", valIn);
      return;
    }
    const next = step(state, { type: "patch", offset: o, value: v }, SAMPLES);
    if (next === state) {
      showErr(patchErr, `Not changed: at most ${MAX_PATCHES} changed bytes; undo one first.`, offIn);
      return;
    }
    patchErr.textContent = "";
    commit(next);
  });
  patchList.addEventListener("click", (e) => {
    const o = attrUp(e.target, "data-unpatch", patchList);
    if (o !== null) commit(step(state, { type: "unpatch", offset: Number(o) }, SAMPLES));
  });

  for (const radio of Object.values(viewRadios)) {
    radio.addEventListener("change", () => {
      if (radio.checked) commit(step(state, { type: "view", view: radio.value }, SAMPLES), { announce: false });
    });
  }
  resetBtn.addEventListener("click", () => {
    pasteBox.value = "";
    fileIn.value = "";
    fileErr.textContent = pasteErr.textContent = patchErr.textContent = "";
    commit(step(state, { type: "reset" }, SAMPLES));
  });
  copyBtn.addEventListener("click", async () => {
    if (state.custom) {
      copyMsg.textContent = "Your own bytes are not put in links; pick a sample to share.";
      return;
    }
    try {
      await navigator.clipboard.writeText(globalThis.location.href);
      copyMsg.textContent = "Link copied.";
    } catch {
      copyMsg.textContent = "Copy the address bar: it holds this view.";
    }
  });
  for (const box of [verdict, regBody, hdrBody]) {
    box.addEventListener("click", (e) => {
      const o = attrUp(e.target, "data-goto", box);
      if (o !== null) commit({ ...state, sel: Number(o) });
    });
  }
  // "Try this" steps and the reg note's button are share strings: load exactly that view.
  for (const box of [tryList, regNote]) {
    box.addEventListener("click", (e) => {
      const t = attrUp(e.target, "data-try", box);
      if (t === null) return;
      const next = decode(t, SAMPLES);
      if (next) commit({ ...next, view: state.view });
    });
  }

  const onWidth = () => {
    const want = mq && mq.matches ? 8 : 16;
    if (want === perRow) return;
    perRow = want;
    renderHex();
    renderSelection();
  };
  if (mq && typeof mq.addEventListener === "function") mq.addEventListener("change", onWidth);

  reparse();
  renderSelection();
  renderViews();
  return {
    destroy() {
      // Every other listener is on an element inside el; the media query is the one outside.
      if (mq && typeof mq.removeEventListener === "function") mq.removeEventListener("change", onWidth);
    },
  };
}
