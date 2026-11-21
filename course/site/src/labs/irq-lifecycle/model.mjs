// irq-lifecycle model: pure logic, no DOM (course/site/LABS.md section 3).
//
// Two views of one idea, "an interrupt is state, not a call":
//
//   * mode "cpu" (chapter 11, no interrupt controller): one CPU input and three kinds of source
//     side by side, each in its own little world: a level-triggered line, an edge with no latch,
//     and an edge with a latch (the PL011's RIS is such a latch). The same action is applied to
//     all three, so the reader sees which one loses the interrupt. The CPU starts with IRQs
//     masked (PSTATE.I = 1), as in the lesson's table.
//
//   * mode "gic" (chapter 12, GICv3): one SPI, INTID 33 (the PL011's line), configured level (as
//     it really is) or edge (a what-if). The reader raises and lowers the line, reads the IAR
//     (ICC_IAR1_EL1) and writes the EOI (ICC_EOIR1_EL1), and watches the per-INTID state:
//     inactive, pending, active, active and pending (IHI 0069, "Interrupt handling state
//     machine"). For a level interrupt the pending half follows the line; for an edge it is a
//     latch set by a rising edge and cleared by the acknowledge. EOImode is 0 (priority drop
//     and deactivation in one write), the mode our guests use (guests/common/gic.rs), and Linux
//     when it boots at EL1 as it does on macvmm (at EL2 Linux splits the two, EOImode 1).
//
// The lessons quote two text tables "if the lab does not load". cpuFallbackText() and
// gicFallbackText() regenerate them from this model; model.test.mjs checks them character for
// character against the lesson files, so the lab and the lessons cannot drift apart.
//
// State is { mode, trigger, actions }, where actions is a short string of action letters. Every
// derived thing (rows, worlds, readout) is a replay of those letters, so the share hash is just
// the letters, and the replay is the only code path.

export const INTID = 33;
export const SPURIOUS = 1023;
export const MAX_ACTIONS = 64;

export const MODES = [
  { id: "cpu", label: "Without a controller (chapter 11)" },
  { id: "gic", label: "With the GIC (chapter 12)" },
];

export const CPU_KINDS = [
  { id: "level", label: "level line" },
  { id: "edge", label: "edge, no latch" },
  { id: "latched", label: "edge, latched" },
];

/** Actions in mode "cpu". `key` is the letter used in the share hash. */
export const CPU_ACTIONS = [
  { key: "r", id: "raise", button: "Source raises", help: "The device signals: a level line goes high, an edge source sends one pulse." },
  { key: "w", id: "wait", button: "Time passes", help: "Nothing changes on the CPU side; see whether the interrupt is still there." },
  { key: "m", id: "mask", button: "CPU masks IRQs", help: "msr daifset, #2: set PSTATE.I." },
  { key: "u", id: "unmask", button: "CPU unmasks IRQs", help: "msr daifclr, #2: clear PSTATE.I." },
  { key: "k", id: "return", button: "Handler returns, cause kept", help: "The handler returns without making the source stop asking." },
  { key: "c", id: "clear", button: "Handler clears the cause", help: "The handler makes the source stop asking (reads the byte, silences the timer), then returns." },
];

/** Actions in mode "gic". */
export const GIC_ACTIONS = [
  { key: "r", id: "raise", button: "Device raises the line", help: "For INTID 33: a byte arrives and the PL011 drives its line high." },
  { key: "d", id: "lower", button: "Device lowers the line", help: "For INTID 33: the RX FIFO empties (the handler read DR) and the line goes low." },
  { key: "i", id: "iar", button: "CPU reads IAR", help: "The handler acknowledges by reading the IAR (interrupt acknowledge register): mrs x0, ICC_IAR1_EL1 returns an INTID, or 1023 for nothing." },
  { key: "e", id: "eoi", button: "Handler writes EOI", help: "The handler says it is done by writing the EOI (end of interrupt) register: msr ICC_EOIR1_EL1, x0." },
];

const actionsFor = (mode) => (mode === "gic" ? GIC_ACTIONS : CPU_ACTIONS);
export const actionByKey = (mode, key) => actionsFor(mode).find((a) => a.key === key) || null;

// ---------------------------------------------------------------------------------------------
// Mode "cpu": three worlds, one CPU each.

