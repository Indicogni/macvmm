// smp-boot-timeline: the model. Pure logic, no DOM (course/site/LABS.md section 3).
//
// A port of the parts of the reference VMM that decide how a secondary CPU starts:
//   - `mpidr(index)` from crates/vmm/src/arch/regs.rs (Aff1 = index / 16, Aff0 = index % 16, bit 31);
//   - the PSCI power table from crates/vmm/src/psci.rs: `index_of`, `cpu_on`, `affinity_info`,
//     `cpu_off` and the mailbox take (`Target::take`), with the same checks in the same order;
//   - `entry_valid` from crates/vmm/src/smccc.rs (4-byte aligned and 4 bytes inside RAM);
//   - `Vcpu::power_on` from crates/vmm/src/vcpu/mod.rs (PC = entry, x0 = context, x1..x3 = 0,
//     CPSR = 0x3c5, MMU and caches off);
//   - the stop: SYSTEM_OFF or SYSTEM_RESET ends the run, every running vCPU leaves the guest with
//     one `canceled` exit, every parked one is woken and ends without running.
// Chapter 20 ("SMP: many vCPUs, many threads") is the lesson; the scripted scenarios replay its
// captures (captures/20-race-trace.txt, 20-smp-race.txt, 20-linux-smp-log.txt, the two
// deliberate breakages) and its nine-call paper exercise. model.test.mjs checks them against
// the capture files and the lesson text.

// --- constants -------------------------------------------------------------------------------

/** The affinity fields a PSCI target may use: Aff3 (39:32) and Aff2..Aff0 (23:0). */
export const AFFINITY_MASK = 0xff_00ff_ffffn;
export const RAM_BASE = 0x4000_0000n;
export const RAM_SIZE = 64n * 1024n * 1024n;
/** The first redistributor frame and the stride (our layout: 0x080A_0000 + index x 128 KiB). */
export const GICR_BASE = 0x080a_0000n;
export const GICR_STRIDE = 0x2_0000n;
/** EL1h with D, A, I and F masked: the state every CPU starts in (chapter 06). */
export const CPSR_BOOT = 0x3c5n;
/** PSCI_VERSION's answer: version 1.1. */
export const PSCI_VERSION_1_1 = 0x1_0001n;
/** MIGRATE_INFO_TYPE 2: no trusted OS that needs migrating. */
export const MIGRATE_NO_TRUSTED_OS = 2n;
export const MIN_CPUS = 2;
/** arch::layout::MAX_CPUS: 64 (model.test.mjs re-reads it from layout.rs). */
export const MAX_CPUS = 64;
export const MAX_ACTIONS = 64;

/** PSCI return codes (Arm DEN 0022 section 5.2.2). */
export const CODE = Object.freeze({
  SUCCESS: 0, NOT_SUPPORTED: -1, INVALID_PARAMETERS: -2, DENIED: -3, ALREADY_ON: -4,
  ON_PENDING: -5, INTERNAL_FAILURE: -6, NOT_PRESENT: -7, DISABLED: -8, INVALID_ADDRESS: -9,
});
const CODE_NAME = new Map(Object.entries(CODE).map(([k, v]) => [v, k]));

/** The name of a PSCI return code, or "" if it has none. */
export function codeName(c) {
  return CODE_NAME.get(c) || "";
}

/**
 * What Linux makes of a refused `CPU_ON` (psci_to_linux_errno in drivers/firmware/psci/psci.c):
 * NOT_SUPPORTED is -EOPNOTSUPP (-95), INVALID_PARAMETERS and INVALID_ADDRESS are -EINVAL (-22),
 * DENIED is -EPERM (-1). Anything else is -EINVAL too.
 */
export function linuxErrno(code) {
  if (code === CODE.NOT_SUPPORTED) return -95;
  if (code === CODE.DENIED) return -1;
  return -22;
}

/** AFFINITY_INFO's answer for a power state: 0 on, 1 off, 2 on pending. */
export const AFFINITY = Object.freeze({ on: 0, off: 1, pending: 2 });
export const POWER_LABEL = Object.freeze({ on: "on", off: "off", pending: "on pending" });

/** The three breakage settings of chapter 20. */
export const BREAKS = Object.freeze({
  ok: "none: one MPIDR per vCPU, everywhere",
  dup: "breakage 1: every vCPU (register and power table) gets vCPU 0's MPIDR",
  reg: "breakage 2: only the register lies (every vCPU's MPIDR_EL1 reads vCPU 0's value)",
});

// --- number formatting -----------------------------------------------------------------------

/** Lower-case hex with 0x, no separators: Rust's `{:#x}`. */
export function hx(v) {
  return "0x" + BigInt.asUintN(64, BigInt(v)).toString(16);
}

/** Hex with `_` every four digits, as the lesson writes addresses (0x4008_0000), zero-padded to `minDigits`. */
export function hxu(v, minDigits = 1) {
  const s = BigInt.asUintN(64, BigInt(v)).toString(16).padStart(minDigits, "0");
  const out = [];
  for (let i = s.length; i > 0; i -= 4) out.unshift(s.slice(Math.max(0, i - 4), i));
  return "0x" + out.join("_");
}

/** A PSCI result as the guest reads it in x0: the signed code and the 64-bit register value. */
export function codeText(c) {
  const n = codeName(c);
  return `${c}${n ? " " + n : ""}`;
}

/**
 * Parse a 64-bit value typed by the reader: hex (0x prefix optional when it has a-f), or decimal
 * with no prefix. `_` and spaces are ignored. At most 16 hex or 20 decimal digits.
 */
export function parseU64(text, { hexDefault = true } = {}) {
  if (typeof text !== "string") return { ok: false, error: "no text" };
  const s = text.trim().replace(/[_\s]/g, "").toLowerCase();
  if (s === "") return { ok: false, error: "empty" };
  if (s.length > 22) return { ok: false, error: "too long" };
  let m = /^0x([0-9a-f]{1,16})$/.exec(s);
  if (m) return { ok: true, value: BigInt("0x" + m[1]) };
  if (hexDefault) {
    m = /^([0-9a-f]{1,16})$/.exec(s);
    if (m) return { ok: true, value: BigInt("0x" + m[1]) };
  } else {
    m = /^([0-9]{1,20})$/.exec(s);
    if (m) {
      const v = BigInt(m[1]);
      if (v > 0xffff_ffff_ffff_ffffn) return { ok: false, error: "more than 64 bits" };
      return { ok: true, value: v };
    }
  }
  return { ok: false, error: "not a hex number" };
}

// --- the machine -----------------------------------------------------------------------------

/** `MPIDR_EL1` for vCPU `index` (a port of `arch::regs::mpidr`). */
export function mpidr(index) {
  const i = BigInt(index);
  return (1n << 31n) | (((i / 16n) & 0xffn) << 8n) | (i % 16n);
}

