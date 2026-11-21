// boot-log-annotator model: pure logic, no DOM (course/site/LABS.md section 3).
//
// It reads a Linux boot log (pasted text, a dropped file, or a capture from course/captures) and
// gives every line:
//   - a stage, one of the eight of the `linux-boot-sequence` primer, either from a rule that knows
//     the line or, for housekeeping, from its position (the stage the boot was in);
//   - for lines it knows, what the line means, what part of *our* machine caused it (the device-tree
//     node and the chapter that built it), and checks against macvmm's memory map;
// and the whole log a verdict: which stages completed, the next one it was waiting for, how it
// ended, what the time stamps and the VMM's exit status say.
//
// Every byte of a boot log was chosen by the guest (or by whoever made the file). So the input is
// capped, control bytes are shown as visible escapes and counted, nothing is ever treated as markup,
// and no regular expression here can backtrack badly on a long line (lines are capped first).

// ---- limits -------------------------------------------------------------------------------

export const LIMITS = Object.freeze({
  maxChars: 2 * 1024 * 1024, // characters kept from a paste or a file
  maxFileBytes: 16 * 1024 * 1024, // a bigger file is refused before reading
  maxLines: 20000,
  maxLineLen: 2000, // longer lines are cut, and say so
});

// ---- macvmm's machine (crates/vmm/src/arch/layout.rs; model.test.mjs re-reads that file) -------

export const LAYOUT = Object.freeze({
  GICD_BASE: 0x0800_0000,
  GICR_BASE: 0x080a_0000,
  GICR_FRAME_SIZE: 0x2_0000,
  PL011_BASE: 0x0900_0000,
  PL031_BASE: 0x0901_0000,
  RAM_BASE: 0x4000_0000,
  PL011_INTID: 33,
});

// ---- where to read more ---------------------------------------------------------------------

const SITE = "/build-your-own/vmm/";

/** The chapters the annotations cite. model.test.mjs checks titles and paths against chapters.json. */
export const CHAPTERS = Object.freeze({
  "02": ["An exception, one level up: your first VM exit", "bare-machine/first-exit/"],
  "04": ["Guest memory: the only safe access is a copy", "memory/guest-memory/"],
  "05": ["Two stages, one map: holes in stage 2 on purpose", "memory/address-space/"],
  "06": ["vCPU state: registers, PSTATE and reset", "cpu/vcpu-state/"],
  "07": ["The exit loop: decoding syndromes and emulating MMIO", "cpu/exit-loop/"],
  "08": ["System registers, injection, hypercalls and PSCI", "cpu/traps-psci/"],
  "09": ["A device is a state machine: the bus, PL011 and PL031", "devices/mmio-pl011/"],
  "10": ["The Device Tree: the VMM's promise to the guest", "devices/device-tree/"],
  "11": ["Getting the CPU back: the timer and a bare interrupt", "interrupts/timer-irq/"],
  "12": ["Why an interrupt controller, and why in the kernel", "interrupts/gicv3/"],
  "13": ["Loading kernels: arm64 Image, initramfs and ELF", "linux/loaders/"],
  "14": ["Booting Linux to a shell", "linux/linux-boot/"],
  "15": ["Rings and a doorbell: the virtio-mmio transport", "virtio/virtio-mmio/"],
  "17": ["virtio-rng (worked) and virtio-console (faded)", "virtio/virtio-rng-console/"],
  "18": ["virtio-blk: a root filesystem that persists", "virtio/virtio-blk/"],
  "20": ["SMP: many vCPUs, many threads", "smp/smp/"],
  "21": ["Firmware: a stricter guest (U-Boot, flash, ISV=0)", "firmware/firmware/"],
  "23": ["macOS guests, the high road: Virtualization.framework", "macos/vz-macos/"],
});

/** Primers the annotations cite, by slug, with their titles (checked against chapters.json). */
export const PRIMERS = Object.freeze({
  "linux-boot-sequence": "The Linux boot sequence",
  "primecell-ids": "PrimeCell peripheral IDs",
  "smccc": "SMCCC: the calling convention for calls to a higher level",
  "caches": "Caches and coherency",
  "uefi": "UEFI: the interface between firmware and an OS loader",
  "cpio-initramfs": "cpio and the initramfs",
  "arm64-boot-protocol": "The arm64 boot protocol",
});

export function chapterHref(id) { return CHAPTERS[id] ? SITE + CHAPTERS[id][1] : null; }
export function primerHref(slug) { return PRIMERS[slug] ? `${SITE}primers/${slug}/` : null; }
export const ESR_LAB = `${SITE}labs/esr-decoder/`;
export const PSTATE_LAB = `${SITE}labs/pstate-builder/`;

// ---- the eight stages (the `linux-boot-sequence` primer's table; the test parses it) ---------

export const STAGES = Object.freeze([
  null,
  { n: 1, name: "head.S, MMU on", milestones: [{ label: "Booting Linux on physical CPU 0x...", rule: "booting" }], suspect: "entry state, placement", ch: ["06", "13"] },
  { n: 2, name: "First DT read", milestones: [{ label: "Machine model: ...", rule: "model" }], suspect: "`x0`, the DTB header; for earlycon, the command line and PL011 8-bit stores", ch: ["10", "13", "09"] },
  { n: 3, name: "Interrupt controller", milestones: [{ label: "GICv3: CPU0: found redistributor 0 ...", rule: "gicr" }], suspect: "`/intc` node, GIC bases", ch: ["12"] },
  { n: 4, name: "Timer and delay loop", milestones: [{ label: "arch_timer: cp15 timer running at 24.00MHz (virt).", rule: "arch-timer" }], suspect: "`/timer` node (compatible, PPIs), `CNTFRQ_EL0`; vtimer exits only with `--irqchip none`", ch: ["11"] },
  { n: 5, name: "First process, other CPUs", milestones: [{ label: "smp: Brought up ...", rule: "smp-up" }], suspect: "PSCI `CPU_ON`", ch: ["08", "20"] },
  { n: 6, name: "Driver binding", milestones: [{ label: "ttyAMA0 at MMIO 0x9000000", rule: "ttyama" }, { label: "rtc-pl031 ... registered as rtc0", rule: "rtc" }], suspect: "`compatible`, `reg`, ID registers", ch: ["09", "10"] },
  { n: 7, name: "initramfs", milestones: [{ label: "Freeing initrd memory: ...", rule: "initrd-freed" }], suspect: "`/chosen` initrd addresses, BSS overlap", ch: ["13"] },
  { n: 8, name: "User space", milestones: [{ label: "Run /init as init process", rule: "run-init" }], suspect: "the initramfs's `/init`", ch: ["13"] },
]);

// ---- small helpers --------------------------------------------------------------------------

const hex = (n) => `0x${n.toString(16)}`;
/** Parse a hex string of at most 16 digits (after an optional 0x) to a BigInt, or null. */
export function parseHex(s) {
  const t = String(s).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,16}$/.test(t)) return null;
  return BigInt(`0x${t}`);
}
const big = (n) => BigInt(n);
const kib = (bytes) => bytes / 1024n;

// ---- rules ----------------------------------------------------------------------------------
//
// A rule: id, re (tested against the message, the part after the time stamp), kind, stage (a number,
// null to keep the stage the boot is in, or a function of the match), and the text. `overlap: true`
// means the line belongs to its stage without moving the boot's position (stage 7 runs in the
// background while stage 6 goes on). `check(m)` returns notes comparing the line with macvmm's
// machine. Kinds: milestone, machine (a part of our machine caused it), failure, context (part of a
// panic or Oops report), info (explained housekeeping).

const R = [];
function rule(r) { R.push(r); }

// Stage 1
rule({
  id: "booting", re: /^Booting Linux on physical CPU (0x[0-9a-f]+) \[(0x[0-9a-f]+)\]/, kind: "milestone", stage: 1,
  title: "The first line start_kernel() prints",
  what: "head.S has built its first page tables, turned the MMU on and jumped to C. The first number is this CPU's affinity, from `MPIDR_EL1`; the second is the CPU identity the guest is shown, from `MIDR_EL1`.",
  cause: "Our entry state: `x0` pointing at the DTB, the MMU off, the Image placed where the boot protocol wants it (chapter 13). The affinity `0x0` is what our VMM put in `MPIDR_EL1` (chapter 06).",
  node: "/cpus/cpu@0", ch: ["13", "06", "23"], primers: ["arm64-boot-protocol"],
  check(m) {
    const mpidr = parseHex(m[1]); const midr = parseHex(m[2]);
    const notes = [];
    if (mpidr === 0n) notes.push("Affinity 0 matches `reg = <0x00>` in `/cpus/cpu@0`.");
    if (midr === 0x610f0000n) notes.push("Implementer `0x61` (Apple), part number 0: Hypervisor.framework's default `MIDR_EL1`, not the chip's own. Real Apple cores have nonzero part numbers; macvmm never sets this register (chapter 23).");
    else if (midr !== null && (midr >> 24n) === 0x61n) notes.push("Implementer `0x61`: Apple. The part number (bits 15 to 4) says which core the guest is told it runs on.");
    return notes;
  },
});

