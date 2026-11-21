// exception-stepper: the pure model (no DOM, no I/O).
//
// One Arm CPU, one "exception" at a time. The learner picks where the code runs (an app at EL0
// or a kernel at EL1) and what happens (svc, hvc, a data abort, an interrupt), takes the
// exception, and then returns with ERET. The model computes, exactly as the architecture does
// for these cases, which level takes it, which vector-table entry the PC jumps to, and what the
// hardware writes into the receiving level's ELR, SPSR, ESR and FAR.
//
// Sources (ARM ARM DDI 0487):
// - "Exception entry" (D1.3 in recent issues): on entry to ELx the PC becomes VBAR_ELx + offset,
//   PSTATE is saved to SPSR_ELx, the preferred return address to ELR_ELx, and PSTATE.{D,A,I,F}
//   are all set; the new mode is ELxh. The condition flags N Z C V are NOT written
//   (AArch64.TakeException sets EL, nRW, SP and DAIF and clears SS and IL; nothing else), so the
//   handler starts with the interrupted code's flags.
// - "Vector tables": offsets 0x000/0x200/0x400 for current-EL-SP_EL0 / current-EL-SP_ELx /
//   lower-EL-AArch64, plus 0x80 for IRQ instead of synchronous.
// - "Preferred exception return address": after svc/hvc, at a faulting or undefined
//   instruction, and the first instruction not executed for an interrupt.
// - ESR_ELx EC values: 0x00 unknown reason, 0x15 SVC64, 0x16 HVC64, 0x24 data abort from a
//   lower level, 0x25 data abort at the same level. HVC at EL0 is UNDEFINED (EC 0x00).
// The labels ("mode", "PC", "saved return address", "reason") are the ones chapter 00's toy-vmm
// uses, so the two screens can be compared side by side.
//
// Two vocabularies: with the "register names" toggle off (the default, and what chapter 02's
// opening section expects) every detail and note is plain language: no PSTATE/ESR hex, no
// h/t mode suffixes, no VBAR_ELx, HPFAR_EL2 or hv_vcpu_run. Those appear only with names on.

import { decodePstate, describePstate, encodePstate, modeName } from "./pstate.mjs";

// ---------------------------------------------------------------------------------------------
// The fixed little machine. The lesson's paper fallback quotes these numbers; tests pin them.
// ---------------------------------------------------------------------------------------------
export const MACHINE = Object.freeze({
  appPc: 0x1000, // the app's instruction, at EL0
  kernelPc: 0x9000, // the kernel's instruction, at EL1
  vbarEl1: 0x8000, // the kernel's vector table
  // VBAR_EL2 belongs to Apple's software at EL2; our VMM never sees its value, so it stays symbolic.
  appPstate: encodePstate({ el: 0, flags: { Z: true } }), // 0x40000000: EL0t, Z flag set
  kernelPstate: encodePstate({ el: 1, ownSp: true }), // 0x5: EL1h, nothing masked
  kernelPstateMasked: encodePstate({ el: 1, ownSp: true, daif: { I: true } }), // 0x85
  unmappedVa: 0x50000, // an address the kernel's own page tables do not map
  // A guest address the VMM never mapped (a hole in the memory map). The load uses it as a
  // virtual address; the dabt2 story assumes the guest's own translation is off or identity
  // (true for chapter 02's guest: EL1, MMU off), so VA == IPA and FAR_EL2 shows the same number.
  // In general FAR_EL2 holds the VA and HPFAR_EL2 the IPA page; notes() says so.
  unmappedIpa: 0x0c000000,
});

export const SOURCES = Object.freeze([0, 1]);
export const CAUSES = Object.freeze(["svc", "hvc", "dabt", "dabt2", "irq"]);

export const CAUSE_LABEL = Object.freeze({
  svc: "svc #0 (a call to the kernel, EL1)",
  hvc: "hvc #0 (a call to the hypervisor level)",
  dabt: "data abort: a load from an address the kernel's page tables do not map",
  dabt2: "data abort: a load from guest memory the VMM never mapped",
  irq: "IRQ: a timer interrupt arrives",
});

