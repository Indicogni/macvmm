// litmus model: a two-thread litmus test on a machine with visible store buffers.
//
// Pure logic, no DOM (course/site/LABS.md section 3). The view renders `state` and turns clicks
// into `apply(program, machine, state, action)` calls.
//
// What is modelled, and why it is enough (the `memory-ordering` primer is the spec):
//
// - Each thread runs three program slots: a first access, an optional fence, a second access.
//   That is the shape of every test in the primer's `litmus.rs` and of the two virtqueue races
//   chapter 16 cares about.
// - A store does not reach shared memory when it runs. It goes into the thread's **store
//   buffer** and reaches memory later, in a separate "drain" step. A load reads the newest entry
//   for its address in its own store buffer, otherwise memory. Memory is single and coherent:
//   once a store has drained, every thread sees it. That is the "other-multi-copy atomic"
//   property the primer's Under the hood box names (ARM ARM DDI 0487, B2.3), and the reason a
//   per-thread buffer in front of one memory is a faithful picture of arm64 for these tests.
// - Three machines:
//   * `sc`, "interleaving only": instructions run in program order and stores go straight to
//     memory. This is the "try every interleaving on paper" model the primer opens with.
//   * `tso`, x86-64: instructions run in program order, stores wait in a first-in first-out
//     store buffer. Only store-then-load can appear reordered (the primer's table, TSO column).
//     `xchg` (a Rust SeqCst store) and `mfence` (a SeqCst fence) wait for an empty buffer.
//   * `arm`, arm64: a thread may run any slot whose ordering constraints are met (so loads and
//     stores can run out of program order), and its store buffer drains in any order. The
//     constraints are exactly the instruction promises the primer lists: LDAPR / LDAR (acquire)
//     hold back everything after them, STLR (release) waits for everything before it, LDAR
//     waits for an earlier STLR to reach memory, DMB ISH orders everything against everything,
//     DMB ISHLD orders earlier loads against everything later; accesses to one address stay in
//     order (coherence).
// - The language rules (Rust's memory model, and Linux's for the C driver side, which agree on
//   these shapes) are a separate verdict, `rulesVerdict`: a test can be forbidden by today's
//   hardware and still allowed by the rules, and only the rules make code correct.

// ---- orderings and machines ------------------------------------------------------------------

export const ORD_NAME = { r: "Relaxed", a: "Acquire", l: "Release", s: "SeqCst" };
export const STORE_ORDS = ["r", "l", "s"];
export const LOAD_ORDS = ["r", "a", "s"];
export const FENCE_KINDS = ["n", "s", "a", "l"];
export const FENCE_NAME = { n: "no fence", s: "fence(SeqCst)", a: "fence(Acquire)", l: "fence(Release)" };

export const MACHINES = {
  arm: { title: "arm64 (Apple Silicon)", short: "arm64" },
  tso: { title: "x86-64 (TSO)", short: "x86-64" },
  sc: { title: "Interleaving only (the paper model)", short: "interleaving" },
};
export const MACHINE_IDS = ["arm", "tso", "sc"];

// ---- the tests ---------------------------------------------------------------------------------
//
// Each thread: [first access, second access] and a fence slot between them. Orderings are not
// part of the test; they come from a preset or from the reader.