// Stage 2
rule({
  id: "banner", re: /^Linux version (\S+)/, kind: "info", stage: 2,
  title: "The kernel's banner",
  what: "The first line of `start_kernel()` proper: the kernel version, who built it and with which compiler.",
  ch: ["13"], primers: ["linux-boot-sequence"],
  check(m) { return m[1] === "6.18.60-0-virt" ? ["This is the course's pinned Alpine kernel."] : [`Version ${m[1]}: not the course's pinned 6.18.60-0-virt, so some lines may differ from the captures.`]; },
});
rule({
  id: "crng", re: /^random: crng init done/, kind: "machine", stage: null,
  title: "The random-number generator is ready",
  what: "The kernel's random-number generator has enough entropy. At time zero that means someone handed it seed bytes before boot.",
  cause: "The `rng-seed` property in `/chosen`, fresh random bytes our VMM writes into the DTB (chapter 10). The kernel trusts them as boot-loader randomness.",
  node: "/chosen", ch: ["10"],
});
rule({
  id: "model", re: /^Machine model: (.*)$/, kind: "milestone", stage: 2,
  title: "The kernel's first look at our DTB",
  what: "Read from the root node's `model` property with the early, flat DT helpers, before the kernel has a memory allocator.",
  cause: "The root node's `model` in the device tree our VMM generates (chapter 10).",
  node: "/", ch: ["10"], primers: ["linux-boot-sequence"],
  check(m) {
    const v = m[1].trim();
    if (v === "macvmm-virt") return ["`macvmm-virt`: this log came from macvmm."];
    if (v === "linux,dummy-virt") return ["`linux,dummy-virt`: QEMU's `virt` machine, the reference platform our memory map copies."];
    return [`Model \`${v}\`: not macvmm's DTB. The stages are the same; the addresses may not be.`];
  },
});
rule({
  id: "earlycon", re: /^earlycon: (\S+) at MMIO (0x[0-9a-f]+)/, kind: "machine", stage: 2,
  title: "earlycon: printing before any driver exists",
  what: "The kernel found `earlycon=` on the command line and can now print by storing bytes to the UART's data register directly. Lines from here on reach the serial port as they are printed, not when the real console registers. (`pl11` is the kernel's own spelling.)",
  cause: "`earlycon=pl011,0x09000000` in `bootargs` (`/chosen`, chapter 10), then 8-bit stores to our PL011's data register (chapter 09).",
  node: "/chosen", ch: ["10", "09"], primers: ["linux-boot-sequence"],
  check(m) { const a = parseHex(m[2]); return a === big(LAYOUT.PL011_BASE) ? ["Address matches macvmm's PL011 at 0x0900_0000."] : [`Address ${m[2]} is not macvmm's PL011 (0x0900_0000): check the \`earlycon=\` address.`]; },
});
rule({
  id: "bootcon-on", re: /^printk: legacy bootconsole \[(\w+)\] enabled/, kind: "machine", stage: null,
  title: "The boot console is on",
  what: "earlycon is registered as a boot console. It will be retired when a real console (`ttyAMA0`) registers.",
  cause: "earlycon writing to our PL011 (chapter 09).", node: "/chosen", ch: ["09"], primers: ["linux-boot-sequence"],
});
rule({
  id: "efi-none", re: /^efi: UEFI not found/, kind: "info", stage: null,
  title: "No UEFI firmware",
  what: "Our VMM boots the kernel directly, with no firmware in between, so there are no UEFI services. Chapter 21 adds firmware.",
  ch: ["21"], primers: ["uefi"],
});
rule({
  id: "no-reserved", re: /^OF: reserved mem: .*No reserved-memory node/, kind: "machine", stage: null,
  title: "No reserved-memory node",
  what: "The kernel looked for a `/reserved-memory` node (RAM it must not touch, such as firmware's) and found none.",
  cause: "Our device tree has no `/reserved-memory` node: nothing in guest RAM belongs to anyone but the kernel (chapter 10).",
  node: "/", ch: ["10"],
});
function memRangeCheck(m) {
  const a = parseHex(m[1]); const b = parseHex(m[2]);
  if (a === null || b === null || b < a) return [];
  const size = b - a + 1n;
  const mib = size / (1024n * 1024n);
  const notes = [`${mib} MiB starting at ${hex(a)}.`];
  if (a === big(LAYOUT.RAM_BASE)) notes.push("Starts at 0x4000_0000, macvmm's RAM base, as the `/memory@40000000` node says.");
  else notes.push(`Does not start at macvmm's RAM base 0x4000_0000: check the \`memory\` node's \`reg\`.`);
  return notes;
}
rule({
  id: "numa-fake", re: /^NUMA: Faking a node at \[mem (0x[0-9a-f]+)-(0x[0-9a-f]+)\]/, kind: "machine", stage: null,
  title: "All of RAM, as one memory node",
  what: "With no NUMA description, the kernel treats all RAM as one node. The range is the `memory` node's `reg`.",
  cause: "The `/memory@40000000` node, sized by `--mem` (chapters 04 and 10).", node: "/memory@40000000", ch: ["04", "10"], check: memRangeCheck,
});
rule({
  id: "mem-node", re: /^\s*node\s+0: \[mem (0x[0-9a-f]+)-(0x[0-9a-f]+)\]/, kind: "machine", stage: null,
  title: "The memory node, as the kernel read it",
  what: "Printed once the memory allocator is up, but read in the first, flat pass over the DTB: where RAM is.",
  cause: "The `reg` of `/memory@40000000` (chapters 04 and 10).", node: "/memory@40000000", ch: ["04", "10"], primers: ["linux-boot-sequence"], check: memRangeCheck,
});
rule({
  id: "mem-head", re: /^(Early memory node ranges|Initmem setup node (\d+) \[mem )/, kind: "info", stage: null,
  title: "Setting up memory", what: "The memory allocator is being built from the `memory` node read earlier.", node: "/memory@40000000", ch: ["04", "10"],
});
rule({
  id: "logbuf", re: /^printk: log buffer data \+ meta data: (\d+)/, kind: "info", stage: null,
  title: "The log buffer", what: "The size of the ring buffer in RAM where `printk` keeps every message. Consoles, and `dmesg`, read from it.", primers: ["linux-boot-sequence"],
});
rule({
  id: "nr-cpus", re: /^rcu: \s*RCU restricting CPUs from NR_CPUS=(\d+) to nr_cpu_ids=(\d+)/, kind: "machine", stage: null,
  title: "How many CPUs this machine can have",
  what: "The kernel is built for up to `NR_CPUS` CPUs, and sizes its tables for the number the DT lists.",
  cause: "The `cpu` nodes under `/cpus` (chapter 10; chapter 20 adds more).", node: "/cpus", ch: ["10", "20"],
});
rule({
  id: "dmi", re: /^DMI not present or invalid/, kind: "info", stage: null,
  title: "No firmware tables", what: "DMI (SMBIOS) tables describe a PC's hardware and come from firmware. There is no firmware here.", ch: ["21"],
});
rule({
  id: "zones", re: /^(Zone ranges:|\s+(DMA|DMA32|Normal)\s+(?:\[mem (0x[0-9a-f]+)-(0x[0-9a-f]+)\]|empty))/, kind: "info", stage: null,
  title: "Memory zones",
  what: "How the kernel splits RAM by which devices can address it. `DMA` and `DMA32` hold RAM that devices with a short address reach can use; `Normal` is the rest. `empty` means no RAM falls in that zone.",
  node: "/memory@40000000", ch: ["04"],
  check(m) {
    if (!m[2]) return [];
    if (!m[3]) return [`\`${m[2]}\` is empty: none of this machine's RAM falls in it.`];
    const a = parseHex(m[3]); const b = parseHex(m[4]);
    if (a === null || b === null || b < a) return [];
    const mib = (b - a + 1n) / (1024n * 1024n);
    const four = 1n << 32n;
    const notes = [`\`${m[2]}\`: ${mib} MiB, ${hex(a)} to ${hex(b)}, ${b < four ? "all below 4 GiB" : a >= four ? "all above 4 GiB" : "crossing 4 GiB"}.`];
    if (m[2] === "DMA" && a === big(LAYOUT.RAM_BASE) && b === 0x5fffffffn) notes.push("With `--mem 512M`, all of RAM sits below 4 GiB, so all of it is in `DMA`.");
    return notes;
  },
});
rule({
  id: "psci-probe", re: /^psci: probing for conduit method from DT/, kind: "machine", stage: null,
  title: "PSCI: which instruction to call firmware with",
  what: "PSCI is Arm's interface for starting CPUs and powering off. The kernel asks the DT whether to reach it with `hvc` or `smc`.",
  cause: "`method = \"hvc\"` in our `/psci` node: calls come to our VMM as hypervisor-call exits (chapter 08).",
  node: "/psci", ch: ["08"], primers: ["smccc"],
});
rule({
  id: "psci-version", re: /^psci: PSCIv(\d+)\.(\d+) detected in firmware/, kind: "machine", stage: null,
  title: "PSCI answered",
  what: "The kernel called `PSCI_VERSION` and got an answer. It is the first time Linux talks to our VMM on purpose.",
  cause: "`/psci` says `method = \"hvc\"`; our answer to `PSCI_VERSION` (chapter 08).",
  node: "/psci", ch: ["08"], primers: ["smccc"],
  check(m) { return m[1] === "1" && m[2] === "1" ? ["Version 1.1: what macvmm answers."] : []; },
});
rule({
  id: "psci-ids", re: /^psci: Using standard PSCI v0\.2 function IDs/, kind: "machine", stage: null,
  title: "Standard function numbers",
  what: "PSCI 0.2 and later fix the function numbers, so the DT does not have to list them.",
  cause: "`arm,psci-0.2` in our `/psci` node's `compatible` (chapter 08).", node: "/psci", ch: ["08"],
});
rule({
  id: "psci-migrate", re: /^psci: Trusted OS migration not required/, kind: "machine", stage: null,
  title: "No Trusted OS to worry about",
  what: "The kernel asked `PSCI_MIGRATE_INFO_TYPE` whether a Trusted OS is pinned to one CPU.",
  cause: "Our answer to `PSCI_MIGRATE_INFO_TYPE`: there is none (chapter 08).", node: "/psci", ch: ["08"], primers: ["smccc"],
});
rule({
  id: "smccc", re: /^psci: SMC Calling Convention v(\d+)\.(\d+)/, kind: "machine", stage: null,
  title: "SMCCC version",
  what: "The calling convention every firmware call follows: which registers carry the function number, arguments and results.",
  cause: "Our answer to `SMCCC_VERSION` (chapter 08).", node: "/psci", ch: ["08"], primers: ["smccc"],
});
rule({
  id: "icache", re: /^Detected (\w+) I-cache on CPU(\d+)/, kind: "machine", stage: null,
  title: "Instruction cache type",
  what: "Read from `CTR_EL0`, the cache type register. PIPT means the cache is indexed and tagged by physical address.",
  cause: "The real CPU's `CTR_EL0`, which Hypervisor.framework lets the guest read unchanged.", ch: ["06"], primers: ["caches"],
});
rule({
  id: "feat-gic", re: /^CPU features: detected: GICv3 CPU interface/, kind: "machine", stage: null,
  title: "The GIC's CPU interface exists",
  what: "The CPU's ID register `ID_AA64PFR0_EL1` says the GICv3 system-register interface is there.",
  cause: "The in-kernel GIC our VMM asked Hypervisor.framework for (chapter 12). With `--irqchip none` this feature would be absent.",
  node: "/intc@8000000", ch: ["12"],
});
rule({
  id: "features", re: /^CPU features: detected: (.*)$/, kind: "info", stage: null,
  title: "A CPU feature",
  what: "Read from the CPU's ID registers. Hypervisor.framework shows the guest the host core's features, minus a few it hides.",
  ch: ["06", "08"],
});
rule({
  id: "cmdline", re: /^Kernel command line: (.*)$/, kind: "machine", stage: null,
  title: "The kernel command line",
  what: "Printed by `start_kernel()` after `setup_arch()` returns. Every option that matters later is here.",
  cause: "The `bootargs` property of `/chosen`, from `--cmdline` (chapter 10).",
  node: "/chosen", ch: ["10"], primers: ["linux-boot-sequence"],
  check(m) {
    const words = m[1].trim().split(/\s+/);
    const notes = [];
    const ec = words.find((w) => w.startsWith("earlycon"));
    notes.push(ec ? `\`${ec}\`: lines reach the serial port as they are printed.` : "No `earlycon`: nothing reaches the serial port until the `ttyAMA0` console registers in stage 6.");
    const con = words.filter((w) => w.startsWith("console="));
    if (con.length) notes.push(`${con.map((c) => `\`${c}\``).join(", ")}: the console the kernel will use once its driver binds.`);
    const t = words.find((w) => w.startsWith("macvmm.test="));
    if (t) notes.push(`\`${t}\`: read by the test initramfs's \`/init\`, not by the kernel (chapter 14).`);
    const p = words.find((w) => w.startsWith("panic="));
    if (p === "panic=-1") notes.push("`panic=-1`: reboot at once on a panic. The reboot is a PSCI `SYSTEM_RESET`.");
    return notes;
  },
});
rule({
  id: "nr-irqs", re: /^NR_IRQS: (\d+)/, kind: "info", stage: 3,
  title: "init_IRQ() begins",
  what: "The kernel sets up its interrupt bookkeeping and then looks in the DT for an interrupt controller.",
  ch: ["12"], primers: ["linux-boot-sequence"],
});