// ESR values, built from fields so the numbers can be checked (see model.test.mjs).
const IL = 1 << 25;
export function makeEsr({ ec, il = true, iss = 0 }) {
  if (!Number.isInteger(ec) || ec < 0 || ec > 0x3f) throw new RangeError("EC is 6 bits");
  if (!Number.isInteger(iss) || iss < 0 || iss > 0x1ffffff) throw new RangeError("ISS is 25 bits");
  return ((ec << 26) | (il ? IL : 0) | iss) >>> 0;
}
// Data-abort ISS (ESR_ELx, ISS encoding for an exception from a data abort).
export function dataAbortIss({ isv = false, sas = 0, sse = false, srt = 0, sf = false, ar = false, wnr = false, dfsc }) {
  let iss = dfsc & 0x3f;
  if (isv) iss |= (1 << 24) | ((sas & 3) << 22) | ((sse ? 1 : 0) << 21) | ((srt & 31) << 16) | ((sf ? 1 : 0) << 15) | ((ar ? 1 : 0) << 14);
  if (wnr) iss |= 1 << 6;
  return iss >>> 0;
}

/** Split an ESR value into the fields the lab shows. Never throws. */
export function esrFields(esr) {
  const v = esr >>> 0;
  const ec = v >>> 26;
  const iss = v & 0x1ffffff;
  const f = { esr: v, ec, il: ((v >>> 25) & 1) === 1, iss };
  if (ec === 0x15 || ec === 0x16 || ec === 0x17) f.imm16 = iss & 0xffff;
  if (ec === 0x24 || ec === 0x25) {
    f.isv = ((iss >>> 24) & 1) === 1;
    if (f.isv) {
      f.sas = (iss >>> 22) & 3;
      f.sse = ((iss >>> 21) & 1) === 1;
      f.srt = (iss >>> 16) & 31;
      f.sf = ((iss >>> 15) & 1) === 1;
      f.ar = ((iss >>> 14) & 1) === 1;
    }
    f.wnr = ((iss >>> 6) & 1) === 1;
    f.dfsc = iss & 0x3f;
  }
  return f;
}

export const EC_NAME = Object.freeze({
  0x00: "unknown reason",
  0x15: "svc (from 64-bit code)",
  0x16: "hvc (from 64-bit code)",
  0x24: "data abort from a lower level",
  0x25: "data abort at the same level",
});

// ---------------------------------------------------------------------------------------------
// The rule table: what happens for (source level, cause, interrupt routing, interrupt mask).
// ---------------------------------------------------------------------------------------------

/** Vector-table offset (ARM ARM "Vector tables"). `ownSp`: the source runs on SP_ELx. */
export function vectorOffset({ from, to, ownSp, async }) {
  let group;
  if (from < to) group = 0x400; // from a lower level running AArch64
  else if (from === to) group = ownSp ? 0x200 : 0x000;
  else throw new RangeError("an exception is never taken to a lower level");
  return group + (async ? 0x80 : 0x000);
}

export function vectorWhy(offset) {
  const g = offset & ~0x80;
  const where =
    g === 0x400 ? "from a lower level" : g === 0x200 ? "at the same level, on its own stack pointer" : "at the same level, on SP_EL0";
  return `${offset & 0x80 ? "interrupt (IRQ)" : "synchronous"}, ${where}`;
}

/** The trigger: `asm` is only assembly (shown as code); `note` is plain text beside it. */
function instruction(src, cause) {
  if (cause === "svc") return { asm: "svc #0", note: "" };
  if (cause === "hvc") return { asm: "hvc #0", note: "" };
  if (cause === "dabt") return { asm: "ldr x1, [x0]", note: `with x0 = ${hex(MACHINE.unmappedVa)}` };
  if (cause === "dabt2") return { asm: "ldr x1, [x0]", note: `with x0 = ${hex(MACHINE.unmappedIpa)}` };
  return { asm: "add x2, x2, #1", note: src === 0 ? "the app's next instruction" : "the kernel's next instruction" };
}