export const TESTS = {
  sb: {
    title: "sb: store buffering (the opening puzzle)",
    shape: "sb",
    vars: [{ id: "X", init: 0 }, { id: "Y", init: 0 }],
    threads: [
      { name: "Thread A", ops: [{ op: "st", v: "X", val: 1 }, { op: "ld", v: "Y", reg: "r1" }] },
      { name: "Thread B", ops: [{ op: "st", v: "Y", val: 1 }, { op: "ld", v: "X", reg: "r2" }] },
    ],
    regs: ["r1", "r2"],
    bad: (r) => r.r1 === 0 && r.r2 === 0,
    badText: "both threads read 0",
    program: true,
  },
  mp: {
    title: "mp: message passing (flag and data)",
    shape: "mp",
    vars: [{ id: "X", init: 0, role: "data" }, { id: "Y", init: 0, role: "flag" }],
    threads: [
      { name: "Thread A", ops: [{ op: "st", v: "X", val: 1 }, { op: "st", v: "Y", val: 1 }] },
      { name: "Thread B", ops: [{ op: "ld", v: "Y", reg: "flag" }, { op: "ld", v: "X", reg: "data" }] },
    ],
    regs: ["flag", "data"],
    bad: (r) => r.flag === 1 && r.data === 0,
    badText: "flag up, data missing",
    program: true,
  },
  lw: {
    title: "The lost wakeup (used.idx and avail.flags)",
    shape: "sb",
    vars: [{ id: "used.idx", init: 0 }, { id: "avail.flags", init: 1 }],
    threads: [
      { name: "macvmm worker (device)", ops: [{ op: "st", v: "used.idx", val: 1 }, { op: "ld", v: "avail.flags", reg: "flags" }] },
      { name: "Linux driver", ops: [{ op: "st", v: "avail.flags", val: 0 }, { op: "ld", v: "used.idx", reg: "used" }] },
    ],
    regs: ["flags", "used"],
    bad: (r) => r.flags === 1 && r.used === 0,
    badText: "the device sees NO_INTERRUPT still set and stays quiet, the driver sees no new used.idx and sleeps",
    program: false,
  },
  used: {
    title: "Publishing a completion (used element, then used.idx)",
    shape: "mp",
    vars: [{ id: "elem", init: 0, role: "data" }, { id: "used.idx", init: 0, role: "flag" }],
    threads: [
      { name: "macvmm worker (device)", ops: [{ op: "st", v: "elem", val: 1 }, { op: "st", v: "used.idx", val: 1 }] },
      { name: "Linux driver", ops: [{ op: "ld", v: "used.idx", reg: "idx" }, { op: "ld", v: "elem", reg: "elem" }] },
    ],
    regs: ["idx", "elem"],
    bad: (r) => r.idx === 1 && r.elem === 0,
    badText: "the driver sees the new used.idx but reads the old used element",
    program: false,
  },
};
export const TEST_IDS = ["sb", "mp", "lw", "used"];

// Presets. For `sb` and `mp` these are exactly the four modes of the primer's litmus.rs:
// `relaxed` => (Relaxed, Relaxed), `seqcst` => (SeqCst, SeqCst), anything else => (Release,
// Acquire), and `full_fence` only in `fence` mode. In `mp` the data accesses are always
// Relaxed and no fence is ever placed (thread_a and thread_b only look at full_fence in sb),
// so `mp fence` runs exactly the `mp acqrel` code.
export const PRESETS = {
  sb: [
    { id: "relaxed", label: "./litmus sb relaxed", ords: ["rnr", "rnr"] },
    { id: "acqrel", label: "./litmus sb acqrel", ords: ["lna", "lna"] },
    { id: "seqcst", label: "./litmus sb seqcst", ords: ["sns", "sns"] },
    { id: "fence", label: "./litmus sb fence", ords: ["lsa", "lsa"] },
  ],
  mp: [
    { id: "relaxed", label: "./litmus mp relaxed", ords: ["rnr", "rnr"] },
    { id: "acqrel", label: "./litmus mp acqrel", ords: ["rnl", "anr"] },
    { id: "seqcst", label: "./litmus mp seqcst", ords: ["rns", "snr"] },
    { id: "fence", label: "./litmus mp fence (same code as acqrel)", ords: ["rnl", "anr"] },
  ],
  lw: [
    { id: "macvmm", label: "macvmm and Linux, as shipped", ords: ["lsr", "rsr"] },
    { id: "nofence", label: "macvmm without its fence", ords: ["lnr", "rsr"] },
    { id: "acquire", label: "an acquire load instead of the fence", ords: ["lna", "rsr"] },
    { id: "seqcst", label: "SeqCst store and load instead of the fence", ords: ["sns", "rsr"] },
  ],
  used: [
    { id: "macvmm", label: "macvmm and Linux, as shipped", ords: ["rnl", "rar"] },
    { id: "norelease", label: "chapter 16's breakage: release dropped", ords: ["rnr", "rar"] },
    { id: "normb", label: "a driver without virtio_rmb()", ords: ["rnl", "rnr"] },
  ],
};

