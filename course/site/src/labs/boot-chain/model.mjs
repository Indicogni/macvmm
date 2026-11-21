// boot-chain: the model. Pure logic, no DOM, no I/O (course/site/LABS.md section 3).
//
// Two ways to start the same machine, side by side:
//   direct boot   macvmm loads the kernel and the DTB, PC = the kernel's entry, x0 = the DTB
//                 (chapter 13, captures/13-dry-run.txt);
//   firmware boot macvmm loads U-Boot into flash and the DTB into RAM, PC = 0 (chapter 21), then
//                 U-Boot starts an operating system one of three ways:
//                   booti      a raw Linux Image          (u-boot primer; not run on macvmm)
//                   efi-linux  bootefi, the Linux EFI stub (uefi primer; not run on macvmm)
//                   efi-bsd    standard boot finds FreeBSD's loader.efi on the ESP (chapter 22,
//                              captures/22-freebsd-boot.txt: observed)
//
// Every step says what is running, who loaded it and where, what is in pc, x0 and x1, whether
// UEFI boot services are alive, which memory regions exist, and which DTB copies exist and who
// owns the one in use. Numbers marked as observed come from a capture and are listed in the
// step's `quotes`, which the model test checks against the capture file, so the lab cannot drift
// from what the course shows. Steps that were not run on our machine say so.
//
// Which copy descends from which (the lab's main lesson), from U-Boot's and FreeBSD's sources:
//   - U-Boot's control copy (fdtcontroladdr) is made at relocation from ours. booti's built-in
//     line passes ${fdtcontroladdr}, so booti hands on that copy.
//   - bootefi with no DTB argument, and the efi_mgr bootmeth, reach efi_install_fdt
//     (lib/efi_loader/efi_helper.c; doc/usage/cmd/bootefi.rst). It takes $fdt_addr first and
//     falls back to $fdtcontroladdr only if that is unset. qemu_arm64's default environment has
//     fdt_addr=0x40000000 (it is in u-boot.bin), so the configuration-table copy descends from
//     OURS. copy_fdt puts it in a fresh page allocation; image_setup_libfdt then edits /chosen
//     (u-boot,version, bootargs if set) and the memory node and adds reservations.
//   - FreeBSD's loader.efi copies the tree again into the kernel's module area (fdt_copy in
//     stand/fdt/fdt_loader_cmd.c, called from stand/efi/loader/bootinfo.c), after fdt_fixup sets
//     /chosen fixup-applied, and passes that copy's address in the kernel's metadata.
// Those copies and edits were not dumped on macvmm, so they carry `src` ("described") even on an
// observed step.
//
// Two what-ifs from the uefi primer's Lab section: U-Boot edits its own control copy (not
// observed at the U-Boot prompt: the copy's totalsize equals ours; only booti hands that copy on),
// and ExitBootServices is called with a stale map key (UEFI 2.10 section 7.4:
// EFI_INVALID_PARAMETER; after the first call only the memory allocation services may be used;
// in practice the loader calls GetMemoryMap and tries again).

export const OWNERS = {
  vmm: "macvmm (the VMM)",
  uboot: "U-Boot",
  uefi: "U-Boot, acting as UEFI firmware",
  stub: "the Linux EFI stub",
  loader: "FreeBSD's loader.efi",
  kernel: "the kernel",
};

// Words, not a bare "-", for a register the lab does not show.
const NOT_HERE = "not meaningful here";
const NOT_TRACED = "not traced (inside the program)";

// Every edit or copy made by U-Boot's EFI code, from its source.
const SRC_UBOOT_EFI = "U-Boot's lib/efi_loader/efi_helper.c (efi_install_fdt) and boot/image-fdt.c (image_setup_libfdt); not dumped on macvmm";
const SRC_BSD_LOADER = "FreeBSD's stand/fdt/fdt_loader_cmd.c (fdt_fixup, fdt_copy) and stand/efi/loader/bootinfo.c; not traced on macvmm";

export const CHAINS = [
  { id: "efi-bsd", label: "U-Boot, then FreeBSD's loader.efi, then the FreeBSD kernel", observed: true },
  { id: "efi-linux", label: "U-Boot bootefi, then the Linux EFI stub, then Linux", observed: false },
  { id: "booti", label: "U-Boot booti, then Linux", observed: false },
];
const CHAIN_IDS = CHAINS.map((c) => c.id);

export const MAPKEY = {
  ok: "the current map key",
  retry: "a stale map key; the loader asks again",
  ignore: "a stale map key; the loader ignores the error (a bug)",
};
const MAPKEY_IDS = Object.keys(MAPKEY);

