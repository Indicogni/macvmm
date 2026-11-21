// vmapple-map: the model. Pure data and functions, no DOM, no I/O (course/site/LABS.md section 3).
//
// What it is: the vmapple board's memory map as chapter 24 cites it from QEMU's hw/vmapple/ at
// tag v10.0.0, one row per region, each tagged observed, inferred or unknown. The tag is not
// typed in by hand per row: it is derived from which evidence the reader switches on (QEMU's
// sources, the first probe with unknown reads returning 0, the all-ones run), so switching a
// source off shows exactly which claims rest on it. With the default evidence (QEMU and the zero
// run, the all-ones run still hidden), `fallbackText` prints the lesson's fallback table
// character for character (model.test.mjs compares them): the lesson shows that block in
// sitting A, before sitting B asks the reader to predict the all-ones run.
//
// Counts only. The two runs are summarised by the numbers chapter 24 publishes from
// captures/24-*.txt (accesses per region, distinct addresses, exit kinds, how the run ended).
// No per-access line, value or program counter other than the first exit's appears here, by the
// same rule the lesson follows for Apple's ROM.
//
// Addresses are plain Numbers in the tables (all below 2^53); the address lookup parses the
// reader's text as a BigInt so a 64-bit value can never lose precision.

export const QEMU_TAG = "v10.0.0";
export const RAM_SIZE_RUNS = 4 * 1024 ** 3; // --mem 4G, as in every run the lesson shows
export const GICR_FRAME = 0x2_0000; // one 128 KiB redistributor frame: what HVF implements for 1 vCPU

const LOGGER = "unknown-MMIO logger: logged, reads return 0, writes are dropped";
const NOT_IN_MAP = "not in macvmm's map: the unknown-MMIO logger records it as (no layout row)";