// What the primer measured on the Apple M5 Pro it was written on (2,000,000 rounds per run).
// The model test re-reads course/primers/memory-ordering.md so these cannot drift. A mode the
// primer does not quote is absent: the lab never invents a measurement.
export const MEASURED = {
  "sb.relaxed": { hits: 1031681, of: 2000000, note: "One run. On another day the runs gave about 1.39 million each time." },
  "sb.acqrel": { hits: 0, of: 2000000, note: "Every run the primer tried." },
  "sb.seqcst": { hits: 0, of: 2000000, note: "" },
  "sb.fence": { hits: 0, of: 2000000, note: "" },
  "mp.relaxed": { hits: 0, of: 2000000, note: "Seen 0 times in each of 20 runs of 2,000,000 rounds. An earlier version of the harness caught it 4 times in 26 million rounds." },
  "mp.acqrel": { hits: 0, of: 2000000, note: "" },
};

// ---- programs ---------------------------------------------------------------------------------

const ORDS_RE = /^[rlas][nsal][rlas]$/;

/** Is `ords` (three letters: first access, fence, second access) valid for this thread? */
export function validOrds(test, t, ords) {
  if (typeof ords !== "string" || !ORDS_RE.test(ords)) return false;
  const ops = TESTS[test].threads[t].ops;
  const ok = (op, c) => (op.op === "st" ? STORE_ORDS : LOAD_ORDS).includes(c);
  return ok(ops[0], ords[0]) && FENCE_KINDS.includes(ords[1]) && ok(ops[1], ords[2]);
}

/**
 * Build the program: per thread, three slots k = 0 (first access), 1 (fence, `null` if none),
 * 2 (second access). Throws on an unknown test or invalid orderings.
 */
export function buildProgram(test, ords) {
  const def = TESTS[test];
  if (!def || !Object.hasOwn(TESTS, test)) throw new Error(`unknown test ${String(test)}`);
  if (!Array.isArray(ords) || ords.length !== 2) throw new Error("need orderings for two threads");
  const threads = def.threads.map((th, t) => {
    if (!validOrds(test, t, ords[t])) throw new Error(`invalid orderings ${String(ords[t])} for ${th.name}`);
    const o = ords[t];
    const slots = [
      { k: 0, ...th.ops[0], ord: o[0] },
      o[1] === "n" ? null : { k: 1, op: "fence", kind: o[1] },
      { k: 2, ...th.ops[1], ord: o[2] },
    ];
    return { name: th.name, slots };
  });
  return { test, ords: [...ords], def, threads };
}

/** The Rust (or Rust-notation) line for a slot. */
export function rustText(slot) {
  if (slot.op === "st") return `${slot.v}.store(${slot.val}, ${ORD_NAME[slot.ord]})`;
  if (slot.op === "ld") return `let ${slot.reg} = ${slot.v}.load(${ORD_NAME[slot.ord]})`;
  return FENCE_NAME[slot.kind];
}

