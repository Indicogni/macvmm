// toy-vmm: one toy guest, run under every virtualization strategy of chapter 00.
//
// Pure logic, no DOM, no I/O: the view renders `state` and turns events into calls to `step`,
// `runSteps` and `runToEnd`, which never mutate their argument.
//
// The machine, the guest and the counts are the lesson's own (course/chapters/0/00-orientation.md,
// "Strategy 1" listing). `model.test.mjs` parses that listing and fails if the two drift apart,
// and checks that `lab.json` holds exactly the counts this model computes, because the lesson
// quotes them from there.
//
// The toy machine:
//   - registers r0..r3 and pc; words are 16-bit two's complement;
//   - a privilege mode: "user" or "kernel" (mode H adds a third, more privileged one for the VMM);
//   - one base-and-limit register: in user mode an address above the limit faults, otherwise the
//     base is added to it; kernel mode uses addresses as they are (the toy's whole page table);
//   - an interrupt-enable bit (CLI clears it, STI sets it; no interrupt ever arrives in this run);
//   - 256 words of memory, with a console at 0xF0..0xFF (a store to 0xF0 prints a character).
// Eleven instructions (LI ADD LD ST JNZ SYSCALL SETBASE IRET CLI STI GETMODE) plus HCALL, which
// only the paravirtual guest of mode G uses.
//
// Honesty notes (the view shows them too): the toy has two privilege modes where Arm has four;
// its trap leaves no syndrome, so the VMM re-reads the instruction at (or just before) the saved
// PC to learn why; a real binary translator rewrites the privileged instructions too, so its
// translated kernel code rarely traps; real hardware keeps a virtual interrupt mask for the guest
// instead of trapping the interrupt switch;
// QEMU translates blocks rather than interpreting one instruction at a time; the cost model is
// invented. Chapter 02 retires the toy against the real mechanism.

export const MEM_WORDS = 256;
export const CONSOLE_LO = 0xf0;
export const CONSOLE_HI = 0xff;
/** Guest instructions per run: the "per 1,000 guest instructions" of the lesson. */
export const BUDGET = 1000;
/** Where the VMM puts guest memory in modes D to H: guest address 0 is host address 0x40. */
export const VMM_BASE = 0x40;
/** The VMM's limit: guest addresses 0x00..0xAF are memory; the console range lies past it. */
export const VMM_LIMIT = 0xaf;
/** The system-call entry point of the toy kernel (SYSCALL enters kernel mode here). */
export const SYSCALL_ENTRY = 0x10;
/** Toy cost model, stated in the readout: invented, chapter 03 measures the real cost. */
export const COST = Object.freeze({ nativeNs: 1, interventionNs: 1000 });
/** Longest basic block the translator of mode F scans. */
const MAX_BLOCK = 16;

// ---------------------------------------------------------------------------------------------
// Instructions

/** Instructions only kernel mode may run. GETMODE is deliberately not in this set. */
export const PRIVILEGED = Object.freeze(new Set(["SETBASE", "IRET", "CLI", "STI"]));
/** Instructions that end a basic block (control may go elsewhere after them). */
const BLOCK_END = new Set(["JNZ", "IRET", "SYSCALL", "HCALL"]);

const ins = (op, fields = {}) => Object.freeze({ op, ...fields });
const LI = (rd, imm, fmt = "dec") => ins("LI", { rd, imm, fmt });
const ADD = (rd, rs) => ins("ADD", { rd, rs });
const ST = (rs, addr) => ins("ST", { rs, addr });
const JNZ = (rs, target) => ins("JNZ", { rs, target });
const SYSCALL = () => ins("SYSCALL");
const SETBASE = (base, limit) => ins("SETBASE", { base, limit });
const IRET = (rs) => ins("IRET", { rs });
const STI = () => ins("STI");
const GETMODE = (rd) => ins("GETMODE", { rd });
const HCALL = (n) => ins("HCALL", { n });

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
const hex = (n) => "0x" + hex2(n);

/** Text of one instruction, in the lesson listing's notation (single spaces). */
export function formatIns(i) {
  if (!i || typeof i !== "object") return "(data)";
  switch (i.op) {
    case "LI": {
      const v = i.fmt === "chr" ? `'${String.fromCharCode(i.imm)}'` : i.fmt === "hex" ? hex(i.imm) : String(i.imm);
      return `LI r${i.rd}, ${v}`;
    }
    case "ADD":
      return `ADD r${i.rd}, r${i.rs}`;
    case "LD":
      return `LD r${i.rd}, [${hex(i.addr)}]`;
    case "ST":
      return `ST r${i.rs}, [${hex(i.addr)}]`;
    case "JNZ":
      return `JNZ r${i.rs}, ${hex2(i.target)}`;
    case "SYSCALL":
    case "CLI":
    case "STI":
      return i.op;
    case "SETBASE":
      return `SETBASE ${hex(i.base)}, ${hex(i.limit)}`;
    case "IRET":
      return `IRET r${i.rs}`;
    case "GETMODE":
      return `GETMODE r${i.rd}`;
    case "HCALL":
      return `HCALL ${i.n}`;
    default:
      return "(unknown)";
  }
}

// ---------------------------------------------------------------------------------------------
// The guest

/**
 * The toy guest, exactly as the lesson lists it. `addr` is the address as the listing shows it:
 * guest-physical for the kernel, app-relative for the app (the app is loaded at 0x20).
 * `mark`: P privileged, S sensitive but unprivileged, C console store, T traps by design.
 */