export const BOOT_SERVICES = {
  none: "none: no firmware runs in direct boot",
  "not-yet": "not started: U-Boot's UEFI interface starts only when an EFI program is run",
  unused: "not used: booti starts the kernel without U-Boot's UEFI interface",
  alive: "alive: the program may call them (allocate memory, read files, find devices)",
  partial: "possibly partly shut down: only the memory allocation services (in practice GetMemoryMap) may be called now",
  gone: "gone: ExitBootServices succeeded; only runtime services remain",
  "never-exited": "never successfully exited: the firmware still thinks it owns memory and devices",
};

// The chapter 21 table, row for row (the model test parses the lesson and compares).
export const CHAIN_TABLE_HEAD = ["Chain", "Loaded by", "Where it runs", "The DTB it sees"];
export const CHAIN_TABLE = [
  { key: "direct", cells: ["direct boot: Linux", "our VMM", "RAM, `0x4020_0000`", "ours, at `0x4000_0000` (`x0`)"] },
  { key: "uboot", cells: ["firmware boot: U-Boot", "our VMM", "flash, `0x0`", "ours, then its own copy near the top of RAM"] },
  { key: "booti", cells: ["U-Boot `booti`: Linux", "U-Boot", "RAM", "the one at the address `booti` is given"] },
  { key: "efi-bsd", cells: ["U-Boot `bootefi`: `loader.efi`, then a kernel", "U-Boot, then `loader.efi`", "RAM", "the one U-Boot puts in the UEFI configuration table"] },
];
// Not in the chapter's table; added by the lab from the uefi primer's diagram.
export const CHAIN_TABLE_EXTRA = [
  { key: "efi-linux", cells: ["U-Boot `bootefi`: the Linux EFI stub, then Linux", "U-Boot", "RAM", "the stub's copy of the one in the UEFI configuration table"] },
];

// ---------------------------------------------------------------------------------------------
// Direct boot (chapter 13's dry run, then chapter 22's console line "Machine model").

const DIRECT = [
  {
    actor: "vmm",
    title: "macvmm builds the machine and loads the kernel itself",
    loadedBy: "macvmm (the host program)",
    where: "kernel at 0x40200000 (36306944 bytes), initrd at 0x42600000, DTB at 0x40000000 (1828 bytes)",
    pc: "0x40200000 (the kernel's entry)",
    x0: "0x40000000 (the DTB)",
    x1: "0 (x1 to x3 must be zero: Linux booting.rst)",
    bs: "none",
    owner: "vmm",
    ownerWhy: "macvmm wrote the DTB and nothing else is running yet, so what it says is macvmm's decision.",
    reads: "ours",
    events: [
      { op: "region", key: "ram", range: "0x40000000..0x60000000", what: "RAM, 512 MiB" },
      { op: "region", key: "dtb0", range: "0x40000000..0x40000724", what: "our DTB" },
      { op: "region", key: "kernel", range: "0x40200000..0x424a0000", what: "kernel (arm64 Image)" },
      { op: "region", key: "initrd", range: "0x42600000..0x42efd8fc", what: "initrd" },
      { op: "dtb", key: "ours", label: "our DTB", addr: "0x40000000", by: "vmm" },
      { op: "edit", key: "ours", by: "vmm", text: "/chosen: bootargs, linux,initrd-start 0x42600000, linux,initrd-end 0x42efd8fc, rng-seed, kaslr-seed" },
    ],
    evidence: { kind: "observed", text: "chapter 13's dry run (entry pc=0x40200000 x0=0x40000000 cpsr=0x3c5)", capture: "13-dry-run.txt" },
    quotes: ["0x40200000", "36306944", "0x42600000", "0x42efd8fc", "1828 bytes", "pc=0x40200000 x0=0x40000000 cpsr=0x3c5", "0x40000000..0x40000724", "0x40200000..0x424a0000"],
  },
  {
    actor: "kernel",
    title: "Linux runs and reads the DTB at x0: ours, unchanged",
    loadedBy: "macvmm",
    where: "RAM, 0x40200000",
    pc: "inside Linux",
    x0: "the kernel has saved it: 0x40000000",
    x1: "0",
    bs: "none",
    owner: "kernel",
    ownerWhy: "Nobody runs after the kernel, so nobody else can change the DTB: the kernel reads it and may rewrite its own view as it likes.",
    reads: "ours",
    events: [],
    evidence: { kind: "observed", text: "chapter 22's Linux console: \"Machine model: macvmm-virt\", the model string our DTB carries", capture: "22-linux-console.txt" },
    quotes: ["Machine model: macvmm-virt"],
  },
];

// ---------------------------------------------------------------------------------------------
// Firmware boot. The first three steps are shared; `mem` picks the run whose numbers we quote.

