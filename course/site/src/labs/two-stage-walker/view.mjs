// two-stage-walker: the view. Renders the model's state with createElement/textContent only
// (no innerHTML, no inline handlers), so it runs under the site's CSP (DESIGN.md section 7).
// All logic lives in model.mjs; this file turns events into model actions and draws the result.
import * as M from "./model.mjs";

const AUTO_MS = 1000;
// With reduced motion, Auto never starts by itself (it never does) and steps half as fast.
const AUTO_MS_REDUCED = 2000;
const ESR_LAB = "/build-your-own/vmm/labs/esr-decoder/";
const GLOSSARY = "/build-your-own/vmm/glossary/";
const PRIMERS = "/build-your-own/vmm/primers/";

/** Tiny element builder: h("p", { class: "x", text: "hi" }, child, ...). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") el.textContent = v;
    else if (k === "class") el.className = v;
    else if (k.startsWith("on")) {
      if (typeof v === "function") el.addEventListener(k.slice(2), v);
    }
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** Replace `el`'s children, skipping null/false (a bare null would render as the text "null"). */
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

function option(value, label, selected) {
  return h("option", { value, selected: selected ? true : undefined, text: label });
}

function link(href, text) {
  return h("a", { href, text });
}

/** The page path, read only to pick an embed's starting state (see M.startHashFor). */
function pagePath() {
  try {
    const loc = globalThis.location || (globalThis.window && globalThis.window.location);
    return loc && typeof loc.pathname === "string" ? loc.pathname : "";
  } catch {
    return "";
  }
}

/** Disable a button without moving focus off it: aria-disabled plus a guard in each handler. */
function setOff(btn, off) {
  if (off) btn.setAttribute("aria-disabled", "true");
  else btn.removeAttribute("aria-disabled");
}
function isOff(btn) {
  return btn.getAttribute("aria-disabled") === "true";
}

function labelled(id, label, control, hint) {
  return h("div", { class: "tsw__field" }, h("label", { for: id, text: label }), control, hint ?? null);
}

const REGION_WHAT = Object.freeze({
  Ram: "RAM, mapped in stage 2",
  Rom: "flash, a hole without firmware",
  GicDist: "in-kernel GIC, handled by HVF",
  GicRedist: "in-kernel GIC, handled by HVF",
  GicMsi: "in-kernel GIC, handled by HVF",
  Mmio: "device window, a hole",
  Reserved: "hole",
});

