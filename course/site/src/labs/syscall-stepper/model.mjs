// syscall-stepper model: a tiny AArch64-flavoured machine that single-steps an app in user mode
// (EL0) into the kernel (EL1) and back.
//
// Why this exists: the os-basics primer describes a system call as four hardware steps (switch
// mode, save the way back, jump through the exception vector table, return with `eret`). This
// model makes those steps observable one instruction at a time, and contrasts them with a page
// fault, where the saved return address points AT the faulting instruction ("a call continues; a
// fault retries").
//
// What is real (ARM ARM DDI 0487, section D1.3 "Exceptions" and D17.2 register descriptions):
//   - exception entry saves the return address (ELR_EL1), the old PSTATE (SPSR_EL1) and the
//     syndrome (ESR_EL1), masks interrupts (PSTATE.DAIF), switches to EL1 and jumps to
//     VBAR_EL1 + 0x400 for a synchronous exception from a lower EL using AArch64;
//   - `svc #imm` returns to the next instruction; a data abort returns to the faulting one;
//   - the ESR values are the exact ones the architecture writes (EC 0x15 for SVC, EC 0x24 for a
//     data abort from a lower EL), cross-checked in model.test.mjs against the course's ESR vectors.
// What is a toy (listed to the learner in the view, too): small flat addresses, a kernel that
// skips saving the app's registers and knows one service, `bl` to kernel helpers stepped over in
// one step, and a page-table walk reduced to "is this 4 KiB page mapped" (a Mac uses 16 KiB pages,
// so a real null store faults at a higher table level and its DFSC differs). The kernel sits at
// EL1, the textbook Arm picture that Linux uses; on a Mac part of the macOS kernel runs at EL2
// (chapter 01), which the view says too.
//
// Pure module: no DOM, no I/O. State is a plain object; `step(state)` returns a new one.

export const PAGE_SIZE = 0x1000;
export const VBAR = 0x8000; // the vector table base the kernel wrote at boot (VBAR_EL1)
export const MAX_STEPS = 64; // hard cap on any run; the programs below need far fewer

/** Vector table offsets (ARM ARM D1.3.1, table "Vector offsets from vector table base address"). */
export const VECTOR_OFFSETS = Object.freeze({
  syncCurrentSpx: 0x200,
  irqCurrentSpx: 0x280,
  syncLower64: 0x400,
  irqLower64: 0x480,
});

export const EC_SVC64 = 0x15;
export const EC_DABT_LOWER = 0x24;

/** ESR for `svc #imm` executed in AArch64 (EC 0x15, IL=1, ISS = imm16). */
export function encodeSvcEsr(imm) {
  if (!Number.isInteger(imm) || imm < 0 || imm > 0xffff) throw new RangeError("svc imm16 out of range");
  return ((EC_SVC64 << 26) | (1 << 25) | imm) >>> 0;
}

/**
 * ESR for a data abort from a lower EL (EC 0x24, IL=1). Fields follow ARM ARM D17.2.40 ISS
 * encoding for a Data Abort: ISV[24] SAS[23:22] SSE[21] SRT[20:16] SF[15] AR[14] FnV[10] S1PTW[7]
 * WnR[6] DFSC[5:0].
 */