// ---- the board, as the lesson's table lists it ---------------------------------------------
// `files`: the QEMU files (at QEMU_TAG) the row is cited from. `inMacvmm`: the row exists in
// crates/vmm/src/machine/vmapple/layout.rs under that name (the test checks base and size).
// `quiet`: the column when no run of ours touched the row (inferred or unknown), with `why`.
// `whyQuiet` and `whySeen` cite only QEMU or fixed facts; whatever a run says is added from the
// runs switched on (`seenWhy`, `quietWhy`), so no sentence leans on evidence that is switched off.
// `span` (PCIe MMIO window): QEMU's memmap[] size, 0x1fff_0000, which ends 64 KiB below RAM.
export const REGIONS = [
  {
    id: "avpbooter", name: "firmware", base: 0x0010_0000, size: 0x0010_0000, sizeText: "1 MiB",
    what: "AVPBooter, the boot ROM a macOS virtual machine runs first",
    files: ["vmapple.c"], inMacvmm: "avpbooter",
    macvmm: "read+execute ROM: AVPBooter read in place, 335,096 bytes in a 1,048,576-byte window",
    quiet: "inferred",
    whyQuiet: "QEMU's board loads AVPBooter here and starts the CPU at its first byte; macvmm does the same, but without a run nothing shows the ROM agrees.",
    // Observed because macvmm starts the CPU at this window's first byte with the MMU off (the
    // dry run's entry line, captures/24-dry-run.txt) and the ROM then kept running and exiting.
    // The first exit's PC is only consistent with that: a PC is a virtual address, and nothing
    // logged SCTLR_EL1 at that exit, so it alone cannot prove a fetch from this window.
    whySeen: "macvmm starts the CPU at 0x0010_0000, this window's first byte, with the MMU off (its dry run prints that entry state), and the ROM went on to run and make exits. The first exit's program counter, 0x103478, lies inside the window, which is consistent with that: a program counter is a virtual address, and it equals the physical one only while the MMU is off.",
    next: "Nothing needed: the first exit already places the ROM. A different ROM version would need its own run.",
  },
  {
    id: "cfg", name: "cfg", base: 0x0040_0000, size: 0x0001_0000, sizeText: "64 KiB",
    what: "configuration block: version, CPU count, ECID (the chip's unique ID), RAM size, serial, model, fields named unk1 to unk10",
    files: ["vmapple.c", "cfg.c"], inMacvmm: "cfg",
    macvmm: LOGGER,
    quiet: "inferred",
    whyQuiet: "QEMU's board fills a page here that the booter reads; no run of ours says the ROM reads it too.",
    whySeen: null, // derived from the runs switched on (seenWhy)
    next: "Fill it from QEMU's field list (with your bundle's ECID), change nothing else, and compare the counts with the zero run.",
  },
  {
    id: "gicd", name: "GIC distributor", base: 0x1000_0000, size: 0x0001_0000, sizeText: "64 KiB",
    what: "interrupt controller, shared part (chapter 12)",
    files: ["vmapple.c"], inMacvmm: "gicd",
    macvmm: "in-kernel GIC (Hypervisor.framework handles every access; none exits to us)",
    quiet: "inferred",
    whyQuiet: "QEMU's board puts its distributor here.",
    whySeen: "Hypervisor.framework accepts this base when macvmm creates the in-kernel GIC. That says the base is legal, not that the ROM uses it: its accesses never exit, so we cannot count them.",
    next: "None that keeps to the rules: GIC accesses are handled inside Hypervisor.framework and never reach the VMM.",
  },
  {
    id: "gicr", name: "GIC redistributors", base: 0x1001_0000, size: 0x0040_0000, sizeText: "4 MiB",
    what: "interrupt controller, one frame per CPU",
    files: ["vmapple.c"], inMacvmm: "gicr",
    macvmm: "in-kernel GIC for the first 128 KiB frame (one vCPU); the rest goes to the unknown-MMIO logger",
    quiet: "inferred",
    whyQuiet: "QEMU's board puts its redistributors here, right after the distributor.",
    whySeen: "Hypervisor.framework accepts this base for the redistributors. As with the distributor, accesses never exit, so the ROM's use of it is not counted.",
    next: "A run with more vCPUs would show whether the ROM touches frames past the first (those would reach the logger).",
  },
  {
    id: "pl011", name: "PL011 UART", base: 0x2001_0000, size: 0x0001_0000, sizeText: "64 KiB", spi: 1,
    what: "serial console",
    files: ["vmapple.c"], inMacvmm: "pl011",
    macvmm: "PL011 model (chapter 09), INTID 33",
    quiet: "inferred",
    whyQuiet: "QEMU's board puts its console here and macvmm models one.", runSuffix: true,
    whySeen: "",
    next: "Any text from the ROM on the console would move it; in the reference runs the console received no bytes.",
  },
  {
    id: "pl031", name: "PL031 RTC", base: 0x2005_0000, size: 0x1000, sizeText: "4 KiB", spi: 2,
    what: "real-time clock",
    files: ["vmapple.c"], inMacvmm: "pl031",
    macvmm: LOGGER,
    quiet: "inferred",
    whyQuiet: "QEMU's board puts a clock here, and the logger would record any access.", runSuffix: true,
    whySeen: "",
    next: "A logged access in this row in a later run, once the ROM gets further.",
  },
  {
    id: "pl061", name: "PL061 GPIO", base: 0x2006_0000, size: 0x1000, sizeText: "4 KiB", spi: 5,
    what: "general-purpose input/output pins: the power button",
    files: ["vmapple.c"], inMacvmm: "pl061",
    macvmm: LOGGER,
    quiet: "inferred",
    whyQuiet: "QEMU's board wires its power button here, and the logger would record any access.", runSuffix: true,
    whySeen: "",
    next: "A logged access in this row in a later run.",
  },
  {
    id: "pvpanic", name: "pvpanic", base: 0x2007_0000, size: 0x2, sizeText: "2 bytes",
    what: "written by a guest that is panicking",
    files: ["vmapple.c"], inMacvmm: "pvpanic",
    macvmm: LOGGER,
    quiet: "inferred",
    whyQuiet: "QEMU's board puts a pvpanic device here.",
    whySeen: null, // derived from the runs switched on (seenWhy)
    next: "Whether that access means the ROM gave up is a separate claim, still inferred: the lesson's Try it asks what experiment would move it.",
  },
  {
    id: "bdif", name: "bdif", base: 0x3000_0000, size: 0x0020_0000, sizeText: "2 MiB",
    what: "backdoor block interface: how the booter reads disks before any driver exists",
    files: ["vmapple.c", "bdif.c"], inMacvmm: "bdif",
    macvmm: LOGGER,
    quiet: "inferred",
    whyQuiet: "QEMU documents that the booter reads its disks through this row.", runSuffix: true,
    whySeen: null, // derived from the runs switched on (seenWhy)
    next: "A per-register cfg experiment that reaches bdif with every other unknown read still returning 0.",
    // Shown instead of `next` until the all-ones run is revealed: `next` names what that run
    // found, so it would answer sitting B's Predict step before the reader has run anything.
    nextHidden: "Any run of yours that logs an access in this row. Sitting B changes what the ROM reads back; check this row after each change.",
  },
  {
    id: "gfx", name: "apple-gfx", base: 0x3020_0000, size: 0x0001_0000, sizeText: "64 KiB",
    what: "graphics bridged to the host by ParavirtualizedGraphics.framework",
    files: ["vmapple.c"], inMacvmm: null,
    macvmm: NOT_IN_MAP,
    quiet: "unknown",
    whyQuiet: "QEMU's board has it, but it is used once a kernel runs; macvmm's map leaves it out, and nothing we ran comes near it.",
    whySeen: "",
    next: "Nothing we can run reaches it: it needs the stages after AVPBooter.",
  },
  {
    id: "iosurface", name: "IOSurface mapper", base: 0x3021_0000, size: 0x0001_0000, sizeText: "64 KiB",
    what: "the graphics device's second window (an IOSurface is a macOS shared graphics buffer)",
    files: ["vmapple.c"], inMacvmm: null,
    macvmm: NOT_IN_MAP,
    quiet: "unknown",
    whyQuiet: "QEMU's board has it for apple-gfx; macvmm's map leaves it out, and nothing we ran comes near it.",
    whySeen: "",
    next: "Nothing we can run reaches it: it needs the stages after AVPBooter.",
  },
  {
    id: "aes1", name: "AES engine, window 1", base: 0x3022_0000, size: 0x4000, sizeText: "16 KiB",
    what: "AES cryptography the guest asks for; the built-in keys are Apple's",
    files: ["vmapple.c"], inMacvmm: null,
    macvmm: NOT_IN_MAP,
    quiet: "unknown",
    whyQuiet: "QEMU's board has it for a running kernel; macvmm's map leaves it out, and nothing we ran comes near it.",
    whySeen: "",
    next: "Nothing we can run reaches it: it needs the stages after AVPBooter.",
  },
  {
    id: "aes2", name: "AES engine, window 2", base: 0x3023_0000, size: 0x4000, sizeText: "16 KiB",
    what: "the AES engine's second window",
    files: ["vmapple.c"], inMacvmm: null,
    macvmm: NOT_IN_MAP,
    quiet: "unknown",
    whyQuiet: "as window 1.",
    whySeen: "",
    next: "Nothing we can run reaches it: it needs the stages after AVPBooter.",
  },
  {
    id: "ecam", name: "PCIe ECAM", base: 0x4000_0000, size: 0x1000_0000, sizeText: "256 MiB",
    what: "PCI Express configuration window (chapter 23)",
    files: ["vmapple.c"], inMacvmm: null,
    macvmm: NOT_IN_MAP,
    quiet: "unknown",
    whyQuiet: "QEMU's board has it for virtio devices a kernel uses; macvmm's map leaves it out, and nothing we ran comes near it.",
    whySeen: "",
    next: "Nothing we can run reaches it: it needs the stages after AVPBooter.",
  },
  {
    id: "pcie-mmio", name: "PCIe MMIO window", base: 0x5000_0000, size: null, span: 0x1fff_0000, sizeText: "about 512 MiB",
    what: "where PCI Express devices' registers appear",
    files: ["vmapple.c"], inMacvmm: null,
    macvmm: NOT_IN_MAP,
    quiet: "unknown",
    whyQuiet: "QEMU's board has it for PCI Express devices; macvmm's map leaves it out, and nothing we ran comes near it.",
    whySeen: "",
    next: "Nothing we can run reaches it: it needs the stages after AVPBooter.",
  },
  {
    id: "ram", name: "RAM", base: 0x7000_0000, size: null, sizeText: "as configured",
    what: "guest memory",
    files: ["vmapple.c"], inMacvmm: "ram",
    macvmm: "RAM (4 GiB in the lesson's runs: 0x7000_0000 to 0x1_7000_0000); accesses never exit",
    quiet: "inferred",
    whyQuiet: "QEMU's board puts RAM here and macvmm maps it here; RAM accesses never exit, so no run counts them.",
    whySeen: "",
    next: "None from the exit trace: RAM does not exit, and dumping it would copy the ROM by another route.",
  },
];

