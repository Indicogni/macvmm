// blk-request view: an editor for one virtio-blk request (disk, header, descriptor chain) and a
// rendering of what model.mjs's `run` decides. All device logic lives in model.mjs; this file
// only builds DOM (createElement + textContent, never innerHTML) inside the element the lab
// shell hands us, and keeps the share state in ctx.hash. See course/site/LABS.md.
//
// Nothing here animates, so reduced motion needs no special case beyond the CSS rule in
// style.css; "Predict first" plays the role of Step: the answer stays hidden until asked for.
import {
  REQ, STATUS_NAME, LIMITS, PRESETS, PREDICTIONS, FEATURES, SECTOR_SIZE, predictionsFor,
  defaultState, cloneState, validateState, run, layout, rowPreview, headerBytes, configBytes,
  offeredFeatures, capacityBytes, typeName, fmt, fmtPow, hex2, hexU, parseU64, parseU32,
  encodeShare, decodeShare, formatTrace, outcomeKey, presetById,
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

const TYPE_CHOICES = [
  [String(REQ.IN), "IN (0): read sectors"],
  [String(REQ.OUT), "OUT (1): write sectors"],
  [String(REQ.FLUSH), "FLUSH (4): make writes durable"],
  [String(REQ.GET_ID), "GET_ID (8): the serial number"],
  ["other", "Another number..."],
];
const AR_CHOICES = [
  ["c", "checked_mul and checked_add (the reference)"],
  ["w", "wrapping, as C does (the first breakage)"],
  ["p", "plain * and +, overflow checks on"],
];
const GLOSSARY = "/build-your-own/vmm/glossary/";
const MAP_CELLS = 64;

export function mount(el, ctx) {
  const id = ctx.id;
  const embedded = !ctx.standalone;
  const thisCh = embedded ? "this chapter" : "chapter 18";
  const runIt = (s) => run(s, { embedded });
  let state = decodeShare(ctx.hash.get()) || defaultState();
  let revealed = false;
  let guess = "";
  let message = "";
  let typeOther = false; // "Another number..." chosen, even before a number is committed
  let rowEls = []; // the editor's row controls, so a refusal can reset values without a rebuild
  let timer = null;
  let lastAnnounce = 0;

  // One channel for screen readers: everything spoken goes through ctx.announce (the page's
  // polite live region); no node inside the lab is itself a live region (LABS.md section 6).
  function say(text) {
    const now = Date.now();
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, 300 - (now - lastAnnounce));
    timer = setTimeout(() => {
      timer = null;
      lastAnnounce = Date.now();
      ctx.announce(text);
    }, wait);
  }

  // ---- top bar: presets and sharing ------------------------------------------------------
  const presetSel = h("select", { id: `${id}-preset` }, h("option", { value: "", text: "Choose a request..." }));
  for (const p of PRESETS) presetSel.append(h("option", { value: p.id, text: p.label }));
  const resetBtn = h("button", { type: "button", class: "br-btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "br-btn", text: "Copy link" });
  const presetNote = h("p", { class: "br-note" });
  const top = h("div", { class: "br-top" },
    h("div", { class: "br-field" }, h("label", { for: `${id}-preset`, text: `Requests from ${thisCh} and its tests` }), presetSel),
    h("div", { class: "br-buttons" }, resetBtn, shareBtn),
  );
  const howTo = h("p", { class: "br-note br-howto", text: "Start here: the request below asks for sector 64 of a 64-sector disk, and rule 6 fires. Change the sector to 63 and watch rule 6 pass; then set the last descriptor to readable and watch the walk refuse the chain. Text fields apply when you press Enter or leave the field. Tick Predict first to guess each answer before you see it." });

  // ---- the disk --------------------------------------------------------------------------
  const capIn = h("input", { id: `${id}-cap`, type: "text", autocomplete: "off", spellcheck: "false", size: "10" });
  const roBox = h("input", { id: `${id}-ro`, type: "checkbox" });
  const wbBox = h("input", { id: `${id}-wb`, type: "checkbox" });
  const diskIn = h("input", { id: `${id}-disk`, type: "text", inputmode: "numeric", autocomplete: "off", size: "3" });
  const arSel = h("select", { id: `${id}-ar` });
  for (const [v, t] of AR_CHOICES) arSel.append(h("option", { value: v, text: t }));
  const laterBox = h("details", { class: "br-more br-later" },
    h("summary", { text: "Later in this chapter" }),
    h("div", { class: "br-later__body" },
      h("p", { class: "br-note", text: "Each control here belongs to a later section. Leave them alone until you get there." }),
      h("div", { class: "br-field" },
        h("label", { for: `${id}-ar`, text: "Arithmetic in rule 6 (see Breaking it on purpose)" }), arSel),
      h("div", { class: "br-field" },
        h("label", { class: "br-check", for: `${id}-wb` }, wbBox, " Driver accepted FLUSH (see What FLUSH promises)"),
        h("p", { class: "br-note", id: `${id}-wb-hint`, text: "Changes only when an OUT is made durable, not its status." })),
      h("div", { class: "br-field" },
        h("label", { for: `${id}-disk`, text: "Disk number" }), diskIn,
        h("p", { class: "br-note", id: `${id}-disk-hint`, text: "Which --disk this is, 0 for the first. It only changes GET_ID's serial." })),
    ),
  );
  wbBox.setAttribute("aria-describedby", `${id}-wb-hint`);
  diskIn.setAttribute("aria-describedby", `${id}-disk-hint`);
  const diskBox = h("fieldset", { class: "br-box" },
    h("legend", { text: "The disk and the driver" }),
    h("div", { class: "br-row" },
      h("div", { class: "br-field" }, h("label", { for: `${id}-cap`, text: "Capacity in 512-byte sectors" }), capIn),
    ),
    h("div", { class: "br-row" },
      h("label", { class: "br-check", for: `${id}-ro` }, roBox, " Opened read-only (,ro)"),
    ),
    laterBox,
  );

  // ---- the header ------------------------------------------------------------------------
  const typeSel = h("select", { id: `${id}-type` });
  for (const [v, t] of TYPE_CHOICES) typeSel.append(h("option", { value: v, text: t }));
  const typeIn = h("input", { id: `${id}-typen`, type: "text", autocomplete: "off", spellcheck: "false", size: "11" });
  const typeField = h("div", { class: "br-field" }, h("label", { for: `${id}-typen`, text: "Type (32-bit)" }), typeIn);
  const sectorIn = h("input", { id: `${id}-sector`, type: "text", autocomplete: "off", spellcheck: "false", size: "22" });
  const resIn = h("input", { id: `${id}-res`, type: "text", autocomplete: "off", spellcheck: "false", size: "11" });
  const fillIn = h("input", { id: `${id}-fill`, type: "text", autocomplete: "off", spellcheck: "false", size: "5", "aria-describedby": `${id}-fill-hint` });
  const hdrBytes = h("ol", { class: "br-bytes", "aria-label": "The 16 header bytes, in memory order" });
  const hdrNote = h("p", { class: "br-note" });
  const headerBox = h("fieldset", { class: "br-box" },
    h("legend", { text: "The header the driver wrote" }),
    h("div", { class: "br-row" },
      h("div", { class: "br-field" }, h("label", { for: `${id}-type`, text: "Request type" }), typeSel),
      typeField,
      h("div", { class: "br-field" }, h("label", { for: `${id}-sector`, text: "Sector (decimal, 0x hex, or 2^n)" }), sectorIn),
    ),
    h("div", { class: "br-row" },
      h("div", { class: "br-field" }, h("label", { for: `${id}-res`, text: "Reserved" }), resIn),
      h("div", { class: "br-field" }, h("label", { for: `${id}-fill`, text: "OUT data byte" }), fillIn,
        h("p", { class: "br-note", id: `${id}-fill-hint`, text: "The value every byte of an OUT's data holds." })),
    ),
    h("div", { class: "br-scroll" }, hdrBytes),
    hdrNote,
  );

  // ---- the chain -------------------------------------------------------------------------
  const chainBody = h("tbody");
  const addR = h("button", { type: "button", class: "br-btn", text: "Add a readable descriptor" });
  const addW = h("button", { type: "button", class: "br-btn", text: "Add a writable descriptor" });
  const chainBox = h("fieldset", { class: "br-box" },
    h("legend", { text: "The descriptor chain, after chapter 16's walk checked the addresses" }),
    h("div", { class: "br-scroll" }, h("table", { class: "br-chain" },
      h("caption", { text: "In chain order. A row can stand for several identical descriptors (Repeat)." }),
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", text: "#" }), h("th", { scope: "col", text: "Device may" }),
        h("th", { scope: "col", text: "Length" }), h("th", { scope: "col", text: "Repeat" }),
        h("th", { scope: "col", text: "Move or remove" }))),
      chainBody)),
    h("div", { class: "br-buttons" }, addR, addW),
  );

  // ---- predict ---------------------------------------------------------------------------
  const predictBox = h("input", { id: `${id}-predict`, type: "checkbox" });
  const guessSel = h("select", { id: `${id}-guess` });
  let guessChoices = "";
  function fillGuesses() {
    const list = predictionsFor(state);
    const key = list.map((p) => p.value).join(",");
    if (key === guessChoices) return;
    guessChoices = key;
    guessSel.replaceChildren(h("option", { value: "", text: "choose" }));
    for (const p of list) guessSel.append(h("option", { value: p.value, text: p.label }));
  }
  const revealBtn = h("button", { type: "button", class: "br-btn br-btn--primary", text: "Show what the device does" });
  const guessRow = h("div", { class: "br-row br-guess" },
    h("div", { class: "br-field" }, h("label", { for: `${id}-guess`, text: "Your prediction: what happens" }), guessSel),
    h("div", { class: "br-buttons" }, revealBtn),
  );
  const scoreEl = h("p", { class: "br-score", tabindex: "-1" });
  const predictWrap = h("div", { class: "br-predict" },
    h("label", { class: "br-check", for: `${id}-predict` }, predictBox, " Predict first (hide the answer until I ask)"),
    guessRow, scoreEl,
  );

  // ---- results ---------------------------------------------------------------------------
  const msgEl = h("p", { class: "br-msg" });
  const readout = h("p", { class: "br-readout" });
  const outcomeEl = h("p", { class: "br-outcome" });
  const checksList = h("ol", { class: "br-checks", "aria-label": "The checks, in the order the device runs them" });
  const streamBody = h("tbody");
  const streamTable = h("div", { class: "br-scroll" }, h("table", { class: "br-stream" },
    h("caption", { text: "Each descriptor's bytes: readable ones as the device copies them, writable ones before and after it answered. Writable buffers start as 0xee, a marker value, so you can see which bytes the device wrote." }),
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: "#" }), h("th", { scope: "col", text: "Holds" }),
      h("th", { scope: "col", text: "Before" }), h("th", { scope: "col", text: "After" }))),
    streamBody));
  const mapEl = h("ol", { class: "br-map", "aria-hidden": "true" });
  const mapText = h("p", { class: "br-note br-maptext" });
  const effectsList = h("ul", { class: "br-effects" });
  const driverList = h("ul", { class: "br-effects" });
  const plain = h("pre", { class: "br-plain" });
  const results = h("div", { class: "br-results" },
    outcomeEl,
    h("h3", { text: "The checks" }), checksList,
    h("h3", { text: "The bytes" }), streamTable,
    h("h3", { text: "The disk" }),
    h("div", { class: "br-scroll" }, mapEl),
    h("p", { class: "br-note", text: "Cells are sectors (or equal groups of sectors on a large disk). A: the range the request asks for. R: read. W: written. X: past the end of the disk." }),
    mapText,
    h("h3", { text: "What reaches the backend" }), effectsList,
    h("p", { class: "br-note br-terms" }, "Terms used here: ",
      h("a", { href: `${GLOSSARY}#bounce-buffer`, text: "bounce buffer" }), ", ",
      h("a", { href: `${GLOSSARY}#flush`, text: "FLUSH" }), ", ",
      h("a", { href: `${GLOSSARY}#write-back`, text: "write-back" }), ", ",
      h("a", { href: `${GLOSSARY}#device-needs-reset`, text: "DEVICE_NEEDS_RESET" }), "."),
    h("details", { class: "br-more" }, h("summary", { text: "What the driver was told (features and configuration space)" }), driverList),
    h("details", { class: "br-more" }, h("summary", { text: "The whole decision as plain text" }), plain),
  );
  const honesty = h("details", { class: "br-more" },
    h("summary", { text: "What this model simplifies" }),
    h("ul", {},
      h("li", { text: "Descriptor addresses are not modelled: the chain is shown after chapter 16's walk accepted every buffer as inside guest RAM. Of the walk's own checks, only the zero length, the readable-after-writable order and the hop budget can be triggered here." }),
      h("li", { text: "Indirect tables are not modelled: every descriptor here sits in the queue's own table, so the walk's hop budget (the queue size, here 256, the largest this device allows; a driver may choose a smaller queue) covers them all. Through an indirect table the budget restarts, so a longer chain gets past the walk and rule 3 refuses it with IOERR. Rule 3's limit of 128 counts descriptors the same wherever they came from." }),
      h("li", { text: "The disk is the host tests' in-memory disk: byte i holds (i × 7 + i / 512) mod 256. It never shrinks, never fails a read, and every sync succeeds." }),
      h("li", { text: "Each request starts from a fresh guest: writable buffers hold 0xee, the value the host tests use, until the device writes them." }),
      h("li", { text: "When a wrapped check lets a far-away offset through, the lab stops there: what a real file does with that offset depends on the backend, and the reference never lets it happen." }),
    ),
  );

  el.append(h("div", { class: "br-wrap" },
    top, howTo, presetNote,
    h("div", { class: "br-controls" }, h("div", { class: "br-col" }, diskBox, headerBox), chainBox),
    msgEl, predictWrap, readout, results, honesty,
  ));

  // ---- editor rows -----------------------------------------------------------------------
  function buildRows(focus) {
    chainBody.replaceChildren();
    rowEls = [];
    state.descs.forEach((d, i) => {
      const dir = h("select", { id: `${id}-d${i}-dir`, "aria-label": `Descriptor row ${i}: direction` },
        h("option", { value: "r", text: "read it (readable)" }), h("option", { value: "w", text: "write it (writable)" }));
      dir.value = d.w ? "w" : "r";
      const len = h("input", { id: `${id}-d${i}-len`, type: "text", inputmode: "numeric", autocomplete: "off", size: "10", "aria-label": `Descriptor row ${i}: length in bytes`, value: String(d.len) });
      len.value = String(d.len);
      const rep = h("input", { id: `${id}-d${i}-n`, type: "text", inputmode: "numeric", autocomplete: "off", size: "4", "aria-label": `Descriptor row ${i}: repeat count`, value: String(d.n) });
      rep.value = String(d.n);
      const up = h("button", { type: "button", class: "br-btn br-btn--small", "aria-label": `Move row ${i} up`, text: "Up", disabled: i === 0 });
      const down = h("button", { type: "button", class: "br-btn br-btn--small", "aria-label": `Move row ${i} down`, text: "Down", disabled: i === state.descs.length - 1 });
      const del = h("button", { type: "button", class: "br-btn br-btn--small", "aria-label": `Remove row ${i}`, text: "Remove", disabled: state.descs.length === 1 });
      dir.addEventListener("change", () => edit((s) => { s.descs[i].w = dir.value === "w"; }));
      len.addEventListener("change", () => {
        const v = parseU32(len.value);
        if (v === null) return refuse("a descriptor's length is a number from 0 to 4294967295");
        edit((s) => { s.descs[i].len = v; });
      });
      rep.addEventListener("change", () => {
        const v = parseU32(rep.value);
        if (v === null || v < 1 || v > LIMITS.repeat) return refuse(`a row repeats 1 to ${LIMITS.repeat} times`);
        edit((s) => { s.descs[i].n = v; });
      });
      up.addEventListener("click", () => move(i, -1));
      down.addEventListener("click", () => move(i, 1));
      del.addEventListener("click", () => {
        edit((s) => { s.descs.splice(i, 1); }, { rows: true, focus: [Math.min(i, state.descs.length - 2), "dir"] });
      });
      rowEls.push({ dir, len, rep });
      chainBody.append(h("tr", {},
        h("th", { scope: "row", text: String(i) }),
        h("td", {}, dir), h("td", {}, len), h("td", {}, rep),
        h("td", {}, h("div", { class: "br-buttons br-buttons--tight" }, up, down, del))));
      if (focus && focus[0] === i) {
        const target = { dir, up, down, del, len, n: rep }[focus[1]];
        if (target && !target.disabled && typeof target.focus === "function") target.focus();
        else if (typeof dir.focus === "function") dir.focus();
      }
    });
    addR.disabled = addW.disabled = state.descs.length >= LIMITS.rows;
  }

  /** Put the kept values back into the existing row controls (no rebuild, so focus stays put). */
  function syncRows() {
    if (rowEls.length !== state.descs.length) { buildRows(null); return; }
    state.descs.forEach((d, i) => {
      rowEls[i].dir.value = d.w ? "w" : "r";
      rowEls[i].len.value = String(d.len);
      rowEls[i].rep.value = String(d.n);
    });
  }

  function move(i, by) {
    const j = i + by;
    edit((s) => { const [d] = s.descs.splice(i, 1); s.descs.splice(j, 0, d); }, { rows: true, focus: [j, by < 0 ? "up" : "down"] });
  }

  function fillEditor() {
    capIn.value = state.cap.toString(10);
    roBox.checked = state.ro;
    wbBox.checked = state.wb;
    diskIn.value = String(state.disk);
    arSel.value = state.ar;
    const named = typeName(state.type) !== null && !typeOther;
    typeSel.value = named ? String(state.type) : "other";
    typeField.hidden = named;
    typeIn.value = String(state.type);
    sectorIn.value = fmt(state.sector);
    resIn.value = String(state.reserved);
    fillIn.value = `0x${hex2(state.fill)}`;
    predictBox.checked = state.predict;
    // Show the later-section controls whenever they hold something other than the default.
    if (state.ar !== "c" || !state.wb || state.disk !== 0) laterBox.open = true;
  }

  // ---- state changes ---------------------------------------------------------------------
  function edit(fn, { rows = false, focus = null, keepPreset = false } = {}) {
    const next = cloneState(state);
    fn(next);
    const err = validateState(next);
    if (err) return refuse(err);
    state = next;
    message = "";
    revealed = false;
    guess = "";
    if (!keepPreset) { presetSel.value = ""; presetNote.textContent = ""; }
    if (rows) buildRows(focus);
    render();
    say(readout.textContent);
  }

  function refuse(text) {
    message = `Not changed: ${text}.`;
    fillEditor();
    syncRows();
    render();
    say(message);
  }

  function load(s, note = "") {
    state = cloneState(s);
    revealed = false;
    guess = "";
    message = "";
    typeOther = false;
    presetNote.textContent = note;
    fillEditor();
    buildRows(null);
    render();
    say(note ? `${note} ${readout.textContent}` : readout.textContent);
  }

  // ---- rendering -------------------------------------------------------------------------
  function render() {
    const res = runIt(state);
    const hidden = state.predict && !revealed;

    // Header bytes.
    const hb = headerBytes(state);
    hdrBytes.replaceChildren();
    const fieldOf = (i) => (i < 4 ? "type" : i < 8 ? "reserved" : "sector");
    hb.forEach((b, i) => hdrBytes.append(h("li", { class: `br-byte br-byte--${fieldOf(i)}`, title: `byte ${i}: ${fieldOf(i)}` },
      h("span", { class: "br-visually-hidden", text: `byte ${i}, ${fieldOf(i)}, 0x${hex2(b)}` }),
      h("span", { class: "br-byte__i", "aria-hidden": "true", text: String(i) }),
      h("span", { class: "br-byte__v", "aria-hidden": "true", text: hex2(b) }))));
    hdrNote.textContent = `Bytes 0-3: le32 type ${state.type}; 4-7: le32 reserved ${state.reserved}; 8-15: le64 sector ${fmt(state.sector)}, least significant byte first.`;

    // Predict.
    guessRow.hidden = !hidden;
    fillGuesses();
    if (!predictionsFor(state).some((p) => p.value === guess)) guess = "";
    guessSel.value = guess;
    revealBtn.disabled = guess === "";
    results.hidden = hidden;
    if (!revealed) scoreEl.textContent = "";

    // Readout.
    msgEl.textContent = message;
    msgEl.hidden = !message;
    readout.textContent = hidden
      ? "Answer hidden. Choose your prediction, then press Show what the device does."
      : res.summary;
    if (!hidden) renderResults(res);

    const str = encodeShare(state);
    ctx.hash.set(str === "" ? null : str);
  }

  function renderResults(res) {
    const o = res.outcome;
    const head = o.kind === "status" ? `Status ${STATUS_NAME[o.status]} (${o.status}), used length ${o.used}`
      : o.kind === "reset" ? "DEVICE_NEEDS_RESET: no status, nothing in the used ring"
        : o.kind === "panic" ? "The VMM panics"
          : "The check's promise is broken: a far-away offset reaches the backend";
    outcomeEl.textContent = head;
    outcomeEl.className = `br-outcome br-outcome--${outcomeKey(res)}`;

    checksList.replaceChildren();
    for (const c of res.checks) {
      const tag = { pass: "passes", fail: "FIRES: stops here", skip: "does not apply", "not reached": "not reached" }[c.verdict];
      checksList.append(h("li", { class: `br-check-item br-check-item--${c.verdict.replace(" ", "-")}` },
        h("span", { class: "br-verdict", text: tag }), h("span", { class: "br-check-title", text: c.title }),
        c.detail ? h("span", { class: "br-check-detail", text: c.detail }) : null));
    }

    streamBody.replaceChildren();
    const lay = layout(state, res);
    let firstIndex = 0;
    for (const L of lay) {
      const pv = rowPreview(state, res, L);
      const idx = L.n > 1 ? `${firstIndex}-${firstIndex + L.n - 1}` : String(firstIndex);
      firstIndex += L.n;
      const holds = `${L.w ? "writable" : "readable"}, ${fmt(BigInt(L.total))} byte${L.total === 1 ? "" : "s"}${L.n > 1 ? ` (${L.n} × ${L.len})` : ""}: ${L.parts.length ? L.parts.join(", ") : L.total === 0 ? "nothing" : "not used"}`;
      const fmtBytes = (arr, more, tail, which) => {
        let t = arr.map(hex2).join(" ");
        if (more > 0) t += ` ... ${fmt(BigInt(more))} more`;
        if (tail) t += ` | last ${hex2(tail[which])}`;
        return t || "(none)";
      };
      const changed = L.w && (pv.after.some((b, i) => b !== pv.before[i]) || (pv.tail && pv.tail.after !== pv.tail.before));
      streamBody.append(h("tr", { class: changed ? "br-changed" : "" },
        h("th", { scope: "row", text: idx }),
        h("td", { text: holds }),
        h("td", { class: "br-mono", text: fmtBytes(pv.before, pv.more, pv.tail, "before") }),
        h("td", { class: "br-mono", text: L.w ? `${fmtBytes(pv.after, pv.more, pv.tail, "after")}${changed ? "  (changed)" : "  (unchanged)"}` : "read only" })));
    }

    renderMap(res);

    effectsList.replaceChildren();
    const d = res.disk;
    const items = [];
    for (const r of d.reads) items.push(`read ${fmt(BigInt(r.len))} bytes at offset ${fmt(r.offset)}${d.wrong ? " (the wrong place)" : ""}`);
    for (const w of d.writes) items.push(`write ${fmt(BigInt(w.len))} bytes at offset ${fmt(w.offset)}${d.wrong ? " (the wrong place)" : ""}`);
    if (d.syncs) items.push(`sync ${d.syncs} time (File::sync_all, F_FULLFSYNC on macOS)`);
    if (!items.length) items.push(o.kind === "panic" ? "nothing: the VMM stopped first" : "nothing: the backend is never called");
    for (const t of items) effectsList.append(h("li", { text: t }));

    driverList.replaceChildren();
    const f = offeredFeatures(state.ro);
    const names = FEATURES.filter((x) => (f >> BigInt(x.bit)) & 1n).map((x) => `${x.name} (bit ${x.bit})`);
    driverList.append(h("li", { text: `Features offered: ${hexU(f)} = ${names.join(", ")}. Not SIZE_MAX, so the 8 MiB cap is never announced.` }));
    driverList.append(h("li", { text: `Configuration space, 24 bytes: ${configBytes(state.cap).map(hex2).join(" ")} (capacity ${fmt(capacityBytes(state.cap) / SECTOR_SIZE)} sectors, size_max 65536, seg_max 126, geometry 0, blk_size 512).` }));
    driverList.append(h("li", { text: state.wb ? "The driver accepted FLUSH: write-back. An OUT is durable only after a later FLUSH." : "The driver did not accept FLUSH: write-through. Every OUT is synced before it answers." }));
    plain.textContent = formatTrace(state, res);
  }

  function renderMap(res) {
    mapEl.replaceChildren();
    const cap = state.cap;
    const cells = cap <= 128n ? Number(cap) : MAP_CELLS;
    const per = cap <= 128n ? 1n : (cap + BigInt(MAP_CELLS) - 1n) / BigInt(MAP_CELLS);
    const d = res.disk;
    const span = (off, len) => {
      if (len === 0) return null;
      const a = off / SECTOR_SIZE;
      return [a, (off + BigInt(len) - 1n) / SECTOR_SIZE];
    };
    const asked = d.asked && d.asked.len > 0 && res.outcome.kind !== "panic"
      ? [d.asked.sector, d.asked.sector + (BigInt(d.asked.len) + SECTOR_SIZE - 1n) / SECTOR_SIZE - 1n] : null;
    const reads = d.reads.map((r) => span(r.offset, r.len)).filter(Boolean);
    const writes = d.writes.map((r) => span(r.offset, r.len)).filter(Boolean);
    const hit = (ranges, lo, hi) => ranges.some(([a, b]) => a <= hi && b >= lo);
    for (let c = 0; c < cells; c++) {
      const lo = BigInt(c) * per;
      const hi = lo + per - 1n;
      const isR = hit(reads, lo, hi);
      const isW = hit(writes, lo, hi);
      const isA = asked && hit([asked], lo, hi);
      const letter = isW ? "W" : isR ? "R" : isA ? "A" : "";
      mapEl.append(h("li", { class: `br-cell${isA ? " br-cell--asked" : ""}${isR ? " br-cell--read" : ""}${isW ? " br-cell--write" : ""}`, text: letter }));
    }
    const past = asked && asked[1] >= cap;
    const pastTouch = [...reads, ...writes].some(([, b]) => b >= cap);
    if (past || pastTouch) mapEl.append(h("li", { class: "br-cell br-cell--past", text: "X" }));

    const parts = [`The disk: sectors 0 to ${fmt(cap - 1n)}${per > 1n ? `, ${fmt(per)} sectors per cell` : ""}.`];
    if (asked) {
      parts.push(`The request asks for sector${asked[0] === asked[1] ? ` ${fmtPow(asked[0])}` : `s ${fmtPow(asked[0])} to ${fmt(asked[1])}`}${past ? ", past the end" : ""}.`);
    } else if (res.header && (res.header.type === REQ.FLUSH || res.header.type === REQ.GET_ID)) {
      parts.push(`${typeName(res.header.type)} names no sectors.`);
    }
    if (reads.length || writes.length) {
      const [a, b] = (reads[0] || writes[0]);
      parts.push(`It ${reads.length ? "reads" : "writes"} sector${a === b ? ` ${fmt(a)}` : `s ${fmt(a)} to ${fmt(b)}`}${d.wrong ? ", not the sectors it asked for" : ""}.`);
    } else if (asked) parts.push("No sector is touched.");
    mapText.textContent = parts.join(" ");
  }

  // ---- events ----------------------------------------------------------------------------
  presetSel.addEventListener("change", () => {
    const p = presetById(presetSel.value);
    if (!p) return;
    const keep = presetSel.value;
    load(p.state, p.note || "");
    presetSel.value = keep;
  });
  resetBtn.addEventListener("click", () => { presetSel.value = ""; load(defaultState()); });
  shareBtn.addEventListener("click", async () => {
    render();
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this request is in the address bar.");
    }
  });

  capIn.addEventListener("change", () => {
    const v = parseU64(capIn.value);
    if (v === null || v < 1n) return refuse("the capacity is a number of sectors from 1 to 2^64 - 1");
    edit((s) => { s.cap = v; });
  });
  roBox.addEventListener("change", () => edit((s) => { s.ro = roBox.checked; }, { keepPreset: true }));
  wbBox.addEventListener("change", () => edit((s) => { s.wb = wbBox.checked; }, { keepPreset: true }));
  arSel.addEventListener("change", () => edit((s) => { s.ar = arSel.value; }, { keepPreset: true }));
  diskIn.addEventListener("change", () => {
    const v = parseU32(diskIn.value);
    if (v === null || v > LIMITS.diskIndex) return refuse(`the disk number is 0 to ${LIMITS.diskIndex}`);
    edit((s) => { s.disk = v; });
  });
  typeSel.addEventListener("change", () => {
    if (typeSel.value === "other") {
      // Reveal the number field, which comes next in tab order; focus stays on the select.
      typeOther = true;
      typeField.hidden = false;
      return;
    }
    typeOther = false;
    edit((s) => { s.type = Number(typeSel.value); });
    fillEditor();
  });
  typeIn.addEventListener("change", () => {
    const v = parseU32(typeIn.value);
    if (v === null) return refuse("the type is a 32-bit number");
    edit((s) => { s.type = v; });
  });
  sectorIn.addEventListener("change", () => {
    const v = parseU64(sectorIn.value);
    if (v === null) return refuse("the sector is a 64-bit number: decimal, 0x hex, or 2^n");
    edit((s) => { s.sector = v; });
  });
  resIn.addEventListener("change", () => {
    const v = parseU32(resIn.value);
    if (v === null) return refuse("the reserved field is a 32-bit number");
    edit((s) => { s.reserved = v; });
  });
  fillIn.addEventListener("change", () => {
    const v = parseU32(fillIn.value);
    if (v === null || v > 0xff) return refuse("the data byte is 0x00 to 0xff");
    edit((s) => { s.fill = v; });
  });
  addR.addEventListener("click", () => edit((s) => { s.descs.push({ w: false, len: 512, n: 1 }); }, { rows: true, focus: [state.descs.length, "dir"] }));
  addW.addEventListener("click", () => edit((s) => { s.descs.push({ w: true, len: 512, n: 1 }); }, { rows: true, focus: [state.descs.length, "dir"] }));

  predictBox.addEventListener("change", () => edit((s) => { s.predict = predictBox.checked; }, { keepPreset: true }));
  guessSel.addEventListener("change", () => {
    guess = guessSel.value;
    revealBtn.disabled = guess === "";
  });
  revealBtn.addEventListener("click", () => {
    if (!guess) return;
    const res = runIt(state);
    const actual = outcomeKey(res);
    const label = PREDICTIONS.find((p) => p.value === guess).label;
    revealed = true;
    render();
    scoreEl.textContent = actual === guess ? `You predicted ${label}: right.` : `You predicted ${label}; see below for what the device does.`;
    // The button just disappeared with the guess row: keep focus next to the results.
    if (typeof scoreEl.focus === "function") scoreEl.focus();
    say(`${scoreEl.textContent} ${readout.textContent}`);
  });

  fillEditor();
  buildRows(null);
  render();

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