export function encodeDataAbortEsr(f) {
  const bit = (b, n) => (b ? 1 << n : 0);
  const field = (v, max, name) => {
    if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${name} out of range`);
    return v;
  };
  let iss = bit(f.isv, 24);
  if (f.isv) {
    iss |= (field(f.sas, 3, "sas") << 22) | bit(f.sse, 21) | (field(f.srt, 31, "srt") << 16) | bit(f.sf, 15) | bit(f.ar, 14);
  } else {
    // With ISV=0 the SAS..AR bits are UNKNOWN; an encoder may carry them through unchanged, but
    // still range-checked so a bad value cannot spill into ISV or a neighbouring field.
    iss |= (field(f.sas ?? 0, 3, "sas") << 22) | bit(f.sse, 21) | (field(f.srt ?? 0, 31, "srt") << 16) | bit(f.sf, 15) | bit(f.ar, 14);
  }
  iss |= bit(f.fnv, 10) | bit(f.s1ptw, 7) | bit(f.wnr, 6) | field(f.dfsc, 0x3f, "dfsc");
  return ((EC_DABT_LOWER << 26) | (1 << 25) | iss) >>> 0;
}

/** The fault this toy raises: a write from EL0, no translation at level 3, ISV=0 (stage 1). */
export const PAGE_FAULT_ESR = encodeDataAbortEsr({ isv: false, wnr: true, dfsc: 0x07 });

/** Plain-words reason for an ESR value, used by the state panel. */
export function describeReason(esr) {
  if (esr === null || esr === undefined) return "(none yet)";
  const ec = esr >>> 26;
  if (ec === EC_SVC64) return `system call: svc #${hex(esr & 0xffff)} from user mode`;
  if (ec === EC_DABT_LOWER) {
    const write = (esr >>> 6) & 1 ? "write" : "read";
    const dfsc = esr & 0x3f;
    const what = dfsc >= 4 && dfsc <= 7 ? "no page-table entry" : `fault status ${hex(dfsc)}`;
    return `page fault (data abort) from user mode: ${write}, ${what}`;
  }
  return `exception class ${hex(ec)}`;
}

/** SPSR value for a PSTATE (ARM ARM C5.2.18): N Z C V [31:28], D A I F [9:6], M[3:0]. */
export function encodeSpsr({ el, nzcv = 0, daif = 0 }) {
  const m = el === 0 ? 0b0000 : 0b0101; // EL0t or EL1h
  return (((nzcv & 0xf) << 28) | ((daif & 0xf) << 6) | m) >>> 0;
}

export function hex(n, width = 0) {
  return "0x" + (n >>> 0).toString(16).padStart(width, "0");
}

export const MODE_NAMES = Object.freeze(["user mode (EL0)", "kernel mode (EL1)"]);

// ---------------------------------------------------------------------------------------------
// Programs. Each instruction: { addr, op, ...operands, text, note }.
// `text` is real AArch64 assembly; `note` is the comment shown beside it.

const KERNEL = [
  { addr: VBAR + VECTOR_OFFSETS.syncLower64, op: "b", target: 0x9000, text: "b    sync_from_user", note: "vector slot: synchronous, from user mode" },
  { addr: 0x9000, op: "mrs", rd: "x9", sys: "esr", text: "mrs  x9, esr_el1", note: "read the reason" },
  { addr: 0x9004, op: "lsr", rd: "x10", rn: "x9", sh: 26, text: "lsr  x10, x9, #26", note: "keep only its kind (the top 6 bits)" },
  { addr: 0x9008, op: "cmpi", rn: "x10", imm: EC_SVC64, text: "cmp  x10, #0x15", note: "0x15 means svc" },
  { addr: 0x900c, op: "bne", target: 0x9100, text: "b.ne fault", note: "not a system call? go to the fault code" },
  { addr: 0x9010, op: "cmpi", rn: "x16", imm: 20, text: "cmp  x16, #20", note: "read the request: which service did the app ask for?" },
  { addr: 0x9014, op: "bne", target: 0x9300, text: "b.ne unknown", note: "not 20 (getpid)? this kernel knows no other" },
  { addr: 0x9018, op: "movi", rd: "x0", imm: 42, text: "mov  x0, #42", note: "getpid: put the answer (process id 42) in x0" },
  { addr: 0x901c, op: "eret", text: "eret", note: "back to the saved address, in the saved mode" },
  { addr: 0x9100, op: "mrs", rd: "x11", sys: "far", text: "mrs  x11, far_el1", note: "fault: which address was touched?" },
  { addr: 0x9104, op: "call", fn: "map_page", text: "bl   map_page", note: "promised page? map it, x12 = 1; else x12 = 0" },
  { addr: 0x9108, op: "cbz", rn: "x12", target: 0x9200, text: "cbz  x12, kill", note: "nothing belongs there: kill the process" },
  { addr: 0x910c, op: "eret", text: "eret", note: "retry the faulting instruction" },
  { addr: 0x9200, op: "call", fn: "kill_process", text: "bl   kill_process", note: "signal 11 (SIGSEGV); never returns" },
  { addr: 0x9300, op: "movi", rd: "x0", imm: 78, text: "mov  x0, #78", note: "unknown service: answer error 78 (ENOSYS)" },
  { addr: 0x9304, op: "eret", text: "eret", note: "back to the app with the error" },
];

export const SCENARIOS = Object.freeze({
  svc: {
    title: "System call (svc)",
    summary: "The app asks the kernel for its process id with svc, the kernel answers in x0, and eret returns to the instruction after the svc.",
    app: [
      { addr: 0x1000, op: "movi", rd: "x16", imm: 20, text: "mov  x16, #20", note: "which service: 20 is getpid on macOS" },
      { addr: 0x1004, op: "svc", imm: 0x80, text: "svc  #0x80", note: "knock on the kernel's door" },
      { addr: 0x1008, op: "movr", rd: "x1", rn: "x0", text: "mov  x1, x0", note: "use the answer" },
      { addr: 0x100c, op: "spin", text: "b    .", note: "done: loop here" },
    ],
    promised: [],
  },
  fault: {
    title: "Page fault, repaired",
    summary: "The app stores to a page the kernel promised but never mapped (lazy allocation). The kernel maps it and returns to the store itself, which runs again and succeeds.",
    app: [
      { addr: 0x1000, op: "movi", rd: "x1", imm: 42, text: "mov  x1, #42", note: "the value to store" },
      { addr: 0x1004, op: "movi", rd: "x2", imm: 0x5000, text: "mov  x2, #0x5000", note: "a page the kernel promised but never mapped" },
      { addr: 0x1008, op: "str", rt: "x1", rn: "x2", text: "str  x1, [x2]", note: "first touch of that page" },
      { addr: 0x100c, op: "spin", text: "b    .", note: "done: loop here" },
    ],
    promised: [0x5],
  },
  null: {
    title: "Page fault, fatal (null store)",
    summary: "The app stores to address 0, which is never mapped. The kernel finds nothing to repair, so it ends the process with signal 11; the shell prints status 139.",
    app: [
      { addr: 0x1000, op: "movi", rd: "x1", imm: 42, text: "mov  x1, #42", note: "the value to store" },
      { addr: 0x1004, op: "movi", rd: "x2", imm: 0, text: "mov  x2, #0", note: "a null pointer" },
      { addr: 0x1008, op: "str", rt: "x1", rn: "x2", text: "str  x1, [x2]", note: "*p = 42, as in null.c" },
      { addr: 0x100c, op: "spin", text: "b    .", note: "never reached" },
    ],
    promised: [],
  },
});

export const SCENARIO_IDS = Object.freeze(Object.keys(SCENARIOS));
export const KERNEL_CODE = Object.freeze(KERNEL.map((i) => Object.freeze({ ...i })));

/** Code pages the toy maps for the app (its own code page). Kernel memory is always mapped at EL1. */
const APP_CODE_PAGES = [0x1];

const REGS = ["x0", "x1", "x2", "x9", "x10", "x11", "x12", "x16"];

export function initialState(scenarioId) {
  if (!SCENARIO_IDS.includes(scenarioId)) throw new RangeError(`unknown scenario: ${String(scenarioId)}`);
  const sc = SCENARIOS[scenarioId];
  const regs = {};
  for (const r of REGS) regs[r] = 0;
  return {
    scenario: scenarioId,
    steps: 0,
    el: 0,
    pc: sc.app[0].addr,
    regs,
    nzcv: 0,
    daif: 0, // interrupts allowed in the app
    elr: null, // saved return address (ELR_EL1)
    spsr: null, // saved mode and flags (SPSR_EL1)
    esr: null, // reason (ESR_EL1)
    far: null, // fault address (FAR_EL1)
    mapped: [...APP_CODE_PAGES],
    promised: [...sc.promised],
    mem: {}, // address (hex string) -> value, only for stores that completed
    halted: null, // null | { kind: "spin" | "killed", text, exitStatus? }
    last: null, // what the previous step did: { who, kind, addr, text, detail }
  };
}

/** Find the instruction at `pc` for this state (app code at EL0, any code at EL1). */
export function fetchInstruction(state) {
  const sc = SCENARIOS[state.scenario];
  const inApp = sc.app.find((i) => i.addr === state.pc);
  if (inApp) return inApp;
  if (state.el === 1) return KERNEL_CODE.find((i) => i.addr === state.pc) ?? null;
  return null;
}

function regGet(s, r) {
  if (!(r in s.regs)) throw new Error(`toy has no register ${r}`);
  return s.regs[r];
}

function clone(s) {
  return { ...s, regs: { ...s.regs }, mapped: [...s.mapped], promised: [...s.promised], mem: { ...s.mem } };
}

/** NZCV for `cmp rn, #imm` on 64-bit values (SUBS discarding the result). */
function cmpFlags(a, b) {
  const A = BigInt.asUintN(64, BigInt(a));
  const B = BigInt.asUintN(64, BigInt(b));
  const r = BigInt.asUintN(64, A - B);
  const n = (r >> 63n) & 1n;
  const z = r === 0n ? 1n : 0n;
  const c = A >= B ? 1n : 0n;
  const sa = (A >> 63n) & 1n, sb = (B >> 63n) & 1n, sr = n;
  const v = sa !== sb && sr !== sa ? 1n : 0n;
  return Number((n << 3n) | (z << 2n) | (c << 1n) | v);
}

/** Exception entry, done by the hardware in one step (ARM ARM D1.3.4, "Taking an exception"). */
function takeException(s, { esr, ret, far = null }) {
  s.spsr = encodeSpsr({ el: s.el, nzcv: s.nzcv, daif: s.daif });
  s.elr = ret;
  s.esr = esr;
  if (far !== null) s.far = far;
  const offset = s.el === 0 ? VECTOR_OFFSETS.syncLower64 : VECTOR_OFFSETS.syncCurrentSpx;
  s.el = 1;
  s.daif = 0xf;
  s.pc = VBAR + offset;
  return offset;
}

/**
 * Execute one instruction. Returns a NEW state; never mutates its argument. A halted state is
 * returned unchanged. Throws only on a programming error in the fixed programs above.
 */
export function step(state) {
  if (state.halted) return state;
  if (state.steps >= MAX_STEPS) {
    return { ...state, halted: { kind: "limit", text: `stopped after ${MAX_STEPS} steps` } };
  }
  const ins = fetchInstruction(state);
  if (!ins) throw new Error(`no instruction at ${hex(state.pc)} in ${MODE_NAMES[state.el]}`);
  const s = clone(state);
  s.steps += 1;
  const who = state.el === 0 ? "app" : "kernel";
  const last = { who, kind: "exec", addr: ins.addr, text: ins.text, detail: "" };
  const next = () => { s.pc = ins.addr + 4; };

  switch (ins.op) {
    case "movi":
      s.regs[ins.rd] = ins.imm;
      last.detail = `${ins.rd} = ${hex(ins.imm)}`;
      next();
      break;
    case "movr":
      s.regs[ins.rd] = regGet(s, ins.rn);
      last.detail = `${ins.rd} = ${hex(s.regs[ins.rd])}`;
      next();
      break;
    case "lsr":
      s.regs[ins.rd] = regGet(s, ins.rn) >>> ins.sh;
      last.detail = `${ins.rd} = ${hex(s.regs[ins.rd])}`;
      next();
      break;
    case "cmpi":
      s.nzcv = cmpFlags(regGet(s, ins.rn), ins.imm);
      last.detail = (s.nzcv & 0b0100) ? "equal" : "not equal";
      next();
      break;
    case "b":
      s.pc = ins.target;
      last.detail = `jump to ${hex(ins.target)}`;
      break;
    case "bne": {
      const taken = (s.nzcv & 0b0100) === 0;
      s.pc = taken ? ins.target : ins.addr + 4;
      last.detail = taken ? `taken: jump to ${hex(ins.target)}` : "not taken";
      break;
    }
    case "cbz": {
      const taken = regGet(s, ins.rn) === 0;
      s.pc = taken ? ins.target : ins.addr + 4;
      last.detail = taken ? `taken: jump to ${hex(ins.target)}` : "not taken";
      break;
    }
    case "mrs": {
      if (state.el === 0) throw new Error("mrs of an EL1 register at EL0");
      const v = ins.sys === "esr" ? s.esr : ins.sys === "far" ? s.far : null;
      if (v === null) throw new Error(`mrs ${ins.sys} with no value`);
      s.regs[ins.rd] = v;
      last.detail = `${ins.rd} = ${hex(v)}`;
      next();
      break;
    }
    case "svc": {
      const offset = takeException(s, { esr: encodeSvcEsr(ins.imm), ret: ins.addr + 4 });
      last.kind = "exception";
      last.detail = `hardware, in one step: switch to kernel mode, mask interrupts, save the old mode, save ${hex(ins.addr + 4)} (the next instruction) as the return address, record the reason (svc #${hex(ins.imm)}), jump to ${hex(VBAR)} + ${hex(offset)}`;
      break;
    }
    case "str": {
      const addr = regGet(s, ins.rn);
      const page = Math.floor(addr / PAGE_SIZE);
      if (s.el === 0 && !s.mapped.includes(page)) {
        const offset = takeException(s, { esr: PAGE_FAULT_ESR, ret: ins.addr, far: addr });
        last.kind = "exception";
        last.detail = `hardware, in one step: no page-table entry for ${hex(addr)}, so switch to kernel mode, mask interrupts, save the old mode, save ${hex(ins.addr)} (this same store) as the return address, record the reason (page fault, write) and the fault address ${hex(addr)}, jump to ${hex(VBAR)} + ${hex(offset)}`;
      } else {
        s.mem[hex(addr)] = regGet(s, ins.rt);
        last.detail = `memory[${hex(addr)}] = ${hex(s.mem[hex(addr)])}`;
        next();
      }
      break;
    }
    case "eret": {
      if (state.el !== 1 || s.elr === null || s.spsr === null) throw new Error("eret with nothing saved");
      s.pc = s.elr;
      s.el = (s.spsr & 0xf) === 0 ? 0 : 1;
      s.daif = (s.spsr >>> 6) & 0xf;
      s.nzcv = (s.spsr >>> 28) & 0xf;
      last.kind = "eret";
      last.detail = `hardware: restore ${MODE_NAMES[s.el]} and interrupts, jump to the saved address ${hex(s.pc)}. The saved return address and reason keep their values until the next exception`;
      break;
    }
    case "call":
      if (ins.fn === "map_page") {
        const page = Math.floor((s.far ?? 0) / PAGE_SIZE);
        const ok = s.promised.includes(page);
        if (ok && !s.mapped.includes(page)) s.mapped.push(page);
        s.regs.x12 = ok ? 1 : 0;
        last.detail = ok
          ? `page ${hex(page * PAGE_SIZE)} was promised: page-table entry filled, x12 = 1`
          : `nothing was promised at ${hex(s.far ?? 0)}: x12 = 0`;
        next();
      } else if (ins.fn === "kill_process") {
        s.halted = { kind: "killed", text: "The kernel ended the process with signal 11 (SIGSEGV). The shell prints \"segmentation fault\" and $? is 128 + 11 = 139.", exitStatus: 139 };
        last.kind = "killed";
        last.detail = "process ended by signal 11; it never returns to the store";
      } else {
        throw new Error(`unknown kernel helper ${ins.fn}`);
      }
      break;
    case "spin":
      s.halted = { kind: "spin", text: "The app reached its final loop. Done." };
      last.kind = "halt";
      last.detail = "the app loops here forever";
      break;
    default:
      throw new Error(`unknown op ${ins.op}`);
  }
  s.last = last;
  return s;
}

/** Run from the start of a scenario for `n` steps (used for Back and for share links). */
export function stateAt(scenarioId, n) {
  let s = initialState(scenarioId);
  const target = Math.max(0, Math.min(MAX_STEPS, Math.trunc(Number(n) || 0)));
  while (s.steps < target && !s.halted) s = step(s);
  return s;
}

/** Every state of a scenario from start to halt, inclusive. */
export function trace(scenarioId) {
  const out = [initialState(scenarioId)];
  while (!out[out.length - 1].halted) out.push(step(out[out.length - 1]));
  return out;
}

/** The four primary labels, as named in the primer and in ch02's exception-stepper. */
export const PANEL = Object.freeze([
  { key: "mode", label: "mode", arm: "PSTATE.EL" },
  { key: "pc", label: "PC", arm: "PC" },
  { key: "elr", label: "saved return address", arm: "ELR_EL1" },
  { key: "esr", label: "reason", arm: "ESR_EL1" },
]);

export function panelValues(s) {
  return {
    mode: MODE_NAMES[s.el],
    pc: hex(s.pc),
    elr: s.elr === null ? "(none yet)" : hex(s.elr),
    esr: describeReason(s.esr),
  };
}

/** Which of the four labels differ between two states. */
export function changedFields(prev, next) {
  const out = [];
  if (prev.el !== next.el) out.push("mode");
  if (prev.pc !== next.pc) out.push("pc");
  if (prev.elr !== next.elr) out.push("elr");
  if (prev.esr !== next.esr) out.push("esr");
  return out;
}

/** Compare a prediction (array of keys) with what changed. */
export function scorePrediction(predicted, changed) {
  const keys = PANEL.map((p) => p.key);
  const pset = new Set(predicted.filter((k) => keys.includes(k)));
  const cset = new Set(changed);
  const rows = keys.map((k) => ({ key: k, predicted: pset.has(k), changed: cset.has(k), right: pset.has(k) === cset.has(k) }));
  return { rows, right: rows.filter((r) => r.right).length, total: rows.length };
}

// Share state: "<scenario>-<step>" with an optional "-arm" suffix, e.g. "svc-2-arm".
const HASH_RE = /^(svc|fault|null)-(\d{1,3})(-arm)?$/;

export function encodeShare({ scenario, steps, arm }) {
  if (!SCENARIO_IDS.includes(scenario)) throw new RangeError("unknown scenario");
  const n = Math.max(0, Math.min(MAX_STEPS, Math.trunc(Number(steps) || 0)));
  return `${scenario}-${n}${arm ? "-arm" : ""}`;
}

/** True for the state a fresh mount shows (svc, step 0, Arm names off): its share string is empty. */
export function isDefaultShare({ scenario, steps, arm }) {
  return scenario === "svc" && steps === 0 && !arm;
}

/** Parse a share string; returns null for anything malformed (hostile input from the URL). */
export function decodeShare(str) {
  if (typeof str !== "string" || str.length > 16) return null;
  const m = HASH_RE.exec(str);
  if (!m) return null;
  const max = trace(m[1]).length - 1;
  return { scenario: m[1], steps: Math.min(Number(m[2]), max), arm: Boolean(m[3]) };
}
