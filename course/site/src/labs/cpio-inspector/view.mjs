// cpio-inspector view: renders what model.mjs computes and turns clicks into model calls. All the
// parsing lives in model.mjs; this file only builds DOM inside the element the lab shell hands
// us, with createElement and textContent (never innerHTML: names and file contents come from a
// file the reader dropped, which is hostile input). See course/site/LABS.md.
import {
  PRESETS, DEFAULT_PRESET, MAX_INPUT, MAX_PATCHES, FIELDS, HEADER,
  presetBytes, unpack, hostView, bootLog, initSource, rootfsRows, regions, hexRows, previewText,
  decodeMode, sniff, lsLine, summary, encodeShare, decodeShare, applyPatches, parseNumber, parseByte, hex,
  memberLabel, safeText, displayName,
} from "./model.mjs";
import { createDropZone } from "./dropzone.mjs";

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

const MAX_ROWS = 400;
const MAX_PARTS = 200; // parts of the buffer (members, zero runs) drawn in the strip and its list
const MAX_TABLES = 32; // member tables drawn
const MAX_ROWS_ALL = 2000; // entry rows drawn over all member tables
const DUMP_DATA = 160;
const BIG_INPUT = 1024 * 1024; // above this, say "Reading..." and yield before the analysis
const KIND_LABEL = { file: "file", dir: "directory", symlink: "symlink", chr: "char device", blk: "block device", fifo: "FIFO", sock: "socket", trailer: "trailer", cut: "cut short", bad: "bad header", other: "unknown" };
const STATUS_LABEL = { created: "created", replaced: "replaces an earlier entry", updated: "already there", ignored: "skipped", trailer: "end of archive", linked: "hard link", partial: "cut short", error: "unpacking stops", lab: "the lab stops here" };
const REGION_LABEL = { magic: "magic", field: "header field", name: "name + NUL", pad: "padding", data: "data", other: "other" };
const SITE = "/build-your-own/vmm/";
const LAB_URL = (name) => `${SITE}labs/${name}/`;
const PRIMER_URL = `${SITE}primers/cpio-initramfs/`;
// Where a boot-log line was seen on a real Mac: the lesson section that shows that capture.
const SEEN = {
  "captures/14-boot.txt": { text: "chapter 14's boot log", href: `${SITE}linux/linux-boot/#boot-it` },
  "captures/13-bad-magic-raw.txt": { text: "chapter 13's broken-initramfs boot", href: `${SITE}linux/loaders/#breaking-it-on-purpose` },
};
const fmt = (n) => n.toLocaleString("en-US");