const KERNEL = [
  [0x00, SETBASE(0x20, 0x1f), "P", "the app's memory: 32 words from 0x20"],
  [0x01, STI(), "P", "interrupts on"],
  [0x02, GETMODE(1), "S", "r1 = 1 in kernel mode, 0 in user mode"],
  [0x03, JNZ(1, 0x07), "", "kernel mode? skip the panic"],
  [0x04, LI(0, 0x21, "chr"), "", "panic: ..."],
  [0x05, ST(0, 0xf0), "C", '...print "!"...'],
  [0x06, JNZ(0, 0x06), "", "...and spin here forever"],
  [0x07, LI(3, 0x00, "hex"), "", "the app starts at its address 0"],
  [0x08, IRET(3), "P", "enter the app, in user mode"],
  [0x10, ST(0, 0xf0), "C", "system-call handler: print r0"],
  [0x11, IRET(3), "P", "back to the app"],
];
const APP_BASE = 0x20;
const APP = [
  [0x00, LI(0, 0x31, "chr"), "", "the first character"],
  [0x01, LI(1, -3), "", "a counter that climbs to 0"],
  [0x02, LI(2, 1), "", ""],
  [0x03, SYSCALL(), "T", "ask the kernel to print r0"],
  [0x04, ADD(0, 2), "", "next character"],
  [0x05, ADD(1, 2), "", "count up"],
  [0x06, JNZ(1, 0x03), "", "not 0 yet? print again"],
  [0x07, JNZ(2, 0x07), "", "done: spin here (r2 is never 0)"],
];
/** Where the panic path starts; reaching it in kernel mode means the guest panicked. */
const PANIC_AT = 0x04;

/**
 * The guest image for a mode. Mode G's guest is paravirtualized: line 02 asks the VMM with
 * hypercall 0 ("which mode am I in?"), whose answer comes back in r1, so line 03 is unchanged.
 * Returns rows {region, addr, gpa, ins, text, mark, note}.
 */
export function guestImage(mode) {
  const rows = [];
  for (const [addr, i, mark, note] of KERNEL) {
    let insn = i;
    let m = mark;
    let n = note;
    if (mode === "G" && addr === 0x02) {
      insn = HCALL(0);
      m = "T";
      n = "hypercall 0: the VMM puts 1 (kernel) or 0 (user) in r1";
    }
    rows.push(Object.freeze({ region: "kernel", addr, gpa: addr, ins: insn, text: formatIns(insn), mark: m, note: n }));
  }
  for (const [addr, i, mark, note] of APP) {
    rows.push(Object.freeze({ region: "app", addr, gpa: APP_BASE + addr, ins: i, text: formatIns(i), mark, note }));
  }
  return Object.freeze(rows);
}

// ---------------------------------------------------------------------------------------------
// Modes

export const MODES = Object.freeze(["A", "B", "C", "D", "E", "F", "G", "H"]);

/** Per-mode text the view shows. `name` is the lesson's "Strategy" column. */
export const MODE_INFO = Object.freeze({
  A: { name: "bare metal", acts: "never: there is no VMM", about: "The toy kernel owns the real machine. Its console output is the reference every other mode is compared with." },
  B: { name: "a process, no VMM", acts: "never", about: "The kernel is copied into an ordinary process and called. The process runs in user mode, so the first privileged instruction is fatal: the host kernel kills it. This is the first problem in chapter 00's ledger: the processor's privileged state." },
  C: { name: "interpret", acts: "on every instruction", about: "An emulator: the VMM reads each guest instruction and carries it out on a software copy of the machine. Correct, and every instruction costs an intervention." },
  D: { name: "trap-and-emulate", acts: "on each trap", about: "The guest kernel runs natively in user mode. Privileged instructions, console stores and system calls trap; the VMM keeps a virtual mode bit and a virtual base, and resumes the guest. Here GETMODE is made to trap." },
  E: { name: "trap-and-emulate, real GETMODE", acts: "on each trap", about: "As mode D, but GETMODE runs as the toy processor really runs it: it is not privileged. The checkbox makes it privileged, the fix Popek and Goldberg ask of processor designers." },
  F: { name: "binary translation", acts: "on each trap and each new block", about: "Before guest kernel code runs, the VMM scans it a block at a time and rewrites GETMODE into a call into the VMM; translated blocks are cached. The app's user-mode code runs directly, untranslated." },
  G: { name: "paravirtualization", acts: "on each trap and each hypercall", about: "The guest's source was edited: line 02 is HCALL 0, a hypercall asking the VMM which mode the guest is in. The answer comes back in r1." },
  H: { name: "hardware assist", acts: "only on what the VMM chose to trap", about: "A third, more privileged mode holds the VMM. The guest kernel runs in a real kernel mode, and the VMM chooses what traps: by default, only the console range. The hardware keeps a virtual interrupt mask for the guest, and the VMM's second base register, applied after the guest's, is the toy's second translation stage." },
});

/**
 * Default options. `getmodePrivileged` matters in mode E; the three traps in mode H.
 * `trapIE` defaults to false because real hardware does not trap the interrupt switch: it keeps
 * a virtual interrupt mask for the guest (on Arm, with HCR_EL2.IMO set, the guest's PSTATE.I masks
 * virtual IRQs, and MSR DAIFSet/DAIFClr cannot be trapped at all). The option stays as a
 * "what if you also trapped it" experiment.
 */
export const DEFAULT_OPTS = Object.freeze({ getmodePrivileged: false, trapBase: false, trapIE: false, trapConsole: true });