function firmwarePrefix(mem) {
  const big = mem === "2G";
  const ramEnd = big ? "0xc0000000" : "0x60000000";
  const vmm = {
    actor: "vmm",
    title: "macvmm loads U-Boot into flash and writes the DTB at the start of RAM",
    loadedBy: "macvmm (the host program)",
    where: big
      ? "U-Boot in flash bank 0 at 0x0 (1453944 bytes); DTB at 0x40000000"
      : "U-Boot in flash bank 0, 0x0..0x162f78 (1453944 bytes); DTB at 0x40000000 (1687 bytes)",
    pc: "0x0 (the first word of the firmware)",
    x0: "0x40000000 (the DTB, as booting.rst asks; U-Boot saves it)",
    x1: "0",
    bs: "none",
    owner: "vmm",
    ownerWhy: "macvmm wrote the DTB and no guest code has run yet.",
    reads: "ours",
    events: [
      { op: "region", key: "flash0", range: "0x00000000..0x04000000", what: "flash bank 0: U-Boot, read and execute only" },
      { op: "region", key: "flash1", range: "0x04000000..0x08000000", what: "flash bank 1: reads as zero" },
      { op: "region", key: "ram", range: `0x40000000..${ramEnd}`, what: big ? "RAM, 2 GiB" : "RAM, 512 MiB" },
      { op: "region", key: "dtb0", range: big ? "0x40000000.." : "0x40000000..0x40000697", what: "our DTB" },
      { op: "dtb", key: "ours", label: "our DTB", addr: "0x40000000", by: "vmm" },
      { op: "edit", key: "ours", by: "vmm", text: "/chosen: bootargs, rng-seed, kaslr-seed (no initrd: the firmware finds the OS)" },
    ],
    evidence: big
      ? { kind: "observed", text: "chapter 22's FreeBSD run, --mem 2G (\"DRAM:  2 GiB\"); flash layout as in chapter 21's dry run", capture: "22-freebsd-boot.txt" }
      : { kind: "observed", text: "chapter 21's dry run (entry pc=0x0 x0=0x40000000 cpsr=0x3c5)", capture: "21-dry-run.txt" },
    quotes: big ? ["--mem 2G", "DRAM:  2 GiB"] : ["0x0..0x162f78", "1453944 bytes", "1687 bytes", "pc=0x0 x0=0x40000000 cpsr=0x3c5", "0x40000000..0x40000697"],
  };
  const inPlace = {
    actor: "uboot",
    title: "U-Boot runs in place, straight from flash, and saves x0",
    loadedBy: "macvmm",
    where: "flash, 0x0",
    pc: "0x17c: stp x0, x1, [x9], the first store",
    x0: "0x40000000, stored to 0x12c668 inside U-Boot's own image",
    x1: "0",
    bs: "not-yet",
    owner: "uboot",
    ownerWhy: "U-Boot is running now and decides what it hands on, even though it has not copied the DTB yet: our file at our address, but U-Boot's to change or replace.",
    reads: "ours",
    events: [],
    note: "The store lands in flash, so macvmm ignores it (\"flash: ignored 8-byte write of 0x40000000 at offset 0x12c668\"). U-Boot reads our DTB where it lies, at the start of RAM.",
    evidence: big
      ? { kind: "observed", text: "the ignored flash writes on standard error in chapter 22's run", capture: "22-trace-run.txt" }
      : { kind: "observed", text: "the first exits of chapter 21's U-Boot trace", capture: "21-uboot-first-exits.txt" },
    quotes: big
      ? ["ignored 8-byte write of 0x40000000 at offset 0x12c668"]
      : ["\"pc\":\"0x17c\"", "\"ipa\":\"0x12c668\"", "\"value\":\"0x40000000\""],
  };
  const reloc = {
    actor: "uboot",
    title: "U-Boot copies itself and the DTB near the top of RAM",
    loadedBy: "U-Boot (it copies itself)",
    where: big
      ? "RAM near the top: malloc area 0xbe65a000-0xbf69a000 (this run did not print the copy addresses)"
      : "RAM, relocaddr 0x5f69a000; malloc area 0x5e65a000-0x5f69a000",
    pc: big ? "inside U-Boot's copy, near the top of RAM" : "inside U-Boot's copy at 0x5f69a000",
    x0: "no longer meaningful: U-Boot keeps the DTB's address in fdtcontroladdr",
    x1: NOT_HERE,
    bs: "not-yet",
    owner: "uboot",
    ownerWhy: "U-Boot is still the only program running; it now works from its own copy and chooses what any later program receives.",
    reads: "uboot",
    events: [
      { op: "region", key: "uboot-ram", range: big ? "near the top of RAM" : "0x5e6596e0 (DTB copy), then 0x5e65a000..0x5f69a000 (malloc) and up", what: "U-Boot's DTB copy, its malloc area and its copy of itself" },
      { op: "dtb", key: "uboot", label: "U-Boot's copy", addr: big ? "near the top of RAM" : "0x5e6596e0", by: "uboot", from: "ours" },
      { op: "fixup", key: "uboot" },
    ],
    note: big
      ? "Our DTB stays at 0x40000000; U-Boot works from its copy."
      : "fdtcontroladdr=5e6596e0, totalsize 0x697 (1687): the copy is the same size as ours. Our original is untouched: md.l 0x40000000 2 prints edfe0dd0 97060000, the big-endian magic and size read as little-endian words. The address depends on the run: the u-boot primer's QEMU run shows 0x5e559d80, because QEMU's DTB is 1 MiB and ours is 1687 bytes, so its copy sits about 1 MiB lower.",
    evidence: big
      ? { kind: "observed", text: "chapter 22's run (\"using memory 0xbe65a000-0xbf69a000 for malloc()\")", capture: "22-freebsd-boot.txt" }
      : { kind: "observed", text: "bdinfo, printenv fdtcontroladdr, fdt header and md.l at chapter 21's prompt", capture: "21-uboot-dtb.txt" },
    quotes: big
      ? ["0xbe65a000-0xbf69a000"]
      : ["0x000000005f69a000", "fdtcontroladdr=5e6596e0", "0x697 (1687)", "edfe0dd0 97060000", "0x5e65a000-0x5f69a000"],
  };
  return [vmm, inPlace, reloc];
}