export const REGION_IDS = REGIONS.map((r) => r.id);
export function region(id) { return REGIONS.find((r) => r.id === id) || null; }

// ---- the virt board (crates/vmm/src/arch/layout.rs, VIRT_REGIONS), for the comparison -------
export const VIRT = [
  { name: "flash0", base: 0x0000_0000, size: 0x0400_0000 },
  { name: "flash1", base: 0x0400_0000, size: 0x0400_0000 },
  { name: "gicd", base: 0x0800_0000, size: 0x0001_0000 },
  { name: "gicv2-cpu", base: 0x0801_0000, size: 0x0001_0000 },
  { name: "gic-v2m", base: 0x0802_0000, size: 0x0001_0000 },
  { name: "gic-its", base: 0x0808_0000, size: 0x0002_0000 },
  { name: "gicr", base: 0x080a_0000, size: 0x00f6_0000 },
  { name: "pl011", base: 0x0900_0000, size: 0x1000 },
  { name: "pl031", base: 0x0901_0000, size: 0x1000 },
  { name: "fw-cfg", base: 0x0902_0000, size: 0x18 },
  { name: "pl061", base: 0x0903_0000, size: 0x1000 },
  { name: "virtio-mmio", base: 0x0a00_0000, size: 0x4000 },
  { name: "testdev", base: 0x0b00_0000, size: 0x1000 },
  { name: "probe-hole", base: 0x0c00_0000, size: 0x0200_0000 },
  { name: "pcie-mmio", base: 0x1000_0000, size: 0x2eff_0000 },
  { name: "pcie-pio", base: 0x3eff_0000, size: 0x0001_0000 },
  { name: "pcie-ecam", base: 0x3f00_0000, size: 0x0100_0000 },
];
export const VIRT_RAM_BASE = 0x4000_0000;
export const VIRT_RAM_MAX_END = 0x40_0000_0000;

// ---- the two runs (captures/24-first-probe.txt, 24-all-ones.txt and their jq summaries) ------
// `kinds`, `exits`, `time`, `window` and `ended` are the capture record, worded as macvmm prints
// it, and model.test.mjs checks each against its capture. The view shows `runLines(k)`, plain
// sentences built from the same numbers.
export const FIRST_EXIT_PC = 0x103478;
export const RUNS = {
  z: {
    id: "z",
    label: "First probe: unknown reads return 0",
    short: "zero run",
    boots: 1,
    perBoot: { cfg: 33, pvpanic: 1 },
    accesses: 34,
    distinct: 14,
    kinds: [["mmio", 34], ["canceled", 1]],
    exits: "total 35: canceled 1, data abort 34",
    time: "exec 19.027 s, wfi 0.000 s, of 20.004 s wall",
    window: "all accesses between 0.19 ms and 0.49 ms; 1 exit in the last 10 ms (the timeout's cancel)",
    ended: "--timeout stopped it after 20 s with the ROM still running, exit code 5",
  },
  o: {
    id: "o",
    label: "All-ones run: unknown reads return all ones",
    short: "all-ones run",
    boots: 11,
    perBoot: { cfg: 60, pvpanic: 1, bdif: 2 },
    accesses: 63,
    distinct: 16,
    kinds: [["mmio", 693], ["PSCI_VERSION", 11], ["PSCI_SYSTEM_RESET", 11]],
    exits: "last boot: total 65: hvc 2, data abort 63",
    time: "last boot under a millisecond: exec 0.000 s, wfi 0.000 s",
    window: "each boot: 63 accesses, then PSCI_VERSION, then SYSTEM_RESET",
    ended: "reset storm: more than 10 resets within 10 s, exit code 3",
  },
};