/** One world: a source of `kind` wired straight to a CPU's IRQ input. */
export function initialCpuWorld(kind) {
  if (!CPU_KINDS.some((k) => k.id === kind)) throw new RangeError(`unknown source kind ${kind}`);
  // masked: PSTATE.I. inHandler: the CPU is running the IRQ handler (entry set PSTATE.I too).
  // line: the level line (high while the cause holds). latch: the edge latch.
  return { kind, masked: true, inHandler: false, line: false, latch: false, runs: 0, lost: 0, merged: 0 };
}

/** Is an interrupt pending at the CPU's input right now? (An unlatched edge never is: it is gone.) */
export function cpuPending(w) {
  if (w.kind === "level") return w.line;
  if (w.kind === "latched") return w.latch;
  return false;
}

/** The CPU takes an IRQ between two instructions when one is pending and IRQs are not masked. */
function take(w) {
  return { ...w, inHandler: true, runs: w.runs + 1 };
}
const canTake = (w) => !w.masked && !w.inHandler;

/** The cell for mask/unmask inside the handler: it would not stick, so the toy does not apply it. */
export const IN_HANDLER_CELL = "in handler (eret restores PSTATE)";

/**
 * Apply one action to one world. Returns { world, cell, applies }, where `cell` is the short text
 * the lesson's table prints for that world ("-" when the action does not apply there) and
 * `applies` is false when the action changed nothing there by construction ("-", or a mask
 * change inside the handler).
 */
export function stepCpuWorld(w, action) {
  switch (action) {
    case "raise": {
      if (w.kind === "level") {
        if (w.line) return { world: w, cell: "already high" };
        const n = { ...w, line: true };
        return canTake(n) ? { world: take(n), cell: "pending, handler runs" } : { world: n, cell: "pending" };
      }
      if (w.kind === "edge") {
        if (canTake(w)) return { world: take(w), cell: "pulse, handler runs" };
        return { world: { ...w, lost: w.lost + 1 }, cell: "pulse, gone" };
      }
      // latched edge
      if (w.latch) return { world: { ...w, merged: w.merged + 1 }, cell: "latch already set" };
      const n = { ...w, latch: true };
      return canTake(n) ? { world: take(n), cell: "latch set, handler runs" } : { world: n, cell: "latch set, pending" };
    }
    case "wait": {
      if (w.inHandler) return { world: w, cell: "handler running" };
      return { world: w, cell: cpuPending(w) ? "still pending" : "nothing pending" };
    }
    case "mask": {
      // Inside the handler PSTATE.I is already set by the exception entry, and eret restores the
      // PSTATE saved at entry, so a daifset here would be undone on return: it does not stick.
      if (w.inHandler) return { world: w, cell: IN_HANDLER_CELL, applies: false };
      if (w.masked) return { world: w, cell: "already masked" };
      return { world: { ...w, masked: true }, cell: cpuPending(w) ? "masked, still pending" : "masked" };
    }
    case "unmask": {
      // Inside the handler the CPU runs with PSTATE.I set by the exception entry; returning
      // (eret) is how this toy handler unmasks (it never nests), so an unmask there is not applied.
      if (w.inHandler) return { world: w, cell: IN_HANDLER_CELL, applies: false };
      if (!w.masked) return { world: w, cell: "already unmasked" };
      const n = { ...w, masked: false };
      return cpuPending(n) ? { world: take(n), cell: "handler runs" } : { world: n, cell: "nothing happens" };
    }
    case "return": {
      if (!w.inHandler) return { world: w, cell: "-" };
      // eret restores the PSTATE saved at entry (IRQs unmasked), so a source still asking is
      // taken again before the next instruction of the interrupted program.
      const n = { ...w, inHandler: false };
      if (cpuPending(n)) return { world: take(n), cell: "runs again at once" };
      return { world: n, cell: "returns, nothing pending" };
    }
    case "clear": {
      if (!w.inHandler) return { world: w, cell: "-" };
      if (w.kind === "level") return { world: { ...w, line: false, inHandler: false }, cell: "line drops, done" };
      if (w.kind === "latched") return { world: { ...w, latch: false, inHandler: false }, cell: "latch cleared, done" };
      return { world: { ...w, inHandler: false }, cell: "done" };
    }
    default:
      throw new RangeError(`unknown cpu action ${action}`);
  }
}

