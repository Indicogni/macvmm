// virtqueue-visualizer view: renders what model.mjs computes and turns button presses into model
// steps. All logic lives in model.mjs; this file only builds DOM (createElement + textContent,
// never innerHTML) inside the element the lab shell hands us. See course/site/LABS.md.
//
// Nothing animates and nothing plays by itself, so reduced motion needs no special path: the toy
// is walked with "Next step" and the ring changes only when the reader presses a button.
//
// Unavailable actions are never `disabled`: they get aria-disabled, stay in the tab order and keep
// focus, and pressing one says why it is not possible (whyNot), which is often the lesson itself
// ("the device only looks after a doorbell"). The reason is also written under the button.
import {
  SIZES, STARTS, CAP_LABELS, HOSTILE, REQUEST_SHAPES, PRESETS, TOY_STEPS, RULES, MAX_BUFFER_LEN,
  TOY_SECTOR, INT_CONFIG, LAYOUT, TOY_DATA_ADDR, TOY_LEN, CH15, CH16,
  initialState, startModeFor, decode, encode, step, replay, snapshot, whyNot, summary, nextHint, specToken,
  hexAddr, hex16, flagNames, grouped,
} from "./model.mjs";

const ANNOUNCE_GAP_MS = 300;
/** How many earlier states Undo can go back to (actions, settings, scenarios, mode). */
const UNDO_DEPTH = 200;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const INTRO = {
  toy: "The smallest ring there is: one descriptor, one doorbell, one \"done\". The guest asks our device to write 4096 bytes to the disk. Press Next step and count the VM exits.",
  ring: "A split virtqueue with N descriptors. You play both sides: the driver (the guest) publishes requests and rings the doorbell; the device (our VMM) takes one chain at a time, checks it, serves it and says \"done\". Switch on hostile mode to misbehave as the driver.",
};

const MODES = [
  { id: "toy", label: "Toy: one descriptor (chapter 15)" },
  { id: "ring", label: "Full ring (chapter 16)" },
];

const BTN = {
  doorbell: { token: "n", text: "Driver: ring the doorbell", help: "Store to QueueNotify: one VM exit." },
  process: { token: "p", text: "Device: process one", help: "Pop one chain, walk it, serve it, add it to the used ring." },
  reclaim: { token: "u", text: "Driver: reclaim used", help: "The interrupt handler: acknowledge, then free finished requests." },
  flags: { token: "f", text: "Driver: toggle NO_INTERRUPT", help: "The \"do not interrupt me\" flag in the available ring (bit 0 of avail.flags)." },
  reset: { token: "z", text: "Driver: reset the device", help: "Write 0 to Status, then set the queue up again." },
};

/** The page path, read only to pick an embed's starting mode (see startModeFor in model.mjs). */
function pagePath() {
  try {
    return globalThis.location?.pathname ?? "";
  } catch {
    return "";
  }
}

/** Mark a button unavailable without taking it out of the tab order (or dropping its focus). */
function block(btn, reason, whyEl) {
  if (reason) {
    btn.setAttribute("aria-disabled", "true");
    btn.classList.add("vq-btn--blocked");
  } else {
    btn.removeAttribute("aria-disabled");
    btn.classList.remove("vq-btn--blocked");
  }
  if (whyEl) {
    whyEl.textContent = reason || "";
    whyEl.hidden = !reason;
  }
}