/** The redistributor frame HVF gives the k-th vCPU created (our layout's invariant). */
export function gicrFrame(index) {
  return GICR_BASE + BigInt(index) * GICR_STRIDE;
}

/** Linux's spelling of a hardware CPU ID, as in "Booted secondary processor 0x0000000001". */
export function linuxHwid(aff) {
  return "0x" + BigInt.asUintN(64, aff).toString(16).padStart(10, "0");
}

/** The address as GICv3's boot line prints it: "region 0:0x00000000080c0000". */
export function linuxRegion(addr) {
  return "0x" + addr.toString(16).padStart(16, "0");
}

/**
 * A fresh machine: `cpus` vCPUs, all created at startup in index order. vCPU 0 is on and running
 * (released by the start gate); every other one is off, its thread parked.
 */
export function makeMachine(cpus = 4, brk = "ok") {
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > MAX_CPUS) throw new Error("bad CPU count");
  if (!(brk in BREAKS)) throw new Error("bad breakage");
  const vcpus = [];
  for (let i = 0; i < cpus; i++) {
    const right = mpidr(i);
    vcpus.push({
      index: i,
      dt: right & AFFINITY_MASK, // the device tree's cpu@N reg: never changed by either breakage
      table: brk === "dup" ? mpidr(0) : right, // the power table's row
      reg: brk === "ok" ? right : mpidr(0), // what MPIDR_EL1 reads on that vCPU
      power: i === 0 ? "on" : "off",
      mailbox: null,
      thread: i === 0 ? "running" : "parked",
      regs: i === 0 ? { pc: null, x: [null, null, null, null], cpsr: CPSR_BOOT, mmu: false } : null,
      seen: null, // the MPIDR this vCPU has read from its own register, once it has
      exits: { hvc: 0, canceled: 0 },
    });
  }
  return { cpus, brk, ramBase: RAM_BASE, ramSize: RAM_SIZE, vcpus, stopped: null };
}

function clone(m) {
  return {
    ...m,
    vcpus: m.vcpus.map((v) => ({
      ...v,
      mailbox: v.mailbox ? { ...v.mailbox } : null,
      regs: v.regs ? { ...v.regs, x: [...v.regs.x] } : null,
      exits: { ...v.exits },
    })),
    stopped: m.stopped ? { ...m.stopped } : null,
  };
}

/**
 * `entry_valid`: 4-byte aligned and the 4 bytes at it inside guest RAM. `null` stands for an
 * entry point the captures do not show (Linux's secondary entry), which was valid.
 */
export function entryCheck(m, entry) {
  if (entry === null) return { ok: true };
  if (entry % 4n !== 0n) return { ok: false, why: `${hxu(entry)} is not 4-byte aligned` };
  const end = m.ramBase + m.ramSize;
  if (entry < m.ramBase || entry + 4n > end) {
    return { ok: false, why: `${hxu(entry)} is outside RAM (${hxu(m.ramBase)} to ${hxu(end - 1n)})` };
  }
  return { ok: true };
}

/** `index_of`: the vCPU whose power-table row has this affinity, or the reason there is none. */
export function indexOf(m, target) {
  const extra = target & ~AFFINITY_MASK;
  if (extra !== 0n) {
    const bit31 = (extra >> 31n) & 1n ? " (bit 31 included: the device tree's reg never carries it)" : "";
    return { index: null, why: `${hxu(target)} has bits outside the affinity fields${bit31}` };
  }
  const rows = m.vcpus.filter((v) => (v.table & AFFINITY_MASK) === target);
  if (rows.length === 0) {
    let why = `no row of the power table has affinity ${hx(target)}`;
    if ((target & 0xffn) > 15n) why += ` (Aff0 = ${target & 0xffn}; our layout puts at most 16 CPUs in a cluster, so Aff0 only goes up to 15)`;
    return { index: null, why };
  }
  return { index: rows[0].index, why: rows.length > 1 ? `${rows.length} rows have affinity ${hx(target)}; the first wins` : "" };
}

function caller(m, from) {
  const v = m.vcpus[from];
  if (!v) return { error: `there is no vCPU ${from}` };
  if (m.stopped) return { error: "the machine has stopped" };
  if (v.thread !== "running") return { error: `vCPU ${from} is not running guest code, so it cannot make a call` };
  return { v };
}

/**
 * Apply one action. Returns `{ m, ev }` with a new machine and an event for the timeline, or
 * `{ error }` (and no change) if the action is not possible in this state.
 *
 * Actions: `{t:"on", from, target, entry, ctx}` CPU_ON; `{t:"ai", from, target, level}`
 * AFFINITY_INFO; `{t:"off", from}` CPU_OFF; `{t:"take", cpu}` a parked thread takes its
 * mailbox and enters the guest; `{t:"read", cpu}` a running CPU reads its own MPIDR_EL1;
 * `{t:"call", from, fn}` PSCI_VERSION or PSCI_MIGRATE_INFO_TYPE; `{t:"sysoff", from}` and
 * `{t:"reset", from}` SYSTEM_OFF and SYSTEM_RESET.
 */