function normOpts(mode, opts) {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  for (const k of Object.keys(DEFAULT_OPTS)) o[k] = Boolean(o[k]);
  // Options a mode does not use are reset to their defaults, so equal runs have equal options
  // (and the share string, which carries only the options a mode uses, round-trips exactly).
  if (mode !== "E") o.getmodePrivileged = DEFAULT_OPTS.getmodePrivileged;
  if (mode !== "H") for (const k of ["trapBase", "trapIE", "trapConsole"]) o[k] = DEFAULT_OPTS[k];
  // Mode D is mode E with the fix applied, by definition.
  if (mode === "D") o.getmodePrivileged = true;
  return Object.freeze(o);
}

// ---------------------------------------------------------------------------------------------
// State

const w16 = (x) => (x << 16) >> 16;

/**
 * A fresh machine for `mode`. The guest image is loaded at host address 0 in modes A to C and at
 * VMM_BASE (0x40) in modes D to H, where the VMM owns the real machine.
 */
export function createState(mode = "A", opts) {
  if (!MODES.includes(mode)) throw new RangeError(`unknown mode ${String(mode)}`);
  const o = normOpts(mode, opts);
  const virt = mode >= "D"; // D, E, F, G, H: a VMM owns the real machine
  const load = virt || mode === "B" ? VMM_BASE : 0;
  const mem = new Array(MEM_WORDS).fill(0);
  for (const row of guestImage(mode)) mem[load + row.gpa] = row.ins;
  let cpu;
  if (mode === "A" || mode === "C") {
    cpu = { r: [0, 0, 0, 0], pc: 0, priv: "kernel", base: 0, limit: 0xff, ie: 0 };
  } else if (mode === "B") {
    // The host OS gave the process the words at 0x40..0xEF, and runs it in user mode.
    cpu = { r: [0, 0, 0, 0], pc: 0, priv: "user", base: VMM_BASE, limit: VMM_LIMIT, ie: 0 };
  } else if (mode === "H") {
    cpu = { r: [0, 0, 0, 0], pc: 0, priv: "kernel", base: 0, limit: 0xff, ie: 0 };
  } else {
    // Deprivileged: the guest kernel really runs in user mode, inside the VMM's base and limit.
    cpu = { r: [0, 0, 0, 0], pc: 0, priv: "user", base: VMM_BASE, limit: VMM_LIMIT, ie: 0 };
  }
  return Object.freeze({
    mode,
    opts: o,
    load,
    mem: Object.freeze(mem),
    cpu: Object.freeze({ ...cpu, r: Object.freeze(cpu.r) }),
    // The VMM's copy of the guest's privileged state (modes D to G), or its own state (mode H).
    v: virt
      ? Object.freeze(
          mode === "H"
            ? // consoleRam: when the console range is not trapped, the VMM maps plain memory there
              // instead: 16 host words outside the guest's 0x40..0xEF window.
              { ie: 0, s2base: VMM_BASE, s2limit: VMM_LIMIT, consoleRam: Object.freeze(new Array(CONSOLE_HI - CONSOLE_LO + 1).fill(0)) }
            : { mode: "kernel", base: 0, limit: 0xff, ie: 0 },
        )
      : null,
    n: Object.freeze({ steps: 0, native: 0, trap: 0, callout: 0, interpret: 0, hypercall: 0, translate: 0 }),
    console: "",
    halted: null, // {kind: "killed" | "fault", text}
    panicked: false,
    spinAt: null, // guest instructions run before the guest first spins on a self-jump
    lastTrap: null, // {reason, saved, to}
    tcache: Object.freeze({ blocks: Object.freeze([]), covered: Object.freeze({}) }),
    trace: Object.freeze([]),
  });
}

function clone(s) {
  return {
    ...s,
    cpu: { ...s.cpu, r: [...s.cpu.r] },
    v: s.v ? { ...s.v } : null,
    n: { ...s.n },
    tcache: { blocks: [...s.tcache.blocks], covered: { ...s.tcache.covered } },
    trace: [...s.trace],
  };
}

function freeze(s) {
  return Object.freeze({
    ...s,
    cpu: Object.freeze({ ...s.cpu, r: Object.freeze(s.cpu.r) }),
    v: s.v ? Object.freeze(s.v) : null,
    n: Object.freeze(s.n),
    tcache: Object.freeze({ blocks: Object.freeze(s.tcache.blocks), covered: Object.freeze(s.tcache.covered) }),
    trace: Object.freeze(s.trace),
  });
}

/** The mode the guest believes it is in. */
export function guestMode(s) {
  if (s.v && s.v.mode) return s.v.mode;
  if (s.mode === "B") return "kernel"; // it believes so; the process is really in user mode
  return s.cpu.priv;
}

/** Guest-physical address of the guest's next instruction, or null if it is out of range. */
export function guestPc(s) {
  if (guestMode(s) === "kernel") return s.cpu.pc;
  const base = s.v && s.v.mode ? s.v.base : s.cpu.base;
  return base + s.cpu.pc;
}

/** True when the run is over: halted, or the 1,000-instruction budget is spent. */
export function isDone(s) {
  return s.halted !== null || s.n.steps >= BUDGET;
}

export function interventions(n) {
  return n.trap + n.callout + n.interpret + n.hypercall + n.translate;
}

// ---------------------------------------------------------------------------------------------
// Memory

/**
 * Translate an address the CPU issues, as the real hardware would.
 * Returns {host} | {device: "console"} | {fault: "limit"} | {exit: "console"|"stage2", gpa} |
 * {ram: index} (mode H: the VMM mapped plain memory at the console range instead of trapping it).
 */