export function mount(el, ctx) {
  const id = ctx.id;
  const startMode = startModeFor({ pathname: pagePath(), standalone: ctx.standalone === true });
  const enc = (s) => encode(s, startMode);
  const shared = ctx.hash.get();
  let state = decode(shared) ?? initialState(startMode);
  /** Earlier states, newest last: Undo restores the previous one, whatever changed it. */
  const past = [];
  let hostile = state.cfg.mode === "ring" && state.actions.some((t) => t.startsWith("h"));

  // ---- throttled announcements (about one per 300 ms; the latest text wins) ----
  let timer = null;
  let lastSpoke = 0;
  function say(text) {
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, lastSpoke + ANNOUNCE_GAP_MS - Date.now());
    timer = setTimeout(() => {
      timer = null;
      lastSpoke = Date.now();
      ctx.announce(text);
    }, wait);
  }

  // ---- static frame: mode ----
  const modeBox = h("fieldset", { class: "vq-field vq-radios" }, h("legend", { text: "What to play" }));
  const modeInputs = {};
  for (const m of MODES) {
    const inputId = `${id}-mode-${m.id}`;
    const input = h("input", { type: "radio", name: `${id}-mode`, id: inputId, value: m.id });
    input.addEventListener("change", () => { if (input.checked) change(step(state, { type: "mode", mode: m.id })); });
    modeInputs[m.id] = input;
    modeBox.append(h("span", { class: "vq-radio" }, input, h("label", { for: inputId, text: m.label })));
  }
  const intro = h("p", { class: "vq-intro" });
  const introText = h("span");
  intro.append(introText);
  if (ctx.standalone === true) {
    intro.append(" New to virtqueues? Read ", h("a", { href: CH15, text: "chapter 15 (virtio-mmio)" }),
      " for the toy, then ", h("a", { href: CH16, text: "chapter 16 (split virtqueues)" }), " for the full ring.");
  }

  // ---- ring settings ----
  const sel = (key, label, options) => {
    const s = h("select", { id: `${id}-${key}` });
    for (const [v, t] of options) s.append(h("option", { value: v, text: t }));
    return { s, field: h("div", { class: "vq-field" }, h("label", { for: `${id}-${key}`, text: label }), s) };
  };
  const nSel = sel("n", "Queue size N", SIZES.map((n) => [String(n), String(n)]));
  const extraStarts = new Set();
  const startSel = sel("start", "Both counters start at", STARTS.map((v) => [String(v), v === 0 ? "0" : `${hex16(v)} (wraps after ${0x10000 - v})`]));
  const capSel = sel("cap", "Device's byte cap per direction", Object.entries(CAP_LABELS));
  const check = (key, label) => {
    const input = h("input", { type: "checkbox", id: `${id}-${key}` });
    return { input, field: h("span", { class: "vq-check" }, input, h("label", { for: `${id}-${key}`, text: label })) };
  };
  const indChk = check("ind", "Indirect descriptors negotiated");
  const budgetChk = check("nobudget", "Remove the hop budget (chapter 16, \"The hop budget\")");
  const rereadChk = check("reread", "Re-read len after checking it (chapter 16, \"The guest writes while we read\")");
  nSel.s.addEventListener("change", () => change(step(state, { type: "config", cfg: { n: Number(nSel.s.value) } })));
  startSel.s.addEventListener("change", () => change(step(state, { type: "config", cfg: { start: Number(startSel.s.value) } })));
  capSel.s.addEventListener("change", () => change(step(state, { type: "config", cfg: { cap: capSel.s.value } })));
  indChk.input.addEventListener("change", () => change(step(state, { type: "config", cfg: { indirect: indChk.input.checked } })));
  budgetChk.input.addEventListener("change", () => change(step(state, { type: "config", cfg: { budget: !budgetChk.input.checked } })));
  rereadChk.input.addEventListener("change", () => change(step(state, { type: "config", cfg: { reread: rereadChk.input.checked } })));
  const settings = h("details", { class: "vq-settings" },
    h("summary", { text: "Ring settings" }),
    h("div", { class: "vq-controls" }, nSel.field, startSel.field, capSel.field),
    h("div", { class: "vq-checks" }, indChk.field, budgetChk.field, rereadChk.field),
    h("p", { class: "vq-note", text: "Changing N, the start or the negotiation starts a fresh ring; Undo brings your ring back. The cap and the two checkboxes below it keep your actions and replay them under the new rule." }),
    h("p", { class: "vq-note", text: "Indices crossing 65535: start both counters at 0xFFFE, or load the \"Indices crossing 65535\" scenario. A disk never meets the byte cap: virtio-blk passes one of about 2 TiB and answers a request that is too big with an IOERR status (chapter 18)." }),
  );

  const presetSel = h("select", { id: `${id}-preset` });
  presetSel.append(h("option", { value: "", text: "Free play" }));
  for (const p of PRESETS) presetSel.append(h("option", { value: p.id, text: p.title }));
  const presetGoal = h("p", { class: "vq-script" });
  presetGoal.hidden = true;
  // Choosing in the menu only previews; "Load scenario" replaces the ring. Arrowing through a
  // closed select fires "change" on every key press in some browsers, so loading on "change"
  // would throw the ring away at the first arrow.
  const presetAbout = h("p", { class: "vq-note", id: `${id}-preset-about` });
  presetSel.addEventListener("change", () => render());
  const loadBtn = h("button", { type: "button", class: "vq-btn", text: "Load scenario", "aria-describedby": `${id}-preset-about` });
  loadBtn.addEventListener("click", () => {
    const p = PRESETS.find((x) => x.id === presetSel.value);
    if (!p) {
      refusal.textContent = "Choose a scenario in the menu first.";
      say(refusal.textContent);
      return;
    }
    const s = decode(p.state);
    if (!s) return;
    hostile = s.actions.some((t) => t.startsWith("h"));
    change({ cfg: s.cfg, actions: s.actions }, `Scenario loaded: ${p.title}. ${p.goal}`);
    presetSel.value = p.id;
    presetGoal.textContent = `${p.goal} Press "${BTN.process.text}".`;
    presetGoal.hidden = false;
  });
  const presetField = h("div", { class: "vq-field" },
    h("label", { for: `${id}-preset`, text: "Scenario" }),
    h("div", { class: "vq-row" }, presetSel, loadBtn),
    presetAbout);

  // ---- driver: honest requests ----
  const shapeSel = h("select", { id: `${id}-shape` });
  for (const s of REQUEST_SHAPES) shapeSel.append(h("option", { value: s.id, text: s.label }));
  shapeSel.append(h("option", { value: "custom", text: "Custom chain (1 to 3 buffers)" }));
  const customRows = [];
  const customBox = h("fieldset", { class: "vq-custom" }, h("legend", { text: "Custom chain, in order" }));
  for (let i = 0; i < 3; i++) {
    const kind = h("select", { id: `${id}-c${i}-kind` });
    if (i > 0) kind.append(h("option", { value: "", text: "(none)" }));
    kind.append(h("option", { value: "r", text: "device reads" }), h("option", { value: "w", text: "device writes" }));
    const len = h("input", { type: "number", id: `${id}-c${i}-len`, min: "1", max: String(MAX_BUFFER_LEN), step: "1", inputmode: "numeric" });
    len.value = String([16, 512, 1][i]);
    kind.value = ["r", "w", "w"][i];
    customRows.push({ kind, len });
    customBox.append(h("div", { class: "vq-custom-row" },
      h("label", { for: `${id}-c${i}-kind`, text: `Buffer ${i + 1}` }), kind,
      h("label", { for: `${id}-c${i}-len`, text: "bytes" }), len));
  }
  const customMsg = h("p", { class: "vq-note" });
  customBox.append(customMsg);
  shapeSel.addEventListener("change", () => { render(); });
  for (const r of customRows) {
    r.kind.addEventListener("change", () => render());
    r.len.addEventListener("input", () => render());
  }
  function requestToken() {
    if (shapeSel.value !== "custom") {
      const s = REQUEST_SHAPES.find((x) => x.id === shapeSel.value) ?? REQUEST_SHAPES[0];
      return { token: specToken(s.spec) };
    }
    const spec = [];
    for (const r of customRows) {
      if (!r.kind.value) break;
      const n = Number(r.len.value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_BUFFER_LEN) return { error: `Each buffer is 1 to ${MAX_BUFFER_LEN} bytes in this lab.` };
      spec.push([r.kind.value, n]);
    }
    if (!spec.length) return { error: "A request needs at least one buffer." };
    return { token: specToken(spec) };
  }
  const addWhy = h("span", { class: "vq-why", id: `${id}-why-add` });
  const addBtn = h("button", { type: "button", class: "vq-btn vq-btn--driver", text: "Driver: add request", "aria-describedby": `${id}-why-add` });
  addBtn.addEventListener("click", () => {
    const r = requestToken();
    if (r.token) act(r.token);
    else { refusal.textContent = r.error; say(r.error); }
  });
  const shapeField = h("div", { class: "vq-field" }, h("label", { for: `${id}-shape`, text: "Request" }), shapeSel);

  // ---- driver: hostile requests ----
  const hostileChk = check("hostile", "Hostile mode: let the driver misbehave");
  hostileChk.input.addEventListener("change", () => { hostile = hostileChk.input.checked; render(); });
  const hostileSel = h("select", { id: `${id}-hostile-kind` });
  for (const x of HOSTILE) hostileSel.append(h("option", { value: x.id, text: x.label }));
  const hostileAbout = h("p", { class: "vq-note", id: `${id}-hostile-about` });
  hostileSel.addEventListener("change", () => render());
  const hostileWhy = h("span", { class: "vq-why", id: `${id}-why-hostile` });
  const hostileBtn = h("button", { type: "button", class: "vq-btn vq-btn--hostile", text: "Hostile driver: publish it", "aria-describedby": `${id}-hostile-about ${id}-why-hostile` });
  hostileBtn.addEventListener("click", () => act(`h${hostileSel.value}`));
  const hostileBox = h("div", { class: "vq-hostile" },
    h("div", { class: "vq-field" }, h("label", { for: `${id}-hostile-kind`, text: "Misbehaviour" }), hostileSel),
    h("span", { class: "vq-action" }, hostileBtn, hostileWhy), hostileAbout);

  // ---- action buttons ----
  const buttons = {};
  const whys = {};
  const mkAction = (key) => {
    const b = BTN[key];
    const helpId = `${id}-help-${key}`;
    const whyId = `${id}-why-${key}`;
    const el2 = h("button", { type: "button", class: `vq-btn${key === "process" ? " vq-btn--device" : " vq-btn--driver"}`, "aria-describedby": `${helpId} ${whyId}`, text: b.text });
    el2.addEventListener("click", () => act(b.token));
    buttons[key] = el2;
    whys[key] = h("span", { class: "vq-why", id: whyId });
    return h("span", { class: "vq-action" }, el2, h("span", { class: "vq-help", id: helpId, text: b.help }), whys[key]);
  };
  const driverBox = h("section", { class: "vq-actor vq-actor--driver", "aria-label": "Driver (the guest)" },
    h("h3", { text: "Driver (the guest)" }),
    h("div", { class: "vq-row" }, shapeField, h("span", { class: "vq-action" }, addBtn, addWhy)),
    customBox,
    h("div", { class: "vq-buttons" }, mkAction("doorbell"), mkAction("reclaim"), mkAction("flags"), mkAction("reset")),
    hostileChk.field,
    hostileBox,
  );
  const deviceBox = h("section", { class: "vq-actor vq-actor--device", "aria-label": "Device (our VMM)" },
    h("h3", { text: "Device (our VMM)" }),
    h("div", { class: "vq-buttons" }, mkAction("process")),
    h("p", { class: "vq-note", text: "The device runs our VMM's checks, in the same order as crates/vmm/src/virtio/queue.rs and chain.rs, on its own copy of each descriptor." }),
  );

  // ---- toy controls ----
  const nextWhy = h("span", { class: "vq-why", id: `${id}-why-next` });
  const nextBtn = h("button", { type: "button", class: "vq-btn vq-btn--primary", text: "Next step", "aria-describedby": `${id}-why-next` });
  nextBtn.addEventListener("click", () => act("s"));
  const toySteps = h("ol", { class: "vq-steps", "aria-label": "The eight steps" });

  // ---- utilities ----
  const undoBtn = h("button", { type: "button", class: "vq-btn", text: "Undo" });
  const resetBtn = h("button", { type: "button", class: "vq-btn", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "vq-btn", text: "Copy link to this state" });
  undoBtn.addEventListener("click", () => {
    if (past.length) {
      const prev = past.pop();
      hostile = hostile || prev.actions.some((t) => t.startsWith("h"));
      change(prev, undefined, false);
      return;
    }
    const next = step(state, { type: "undo" });
    if (next === state) { refusal.textContent = "Nothing to undo."; say(refusal.textContent); return; }
    change(next, undefined, false);
  });
  resetBtn.addEventListener("click", () => {
    const next = step(state, { type: "reset" });
    if (!state.actions.length) { refusal.textContent = "Nothing to reset: no actions yet."; say(refusal.textContent); return; }
    change(next, "Reset. Undo brings the actions back.");
  });
  copyBtn.addEventListener("click", async () => {
    commit("Link updated.");
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this state is in the address bar.");
    }
  });
  const refusal = h("p", { class: "vq-refusal" });

  // ---- output areas ----
  const viz = h("div", { class: "vq-viz" });
  // The summary: plain text, spoken through ctx.announce (the page's polite live region).
  const readout = h("p", { class: "vq-readout" });
  // "Try next": the honest driver's next move, for a reader who has never driven a ring.
  const hintBox = h("p", { class: "vq-hint" });
  const checksBox = h("div", { class: "vq-checksbox" });
  const logBox = h("details", { class: "vq-more" });
  const historyBox = h("div", { class: "vq-history" });

  const simplifies = h("details", { class: "vq-more" },
    h("summary", { text: "What this lab simplifies" }),
    h("ul", {},
      h("li", { text: "Guest RAM is a small guest's: 1 MiB at 0x4000_0000 for the full ring (512 MiB for the toy), with the rings at fixed addresses. Each descriptor index owns a 4 KiB buffer." }),
      h("li", { text: "The device is generic: it reads its readable buffers, fills every writable byte with filler and reports exactly that count as used.len. A final 1-byte buffer gets 0, the disk's \"OK\" status. A real disk also looks at what the header asks for (chapter 18)." }),
      h("li", { text: "The toy's descriptor carries no sector number: its device always writes sector 8. A real virtio-blk request says which sector in a 16-byte header descriptor, so it is a chain of three." }),
      h("li", { text: "One press of Process takes one chain. The real doorbell path takes up to N chains per call and at most four calls per doorbell; from chapter 17 a worker thread does the same work." }),
      h("li", { text: "Here the device decides on the interrupt after every chain and keeps looking until it finds the ring empty. The real device decides once per batch, after its loop, and a request the driver adds after the device has drained the ring needs another doorbell." }),
      h("li", { text: "Exits count only the doorbell, the two interrupt-handler registers and the reset write; the setup's register writes are left out. With the in-kernel GIC, raising the line costs no exit." }),
      h("li", { text: "A walk with no hop budget and no cap never ends on a real host; the lab gives up after 20,000 hops and says so." }),
    ),
  );

  const ringTop = h("div", { class: "vq-top" }, presetField, settings);
  const ringGoal = h("div", {}, presetGoal);
  const toyBox = h("div", {}, toySteps);
  const actors = h("div", { class: "vq-actors" }, driverBox, deviceBox);
  const nextWrap = h("span", { class: "vq-action" }, nextBtn, nextWhy);
  toyBox.append(nextWrap);
  const ringOnly = [ringTop, ringGoal, actors, hintBox];
  const toyOnly = [toyBox];
  el.append(h("div", { class: "vq-wrap" },
    modeBox,
    intro,
    ringTop,
    ringGoal,
    toyBox,
    actors,
    h("div", { class: "vq-buttons", role: "group", "aria-label": "History" }, undoBtn, resetBtn, copyBtn),
    refusal,
    readout,
    hintBox,
    viz,
    checksBox,
    logBox,
    historyBox,
    simplifies,
  ));

  // ---- state changes ----
  let cache = { key: undefined, world: null, snap: null };
  function current() {
    const key = `${enc(state)}|${state.cfg.mode}`;
    if (cache.key !== key) {
      const world = replay(state);
      cache = { key, world, snap: snapshot(world) };
    }
    return cache;
  }

  function commit(message) {
    ctx.hash.set(enc(state));
    render();
    say(message ?? summary(current().snap));
  }

  function remember() {
    past.push(state);
    if (past.length > UNDO_DEPTH) past.shift();
  }

  function change(next, message, record = true) {
    refusal.textContent = "";
    if (next === state) { render(); return; }
    if (record) remember();
    state = next;
    presetSel.value = "";
    presetGoal.hidden = true;
    commit(message);
  }

  function act(token) {
    const reason = whyNot(current().world, token);
    if (reason) {
      refusal.textContent = reason;
      say(reason);
      return;
    }
    const next = step(state, { type: "do", token });
    if (next === state) return;
    refusal.textContent = "";
    remember();
    state = next;
    commit();
  }

  // ---- rendering helpers ----
  // Each scroll box has a short name of its own (the caption is read with the table) and a key,
  // so its sideways scroll position survives the re-render after every button press.
  const scroller = (key, name, t) => h("div", { class: "vq-scroll", tabindex: "0", role: "region", "aria-label": `${name}, scrolls sideways`, "data-key": key }, t);
  const table = (key, name, caption, head, rows, cls = "") => {
    const t = h("table", { class: `vq-table ${cls}` }, h("caption", { text: caption }));
    t.append(h("thead", {}, h("tr", {}, ...head.map((x) => h("th", { scope: "col", text: x })))));
    const body = h("tbody");
    for (const r of rows) body.append(r);
    t.append(body);
    return scroller(key, name, t);
  };
  const justWritten = () => h("span", { class: "vq-sr", text: " (just written)" });
  const marker = (text) => h("span", { class: "vq-marker" }, h("span", { "aria-hidden": "true", text: "▲ " }), text);

  function walkedBy(snap) {
    const m = new Map();
    const checks = snap.last?.checks || [];
    let gap = false;
    for (const c of checks) {
      if (c.gap) gap = true;
      if (c.head && c.table === "main") {
        const e = m.get(c.index) || { hops: [], gap: false };
        e.hops.push(c.hop);
        if (gap) e.gap = true;
        m.set(c.index, e);
      }
    }
    return m;
  }

  function walkText(e) {
    if (!e) return "";
    if (e.hops.length === 1 && !e.gap) return `hop ${e.hops[0]}`;
    const last = e.hops[e.hops.length - 1];
    return e.gap ? `hops ${e.hops[0]} to ${grouped(last)} (most not shown)` : `hops ${e.hops.join(", ")}`;
  }

  function renderDescTable(snap) {
    const walked = walkedBy(snap);
    const changed = new Set(snap.last?.changed?.desc || []);
    const rows = snap.descs.map((d) => {
      const who = d.owner
        ? `request at head ${d.owner.head}, buffer ${d.owner.pos + 1}`
        : d.free ? "free" : "published, not tracked by the driver";
      const tr = h("tr", { class: `${changed.has(d.index) ? "vq-row--changed" : ""}${walked.has(d.index) ? " vq-row--walked" : ""}` });
      tr.append(
        h("th", { scope: "row", text: String(d.index) }),
        h("td", { class: "vq-mono", text: hexAddr(d.addr) }),
        h("td", { class: "vq-mono", text: grouped(d.len) }),
        h("td", { class: "vq-mono", text: flagNames(d.flags) }),
        h("td", { class: "vq-mono", text: String(d.next) }),
        h("td", { text: `${who}${changed.has(d.index) ? " (just written)" : ""}` }),
        h("td", { text: walkText(walked.get(d.index)) }),
      );
      return tr;
    });
    return table("desc", "Descriptor table", `Descriptor table at ${hexAddr(LAYOUT.desc)}: ${snap.n} × 16 bytes, written by the driver`,
      ["#", "addr", "len", "flags", "next", "who uses it", "last walk"], rows);
  }

  function renderIndirect(snap) {
    return snap.indirect.map((t) => {
      const rows = t.rows.map((d) => h("tr", {},
        h("th", { scope: "row", text: String(d.index) }),
        h("td", { class: "vq-mono", text: hexAddr(d.addr) }),
        h("td", { class: "vq-mono", text: grouped(d.len) }),
        h("td", { class: "vq-mono", text: flagNames(d.flags) }),
        h("td", { class: "vq-mono", text: String(d.next) }),
      ));
      return table(`ind-${t.from}`, `Indirect table from descriptor ${t.from}`, `Indirect table at ${hexAddr(t.addr)} (from descriptor ${t.from}, len ${t.len})`, ["#", "addr", "len", "flags", "next"], rows, "vq-table--indirect");
    });
  }

  function ringTable(key, name, caption, slots, cellText, marks, changedSlots) {
    const head = ["slot", ...slots.map((_, i) => String(i))];
    const t = h("table", { class: "vq-table vq-table--ring" }, h("caption", { text: caption }));
    t.append(h("thead", {}, h("tr", {}, ...head.map((x, i) => h("th", { scope: "col", text: x, class: i > 0 && changedSlots.has(i - 1) ? "vq-cell--changed" : null })))));
    const body = h("tbody");
    body.append(h("tr", {}, h("th", { scope: "row", text: "entry" }), ...slots.map((s, i) => h("td", { class: `vq-mono${changedSlots.has(i) ? " vq-cell--changed" : ""}` }, cellText(s), changedSlots.has(i) ? justWritten() : null))));
    const mrow = h("tr", {}, h("th", { scope: "row", text: "next" }));
    for (let i = 0; i < slots.length; i++) {
      const here = marks.filter((m) => m.slot === i);
      mrow.append(h("td", {}, ...here.map((m) => marker(m.label))));
    }
    body.append(mrow);
    t.append(body);
    return scroller(key, name, t);
  }

  function renderRings(snap) {
    const n = snap.n;
    const dv = snap.device;
    const dr = snap.driver;
    const lastChanged = snap.last?.changed || {};
    const availTbl = ringTable("avail", "Available ring",
      `Available ring at ${hexAddr(snap.avail.addr)}: flags ${snap.avail.flags} (${snap.avail.flags & 1 ? "NO_INTERRUPT" : "interrupts wanted"}), idx ${hex16(snap.avail.idx)} = ${snap.avail.idx}; written by the driver`,
      snap.avail.ring, (v) => String(v),
      [{ slot: snap.avail.idx % n, label: "avail.idx: driver writes here" }, { slot: dv.nextAvail % n, label: "next_avail: device reads here" }],
      new Set(lastChanged.avail || []),
    );
    const usedTbl = ringTable("used", "Used ring",
      `Used ring at ${hexAddr(snap.used.addr)}: idx ${hex16(snap.used.idx)} = ${snap.used.idx}; written by the device`,
      snap.used.ring, (e) => `id ${e.id}, len ${grouped(e.len)}`,
      [{ slot: dv.nextUsed % n, label: "next_used: device writes here" }, { slot: dr.lastUsed % n, label: "last_used: driver reads here" }],
      new Set(lastChanged.used || []),
    );
    const sums = h("dl", { class: "vq-dl" });
    const row = (a, b) => sums.append(h("dt", { text: a }), h("dd", { text: b }));
    row("Pending for the device", `avail.idx − next_avail = ${hex16(snap.avail.idx)} − ${hex16(dv.nextAvail)} = ${dv.pending} (16-bit arithmetic: 0xFFFF + 1 wraps to 0x0000)`);
    row("Done, not yet reclaimed", `used.idx − last_used = ${hex16(snap.used.idx)} − ${hex16(dr.lastUsed)} = ${dr.unreclaimed}`);
    row("Slot of an index", `index % N, here index % ${n}`);
    return [availTbl, usedTbl, sums];
  }

  function renderDevice(snap) {
    const d = snap.device;
    const status = d.status === "ok" ? "DRIVER_OK: working" : d.status === "reset" ? "DEVICE_NEEDS_RESET: ignores the doorbell until Status is written with 0" : "stuck in an endless walk";
    const dl = h("dl", { class: "vq-dl" });
    const row = (a, b) => dl.append(h("dt", { text: a }), h("dd", { text: b }));
    row("Device status", status);
    row("Doorbell heard", d.notified ? "yes: the device is looking at the ring" : "no: waiting for a doorbell");
    row("Interrupt line", d.line ? `high (${d.intStatus & INT_CONFIG ? "configuration change" : "used buffer"}${(d.intStatus & 3) === 3 ? " and used buffer" : ""})` : "low");
    row("VM exits", `${snap.exits.total} (doorbell ${snap.exits.doorbell}, interrupt handler ${snap.exits.handler}, reset ${snap.exits.reset})`);
    if (snap.cfg.mode === "ring") {
      row("Driver's free descriptors", snap.driver.free.length ? snap.driver.free.join(", ") : "none");
      if (snap.hook) row("Armed", `the guest will rewrite ${hexAddr(snap.hook.addr)} right after the device copies it`);
    }
    return h("section", { class: "vq-status", "aria-label": "Device and exits" }, h("h3", { text: "State" }), dl);
  }

  function renderToyViz(snap) {
    const k = snap.toyStep;
    const data = k >= 1 ? `"Hello from the guest, sector 8. Hello..." (${TOY_LEN} bytes)` : "(nothing yet)";
    const dl = h("dl", { class: "vq-dl" });
    const row = (a, b) => dl.append(h("dt", { text: a }), h("dd", { class: "vq-mono", text: b }));
    row(`Data at ${hexAddr(TOY_DATA_ADDR)}`, data);
    const d0 = snap.descs[0];
    row("Descriptor 0", k >= 2 ? `addr ${hexAddr(d0.addr)}, len ${d0.len}, flags ${flagNames(d0.flags)} (the device reads it)` : "(empty)");
    row("Available ring", `idx ${snap.avail.idx}, ring[0] = ${snap.avail.ring[0]}`);
    row("Used ring", `idx ${snap.used.idx}, ring[0] = {id ${snap.used.ring[0].id}, len ${snap.used.ring[0].len}}`);
    const disk = h("dl", { class: "vq-dl" });
    const drow = (a, b) => disk.append(h("dt", { text: a }), h("dd", { class: "vq-mono", text: b }));
    drow(`Disk sector ${TOY_SECTOR}`, snap.disk ? `"${String.fromCharCode(...snap.disk.bytes.slice(0, 32))}..." (${snap.disk.bytes.length} bytes)` : "(old contents)");
    drow("Interrupt line", snap.device.line ? "high" : "low");
    const exits = h("p", { class: "vq-exits" }, h("span", { class: "vq-label", text: "VM exits so far " }), h("strong", { text: String(snap.exits.total) }));
    const cmp = k === 8 ? h("p", { class: "vq-note", text: `${snap.exits.total} exits for ${TOY_LEN} bytes. Chapter 15 measured about 2.7 exits per byte through the PL011: about 11,000 for the same ${TOY_LEN} bytes.` }) : null;
    viz.replaceChildren(
      h("div", { class: "vq-toy" },
        h("section", { class: "vq-actor vq-actor--driver", "aria-label": "Guest RAM" }, h("h3", { text: "Guest RAM (the guest writes it, we read it)" }), dl),
        h("section", { class: "vq-actor vq-actor--device", "aria-label": "Our VMM" }, h("h3", { text: "Our VMM and the disk" }), disk, exits, cmp),
      ),
    );
  }

  function renderChecks(snap) {
    const last = snap.last;
    if (!last || !last.checks || !last.checks.length) {
      checksBox.replaceChildren();
      return;
    }
    const ol = h("ol", { class: "vq-checks-list" });
    for (const c of last.checks) {
      if (c.gap) {
        ol.append(h("li", { class: "vq-gap", text: c.text }));
        continue;
      }
      const mark = c.ok === true ? "pass" : c.ok === false ? "refused" : "note";
      const rule = RULES[c.rule];
      const li = h("li", { class: `vq-check-${mark}${c.head ? " vq-hop" : ""}` },
        h("span", { class: "vq-tag", text: c.head ? "step" : mark }), " ", c.text);
      if (rule && (c.ok === false || c.head)) {
        // The visible text is the function; the accessible name says where the link goes.
        const a = h("a", { href: rule.href, class: "vq-rule", "aria-label": `${rule.code}, explained in chapter ${rule.chapter}, "${rule.section}"`, text: rule.code });
        a.addEventListener("click", keepStateAfterJump);
        li.append(" ", a);
      }
      ol.append(li);
    }
    checksBox.replaceChildren(h("h3", { text: "What the device checked, in order" }), ol);
  }

  function renderLog(snap) {
    const log = snap.last?.log || [];
    logBox.hidden = !log.length;
    if (!log.length) { logBox.replaceChildren(); return; }
    const ol = h("ol", { class: "vq-log" });
    const shown = log.length > 60 ? [...log.slice(0, 40), null, ...log.slice(-12)] : log;
    for (const a of shown) {
      if (!a) { ol.append(h("li", { class: "vq-gap", text: `... ${grouped(log.length - 52)} more accesses ...` })); continue; }
      const where = a.op === "fence" ? "" : ` at ${hexAddr(a.addr)}${a.len ? `, ${a.len} byte${a.len === 1 ? "" : "s"}` : ""}`;
      const kind = a.op === "guest" ? "guest" : a.ordered ? "ordered" : a.op;
      ol.append(h("li", {}, h("span", { class: "vq-tag", text: kind }), ` ${a.what}${where}`));
    }
    logBox.replaceChildren(
      h("summary", { text: `The device's memory accesses for that step (${grouped(log.length)})` }),
      h("p", { class: "vq-note", text: "\"acquire load\" and \"release store\" are the ordered accesses of chapter 16, \"Two CPUs, one ring, no lock\": they keep the other CPU's writes and ours in the right order." }),
      ol);
  }

  function renderHistory(snap) {
    if (!snap.history.length) {
      historyBox.replaceChildren();
      return;
    }
    const ol = h("ol", { class: "vq-history-list" });
    snap.history.forEach((x, i) => ol.append(h("li", { class: i === snap.history.length - 1 ? "vq-row--last" : null, text: x.text })));
    historyBox.replaceChildren(h("h3", { text: "What happened, step by step" }), ol);
  }

  // A rule link in chapter 16's own embed is a same-page anchor: following it replaces the hash,
  // and with it the lab's share state. Put the state back once the browser has jumped.
  function keepStateAfterJump(ev) {
    try {
      const target = new URL(ev.currentTarget.getAttribute("href"), globalThis.location.href);
      if (target.pathname !== globalThis.location.pathname) return;
      setTimeout(() => ctx.hash.set(enc(state)), 0);
    } catch { /* no location (tests): nothing to restore */ }
  }

  /** Scroll positions of the sideways-scrolling tables, by key, across a re-render. */
  function saveScroll() {
    const out = new Map();
    for (const box of viz.querySelectorAll?.(".vq-scroll") ?? []) out.set(box.getAttribute("data-key"), box.scrollLeft);
    return out;
  }
  function restoreScroll(saved) {
    if (!saved.size) return;
    for (const box of viz.querySelectorAll?.(".vq-scroll") ?? []) {
      const x = saved.get(box.getAttribute("data-key"));
      if (x) box.scrollLeft = x;
    }
  }

  function render() {
    const { world, snap } = current();
    const mode = state.cfg.mode;
    for (const m of MODES) modeInputs[m.id].checked = mode === m.id;
    introText.textContent = INTRO[mode];
    for (const c of ringOnly) c.hidden = mode !== "ring";
    for (const c of toyOnly) c.hidden = mode !== "toy";
    block(undoBtn, past.length || state.actions.length ? null : "Nothing to undo.");
    block(resetBtn, state.actions.length ? null : "Nothing to reset.");
    if (mode === "toy") {
      toySteps.replaceChildren();
      TOY_STEPS.forEach((s, i) => {
        const done = i < snap.toyStep;
        const li = h("li", { class: `vq-step vq-step--${s.who}${done ? " vq-step--done" : ""}${i === snap.toyStep - 1 ? " vq-step--current" : ""}` },
          h("span", { class: "vq-tag", text: s.who === "guest" ? "guest" : "VMM" }), ` ${s.title}`, done ? h("span", { class: "vq-done", text: " (done)" }) : null);
        if (i === snap.toyStep - 1) li.setAttribute("aria-current", "step");
        toySteps.append(li);
      });
      block(nextBtn, whyNot(world, "s"), nextWhy);
      renderToyViz(snap);
      // The same sentence the live region speaks, so a screen-reader user hears what happened.
      readout.textContent = summary(snap);
      checksBox.replaceChildren();
      renderChecks(snap);
      renderLog(snap);
      historyBox.replaceChildren();
      return;
    }
    const c = state.cfg;
    nSel.s.value = String(c.n);
    if (!STARTS.includes(c.start) && !extraStarts.has(c.start)) {
      // A shared link may carry any u16 start; offer it in the menu once.
      extraStarts.add(c.start);
      startSel.s.append(h("option", { value: String(c.start), text: hex16(c.start) }));
    }
    startSel.s.value = String(c.start);
    capSel.s.value = c.cap;
    indChk.input.checked = c.indirect;
    budgetChk.input.checked = !c.budget;
    rereadChk.input.checked = c.reread;
    hostileChk.input.checked = hostile;
    hostileBox.hidden = !hostile;
    customBox.hidden = shapeSel.value !== "custom";
    const req = requestToken();
    customMsg.textContent = shapeSel.value === "custom" && req.error ? req.error : "";
    block(addBtn, req.token ? whyNot(world, req.token) : req.error, addWhy);
    for (const [key, b] of Object.entries(BTN)) block(buttons[key], whyNot(world, b.token), whys[key]);
    const hx = HOSTILE.find((x) => x.id === hostileSel.value) ?? HOSTILE[0];
    hostileAbout.textContent = hx.about;
    block(hostileBtn, whyNot(world, `h${hx.id}`), hostileWhy);
    const pv = PRESETS.find((x) => x.id === presetSel.value);
    presetAbout.textContent = pv ? `${pv.goal} Loading it replaces your ring; Undo brings it back.` : "Choose a prepared ring, then press Load scenario.";
    const parts = [renderDescTable(snap), ...renderIndirect(snap), ...renderRings(snap)];
    const scroll = saveScroll();
    viz.replaceChildren(h("div", { class: "vq-main" }, h("div", { class: "vq-areas" }, ...parts), renderDevice(snap)));
    restoreScroll(scroll);
    readout.textContent = summary(snap);
    const hint = nextHint(snap);
    hintBox.textContent = hint ? `Try next: ${hint}` : "";
    renderChecks(snap);
    renderLog(snap);
    renderHistory(snap);
  }

  render();
  // Write the hash on mount only to correct a shared link (cut to its allowed prefix, or malformed);
  // an untouched lab leaves the address bar, and any heading anchor in it, alone.
  if (shared !== null && shared !== enc(state)) ctx.hash.set(enc(state));

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