export function apply(m0, a) {
  const m = clone(m0);
  switch (a.t) {
    case "on": {
      const c = caller(m, a.from);
      if (c.error) return { error: c.error };
      c.v.exits.hvc++;
      const call = `CPU_ON(${hx(a.target)}, ${a.entry === null ? "Linux's secondary entry" : hxu(a.entry)}, ${hx(a.ctx)})`;
      const ev = { lane: a.from, kind: "call", fn: "PSCI_CPU_ON", call };
      // The order of psci::cpu_on: find the target, then check the entry, then the state.
      const found = indexOf(m, a.target);
      if (found.index === null) return { m, ev: { ...ev, code: CODE.INVALID_PARAMETERS, why: found.why } };
      const entry = entryCheck(m, a.entry);
      if (!entry.ok) return { m, ev: { ...ev, code: CODE.INVALID_ADDRESS, why: entry.why } };
      const t = m.vcpus[found.index];
      ev.target = t.index;
      if (t.power === "on") return { m, ev: { ...ev, code: CODE.ALREADY_ON, why: `vCPU ${t.index}'s thread has already taken its request` } };
      if (t.power === "pending") return { m, ev: { ...ev, code: CODE.ON_PENDING, why: `vCPU ${t.index}'s request is accepted but its thread has not taken it yet` } };
      t.power = "pending";
      t.mailbox = { entry: a.entry, ctx: a.ctx };
      const extra = found.why ? `; ${found.why}` : "";
      return { m, ev: { ...ev, code: CODE.SUCCESS, why: `vCPU ${t.index} was off: now on pending, the request in its mailbox, its thread woken${extra}` } };
    }
    case "ai": {
      const c = caller(m, a.from);
      if (c.error) return { error: c.error };
      c.v.exits.hvc++;
      const ev = { lane: a.from, kind: "call", fn: "PSCI_AFFINITY_INFO", call: `AFFINITY_INFO(${hx(a.target)}, ${a.level})`, hidden: true };
      if (a.level !== 0n && a.level !== 0) return { m, ev: { ...ev, code: CODE.INVALID_PARAMETERS, why: `level ${a.level} asks about a group of CPUs; we answer only level 0` } };
      const found = indexOf(m, a.target);
      if (found.index === null) return { m, ev: { ...ev, code: CODE.INVALID_PARAMETERS, why: found.why } };
      const p = m.vcpus[found.index].power;
      return { m, ev: { ...ev, code: AFFINITY[p], target: found.index, why: `vCPU ${found.index} is ${POWER_LABEL[p]}`, info: true } };
    }
    case "off": {
      const c = caller(m, a.from);
      if (c.error) return { error: c.error };
      if (c.v.power !== "on") return { error: `vCPU ${a.from} is not on` };
      c.v.exits.hvc++;
      c.v.power = "off";
      c.v.mailbox = null;
      c.v.thread = "parked";
      c.v.regs = null;
      c.v.seen = null;
      const ev = { lane: a.from, kind: "call", fn: "PSCI_CPU_OFF", call: "CPU_OFF()", why: `vCPU ${a.from} is off; its thread parks again, alive, waiting for the next CPU_ON` };
      // psci::all_off: every row Off (a pending one still counts as alive). The run loop warns.
      if (m.vcpus.every((v) => v.power === "off")) {
        ev.allOff = true;
        ev.why += ". Every vCPU is now off and no one is left to call CPU_ON, so the VM idles until it is stopped (--timeout or Ctrl-C)";
        ev.stderr = [`macvmm: warn: [vcpu${a.from}] guest: vcpu${a.from}: CPU_OFF: every vCPU is now off; the VM idles until it is stopped`];
      }
      return { m, ev };
    }
    case "take": {
      const v = m.vcpus[a.cpu];
      if (!v) return { error: `there is no vCPU ${a.cpu}` };
      if (m.stopped) return { error: "the machine has stopped" };
      if (v.thread !== "parked" || v.power !== "pending" || !v.mailbox) return { error: `vCPU ${a.cpu} has no request waiting in its mailbox` };
      const on = v.mailbox;
      v.mailbox = null;
      v.power = "on";
      v.thread = "running";
      v.regs = { pc: on.entry, x: [on.ctx, 0n, 0n, 0n], cpsr: CPSR_BOOT, mmu: false };
      return { m, ev: { lane: a.cpu, kind: "take", call: "takes its mailbox", why: `now on; enters the guest at ${on.entry === null ? "Linux's secondary entry" : hxu(on.entry)} with x0 = ${hx(on.ctx)}, x1 to x3 = 0, CPSR 0x3c5 (EL1h, interrupts masked), MMU and caches off` } };
    }
    case "read": {
      const v = m.vcpus[a.cpu];
      if (!v) return { error: `there is no vCPU ${a.cpu}` };
      if (m.stopped) return { error: "the machine has stopped" };
      if (v.thread !== "running") return { error: `vCPU ${a.cpu} is not running guest code` };
      v.seen = v.reg;
      const agrees = (v.reg & AFFINITY_MASK) === v.dt;
      return {
        m,
        ev: {
          lane: a.cpu, kind: "read", call: "mrs MPIDR_EL1", value: v.reg, mismatch: !agrees,
          why: agrees ? `reads ${hx(v.reg)}, the affinity its cpu@ node in the device tree says (${hx(v.dt)})`
            : `reads ${hx(v.reg)}, but the device tree (and Linux's table) say this CPU is ${hx(v.dt)}: it believes it is CPU ${hx(v.reg & AFFINITY_MASK)}`,
        },
      };
    }
    case "call": {
      const c = caller(m, a.from);
      if (c.error) return { error: c.error };
      c.v.exits.hvc++;
      if (a.fn === "PSCI_VERSION") return { m, ev: { lane: a.from, kind: "call", fn: a.fn, call: "PSCI_VERSION()", value: PSCI_VERSION_1_1, why: "x0 = 0x10001: PSCI 1.1" } };
      if (a.fn === "PSCI_MIGRATE_INFO_TYPE") return { m, ev: { lane: a.from, kind: "call", fn: a.fn, call: "MIGRATE_INFO_TYPE()", value: MIGRATE_NO_TRUSTED_OS, why: "x0 = 2: no trusted OS to migrate" } };
      return { error: `unknown call ${a.fn}` };
    }
    case "sysoff":
    case "reset": {
      const c = caller(m, a.from);
      if (c.error) return { error: c.error };
      c.v.exits.hvc++;
      const canceled = [];
      const woken = [];
      for (const v of m.vcpus) {
        if (v.index === a.from) { v.thread = "stopped"; continue; }
        if (v.thread === "running") { v.exits.canceled++; canceled.push(v.index); } else if (v.thread === "parked") woken.push(v.index);
        v.thread = "stopped";
      }
      c.v.thread = "stopped";
      m.stopped = { reason: a.t, by: a.from, canceled, woken };
      const fn = a.t === "sysoff" ? "PSCI_SYSTEM_OFF" : "PSCI_SYSTEM_RESET";
      const parts = [];
      if (canceled.length) parts.push(`the kick pulls vCPU ${canceled.join(", ")} out of the guest (one canceled exit each)`);
      if (woken.length) parts.push(`vCPU ${woken.join(", ")}, parked, ${woken.length > 1 ? "are" : "is"} woken and end${woken.length > 1 ? "" : "s"} without running`);
      return { m, ev: { lane: a.from, kind: "call", fn, call: a.t === "sysoff" ? "SYSTEM_OFF()" : "SYSTEM_RESET()", why: `the VM stops${parts.length ? ": " + parts.join("; ") : ""}${resetTail(a)}`, stops: true } };
    }
    default:
      return { error: "unknown action" };
  }
}

/**
 * What SYSTEM_RESET does after the stop depends on `--on-reset` (crates/macvmm/src/cli.rs):
 * `exit` ends the process with exit code 4; the default, `reboot`, rebuilds the machine. A scripted
 * step quoting a capture made with `--on-reset exit` sets `onReset: "exit"`.
 */
function resetTail(a) {
  if (a.t !== "reset") return "";
  if (a.onReset === "exit") return " (with --on-reset exit, as in this run: exit code 4)";
  return ". With --on-reset exit the process then ends with exit code 4; the default, reboot, rebuilds the machine instead";
}