function translate(s, addr) {
  if (!Number.isInteger(addr) || addr < 0 || addr >= MEM_WORDS) return { fault: "bus" };
  let a = addr;
  if (s.cpu.priv === "user") {
    if (a > s.cpu.limit) return { fault: "limit" };
    a = s.cpu.base + a;
  }
  if (s.mode === "H") {
    // The second stage: the VMM's base and limit, applied after the guest's own.
    // Every guest-physical address the VMM did not back with memory exits. Choosing not to trap
    // the console range means backing it with plain memory (the VMM's consoleRam).
    if (a >= CONSOLE_LO && a <= CONSOLE_HI) return s.opts.trapConsole ? { exit: "console", gpa: a } : { ram: a - CONSOLE_LO };
    if (a > s.v.s2limit) return { exit: "stage2", gpa: a };
    a = s.v.s2base + a;
  }
  if (a >= MEM_WORDS) return { fault: "bus" };
  if (a >= CONSOLE_LO && a <= CONSOLE_HI) return { device: "console" };
  return { host: a };
}

function printable(v) {
  const c = v & 0xff;
  return c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : "?";
}

function consoleWrite(s, addr, v) {
  // Only 0xF0 prints; the rest of the console range ignores stores.
  if (addr === CONSOLE_LO) s.console += printable(v);
}

function memWrite(s, host, v) {
  const m = s.mem.slice();
  m[host] = w16(v);
  s.mem = Object.freeze(m);
}

function memRead(s, host) {
  const x = s.mem[host];
  return typeof x === "number" ? x : 0; // an instruction word reads as 0 in this toy
}

// ---------------------------------------------------------------------------------------------
// Execution

function halt(s, rec, kind, text) {
  s.halted = { kind, text };
  rec.kind = kind;
  rec.what = text;
}

/** The region and listing address of a guest-physical instruction address. */
function where(s, gpa) {
  if (guestMode(s) === "kernel") return { region: "kernel", addr: gpa };
  return { region: "app", addr: s.cpu.pc };
}

/**
 * Run one native instruction with the real machine's semantics (bare metal, the interpreter's
 * software copy, the CPU running a guest directly). Returns false if it could not complete.
 */
function execNative(s, i, rec) {
  const c = s.cpu;
  const next = c.pc + 1;
  switch (i.op) {
    case "LI":
      c.r[i.rd] = w16(i.imm);
      break;
    case "ADD":
      c.r[i.rd] = w16(c.r[i.rd] + c.r[i.rs]);
      break;
    case "LD":
    case "ST": {
      const t = translate(s, i.addr);
      if (t.host !== undefined) {
        if (i.op === "LD") c.r[i.rd] = memRead(s, t.host);
        else memWrite(s, t.host, c.r[i.rs]);
      } else if (t.device) {
        if (i.op === "ST") consoleWrite(s, i.addr, c.r[i.rs]);
        else c.r[i.rd] = 0;
      } else if (t.ram !== undefined) {
        if (i.op === "LD") {
          c.r[i.rd] = s.v.consoleRam[t.ram];
          rec.what = `Loads natively: the VMM mapped plain memory at the console range instead of trapping it, so r${i.rd} = ${c.r[i.rd]}, the last value stored there.`;
        } else {
          const ram = s.v.consoleRam.slice();
          ram[t.ram] = w16(c.r[i.rs]);
          s.v.consoleRam = Object.freeze(ram);
          rec.what = "Stores natively: the VMM mapped plain memory at the console range instead of trapping it, so the value lands in memory and nothing reaches your screen.";
        }
      } else {
        return false;
      }
      break;
    }
    case "JNZ":
      if (c.r[i.rs] !== 0) {
        if (i.target === c.pc && s.spinAt === null) s.spinAt = s.n.steps;
        c.pc = i.target;
        return true;
      }
      break;
    case "SYSCALL":
      c.r[3] = next;
      c.priv = "kernel";
      c.pc = SYSCALL_ENTRY;
      s.lastTrap = { reason: "system call (SYSCALL)", saved: next, to: "guest kernel" };
      return true;
    case "SETBASE":
      c.base = i.base;
      c.limit = i.limit;
      break;
    case "IRET":
      c.priv = "user";
      c.pc = c.r[i.rs] & 0xff;
      return true;
    case "CLI":
      c.ie = 0;
      break;
    case "STI":
      c.ie = 1;
      break;
    case "GETMODE":
      c.r[i.rd] = c.priv === "kernel" ? 1 : 0;
      break;
    default:
      return false;
  }
  c.pc = next;
  return true;
}

/** Load the real base and limit for the guest's virtual mode (modes D to G). */
function syncShadow(s) {
  if (s.v.mode === "kernel") {
    s.cpu.base = VMM_BASE;
    s.cpu.limit = VMM_LIMIT;
    return true;
  }
  // Shadowing in one line: the real base is the guest's base plus the VMM's.
  if (s.v.base > VMM_LIMIT) return false;
  s.cpu.base = VMM_BASE + s.v.base;
  s.cpu.limit = Math.min(s.v.limit, VMM_LIMIT - s.v.base);
  return true;
}

/**
 * The VMM emulates one trapped instruction for a deprivileged guest (modes D to G).
 * `cause` says why the CPU stopped. Returns false if the guest did something it may not.
 */