// Stage 3
rule({
  id: "gic-spis", re: /^GICv3: (\d+) SPIs implemented/, kind: "machine", stage: 3,
  title: "The distributor answered",
  what: "Linux read the GIC distributor's `GICD_TYPER` register: how many shared peripheral interrupts (SPIs) it has.",
  cause: "The first `reg` pair of `/intc@8000000`, where Hypervisor.framework's in-kernel GIC sits (chapter 12).",
  node: "/intc@8000000", ch: ["12"],
});
rule({
  id: "gic-ds", re: /^GICv3: GICD_CTLR\.DS=1/, kind: "info", stage: 3,
  title: "One security state", what: "The GIC runs with security disabled: there is no secure world to share it with.", node: "/intc@8000000", ch: ["12"],
});
rule({
  id: "gic-root", re: /^Root IRQ handler: gic_handle_irq/, kind: "info", stage: 3,
  title: "The GIC driver takes interrupts", what: "From now on every interrupt goes through the GIC driver's handler.", ch: ["12"],
});
rule({
  id: "gicr", re: /^GICv3: CPU(\d+): found redistributor (\d+) region (\d+):(0x[0-9a-f]+)/,
  kind: (m) => (m[1] === "0" ? "milestone" : "machine"), stage: (m) => (m[1] === "0" ? 3 : 5), overlap: true,
  title: "A CPU's redistributor was found",
  what: "The redistributor is the per-CPU part of the GIC. Linux found it at the address the DT gave and checked its identification register.",
  cause: "The second `reg` pair of `/intc@8000000` (chapter 12). Each vCPU's redistributor is 128 KiB further on.",
  node: "/intc@8000000", ch: ["12"],
  check(m) {
    const cpu = BigInt(m[1]); const addr = parseHex(m[4]);
    const want = big(LAYOUT.GICR_BASE) + cpu * big(LAYOUT.GICR_FRAME_SIZE);
    const notes = [];
    if (addr === want) notes.push(`${hex(addr)} = 0x080a_0000 + ${cpu} × 0x2_0000: macvmm's redistributor for vCPU ${cpu}.`);
    else notes.push(`macvmm's redistributor for vCPU ${cpu} is at ${hex(want)}; this one is at ${m[4]}.`);
    if (m[1] !== "0") notes.push("A secondary CPU: it came up through PSCI `CPU_ON` (chapter 20).");
    return notes;
  },
});
rule({
  id: "gic-features", re: /^GICv3: GICv[34] features: /, kind: "info", stage: 3,
  title: "GIC features", what: "What the GIC says it supports, read from its registers.", node: "/intc@8000000", ch: ["12"],
});
rule({
  id: "no-redist", re: /^GICv3: No redistributor present/, kind: "failure", stage: 3,
  title: "No redistributor where the DT said",
  what: "Linux read the redistributor's `GICR_PIDR2` at the address the DT gave, and it did not say GICv3 or GICv4.",
  cause: "The second `reg` pair of `/intc@8000000` points where no redistributor answers. In macvmm that window reads as zero (chapter 14's breakage 2).",
  node: "/intc@8000000", ch: ["12", "14"],
});
rule({
  id: "no-redist-cpu", re: /^CPU(\d+): mpidr (\S+) has no re-distributor!/, kind: "failure", stage: 3,
  title: "This CPU has no redistributor",
  what: "Without a redistributor the CPU cannot receive its private interrupts: not the timer, not inter-processor interrupts.",
  cause: "The redistributor region in `/intc@8000000` (chapter 12).", node: "/intc@8000000", ch: ["12"],
});
rule({
  id: "jiffies", re: /^clocksource: jiffies:/, kind: "info", stage: 4,
  title: "The fallback clock",
  what: "The kernel registers its plain tick counter as a clocksource. It cannot tick until a timer exists.",
  ch: ["11"], primers: ["linux-boot-sequence"],
});

// Stage 4
rule({
  id: "arch-timer", re: /^arch_timer: cp15 timer running at ([\d.]+)MHz \((virt|phys)\)/, kind: "milestone", stage: 4,
  title: "The Generic Timer was found",
  what: "`time_init()` found the architected timer through the `/timer` node. `(virt)` means the kernel uses the virtual timer; `cp15` is a 32-bit-era name for system registers.",
  cause: "The `/timer` node and the counter frequency Hypervisor.framework sets in `CNTFRQ_EL0` (chapter 11).",
  node: "/timer", ch: ["11"], primers: ["linux-boot-sequence"],
  check(m) { return m[1] === "24.00" ? ["24 MHz: the counter frequency on Apple Silicon."] : []; },
});
rule({
  id: "arch-counter", re: /^clocksource: arch_sys_counter:/, kind: "machine", stage: 4,
  title: "The counter becomes a clocksource",
  what: "`arch_sys_counter` is the Generic Timer's counter, `CNTVCT_EL0`, which counts up 24 million times a second.",
  cause: "The virtual counter Hypervisor.framework gives each vCPU (chapter 11).", node: "/timer", ch: ["11"],
});
rule({
  id: "sched-clock", re: /^sched_clock: (\d+) bits at/, kind: "machine", stage: 4,
  title: "Time stamps start here",
  what: "`sched_clock` is the clock `printk` stamps messages with. Every line before this one reads 0.000000, because there was nothing to read the time from.",
  cause: "The same counter (chapter 11).", node: "/timer", ch: ["11"], primers: ["linux-boot-sequence"],
});
rule({
  id: "timer-probe", re: /^timer_probe: no matching timers found/, kind: "failure", stage: 4,
  title: "No timer in the device tree",
  what: "`timer_probe()` found no DT node whose `compatible` matches a timer driver, so no timer started and the timer's rate stayed zero.",
  cause: "A missing or misspelled `/timer` node (chapter 14's breakage 1).", node: "/timer", ch: ["11", "14"], primers: ["linux-boot-sequence"],
});
rule({
  id: "lpj", re: /^Calibrating delay loop \(skipped\).*lpj=(\d+)/, kind: "machine", stage: 4,
  title: "The delay loop, computed not measured",
  what: "Loops per jiffy, for short busy-waits. arm64 computes it from the timer frequency instead of spinning. BogoMIPS means nothing beyond this.",
  cause: "`CNTFRQ_EL0` again (chapter 11).", node: "/timer", ch: ["11"], primers: ["linux-boot-sequence"],
  check(m) { return m[1] === "24000" ? ["24,000,000 ticks per second / 1,000 ticks of the kernel's clock (`CONFIG_HZ=1000`) = 24,000."] : []; },
});
rule({
  id: "dummy-console", re: /^Console: colour dummy device/, kind: "info", stage: null,
  title: "A placeholder screen console", what: "There is no screen; the kernel registers a do-nothing console for it. Ours is the serial port.", ch: ["09"],
});
rule({
  id: "srcu", re: /^rcu: Hierarchical SRCU implementation/, kind: "info", stage: 5,
  title: "The first initcalls", what: "Printed by an `early` initcall. `kernel_init`, the thread that becomes PID 1, is running.",
  primers: ["linux-boot-sequence"],
});
rule({
  id: "efi-services", re: /^EFI services will not be available/, kind: "info", stage: null,
  title: "No UEFI runtime services", what: "Direct kernel boot: no firmware stays behind.", ch: ["21"], primers: ["uefi"],
});