export function mount(el, ctx) {
  const id = (s) => `${ctx.id}-${s}`;
  let state = M.initialState();
  let hashNote = null;
  const shared = ctx.hash && ctx.hash.get ? ctx.hash.get() : null;
  if (shared) {
    const d = M.decodeHash(shared);
    state = d.state;
    hashNote = M.hashErrorText(d.errors);
  } else {
    // No shared link: the embed decides where to start (a primer reader has not met stage 2).
    const start = M.startHashFor({ pathname: pagePath(), standalone: !!ctx.standalone });
    if (start) state = M.decodeHash(start).state;
  }
  const autoMs = ctx.reducedMotion ? AUTO_MS_REDUCED : AUTO_MS;
  let guesses = { index: "", addr: "", result: null };
  let timer = null;
  let rovers = new Map(); // card key -> focused row index
  let worldKey = "";
  let world = null;
  let lastAnnounce = 0;
  let pendingAnnounce = null;
  let announceTimer = null;

  function announce(text) {
    if (!ctx.announce) return;
    const now = Date.now();
    pendingAnnounce = text;
    if (now - lastAnnounce >= 300) {
      lastAnnounce = now;
      ctx.announce(text);
      pendingAnnounce = null;
    } else if (!announceTimer) {
      announceTimer = setTimeout(() => {
        announceTimer = null;
        if (pendingAnnounce) {
          lastAnnounce = Date.now();
          ctx.announce(pendingAnnounce);
          pendingAnnounce = null;
        }
      }, 300);
    }
  }

  function getWorld() {
    const key = [state.scenario, state.g1, state.g2, state.ipaBits, state.uartRam, state.edits.map((e) => `${e.stage}.${e.addr}.${e.value}`).join(",")].join("|");
    if (key !== worldKey) {
      world = M.buildWorld(state);
      worldKey = key;
    }
    return world;
  }

  // ------------------------------------------------------------------------------- controls
  const scenarioSel = h("select", { id: id("scenario") }, Object.entries(M.SCENARIOS).map(([k, v]) => option(k, v.label, k === state.scenario)));
  const modeSel = h("select", { id: id("mode") }, Object.entries(M.MODES).map(([k, v]) => option(k, v, k === state.mode)));
  const addrInput = h("input", { id: id("addr"), type: "text", inputmode: "text", spellcheck: "false", autocomplete: "off", "aria-describedby": id("addr-err") });
  const addrErr = h("p", { id: id("addr-err"), class: "tsw__err", "aria-live": "polite" });
  const walkBtn = h("button", { type: "button", class: "tsw__btn tsw__btn--primary", text: "Walk" });
  const exampleSel = h("select", { id: id("examples") });
  const opSel = h("select", { id: id("op") }, option("w", "Store (str)", true), option("r", "Load (ldr)", false));
  const sizeSel = h("select", { id: id("size") }, M.ACCESS_SIZES.map((n) => option(String(n), `${n} byte${n > 1 ? "s" : ""}`, n === 4)));
  const rtInput = h("input", { id: id("rt"), type: "number", min: "0", max: "30", step: "1", value: "9", "aria-describedby": id("rt-err") });
  const rtErr = h("p", { id: id("rt-err"), class: "tsw__err", "aria-live": "polite" });
  const elSel = h("select", { id: id("el") }, option("1", "EL1 (the guest kernel)", true), option("0", "EL0 (an app)", false));
  const g1Sel = h("select", { id: id("g1") }, option("4", "4 KiB", true), option("16", "16 KiB", false));
  const g2Sel = h("select", { id: id("g2") }, option("4", "4 KiB", false), option("16", "16 KiB (HVF default)", true));
  const ipaSel = h("select", { id: id("ipa") }, M.IPA_SIZES.map((n) => option(String(n), `${n} bits${n === 36 ? " (HVF default)" : ""}`, n === 36)));
  const uartBox = h("input", { id: id("uart"), type: "checkbox" });
  const predictBox = h("input", { id: id("predict"), type: "checkbox" });
  const stepBtn = h("button", { type: "button", class: "tsw__btn", text: "Step", "data-fkey": "ctl-step" });
  const backBtn = h("button", { type: "button", class: "tsw__btn", text: "Back", "data-fkey": "ctl-back" });
  const allBtn = h("button", { type: "button", class: "tsw__btn", text: "Show all", "data-fkey": "ctl-all" });
  const playBtn = h("button", { type: "button", class: "tsw__btn", "aria-pressed": "false", text: "Auto", "data-fkey": "ctl-auto" });
  const resetBtn = h("button", { type: "button", class: "tsw__btn", text: "Reset", "data-fkey": "ctl-reset" });
  const shareBtn = h("button", { type: "button", class: "tsw__btn", text: "Share state", "data-fkey": "ctl-share" });
  const progress = h("p", { class: "tsw__progress" });

  const controls = h(
    "div",
    { class: "tsw__controls" },
    h("fieldset", { class: "tsw__group" }, h("legend", { text: "Machine" }), labelled(id("scenario"), "Tables", scenarioSel), labelled(id("mode"), "Mode", modeSel)),
    h(
      "fieldset",
      { class: "tsw__group" },
      h("legend", { text: "Address" }),
      h("div", { class: "tsw__field" }, h("label", { for: id("addr"), id: id("addr-label"), text: "Guest virtual address" }), h("div", { class: "tsw__row" }, addrInput, walkBtn), addrErr),
      labelled(id("examples"), "Examples", exampleSel),
    ),
    h(
      "fieldset",
      { class: "tsw__group" },
      h("legend", { text: "Access" }),
      labelled(id("op"), "Instruction", opSel),
      labelled(id("size"), "Size", sizeSel),
      labelled(id("rt"), "Register number (0 to 30)", rtInput, rtErr),
      labelled(id("el"), "Made from", elSel),
    ),
    h(
      "fieldset",
      { class: "tsw__group" },
      h("legend", { text: "Granules and sizes" }),
      labelled(id("g1"), "Stage-1 granule (the guest's)", g1Sel),
      labelled(id("g2"), "Stage-2 granule (HVF's)", g2Sel),
      labelled(id("ipa"), "IPA size", ipaSel),
      h("div", { class: "tsw__check" }, uartBox, h("label", { for: id("uart"), text: "Map a 16 KiB page of RAM at 0x0900_0000 (chapter 05's Predict)" })),
    ),
    h(
      "div",
      { class: "tsw__group tsw__group--wide" },
      h("div", { class: "tsw__check" }, predictBox, h("label", { for: id("predict"), text: "Predict each index before the lab shows it (not scored)" })),
      h("div", { class: "tsw__buttons", role: "group", "aria-label": "Walk controls" }, stepBtn, backBtn, allBtn, playBtn, resetBtn, shareBtn),
      progress,
    ),
  );

  // ------------------------------------------------------------------------------- regions
  const intro = h(
    "div",
    { class: "tsw__intro" },
    h("h3", { text: "What you are looking at" }),
    h(
      "p",
      {},
      "A load or store goes through up to two sets of ",
      link(`${PRIMERS}page-tables/`, "page tables"),
      ". ",
      link(`${GLOSSARY}#stage-1-stage-2`, "Stage 1"),
      " is the guest's own tables: they turn a virtual address (VA) into an ",
      link(`${GLOSSARY}#ipa`, "IPA"),
      ", the address the guest believes is physical. Stage 2 is the tables of HVF (Hypervisor.framework, the macOS part that runs our VMs): they turn the IPA into a host address. Each card below is one table entry read from memory. A failed stage-1 walk is the guest kernel's business; a failed stage-2 walk stops the guest and usually hands control to our VMM, a ",
      link(`${GLOSSARY}#vm-exit`, "VM exit"),
      ". In bare-metal mode there is no VM, so only stage 1 runs.",
    ),
  );
  const about = h("p", { class: "tsw__about" });
  const config = h("div", { class: "tsw__config" });
  const mapNav = h("div", { class: "tsw__map" });
  const split = h("div", { class: "tsw__split" });
  const predictPanel = h("div", { class: "tsw__predictbox" });
  const startHint = h("p", { class: "tsw__start", hidden: true });
  const walkList = h("ol", { class: "tsw__walk", "aria-label": "Walk, one entry per table read" });
  const readout = h("section", { class: "tsw__readout", "aria-labelledby": id("readout-title") });
  // Not a live region: every announcement goes through ctx.announce, one channel (LABS.md section 6).
  const summary = h("p", { class: "tsw__summary" });
  const readoutBody = h("div");
  readout.append(h("h3", { id: id("readout-title"), text: "Readout" }), summary, readoutBody);
  const editor = h("section", { class: "tsw__editor", "aria-labelledby": id("editor-title"), hidden: true });
  const notesBox = h("div", { class: "tsw__notes" });
  const simplifies = h(
    "details",
    { class: "tsw__details" },
    h("summary", { text: "What this lab simplifies" }),
    h(
      "ul",
      {},
      h("li", { text: "Host addresses (HVF's stage-2 tables and the host pages behind guest RAM) are made up: HVF never shows them to a VMM. The walk's shape and every guest-side number are real." }),
      h("li", { text: "Stage 2 starts at the shallowest level that covers the IPA size. The architecture also lets a hypervisor join up to 16 tables at the first level to skip one; this lab does not." }),
      h("li", { text: "Only loads and stores of one register. No TLB, no instruction fetches, no hardware updates of the access flag, no upper-half (TTBR1_EL1) tables." }),
      h("li", { text: "Stage 2 maps guest RAM with last-level pages; HVF may use blocks where it can." }),
      h("li", { text: `The physical address size the guest's CPU reports is fixed at ${M.GUEST_PA_BITS} bits; with the MMU off, a larger address faults at stage 1.` }),
      h("li", { text: "An access that runs into the next page is walked on screen for its first page only; the readout says whether the second page is mapped, and reports its fault if it is not." }),
    ),
  );

  const root = h(
    "div",
    { class: "tsw" },
    controls,
    hashNote ? h("p", { class: "tsw__note", role: "note", text: hashNote }) : null,
    intro,
    about,
    config,
    mapNav,
    split,
    predictPanel,
    startHint,
    walkList,
    readout,
    editor,
    notesBox,
    simplifies,
  );
  fill(el, root);

  // ------------------------------------------------------------------------------- events
  function set(next, { keepGuess = false } = {}) {
    state = next;
    if (!keepGuess) guesses = { index: "", addr: "", result: null };
    render();
  }

  function stopAuto() {
    if (timer) clearInterval(timer);
    timer = null;
    playBtn.setAttribute("aria-pressed", "false");
    playBtn.textContent = "Auto";
  }

  function applyAddr() {
    const p = M.parseHex(addrInput.value);
    if (!p.ok) {
      addrErr.textContent = p.error;
      addrInput.setAttribute("aria-invalid", "true");
      return;
    }
    addrErr.textContent = "";
    addrInput.removeAttribute("aria-invalid");
    stopAuto();
    set(M.step(state, { type: "addr", value: p.value }));
    announceReady();
  }

  /** After the walk was reset to step 0 by a new address, mode or table set. */
  function announceReady() {
    const r = current();
    announce(`Address ${M.hex(state.addr)}: ${r.timeline.length} step${r.timeline.length === 1 ? "" : "s"}. Press Step to read the first table entry, or Show all.`);
  }

  /** Announce what changed in a finished walk (edits, granules), or nothing while stepping. */
  function announceOutcome(prefix) {
    const r = current();
    const done = Math.min(state.cursor, r.timeline.length) >= r.timeline.length;
    announce(done ? `${prefix} ${r.outcome.summary}` : prefix);
  }

  scenarioSel.addEventListener("change", () => {
    stopAuto();
    set(M.step(state, { type: "scenario", value: scenarioSel.value }));
    syncControls();
    announceReady();
  });
  modeSel.addEventListener("change", () => {
    stopAuto();
    set(M.step(state, { type: "mode", value: modeSel.value }));
    syncControls();
    announceReady();
  });
  walkBtn.addEventListener("click", applyAddr);
  addrInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyAddr();
    }
  });
  exampleSel.addEventListener("change", () => {
    if (exampleSel.value === "") return;
    const p = M.parseHex(exampleSel.value);
    if (p.ok) {
      stopAuto();
      set(M.step(state, { type: "addr", value: p.value }));
      syncControls();
      announceReady();
    }
  });
  const accessChanged = () => {
    const rt = Number.parseInt(rtInput.value, 10);
    const next = M.step(state, { type: "access", value: { write: opSel.value === "w", size: Number(sizeSel.value), rt: Number.isFinite(rt) ? rt : -1, el: Number(elSel.value) } });
    if (next === state) {
      rtInput.setAttribute("aria-invalid", "true");
      rtErr.textContent = "Use a register number from 0 to 30.";
      return;
    }
    rtInput.removeAttribute("aria-invalid");
    rtErr.textContent = "";
    set(next, { keepGuess: true });
  };
  for (const c of [opSel, sizeSel, rtInput, elSel]) c.addEventListener("change", accessChanged);
  g1Sel.addEventListener("change", () => {
    set(M.step(state, { type: "g1", value: Number(g1Sel.value) }));
    announceReady();
  });
  g2Sel.addEventListener("change", () => {
    set(M.step(state, { type: "g2", value: Number(g2Sel.value) }));
    announceOutcome(`Stage-2 granule ${state.g2} KiB.`);
  });
  ipaSel.addEventListener("change", () => {
    set(M.step(state, { type: "ipaBits", value: Number(ipaSel.value) }));
    announceOutcome(`IPA size ${state.ipaBits} bits.`);
  });
  uartBox.addEventListener("change", () => {
    set(M.step(state, { type: "uartRam", value: uartBox.checked }));
    announceOutcome(state.uartRam ? "A RAM page now sits at 0x0900_0000." : "The RAM page at 0x0900_0000 is gone.");
  });
  predictBox.addEventListener("change", () => {
    stopAuto();
    set(M.step(state, { type: "predict", value: predictBox.checked }));
  });
  /** Move the cursor one Step (+1) or Back (-1) and announce what that revealed. */
  function move(dir) {
    const r = current();
    const total = r.timeline.length;
    const from = Math.min(state.cursor, total);
    const span = M.stepSpan(r.timeline, from, dir, state.predict);
    set(M.step(state, { type: dir > 0 ? "next" : "back", total, span }));
    announce(M.stepAnnouncement(r, from, Math.min(state.cursor, total)));
  }
  stepBtn.addEventListener("click", () => {
    if (isOff(stepBtn)) return;
    stopAuto();
    move(1);
  });
  backBtn.addEventListener("click", () => {
    if (isOff(backBtn)) return;
    stopAuto();
    move(-1);
  });
  allBtn.addEventListener("click", () => {
    if (isOff(allBtn)) return;
    stopAuto();
    set(M.step(state, { type: "all" }));
    announce(`Walk complete. ${current().outcome.summary}`);
  });
  playBtn.addEventListener("click", () => {
    if (timer) {
      stopAuto();
      return;
    }
    const total = current().timeline.length;
    if (state.cursor >= total) state = M.step(state, { type: "restart" });
    playBtn.setAttribute("aria-pressed", "true");
    playBtn.textContent = "Pause";
    render();
    timer = setInterval(() => {
      const t = current().timeline.length;
      if (state.cursor >= t) {
        stopAuto();
        return;
      }
      move(1);
    }, autoMs);
  });
  resetBtn.addEventListener("click", () => {
    stopAuto();
    rovers = new Map();
    set(M.step(state, { type: "reset" }));
    syncControls();
    announce("Lab reset. Press Step to read the first table entry.");
  });
  shareBtn.addEventListener("click", () => {
    const s = M.encodeHash(state);
    if (ctx.hash && ctx.hash.set) ctx.hash.set(s);
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(window.location.href).then(
          () => announce("Link copied. It is also in the address bar."),
          () => announce("The address bar now holds a link to this state."),
        );
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) announce("The address bar now holds a link to this state.");
  });

  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selected) {
      const back = state.selected;
      set(M.step(state, { type: "select", value: null }), { keepGuess: true });
      const row = root.querySelector(`[data-fkey="row-${back.stage}-${back.addr.toString(16)}"]`);
      if (row) row.focus();
    }
  });

  // ------------------------------------------------------------------------------- render
  let cached = null;
  function current() {
    const w = getWorld();
    const key = `${worldKey}#${state.mode}#${state.addr}#${JSON.stringify(state.access)}`;
    if (!cached || cached.key !== key) cached = { key, r: M.translate(state, w) };
    return cached.r;
  }

  function syncControls() {
    scenarioSel.value = state.scenario;
    modeSel.value = state.mode;
    addrInput.value = M.hex(state.addr);
    opSel.value = state.access.write ? "w" : "r";
    sizeSel.value = String(state.access.size);
    rtInput.value = String(state.access.rt);
    elSel.value = String(state.access.el);
    g1Sel.value = String(state.g1);
    g2Sel.value = String(state.g2);
    ipaSel.value = String(state.ipaBits);
    uartBox.checked = state.uartRam;
    predictBox.checked = state.predict;
    const label = root.querySelector(`#${CSS.escape(id("addr-label"))}`);
    if (label) label.textContent = state.mode === "s2" ? "Guest address (VA = IPA: the MMU is off)" : state.mode === "s1" ? "Virtual address" : "Guest virtual address";
    const exs = state.mode === "s2" ? M.S2_EXAMPLES : M.SCENARIOS[state.scenario].examples;
    fill(exampleSel, option("", "Choose an example...", true), ...exs.map((x) => option(M.hex(x.addr), x.label, false)));
    const vm = state.mode !== "s1";
    g2Sel.disabled = !vm;
    ipaSel.disabled = !vm;
    uartBox.disabled = !vm;
    g1Sel.disabled = state.mode === "s2";
  }

  function render() {
    const focusKey = document.activeElement && root.contains(document.activeElement) ? document.activeElement.getAttribute("data-fkey") : null;
    const w = getWorld();
    const r = current();
    const total = r.timeline.length;
    const shown = Math.min(state.cursor, total);
    const sc = M.SCENARIOS[state.scenario];

    about.textContent = state.mode === "s2" ? "The guest's MMU is off, so every address it uses is already an IPA and only stage 2 runs. Chapter 05's mmio-poke and ipa-poke guests run this way." : sc.about;
    fill(config, ...configLines(w));
    renderMap(r);
    renderSplit(r, w, shown);
    renderWalk(r, w, shown);
    renderPredict(r, shown);
    renderReadout(r, w, shown, total);
    renderEditor(w);
    renderNotes(w);

    progress.textContent = shown >= total ? `Walk complete: ${total} step${total === 1 ? "" : "s"}.` : `Step ${shown} of ${total}.`;
    setOff(stepBtn, shown >= total);
    setOff(backBtn, shown === 0);
    setOff(allBtn, shown >= total);
    startHint.hidden = shown !== 0;
    startHint.textContent = shown === 0 ? (state.predict ? "Start here: predict the first index below, then press Step." : "Start here: press Step to read the first table entry, or Show all to see the whole walk.") : "";

    if (focusKey) {
      const target = root.querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`);
      if (target && target !== document.activeElement) target.focus();
    }
  }

  function configLines(w) {
    const s1 = w.s1;
    const lines = [];
    if (state.mode !== "s2") {
      lines.push(
        h(
          "p",
          { class: "tsw__cfg" },
          `Stage 1: ${s1.geo.granule} KiB `,
          link(`${PRIMERS}page-granules/`, "granule"),
          ` (page size), ${s1.geo.inBits}-bit addresses, starts at level ${s1.geo.startLevel}.`,
        ),
        h(
          "details",
          { class: "tsw__regsdetail" },
          h("summary", { text: "Register values" }),
          h(
            "ul",
            {},
            h("li", {}, h("code", { text: `TCR_EL1 = ${M.hex(s1.tcr)}` }), `: the translation control register, which sets the granule and the address size (T0SZ = ${64 - s1.geo.inBits}, so ${s1.geo.inBits}-bit addresses).`),
            h("li", {}, h("code", { text: `TTBR0_EL1 = ${M.hex(s1.root)}` }), ": the translation table base register, the address of the guest's top-level table."),
          ),
        ),
      );
    }
    if (state.mode !== "s1") {
      lines.push(h("p", { class: "tsw__cfg" }, `Stage 2: ${w.s2.geo.granule} KiB granule, ${w.s2.geo.inBits}-bit IPA space, starts at level ${w.s2.geo.startLevel} (${w.s2.geo.levels[0].entries} entries there). Maps 64 MiB of RAM at 0x4000_0000${state.uartRam ? " and one RAM page at 0x0900_0000" : ""}.`));
    }
    return lines;
  }

  function renderMap(r) {
    const hit = r.ipa !== null ? M.regionAt(r.ipa) : null;
    const items = M.MEMORY_MAP.map((reg) => {
      const active = hit && hit.name === reg.name;
      const what = REGION_WHAT[reg.kind] ?? "hole";
      return h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: `tsw__region tsw__region--${reg.kind.toLowerCase()}${active ? " is-hit" : ""}`,
            "aria-current": active ? "true" : undefined,
            "aria-label": `${reg.name}, ${M.hex(reg.base)}, ${M.sizeText(reg.size)}, ${what}${active ? ", the IPA is here" : ""}. Sets the address to its start.`,
            "data-fkey": `map-${reg.name}`,
            onclick: () => {
              stopAuto();
              set(M.step(state, { type: "addr", value: reg.base }));
              syncControls();
              announce(`Address set to ${M.hex(reg.base)}, the start of ${reg.name}. Press Step to walk it, or Show all.`);
            },
          },
          h("span", { class: "tsw__region-name", text: reg.name }),
          h("span", { class: "tsw__region-addr", text: M.hex(reg.base) }),
          h("span", { class: "tsw__region-meta", text: `${M.sizeText(reg.size)}, ${what}` }),
          active ? h("span", { class: "tsw__tag", text: "IPA here" }) : null,
        ),
      );
    });
    fill(mapNav, 
      h("h3", { id: id("map-title"), text: "Memory map (chapter 05, 64 MiB of RAM)" }),
      h("p", { class: "tsw__hint", text: "Each button sets the address to the start of that region. Only ram is in stage 2; every other region is a hole." }),
      h("ul", { class: "tsw__map-list", "aria-labelledby": id("map-title") }, items),
    );
  }

  function bitBoxes(title, geo, input, highlight) {
    const sp = M.splitAddress(geo, input);
    return h(
      "div",
      { class: "tsw__bits-wrap" },
      h("p", { class: "tsw__bits-title", text: `${title} ${M.hex(input)}` }),
      h(
        "div",
        { class: "tsw__bits", role: "list" },
        sp.top !== 0n ? h("span", { class: "tsw__bit tsw__bit--top", role: "listitem" }, h("span", { class: "tsw__bit-range", text: `[63:${geo.inBits}]` }), h("span", { class: "tsw__bit-val", text: `${M.hexRaw(sp.top)} (must be 0)` })) : null,
        sp.parts.map((p) =>
          h(
            "span",
            { class: `tsw__bit${highlight === p.label ? " is-current" : ""}`, role: "listitem" },
            h("span", { class: "tsw__bit-label", text: p.label === "offset" ? "offset" : `level ${p.label.slice(1)}` }),
            h("span", { class: "tsw__bit-range", text: `[${p.hi}:${p.lo}]` }),
            h("span", { class: "tsw__bit-val", text: p.label === "offset" || !state.predict || revealedIndex(p.label) ? M.hexSmall(p.value) : "?" }),
          ),
        ),
      ),
    );
  }

  let revealedLevels = new Set();
  function revealedIndex(label) {
    return revealedLevels.has(label);
  }

  function renderSplit(r, w, shown) {
    const parts = [];
    // In predict mode the index fields stay "?" until their step is revealed.
    revealedLevels = new Set();
    const seen = r.timeline.slice(0, shown);
    const s1Shown = seen.filter((t) => t.ref === "s1").map((t) => `L${r.s1.steps[t.i].level}`);
    const s2Shown = seen.filter((t) => t.ref === "s2").map((t) => `L${r.s2.steps[t.i].level}`);
    if (r.s1 && state.mode !== "s2") {
      revealedLevels = new Set(s1Shown);
      parts.push(bitBoxes(state.mode === "s1" ? "VA" : "Stage 1 input, VA", w.s1.geo, r.va, null));
    }
    const ipaVisible = r.ipa !== null && (state.mode === "s2" || seen.some((t) => t.ref === "s2" || t.ref === "end"));
    if (state.mode !== "s1" && ipaVisible) {
      revealedLevels = new Set(s2Shown);
      parts.push(bitBoxes("Stage 2 input, IPA", w.s2.geo, r.ipa, null));
    }
    fill(split, ...parts);
  }

  function windowRows(stage, geo, mem, stepRec, cardKey) {
    const l = M.levelInfo(geo, stepRec.level);
    const n = Math.min(16, l.entries);
    const start = Math.max(0, Math.min(stepRec.index - 7, l.entries - n));
    const focusIdx = rovers.has(cardKey) ? rovers.get(cardKey) : stepRec.index;
    const rows = [];
    for (let i = start; i < start + n; i++) {
      const addr = stepRec.tableBase + BigInt(i) * 8n;
      const d = M.readWord(mem, addr);
      const kind = M.descKind(d, stepRec.level, geo.granule);
      const onPath = i === stepRec.index;
      const edited = state.edits.some((e) => e.stage === stage && e.addr === addr);
      const selected = state.selected && state.selected.stage === stage && state.selected.addr === addr;
      const btn = h(
        "button",
        {
          type: "button",
          class: `tsw__entry${onPath ? " is-path" : ""}${selected ? " is-selected" : ""}${kind === "invalid" ? " is-invalid" : ""}`,
          tabindex: i === focusIdx ? "0" : "-1",
          "data-fkey": `row-${stage}-${addr.toString(16)}`,
          "aria-label": `Entry ${M.hexSmall(i)}: ${M.hex(d, 16)}, ${kind}${onPath ? ", on the walk" : ""}${edited ? ", edited" : ""}. Press Enter to edit.`,
          onclick: () => {
            rovers.set(cardKey, i);
            set(M.step(state, { type: "select", value: { stage, addr, level: stepRec.level } }), { keepGuess: true });
            const ed = editor.querySelector("[data-fkey='editor-first']");
            if (ed) ed.focus();
          },
          onkeydown: (e) => {
            const delta = { ArrowDown: 1, ArrowUp: -1, Home: -1e9, End: 1e9 }[e.key];
            if (delta === undefined) return;
            e.preventDefault();
            const ni = Math.max(start, Math.min(start + n - 1, i + delta));
            rovers.set(cardKey, ni);
            const sib = e.currentTarget.closest("ul").querySelectorAll("button")[ni - start];
            for (const b of e.currentTarget.closest("ul").querySelectorAll("button")) b.setAttribute("tabindex", "-1");
            sib.setAttribute("tabindex", "0");
            sib.focus();
          },
        },
        h("span", { class: "tsw__entry-idx", text: M.hexSmall(i) }),
        h("span", { class: "tsw__entry-val", text: M.hex(d, 16) }),
        h("span", { class: "tsw__entry-kind", text: `${kind}${edited ? " (edited)" : ""}` }),
        onPath ? h("span", { class: "tsw__entry-mark", text: "on the walk" }) : null,
      );
      rows.push(h("li", {}, btn));
    }
    return h(
      "div",
      { class: "tsw__table" },
      h("p", { class: "tsw__hint", text: `Entries ${M.hexSmall(start)} to ${M.hexSmall(start + n - 1)} of ${l.entries}, around the one the walk reads; the window follows the address, so type another address to see other entries. Arrow keys move between entries; Enter opens one for editing.` }),
      h("ul", { class: "tsw__entries", "aria-label": `Table at ${M.hex(stepRec.tableBase)}` }, rows),
    );
  }

  function stepCard(stage, stepRec, w, input, last, fault) {
    const geo = stage === 1 ? w.s1.geo : w.s2.geo;
    const mem = stage === 1 ? w.s1.mem : w.s2.mem;
    const owner = stage === 1 ? (state.mode === "s1" ? "the kernel's table, in physical memory" : "the guest's table, at an IPA in guest RAM") : "HVF's table, in host memory (address illustrative)";
    const cardKey = `${stage}-${stepRec.tableBase.toString(16)}`;
    let result;
    if (stepRec.kind === "table") result = `Table descriptor: next table at ${M.hex(stepRec.next ?? M.descAddress(stepRec.desc, geo.shift))}.`;
    else if (stepRec.kind === "block" || stepRec.kind === "page") {
      result = stepRec.out !== undefined ? `${stepRec.kind === "block" ? `Block of ${M.sizeText(M.leafSize(geo, stepRec.level))}` : `Page of ${M.sizeText(geo.pageBytes)}`}: output ${M.hex(stepRec.out)}.` : `Leaf descriptor, but the access is refused (see the readout).`;
    } else result = stepRec.kind === "reserved" ? "Not a legal descriptor at this level: the walk stops." : "Invalid descriptor: the walk stops.";
    if (last && fault) result += ` Fault: ${M.FAULT_NAMES[fault.kind]}, level ${fault.level}.`;
    return h(
      "li",
      { class: `tsw__card tsw__card--s${stage}${last && fault ? " is-fault" : ""}` },
      h("h4", { class: "tsw__card-title", text: `Stage ${stage}, level ${stepRec.level}: ${owner}` }),
      h("p", { class: "tsw__card-line", text: `Table at ${M.hex(stepRec.tableBase)}. Index ${M.indexHow(stepRec, input)}.` }),
      windowRows(stage, geo, mem, stepRec, cardKey),
      h("p", { class: `tsw__card-result${last && fault ? " is-fault" : ""}` }, h("span", { class: "tsw__tag", text: last && fault ? "Fault" : stepRec.kind === "table" ? "Next" : "Result" }), " ", result),
    );
  }

  function nestedCard(stepRec) {
    const n = stepRec.nested;
    const text = M.nestedText(stepRec);
    return h(
      "li",
      { class: `tsw__card tsw__card--nested${n.ok ? "" : " is-fault"}` },
      h("p", { class: "tsw__card-line" }, h("span", { class: "tsw__tag", text: n.ok ? "Stage 2" : "Fault" }), " ", text),
      n.steps.length
        ? h(
            "details",
            { class: "tsw__nested" },
            h("summary", { text: "Show the stage-2 reads" }),
            h(
              "ul",
              {},
              n.steps.map((s) => h("li", { class: "tsw__mono", text: `level ${s.level}: table ${M.hex(s.tableBase)}, index ${M.hexSmall(s.index)}, descriptor ${M.hex(s.desc, 16)} (${s.kind})` })),
            ),
          )
        : null,
    );
  }

  function renderWalk(r, w, shown) {
    const items = [];
    const seen = r.timeline.slice(0, shown);
    seen.forEach((t) => {
      if (t.ref === "s1n") items.push(nestedCard(r.s1.steps[t.i]));
      else if (t.ref === "s1") {
        const lastS1 = t.i === r.s1.steps.length - 1;
        const fault = lastS1 && !r.s1.ok && !r.s1.fault.s1ptw ? r.s1.fault : null;
        items.push(stepCard(1, r.s1.steps[t.i], w, r.va, lastS1, fault));
      } else if (t.ref === "s2") {
        const lastS2 = t.i === r.s2.steps.length - 1;
        items.push(stepCard(2, r.s2.steps[t.i], w, r.ipa, lastS2, lastS2 && !r.s2.ok ? r.s2.fault : null));
      }
    });
    if (items.length === 0) {
      items.push(h("li", { class: "tsw__card tsw__card--empty", text: shown >= r.timeline.length ? "No table was read: the address fails before the walk starts (see the readout)." : "Nothing read yet." }));
    }
    fill(walkList, ...items);
  }

  function nextPredictable(r, shown) {
    // A stage-2 translation of a table address comes before its stage-1 read; ask about the read.
    let t = r.timeline[shown];
    if (t && t.ref === "s1n") t = r.timeline[shown + 1];
    if (!t || (t.ref !== "s1" && t.ref !== "s2")) return null;
    const stage = t.ref === "s1" ? 1 : 2;
    const stepRec = stage === 1 ? r.s1.steps[t.i] : r.s2.steps[t.i];
    return { stage, stepRec, input: stage === 1 ? r.va : r.ipa };
  }

  function renderPredict(r, shown) {
    const np = state.predict ? nextPredictable(r, shown) : null;
    if (!np) {
      fill(predictPanel);
      predictPanel.hidden = true;
      return;
    }
    predictPanel.hidden = false;
    const idxIn = h("input", { id: id("guess-idx"), type: "text", value: guesses.index, autocomplete: "off", spellcheck: "false", "data-fkey": "guess-idx" });
    const addrIn = h("input", { id: id("guess-addr"), type: "text", value: guesses.addr, autocomplete: "off", spellcheck: "false", "data-fkey": "guess-addr" });
    const check = h("button", {
      type: "button",
      class: "tsw__btn",
      text: "Check",
      "data-fkey": "guess-check",
      onclick: () => {
        guesses = { index: idxIn.value, addr: addrIn.value, result: M.checkGuess(np.stepRec, { index: idxIn.value, addr: addrIn.value }) };
        render();
        const g = guesses.result;
        const bits = [];
        if (g.index) bits.push(g.index.ok ? "Index matches." : `Index: the lab gets ${g.index.expected}.`);
        if (g.addr) bits.push(g.addr.ok ? "Address matches." : `Address: the lab gets ${g.addr.expected}.`);
        announce(bits.length ? bits.join(" ") : "Type an index or an address first, or press Step to see it.");
      },
    });
    for (const inp of [idxIn, addrIn])
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          check.click();
        }
      });
    const fb = [];
    const g = guesses.result;
    if (g) {
      if (g.index) fb.push(h("li", { text: g.index.ok ? `Index ${g.index.expected}: matches.` : g.index.parsed ? `Index: the lab gets ${g.index.expected}. ${M.indexHow(np.stepRec, np.input)}.` : "Type the index as hex with 0x, or as decimal." }));
      if (g.addr) fb.push(h("li", { text: g.addr.ok ? `Descriptor address ${g.addr.expected}: matches.` : g.addr.parsed ? `Descriptor address: the lab gets ${g.addr.expected} (table base + index x 8).` : "Type the address as hex." }));
    }
    const geo = getWorld()[np.stage === 1 ? "s1" : "s2"].geo;
    fill(predictPanel, 
      h("h3", { text: `Predict: stage ${np.stage}, level ${np.stepRec.level}` }),
      h("p", { text: `This level uses bits [${np.stepRec.hi}:${np.stepRec.lo}] of ${M.hex(np.input)} (${np.stepRec.bits} bits, ${geo.granule} KiB granule). The table is at ${M.hex(np.stepRec.tableBase)}. Which entry does the walk read, and at which address? Nothing is scored; Step shows the answer either way.` }),
      h("div", { class: "tsw__row" }, labelled(id("guess-idx"), "Index", idxIn), labelled(id("guess-addr"), "Descriptor address", addrIn), check),
      fb.length ? h("ul", { class: "tsw__feedback" }, fb) : null,
    );
  }

  function renderReadout(r, w, shown, total) {
    if (shown < total) {
      summary.textContent = "The result appears here when the walk is complete.";
      fill(readoutBody);
      return;
    }
    const o = r.outcome;
    summary.textContent = o.summary;
    const body = [];
    const tag =
      o.kind === "ok"
        ? "No fault"
        : o.kind === "s1-fault"
          ? "Stage-1 fault: the guest handles it"
          : o.inHvf
            ? "Stage-2 abort handled inside HVF: no VM exit"
            : "Stage-2 fault: VM exit";
    body.push(h("p", { class: `tsw__verdict tsw__verdict--${o.kind}` }, h("span", { class: "tsw__tag", text: tag }), " ", `${M.accessInsn(state.access)} with x8 = ${M.hex(r.va)}, from EL${state.access.el}.`));
    if (o.regs) {
      body.push(
        h(
          "dl",
          { class: "tsw__regs" },
          o.regs.flatMap((g) => [h("dt", { text: g.name }), h("dd", {}, h("code", { text: g.value }), " ", g.note)]),
        ),
      );
      const esr = o.regs.find((g) => g.name.startsWith("ESR"));
      body.push(
        h(
          "p",
          {},
          "The ",
          link(`${GLOSSARY}#esr`, "ESR"),
          " (exception syndrome register) records why the exception happened. ",
          h("a", { href: `${ESR_LAB}#esr-decoder=${M.hexRaw(esr.raw)}`, text: `Decode ${esr.name} = ${M.hexRaw(esr.raw)} in the ESR decoder lab` }),
        ),
      );
    }
    if (o.vmmLine) body.push(h("p", {}, `${o.vmmLineLabel}: `, h("code", { text: o.vmmLine })));
    if (o.reaction) body.push(h("p", { text: o.reaction.text }));
    if (o.s1ptw) body.push(h("p", {}, "S1PTW means \"stage 1 page table walk\": the fault hit a table read, not the data. The ", link(`${PRIMERS}page-tables/`, "page-tables primer"), " explains it under the hood."));
    if (state.mode !== "s1" && r.ipa !== null && (o.kind !== "s1-fault")) {
      const ipa = o.kind === "s2-fault" ? o.ipa : r.ipa;
      const c = M.coverage(w, ipa);
      if (state.mode === "both" && c.guestPages > 1) {
        body.push(h("p", { text: `This stage-2 page covers IPAs ${M.hex(c.base)} to ${M.hex(c.end - 1n)}: ${c.guestPages} of the guest's ${M.sizeText(c.s1Page)} pages share its one entry, its permissions and its fault.` }));
      }
    }
    if (state.mode === "both" || (state.mode === "s1" && o.kind !== "s1-fault")) body.push(h("p", { class: "tsw__hint", text: `Memory reads for this access's translation: ${r.reads}.` }));
    fill(readoutBody, ...body);
  }

  function renderEditor(w) {
    const sel = state.selected;
    if (!sel) {
      editor.hidden = true;
      fill(editor);
      return;
    }
    editor.hidden = false;
    const stage = sel.stage;
    const level = sel.level;
    const geo = stage === 1 ? w.s1.geo : w.s2.geo;
    const mem = stage === 1 ? w.s1.mem : w.s2.mem;
    const d = M.readWord(mem, sel.addr);
    const dec = M.decodeDescriptor(d, { stage, level, granule: geo.granule, mair: w.s1.mair });
    const apply = (value) => {
      set(M.step(state, { type: "edit", stage, addr: sel.addr, value }), { keepGuess: true });
      announceOutcome(`Descriptor at ${M.hex(sel.addr)} is now ${M.hex(value, 16)}.`);
    };
    const toggle = (label, bit, fkey) =>
      h("button", { type: "button", class: "tsw__btn", "data-fkey": fkey, "aria-pressed": (d >> BigInt(bit)) & 1n ? "true" : "false", text: `${label}: ${(d >> BigInt(bit)) & 1n ? "1" : "0"}`, onclick: () => apply(d ^ (1n << BigInt(bit))) });
    const apSel = h(
      "select",
      { id: id("ap"), "data-fkey": "editor-ap" },
      (stage === 1 ? ["00 read/write (EL1)", "01 read/write (EL1 and EL0)", "10 read-only (EL1)", "11 read-only (EL1 and EL0)"] : ["00 no access", "01 read-only", "10 write-only", "11 read/write"]).map((t, i) => option(String(i), t, Number(M.field(d, 6, 2)) === i)),
    );
    apSel.addEventListener("change", () => apply(M.setField(d, 6, 2, Number(apSel.value))));
    const hexIn = h("input", { id: id("desc-hex"), type: "text", value: M.hex(d, 16), spellcheck: "false", autocomplete: "off", "data-fkey": "editor-hex", "aria-describedby": id("desc-hex-err") });
    const hexErr = h("p", { id: id("desc-hex-err"), class: "tsw__err", "aria-live": "polite" });
    const hexApply = () => {
      const p = M.parseHex(hexIn.value);
      if (!p.ok) {
        hexErr.textContent = p.error;
        hexIn.setAttribute("aria-invalid", "true");
        return;
      }
      apply(p.value);
    };
    hexIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        hexApply();
      }
    });
    fill(editor, 
      h("h3", { id: id("editor-title"), text: `Edit: stage ${stage}, level ${level}, entry at ${M.hex(sel.addr)}` }),
      h("p", { class: "tsw__hint", text: stage === 1 ? "The guest writes these tables, so it can write anything here; so can you. Escape closes this panel." : "Only HVF writes these tables; our VMM changes them through hv_vm_map, hv_vm_unmap and hv_vm_protect. The toggles stand for those calls. Escape closes this panel." }),
      h("p", { class: "tsw__mono", text: `${M.hex(d, 16)}: ${dec.kind}` }),
      h(
        "table",
        { class: "tsw__fields" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Field" }), h("th", { scope: "col", text: "Bits" }), h("th", { scope: "col", text: "Value" }), h("th", { scope: "col", text: "Meaning" }))),
        h(
          "tbody",
          {},
          dec.fields.map((f) => h("tr", {}, h("th", { scope: "row", text: f.name }), h("td", { class: "tsw__mono", text: f.bits }), h("td", { class: "tsw__mono", text: f.value }), h("td", { text: f.meaning }))),
        ),
      ),
      h(
        "div",
        { class: "tsw__buttons", role: "group", "aria-label": "Change this descriptor" },
        toggle("Valid, bit 0", 0, "editor-first"),
        toggle(level === 3 ? "Page, bit 1" : "Table, bit 1", 1, "editor-type"),
        toggle("Access flag, bit 10", 10, "editor-af"),
      ),
      labelled(id("ap"), stage === 1 ? "AP, bits [7:6]" : "S2AP, bits [7:6]", apSel),
      stage === 1
        ? h("div", { class: "tsw__field" }, h("label", { for: id("desc-hex"), text: "Whole descriptor (hex)" }), h("div", { class: "tsw__row" }, hexIn, h("button", { type: "button", class: "tsw__btn", text: "Apply", "data-fkey": "editor-apply", onclick: hexApply })), hexErr)
        : null,
      h(
        "div",
        { class: "tsw__buttons" },
        h("button", {
          type: "button",
          class: "tsw__btn",
          text: "Undo all edits",
          "data-fkey": "editor-undo",
          "aria-disabled": state.edits.length === 0 ? "true" : undefined,
          onclick: (e) => {
            if (isOff(e.currentTarget)) return;
            set(M.step(state, { type: "revert" }), { keepGuess: true });
            announceOutcome("All table edits undone.");
          },
        }),
        h("button", {
          type: "button",
          class: "tsw__btn",
          text: "Close",
          onclick: () => {
            const back = sel;
            set(M.step(state, { type: "select", value: null }), { keepGuess: true });
            const row = root.querySelector(`[data-fkey="row-${back.stage}-${back.addr.toString(16)}"]`);
            if (row) row.focus();
          },
        }),
      ),
    );
  }

  function renderNotes(w) {
    const notes = state.mode === "s2" ? [] : [...w.s1.notes];
    if (state.edits.length) notes.push(`${state.edits.length} table entr${state.edits.length === 1 ? "y is" : "ies are"} edited. Changing a granule or the IPA size rebuilds that stage's tables and drops its edits.`);
    if (!notes.length) {
      fill(notesBox);
      return;
    }
    fill(notesBox, h("h3", { text: "Notes on these tables" }), h("ul", {}, notes.map((n) => h("li", { text: n }))));
  }

  syncControls();
  render();

  return {
    destroy() {
      stopAuto();
      if (announceTimer) clearTimeout(announceTimer);
    },
  };
}
