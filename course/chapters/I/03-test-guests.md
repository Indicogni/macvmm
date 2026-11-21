---
title: A guest of your own, and what an exit costs
part: I
chapter: I.2
id: 03
runs: mac+browser
minutes: 210
prereqs: [02]
start_tag: ch-02
labs: [linker-map]
command: scripts/checkpoint.sh 03
expect: CHECKPOINT 03 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** a bare-metal program (an entry point, a stack, zeroing the BSS, `no_std`, `no_main`, a panic handler); loading a flat binary with `--raw FILE@ADDR`; a run loop; the two debug hypercalls as vendor-specific hypervisor fast calls of the SMC calling convention (SMCCC); `--timeout` and the virtual machine monitor's (VMM's) exit codes 0, 2, 5 and 6; the first exit trace; the cost of one exit, measured.
- **Core, from earlier:** the VM exit, the syndrome and its exception class, and the call-versus-retry rule for the PC (chapter 02); `Vcpu`, `OwnedMapping` and `VBAR_EL1` (chapter 02).
- **Primers (read first):** `bare-metal-rust` (`no_std`, `no_main`, sections, the linker script, load versus run address, the memory management unit (MMU), why nothing gives you a stack); `smccc` (function IDs, owners, fast calls).
- **Primers (review):** `aarch64-reading` (registers, post-index stores, `bl`, `mrs` and `msr`); `host-concurrency` (threads, `recv_timeout`, an atomic flag).
- **Pointers:** the rustc book's `aarch64-unknown-none` page (an Aside); the os-basics primer (exit status) and the ELF primer.
- **Forward definitions:** ELF; PSCI and its power-off call; the device tree; `MPIDR_EL1`; `CPACR_EL1`; `wfe`; `CNTVCT_EL0`; the kick that stops a running vCPU; an address size fault. Each is defined at first use.
:::

This chapter's guest prints `hello from guest` the way the simplest hardware does: one VM exit per character. Is that a problem? A function call on your Mac costs about a nanosecond. A VM exit stops a CPU mid-program, switches exception level, returns from `hv_vcpu_run` to a thread in your process, runs your Rust and switches all the way back. That round trip is a [**world switch**](/build-your-own/vmm/glossary/#world-switch). How many nanoseconds is that?

:::predict Before you run `exit-bench` at the end of this chapter: does one `hvc` round trip, guest to monitor and back, cost nanoseconds (it is a call, like a function call) or microseconds (it is a world switch)? Write a number.
Write your estimate and one sentence of reasoning under `## Predict` in your journal.
:::

This chapter measures row 8 of chapter 00's problem ledger, cheap bulk input and output, without solving it yet: your number is the argument for the second half of the course.

:::objectives
- Build a `no_std`, `no_main` Rust program for `aarch64-unknown-none` with a linker script that puts `_start` at `0x4008_0000`, and turn it into a flat binary.
- Explain each group of lines of the guest's `_start`: pick a stack, enable floating point, zero the BSS, install the vectors, call `main`.
- Implement the debug hypercalls DEBUG_PUTC (`x0 = 0xC600_4D01`, `x1 = byte`) and DEBUG_EXIT (`x0 = 0xC600_4D02`, `x1 = code`), and decode their IDs as SMCCC vendor-specific hypervisor fast calls.
- Write a run loop that handles exits repeatedly, a `--timeout` that stops a hung guest with exit code 5, and the first exit trace (records with `t_ns`, `pc`, `ec` and `imm`).
- Measure the cost of one `hvc` round trip with `exit-bench`, and compare it with one store instruction timed by the same counter.
:::

**Before you start.** Run `scripts/learner start 03` from the repository root; it copies this chapter's journal to `learner/journal/03.md`. The monitor parts go into your workspace, `learner/`. The guests live in `guests/`, because every later checkpoint runs them against *your* monitor; when you change them on purpose, `git restore guests/` and `scripts/build-guests.sh` put them back.

## Two programs, from now on

