// image-inspector view: renders the model's analysis and turns events into model steps.
//
// Three ways to give it a file, all ending in the same model calls:
//   1. pick a Try preset (the two Alpine kernels and doctored copies of them);
//   2. drop a file or choose one: the view reads the first 4 KiB with File.slice() and then at
//      most four more windows of at most 4 KiB that the headers point at. The file is never
//      read whole, never uploaded, and its name is shown as text only;
//   3. paste xxd output (the first rows of `xxd -l 64 FILE`), parsed by the model.
// Then flip bytes in the 64-byte grid (roving tabindex; type two hex digits on a cell), edit a
// field, change the file length, the RAM size or the initrd, and read which check fails first.
// DOM is built with createElement/textContent only; no string from a file reaches markup.
import {
  BASES,
  TRIES,
  GRID,
  READ_WINDOW,
  MAX_EXTRA_READS,
  RAM_CHOICES_MIB,
  RAM_DEFAULT_MIB,
  RAM_BASE,
  ZBOOT_MAX_OUTPUT,
  makeView,
  analyze,
  step,
  encode,
  decode,
  initialState,
  summary,
  wantedRanges,
  parseXxd,
  parseNumber,
  barLayout,
  fieldAt,
  checkMarks,
  hx,
  toHex,
  ramError,
} from "./model.mjs";

const ANNOUNCE_GAP_MS = 300;
// The SVG namespace is a name, not a URL anything fetches (split so no URL literal ships).
const SVG_NS = ["http:", "/www.w3.org/2000/svg"].join("/");
const BAR_W = 1000;
const NAME_MAX = 80;

/** h("p", {class: "x"}, "text", child, ...). Attributes are set, never parsed. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  return fill(el, attrs, children);
}

function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  return fill(el, attrs, children);
}

function fill(el, attrs, children) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function code(text) {
  return h("code", { class: "ii__code", text });
}

/** The course base URL (`/build-your-own/vmm/`); the lab's assets live at `assets/labs/<name>/`. */
function courseBase(ctx) {
  for (const from of [ctx.base, import.meta.url]) {
    try {
      if (from) return new URL("../../../", from);
    } catch {
      // try the next one
    }
  }
  return null;
}