// Stage 5
rule({
  id: "smp-start", re: /^smp: Bringing up secondary CPUs/, kind: "machine", stage: 5,
  title: "Starting the other CPUs",
  what: "One PSCI `CPU_ON` call per extra `cpu` node. With one vCPU there is nothing to start.",
  cause: "The `cpu` nodes under `/cpus` and our PSCI `CPU_ON` (chapters 08 and 20).", node: "/cpus", ch: ["08", "20"],
});
rule({
  id: "cpu-up", re: /^CPU(\d+): Booted secondary processor (0x[0-9a-f]+)/, kind: "machine", stage: 5,
  title: "A secondary CPU is running",
  what: "The CPU started at the entry point the kernel passed to PSCI `CPU_ON` and reported in.",
  cause: "Our `CPU_ON`: a new host thread for the vCPU, started at the requested address (chapter 20).", node: "/cpus", ch: ["20"],
});
rule({
  id: "smp-up", re: /^smp: Brought up (\d+) nodes?, (\d+) CPUs?/, kind: "milestone", stage: 5,
  title: "All CPUs are up",
  what: "Every CPU the DT lists is running.",
  cause: "The `cpu` nodes under `/cpus`: one `cpu@0` here; chapter 20 adds more vCPUs.", node: "/cpus/cpu@0", ch: ["20", "08"],
  check(m) { return [`${m[2]} CPU${m[2] === "1" ? "" : "s"}: one per \`cpu\` node in the DT.`]; },
});
rule({
  id: "smp-total", re: /^SMP: Total of (\d+) processors? activated/, kind: "machine", stage: null,
  title: "CPU count", what: "The same count, from the scheduler's side.", node: "/cpus", ch: ["20"],
});
rule({
  id: "started-el", re: /^CPU: All CPU\(s\) started at (EL\d)/, kind: "machine", stage: null,
  title: "Which exception level the kernel got",
  what: "Every CPU entered the kernel at this level. EL1 is the kernel's own level; a kernel that gets EL2 can be a hypervisor itself.",
  cause: "Our VMM starts every vCPU at EL1 (chapter 06).", ch: ["06"], primers: ["arm64-boot-protocol"],
});
rule({
  id: "memory", re: /^Memory: (\d+)K\/(\d+)K available/, kind: "machine", stage: null,
  title: "RAM, accounted",
  what: "Free RAM out of the total. The rest is the kernel's code, data and early allocations.",
  cause: "The `memory` node's size, from `--mem` (chapters 04 and 10).", node: "/memory@40000000", ch: ["04", "10"],
  check(m) { const t = BigInt(m[2]); return [`${m[2]}K = ${t / 1024n} MiB total${t === 524288n ? ", the chapter's `--mem 512M`" : ""}.`]; },
});
rule({
  id: "devtmpfs", re: /^devtmpfs: initialized/, kind: "info", stage: 6,
  title: "The driver model starts", what: "`do_basic_setup()` begins: the driver core, then the initcall levels in order. Devices and drivers arrive from here on.",
  primers: ["linux-boot-sequence"],
});

// Stage 6
rule({
  id: "pl011-drv", re: /^Serial: AMBA PL011 UART driver/, kind: "machine", stage: 6,
  title: "The PL011 driver registered (not bound yet)",
  what: "`pl011_init` registered the driver on the AMBA bus. Binding needs a device too, and the AMBA bus matches on the peripheral ID registers, not on `compatible`.",
  cause: "Nothing yet: this line appears even if our PL011 is broken (chapter 09).", node: "/pl011@9000000", ch: ["09"], primers: ["primecell-ids"],
});
rule({
  id: "ttyama", re: /^(\S+): ttyAMA(\d+) at MMIO (0x[0-9a-f]+) \(irq = (\d+), base_baud = (\d+)\) is a PL011 rev(\d+)/, kind: "milestone", stage: 6,
  title: "The UART driver bound to our PL011",
  what: "The AMBA bus read the eight identification registers at `0xFE0` to `0xFFC`, matched the `uart-pl011` driver, and its `probe()` mapped the `reg` window. `irq = 13` is Linux's own interrupt number, not the GIC's INTID 33.",
  cause: "`/pl011@9000000`, its clocks and its identification registers (chapters 09 and 10).",
  node: "/pl011@9000000", ch: ["09", "10"], primers: ["primecell-ids"],
  check(m) {
    const notes = [];
    const a = parseHex(m[3]);
    notes.push(a === big(LAYOUT.PL011_BASE) ? "MMIO 0x9000000: the node's `reg`, macvmm's PL011." : `MMIO ${m[3]} is not macvmm's PL011 (0x0900_0000).`);
    if (m[6] === "1") notes.push("rev1: from peripheral ID 0x00141011 (part 0x011, designer 0x41 Arm, revision 1).");
    return notes;
  },
});
rule({
  id: "console-on", re: /^printk: console \[(\w+)\] enabled/, kind: "machine", stage: null,
  title: "The real console is on",
  what: "The kernel replays its whole log buffer to the new console. In our captures the line appears twice: for that moment two consoles, the boot console and `ttyAMA0`, write to the same PL011.",
  cause: "`console=ttyAMA0` on the command line, now that the driver exists (chapter 10).", node: "/chosen", ch: ["10", "09"], primers: ["linux-boot-sequence"],
  check(m) { return m[1] === "hvc0" ? ["`hvc0`: the virtio console (chapter 17), not the PL011."] : []; },
});
rule({
  id: "legacy-console-on", re: /^printk: legacy console \[(\w+)\] enabled/, kind: "machine", stage: null,
  title: "A console is on",
  what: "A console driver registered and the kernel replayed its log buffer to it.",
  cause: "`console=` on the command line. `hvc0` is the virtio console (chapter 17).", node: "/chosen", ch: ["17", "10"],
});
rule({
  id: "bootcon-off", re: /^printk: legacy bootconsole \[(\w+)\] disabled/, kind: "machine", stage: null,
  title: "earlycon retired",
  what: "A real console exists, so the boot console stops. Also printed twice, for the same reason.",
  cause: "Our PL011 bound as `ttyAMA0` (chapter 09).", node: "/pl011@9000000", ch: ["09"],
});
rule({
  id: "cs-switch", re: /^clocksource: Switched to clocksource (\S+)/, kind: "machine", stage: null,
  title: "Timekeeping moved to the Generic Timer",
  what: "From the coarse tick counter to the counter `CNTVCT_EL0`.",
  cause: "The `/timer` node (chapter 11).", node: "/timer", ch: ["11"],
});
rule({
  id: "rtc", re: /^rtc-pl031 (\S+): registered as rtc(\d+)/, kind: "milestone", stage: 6, overlap: true,
  title: "The real-time clock bound",
  what: "Another PrimeCell on the AMBA bus: matched by its identification registers, then probed.",
  cause: "`/pl031@9010000` and its identification registers (chapter 09).",
  node: "/pl031@9010000", ch: ["09"], primers: ["primecell-ids"],
  check(m) { return m[1] === "9010000.pl031" ? ["`9010000.pl031`: the node's unit address, macvmm's PL031 at 0x0901_0000."] : []; },
});
rule({
  id: "rtc-set", re: /^rtc-pl031 \S+: setting system clock to (\S+)/, kind: "machine", stage: null, overlap: true,
  title: "Wall-clock time, from our RTC",
  what: "The kernel read the PL031's data register: seconds since 1970.",
  cause: "Our PL031 answers with the host's time (chapter 09).", node: "/pl031@9010000", ch: ["09"],
});
rule({
  id: "8250", re: /^Serial: 8250\/16550 driver/, kind: "info", stage: null,
  title: "A driver with nothing to drive", what: "The PC-style UART driver is built in and registers, but no DT node matches it. Harmless.", ch: ["10"],
});
rule({
  id: "hyperv", re: /^hv_vmbus: registering driver/, kind: "info", stage: null,
  title: "Another hypervisor's driver", what: "A Hyper-V driver registers and finds no Hyper-V bus. Linux checks the DT, never probes blindly. Harmless.", ch: ["10"],
});
rule({
  id: "kvm-nohyp", re: /^kvm \[\d+\]: HYP mode not available/, kind: "machine", stage: null,
  title: "This kernel cannot be a hypervisor here",
  what: "KVM needs EL2, and the kernel entered at EL1.",
  cause: "Our VMM starts vCPUs at EL1 (chapter 06).", ch: ["06"],
});
rule({
  id: "acpi-off", re: /^ACPI: Interpreter disabled/, kind: "info", stage: null,
  title: "No ACPI", what: "Machines describe themselves with a DT or with ACPI tables. Ours uses a DT.", ch: ["10"],
});
rule({
  id: "virtio-blk", re: /^virtio_blk (virtio\d+): \[(vd\w+)\] (\d+) 512-byte logical blocks/, kind: "machine", stage: 6, overlap: true,
  title: "A virtio disk", what: "The `virtio_blk` driver found a disk behind a virtio-mmio slot and read its capacity.",
  cause: "Our virtio-blk device and its `virtio_mmio` node (chapters 15 and 18).", ch: ["18", "15"],
});
rule({
  id: "initcall-call", re: /^calling {1,2}([\w.]+)\+0x[0-9a-f]+\/0x[0-9a-f]+ @ (\d+)/, kind: "info", stage: null,
  title: "An initcall starts (initcall_debug)",
  what: "With `initcall_debug` on the command line the kernel prints every initcall. A `calling` line with no matching `returned` is where a boot hung. `@ 1` means PID 1, `kernel_init`, made the call.",
  primers: ["linux-boot-sequence"],
});
rule({
  id: "initcall-ret", re: /^initcall ([\w.]+)\+0x[0-9a-f]+\/0x[0-9a-f]+ returned (-?\d+) after/, kind: "info", stage: null,
  title: "An initcall returned (initcall_debug)", what: "0 is success; a negative number is an error code.", primers: ["linux-boot-sequence"],
});

