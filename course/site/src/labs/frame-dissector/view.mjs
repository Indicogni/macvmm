// frame-dissector view: renders the model's dissection and turns form input into model calls.
// All parsing and every verdict live in model.mjs; this file only builds DOM (createElement +
// textContent, never innerHTML) inside the element the lab shell hands us. See LABS.md.
import {
  PRESETS, preset, VMS, LAYERS, HDR_LEN, LEGACY_HDR_LEN, LEGACY_RUN, DEFAULT,
  parseHex, formatHexLines, dissect, summary, shiftRows, fixChecksums, hex,
  encodeShare, decodeShare, stateBytes,
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

const ROW = 16;
const CUSTOM = "custom";

const CHECK_TEXT = { ok: "ok", warn: "check", bad: "problem", info: "note" };
const APPLY_IDLE_MS = 500; // the hex box applies after this much idle time, or on change/blur

export function mount(el, ctx) {
  const id = ctx.id;
  // The shell titles the lab with h1 on the standalone page and h3 inside a lesson (under the
  // section's h2), so the lab's own panel headings sit one level below that title.
  const HN = ctx.standalone ? "h2" : "h4";
  let s = decodeShare(ctx.hash.get()) || { ...DEFAULT };
  let bytes = stateBytes(s);
  let d = null;
  let sel = 0; // selected field index
  let focusByte = 0;
  let message = "";
  let timer = null;
  let applyTimer = null;
  let lastAnnounce = 0;
  let cells = [];

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

  // ---- controls -------------------------------------------------------------------------
  const presetSel = h("select", { id: `${id}-preset` });
  for (const p of PRESETS) presetSel.append(h("option", { value: p.id, text: p.title }));
  presetSel.append(h("option", { value: CUSTOM, text: "Your bytes (edited)" }));
  const dirSel = h("select", { id: `${id}-dir` },
    h("option", { value: "tx", text: "A guest transmits it (TX: the device checks it)" }),
    h("option", { value: "rx", text: "A guest's driver receives it (RX)" }));
  const stripSel = h("select", { id: `${id}-strip` },
    h("option", { value: String(HDR_LEN), text: "12 bytes (virtio 1.0 and later: correct)" }),
    h("option", { value: String(LEGACY_HDR_LEN), text: "10 bytes (an old, pre-1.0 device)" }));
  const toSel = h("select", { id: `${id}-to` });
  for (const vm of Object.values(VMS)) toSel.append(h("option", { value: vm.id, text: `${vm.name} (${vm.ip.join(".")})` }));
  const fixBtn = h("button", { type: "button", class: "fd-btn", text: "Fix checksums" });
  const resetBtn = h("button", { type: "button", class: "fd-btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "fd-btn", text: "Copy link" });
  const hexIn = h("textarea", { id: `${id}-hex`, rows: "5", spellcheck: "false", autocomplete: "off", class: "fd-hex", "aria-describedby": `${id}-hexhelp` });
  const hexHelp = h("p", { id: `${id}-hexhelp`, class: "fd-note", text: "Changes apply when you pause typing or leave the box." });
  const sourceNote = h("p", { class: "fd-note" });
  const msgEl = h("p", { id: `${id}-msg`, class: "fd-msg", role: "status" });

  const field = (forId, label, control) => h("div", { class: "fd-field" }, h("label", { for: forId, text: label }), control);
  // The strip option answers the chapter's "Two bytes off" Predict, which comes after this lab
  // in the lesson; it waits behind a closed disclosure so it does not give the answer away.
  const stripBox = h("details", { class: "fd-more fd-later" },
    h("summary", { text: "Two bytes off (open after you write your guess for the Predict below)" }),
    h("p", { class: "fd-note", text: "The device must strip exactly the header the driver wrote. Pick 10 to make it strip two bytes too few on transmit, and see what the receiver reads." }),
    field(`${id}-strip`, "Header the device strips on transmit", stripSel));
  const controls = h("div", { class: "fd-controls" },
    h("div", { class: "fd-row" },
      field(`${id}-preset`, "Buffer", presetSel),
      field(`${id}-dir`, "Direction", dirSel),
      field(`${id}-to`, "Receiving guest", toSel)),
    h("div", { class: "fd-field fd-field--wide" },
      h("label", { for: `${id}-hex`, text: "Bytes in hex, virtio-net header first (edit freely; spaces and colons are fine)" }), hexIn, hexHelp),
    sourceNote,
    h("div", { class: "fd-buttons", role: "group", "aria-label": "Actions" }, fixBtn, resetBtn, shareBtn),
    msgEl,
    stripBox);

  // ---- a first path through the lab, tied to the lesson's ARP table ------------------------
  const tryThis = h("div", { class: "fd-try" },
    h(HN, { class: "fd-h", text: "Try this" }),
    h("ol", {},
      h("li", { text: "Click byte 24 in the grid: the EtherType, 08 06. Read what it says comes next." }),
      h("li", { text: "Set Buffer to \"Header asks for checksum offload (flags = 1)\" and read what macvmm's device does." }),
      h("li", { text: "Pick the 1515-byte frame and see where it stops." }),
      h("li", { text: "Back on the ARP request, set Receiving guest to VM A and read why nobody answers." })),
    h("p", { class: "fd-note", text: "Words the verdicts use: the device is macvmm's virtio-net device, the host code behind the guest's network card. tx_packets, tx_dropped and the rx_ names are counters it keeps. The backend is the host side that carries a frame to the other VM; an offload is work the guest asks the device to do. The Transmit section below explains all of them." }));

  // ---- readout --------------------------------------------------------------------------
  // Spoken through ctx.announce only (not also a live region), so each summary is heard once.
  const readout = h("p", { class: "fd-readout" });

  // ---- byte grid ------------------------------------------------------------------------
  const legend = h("ul", { class: "fd-legend", "aria-label": "Layers" });
  const grid = h("div", { class: "fd-grid", role: "grid", "aria-label": "The buffer's bytes, 16 per row", "aria-describedby": `${id}-gridhelp` });
  const gridHelp = h("p", { id: `${id}-gridhelp`, class: "fd-note", text: "Click a byte, or focus the grid and use the arrow keys. Home and End go to a row's ends, Ctrl+Home and Ctrl+End to the first and last byte, Page Up and Page Down move 8 rows. The field it belongs to is described below. A thick left edge marks where a field starts." });
  const detail = h("div", { class: "fd-detail" });

  // ---- verdicts -------------------------------------------------------------------------
  const devTitle = h(HN, { class: "fd-h" });
  const devText = h("p");
  const devWarn = h("pre", { class: "fd-warn" });
  const peerTitle = h(HN, { class: "fd-h" });
  const peerText = h("p");
  const guestTitle = h(HN, { class: "fd-h" });
  const guestText = h("p");
  const verdicts = h("div", { class: "fd-verdicts" },
    h("div", { class: "fd-card" }, devTitle, devText, devWarn, peerTitle, peerText),
    h("div", { class: "fd-card" }, guestTitle, guestText));

  // ---- the Predict panel ----------------------------------------------------------------
  const shiftBody = h("tbody");
  const shiftRun = h("p", { class: "fd-note" });
  const shiftBox = h("div", { class: "fd-card fd-shift" },
    h(HN, { class: "fd-h", text: "Two bytes off: what the receiver reads" }),
    h("div", { class: "fd-scroll", tabindex: "0", role: "region", "aria-labelledby": `${id}-shiftcap` }, h("table", {},
      h("caption", { id: `${id}-shiftcap`, text: "The first 14 frame bytes, as the driver wrote them and as the receiver reads them (scrolls sideways on narrow screens)" }),
      h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Bytes read" }), h("th", { scope: "col", text: "Field" }),
        h("th", { scope: "col", text: "Sent as" }), h("th", { scope: "col", text: "Read as" }))),
      shiftBody)),
    shiftRun);

  // ---- field table ----------------------------------------------------------------------
  const tableBody = h("tbody");
  let tableRows = [];
  const table = h("div", { class: "fd-scroll", tabindex: "0", role: "region", "aria-labelledby": `${id}-tablecap` }, h("table", { class: "fd-table" },
    h("caption", { id: `${id}-tablecap`, text: "Every field, in buffer order. Choose an offset to show that field in the grid and the panel above; focus stays here. The table scrolls sideways on narrow screens." }),
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: "Offset" }), h("th", { scope: "col", text: "Layer" }), h("th", { scope: "col", text: "Field" }),
      h("th", { scope: "col", text: "Bytes" }), h("th", { scope: "col", text: "Value" }), h("th", { scope: "col", text: "Check" }))),
    tableBody));

  const honesty = h("details", { class: "fd-more" },
    h("summary", { text: "What this model simplifies" }),
    h("ul", {},
      h("li", { text: "The device side is the course's reference: the transmit length rule (26 to 1526 bytes), then flags and gso_type, then the backend; on receive, the 14 to 1514 rule and the header it writes. A real chain also has descriptors; here the buffer is already one copy." }),
      h("li", { text: "The guest side is a simplified Linux host: the Ethernet destination filter, ARP for its own address, IPv4 and ICMP echo. It does not reassemble fragments, route, or decode TCP, UDP or IPv6 beyond the headers. It knows no netmask, so a subnet broadcast such as 10.0.0.255 counts as somebody else's address." }),
      h("li", { text: "Only the ARP request comes from the lesson. The other buffers were built by this lab from the protocol rules, with correct checksums; no run recorded those bytes." }),
      h("li", { text: "Frames are not padded to 60 bytes: padding is a wire rule, and neither side of a datagram socket needs it." }),
    ));

  el.append(h("div", { class: "fd-wrap" },
    controls,
    tryThis,
    h("div", { class: "fd-main" },
      h("div", { class: "fd-col" }, legend, h("div", { class: "fd-scroll" }, grid), gridHelp, detail),
      h("div", { class: "fd-col" }, verdicts, shiftBox)),
    readout,
    table,
    honesty));

  for (const [k, name] of Object.entries(LAYERS)) {
    legend.append(h("li", { class: `fd-key fd-l-${k}` }, h("span", { class: "fd-swatch", "aria-hidden": "true" }), name));
  }

  // ---- rendering ------------------------------------------------------------------------
  function fieldAt(off) {
    const i = d.fields.findIndex((f) => f.len > 0 && off >= f.off && off < f.off + f.len);
    return i;
  }

  function cellLabel(i) {
    const fi = fieldAt(i);
    const f = fi >= 0 ? d.fields[fi] : null;
    return `offset ${i}, ${hex(bytes[i])}${f ? `, ${LAYERS[f.layer]} ${f.name}` : ""}`;
  }

  function buildGrid() {
    grid.replaceChildren();
    cells = [];
    if (bytes.length === 0) {
      grid.append(h("div", { role: "row", class: "fd-grow" }, h("span", { role: "gridcell", class: "fd-empty", text: "No bytes." })));
      return;
    }
    for (let r = 0; r < bytes.length; r += ROW) {
      const row = h("div", { role: "row", class: "fd-grow" }, h("span", { role: "rowheader", class: "fd-off", text: String(r).padStart(4, "0") }));
      for (let i = r; i < Math.min(r + ROW, bytes.length); i++) {
        const c = h("span", { role: "gridcell", tabindex: "-1", class: "fd-b", text: bytes[i].toString(16).padStart(2, "0") });
        c.addEventListener("click", () => selectByte(i, true));
        cells.push(c);
        row.append(c);
      }
      grid.append(row);
    }
  }

  function paintGrid() {
    const f = d.fields[sel];
    for (let i = 0; i < cells.length; i++) {
      const fi = fieldAt(i);
      const fld = fi >= 0 ? d.fields[fi] : null;
      const inSel = f && f.len > 0 && i >= f.off && i < f.off + f.len;
      const cls = ["fd-b"];
      if (fld) cls.push(`fd-l-${fld.layer}`);
      if (fld && fld.off === i) cls.push("fd-start");
      if (fld && (fld.status === "bad" || fld.status === "warn")) cls.push("fd-flag");
      if (inSel) cls.push("fd-sel");
      if (d.dir === "tx" && d.strip === LEGACY_HDR_LEN && i >= LEGACY_HDR_LEN && i < HDR_LEN) cls.push("fd-moved");
      cells[i].className = cls.join(" ");
      cells[i].setAttribute("tabindex", i === focusByte ? "0" : "-1");
      // One selected cell (the focused one, when it lies in the chosen field); the whole field
      // is described by the detail panel, so no multi-selection is claimed.
      cells[i].setAttribute("aria-selected", inSel && i === focusByte ? "true" : "false");
      cells[i].setAttribute("aria-label", cellLabel(i));
    }
  }

  function renderDetail() {
    detail.replaceChildren();
    const f = d.fields[sel];
    if (!f) return;
    const end = f.len > 0 ? `${f.off} to ${f.off + f.len - 1}` : `${f.off}`;
    detail.append(
      h(HN, { class: "fd-h", text: `${LAYERS[f.layer]}: ${f.name}` }),
      h("p", { class: "fd-mono", text: `bytes ${end} (${f.len} byte${f.len === 1 ? "" : "s"})${f.hex && f.len <= 16 ? `: ${f.hex}` : ""}` }),
      h("p", { text: `Value: ${f.value}` }),
    );
    if (f.check || f.status !== "ok") detail.append(h("p", { class: `fd-status fd-status--${f.status}`, text: `${CHECK_TEXT[f.status]}: ${f.check || f.status}` }));
    if (f.note) detail.append(h("p", { class: "fd-note", text: f.note }));
  }

  function renderTable() {
    tableBody.replaceChildren();
    tableRows = [];
    d.fields.forEach((f, i) => {
      const btn = h("button", { type: "button", class: "fd-link", text: String(f.off), "aria-label": `Select ${f.name} at offset ${f.off}` });
      btn.addEventListener("click", () => { selectField(i); });
      const shown = f.len > 16 ? `${f.hex.split(" ").slice(0, 8).join(" ")} ... (${f.len})` : f.hex;
      const tr = h("tr", { class: i === sel ? "fd-current" : "" },
        h("td", {}, btn),
        h("td", { text: LAYERS[f.layer] }),
        h("td", { text: f.name }),
        h("td", { class: "fd-mono", text: shown }),
        h("td", { text: f.value }),
        h("td", { class: `fd-status fd-status--${f.status}`, text: f.check || (f.status === "ok" ? "" : CHECK_TEXT[f.status]) }));
      tableRows.push(tr);
      tableBody.append(tr);
    });
  }

  // Selection only moves the highlight: the rows (and the button that may hold focus) stay.
  function markTableRow() {
    tableRows.forEach((tr, i) => tr.classList.toggle("fd-current", i === sel));
  }

  function renderVerdicts() {
    const tx = d.dir === "tx";
    devTitle.textContent = tx ? "macvmm's device, transmitting" : "macvmm's device, receiving";
    devText.textContent = d.device.text;
    devWarn.textContent = d.device.warn || "";
    devWarn.hidden = !d.device.warn;
    const peer = VMS[d.to];
    peerTitle.hidden = !d.peerDevice;
    peerText.hidden = !d.peerDevice;
    if (d.peerDevice) {
      peerTitle.textContent = `${peer.name}'s device, receiving it`;
      peerText.textContent = d.peerDevice.text + (d.peerDevice.warn ? ` ${d.peerDevice.warn}` : "");
    }
    guestTitle.textContent = `${peer.name}'s guest`;
    guestText.textContent = d.guest.text;
  }

  function renderShift() {
    const on = d.dir === "tx" && d.strip === LEGACY_HDR_LEN;
    shiftBox.hidden = !on;
    if (!on) return;
    shiftBody.replaceChildren();
    for (const r of shiftRows(bytes, LEGACY_HDR_LEN)) {
      shiftBody.append(h("tr", {}, h("td", { text: r.range }), h("td", { text: r.what }),
        h("td", { class: "fd-mono", text: r.sent }), h("td", { class: "fd-mono", text: r.read })));
    }
    shiftRun.textContent = s.preset === "arp" ? LEGACY_RUN.text : "Every byte the receiver reads is the one two places earlier in what the driver wrote.";
  }

  function render({ rebuild = true, announce = true } = {}) {
    d = dissect(bytes, { dir: s.dir, strip: s.strip, to: s.to });
    if (sel >= d.fields.length) sel = 0;
    if (focusByte >= bytes.length) focusByte = Math.max(0, bytes.length - 1);
    presetSel.value = s.preset || CUSTOM;
    dirSel.value = s.dir;
    stripSel.value = String(s.strip);
    stripSel.disabled = s.dir !== "tx";
    toSel.value = s.to;
    const p = s.preset ? preset(s.preset) : null;
    sourceNote.textContent = p
      ? (p.source === "lesson" ? "These are the bytes chapter 19 prints." : "Built by this lab from the protocol rules, with correct checksums; no run recorded these bytes.")
      : `Your ${bytes.length} byte${bytes.length === 1 ? "" : "s"}.`;
    showMessage(message);
    stripBox.open = stripBox.open || s.strip === LEGACY_HDR_LEN;
    readout.textContent = summary(d);
    if (rebuild) buildGrid();
    paintGrid();
    renderDetail();
    renderTable();
    renderVerdicts();
    renderShift();
    const str = encodeShare(s);
    ctx.hash.set(str === "" ? null : str);
    if (announce) say(readout.textContent);
  }

  function showMessage(text, invalid = false) {
    msgEl.textContent = text;
    msgEl.hidden = !text;
    if (invalid) {
      hexIn.setAttribute("aria-invalid", "true");
      hexIn.setAttribute("aria-describedby", `${id}-hexhelp ${id}-msg`);
    } else {
      hexIn.removeAttribute("aria-invalid");
      hexIn.setAttribute("aria-describedby", `${id}-hexhelp`);
    }
  }

  function setBytesFromState() {
    bytes = stateBytes(s);
    setHexText(formatHexLines(bytes));
  }

  function setHexText(text) {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = null;
    hexIn.value = text;
    applied = text;
  }

  function selectField(i) {
    sel = i;
    const f = d.fields[i];
    if (f && f.len > 0) focusByte = f.off;
    paintGrid();
    renderDetail();
    markTableRow();
    if (f) say(`Selected ${LAYERS[f.layer]} ${f.name}: ${f.value}`);
  }

  function selectByte(i, focus) {
    if (i < 0 || i >= bytes.length) return;
    focusByte = i;
    const fi = fieldAt(i);
    if (fi >= 0) sel = fi;
    paintGrid();
    renderDetail();
    markTableRow();
    if (focus && cells[i]) cells[i].focus();
    // The cell's accessible name already gives offset, byte, layer and field; add the value.
    const f = d.fields[sel];
    if (f && fi >= 0) say(`Value: ${f.value}`);
  }

  // ---- events ---------------------------------------------------------------------------
  grid.addEventListener("keydown", (e) => {
    const n = bytes.length;
    if (!n) return;
    let i = focusByte;
    const rowStart = i - (i % ROW);
    switch (e.key) {
      case "ArrowRight": i = Math.min(n - 1, i + 1); break;
      case "ArrowLeft": i = Math.max(0, i - 1); break;
      case "ArrowDown": i = Math.min(n - 1, i + ROW); break;
      case "ArrowUp": i = Math.max(0, i - ROW); break;
      case "Home": i = e.ctrlKey ? 0 : rowStart; break;
      case "End": i = e.ctrlKey ? n - 1 : Math.min(n - 1, rowStart + ROW - 1); break;
      case "PageDown": i = Math.min(n - 1, i + 8 * ROW); break;
      case "PageUp": i = Math.max(0, i - 8 * ROW); break;
      default: return;
    }
    if (e.preventDefault) e.preventDefault();
    selectByte(i, true);
  });

  presetSel.addEventListener("change", () => {
    if (presetSel.value === CUSTOM) {
      s = { ...s, preset: null, bytes: [...bytes] };
      render({ rebuild: false });
      return;
    }
    const p = preset(presetSel.value);
    if (!p) return;
    s = { preset: p.id, bytes: null, dir: p.dir, strip: HDR_LEN, to: p.to };
    message = "";
    sel = 0;
    focusByte = 0;
    setBytesFromState();
    render();
  });
  dirSel.addEventListener("change", () => {
    s = { ...s, dir: dirSel.value === "rx" ? "rx" : "tx" };
    if (s.dir === "rx") s.strip = HDR_LEN;
    render();
  });
  stripSel.addEventListener("change", () => {
    s = { ...s, strip: stripSel.value === String(LEGACY_HDR_LEN) ? LEGACY_HDR_LEN : HDR_LEN };
    render();
  });
  toSel.addEventListener("change", () => {
    s = { ...s, to: VMS[toSel.value] ? toSel.value : "b" };
    render();
  });
  // The hex box applies after a pause in typing (or on change/blur), never on each keystroke:
  // half-typed bytes are not errors worth speaking, and each apply rebuilds the grid.
  let applied = hexIn.value;
  function applyHex() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = null;
    if (hexIn.value === applied) return;
    applied = hexIn.value;
    const r = parseHex(hexIn.value);
    if (r.error) {
      // msgEl is role=status, so it speaks this itself; no ctx.announce as well.
      message = "";
      showMessage(`Not applied: ${r.error}. The dissection below is of the last valid bytes.`, true);
      return;
    }
    message = "";
    bytes = r.bytes;
    const p = s.preset ? preset(s.preset) : null;
    const same = p && p.bytes.length === bytes.length && p.bytes.every((x, k) => x === bytes[k]);
    s = { ...s, preset: same ? p.id : null, bytes: same ? null : [...bytes] };
    render();
  }
  hexIn.addEventListener("input", () => {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(applyHex, APPLY_IDLE_MS);
  });
  hexIn.addEventListener("change", applyHex);
  hexIn.addEventListener("blur", applyHex);
  fixBtn.addEventListener("click", () => {
    const fixed = fixChecksums(bytes);
    const changed = fixed.some((x, k) => x !== bytes[k]);
    bytes = fixed;
    if (changed) s = { ...s, preset: null, bytes: [...bytes] };
    setHexText(formatHexLines(bytes));
    message = changed ? "Checksums recomputed." : "Nothing to fix: the checksums were already right (or there is no IPv4, ICMP or ICMPv6 here).";
    render();
  });
  resetBtn.addEventListener("click", () => {
    s = { ...DEFAULT };
    message = "";
    sel = 0;
    focusByte = 0;
    setBytesFromState();
    render();
  });
  shareBtn.addEventListener("click", async () => {
    render({ rebuild: false, announce: false });
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this state is in the address bar.");
    }
  });

  setHexText(formatHexLines(bytes));
  render({ announce: false });

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      if (applyTimer) clearTimeout(applyTimer);
      timer = null;
      applyTimer = null;
    },
  };
}