function emulate(s, i, rec, cause) {
  const c = s.cpu;
  const v = s.v;
  const next = c.pc + 1;
  const reason =
    cause === "fault"
      ? "address past the limit"
      : cause === "callout"
        ? `call into the VMM from the translated ${i.op}`
        : `${PRIVILEGED.has(i.op) ? "privileged instruction" : "trapping instruction"} ${i.op}`;
  s.lastTrap = { reason, saved: c.pc, to: "VMM" };
  switch (i.op) {
    case "SETBASE":
      v.base = i.base;
      v.limit = i.limit;
      rec.what = `Traps: privileged. The VMM records the guest's base ${hex(i.base)} and limit ${hex(i.limit)} as virtual values and leaves the real register alone.`;
      break;
    case "STI":
    case "CLI":
      v.ie = i.op === "STI" ? 1 : 0;
      rec.what = `Traps: privileged. The VMM sets its virtual interrupt-enable bit to ${v.ie}.`;
      break;
    case "GETMODE":
      c.r[i.rd] = v.mode === "kernel" ? 1 : 0;
      rec.what =
        s.mode === "F"
          ? `The translator rewrote it into a call into the VMM. The VMM answers from its virtual mode bit: r${i.rd} = ${c.r[i.rd]} (${v.mode}).`
          : `Traps: made privileged. The VMM answers from its virtual mode bit: r${i.rd} = ${c.r[i.rd]} (${v.mode}).`;
      break;
    case "IRET": {
      const target = c.r[i.rs] & 0xff;
      v.mode = "user";
      if (!syncShadow(s)) return false;
      c.pc = target;
      rec.what = `Traps: privileged. The VMM switches the virtual mode to user and loads the real base with the guest's base plus its own: ${hex(c.base)}.`;
      return true;
    }
    case "SYSCALL":
      // Every trap goes to real kernel mode, which is now the VMM: pass it on to the guest kernel.
      c.r[3] = next;
      v.mode = "kernel";
      syncShadow(s);
      c.pc = SYSCALL_ENTRY;
      s.lastTrap = { reason: "system call (SYSCALL)", saved: next, to: "VMM, passed on to the guest kernel" };
      rec.what = `Traps to the VMM, which passes it on: virtual mode kernel, r3 = ${hex(next)}, jump to the guest kernel's handler at ${hex(SYSCALL_ENTRY)}.`;
      return true;
    case "HCALL":
      if (s.mode !== "G" || i.n !== 0) return false;
      c.r[1] = v.mode === "kernel" ? 1 : 0;
      // As for SYSCALL (and Arm's hvc and svc), the call continues at the next instruction.
      s.lastTrap = { reason: "hypercall 0", saved: next, to: "VMM" };
      rec.what = `Hypercall 0: the guest asks the VMM which mode it is in. r1 = ${c.r[1]} (${v.mode}).`;
      break;
    case "LD":
    case "ST": {
      // The CPU faulted on the limit. Work out the guest-physical address the guest meant.
      let gpa = i.addr;
      if (v.mode === "user") {
        if (i.addr > v.limit) return false;
        gpa = v.base + i.addr;
      }
      if (gpa < CONSOLE_LO || gpa > CONSOLE_HI) return false;
      if (i.op === "ST") {
        consoleWrite(s, gpa, c.r[i.rs]);
        rec.what = `Traps: ${hex(i.addr)} is past the limit. The VMM plays the console: it prints "${printable(c.r[i.rs])}".`;
      } else {
        c.r[i.rd] = 0;
        rec.what = "Traps: past the limit. The VMM plays the console and returns 0.";
      }
      s.lastTrap = { reason: "console access past the limit", saved: c.pc, to: "VMM" };
      break;
    }
    default:
      return false;
  }
  c.pc = next;
  return true;
}

/** Mode F: make sure the guest kernel code at `gpa` is translated. Returns the new block or null. */
function translateBlock(s, gpa) {
  if (s.tcache.covered[gpa] !== undefined) return null;
  let end = gpa;
  let rewrites = 0;
  for (let k = 0; k < MAX_BLOCK; k++) {
    const a = gpa + k;
    if (a > VMM_LIMIT) break;
    const i = s.mem[s.load + a];
    if (!i || typeof i !== "object") break;
    end = a;
    if (i.op === "GETMODE") rewrites++;
    if (BLOCK_END.has(i.op)) break;
  }
  const block = Object.freeze({ start: gpa, end, rewrites });
  s.tcache.blocks.push(block);
  for (let a = gpa; a <= end; a++) s.tcache.covered[a] = gpa;
  s.n.translate++;
  return block;
}

function fetch(s) {
  const t = translate(s, s.cpu.pc);
  if (t.host !== undefined) {
    const i = s.mem[t.host];
    return i && typeof i === "object" ? { ins: i } : { bad: "a data word, not an instruction" };
  }
  return { bad: "an address the guest may not run code from" };
}

