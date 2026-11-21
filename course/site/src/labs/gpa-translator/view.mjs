// gpa-translator: the view. Renders the model's state; turns events into model actions.
// DOM is built with createElement/textContent only (no HTML strings), and nothing outside `el`
// is touched except ctx.hash and ctx.announce.
import {
  MAX_REGIONS,
  MODES,
  TABLE_PRESETS,
  ACCESS_PRESETS,
  initialState,
  step,
  evaluate,
  encodeHash,
  decodeHash,
  place,
  hex,
  sizeText,
  hostName,
  hostExpr,
  regionErrorWhy,
  lenText,
} from "./model.mjs";

const U64_MAX = (1n << 64n) - 1n;

const MODE_INFO = {
  checked: { label: "Checked", code: "addr.checked_add(len)", note: "Overflow is a value (None) you must handle. What the reference does." },
  wrapping: { label: "Wrapping", code: "addr + len, as C does", note: "The missing 65th bit is dropped. Rust does the same with plain + when overflow checks are off (its default for release builds)." },
  panicking: { label: "Panicking", code: "addr + len, overflow checks on", note: "With overflow checks on (Rust's default in debug builds, and this repository's setting in release too), plain + panics: no leak, but the guest can crash the VMM." },
  span: { label: "Whole RAM", code: "checked_add, then one test against all of RAM", note: "No overflow and no empty access, but the range only has to fit between the lowest region base and the highest region end, not inside one region." },
};

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

// What each kind of harm is called in the results table (see harmOf in the model).
const HARM_TAG = {
  leak: { text: "leaks host memory", cls: "gpa__tag gpa__tag--bad" },
  crash: { text: "crashes the VMM", cls: "gpa__tag gpa__tag--bad" },
  contract: { text: "breaks the contract", cls: "gpa__tag gpa__tag--warn" },
};