/** The run card's lines: plain sentences, every number taken from RUNS. */
export function runLines(k) {
  const run = RUNS[k];
  const per = Object.entries(run.perBoot).map(([rid, n]) => `${n} in ${rid}`).join(", ");
  if (k === "z") {
    const [, canceled] = run.kinds.find(([n]) => n === "canceled");
    return [
      `${run.accesses} accesses to addresses with no device, each written down by the logger: ${per}`,
      `${run.distinct} distinct addresses`,
      `${run.accesses + canceled} VM exits: ${run.accesses} device accesses and ${canceled} when the time limit stopped the CPU`,
      "19.0 of the 20 seconds spent running guest instructions, none waiting for an interrupt",
      `all ${run.accesses} accesses between 0.19 ms and 0.49 ms after the start, then no exit until the time limit`,
      "Ended: the 20-second time limit (--timeout) stopped it with the ROM still running",
    ];
  }
  return [
    `${run.accesses} accesses per boot to addresses with no device: ${per}`,
    `${run.boots} boots, ${run.distinct} distinct addresses across the whole trace`,
    `each boot: the ${run.accesses} accesses, then two hypercalls, PSCI_VERSION and SYSTEM_RESET (chapter 08)`,
    `the last boot: ${run.accesses + 2} VM exits (${run.accesses} device accesses, 2 hypercalls), in under a millisecond`,
    "Ended: macvmm rebuilt the machine at each reset until its limit on resets stopped it (more than 10 within 10 s)",
  ];
}

export const SOURCES = [
  { key: "q", label: `QEMU's sources at ${QEMU_TAG} (vmapple.c, cfg.c, bdif.c, vmapple.rst)` },
  { key: "z", label: "Our first probe: unknown reads return 0" },
  { key: "o", label: "Our all-ones run: unknown reads return all ones" },
];
export const COLUMNS = ["observed", "inferred", "unknown"];

// ---- deriving a row's column from the evidence that is switched on -------------------------
const RUN_KEYS = ["z", "o"];
function runsOn(ev) { return RUN_KEYS.filter((k) => ev.includes(k)); }

/** Accesses one boot of run `k` made in row `id` (0 when none). */
export function countIn(k, id) { return RUNS[k].perBoot[id] || 0; }

/** Which enabled runs observed the row, and how. */
function observers(r, ev) {
  const on = runsOn(ev);
  if (r.id === "avpbooter" || r.id === "gicd" || r.id === "gicr") return on; // every run: first exit, GIC created
  return on.filter((k) => countIn(k, r.id) > 0);
}

/** Why the row is observed, citing only the runs that are switched on. */
function seenWhy(r, on) {
  const z = on.includes("z"), o = on.includes("o");
  switch (r.id) {
    case "cfg": {
      const parts = [];
      if (z) parts.push(`the zero run's first device access, and ${RUNS.z.perBoot.cfg} of its ${RUNS.z.accesses} accesses, fall in this row`);
      if (o) parts.push(`the all-ones run put ${RUNS.o.perBoot.cfg} of its ${RUNS.o.accesses} accesses per boot here`);
      return `${parts.join("; ")}.`;
    }
    case "pvpanic":
      if (z && o) return "each run made one access in this 2-byte row (one per boot in the all-ones run).";
      return z ? "the zero run made one access in this 2-byte row." : "the all-ones run made one access per boot in this 2-byte row.";
    case "bdif":
      return `the all-ones run logged ${RUNS.o.perBoot.bdif} accesses per boot here${z ? "; the zero run logged none. One changed answer opened a path to it." : "."}`;
    default:
      return r.whySeen;
  }
}

/** Why the row is inferred or unknown with QEMU on: QEMU's part, then what the runs on say. */
function quietWhy(r, on) {
  if (!r.runSuffix) return r.whyQuiet;
  if (!on.length) return `${r.whyQuiet} No run is switched on, so nothing shows whether the ROM uses it.`;
  if (on.length === 2) return `${r.whyQuiet} Neither run made an access here.`;
  return `${r.whyQuiet} The ${RUNS[on[0]].short} made no access here.`;
}

/**
 * The name the lab may show for a row. Names, sizes and interrupts come from QEMU, so with
 * QEMU's sources off a row a run touched is only an address, and any other row is nothing.
 */
export function displayName(id, ev) {
  const r = region(id);
  if (ev.includes("q")) return r.name;
  if (observers(r, ev).length) return `unnamed, at ${hex(r.base)}`;
  return `unnamed row ${REGION_IDS.indexOf(id) + 1}`;
}

// What an observed row is without QEMU's sources: it depends on how it was observed. The GIC
// rows are a base Hypervisor.framework accepted (their accesses never exit, so none is counted);
// the firmware row is the window the CPU starts in; the others have logged accesses.
const NO_QEMU_SUFFIX = {
  gicd: "Without QEMU's sources it is only a base Hypervisor.framework accepted: the name comes from QEMU.",
  gicr: "Without QEMU's sources it is only a base Hypervisor.framework accepted: the name comes from QEMU.",
  avpbooter: "Without QEMU's sources it is only the window the CPU started in: the name comes from QEMU.",
  default: "Without QEMU's sources it is only an address with accesses: the name comes from QEMU.",
};

/**
 * The row's entry for evidence `ev` (a string of source keys from "qzo").
 * Returns { column, qualifier, tag, seen, source, why, named, known, name }: `known` is false
 * when nothing switched on gives the row an address.
 */