function stepMut(s) {
  if (isDone(s)) return s;
  const gpa = guestPc(s);
  const at = where(s, gpa);
  const rec = { n: s.n.steps + 1, region: at.region, addr: at.addr, text: "", who: "CPU", kind: "native", what: "", translated: null };
  s.trace.push(rec);

  const f = fetch(s);
  if (!f.ins) {
    rec.text = "?";
    rec.who = s.mode === "C" ? "VMM" : "nobody";
    halt(s, rec, "fault", `The guest's PC points at ${f.bad}. The toy has no handler for that, so the run stops.`);
    return s;
  }
  const i = f.ins;
  rec.text = formatIns(i);
  if (guestMode(s) === "kernel" && gpa === PANIC_AT) s.panicked = true;

  const m = s.mode;
  if (m === "A" || m === "C") {
    if (s.cpu.priv === "user" && PRIVILEGED.has(i.op)) {
      halt(s, rec, "fault", `${i.op} is privileged and the CPU is in user mode. The toy kernel has no handler for that, so the run stops.`);
      return s;
    }
    if (!execNative(s, i, rec)) {
      halt(s, rec, "fault", `${rec.text} cannot run here. The toy has no handler for that, so the run stops.`);
      return s;
    }
    if (m === "C") {
      rec.who = "VMM";
      rec.kind = "interpret";
      rec.what = rec.what || "The interpreter decodes it and carries it out on its software copy of the machine.";
      s.n.interpret++;
    } else {
      rec.what = rec.what || "Runs natively on the real machine.";
      s.n.native++;
    }
    s.n.steps++;
    return s;
  }

  if (m === "B") {
    if (PRIVILEGED.has(i.op)) {
      rec.who = "host OS";
      s.lastTrap = { reason: `privileged instruction ${i.op}`, saved: s.cpu.pc, to: "host kernel" };
      halt(s, rec, "killed", `${i.op} is privileged and this is an ordinary process, in user mode. The host kernel kills it: SIGILL, illegal instruction. This is the first problem in chapter 00's ledger: the processor's privileged state.`);
      return s;
    }
    if (i.op === "SYSCALL") {
      // Not privileged: in a process, a system call goes to the host kernel, not the toy kernel.
      rec.who = "host OS";
      s.lastTrap = { reason: "system call (SYSCALL)", saved: s.cpu.pc + 1, to: "host kernel" };
      halt(s, rec, "fault", "SYSCALL asks the host kernel, not the toy kernel inside this process, and the host kernel does not know this call. The toy stops the run here.");
      return s;
    }
    if (i.op === "HCALL") {
      rec.who = "host OS";
      s.lastTrap = { reason: "undefined instruction HCALL", saved: s.cpu.pc, to: "host kernel" };
      halt(s, rec, "killed", "HCALL asks a VMM, and there is none: the host kernel treats it as an illegal instruction and kills the process (SIGILL).");
      return s;
    }
    if (!execNative(s, i, rec)) {
      rec.who = "host OS";
      halt(s, rec, "killed", "The process touched memory it does not have. The host kernel kills it.");
      return s;
    }
    s.n.native++;
    s.n.steps++;
    return s;
  }

  if (m === "H") return stepHardwareAssist(s, i, rec);

  // Modes D, E, F, G: the guest kernel runs deprivileged, in real user mode.
  if (m === "F" && s.v.mode === "kernel") {
    const b = translateBlock(s, gpa);
    if (b) rec.translated = b;
  }
  let trapCause = null;
  if (PRIVILEGED.has(i.op) || i.op === "SYSCALL" || i.op === "HCALL") trapCause = "instruction";
  else if (i.op === "GETMODE") {
    // Mode F: the translator replaced GETMODE with a call into the VMM, so it no longer traps.
    const rewritten = m === "F" && s.v.mode === "kernel";
    if (rewritten) trapCause = "callout";
    else if (s.opts.getmodePrivileged) trapCause = "instruction";
  } else if (i.op === "LD" || i.op === "ST") {
    const t = translate(s, i.addr);
    if (t.host === undefined && !t.device) trapCause = "fault";
  }

  if (trapCause && s.v.mode === "user" && PRIVILEGED.has(i.op)) {
    // The guest's own app ran a privileged instruction. The VMM must not carry it out: on real
    // hardware the guest kernel would get an illegal-instruction fault. The toy guest kernel has
    // no handler for one, so the run stops.
    rec.who = "VMM";
    rec.kind = "trap";
    s.lastTrap = { reason: `privileged instruction ${i.op} from the guest app`, saved: s.cpu.pc, to: "VMM" };
    halt(s, rec, "fault", `The guest app ran a privileged instruction, ${i.op}. A real VMM reflects this to the guest kernel as an illegal-instruction fault; the toy guest kernel has no handler for it, so the run stops.`);
    return s;
  }
  if (trapCause) {
    rec.who = "VMM";
    rec.kind = i.op === "HCALL" ? "hypercall" : trapCause === "callout" ? "callout" : "trap";
    if (!emulate(s, i, rec, trapCause)) {
      halt(s, rec, "fault", `${rec.text} traps, and the VMM finds the guest doing something it may not. The toy has no fault handler, so the run stops.`);
      return s;
    }
    if (rec.kind === "hypercall") s.n.hypercall++;
    else if (rec.kind === "callout") s.n.callout++;
    else s.n.trap++;
    s.n.steps++;
    return s;
  }
  if (!execNative(s, i, rec)) {
    halt(s, rec, "fault", `${rec.text} cannot run here, so the run stops.`);
    return s;
  }
  if (!rec.what) {
    rec.what =
      i.op === "GETMODE"
        ? `Runs natively: the CPU really is in user mode, so r${i.rd} = 0 (user). Nothing traps; the VMM never sees it.`
        : "Runs natively; the VMM is not running.";
  }
  s.n.native++;
  s.n.steps++;
  return s;
}