// ExitBootServices, as one step or three. `who` is "stub" or "loader".
function exitSteps(who, mapkey) {
  const name = who === "stub" ? "The stub" : "loader.efi";
  const base = {
    actor: who, loadedBy: "U-Boot, acting as UEFI firmware", where: "RAM", owner: who, reads: who, events: [],
    ownerWhy: `Still ${who === "stub" ? "the stub" : "loader.efi"}: calling ExitBootServices hands memory and devices to the OS, not the DTB. ${name} decides what the kernel gets until it jumps.`,
  };
  const spec = { kind: "described", text: "UEFI 2.10 section 7.4 (ExitBootServices) and the uefi primer; not traced on macvmm" };
  if (mapkey === "ok") {
    return [{
      ...base,
      title: `${name} gets the memory map (map key A) and calls ExitBootServices(A)`,
      pc: `inside ${who === "stub" ? "the stub" : "loader.efi"}`,
      x0: "image handle (the argument to ExitBootServices)",
      x1: "A, the current map key",
      bs: "gone",
      note: "EFI_SUCCESS. The firmware stops its timers and drivers; memory it used for boot services is now the OS's to reuse.",
      evidence: spec,
    }];
  }
  const first = [
    {
      ...base,
      title: `${name} gets the memory map (map key A), then allocates once more`,
      pc: `inside ${who === "stub" ? "the stub" : "loader.efi"}`,
      x0: NOT_TRACED,
      x1: NOT_TRACED,
      bs: "alive",
      note: "Any allocation changes the memory map, so key A is now stale: the current key is B. (What-if: the lab adds this allocation.)",
      evidence: { kind: "what-if", text: "a lab what-if from the uefi primer" },
    },
    {
      ...base,
      title: `${name} calls ExitBootServices(A) with the stale key`,
      pc: `inside ${who === "stub" ? "the stub" : "loader.efi"}`,
      x0: "image handle",
      x1: "A, a stale map key",
      bs: "partial",
      note: "EFI_INVALID_PARAMETER. The firmware may already have shut part of itself down, so only the memory allocation services may be called now; in practice the next call is GetMemoryMap.",
      evidence: spec,
    },
  ];
  if (mapkey === "retry") {
    return [...first, {
      ...base,
      title: `${name} calls GetMemoryMap again (key B), then ExitBootServices(B)`,
      pc: `inside ${who === "stub" ? "the stub" : "loader.efi"}`,
      x0: "image handle",
      x1: "B, the current map key",
      bs: "gone",
      note: "EFI_SUCCESS on the second try. The Linux EFI stub retries exactly this way.",
      evidence: spec,
    }];
  }
  return [...first, {
    ...base,
    title: `${name} ignores the error and jumps to the kernel anyway`,
    pc: "about to jump to the kernel",
    x0: NOT_TRACED,
    x1: NOT_TRACED,
    bs: "never-exited",
    note: "A bug. The kernel will treat memory as free that the firmware may still use, while firmware timers and drivers may still be running.",
    evidence: { kind: "what-if", text: "a lab what-if: a buggy loader" },
  }];
}