/**
 * Plan the exception for a configuration, without changing any state. Returns
 * `{ pending: true, ... }` when the interrupt is masked and nothing happens yet.
 */
export function plan({ src, cause, irqTo = 1, masked = false }) {
  if (!SOURCES.includes(src)) throw new RangeError(`bad source level ${src}`);
  if (!CAUSES.includes(cause)) throw new RangeError(`bad cause ${cause}`);
  const pc = src === 0 ? MACHINE.appPc : MACHINE.kernelPc;
  // The mask only exists in the one configuration where its control is shown.
  const useMask = masked && cause === "irq" && src === 1;
  const pstate = src === 0 ? MACHINE.appPstate : useMask ? MACHINE.kernelPstateMasked : MACHINE.kernelPstate;
  const ownSp = decodePstate(pstate).ownSp;
  const ins = instruction(src, cause);
  const base = { src, cause, pc, pstate, instr: ins.asm, instrNote: ins.note };
  let p;
  switch (cause) {
    case "svc":
      p = {
        target: 1, async: false, elr: pc + 4, esr: makeEsr({ ec: 0x15, iss: 0 }), far: undefined,
        reason: "svc, number 0", returnWhy: "after the svc: a call continues", rule: "continue",
      };
      break;
    case "hvc":
      if (src === 0) {
        p = {
          target: 1, async: false, elr: pc, esr: makeEsr({ ec: 0x00 }), far: undefined,
          reason: "unknown reason: hvc is not allowed at EL0, so it is an undefined instruction",
          returnWhy: "the hvc itself: an undefined instruction is reported where it stands", rule: "retry",
        };
      } else {
        p = {
          target: 2, async: false, elr: pc + 4, esr: makeEsr({ ec: 0x16, iss: 0 }), far: undefined,
          reason: "hvc, number 0", returnWhy: "after the hvc: a call continues", rule: "continue",
        };
      }
      break;
    case "dabt":
      p = {
        target: 1, async: false, elr: pc,
        // ISV = 0: no instruction syndrome for a fault taken to EL1 here (compare ESR_EL1 = 0x96000021
        // captured in chapter 06's self-fault). DFSC 0b000111: translation fault, level 3.
        esr: makeEsr({ ec: src === 0 ? 0x24 : 0x25, iss: dataAbortIss({ dfsc: 0x07 }) }),
        far: MACHINE.unmappedVa,
        reason: "data abort: translation fault (no page at that address)",
        returnWhy: "the load itself: a fault retries", rule: "retry",
      };
      break;
    case "dabt2":
      p = {
        target: 2, async: false, elr: pc,
        // A stage-2 fault reported to EL2 carries a valid instruction syndrome: a 64-bit load into
        // x1 (ISV=1, SAS=3, SRT=1, SF=1), DFSC 0b000110 (translation fault, level 2), as HVF reports
        // for a hole in the guest's memory map.
        esr: makeEsr({ ec: 0x24, iss: dataAbortIss({ isv: true, sas: 3, srt: 1, sf: true, dfsc: 0x06 }) }),
        far: MACHINE.unmappedIpa,
        reason: "data abort: the VMM never mapped that guest memory (a load of 8 bytes into x1)",
        returnWhy: "the load itself: a fault retries", rule: "retry",
      };
      break;
    case "irq": {
      const target = irqTo === 2 ? 2 : 1;
      // An interrupt aimed at the current level is held back by PSTATE.I; one aimed at a higher
      // level (EL2) is not (ARM ARM, "Asynchronous exception masking").
      if (src === 1 && target === 1 && useMask) {
        return { ...base, pending: true, target: 1, async: true, irqTo: target };
      }
      p = {
        target, async: true, elr: pc, esr: undefined, far: undefined,
        reason: "not written: an interrupt has no reason code; the handler asks the interrupt controller",
        returnWhy: "the first instruction not yet run: the program resumes unharmed", rule: "resume",
      };
      break;
    }
  }
  const offset = vectorOffset({ from: src, to: p.target, ownSp, async: p.async });
  const vectorPc = p.target === 1 ? MACHINE.vbarEl1 + offset : `VBAR_EL2 + ${hex(offset)}`;
  // Entry changes the level, the stack choice and the masks; the condition flags carry over.
  const newPstate = encodePstate({
    el: p.target, ownSp: true, flags: decodePstate(pstate).flags, daif: { D: true, A: true, I: true, F: true },
  });
  return { ...base, ...p, pending: false, irqTo: irqTo === 2 ? 2 : 1, offset, vectorPc, newPstate };
}

