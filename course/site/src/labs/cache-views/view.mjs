// cache-views view: renders the model's state and turns controls into model calls.
// No innerHTML anywhere: every node is built with createElement and textContent.
import {
  LINES,
  LINE_BYTES,
  SCENARIOS,
  OPERATIONS,
  lineAddress,
  hex8,
  initialState,
  apply,
  step,
  peek,
  coherent,
  loadScenario,
  encodeState,
  decodeState,
  describeAction,
  suggestValue,
  parseByte,
} from "./model.mjs";

const PLATFORM_LABEL = {
  arch: "What the architecture allows",
  apple: "Apple Silicon under HVF, as measured",
};
const GUEST_LABEL = {
  off: "MMU off: uncached (Device) accesses, around the cache",
  on: "MMU on: Normal cacheable memory",
};
const KIND_LABEL = { ok: "OK", stale: "STALE", lost: "LOST", info: "DONE", error: "ERROR" };

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("aria-") || k.startsWith("data-") || k === "role" || k === "for" || k === "scope")
      el.setAttribute(k, v === true ? "true" : String(v));
    else el[k] = v;
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

function option(value, label) {
  return h("option", { value, text: label });
}

export function mount(el, ctx) {
  const id = (s) => `${ctx.id}-${s}`;
  const announce = typeof ctx.announce === "function" ? ctx.announce : () => {};

  let state = null;
  const fromHash = ctx.hash && ctx.hash.get ? decodeState(ctx.hash.get()) : null;
  state = fromHash || loadScenario(SCENARIOS[0].id);
  // Point the maintenance buttons at the line the story is using (or was last used).
  let selected = state.pending[0]?.line ?? state.actions[state.actions.length - 1]?.line ?? 0;
  // The reader's guess for the next read step: null, "new" or "old".
  let prediction = null;
  let copyTimer = null;

  // ---- controls --------------------------------------------------------------------------
  const intro = h(
    "p",
    { class: "cv__intro" },
    "The VMM is the program that runs the virtual machine; the guest is the operating system inside it. Load a story, predict what happens, then press Next step. Afterwards, fix it with the maintenance buttons.",
  );
  if (ctx.standalone && ctx.base) {
    try {
      const primer = new URL("../../../primers/caches/", ctx.base);
      intro.append(" New to caches? Read the ", h("a", { href: primer.pathname, text: "caches primer" }), " first.");
    } catch {
      /* no link without a base URL */
    }
  }
  const platformSel = h("select", { id: id("platform") });
  for (const p of Object.keys(PLATFORM_LABEL)) platformSel.append(option(p, PLATFORM_LABEL[p]));
  const guestSel = h("select", { id: id("guest") });
  for (const g of Object.keys(GUEST_LABEL)) guestSel.append(option(g, GUEST_LABEL[g]));
  const modeNote = h("p", { class: "cv__note", id: id("mode-note") });

  const machine = h(
    "fieldset",
    { class: "cv__group" },
    h("legend", { text: "Machine" }),
    h("label", { for: id("platform"), text: "Platform" }),
    platformSel,
    h("label", { for: id("guest"), text: "Guest" }),
    guestSel,
    modeNote,
  );

  const scenarioSel = h("select", { id: id("scenario") });
  for (const sc of SCENARIOS) scenarioSel.append(option(sc.id, sc.title));
  const loadBtn = h("button", { type: "button", class: "cv__btn", text: "Load scenario" });
  const goal = h("p", { class: "cv__note" });
  const stepBtn = h("button", { type: "button", class: "cv__btn cv__btn--primary" });
  const predictQ = h("p", { class: "cv__note", id: id("predict-q") });
  const predictBtns = [
    ["new", "It gets the newest value"],
    ["old", "It gets an old value"],
  ].map(([val, label]) => {
    const b = h("button", { type: "button", class: "cv__btn", "aria-pressed": "false", "data-guess": val, text: label });
    b.addEventListener("click", () => {
      prediction = val;
      render();
      announce(`Prediction noted: ${label.toLowerCase()}. Press Next step to find out.`);
    });
    return b;
  });
  const predict = h(
    "div",
    { class: "cv__predict", role: "group", "aria-labelledby": id("predict-q") },
    predictQ,
    h("div", { class: "cv__btns" }, ...predictBtns),
  );
  const verdict = h("p", { class: "cv__verdict", id: id("verdict") });
  const scenario = h(
    "fieldset",
    { class: "cv__group" },
    h("legend", { text: "Scenario" }),
    h("label", { for: id("scenario"), text: "Story" }),
    h("div", { class: "cv__row" }, scenarioSel, loadBtn),
    goal,
    predict,
    stepBtn,
    verdict,
  );

  const lineSel = h("select", { id: id("line") });
  for (let i = 0; i < LINES; i++) lineSel.append(option(String(i), `Line ${i} (${lineAddress(i)})`));
  const valueIn = h("input", {
    id: id("value"),
    type: "text",
    inputMode: "text",
    autocomplete: "off",
    size: 6,
    maxLength: 6,
  });
  valueIn.spellcheck = false;
  valueIn.setAttribute("aria-describedby", id("value-help"));
  const valueHelp = h("span", { class: "cv__note", id: id("value-help"), text: "A hex byte; empty uses the suggestion." });
  const accessBtns = [
    ["vmm", "write", "VMM writes"],
    ["vmm", "read", "VMM reads"],
    ["guest", "write", "Guest writes"],
    ["guest", "read", "Guest reads"],
  ].map(([who, op, label]) => {
    const b = h("button", { type: "button", class: "cv__btn", text: label });
    b.addEventListener("click", () => access(who, op));
    return b;
  });
  const accessGroup = h(
    "fieldset",
    { class: "cv__group" },
    h("legend", { text: "Access" }),
    h("label", { for: id("line"), text: "Line" }),
    lineSel,
    h("label", { for: id("value"), text: "Value to write" }),
    valueIn,
    valueHelp,
    h("div", { class: "cv__btns" }, ...accessBtns),
  );

  const maintBtns = [
    ["clean", "Clean (DC CVAC)"],
    ["inval", "Invalidate (DC IVAC)"],
    ["cleaninval", "Clean and invalidate (DC CIVAC)"],
    ["evict", "Evict (the cache's own choice)"],
  ].map(([op, label]) => {
    const b = h("button", { type: "button", class: "cv__btn", text: label });
    b.addEventListener("click", () => act({ op, line: selected }));
    return b;
  });
  const maintNote = h("p", { class: "cv__note" });
  const elNote = h("p", {
    class: "cv__note",
    text: "Plain invalidate (DC IVAC) needs EL1, for example a guest kernel or firmware. A VMM running as an ordinary macOS process can only clean, or clean and invalidate (DC CVAC, DC CIVAC); on a clean line, clean and invalidate does exactly what invalidate does.",
  });
  const maint = h(
    "fieldset",
    { class: "cv__group" },
    h("legend", { text: "Cache maintenance on the selected line" }),
    maintNote,
    elNote,
    h("div", { class: "cv__btns" }, ...maintBtns),
  );

  const resetBtn = h("button", { type: "button", class: "cv__btn", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "cv__btn", text: "Copy link to this state" });
  const shareNote = h("p", { class: "cv__note", id: id("share-note") });
  copyBtn.setAttribute("aria-describedby", id("share-note"));
  const tools = h("div", { class: "cv__btns" }, resetBtn, copyBtn);

  const controls = h("div", { class: "cv__controls" }, intro, scenario, accessGroup, maint, machine, tools, shareNote);

  // ---- visualization -----------------------------------------------------------------------
  // The path is a small ASCII picture: hidden from screen readers, which get a sentence instead.
  const path = h("p", { class: "cv__path", id: id("path"), role: "img" });
  const pathArt = h("span", { "aria-hidden": "true" });
  path.append(pathArt);
  const tbody = h("tbody");
  const table = h(
    "table",
    { class: "cv__table" },
    h("caption", {
      text: `Four lines of guest RAM, ${LINE_BYTES} bytes apart (the smallest line size, CTR_EL0.DminLine), one byte shown per line. Real lines can be larger: 128 bytes on the Mac this course measured, so neighbouring lab lines can share one.`,
    }),
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { scope: "col", text: "Line" }),
        h("th", { scope: "col", text: "VMM's cache line" }),
        h("th", { scope: "col", text: "RAM (the Point of Coherency, PoC)" }),
        h("th", { scope: "col", text: "VMM would read" }),
        h("th", { scope: "col", text: "Guest would read" }),
      ),
    ),
    tbody,
  );
  const viz = h(
    "div",
    { class: "cv__viz" },
    path,
    h("div", { class: "cv__scroll", tabIndex: 0, role: "region", "aria-label": "Who sees what" }, table),
    h("p", { class: "cv__note", text: 'Choose a line with its button in the first column. Stale cells say STALE and have a dashed outline; dirty lines say Dirty. The two "would read" columns show ? while a story has steps left, so you can predict first.' }),
  );

  // ---- readout -----------------------------------------------------------------------------
  const summary = h("p", { class: "cv__summary", id: id("summary") });
  const fix = h("p", { class: "cv__fix" });
  const logList = h("ol", { class: "cv__log" });
  const opsBody = h("tbody");
  for (const o of OPERATIONS) {
    opsBody.append(
      h(
        "tr",
        { "data-op": o.op },
        h("th", { scope: "row" }, `${o.name} `, h("code", { text: o.insn })),
        h("td", { text: o.fixes }),
        h("td", { text: o.risk }),
      ),
    );
  }
  const opsTable = h(
    "details",
    { class: "cv__ops" },
    h("summary", { text: "Which operation fixes which direction" }),
    h(
      "div",
      { class: "cv__scroll", tabIndex: 0, role: "region", "aria-label": "Operations table" },
      h(
        "table",
        { class: "cv__table" },
        h(
          "thead",
          {},
          h("tr", {}, h("th", { scope: "col", text: "Operation" }), h("th", { scope: "col", text: "Fixes" }), h("th", { scope: "col", text: "Can go wrong" })),
        ),
        opsBody,
      ),
    ),
  );
  const readout = h(
    "div",
    { class: "cv__readout" },
    h("h3", { class: "cv__h", text: "Readout" }),
    summary,
    fix,
    h("h3", { class: "cv__h", text: "History" }),
    logList,
    opsTable,
  );

  // Rows are built once and updated in place, so a focused "Line N" button survives every
  // render and screen readers are not made to re-read the whole table.
  const rows = [];
  for (let i = 0; i < LINES; i++) {
    const pick = h("button", { type: "button", class: "cv__pick", "aria-label": `Select line ${i}, ${lineAddress(i)}` });
    pick.append(h("span", { text: `Line ${i}` }), h("span", { class: "cv__sub", text: lineAddress(i) }));
    pick.addEventListener("click", () => {
      selected = i;
      render();
      announce(`Line ${i} selected.`);
    });
    const cells = [h("td"), h("td"), h("td"), h("td")];
    const tr = h("tr", {}, h("th", { scope: "row" }, pick), ...cells);
    tbody.append(tr);
    rows.push({ tr, pick, cells });
  }

  const root = h("div", { class: "cv" }, controls, viz, readout);
  el.replaceChildren(root);

  // ---- behaviour ---------------------------------------------------------------------------
  function setHash() {
    try {
      // encodeState gives null once the history is too long to replay: clear the hash then,
      // rather than share a link that would rebuild a different machine.
      ctx.hash && ctx.hash.set && ctx.hash.set(encodeState(state));
    } catch {
      /* share state is a convenience */
    }
  }

  function resetCopyLabel() {
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = null;
    copyBtn.textContent = "Copy link to this state";
  }

  function commit(next, { speak = true } = {}) {
    state = next;
    resetCopyLabel();
    setHash();
    render();
    if (speak) {
      const ev = state.log[state.log.length - 1];
      if (ev) announce(`${KIND_LABEL[ev.kind]}. ${ev.text}. ${ev.detail}`);
    }
  }

  function act(action) {
    commit(apply(state, action));
  }

  function access(who, op) {
    if (op === "read") return act({ op, who, line: selected });
    let value;
    if (valueIn.value.trim() === "") value = suggestValue(state);
    else value = parseByte(valueIn.value);
    if (value === null) {
      valueIn.setAttribute("aria-invalid", "true");
      valueHelp.textContent = "Not a hex byte. Use 00 to FF, for example AB or 0xAB.";
      announce("Not a hex byte. Use 00 to FF.");
      valueIn.focus();
      return;
    }
    valueIn.removeAttribute("aria-invalid");
    valueHelp.textContent = "A hex byte; empty uses the suggestion.";
    valueIn.value = "";
    act({ op, who, line: selected, value });
  }

  platformSel.addEventListener("change", () => {
    prediction = null;
    verdict.textContent = "";
    commit(initialState(platformSel.value, guestSel.value), { speak: false });
    announce(`Platform: ${PLATFORM_LABEL[state.platform]}. Started over.`);
  });
  guestSel.addEventListener("change", () => {
    prediction = null;
    verdict.textContent = "";
    commit(initialState(platformSel.value, guestSel.value), { speak: false });
    announce(`Guest: ${GUEST_LABEL[state.guest]}. Started over.`);
  });
  lineSel.addEventListener("change", () => {
    selected = Number(lineSel.value);
    render();
  });
  loadBtn.addEventListener("click", () => {
    prediction = null;
    verdict.textContent = "";
    commit(loadScenario(scenarioSel.value), { speak: false });
    selected = state.pending[0]?.line ?? 0;
    render();
    const sc = SCENARIOS.find((x) => x.id === state.scenario);
    announce(`Loaded: ${sc.title}. ${sc.goal}`);
  });
  // aria-disabled, not the disabled property, so the button keeps keyboard focus when the
  // last step runs (a disabled element drops focus to <body>).
  stepBtn.addEventListener("click", () => {
    if (state.pending.length === 0) return;
    const next = state.pending[0];
    selected = next.line;
    const guess = next.op === "read" ? prediction : null;
    prediction = null;
    verdict.textContent = "";
    commit(step(state), { speak: false });
    const ev = state.log[state.log.length - 1];
    let said = ev ? `${KIND_LABEL[ev.kind]}. ${ev.text}. ${ev.detail}` : "";
    if (guess && ev) {
      const gotOld = ev.kind === "stale";
      const right = (guess === "old") === gotOld;
      verdict.textContent = `${right ? "Your prediction was right" : "Not what you predicted"}: it got ${gotOld ? "an old value" : "the newest value"}.`;
      said = `${verdict.textContent} ${said}`;
    }
    if (said) announce(said);
  });
  resetBtn.addEventListener("click", () => {
    state = initialState(state.platform, state.guest);
    selected = 0;
    prediction = null;
    verdict.textContent = "";
    resetCopyLabel();
    try {
      ctx.hash && ctx.hash.set && ctx.hash.set(null);
    } catch {
      /* ignore */
    }
    render();
    announce("Reset: RAM holds 0x00 everywhere and the cache is empty.");
  });
  copyBtn.addEventListener("click", async () => {
    if (encodeState(state) === null) {
      announce("This history is too long to share. Reset to share again.");
      return;
    }
    const url = String(globalThis.location ? globalThis.location.href : "");
    let label;
    try {
      await navigator.clipboard.writeText(url);
      announce("Link copied.");
      label = "Copied";
    } catch {
      announce("Could not copy. The address bar already holds the link to this state.");
      label = "Copy failed: use the address bar";
    }
    resetCopyLabel();
    copyBtn.textContent = label;
    copyTimer = setTimeout(resetCopyLabel, 2000);
  });

  function fill(td, text, { stale = false, dirty = false, hidden = false, extra = null } = {}) {
    td.className = ["cv__cell", stale && "is-stale", dirty && "is-dirty", hidden && "is-hidden"].filter(Boolean).join(" ");
    const kids = [h("span", { class: "cv__val", text })];
    if (stale) kids.push(h("span", { class: "cv__flag cv__flag--stale", text: "STALE" }));
    if (extra) kids.push(h("span", { class: "cv__sub", text: extra }));
    td.replaceChildren(...kids);
  }

  function render() {
    platformSel.value = state.platform;
    guestSel.value = state.guest;
    lineSel.value = String(selected);
    valueIn.placeholder = hex8(suggestValue(state)).slice(2);

    modeNote.textContent = coherent(state)
      ? state.platform === "apple" && state.guest === "off"
        ? "Models what chapter 04's memtest observed: the VMM and an MMU-off guest agree. It shows the outcome, not how the hardware achieves it."
        : "The guest's accesses use the same coherent cache as the VMM, so both see the same copy."
      : "The guest's loads and stores go straight to RAM; the VMM's go through its write-back cache.";
    if (coherent(state)) {
      path.setAttribute("aria-label", "The VMM and the guest both reach the line through the same cache, so they meet there.");
      pathArt.textContent = "VMM -> [ cache ] <- guest\nboth observers meet in the cache";
    } else {
      path.setAttribute("aria-label", "The VMM goes through its cache to RAM; the guest, with its MMU off, goes straight to RAM.");
      pathArt.textContent = "VMM -> [ cache ] -> RAM\nguest (MMU off) -> RAM, around the cache";
    }

    const sc = SCENARIOS.find((x) => x.id === state.scenario);
    if (sc) scenarioSel.value = sc.id;
    goal.textContent = sc ? sc.goal : "No scenario loaded. Pick one and press Load, or use the controls freely.";
    const pending = state.pending.length > 0;
    if (pending) {
      const total = sc ? sc.steps.length : state.pending.length;
      const n = total - state.pending.length + 1;
      stepBtn.textContent = `Next step (${n} of ${total}): ${describeAction(state.pending[0])}`;
      stepBtn.removeAttribute("aria-disabled");
    } else {
      stepBtn.textContent = sc ? "Scenario done: now fix it yourself" : "No steps pending";
      stepBtn.setAttribute("aria-disabled", "true");
    }
    const nextRead = pending && state.pending[0].op === "read" ? state.pending[0] : null;
    predict.hidden = !nextRead;
    if (nextRead) {
      predictQ.textContent = `Predict before you press Next step: when the ${nextRead.who === "vmm" ? "VMM" : "guest"} reads line ${nextRead.line}, what does it get? (Optional.)`;
    }
    for (const b of predictBtns) b.setAttribute("aria-pressed", String(b.dataset.guess === prediction));
    maintNote.textContent = `Acts on line ${selected} (${lineAddress(selected)}), in the VMM's cache.`;

    // While a story has steps left, hide who would read what: the reader predicts first.
    for (let i = 0; i < LINES; i++) {
      const { tr, pick, cells } = rows[i];
      const c = state.cache[i];
      const r = state.ram[i];
      const vm = peek(state, "vmm", i);
      const gu = peek(state, "guest", i);
      pick.setAttribute("aria-pressed", i === selected ? "true" : "false");
      tr.classList.toggle("is-selected", i === selected);
      const cacheText = c.valid ? hex8(c.value) : "-";
      const cacheState = c.valid ? (c.dirty ? "Dirty" : "Clean") : "Invalid";
      fill(cells[0], cacheText, { dirty: c.valid && c.dirty, extra: cacheState });
      fill(cells[1], hex8(r.value));
      for (const [td, v] of [
        [cells[2], vm],
        [cells[3], gu],
      ]) {
        if (pending) fill(td, "?", { hidden: true, extra: "press Next step to find out" });
        else fill(td, hex8(v.value), { stale: v.stale, extra: v.from === "cache" ? "from cache" : "from RAM" });
      }
    }

    const shareable = encodeState(state) !== null;
    if (shareable) copyBtn.removeAttribute("aria-disabled");
    else copyBtn.setAttribute("aria-disabled", "true");
    shareNote.textContent = shareable
      ? ""
      : "History too long to share (more than 64 actions): a link could not rebuild this state. Reset to share again.";

    const ev = state.log[state.log.length - 1];
    if (ev) {
      summary.textContent = `${KIND_LABEL[ev.kind]}: ${ev.text}. ${ev.detail}`;
      summary.dataset.kind = ev.kind;
      fix.textContent = ev.fix ? `Fix: ${ev.fix}` : "";
    } else {
      summary.textContent = "Nothing has happened yet. RAM holds 0x00 everywhere and the cache is empty.";
      summary.dataset.kind = "info";
      fix.textContent = "";
    }

    logList.replaceChildren();
    for (const e of state.log.slice(-8)) {
      logList.append(
        h(
          "li",
          { "data-kind": e.kind },
          h("span", { class: `cv__flag cv__flag--${e.kind}`, text: KIND_LABEL[e.kind] }),
          ` ${e.text}. `,
          h("span", { class: "cv__sub", text: e.detail }),
        ),
      );
    }
    for (const tr of opsBody.children) tr.classList.toggle("is-current", tr.dataset.op === state.lastOp);
  }

  render();
  return {
    destroy() {
      if (copyTimer) clearTimeout(copyTimer);
      el.replaceChildren();
    },
  };
}