/** The instruction the slot becomes on a machine (32-bit atomics, as in litmus.rs). */
export function asmText(machine, slot) {
  if (machine === "sc") return "(any; the paper model has no instructions)";
  if (machine === "arm") {
    if (slot.op === "st") return slot.ord === "r" ? "str" : "stlr";
    if (slot.op === "ld") return { r: "ldr", a: "ldapr", s: "ldar" }[slot.ord];
    return slot.kind === "a" ? "dmb ishld" : "dmb ish";
  }
  if (slot.op === "st") return slot.ord === "s" ? "xchg" : "mov (store)";
  if (slot.op === "ld") return "mov (load)";
  return slot.kind === "s" ? "mfence" : "(no instruction: only stops the compiler)";
}

// ---- state ------------------------------------------------------------------------------------

/** Initial state: every slot pending (an absent fence counts as done), empty buffers. */
export function initialState(program) {
  const mem = {};
  for (const v of program.def.vars) mem[v.id] = v.init;
  return {
    status: program.threads.map((th) => th.slots.map((s) => (s ? "pending" : "done"))),
    buffers: [[], []],
    mem,
    regs: {},
    log: [],
  };
}

function clone(st) {
  return {
    status: st.status.map((a) => [...a]),
    buffers: st.buffers.map((b) => b.map((e) => ({ ...e }))),
    mem: { ...st.mem },
    regs: { ...st.regs },
    log: [...st.log],
  };
}

const isRelease = (s) => s && s.op === "st" && (s.ord === "l" || s.ord === "s");
const isAcquire = (s) => s && s.op === "ld" && (s.ord === "a" || s.ord === "s");
const isAccess = (s) => s && (s.op === "st" || s.op === "ld");

/**
 * arm64: must slot j (earlier in program order) be complete before slot i may run? Returns the
 * reason in words, or null. "Complete" means: a load has read its value, a store has reached
 * memory, a fence has run.
 */
export function armOrderedBefore(j, i) {
  if (!j || !i) return null;
  if (isAccess(j) && isAccess(i) && j.v === i.v) return "both touch the same address, and one address is never seen out of order";
  if (isAcquire(j)) return `${j.ord === "s" ? "ldar" : "ldapr"} (an acquire load) holds back everything after it`;
  if (isRelease(i)) return "stlr (a release store) waits until every earlier access is done";
  if (isRelease(j) && i.op === "ld" && i.ord === "s") return "ldar never runs before an earlier stlr has reached memory";
  if (j.op === "fence" && j.kind !== "a") return "dmb ish holds back everything after it";
  if (j.op === "fence" && j.kind === "a") return "dmb ishld holds back everything after it";
  if (i.op === "fence" && i.kind !== "a") return "dmb ish waits until every earlier access is done";
  if (i.op === "fence" && i.kind === "a" && j.op === "ld") return "dmb ishld waits until every earlier load is done";
  return null;
}

const isFullX86 = (s) => s && ((s.op === "st" && s.ord === "s") || (s.op === "fence" && s.kind === "s"));

/**
 * Why can slot k of thread t not run now? Returns a list of reasons (empty if it can run, or
 * if it is not pending).
 */
export function blockers(program, machine, st, t, k) {
  const slots = program.threads[t].slots;
  const slot = slots[k];
  if (!slot || st.status[t][k] !== "pending") return [];
  const out = [];
  if (machine === "arm") {
    for (let j = 0; j < k; j++) {
      const why = armOrderedBefore(slots[j], slot);
      if (why && st.status[t][j] !== "done") out.push({ j, why });
    }
    return out;
  }
  for (let j = 0; j < k; j++) {
    if (st.status[t][j] === "pending") out.push({ j, why: "this machine runs each thread's instructions in program order" });
  }
  if (machine === "tso" && isFullX86(slot) && st.buffers[t].length > 0) {
    out.push({ j: st.buffers[t][0].k, why: `${slot.op === "st" ? "xchg" : "mfence"} waits until the store buffer is empty` });
  }
  return out;
}