// ---------------------------------------------------------------------------------------------
// State machine. State is one plain object; step() returns a new one.
// ---------------------------------------------------------------------------------------------

const emptyRegs = () => ({ elr: null, spsr: null, esr: null, far: null });

export function initialState(opts = {}) {
  const src = SOURCES.includes(opts.src) ? opts.src : 0;
  const cause = CAUSES.includes(opts.cause) ? opts.cause : "svc";
  const irqTo = opts.irqTo === 2 ? 2 : 1;
  // The mask control is shown only for an IRQ at EL1; elsewhere it is always off, so a hidden
  // control can never change what the learner sees.
  const masked = opts.masked === true && cause === "irq" && src === 1;
  const names = opts.names === true;
  const p = plan({ src, cause, irqTo, masked });
  return {
    src, cause, irqTo, masked, names,
    phase: "before", // before | taken | pending | returned
    cpu: { pc: p.pc, pstate: p.pstate },
    regs: { 1: emptyRegs(), 2: emptyRegs() },
    start: { pc: p.pc, pstate: p.pstate },
  };
}

export function canTake(s) { return s.phase === "before"; }
export function canEret(s) { return s.phase === "taken"; }

/** next = step(state, action). Unknown actions return the state unchanged. */
export function step(s, action) {
  if (!action || typeof action !== "object") return s;
  const cfg = { src: s.src, cause: s.cause, irqTo: s.irqTo, masked: s.masked, names: s.names };
  switch (action.type) {
    case "setSource": return SOURCES.includes(action.el) ? initialState({ ...cfg, src: action.el }) : s;
    case "setCause": return CAUSES.includes(action.cause) ? initialState({ ...cfg, cause: action.cause }) : s;
    case "setIrqTo": return action.el === 1 || action.el === 2 ? initialState({ ...cfg, irqTo: action.el }) : s;
    case "setMasked": {
      const next = initialState({ ...cfg, masked: action.on === true });
      // Clearing PSTATE.I with an IRQ pending: the CPU takes it at once (before the next
      // instruction), so go straight to the taken state instead of asking for another Step.
      return s.phase === "pending" && action.on !== true ? step(next, { type: "take" }) : next;
    }
    case "setNames": return { ...s, names: action.on === true };
    case "reset": return initialState(cfg);
    case "take": {
      if (!canTake(s)) return s;
      const p = plan(cfg);
      if (p.pending) return { ...s, phase: "pending" };
      const old = s.regs[p.target];
      const regs = {
        ...s.regs,
        [p.target]: {
          elr: p.elr,
          spsr: s.cpu.pstate,
          esr: p.esr === undefined ? old.esr : p.esr,
          far: p.far === undefined ? old.far : p.far,
        },
      };
      return { ...s, phase: "taken", cpu: { pc: p.vectorPc, pstate: p.newPstate }, regs };
    }
    case "eret": {
      if (!canEret(s)) return s;
      const el = decodePstate(s.cpu.pstate).el;
      const r = s.regs[el];
      if (!r || r.elr === null || r.spsr === null) return s;
      return { ...s, phase: "returned", cpu: { pc: r.elr, pstate: r.spsr } };
    }
    default:
      return s;
  }
}

// ---------------------------------------------------------------------------------------------
// Presentation helpers (pure, so they are tested too).
// ---------------------------------------------------------------------------------------------

export function hex(n) {
  if (typeof n === "string") return n;
  return `0x${(n >>> 0).toString(16)}`;
}

/** Fixed-width hex, e.g. hexPad(0x2000000, 8) = "0x02000000" (ESR is shown as 32 bits). */
export function hexPad(n, digits) {
  return `0x${(n >>> 0).toString(16).padStart(digits, "0")}`;
}

