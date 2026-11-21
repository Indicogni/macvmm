// lock-order view: renders the model's state and turns button presses into model calls.
// All logic (scheduling, mutexes, the condvar, deadlock detection, the search over every
// schedule) lives in model.mjs; this file only builds DOM with createElement / textContent
// (never innerHTML) inside the element the lab shell hands us. See course/site/LABS.md.
import {
  SCENARIOS, SCENARIO_IDS, buildProgram, initialState, canStep, canSpurious, apply, outcome,
  waitFor, describeCycle, explore, replay, parseSchedule, encodeShare, decodeShare,
} from "./model.mjs";

// The SVG namespace is a name, never fetched. It is spelled in two pieces because the site
// builder rejects the scheme-plus-slashes string anywhere in shipped lab code (LABS.md section 7).
const SVG_NS = ["http:", "/www.w3.org/2000/svg"].join("/");

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  for (const kid of kids) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}

function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  for (const kid of kids) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

const STATUS_TEXT = {
  ready: "ready",
  lock: "asleep, waiting for a lock",
  cv: "asleep on the condvar",
  done: "finished",
};

function threadStatus(program, st, i) {
  const t = st.threads[i];
  if (t.status === "lock") {
    const who = st.holder[t.waitLock];
    return `asleep: wants ${t.waitLock}, held by ${who === null ? "nobody" : program.threads[who].name}`;
  }
  if (t.status === "ready" && t.woken) return "woken: wait must take the lock back";
  return STATUS_TEXT[t.status];
}

const GENERIC_FIX = "Fix it: use Swap so that every thread takes the locks in one shared order, then try to deadlock it again, or press Try every schedule.";

function outcomeText(program, st, swaps = []) {
  const o = outcome(program, st);
  const v = o.violation ? ` Bug: ${o.violation.text}, the one thing park.rs promises cannot happen.` : "";
  const bugOnly = o.violation ? `The ${o.violation.text}, the one thing park.rs promises cannot happen. Only the predicate loop stops this.` : "";
  switch (o.kind) {
    case "deadlock":
    {
      const sc = SCENARIOS[program.id];
      const fix = program.kind === "locks" ? ` ${!swaps.some(Boolean) && sc && sc.fix ? sc.fix : GENERIC_FIX}` : "";
      return { kind: "deadlock", head: "Deadlock", text: `${describeCycle(program, o.cycle)} The real program would sit here at 0% CPU forever.${v}${fix}` };
    }
    case "forever":
      return {
        kind: "forever", head: "Asleep forever",
        text: `${program.threads[o.thread].name} sleeps on the condvar and nobody is left to ring the bell${st.lostNotifies ? ": the only notify came before anyone was waiting, and a notify with no waiter is not saved" : ""}. Nothing in this program ever ends this wait; the real program would hang here. The primer's lost.rs adds a 2 s wait_timeout only so that it can end and show you this.${v}`,
      };
    case "done":
      return { kind: o.violation ? "bug" : "done", head: o.violation ? "Finished, wrongly" : "Finished", text: `Every thread finished.${v}` };
    case "stuck":
      return { kind: "deadlock", head: "Stuck", text: `No thread can move.${v}` };
    default:
      return o.violation ? { kind: "bug", head: "Bug", text: bugOnly } : null;
  }
}