export function mount(el, ctx) {
  const id = (s) => `${ctx.id}-${s}`;
  // Embedded, the lab's title is an h3, so its sections are h4; standalone, the page title is
  // the h1, so they are h2.
  const H = ctx.standalone ? "h2" : "h4";
  let state = decodeHash(ctx.hash.get()) || initialState();
  let announceTimer = null;
  let lastAnnounced = "";
  // Only write the share state after the reader changes something, so merely opening a page
  // does not put lab state into its URL.
  let touched = false;

  const root = h("div", { class: "gpa" + (ctx.reducedMotion ? " gpa--still" : "") });
  el.append(root);

  // ---- Controls -----------------------------------------------------------------------------
  const controls = h("div", { class: "gpa__controls" });

  // What to try, in order: the lab opens on the bug, so say so first.
  const tryList = h("ol", { class: "gpa__try" });
  for (const t of [
    "The opening puzzle is loaded with the Wrapping check. Read where the pointer lands under \u201cOur VMM's memory\u201d.",
    "Switch to Checked: checked_add reports the overflow, and the access is refused.",
    "Switch to Panicking: nothing leaks, but the guest has just crashed the VMM.",
    "Load the example \u201c8 bytes across two adjacent regions\u201d and compare Checked with Whole RAM.",
    "Load \u201cOne byte past the end\u201d, then the two \u201cZero length\u201d examples, and see how each version answers.",
    "Load a \u201cBroken\u201d table and read why it is refused.",
  ]) {
    tryList.append(h("li", { text: t }));
  }
  controls.append(h("div", { class: "gpa__tryset" }, [h(H, { class: "gpa__h", text: "Try this" }), tryList]));
  const numHint = h("p", { id: id("numhint"), class: "gpa__hint", text: "Numbers: hex (0x4000_0000), decimal, or sizes such as 64M and 16K." });

  // Region table
  const tableSet = h("fieldset", { class: "gpa__set" });
  tableSet.append(h("legend", { text: "Guest RAM: the region table" }));
  const tablePresetSel = h("select", { id: id("tpreset") });
  tablePresetSel.append(h("option", { value: "", text: "Load a table..." }));
  for (const p of TABLE_PRESETS) tablePresetSel.append(h("option", { value: p.id, text: p.label }));
  tableSet.append(h("div", { class: "gpa__row" }, [h("label", { for: id("tpreset"), text: "Table preset" }), tablePresetSel]));
  const regionList = h("div", { class: "gpa__regions" });
  tableSet.append(regionList);
  const addBtn = h("button", { type: "button", class: "gpa__btn", text: "Add region" });
  const bitsIn = h("input", { id: id("bits"), type: "text", inputmode: "numeric", autocomplete: "off", spellcheck: "false", size: "4", "aria-describedby": `${id("bits-err")} ${id("bits-hint")}` });
  const bitsErr = h("span", { id: id("bits-err"), class: "gpa__err" });
  tableSet.append(
    h("div", { class: "gpa__row" }, [addBtn]),
    h("div", { class: "gpa__row" }, [h("label", { for: id("bits"), text: "IPA width (bits)" }), bitsIn, bitsErr]),
    h("p", {
      id: id("bits-hint"),
      class: "gpa__hint",
      text: "How many bits of guest-physical address the VM can use: 36 bits (64 GiB) is HVF's default. Chapter 05 covers how to choose it.",
    }),
  );
  const tableStatus = h("p", { class: "gpa__status" });
  tableSet.append(tableStatus);
  controls.append(tableSet);

  // Access
  const accSet = h("fieldset", { class: "gpa__set" });
  accSet.append(h("legend", { text: "The guest's request" }));
  const accPresetSel = h("select", { id: id("apreset") });
  accPresetSel.append(h("option", { value: "", text: "Load an example..." }));
  for (const p of ACCESS_PRESETS) accPresetSel.append(h("option", { value: p.id, text: p.label }));
  const addrIn = h("input", { id: id("addr"), type: "text", class: "gpa__num", autocomplete: "off", spellcheck: "false", "aria-describedby": `${id("addr-err")} ${id("numhint")}` });
  const lenIn = h("input", { id: id("len"), type: "text", class: "gpa__num", autocomplete: "off", spellcheck: "false", "aria-describedby": `${id("len-err")} ${id("numhint")}` });
  const addrErr = h("span", { id: id("addr-err"), class: "gpa__err" });
  const lenErr = h("span", { id: id("len-err"), class: "gpa__err" });
  accSet.append(
    h("div", { class: "gpa__row" }, [h("label", { for: id("apreset"), text: "Example" }), accPresetSel]),
    h("div", { class: "gpa__row" }, [h("label", { for: id("addr"), text: "addr (guest-physical)" }), addrIn, addrErr]),
    h("div", { class: "gpa__row" }, [h("label", { for: id("len"), text: "len (bytes)" }), lenIn, lenErr]),
    numHint,
  );
  controls.append(accSet);

  // Mode
  const modeSet = h("fieldset", { class: "gpa__set" });
  modeSet.append(h("legend", { text: "Which version of the check the VMM runs" }));
  const modeInputs = {};
  for (const m of MODES) {
    const info = MODE_INFO[m];
    const input = h("input", { type: "radio", name: id("mode"), id: id(`mode-${m}`), value: m, "aria-describedby": id(`mode-${m}-note`) });
    modeInputs[m] = input;
    modeSet.append(
      h("div", { class: "gpa__mode" }, [
        input,
        h("label", { for: id(`mode-${m}`) }, [h("strong", { text: info.label }), " ", h("code", { text: info.code })]),
        h("p", { id: id(`mode-${m}-note`), class: "gpa__hint", text: info.note }),
      ]),
    );
  }
  controls.append(modeSet);

  const resetBtn = h("button", { type: "button", class: "gpa__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "gpa__btn", text: "Share state" });
  const shareOut = h("input", { type: "text", readonly: true, class: "gpa__share", "aria-label": "Link to this state", hidden: true });
  controls.append(h("div", { class: "gpa__row gpa__actions" }, [resetBtn, shareBtn]), shareOut);

  // ---- Visualization ------------------------------------------------------------------------
  const viz = h("div", { class: "gpa__viz" });
  const guestCap = h("p", { class: "gpa__cap", id: id("gcap") });
  const guestStrip = h("div", { class: "gpa__strip", role: "img", "aria-labelledby": id("gcap") });
  const hostCap = h("p", { class: "gpa__cap", id: id("hcap") });
  const hostStrip = h("div", { class: "gpa__strip gpa__strip--host", role: "img", "aria-labelledby": id("hcap") });
  // Wide content scrolls sideways on a phone; a focusable region lets the keyboard scroll it.
  const scroller = (label, child) => h("div", { class: "gpa__scroll", tabindex: "0", role: "region", "aria-label": label }, [child]);
  viz.append(
    h(H, { class: "gpa__h", text: "Guest-physical address space (not to scale)" }),
    scroller("Guest-physical address strip", guestStrip),
    guestCap,
    h(H, { class: "gpa__h", text: "Our VMM's memory: where the pointer lands" }),
    scroller("Host memory strip", hostStrip),
    hostCap,
  );

  // ---- Readout ------------------------------------------------------------------------------
  const out = h("div", { class: "gpa__out" });
  // Spoken through ctx.announce only (one channel), so this node is not a live region itself.
  const readout = h("p", { class: "gpa__readout" });
  const stepsHead = h(H, { class: "gpa__h" });
  const stepsList = h("ol", { class: "gpa__steps" });
  const tbl = h("table", { class: "gpa__table" });
  tbl.append(h("caption", { text: "The same request under each version of the check (host base of a region written H)" }));
  const thead = h("thead");
  const hr = h("tr");
  for (const c of ["mode", "addr", "len", "addr + len", "verdict", "host address"]) hr.append(h("th", { scope: "col", text: c }));
  thead.append(hr);
  const tbody = h("tbody");
  tbl.append(thead, tbody);
  out.append(
    h(H, { class: "gpa__h", text: "Readout" }),
    readout,
    stepsHead,
    stepsList,
    scroller("Results by version of the check", tbl),
  );

  root.append(controls, viz, out);

  // ---- Region rows --------------------------------------------------------------------------
  let regionInputs = [];
  function buildRegionRows() {
    regionList.replaceChildren();
    regionInputs = state.regions.map((r, i) => {
      const bId = id(`base${i}`);
      const sId = id(`size${i}`);
      const rowId = id(`row${i}`);
      // Named "region N base" / "region N size", so every row's inputs are told apart by ear.
      const common = { type: "text", autocomplete: "off", spellcheck: "false", "data-i": i };
      const base = h("input", { ...common, id: bId, class: "gpa__num", "data-f": "base", "aria-labelledby": `${rowId} ${bId}-l`, "aria-describedby": `${bId}-err ${id("numhint")}` });
      const size = h("input", { ...common, id: sId, class: "gpa__num gpa__num--short", "data-f": "size", "aria-labelledby": `${rowId} ${sId}-l`, "aria-describedby": `${sId}-err ${id("numhint")}` });
      const bErr = h("span", { id: `${bId}-err`, class: "gpa__err" });
      const sErr = h("span", { id: `${sId}-err`, class: "gpa__err" });
      const rm = h("button", { type: "button", class: "gpa__btn gpa__btn--small", "data-rm": i, text: "Remove", "aria-label": `Remove region ${i}` });
      rm.disabled = state.regions.length <= 1;
      base.value = r.base;
      size.value = r.size;
      regionList.append(
        h("div", { class: "gpa__region" }, [
          h("span", { id: rowId, class: "gpa__rlabel", text: `region ${i}` }),
          h("label", { id: `${bId}-l`, for: bId, text: "base" }),
          base,
          h("label", { id: `${sId}-l`, for: sId, text: "size" }),
          size,
          rm,
          bErr,
          sErr,
        ]),
      );
      return { base, size, bErr, sErr };
    });
    addBtn.disabled = state.regions.length >= MAX_REGIONS;
  }

  // ---- Render -------------------------------------------------------------------------------
  function setVal(input, v) {
    if (input.value !== v && document.activeElement !== input) input.value = v;
  }
  function setErr(input, node, msg) {
    node.textContent = msg ? msg : "";
    if (msg) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function renderStrip(strip, cells) {
    strip.replaceChildren();
    for (const c of cells) {
      const cell = h("div", { class: `gpa__seg gpa__seg--${c.kind}` });
      cell.append(h("span", { class: "gpa__seglabel", text: c.label }));
      if (c.range) cell.append(h("span", { class: "gpa__segrange", text: c.range }));
      for (const m of c.marks || []) {
        // Near an edge, anchor the label to that edge so it is not clipped by the cell.
        const edge = m.frac < 0.12 ? " gpa__mark--left" : m.frac > 0.88 ? " gpa__mark--right" : "";
        const mk = h("span", { class: `gpa__mark gpa__mark--${m.kind}${edge}`, text: m.text });
        mk.style.setProperty("--at", `${Math.min(100, Math.max(0, m.frac * 100)).toFixed(2)}%`);
        cell.append(mk);
      }
      strip.append(cell);
    }
  }

  function render() {
    const ev = evaluate(state);
    if (regionInputs.length !== state.regions.length) buildRegionRows();
    state.regions.forEach((r, i) => {
      const ri = regionInputs[i];
      setVal(ri.base, r.base);
      setVal(ri.size, r.size);
      setErr(ri.base, ri.bErr, ev.fieldErrors[`base${i}`] && `base: ${ev.fieldErrors[`base${i}`]}`);
      setErr(ri.size, ri.sErr, ev.fieldErrors[`size${i}`] && `size: ${ev.fieldErrors[`size${i}`]}`);
    });
    setVal(bitsIn, state.ipaBits);
    setVal(addrIn, state.addr);
    setVal(lenIn, state.len);
    setErr(bitsIn, bitsErr, ev.fieldErrors.ipaBits);
    setErr(addrIn, addrErr, ev.fieldErrors.addr);
    setErr(lenIn, lenErr, ev.fieldErrors.len);
    for (const m of MODES) modeInputs[m].checked = state.mode === m;

    // Table status
    let text;
    tableStatus.classList.remove("gpa__status--bad", "gpa__status--ok");
    if (!ev.table) {
      tableStatus.textContent = "Fix the highlighted fields to build the table.";
      tableStatus.classList.add("gpa__status--bad");
    } else if (!ev.table.ok) {
      tableStatus.textContent = `Table refused: ${ev.table.message}. ${regionErrorWhy(ev.table.error)}`;
      tableStatus.classList.add("gpa__status--bad");
    } else {
      const sp = ev.table.spans;
      const total = sp.reduce((t, s) => t + s.size, 0n);
      tableStatus.textContent = `Table accepted: ${sp.length} region${sp.length === 1 ? "" : "s"}, ${sizeText(total)} of RAM.`;
      tableStatus.classList.add("gpa__status--ok");
    }

    tbody.replaceChildren();
    stepsList.replaceChildren();
    if (!ev.result) {
      text = ev.table && !ev.table.ok ? `No access can be checked: ${tableStatus.textContent}` : "Enter a valid table, address and length.";
      readout.textContent = text;
      stepsHead.textContent = "Checks, in order";
      renderStrip(guestStrip, []);
      renderStrip(hostStrip, []);
      guestCap.textContent = "";
      hostCap.textContent = "";
    } else {
      const r = ev.result;
      const spans = ev.table.spans;
      text = r.summary;
      readout.textContent = text;

      // Steps for the selected mode
      stepsHead.textContent = `Checks, in order (${MODE_INFO[state.mode].label.toLowerCase()})`;
      for (const s of r[state.mode].steps) {
        const kind = s.warn ? "warn" : s.pass ? "pass" : "fail";
        const li = h("li", { class: `gpa__${kind}` });
        li.append(h("span", { class: "gpa__badge", text: s.warn ? "wrapped!" : kind }), " ", h("code", { text: s.check }), ": ", s.detail);
        stepsList.append(li);
      }

      // Rows
      for (const row of r.rows) {
        const tr = h("tr", { class: (row.mode === state.mode ? "gpa__sel " : "") + (row.harmful ? "gpa__harm" : "") });
        if (row.mode === state.mode) tr.setAttribute("aria-current", "true");
        const modeCell = h("th", { scope: "row" }, [MODE_INFO[row.mode].label]);
        if (row.mode === state.mode) modeCell.append(h("span", { class: "gpa__tag", text: "selected" }));
        tr.append(modeCell);
        for (const k of ["addr", "len", "sum"]) tr.append(h("td", {}, [h("code", { text: row[k] })]));
        const v = h("td", { text: row.verdict });
        const tag = HARM_TAG[row.harm];
        if (tag) v.append(h("span", { class: tag.cls, text: tag.text }));
        tr.append(v, h("td", {}, [h("code", { text: row.host })]));
        tbody.append(tr);
      }

      // Guest strip: where addr and addr + len fall
      const segs = r.segments;
      const a = ev.addr;
      const full = ev.addr + ev.len;
      const mode = state.mode;
      const exact = mode === "checked" || mode === "span";
      const endVal = exact ? (full > U64_MAX ? null : full) : r.wrapping.sum;
      const cells = segs.map((s) => ({
        kind: s.kind === "region" ? "region" : "gap",
        label: s.kind === "region" ? `region ${s.row}` : "no RAM",
        range: `${hex(s.from)}..${hex(s.to)}`,
        marks: [],
      }));
      const pa = place(segs, a);
      cells[pa.seg].marks.push({ kind: "start", frac: pa.frac, text: "addr" });
      if (endVal !== null && ev.len > 0n) {
        // The end is exclusive: place the last byte touched, end - 1, wrapping to the top for end 0.
        const last = (endVal - 1n) & U64_MAX;
        const pe = place(segs, last);
        const wrappedEnd = !exact && r.wrapping.wrapped;
        cells[pe.seg].marks.push({ kind: wrappedEnd ? "wrap" : "end", frac: pe.frac, text: wrappedEnd ? "end (wrapped)" : "end" });
      }
      renderStrip(guestStrip, cells);
      const endText =
        exact && endVal === null
          ? "addr + len does not fit in 64 bits"
          : `addr + len is ${hex(endVal)}${!exact && r.wrapping.wrapped ? " after wrapping" : ""}`;
      guestCap.textContent = `addr ${hex(a)} is in ${cells[pa.seg].label === "no RAM" ? "no region" : cells[pa.seg].label}; ${endText}.`;

      // Host strip: the allocation the access was resolved against, and where the pointer lands
      let idx = null;
      let delta = null;
      if (mode === "checked" && r.checked.ok) {
        idx = r.checked.index;
        delta = r.checked.offset;
      } else if (mode !== "checked" && r[mode].pass && !r[mode].panic) {
        idx = r[mode].index;
        delta = r[mode].delta;
      }
      if (idx === null) {
        renderStrip(hostStrip, [{ kind: "none", label: mode === "panicking" && r.panicking.panic ? "the VMM panicked: no pointer" : "refused: no pointer is formed", marks: [] }]);
        hostCap.textContent = "No host pointer is formed, so no host memory is touched.";
      } else {
        const span = spans[idx];
        const name = hostName(spans, idx);
        const rname = `region ${span.row}`;
        const hc = [
          { kind: "gap", label: "below", range: `below ${name}`, marks: [] },
          { kind: "region", label: `${rname}'s allocation`, range: `${name}..${hostExpr(name, span.size)}`, marks: [] },
          { kind: "gap", label: "above", range: `from ${hostExpr(name, span.size)}`, marks: [] },
        ];
        const zone = delta < 0n ? 0 : delta >= span.size ? 2 : 1;
        const frac = zone === 1 ? Number((delta * 10000n) / span.size) / 10000 : zone === 0 ? 0.8 : 0.2;
        hc[zone].marks.push({ kind: zone === 1 ? "start" : "wrap", frac, text: "pointer" });
        // Starts inside but runs past the end (a range crossing into the next region).
        const runsPast = zone === 1 && delta + ev.len > span.size;
        if (runsPast) hc[2].marks.push({ kind: "wrap", frac: 0.2, text: "end" });
        renderStrip(hostStrip, hc);
        hostCap.textContent = runsPast
          ? `The pointer ${hostExpr(name, delta)} starts inside ${rname}'s host allocation, but the ${lenText(ev.len)}-byte access runs past its end at ${hostExpr(name, span.size)}: host memory the guest must never reach.`
          : zone === 1
            ? `The pointer ${hostExpr(name, delta)} is inside ${rname}'s host allocation.`
            : `The pointer ${hostExpr(name, delta)} is outside ${rname}'s host allocation: host memory the guest must never reach.`;
      }
    }

    // Share state and announcement
    const enc = encodeHash(state);
    if (enc !== null && touched) ctx.hash.set(enc);
    shareOut.hidden = true;
    // Nothing is spoken until the reader changes something: opening the page stays quiet.
    if (!touched) {
      clearTimeout(announceTimer);
      lastAnnounced = text;
    } else if (text !== lastAnnounced) {
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        lastAnnounced = text;
        ctx.announce(text);
      }, 300);
    }
  }

  function dispatch(action) {
    touched = true;
    state = step(state, action);
    render();
  }

  // ---- Events -------------------------------------------------------------------------------
  regionList.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.f) dispatch({ type: "setRegion", index: Number(t.dataset.i), field: t.dataset.f, value: t.value });
  });
  regionList.addEventListener("click", (e) => {
    const t = e.target.closest("button[data-rm]");
    if (!t) return;
    const i = Number(t.dataset.rm);
    dispatch({ type: "removeRegion", index: i });
    const next = regionInputs[Math.min(i, regionInputs.length - 1)];
    if (next) next.base.focus();
  });
  addBtn.addEventListener("click", () => {
    dispatch({ type: "addRegion" });
    const last = regionInputs[regionInputs.length - 1];
    if (last) last.base.focus();
  });
  bitsIn.addEventListener("input", () => dispatch({ type: "setIpaBits", value: bitsIn.value }));
  addrIn.addEventListener("input", () => dispatch({ type: "setAddr", value: addrIn.value }));
  lenIn.addEventListener("input", () => dispatch({ type: "setLen", value: lenIn.value }));
  tablePresetSel.addEventListener("change", () => {
    if (tablePresetSel.value) {
      dispatch({ type: "tablePreset", id: tablePresetSel.value });
      buildRegionRows();
      render();
    }
    tablePresetSel.value = "";
  });
  accPresetSel.addEventListener("change", () => {
    if (accPresetSel.value) {
      dispatch({ type: "accessPreset", id: accPresetSel.value });
      buildRegionRows();
      render();
    }
    accPresetSel.value = "";
  });
  modeSet.addEventListener("change", (e) => {
    if (e.target.name === id("mode")) dispatch({ type: "setMode", mode: e.target.value });
  });
  resetBtn.addEventListener("click", () => {
    state = initialState();
    touched = false;
    buildRegionRows();
    render();
    ctx.hash.set(null);
  });
  shareBtn.addEventListener("click", async () => {
    const enc = encodeHash(state);
    if (enc === null) {
      ctx.announce("Fix the highlighted fields first; only a valid state can be shared.");
      return;
    }
    ctx.hash.set(enc);
    const link = String(location.href);
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(link);
        copied = true;
      }
    } catch {
      copied = false;
    }
    shareOut.value = link;
    shareOut.hidden = false;
    if (!copied) shareOut.select();
    ctx.announce(copied ? "Link copied." : "Copy the link from the box below the buttons.");
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !shareOut.hidden) {
      shareOut.hidden = true;
      shareBtn.focus();
    }
  });

  buildRegionRows();
  render();

  return {
    destroy() {
      clearTimeout(announceTimer);
    },
  };
}