export function classify(id, ev) {
  const r = region(id);
  if (!r) throw new Error(`no row ${id}`);
  const q = ev.includes("q");
  const on = runsOn(ev);
  const obs = observers(r, ev);
  let column, qualifier = "", why;
  if (obs.length) {
    column = "observed";
    if (r.id === "gicd" || r.id === "gicr") qualifier = "accepted";
    else if (ev.includes("z") && !obs.includes("z")) qualifier = "all-ones only";
    why = `Observed: ${seenWhy(r, on)}`;
    if (!q) why += ` ${NO_QEMU_SUFFIX[r.id] || NO_QEMU_SUFFIX.default}`;
  } else if (q) {
    column = r.quiet;
    why = `${column === "inferred" ? "Inferred" : "Unknown"}: ${quietWhy(r, on)}`;
  } else {
    column = "unknown";
    why = on.length
      ? "Unknown: no run of ours touched it, and with QEMU's sources switched off nothing names it or says it exists."
      : "Unknown: with every source switched off there is nothing to say about this row.";
  }
  const tag = qualifier ? `${column} (${qualifier})` : column;
  return {
    column, qualifier, tag, seen: seenText(r, on, false, q), source: sourceText(r, ev, obs), why,
    named: q, known: q || obs.length > 0, name: displayName(id, ev),
  };
}

function seenText(r, on, group, q = true) {
  if (!on.length) return "not run";
  const z = on.includes("z"), o = on.includes("o");
  switch (r.id) {
    case "avpbooter": return `first exit at pc=0x${FIRST_EXIT_PC.toString(16)}`;
    // The fallback block (group) keeps the lesson's wording; the lab spells the call out.
    case "gicd": case "gicr": return group ? "hv_gic_create accepts them" : "Hypervisor.framework accepts the base when macvmm creates the GIC";
    case "ram": return q ? "no exits: RAM accesses do not exit" : "no exits here";
    default: break;
  }
  if (r.id === "bdif" && z && o) return "reached only with all ones";
  const k = z && countIn("z", r.id) > 0 ? "z" : o && countIn("o", r.id) > 0 ? "o" : null;
  // "never reached" (not in macvmm's map) versus "no access seen" rests on QEMU's map, so with
  // QEMU's sources off both read the same.
  if (!k) return q && !r.inMacvmm ? "never reached" : "no access seen";
  const n = countIn(k, r.id);
  const per = k === "o" && !z ? " per boot" : "";
  const all = r.id === "cfg" ? ", all unmodelled" : "";
  return `${n} access${n === 1 ? "" : "es"}${per}${all}`;
}

function sourceText(r, ev, obs, files = r.files) {
  const parts = [];
  if (ev.includes("q")) parts.push(`QEMU ${files.join(", ")}`);
  if (obs.length) parts.push(r.id === "bdif" && ev.includes("z") && ev.includes("o") ? "our runs" : "our run");
  return parts.length ? parts.join(", ") : "none";
}

/** Every row's entry, plus counts per column. */
export function inventory(ev) {
  const rows = REGIONS.map((r) => ({ region: r, ...classify(r.id, ev) }));
  const counts = Object.fromEntries(COLUMNS.map((c) => [c, rows.filter((x) => x.column === c).length]));
  return { rows, counts };
}

// ---- the lesson's fallback table -----------------------------------------------------------
export const FALLBACK_GROUPS = [
  { label: "avpbooter 0x100000", ids: ["avpbooter"] },
  { label: "cfg       0x400000", ids: ["cfg"] },
  { label: "gicd/gicr 0x10000000", ids: ["gicd", "gicr"] },
  { label: "pl011     0x20010000", ids: ["pl011"] },
  { label: "pvpanic   0x20070000", ids: ["pvpanic"] },
  { label: "bdif      0x30000000", ids: ["bdif"] },
  { label: "pcie, aes, apple-gfx", ids: ["ecam", "pcie-mmio", "aes1", "aes2", "gfx", "iosurface"] },
];

/** One fallback row: the group's shared tag, seen text and sources (members must agree). */
export function groupEntry(g, ev) {
  const entries = g.ids.map((id) => classify(id, ev));
  const tags = new Set(entries.map((e) => e.tag));
  if (tags.size !== 1) throw new Error(`group ${g.label} disagrees: ${[...tags].join(" / ")}`);
  const first = region(g.ids[0]);
  const seen = seenText(first, runsOn(ev), g.ids.length > 1, ev.includes("q"));
  const files = [...new Set(g.ids.flatMap((id) => region(id).files))];
  const source = sourceText(first, ev, observers(first, ev), files);
  return { label: g.label, tag: entries[0].tag, seen, source };
}

/**
 * The fallback block as the lesson prints it: columns 23, 26 and 30 characters wide, widened
 * for evidence sets whose text is longer, so every column keeps at least two spaces before
 * the next one.
 */
export function fallbackText(ev = DEFAULT_EV) {
  const head = ["row", "column", "seen in the reference runs", "source of the row"];
  const rows = [head, ...FALLBACK_GROUPS.map((g) => {
    const e = groupEntry(g, ev);
    return [e.label, e.tag, e.seen, e.source];
  })];
  const widths = [23, 26, 30].map((w, i) => Math.max(w, ...rows.map((r) => r[i].length + 2)));
  return rows.map((r) => `${r[0].padEnd(widths[0])}${r[1].padEnd(widths[1])}${r[2].padEnd(widths[2])}${r[3]}`).join("\n");
}