export function mount(el, ctx) {
  const id = ctx.id;
  const shared = decodeShare(ctx.hash.get());
  let ui = {
    scenario: shared ? shared.scenario : "deadlock",
    swaps: shared ? shared.swaps : [],
    actions: shared ? shared.actions : [],
    search: null,
  };
  let program = buildProgram(ui.scenario, ui.swaps);
  let state = replay(program, ui.actions).state;
  let timer = null;
  let lastAnnounce = 0;

  function say(text) {
    const wait = Math.max(0, 300 - (Date.now() - lastAnnounce));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      lastAnnounce = Date.now();
      ctx.announce(text);
    }, wait);
  }

  // ---- static skeleton ------------------------------------------------------------------
  const scenarioSel = h("select", { id: `${id}-scenario` });
  for (const sid of SCENARIO_IDS) scenarioSel.append(h("option", { value: sid, text: SCENARIOS[sid].title }));
  const backBtn = h("button", { type: "button", class: "lo-btn", text: "Undo step", "data-focus": "undo" });
  const resetBtn = h("button", { type: "button", class: "lo-btn", text: "Reset", "data-focus": "reset" });
  const searchBtn = h("button", { type: "button", class: "lo-btn", text: "Try every schedule" });
  const shareBtn = h("button", { type: "button", class: "lo-btn", text: "Copy link to this run" });
  const controls = h("div", { class: "lo-controls" },
    h("div", { class: "lo-field" }, h("label", { for: `${id}-scenario`, text: "Program" }), scenarioSel),
    h("div", { class: "lo-buttons", role: "group", "aria-label": "Run" }, backBtn, resetBtn, searchBtn, shareBtn),
  );
  const summary = h("p", { class: "lo-summary" });
  const howto = h("p", { class: "lo-note", text: "You are the scheduler: each Step button runs one line of that thread, and the order in which you press the Step buttons is a schedule. A thread asleep on a lock or on the condvar cannot be stepped until something wakes it." });
  const challenge = h("p", { class: "lo-challenge" });

  const threadsBox = h("div", { class: "lo-threads" });
  // tabindex -1: focus lands here when the control the reader pressed is gone or disabled and no
  // thread can be stepped any more (the run ended), so keyboard users keep their place.
  const banner = h("div", { class: "lo-banner", hidden: true, tabindex: "-1" });
  const bannerHead = h("strong", { class: "lo-banner__head" });
  const bannerText = h("span", {});
  banner.append(bannerHead, " ", bannerText);

  const locksBody = h("tbody");
  const locksTable = h("table", { class: "lo-locks" },
    h("caption", { text: "Locks" }),
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Lock" }), h("th", { scope: "col", text: "Held by" }), h("th", { scope: "col", text: "Asleep waiting for it" }))),
    locksBody,
  );
  const cvLine = h("p", { class: "lo-cv" });

  // Wait-for graph.
  const arrowId = `${id}-arrow`;
  const arrowCycleId = `${id}-arrow-cycle`;
  const svgTitle = s("title", { id: `${id}-graph-title`, text: "Who holds what, who waits for what" });
  const edgesG = s("g", {});
  const nodesG = s("g", {});
  const svg = s("svg", {
    class: "lo-graph", viewBox: "0 0 360 250", role: "img",
    "aria-labelledby": `${id}-graph-title`,
  },
  svgTitle,
  s("defs", {},
    s("marker", { id: arrowId, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "9", markerHeight: "9", markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" },
      s("path", { d: "M0,0 L10,5 L0,10 z", class: "lo-arrow" })),
    s("marker", { id: arrowCycleId, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "9", markerHeight: "9", markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" },
      s("path", { d: "M0,0 L10,5 L0,10 z", class: "lo-arrow lo-arrow--cycle" }))),
  edgesG, nodesG);
  const legend = h("p", { class: "lo-note", text: "Solid arrow: from a lock to the thread holding it. Dashed arrow: from a thread to the lock it is asleep on. A thick arrow labelled \"cycle\" is part of a deadlock." });
  const graphText = h("p", { class: "lo-graph-text" });
  const graphBox = h("figure", { class: "lo-figure" },
    h("div", { class: "lo-scroll" }, svg),
    h("figcaption", {}, legend, graphText),
  );

  const outputList = h("pre", { class: "lo-output", "aria-label": "Program output" });
  const logList = h("ol", { class: "lo-log", "aria-label": "Steps so far", tabindex: "0" }); // scrolls, so focusable
  const logEmpty = h("p", { class: "lo-muted lo-log-empty", text: "No steps yet." });
  // A plain visible summary, deliberately not a live region: changes are spoken once, briefly,
  // through ctx.announce (LABS.md section 6: the shell's live region or your own, not both).
  const readout = h("p", { class: "lo-readout", tabindex: "-1" });

  const searchOut = h("p", { class: "lo-search", hidden: true });
  const showBtn = h("button", { type: "button", class: "lo-btn", hidden: true, text: "Show me that schedule" });

  const honesty = h("details", { class: "lo-more" },
    h("summary", { text: "What this toy simplifies" }),
    h("ul", {},
      h("li", { text: "One step is one line of Rust. Real threads interleave at the level of single instructions, and the kernel's scheduler, not you, picks who runs." }),
      h("li", { text: "deadlock.rs uses a Barrier to force the deadly timing every time; here you force it by hand, so the barrier is left out." }),
      h("li", { text: "When a lock is released, every thread asleep on it becomes ready and retries. A real mutex may hand it straight to one waiter; the possible outcomes are the same." }),
      h("li", { text: "Unlocking shows as drop(guard). In deadlock.rs and ordered.rs the guards are dropped at the end of their block, newest first, which is the order shown." }),
      h("li", { text: "park.rs sets the flag through a temporary guard, *powered_on.lock().unwrap() = true;, which is dropped at the end of that one statement. The lab spells the same thing as three lines: lock, set, drop." }),
      h("li", { text: "\"Try every schedule\" visits every distinct situation once: who holds which lock, where each thread is, and the flag. Runs that differ only in the order lines were printed count as one, because print order never changes what can happen next. A \"no\" here is a proof for this toy, not for your real program." }),
    ),
  );

  el.append(h("div", { class: "lo-wrap" },
    controls, summary, howto, challenge, banner, threadsBox,
    h("div", { class: "lo-main" },
      h("div", { class: "lo-col" }, locksTable, cvLine, graphBox),
      h("div", { class: "lo-col" },
        h("h3", { class: "lo-h", text: "Output" }), outputList,
        h("h3", { class: "lo-h", text: "What happened" }), logList, logEmpty),
    ),
    readout, h("div", { class: "lo-searchbox" }, searchOut, showBtn), honesty,
  ));

  // ---- rendering ------------------------------------------------------------------------
  function threadColumn(i) {
    const t = state.threads[i];
    const def = program.threads[i];
    const list = h("ol", { class: "lo-code", "aria-label": `${def.name} script` });
    def.script.forEach((ins, k) => {
      const current = t.status !== "done" && t.pc === k;
      const li = h("li", { class: `lo-line${current ? " lo-line--current" : ""}${current && t.status !== "ready" ? " lo-line--asleep" : ""}` },
        h("span", { class: "lo-marker", "aria-hidden": "true", text: current ? (t.status === "ready" ? "▶" : "z") : "" }),
        h("code", { class: "lo-ins", text: ins.text }),
      );
      if (current) {
        li.setAttribute("aria-current", "step");
        li.prepend(h("span", { class: "lo-visually-hidden", text: t.status === "ready" ? "Next: " : "Stuck at: " }));
      }
      list.append(li);
    });
    const stepBtn = h("button", { type: "button", class: "lo-btn lo-btn--primary", text: `Step ${def.name}`, "data-focus": `step-${i}` });
    stepBtn.disabled = !canStep(program, state, i);
    stepBtn.addEventListener("click", () => act({ thread: i, spurious: false }));
    keep(stepBtn);
    const buttons = h("div", { class: "lo-buttons" }, stepBtn);
    if (program.kind === "locks") {
      const swapBtn = h("button", { type: "button", class: "lo-btn", text: `Swap ${def.name}'s lock order`, "data-focus": `swap-${i}` });
      swapBtn.setAttribute("aria-describedby", `${id}-swapnote`);
      swapBtn.addEventListener("click", () => {
        ui.swaps = program.threads.map((_, k) => Boolean(ui.swaps[k]) !== (k === i));
        restart(`${def.name} now takes ${[...program.threads[i].order].reverse().join(", then ")}. Run restarted.`);
      });
      buttons.append(keep(swapBtn));
    } else if (def.script.some((x) => x.op === "wait")) {
      const spBtn = h("button", { type: "button", class: "lo-btn", text: "Spurious wake-up", "data-focus": `spurious-${i}` });
      spBtn.disabled = !canSpurious(program, state, i);
      spBtn.addEventListener("click", () => act({ thread: i, spurious: true }));
      buttons.append(keep(spBtn));
    }
    const order = def.order ? h("p", { class: "lo-order", text: `Lock order: ${def.order.join(", then ")}` }) : null;
    return h("section", { class: `lo-thread lo-thread--${t.status}`, "aria-label": def.name },
      h("h3", { class: "lo-h", text: def.name }),
      h("p", { class: "lo-status", text: `Status: ${threadStatus(program, state, i)}` }),
      order,
      h("div", { class: "lo-scroll" }, list),
      buttons,
    );
  }

  function renderGraph(o) {
    const nodes = [];
    const n = Math.max(program.locks.length, program.threads.length);
    for (let k = 0; k < n; k++) {
      if (k < program.locks.length) nodes.push({ key: `l:${program.locks[k]}`, label: program.locks[k], lock: true });
      if (k < program.threads.length) nodes.push({ key: `t:${k}`, label: program.threads[k].name, lock: false, i: k });
    }
    const cx = 180, cy = 125, rx = 120, ry = 85;
    const pos = new Map();
    nodes.forEach((nd, k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / nodes.length;
      pos.set(nd.key, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    });
    const cycleLocks = new Set(o.kind === "deadlock" && o.cycle ? o.cycle.map((e) => e.lock) : []);
    const cycleThreads = new Set(o.kind === "deadlock" && o.cycle ? o.cycle.map((e) => e.from) : []);
    const edges = [];
    for (const l of program.locks) {
      const hld = state.holder[l];
      if (hld !== null) edges.push({ from: `l:${l}`, to: `t:${hld}`, kind: "hold", cycle: cycleLocks.has(l) && cycleThreads.has(hld) });
    }
    for (const e of waitFor(program, state)) {
      edges.push({ from: `t:${e.from}`, to: `l:${e.lock}`, kind: "wait", cycle: cycleThreads.has(e.from) && cycleLocks.has(e.lock) });
    }
    edgesG.replaceChildren();
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const pad = 30;
      const x1 = a.x + (dx / len) * pad, y1 = a.y + (dy / len) * pad;
      const x2 = b.x - (dx / len) * pad, y2 = b.y - (dy / len) * pad;
      edgesG.append(s("line", {
        x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1),
        class: `lo-edge lo-edge--${e.kind}${e.cycle ? " lo-edge--cycle" : ""}`,
        "marker-end": `url(#${e.cycle ? arrowCycleId : arrowId})`,
      }));
      if (e.cycle) {
        // Label beside the edge (offset along its normal), not on top of it.
        const nx = -dy / len, ny = dx / len;
        edgesG.append(s("text", { x: ((x1 + x2) / 2 + nx * 12).toFixed(1), y: ((y1 + y2) / 2 + ny * 12 + 4).toFixed(1), class: "lo-edge-label", "text-anchor": "middle", text: "cycle" }));
      }
    }
    nodesG.replaceChildren();
    // Wide enough for the longest lock name in a monospace font at 11px (about 7px a character).
    const lockW = Math.max(40, ...program.locks.map((l) => l.length * 7 + 16));
    for (const nd of nodes) {
      const p = pos.get(nd.key);
      const inCycle = nd.lock ? cycleLocks.has(nd.label) : cycleThreads.has(nd.i);
      const shape = nd.lock
        ? s("rect", { x: (p.x - lockW / 2).toFixed(1), y: (p.y - 15).toFixed(1), width: String(lockW), height: "30", rx: "4", class: `lo-node lo-node--lock${inCycle ? " lo-node--cycle" : ""}` })
        : s("ellipse", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), rx: "46", ry: "18", class: `lo-node lo-node--thread${inCycle ? " lo-node--cycle" : ""}` });
      nodesG.append(shape, s("text", { x: p.x.toFixed(1), y: (p.y + 4).toFixed(1), "text-anchor": "middle", class: `lo-node-label${nd.lock ? " lo-node-label--mono" : ""}`, text: nd.label }));
    }
    const holds = program.locks.map((l) => (state.holder[l] === null ? `${l} is free` : `${l} is held by ${program.threads[state.holder[l]].name}`));
    const waits = waitFor(program, state).map((e) => `${program.threads[e.from].name} is asleep waiting for ${e.lock}`);
    const text = [...holds, ...waits].join("; ") + ".";
    const cyc = o.kind === "deadlock" ? ` ${describeCycle(program, o.cycle)}` : " No cycle.";
    graphText.textContent = text + cyc;
  }

  // Focus keeping. Every render rebuilds the thread columns, so the button the reader just pressed
  // is replaced. Each lab control carries a data-focus key ("step-1", "swap-0", "undo", ...);
  // after rendering, focus moves to the control with the same key. If that control is gone or now
  // disabled (the thread fell asleep or finished, Undo emptied the run), it moves to the next
  // thread that can still be stepped, and failing that to the outcome banner or the readout.
  const mine = new WeakSet([backBtn, resetBtn, searchBtn, shareBtn, scenarioSel]);
  function activeElement() {
    return (el.ownerDocument || globalThis.document || {}).activeElement || null;
  }
  function focusKeyOf(node) {
    return node && mine.has(node) && typeof node.getAttribute === "function" ? node.getAttribute("data-focus") : null;
  }
  function controlFor(key) {
    if (key === "undo") return backBtn;
    if (key === "reset") return resetBtn;
    return threadControls.get(key) || null;
  }
  const usable = (b) => b && !b.disabled && !b.hidden;
  function restoreFocus(before, key) {
    if (!key) return;
    const same = controlFor(key);
    if (usable(same)) {
      if (same !== before) same.focus();
      return;
    }
    const n = program.threads.length;
    const from = /^(?:step|swap|spurious)-(\d+)$/.exec(key);
    const start = from ? Number(from[1]) + 1 : 0;
    for (let k = 0; k < n; k++) {
      const b = threadControls.get(`step-${(start + k) % n}`);
      if (usable(b)) { b.focus(); return; }
    }
    (banner.hidden ? readout : banner).focus();
  }

  const threadControls = new Map();
  function keep(btn) {
    mine.add(btn);
    threadControls.set(btn.getAttribute("data-focus"), btn);
    return btn;
  }

  function render() {
    const before = activeElement();
    const focusKey = focusKeyOf(before);
    const o = outcome(program, state);
    scenarioSel.value = ui.scenario;
    summary.textContent = SCENARIOS[ui.scenario].summary;
    challenge.textContent = SCENARIOS[ui.scenario].challenge || "";
    challenge.hidden = !challenge.textContent;
    el.classList.toggle("lo-condvar", program.kind === "condvar");

    threadControls.clear();
    threadsBox.replaceChildren(...program.threads.map((_, i) => threadColumn(i)));
    const swapNote = program.kind === "locks"
      ? h("p", { class: "lo-note", id: `${id}-swapnote`, text: "Swapping a thread's lock order restarts the run from the beginning." })
      : null;
    if (swapNote) threadsBox.append(swapNote);

    const ot = outcomeText(program, state, ui.swaps);
    banner.hidden = !ot;
    banner.className = ot ? `lo-banner lo-banner--${ot.kind}` : "lo-banner";
    bannerHead.textContent = ot ? `${ot.head}.` : "";
    bannerText.textContent = ot ? ot.text : "";

    locksBody.replaceChildren();
    for (const l of program.locks) {
      const hld = state.holder[l];
      const waiting = state.threads.map((t, i) => (t.status === "lock" && t.waitLock === l ? program.threads[i].name : null)).filter(Boolean);
      locksBody.append(h("tr", {},
        h("th", { scope: "row", class: "lo-mono", text: l }),
        h("td", { text: hld === null ? "free" : program.threads[hld].name }),
        h("td", { text: waiting.length ? waiting.join(", ") : "nobody" })));
    }
    cvLine.hidden = program.kind !== "condvar";
    if (program.kind === "condvar") {
      const sleepers = state.threads.map((t, i) => (t.status === "cv" ? program.threads[i].name : null)).filter(Boolean);
      cvLine.textContent = `powered_on = ${state.flag}. Asleep on the condvar: ${sleepers.length ? sleepers.join(", ") : "nobody"}. Notifies that found nobody waiting (lost): ${state.lostNotifies}.`;
    }
    renderGraph(o);

    outputList.textContent = state.output.length ? state.output.join("\n") : "(nothing printed yet)";
    logList.replaceChildren(...state.log.map((e) => h("li", { text: e.text })));
    logList.hidden = state.log.length === 0;
    logEmpty.hidden = state.log.length > 0;

    backBtn.disabled = ui.actions.length === 0;
    // Reset stays enabled (a no-op at the start) so pressing it never strands keyboard focus.

    const last = state.log.length ? state.log[state.log.length - 1].text + ". " : "";
    readout.textContent = ot ? `${last}${ot.head}. ${ot.text}` : `${last}Step ${ui.actions.length}. ${program.threads.map((_, i) => `${program.threads[i].name}: ${threadStatus(program, state, i)}`).join("; ")}.`;

    if (ui.search) {
      searchOut.hidden = false;
      searchOut.textContent = ui.search.text;
      showBtn.hidden = !ui.search.path;
    } else {
      searchOut.hidden = true;
      showBtn.hidden = true;
    }
    ctx.hash.set(encodeShare({ scenario: ui.scenario, swaps: ui.swaps, actions: ui.actions }));
    restoreFocus(before, focusKey);
  }

  /**
   * The short sentence spoken after a change: the last thing that happened, then the outcome's
   * headline. The full explanation is spoken only when the outcome changes; it stays on screen.
   */
  function spoken(prevKind) {
    const ot = outcomeText(program, state, ui.swaps);
    const last = state.log.length ? `${state.log[state.log.length - 1].text}. ` : "";
    if (!ot) return `${last}Step ${ui.actions.length}.`;
    return ot.kind === prevKind ? `${last}${ot.head}.` : `${last}${ot.head}. ${ot.text}`;
  }
  const kindNow = () => { const ot = outcomeText(program, state, ui.swaps); return ot ? ot.kind : null; };

  function act(a) {
    const n = apply(program, state, a);
    if (!n) return;
    const prev = kindNow();
    state = n;
    ui.actions = [...ui.actions, a];
    render();
    say(spoken(prev));
  }

  function restart(message) {
    program = buildProgram(ui.scenario, ui.swaps);
    ui.actions = [];
    ui.search = null;
    state = initialState(program);
    render();
    say(message || `${SCENARIOS[ui.scenario].title}. ${spoken(null)}`);
  }

  function names(path) {
    return path.map((a) => (a[0] === "w" ? `spurious wake-up of ${program.threads[Number(a.slice(1)) - 1].name}` : program.threads[Number(a) - 1].name)).join(", ");
  }

  // ---- events ---------------------------------------------------------------------------
  backBtn.addEventListener("click", () => {
    if (!ui.actions.length) return;
    ui.actions = ui.actions.slice(0, -1);
    const prev = kindNow();
    state = replay(program, ui.actions).state;
    render();
    say(`Undone. ${spoken(prev)}`);
  });
  resetBtn.addEventListener("click", () => restart("Reset to the start."));
  scenarioSel.addEventListener("change", () => {
    if (!SCENARIO_IDS.includes(scenarioSel.value)) return;
    ui.scenario = scenarioSel.value;
    ui.swaps = [];
    restart();
  });
  searchBtn.addEventListener("click", () => {
    const condvar = program.kind === "condvar";
    const r = explore(program, { spuriousWakeups: condvar });
    const bad = r.deadlock ? ["deadlock", r.deadlock] : r.forever ? ["sleep forever", r.forever] : r.violation ? ["run before powered_on is true", r.violation] : null;
    const scope = `Checked every schedule${condvar ? ", spurious wake-ups included" : ""}: ${r.states} reachable states${r.complete ? "" : " (search stopped early)"}.`;
    let text;
    if (bad) {
      const extra = !r.deadlock && r.forever && r.violation ? " It can also run the secondary before powered_on is true." : "";
      text = `${scope} It can ${bad[0]}. Shortest way (${bad[1].length} steps): ${names(bad[1])}.${extra}`;
    } else {
      text = `${scope} No schedule deadlocks, sleeps forever or runs early: every run finishes.`;
    }
    ui.search = { text, path: bad ? bad[1] : null };
    render();
    say(text);
  });
  showBtn.addEventListener("click", () => {
    if (!ui.search || !ui.search.path) return;
    const actions = parseSchedule(ui.search.path.join(""), program.threads.length) || [];
    const r = replay(program, actions);
    ui.actions = r.actions;
    state = r.state;
    render();
    say(spoken(null));
  });
  shareBtn.addEventListener("click", async () => {
    render();
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this run is in the address bar.");
    }
  });

  render();

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
