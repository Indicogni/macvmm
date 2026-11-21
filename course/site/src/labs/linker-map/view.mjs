// linker-map view: renders the model's results and turns controls into model actions.
// All logic lives in model.mjs. DOM is built with createElement and textContent only (no
// innerHTML), nothing outside `el` is touched except ctx.hash and ctx.announce, and every
// element id is derived from ctx.id.
import * as M from "./model.mjs";

const KIND_LABEL = { text: "code", rodata: "constants", data: "variables", far: ".far", gap: "zeros" };

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "value" || k === "checked" || k === "disabled") node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const fmt = (v) => M.hex(v, { group: false });
const sizeText = (n) => `${M.commas(n)} B`;

export function mount(el, ctx) {
  const id = (s) => `${ctx.id}-${s}`;
  let state = M.decodeHash(ctx.hash && ctx.hash.get ? ctx.hash.get() : null);
  let result = M.link(state);
  let lastSaid = "";
  let announceTimer = null;
  let dragId = null;

  // ---- Controls -------------------------------------------------------------------------
  const presetSel = h("select", { id: id("preset") },
    Object.values(M.PRESETS).map((p) => h("option", { value: p.id, text: p.title })));
  const whereBox = h("input", { type: "checkbox", id: id("where") });
  const farBox = h("input", { type: "checkbox", id: id("far"), "aria-describedby": id("far-help") });
  const farInput = h("input", { type: "text", id: id("faraddr"), class: "lm__in", spellcheck: "false", autocomplete: "off", maxlength: "24", "aria-describedby": id("faraddr-err") });
  const startInput = h("input", { type: "text", id: id("start"), class: "lm__in", spellcheck: "false", autocomplete: "off", maxlength: "24", "aria-describedby": id("start-err") });
  const stackInput = h("input", { type: "text", id: id("stack"), class: "lm__in", spellcheck: "false", autocomplete: "off", maxlength: "24", "aria-describedby": id("stack-err") });
  const loadInput = h("input", { type: "text", id: id("load"), class: "lm__in", spellcheck: "false", autocomplete: "off", maxlength: "24", "aria-describedby": `${id("load-help")} ${id("load-err")}` });
  // Error text is announced through ctx.announce (one channel), so these are not live regions;
  // aria-describedby still reads them when the field has focus.
  const errP = (f) => h("p", { id: id(`${f}-err`), class: "lm__err" });
  const errs = { start: errP("start"), stack: errP("stack"), farAddr: errP("faraddr"), load: errP("load") };
  const stackLabel = h("label", { for: id("stack") });
  const whereRow = h("div", { class: "lm__check" }, whereBox,
    h("label", { for: id("where"), text: "Add WHERE, a static that stores GREETING's address" }));
  const orderList = h("ol", { class: "lm__order", id: id("order"), "aria-labelledby": id("order-label"), "aria-describedby": id("order-help") });
  const resetBtn = h("button", { type: "button", class: "lm__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "lm__btn", text: "Copy link to this layout" });
  const shareNote = h("span", { class: "lm__note", role: "status" });

  const controls = h("div", { class: "lm__controls" },
    h("fieldset", {},
      h("legend", { text: "Program" }),
      h("div", { class: "lm__field" }, h("label", { for: id("preset"), text: "Program" }), presetSel),
      whereRow),
    h("fieldset", {},
      h("legend", { text: "Linker script" }),
      h("div", { class: "lm__field" }, h("label", { for: id("start"), text: "Start address (. = ...)" }), startInput, errs.start),
      h("div", { class: "lm__field" }, stackLabel, stackInput, errs.stack),
      h("div", { class: "lm__check" }, farBox, h("label", { for: id("far"), text: "Add .far : { BYTE(1) } at a fixed address" })),
      h("p", { class: "lm__help", id: id("far-help"), text: "One byte placed far above the rest: watch the flat file fill the gap with zeros." }),
      h("div", { class: "lm__field" }, h("label", { for: id("faraddr"), text: ".far address" }), farInput, errs.farAddr),
      h("p", { class: "lm__h", id: id("order-label"), text: "Section order" }),
      h("p", { class: "lm__help", id: id("order-help"), text: "Use each section's Up and Down buttons (or drag it with a mouse). The linker places them top to bottom." }),
      orderList),
    h("fieldset", {},
      h("legend", { text: "Raw loader" }),
      h("div", { class: "lm__field" },
        h("label", { for: id("load") }, "Load address ", h("span", { class: "lm__mono", text: "(--raw FILE@ADDR)" })),
        loadInput,
        h("p", { class: "lm__help", id: id("load-help"), text: "Where the VMM copies the file and points the PC. Try a value different from the start address." }),
        errs.load)),
    h("details", { class: "lm__try" },
      h("summary", { text: "Try this (predict first, then look)" }),
      h("ol", {},
        h("li", { text: "Make the flat file bigger without adding any code or data." }),
        h("li", { text: "Put .rodata first. What does the CPU run as its first instruction?" }),
        h("li", { text: "Tick \u201cAdd WHERE\u201d, then change the load address. Which value is now wrong?" }),
        h("li", { text: "Pick \u201cChapter 03's hello guest\u201d. Where does the BSS start, and where does the file end?" }))),
    h("div", { class: "lm__buttons" }, resetBtn, shareBtn, shareNote));

  // ---- Views ----------------------------------------------------------------------------
  const sourcePre = h("pre", { class: "lm__pre" });
  const scriptPre = h("pre", { class: "lm__pre" });
  const nmPre = h("pre", { class: "lm__pre" });
  const phBody = h("tbody");
  const phNote = h("p", { class: "lm__help" });
  const codeSec = h("section", { class: "lm__view" });
  const codePre = h("pre", { class: "lm__pre" });
  const flatHead = h("p", { class: "lm__big" });
  const regionBody = h("tbody");
  const hexBox = h("div", { class: "lm__hex", role: "group", "aria-label": "Bytes of the flat binary, 16 per row", tabindex: "0" });
  const rawList = h("ul", { class: "lm__raw" });
  const errorBox = h("p", { class: "lm__fail", role: "alert" });
  // The visible readout. Not a live region: changes are announced once, through ctx.announce.
  const summaryP = h("p", { class: "lm__summary" });

  const table = (caption, heads, body) =>
    h("div", { class: "lm__scroll" },
      h("table", { class: "lm__table" },
        h("caption", { class: "lm__sr", text: caption }),
        h("thead", {}, h("tr", {}, heads.map((t) => h("th", { scope: "col", text: t })))),
        body));

  codeSec.append(
    h("h3", { class: "lm__h", text: "Code after linking (llvm-objdump -d)" }),
    h("p", { class: "lm__help", text: "The linker fills in the addresses: watch the adr, adrp and ldr offsets change as sections move." }),
    h("div", { class: "lm__scroll" }, codePre));

  const views = h("div", { class: "lm__views" },
    errorBox,
    h("section", { class: "lm__view lm__two" },
      h("div", {}, h("h3", { class: "lm__h", text: "The program's statics" }), h("div", { class: "lm__scroll" }, sourcePre)),
      h("div", {}, h("h3", { class: "lm__h", text: "link.ld" }), h("div", { class: "lm__scroll" }, scriptPre))),
    h("section", { class: "lm__view" },
      h("h3", { class: "lm__h", text: "Symbols (llvm-nm -n -C)" }),
      h("div", { class: "lm__scroll" }, nmPre)),
    h("section", { class: "lm__view" },
      h("h3", { class: "lm__h", text: "Program headers (llvm-readobj --program-headers)" }),
      table("PT_LOAD program headers", ["Offset", "Address", "FileSize", "MemSize", "Flags", "Sections"], phBody),
      phNote),
    codeSec,
    h("section", { class: "lm__view" },
      h("h3", { class: "lm__h", text: "Flat binary (llvm-objcopy -O binary)" }),
      flatHead,
      table("What each range of the flat binary holds", ["File offset", "Address", "Size", "What"], regionBody),
      h("p", { class: "lm__help", text: "Bytes are marked by region: code plain, constants underlined, variables boxed, .far bold with a double underline, zeros dimmed with a dot; the label column names the regions in each row." }),
      hexBox),
    h("section", { class: "lm__view" },
      h("h3", { class: "lm__h", text: "After --raw FILE@ADDR" }),
      rawList),
    summaryP);

  el.append(h("div", { class: "lm" }, controls, views));

  // ---- Rendering ------------------------------------------------------------------------
  function renderOrder(focusSel) {
    clear(orderList);
    const names = M.PRESETS[state.preset].sectionNames;
    const byId = {};
    if (result.ok) for (const s of result.sections) byId[s.id] = s;
    state.order.forEach((sid, i) => {
      const name = sid === "far" ? ".far" : names[sid];
      const sec = byId[sid];
      const up = h("button", { type: "button", class: "lm__mini", "aria-label": `Move ${name} up`, text: "Up", disabled: i === 0 });
      const down = h("button", { type: "button", class: "lm__mini", "aria-label": `Move ${name} down`, text: "Down", disabled: i === state.order.length - 1 });
      const move = (delta, key) => {
        const next = M.step(state, { type: "move", section: sid, delta });
        update(next, key, { lead: M.moveText(next, sid) });
      };
      up.addEventListener("click", () => move(-1, `${sid}-up`));
      down.addEventListener("click", () => move(1, `${sid}-down`));
      up.setAttribute("data-focus", `${sid}-up`);
      down.setAttribute("data-focus", `${sid}-down`);
      const li = h("li", { class: "lm__item", draggable: "true", "data-sec": sid },
        h("span", { class: "lm__grip", "aria-hidden": "true", text: "≡" }),
        h("span", { class: "lm__secname", text: name }),
        h("span", { class: "lm__secinfo", text: sec ? `${fmt(sec.addr)}, ${sizeText(sec.size)}${sec.nobits ? ", NOLOAD" : ""}` : "" }),
        h("span", { class: "lm__moves" }, up, down));
      li.addEventListener("dragstart", (e) => {
        dragId = sid;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", sid);
        }
      });
      li.addEventListener("dragover", (e) => {
        if (dragId) e.preventDefault();
      });
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragId && dragId !== sid) {
          const moved = dragId;
          const next = M.step(state, { type: "moveTo", section: moved, index: i });
          update(next, null, { lead: M.moveText(next, moved) });
        }
        dragId = null;
      });
      li.addEventListener("dragend", () => {
        dragId = null;
      });
      orderList.append(li);
    });
    if (focusSel) {
      // Keep keyboard focus on the moved section's button; if it is now disabled (top or
      // bottom), use its sibling so focus never falls back to the page.
      let target = findFocus(orderList, focusSel);
      if (target && target.disabled) {
        target = findFocus(orderList, focusSel.endsWith("-up") ? focusSel.replace(/-up$/, "-down") : focusSel.replace(/-down$/, "-up"));
      }
      if (target && target.focus) target.focus();
    }
  }

  function findFocus(root, key) {
    if (root.getAttribute && root.getAttribute("data-focus") === key) return root;
    for (const c of root.children || []) {
      const f = findFocus(c, key);
      if (f) return f;
    }
    return null;
  }

  function renderHex(flat) {
    clear(hexBox);
    if (flat.size === 0n) {
      hexBox.append(h("p", { class: "lm__help", text: "The file is empty." }));
      return;
    }
    for (const row of M.hexRows(flat)) {
      if (row.type === "skip") {
        hexBox.append(h("div", { class: "lm__row lm__row--skip" },
          h("span", { class: "lm__off", text: M.rawHex(row.off, 8) }),
          h("span", { text: `... ${M.commas(row.size)} bytes of zeros (${row.label}) ...` })));
        continue;
      }
      if (row.type === "opaque") {
        hexBox.append(h("div", { class: "lm__row lm__row--skip" },
          h("span", { class: "lm__off", text: M.rawHex(row.off, 8) }),
          h("span", { text: row.label })));
        continue;
      }
      if (row.type === "more") {
        hexBox.append(h("div", { class: "lm__row lm__row--skip" },
          h("span", { class: "lm__off", text: M.rawHex(row.off, 8) }),
          h("span", { text: `... ${M.commas(row.remaining)} more bytes not shown ...` })));
        continue;
      }
      const cells = [];
      const labels = [];
      row.cells.forEach((c, i) => {
        const gapCls = i % 2 === 1 ? " lm__b--pair" : "";
        if (!c) {
          cells.push(h("span", { class: `lm__b lm__b--none${gapCls}`, text: "  " }));
          return;
        }
        cells.push(h("span", { class: `lm__b lm__b--${c.kind}${gapCls}`, text: c.byte.toString(16).padStart(2, "0") }));
        const lab = c.kind === "gap" ? "zeros" : c.label;
        if (!labels.includes(lab)) labels.push(lab);
      });
      hexBox.append(h("div", { class: "lm__row" },
        h("span", { class: "lm__off", text: `${M.rawHex(row.off, 8)}:` }),
        h("span", { class: "lm__cells" }, cells),
        h("span", { class: "lm__labels", text: labels.join(", ") })));
    }
  }

  function render() {
    const p = M.PRESETS[state.preset];
    presetSel.value = state.preset;
    whereBox.checked = state.where;
    whereRow.hidden = !p.canWhere;
    farBox.checked = state.far;
    farInput.disabled = !state.far;
    stackLabel.textContent = `${p.stackLabel}, in hex (. += ...)`;
    for (const [field, input] of [["start", startInput], ["stack", stackInput], ["farAddr", farInput], ["load", loadInput]]) {
      if (!state.errors[field]) input.value = fmt(state[field]);
      errs[field].textContent = state.errors[field] || "";
      if (state.errors[field]) input.setAttribute("aria-invalid", "true");
      else input.setAttribute("aria-invalid", "false");
    }

    sourcePre.textContent = p.source(state.where).join("\n");
    scriptPre.textContent = M.scriptText(state);

    clear(phBody);
    clear(regionBody);
    clear(rawList);
    if (!result.ok) {
      errorBox.hidden = false;
      errorBox.textContent = result.error;
      nmPre.textContent = "";
      codePre.textContent = "";
      flatHead.textContent = "";
      clear(hexBox);
      phNote.textContent = "";
      summaryP.textContent = M.summary(state, result);
      return;
    }
    errorBox.hidden = true;
    errorBox.textContent = "";

    nmPre.textContent = result.symbols.map((s) => `${M.rawHex(s.addr)} ${s.letter} ${s.name}`).join("\n");

    for (const ph of result.phdrs) {
      phBody.append(h("tr", {},
        h("td", { class: "lm__mono", text: fmt(ph.offset) }),
        h("td", { class: "lm__mono", text: fmt(ph.vaddr) }),
        h("td", { class: "lm__mono", text: M.commas(ph.filesz) }),
        h("td", { class: `lm__mono${ph.memsz !== ph.filesz ? " lm__diff" : ""}`, text: M.commas(ph.memsz) + (ph.memsz !== ph.filesz ? " (more than FileSize)" : "") }),
        h("td", { class: "lm__mono", text: ph.flags.split("").map((f) => `PF_${f}`).join(" ") }),
        h("td", { text: ph.sections.join(", ") + (ph.zeroFilled.length ? ` (${ph.zeroFilled.join(", ")} costs file space here)` : "") })));
    }
    phNote.textContent = "MemSize minus FileSize is what a loader that reads ELF would zero. A flat binary keeps neither number.";

    codeSec.hidden = result.code.length === 0;
    codePre.textContent = result.code.map((c) => `${M.rawHex(c.addr, 8)}: ${c.word.toString(16).padStart(8, "0")}  ${c.text}`).join("\n")
      + result.notes.filter((n) => n.erratum).map((n) => `\n\nNote: an adrp sits at page offset 0xff8 or 0xffc and loads or stores through its register follow it. On a Cortex-A53 that sequence can use the wrong address (erratum 843419), so the linker breaks it up: ${n.text}.`).join("");

    const flat = result.flat;
    flatHead.textContent = `${p.file}: ${M.commas(flat.size)} bytes, from ${fmt(flat.start)} to ${fmt(flat.start + flat.size)}.`;
    for (const c of flat.chunks) {
      const what = c.kind === "gap" ? c.label : `${c.section}: ${c.label} (${KIND_LABEL[c.kind] || c.kind})`;
      regionBody.append(h("tr", { class: c.kind === "gap" ? "lm__gaprow" : "" },
        h("td", { class: "lm__mono", text: fmt(c.off) }),
        h("td", { class: "lm__mono", text: fmt(c.addr) }),
        h("td", { class: "lm__mono", text: M.commas(c.size) }),
        h("td", { text: what })));
    }
    for (const s of result.sections) {
      if (!s.nobits) continue;
      const inFile = s.addr >= flat.start && s.addr + s.size <= flat.start + flat.size;
      if (inFile) continue;
      regionBody.append(h("tr", { class: "lm__missing" },
        h("td", { text: "not in the file" }),
        h("td", { class: "lm__mono", text: fmt(s.addr) }),
        h("td", { class: "lm__mono", text: M.commas(s.size) }),
        h("td", { text: `${s.name} (NOLOAD): variables that start at zero, and the stack. Nobody writes these bytes but _start.` })));
    }
    renderHex(flat);

    for (const item of M.rawLoad(state, result)) {
      const tag = { ok: "Works:", warn: "Watch out:", bad: "Breaks:", info: "Load:" }[item.status];
      rawList.append(h("li", { class: `lm__raw--${item.status}` }, h("strong", { text: `${tag} ` }), item.text));
    }
    summaryP.textContent = M.summary(state, result);
  }

  // The single announcement channel: one message per change, after a short pause so quick
  // edits do not queue up. `lead` (a move, or an input error) comes first.
  function announce(lead) {
    if (!ctx.announce) return;
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      announceTimer = null;
      const sum = M.summary(state, result);
      const text = lead ? `${lead} ${sum}` : sum;
      if (lead || text !== lastSaid) {
        lastSaid = text;
        ctx.announce(text);
      }
    }, 300);
  }

  function update(next, focusKey, { writeHash = true, lead = "" } = {}) {
    state = next;
    result = M.link(state);
    render();
    renderOrder(focusKey);
    if (writeHash && ctx.hash && ctx.hash.set) ctx.hash.set(M.encodeHash(state));
    announce(lead);
  }

  // ---- Events ---------------------------------------------------------------------------
  const FIELD_NAME = { start: "Start address", stack: "Stack size", farAddr: ".far address", load: "Load address" };
  const commit = (input, type) => {
    const go = () => {
      const next = M.step(state, { type, text: input.value });
      const err = next.errors[type];
      const field = type === "stack" ? M.PRESETS[state.preset].stackLabel : FIELD_NAME[type];
      update(next, null, { lead: err ? `${field} not changed: ${err}` : "" });
    };
    input.addEventListener("change", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
  };
  commit(startInput, "start");
  commit(stackInput, "stack");
  commit(farInput, "farAddr");
  commit(loadInput, "load");
  presetSel.addEventListener("change", () => update(M.step(state, { type: "preset", id: presetSel.value })));
  whereBox.addEventListener("change", () => update(M.step(state, { type: "where", on: whereBox.checked })));
  farBox.addEventListener("change", () => update(M.step(state, { type: "far", on: farBox.checked })));
  resetBtn.addEventListener("click", () => {
    update(M.step(state, { type: "reset" }), null, { writeHash: false });
    if (ctx.hash && ctx.hash.set) ctx.hash.set(null);
  });
  shareBtn.addEventListener("click", () => {
    if (ctx.hash && ctx.hash.set) ctx.hash.set(M.encodeHash(state));
    let url = "";
    try {
      url = globalThis.location ? globalThis.location.href : "";
    } catch {
      url = "";
    }
    const done = (ok) => {
      shareNote.textContent = ok ? "Link copied." : "The address bar now holds a link to this layout.";
    };
    try {
      if (url && globalThis.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
      } else done(false);
    } catch {
      done(false);
    }
  });

  render();
  renderOrder(null);

  return {
    destroy() {
      if (announceTimer) clearTimeout(announceTimer);
    },
  };
}