/** The three lookups of each vCPU's identity, side by side, and whether they agree. */
export function lookups(m) {
  return m.vcpus.map((v) => {
    const tableAff = v.table & AFFINITY_MASK;
    const regAff = v.reg & AFFINITY_MASK;
    const problems = [];
    const sameRow = m.vcpus.filter((w) => (w.table & AFFINITY_MASK) === tableAff).length;
    if (tableAff !== v.dt) problems.push(`the power table says ${hx(tableAff)}${sameRow > 1 ? `, like ${sameRow - 1} other row${sameRow > 2 ? "s" : ""}` : ""}, the device tree ${hx(v.dt)}`);
    else if (sameRow > 1) {
      const first = m.vcpus.find((w) => (w.table & AFFINITY_MASK) === tableAff).index;
      problems.push(`${sameRow - 1} other row${sameRow > 2 ? "s" : ""} of the power table also claim${sameRow > 2 ? "" : "s"} ${hx(tableAff)}; the lookup (index_of) takes the first${first === v.index ? ", this one, so the others can never be addressed" : ""}`);
    }
    if (regAff !== v.dt) problems.push(`MPIDR_EL1 reads ${hx(v.reg)}, the device tree says ${hx(v.dt)}`);
    return {
      index: v.index, dt: v.dt, table: v.table, reg: v.reg, frame: gicrFrame(v.index), frameAff: regAff,
      frameGuess: m.brk !== "ok", // what the frame reports follows the register: likely, not checked
      ok: problems.length === 0, problems,
    };
  });
}

// --- scripted scenarios ---------------------------------------------------------------------

/** smp-race's secondary entry point, from the first line of captures/20-smp-race.txt. */
export const RACE_ENTRY = 0x4008_0078n;

/** The records of captures/20-race-trace.txt, in file order (model.test.mjs re-reads the file). */
export const RACE_TRACE = Object.freeze([
  { t_ns: 522500, vcpu: 0, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 528250, vcpu: 0, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 812166, vcpu: 0, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 966708, vcpu: 0, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 967083, vcpu: 1, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 972041, vcpu: 2, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 1354333, vcpu: 3, reason: "exception", pc: "0x40081c30", fn: "PSCI_CPU_OFF" },
  { t_ns: 1454208, vcpu: 0, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 1560875, vcpu: 0, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 1563916, vcpu: 0, reason: "exception", pc: "0x40081870", fn: "PSCI_CPU_ON" },
  { t_ns: 1744875, vcpu: 0, reason: "exception", pc: "0x4008188c", fn: "PSCI_SYSTEM_OFF" },
  { t_ns: 1762625, vcpu: 2, reason: "canceled", pc: "0x400811dc" },
  { t_ns: 1764583, vcpu: 3, reason: "canceled", pc: "0x40081210" },
  { t_ns: 1763208, vcpu: 1, reason: "canceled", pc: "0x400811dc" },
]);

/** The records of captures/20-mpidr-mismatch-trace.txt (PSCI_FEATURES probes hidden there too). */
export const REG_TRACE = Object.freeze([
  { t_ns: 11662958, vcpu: 0, reason: "exception", pc: "0xffff800080041338", fn: "PSCI_VERSION" },
  { t_ns: 12360791, vcpu: 0, reason: "exception", pc: "0xffff800080041338", fn: "PSCI_MIGRATE_INFO_TYPE" },
  { t_ns: 41407291, vcpu: 0, reason: "exception", pc: "0xffff800080041338", fn: "PSCI_CPU_ON" },
  { t_ns: 1046895583, vcpu: 1, reason: "exception", pc: "0xffff800080041338", fn: "PSCI_SYSTEM_RESET" },
  { t_ns: 1046934458, vcpu: 0, reason: "canceled", pc: "0xffff800080ce0a28" },
]);

const E = RACE_ENTRY;

/**
 * Each scenario: a machine and a list of steps. A step has `text` (what happens, one sentence),
 * `acts` (model actions; `as` names a result for `say`), `trace` (indices into the scenario's
 * trace records), `say` (console lines the guest prints, computed from the results), `log`
 * (Linux log lines quoted verbatim from a capture), `stderr` (the VMM's own lines, quoted) and
 * `note` (an explanation).
 */
