// elf-inspector view: renders the model's analysis and turns events into model steps.
//
// Inputs: a sample (two copies of the hello guest), an ELF file the reader opens or drops (read locally with
// File.arrayBuffer, never uploaded, refused above 16 MiB), byte patches (typed, or built by a "break one rule"
// preset) and the guest RAM size. Everything shown comes from model.mjs's analyze(); strings from the file reach
// the page only through textContent. DOM is built with createElement only.
import {
  SAMPLES,
  PRESETS,
  CHECKS,
  RAM_SIZES_MIB,
  MAX_FILE,
  MAX_PATCHES,
  initialState,
  step,
  encode,
  decode,
  analyze,
  buildSample,
  applyPatches,
  parsePatch,
  presetPatches,
  hex,
  hexu,
  hexPad,
  commas,
  flagsText,
  flagsWords,
} from "./model.mjs";

const ANNOUNCE_GAP_MS = 300;
const HEX_LINES = 16; // lines of 16 bytes in the hex window
// The first four checks read e_ident and the header length; macvmm's order for them differs from the primer's list.
const IDENT_CHECKS = new Set(["magic", "ident-len", "ident", "header-len"]);
// chapter 13's capture of this exact file (13-hello-elf.txt): the only run of an accepted file the lab can quote.
const RECORDED_RUN = ["exit: 0", "hello from guest, x0=0x40000000", "guest done"];

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

const STATUS_MARK = { pass: "✓ passed", fail: "✗ failed", "not reached": "– not reached" };

