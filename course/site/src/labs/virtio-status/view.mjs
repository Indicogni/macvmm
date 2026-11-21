// virtio-status view: renders the model's state and turns form input into model actions. All
// transport logic lives in model.mjs; this file only builds DOM (createElement + textContent,
// never innerHTML) inside the element the lab shell hands us. See course/site/LABS.md.
import {
  REGISTERS, REG, SIZES, STATUS, STATUS_STEPS, STATUS_BITS, DEVICES, PRESETS, DEFAULT_PRESET,
  MAX_ACTIONS, WINDOW, RAM_BASE,
  apply, replay, formatTrace, statusRead, statusNames, featureNames, driverFeatures, queueView,
  ramEnd, preset, hex, regName, validateAction, parseNumber, scoreGuess, encodeShare, decodeShare,
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

const OTHER = "other";
const CONFIG_OPT = "config";
const GROUPS = [
  ["captured", "Captured on a real Mac"],
  ["misbehaves", "The driver misbehaves"],
  ["blank", "Start with no steps"],
];
const BIT_TAGS = { FAILED: "FAIL", DEVICE_NEEDS_RESET: "NEEDS RESET", FEATURES_OK: "FEAT OK", DRIVER_OK: "DRV OK", DRIVER: "DRV", ACKNOWLEDGE: "ACK" };
const LADDER = [
  { value: 0x0, name: "reset", text: "0x0: reset" },
  { value: 0x1, name: "ACKNOWLEDGE", text: "0x1: ACKNOWLEDGE, \"I have seen a virtio device\"" },
  { value: 0x3, name: "DRIVER", text: "0x3: + DRIVER, \"and I have a driver for it\"" },
  { value: 0xb, name: "FEATURES_OK", text: "0xb: + FEATURES_OK, \"these are the features I will use\"" },
  { value: 0xf, name: "DRIVER_OK", text: "0xf: + DRIVER_OK, \"the queues are set up, start working\"" },
];

export function mount(el, ctx) {
  const id = ctx.id;
  const shared = decodeShare(ctx.hash.get());
  let ui = shared
    ? { preset: shared.preset, actions: shared.actions, cursor: shared.cursor }
    : { preset: DEFAULT_PRESET, actions: [...preset(DEFAULT_PRESET).actions], cursor: 0 };
  let guess = null;
  let lastScore = null;
  let message = "";
  let timer = null;
  let lastAnnounce = 0;

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

  // ---- scenario ---------------------------------------------------------------------------
  const presetSel = h("select", { id: `${id}-preset` });
  for (const [g, label] of GROUPS) {
    const og = h("optgroup", { label });
    for (const p of PRESETS.filter((x) => x.group === g)) og.append(h("option", { value: p.key, text: p.title }));
    presetSel.append(og);
  }
  const aboutEl = h("p", { class: "vs-note" });
  const deviceEl = h("p", { class: "vs-note" });
  const scenarioBox = h("div", { class: "vs-scenario" },
    h("div", { class: "vs-field" }, h("label", { for: `${id}-preset`, text: "Scenario" }), presetSel),
    aboutEl, deviceEl);

  // ---- the walk ---------------------------------------------------------------------------
  const stepBtn = h("button", { type: "button", class: "vs-btn vs-btn--primary", text: "Step" });
  const backBtn = h("button", { type: "button", class: "vs-btn", text: "Back" });
  const runBtn = h("button", { type: "button", class: "vs-btn", text: "Run to end" });
  const restartBtn = h("button", { type: "button", class: "vs-btn", text: "Restart scenario" });
  const resetBtn = h("button", { type: "button", class: "vs-btn", text: "Reset (no steps)" });
  const shareBtn = h("button", { type: "button", class: "vs-btn", text: "Copy link" });
  const nextLine = h("p", { class: "vs-next" });
  const guessSel = h("select", { id: `${id}-guess` },
    h("option", { value: "", text: "no guess" }),
    h("option", { value: "takes", text: "takes the write" }),
    h("option", { value: "ignores", text: "ignores or refuses it" }),
  );
  const guessField = h("div", { class: "vs-field vs-field--inline" },
    h("label", { for: `${id}-guess`, text: "Predict: the device" }), guessSel);
  const scoreEl = h("p", { class: "vs-score" });
  const intro = h("p", { class: "vs-intro", text: "You watch (or play) the guest's driver; the lab plays macvmm's device. Press Step to apply the driver's next register access and watch Status climb the ladder. Before each write, predict whether the device takes it." });
  const walkBox = h("div", { class: "vs-walk" },
    intro,
    h("div", { class: "vs-buttons", role: "group", "aria-label": "Stepping" }, stepBtn, backBtn, runBtn, restartBtn, resetBtn, shareBtn),
    nextLine, guessField, scoreEl);

  // ---- driver controls --------------------------------------------------------------------
  const regSel = h("select", { id: `${id}-reg` });
  for (const r of REGISTERS) regSel.append(h("option", { value: String(r.off), text: `${r.name} (${hex(r.off, 3)})` }));
  regSel.append(h("option", { value: CONFIG_OPT, text: "Config space (0x100 and up)..." }));
  regSel.append(h("option", { value: OTHER, text: "Another offset..." }));
  const offIn = h("input", { id: `${id}-off`, type: "text", autocomplete: "off", spellcheck: "false", value: "0x100", size: "7" });
  const offLabel = h("label", { for: `${id}-off`, text: "Offset (0x000 to 0x1ff)" });
  const offField = h("div", { class: "vs-field", hidden: true }, offLabel, offIn);
  const sizeSel = h("select", { id: `${id}-size` });
  for (const s of SIZES) sizeSel.append(h("option", { value: String(s), text: `${8 * s}-bit` }));
  sizeSel.value = "4";
  const valIn = h("input", { id: `${id}-val`, type: "text", autocomplete: "off", spellcheck: "false", value: "0x1", size: "11" });
  const writeBtn = h("button", { type: "button", class: "vs-btn", text: "Write" });
  const readBtn = h("button", { type: "button", class: "vs-btn", text: "Read" });
  const configBtn = h("button", { type: "button", class: "vs-btn", text: "Device changes its config" });
  const configNote = h("p", { class: "vs-note" });
  const regNote = h("p", { class: "vs-note" });
  const driverSet = h("fieldset", { class: "vs-box" },
    h("legend", { text: "Driver: load and store (slot 0, 0x0a00_0000)" }),
    h("div", { class: "vs-row" },
      h("div", { class: "vs-field" }, h("label", { for: `${id}-reg`, text: "Register" }), regSel),
      offField,
      h("div", { class: "vs-field" }, h("label", { for: `${id}-size`, text: "Width" }), sizeSel),
      h("div", { class: "vs-field" }, h("label", { for: `${id}-val`, text: "Value to write" }), valIn),
      h("div", { class: "vs-buttons" }, writeBtn, readBtn),
    ),
    regNote,
  );
  const deviceSet = h("fieldset", { class: "vs-box" },
    h("legend", { text: "Device side (not the driver)" }),
    h("div", { class: "vs-row vs-row--device" },
      h("div", { class: "vs-buttons" }, configBtn),
      configNote,
    ),
  );
  // Closed on first contact so the stepping controls come first; opened for the blank scenarios.
  const driverBox = h("details", { class: "vs-more vs-own" },
    h("summary", { text: "Make your own accesses" }), driverSet, deviceSet);

  // ---- device state -----------------------------------------------------------------------
  const ladder = h("ol", { class: "vs-ladder", "aria-label": "The status handshake, in order" });
  const flagsEl = h("p", { class: "vs-flags" });
  const bitsHead = h("tr", {}, h("th", { scope: "col", text: "bit" }));
  for (const b of [...STATUS_BITS].reverse()) {
    // A short visible tag plus the full name for screen readers, so no meaning hides in a tooltip.
    const unused = b.name.startsWith("bit ");
    bitsHead.append(h("th", { scope: "col" }, `${Math.log2(b.mask)}`,
      h("span", { class: "vs-bitname", "aria-hidden": "true", text: BIT_TAGS[b.name] ?? "-" }),
      h("span", { class: "visually-hidden", text: unused ? " unused" : ` ${b.name}` })));
  }
  bitsHead.append(h("th", { scope: "col", text: "value" }));
  const bitsBody = h("tbody");
  const bitsTable = h("table", { class: "vs-bits" },
    h("caption", { text: "Status as the driver reads it, bit by bit (7 FAILED, 6 DEVICE_NEEDS_RESET, 3 FEATURES_OK, 2 DRIVER_OK, 1 DRIVER, 0 ACKNOWLEDGE)" }),
    h("thead", {}, bitsHead), bitsBody);
  const statusCol = h("div", { class: "vs-col" },
    h("h3", { text: "Status" }), ladder, flagsEl, h("div", { class: "vs-scroll" }, bitsTable));

  const featBody = h("tbody");
  const featTable = h("table", { class: "vs-kv" }, h("caption", { text: "Feature negotiation (64 bits, 32 at a time)" }), featBody);
  const queueBody = h("tbody");
  const queueTable = h("table", { class: "vs-kv" }, h("caption", { text: "Queues" }), queueBody);
  const intBody = h("tbody");
  const intTable = h("table", { class: "vs-kv" }, h("caption", { text: "Interrupt, selectors, config" }), intBody);
  const lineEl = h("p", { class: "vs-line" });
  const regsCol = h("div", { class: "vs-col" },
    h("div", { class: "vs-scroll" }, featTable),
    h("div", { class: "vs-scroll" }, queueTable),
    lineEl,
    h("div", { class: "vs-scroll" }, intTable));
  const device = h("div", { class: "vs-device" }, statusCol, regsCol);

  // ---- readout, log -----------------------------------------------------------------------
  // Not a live region: every step is spoken once, through ctx.announce (say), never twice.
  const readout = h("p", { class: "vs-readout" });
  const warnEl = h("p", { class: "vs-warn" });
  const msgEl = h("p", { class: "vs-msg" });
  const logBody = h("tbody");
  const log = h("div", { class: "vs-scroll" }, h("table", { class: "vs-log" },
    h("caption", { text: "Every access so far (steps still to come are shown dimmed)" }),
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: "#" }), h("th", { scope: "col", text: "access" }),
      h("th", { scope: "col", text: "read" }), h("th", { scope: "col", text: "device" }),
      h("th", { scope: "col", text: "Status after" }))),
    logBody));
  const plain = h("pre", { class: "vs-plain" });
  const plainBox = h("details", { class: "vs-more" },
    h("summary", { text: "The applied accesses in the trace format of the chapter's capture" }), plain);
  const honesty = h("details", { class: "vs-more" },
    h("summary", { text: "What this model simplifies" }),
    h("ul", {},
      h("li", { text: "There are no rings in memory. A valid doorbell always completes one request and sets InterruptStatus bit 0; the real device reads the ring (chapter 16) and can also fail on a broken one, which sets DEVICE_NEEDS_RESET." }),
      h("li", { text: "The devices keep only what the transport sees: the entropy device (DeviceID 4, VERSION_1 only, one queue of up to 64) and the disk (DeviceID 2, the reference's feature set, one queue of up to 256, the 24-byte config space of a 64 MiB image)." }),
      h("li", { text: "Guest RAM is one region at 0x4000_0000: 64 MiB, or 512 MiB for the disk, as in the captured runs. Anything else, including device registers, is not RAM." }),
      h("li", { text: "Warnings are the lines the reference VMM logs (it rate-limits them). Lines marked debug are logged only at debug level." }),
      h("li", { text: "The check at DRIVER_OK is the reference's: each ring's alignment, then that it lies inside RAM. Your chapter 15 version checks only the RAM part; chapter 16 adds alignment." }),
      h("li", { text: "The device never fails on its own here (in the real VMM, a crash in device code can)." }),
    ),
  );

  el.append(h("div", { class: "vs-wrap" },
    scenarioBox,
    walkBox,
    driverBox,
    msgEl,
    readout,
    warnEl,
    device,
    log,
    plainBox,
    honesty,
  ));

  // ---- rendering --------------------------------------------------------------------------
  function selectedOffset() {
    if (regSel.value === OTHER || regSel.value === CONFIG_OPT) return parseNumber(offIn.value, WINDOW - 1);
    return Number(regSel.value);
  }

  function renderRegNote() {
    const isOther = regSel.value === OTHER || regSel.value === CONFIG_OPT;
    offField.hidden = !isOther;
    const off = selectedOffset();
    const dev = DEVICES[preset(ui.preset).device];
    if (regSel.value === CONFIG_OPT) {
      regNote.textContent = `Config space of this device: ${dev.configNote}. The device answers any width inside its length (it is lenient); the spec requires drivers to read each field at its natural width (virtio 1.2 section 4.2.2.2).`;
      return;
    }
    const r = REGISTERS.find((x) => x.off === off);
    regNote.textContent = r
      ? `${r.name}: ${r.note}.${r.rw === "r" ? " Read-only." : r.rw === "w" ? " Write-only." : ""}`
      : off === null ? "Type an offset like 0x070." : `${hex(off, 3)}: ${off >= REG.CONFIG ? "config space." : "no register here, or not 4-byte aligned."}`;
  }

  function td(text, cls) { return h("td", { class: cls, text }); }
  function kv(body, rows) {
    body.replaceChildren();
    for (const [k, v] of rows) body.append(h("tr", {}, h("th", { scope: "row", text: k }), td(v, "vs-mono")));
  }

  function renderStatus(s) {
    const v = statusRead(s);
    const st = s.status & 0xf;
    const at = st === 0 ? 0 : STATUS_STEPS.indexOf(st) + 1;
    ladder.replaceChildren();
    LADDER.forEach((step, i) => {
      const state = i < at ? "done" : i === at ? "here" : "not yet";
      ladder.append(h("li", { class: `vs-rung vs-rung--${state.replace(" ", "-")}`, "aria-current": state === "here" ? "step" : null },
        h("span", { class: "vs-rung__mark", text: state === "here" ? "now" : state }),
        h("span", { text: step.text })));
    });
    const flags = [];
    if (v & STATUS.DEVICE_NEEDS_RESET) flags.push("DEVICE_NEEDS_RESET (set by the device: write 0 to recover)");
    if (v & STATUS.FAILED) flags.push("FAILED (set by the driver: write 0 to recover)");
    flagsEl.textContent = flags.length ? `Also set: ${flags.join("; ")}.` : "No error bits set.";
    flagsEl.classList.toggle("vs-flags--on", flags.length > 0);
    const tr = h("tr", {}, h("th", { scope: "row", text: "now" }));
    for (const b of [...STATUS_BITS].reverse()) {
      const on = (v & b.mask) !== 0;
      tr.append(h("td", { class: on ? "vs-bit vs-bit--on" : "vs-bit", text: on ? "1" : "0" }));
    }
    tr.append(td(hex(v), "vs-mono"));
    bitsBody.replaceChildren(tr);
  }

  function scoreText(sc) {
    if (!sc) return "";
    const g = sc.guess === "takes" ? "takes" : "ignores";
    if (sc.but) {
      return `You predicted the device ${g} it. It took the write (DRIVER_OK is set), ${sc.but}: ${sc.guess === "takes" ? "right about the write, but the ring was refused" : "right that it refused, though the refusal came after the write was taken"}.`;
    }
    return sc.right ? `You predicted the device ${g} it: right.` : `You predicted the device ${g} it; it ${sc.actual === "takes" ? "took" : "did not take"} it.`;
  }

  function names(bits, dev) {
    const n = featureNames(bits, dev);
    return n.length ? `${hex(bits)}: ${n.join(", ")}` : `${hex(bits)}: none`;
  }

  function render() {
    const p = preset(ui.preset);
    const dev = DEVICES[p.device];
    const rows = replay(ui.preset, ui.actions.slice(0, ui.cursor));
    const last = rows[rows.length - 1];
    const s = last.state;

    presetSel.value = ui.preset;
    const custom = encodeShare(ui).includes(":");
    const needs = p.needs ? ` This one builds on the chapter's section "${p.needs}"; if you have not read it yet, save this scenario for later.` : "";
    aboutEl.textContent = p.about + needs + (custom ? " (Your own steps replace or extend the scenario's.)" : "");
    const isBlk = dev.key === "blk";
    configBtn.disabled = !isBlk;
    configNote.textContent = isBlk
      ? "Bumps ConfigGeneration and raises a configuration interrupt, as a disk does when its image is resized."
      : `Only the disk has config fields that can change; ${dev.id === 0 ? "an empty slot has no device" : "the entropy device has no config space"}.`;
    deviceEl.textContent = `Slot 0 holds: ${dev.name} (DeviceID ${dev.id}). Guest RAM: ${hex(RAM_BASE)} to ${hex(ramEnd(s))} (${p.ramMiB} MiB).`;

    // Walk.
    const hasNext = ui.cursor < ui.actions.length;
    stepBtn.disabled = !hasNext;
    runBtn.disabled = !hasNext;
    backBtn.disabled = ui.cursor === 0;
    const nextAction = hasNext ? ui.actions[ui.cursor] : null;
    guessField.hidden = !(nextAction && nextAction.op === "w");
    guessSel.value = guess ?? "";
    if (hasNext) {
      nextLine.textContent = `Next step (${ui.cursor + 1} of ${ui.actions.length}): ${apply(s, nextAction).label}.`;
    } else {
      nextLine.textContent = ui.actions.length
        ? `All ${ui.actions.length} steps applied. Write and read registers below, or press Back.`
        : "No steps yet. Write or read a register below.";
    }
    scoreEl.textContent = scoreText(lastScore);

    // Device.
    renderStatus(s);
    const accepted = driverFeatures(s);
    kv(featBody, [
      ["offered by the device", names(dev.features, dev.key)],
      ["accepted by the driver so far", names(accepted, dev.key) + (s.beyond ? ", and bits beyond 63" : "")],
      ["agreed at FEATURES_OK", s.acked === null ? "not yet" : names(s.acked, dev.key)],
    ]);
    queueBody.replaceChildren();
    if (s.queues.length === 0) queueBody.append(h("tr", {}, h("th", { scope: "row", text: "none" }), td("this device has no queues", "")));
    s.queues.forEach((_, i) => {
      const q = queueView(s, i);
      const where = (a) => (a === 0n ? "0 (not set)" : hex(a));
      const rowsQ = [
        [`queue ${i} size`, `${q.size} of at most ${q.max}`],
        ["ready", q.ready ? "yes" : "no"],
        ["descriptor table", where(q.desc)],
        ["driver area", where(q.avail)],
        ["device area", where(q.used)],
        ["registers", q.frozen ? "frozen (ready, or DRIVER_OK set)" : "writable"],
        ["check at DRIVER_OK", q.check.ok ? "would pass: aligned and inside RAM" : `would fail: ${q.check.plain}`],
      ];
      for (const [k, v] of rowsQ) queueBody.append(h("tr", {}, h("th", { scope: "row", text: k }), td(v, "vs-mono")));
    });
    lineEl.textContent = `Interrupt line: ${s.line ? "HIGH" : "low"}${s.transitions.length ? ` (changes so far: ${s.transitions.map((x) => (x ? "high" : "low")).join(", ")})` : ""}`;
    lineEl.classList.toggle("vs-line--high", s.line);
    kv(intBody, [
      ["InterruptStatus", `${hex(s.intStatus)}${s.intStatus & 1 ? ", bit 0 used buffers" : ""}${s.intStatus & 2 ? ", bit 1 configuration changed" : ""}`],
      ["DeviceFeaturesSel", String(s.devSel)],
      ["DriverFeaturesSel", String(s.drvSel)],
      ["QueueSel", String(s.queueSel)],
      ["ConfigGeneration", String(s.configGen)],
    ]);

    // Readout.
    const sv = statusRead(s);
    const now = `Status ${hex(sv)} (${sv === 0 ? "reset" : statusNames(sv)}), InterruptStatus ${hex(s.intStatus)}, line ${s.line ? "high" : "low"}.`;
    const text = ui.cursor === 0
      ? `${last.effect} ${now}`
      : `Step ${ui.cursor}, ${last.label}${last.read === null ? "" : ` returned ${hex(last.read)}`}. ${last.effect} Now: ${now}`;
    if (readout.textContent !== text) readout.textContent = text;
    if (ui.cursor > 0 && last.log) {
      warnEl.hidden = false;
      warnEl.textContent = `${last.log.level === "warn" ? "macvmm logs a warning" : "macvmm logs, at debug level"}: ${last.log.text}`;
    } else {
      warnEl.hidden = true;
      warnEl.textContent = "";
    }
    msgEl.textContent = message;
    msgEl.hidden = !message;

    // Log.
    logBody.replaceChildren();
    rows.forEach((r, i) => {
      if (i === 0) return;
      const logged = r.log ? (r.log.level === "warn" ? "warning" : "debug log") : "";
      const verdict = [r.taken === null ? "" : r.taken ? "took it" : "ignored it", logged].filter(Boolean).join(", ");
      logBody.append(h("tr", { class: i === rows.length - 1 ? "vs-current" : "" },
        td(String(i), ""), td(r.label, "vs-mono"),
        td(r.read === null ? "" : hex(r.read), "vs-mono"),
        td(verdict, ""),
        td(hex(statusRead(r.state)), "vs-mono")));
    });
    ui.actions.slice(ui.cursor).forEach((a, j) => logBody.append(h("tr", { class: "vs-future" },
      td(String(ui.cursor + j + 1), ""), td(pendingLabel(a), "vs-mono"), td("", ""), td("not yet", ""), td("", ""))));
    plain.textContent = formatTrace(rows) || "(no accesses yet)";

    renderRegNote();
    const str = encodeShare(ui);
    const isDefault = ui.preset === DEFAULT_PRESET && str === `${DEFAULT_PRESET}~0`;
    ctx.hash.set(str === "" || isDefault ? null : str);
  }

  function pendingLabel(a) {
    if (a.op === "c") return "device changes its config";
    const sz = a.size === 4 ? "" : ` (${a.size}-byte)`;
    return a.op === "r" ? `read ${regName(a.off)}${sz}` : `write ${regName(a.off)} = ${hex(a.val)}${sz}`;
  }

  function go(cursor, { score = false } = {}) {
    const target = Math.max(0, Math.min(ui.actions.length, cursor));
    lastScore = null;
    if (score && target === ui.cursor + 1) {
      const rows = replay(ui.preset, ui.actions.slice(0, target));
      const r = rows[rows.length - 1];
      lastScore = scoreGuess(guess, r.taken);
      if (lastScore && r.but) lastScore = { ...lastScore, but: r.but };
    }
    ui.cursor = target;
    guess = null;
    message = "";
    const focused = typeof document.activeElement === "undefined" ? null : document.activeElement;
    render();
    keepFocus(focused);
    say(spoken(lastScore ? scoreEl.textContent : ""));
  }

  // The spoken version of a step: score, readout, the device's warning and any message, once.
  function spoken(prefix) {
    return [prefix, message, readout.textContent, warnEl.hidden ? "" : warnEl.textContent].filter(Boolean).join(" ");
  }

  // Disabling the focused button would drop focus to <body>; move it to a sensible neighbour.
  function keepFocus(was) {
    if (!was || !was.disabled) return;
    const order = was === backBtn ? [stepBtn, runBtn, restartBtn] : [backBtn, restartBtn];
    const next = order.find((b) => !b.disabled);
    if (next && typeof next.focus === "function") next.focus();
  }

  function refuse(text) {
    message = text;
    render();
    say(message);
  }

  function poke(a) {
    const err = validateAction(a);
    if (err) return refuse(`Not applied: ${err}.`);
    if (ui.cursor >= MAX_ACTIONS) return refuse(`Not applied: the lab keeps at most ${MAX_ACTIONS} steps. Press Reset to start again.`);
    const dropped = ui.actions.length - ui.cursor;
    ui = { preset: ui.preset, actions: [...ui.actions.slice(0, ui.cursor), a], cursor: ui.cursor + 1 };
    lastScore = null;
    guess = null;
    message = dropped ? `The ${dropped} remaining step${dropped === 1 ? "" : "s"} of the scenario ${dropped === 1 ? "was" : "were"} replaced by your step.` : "";
    render();
    say(spoken(""));
  }

  function access(op) {
    const off = selectedOffset();
    if (off === null) return refuse("Not applied: the offset must be a number from 0x000 to 0x1ff.");
    const size = Number(sizeSel.value);
    if (op === "r") return poke({ op: "r", off, size });
    const val = parseNumber(valIn.value);
    if (val === null) return refuse("Not applied: the value must be a number like 0xb or 11, at most 32 bits.");
    poke({ op: "w", off, size, val });
  }

  function load(key) {
    const p = preset(key);
    if (!p) return;
    ui = { preset: p.key, actions: [...p.actions], cursor: 0 };
    if (p.group === "blank") driverBox.open = true;
    go(0);
  }

  // ---- events -----------------------------------------------------------------------------
  stepBtn.addEventListener("click", () => go(ui.cursor + 1, { score: true }));
  backBtn.addEventListener("click", () => go(ui.cursor - 1));
  runBtn.addEventListener("click", () => go(ui.actions.length));
  restartBtn.addEventListener("click", () => load(ui.preset));
  resetBtn.addEventListener("click", () => {
    ui = { preset: ui.preset, actions: [], cursor: 0 };
    go(0);
  });
  presetSel.addEventListener("change", () => load(presetSel.value));
  guessSel.addEventListener("change", () => {
    guess = guessSel.value === "takes" || guessSel.value === "ignores" ? guessSel.value : null;
  });
  regSel.addEventListener("change", () => {
    if (regSel.value === CONFIG_OPT) offIn.value = "0x100";
    renderRegNote();
  });
  offIn.addEventListener("input", renderRegNote);
  writeBtn.addEventListener("click", () => access("w"));
  readBtn.addEventListener("click", () => access("r"));
  configBtn.addEventListener("click", () => { if (!configBtn.disabled) poke({ op: "c" }); });
  shareBtn.addEventListener("click", async () => {
    render();
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this state is in the address bar.");
    }
  });

  regSel.value = String(REG.STATUS);
  if (preset(ui.preset).group === "blank" || encodeShare(ui).includes(":")) driverBox.open = true;
  render();

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