function stepHardwareAssist(s, i, rec) {
  const c = s.cpu;
  const o = s.opts;
  const trapsHere = (o.trapBase && i.op === "SETBASE") || (o.trapIE && (i.op === "CLI" || i.op === "STI"));
  if (c.priv === "user" && (PRIVILEGED.has(i.op) || i.op === "HCALL")) {
    halt(s, rec, "fault", `${i.op} is privileged and the app is in user mode. The toy kernel has no handler for that, so the run stops.`);
    return s;
  }
  if (i.op === "HCALL") {
    halt(s, rec, "fault", "HCALL exists only for the paravirtual guest of mode G.");
    return s;
  }
  if (trapsHere) {
    rec.who = "VMM";
    rec.kind = "trap";
    s.lastTrap = { reason: `privileged instruction ${i.op}, chosen by the VMM`, saved: c.pc, to: "VMM" };
    if (i.op === "SETBASE") {
      c.base = i.base;
      c.limit = i.limit;
      rec.what = `Traps, because the VMM asked to see base writes. It writes the guest's own base register (${hex(i.base)}, limit ${hex(i.limit)}) and resumes; its second base register is unchanged.`;
    } else {
      s.v.ie = i.op === "STI" ? 1 : 0;
      rec.what = `Traps, because the VMM asked to see the interrupt switch. Its virtual interrupt-enable bit is now ${s.v.ie}. Real hardware is not asked to do this: it keeps a virtual interrupt mask for the guest.`;
    }
    c.pc += 1;
    s.n.trap++;
    s.n.steps++;
    return s;
  }
  if (i.op === "LD" || i.op === "ST") {
    const t = translate(s, i.addr);
    if (t.exit === "console") {
      rec.who = "VMM";
      rec.kind = "trap";
      s.lastTrap = { reason: "console access, chosen by the VMM", saved: c.pc, to: "VMM" };
      if (i.op === "ST") {
        consoleWrite(s, t.gpa, c.r[i.rs]);
        rec.what = `Traps: the VMM asked to see the console range. It plays the console and prints "${printable(c.r[i.rs])}".`;
      } else {
        c.r[i.rd] = 0;
        rec.what = "Traps: the VMM plays the console and returns 0.";
      }
      c.pc += 1;
      s.n.trap++;
      s.n.steps++;
      return s;
    }
    if (t.exit === "stage2" || t.fault) {
      rec.who = "VMM";
      halt(s, rec, "fault", "The guest touched memory outside what the VMM gave it. The second base register stopped it, and the toy VMM ends the run.");
      return s;
    }
  }
  if (!execNative(s, i, rec)) {
    halt(s, rec, "fault", `${rec.text} cannot run here, so the run stops.`);
    return s;
  }
  if (!rec.what) {
    if (i.op === "GETMODE") rec.what = `Runs natively in a real kernel mode, so r${i.rd} = ${c.r[i.rd]} (${c.priv === "kernel" ? "kernel" : "user"}), truthfully.`;
    else if (i.op === "SETBASE") rec.what = "Runs natively: the guest sets its own base. The VMM's second base register still applies after it.";
    else if (i.op === "STI" || i.op === "CLI") rec.what = "Runs natively: the hardware keeps a virtual interrupt mask for the guest, so the guest switches it itself and nothing traps.";
    else if (i.op === "SYSCALL") rec.what = "Runs natively: the CPU enters the guest kernel's handler directly; the VMM is not involved.";
    else if (i.op === "IRET") rec.what = "Runs natively in a real kernel mode; nothing traps.";
    else rec.what = "Runs natively.";
  }
  s.n.native++;
  s.n.steps++;
  return s;
}

/** One guest instruction. Never mutates `s`. */
export function step(s) {
  if (isDone(s)) return s;
  return freeze(stepMut(clone(s)));
}

/** Up to `count` guest instructions (stops early when the run is over). */
export function runSteps(s, count) {
  if (isDone(s) || !(count > 0)) return s;
  const c = clone(s);
  for (let k = 0; k < count && !isDone(c); k++) stepMut(c);
  return freeze(c);
}

/** Run until the budget is spent or the guest halts. */
export function runToEnd(s) {
  return runSteps(s, BUDGET + 1);
}

// ---------------------------------------------------------------------------------------------
// Readout

let referenceCache = null;

/** Guest instructions run when the console first equals the reference, or null if it never does. */
export function outputCompleteAt(s0) {
  const ref = reference();
  let s = s0;
  while (!isDone(s)) {
    if (s.console === ref) return s.n.steps;
    s = step(s);
  }
  return s.console === ref ? s.n.steps : null;
}
/** The console output of mode A: the reference string. */
export function reference() {
  if (referenceCache === null) referenceCache = runToEnd(createState("A")).console;
  return referenceCache;
}

/** Toy-model time in nanoseconds. */
export function toyTimeNs(n) {
  return n.native * COST.nativeNs + interventions(n) * COST.interventionNs;
}

/** Format nanoseconds as the readout does ("13.987 µs", "1 ms"). */
export function formatTime(ns) {
  if (ns < 1000) return `${ns} ns`;
  if (ns < 1_000_000) return `${trimNum(ns / 1000)} µs`;
  return `${trimNum(ns / 1_000_000)} ms`;
}

function trimNum(x) {
  return String(Number(x.toFixed(3)));
}

/** Everything the readout needs, as plain data. */
export function summary(s) {
  const ref = reference();
  return Object.freeze({
    mode: s.mode,
    steps: s.n.steps,
    native: s.n.native,
    interventions: interventions(s.n),
    traps: s.n.trap,
    callouts: s.n.callout,
    interpretations: s.n.interpret,
    hypercalls: s.n.hypercall,
    translations: s.n.translate,
    output: s.console,
    matches: s.console === ref,
    timeNs: toyTimeNs(s.n),
    halted: s.halted,
    panicked: s.panicked,
    spinAt: s.spinAt,
    done: isDone(s),
  });
}