/** Plain-language mode description for names-off, e.g. "EL1, interrupts and other exceptions switched off". */
export function plainPstate(value) {
  const d = decodePstate(value);
  if (!d.ok) return "not a mode this lab uses";
  const m = Object.values(d.daif).filter(Boolean).length;
  const masks = m === 4 ? "interrupts and other exceptions switched off"
    : d.daif.I && m === 1 ? "interrupts switched off"
      : m === 0 ? "interrupts allowed" : "some exceptions switched off";
  const flags = Object.values(d.flags).some(Boolean) ? ", a result flag from earlier arithmetic set" : "";
  return `EL${d.el}, ${masks}${flags}`;
}

/** A PC for display: EL2's table base is unknown to us, so it is symbolic; named only with names on. */
export function pcText(pc, names) {
  if (typeof pc === "string") return names ? pc : pc.replace("VBAR_EL2", "Apple's table");
  return hex(pc);
}

const RULE_TEXT = Object.freeze({
  continue: "Call versus retry: this is a call, so return after it.",
  retry: "Call versus retry: this is a fault, so retry it.",
  resume: "Call versus retry: an interrupt is neither; resume where it stopped.",
});

function regName(kind, el) {
  return { elr: "ELR", spsr: "SPSR", esr: "ESR", far: "FAR" }[kind] + `_EL${el}`;
}

function levelOf(pstate) {
  return `EL${decodePstate(pstate).el}`;
}

/**
 * The state panel: one row per label, with the value at the start and now, and whether it
 * changed in the last step. `regEl` is the level whose ELR/SPSR/ESR/FAR are shown: the level
 * that takes (or would take) the exception.
 */
export function rows(s) {
  const p = plan(s);
  const el = p.target;
  const r = s.regs[el];
  const atStart = s.phase === "before";
  const unknown = "?";
  const out = [];
  out.push({
    key: "mode", label: "mode", reg: "PSTATE",
    before: levelOf(s.start.pstate), now: levelOf(s.cpu.pstate),
    detail: s.names ? `${describePstate(s.cpu.pstate)}  (PSTATE ${hex(s.cpu.pstate)})` : plainPstate(s.cpu.pstate),
  });
  let pcNote = "";
  if (s.phase === "taken") pcNote = el === 1 ? `table + ${hex(p.offset)}` : `Apple's table + ${hex(p.offset)}`;
  else if (s.phase === "returned") pcNote = "the saved return address";
  else pcNote = s.cause === "irq" ? "an interrupt can arrive here" : "the instruction about to run";
  out.push({ key: "pc", label: "PC", reg: "PC", before: hex(s.start.pc), now: pcText(s.cpu.pc, s.names), detail: pcNote });
  out.push({
    key: "elr", label: "saved return address", reg: regName("elr", el),
    before: unknown, now: r.elr === null ? unknown : hex(r.elr),
    detail: r.elr === null ? "" : p.returnWhy,
  });
  out.push({
    key: "spsr", label: "saved mode", reg: regName("spsr", el),
    before: unknown, now: r.spsr === null ? unknown : `${levelOf(r.spsr)} and its flags`,
    detail: r.spsr === null ? "" : s.names ? `${describePstate(r.spsr)}  (${hex(r.spsr)})` : plainPstate(r.spsr),
  });
  let reasonNow = unknown;
  let reasonDetail = "";
  if (r.esr !== null) {
    const f = esrFields(r.esr);
    reasonNow = p.cause === "irq" ? unknown : p.reason;
    reasonDetail = s.names ? `${hexPad(r.esr, 8)}: class ${hexPad(f.ec, 2)} in bits 31..26 (${EC_NAME[f.ec] ?? "other"})` : "";
  } else if (!atStart && p.cause === "irq" && s.phase !== "pending") {
    reasonDetail = "not written: " + p.reason.replace(/^not written: /, "");
  }
  out.push({ key: "esr", label: "reason", reg: regName("esr", el), before: unknown, now: reasonNow, detail: reasonDetail });
  let farDetail = "";
  if (!atStart && s.phase !== "pending" && r.far === null) farDetail = "not a fault";
  else if (r.far !== null) farDetail = "the address the load used";
  out.push({
    key: "far", label: "fault address", reg: regName("far", el),
    before: unknown, now: r.far === null ? unknown : hex(r.far), detail: farDetail,
  });
  // "changed" compares with the previous phase: before -> taken, taken -> returned.
  const prev = previousState(s);
  if (prev) {
    const prevRows = rowsNoChange(prev);
    for (let i = 0; i < out.length; i++) out[i].changed = out[i].now !== prevRows[i].now;
  } else {
    for (const row of out) row.changed = false;
  }
  return out;
}