/** Every action allowed now: `{code, t, k, kind}` with kind `run` or `drain`. */
export function enabledActions(program, machine, st) {
  const acts = [];
  for (let t = 0; t < 2; t++) {
    for (let k = 0; k < 3; k++) {
      if (st.status[t][k] === "pending" && blockers(program, machine, st, t, k).length === 0) {
        acts.push({ code: "ab"[t] + k, t, k, kind: "run" });
      }
    }
    const buf = st.buffers[t];
    buf.forEach((e, idx) => {
      if (machine === "tso" && idx > 0) return; // first in, first out
      if (machine === "arm" && buf.slice(0, idx).some((o) => o.v === e.v)) return; // coherence
      acts.push({ code: "AB"[t] + e.k, t, k: e.k, kind: "drain" });
    });
  }
  return acts;
}

/** Apply one action code (`a0`, `b2`, `A0`, ...). Returns `{ok, state, error}`. */
export function apply(program, machine, st, code) {
  const act = enabledActions(program, machine, st).find((a) => a.code === code);
  if (!act) return { ok: false, state: st, error: `step ${String(code)} is not allowed now` };
  const next = clone(st);
  const { t, k } = act;
  const slot = program.threads[t].slots[k];
  if (act.kind === "drain") {
    const idx = next.buffers[t].findIndex((e) => e.k === k);
    const [e] = next.buffers[t].splice(idx, 1);
    next.mem[e.v] = e.val;
    next.status[t][k] = "done";
  } else if (slot.op === "ld") {
    const own = next.buffers[t].filter((e) => e.v === slot.v);
    next.regs[slot.reg] = own.length ? own[own.length - 1].val : next.mem[slot.v];
    next.status[t][k] = "done";
  } else if (slot.op === "st") {
    const direct = machine === "sc" || (machine === "tso" && slot.ord === "s");
    if (direct) {
      next.mem[slot.v] = slot.val;
      next.status[t][k] = "done";
    } else {
      next.buffers[t].push({ k, v: slot.v, val: slot.val });
      next.status[t][k] = "buffered";
    }
  } else {
    next.status[t][k] = "done";
  }
  next.log.push(code);
  return { ok: true, state: next, error: null };
}

export function isFinal(st) {
  return st.status.every((a) => a.every((s) => s === "done"));
}

/** Words for one action, for buttons, the log and the screen reader. */
export function describeAction(program, machine, st, code) {
  const t = "ab".indexOf(code[0].toLowerCase());
  const k = Number(code[1]);
  const th = program.threads[t];
  const slot = th.slots[k];
  if (!slot) return code;
  if (code[0] === code[0].toUpperCase()) return `${th.name}'s store buffer: ${slot.v} = ${slot.val} reaches memory`;
  if (slot.op === "st") {
    const direct = machine === "sc" || (machine === "tso" && slot.ord === "s");
    return `${th.name}: ${rustText(slot)}${direct ? `, ${slot.v} = ${slot.val} written to memory` : `, ${slot.v} = ${slot.val} waits in the store buffer`}`;
  }
  if (slot.op === "ld") {
    const own = st.buffers[t].filter((e) => e.v === slot.v);
    const val = own.length ? own[own.length - 1].val : st.mem[slot.v];
    return `${th.name}: ${rustText(slot)}, reads ${val} from ${own.length ? "its own store buffer" : "memory"}`;
  }
  return `${th.name}: ${rustText(slot)}`;
}

/** Replay a schedule, stopping at the first action that is not allowed. */
export function replay(program, machine, codes) {
  let st = initialState(program);
  const applied = [];
  for (const c of codes) {
    const r = apply(program, machine, st, c);
    if (!r.ok) return { state: st, applied, stoppedAt: c };
    st = r.state;
    applied.push(c);
  }
  return { state: st, applied, stoppedAt: null };
}

// ---- outcomes ---------------------------------------------------------------------------------

export function outcomeKey(program, regs) {
  return program.def.regs.map((r) => `${r}=${regs[r]}`).join(" ");
}

function stateKey(st) {
  return JSON.stringify([st.status, st.buffers, st.mem, st.regs]);
}