/** One plain-text sentence (or a few) for the live region. */
export function describe(s) {
  const r = summary(s);
  const n = (k) => k.toLocaleString("en-US");
  const sentences = [];
  let first = `Mode ${s.mode}, ${MODE_INFO[s.mode].name}: ${n(r.steps)} guest instructions run`;
  if (s.mode !== "A") first += `, ${n(r.native)} natively by the CPU, ${n(r.interventions)} VMM interventions${breakdown(r)}`;
  sentences.push(first);
  let out = r.output === "" ? "Console: empty" : `Console: ${r.output}`;
  if (r.done) out += r.matches ? " (matches bare metal)" : " (does not match bare metal)";
  sentences.push(out);
  if (r.halted) sentences.push(r.halted.kind === "killed" ? "The process was killed" : "The run stopped");
  if (r.panicked) sentences.push("The guest panicked");
  sentences.push(`Toy-model time ${formatTime(r.timeNs)}`);
  return sentences.join(". ") + ".";
}

/** "(13 traps)" style breakdown of the interventions, or "". */
export function breakdown(r) {
  const b = [];
  const p = (k, one, many) => k && b.push(`${k.toLocaleString("en-US")} ${k === 1 ? one : many}`);
  p(r.traps, "trap", "traps");
  p(r.callouts, "call into the VMM", "calls into the VMM");
  p(r.interpretations, "interpretation", "interpretations");
  p(r.hypercalls, "hypercall", "hypercalls");
  p(r.translations, "block translation", "block translations");
  return b.length ? ` (${b.join(", ")})` : "";
}

/**
 * The counts every lesson quotes: each mode with default options run to the end, plus the
 * variants the lesson discusses. `lab.json` must hold exactly this (the test checks).
 */
export function canonicalCounts() {
  const row = (mode, opts) => {
    const r = summary(runToEnd(createState(mode, opts)));
    return {
      native: r.native,
      interventions: r.interventions,
      traps: r.traps,
      callouts: r.callouts,
      interpretations: r.interpretations,
      hypercalls: r.hypercalls,
      translations: r.translations,
      output: r.output,
      matches: r.matches,
      ...(r.halted ? { stopped: r.halted.kind } : {}),
      ...(r.panicked ? { panicked: true } : {}),
    };
  };
  return {
    reference: reference(),
    budget: BUDGET,
    // Mode A: the instruction count at which the console first reads the reference, and the
    // count run before the app enters its final spin loop.
    referenceAt: outputCompleteAt(createState("A")),
    spinAt: summary(runToEnd(createState("A"))).spinAt,
    modes: Object.fromEntries(MODES.map((m) => [m, row(m)])),
    variants: {
      "E-fixed": row("E", { getmodePrivileged: true }),
      "H-trap-base-too": row("H", { trapBase: true }),
      "H-trap-interrupt-switch-too": row("H", { trapIE: true }),
      "H-no-console": row("H", { trapConsole: false }),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Share state: "D", "E-p", "H-ic", "H-bic@27". Mode letter, option flags, optional step count.

const FLAG = { getmodePrivileged: "p", trapBase: "b", trapIE: "i", trapConsole: "c" };

/** Encode mode, options and position. Flags are written only where the mode uses them. */
export function formatShare(s) {
  let out = s.mode;
  if (s.mode === "E") out += "-" + (s.opts.getmodePrivileged ? "p" : "");
  if (s.mode === "H") out += "-" + ["trapBase", "trapIE", "trapConsole"].filter((k) => s.opts[k]).map((k) => FLAG[k]).join("");
  if (s.n.steps > 0) out += "@" + s.n.steps;
  return out;
}

/**
 * Decode a share string. Returns {mode, opts, steps} or null for anything malformed.
 * Only canonical strings (exactly what formatShare writes) are accepted: modes E and H always
 * carry a flag group, other modes never do, flags appear in the order "bic", and the step count
 * has no leading zeros (no "@0"). So parse and format round-trip exactly.
 */
export function parseShare(str) {
  if (typeof str !== "string" || str.length > 24) return null;
  const m = /^([A-H])(?:-(p?|b?i?c?))?(?:@([1-9]\d{0,3}))?$/.exec(str);
  if (!m) return null;
  const mode = m[1];
  const flags = m[2];
  const hasFlags = mode === "E" || mode === "H";
  if (hasFlags !== (flags !== undefined)) return null;
  if (mode === "E" && !/^p?$/.test(flags)) return null;
  if (mode === "H" && !/^b?i?c?$/.test(flags)) return null;
  const opts = { ...DEFAULT_OPTS };
  if (mode === "E") opts.getmodePrivileged = flags === "p";
  if (mode === "H") {
    opts.trapBase = flags.includes("b");
    opts.trapIE = flags.includes("i");
    opts.trapConsole = flags.includes("c");
  }
  const steps = m[3] === undefined ? 0 : Number(m[3]);
  if (steps > BUDGET) return null;
  return { mode, opts: normOpts(mode, opts), steps };
}

/**
 * Build the state a share string describes, or null. A step count past the point where the run
 * stops (mode B halts at once, mode E's panic still runs to the budget) is clamped to that
 * point; formatShare of the result is then the canonical string the view writes back.
 */
export function stateFromShare(str) {
  const p = parseShare(str);
  if (!p) return null;
  return runSteps(createState(p.mode, p.opts), p.steps);
}