export const SCENARIOS = Object.freeze({
  race: {
    label: "smp-race on 4 CPUs (the real trace)",
    cpus: 4, brk: "ok", traceRecs: RACE_TRACE, source: "captures/20-race-trace.txt and captures/20-smp-race.txt",
    steps: [
      { text: "vCPU 0 starts in the guest and reads its own MPIDR_EL1.", acts: [{ t: "read", cpu: 0, as: "m0" }],
        say: (v) => [`smp-race: cpu 0 mpidr=${hx(v.m0)} entry=${hx(E)}`],
        note: "Every vCPU was created at startup in index order, so redistributor frame k belongs to vCPU k. Only vCPU 0 was let through the start gate; vCPUs 1 to 3 are parked." },
      { text: "vCPU 0 checks that every secondary is off: AFFINITY_INFO for CPUs 1, 2 and 3.",
        acts: [{ t: "ai", from: 0, target: 1n, level: 0n }, { t: "ai", from: 0, target: 2n, level: 0n }, { t: "ai", from: 0, target: 3n, level: 0n }],
        note: "The capture's grep hides AFFINITY_INFO calls, so these steps have no trace line." },
      { text: "vCPU 0 calls CPU_ON for CPU 1 with context 1.", acts: [{ t: "on", from: 0, target: 1n, entry: E, ctx: 1n, as: "first" }], trace: [0] },
      { text: "vCPU 1's thread wakes and takes its mailbox.", acts: [{ t: "take", cpu: 1 }],
        note: "The mailbox is a slot only vCPU 1's thread reads: CPU_ON left the entry point and context there. In this run the thread won the race against vCPU 0's next call: 5.75 microseconds passed between the two trace lines." },
      { text: "vCPU 0 calls CPU_ON for CPU 1 again.", acts: [{ t: "on", from: 0, target: 1n, entry: E, ctx: 1n, as: "second" }], trace: [1],
        say: (v) => [`smp-race: cpu_on(1) first=${v.first} second=${v.second}`],
        note: "-4 here; -5 would be just as right if vCPU 1's thread had not taken its mailbox yet. Which one you see is host timing. Never a second start." },
      { text: "vCPU 1 reads its MPIDR_EL1; vCPU 0 checks CPU 1 is on.", acts: [{ t: "read", cpu: 1, as: "u1" }, { t: "ai", from: 0, target: 1n, level: 0n }],
        say: (v) => [`smp-race: cpu 1 up mpidr=${hx(v.u1)}`] },
      { text: "vCPU 0 calls CPU_ON for CPU 2 with context 2.", acts: [{ t: "on", from: 0, target: 2n, entry: E, ctx: 2n }], trace: [2] },
      { text: "vCPU 2's thread takes its mailbox; vCPU 2 reads its MPIDR_EL1.", acts: [{ t: "take", cpu: 2 }, { t: "read", cpu: 2, as: "u2" }],
        say: (v) => [`smp-race: cpu 2 up mpidr=${hx(v.u2)}`] },
      { text: "The race for CPU 3 starts: vCPU 0 sets GO and calls CPU_ON(3).", acts: [{ t: "on", from: 0, target: 3n, entry: E, ctx: 3n, as: "r0" }], trace: [3],
        note: "GO is a flag in guest memory: vCPU 0 sets it to release vCPUs 1 and 2, which were spinning on it, so all three call at about the same moment. Each call takes vCPU 3's own lock, so exactly one of them finds it off." },
      { text: "vCPU 1 calls CPU_ON(3), 375 ns later.", acts: [{ t: "on", from: 1, target: 3n, entry: E, ctx: 3n, as: "r1" }], trace: [4] },
      { text: "vCPU 2 calls CPU_ON(3).", acts: [{ t: "on", from: 2, target: 3n, entry: E, ctx: 3n, as: "r2" }], trace: [5],
        say: (v) => {
          const r = [v.r0, v.r1, v.r2];
          const wins = r.filter((x) => x === 0).length;
          const refused = r.filter((x) => x === -4 || x === -5).length;
          return [`smp-race: cpu_on(3) race: cpu0=${v.r0} cpu1=${v.r1} cpu2=${v.r2} successes=${wins} refused=${refused}`];
        },
        note: "vCPUs 1 and 2 now halt in the guest. They stay running, so the stop at the end will have to kick them." },
      { text: "vCPU 3's thread takes its mailbox (x0 = 3); vCPU 3 reads its MPIDR_EL1.", acts: [{ t: "take", cpu: 3 }, { t: "read", cpu: 3, as: "u3" }],
        say: (v) => [`smp-race: cpu 3 up mpidr=${hx(v.u3)}`] },
      { text: "vCPU 3 calls CPU_OFF.", acts: [{ t: "off", from: 3 }], trace: [6] },
      { text: "vCPU 0 polls AFFINITY_INFO(3) until it reads off.", acts: [{ t: "ai", from: 0, target: 3n, level: 0n, as: "a" }],
        say: (v) => [`smp-race: cpu_off(3) affinity=${v.a}`] },
      { text: "vCPU 0 starts CPU 3 again, with context 0x33.", acts: [{ t: "on", from: 0, target: 3n, entry: E, ctx: 0x33n }], trace: [7],
        note: "No thread is created: vCPU 3's thread has existed since startup and was parked again by CPU_OFF." },
      { text: "vCPU 3's thread takes the new request; vCPU 3 reads x0; vCPU 0 checks it is on.", acts: [{ t: "take", cpu: 3, as: "t3" }, { t: "ai", from: 0, target: 3n, level: 0n, as: "a2" }],
        say: (v, m) => [`smp-race: cpu 3 back on ctx=${hx(m.vcpus[3].regs.x[0])} affinity=${v.a2}`] },
      { text: "vCPU 0 asks for a CPU that does not exist: CPU_ON(4).", acts: [{ t: "on", from: 0, target: 4n, entry: E, ctx: 0n, as: "noCpu" }], trace: [8] },
      { text: "vCPU 0 asks for CPU 1 with an entry outside RAM, then AFFINITY_INFO at level 1.",
        acts: [{ t: "on", from: 0, target: 1n, entry: 0x1000n, ctx: 0n, as: "bad" }, { t: "ai", from: 0, target: 1n, level: 1n, as: "l1" }], trace: [9],
        say: (v) => [`smp-race: cpu_on(4)=${v.noCpu} bad_entry=${v.bad} affinity_level1=${v.l1}`, "smp-race: done"],
        note: "The checks run before any state changes: CPU 1 is on, but the bad entry is reported first." },
      { text: "vCPU 0 calls SYSTEM_OFF; the stop pulls every secondary out of the guest.", acts: [{ t: "sysoff", from: 0 }], trace: [10, 11, 12, 13],
        stderr: [
          "macvmm: stats: vcpu1 exits: vtimer 0, wfx 0, total 2: canceled 1, hvc 1",
          "macvmm: stats: vcpu2 exits: vtimer 0, wfx 0, total 2: canceled 1, hvc 1",
          "macvmm: stats: vcpu3 exits: vtimer 0, wfx 0, total 2: canceled 1, hvc 1",
        ],
        note: "A kick is the VMM forcing a vCPU out of the guest (hv_vcpus_exit); the vCPU's thread sees one canceled exit, then stops. One canceled exit per secondary: that is how they stopped. The trace lines are in the order they were written, not by time." },
    ],
  },
  paper: {
    label: "The nine calls on paper (predict each answer)",
    cpus: 4, brk: "ok", source: "chapter 20, \"A power table, one lock per CPU\"",
    steps: [
      { text: "CPU_ON(0x1).", acts: [{ t: "on", from: 0, target: 1n, entry: 0x4008_0000n, ctx: 0n }] },
      { text: "AFFINITY_INFO(0x1, 0), before vCPU 1's thread has woken.", acts: [{ t: "ai", from: 0, target: 1n, level: 0n }] },
      { text: "CPU_ON(0x1) again, still before it has woken.", acts: [{ t: "on", from: 0, target: 1n, entry: 0x4008_0000n, ctx: 0n }] },
      { text: "The same call, after vCPU 1's thread has taken its mailbox.", acts: [{ t: "take", cpu: 1 }, { t: "on", from: 0, target: 1n, entry: 0x4008_0000n, ctx: 0n }] },
      { text: "CPU_ON(0x2) with entry 0x4008_0002.", acts: [{ t: "on", from: 0, target: 2n, entry: 0x4008_0002n, ctx: 0n }] },
      { text: "CPU_ON(0x10).", acts: [{ t: "on", from: 0, target: 0x10n, entry: 0x4008_0000n, ctx: 0n }] },
      { text: "CPU_ON(0x8000_0002).", acts: [{ t: "on", from: 0, target: 0x8000_0002n, entry: 0x4008_0000n, ctx: 0n }] },
      { text: "vCPU 1 calls CPU_OFF; then AFFINITY_INFO(0x1, 0).", acts: [{ t: "off", from: 1 }, { t: "ai", from: 0, target: 1n, level: 0n }] },
      { text: "AFFINITY_INFO(0x1, 1).", acts: [{ t: "ai", from: 0, target: 1n, level: 1n }] },
    ],
  },
  linux: {
    label: "Linux on 4 CPUs",
    cpus: 4, brk: "ok", source: "captures/20-linux-smp-log.txt",
    steps: [
      { text: "The boot CPU reads its MPIDR_EL1 and finds its redistributor.", acts: [{ t: "read", cpu: 0 }],
        log: ["[    0.000000] GICv3: CPU0: found redistributor 0 region 0:0x00000000080a0000"] },
      { text: "Linux starts bringing up the secondaries, one at a time.", acts: [], log: ["[    0.006726] smp: Bringing up secondary CPUs ..."] },
      { text: "vCPU 0 calls CPU_ON for the reg of cpu@1, with context 0.", acts: [{ t: "on", from: 0, target: 1n, entry: null, ctx: 0n }],
        note: "Our VMM finds the vCPU whose MPIDR is 0x1, marks it on pending (accepted, not started yet), puts the request (entry point and context) in that vCPU's mailbox, a slot only its thread reads, and wakes the thread. Linux passes its secondary entry's physical address (not shown in our captures) and context 0, and waits for this CPU before starting the next." },
      { text: "vCPU 1 takes its mailbox, reads its MPIDR_EL1 and finds its redistributor.", acts: [{ t: "take", cpu: 1 }, { t: "read", cpu: 1 }],
        note: "The thread takes the request out of its mailbox, sets PC to the entry point and x0 to the context, and enters the guest: vCPU 1 is now on.",
        log: ["[    0.007160] GICv3: CPU1: found redistributor 1 region 0:0x00000000080c0000", "[    0.007192] CPU1: Booted secondary processor 0x0000000001 [0x610f0000]"] },
      { text: "vCPU 0 calls CPU_ON for cpu@2.", acts: [{ t: "on", from: 0, target: 2n, entry: null, ctx: 0n }] },
      { text: "vCPU 2 comes up.", acts: [{ t: "take", cpu: 2 }, { t: "read", cpu: 2 }],
        log: ["[    0.007362] GICv3: CPU2: found redistributor 2 region 0:0x00000000080e0000", "[    0.007390] CPU2: Booted secondary processor 0x0000000002 [0x610f0000]"] },
      { text: "vCPU 0 calls CPU_ON for cpu@3.", acts: [{ t: "on", from: 0, target: 3n, entry: null, ctx: 0n }] },
      { text: "vCPU 3 comes up.", acts: [{ t: "take", cpu: 3 }, { t: "read", cpu: 3 }],
        log: ["[    0.007537] GICv3: CPU3: found redistributor 3 region 0:0x0000000008100000", "[    0.007567] CPU3: Booted secondary processor 0x0000000003 [0x610f0000]"] },
      { text: "All four CPUs are online.", acts: [], log: ["[    0.007624] smp: Brought up 1 node, 4 CPUs", "macvmm-smp: nproc=4"],
        note: "The three lookups agree for every vCPU: the device tree's reg, our power table and each CPU's own register, which its redistributor frame reports too." },
    ],
  },
  dup: {
    label: "Breakage 1: two vCPUs with one MPIDR",
    cpus: 2, brk: "dup", source: "captures/20-dup-mpidr-log.txt and 20-dup-mpidr-run.txt",
    steps: [
      { text: "The boot CPU reads its MPIDR_EL1 and finds its redistributor.", acts: [{ t: "read", cpu: 0 }],
        log: ["[    0.000000] GICv3: CPU0: found redistributor 0 region 0:0x00000000080a0000"] },
      { text: "Linux starts bringing up the secondaries.", acts: [], log: ["[    0.006707] smp: Bringing up secondary CPUs ..."] },
      { text: "vCPU 0 calls CPU_ON for the reg of cpu@1, 0x1.", acts: [{ t: "on", from: 0, target: 1n, entry: null, ctx: 0n, as: "on1" }],
        log: ["[    0.007045] psci: failed to boot CPU1 (-22)", "[    0.007314] CPU1: failed to boot: -22"],
        note: "Our table has two rows for affinity 0 and none for 1, so the answer is INVALID_PARAMETERS (-2), which Linux reports as -22, its \"invalid argument\"." },
      { text: "Linux gives up on CPU 1.", acts: [], log: ["[    0.007559] smp: Brought up 1 node, 1 CPU", "macvmm-smp: nproc=1"] },
      { text: "The test powers off: vCPU 1's thread, still parked, is woken and ends.", acts: [{ t: "sysoff", from: 0 }],
        stderr: ["macvmm: stats: vcpu1 exits: vtimer 0, wfx 0, total 0"],
        note: "vCPU 1's thread existed the whole time and never ran: zero exits. Two CPUs with one name cannot both be addressed." },
    ],
  },
  reg: {
    label: "Breakage 2: only the register disagrees",
    cpus: 2, brk: "reg", traceRecs: REG_TRACE, source: "captures/20-mpidr-mismatch-trace.txt and 20-mpidr-mismatch-log.txt",
    steps: [
      { text: "Linux on vCPU 0 probes the firmware: PSCI_VERSION, then MIGRATE_INFO_TYPE.",
        acts: [{ t: "call", from: 0, fn: "PSCI_VERSION" }, { t: "call", from: 0, fn: "PSCI_MIGRATE_INFO_TYPE" }], trace: [0, 1],
        note: "The capture's grep hides the PSCI_FEATURES probes." },
      { text: "Linux starts bringing up the secondaries.", acts: [], log: ["[    0.006684] smp: Bringing up secondary CPUs ..."] },
      { text: "vCPU 0 calls CPU_ON for the reg of cpu@1, 0x1.", acts: [{ t: "on", from: 0, target: 1n, entry: null, ctx: 0n }], trace: [2],
        note: "The device tree and our power table both say 0x1, so the call succeeds. No clean error." },
      { text: "vCPU 1 takes its mailbox and reads its own MPIDR_EL1.", acts: [{ t: "take", cpu: 1 }, { t: "read", cpu: 1 }],
        note: "CPU 1 now believes it is CPU 0. Most likely its redistributor frame says so too, since it reports the affinity in the vCPU's register; we have not checked that. Nothing more is printed." },
      { text: "About a second later, vCPU 1, not vCPU 0, asks for a reset.", acts: [{ t: "reset", from: 1, onReset: "exit" }], trace: [3, 4],
        stderr: ["macvmm: guest requested a reset (exit code 4)"],
        note: "Exactly what broke first was not checked; the CPU with the wrong name is the one that gave up. A hypothesis: its redistributor walk finds the frame matching its MPIDR, and CPU 0 already owns that frame." },
    ],
  },
});