From now on there are two Rust programs. **The guest** runs inside the virtual machine (VM), with no operating system under it. [**The monitor**](/build-your-own/vmm/glossary/#monitor) is our virtual machine monitor (VMM), `macvmm`, an ordinary macOS program.

| | The guest | The monitor |
|---|---|---|
| Directory | `guests/` (its own Cargo workspace) | `crates/` (yours: `learner/crates/`) |
| Target triple | `aarch64-unknown-none` | `aarch64-apple-darwin` |
| Built by | `scripts/build-guests.sh`, then `llvm-objcopy` to a flat `.bin` | `cargo build` |
| Runs | inside the VM, at EL1, with the [MMU](/build-your-own/vmm/primers/bare-metal-rust/#sections-sorting-a-program-by-what-it-needs) off | in your terminal, as a macOS process at EL0 |
| Has | no OS, no heap, no `std`, no `main` in the usual sense | everything a Mac program has |

> **Aside.** `aarch64-unknown-none` means 64-bit Arm with no operating system, so `std` does not exist for it; the rustc book's [platform page](https://doc.rust-lang.org/rustc/platform-support/aarch64-unknown-none.html) lists what it assumes.

Build the guests from the repository root:

:::term source=captures/03-build-guests.txt

This chapter uses `hello` and `exit-bench`. With the MMU off an unaligned access faults, so the guests forbid one with `strict-align`; rustc warns only because it calls that flag unstable, not about your code. Each guest exists twice. **ELF** (Executable and Linkable Format) is the container the linker writes, the program's pieces with the addresses they want ([ELF primer](/build-your-own/vmm/primers/elf/); chapter 13 loads it). Until then we use the `.bin`, a [flat binary](/build-your-own/vmm/glossary/#flat-binary): the bytes of memory, in address order, nothing else.

## Where the guest's bytes go

The `bare-metal-rust` primer built a linker script for a toy program. The guests share one. Guest, `guests/common/link.ld`:

:::code anchor=guest_linker_script file=guests/common/link.ld

Three lines matter today. `. = 0x40080000` is the link address: RAM starts at `0x4000_0000` in the memory map we borrow from QEMU's `virt` machine (chapter 05), and the first 512 KiB are kept for the **device tree**, a description of the machine that the monitor writes into RAM as a DTB (device tree blob), chapter 10. `KEEP(*(.text.boot))` comes first, so `_start` is the flat binary's first byte: with no header naming an entry, the monitor starts the CPU at the load address. And `.bss (NOLOAD)` holds the variables that start at zero, plus eight 64 KiB stacks, without a byte in the file.

The [BSS](/build-your-own/vmm/glossary/#bss) (from an old assembler's "block started by symbol") is easiest to see with one variable, the console's choice of output device. Guest, `guests/common/console.rs`:

:::code anchor=guest_console_backend file=guests/common/console.rs

`Backend::Hvc` is 0, so this lives in `.bss`. We added `static COUNTER: AtomicU32 = AtomicU32::new(0);` to a copy of `hello` and asked where things went:

:::term source=captures/03-bss-nm.txt

`b` means a local symbol in the BSS; capital `B` is a global one, like the linker's `__bss_start`; `(.0)` is the field inside the atomic wrapper. The BSS starts at `0x40082e60`, 11,872 bytes after `_start`; the flat binary is 11,866 bytes long. So after the monitor copies the file, `COUNTER`, `BACKEND` and all eight stacks hold whatever the RAM held before:

```text
guest RAM after --raw hello.bin@0x40080000
0x40080000  .text: _start first, vectors at 0x40080800   copied from the file
            .rodata, .data                               (11,866 bytes)
0x40082e5a  ---------------------------- end of the file
0x40082e60  .bss: COUNTER, BACKEND, ...                   NOT in the file:
            eight 64 KiB stacks                           old contents of RAM
0x40102e90  __bss_end
```

*Nothing in the file says these bytes should be zero. `_start` has to make them zero.*

In the `linker-map` lab, pick the program "Chapter 03's hello guest, with COUNTER" and check that the symbols show `__bss_start` at `0x40082e60` and the file ending at 11,866 bytes. Then move `.bss` above `.text` and watch where `_start` goes and what a raw load at `0x40080000` would now get wrong:

:::lab linker-map

## `_start`: the first instructions of the guest

When the vCPU starts at `0x4008_0000`, there is no stack, no zeroed BSS, no vector table. Every general-purpose register, and `sp`, is zero apart from `x0` (and the PC and PSTATE the monitor sets); system registers hold their reset values, for example `MPIDR_EL1 = 0x80000000` on the first CPU. Compiled Rust assumes a stack from its first instruction, so the first code is assembly, which `global_asm!` pastes into the guest crate. Guest, `guests/common/start.rs`:

:::code anchor=guest_start_asm file=guests/common/start.rs

This notation is new since the `aarch64-reading` primer:

| Written | Meaning |
|---|---|
| `.section`, `.global` | directives: put the code in `.text.boot`, and export `_start` to the linker |
| `.Lname` | a label private to this file (the assembler drops it) |
| `and a, b, #n` | bitwise AND: `and x9, x9, #0xff` keeps the low eight bits |
| `cmp a, b` | compare: compute `a - b`, keep only the condition flags |
| `b.hs L` | branch to `L` if the last `cmp` found `a >= b`, unsigned ("higher or same") |
| `cbnz x, L` | branch to `L` if register `x` is not zero |
| `lsl a, b, #n` | shift `b` left by `n` bits into `a` |
| `#(3 << 20)` | a constant the assembler computes: 3 shifted left 20, `0x30_0000` |
| `1:`, `1b`, `2f` | numbered local labels: `1b` is the nearest `1:` backwards, `2f` the nearest `2:` forwards |
| `isb` | finish applying system-register changes before the next instruction |

Read it in five groups.

1. **Which CPU am I?** `mrs x9, mpidr_el1` reads **`MPIDR_EL1`**, this CPU's identity number; its low eight bits are 0 for the first CPU. A CPU numbered 8 or more parks at `.Lpark`, where `wfe` (wait for event) waits in a low-power state, forever.
2. **The stack.** `adrp` and `add :lo12:` form the address of `__stacks_start` relative to the PC (the primer says why). `x11 = (cpu + 1) << 16` adds 64 KiB per CPU, so `x10` is the *top* of this CPU's stack; stacks grow down. `mov sp, x10` matters most in this chapter.
3. **Floating point.** The compiler uses the floating-point registers even in ordinary code; until `CPACR_EL1`, which controls access to them, has its `FPEN` bits (20 and 21) set, any such instruction traps.
4. **The BSS.** `cbnz x9, .Lpark` sends every CPU but the first away. In chapter 20 the others start at a separate entry, `_secondary_start`, which picks its own stack the same way; hence eight stacks. Then from `__bss_start` to `__bss_end`, `str xzr, [x10], #8` stores the zero register and moves `x10` on by 8, so both ends must be multiples of 8. The linker script uses 16, because the stacks live in the BSS too and Arm's calling convention requires `sp` to be a multiple of 16.
5. **Vectors, then Rust.** Writing `VBAR_EL1` sends a fault inside the guest to a handler that prints a message, not to `0 + 0x200` as in chapter 02. Then `bl guest_main` calls Rust; if it returns, `bl guest_power_off` turns the machine off.

A macro gives each guest exactly one `guest_main`, the symbol the assembly calls. Guest, `guests/common/start.rs`:

:::code anchor=guest_entry_macro file=guests/common/start.rs

And here is a whole guest. Guest, `guests/hello/main.rs`:

:::code anchor=guest_hello file=guests/hello/main.rs

`#![no_std]` drops the standard library; `#![no_main]` drops Rust's usual start-up code. `println!` is the guests' own macro, one `hvc` per byte.

## A panic needs somewhere to go

On macOS, a panic prints and the process exits. Here there is no process, so the guest writes its own handler. Guest, `guests/common/lib.rs`:

:::code anchor=guest_panic_handler file=guests/common/lib.rs

It prints where it panicked, then calls DEBUG_EXIT ("stop with this code", next section) with code 1, which the monitor turns into its [exit status](/build-your-own/vmm/primers/os-basics/) 6, so a script can tell "the guest failed" from "the monitor failed".

## Two hypercalls, numbered by a convention

Before any device exists, the guest needs two services, print a byte and stop with a verdict, each an `hvc` with the request in registers: the [**debug hypercalls**](/build-your-own/vmm/glossary/#debug-hypercall). Guest, `guests/common/hvc.rs`:

:::code anchor=guest_debug_ids file=guests/common/hvc.rs

Read `0xC600_4D01` with the `smccc` primer's field diagram:

- bit 31 = 1: a **fast call**, which runs to completion, unlike a *yielding* call, which may pause part-way and be resumed;
- bit 30 = 1: the 64-bit convention, so all of `x1` is read, not only its 32-bit `w1` half;
- bits 29 to 24 = `0x06`: owner 6, "vendor-specific hypervisor service", for whatever hypervisor is running;
- bits 23 to 16 = 0: reserved in a fast call (the primer has the one optional exception, bit 16);
- bits 15 to 0 = `0x4D01`: function `0x4D01` of that owner (`0x4D` is the letter M).

Following the SMC calling convention (**SMCCC**, after `smc`, the secure monitor call) means a real kernel, which makes its own requests the same way (chapter 08), never mistakes our call for one of its own. Any function number in owner 6 would do, but one block is taken: on macOS 27 we measured that Hypervisor.framework answers `0xC600_0000` to `0xC600_001F` itself, so they never become VM exits. Apple does not document this, so we stay well clear, at `0x4D` (M, for macvmm); a Try it below repeats the measurement.

The call puts the ID in `x0` and the argument in `x1`, executes `hvc #0`, and reads the results back from `x0` to `x3`. SMCCC lets the callee change `x4` to `x17`, so the `asm!` block tells the compiler those registers hold garbage afterwards (`lateout(...) _`); DEBUG_MEMHASH in its comment is a later debug call (chapter 04). Guest, `guests/common/hvc.rs`:

:::code anchor=guest_hvc_call file=guests/common/hvc.rs

:::code anchor=guest_debug_putc file=guests/common/hvc.rs

:::code anchor=guest_debug_exit file=guests/common/hvc.rs

`debug_exit` never returns: if the monitor ignored the call, the guest halts.

:::stopping-point Good place to stop. The guest side is read; the rest of the chapter builds the monitor side in your workspace and needs your Mac.

## A `run` command

Now the monitor. Every later checkpoint drives it through the subcommand `run`, so its command line is an interface with exact rules. Write it with `std::env::args` and a `match` on each flag, no crate (the reference: `crates/macvmm/src/cli.rs`).

| Flag | Accepts | Refused |
|---|---|---|
| `--mem SIZE` | a number, optionally with a `K`, `M` or `G` suffix: `64M` (the reference also takes `KiB` and similar; yours may be stricter) | no digits, another suffix, a product that overflows 64 bits |
| `--raw FILE@0xADDR` | a file, `@`, a hex address with `0x` (`_` separators allowed, as in Rust: `0x4008_0000`); split at the *last* `@`, because a file name may itself contain one | no `@`, an empty file name, no `0x`, not hex, more than 64 bits |
| `--timeout SECS` | a whole number of seconds, at least 1 | 0, fractions, anything else |
| `--trace exits:FILE[:hvc]` | a file for the exit trace; `:hvc` keeps only `hvc` exits | no `exits:` prefix, no file name, the flag given twice |

Any refusal, and any flag not in the table, is a usage error: print a one-line reason on standard error and exit with status 2 *before* creating a VM. The reference has more flags; yours need not.

From here on, commands run in one of two places, with `$G` pointing at the built guests (set it again in a new terminal):

```sh
G=target/guests/aarch64-unknown-none/release      # at the repository root: the reference monitor
G=../target/guests/aarch64-unknown-none/release   # in learner/: your monitor
```

Three refusals from the reference monitor, at the repository root, each printing only the first line of its error (the full usage text follows it):

:::term source=captures/03-usage-no-0x.txt

:::term source=captures/03-usage-unknown-flag.txt

:::term source=captures/03-usage-bad-size.txt

## Loading a flat binary

`--raw FILE@ADDR` copies a file's bytes to guest address `ADDR`. The string comes from the user, so it is parsed strictly. Monitor, `crates/vmm/src/loader/raw.rs`:

:::code anchor=raw_parse_spec file=crates/vmm/src/loader/raw.rs

`F@40080000` is refused, not guessed at. Then the whole file must land inside guest RAM. Monitor, `crates/vmm/src/loader/raw.rs` and `crates/vmm/src/loader/mod.rs`:

:::code anchor=raw_check_placement file=crates/vmm/src/loader/raw.rs

:::code anchor=loader_ram_range file=crates/vmm/src/loader/mod.rs

> **Security.** The file and the address are untrusted input, so `contains` uses `checked_add`, never `+`. In a default release build `0xffff_ffff_ffff_f000 + 0x2000` wraps to `0x1000`, passes an "end is below the end of RAM" test, and the copy runs off the top of memory. With `overflow-checks` on, as in our workspace, it panics instead; `checked_add` gives a clean refusal, exit code 2.

### Planning more than one blob

`--raw` may be given more than once, so the loader plans all the blobs, then copies. Monitor, `crates/vmm/src/loader/plan.rs` and `crates/vmm/src/loader/mod.rs`:

:::code anchor=plan_raw_blobs file=crates/vmm/src/loader/plan.rs

:::code anchor=loader_overlaps file=crates/vmm/src/loader/mod.rs

Three rules, each a usage error: no blob may overlap another; no blob may touch the first 512 KiB of RAM, the device tree's slot (`dtb` in the code, `OverlapsDtb`); and the first blob is the [entry point](/build-your-own/vmm/glossary/#entry-point), so with no blob there is nothing to run (`NoImage`).

The checkpoint's contract tests call your code by these names, and compare whole results with `assert_eq!`:

| Module | Item | Must have |
|---|---|---|
| `vmm::loader::raw` | `parse_spec`, returning `RawSpec { path: PathBuf, addr }` | `Debug`, `PartialEq` |
| | `RawSpecError`: `MissingAt`, `EmptyPath`, `MissingHexPrefix`, `BadAddress` | `Debug`, `PartialEq` |
| | `check_placement` | |
| `vmm::loader::plan` | `plan(ram, &inputs)`, returning a `BootPlan` whose `entry` says where to start | `Debug`, `PartialEq` |
| | `BootInputs { kernel: Option<&[u8]>, raw: &[(u64, Arc<[u8]>)] }`; `kernel` is `None` until chapter 13 | `Default` |
| `vmm::loader` | `RamRange` | |
| | `LoaderError`: at least `OutsideRam`, `OverlapsDtb`, `Overlap`, `NoImage` | `Debug`, `PartialEq` |

For guest RAM, map 64 MiB at `0x4000_0000` with chapter 02's `OwnedMapping` (chapter 04 replaces it). Copy each blob in with `OwnedMapping::write(ADDR - 0x4000_0000, bytes)`, an offset into the mapping, not a guest address. Then set the PC to the entry, PSTATE to `0x3c5` as in chapter 02, and `x0` to `0x4000_0000` (the checkpoint accepts any value).

## A loop that answers exit after exit

A guest that prints `hello from guest` needs one answer per byte, so the run becomes a [**run loop**](/build-your-own/vmm/glossary/#run-loop): run, decode, handle, decide whether to go back in. Here is the reference's, which later chapters extend. Monitor, `crates/vmm/src/vcpu/run_loop.rs`:

:::code anchor=run_loop file=crates/vmm/src/vcpu/run_loop.rs

You need its skeleton: `vcpu.run()`, decode the syndrome as chapter 02 did (`Exit::from_hv`), handle the exit, then resume or stop: the `loop` with its first `match`, the `Exit::from_hv` line, and the `match action` arms `Resume` and `Stop`. Skip the rest for now: `ring` (chapter 07), `stats` (chapter 11), `generation` (chapter 21), `GuestFatal` (chapter 06), `CpuOff` (chapter 20), and `obs.trace` (next section). The stop flag at the top is an atomic boolean another thread sets to ask the vCPU to stop; your monitor gains it in chapter 09.

An `hvc` exit is an SMCCC call: read `x0` to `x3`, dispatch on the ID, write back the results. Monitor, `crates/vmm/src/vcpu/exit.rs`:

:::code anchor=exit_smccc_call file=crates/vmm/src/vcpu/exit.rs

Its last lines hold the call rule: `advance_pc: conduit == Conduit::Smc`. An `smc` must be stepped past; an `hvc` must not, because the hardware already moved the PC (chapter 02). `debug_calls` is true only for test guests loaded with `--raw`, so a real kernel never gets the debug calls (chapter 08); your first version can answer them unconditionally. Only the first two matter today. Monitor, `crates/vmm/src/smccc.rs`:

:::code anchor=smccc_debug_call_fn file=crates/vmm/src/smccc.rs

DEBUG_PUTC writes the low byte of `x1` to standard output and returns 0. DEBUG_EXIT stops the VM with the guest's code. `_start` ends with a third, `guest_power_off`: `SYSTEM_OFF`, ID `0x8400_0008`, the standard Arm power-off call of the Power State Coordination Interface (**PSCI**, chapter 08). Every other ID answers -1, NOT_SUPPORTED (`u64::MAX` in `x0`); log unknown IDs, but limit how many. Your first version is a `match` with four arms: DEBUG_PUTC, DEBUG_EXIT, `SYSTEM_OFF` (stop, exit 0), and everything else (-1).

> **Security.** DEBUG_PUTC's bytes come from the guest, and an escape sequence can repaint or reprogram your terminal. The reference filters them through `write_guest`, the `AnsiFilter` its comments name; chapter 09 builds that filter. For now, write any byte outside printable ASCII and newline as `?`.

Run `hello` with your monitor, from `learner/`:

```sh
cargo run -q -p macvmm -- run --mem 64M --raw $G/hello.bin@0x40080000 --timeout 10
```

:::term source=captures/03-first-hello.txt

Two lines, exit status 0, from the power-off call. `x0=0x40000000` is where the device tree will go (chapter 10); printing it proves that a register you set arrives.

## Counting exits: the first trace

You can now count exits instead of believing in them, with an [**exit trace**](/build-your-own/vmm/glossary/#exit-trace). With `--trace exits:FILE:hvc`, the monitor writes one line of JSON (JavaScript Object Notation) per `hvc` exit: numbers and names from fixed tables, never bytes the guest chose. Monitor, `crates/vmm/src/trace.rs`:

:::code anchor=trace_record file=crates/vmm/src/trace.rs

Your first version writes eight of those fields by hand with `format!`. The checkpoint parses the lines and searches them for exact text, so match this record's keys, their order and its punctuation exactly; your `t_ns` and `pc` will differ.

```text
format:
{"t_ns":232541,"vcpu":0,"reason":"exception","ec":"0x16","pc":"0x4008117c","imm":0,"fn":"DEBUG_PUTC","action":"smccc"}
```

No spaces. `t_ns` (nanoseconds since the VM started: `std::time::Instant`, or `mach_absolute_time` as in the reference), `vcpu` and `imm` are plain numbers; `reason` is `"exception"`; `ec` and `pc` are hex strings written with `{:#x}`. `fn` (`func` in Rust, where `fn` is a keyword) names the call (`DEBUG_PUTC`, `DEBUG_EXIT`, `PSCI_SYSTEM_OFF`); `action` is `smccc` for the debug calls and `psci` for the power-off. The checkpoint looks for the exact text `"reason":"exception","ec":"0x16"` and `"fn":"PSCI_SYSTEM_OFF","action":"psci"`, and counts lines containing `"ec":"0x16"`.

```sh
cargo run -q -p macvmm -- run --mem 64M --raw $G/hello.bin@0x40080000 --trace exits:h.jsonl:hvc --timeout 10
grep -c '"ec":"0x16"' h.jsonl
```

:::term source=captures/03-hello-trace-run.txt

:::term source=captures/03-trace-count.txt

44 records: the output is 43 bytes (31 characters, a newline, 10 characters, a newline), plus the power-off. The DEBUG_PUTC records' `pc`, `0x4008117c`, is the instruction *after* an `hvc` in the console's print routine. The output took about 190 µs, 4.4 µs per exit, terminal and trace file included.

> **Try it.** Watch Hypervisor.framework answer a call before your monitor sees it. In `guests/common/hvc.rs`, change `DEBUG_PUTC` to `0xC600_0001` and run `scripts/build-guests.sh`. Then run the command below with the reference monitor at the repository root. Look for: no output, and a trace with only the power-off record. Afterwards: `git restore guests/`, then `scripts/build-guests.sh`.

:::term source=captures/03-putc-0001.txt

Nothing printed, and the trace holds only the power-off: Hypervisor.framework answered 43 `hvc` instructions inside macOS.

## When the guest never calls: `--timeout`

Chapter 02's break 1 left you pressing Ctrl-C: a guest in `b .` never exits, so `hv_vcpu_run` never returns. The vCPU's thread is stuck inside it, so the reference's main thread waits for "the VM stopped" or the deadline, whichever comes first. Monitor, `crates/vmm/src/vcpu/manager.rs`:

:::code anchor=run_vcpus_timeout file=crates/vmm/src/vcpu/manager.rs

`request_stop(Timeout)` sets the stop flag, then *kicks* the vCPU: `hv_vcpus_exit` makes a running `hv_vcpu_run` return with the reason `CANCELED` (chapter 09). Yours can be simpler. Spawn a thread and create the vCPU *inside* it: a vCPU belongs to the thread that created it (chapter 02), which is why your `Vcpu` is not `Send`. Move the plan's entry point into the closure, run the loop there, and send the stop reason (power-off, or DEBUG_EXIT's code) back over a [channel](/build-your-own/vmm/primers/host-concurrency/#handing-over-messages-channels). The main thread calls `recv_timeout(Duration::from_secs(n))`; if the deadline wins, it prints a message containing `timeout` to standard error (the checkpoint looks for it) and exits with status 5, which ends the vCPU too.

Now make a hung guest on purpose, `b .` as four bytes, `0x14000000` stored little-endian (printf escapes are octal: `\024` is `0x14`), and run it with your monitor from `learner/` (the output below is the reference's; yours should say the same):

```sh
printf '\000\000\000\024' > spin.bin
cargo run -q -p macvmm -- run --mem 64M --raw spin.bin@0x40080000 --timeout 1; echo "exit status $?"
```

:::term source=captures/03-spin-timeout.txt

The monitor's exit status is now part of its interface. Monitor, `crates/vmm/src/control.rs`:

:::code anchor=exit_code_match file=crates/vmm/src/control.rs

This chapter meets 0 (power-off, or DEBUG_EXIT with 0), 2 (a usage error), 5 (timeout) and 6 (DEBUG_EXIT with any other code); the [reference card](/build-your-own/vmm/reference/) lists the rest.

## Breaking it on purpose

Two breaks in the guest's start-up code. Unless a step says *your* monitor, run from the repository root with the reference monitor, and rebuild the guests after every edit.

**Deliberate breakage 1: delete the BSS-zeroing loop.** In `guests/common/start.rs`, delete the eight lines from `adrp x10, __bss_start` to `b 1b`, and on the next line remove only the `2:` prefix (keep `adrp x10, guest_vectors`). Then, in `guests/hello/main.rs`:

1. Import `AtomicU32` and `Ordering` from `core::sync::atomic`, and add the `COUNTER` static from earlier at the top level.
2. In `main`, read it with `COUNTER.load(Ordering::Relaxed)` and print it with `println!("hello: COUNTER = {:#x}", ...)`.
3. Store it back plus one, so the compiler cannot treat it as a constant.

Rebuild and run.

:::predict Nothing sets `COUNTER` to zero any more. Will it print 0?
Run it before you read on.
:::

:::term source=captures/03-bss-nozero.txt

It prints 0. Now break the monitor too: in your raw loader, fill guest RAM from the load address to its end with `0xA5` before copying the file, like RAM left by a previous program. Run the same guest with your monitor (we made the same change in a copy of the reference's loader).

:::term source=captures/03-bss-a5.txt

`0xa5a5a5a5`. Put the zeroing loop back, keep the `0xA5` fill, and run again:

:::term source=captures/03-bss-a5-fixed.txt

What you saw: a zero that came from fresh memory, not from the program. The misconception: "a static that starts at zero is zero by itself". On macOS the loader and the kernel's zero pages do it; bare metal has neither, so `_start` must. The tool: poison fresh memory with an implausible pattern, then look for it.

**Deliberate breakage 2: delete the stack setup.** Restore the guests, delete the line `mov sp, x10` from `_start`, and rebuild. Run it with the reference monitor, which can kick a hung vCPU and record that in a full trace (no `:hvc` filter); yours gains the kick in chapter 09.

:::predict What does `sp` hold when `guest_main` starts, and what will you see?
Write it under Q2 in your journal, then run it.
:::

:::term source=captures/03-no-stack.txt

No output, exit status 5, and one trace record: `canceled`, the timeout's kick, with the guest's PC at `0x40080a00`. What was `sp`? We added eight instructions at the top of `_start` that print one character through DEBUG_PUTC: `A` if `sp` is exactly 0, `?` otherwise:

:::term source=captures/03-sp-probe.txt

`sp` was 0: Hypervisor.framework starts it there, like every general-purpose register. Now the code that ran:

:::term source=captures/03-no-stack-disasm.txt

`guest_main` starts with `sub sp, sp, #0x20`: `0 - 0x20` wraps to `0xffff_ffff_ffff_ffe0`, and its next store goes far above any memory. With the MMU off, an address too large to be physical is an [**address size fault**](/build-your-own/vmm/glossary/#address-size-fault), taken at the guest's own level, EL1.

In chapter 02, `0x200` was a plausible address with no memory behind it, so the monitor heard about it. `0xffff_ffff_ffff_ffe0` is too wide to be an address at all, so the CPU rejects it inside the guest; EL2 has nothing to forward. The CPU went to the guest's handler at `VBAR_EL1 + 0x200`, `0x40080a00`, which stores through the same bad stack and faults again, forever, without a VM exit.

What you saw: a hang in the guest's own exception handler. The misconception: that the CPU or the monitor provides a stack; nothing does, and even the fault handler needs one. The tool: `--timeout` plus the trace, whose last record says where the vCPU was.

Before going on: `git restore guests/`, then `scripts/build-guests.sh`, and remove the `0xA5` fill from your loader (or keep it behind a debug flag; it is a useful poison).

## What one exit costs

Back to the opening question. `exit-bench` makes 100,000 calls with an ID nobody implements, `0xC600_00FF`, above Hypervisor.framework's block, so every call is a real exit. The monitor does very little work: decode, dispatch, answer -1, plus the bookkeeping every exit gets (statistics, the exit ring, a rate-limited warning). Guest, `guests/exit-bench/main.rs`:

:::code anchor=exit_bench_loop file=guests/exit-bench/main.rs

The clock is `CNTVCT_EL0`, the CPU's virtual counter, which counts up at a fixed rate (chapter 11 builds timers on it). Guest, `guests/common/lib.rs`:

:::code anchor=guest_cntvct file=guests/common/lib.rs

```sh
cargo run -q -p macvmm -- run --mem 64M --raw $G/exit-bench.bin@0x40080000 --timeout 30
```

:::term source=captures/03-exit-bench-run.txt

The guest divides by the frequency in `CNTFRQ_EL0`. Check: 3,433,366 ticks / 100,000 is 34.3 ticks per exit, and 1,430 ns / 34.3 is 41.7 ns per tick, a 24 MHz counter. Two runs on our Mac gave 1,430 and 1,415 ns (the second is below). Load and power state move it: on an idle Mac on AC power expect roughly 1.3 to 2 µs. In that time the CPU leaves the guest, enters EL2, returns to macOS, wakes our thread, runs our Rust, and goes all the way back.

`hello`'s 4.4 µs included tracing, formatting and cold caches. Use your number to estimate how long 4 KiB through DEBUG_PUTC takes, and write it under Q1 before reading on.

The 110 `warn` lines report the unknown ID: ten in full, then one per thousand. A guest decides how often it calls, so even our *complaints* are limited.

Now compare with one store instruction. A tick is too coarse to time one store, but a million can be timed. This step is part of the measurement, not optional:

1. In `guests/exit-bench/main.rs`, after the final `println!`, read `guest::cntvct()`, then for `i` from 0 to 1,000,000 store `i` into a local `u64` with `core::ptr::write_volatile(&mut local, i)`, then read the counter again.
2. Compute picoseconds per store in `u128`: `ticks * 1_000_000_000_000 / freq / 1_000_000`. Print it as `exit-bench: 1000000 stores in {ticks} ticks, {ps} ps/store`.
3. Run `scripts/build-guests.sh`. Then run the command below with the reference monitor at the repository root; `--log error`, a reference flag your monitor does not have, hides the 110 warnings.
4. Undo the change and rebuild: `git restore guests/`, then `scripts/build-guests.sh`.

:::term source=captures/03-store-loop.txt

233 picoseconds per store, loop included: about one store per cycle. (Every store goes to the same stack slot, and the guest never has to stop for any of them. Don't read much into the absolute number; the point is the ratio.) One exit costs about six thousand stores: the [exit cost](/build-your-own/vmm/glossary/#exit-cost). A disk delivering 4 KiB a byte at a time would cost 4,096 exits. That is ledger row 8, measured: from chapter 15 on, devices stop talking byte by byte and share memory instead.

## Your turn

Your workspace now has `run` with four flags, a loop with four answers, and exit codes 0, 2, 5 and 6. Check, from inside `learner/`:

1. `hello` prints two lines and exits 0; with `--trace`, the trace has 44 `hvc` records.
2. `spin.bin` with `--timeout 1` prints `timeout` on standard error and exits 5.
3. `exit-bench` prints its line; your number goes in your journal.
4. Your journal has answers under Predict and Q1 to Q3 (Q1 needs your `exit-bench` number; Q3 is the open question below).

Stuck? `scripts/learner hint 03` gives four hints, from a nudge to the exact reference file.

## Checkpoint

From the repository root:

:::checkpoint

It runs the contract tests for your raw loader, then your monitor four times: `hello`; `hello` traced, with `hvc` records numbering the printed bytes plus 1; the `b .` blob with `--timeout 1` (exit 5); and `exit-bench` (format only). Then it checks your journal. Against an unmodified copy of the reference:

:::term source=captures/03-checkpoint.txt

What now works:

- a Rust program with no operating system runs in your VM, with its own stack, BSS and panic handler;
- your monitor loads a flat binary safely, answers exit after exit, stops a hung guest, and reports why in its exit status;
- you can count a guest's exits, and you know what one costs.

The next chapter starts from this state (the reference at the end of chapter 03).

### What's next

So far guest RAM is one `OwnedMapping` and a `write` method. Chapter 04 asks what it means to share memory with a guest that may be changing it at the same instant, and why the only safe way to touch it is a bounds-checked copy.

### Open question

`hello` printed 43 bytes through DEBUG_PUTC, and your monitor wrote every one to your terminal. A guest you did not write sends a million bytes, or a billion, as fast as it can. What does your monitor do with them, and which limit would you add?

## Spec hunt

- Arm's *SMC Calling Convention* (document DEN 0028), the section on function identifiers and its table of owning entity numbers: which owner would a call to a trusted operating system use, and why can no PSCI call ever equal `0xC600_4D01`?
- ARM ARM (DDI 0487), register pages **CNTVCT_EL0** and **CNTFRQ_EL0**: who writes the frequency, and why does `exit-bench` read it instead of assuming 24 MHz?
- *Procedure Call Standard for the Arm 64-bit Architecture* (AAPCS64), the universal stack constraints: what must be true of `sp` at all times, and which line of `link.ld` keeps `_start`'s stacks honest?