function bootiTail() {
  return [
    {
      actor: "uboot",
      title: "U-Boot loads the kernel and runs booti",
      loadedBy: "U-Boot",
      where: "kernel at ${kernel_addr_r}, the U-Boot variable holding the kernel's load address (0x40400000; moved to a 2 MiB multiple if needed), initrd at ${ramdisk_addr_r} (0x44000000)",
      pc: "inside U-Boot, about to jump",
      x0: "the DTB address given to booti; U-Boot's built-in booti line passes ${fdtcontroladdr}, its own copy (u-boot primer)",
      x1: "0 (x1 to x3 zeroed; MMU and caches off)",
      bs: "unused",
      owner: "uboot",
      ownerWhy: "U-Boot is still running: it edits its copy's /chosen and decides which address goes into x0.",
      reads: "uboot",
      events: [
        { op: "region", key: "kernel", range: "${kernel_addr_r}..", what: "kernel (arm64 Image), loaded by U-Boot" },
        { op: "region", key: "initrd", range: "${ramdisk_addr_r}..", what: "initrd, loaded by U-Boot" },
        { op: "edit", key: "uboot", by: "uboot", text: "/chosen: linux,initrd-start, linux,initrd-end, u-boot,version (and bootargs if U-Boot's bootargs variable is set); memory node fixup" },
      ],
      note: "U-Boot plays the boot loader of Linux's booting.rst. It may move the DTB once more before jumping.",
      evidence: { kind: "described", text: "the u-boot primer's booti section; booti was not run on macvmm" },
    },
    {
      actor: "kernel",
      title: "Linux runs and reads the DTB at x0: U-Boot's copy, not ours",
      loadedBy: "U-Boot",
      where: "RAM, at ${kernel_addr_r}",
      pc: "inside Linux",
      x0: "the DTB booti prepared",
      x1: "0",
      bs: "unused",
      owner: "kernel",
      ownerWhy: "Nobody runs after the kernel, so nobody else can change the DTB: the kernel reads it and may rewrite its own view as it likes.",
      reads: "uboot",
      events: [],
      evidence: { kind: "described", text: "the u-boot primer; not run on macvmm" },
    },
  ];
}

// The configuration-table copy: efi_install_fdt copies $fdt_addr (ours), then edits it.
const CFG_EDIT = "/chosen: u-boot,version (and bootargs if U-Boot's bootargs variable is set); memory node fixup; memory reservations added";
const KERNEL_WHY = "Nobody runs after the kernel, so nobody else can change the DTB: the kernel reads it and may rewrite its own view as it likes.";

// The kernel step's events: boot-services memory goes back to the OS, the System Table and
// runtime services stay. With the buggy "ignore" path the firmware never let go of it.
const kernelEvents = (mapkey) => (mapkey === "ignore" ? [] : [{ op: "drop-region", key: "efi-bs" }]);
const IGNORE_NOTE = "Boot-services memory is still listed: the firmware never let go of it, yet the kernel will treat it as free.";

function efiLinuxTail(mapkey) {
  return [
    {
      actor: "uefi",
      title: "bootefi: U-Boot, as UEFI firmware, installs a DTB copy and starts the EFI program",
      loadedBy: "U-Boot (vmlinuz, an EFI zboot file, from disk)",
      where: "RAM, an address U-Boot's UEFI code allocates",
      pc: "the PE entry point of the EFI program",
      x0: "image handle",
      x1: "the System Table",
      bs: "alive",
      owner: "uefi",
      ownerWhy: "U-Boot made the configuration-table copy and edited it; until the EFI program runs, that copy is U-Boot's.",
      reads: "cfg",
      events: [
        { op: "region", key: "efi-bs", range: "allocated by U-Boot", what: "the EFI program and boot-services memory" },
        { op: "region", key: "efi-rt", range: "allocated by U-Boot", what: "the System Table and runtime services (they survive ExitBootServices)" },
        { op: "dtb", key: "cfg", label: "the DTB in the configuration table", addr: "a page U-Boot allocates", by: "uefi", from: "ours", src: SRC_UBOOT_EFI },
        { op: "edit", key: "cfg", by: "uefi", text: CFG_EDIT, src: SRC_UBOOT_EFI },
      ],
      note: "With no DTB argument, bootefi uses `$fdt_addr` (`0x40000000` on qemu_arm64: our DTB) and falls back to `$fdtcontroladdr`, U-Boot's own copy, only if that variable is unset. It copies the tree into a new page allocation with room to grow, edits it, then installs it (U-Boot's doc/usage/cmd/bootefi.rst; lib/efi_loader/efi_helper.c, efi_install_fdt). U-Boot's own `bootefi hello` prints \"Have device tree\" because it finds it there.",
      evidence: { kind: "described", text: "the uefi and u-boot primers and U-Boot's source; Linux was not started through bootefi on macvmm" },
    },
    {
      actor: "stub",
      title: "The Linux EFI stub copies the DTB and rewrites /chosen and memory",
      loadedBy: "U-Boot, acting as UEFI firmware",
      where: "RAM",
      pc: "inside the stub (an EFI zboot file first decompresses the kernel)",
      x0: NOT_TRACED,
      x1: NOT_TRACED,
      bs: "alive",
      owner: "stub",
      ownerWhy: "The stub is running; it made its own copy and decides what the kernel will get.",
      reads: "stub",
      events: [
        { op: "dtb", key: "stub", label: "the stub's copy", addr: "allocated by the stub", by: "stub", from: "cfg" },
        { op: "edit", key: "stub", by: "stub", text: "/chosen: bootargs, linux,uefi-system-table, linux,uefi-mmap-*, kaslr-seed; deletes every /memory node and the memreserve block (the kernel uses the UEFI memory map)" },
      ],
      note: "The /memory nodes you wrote in chapter 10 do not reach the kernel on this path: the UEFI memory map replaces them.",
      evidence: { kind: "described", text: "the uefi primer's diagram, Linux's Documentation/arch/arm/uefi.rst and drivers/firmware/efi/libstub/fdt.c (update_fdt); not run on macvmm" },
    },
    ...exitSteps("stub", mapkey),
    {
      actor: "kernel",
      title: "Linux runs and reads the DTB at x0: the stub's copy",
      loadedBy: "the stub (it jumps into the kernel it carries)",
      where: "RAM",
      pc: "inside Linux",
      x0: "the stub's DTB",
      x1: "0",
      bs: mapkey === "ignore" ? "never-exited" : "gone",
      owner: "kernel",
      ownerWhy: KERNEL_WHY,
      reads: "stub",
      events: kernelEvents(mapkey),
      ...(mapkey === "ignore" ? { note: IGNORE_NOTE } : {}),
      evidence: { kind: "described", text: "the uefi primer; not run on macvmm" },
    },
  ];
}