/** Simple to hard; Linux first, since that is the path the lesson describes where the lab sits. */
export const SCENARIO_IDS = Object.freeze(["linux", "race", "paper", "dup", "reg", "free"]);
export const DEFAULT_SCENARIO = "linux";

/** The label of a scenario, for the select (the sandbox has no SCENARIOS entry). */
export function scenarioLabel(id) {
  return id === "free" ? "Sandbox: make the calls yourself" : SCENARIOS[id].label;
}

/** The answers of the paper exercise, one string per call, as the lesson writes them. */
export function paperAnswers() {
  return runScenario("paper").slice(1).map((s) => {
    const last = s.events[s.events.length - 1];
    return last.code;
  });
}

/**
 * Replay a scripted scenario. Returns snapshots: index 0 is the start, index k the state after
 * step k: `{ m, events, vars, console, log, stderr, trace, step }`. A step whose action is not
 * possible is a bug in the script, so this throws.
 */
export function runScenario(id) {
  const sc = SCENARIOS[id];
  if (!sc) throw new Error(`no scenario ${id}`);
  let m = makeMachine(sc.cpus, sc.brk);
  const vars = {};
  const snaps = [{ m, events: [], vars: { ...vars }, console: [], log: [], stderr: [], trace: [], step: 0 }];
  sc.steps.forEach((st, k) => {
    const events = [];
    for (const a of st.acts) {
      const r = apply(m, a);
      if (r.error) throw new Error(`${id} step ${k + 1}: ${r.error}`);
      m = r.m;
      events.push(r.ev);
      if (a.as) vars[a.as] = r.ev.code !== undefined ? r.ev.code : r.ev.value;
    }
    const recs = (st.trace || []).map((i) => sc.traceRecs[i]);
    snaps.push({
      m, events, vars: { ...vars }, console: st.say ? st.say(vars, m) : [], log: st.log || [],
      stderr: st.stderr || events.flatMap((e) => e.stderr || []), trace: recs, step: k + 1, text: st.text, note: st.note || "",
    });
  });
  return snaps;
}