function cpuStepLabel(worlds, action) {
  switch (action) {
    case "raise": return "source raises";
    // The worlds' CPUs can disagree (one may be in its handler), so only say "masked" when
    // every one of them is masked and outside its handler.
    case "wait": return worlds.every((w) => w.masked && !w.inHandler) ? "CPU masked, waits" : "time passes";
    case "mask": return "CPU masks IRQs";
    case "unmask": return "CPU unmasks";
    case "return": return "handler returns, cause kept";
    case "clear": return "handler clears the cause";
    default: throw new RangeError(`unknown cpu action ${action}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Mode "gic": one INTID in a GICv3.

export function initialGic(trigger) {
  if (trigger !== "level" && trigger !== "edge") throw new RangeError(`unknown trigger ${trigger}`);
  // edgeLatch: the pending bit of an edge interrupt (set by a rising edge, cleared by the IAR).
  // lowered: the line went low at some point since the last acknowledge, so a level interrupt
  // that is pending again at EOI is a new event, not the same cause never removed (a storm).
  return { trigger, line: false, edgeLatch: false, active: false, lowered: false, acks: 0, spurious: 0, eois: 0 };
}

/** The pending half of the state: a level interrupt follows its line; an edge one is latched. */
export function gicPending(g) {
  return g.trigger === "level" ? g.line : g.edgeLatch;
}

/** The four states of IHI 0069's state machine, in the lesson's words. */
export function gicStateName(g) {
  const p = gicPending(g);
  if (g.active && p) return "active and pending";
  if (g.active) return "active";
  if (p) return "pending";
  return "inactive";
}

/** Is the CPU interface signalling an IRQ to the CPU? Pending and not already being handled. */
export function gicSignalling(g) {
  return gicPending(g) && !g.active;
}

/**
 * Apply one action. Returns { gic, row: { step, line, state, note }, result } where `result` is
 * the value an IAR read returned (33 or 1023), else null.
 */
export function stepGic(g, action) {
  let n = g;
  let step = "";
  let note = "";
  let result = null;
  switch (action) {
    case "raise": {
      if (g.line) {
        step = "line already high";
        note = g.trigger === "edge" ? "no new edge, nothing changes" : "nothing changes";
        break;
      }
      n = { ...g, line: true };
      if (g.trigger === "level") {
        step = "byte arrives";
      } else {
        step = "rising edge";
        if (g.edgeLatch) note = "two edges, one pending bit";
        else if (g.active) note = "a second edge while active: kept";
        n.edgeLatch = true;
      }
      break;
    }
    case "lower": {
      if (!g.line) {
        step = "line already low";
        note = "nothing changes";
        break;
      }
      n = { ...g, line: false, lowered: g.lowered || g.active };
      if (g.trigger === "edge") {
        step = "line falls";
        note = "an edge interrupt ignores the fall";
      } else if (g.active) {
        step = "handler reads DR (FIFO empty)";
      } else {
        step = "device lowers the line";
        note = "dropped before the IAR: no longer pending";
      }
      break;
    }
    case "iar": {
      // Only an interrupt that is pending and not active can be acknowledged. An active one is
      // also blocked by the running priority until its EOI, so a second read gets 1023 too.
      if (gicPending(g) && !g.active) {
        result = INTID;
        n = { ...g, active: true, lowered: false, acks: g.acks + 1 };
        if (g.trigger === "edge") n.edgeLatch = false;
        if (g.trigger === "edge" && g.line) {
          step = "CPU reads IAR, line held high";
          note = "active only: the IAR cleared pending";
        } else {
          step = `CPU reads IAR (returns ${INTID})`;
        }
      } else {
        result = SPURIOUS;
        n = { ...g, spurious: g.spurious + 1 };
        step = `CPU reads IAR (returns ${SPURIOUS})`;
        note = g.active ? "already active: nothing new to acknowledge" : "spurious: the handler returns without an EOI";
      }
      break;
    }
    case "eoi": {
      step = "handler writes EOI";
      if (!g.active) {
        note = "nothing is active: an EOI now is a guest bug";
        break;
      }
      n = { ...g, active: false, eois: g.eois + 1 };
      if (gicPending(n)) {
        if (g.trigger === "edge") note = "taken again: the second edge was kept";
        else if (g.lowered) note = "pending again: a new byte arrived during the handler";
        else note = "taken again at once: a storm";
      }
      else if (n.line) note = "no re-delivery";
      else note = "one interrupt, done";
      break;
    }
    default:
      throw new RangeError(`unknown gic action ${action}`);
  }
  return { gic: n, row: { step, line: n.line ? "high" : "low", state: gicStateName(n), note }, result };
}

// ---------------------------------------------------------------------------------------------
// Lab state, replay and steps.

export function initialState(mode = "cpu", trigger = "level") {
  if (mode !== "cpu" && mode !== "gic") throw new RangeError(`unknown mode ${mode}`);
  return { mode, trigger: mode === "gic" ? (trigger === "edge" ? "edge" : "level") : "level", actions: "" };
}

/**
 * Pages whose embed opens in the GIC view: chapter 12's URL (relative to the course root, as in
 * course/chapters.json; model.test.mjs checks it). The lab shell passes no per-embed options
 * today, so the page path is how one lab serves both chapters without showing chapter 12's
 * vocabulary first in chapter 11 or chapter 11's view first in chapter 12.
 */
export const GIC_START_PAGES = ["interrupts/gicv3/"];

/**
 * The state a fresh mount starts in. `options.mode` ("cpu" or "gic"), if a future lab shell
 * passes per-embed options, wins; otherwise an embed on a GIC_START_PAGES page starts in the GIC
 * view (level, as the PL011 is), and everything else, the standalone page included, in the
 * chapter 11 view.
 */
export function startState({ standalone = false, path = "", options = null } = {}) {
  const m = options && typeof options === "object" ? options.mode : undefined;
  if (m === "gic" || m === "cpu") return initialState(m, "level");
  const p = String(path).replace(/index\.html$/, "");
  if (!standalone && GIC_START_PAGES.some((u) => p.endsWith(`/${u}`))) return initialState("gic", "level");
  return initialState();
}

/**
 * The share string to write for `state` on a page that starts in `start`: null (clear the hash)
 * when nothing differs from the start, else encode(state), with "cpu" for an empty chapter 11
 * view so that a link from a GIC-start page still opens that view.
 */
export function shareString(state, start) {
  if (state.mode === start.mode && state.trigger === start.trigger && state.actions === start.actions) return null;
  return encode(state) ?? "cpu";
}

/**
 * Replay a state's actions. Returns
 *   cpu: { worlds, rows: [{ key, step, cells: [3 strings] }], refused: index|-1 }
 *   gic: { gic, rows: [{ key, step, line, state, note, result }], refused: index|-1 }
 * An action that applies in no world (every cell "-", or a mask change inside every handler) is
 * "refused": replay stops there.
 */
export function replay(state) {
  const rows = [];
  if (state.mode === "cpu") {
    let worlds = CPU_KINDS.map((k) => initialCpuWorld(k.id));
    for (let i = 0; i < state.actions.length; i++) {
      const a = actionByKey("cpu", state.actions[i]);
      if (!a) return { worlds, rows, refused: i };
      const label = cpuStepLabel(worlds, a.id);
      const outs = worlds.map((w) => stepCpuWorld(w, a.id));
      if (outs.every((o) => o.cell === "-" || o.applies === false)) return { worlds, rows, refused: i };
      worlds = outs.map((o) => o.world);
      rows.push({ key: a.key, step: label, cells: outs.map((o) => o.cell) });
    }
    return { worlds, rows, refused: -1 };
  }
  let gic = initialGic(state.trigger);
  for (let i = 0; i < state.actions.length; i++) {
    const a = actionByKey("gic", state.actions[i]);
    if (!a) return { gic, rows, refused: i };
    const out = stepGic(gic, a.id);
    gic = out.gic;
    rows.push({ key: a.key, ...out.row, result: out.result });
  }
  return { gic, rows, refused: -1 };
}

/** Would this action be accepted now? (cpu mode refuses actions that apply in no world.) */
export function canDo(state, key) {
  if (state.actions.length >= MAX_ACTIONS) return false;
  if (!actionByKey(state.mode, key)) return false;
  return replay({ ...state, actions: state.actions + key }).refused === -1;
}

/**
 * next = step(state, action). Actions: { type: "do", key }, { type: "undo" }, { type: "reset" },
 * { type: "mode", mode }, { type: "trigger", trigger }, { type: "preset", id }.
 * Returns the same object when nothing changes.
 */
export function step(state, action) {
  switch (action?.type) {
    case "do":
      return canDo(state, action.key) ? { ...state, actions: state.actions + action.key } : state;
    case "undo":
      return state.actions ? { ...state, actions: state.actions.slice(0, -1) } : state;
    case "reset":
      return state.actions ? { ...state, actions: "" } : state;
    case "mode":
      if (action.mode === state.mode || (action.mode !== "cpu" && action.mode !== "gic")) return state;
      return initialState(action.mode, state.trigger);
    case "trigger":
      if (state.mode !== "gic" || (action.trigger !== "level" && action.trigger !== "edge") || action.trigger === state.trigger) return state;
      // Every GIC action is valid under both triggers, so the same steps replay as a what-if.
      return { ...state, trigger: action.trigger };
    case "preset": {
      const p = PRESETS.find((x) => x.id === action.id);
      if (!p) return state;
      return { mode: p.mode, trigger: p.trigger || "level", actions: p.actions };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Presets, each with what the real machine did (quotes are checked against course/captures).

export const PRESETS = [
  {
    id: "lesson", mode: "cpu", actions: "rwukc", title: "The lesson's table",
    goal: "Raise while masked, wait, unmask, return with the cause kept, then clear it.",
  },
  {
    id: "masked", mode: "cpu", actions: "rwwuc", title: "The timer fires while IRQs are masked",
    goal: "The level line waits as state until the CPU unmasks; nothing is lost.",
    real: {
      capture: "11-masked-irq.txt",
      quote: "interval 0 = 300 ms OUT OF RANGE",
      says: "The guest kept IRQs masked for 300 ms after a 100 ms alarm. The handler ran only when it unmasked, so the first interval read 300 ms.",
    },
  },
  {
    id: "storm", mode: "cpu", actions: "urkkkk", title: "Nobody lowers the level line",
    goal: "The level line stays high because nobody lowers it, so every return takes the interrupt again: a storm. In the real run the guest did silence its timer, but the VMM never dropped its line.",
    real: {
      capture: "11-no-kick.txt",
      quote: "exec 9.819 s",
      says: "With nothing to drop our line, the guest re-took the same timer interrupt for the rest of the run: 9.8 of 10 seconds in the guest, and not one interval printed.",
    },
  },
  {
    id: "merge", mode: "cpu", actions: "rruc", title: "Two events, one latch",
    goal: "Two pulses while masked: the latch remembers that something happened, not how often.",
  },
  {
    id: "one", mode: "gic", trigger: "level", actions: "ride", title: "One keystroke, done right",
    goal: "Byte arrives, IAR, the handler reads DR, EOI: one interrupt.",
    real: {
      capture: "12-irq-typed.txt",
      quote: "irq: 3 irqs intid=33 spurious=0",
      says: "Three keystrokes, three interrupts on INTID 33, no spurious reads.",
    },
  },
  {
    id: "never", mode: "gic", trigger: "level", actions: "rieieie", title: "The handler never drains the FIFO",
    goal: "The line stays high at every EOI, so INTID 33 is pending again at once.",
    real: {
      capture: "12-no-drain.txt",
      quote: "irq: 985326 irqs intid=33",
      says: "One keystroke, a handler that never read DR: 985,326 interrupts in the second the guest counted them.",
    },
  },
  {
    id: "early", mode: "gic", trigger: "level", actions: "rdi", title: "The line drops before the IAR",
    goal: "A level interrupt that is no longer asked for is no longer pending: the IAR returns 1023.",
  },
  {
    id: "edge", mode: "gic", trigger: "edge", actions: "rie", title: "An edge, line held high",
    goal: "The acknowledge clears the pending bit even though the line is still high.",
  },
  {
    id: "edge2", mode: "gic", trigger: "edge", actions: "ridrei", title: "A second edge while active",
    goal: "An edge that arrives during the handler is latched and delivered after the EOI.",
  },
];

// ---------------------------------------------------------------------------------------------
// The lessons' fallback tables, regenerated from the model.

const CPU_COLS = [29, 21, 21];
const GIC_COLS = [30, 7, 18];

function fmt(widths, cells) {
  return cells.map((c, i) => (i < widths.length ? String(c).padEnd(widths[i]) : String(c))).join("").trimEnd();
}

/** Chapter 11's table (the text block after `:::lab irq-lifecycle`). */
export function cpuFallbackText() {
  const { rows } = replay({ mode: "cpu", trigger: "level", actions: "rwukc" });
  const lines = [fmt(CPU_COLS, ["step", ...CPU_KINDS.map((k) => k.label)])];
  for (const r of rows) lines.push(fmt(CPU_COLS, [r.step, ...r.cells]));
  return lines.join("\n");
}

/** Chapter 12's table: one interrupt, a line never lowered, and an edge line. */
export function gicFallbackText() {
  const sections = [
    { title: null, trigger: "level", actions: "ride", skip: 0 },
    { title: "same, but the device never lowers the line", trigger: "level", actions: "rie", skip: 1 },
    { title: "an edge-triggered line", trigger: "edge", actions: "rie", skip: 0 },
  ];
  const lines = [fmt(GIC_COLS, ["step", "line", `state of INTID ${INTID}`])];
  for (const s of sections) {
    if (s.title) lines.push(`--- ${s.title} ---`);
    const { rows } = replay({ mode: "gic", trigger: s.trigger, actions: s.actions });
    for (const r of rows.slice(s.skip)) lines.push(fmt(GIC_COLS, [r.step, r.line, r.state, r.note]));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Readout and share state.

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** One plain-text sentence group summarising the current state, for the live region. */
export function summary(state) {
  const r = replay(state);
  const n = r.rows.length;
  const last = n ? r.rows[n - 1] : null;
  if (state.mode === "cpu") {
    const head = last ? `After "${last.step}": ` : "Start: the CPU has IRQs masked and every source is quiet. ";
    const parts = r.worlds.map((w, i) => {
      const k = CPU_KINDS[i].label;
      const where = w.inHandler ? "in the handler" : cpuPending(w) ? "pending" : "nothing pending";
      let s = `${k}: ${last ? last.cells[i] + ", " : ""}${where}, handler ran ${plural(w.runs, "time", "times")}`;
      if (w.lost) s += `, ${plural(w.lost, "event", "events")} lost`;
      if (w.merged) s += `, ${plural(w.merged, "event", "events")} merged into the latch`;
      return s;
    });
    return `${head}${parts.join(". ")}.`;
  }
  const g = r.gic;
  const head = last
    ? `After "${last.step}": INTID ${INTID} is ${gicStateName(g)}, line ${g.line ? "high" : "low"}.`
    : `Start: INTID ${INTID} (${g.trigger}-triggered) is inactive, line low.`;
  const sig = gicSignalling(g) ? " The GIC is signalling an IRQ to the CPU." : " No IRQ is being signalled to the CPU.";
  const note = last && last.note ? ` ${last.note[0].toUpperCase()}${last.note.slice(1)}.` : "";
  const counts = ` IAR returned ${INTID} ${plural(g.acks, "time", "times")}, ${SPURIOUS} ${plural(g.spurious, "time", "times")}.`;
  return `${head}${note}${sig}${counts}`;
}

/** Share state: `cpu[.<letters>]`, `gic-l[.<letters>]`, `gic-e[.<letters>]`. Default -> null. */
export function encode(state) {
  const head = state.mode === "cpu" ? "cpu" : state.trigger === "edge" ? "gic-e" : "gic-l";
  if (head === "cpu" && !state.actions) return null;
  return state.actions ? `${head}.${state.actions}` : head;
}

/** Strict parser: returns a state, or null for anything it does not fully accept. */
export function decode(str) {
  if (typeof str !== "string" || str.length > 6 + 1 + MAX_ACTIONS) return null;
  const m = /^(cpu|gic-l|gic-e)(?:\.([a-z]{1,64}))?$/.exec(str);
  if (!m) return null;
  const mode = m[1] === "cpu" ? "cpu" : "gic";
  const state = { mode, trigger: m[1] === "gic-e" ? "edge" : "level", actions: m[2] || "" };
  for (const ch of state.actions) if (!actionByKey(mode, ch)) return null;
  if (replay(state).refused !== -1) return null;
  return state;
}