// ---- address lookup ------------------------------------------------------------------------
/**
 * Parse a guest-physical address typed by the reader. Hardened: at most 16 hex digits after an
 * optional 0x, with underscores or spaces allowed only between digits (checked before they are
 * removed), nothing else. The text is always read as hex, so "1e3" is 0x1e3. Returns a BigInt
 * or an { error } object.
 */
export function parseAddr(text) {
  if (typeof text !== "string") return { error: "Type an address in hex." };
  if (text.length > 64) return { error: "Too long: an address has at most 16 hex digits." };
  const t = text.trim().toLowerCase();
  const body = t.startsWith("0x") ? t.slice(2) : t;
  if (!body) return { error: "Type an address in hex, for example 0x0040_0000." };
  if (!/^[0-9a-f]+(?:[_\s]+[0-9a-f]+)*$/.test(body)) return { error: "Only hex digits, an optional 0x, and _ or spaces between digits." };
  let s = body.replace(/[_\s]/g, "").replace(/^0+(?=.)/, "");
  if (s.length > 16) return { error: "Too big: an address has at most 16 hex digits (64 bits)." };
  return BigInt(`0x${s}`);
}

/** 0x0040_0000 style, at least 8 digits, groups of 4. */
export function hex(n) {
  const v = typeof n === "bigint" ? n : BigInt(n);
  let s = v.toString(16);
  if (s.length < 8) s = s.padStart(8, "0");
  const groups = [];
  for (let i = s.length; i > 0; i -= 4) groups.unshift(s.slice(Math.max(0, i - 4), i));
  return `0x${groups.join("_")}`;
}

function rowEnd(r, ramSize) {
  if (r.id === "ram") return r.base + ramSize;
  return r.base + (r.size ?? r.span);
}

// How far an access can get. macvmm sizes the IPA space to fit the map and RAM
// (Layout::ipa_bits_needed): 36 bits for the lesson's 4 GiB vmapple runs (the test in
// machine/vmapple/layout.rs), and 36 to 38 bits on virt depending on --mem. Past it, two
// things were observed in this course: chapter 05's store to 1 << 36 exited as a level-0
// stage-2 translation fault (captures/05-beyond-ipa.txt) and was handled like any unmapped
// address; chapter 03's store to 0xffff_ffff_ffff_ffe0 was an address size fault inside the
// guest, with no exit. Where one becomes the other is the physical-address size the CPU
// implements (PAMax) while the guest's MMU is off, or the size TCR_EL1.IPS selects once it is
// on (ARM ARM, "Address size fault"); a guest learns the implemented size from
// ID_AA64MMFR0_EL1.PARange, which a hypervisor may make report less. No run here measured it.
// Armv9.4's FEAT_D128 allows 56-bit physical addresses (52 with FEAT_LPA), so anything at or
// above 1 << 56 is wider than any Arm CPU can address and never reaches the VMM.
export const IPA_BITS_RUNS = 36;
export const PA_BITS_MAX = 56;
const IPA_LIMIT = 1n << BigInt(IPA_BITS_RUNS);
const PA_LIMIT = 1n << BigInt(PA_BITS_MAX);

const NEVER = "never reaches the VMM: wider than any Arm physical address (56 bits at most, with FEAT_D128; " +
  "52 with FEAT_LPA), so with the " +
  "MMU off, as at reset, it is an address size fault taken inside the guest at EL1 (chapter 03); " +
  "no VM exit, nothing logged";
function beyondIpa(space, outcome) {
  return `past ${space}. If the guest's CPU accepts an address this wide, stage 2 refuses it with a ` +
    `level-0 translation fault and it exits like any unmapped address, as chapter 05 saw at 1 << 36: ${outcome}. ` +
    "If it is wider than the physical-address size the CPU implements (with the MMU off; with it on, the " +
    "size the guest's TCR_EL1.IPS selects), it is an address size fault inside the guest and never reaches " +
    "the VMM. A guest learns that size from ID_AA64MMFR0_EL1.PARange; no run here measured it";
}

/**
 * Where an access to `addr` (BigInt) lands on the vmapple board and on virt. `reach` is "map"
 * (inside the IPA space), "beyond-ipa" (past it, outcome depends on the guest's PA range) or
 * "never" (wider than any physical address: the VMM cannot see it).
 */
export function lookup(addr, ramSize = RAM_SIZE_RUNS) {
  const a = BigInt(addr);
  const reach = a >= PA_LIMIT ? "never" : a >= IPA_LIMIT ? "beyond-ipa" : "map";
  let row = null;
  for (const r of REGIONS) {
    if (a >= BigInt(r.base) && a < BigInt(rowEnd(r, ramSize))) { row = r; break; }
  }
  let macvmm;
  if (reach === "never") macvmm = NEVER;
  else if (reach === "beyond-ipa") {
    macvmm = beyondIpa("the 36-bit IPA space macvmm sets up for this board with 4 GiB of RAM",
      "the unknown-MMIO logger records it with no row name");
  } else if (!row) macvmm = "no row on the vmapple board: the unknown-MMIO logger records it as (no layout row)";
  else if (row.id === "gicr") macvmm = a - BigInt(row.base) < BigInt(GICR_FRAME)
    ? "in-kernel GIC: the first redistributor frame, handled inside Hypervisor.framework"
    : "past the first 128 KiB frame: the unknown-MMIO logger records it as (gicr)";
  else if (row.inMacvmm && row.macvmm === LOGGER) macvmm = `the unknown-MMIO logger records it as (${row.inMacvmm}); reads return 0`;
  else macvmm = row.macvmm;
  const offset = row ? a - BigInt(row.base) : null;

  let virt = null;
  for (const v of VIRT) {
    if (a >= BigInt(v.base) && a < BigInt(v.base + v.size)) { virt = `${v.name}, offset ${shortHex(a - BigInt(v.base))}`; break; }
  }
  if (!virt && a >= BigInt(VIRT_RAM_BASE) && a < BigInt(VIRT_RAM_MAX_END)) virt = "RAM, when --mem reaches it (virt's RAM starts at 0x4000_0000)";
  if (!virt) {
    if (reach === "never") virt = NEVER;
    else if (a >= IPA_LIMIT) virt = beyondIpa("virt's IPA space (36 to 38 bits, set by --mem)", "an unhandled access, which stops the guest with exit code 3 by default");
    else virt = "nothing: an unhandled access, which stops the guest with exit code 3 by default";
  }
  return { addr: a, row, offset, reach, macvmm, virt };
}