// --- the free sandbox ---------------------------------------------------------------------

/** Encode one free-mode action for the share string: `on0-1-40080000-0`, `tk1`, ... */
export function encodeAct(a) {
  const h = (v) => BigInt.asUintN(64, BigInt(v)).toString(16);
  switch (a.t) {
    case "on": return `on${a.from}-${h(a.target)}-${h(a.entry)}-${h(a.ctx)}`;
    case "ai": return `ai${a.from}-${h(a.target)}-${h(a.level)}`;
    case "off": return `of${a.from}`;
    case "take": return `tk${a.cpu}`;
    case "read": return `rd${a.cpu}`;
    case "sysoff": return `so${a.from}`;
    case "reset": return `rs${a.from}`;
    default: throw new Error("not a free-mode action");
  }
}

const H64 = "([0-9a-f]{1,16})";
/** Decode one action token, or null. */
export function decodeAct(tok) {
  let m = new RegExp(`^on(\\d{1,2})-${H64}-${H64}-${H64}$`).exec(tok);
  if (m) return { t: "on", from: Number(m[1]), target: BigInt("0x" + m[2]), entry: BigInt("0x" + m[3]), ctx: BigInt("0x" + m[4]) };
  m = new RegExp(`^ai(\\d{1,2})-${H64}-${H64}$`).exec(tok);
  if (m) return { t: "ai", from: Number(m[1]), target: BigInt("0x" + m[2]), level: BigInt("0x" + m[3]) };
  m = /^(of|tk|rd|so|rs)(\d{1,2})$/.exec(tok);
  if (m) {
    const n = Number(m[2]);
    return { of: { t: "off", from: n }, tk: { t: "take", cpu: n }, rd: { t: "read", cpu: n }, so: { t: "sysoff", from: n }, rs: { t: "reset", from: n } }[m[1]];
  }
  return null;
}

/** Replay a free-mode action list; stops at the first action that is not possible. */
export function runFree(free) {
  let m = makeMachine(free.cpus, free.brk);
  const snaps = [{ m, events: [], console: [], log: [], stderr: [], trace: [], step: 0 }];
  const applied = [];
  for (const a of free.acts) {
    const r = apply(m, a);
    if (r.error) break;
    m = r.m;
    applied.push(a);
    snaps.push({ m, events: [r.ev], console: [], log: [], stderr: r.ev.stderr || [], trace: [], step: applied.length, text: describeAct(a) });
  }
  return { snaps, applied };
}

/** One line naming an action, for the free timeline. */
export function describeAct(a) {
  switch (a.t) {
    case "on": return `vCPU ${a.from} calls CPU_ON(${hx(a.target)}, ${hxu(a.entry)}, ${hx(a.ctx)}).`;
    case "ai": return `vCPU ${a.from} calls AFFINITY_INFO(${hx(a.target)}, ${a.level}).`;
    case "off": return `vCPU ${a.from} calls CPU_OFF.`;
    case "take": return `vCPU ${a.cpu}'s thread takes its mailbox.`;
    case "read": return `vCPU ${a.cpu} reads its MPIDR_EL1.`;
    case "sysoff": return `vCPU ${a.from} calls SYSTEM_OFF.`;
    case "reset": return `vCPU ${a.from} calls SYSTEM_RESET.`;
    default: return "";
  }
}

/** The moves that make sense next in the sandbox (CPU_ON and AFFINITY_INFO have their own form). */
export function quickMoves(m) {
  if (m.stopped) return [];
  const out = [];
  for (const v of m.vcpus) {
    if (v.thread === "parked" && v.power === "pending") out.push({ label: `vCPU ${v.index}'s thread takes its mailbox`, act: { t: "take", cpu: v.index } });
  }
  for (const v of m.vcpus) {
    if (v.thread === "running") out.push({ label: `vCPU ${v.index} reads MPIDR_EL1`, act: { t: "read", cpu: v.index } });
  }
  for (const v of m.vcpus) {
    if (v.thread === "running" && v.index !== 0) out.push({ label: `vCPU ${v.index} calls CPU_OFF`, act: { t: "off", from: v.index } });
  }
  if (m.vcpus[0].thread === "running") out.push({ label: "vCPU 0 calls SYSTEM_OFF", act: { t: "sysoff", from: 0 } });
  return out;
}

// --- lab state, steps and the share string ---------------------------------------------------

export const DEFAULT_FREE = Object.freeze({ cpus: 4, brk: "ok", acts: [] });

export function initialState() {
  return { sc: DEFAULT_SCENARIO, step: 0, free: { ...DEFAULT_FREE, acts: [] }, reveal: false };
}

/** The snapshots for a state: a scripted scenario's, or the sandbox's replay. */
export function snapshots(state) {
  if (state.sc === "free") return runFree(state.free).snaps;
  return runScenario(state.sc);
}

export function lastStep(state) {
  return state.sc === "free" ? state.free.acts.length : SCENARIOS[state.sc].steps.length;
}

/**
 * The reducer. Actions: next, prev, goto {step}, reset, scenario {sc}, reveal {on},
 * freeAct {act} (refused acts leave the state as it was and return `error`), freeUndo,
 * freeConfig {cpus, brk} (clears the sandbox's actions).
 */
