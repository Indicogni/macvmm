# ADR-0009: How far macvmm traces Apple's AVPBooter (risk R10)

- **Status:** Accepted. The decision is the lead's, recorded as `docs/DECISIONS.md` **D4**
  (2026-11-18). This file transcribes it into the form ADR-0008 decision 3 and PLAN M21 ask for;
  it adds no scope of its own.
- **Date:** 2026-11-19
- **Related:** ADR-0008 (decisions 3, 4 and 6), `docs/research/macos-guest.md` R5,
  `docs/macos-guest-requirements.md` §6 item 4, architecture §5.2 and risk R10, PLAN M21,
  threat model TEST-11 and POST-6

## Context

Stage S1 runs Apple's macOS-guest boot ROM, `AVPBooter.vmapple2.bin`, inside macvmm. The ROM is
Apple software, licensed with macOS. The macOS software licence agreement (SLA) forbids
redistributing Apple software and forbids reverse engineering, decompiling or disassembling it
(§2B(iii), §2N; `docs/macos-guest-requirements.md` §6). A VMM necessarily *observes* the code it
runs: every trap shows a PC, an address, a size and a value. The open question was where that
observation stops being "running the software on a Mac" and starts being reverse engineering.

## Decision (D4, verbatim scope)

> M21 scope: load `AVPBooter.vmapple2.bin` **from the system path at runtime** (never copied
> into the repo or cache, never redistributed), and only log its first device accesses. No
> reverse-engineering writeups of Apple code beyond the device-access trace.

Concretely, for macvmm:

1. **Loaded in place.** `HostIo` reads the ROM from
   `/System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/AVPBooter.vmapple2.bin`
   (or the `--bios` the user names) into memory; `loader::firmware` copies it into the guest ROM
   allocation. No code path writes it to a file. TEST-11 (`e2e_vmapple::avpbooter_never_copied`)
   hashes every file of its size in the repo and the cache.
2. **Only the device-access trace.** The unknown-MMIO logger records `(pc, ipa, size, direction,
   value)` for at most 256 accesses per boot, then stops the VM. The exit trace (`--trace`) holds
   exit records (numbers) only. Neither ever contains ROM bytes.
3. **No disassembly, no decompilation, no annotated listings.** We never read the ROM's
   instructions to learn what it does. (The ISV = 0 decoder of M17 fetches one instruction at a
   trapping PC through the guest's stage 1 to emulate the access; for a PC in the ROM it cannot even
   do that, because the ROM is not `GuestMemory`. The vmapple board then counts the access in the
   logger and stops the VM rather than inject an abort the ROM would never see under VZ. It never
   keeps or prints the instruction.)
4. **What may be written down.** "Observed X; blocked at Y" lines in `docs/macos/status.md`: the
   first exit's PC, how many unknown accesses were logged, which layout rows they fell in, and how
   the run ended. Device facts come from QEMU's public `hw/vmapple/` sources and docs (facts only,
   never GPL code or prose) and Apple's public headers, never from the trace.
5. **Not published:** raw per-access logs of the ROM, values it wrote, guesses about the purpose
   of its code, and any copy of the ROM. Learners produce their own trace on their own Mac.
6. **`tools/hv-denied-probe`** (the one unheadered-symbol use ADR-0008 decision 4 allows) lives
   outside macvmm, calls `_hv_vm_config_set_isa(cfg, 3)` through `dlsym` and reports what
   `hv_vm_create` returns. It touches no Apple binary and documents `HV_DENIED` as the correct
   answer; it never suggests changing SIP or AMFI.

## Consequences

- PLAN M21 is unblocked with the full scope (the trace), not the reduced "HV_DENIED probe only"
  fallback.
- The course (ch24) teaches the method on the learner's own machine and grades the design record
  and the learner's trace, never a boot.
- Moving the line (for example, publishing per-access logs, or an S2 that sizes the bdif cap from
  observed requests) needs a new decision by the lead and an update of this ADR.