function shortHex(n) { return `0x${BigInt(n).toString(16)}`; }

// With QEMU's sources off, macvmm's map is hidden too (it is built from QEMU's), so for an address
// in a row nothing switched on names, or in a gap between rows, the lab cannot tell which.
const HIDDEN_MACVMM = "not shown with QEMU's sources off: macvmm's map is built from QEMU's, so nothing " +
  "switched on says whether a device model or the unknown-MMIO logger answers here";

/**
 * `lookup` as the reader may see it with evidence `ev`. With QEMU's sources on it is `lookup`.
 * With them off only a row something switched on gives an address (an observed row) is matched,
 * its log label (a QEMU name) is not printed, and any other address inside the IPA space reads
 * the same whether it is in an unseen row or in a gap: "no row known with this evidence".
 * Adds `rowText`, the line the view shows for the vmapple row.
 */
export function lookupFor(addr, ev, ramSize = RAM_SIZE_RUNS) {
  const l = lookup(addr, ramSize);
  if (ev.includes("q")) {
    return { ...l, rowText: l.row ? `${l.row.name}, offset ${shortHex(l.offset)}` : "none" };
  }
  if (l.row && classify(l.row.id, ev).known) {
    let macvmm = l.macvmm;
    if (/records it as \([a-z0-9-]+\)/.test(macvmm)) {
      macvmm = macvmm.replace(/records it as \([a-z0-9-]+\)/, "records it, under a row label that comes from QEMU's names (hidden)");
    }
    return { ...l, macvmm, rowText: `${displayName(l.row.id, ev)}, offset ${shortHex(l.offset)}` };
  }
  const hidden = l.reach === "map";
  return {
    ...l, row: null, offset: null,
    macvmm: hidden ? HIDDEN_MACVMM : l.macvmm,
    rowText: hidden ? "no row known with this evidence" : "none",
  };
}

// ---- state, actions, share string ----------------------------------------------------------
// The all-ones run starts hidden: chapter 24 asks the reader to predict it in sitting B, so
// the lab shows it only once the reader asks (`reveal`). Switching it on reveals it too.
//
// `pick` is the row the reader chose (a chip, or the share link); `sel` is the row shown, which
// is the typed address's row when it has one the evidence lets the reader see, and `pick`
// otherwise. So typing 0x1234_5678 one key at a time never leaves a row behind that a prefix
// such as 0x123456 happened to fall in, and clearing the box returns to the reader's choice.
export const DEFAULT_EV = "qz";

export function initialState() {
  return { ev: DEFAULT_EV, sel: "cfg", pick: "cfg", addr: "", reveal: false };
}

function normEv(s) { return ["q", "z", "o"].filter((k) => s.includes(k)).join(""); }

/** The typed address's row, if the evidence lets the reader see one; otherwise null. */
function addrRow(addr, ev) {
  if (typeof addr !== "string" || !addr.trim()) return null;
  const p = parseAddr(addr);
  if (typeof p !== "bigint") return null;
  const row = lookupFor(p, ev).row;
  return row ? row.id : null;
}

function withSel(s) { return { ...s, sel: addrRow(s.addr, s.ev) || s.pick }; }

export function step(state, action) {
  const s = { ...state };
  switch (action && action.type) {
    case "toggle": {
      if (!["q", "z", "o"].includes(action.key)) return state;
      s.ev = normEv(s.ev.includes(action.key) ? s.ev.replace(action.key, "") : s.ev + action.key);
      if (action.key === "o") s.reveal = true;
      return withSel(s);
    }
    case "reveal": return withSel({ ...s, reveal: true, ev: normEv(`${s.ev}o`) });
    // A chip press is an explicit choice: it wins over the address until the address changes.
    case "select": return REGION_IDS.includes(action.id) ? { ...s, sel: action.id, pick: action.id } : state;
    case "addr": {
      s.addr = typeof action.text === "string" ? action.text.slice(0, 64) : "";
      return withSel(s);
    }
    case "reset": return initialState();
    default: return state;
  }
}

/**
 * `<evidence>[+][@<row>][~<hex address>]`: evidence is a subset of "qzo" in that order, or "-"
 * for none; `+` means the all-ones run is revealed though switched off (any evidence with "o"
 * is revealed already); `@` is the reader's chosen row (`pick`). The default state writes no
 * hash. An empty evidence part (a hand-edited or truncated link) reads as the default evidence,
 * never as "none".
 */
export function encodeHash(state) {
  const p = typeof state.addr === "string" && state.addr.trim() ? parseAddr(state.addr) : null;
  const addrPart = typeof p === "bigint" ? `~${p.toString(16)}` : "";
  const pick = state.pick || state.sel;
  const selPart = pick !== "cfg" ? `@${pick}` : "";
  const revPart = state.reveal && !state.ev.includes("o") ? "+" : "";
  if (state.ev === DEFAULT_EV && !revPart && !selPart && !addrPart) return null;
  return `${state.ev || "-"}${revPart}${selPart}${addrPart}`;
}