export function step(state, action) {
  const s = { ...state, free: { ...state.free, acts: [...state.free.acts] } };
  const last = lastStep(s);
  switch (action.type) {
    case "next": if (s.sc === "free") return s; s.step = Math.min(last, s.step + 1); return s;
    case "prev":
      if (s.sc === "free") { s.free.acts.pop(); s.step = s.free.acts.length; return s; }
      s.step = Math.max(0, s.step - 1); return s;
    case "goto":
      if (s.sc === "free") { s.free.acts = s.free.acts.slice(0, Math.max(0, Math.min(action.step, last))); s.step = s.free.acts.length; return s; }
      s.step = Math.max(0, Math.min(last, action.step | 0)); return s;
    case "reset":
      if (s.sc === "free") { s.free.acts = []; s.step = 0; return s; }
      s.step = 0; s.reveal = false; return s;
    case "scenario":
      if (!SCENARIO_IDS.includes(action.sc)) return s;
      s.sc = action.sc;
      s.step = s.sc === "free" ? s.free.acts.length : 0;
      s.reveal = false;
      return s;
    case "reveal": s.reveal = !!action.on; return s;
    case "freeAct": {
      if (s.sc !== "free" || s.free.acts.length >= MAX_ACTIONS) return { ...s, error: "the sandbox holds at most 64 actions" };
      const { snaps } = runFree(s.free);
      const r = apply(snaps[snaps.length - 1].m, action.act);
      if (r.error) return { ...state, error: r.error };
      s.free.acts.push(action.act);
      s.step = s.free.acts.length;
      return s;
    }
    case "freeUndo": s.free.acts.pop(); s.step = s.free.acts.length; return s;
    case "freeConfig": {
      const cpus = Math.max(MIN_CPUS, Math.min(MAX_CPUS, action.cpus | 0 || s.free.cpus));
      const brk = action.brk in BREAKS ? action.brk : s.free.brk;
      s.free = { cpus, brk, acts: [] };
      s.step = 0;
      return s;
    }
    default: return s;
  }
}

/**
 * The share string: `<scenario>@<step>` (`race@5`), `paper@<step>` plus `!` when the answers
 * are shown, or `free.c<cpus>.<brk>[.<act>_<act>...]`. The default (`linux@0`) is null.
 */
export function encodeHash(state) {
  if (state.sc === "free") {
    const base = `free.c${state.free.cpus}.${state.free.brk}`;
    return state.free.acts.length ? `${base}.${state.free.acts.map(encodeAct).join("_")}` : base;
  }
  if (state.sc === DEFAULT_SCENARIO && state.step === 0) return null;
  return `${state.sc}@${state.step}${state.sc === "paper" && state.reveal ? "!" : ""}`;
}

/** Parse a share string; anything malformed gives the initial state (never throws). */
export function decodeHash(str) {
  const s0 = initialState();
  if (typeof str !== "string" || str.length === 0 || str.length > 4096) return s0;
  let m = /^(race|paper|linux|dup|reg)@(\d{1,3})(!?)$/.exec(str);
  if (m) {
    const s = { ...s0, sc: m[1] };
    s.step = Math.min(Number(m[2]), lastStep(s));
    s.reveal = m[1] === "paper" && m[3] === "!";
    return s;
  }
  m = /^free\.c(\d{1,2})\.(ok|dup|reg)(?:\.([a-z0-9_-]+))?$/.exec(str);
  if (!m) return s0;
  const cpus = Number(m[1]);
  if (cpus < MIN_CPUS || cpus > MAX_CPUS) return s0;
  const acts = [];
  if (m[3]) {
    for (const tok of m[3].split("_").slice(0, MAX_ACTIONS)) {
      const a = decodeAct(tok);
      if (!a) break;
      acts.push(a);
    }
  }
  const { applied } = runFree({ cpus, brk: m[2], acts });
  return { ...s0, sc: "free", free: { cpus, brk: m[2], acts: applied }, step: applied.length };
}

// --- readouts ---------------------------------------------------------------------------------

/** One event as a short line for its lane in the timeline. */
export function eventLine(ev) {
  if (ev.kind === "call") {
    if (ev.code !== undefined) return `${ev.call} → ${ev.info ? `${ev.code} (${["on", "off", "on pending"][ev.code]})` : codeText(ev.code)}`;
    if (ev.value !== undefined) return `${ev.call} → ${hx(ev.value)}`;
    return ev.call;
  }
  if (ev.kind === "read") return `MPIDR_EL1 = ${hx(ev.value)}${ev.mismatch ? " (wrong)" : ""}`;
  return ev.call;
}

/** Plain-text explanation of one event, for the readout. */
export function eventSentence(ev) {
  const who = ev.kind === "take" ? `vCPU ${ev.lane}'s thread` : `vCPU ${ev.lane}`;
  let what = eventLine(ev);
  if (ev.kind === "call" && ev.code !== undefined && !ev.info) {
    what += ` (x0 = ${hxu(BigInt.asUintN(64, BigInt(ev.code)))})`;
  }
  return `${who}: ${what}. ${ev.why ? ev.why[0].toUpperCase() + ev.why.slice(1) + "." : ""}`.trim();
}

/** The summary line for the live region. */
export function summary(state, snaps, { short = false } = {}) {
  const last = snaps.length - 1;
  const k = state.sc === "free" ? last : state.step;
  const s = snaps[k];
  if (k === 0) {
    const n = s.m.cpus;
    return `Start: ${n} vCPUs, each on its own thread, created in index order. vCPU 0 runs; ${n > 2 ? `vCPUs 1 to ${n - 1} are` : "vCPU 1 is"} off, ${n > 2 ? "their threads" : "its thread"} parked.${state.sc === "free" ? " Make a call with the controls." : " Press Step to start."}`;
  }
  const head = `Step ${k} of ${state.sc === "free" ? last : lastStep(state)}`;
  if (short) return `${head}: ${s.text}`;
  const body = s.events.map(eventLine).join("; ");
  return `${head}: ${s.text}${body ? " " + body + "." : ""}`;
}

/** A vCPU's state as short labelled lines, for its card. */
export function vcpuLines(v) {
  const thread = { running: "running guest code", parked: "parked (waiting on its condition variable)", stopped: "stopped" }[v.thread];
  const lines = [
    ["Thread", thread],
    ["PSCI state", `${POWER_LABEL[v.power]} (AFFINITY_INFO = ${AFFINITY[v.power]})`],
    ["Mailbox", v.mailbox ? `entry ${v.mailbox.entry === null ? "Linux's secondary entry" : hxu(v.mailbox.entry)}, context ${hx(v.mailbox.ctx)}` : "empty"],
    ["MPIDR_EL1", hxu(v.reg)],
  ];
  if (v.regs) {
    lines.push(["PC", v.regs.pc === null ? (v.index === 0 ? "the kernel's entry (chapter 06)" : "Linux's secondary entry") : hxu(v.regs.pc)]);
    lines.push(["x0", v.regs.x[0] === null ? "the boot protocol's value (chapter 06)" : hx(v.regs.x[0])]);
    lines.push(["CPSR", `${hx(v.regs.cpsr)} (EL1h, D A I F masked)`]);
    lines.push(["MMU", v.regs.mmu ? "on" : "off"]);
  }
  return lines;
}