export function mount(el, ctx) {
  const pid = ctx.id;
  let state = decode(ctx.hash.get()) ?? initialState();
  let base = buildSample(state.sample); // the sample, or the bytes of a file the reader opened (never leaves this closure)
  let bytes = applyPatches(base, state.patches);
  let a = analyze(bytes, { ramMiB: state.ramMiB, sections: sampleSections() });
  let sel = null; // the selected byte range {off, len, label}
  let hexStart = 0; // first offset shown in the hex window
  let openPh = null; // program header whose fields are expanded
  let message = ""; // last input problem (file too big, bad patch)

  function sampleSections() {
    if (state.file) return true;
    return SAMPLES.find((s) => s.id === state.sample)?.sections !== false;
  }

  // ---- throttled announcements (about one per 300 ms; the last message wins) ----
  let lastSpoke = 0;
  let pendingTimer = null;
  let pendingText = "";
  function say(text) {
    pendingText = text;
    const now = Date.now();
    const wait = lastSpoke + ANNOUNCE_GAP_MS - now;
    if (wait <= 0 && pendingTimer === null) {
      lastSpoke = now;
      ctx.announce(text);
      return;
    }
    if (pendingTimer === null) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastSpoke = Date.now();
        ctx.announce(pendingText);
      }, Math.max(wait, 0));
    }
  }

  // ---------------------------------------------------------------- static controls
  const intro = h(
    "p",
    { class: "eli__help" },
    "Pick a sample or open an ELF file of your own (it is read in this browser tab and never uploaded). The lab decodes the ELF header and program headers, runs macvmm's loader checks in macvmm's order, and draws what lands in guest RAM. Then break one byte and watch which check catches it.",
  );

  const sampleSel = h("select", { id: `${pid}-sample`, class: "eli__select" });
  for (const s of SAMPLES) sampleSel.append(h("option", { value: s.id, text: s.label }));
  sampleSel.append(h("option", { value: "file", text: "your file", disabled: true }));
  const fileInput = h("input", { id: `${pid}-file`, class: "eli__file", type: "file" });
  const ramSel = h("select", { id: `${pid}-ram`, class: "eli__select" });
  for (const m of RAM_SIZES_MIB) ramSel.append(h("option", { value: String(m), text: m >= 1024 ? `${m / 1024} GiB` : `${m} MiB` }));
  const resetBtn = h("button", { type: "button", class: "eli__btn" }, "Reset");

  const sourceRow = h(
    "div",
    { class: "eli__controls" },
    h("div", { class: "eli__ctl" }, h("label", { class: "eli__label", for: `${pid}-sample` }, "Sample"), sampleSel),
    h("div", { class: "eli__ctl" }, h("label", { class: "eli__label", for: `${pid}-file` }, "Or open an ELF file (at most 16 MiB)"), fileInput),
    h("div", { class: "eli__ctl" }, h("label", { class: "eli__label", for: `${pid}-ram` }, "Guest RAM at 0x4000_0000"), ramSel),
    h("div", { class: "eli__ctl eli__ctl--end" }, resetBtn),
  );
  const dropHint = h("p", { class: "eli__hint" }, "You can also drop a file anywhere on this lab.");
  const sampleNote = h("p", { class: "eli__note" });

  // "Break one rule"
  const presetSel = h("select", { id: `${pid}-preset`, class: "eli__select" });
  presetSel.append(h("option", { value: "", text: "choose a broken byte..." }));
  for (const p of PRESETS) presetSel.append(h("option", { value: p.id, text: p.label }));
  const presetBtn = h("button", { type: "button", class: "eli__btn" }, "Apply");
  const predictSel = h("select", { id: `${pid}-predict`, class: "eli__select" });
  predictSel.append(h("option", { value: "", text: "no prediction" }));
  for (const c of CHECKS) predictSel.append(h("option", { value: c.id, text: c.title }));
  predictSel.append(h("option", { value: "none", text: "No check fails: it still loads" }));
  const predictOut = h("p", { class: "eli__predict" });
  const offIn = h("input", { id: `${pid}-off`, class: "eli__input eli__input--off", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "38", "aria-describedby": `${pid}-patch-err` });
  const valIn = h("input", { id: `${pid}-val`, class: "eli__input", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "ff ff", "aria-describedby": `${pid}-patch-err` });
  const patchErr = h("p", { id: `${pid}-patch-err`, class: "eli__err", role: "alert" });
  const patchForm = h(
    "form",
    { class: "eli__patch" },
    h("div", { class: "eli__ctl" }, h("label", { class: "eli__label", for: `${pid}-off` }, "Offset (hex)"), offIn),
    h("div", { class: "eli__ctl eli__ctl--grow" }, h("label", { class: "eli__label", for: `${pid}-val` }, "New bytes (hex)"), valIn),
    h("div", { class: "eli__ctl eli__ctl--end" }, h("button", { type: "submit", class: "eli__btn" }, "Patch")),
  );
  const patchList = h("ul", { class: "eli__patches", "aria-label": "Patches applied, in order" });
  const clearBtn = h("button", { type: "button", class: "eli__btn eli__btn--quiet" }, "Remove all patches");
  const breakBox = h(
    "fieldset",
    { class: "eli__break" },
    h("legend", { class: "eli__legend" }, "Break one rule"),
    h(
      "div",
      { class: "eli__controls" },
      h("div", { class: "eli__ctl eli__ctl--grow" }, h("label", { class: "eli__label", for: `${pid}-preset` }, "Preset"), presetSel),
      h("div", { class: "eli__ctl eli__ctl--grow" }, h("label", { class: "eli__label", for: `${pid}-predict` }, "Predict which check fails (optional)"), predictSel),
      h("div", { class: "eli__ctl eli__ctl--end" }, presetBtn),
    ),
    predictOut,
    h("p", { class: "eli__hint" }, "Or patch bytes yourself. Selecting a field in the tables below fills in its offset and current bytes. A patch overwrites bytes in place; it never makes the file longer."),
    patchForm,
    patchErr,
    patchList,
    clearBtn,
  );

  // ---------------------------------------------------------------- dynamic regions
  const summaryNode = h("p", { id: `${pid}-summary`, class: "eli__summary" });
  const verdict = h("div");
  const checksBox = h("section", { "aria-labelledby": `${pid}-checks-h` });
  const headerBox = h("section", { "aria-labelledby": `${pid}-hdr-h` });
  const phBox = h("section", { "aria-labelledby": `${pid}-ph-h` });
  const mapBox = h("section", { "aria-labelledby": `${pid}-map-h` });
  const secBox = h("section", { "aria-labelledby": `${pid}-sec-h` });

  // The hex view's frame and paging controls are built once, so focus and a typed offset survive every render;
  // renderHex only refills the grid and the readout.
  const hexReadout = h("p", { id: `${pid}-hex-readout`, class: "eli__readout" });
  const hexGrid = h("div", { class: "eli__hex" });
  const hexScroll = h("div", { class: "eli__scroll eli__hexscroll", role: "region", tabindex: "0", "aria-describedby": `${pid}-hex-readout` }, hexGrid);
  const hexPrev = h("button", { type: "button", class: "eli__btn" }, "Previous 256 bytes");
  const hexNext = h("button", { type: "button", class: "eli__btn" }, "Next 256 bytes");
  const goIn = h("input", { id: `${pid}-go`, class: "eli__input eli__input--off", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "10000" });
  const goForm = h("form", { class: "eli__go" }, h("label", { class: "eli__label", for: `${pid}-go` }, "Go to offset (hex)"), goIn, h("button", { type: "submit", class: "eli__btn" }, "Go"));
  const hexBox = h(
    "section",
    { "aria-labelledby": `${pid}-hex-h` },
    h("h3", { class: "eli__h", id: `${pid}-hex-h` }, "Hex view"),
    h("p", { class: "eli__hint" }, "Laid out like xxd: offset, 16 bytes, then the printable characters. Selected bytes are bold on a tinted background."),
    hexReadout,
    hexScroll,
    h("div", { class: "eli__controls" }, hexPrev, hexNext, goForm),
  );
  const notes = h(
    "details",
    { class: "eli__about" },
    h("summary", {}, "What this lab models, and what it leaves out"),
    h(
      "ul",
      {},
      h("li", { text: "The checks are a line-by-line port of macvmm's ELF loader (crates/vmm/src/loader/elf.rs) and of the ELF arm of its boot plan: same rules, same order, same messages, with the device-tree slot of 512 KiB at the start of RAM." }),
      h("li", { text: "Only 64-bit little-endian ELF files are decoded field by field. For a 32-bit or big-endian ELF file the lab shows the 16 identification bytes and stops, because the rest uses a different layout or byte order; for a file without the ELF magic it shows only the first 4 bytes." }),
      h("li", { text: "The elf primer lists the same checks with the length check first. macvmm reads the 16 identification bytes before it checks that the file holds the whole 64-byte header. Both orders are safe, because every read is bounds-checked." }),
      h("li", { text: "For an accepted file the lab stops where the loader stops: it does not run the guest. The one exception is the unchanged chapter 13 sample at 64 MiB, where it quotes the recorded run." }),
      h("li", { text: "The boot-plan lines leave out the device-tree line and the memory map: their contents depend on the device tree macvmm builds, not on the ELF file." }),
      h("li", { text: "The flat-binary size is what llvm-objcopy -O binary writes: from the lowest address that has file bytes to the end of the highest, with gaps filled with zeros." }),
      h("li", { text: "Section headers are decoded only to show the linker's view next to the loader's. The loader never reads them." }),
      h("li", { text: "A file you open stays in this tab. It is not put in the share link; patches to a sample are." }),
    ),
  );
  const status = h("p", { class: "eli__status", role: "status" });

  el.append(
    intro,
    sourceRow,
    dropHint,
    sampleNote,
    h("h3", { class: "eli__h", id: `${pid}-verdict-h` }, "Verdict"),
    summaryNode,
    verdict,
    checksBox,
    breakBox,
    headerBox,
    phBox,
    hexBox,
    mapBox,
    secBox,
    notes,
    status,
  );

  // ---------------------------------------------------------------- helpers
  function select(range) {
    sel = range;
    if (range) {
      const line = Math.floor(range.off / 16) * 16;
      if (line < hexStart || line >= hexStart + HEX_LINES * 16) hexStart = Math.max(0, line - 32);
      offIn.value = hex(range.off).slice(2);
      const n = Math.min(range.len, 16);
      valIn.value = Array.from(bytes.subarray(range.off, range.off + n), (v) => hexPad(v, 2)).join(" ");
    }
  }

  /** "e_phnum, 2 bytes at 0x38: 04 00": what the readout says about the selection, and what a click announces. */
  function selText() {
    if (!sel) return "";
    const shown = Array.from(bytes.subarray(sel.off, sel.off + Math.min(sel.len, 16)), (v) => hexPad(v, 2)).join(" ");
    return `${sel.label}, ${sel.len} byte${sel.len === 1 ? "" : "s"} at ${hex(sel.off)}: ${shown}${sel.len > 16 ? " ..." : ""}`;
  }

  function fieldButton(label, range, key, describe) {
    const pressed = sel && sel.off === range.off && sel.len === range.len;
    const b = h("button", { type: "button", class: "eli__fbtn", "data-key": key, "aria-pressed": pressed ? "true" : "false", "aria-label": describe || null }, label);
    b.addEventListener("click", () => {
      select({ ...range, label });
      render(false);
      say(selText());
    });
    return b;
  }

  // ---------------------------------------------------------------- renderers
  function renderVerdict() {
    summaryNode.textContent = a.summary;
    const what = state.file ? state.file.name : "hello";
    const cmd = `$ macvmm run --mem ${state.ramMiB >= 1024 ? `${state.ramMiB / 1024}G` : `${state.ramMiB}M`} --kernel ${what}`;
    const recorded = a.ok && !state.file && state.sample === "ch13" && state.patches.length === 0 && state.ramMiB === 64;
    let label = "What macvmm's loader reports";
    let lines;
    if (recorded) {
      label = "A recorded run of this exact file (chapter 13's capture)";
      lines = [`${cmd} --timeout 10`, ...RECORDED_RUN];
    } else if (a.ok) {
      lines = [cmd, `(loader: accepted; the vCPU would start at ${hexu(a.image.entry)}. What the guest then does is not modelled.)`];
    } else if (a.line) {
      lines = [cmd, `exit: ${a.exit}`, a.line]; // the capture's order: the exit status, then stderr
    } else {
      lines = [cmd, "(handed to the arm64 Image loader)"];
    }
    verdict.replaceChildren(h("p", { class: "eli__label" }, label), h("pre", { class: "eli__term" }, lines.join("\n")));
  }

  function renderChecks() {
    const ol = h("ol", { class: "eli__checks" });
    for (const c of a.checks) {
      ol.append(
        h(
          "li",
          { class: `eli__check eli__check--${c.status.replace(" ", "-")}` },
          h("span", { class: "eli__mark" }, STATUS_MARK[c.status]),
          h("span", { class: "eli__ctitle" }, c.title),
          h("span", { class: "eli__cdetail" }, c.detail),
        ),
      );
    }
    const failed = a.checks.find((c) => c.status === "fail");
    checksBox.replaceChildren(
      ...[
        h("h3", { class: "eli__h", id: `${pid}-checks-h` }, "The loader's checks, in macvmm's order"),
        failed && IDENT_CHECKS.has(failed.id)
          ? h("p", { class: "eli__hint" }, "macvmm reads the 16 identification bytes before it checks that the file holds the whole 64-byte header; the elf primer lists the length check first. Both orders are safe, because every read is bounds-checked.")
          : null,
        ol,
      ].filter(Boolean),
    );
  }

  function renderHeader() {
    const table = h("table", { class: "eli__table" });
    table.append(h("thead", {}, h("tr", {}, ...["Offset", "Field", "Bytes", "Value", "Meaning"].map((t) => h("th", { scope: "col", text: t })))));
    const tb = h("tbody");
    const failOff = a.error?.where?.off;
    for (const f of a.header) {
      const bad = !a.ok && f.off <= failOff && failOff < f.off + f.size;
      tb.append(
        h(
          "tr",
          { class: bad ? "eli__row--bad" : null },
          h("td", { class: "eli__mono" }, hex(f.off)),
          h("td", {}, fieldButton(f.name, { off: f.off, len: f.size }, `h-${f.off}`, `${f.name}, ${f.size} byte${f.size === 1 ? "" : "s"} at ${hex(f.off)}`)),
          h("td", { class: "eli__mono" }, f.present ? f.bytes : "missing"),
          h("td", { class: "eli__mono" }, f.present ? (f.size === 1 || f.size === 7 ? String(f.value) : hex(f.value)) : ""),
          h("td", {}, (bad ? "✗ " : "") + f.meaning),
        ),
      );
    }
    table.append(tb);
    headerBox.replaceChildren(
      ...[
        h("h3", { class: "eli__h", id: `${pid}-hdr-h` }, "ELF header (the first 64 bytes)"),
        h("p", { class: "eli__hint" }, "Multi-byte fields are little-endian: read the bytes right to left. Select a field to see it in the hex view."),
        h("div", { class: "eli__scroll" }, table),
        a.layoutNote ? h("p", { class: "eli__note" }, a.layoutNote) : null,
      ].filter(Boolean),
    );
  }

  function renderPhdrs() {
    const kids = [h("h3", { class: "eli__h", id: `${pid}-ph-h` }, "Program headers: the loader's to-do list")];
    const list = a.phdrs.list;
    if (a.phdrs.note) kids.push(h("p", { class: "eli__note" }, a.phdrs.note));
    if (list.length) {
      const trace = new Map(a.trace.map((t) => [t.index, t]));
      const table = h("table", { class: "eli__table" });
      table.append(h("thead", {}, h("tr", {}, ...["#", "Type", "Flags", "Offset", "VirtAddr", "PhysAddr", "FileSiz", "MemSiz", "Align", "Loader"].map((t) => h("th", { scope: "col", text: t })))));
      const tb = h("tbody");
      for (const p of list) {
        const t = trace.get(p.index);
        const verdictText = t ? (t.outcome === "loaded" ? "✓ loaded" : t.outcome === "skipped" ? `– skipped: ${t.why}` : `✗ ${t.why}`) : a.kind === "elf" && a.checks.find((c) => c.id === "segments").status === "not reached" ? "not reached" : "not read";
        const btn = h("button", { type: "button", class: "eli__fbtn", "data-key": `p-${p.index}`, "aria-expanded": openPh === p.index ? "true" : "false", "aria-label": `Program header ${p.index}, ${p.typeName}: show its 56 bytes and fields` }, String(p.index));
        btn.addEventListener("click", () => {
          openPh = openPh === p.index ? null : p.index;
          select({ off: p.off, len: 56, label: `program header ${p.index}` });
          render(false);
          say(selText());
        });
        tb.append(
          h(
            "tr",
            { class: t && t.outcome === "rejected" ? "eli__row--bad" : null },
            h("td", {}, btn),
            h("td", { class: "eli__mono" }, p.typeName),
            h("td", { class: "eli__mono" }, h("span", { "aria-hidden": "true" }, flagsText(p.flags)), h("span", { class: "eli__sr" }, flagsWords(p.flags))),
            h("td", { class: "eli__mono" }, hex(p.offset)),
            h("td", { class: "eli__mono" }, hex(p.vaddr)),
            h("td", { class: "eli__mono" }, hex(p.paddr)),
            h("td", { class: "eli__mono" }, hex(p.filesz)),
            h("td", { class: "eli__mono" }, hex(p.memsz)),
            h("td", { class: "eli__mono" }, hex(p.align)),
            h("td", {}, verdictText),
          ),
        );
      }
      table.append(tb);
      kids.push(h("p", { class: "eli__hint" }, "Select a row's number to see its 56 bytes and decode them field by field. Flags: R read, W write, E execute."), h("div", { class: "eli__scroll" }, table));
      const p = list.find((x) => x.index === openPh);
      if (p) {
        const ft = h("table", { class: "eli__table" });
        ft.append(h("caption", {}, `Program header ${p.index}, bytes ${hex(p.off)} to ${hex(p.off + 55)}`));
        ft.append(h("thead", {}, h("tr", {}, ...["Offset", "Field", "Bytes", "Value"].map((t) => h("th", { scope: "col", text: t })))));
        const fb = h("tbody");
        for (const f of p.fields) {
          fb.append(
            h(
              "tr",
              {},
              h("td", { class: "eli__mono" }, `${hex(f.off)} (+${f.off - p.off})`),
              h("td", {}, fieldButton(f.name, { off: f.off, len: f.size }, `pf-${f.off}`, `${f.name} of program header ${p.index}, ${f.size} bytes at ${hex(f.off)}`)),
              h("td", { class: "eli__mono" }, f.bytes),
              h("td", { class: "eli__mono" }, f.name === "p_type" ? `${p.typeName} (${f.value})` : f.name === "p_flags" ? `${f.value} = ${flagsWords(p.flags)}` : hex(f.value)),
            ),
          );
        }
        ft.append(fb);
        kids.push(h("div", { class: "eli__scroll" }, ft));
      }
    }
    phBox.replaceChildren(...kids);
  }

  function renderHex() {
    const len = bytes.length;
    const start = Math.min(hexStart, Math.max(0, Math.floor((len - 1) / 16) * 16));
    hexStart = start;
    const errR = a.ok || !a.error.where ? null : a.error.where;
    const inR = (r, i) => r && i >= r.off && i < r.off + r.len;
    const rows = [];
    for (let line = start; line < Math.min(len, start + HEX_LINES * 16); line += 16) {
      const row = h("div", { class: "eli__hexline" }, h("span", { class: "eli__hexoff" }, hexPad(line, 8) + ":"));
      let ascii = "";
      for (let i = line; i < line + 16; i++) {
        if (i >= len) {
          row.append(h("span", { class: "eli__byte" }, "  "));
          continue;
        }
        const v = bytes[i];
        const cls = ["eli__byte"];
        if (inR(sel, i)) cls.push("eli__byte--sel");
        if (inR(errR, i)) cls.push("eli__byte--err");
        if (state.patches.some((p) => i >= p.off && i < p.off + p.bytes.length)) cls.push("eli__byte--patched");
        row.append(h("span", { class: cls.join(" ") }, hexPad(v, 2)));
        ascii += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : ".";
      }
      row.append(h("span", { class: "eli__ascii" }, ascii));
      rows.push(row);
    }
    hexGrid.replaceChildren(...rows);
    hexScroll.setAttribute("aria-label", `Hex view, bytes ${hex(start)} to ${hex(Math.min(len, start + HEX_LINES * 16) - 1)}`);
    const active = globalThis.document.activeElement;
    hexPrev.disabled = start === 0;
    hexNext.disabled = start + HEX_LINES * 16 >= len;
    // A paging button that just became disabled cannot keep focus: hand it to the other one.
    if (active === hexPrev && hexPrev.disabled && !hexNext.disabled) hexNext.focus();
    if (active === hexNext && hexNext.disabled && !hexPrev.disabled) hexPrev.focus();
    const parts = [];
    if (sel) parts.push(`Selected: ${selText()}.`);
    if (errR) parts.push(`Dashed outline: the ${errR.len} byte${errR.len === 1 ? "" : "s"} at ${hex(errR.off)} that the failing check read.`);
    if (state.patches.length) parts.push("Underlined: bytes you patched.");
    hexReadout.textContent = parts.join(" ") || "Nothing selected. Select a field or a program header.";
  }

  function mapTable(caption, rows, isFile) {
    const t = h("table", { class: "eli__table" });
    t.append(h("caption", {}, caption));
    t.append(h("thead", {}, h("tr", {}, ...["From", "To", "Bytes", "What"].map((x) => h("th", { scope: "col", text: x })))));
    const tb = h("tbody");
    for (const r of rows) {
      let what = r.label;
      if (isFile && r.kind === "copy") {
        what = fieldButton(r.label, { off: Number(r.start), len: Number(r.end - r.start) }, `m-${r.start}`, `${r.label}, file bytes ${hex(r.start)} to ${hex(r.end)}`);
      }
      tb.append(h("tr", { class: `eli__map eli__map--${r.kind}` }, h("td", { class: "eli__mono" }, hex(r.start)), h("td", { class: "eli__mono" }, hex(r.end)), h("td", { class: "eli__mono" }, commas(r.end - r.start)), h("td", {}, what)));
    }
    t.append(tb);
    return h("div", { class: "eli__scroll" }, t);
  }

  function renderMap() {
    const kids = [h("h3", { class: "eli__h", id: `${pid}-map-h` }, "From file to guest RAM")];
    if (!a.ok) {
      kids.push(h("p", { class: "eli__note" }, "Nothing is copied: the loader validates every header before it writes a single byte, so a refused file leaves guest RAM untouched."));
    } else {
      const s = a.sizes;
      kids.push(
        h(
          "dl",
          { class: "eli__sizes" },
          h("dt", {}, "File"),
          h("dd", {}, `${commas(s.file)} bytes, everything the linker wrote`),
          h("dt", {}, "Flat binary"),
          h("dd", {}, `${commas(s.flat)} bytes, what objcopy -O binary keeps`),
          h("dt", {}, "Guest RAM"),
          h("dd", {}, `${commas(s.span)} bytes, ${hex(s.start)} to ${hex(s.end)}, including the zero-filled part`),
        ),
        h("div", { class: "eli__maps" }, mapTable("The file", a.map.file, true), mapTable("Guest RAM", a.map.memory, false)),
        h("p", { class: "eli__hint" }, "Only the copied rows travel; every byte marked zero-filled is written as zero by the loader, and the rest of the file stays behind."),
        h("p", { class: "eli__label" }, "What macvmm run --dry-run prints for it (device-tree line left out)"),
        h("pre", { class: "eli__term" }, a.plan.join("\n")),
      );
    }
    mapBox.replaceChildren(...kids);
  }

  function renderSections() {
    const kids = [h("h3", { class: "eli__h", id: `${pid}-sec-h` }, "Sections: the linker's view (never read by the loader)")];
    const s = a.sections;
    if (s.skipped) kids.push(h("p", { class: "eli__note" }, "This copy keeps only the bytes the primer prints, so its section table is zeros. Pick the chapter 13 sample to see real section names."));
    else if (s.note) kids.push(h("p", { class: "eli__note" }, s.note));
    if (s.list.length) {
      const t = h("table", { class: "eli__table" });
      t.append(h("thead", {}, h("tr", {}, ...["#", "Name", "Type", "Address", "Offset", "Size", "Flags", "Loaded?"].map((x) => h("th", { scope: "col", text: x })))));
      const tb = h("tbody");
      for (const x of s.list) {
        tb.append(
          h(
            "tr",
            {},
            h("td", {}, String(x.index)),
            h("td", { class: "eli__mono" }, x.name || "(none)"),
            h("td", { class: "eli__mono" }, x.typeName),
            h("td", { class: "eli__mono" }, hex(x.addr)),
            h("td", { class: "eli__mono" }, hex(x.offset)),
            h("td", { class: "eli__mono" }, hex(x.size)),
            h("td", { class: "eli__mono" }, x.flags),
            h("td", {}, x.loadedIn === null ? "not loaded" : `in segment ${x.loadedIn}`),
          ),
        );
      }
      t.append(tb);
      kids.push(h("details", { class: "eli__secs" }, h("summary", {}, `Show all ${s.list.length} section headers`), h("div", { class: "eli__scroll" }, t)));
    }
    secBox.replaceChildren(...kids);
  }

  function renderSource() {
    sampleSel.value = state.file ? "file" : state.sample;
    ramSel.value = String(state.ramMiB);
    const s = SAMPLES.find((x) => x.id === state.sample);
    sampleNote.textContent = state.file ? `Your file: ${state.file.name}, ${commas(state.file.size)} bytes. It stays in this tab and is not put in the share link.` : s.note;
    patchList.replaceChildren(
      ...state.patches.map((p, i) => {
        const rm = h("button", { type: "button", class: "eli__btn eli__btn--quiet", "data-key": `rm-${i}`, "aria-label": `Remove patch ${i + 1}` }, "Remove");
        rm.addEventListener("click", () => {
          update({ type: "unpatch", index: i }, true);
          // Focus the Remove button that slid into this place, or the one before it, or the offset field.
          const n = state.patches.length;
          const next = n ? el.querySelector(`[data-key="rm-${Math.min(i, n - 1)}"]`) : null;
          (next || offIn).focus();
          say(`Patch removed. ${a.summary}`);
        });
        return h("li", {}, h("span", { class: "eli__mono" }, `${hex(p.off)}: ${p.bytes.map((v) => hexPad(v, 2)).join(" ")}`), " ", rm);
      }),
    );
    clearBtn.disabled = state.patches.length === 0;
    status.textContent = message;
  }

  function render(recompute) {
    const active = globalThis.document.activeElement;
    const key = active && el.contains(active) ? active.getAttribute?.("data-key") : null;
    if (recompute) {
      bytes = applyPatches(base, state.patches);
      a = analyze(bytes, { ramMiB: state.ramMiB, sections: sampleSections() });
      if (!a.ok && a.error.where) select({ ...a.error.where, label: "the bytes the failing check read" });
      else if (sel && sel.off + sel.len > bytes.length) sel = null;
    }
    renderSource();
    renderVerdict();
    renderChecks();
    renderHeader();
    renderPhdrs();
    renderHex();
    renderMap();
    renderSections();
    if (key) {
      const again = el.querySelector(`[data-key="${key}"]`);
      if (again) again.focus();
    }
  }

  function update(action, quiet = false) {
    state = step(state, action);
    ctx.hash.set(encode(state));
    render(true);
    if (!quiet) say(a.summary);
  }

  // ---------------------------------------------------------------- events
  sampleSel.addEventListener("change", () => {
    if (sampleSel.value === "file") return;
    base = buildSample(sampleSel.value) ?? base;
    message = "";
    predictOut.textContent = "";
    openPh = null;
    sel = null;
    hexStart = 0;
    update({ type: "sample", id: sampleSel.value });
  });
  ramSel.addEventListener("change", () => update({ type: "ram", mib: Number(ramSel.value) }));
  hexPrev.addEventListener("click", () => {
    hexStart = Math.max(0, hexStart - HEX_LINES * 16);
    render(false);
  });
  hexNext.addEventListener("click", () => {
    hexStart += HEX_LINES * 16;
    render(false);
  });
  goForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const len = bytes.length;
    const t = String(goIn.value).trim().toLowerCase().replace(/_/g, "").replace(/^0x/, "");
    if (/^[0-9a-f]{1,8}$/.test(t) && parseInt(t, 16) < len) {
      hexStart = Math.floor(parseInt(t, 16) / 16) * 16;
      message = "";
    } else message = `Offsets run from 0 to ${hex(len - 1)}.`;
    render(false);
  });

  function clearPatchErr() {
    patchErr.textContent = "";
    offIn.removeAttribute("aria-invalid");
    valIn.removeAttribute("aria-invalid");
  }

  resetBtn.addEventListener("click", () => {
    base = buildSample("primer");
    message = "";
    openPh = null;
    sel = null;
    hexStart = 0;
    presetSel.value = "";
    predictSel.value = "";
    predictOut.textContent = "";
    offIn.value = "";
    valIn.value = "";
    goIn.value = "";
    clearPatchErr();
    update({ type: "reset" });
  });
  presetBtn.addEventListener("click", () => {
    if (!presetSel.value) {
      patchErr.textContent = "Choose a preset first.";
      return;
    }
    const p = presetPatches(presetSel.value, base);
    if (!p) {
      patchErr.textContent = "That preset needs a program-header layout this file does not have.";
      return;
    }
    clearPatchErr();
    update({ type: "preset", patches: p }, true);
    // Unscored: the prediction is only put next to what happened.
    const fired = a.checks.find((c) => c.status === "fail");
    const firedText = fired ? `caught by "${fired.title}"` : "no check fails: it still loads";
    const guess = predictSel.value;
    const guessText = guess === "none" ? "No check fails" : CHECKS.find((c) => c.id === guess)?.title;
    predictOut.textContent = guess ? `You predicted: ${guessText}. What happened: ${firedText}.` : `What happened: ${firedText}.`;
    say(`${predictOut.textContent} ${a.summary}`);
    // The verdict is above this box; on a narrow screen it is out of sight, so bring it into view.
    if (typeof summaryNode.scrollIntoView === "function") summaryNode.scrollIntoView({ block: "nearest", behavior: ctx.reducedMotion ? "auto" : "smooth" });
  });
  patchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.patches.length >= MAX_PATCHES) {
      patchErr.textContent = `At most ${MAX_PATCHES} patches. Remove one first.`;
      return;
    }
    const r = parsePatch(offIn.value, valIn.value, base.length);
    if (!r.ok) {
      clearPatchErr();
      patchErr.textContent = r.why;
      if (r.field !== "bytes") offIn.setAttribute("aria-invalid", "true");
      if (r.field !== "off") valIn.setAttribute("aria-invalid", "true");
      return;
    }
    clearPatchErr();
    update({ type: "patch", patch: r.patch });
  });
  clearBtn.addEventListener("click", () => {
    update({ type: "clear" }, true);
    offIn.focus(); // this button is now disabled
    say(`All patches removed. ${a.summary}`);
  });

  async function takeFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE) {
      message = `That file is ${commas(file.size)} bytes; this lab reads at most 16 MiB. Nothing was read.`;
      render(false); // the lab's own status region speaks it; no second announcement
      return;
    }
    let buf;
    try {
      buf = new Uint8Array(await file.arrayBuffer());
    } catch {
      message = "The browser could not read that file.";
      render(false);
      return;
    }
    base = buf;
    message = "";
    openPh = null;
    sel = null;
    hexStart = 0;
    update({ type: "file", name: file.name || "file", size: buf.length });
  }
  fileInput.addEventListener("change", () => takeFile(fileInput.files && fileInput.files[0]));
  el.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  el.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    takeFile(f);
  });

  if (!a.ok && a.error.where) select({ ...a.error.where, label: "the bytes the failing check read" });
  render(false);

  return {
    destroy() {
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = null;
    },
  };
}