// Stage 7
rule({
  id: "initrd-unpack", re: /^Unpacking initramfs\.\.\./, kind: "machine", stage: 7, overlap: true,
  title: "Unpacking the initramfs, in the background",
  what: "The `populate_rootfs` initcall unpacks the cpio archive into an in-memory filesystem while other initcalls go on.",
  cause: "`linux,initrd-start` and `linux,initrd-end` in `/chosen` (chapter 13).", node: "/chosen", ch: ["13"], primers: ["cpio-initramfs"],
});
rule({
  id: "initrd-freed", re: /^Freeing initrd memory: (\d+)K/, kind: "milestone", stage: 7, overlap: true,
  title: "The initramfs is unpacked",
  what: "The archive was unpacked and its RAM handed back.",
  cause: "`linux,initrd-start` and `-end` in `/chosen` (chapter 13).", node: "/chosen", ch: ["13"], primers: ["cpio-initramfs"],
  check(m) {
    return m[1] === "9204"
      ? ["9204K: our DTB says 0x42600000 to 0x42efd8fc. Rounded down to a 4 KiB page, 0x42efd000 − 0x42600000 = 0x8fd000 bytes = 9,204 KiB."]
      : [];
  },
});
rule({
  id: "initrd-fail", re: /^(Initramfs unpacking failed|rootfs image is not initramfs|Trying to unpack rootfs image as initrd)/, kind: "failure", stage: 7, overlap: true,
  title: "The initramfs did not unpack",
  what: "The bytes at `linux,initrd-start` were not a valid archive: a wrong address or size, an unsupported compression, or something overwrote them.",
  cause: "Our initramfs placement and `/chosen` (chapter 13). A BSS overlap can give this, or a silent stall before `Unpacking initramfs...` (chapter 13's capture).",
  node: "/chosen", ch: ["13"], primers: ["cpio-initramfs", "arm64-boot-protocol"],
});

// Stage 8
rule({
  id: "free-init", re: /^Freeing unused kernel memory/, kind: "info", stage: 8,
  title: "Boot-only code freed", what: "`kernel_init` frees the code and data it needed only for boot, right before it starts `/init`.", primers: ["linux-boot-sequence"],
});
rule({
  id: "no-console", re: /^Warning: unable to open an initial console/, kind: "failure", stage: 8,
  title: "No console for /init",
  what: "`kernel_init` could not open `/dev/console` for PID 1, because no real console registered. Whatever `/init` prints goes nowhere.",
  cause: "Our PL011 never bound as `ttyAMA0`: look for the missing `ttyAMA0 at MMIO` line. In chapter 14's breakage 3 the identification registers read zero.",
  node: "/pl011@9000000", ch: ["09", "14"], primers: ["primecell-ids"],
});
rule({
  id: "run-init", re: /^Run (\S+) as init process/, kind: "milestone", stage: 8,
  title: "The hand-off to user space",
  what: "The kernel executes `/init` from the initramfs as PID 1. It is the last line the kernel prints on purpose; everything after is a program.",
  cause: "The initramfs's `/init` (chapter 13).", ch: ["13"], primers: ["linux-boot-sequence", "cpio-initramfs"],
});
rule({
  id: "initramfs-ready", re: /^macvmm-initramfs: ready (\S+)/, kind: "machine", stage: 8,
  title: "The test initramfs speaks",
  what: "A user-space program, our test `/init`, printing through `/dev/console`, which the kernel routes to `ttyAMA0`, our PL011.",
  cause: "The course's test initramfs (chapter 13), through the PL011 driver (chapter 09).", ch: ["13", "14", "09"],
});
rule({
  id: "macvmm-marker", re: /^macvmm-[\w-]+: /, kind: "machine", stage: 8,
  title: "A marker from the test initramfs", what: "Printed by the test `/init` for the case on the command line (`macvmm.test=`).", ch: ["14", "13"],
});
rule({
  id: "boot-media", re: /^Mounting boot media: failed/, kind: "failure", stage: 8,
  title: "Alpine's own /init gave up",
  what: "Alpine's stock `/init` looks for its boot media, finds none on our bare machine, and exits. PID 1 exiting panics the kernel next.",
  cause: "Using Alpine's stock initramfs; the course builds its own (chapter 13).", ch: ["13"], primers: ["linux-boot-sequence"],
});
rule({
  id: "panic-init", re: /^Kernel panic - not syncing: Attempted to kill init!/, kind: "failure", stage: 8,
  title: "PID 1 exited",
  what: "`/init` must never exit: it adopts every orphaned process, and nobody can take that role over. The exit code does not matter.",
  cause: "The initramfs's `/init` returned instead of powering off (chapter 13).", ch: ["13"], primers: ["linux-boot-sequence"],
});
rule({
  id: "panic-vfs", re: /^Kernel panic - not syncing: VFS: Unable to mount root fs/, kind: "failure", stage: 8,
  title: "No initramfs /init, and no root disk",
  what: "There was no `/init` in an initramfs (or no initramfs at all), so the kernel tried the disk named by `root=`, and that failed too.",
  cause: "The initramfs placement in `/chosen` (chapter 13), or a missing disk (chapter 18).", node: "/chosen", ch: ["13", "18"], primers: ["linux-boot-sequence"],
});
rule({
  id: "panic-noinit", re: /^Kernel panic - not syncing: No working init found/, kind: "failure", stage: 8,
  title: "No init program on the root disk", what: "The root disk mounted, but `/sbin/init`, `/etc/init`, `/bin/init` and `/bin/sh` all failed.", ch: ["18"], primers: ["linux-boot-sequence"],
});
rule({
  id: "panic-sysrq", re: /^Kernel panic - not syncing: sysrq triggered crash/, kind: "failure", stage: null,
  title: "A crash on request",
  what: "Something wrote `c` to `/proc/sysrq-trigger`. Here it is the test `/init` for `macvmm.test=panic`, on purpose.",
  cause: "The test initramfs (chapter 14). With `panic=-1` the kernel then asks for a reset.", ch: ["14"],
});
rule({
  id: "panic-timer", re: /^Kernel panic - not syncing: Unable to initialise architected timer/, kind: "failure", stage: 4,
  title: "No timer, no kernel",
  what: "`time_init()` found the timer's rate still zero and stopped. This happens before any console driver exists: without earlycon, nobody sees it.",
  cause: "The `/timer` node (chapter 14's breakage 1).", node: "/timer", ch: ["11", "14"], primers: ["linux-boot-sequence"],
});
rule({
  id: "panic-idle", re: /^Kernel panic - not syncing: Attempted to kill the idle task!/, kind: "failure", stage: null,
  title: "The boot context died",
  what: "A fatal fault in PID 0, the boot CPU's own context, before any process existed. Read the Oops above it for the fault.",
  ch: ["14"],
});
rule({
  id: "panic", re: /^Kernel panic - not syncing: (.*)$/, kind: "failure", stage: null,
  title: "A kernel panic", what: "The kernel stopped on purpose because it cannot go on. The reason is the text after the colon; the call trace below says where.",
  ch: ["14"], primers: ["linux-boot-sequence"],
});
rule({
  id: "panic-end", re: /^-+\[ end Kernel panic/, kind: "context", stage: null,
  title: "End of the panic report", what: "After this the CPU spins (or, with `panic=-1`, resets). Our VMM sees nothing more unless `--timeout` or a reset ends the run.",
  ch: ["14"],
});
rule({
  id: "paging", re: /^Unable to handle kernel (paging request|NULL pointer dereference) at virtual address ([0-9a-f]+)/, kind: "failure", stage: null,
  title: "A fault inside the kernel",
  what: "The kernel touched an address its page tables do not map. The fault went to the guest's own vector table, not to our VMM.",
  ch: ["02", "05"],
  check(m) { return m[2] === "0000000000010100" ? ["0x10100 = a redistributor base of 0 + 0x10000 (its second frame) + 0x100 (`GICR_ISENABLER0`): no redistributor was found, so the base stayed 0."] : []; },
});
rule({
  id: "esr", re: /^\s*ESR = (0x[0-9a-f]+)/, kind: "context", stage: null,
  title: "The fault's syndrome",
  what: "`ESR_EL1`, the register that records why the CPU faulted. Open it in the ESR decoder.",
  ch: ["02", "07"],
  link(m) { const v = parseHex(m[1]); return v === null ? null : { label: `Decode ${hex(v)} in the ESR decoder`, href: `${ESR_LAB}#esr-decoder=${hex(v)}` }; },
});
rule({
  id: "oops", re: /^Internal error: Oops: ([0-9a-f]+)/, kind: "failure", stage: null,
  title: "An Oops", what: "Linux's report of a fault inside the kernel itself. The number is the ESR again.", ch: ["02"],
  link(m) { const v = parseHex(m[1]); return v === null ? null : { label: `Decode ${hex(v)} in the ESR decoder`, href: `${ESR_LAB}#esr-decoder=${hex(v)}` }; },
});
rule({
  id: "warning", re: /^WARNING: CPU: \d+ PID: \d+ at (\S+)/, kind: "failure", stage: null,
  title: "A kernel warning", what: "Something unexpected, but not fatal by itself. The file and line say who complained.", ch: ["14"],
});
rule({
  id: "cut-here", re: /^-+\[ cut here \]-+/, kind: "context", stage: null,
  title: "Start of a report", what: "A warning or Oops report starts here.", ch: ["14"],
});
rule({
  id: "who", re: /^CPU: (\d+) UID: \d+ PID: (\d+) Comm: (\S+)/, kind: "context", stage: null,
  title: "Who was running",
  what: "Which CPU and process hit the problem.",
  ch: ["14"],
  check(m) { return m[2] === "0" ? ["PID 0: still the boot CPU's own context. No process exists yet."] : [`PID ${m[2]} (${m[3]}).`]; },
});
rule({
  id: "hw-name", re: /^Hardware name: (.*) \(DT\)/, kind: "context", stage: null,
  title: "The machine, again", what: "The root node's `model`, repeated in every report.", node: "/", ch: ["10"],
});
rule({
  id: "pstate", re: /^pstate: ([0-9a-f]{8}) /, kind: "context", stage: null,
  title: "PSTATE at the fault", what: "The CPU's state bits when it faulted, decoded by the kernel in brackets.", ch: ["06"],
  link(m) { return { label: `Open 0x${m[1]} in the PSTATE builder`, href: `${PSTATE_LAB}#pstate-builder=0x${m[1]}` }; },
});
rule({
  id: "call-trace", re: /^Call trace:/, kind: "context", stage: null,
  title: "Call trace", what: "The functions that were running, innermost first. The stage functions to look for: `init_IRQ` (stage 3), `time_init` (stage 4), `kernel_init` (stage 5 on).",
  primers: ["linux-boot-sequence"],
});
rule({
  id: "frame", re: /^\s+([\w.]+)\+0x[0-9a-f]+\/0x[0-9a-f]+/, kind: "context", stage: null,
  title: "A call-trace frame", what: "One function in the call trace: name, then offset/size in bytes.",
  check(m) { const s = FRAME_STAGE[m[1]]; return s ? [`\`${m[1]}\` runs stage ${s}: ${STAGES[s].name}.`] : []; },
});
rule({
  id: "regs", re: /^(pc|lr|sp) : |^x\d+\s*: [0-9a-f]{16}/, kind: "context", stage: null,
  title: "Registers at the fault", what: "The CPU's registers when it faulted.", ch: ["06"],
});
rule({
  id: "report-misc", re: /^(Modules linked in:|Tainted: |Code: |Mem abort info:|Data abort info:|\s+(EC|SET|EA|FSC|ISV|CM|GCS) = |\[[0-9a-f]{16}\] user address|-+\[ end trace)/, kind: "context", stage: null,
  title: "Part of the report", what: "Detail of the warning or Oops report above.", ch: ["02"],
});
rule({
  id: "kaslr", re: /^Kernel Offset: disabled/, kind: "context", stage: null,
  title: "No address randomisation", what: "KASLR is off in Alpine's `virt` kernel, so function addresses are the same on every run.", ch: ["14"], primers: ["linux-boot-sequence"],
});
rule({
  id: "power-down", re: /^reboot: Power down/, kind: "machine", stage: null,
  title: "Power off",
  what: "The kernel's last line before it calls PSCI `SYSTEM_OFF`.",
  cause: "PSCI `SYSTEM_OFF`, which ends `macvmm` with status 0 (chapter 08).", node: "/psci", ch: ["08"],
});
rule({
  id: "restart", re: /^reboot: Restarting system/, kind: "machine", stage: null,
  title: "Reset",
  what: "The kernel's last line before it calls PSCI `SYSTEM_RESET`.",
  cause: "PSCI `SYSTEM_RESET`: our VMM rebuilds the VM, or with `--on-reset exit` stops with status 4 (chapter 08).", node: "/psci", ch: ["08"],
});
rule({
  id: "net", re: /^NET: Registered /, kind: "info", stage: null,
  title: "An initcall announcing itself", what: "Most boot lines look like this: a subsystem's initcall saying it is ready. They rarely matter to a VMM author.", primers: ["linux-boot-sequence"],
});

export const RULES = Object.freeze(R);
const RULE_BY_ID = new Map(R.map((r) => [r.id, r]));
export function ruleById(id) { return RULE_BY_ID.get(id) || null; }

/** Call-trace functions that pin a stage. */
export const FRAME_STAGE = Object.freeze({
  init_IRQ: 3, irqchip_init: 3, gic_of_init: 3, gic_init_bases: 3,
  time_init: 4, timer_probe: 4,
  kernel_init: 5, kernel_init_freeable: 5, do_initcalls: 6, do_basic_setup: 6, populate_rootfs: 7,
});

/** What macvmm's exit status means (crates/vmm/src/control.rs, `StopReason::exit_code`). */
export const EXIT_MEANING = Object.freeze({
  0: "the guest powered off (PSCI `SYSTEM_OFF`)",
  1: "the VMM or the host failed",
  2: "a configuration error",
  3: "a fatal guest error, such as an unhandled MMIO access",
  4: "the guest asked for a reset and `--on-reset exit` was set",
  5: "`--timeout` ended the run: the guest was still running, and our VMM never learned why",
  6: "the guest's debug exit, with a nonzero code",
  130: "you quit (SIGINT, SIGTERM or `Ctrl-A x`)",
});

// ---- input: text to lines -------------------------------------------------------------------

/** A capture command that runs macvmm itself, so its `exit:` is macvmm's exit status. */
const RUNS_MACVMM = /(?:^|\s)(?:-p macvmm\b|\S*macvmm run\b|\S*run-linux\.sh\b)/;

const BIDI = /[‪-‮⁦-⁩‎‏؜]/;

/**
 * Make one line safe to show: control bytes (C0 except tab, DEL, C1) and bidirectional overrides
 * become visible escapes. Returns { text, escapes }.
 */
export function visible(s) {
  let out = "";
  let escapes = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c < 0x20 && c !== 9) || c === 0x7f || (c >= 0x80 && c < 0xa0)) { out += `\\x${c.toString(16).padStart(2, "0")}`; escapes++; }
    else if (BIDI.test(ch)) { out += `\\u{${c.toString(16)}}`; escapes++; }
    else out += ch;
  }
  return { text: out, escapes };
}