function rowsNoChange(s) {
  const p = plan(s);
  const r = s.regs[p.target];
  return [
    { now: levelOf(s.cpu.pstate) }, { now: pcText(s.cpu.pc, s.names) },
    { now: r.elr === null ? "?" : hex(r.elr) }, { now: r.spsr === null ? "?" : `${levelOf(r.spsr)} and its flags` },
    { now: r.esr === null || p.cause === "irq" ? "?" : p.reason }, { now: r.far === null ? "?" : hex(r.far) },
  ];
}

function previousState(s) {
  const cfg = { src: s.src, cause: s.cause, irqTo: s.irqTo, masked: s.masked, names: s.names };
  if (s.phase === "taken" || s.phase === "pending") return initialState(cfg);
  if (s.phase === "returned") return step(initialState(cfg), { type: "take" });
  return null;
}

/** One plain-text summary sentence for the live region. */
export function summary(s) {
  const p = plan(s);
  const who = s.src === 0 ? "The app at EL0" : "The kernel at EL1";
  if (s.phase === "before") {
    return p.cause === "irq"
      ? `${who} is about to run ${hex(p.pc)}. Step to let a timer interrupt arrive.`
      : `${who} is about to run ${p.instr} at ${hex(p.pc)}. Step to take the exception.`;
  }
  if (s.phase === "pending") {
    return "Nothing happened: the kernel has switched interrupts off, so the interrupt waits. Untick the mask to let it in: it is taken at once.";
  }
  if (s.phase === "taken") {
    const kind = p.async ? "An asynchronous exception (an interrupt)" : "A synchronous exception";
    return `${kind}, taken to EL${p.target}. PC is now ${pcText(p.vectorPc, s.names)}; saved return address ${hex(p.elr)} (${p.returnWhy}).`;
  }
  return `ERET: back to ${levelOf(s.cpu.pstate)} at ${hex(s.cpu.pc)}, the saved return address.`;
}