function efiBsdTail(mapkey) {
  return [
    {
      actor: "uefi",
      title: "Standard boot finds \\EFI\\BOOT\\BOOTAA64.EFI on the ESP and starts it",
      loadedBy: "U-Boot (from disk0p1, the EFI system partition)",
      where: "RAM, image base 0xbd460000",
      pc: "the PE entry point of loader.efi",
      x0: "image handle",
      x1: "the System Table",
      bs: "alive",
      owner: "uefi",
      ownerWhy: "U-Boot made the configuration-table copy and edited it; until loader.efi runs, that copy is U-Boot's.",
      reads: "cfg",
      events: [
        { op: "region", key: "efi-bs", range: "0xbd460000..", what: "loader.efi and boot-services memory" },
        { op: "region", key: "efi-rt", range: "allocated by U-Boot", what: "the System Table and runtime services (they survive ExitBootServices)" },
        { op: "dtb", key: "cfg", label: "the DTB in the configuration table", addr: "0xbd600000", by: "uefi", from: "ours", src: SRC_UBOOT_EFI },
        { op: "edit", key: "cfg", by: "uefi", text: CFG_EDIT, src: SRC_UBOOT_EFI },
      ],
      note: "\"Booting bootflow '<NULL>' with efi_mgr\", then loader.efi reports its Load Path, /\\EFI\\BOOT\\BOOTAA64.EFI, and EFI Firmware: Das U-Boot. Nobody typed bootefi: standard boot ran it, through the same code as bootefi, which copies the DTB at `$fdt_addr` (`0x40000000`, ours) and edits the copy before installing it.",
      evidence: { kind: "observed", text: "chapter 22's FreeBSD boot", capture: "22-freebsd-boot.txt" },
      quotes: ["Booting bootflow '<NULL>' with efi_mgr", "Image base: 0xbd460000", "Load Path: /\\EFI\\BOOT\\BOOTAA64.EFI", "EFI Firmware: Das U-Boot"],
    },
    {
      actor: "loader",
      title: "loader.efi reads the kernel from UFS, finds the DTB in the configuration table and copies it for the kernel",
      loadedBy: "U-Boot, acting as UEFI firmware",
      where: "RAM, image base 0xbd460000",
      pc: "inside loader.efi",
      x0: NOT_TRACED,
      x1: NOT_TRACED,
      bs: "alive",
      owner: "loader",
      ownerWhy: "loader.efi is running; it decides which tree the kernel gets and what goes into it.",
      reads: "loader",
      events: [
        { op: "region", key: "bsdkernel", range: "allocated by loader.efi", what: "the FreeBSD kernel, read from disk0p3 through boot services" },
        { op: "dtb", key: "loader", label: "loader.efi's copy", addr: "in the kernel's module area", by: "loader", from: "cfg", src: SRC_BSD_LOADER },
        { op: "edit", key: "loader", by: "loader", text: "/chosen: fixup-applied (and any overlays)", src: SRC_BSD_LOADER },
      ],
      note: "\"Using DTB provided by EFI at 0xbd600000.\" That is a page-aligned address, as expected of the fresh page efi_install_fdt allocated for its copy of `$fdt_addr`. It is not U-Boot's control copy, which in this layout would sit just below the malloc area, near 0xbe6596e0 if it lands as in the 512 MiB run (our reading of the addresses). loader.efi then copies the tree into the kernel's module area and passes that copy on.",
      evidence: { kind: "observed", text: "chapter 22's FreeBSD boot", capture: "22-freebsd-boot.txt" },
      quotes: ["Setting currdev to disk0p3:", "/boot/kernel/kernel", "Using DTB provided by EFI at 0xbd600000."],
    },
    ...exitSteps("loader", mapkey),
    {
      actor: "kernel",
      title: "The FreeBSD kernel starts and reads the DTB from the loader's metadata",
      loadedBy: "loader.efi",
      where: "RAM",
      pc: "inside the FreeBSD kernel",
      x0: "the loader's metadata, not the DTB (the address of loader.efi's copy is one record in it)",
      x1: NOT_TRACED,
      bs: mapkey === "ignore" ? "never-exited" : "gone",
      owner: "kernel",
      ownerWhy: KERNEL_WHY,
      reads: "loader",
      events: kernelEvents(mapkey),
      note: "\"WARNING: Cannot find freebsd,dts-version property\": FreeBSD is reading a descendant of the tree macvmm generated, two copies down (U-Boot's EFI copy, then loader.efi's copy of that). Both added to /chosen, neither added that property." + (mapkey === "ignore" ? ` ${IGNORE_NOTE}` : ""),
      evidence: { kind: "observed", text: "chapter 22's FreeBSD boot (\"---<<BOOT>>---\")", capture: "22-freebsd-boot.txt" },
      quotes: ["---<<BOOT>>---", "WARNING: Cannot find freebsd,dts-version property"],
    },
  ];
}