/**
 * Split raw input into the log's lines plus what a capture file says about the run.
 * Accepts a plain serial log, `dmesg` output, or a course capture (`# ` header, `$ ` command,
 * `exit: N`, `--- stdout ---`, `--- stderr ---`).
 */
export function splitInput(input) {
  const info = { format: "plain", truncatedChars: false, truncatedLines: false, header: [], command: null, exit: null, stderr: [] };
  let text = typeof input === "string" ? input : "";
  if (text.length > LIMITS.maxChars) { text = text.slice(0, LIMITS.maxChars); info.truncatedChars = true; }
  text = text.replace(/^﻿/, "").replace(/\r+\n/g, "\n").replace(/\r/g, "\n");
  let lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  // A capture file: header lines, then the command, exit status and the two streams.
  const so = lines.indexOf("--- stdout ---");
  if (lines.length && lines[0].startsWith("#") && so !== -1) {
    info.format = "capture";
    let i = 0;
    while (i < so && lines[i].startsWith("#")) info.header.push(lines[i++].replace(/^#\s?/, ""));
    for (; i < so; i++) {
      const ex = /^exit: (\d{1,3})$/.exec(lines[i]);
      if (ex && Number(ex[1]) <= 255) info.exit = Number(ex[1]);
      else if (lines[i].startsWith("$ ")) info.command = lines[i].slice(2);
    }
    let se = lines.indexOf("--- stderr ---", so + 1);
    if (se === -1) se = lines.length;
    info.stderr = lines.slice(se + 1, se + 1 + 200).map((l) => visible(l.slice(0, LIMITS.maxLineLen)).text);
    lines = lines.slice(so + 1, se);
    // The exit status is macvmm's only when the capture's command ran macvmm (not, say, grep).
    if (info.exit !== null && !(info.command && RUNS_MACVMM.test(info.command))) info.exit = null;
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
  }
  if (lines.length > LIMITS.maxLines) { lines = lines.slice(0, LIMITS.maxLines); info.truncatedLines = true; }
  // The capture tool writes a guest's carriage return as a literal `\x0d` (or `\r`).
  lines = lines.map((l) => l.replace(/(?:\\x0d|\\r)+$/i, ""));
  return { lines, info };
}

/** Parse one line: optional `<level>`, optional `[ seconds.micro]` stamp, then the message. */
export function parseLine(raw) {
  let cut = false;
  let s = raw;
  if (s.length > LIMITS.maxLineLen) { s = s.slice(0, LIMITS.maxLineLen); cut = true; }
  const { text, escapes } = visible(s);
  let rest = text;
  let level = null;
  const lv = /^<([0-7])>/.exec(rest);
  if (lv) { level = Number(lv[1]); rest = rest.slice(lv[0].length); }
  let ts = null;
  let tsText = null;
  const st = /^\[\s{0,12}(\d{1,8})\.(\d{1,9})\] ?/.exec(rest);
  if (st) {
    tsText = `${st[1]}.${st[2]}`;
    ts = Number(tsText);
    rest = rest.slice(st[0].length);
  }
  return { text, msg: rest, ts, tsText, level, escapes, cut };
}

/** Find the rule for a message: the first that matches, in RULES order. */
export function classify(msg) {
  for (const r of RULES) {
    const m = r.re.exec(msg);
    if (m) return { rule: r, m };
  }
  return null;
}

// ---- the device tree (dtc output) -------------------------------------------------------------

/**
 * Index dtc's text output by node path: Map(path -> the text dtc printed for that node). For the
 * root, only its own properties (each child has its own entry). Our own capture is trusted input,
 * but the parser is defensive anyway: at most 5,000 lines and 32 levels.
 */
export function parseDts(text) {
  const lines = String(text).split("\n").slice(0, 5000).map((l) => l.replace(/\s+$/, ""));
  const spans = [];
  const stack = [];
  lines.forEach((line, i) => {
    const open = /^(\t*)([\w,.+@-]+|\/) \{$/.exec(line);
    if (open) {
      if (stack.length >= 32) return;
      const name = open[2];
      const parent = stack.length ? stack[stack.length - 1].path : null;
      const path = name === "/" ? "/" : !parent || parent === "/" ? `/${name}` : `${parent}/${name}`;
      stack.push({ path, start: i, depth: open[1].length });
      return;
    }
    if (/^\t*\};$/.test(line) && stack.length) spans.push({ ...stack.pop(), end: i });
  });
  const out = new Map();
  for (const { path, start, end, depth } of spans) {
    let block = lines.slice(start, end + 1);
    if (path === "/") block = block.filter((l, k) => k === 0 || k === block.length - 1 || (/^\t[^\t]/.test(l) && !/ \{$/.test(l) && l !== "\t};"));
    const strip = new RegExp(`^\\t{0,${depth}}`);
    out.set(path, block.filter((l) => l !== "").map((l) => l.replace(strip, "")).join("\n"));
  }
  return out;
}

/** The text block dtc printed for one node, or null. */
export function dtsNode(dtsIndex, path) {
  if (!dtsIndex || !path) return null;
  return dtsIndex.get(path) ?? null;
}

/** The dtc text out of the capture. */
export function dtsFromCapture(captureText) {
  const { lines } = splitInput(captureText);
  return lines.join("\n");
}

// ---- annotate -------------------------------------------------------------------------------

const KIND_ORDER = ["milestone", "failure", "machine", "context", "info", "plain"];
export const KINDS = Object.freeze(KIND_ORDER);

/** Annotate a whole log. Returns { lines, summary, info }. */
export function annotate(input) {
  const { lines: rawLines, info } = splitInput(input);
  const lines = [];
  let cur = null; // the stage the boot is in
  let escapes = 0;
  let cutLines = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const p = parseLine(rawLines[i]);
    escapes += p.escapes;
    if (p.cut) cutLines++;
    const hit = p.msg.trim() === "" ? null : classify(p.msg);
    const line = { n: i + 1, text: p.text, msg: p.msg, ts: p.ts, tsText: p.tsText, level: p.level, cut: p.cut, kind: "plain", stage: null, ruleId: null, notes: [], link: null, explicit: false };
    if (hit) {
      const r = hit.rule;
      line.ruleId = r.id;
      line.kind = typeof r.kind === "function" ? r.kind(hit.m) : r.kind;
      const st = typeof r.stage === "function" ? r.stage(hit.m) : r.stage;
      if (st !== null && st !== undefined) {
        line.stage = st;
        line.explicit = true;
        if (!r.overlap && (cur === null || st > cur)) cur = st;
      }
      if (r.check) { try { line.notes = r.check(hit.m) || []; } catch { line.notes = []; } }
      if (r.link) line.link = r.link(hit.m);
    }
    // A line with no time stamp after /init is user space talking (or the shell).
    if (line.stage === null) {
      if (p.ts === null && cur === 8 && line.kind === "plain") line.stage = 8;
      else line.stage = cur;
    }
    lines.push(line);
  }
  const summary = summarize(lines, info, { escapes, cutLines });
  return { lines, summary, info };
}

/** The verdict on a whole log. */
export function summarize(lines, info, extra = { escapes: 0, cutLines: 0 }) {
  const stageLine = (l) => l.explicit && l.kind !== "context" && l.stage;
  const stages = [];
  for (let s = 1; s <= 8; s++) {
    const st = STAGES[s];
    const ms = st.milestones.map((mm) => {
      const hit = lines.find((l) => l.ruleId === mm.rule && l.kind === "milestone");
      return { label: mm.label, rule: mm.rule, line: hit ? hit.n : null };
    });
    const found = ms.filter((x) => x.line !== null).length;
    const seen = lines.some((l) => l.stage === s && l.explicit);
    const status = found === ms.length ? "done" : found > 0 ? "partial" : seen ? "started" : "missing";
    stages.push({ n: s, name: st.name, status, milestones: ms, firstLine: (lines.find((l) => l.stage === s) || {}).n ?? null });
  }
  // A log that is not a boot log at all: nothing matches a rule and nothing has a kernel time stamp.
  const notLog = lines.length > 0 && !lines.some((l) => l.ruleId) && !lines.some((l) => l.ts !== null);
  // A log that starts mid-boot (scrollback, a dmesg excerpt, a grep): its lowest stage is above 1,
  // or its first time stamp is not zero. Stages run in order, so the earlier ones ran; they are
  // "not in this log" rather than missing. The same holds for a gap in stages 1 to 5 (each prints
  // its milestone unconditionally) when a later stage's milestone is present: the log was filtered.
  const stageNums = lines.filter(stageLine).map((l) => l.stage);
  const start = stageNums.length ? Math.min(...stageNums) : null;
  const firstStamped = lines.find((l) => l.ts !== null);
  const lateStamp = firstStamped ? firstStamped.ts > 0 : false;
  const midBoot = !notLog && lines.length > 0 && (start !== null ? start > 1 : lateStamp);
  if (midBoot && start !== null) for (let k = 0; k < start - 1; k++) stages[k].status = "absent";
  const lastMilestone = Math.max(0, ...stages.filter((x) => x.milestones.some((m) => m.line !== null)).map((x) => x.n));
  const filteredGaps = [];
  for (const st of stages) {
    if (st.n <= 5 && st.status === "missing" && st.n < lastMilestone) { st.status = "absent"; filteredGaps.push(st.n); }
  }
  const excerpt = midBoot || filteredGaps.length > 0;
  let completed = 0;
  while (completed < 8 && (stages[completed].status === "done" || stages[completed].status === "absent")) completed++;
  // How far the boot got: lines that move the boot's position (not stage 7's background lines,
  // which run alongside stage 6), and stages whose milestones all appeared.
  const reached = Math.max(0,
    ...lines.filter((l) => stageLine(l) && !(l.ruleId && RULE_BY_ID.get(l.ruleId).overlap)).map((l) => l.stage),
    ...stages.filter((x) => x.status === "done").map((x) => x.n));
  const waiting = notLog ? null : completed < 8 ? completed + 1 : null;
  const failures = lines.filter((l) => l.kind === "failure");
  const panicLine = lines.find((l) => /^Kernel panic - not syncing: /.test(l.msg));
  const panic = panicLine ? panicLine.msg.replace(/^Kernel panic - not syncing: /, "").replace(/\s+$/, "") : null;
  const last = [...lines].reverse().find((l) => l.text.trim() !== "");
  let ending = "empty";
  if (lines.some((l) => l.ruleId === "power-down")) ending = "power-off";
  else if (lines.some((l) => l.ruleId === "restart")) ending = "reset";
  else if (panic) ending = "panic";
  else if (last) ending = "stopped";
  const stamped = lines.filter((l) => l.ts !== null);
  const allZero = stamped.length > 0 && stamped.every((l) => l.ts === 0);
  const schedClock = lines.some((l) => l.ruleId === "sched-clock");
  const earlycon = lines.some((l) => l.ruleId === "earlycon");
  const ttyama = lines.some((l) => l.ruleId === "ttyama");
  const unpacking = lines.some((l) => l.ruleId === "initrd-unpack");
  // initcall_debug: calls that never returned.
  const open = new Map();
  for (const l of lines) {
    let m;
    if (l.ruleId === "initcall-call" && (m = /^calling {1,2}([\w.]+)\+/.exec(l.msg))) open.set(m[1], l.n);
    else if (l.ruleId === "initcall-ret" && (m = /^initcall ([\w.]+)\+/.exec(l.msg))) open.delete(m[1]);
  }
  const hungInitcalls = [...open].map(([name, n]) => ({ name, line: n }));
  // Which stage the panic's call trace points at: the frames after the panic line, else the
  // nearest report above it (an Oops prints its trace before the panic). The function found is
  // kept too, so the verdict names the frame actually in the log.
  let traceStage = null;
  let traceFn = null;
  if (panicLine) {
    const frameFn = (l) => {
      if (l.ruleId !== "frame") return null;
      const m = /^\s+([\w.]+)\+/.exec(l.msg);
      return m && Object.hasOwn(FRAME_STAGE, m[1]) ? m[1] : null;
    };
    const at = panicLine.n - 1;
    for (let k = at + 1; k < Math.min(lines.length, at + 40) && traceFn === null; k++) traceFn = frameFn(lines[k]);
    for (let k = at - 1; k >= Math.max(0, at - 80) && traceFn === null; k--) traceFn = frameFn(lines[k]);
    if (traceFn) traceStage = FRAME_STAGE[traceFn];
  }
  let exits = null;
  let serialWritten = null;
  for (const s of info.stderr || []) {
    const m = /vcpu\d+ exits: .*total (\d+)/.exec(s);
    if (m) exits = (exits || 0) + Number(m[1]);
    const w = /^macvmm: stats: .*\bserial_written=(\d+)/.exec(s);
    if (w) serialWritten = Number(w[1]);
  }
  const cmdEarlycon = info.command ? /\bearlycon\b/.test(info.command) : null;
  // Stages 6 and 7 run together: a log that just stops inside stage 6, with no trouble reported
  // and stage 7 unfinished, may be stuck in either.
  const sixSeven = !excerpt && completed === 5 && ["partial", "started"].includes(stages[5].status)
    && stages[6].status !== "done" && ending === "stopped" && failures.length === 0;
  const vmmSaid = (info.stderr || []).filter((s) => /^macvmm: /.test(s) && !/^macvmm: stats: /.test(s));
  const sum = {
    lineCount: lines.length, stages, completed, reached, waiting, ending, panic, failures: failures.map((l) => l.n),
    firstFailure: failures.length ? failures[0].n : null, allZero, schedClock, earlycon, ttyama, unpacking, hungInitcalls,
    traceStage, traceFn, exit: info.exit, exits, serialWritten, cmdEarlycon, vmmSaid, escapes: extra.escapes, cutLines: extra.cutLines,
    truncated: info.truncatedChars || info.truncatedLines, notLog, midBoot, start, firstStamp: firstStamped ? firstStamped.tsText : null,
    filteredGaps, excerpt, sixSeven,
  };
  sum.sentences = verdict(sum);
  sum.text = sum.sentences.map((s) => s.replace(/`/g, "")).join(" ");
  return sum;
}

/** The verdict in sentences (backticks mark code; the view renders them, announce strips them). */
export function verdict(s) {
  const out = [];
  const stageName = (n) => `stage ${n} (${STAGES[n].name})`;
  const hasExit = s.exit !== null && s.exit !== undefined;
  if (s.notLog) {
    out.push("This does not look like a Linux boot log: no line has a `[    0.000000]` time stamp or a known message.");
    out.push("Paste the serial output of a boot (or `dmesg` output) and press Annotate again.");
    if (hasExit) out.push(exitSentence(s.exit));
    return out;
  }
  if (s.lineCount === 0 || s.ending === "empty") {
    out.push("Nothing reached the serial port.");
    if (s.exits !== null) out.push(`Yet the VMM counted ${s.exits.toLocaleString("en-US")} exits, so the guest ran.`);
    if (hasExit && (s.exit === 0 || s.exit === 4)) {
      out.push(exitSentence(s.exit));
      out.push(s.exit === 0
        ? "The kernel calls `SYSTEM_OFF` only when user space asks it to power off, so it ran all the way through stage 8, and still printed nothing: its console never registered."
        : "So the kernel ran long enough to ask for a reset, and still printed nothing: its console never registered.");
      if (s.serialWritten === 0) out.push("`serial_written=0`: our VMM's own count agrees. Not one byte reached the PL011's data register.");
      if (s.cmdEarlycon) out.push("The command line asks for `earlycon`, yet even that printed nothing: check the `earlycon=` address against our PL011 (chapters 09 and 10).");
      else out.push("Without `earlycon`, nothing reaches the serial port until the `ttyAMA0` console registers in stage 6, so stage 6's binding of `ttyAMA0` failed. Suspect: the PL011's identification registers, its `compatible` and `reg` (chapters 09 and 10).");
      return out;
    }
    out.push("Without `earlycon`, lines reach the serial port only once the `ttyAMA0` console registers in stage 6, so the kernel may be stuck (or dead) in any stage before that, or the console may never have registered. Add `earlycon=pl011,0x09000000` and look again.");
    if (hasExit) out.push(exitSentence(s.exit));
    return out;
  }
  if (s.midBoot) {
    out.push(s.start !== null
      ? `This log starts mid-boot: its earliest line belongs to ${stageName(s.start)}${s.firstStamp && s.firstStamp !== "0.000000" ? `, stamped ${s.firstStamp}` : ""}. ${s.start === 2 ? "Stage 1 is" : `${upTo(s.start - 1)} are`} not in it; stages run in order, so ${s.start === 2 ? "it" : "they"} ran.`
      : `This log starts mid-boot (its first time stamp is ${s.firstStamp}), and no line in it marks a stage.`);
  }
  if (s.filteredGaps.length) {
    const g = s.filteredGaps;
    out.push(`${g.length === 1 ? `Stage ${g[0]}'s milestone is` : `The milestones of stages ${g.join(", ")} are`} not in this log, but a later stage's is. Stages run in order, so this log is an excerpt or was filtered (with \`grep\`, say).`);
  }
  const caveat = s.excerpt ? " This log is an excerpt, so the line may simply have been left out." : "";
  if (s.completed === 8) out.push(s.excerpt ? "Every stage in this log completed." : "All eight stages completed.");
  else if (s.completed === 0 && s.reached === 0) out.push(`No stage completed: the first milestone, \`${STAGES[1].milestones[0].label}\`, is missing.`);
  else if (s.sixSeven) {
    out.push(`${upTo(5)} completed. The log stops while stages 6 (${STAGES[6].name}) and 7 (${STAGES[7].name}) run together: drivers bind while the initramfs unpacks in the background.`);
    if (!s.unpacking) out.push("The next line in order would be `Unpacking initramfs...`.");
    const missing = s.stages[5].milestones.filter((m) => m.line === null).map((m) => `\`${m.label}\``).join(" and ");
    out.push(`Stage 6 has no ${missing} line yet. Suspect either stage: for 6, ${STAGES[6].suspect} (${chList(STAGES[6].ch)}); for 7, ${STAGES[7].suspect} (${chList(STAGES[7].ch)}). A BSS overlap can stall the boot silently before \`Unpacking initramfs...\`.`);
  } else if (s.reached > s.completed + 1 || (s.reached > s.completed && s.stages.slice(s.completed + 1).some((x) => x.status === "done"))) {
    const gap = s.stages[s.completed];
    const missing = gap.milestones.filter((m) => m.line === null).map((m) => `\`${m.label}\``).join(" or ");
    out.push(`The boot reached ${stageName(s.reached)}, but ${stageName(gap.n)} is incomplete: no ${missing} line.${caveat}`);
  } else if (s.reached > s.completed) {
    out.push(`${upTo(s.completed)} completed. ${cap(stageName(s.reached))} started and never finished.`);
  } else {
    out.push(`${upTo(s.completed)} completed; the log stops before ${stageName(s.waiting)} starts.`);
  }
  if (s.completed < 8 && s.waiting && !s.sixSeven) {
    const g = STAGES[s.waiting];
    const missing = s.stages[s.waiting - 1].milestones.filter((m) => m.line === null).map((m) => `\`${m.label}\``);
    out.push(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} ${s.excerpt ? "not in this log" : "missing"}. Suspect: ${g.suspect} (${chList(g.ch)}).`);
  }
  if (s.ending === "panic") out.push(`The log ends in a panic: \`${s.panic}\`${s.traceFn ? `, with \`${s.traceFn}\` in the call trace (stage ${s.traceStage})` : ""}.`);
  else if (s.ending === "power-off") out.push("It ends with `reboot: Power down`: PSCI `SYSTEM_OFF`.");
  else if (s.ending === "reset") out.push(`It ends with \`reboot: Restarting system\`: PSCI \`SYSTEM_RESET\`${s.panic ? `, after a panic (\`${s.panic}\`)` : ""}.`);
  else out.push("The log stops without a panic or a power-off: a hang, a cut-off capture, or a kernel that died before a console could print.");
  if (s.firstFailure !== null && s.ending !== "panic" && !(s.ending === "reset" && s.panic)) out.push(`Look at line ${s.firstFailure}: the first line that reports trouble.`);
  else if (s.firstFailure !== null) out.push(`The first line that reports trouble is line ${s.firstFailure}.`);
  if (s.allZero && !s.schedClock && !s.excerpt) {
    out.push(s.reached > 0 && s.reached < 4
      ? `Every time stamp is 0.000000, which fits: \`sched_clock\`, the clock behind the stamps, only starts in stage 4, and this boot stopped in stage ${s.reached}.`
      : "Every time stamp is 0.000000: `sched_clock` was never registered, so the kernel stopped before finishing stage 4.");
  }
  if (!s.earlycon && s.lineCount > 0 && !s.excerpt) out.push(s.ttyama ? "No `earlycon` line: every line before `ttyAMA0` registered was replayed from the log buffer when the console started." : "No `earlycon` line and no `ttyAMA0`: these lines reached you through some other console.");
  for (const h of s.hungInitcalls.slice(0, 3)) out.push(`\`${h.name}\` was called (line ${h.line}) and never returned: with \`initcall_debug\`, that is where the boot hung.`);
  if (hasExit) out.push(exitSentence(s.exit));
  if (s.exits !== null) out.push(`The VMM counted ${s.exits.toLocaleString("en-US")} exits.`);
  if (s.escapes) out.push(`${s.escapes} control byte${s.escapes === 1 ? " is" : "s are"} shown as escapes: the guest chose them, and nothing here interprets them.`);
  if (s.truncated) out.push(`Only the first ${LIMITS.maxLines.toLocaleString("en-US")} lines (or 2 MiB) were read.`);
  return out;
}

export function chList(ids) {
  const sorted = [...ids].sort();
  if (sorted.length === 1) return `chapter ${sorted[0]}`;
  return `chapters ${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
}
function upTo(n) { return n === 1 ? "Stage 1" : n === 2 ? "Stages 1 and 2" : `Stages 1 to ${n}`; }
function cap(s) { return s[0].toUpperCase() + s.slice(1); }
export function exitSentence(code) {
  const m = EXIT_MEANING[code];
  return m ? `\`macvmm\` exited with status ${code}: ${m}.` : `\`macvmm\` exited with status ${code}.`;
}

/** Everything the detail panel shows for one line. */
export function explain(line) {
  const r = line.ruleId ? ruleById(line.ruleId) : null;
  const stage = line.stage ? STAGES[line.stage] : null;
  const chapters = (r?.ch || []).filter((c) => CHAPTERS[c]).map((c) => ({ id: c, title: CHAPTERS[c][0], href: chapterHref(c) }));
  const primers = (r?.primers || []).filter((p) => PRIMERS[p]).map((p) => ({ slug: p, title: PRIMERS[p], href: primerHref(p) }));
  return {
    n: line.n,
    kind: line.kind,
    stage: line.stage,
    stageName: stage ? stage.name : null,
    stageBy: line.stage ? (line.explicit ? "line" : "position") : null,
    title: r ? r.title : "Housekeeping",
    what: r ? r.what : (line.stage
      ? `No annotation for this line. It sits in stage ${line.stage} (${stage.name}) by position. Most boot lines are a subsystem or an initcall announcing itself; they rarely matter to a VMM author.`
      : "No annotation for this line, and no stage yet: no line before it says where the boot is."),
    cause: r?.cause || null,
    node: r?.node || null,
    notes: line.notes,
    link: line.link,
    chapters,
    primers,
  };
}

// ---- share state ----------------------------------------------------------------------------
//
// `<sample>.<s|k>[.a][.<line>]`: the sample (or `paste`: the pasted text itself is never put in the
// link), the colouring (s = by stage, k = by line type), `a` = annotated lines only, and the
// selected line. The default (`boot.s`, nothing selected) clears the hash.

export const SAMPLE_IDS = Object.freeze(["boot", "no-timer", "wrong-gicr", "no-id", "silent", "panic"]);
export const DEFAULT_STATE = Object.freeze({ sample: "boot", colour: "s", onlyAnnotated: false, line: null });
export const REFERENCE = "no-timer.s.61";

export function encodeShare(st) {
  if (!st || (!SAMPLE_IDS.includes(st.sample) && st.sample !== "paste")) return null;
  const parts = [st.sample, st.colour === "k" ? "k" : "s"];
  if (st.onlyAnnotated) parts.push("a");
  if (Number.isInteger(st.line) && st.line > 0) parts.push(String(st.line));
  const s = parts.join(".");
  return s === "boot.s" ? null : s;
}

export function decodeShare(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 64) return null;
  const parts = str.split(".");
  const sample = parts[0];
  if (!SAMPLE_IDS.includes(sample) && sample !== "paste") return null;
  if (parts[1] !== "s" && parts[1] !== "k") return null;
  const st = { sample, colour: parts[1], onlyAnnotated: false, line: null };
  let i = 2;
  if (parts[i] === "a") { st.onlyAnnotated = true; i++; }
  if (i < parts.length) {
    if (!/^[1-9]\d{0,5}$/.test(parts[i])) return null;
    st.line = Number(parts[i]);
    i++;
  }
  if (i !== parts.length) return null;
  return st;
}

/**
 * The line a sample opens on: its first failure, else its first milestone. With `quiz` (a broken
 * run the lesson asks the learner to read first) it opens on the first milestone, so the panel does
 * not give the answer away.
 */
export function defaultLine(result, opts = {}) {
  const firstMilestone = (result.lines.find((l) => l.kind === "milestone") || {}).n ?? null;
  if (opts.quiz) return firstMilestone ?? (result.lines.length ? 1 : null);
  return result.summary.firstFailure ?? firstMilestone;
}

/** Split text with backtick code spans into [{code: bool, text}] for safe rendering. */
export function spans(s) {
  const out = [];
  const parts = String(s).split("`");
  parts.forEach((t, i) => { if (t) out.push({ code: i % 2 === 1, text: t }); });
  return out;
}