export function mount(el, ctx) {
  const id = ctx.id;
  const shared = decodeShare(ctx.hash.get());
  const ui = {
    preset: shared ? shared.preset : DEFAULT_PRESET,
    patches: shared ? shared.patches : [],
    select: shared && shared.select ? shared.select : { member: 0, index: 0 },
    file: null, // { name, bytes } when the reader dropped a file
    message: "", messageKind: "err", invalid: null,
    revealed: !!shared, // a shared link opens on the answer it points at
  };
  let bytes = null;
  let res = null;
  let host = null;
  let rows = new Map(); // "member.index" -> { tr, btn } for the entries tables

  // ---- announcements: one channel (ctx.announce), about one call per 300 ms ------------------
  let lastSaid = 0;
  let pending = null;
  let timer = null;
  function announce(text) {
    const now = Date.now();
    if (now - lastSaid >= 300 && !timer) { lastSaid = now; ctx.announce(text); return; }
    pending = text;
    if (!timer) timer = setTimeout(flush, 300);
  }
  function flush() { timer = null; if (pending) { lastSaid = Date.now(); ctx.announce(pending); pending = null; } }

  // ---- first steps --------------------------------------------------------------------------
  const tryList = h("ol", { class: "ci-steps" },
    h("li", { text: "With both.cpio picked, answer the question below, then press Reveal. Compare \"What a host cpio tool shows\" with \"Entries\": the host tool stops at the first TRAILER!!!, the kernel carries on to the next member." }),
    h("li", { text: "Press Change byte with the values already filled in (offset 5, '8'). That is the primer's bad.cpio: read the boot log it leads to." }),
    h("li", { text: "Pick \"Miniature Alpine plus our /init\", then \"Overlay appended without padding\". Whose /init runs in each, and why does one missing padding byte change that?" }),
    h("li", { text: "Pick \"Miniature Alpine plus a new etc/motd\" and predict which motd wins before you reveal it." }),
  );
  const gloss = h("p", { class: "ci-note", text: "A member is one cpio archive inside the initramfs buffer, raw or compressed; the kernel unpacks every member in turn. newc is the cpio format Linux reads: text headers that start with 070701." });
  if (ctx.standalone) gloss.append(" New to cpio? Read the ", h("a", { href: PRIMER_URL, text: "cpio and initramfs primer" }), " first.");
  const intro = h("div", { class: "ci-try" }, h("p", { class: "ci-lead", text: "Try this" }), tryList, gloss);

  // ---- controls ---------------------------------------------------------------------------
  const presetSel = h("select", { id: `${id}-preset` });
  for (const p of PRESETS) presetSel.append(h("option", { value: p.key, text: p.label }));
  presetSel.append(h("option", { value: "file", text: "Your file", disabled: true }));
  const about = h("p", { class: "ci-note" });
  const predictBox = h("input", { id: `${id}-predict`, type: "checkbox", checked: true });
  predictBox.checked = true;
  const drop = createDropZone({
    id, maxBytes: MAX_INPUT, label: "Or drop a file here (an initramfs, a cpio archive, anything)",
    hint: "On a Mac, the file picker hides folders whose names start with a dot, such as .cache. Press Cmd+Shift+. (period) in the picker to show them.",
    onFile: (f) => { ui.file = f; ui.patches = []; ui.select = { member: 0, index: 0 }; ui.message = ""; ui.invalid = null; analyse(true); },
    onError: (m) => { setMessage(m, "err"); },
  });
  const offIn = h("input", { id: `${id}-off`, type: "text", autocomplete: "off", spellcheck: "false", value: "5", size: "10", inputmode: "text" });
  const byteIn = h("input", { id: `${id}-byte`, type: "text", autocomplete: "off", spellcheck: "false", value: "'8'", size: "6" });
  const patchBtn = h("button", { type: "submit", class: "ci-btn", text: "Change byte" });
  const undoBtn = h("button", { type: "button", class: "ci-btn", text: "Undo changes" });
  const patchList = h("p", { class: "ci-note" });
  const resetBtn = h("button", { type: "button", class: "ci-btn", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "ci-btn", text: "Copy link" });
  // The status region stays rendered (an element that appears and fills in the same tick is
  // often not spoken); only the text inside it changes.
  const msg = h("div", { class: "ci-status", role: "status", id: `${id}-msg` });

  const patchForm = h("form", { class: "ci-row", "aria-label": "Change one byte" },
    h("div", { class: "ci-field" }, h("label", { for: `${id}-off`, text: "Offset" }), offIn),
    h("div", { class: "ci-field" }, h("label", { for: `${id}-byte`, text: "New byte" }), byteIn),
    h("div", { class: "ci-buttons" }, patchBtn, undoBtn),
  );

  const controls = h("div", { class: "ci-controls" },
    h("fieldset", { class: "ci-box" },
      h("legend", { text: "Archive" }),
      h("div", { class: "ci-field" }, h("label", { for: `${id}-preset`, text: "Sample" }), presetSel),
      about,
      h("div", { class: "ci-check" }, predictBox, h("label", { for: `${id}-predict`, text: "Predict first: hide the kernel's answer until I press Reveal" })),
      drop.node,
    ),
    h("fieldset", { class: "ci-box" },
      h("legend", { text: "Break a copy" }),
      h("p", { class: "ci-note", text: "Change one byte of the archive and watch what the kernel would say. Offsets count from 0; a decimal number, or hex with 0x. The byte can be a number or a quoted character such as '8'." }),
      patchForm,
      patchList,
      h("div", { class: "ci-buttons ci-buttons--end" }, resetBtn, copyBtn),
    ),
  );

  const readout = h("p", { class: "ci-readout", tabindex: "-1" });
  const hint = h("p", { class: "ci-hint", hidden: true });
  const question = h("p", { class: "ci-qtext" });
  const revealBtn = h("button", { type: "button", class: "ci-btn", text: "Reveal" });
  const questionBox = h("div", { class: "ci-question", hidden: true }, h("p", { class: "ci-lead", text: "Predict first" }), question, h("div", { class: "ci-buttons" }, revealBtn));

  // ---- sections ---------------------------------------------------------------------------
  const heads = {};
  const sec = (key, title, ...kids) => {
    const hid = `${id}-${key}`;
    heads[key] = h("h3", { id: hid, text: title, tabindex: "-1" });
    return h("section", { class: "ci-sec", "aria-labelledby": hid }, heads[key], ...kids);
  };
  // A scroll box a keyboard can reach: focusable, named, outlined on focus.
  const scroller = (label, child) => h("div", { class: "ci-scroll", tabindex: "0", role: "region", "aria-label": `${label} (scrolls sideways)` }, child);
  const stripBox = h("div", { class: "ci-stripbox" });
  const itemsList = h("ol", { class: "ci-items" });
  const entriesBox = h("div");
  const detailBox = h("div");
  const rootBox = h("div");
  const logBox = h("div");
  const hostBox = h("div");

  const answerSecs = [
    sec("buffer", "The buffer, as the kernel walks it", h("p", { class: "ci-note", text: "Members in the order the kernel meets them. A member is one cpio archive, raw or compressed; zero bytes between members are skipped." }), stripBox, itemsList),
    sec("entries", "Entries", entriesBox),
    sec("detail", "Selected entry", detailBox),
    sec("rootfs", "The rootfs after unpacking", rootBox),
    sec("log", "The boot log this leads to", logBox),
  ];
  const wrap = h("div", { class: "ci-wrap" },
    intro, controls, msg, readout, hint, questionBox,
    ...answerSecs,
    sec("host", "What a host cpio tool shows", hostBox),
  );
  el.replaceChildren(wrap);

  // ---- analysis ---------------------------------------------------------------------------
  function sourceBytes() {
    if (ui.file) return ui.file.bytes;
    return presetBytes(ui.preset);
  }
  function currentPreset() { return PRESETS.find((x) => x.key === ui.preset); }
  function hiding() {
    const p = currentPreset();
    return predictBox.checked && !ui.revealed && !ui.file && ui.patches.length === 0 && !!(p && p.question);
  }
  /** Re-read the buffer. `speak` is false only for the first run at mount. A big input gets a
   * "Reading..." status and one turn of the event loop first, so the page can show it. */
  function analyse(speak) {
    const base = sourceBytes();
    if (base.length > BIG_INPUT) {
      setMessage("Reading the file...", "ok");
      setTimeout(() => run(base, speak), 0);
      return;
    }
    run(base, speak);
  }
  function run(base, speak) {
    const p = applyPatches(base, ui.patches);
    ui.patches = p.applied;
    bytes = p.bytes;
    res = unpack(bytes);
    host = hostView(bytes);
    const m = res.members[ui.select.member];
    if (!m || !m.entries[ui.select.index]) ui.select = { member: 0, index: 0 };
    if (ui.message === "Reading the file...") ui.message = "";
    render();
    if (speak) announce(readout.textContent);
  }

  function streamOf(e) {
    if (e.stream === "input") return bytes;
    return res.members[e.member].data;
  }
  function selected() {
    const m = res.members[ui.select.member];
    return m ? m.entries[ui.select.index] || null : null;
  }
  /** Select an entry. The entries tables are updated in place, so the button that was pressed
   * keeps focus. With `go`, the view moves to the Selected entry section (for buttons far away). */
  function select(member, index, go = false) {
    const old = rows.get(`${ui.select.member}.${ui.select.index}`);
    if (old) { old.tr.classList.remove("ci-current"); old.btn.removeAttribute("aria-current"); }
    ui.select = { member, index };
    const now = rows.get(`${member}.${index}`);
    if (now) { now.tr.classList.add("ci-current"); now.btn.setAttribute("aria-current", "true"); }
    renderDetail();
    writeHash();
    const e = selected();
    if (go) {
      const head = heads.detail;
      if (typeof head.scrollIntoView === "function") head.scrollIntoView({ block: "start", behavior: ctx.reducedMotion ? "auto" : "smooth" });
      if (typeof head.focus === "function") head.focus({ preventScroll: true });
    }
    if (e) announce(entrySentence(e));
  }
  function entrySentence(e) {
    const what = e.nameDisplay != null ? `${e.nameDisplay}, ${KIND_LABEL[e.kind] || e.kind}` : KIND_LABEL[e.kind] || e.kind;
    const size = e.filesize != null ? `, ${fmt(e.filesize)} bytes` : "";
    return `Member ${e.member + 1}, entry ${e.index + 1}: ${what}${size}. ${e.outcome ? e.outcome.text : ""}`.trim();
  }
  function writeHash() {
    if (ui.file) { ctx.hash.set(null); return; }
    ctx.hash.set(encodeShare({ preset: ui.preset, patches: ui.patches, select: ui.select }));
  }
  function setMessage(text, kind = "err", invalid = null) {
    ui.message = text; ui.messageKind = kind; ui.invalid = invalid;
    renderMessage();
  }

  // ---- rendering --------------------------------------------------------------------------
  function render() {
    presetSel.value = ui.file ? "file" : ui.preset;
    const p = currentPreset();
    about.textContent = ui.file ? `${safeText(ui.file.name)}: ${fmt(ui.file.size)} bytes, read in this page only. A dropped file is never put in a shared link.` : p.about;
    patchList.textContent = ui.patches.length
      ? `Changed: ${ui.patches.map((x) => `byte ${x.off} (${hex(x.off)}) = ${hex(x.byte, 2)}${x.byte >= 0x20 && x.byte < 0x7f ? ` '${String.fromCharCode(x.byte)}'` : ""}`).join("; ")}.`
      : "";
    // Disabling the focused button would drop keyboard focus to <body>; move it to the Offset
    // box first, so the reader stays in the form.
    if (ui.patches.length === 0 && document.activeElement === undoBtn) offIn.focus();
    undoBtn.disabled = ui.patches.length === 0;
    const hide = hiding();
    questionBox.hidden = !hide;
    question.textContent = hide ? p.question : "";
    for (const s of answerSecs) s.hidden = hide;
    // While hiding, say nothing the kernel worked out (not even how many members it found).
    if (hide) readout.textContent = `${fmt(res.length)} bytes. The kernel's answer is hidden until you press Reveal.`;
    else readout.textContent = summary(res, host);
    const s = sniff(bytes);
    hint.hidden = !s.lab;
    hint.replaceChildren();
    if (s.lab) hint.append(`This looks like ${s.label}, not an initramfs. The kernel would refuse it as shown below; to read its header, open it in `, h("a", { href: LAB_URL(s.lab), text: s.lab }), ".");
    renderMessage();
    renderStrip();
    renderEntries();
    renderDetail();
    renderRootfs();
    renderLog();
    renderHost();
    writeHash();
  }
  function renderMessage() {
    msg.replaceChildren();
    if (ui.message) msg.append(h("p", { class: `ci-msg ci-msg--${ui.messageKind}`, text: ui.message }));
    for (const input of [offIn, byteIn]) {
      if (ui.invalid === input) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", `${id}-msg`); }
      else { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); }
    }
  }

  function renderStrip() {
    const total = Math.max(1, res.length);
    const bar = h("ol", { class: "ci-strip", "aria-hidden": "true" });
    // A hostile file can have a thousand members and a zero run after every entry: draw the
    // first MAX_PARTS parts and say how many were left out.
    const parts = res.items.filter((it) => it.type !== "stop");
    const hiddenParts = Math.max(0, parts.length - MAX_PARTS);
    for (const it of parts.slice(0, MAX_PARTS)) {
      const w = Math.max(2, ((it.end - it.start) / total) * 100);
      const cls = it.type === "member" ? `ci-seg ci-seg--${res.members[it.member].kind === "newc" ? "raw" : "comp"}` : it.type === "zeros" ? "ci-seg ci-seg--zero" : "ci-seg ci-seg--junk";
      const label = it.type === "member" ? `${it.member + 1}` : it.type === "zeros" ? "0" : "!";
      const seg = h("li", { class: cls, text: label });
      seg.style.flexGrow = String(w);
      bar.append(seg);
    }
    stripBox.replaceChildren(bar);
    itemsList.replaceChildren();
    // The same first MAX_PARTS parts, then the message the kernel stopped with, if any.
    for (const it of parts.slice(0, MAX_PARTS).concat(res.items.filter((x) => x.type === "stop"))) {
      if (it.type === "member") {
        const m = res.members[it.member];
        const trailers = m.entries.filter((e) => e.kind === "trailer").length;
        const n = m.entries.filter((e) => !["trailer", "cut", "bad"].includes(e.kind)).length;
        let text = `Member ${m.index + 1}: bytes ${fmt(it.start)} to ${fmt(Math.max(it.start, it.end - 1))}, `;
        if (m.kind === "newc") text += `${memberLabel(m)}, ${n} entr${n === 1 ? "y" : "ies"}, ${trailers ? `${trailers} TRAILER!!!` : "no trailer"}.`;
        else if (m.gzip) {
          text += `gzip (${fmt(it.end - it.start)} bytes, ${fmt(m.data.length)} once decompressed), ${n} entr${n === 1 ? "y" : "ies"}, ${trailers ? `${trailers} TRAILER!!!` : "no trailer"}.`;
          if (m.gzip.crcOk === false) text += " Its CRC-32 does not match, which the kernel does not check.";
          if (m.gzip.unskipped && m.gzip.unskipped.length) text += ` Header fields the kernel does not skip: ${m.gzip.unskipped.join(", ")}.`;
        } else text += `${m.kind}-compressed; the lab cannot look inside.`;
        const btn = h("button", { type: "button", class: "ci-link ci-link--big", text: "Show its first entry" });
        btn.addEventListener("click", () => { if (m.entries.length) select(m.index, 0, true); });
        itemsList.append(h("li", {}, text, " ", m.entries.length ? btn : null));
      } else if (it.type === "zeros") {
        itemsList.append(h("li", { class: "ci-muted", text: `${fmt(it.end - it.start)} zero byte${it.end - it.start === 1 ? "" : "s"} at ${fmt(it.start)}: skipped.` }));
      } else if (it.type === "junk") {
        itemsList.append(h("li", { class: "ci-bad", text: `At ${fmt(it.start)}: ${it.why}, which is neither a header nor a known compressor. The kernel stops here.` }));
      } else if (it.type === "stop") {
        itemsList.append(h("li", { class: "ci-bad", text: `Initramfs unpacking failed: ${it.message}` }));
      }
    }
    if (hiddenParts) itemsList.append(h("li", { class: "ci-muted", text: `${fmt(hiddenParts)} more part${hiddenParts === 1 ? "" : "s"} of the buffer (members and runs of zero bytes) not listed: the list shows the first ${MAX_PARTS}.` }));
    if (res.labStop) itemsList.append(h("li", { class: "ci-warn", text: res.labStop }));
    for (const n of res.notes) itemsList.append(h("li", { class: "ci-warn", text: n }));
  }

  function renderEntries() {
    entriesBox.replaceChildren();
    rows = new Map();
    if (!res.members.length) { entriesBox.append(h("p", { class: "ci-note", text: "No entries: the kernel never found a cpio header." })); return; }
    let rowsLeft = MAX_ROWS_ALL;
    for (const m of res.members.slice(0, MAX_TABLES)) {
      const table = h("table", { class: "ci-table" });
      table.append(h("caption", { text: `Member ${m.index + 1} (${memberLabel(m)}). Offsets are ${m.kind === "newc" ? "in the file" : "in the decompressed stream"}.` }));
      // Column order puts what teaches first (name, then the kernel's action); on a narrow screen
      // style.css turns each row into a card, labelled from data-label.
      table.classList.add("ci-cards");
      const COLS = ["#", "name", "what the kernel does", "type", "size", "mode", "offset"];
      table.append(h("thead", {}, h("tr", {}, ...COLS.map((t) => h("th", { scope: "col", text: t })))));
      const body = h("tbody");
      const shown = m.entries.slice(0, Math.min(MAX_ROWS, rowsLeft));
      rowsLeft -= shown.length;
      for (const e of shown) {
        const isSel = ui.select.member === m.index && ui.select.index === e.index;
        const nameBtn = h("button", { type: "button", class: "ci-link", "aria-current": isSel ? "true" : null, text: e.nameDisplay != null ? (e.nameDisplay || "(empty)") : `(${KIND_LABEL[e.kind] || e.kind})` });
        nameBtn.addEventListener("click", () => select(m.index, e.index));
        let what = STATUS_LABEL[e.outcome ? e.outcome.status : ""] || "";
        if (e.overwrittenBy) what += `; replaced later by member ${e.overwrittenBy.member + 1}, entry ${e.overwrittenBy.index + 1}`;
        const mode = e.kind === "trailer" ? "(none)" : e.mode != null ? decodeMode(e.mode).ls : "";
        const tr = h("tr", { class: `${isSel ? "ci-current" : ""} ${e.overwrittenBy ? "ci-gone" : ""} ${e.outcome && (e.outcome.status === "error") ? "ci-errrow" : ""}`.trim() || null },
          h("td", { "data-label": "#", text: String(e.index + 1) }),
          h("td", { "data-label": "name", class: "ci-namecell" }, nameBtn),
          h("td", { "data-label": "what the kernel does", class: "ci-what", text: what }),
          h("td", { "data-label": "type", text: KIND_LABEL[e.kind] || e.kind }),
          h("td", { "data-label": "size", class: "ci-mono", text: e.filesize != null ? fmt(e.filesize) : "" }),
          h("td", { "data-label": "mode", class: "ci-mono", text: mode }),
          h("td", { "data-label": "offset", class: "ci-mono", text: fmt(e.off) }),
        );
        rows.set(`${m.index}.${e.index}`, { tr, btn: nameBtn });
        body.append(tr);
      }
      table.append(body);
      entriesBox.append(scroller(`Entries of member ${m.index + 1}`, table));
      if (m.entries.length > shown.length) entriesBox.append(h("p", { class: "ci-note", text: `Showing the first ${shown.length} of ${fmt(m.entries.length)} entries in this member.` }));
    }
    if (res.members.length > MAX_TABLES) entriesBox.append(h("p", { class: "ci-note", text: `Showing the first ${MAX_TABLES} of ${fmt(res.members.length)} members.` }));
  }

  function renderDetail() {
    detailBox.replaceChildren();
    const e = selected();
    if (!e) { detailBox.append(h("p", { class: "ci-note", text: "Pick an entry above." })); return; }
    const buf = streamOf(e);
    detailBox.append(h("p", { class: "ci-lead", text: entrySentence(e) }));
    if (e.kernelPrints) detailBox.append(h("p", { class: "ci-term", text: e.kernelPrints }));
    for (const n of e.notes || []) detailBox.append(h("p", { class: "ci-note", text: n }));
    if (e.fields) {
      const t = h("table", { class: "ci-table ci-cards" },
        h("caption", { text: `The 110-byte header at ${fmt(e.off)}: the magic ${e.magic}, then 13 fields of 8 hex digits.` }),
        h("thead", {}, h("tr", {}, ...["field", "meaning", "value", "characters", "offset"].map((x) => h("th", { scope: "col", text: x })))));
      const b = h("tbody");
      e.fields.forEach((f, i) => {
        let meaning = FIELDS[i].meaning;
        if (f.name === "c_mode") { const d = decodeMode(e.mode); meaning = `${d.octal} octal: ${d.typeName} (${d.typeOctal}), permissions ${d.perms} = ${d.rwx}`; }
        if (f.name === "c_namesize") meaning = `${f.value} bytes: the name and its NUL; data starts ${HEADER} + ${f.value} rounded up to 4 = ${fmt(e.dataOff - e.off)} bytes into the entry`;
        if (f.name === "c_filesize") meaning = `${fmt(f.value)} bytes of ${e.kind === "symlink" ? "link target" : "data"}; the next header is at ${fmt(e.nextHeader)}`;
        if (!f.clean) meaning += ". Not all hex digits: the kernel reads up to the first one that is not";
        b.append(h("tr", {},
          h("th", { scope: "row", class: "ci-mono", "data-label": "field", text: f.name }),
          h("td", { "data-label": "meaning", class: "ci-what", text: meaning }),
          h("td", { class: "ci-mono", "data-label": "value", text: `${hex(f.value)} = ${fmt(f.value)}` }),
          h("td", { class: "ci-mono", "data-label": "characters", text: f.raw.replace(/[^\x20-\x7e]/g, "?") }),
          h("td", { class: "ci-mono", "data-label": "offset", text: String(f.off) })));
      });
      t.append(b);
      detailBox.append(scroller("Header fields", t));
    }
    // Regions table: the text version of the coloured dump (which screen readers skip).
    const regs = regions(e);
    if (regs.length) {
      const named = regs.filter((r) => r.kind !== "field");
      const head = { kind: "field", from: e.off + 6, to: e.off + HEADER, label: "the 13 fields" };
      const parts = e.kind === "bad" ? regs : [named[0], head, ...named.slice(1)];
      const t = h("table", { class: "ci-table" },
        h("caption", { text: "Where each part sits (offsets in decimal, inclusive). This table is the text version of the hex dump below." }),
        h("thead", {}, h("tr", {}, ...["offsets", "bytes", "what"].map((x) => h("th", { scope: "col", text: x })))));
      const b = h("tbody");
      for (const r of parts) {
        const n = r.to - r.from;
        const show = [...buf.subarray(r.from, Math.min(r.to, r.from + 6))].map((x) => x.toString(16).padStart(2, "0")).join(" ") + (n > 6 ? " ..." : "");
        b.append(h("tr", {},
          h("td", { class: "ci-mono", text: n === 1 ? fmt(r.from) : `${fmt(r.from)} to ${fmt(r.to - 1)}` }),
          h("td", { class: "ci-mono", text: r.from >= buf.length ? "(missing)" : show }),
          h("td", {}, h("span", { class: `ci-key ci-r-${r.kind}`, "aria-hidden": "true" }), ` ${r.label} (${fmt(n)} byte${n === 1 ? "" : "s"})`)));
      }
      if (e.nextHeader != null) b.append(h("tr", {}, h("td", { class: "ci-mono", text: `${fmt(e.nextHeader)} onward` }), h("td", { class: "ci-mono", text: e.nextHeader < buf.length ? [...buf.subarray(e.nextHeader, e.nextHeader + 4)].map((x) => x.toString(16).padStart(2, "0")).join(" ") + " ..." : "(end)" }), h("td", { text: "the next header" })));
      t.append(b);
      detailBox.append(scroller("Where each part sits", t));
      // The dump: visual only; the table above carries the same facts in words.
      const end = Math.min(e.nextHeader ?? e.off + HEADER, (e.dataOff ?? e.off + HEADER) + DUMP_DATA);
      const legend = h("ul", { class: "ci-legend", "aria-hidden": "true" });
      for (const k of ["magic", "field", "name", "pad", "data"]) legend.append(h("li", {}, h("span", { class: `ci-key ci-r-${k}` }), ` ${REGION_LABEL[k]}`));
      const dump = h("div", { class: "ci-dump" });
      for (const row of hexRows(buf, e.off, end, regs)) {
        const line = h("div", { class: "ci-dumprow" }, h("span", { class: "ci-dumpoff", text: `0x${row.off.toString(16).padStart(6, "0")}` }));
        const ascii = h("span", { class: "ci-ascii" });
        for (const c of row.cells) {
          if (!c) { line.append(h("span", { class: "ci-byte ci-byte--none", text: "  " })); ascii.append(h("span", { text: " " })); continue; }
          const cls = `ci-byte ci-r-${c.kind}${c.kind === "field" && c.field % 2 ? " ci-r-field--odd" : ""}`;
          line.append(h("span", { class: cls, text: c.byte.toString(16).padStart(2, "0") }));
          ascii.append(h("span", { class: `ci-r-${c.kind}`, text: c.byte >= 0x20 && c.byte < 0x7f ? String.fromCharCode(c.byte) : "." }));
        }
        line.append(ascii);
        dump.append(line);
      }
      // The scroller is focusable so a keyboard can scroll it at 360px; the dump inside stays
      // hidden from screen readers, and the label says the table above has the same facts.
      dump.setAttribute("aria-hidden", "true");
      detailBox.append(legend,
        h("p", { class: "ci-note", text: `Row offsets in the dump are hexadecimal: 0x70 = 112. The first row starts at 0x${(e.off - (e.off % 16)).toString(16)} = ${fmt(e.off - (e.off % 16))}.` }),
        h("div", { class: "ci-scroll ci-scroll--dump", tabindex: "0", role: "region", "aria-label": "Hex dump (visual; the table above has the same facts)" }, dump));
      if (e.nextHeader != null && end < e.nextHeader) detailBox.append(h("p", { class: "ci-note", text: `${fmt(e.nextHeader - end)} more bytes to the next header are not shown.` }));
    }
    if (e.kind === "file" && e.dataOff != null && e.filesize > 0) {
      const data = buf.subarray(e.dataOff, Math.min(buf.length, e.dataOff + e.filesize));
      const p = previewText(data, 2048);
      detailBox.append(h("p", { class: "ci-note", text: "The file's contents, as text (other bytes shown as \\xNN):" }), h("pre", { class: "ci-term", tabindex: "0", "aria-label": "File contents" }, p.text));
      if (p.more > 0) detailBox.append(h("p", { class: "ci-note", text: `${fmt(p.more)} more bytes not shown.` }));
    }
  }

  function renderRootfs() {
    rootBox.replaceChildren();
    const src = initSource(res);
    const list = rootfsRows(res);
    if (res.labStop) rootBox.append(h("p", { class: "ci-warn", text: "Incomplete: the lab could not follow the whole buffer." }));
    if (src && src.src && !src.src.builtin) {
      const btn = h("button", { type: "button", class: "ci-link ci-link--big", text: `member ${src.src.member + 1}, entry ${src.src.index + 1}` });
      btn.addEventListener("click", () => select(src.src.member, src.src.index, true));
      rootBox.append(h("p", { class: "ci-lead" }, `/init${src.viaSymlink ? ` (a symlink to ${src.path})` : ""} is ${fmt(src.size)} bytes, written by `, btn, "."));
    } else {
      rootBox.append(h("p", { class: "ci-lead", text: "There is no /init in the rootfs." }));
    }
    const t = h("table", { class: "ci-table" },
      h("caption", { text: "Every path, after all members (built-in: the small archive inside Alpine's kernel, unpacked first)" }),
      h("thead", {}, h("tr", {}, ...["path", "mode", "size", "from"].map((x) => h("th", { scope: "col", text: x })))));
    const b = h("tbody");
    for (const r of list.slice(0, MAX_ROWS)) {
      let from;
      if (r.from === "built-in") from = "built-in";
      else if (r.from) {
        from = h("button", { type: "button", class: "ci-link", text: `member ${r.from.member + 1}, entry ${r.from.index + 1}` });
        const f = r.from;
        from.addEventListener("click", () => select(f.member, f.index, true));
      } else from = "";
      const shownPath = displayName(r.path);
      b.append(h("tr", {},
        h("td", { class: "ci-mono", text: r.target != null ? `${shownPath} -> ${displayName(r.target)}` : r.rdev ? `${shownPath} (${r.rdev[0]}:${r.rdev[1]})` : shownPath }),
        h("td", { class: "ci-mono", text: r.ls }),
        h("td", { class: "ci-mono", text: r.type === "dir" ? "" : fmt(r.size) }),
        h("td", {}, from)));
    }
    t.append(b);
    rootBox.append(scroller("Rootfs paths", t));
    if (list.length > MAX_ROWS) rootBox.append(h("p", { class: "ci-note", text: `Showing ${MAX_ROWS} of ${fmt(list.length)} paths.` }));
  }

  function noinitLead(log) {
    const f = log.failed;
    if (f && f.script && f.interp && f.err === -2) return `/init is chosen, but its first line asks for ${f.interp}, which is not in this rootfs. There is nothing to fall back to either, so the kernel panics.`;
    return "/init is chosen but cannot run, and there is nothing to fall back to.";
  }

  function renderLog() {
    logBox.replaceChildren();
    const log = bootLog(res);
    const list = h("ol", { class: "ci-log" });
    for (const l of log.lines) {
      const seen = SEEN[l.source];
      const src = h("span", { class: "ci-src" }, " (");
      if (seen) src.append("seen on a real Mac: ", h("a", { href: seen.href, text: seen.text }));
      else src.append(l.source === "lab" ? "the lab" : `from ${l.source}`);
      if (l.note) src.append(`. ${l.note}`);
      src.append(")");
      list.append(h("li", {}, h("code", { class: "ci-logline", text: l.text === "" ? "(empty line)" : l.text }), src));
    }
    const lead = {
      runs: "The kernel runs /init.",
      fallback: "/init fails; the kernel falls back to another program.",
      noinit: noinitLead(log),
      panic: "There is no usable /init, so the kernel looks for a disk and panics.",
      unknown: log.why === "pastEnd" ? "The lab cannot tell: the kernel reads past the end of the buffer." : "The lab cannot tell.",
    }[log.outcome];
    logBox.append(h("p", { class: "ci-lead", text: lead }));
    const p = currentPreset();
    if (!ui.file && ui.patches.length === 0 && p && p.caveat) logBox.append(h("p", { class: "ci-warn", text: p.caveat }));
    if (log.note) logBox.append(h("p", { class: "ci-note", text: log.note }));
    logBox.append(scroller("Boot log", list));
    logBox.append(h("p", { class: "ci-note", text: "Lines are in order; a real log has other kernel messages between them. Lines marked \"seen on a real Mac\" appear in the course's boot captures; \"from\" lines follow from the kernel source." }));
  }

  function renderHost() {
    hostBox.replaceChildren();
    if (!host.ok) { hostBox.append(h("p", { class: "ci-lead", text: host.text })); return; }
    const now = Math.floor(Date.now() / 1000);
    const tz = -new Date().getTimezoneOffset();
    hostBox.append(h("p", { class: "ci-note", text: `cpio -itv reads one ${host.format} archive and ${host.trailer ? `stops at its first TRAILER!!! (offset ${fmt(host.stoppedAt)}${host.format.startsWith("gzip") ? " of the decompressed stream" : ""})` : `stops at ${host.error}${host.error === "a damaged header" ? ` (offset ${fmt(host.stoppedAt)})` : ""}`}. Dates in your time zone.` }));
    let lines = host.items.slice(0, MAX_ROWS).map((x) => lsLine(x, { now, tzOffsetMin: tz })).join("\n");
    if (host.says) lines += `${lines ? "\n" : ""}${host.says}`;
    hostBox.append(h("pre", { class: "ci-term", tabindex: "0", "aria-label": "Host cpio listing" }, lines || "(nothing listed)"));
    if (host.items.length > MAX_ROWS) hostBox.append(h("p", { class: "ci-note", text: `First ${MAX_ROWS} of ${fmt(host.items.length)} lines.` }));
    const kernelFiles = res.entries.filter((e) => !["trailer", "cut", "bad"].includes(e.kind)).length;
    if (!hiding() && kernelFiles !== host.items.length) hostBox.append(h("p", { class: "ci-note", text: `The kernel met ${kernelFiles} entr${kernelFiles === 1 ? "y" : "ies"}; the host tool lists ${host.items.length}. Both follow their own rules: the host tool treats TRAILER!!! as the end of everything, the kernel as the end of one member.` }));
  }

  // ---- events -----------------------------------------------------------------------------
  presetSel.addEventListener("change", () => {
    if (presetSel.value === "file") return;
    ui.preset = presetSel.value; ui.file = null; ui.patches = []; ui.select = { member: 0, index: 0 }; ui.message = ""; ui.invalid = null; ui.revealed = false;
    analyse(true);
  });
  predictBox.addEventListener("change", () => { render(); announce(readout.textContent); });
  revealBtn.addEventListener("click", () => {
    ui.revealed = true;
    render();
    // Focus alone makes a screen reader read the summary; announcing it too would say it twice.
    if (typeof readout.focus === "function") readout.focus();
  });
  patchForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const off = parseNumber(offIn.value);
    const b = parseByte(byteIn.value);
    if (off === null || off >= bytes.length) { setMessage(`The offset must be a number from 0 to ${bytes.length - 1}.`, "err", offIn); return; }
    if (b === null) { setMessage("The byte must be 0 to 255 (0x00 to 0xff), or one character in quotes.", "err", byteIn); return; }
    if (ui.patches.length >= MAX_PATCHES && !ui.patches.some((x) => x.off === off)) { setMessage(`At most ${MAX_PATCHES} changed bytes; undo some first.`, "err", offIn); return; }
    ui.patches = ui.patches.filter((x) => x.off !== off).concat([{ off, byte: b }]);
    ui.message = ""; ui.invalid = null;
    analyse(true);
  });
  undoBtn.addEventListener("click", () => { ui.patches = []; ui.message = ""; ui.invalid = null; analyse(true); });
  resetBtn.addEventListener("click", () => {
    ui.preset = DEFAULT_PRESET; ui.file = null; ui.patches = []; ui.select = { member: 0, index: 0 }; ui.message = ""; ui.invalid = null; ui.revealed = false;
    analyse(true);
  });
  copyBtn.addEventListener("click", async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(window.location.href);
      setMessage(ui.file ? "Link copied. It opens the default sample: a dropped file stays on your machine." : "Link copied.", "ok");
    } catch {
      setMessage("Copy the address from the address bar; it holds this state.", "ok");
    }
  });

  analyse(false);
  return { destroy() { if (timer) clearTimeout(timer); timer = null; } };
}