// The full list of firmware steps for the chosen options.
export function chainSteps(chain, mapkey = "ok") {
  if (!CHAIN_IDS.includes(chain)) throw new Error(`unknown chain: ${chain}`);
  if (!MAPKEY_IDS.includes(mapkey)) throw new Error(`unknown map key choice: ${mapkey}`);
  if (chain === "booti") return [...firmwarePrefix("512M"), ...bootiTail()];
  if (chain === "efi-linux") return [...firmwarePrefix("512M"), ...efiLinuxTail(mapkey)];
  return [...firmwarePrefix("2G"), ...efiBsdTail(mapkey)];
}

export const directSteps = () => DIRECT;

// Which direct-boot step lines up with firmware step i: the first with the first, the last
// with the last, nothing in between (the VMM already started the kernel).
export function alignedDirect(i, n) {
  if (i === 0) return DIRECT[0];
  if (i === n - 1) return DIRECT[1];
  return null;
}

export const isEfi = (chain) => chain === "efi-linux" || chain === "efi-bsd";

// ---------------------------------------------------------------------------------------------
// Replaying events: the DTB copies and the memory regions that exist after step i.

const FIXUP_TEXT = "what-if: U-Boot edits its own copy (for example, reserving memory it still uses); not observed at our prompt. Only booti hands this copy on: bootefi copies the DTB at $fdt_addr instead";

export function replayEvents(steps, upto, fixup) {
  const dtbs = new Map();
  const regions = new Map();
  for (let i = 0; i <= upto && i < steps.length; i++) {
    for (const ev of steps[i].events) {
      if (ev.op === "region") regions.set(ev.key, { range: ev.range, what: ev.what, step: i });
      else if (ev.op === "drop-region") regions.delete(ev.key);
      else if (ev.op === "dtb") {
        const parent = ev.from ? dtbs.get(ev.from) : null;
        const edits = parent ? parent.edits.map((e) => ({ ...e, inherited: true })) : [];
        dtbs.set(ev.key, { key: ev.key, label: ev.label, addr: ev.addr, by: ev.by, from: ev.from || null, src: ev.src || null, edits, step: i });
      } else if (ev.op === "edit") {
        const d = dtbs.get(ev.key);
        if (!d) throw new Error(`edit of a DTB that does not exist yet: ${ev.key}`);
        d.edits.push({ by: ev.by, text: ev.text, inherited: false, step: i, src: ev.src || null });
      } else if (ev.op === "fixup") {
        if (fixup) {
          const d = dtbs.get(ev.key);
          if (!d) throw new Error(`fixup of a DTB that does not exist yet: ${ev.key}`);
          d.edits.push({ by: "uboot", text: FIXUP_TEXT, inherited: false, step: i, whatIf: true });
        }
      } else throw new Error(`unknown event: ${ev.op}`);
    }
  }
  return { dtbs: [...dtbs.values()], regions: [...regions.values()] };
}

// ---------------------------------------------------------------------------------------------
// State and transitions.

export const DEFAULT_CHAIN = "efi-bsd";

export function initialState() {
  return { chain: DEFAULT_CHAIN, fixup: false, mapkey: "ok", step: 0, guess: null, revealed: false, skipQuiz: false };
}

const clampStep = (s) => {
  const n = chainSteps(s.chain, s.mapkey).length;
  return { ...s, step: Math.max(0, Math.min(n - 1, s.step)) };
};