/** Extra explanation lines for the current phase (plain text). Register names only when s.names. */
export function notes(s) {
  const p = plan(s);
  const n = s.names;
  const out = [];
  if (p.pending) {
    out.push("An interrupt aimed at the level that is running waits while that level has interrupts switched off. The kernel switches them back on when it is ready, and then the interrupt is taken.");
    return out;
  }
  out.push(RULE_TEXT[p.rule]);
  out.push(`${p.async ? "Asynchronous: caused by something outside the instruction stream." : "Synchronous: caused by the instruction itself."} Taken to EL${p.target}.`);
  const why = vectorWhy(p.offset);
  if (n) out.push(`Vector entry: ${p.target === 1 ? "VBAR_EL1" : "VBAR_EL2"} + ${hex(p.offset)} (${why}).`);
  else out.push(`Handler entry: ${p.target === 1 ? "the kernel's" : "Apple's"} table + ${hex(p.offset)} (${why.replace(/, on (its own stack pointer|SP_EL0)$/, "")}).`);
  if (s.src === 1 && p.target === 1 && p.cause === "svc") {
    out.push("svc always goes to EL1. The kernel is already at EL1, so the exception stays at the same level and uses the same-level part of the table (+0x200) instead of the from-a-lower-level part (+0x400).");
  } else if (s.src === 1 && p.target === 1 && p.cause === "dabt") {
    out.push("A fault in the kernel's own code is taken by the kernel itself: it stays at EL1 and uses the same-level part of the table (+0x200) instead of the from-a-lower-level part (+0x400).");
  }
  if (s.phase === "taken" && decodePstate(p.pstate).flags.Z) {
    out.push(n
      ? "The condition flags (here Z) are carried over into the new PSTATE; only the level, stack choice and D A I F masks change."
      : "The result flags from earlier arithmetic are carried over; only the level and the switched-off interrupts change.");
  }
  if (p.target === 2) {
    const forward = p.async
      ? (n ? "when it forwards an exception, hv_vcpu_run returns to our VMM; an interrupt brings no syndrome."
        : "when it passes an exception on, our VMM's call that runs the guest returns; an interrupt brings no reason code.")
      : (n ? "when it forwards an exception, hv_vcpu_run returns to our VMM with the syndrome."
        : "when it passes an exception on, our VMM's call that runs the guest returns, carrying the reason code.");
    out.push(`On a Mac the software at EL2 is Apple's, not ours. It owns ${n ? "VBAR_EL2" : "that table"}; ${forward}`);
    if (p.cause === "hvc") {
      out.push(n
        ? `Sitting B of this chapter sees exactly this: syndrome ${hexPad(p.esr, 8)}, class 0x16, and the PC already after the hvc.`
        : "Sitting B of this chapter sees exactly this: the reason is hvc, and the PC is already after the hvc.");
    }
    if (p.cause === "dabt2") {
      out.push("The VMM either emulates the load and moves the PC past it itself, or stops the guest.");
      out.push(n
        ? "Here the guest's own translation is off (or identity), so the address the load used is also the guest-physical address. In general FAR_EL2 holds the virtual address and HPFAR_EL2 the guest-physical page (chapter 05)."
        : "Here the guest's own address translation is off, so the address the load used is also the guest-physical address. In general the two differ, and the CPU reports both (chapter 05).");
    }
    if (p.cause === "irq") out.push("Whether Apple's software then returns to our VMM is its choice (chapters 11 and 12).");
  }
  if (s.src === 1 && p.cause === "irq" && p.target === 2 && s.masked) {
    out.push(`The kernel's interrupt mask${n ? " (PSTATE.I)" : ""} does not hold back an interrupt aimed at EL2.`);
  }
  if (s.phase === "returned") {
    out.push("ERET changes only the PC and the mode; the saved registers keep their values until the next exception.");
    if (p.rule === "retry") {
      out.push("ERET retries the same instruction. Unless the handler fixed the cause (mapped the page, or emulated the load and moved the PC on), it faults again.");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Share state in the URL hash: tokens joined by "-", e.g. "s0-csvc-p1-n0".
// s<0|1> source, c<cause>, r<1|2> IRQ routing, m<0|1> mask, p<0..3> phase, n<0|1> names.
// Unknown or malformed tokens are ignored; the result is always a valid state.
// ---------------------------------------------------------------------------------------------
const PHASES = ["before", "taken", "pending", "returned"];

export function encodeHash(s) {
  return [`s${s.src}`, `c${s.cause}`, `r${s.irqTo}`, `m${s.masked ? 1 : 0}`, `p${PHASES.indexOf(s.phase)}`, `n${s.names ? 1 : 0}`].join("-");
}

export function decodeHash(str) {
  const opts = {};
  let phase = 0;
  if (typeof str === "string" && str.length <= 64) {
    for (const tok of str.split("-")) {
      const k = tok[0];
      const v = tok.slice(1);
      if (k === "s" && (v === "0" || v === "1")) opts.src = Number(v);
      else if (k === "c" && CAUSES.includes(v)) opts.cause = v;
      else if (k === "r" && (v === "1" || v === "2")) opts.irqTo = Number(v);
      else if (k === "m" && (v === "0" || v === "1")) opts.masked = v === "1";
      else if (k === "n" && (v === "0" || v === "1")) opts.names = v === "1";
      else if (k === "p" && /^[0-3]$/.test(v)) phase = Number(v);
    }
  }
  let s = initialState(opts);
  if (phase >= 1) s = step(s, { type: "take" });
  if (phase === 3) s = step(s, { type: "eret" });
  return s;
}

export { modeName };