/**
 * Every outcome this machine allows, by breadth-first search over every reachable state. Each
 * outcome carries the shortest schedule that reaches it. The state space is tiny (at most a few
 * hundred states), so this is exact, not sampled.
 */
export function explore(program, machine) {
  const start = initialState(program);
  const seen = new Map([[stateKey(start), start]]);
  const queue = [start];
  const outcomes = new Map();
  while (queue.length) {
    const st = queue.shift();
    if (isFinal(st)) {
      const key = outcomeKey(program, st.regs);
      if (!outcomes.has(key)) {
        outcomes.set(key, { key, regs: { ...st.regs }, bad: program.def.bad(st.regs), witness: [...st.log] });
      }
      continue;
    }
    for (const a of enabledActions(program, machine, st)) {
      const next = apply(program, machine, st, a.code).state;
      const key = stateKey(next);
      if (seen.has(key)) continue;
      if (seen.size > 10000) throw new Error("state space too large");
      seen.set(key, next);
      queue.push(next);
    }
  }
  const list = [...outcomes.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return { outcomes: list, states: seen.size, badAllowed: list.some((o) => o.bad) };
}

/** Plain words for an outcome (register names only: no reference to litmus.rs's functions). */
export function outcomeText(program, regs) {
  return program.def.regs.map((r) => `${r} = ${regs[r]}`).join(", ");
}

// ---- the rules --------------------------------------------------------------------------------

/**
 * What the language rules say about the bad outcome: Rust's model (C++20's), and Linux's for
 * the driver side, which agree for these two shapes.
 *
 * - sb shape (each thread stores its own variable, then loads the other's): forbidden only if
 *   *both* threads order their store before their load, either with a SeqCst fence between
 *   them or with SeqCst on both the store and the load. Release and acquire never order a
 *   store before a later load.
 * - mp shape: forbidden only if the writer releases (a Release or SeqCst flag store, or a
 *   Release or SeqCst fence between its two stores) *and* the reader acquires (an Acquire or
 *   SeqCst flag load, or an Acquire or SeqCst fence between its two loads). Each half is useless
 *   alone.
 */
export function rulesVerdict(program) {
  const [a, b] = program.ords;
  if (program.def.shape === "sb") {
    const ordered = (o) => o[1] === "s" || (o[0] === "s" && o[2] === "s");
    const why = (o, name) => (o[1] === "s" ? `${name} has a SeqCst fence` : o[0] === "s" && o[2] === "s" ? `${name}'s store and load are both SeqCst` : `${name} does not order its store before its load`);
    const forbidden = ordered(a) && ordered(b);
    return { forbidden, why: `${why(a, program.threads[0].name)}; ${why(b, program.threads[1].name)}.` };
  }
  const releases = a[2] === "l" || a[2] === "s" || a[1] === "l" || a[1] === "s";
  const acquires = b[0] === "a" || b[0] === "s" || b[1] === "a" || b[1] === "s";
  const w = program.threads[0].name, r = program.threads[1].name;
  return {
    forbidden: releases && acquires,
    why: `${w} ${releases ? "releases (its flag store cannot overtake the data)" : "does not release (its two stores may become visible in either order)"}; ${r} ${acquires ? "acquires (its data load waits for the flag load)" : "does not acquire (its two loads may run in either order)"}.`,
  };
}

/** Which presets this exact program is (several, for `mp acqrel` and `mp fence`). */
export function presetsOf(program) {
  return (PRESETS[program.test] || []).filter((p) => p.ords[0] === program.ords[0] && p.ords[1] === program.ords[1]);
}

/** The measurements the primer quotes for this program, if any. */
export function measurementsOf(program) {
  if (!program.def.program) return [];
  return presetsOf(program)
    .map((p) => ({ preset: p, m: MEASURED[`${program.test}.${p.id}`] || null }));
}

/**
 * The summary verdict: does the chosen machine allow the bad outcome, do the rules, and what
 * the primer measured. `kind` is one of `allowed`, `forbidden`, `hardware-only` (this machine
 * forbids, the rules allow). What `hardware-only` means depends on the machine: on arm64 or
 * x86-64 the code is correct only by accident of that hardware and its instructions; on the
 * paper model (`sc`) it means the paper model is too strong, not that the code is safe, so
 * `real` carries the two real machines' answers for the view to show next to it.
 * `crossLanguage` marks the virtqueue tests, where one thread is the Linux C driver: Rust's
 * model has no rule for it, so the pairing is argued in Arm terms (the primer's "The guest is
 * the other thread").
 */
export function verdict(program, machine) {
  const ex = explore(program, machine);
  const rules = rulesVerdict(program);
  let kind;
  if (rules.forbidden) kind = "forbidden";
  else if (ex.badAllowed) kind = "allowed";
  else kind = "hardware-only";
  const real = {
    arm: machine === "arm" ? ex.badAllowed : explore(program, "arm").badAllowed,
    tso: machine === "tso" ? ex.badAllowed : explore(program, "tso").badAllowed,
  };
  return { machineAllows: ex.badAllowed, rules, kind, explored: ex, real, crossLanguage: !program.def.program };
}

/**
 * The primer's exercise table: the eight litmus.rs combinations with what was measured, what
 * arm64 allows and what the rules say. `fools` marks a zero that would fool a test suite.
 */
export function exerciseTable() {
  const rows = [];
  for (const test of ["sb", "mp"]) {
    for (const p of PRESETS[test]) {
      const prog = buildProgram(test, p.ords);
      const arm = explore(prog, "arm").badAllowed;
      const rules = rulesVerdict(prog);
      const m = MEASURED[`${test}.${p.id}`] || null;
      rows.push({
        test, mode: p.id, measured: m, armAllows: arm, rulesAllow: !rules.forbidden,
        fools: Boolean(m && m.hits === 0 && !rules.forbidden),
      });
    }
  }
  return rows;
}

// ---- share state ------------------------------------------------------------------------------
//
// `<test>.<machine>.<ords A>.<ords B>[.<schedule>]`, the schedule being two-character actions
// run back to back: `a0` / `b2` run thread A's / B's slot, `A0` / `B2` drain that store from
// the store buffer. The default (sb, arm64, relaxed, no steps) is `null`, which clears the hash.

export const DEFAULT = { test: "sb", machine: "arm", ords: ["rnr", "rnr"], schedule: [] };
const SHARE_RE = /^(sb|mp|lw|used)\.(arm|tso|sc)\.([a-z]{3})\.([a-z]{3})(?:\.((?:[abAB][0-2]){0,10}))?$/;

export function encodeShare({ test, machine, ords, schedule }) {
  const isDefault = test === DEFAULT.test && machine === DEFAULT.machine && ords[0] === DEFAULT.ords[0] &&
    ords[1] === DEFAULT.ords[1] && schedule.length === 0;
  if (isDefault) return null;
  return `${test}.${machine}.${ords[0]}.${ords[1]}${schedule.length ? `.${schedule.join("")}` : ""}`;
}

/**
 * Parse a share string. Hostile input returns null (the view then starts from the default).
 * The schedule is replayed and cut at the first step that is not allowed.
 */
export function decodeShare(str) {
  if (typeof str !== "string" || str.length > 64) return null;
  const m = SHARE_RE.exec(str);
  if (!m) return null;
  const [, test, machine, oa, ob, sched = ""] = m;
  if (!validOrds(test, 0, oa) || !validOrds(test, 1, ob)) return null;
  const codes = sched.match(/../g) || [];
  const program = buildProgram(test, [oa, ob]);
  const { applied } = replay(program, machine, codes);
  return { test, machine, ords: [oa, ob], schedule: applied };
}