export function decodeHash(str) {
  const base = initialState();
  if (typeof str !== "string" || str.length > 64 || str === "") return base;
  const m = /^(q?z?o?|-)(\+)?(?:@([a-z0-9-]{1,16}))?(?:~([0-9a-f]{1,16}))?$/.exec(str);
  if (!m) return base;
  const ev = m[1] === "-" ? "" : m[1] === "" ? DEFAULT_EV : m[1];
  const pick = m[3] && REGION_IDS.includes(m[3]) ? m[3] : base.pick;
  const addr = m[4] ? hex(BigInt(`0x${m[4]}`)) : "";
  return withSel({ ev, sel: pick, pick, addr, reveal: Boolean(m[2]) || ev.includes("o") });
}

// ---- what the readout says -----------------------------------------------------------------
/** The row's "what would move it" suggestion; never names a result of the hidden all-ones run. */
export function nextText(id, state) {
  const r = region(id);
  if (!r) throw new Error(`no row ${id}`);
  const seen = Boolean(state && (state.reveal || (typeof state.ev === "string" && state.ev.includes("o"))));
  return !seen && r.nextHidden ? r.nextHidden : r.next;
}

export function evidenceList(ev) {
  const names = { q: "QEMU's sources", z: "the zero run", o: "the all-ones run" };
  const on = ["q", "z", "o"].filter((k) => ev.includes(k)).map((k) => names[k]);
  return on.length ? on.join(", ") : "nothing";
}

/** The address part of the readout: "Address 0x…: <where>." (no leading space). */
function addrPart(state) {
  if (!state.addr || !state.addr.trim()) return "";
  const p = parseAddr(state.addr);
  if (typeof p !== "bigint") return `Address: ${p.error}`;
  const l = lookupFor(p, state.ev);
  let where;
  if (l.row) where = `${displayName(l.row.id, state.ev)}, offset ${shortHex(l.offset)}`;
  else if (l.reach === "never") where = "no row; it never reaches the VMM";
  else if (l.reach === "beyond-ipa") where = "no row, past the IPA space";
  else if (!state.ev.includes("q")) where = "no row known with this evidence";
  else where = "no row";
  return `Address ${hex(p)}: ${where}.`;
}
function addrSentence(state) { const a = addrPart(state); return a ? ` ${a}` : ""; }

function rowLead(r, c) { return c.named ? `${c.name} at ${hex(r.base)}` : c.name; }

/** The full readout, shown on the page (not spoken on every change). */
export function summary(state) {
  const r = region(state.sel);
  const c = classify(r.id, state.ev);
  const { counts } = inventory(state.ev);
  return `${rowLead(r, c)}: ${c.tag}. Seen in the reference runs: ${c.seen}. ` +
    `Evidence on: ${evidenceList(state.ev)}. Whole map: ${counts.observed} observed, ${counts.inferred} inferred, ${counts.unknown} unknown.` +
    addrSentence(state);
}

const SOURCE_NAME = { q: "QEMU's sources", z: "Zero run", o: "All-ones run" };
const MOVE_LIST_MAX = 5;

/**
 * Which rows changed column between evidence `before` and `after`, as one short sentence for
 * the live region, e.g. "Zero run off: firmware, cfg, pvpanic, GIC distributor, GIC
 * redistributors moved to inferred." Names are the ones `after` allows (no QEMU name once
 * QEMU's sources are off). Empty when the evidence did not change.
 */
export function changeNote(before, after) {
  if (before === after) return "";
  const flipped = ["q", "z", "o"].filter((k) => before.includes(k) !== after.includes(k));
  const lead = flipped.map((k) => `${SOURCE_NAME[k]} ${after.includes(k) ? "on" : "off"}`).join(", ");
  const moved = Object.fromEntries(COLUMNS.map((c) => [c, []]));
  for (const id of REGION_IDS) {
    const was = classify(id, before).column, now = classify(id, after).column;
    if (was !== now) moved[now].push(displayName(id, after));
  }
  const parts = COLUMNS.filter((c) => moved[c].length).map((c) => {
    const names = moved[c];
    const shown = names.slice(0, MOVE_LIST_MAX).join(", ");
    const more = names.length > MOVE_LIST_MAX ? ` and ${names.length - MOVE_LIST_MAX} more` : "";
    return `${shown}${more} moved to ${c}`;
  });
  return `${lead}: ${parts.length ? parts.join("; ") : "no row changed column"}.`;
}

/**
 * The short sentence the live region speaks after a change. With `prev` (the state before an
 * evidence change) it starts with which rows moved. When a typed address has no row it leads
 * with the address, so the reader hears what they typed before the row still selected.
 */
export function announcement(state, prev = null) {
  const r = region(state.sel);
  const c = classify(r.id, state.ev);
  const { counts } = inventory(state.ev);
  const note = prev && prev.ev !== state.ev ? `${changeNote(prev.ev, state.ev)} ` : "";
  const map = `Map: ${counts.observed} observed, ${counts.inferred} inferred, ${counts.unknown} unknown.`;
  const addr = addrPart(state);
  if (addr && !addrRow(state.addr, state.ev)) {
    return `${note}${addr} Still selected: ${c.name}, ${c.tag}. ${map}`;
  }
  return `${note}${c.name}: ${c.tag}. ${map}${addr ? ` ${addr}` : ""}`;
}