function hex2(b) {
  return b.toString(16).padStart(2, "0");
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function sizeWords(bytes) {
  const b = BigInt(bytes);
  const units = [
    [60n, "EiB"],
    [50n, "PiB"],
    [40n, "TiB"],
    [30n, "GiB"],
    [20n, "MiB"],
    [10n, "KiB"],
  ];
  for (const [shift, name] of units) {
    const one = 1n << shift;
    if (b < one) continue;
    if (b % one === 0n) return `${b >> shift} ${name}`;
    // Exact to one decimal place without converting a 64-bit value to a float first.
    const tenths = (b * 10n + one / 2n) / one;
    return `${tenths / 10n}.${tenths % 10n} ${name}`;
  }
  return `${b} bytes`;
}

export function mount(el, ctx) {
  const pid = ctx.id;
  let state = decode(ctx.hash.get()) ?? initialState();
  let custom = null; // {length, chunks, name, reads} for a dropped or pasted file
  let selected = 0;
  let pending = null; // first hex digit typed on a grid cell
  let readToken = 0;

  // ---- throttled announcements (about one per 300 ms; the last message wins) ----
  let lastSpoke = 0;
  let timer = null;
  let pendingText = "";
  function say(text) {
    pendingText = text;
    const wait = lastSpoke + ANNOUNCE_GAP_MS - Date.now();
    if (wait <= 0 && timer === null) {
      lastSpoke = Date.now();
      ctx.announce(text);
      return;
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        lastSpoke = Date.now();
        ctx.announce(pendingText);
      }, Math.max(wait, 0));
    }
  }

  // ---- source controls ----
  const tryId = `${pid}-try`;
  const trySel = h("select", { id: tryId, class: "ii__select" });
  trySel.append(h("option", { value: "", text: "Edited (no scenario)" }));
  for (const t of TRIES) trySel.append(h("option", { value: t.id, text: t.label }));
  const tryBox = h("div", { class: "ii__ctl" }, h("label", { class: "ii__label", for: tryId, text: "Try a scenario" }), trySel);

  const fileId = `${pid}-file`;
  const fileInput = h("input", { id: fileId, type: "file", class: "ii__fileinput" });
  const drop = h(
    "div",
    { class: "ii__drop" },
    h("label", { class: "ii__btn", for: fileId, text: "Choose a file" }),
    fileInput,
    h("span", { class: "ii__muted", text: " or drop one here. It is read in this tab only, a few KiB of it, and never uploaded." }),
  );

  const pasteId = `${pid}-paste`;
  const pasteErrId = `${pid}-paste-err`;
  const pasteArea = h("textarea", { id: pasteId, class: "ii__paste", rows: "5", spellcheck: "false", autocomplete: "off", "aria-describedby": pasteErrId });
  const pasteBtn = h("button", { type: "submit", class: "ii__btn", text: "Read the pasted rows" });
  const pasteErr = h("p", { class: "ii__err", id: pasteErrId });
  const pasteForm = h(
    "form",
    { class: "ii__pasteform", novalidate: true },
    h("label", { class: "ii__label", for: pasteId, text: "Paste xxd output" }),
    h("p", { class: "ii__muted ii__small", text: "For example the output of xxd -l 64 .cache/macvmm/Image-virt (plain xxd or xxd -p, not xxd -e)." }),
    pasteArea,
    h("div", { class: "ii__row" }, pasteBtn),
    pasteErr,
  );
  const pasteDetails = h("details", { class: "ii__details" }, h("summary", { text: "Paste a hex dump instead" }), pasteForm);

  // ---- settings ----
  const lenId = `${pid}-len`;
  const lenErrId = `${pid}-len-err`;
  const lenInput = h("input", { id: lenId, class: "ii__input", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "24", "aria-describedby": lenErrId });
  const lenForm = h(
    "form",
    { class: "ii__ctl", novalidate: true },
    h("label", { class: "ii__label", for: lenId, text: "File length (bytes)" }),
    h("div", { class: "ii__row" }, lenInput, h("button", { type: "submit", class: "ii__btn", text: "Set" })),
    h("p", { class: "ii__err", id: lenErrId }),
  );
  const lenErr = lenForm.children[2];

  const ramId = `${pid}-ram`;
  const ramSel = h("select", { id: ramId, class: "ii__select" });
  const ramBox = h("div", { class: "ii__ctl" }, h("label", { class: "ii__label", for: ramId, text: "Guest RAM (--mem)" }), ramSel);

  const rdId = `${pid}-rd`;
  const rdErrId = `${pid}-rd-err`;
  const rdInput = h("input", { id: rdId, class: "ii__input", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "24", "aria-describedby": rdErrId });
  const rdForm = h(
    "form",
    { class: "ii__ctl", novalidate: true },
    h("label", { class: "ii__label", for: rdId, text: "--initrd size (bytes; empty for none)" }),
    h("div", { class: "ii__row" }, rdInput, h("button", { type: "submit", class: "ii__btn", text: "Set" })),
    h("p", { class: "ii__err", id: rdErrId }),
  );
  const rdErr = rdForm.children[2];

  const resetBtn = h("button", { type: "button", class: "ii__btn", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "ii__btn", text: "Copy link" });
  const sourceLine = h("p", { class: "ii__source" });

  const controls = h(
    "div",
    { class: "ii__controls" },
    h("div", { class: "ii__ctlrow" }, tryBox, drop),
    pasteDetails,
    h("div", { class: "ii__ctlrow" }, lenForm, ramBox, rdForm, h("div", { class: "ii__ctl ii__buttons" }, resetBtn, copyBtn)),
    sourceLine,
  );

  // ---- the 64-byte grid ----
  const gridHelpId = `${pid}-gridhelp`;
  const grid = h("div", { class: "ii__grid", role: "group", "aria-label": "The first 64 bytes of the file", "aria-describedby": gridHelpId });
  const cells = [];
  for (let row = 0; row < GRID / 16; row++) {
    grid.append(h("span", { class: "ii__rowoff", "aria-hidden": "true", text: (row * 16).toString(16).padStart(8, "0") }));
    for (let col = 0; col < 16; col++) {
      const off = row * 16 + col;
      const btn = h("button", { type: "button", class: "ii__cell", "data-off": off, tabindex: off === 0 ? "0" : "-1" });
      cells.push(btn);
      grid.append(btn);
    }
  }
  const byteId = `${pid}-byte`;
  const byteErrId = `${pid}-byte-err`;
  const byteLabel = h("label", { class: "ii__label", for: byteId });
  const byteInput = h("input", { id: byteId, class: "ii__input ii__input--byte", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "4", "aria-describedby": byteErrId });
  const byteErr = h("p", { class: "ii__err", id: byteErrId });
  const byteForm = h(
    "form",
    { class: "ii__ctl", novalidate: true },
    byteLabel,
    h("div", { class: "ii__row" }, byteInput, h("button", { type: "submit", class: "ii__btn", text: "Set byte" })),
    byteErr,
  );
  const undoBtn = h("button", { type: "button", class: "ii__btn", text: "Undo all byte edits" });

  const fieldSelId = `${pid}-field`;
  const fieldValId = `${pid}-fieldval`;
  const fieldErrId = `${pid}-field-err`;
  const fieldSel = h("select", { id: fieldSelId, class: "ii__select" });
  for (const [v, t] of [
    ["image_size", "image_size (0x10)"],
    ["text_offset", "text_offset (0x08)"],
    ["flags", "flags (0x18)"],
  ]) {
    fieldSel.append(h("option", { value: v, text: t }));
  }
  const fieldVal = h("input", { id: fieldValId, class: "ii__input", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "24", "aria-describedby": fieldErrId });
  const fieldErr = h("p", { class: "ii__err", id: fieldErrId });
  const fieldForm = h(
    "form",
    { class: "ii__fieldform", novalidate: true },
    h("div", { class: "ii__ctl" }, h("label", { class: "ii__label", for: fieldSelId, text: "Header field" }), fieldSel),
    h(
      "div",
      { class: "ii__ctl" },
      h("label", { class: "ii__label", for: fieldValId, text: "New value (decimal or 0x hex)" }),
      h("div", { class: "ii__row" }, fieldVal, h("button", { type: "submit", class: "ii__btn", text: "Write field" })),
      fieldErr,
    ),
  );
  const fieldTable = h("div", { class: "ii__scroll" });

  const gridBox = h(
    "section",
    { class: "ii__panel", "aria-labelledby": `${pid}-gridtitle` },
    h("h3", { class: "ii__h", id: `${pid}-gridtitle`, text: "The first 64 bytes" }),
    h("p", {
      class: "ii__muted ii__small",
      id: gridHelpId,
      text: "Click a byte, or Tab into the grid and use the arrow keys. Type two hex digits on a byte to change it; Escape cancels. Edited bytes are underlined and marked with a dot; -- is past the end of the file, and ?? marks a byte this lab did not read.",
    }),
    h("div", { class: "ii__scroll" }, grid),
    h("div", { class: "ii__ctlrow" }, byteForm, h("div", { class: "ii__ctl ii__buttons" }, undoBtn)),
    fieldTable,
    fieldForm,
  );

  // ---- readout ----
  const sumLine = h("p", { class: "ii__summary", id: `${pid}-summary` });
  const readoutBody = h("div", { class: "ii__readoutbody" });
  const readout = h("section", { class: "ii__panel ii__readout", "aria-labelledby": `${pid}-readtitle` }, h("h3", { class: "ii__h", id: `${pid}-readtitle`, text: "Readout" }), sumLine, readoutBody);

  // Where the words come from: chapter 13's header table, the two primers and the glossary.
  const base = courseBase(ctx);
  const link = (path, text) => (base ? h("a", { href: new URL(path, base).href, text }) : text);
  const concepts = h(
    "p",
    { class: "ii__muted ii__small" },
    "Concepts you'll need: the Image header table in ",
    link("linux/loaders/", "chapter 13"),
    ", the ",
    link("primers/arm64-boot-protocol/", "arm64 boot protocol"),
    " and ",
    link("primers/efi-zboot/", "EFI zboot"),
    " primers, and the glossary entries for ",
    link("glossary/#image-size", "image_size"),
    ", ",
    link("glossary/#text-offset", "text_offset"),
    " and ",
    link("glossary/#bss", "BSS"),
    ".",
  );
  el.append(
    h("p", {
      class: "ii__muted",
      text: "The loader reads a kernel's header before anything runs, and every byte of it is hostile input. Pick a scenario or a file, change a byte, and see which of macvmm's checks fails first.",
    }),
  );
  // Embedded, the lesson's own "Concepts you'll need" box already says this.
  if (ctx.standalone) el.append(concepts);
  el.append(controls, h("div", { class: "ii__body" }, gridBox, readout));

  // ---- state changes ----
  function apply(action, quiet = false) {
    const next = step(state, action, custom);
    if (next === state) return false;
    state = next;
    pending = null;
    clearErrors();
    ctx.hash.set(encode(state));
    render();
    if (!quiet) say(sumLine.textContent);
    return true;
  }

  // Error messages stay until their own form succeeds or the state changes; moving around the
  // grid never clears them.
  function clearErrors() {
    for (const [msg, input] of [
      [lenErr, lenInput],
      [rdErr, rdInput],
      [byteErr, byteInput],
      [fieldErr, fieldVal],
      [pasteErr, pasteArea],
    ]) {
      msg.textContent = "";
      input.removeAttribute("aria-invalid");
    }
  }

  // ---- rendering ----
  let a = null;
  let barCount = 0;

  function render() {
    a = analyze(state, custom);
    const v = a.view;

    trySel.value = state.tryId ?? "";
    if (document.activeElement !== lenInput) lenInput.value = a.lengthKnown ? String(v.length) : "";
    lenInput.setAttribute("placeholder", a.lengthKnown ? "" : "unknown: type it");

    const choices = RAM_CHOICES_MIB.includes(state.ramMiB) ? RAM_CHOICES_MIB : [...RAM_CHOICES_MIB, state.ramMiB].sort((x, y) => x - y);
    ramSel.replaceChildren(...choices.map((m) => h("option", { value: String(m), text: `${sizeWords(BigInt(m) << 20n)}${m === RAM_DEFAULT_MIB ? " (default)" : ""}` })));
    ramSel.value = String(state.ramMiB);
    if (document.activeElement !== rdInput) rdInput.value = state.initrd === null ? "" : String(state.initrd);

    // Source line.
    if (state.base === "image" || state.base === "zboot") {
      const b = BASES[state.base];
      const t = TRIES.find((x) => x.id === state.tryId);
      sourceLine.replaceChildren(
        "Showing ",
        h("strong", { text: b.label }),
        `: ${b.file}, ${b.length} bytes. The lab carries only its headers.`,
        t && t.note ? ` ${t.note}` : "",
        t && t.capture ? ` The message matches course/captures/${t.capture}.` : "",
      );
    } else if (custom && state.base === "file") {
      sourceLine.replaceChildren(
        "Your file ",
        h("strong", { text: custom.name }),
        `: ${custom.length} bytes, of which ${custom.read} were read. Nothing left this tab, and a link cannot carry it.`,
      );
    } else if (custom) {
      sourceLine.textContent = `Your pasted rows: ${plural(custom.read, "byte", "bytes")}. ${
        a.lengthKnown ? `File length set to ${v.length} bytes.` : "The file's length is unknown until you type it in File length."
      } Nothing left this tab, and a link cannot carry it.`;
    } else {
      sourceLine.textContent = "Reading...";
    }

    // Grid.
    cells.forEach((btn, off) => {
      const st = v.state(off);
      const b = v.byte(off);
      const f = fieldAt(a.fields, off);
      const patched = v.patched(off);
      btn.textContent = st === "absent" ? "--" : st === "unread" ? "??" : pending && pending.off === off ? `${pending.digit}_` : hex2(b);
      btn.setAttribute("class", `ii__cell ii__f--${f ? f.id : "none"}${patched ? " ii__cell--patched" : ""}${st !== "byte" ? " ii__cell--absent" : ""}${off === selected ? " ii__cell--sel" : ""}`);
      const orig = v.original(off);
      btn.setAttribute(
        "aria-label",
        `offset ${hx(off)}, ${f ? f.name : "byte"}: ${st === "absent" ? "past the end of the file" : st === "unread" ? "not read" : hex2(b)}${patched && orig !== undefined ? `, edited, was ${hex2(orig)}` : patched ? ", edited" : ""}`,
      );
      if (off === selected) btn.setAttribute("aria-current", "true");
      else btn.removeAttribute("aria-current");
    });
    byteLabel.textContent = `Byte at ${hx(selected)}`;
    if (document.activeElement !== byteInput) {
      const b = v.byte(selected);
      byteInput.value = b === undefined ? "" : hex2(b);
    }
    undoBtn.disabled = Object.keys(state.patches).length === 0;

    // Field table.
    const table = h("table", { class: "ii__table" });
    table.append(h("caption", { text: a.kind === "zboot" ? "The zboot header fields (all little-endian)" : "The Image header fields (all little-endian)" }));
    table.append(h("thead", {}, h("tr", {}, ...["Offset", "Field", "Bytes", "Value"].map((t) => h("th", { scope: "col", text: t })))));
    const tb = h("tbody");
    for (const f of a.fields) {
      const bytes = [];
      let missing = false;
      for (let i = f.from; i <= f.to; i++) {
        const b = v.byte(i);
        if (b === undefined) missing = true;
        else bytes.push(b);
      }
      const shown = f.to - f.from + 1 > 8 ? `${bytes.slice(0, 8).map(hex2).join(" ")} ...` : bytes.map(hex2).join(" ");
      tb.append(
        h(
          "tr",
          {},
          h("td", {}, code(hx(f.from))),
          h("td", {}, h("span", { class: `ii__swatch ii__f--${f.id}`, "aria-hidden": "true" }), ` ${f.name}`),
          h("td", {}, code(missing && bytes.length === 0 ? "not in the file" : shown)),
          h("td", {}, fieldValue(f, missing)),
        ),
      );
    }
    table.append(tb);
    fieldTable.replaceChildren(table);
    fieldForm.hidden = a.kind === "zboot";

    renderReadout();
  }

  function fieldValue(f, missing) {
    if (missing) return "not in the file";
    if (a.kind === "zboot") {
      const z = a.zboot.fields;
      switch (f.id) {
        case "payload_offset":
          return code(hx(z.payloadOffset));
        case "payload_size":
          return h("span", {}, code(hx(z.payloadSize)), ` (${z.payloadSize} bytes)`);
        case "compression":
          return code(JSON.stringify(z.compression ?? ""));
        case "linux_pe_magic":
          return h("span", {}, code(hx(z.linuxPeMagic)), a.zboot.linuxPeMagicOk ? " (as expected)" : " (not 0x818223cd)");
        case "e_lfanew":
          return h("span", {}, "PE header at ", code(hx(z.eLfanew)));
        default:
          return f.what;
      }
    }
    const x = a.image.fields;
    switch (f.id) {
      case "text_offset":
        return code(hx(x.textOffset));
      case "image_size":
        return h("span", {}, code(hx(x.imageSize)), ` (${sizeWords(x.imageSize)})`);
      case "flags":
        return h(
          "span",
          {},
          code(hx(x.flags)),
          `: ${x.bigEndian ? "big" : "little"}-endian, page size ${x.pageWords}, ${x.anywhere ? "may sit anywhere in RAM" : "as low in RAM as possible"}${x.reservedFlags ? ", reserved bits set (ignored)" : ""}`,
        );
      case "magic":
        return h("span", {}, code(x.magic.map(hex2).join(" ")), x.magic.join() === "65,82,77,100" ? " = ARM\\x64" : " (not ARM\\x64)");
      case "res5":
        return h("span", {}, code(hx(x.res5)), " (PE header offset, ignored)");
      case "code0":
      case "code1":
        return h("span", {}, code(hx(f.id === "code0" ? x.code0 : x.code1)), " (an instruction)");
      default:
        return f.what;
    }
  }

  function checkList(checks, first, label, notRun = false) {
    const ol = h("ol", { class: "ii__checks", "aria-label": label });
    const marks = checkMarks(checks, first, notRun);
    checks.forEach((c, i) => {
      const { mark, word, cls } = marks[i];
      ol.append(
        h(
          "li",
          { class: `ii__check ii__check--${cls}` },
          h("span", { class: "ii__mark", "aria-hidden": "true", text: mark }),
          h("span", {}, h("strong", { text: c.label }), ` (${word}). `, h("span", { class: "ii__muted", text: c.detail })),
        ),
      );
    });
    return ol;
  }

  // A scroll box holds nothing focusable, so it takes focus itself: keyboard users can then scroll
  // it with the arrow keys in every browser.
  function scrollBox(child, label) {
    return h("div", { class: "ii__scroll", tabindex: "0", role: "region", "aria-label": label }, child);
  }

  function terminal(lines, caption) {
    return h(
      "figure",
      { class: "ii__term" },
      h("figcaption", { class: "ii__label", text: caption }),
      h("pre", { class: "ii__pre", tabindex: "0", role: "region", "aria-label": `${caption} (scrollable)` }, lines.join("\n")),
    );
  }

  function bar(segments, from, to, title, desc) {
    const lay = barLayout(segments, from, to, BAR_W);
    barCount++;
    const titleId = `${pid}-bar${barCount}-t`;
    const descId = `${pid}-bar${barCount}-d`;
    const svg = s("svg", { class: "ii__bar", viewBox: `0 0 ${BAR_W} 44`, role: "img", "aria-labelledby": `${titleId} ${descId}`, preserveAspectRatio: "none" });
    svg.append(s("title", { id: titleId, text: title }), s("desc", { id: descId, text: desc }));
    for (const seg of lay) {
      svg.append(s("rect", { class: `ii__seg ii__seg--${seg.id}`, x: seg.x, y: 4, width: Math.max(seg.w - 1, 1), height: 36 }));
    }
    const list = h("ul", { class: "ii__seglist" });
    for (const seg of lay) {
      list.append(
        h(
          "li",
          {},
          h("span", { class: `ii__swatch ii__seg-sw--${seg.id}`, "aria-hidden": "true" }),
          " ",
          code(`${hx(seg.from)}..${hx(seg.to)}`),
          ` ${seg.label} (${sizeWords(seg.to - seg.from)})`,
        ),
      );
    }
    return h("div", { class: "ii__map" }, scrollBox(svg, `${title} (scrollable)`), list);
  }

  function renderReadout() {
    const p = a.plan;
    sumLine.textContent = summary(a);
    const out = [];
    const sec = (title, ...kids) => out.push(h("div", { class: "ii__block" }, h("h4", { class: "ii__h4", text: title }), ...kids));

    if (a.kind === "zboot") {
      const z = a.zboot;
      sec("macvmm run --kernel", terminal([p.message, "exit: 2"], "What the loader prints"), h("p", {}, "The loader looks only at MZ and zimg, the same test its detect() makes, and refuses the wrapper by name. An arm64 kernel has no decompressor, and macvmm will not run one: unwrapping happens once, on the host, after the download's sha256 matched."));
      const zl = [];
      zl.push(h("li", {}, "Payload: ", code(`${hx(z.fields.payloadOffset ?? 0)} + ${hx(z.fields.payloadSize ?? 0)} = ${z.end === null ? "?" : hx(z.end)}`), " in 64-bit arithmetic; the file ends at ", code(hx(a.view.length)), "."));
      if (z.wrapped32 !== null && z.wrapped32 !== z.end) {
        zl.push(h("li", { class: "ii__warn" }, h("span", { class: "ii__mark", "aria-hidden": "true", text: "!" }), " Added in 32 bits, the sum wraps to ", code(hx(z.wrapped32)), z.naive32Passes ? ", which a careless check offset + size <= length would accept." : "."));
      }
      sec("cargo xtask unzboot (the host-side unwrapper)", h("ul", { class: "ii__plain" }, ...zl), checkList(z.checks, z.first, "The unwrapper's checks, in order"), z.error ? terminal([`unzboot: ${z.error}`], "Where it stops") : h("p", {}, z.undecided === -1 ? "Every check this lab can make passes. The unwrapper would go on to the steps below, which need DEFLATE and are not run in the browser:" : "The bytes this check needs were not read, so the lab cannot say."), z.error ? null : h("ul", { class: "ii__plain" }, ...z.notRun.map((t) => h("li", {}, h("span", { class: "ii__mark", "aria-hidden": "true", text: "–" }), ` ${t} (not run here).`))));
      if (z.gzip && z.gzip.header) {
        const g = z.gzip;
        const rows = [
          ["Header bytes", code(toHex(g.header).replace(/(..)(?!$)/g, "$1 "))],
          ["Magic", g.magic ? "1f 8b: gzip" : "not gzip"],
          ["Method", `${g.method} (${g.methodName})`],
          ["Flags", `${g.flags}${g.flags === 0 ? " (no file name follows)" : ""}`],
          ["Modification time", `${g.mtime}${g.mtime === 0 ? " (left blank by a reproducible build)" : ""}`],
          ["Extra flags", `${g.xfl} (${g.xflName})`],
          ["Made on", `${g.os} (${g.osName})`],
        ];
        if (g.crc32 !== null) rows.push(["CRC32 (trailer)", code(hx(g.crc32))]);
        if (g.isize !== null) rows.push(["ISIZE (trailer)", h("span", {}, code(hx(g.isize)), ` = ${g.isize} bytes: the inflated size modulo 2^32, a hint written by whoever made the file. ${BigInt(g.isize) <= ZBOOT_MAX_OUTPUT ? "Below" : "Above"} the ${ZBOOT_MAX_OUTPUT >> 20n} MiB cap, which still applies to what inflating really produces.`)]);
        sec("The gzip payload (RFC 1952)", dl(rows));
      }
      if (z.pe) sec("The PE/COFF header (why file calls it a Windows program)", peBlock(z.pe));
      if (a.zmap && a.zmap.length) {
        sec("The file, end to end", bar(a.zmap, 0n, a.view.length, "File map of the zboot wrapper", a.zmap.map((m) => `${hx(m.from)} to ${hx(m.to)}: ${m.label}`).join("; ")));
      }
    } else {
      const notRun = p.stage === "detect" || p.stage === "elf";
      if (a.kind === "elf") {
        sec(
          "An ELF file",
          h(
            "p",
            {},
            p.message
              ? "It starts with 7f 45 4c 46, an ELF file, so the loader never reads it as an Image: it stops at the --initrd rule first (an initramfs goes only with an arm64 Image). The Image checks below were not run."
              : "It starts with 7f 45 4c 46, so macvmm's ELF loader takes it (the elf primer). The Image checks below were not run; each shows only what it would say on its own.",
          ),
        );
      } else if (p.stage === "detect" && a.kind === "raw") {
        sec(
          "Step 1: the magic-number sniff",
          h(
            "ol",
            { class: "ii__checks", "aria-label": "What the loader checks first" },
            h(
              "li",
              { class: "ii__check ii__check--bad" },
              h("span", { class: "ii__mark", "aria-hidden": "true", text: "!" }),
              h("span", {}, h("strong", { text: "ELF, zboot or Image magic present" }), " (fails first: the loader stops here). ", h("span", { class: "ii__muted", text: "No 7f 45 4c 46 at 0, no MZ and zimg, no ARM\\x64 at 0x38." })),
            ),
          ),
          h("p", {}, "The loader sniffs the magic numbers before anything else. Without ARM\\x64 at 0x38 this is not an Image, so parse_header never runs, and the message names what the loader expected instead. The Image checks below were not run."),
        );
      }
      sec(
        notRun ? "macvmm's Image header checks (not run for this file)" : "macvmm's Image header checks, in order",
        checkList(a.image.checks, a.checkFirst, "Image header checks, in order", notRun),
      );
      if (p.stage === "undecided" || (p.stage === "ok" && !a.lengthKnown)) {
        sec("Not decided yet", h("p", {}, "Pasted rows say nothing about how long the file is. Type its length in File length (ls -l prints it) to finish the checks; until then the lab shows file=? where macvmm would print the length."));
      }
      if (p.message) {
        out.push(terminal([p.message, "exit: 2"], "What macvmm prints"));
        if (p.stage === "kernel") out.push(kernelWhy(p));
        if (p.stage === "initrd") out.push(h("p", {}, "The kernel fits; the initramfs, placed at the next 2 MiB boundary after image_size, does not."));
      } else if (p.stage === "ok") {
        out.push(terminal(p.lines, "These lines of run --dry-run (the dtb line and the memory map need the real device tree, which the lab does not build)"));
        sec(
          "Where everything goes",
          bar(a.map.segments, a.map.from, a.map.to, "Guest RAM placement", a.map.segments.map((m) => `${hx(m.from)} to ${hx(m.to)}: ${m.label}`).join("; ")),
          h("p", { class: "ii__muted ii__small" }, "The initramfs goes after image_size, not after the file's last byte: the kernel zeroes its BSS early, and anything there is erased. The bar gives small pieces a minimum width; the addresses are exact."),
        );
        if (a.wrongMap) {
          const w = a.wrongMap;
          out.push(
            h(
              "details",
              { class: "ii__details" },
              h("summary", { text: "The tempting wrong plan: initramfs right after the file" }),
              h("p", {}, "Not what macvmm does. Here the initramfs starts at ", code(hx(w.start)), ", the file's last byte, instead of ", code(hx(p.initrd.start)), ". Its first ", code(hx(w.overlap)), ` bytes (${sizeWords(w.overlap)}) sit inside the kernel's BSS, which the kernel zeroes early; the damage shows up much later, when the kernel unpacks the initramfs.`),
              bar(w.segments, w.from, w.to, "The tempting wrong plan", w.segments.map((m) => `${hx(m.from)} to ${hx(m.to)}: ${m.label}`).join("; ")),
            ),
          );
        }
      }
      if (a.imagePe && a.imagePe.signature) {
        sec("Also a PE/COFF program", h("p", {}, "The file starts with MZ and res5 points at ", code(hx(a.imagePe.offset)), `, where PE\\0\\0 sits: machine ${hx(a.imagePe.machine ?? 0)} (${a.imagePe.machineName}), subsystem ${a.imagePe.subsystem} (${a.imagePe.subsystemName}). That is the EFI stub, for UEFI firmware; macvmm ignores it.`));
      }
    }
    readoutBody.replaceChildren(...out);
  }

  function kernelWhy(p) {
    const k = p.kernel;
    const size = p.image.header.imageSize;
    if (k.step === "end") {
      const ramEnd = RAM_BASE + (BigInt(state.ramMiB) << 20n);
      const where = k.wrapped >= RAM_BASE && k.wrapped < ramEnd ? "inside RAM" : "below ram_end";
      return h("p", {}, code(`${hx(k.load)} + ${hx(size)}`), " does not fit in 64 bits. With wrapping arithmetic the end would be ", code(hx(k.wrapped)), `, ${where}, and a check end <= ram_end would wave it through. checked_add returns None instead, and place() turns that into this error before the kernel ever runs.`);
    }
    if (k.step === "load") return h("p", {}, "The base plus text_offset already overflows 64 bits.");
    const ramEnd = RAM_BASE + (BigInt(state.ramMiB) << 20n);
    return h("p", {}, "The kernel would end at ", code(hx(k.end)), "; RAM ends at ", code(hx(ramEnd)), ". The whole image_size must fit, not just the file.");
  }

  function dl(rows) {
    const d = h("dl", { class: "ii__dl" });
    for (const [k, v] of rows) d.append(h("dt", { text: k }), h("dd", {}, v));
    return d;
  }

  function peBlock(pe) {
    if (pe.error) return h("p", { class: "ii__warn" }, h("span", { class: "ii__mark", "aria-hidden": "true", text: "!" }), ` ${pe.error}.`);
    const rows = [
      ["Signature", h("span", {}, code("PE\\0\\0"), " at ", code(hx(pe.offset)))],
      ["Machine", pe.machine === null ? "not read" : h("span", {}, code(hx(pe.machine)), ` (${pe.machineName})`)],
      ["Optional header", pe.optMagic === null ? "not read" : h("span", {}, code(hx(pe.optMagic)), ` (${pe.optKind})`)],
      ["Subsystem", pe.subsystem === null ? "not read" : `${pe.subsystem} (${pe.subsystemName})`],
      ["Entry point", pe.entry === null ? "not read" : h("span", {}, code(hx(pe.entry)), " bytes into the loaded image")],
    ];
    const t = h("table", { class: "ii__table" }, h("caption", { text: `Sections: ${pe.sections ?? "?"}${pe.sectionsCapped ? " (only the first 16 are shown)" : ""}` }));
    t.append(h("thead", {}, h("tr", {}, ...["Name", "File offset", "Size in file", "Loaded at (VMA)"].map((x) => h("th", { scope: "col", text: x })))));
    const tb = h("tbody");
    for (const sct of pe.sectionTable) {
      tb.append(h("tr", {}, h("td", {}, code(sct.name || "(none)")), h("td", {}, code(hx(sct.rawPtr ?? 0))), h("td", {}, code(hx(sct.rawSize ?? 0))), h("td", {}, code(hx(sct.va ?? 0)))));
    }
    t.append(tb);
    return h("div", {}, dl(rows), h("div", { class: "ii__scroll" }, t));
  }

  // ---- reading a dropped or chosen file ----
  async function loadFile(file) {
    const token = ++readToken;
    const name = String(file.name || "file").slice(0, NAME_MAX);
    const length = BigInt(file.size);
    sourceLine.textContent = `Reading ${name}...`;
    try {
      const chunks = [{ off: 0, bytes: new Uint8Array(await file.slice(0, READ_WINDOW).arrayBuffer()) }];
      let extra = 0;
      for (let round = 0; round < 2 && extra < MAX_EXTRA_READS; round++) {
        const want = wantedRanges(makeView(length, chunks)).slice(0, MAX_EXTRA_READS - extra);
        if (want.length === 0) break;
        for (const w of want) {
          chunks.push({ off: w.off, bytes: new Uint8Array(await file.slice(w.off, w.off + w.len).arrayBuffer()) });
          extra++;
        }
      }
      if (token !== readToken) return;
      const read = chunks.reduce((n, c) => n + c.bytes.length, 0);
      custom = { length, chunks, name, read };
      selected = 0;
      state = step(state, { type: "source", base: "file" }, custom);
      clearErrors();
      ctx.hash.set(null);
      render();
      say(`Read ${name}. ${sumLine.textContent}`);
    } catch (err) {
      if (token !== readToken) return;
      sourceLine.textContent = `Could not read that file: ${String(err && err.message ? err.message : err).slice(0, 120)}`;
      say(sourceLine.textContent);
    }
  }

  // ---- events ----
  trySel.addEventListener("change", () => {
    if (!trySel.value) return;
    custom = null;
    readToken++;
    apply({ type: "try", id: trySel.value });
  });

  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) loadFile(f);
    fileInput.value = "";
  });
  for (const t of ["dragenter", "dragover"]) {
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      drop.classList.add("ii__drop--over");
    });
  }
  drop.addEventListener("dragleave", () => drop.classList.remove("ii__drop--over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("ii__drop--over");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  pasteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const r = parseXxd(pasteArea.value);
    if (r.error) {
      pasteErr.textContent = r.error;
      pasteArea.setAttribute("aria-invalid", "true");
      say(r.error);
      return;
    }
    readToken++;
    const read = r.chunks.reduce((n, c) => n + c.bytes.length, 0);
    custom = { length: BigInt(r.end), chunks: r.chunks, name: "pasted rows", read };
    state = step(state, { type: "source", base: "paste" }, custom);
    selected = 0;
    clearErrors();
    ctx.hash.set(null);
    render();
    say(`Read ${plural(read, "byte", "bytes")}. Type the file length to finish the checks. ${sumLine.textContent}`);
  });

  lenForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = parseNumber(lenInput.value);
    if (v === null) {
      lenErr.textContent = "Type a length in bytes: decimal, or hex with 0x, at most 64 bits.";
      lenInput.setAttribute("aria-invalid", "true");
      say(lenErr.textContent);
      return;
    }
    if (!apply({ type: "setLength", value: v })) say(sumLine.textContent);
  });

  ramSel.addEventListener("change", () => {
    const mib = Number(ramSel.value);
    if (ramError(mib)) return;
    apply({ type: "setRam", mib });
  });

  rdForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = rdInput.value.trim();
    const v = t === "" ? null : parseNumber(t);
    if (t !== "" && (v === null || v === 0n)) {
      rdErr.textContent = "Type a size in bytes greater than 0 (decimal, or hex with 0x), or leave it empty for no --initrd.";
      rdInput.setAttribute("aria-invalid", "true");
      say(rdErr.textContent);
      return;
    }
    if (!apply({ type: "setInitrd", size: v })) say(sumLine.textContent);
  });

  resetBtn.addEventListener("click", () => {
    custom = null;
    readToken++;
    selected = 0;
    state = initialState();
    clearErrors();
    ctx.hash.set(null);
    render();
    say(`Reset. ${sumLine.textContent}`);
  });

  copyBtn.addEventListener("click", async () => {
    const enc = encode(state);
    if (state.base === "file" || state.base === "paste") {
      say("A link cannot carry your own file. Pick a Try preset to share a link.");
      return;
    }
    ctx.hash.set(enc);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(location.href);
      say("Link copied. It reopens the lab with these bytes and settings.");
    } catch {
      say("Could not copy here. The address bar already holds a link to this state.");
    }
  });

  undoBtn.addEventListener("click", () => apply({ type: "clearPatches" }));

  byteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = byteInput.value.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{1,2}$/.test(t)) {
      byteErr.textContent = "Type one byte as one or two hex digits, for example 41.";
      byteInput.setAttribute("aria-invalid", "true");
      say(byteErr.textContent);
      return;
    }
    if (a.view.state(selected) === "absent") {
      byteErr.textContent = "That offset is past the end of the file. Make the file longer first.";
      say(byteErr.textContent);
      return;
    }
    if (!apply({ type: "setByte", off: selected, value: parseInt(t, 16) })) say(sumLine.textContent);
  });

  fieldForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = parseNumber(fieldVal.value);
    if (v === null) {
      fieldErr.textContent = "Type a value: decimal, or hex with 0x, at most 64 bits (0xffffffffffffffff).";
      fieldVal.setAttribute("aria-invalid", "true");
      say(fieldErr.textContent);
      return;
    }
    if (!apply({ type: "setField", field: fieldSel.value, value: v })) say(sumLine.textContent);
  });

  function select(off, focus) {
    selected = Math.max(0, Math.min(GRID - 1, off));
    pending = null;
    cells.forEach((c, i) => (c.tabIndex = i === selected ? 0 : -1));
    render();
    if (focus) cells[selected].focus();
  }

  grid.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".ii__cell") : null;
    if (!btn || !grid.contains(btn)) return;
    select(Number(btn.getAttribute("data-off")), true);
  });

  grid.addEventListener("keydown", (e) => {
    // Leave browser and system shortcuts alone (copy, find, back, ...). Shift is allowed: it
    // only makes a hex letter upper-case.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const btn = e.target instanceof Element ? e.target.closest(".ii__cell") : null;
    if (!btn) return;
    const off = Number(btn.getAttribute("data-off"));
    const rowStart = off - (off % 16);
    const moves = { ArrowLeft: off - 1, ArrowRight: off + 1, ArrowUp: off - 16, ArrowDown: off + 16, Home: rowStart, End: rowStart + 15 };
    if (Object.hasOwn(moves, e.key)) {
      e.preventDefault();
      const to = moves[e.key];
      if (to >= 0 && to < GRID) select(to, true);
      return;
    }
    if (e.key === "Escape") {
      if (pending) {
        e.preventDefault();
        pending = null;
        render();
        say("Byte edit cancelled.");
      }
      return;
    }
    if (typeof e.key === "string" && /^[0-9a-fA-F]$/.test(e.key)) {
      e.preventDefault();
      if (a.view.state(off) === "absent") {
        say("That offset is past the end of the file.");
        return;
      }
      if (selected !== off) {
        selected = off;
        pending = null;
      }
      if (!pending) {
        pending = { off, digit: e.key.toLowerCase() };
        render();
        say(`First digit ${pending.digit}; type the second.`);
        return;
      }
      const value = parseInt(pending.digit + e.key.toLowerCase(), 16);
      pending = null;
      if (!apply({ type: "setByte", off, value })) {
        render();
        say(sumLine.textContent);
      }
      cells[off].focus();
    }
  });

  // A half-typed byte does not survive leaving the grid: otherwise one digit typed much later
  // would complete it.
  grid.addEventListener("focusout", (e) => {
    if (!pending) return;
    const to = e.relatedTarget;
    if (to && grid.contains(to)) return;
    pending = null;
    render();
    say("Byte edit cancelled.");
  });

  render();
  return {
    destroy() {
      if (timer !== null) clearTimeout(timer);
      readToken++;
    },
  };
}