export function step(state, action) {
  const s = { ...state };
  switch (action.type) {
    case "setChain":
      if (!CHAIN_IDS.includes(action.chain)) return state;
      return { ...s, chain: action.chain, step: 0, guess: null, revealed: s.skipQuiz, mapkey: isEfi(action.chain) ? s.mapkey : "ok" };
    case "setFixup":
      return { ...s, fixup: !!action.on };
    case "setMapKey":
      if (!MAPKEY_IDS.includes(action.mapkey) || !isEfi(s.chain)) return state;
      // Keep the reader at the same step where possible; the tail changes length.
      return clampStep({ ...s, mapkey: action.mapkey });
    case "setSkipQuiz":
      return { ...s, skipQuiz: !!action.on, revealed: !!action.on || s.revealed };
    case "next": {
      const n = chainSteps(s.chain, s.mapkey).length;
      if (s.step >= n - 1) return state;
      return { ...s, step: s.step + 1, guess: null, revealed: s.skipQuiz };
    }
    case "back":
      if (s.step === 0) return state;
      return { ...s, step: s.step - 1, guess: null, revealed: true };
    case "goto": {
      const n = chainSteps(s.chain, s.mapkey).length;
      if (!Number.isInteger(action.step) || action.step < 0 || action.step >= n) return state;
      return { ...s, step: action.step, guess: null, revealed: true };
    }
    case "guess":
      if (!Object.hasOwn(OWNERS, action.owner)) return state;
      return { ...s, guess: action.owner, revealed: true };
    case "reveal":
      return { ...s, revealed: true };
    case "reset":
      return { ...initialState(), skipQuiz: s.skipQuiz, revealed: s.skipQuiz };
    default:
      return state;
  }
}

// The owners offered as answers for a chain: everyone who owns the DTB at some step.
export function ownerChoices(chain, mapkey = "ok") {
  const seen = [];
  for (const st of chainSteps(chain, mapkey)) if (!seen.includes(st.owner)) seen.push(st.owner);
  return seen;
}

const DTB_LABEL = { ours: "our DTB at 0x40000000", uboot: "U-Boot's copy", cfg: "the DTB in the configuration table", stub: "the stub's copy", loader: "loader.efi's copy" };

// Everything the view draws for the current state.
export function snapshot(state) {
  const steps = chainSteps(state.chain, state.mapkey);
  const i = Math.max(0, Math.min(steps.length - 1, state.step));
  const st = steps[i];
  const { dtbs, regions } = replayEvents(steps, i, state.fixup);
  const d = alignedDirect(i, steps.length);
  const directView = d ? { ...d, ...replayEvents(DIRECT, DIRECT.indexOf(d), false) } : null;
  return {
    index: i,
    count: steps.length,
    step: st,
    titles: steps.map((x) => x.title),
    actors: steps.map((x) => x.actor),
    dtbs,
    regions,
    reads: DTB_LABEL[st.reads],
    bootServices: BOOT_SERVICES[st.bs],
    direct: directView,
    directIndex: d ? DIRECT.indexOf(d) : -1,
    correct: state.guess === null ? null : state.guess === st.owner,
  };
}

export function summary(state) {
  const sn = snapshot(state);
  const st = sn.step;
  const head = `Step ${sn.index + 1} of ${sn.count}: ${st.title}.`;
  if (!state.revealed) return `${head} Who owns the DTB now?`;
  let verdict = "";
  if (sn.correct === true) verdict = " Your answer is right.";
  else if (sn.correct === false) verdict = ` Not ${OWNERS[state.guess]}.`;
  return `${head}${verdict} The DTB's owner is ${OWNERS[st.owner]}. Why: ${st.ownerWhy} The code running now reads ${sn.reads}. pc: ${st.pc}. x0: ${st.x0}. Boot services: ${BOOT_SERVICES[st.bs].split(":")[0]}.`;
}

// ---------------------------------------------------------------------------------------------
// Share state: `<chain>[.f][.k<r|i>]@<step>`, step 1-based. The default (efi-bsd@1, no options)
// clears the hash. Hostile input: a strict pattern, a short length cap, no exceptions leak.

export const REFERENCE = "efi-linux.f.kr@7";

export function encodeHash(state) {
  let s = state.chain;
  if (state.fixup) s += ".f";
  if (state.mapkey === "retry") s += ".kr";
  if (state.mapkey === "ignore") s += ".ki";
  s += `@${state.step + 1}`;
  return s === `${DEFAULT_CHAIN}@1` ? null : s;
}

export function decodeHash(str) {
  if (typeof str !== "string" || str.length > 40) throw new Error("bad share state");
  const m = /^(efi-bsd|efi-linux|booti)(\.f)?(\.k[ri])?@([1-9][0-9]?)$/.exec(str);
  if (!m) throw new Error("bad share state");
  const chain = m[1];
  const mapkey = m[3] === ".kr" ? "retry" : m[3] === ".ki" ? "ignore" : "ok";
  if (mapkey !== "ok" && !isEfi(chain)) throw new Error("map key choice applies to EFI chains only");
  const n = chainSteps(chain, mapkey).length;
  const stepNo = Number(m[4]);
  if (stepNo > n) throw new Error("step out of range");
  return { ...initialState(), chain, fixup: !!m[2], mapkey, step: stepNo - 1, revealed: true };
}
