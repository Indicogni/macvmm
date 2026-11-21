// syscall-stepper view: renders the model's state and turns button presses into model calls.
// All logic lives in model.mjs; this file only builds DOM (createElement + textContent, never
// innerHTML) inside the element the lab shell hands us. See course/site/LABS.md.
import {
  SCENARIOS, SCENARIO_IDS, KERNEL_CODE, PANEL, MODE_NAMES, VBAR, PAGE_SIZE,
  stateAt, trace, panelValues, changedFields, scorePrediction, encodeShare, decodeShare, isDefaultShare, hex,
} from "./model.mjs";

const STORAGE_KEY = "vmm-lab-syscall-stepper-v1";

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

function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return { arm: Boolean(v && v.arm === true), predict: !(v && v.predict === false) };
  } catch {
    return { arm: false, predict: true };
  }
}

function savePrefs(p) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ arm: Boolean(p.arm), predict: Boolean(p.predict) }));
  } catch {
    /* storage blocked: the lab works without it */
  }
}

const WHO = {
  app: "the app (user mode)",
  kernel: "the kernel (kernel mode)",
};

export function mount(el, ctx) {
  const id = ctx.id;
  const rawHash = ctx.hash.get();
  const shared = decodeShare(rawHash);
  const prefs = loadPrefs();
  let ui = {
    scenario: shared ? shared.scenario : "svc",
    steps: shared ? shared.steps : 0,
    arm: shared ? shared.arm : prefs.arm,
    predict: prefs.predict,
    predicted: new Set(),
    lastScore: null,
  };
  let timer = null;
  let lastAnnounce = 0;

  // Throttled announcements (about one per 300 ms; the latest text wins).
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

  // ---- static skeleton ------------------------------------------------------------------
  const scenarioSel = h("select", { id: `${id}-scenario` });
  for (const sid of SCENARIO_IDS) scenarioSel.append(h("option", { value: sid, text: SCENARIOS[sid].title }));
  const stepBtn = h("button", { type: "button", class: "ss-btn ss-btn--primary", text: "Step" });
  const backBtn = h("button", { type: "button", class: "ss-btn", text: "Back" });
  const runBtn = h("button", { type: "button", class: "ss-btn", text: "Run to end" });
  const resetBtn = h("button", { type: "button", class: "ss-btn", text: "Reset" });
  const nearStepBtn = h("button", { type: "button", class: "ss-btn ss-btn--primary", text: "Next step" });
  const nearBackBtn = h("button", { type: "button", class: "ss-btn", text: "Previous step" });
  const near = h("div", { class: "ss-buttons ss-near", role: "group", "aria-label": "Stepping, beside the panel" }, nearStepBtn, nearBackBtn);
  const shareBtn = h("button", { type: "button", class: "ss-btn", text: "Copy link to this step" });
  const armBox = h("input", { type: "checkbox", id: `${id}-arm` });
  const predictBox = h("input", { type: "checkbox", id: `${id}-predict` });

  const controls = h("div", { class: "ss-controls" },
    h("div", { class: "ss-field" }, h("label", { for: `${id}-scenario`, text: "Program" }), scenarioSel),
    h("div", { class: "ss-buttons ss-stepping", role: "group", "aria-label": "Stepping" }, stepBtn, backBtn, runBtn, resetBtn),
    h("div", { class: "ss-field ss-field--check" }, predictBox, h("label", { for: `${id}-predict`, text: "Predict before each step" })),
    h("div", { class: "ss-field ss-field--check" }, armBox, h("label", { for: `${id}-arm`, text: "Show Arm register names (chapter 02)" })),
    h("div", { class: "ss-buttons" }, shareBtn),
  );
  const scenarioSummary = h("p", { class: "ss-summary" });

  // State panel: the four labels, each with a "predict" checkbox.
  const panelBody = h("tbody", { role: "rowgroup" });
  const panelRows = {};
  for (const p of PANEL) {
    const box = h("input", { type: "checkbox", id: `${id}-pred-${p.key}` });
    box.addEventListener("change", () => {
      if (box.checked) ui.predicted.add(p.key);
      else ui.predicted.delete(p.key);
    });
    const armName = h("span", { class: "ss-arm", text: ` ${p.arm}` });
    const value = h("td", { class: "ss-value", role: "cell" });
    const result = h("td", { class: "ss-result", role: "cell", "data-label": "Last step" });
    const row = h("tr", { role: "row" },
      h("th", { scope: "row", role: "rowheader" }, p.label, armName),
      value,
      h("td", { class: "ss-predict", role: "cell", "data-label": "Will change?" }, box, h("label", { for: `${id}-pred-${p.key}`, class: "ss-visually-hidden", text: `I predict ${p.label} changes on the next step` })),
      result,
    );
    panelRows[p.key] = { row, value, result, box, armName };
    panelBody.append(row);
  }
  const caption = h("caption");
  const panel = h("table", { class: "ss-panel", role: "table" },
    caption,
    h("thead", { role: "rowgroup" }, h("tr", { role: "row" },
      h("th", { scope: "col", role: "columnheader", text: "Label" }),
      h("th", { scope: "col", role: "columnheader", text: "Value" }),
      h("th", { scope: "col", role: "columnheader", class: "ss-predict", text: "Will change?" }),
      h("th", { scope: "col", role: "columnheader", text: "Last step" }),
    )),
    panelBody,
  );
  const leftover = h("p", { class: "ss-note", hidden: true, text: "After eret, the saved return address and the reason still show the last exception's values. Nothing clears them: the hardware rewrites them only when the next exception arrives." });
  const scoreLine = h("p", { class: "ss-score" });

  // Code listings.
  // role="list" keeps list semantics in WebKit, which drops them under list-style: none.
  const appList = h("ol", { class: "ss-code", role: "list", "aria-label": "App code, runs in user mode" });
  const kernList = h("ol", { class: "ss-code", role: "list", "aria-label": "Kernel code, runs in kernel mode" });
  const code = h("div", { class: "ss-listings" },
    h("div", { class: "ss-listing" }, h("h3", { text: "App (user mode, EL0)" }), appList),
    h("div", { class: "ss-listing" },
      h("h3", { text: "Kernel (kernel mode, EL1)" }),
      h("p", { class: "ss-note", text: `Vector table base ${hex(VBAR)}; the slot for "synchronous, from user mode" is at base + 0x400.` }),
      kernList),
  );

  // What the last step did, plus the summary readout.
  const lastStep = h("p", { class: "ss-last" });
  // Not a live region: announcements go through ctx.announce only (LABS.md section 6: one channel).
  const readout = h("p", { class: "ss-readout" });
  const haltBox = h("p", { class: "ss-halt", hidden: true });

  // More state.
  const moreBody = h("tbody");
  const more = h("details", { class: "ss-more" },
    h("summary", { text: "More state: registers, saved mode, fault address, memory" }),
    h("table", { class: "ss-regs" }, moreBody),
  );

  const honesty = h("details", { class: "ss-more" },
    h("summary", { text: "What this toy simplifies" }),
    h("ul", {},
      h("li", { text: "Addresses are small and flat so they fit on screen. A real arm64 kernel lives at very high addresses, and macOS leaves the app's lowest 4 GiB unmapped." }),
      h("li", { text: "A real kernel first saves all of the app's registers to memory; this one only uses scratch registers the app does not." }),
      h("li", { text: "This kernel knows one service, 20 (getpid), and always answers 42; any other number in x16 gets error 78 (ENOSYS)." }),
      h("li", { text: "bl map_page and bl kill_process each run a whole kernel function in one step." }),
      h("li", { text: "The page-table walk is reduced to \"is this 4 KiB page mapped?\". The reason values are encoded exactly as the CPU encodes them, for this toy's page table: 0x56000080 for svc #0x80 and 0x92000047 for the write fault. Your Mac uses 16 KiB pages, so a real null store is caught at a higher level of the page table and the last hex digit differs (typically 0x92000046)." }),
      h("li", { text: "The kernel sits at EL1, the textbook Arm picture that Linux uses. On a Mac, part of the macOS kernel runs one level higher, at EL2 (chapter 01 shows the stack, chapter 02 the levels)." }),
      h("li", { text: "macOS's real system-call handler is far longer, and reports errors through a flag as well as x0. Linux on Arm puts the service number in x8 and uses svc #0." }),
    ),
  );

  el.append(
    h("div", { class: "ss-wrap" },
      controls, scenarioSummary,
      h("div", { class: "ss-main" },
        h("div", { class: "ss-col" }, panel, near, leftover, scoreLine, lastStep, haltBox),
        h("div", { class: "ss-col" }, code),
      ),
      readout, more, honesty,
    ),
  );

  // ---- rendering ------------------------------------------------------------------------
  function renderListing(list, code, s) {
    list.replaceChildren();
    for (const ins of code) {
      const current = s.pc === ins.addr;
      const li = h("li", { class: current ? "ss-line ss-line--current" : "ss-line" },
        h("span", { class: "ss-marker", "aria-hidden": "true", text: current ? "▶" : "" }),
        h("span", { class: "ss-addr", text: hex(ins.addr, 4) }),
        h("code", { class: "ss-ins", text: ins.text }),
        h("span", { class: "ss-com", text: `; ${ins.note}` }),
      );
      if (current) {
        li.setAttribute("aria-current", "step");
        li.prepend(h("span", { class: "ss-visually-hidden", text: "Next to run: " }));
      }
      list.append(li);
    }
  }

  const LABEL_WORDS = { mode: "mode", pc: "PC", elr: "saved return address", esr: "reason" };

  // Move focus off a control that is about to be disabled, so keyboard and screen-reader users
  // keep their place (a disabled focused button sends focus to <body> in Chrome and Safari).
  function keepFocus(s) {
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    if (s.halted && (active === stepBtn || active === runBtn)) resetBtn.focus();
    else if (s.halted && active === nearStepBtn) nearBackBtn.focus();
    else if (s.steps === 0 && active === backBtn) stepBtn.focus();
    else if (s.steps === 0 && active === nearBackBtn) nearStepBtn.focus();
  }

  function render({ writeHash = true } = {}) {
    const tr = trace(ui.scenario);
    const s = stateAt(ui.scenario, ui.steps);
    const prev = s.steps > 0 ? tr[s.steps - 1] : null;
    const vals = panelValues(s);
    const changed = prev ? changedFields(prev, s) : [];

    scenarioSel.value = ui.scenario;
    scenarioSummary.textContent = SCENARIOS[ui.scenario].summary;
    armBox.checked = ui.arm;
    predictBox.checked = ui.predict;
    el.classList.toggle("ss-show-arm", ui.arm);
    el.classList.toggle("ss-no-predict", !ui.predict);
    caption.textContent = ui.predict
      ? "CPU state. Tick the labels you think will change; unticked means you expect it to stay the same. Then press Step."
      : "CPU state. Press Step and watch which labels change.";

    for (const p of PANEL) {
      const r = panelRows[p.key];
      r.value.textContent = vals[p.key];
      if (ui.arm && p.key === "esr" && s.esr !== null) r.value.textContent += ` (${hex(s.esr, 8)})`;
      r.box.checked = ui.predicted.has(p.key);
      r.box.disabled = Boolean(s.halted) || !ui.predict;
      const did = changed.includes(p.key);
      r.row.classList.toggle("ss-changed", did);
      let txt = prev ? (did ? "changed" : "same") : "";
      if (ui.lastScore) {
        const row = ui.lastScore.rows.find((x) => x.key === p.key);
        txt += row.right ? " ✓ you were right" : " ✗ you guessed " + (row.predicted ? "changed" : "same");
      }
      r.result.textContent = txt;
    }
    scoreLine.textContent = ui.lastScore
      ? `Your prediction: ${ui.lastScore.right} of ${ui.lastScore.total} labels right.`
      : "";
    leftover.hidden = !(s.el === 0 && s.elr !== null && !s.halted);

    renderListing(appList, SCENARIOS[ui.scenario].app, s);
    renderListing(kernList, KERNEL_CODE, s);

    if (s.last) {
      lastStep.textContent = `Step ${s.steps}: ${hex(s.last.addr, 4)} ${s.last.text.replace(/\s+/g, " ")}, run by ${WHO[s.last.who]}. ${s.last.detail}.`;
    } else {
      lastStep.textContent = "Nothing has run yet. The app is about to execute its first instruction in user mode.";
    }
    haltBox.hidden = !s.halted;
    haltBox.textContent = s.halted ? s.halted.text : "";

    keepFocus(s);
    stepBtn.disabled = nearStepBtn.disabled = Boolean(s.halted);
    runBtn.disabled = Boolean(s.halted);
    backBtn.disabled = nearBackBtn.disabled = s.steps === 0;

    // More state.
    moreBody.replaceChildren();
    const rows = [
      ["x0", hex(s.regs.x0)], ["x1", hex(s.regs.x1)], ["x2", hex(s.regs.x2)],
      ["x9", hex(s.regs.x9)], ["x10", hex(s.regs.x10)], ["x11", hex(s.regs.x11)], ["x12", hex(s.regs.x12)],
      ["x16", hex(s.regs.x16)],
      ["interrupts", s.daif ? "masked" : "allowed"],
      [ui.arm ? "saved mode (SPSR_EL1)" : "saved mode",
        s.spsr === null ? "(none yet)" : `${MODE_NAMES[(s.spsr & 0xf) === 0 ? 0 : 1]}, interrupts ${((s.spsr >>> 6) & 0xf) ? "masked" : "allowed"} (${hex(s.spsr, 8)})`],
      [ui.arm ? "fault address (FAR_EL1)" : "fault address", s.far === null ? "(none yet)" : hex(s.far)],
      ["mapped data pages", s.mapped.filter((p) => p !== 0x1).map((p) => hex(p * PAGE_SIZE)).join(", ") || "(none)"],
      ["memory written", Object.entries(s.mem).map(([a, v]) => `${a} = ${hex(v)}`).join(", ") || "(nothing)"],
    ];
    for (const [k, v] of rows) moreBody.append(h("tr", {}, h("th", { scope: "row", text: k }), h("td", { text: v })));

    const where = `${vals.mode}, PC ${vals.pc}`;
    readout.textContent = s.halted
      ? `Step ${s.steps} of ${tr.length - 1}. ${s.halted.text}`
      : `Step ${s.steps} of ${tr.length - 1}. ${where}. Saved return address: ${vals.elr}. Reason: ${vals.esr}.`;

    if (writeHash) {
      const st = { scenario: ui.scenario, steps: s.steps, arm: ui.arm };
      ctx.hash.set(isDefaultShare(st) ? null : encodeShare(st));
    }
    return { s, prev, changed };
  }

  // One spoken sentence per action: what the step did and why, which labels changed, the score.
  function announcement({ s, prev, changed }) {
    const parts = [lastStep.textContent];
    if (prev) {
      parts.push(changed.length
        ? `Changed: ${changed.map((k) => LABEL_WORDS[k]).join(", ")}.`
        : "Nothing in the panel changed.");
    }
    if (ui.lastScore) parts.push(`Your prediction: ${ui.lastScore.right} of ${ui.lastScore.total} right.`);
    if (s.halted) parts.push(s.halted.text);
    return parts.join(" ");
  }

  function go(steps, { score = false } = {}) {
    const before = stateAt(ui.scenario, ui.steps);
    ui.steps = Math.max(0, steps);
    const after = stateAt(ui.scenario, ui.steps);
    ui.steps = after.steps;
    ui.lastScore = score && ui.predict && after.steps === before.steps + 1
      ? scorePrediction([...ui.predicted], changedFields(before, after))
      : null;
    ui.predicted = new Set();
    say(announcement(render()));
  }

  // ---- events ---------------------------------------------------------------------------
  stepBtn.addEventListener("click", () => go(ui.steps + 1, { score: true }));
  backBtn.addEventListener("click", () => go(ui.steps - 1));
  nearStepBtn.addEventListener("click", () => go(ui.steps + 1, { score: true }));
  nearBackBtn.addEventListener("click", () => go(ui.steps - 1));
  runBtn.addEventListener("click", () => go(trace(ui.scenario).length - 1));
  resetBtn.addEventListener("click", () => go(0));
  scenarioSel.addEventListener("change", () => {
    if (SCENARIO_IDS.includes(scenarioSel.value)) ui.scenario = scenarioSel.value;
    go(0);
  });
  armBox.addEventListener("change", () => {
    ui.arm = armBox.checked;
    savePrefs({ arm: ui.arm, predict: ui.predict });
    render();
  });
  predictBox.addEventListener("change", () => {
    ui.predict = predictBox.checked;
    ui.predicted = new Set();
    ui.lastScore = null;
    savePrefs({ arm: ui.arm, predict: ui.predict });
    render();
  });
  shareBtn.addEventListener("click", async () => {
    // The default state has no share string: its link is the plain page URL.
    render();
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this step is in the address bar.");
    }
  });

  // First paint: write the hash only if the URL carried one (restored, clamped, or a hostile
  // value to clear). A fresh visit leaves the page's own #anchor alone.
  render({ writeHash: rawHash !== null && rawHash !== undefined && rawHash !== "" });

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
