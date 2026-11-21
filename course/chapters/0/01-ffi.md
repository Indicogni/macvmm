---
title: Where our VMM sits: Hypervisor.framework and a hand-written FFI
part: 0
chapter: 0.2
id: 01
runs: mac+browser
minutes: 240
prereqs: [00]
start_tag: ch-00
labs: [trap-or-not, repr-c-layout]
command: scripts/checkpoint.sh 01
expect: CHECKPOINT 01 PASS
---

:::retrieval from=00

:::concepts
- **Core, taught here:** who owns the CPU's most privileged level on a Mac (chapter 02 makes it exact); the macOS virtualization stack and its two supervisors; where Virtualization.framework sits (named here, used in chapter 23); `unsafe` Rust (extra powers, not fewer checks; the invariants become yours); the foreign function interface (FFI): `extern "C"`, linking a framework, C types to Rust types, out-pointers; `repr(C)` layout (the `repr-c-layout` lab); `hv_return_t` decoded into `HvError`; one VM per process, modelled as a value that destroys itself.
- **Core, from earlier:** the problem ledger, the strategies, hardware assist, the second translation stage (the idea) and the readiness check `scripts/doctor.sh` (chapter 00).
- **Primers (read first):** `codesign-entitlements` (its "need to know" part: ad-hoc signing, the entitlement, why every build must be re-signed, the signing runner).
- **Primers (review):** `os-basics` (user and kernel mode, a system call, a page fault, an interrupt).
- **Pointers:** type 1 and type 2 hypervisors (an Aside); Mach error codes (an Aside); the Rust book's "Unsafe Rust", the Rustonomicon's FFI chapter and the Cargo book's "Build Scripts" (linked where used); which desktop VM apps use which Apple framework. For the curious: the reading-specs primer.
- **Forward definitions:** EL0, EL1 and EL2 (named in chapter 00, recalled in one sentence before the stack figure; chapter 02); vCPU, one virtual CPU of a guest (chapter 02); IPA (intermediate physical address), "the address the guest thinks is physical" (the doctor's max IPA line; chapter 05); GICv3, Arm's interrupt controller (chapter 12); the one-line meaning of every action in the `trap-or-not` table (chapters 02, 05, 08 and 11).
:::

In chapter 00 you ran the provided readiness check, and its first line said yes:

:::term source=captures/00-doctor.txt

Three questions hide in that line. Which program answered `hv_vm_create: OK`? At what privilege level does that program run, given that you started it from an ordinary shell? And if any program can ask, what stopped every other app on your Mac from doing the same? By the end of this chapter you will have answered all three, drawn the picture every later chapter reuses, and made the same call from a Rust crate you wrote yourself.

This is still row 1 of the problem ledger, the processor, which from here on we call the CPU (central processing unit): the mechanism we will use needs an interface before it can run anything.

:::objectives
- Say which software owns the CPU's most privileged level on a Mac, and what it lets an ordinary process do.
- Draw the macOS stack from memory (guest apps and guest kernel, our process, Hypervisor.framework, the kernel's EL2 part, the CPU), mark which layer decides what traps and which decides what to do about it, and say what Virtualization.framework adds and why this course uses Hypervisor.framework.
- After sorting the ten guest actions in `trap-or-not` (unscored), explain three of them in your own words: which ledger row, what stops the guest, and who handles it.
- Interpret every line of the doctor's output, and explain from the Predict run why a missing entitlement is a run-time error and not a link error.
- Write `extern "C"` declarations for `hv_vm_create` and `hv_vm_destroy` that match the SDK (software development kit) headers, checked by reading the headers, not from memory.
- Convert `hv_return_t` into an `HvError` enum whose `Display` names the error and keeps unknown codes; write a `// SAFETY:` comment for each `unsafe` call stating the invariant it relies on; observe and explain "one VM per process".
:::

**Before you start.** From the repository root, run `scripts/learner init` if you have not yet (it creates `learner/`, your own workspace, and prints `learner: ready`), then `scripts/learner start 01`, which copies this chapter's journal to `learner/journal/01.md`, "your journal" below. Every code block on this page comes from the [reference](/build-your-own/vmm/glossary/#reference-implementation): the course's finished virtual machine monitor (VMM), in this repository's `crates/`. Your own code lives in `learner/`, and the text says where yours differs. Sitting A is reading and a browser lab (about 1.5 hours); sitting B is your first Rust against the framework, at your Mac (about 2.5 hours).

## Who owns the most privileged level?

Recall hardware assist from chapter 00: CPU makers added a level more privileged than the kernel, whose software chooses what traps. On your Mac that level exists, and something already sits in it. So the useful question for anyone building a [VMM](/build-your-own/vmm/glossary/#vmm) is not "what kind of hypervisor is this?" but **which software owns the CPU's most privileged level, and what does it let us do?**

> **Aside.** You will meet "type 1" (a [hypervisor](/build-your-own/vmm/glossary/#hypervisor) that runs on the bare machine, such as Xen) and "type 2" (one that runs as a program on another operating system, such as VirtualBox), from Robert P. Goldberg's thesis, *Architectural Principles for Virtual Computer Systems* (Harvard University, 1973). Modern systems blur the line, because the host's own kernel takes the privileged part: Linux does this with KVM (chapter 00's Aside), macOS with Hypervisor.framework. This course never needs the [labels](/build-your-own/vmm/glossary/#type-1-type-2-hypervisor).

## The stack, in one picture

First, a reminder of chapter 00's level names, so no label below is cold. Arm numbers its privilege levels: **EL0** is where ordinary programs run, **EL1** where a kernel runs, and **EL2** the level that supervises kernels ([exception levels](/build-your-own/vmm/glossary/#el0-el1-el2-el3); chapter 02 meets them properly). For now: higher number, more power.

The [guest](/build-your-own/vmm/glossary/#guest)'s apps run at EL0 and its kernel at EL1, natively, on the real CPU. Nothing interprets their instructions. Above them, at EL2, sits a part of the macOS kernel (Apple calls the kernel [XNU](/build-your-own/vmm/glossary/#xnu); "the macOS kernel" is enough here). That part configures what traps, sets up how guest memory is translated, and decides which exceptions leave the guest.

Our VMM, `macvmm`, is none of those: it is an ordinary process. It calls into **Hypervisor.framework** ([HVF](/build-your-own/vmm/glossary/#hvf)), which is a user-space library: ordinary code inside our own process that makes system calls into that kernel part.

```text
   guest (believes it owns the machine)          host (macOS)
 +------------------------------+     +-------------------------------------+
 | guest apps, EL0              |     | macvmm, our VMM: ordinary process,  |
 |   ask (system call)          |     | EL0. Memory map, devices, exits     |
 |   v                          |     +-------------------------------------+
 | guest kernel, EL1            |       | calls hv_vcpu_run    ^ returns the
 +------------------------------+       v through              | exit to
          | runs natively on          +--------------------+   |
          v                           | Hypervisor.        |   |
 +------------------+                 | framework (library)|   |
 | Apple Silicon    |                 +--------------------+   |
 | CPU              |                   | enters (system call) |
 +------------------+                   v                      |
          | takes a trapped     +-----------------------------------------+
          +-- exception to ---> | macOS kernel, EL2 part: decides what    |
                                | traps, sets up guest memory translation |
                                +-----------------------------------------+
   ===== trust boundary: everything on the left is guest-controlled =====
```

*EL0 = ordinary programs, EL1 = a kernel, EL2 = the level that supervises kernels (chapter 02). Notice that our VMM sits at EL0, beside every other app.*

So there are [**two supervisors**](/build-your-own/vmm/glossary/#two-supervisors). The kernel's EL2 part decides *what leaves the guest*; we decide *what to do with what it hands us*. When a guest reaches for something it does not own, the CPU takes an exception to EL2. The kernel either handles it itself and resumes the guest, or returns it to us as a VM exit from `hv_vcpu_run`, the call that runs one virtual CPU (a [vCPU](/build-your-own/vmm/glossary/#vcpu)) of the guest until something stops it (chapter 02 runs one).

How sure are we of this picture? We checked that the guest kernel runs at EL1: chapter 02 starts it there and chapter 06 reads it back. The EL2 part must exist, because the controls it uses exist only at EL2. Whether *all* of the macOS kernel runs at EL2 we do not know, so the figure says "EL2 part".

That answers the opening's first two questions. `hv_vm_create: OK` was answered by the kernel's EL2 part, through the library, to a doctor running at EL0. If you came in believing "our VMM is the hypervisor and runs at a privileged level", the figure retires it: the privileged half is Apple's, and ours is an app.

## Where the apps and Apple's other framework sit

The desktop VM apps you may know, such as UTM, Parallels Desktop and VMware Fusion, sit at our layer, as ordinary processes. Each builds on one of two Apple frameworks. One is Hypervisor.framework. The other is **Virtualization.framework** ([VZ](/build-your-own/vmm/glossary/#vz)): a complete machine with devices and firmware Apple chose, which you configure rather than build.

[UTM's README](https://github.com/utmapp/UTM) lists both: "Hardware accelerated virtualization using Hypervisor.framework and QEMU", and "Boot macOS guests with Virtualization.framework". For the other apps, we have not been able to check which framework each uses.

Why HVF? With VZ you configure a machine Apple built. With HVF you build it: you choose every device, the memory map and the firmware. So you can boot stock firmware VZ does not let you pick, such as U-Boot (a widely used open-source firmware that loads operating systems), which then boots FreeBSD in chapters 21 and 22. And you see every VM exit, which is how you learn what a virtual machine is. VZ packages what a macOS guest needs (Apple's boot ROM and paravirtual devices); doing that on HVF means rebuilding those pieces, which chapter 23 investigates.

## Sorting real guest actions

Time to use the picture. The lab below gives you ten things a guest might do, each described in plain words first and its Arm instruction name second. Drag each into one of three buckets:

- **stops and reaches our VMM**;
- **stops, but the macOS kernel handles it** (it never reaches us);
- **never leaves the guest**: the CPU completes it without stopping the guest, though the hardware may help.

Nothing is scored, and you have met no Arm yet, so guess freely: what counts is the explanation in the feedback.

:::lab trap-or-not

If the lab does not load, sort these on paper first, then open the reference sort below. The ten actions: load a value from RAM (`ldr`); store a byte to the serial port's address, `0x0900_0000` (`str`); wait until an interrupt (`wfi`); the guest kernel calls the level above (`hvc`); read the clock counter (`mrs CNTVCT_EL0`); touch a virtual address the guest kernel's own page tables do not map; an app inside the guest asks its kernel for a service (`svc`); the guest kernel calls the firmware (`smc`); set the debugger's lock register (`msr OSLAR_EL1`); store to the interrupt controller's registers.

:::predict Reference sort: open it after you have sorted all ten.

| Guest action | Bucket | What stops it, who handles it, and why | Ledger row |
|---|---|---|---|
| `ldr`, "load a register from memory", from RAM | never leaves the guest | the hardware translates the address to memory our VMM gave the guest, without stopping (chapter 05) | 2 |
| `str`, "store a register to memory", to `0x0900_0000` | reaches our VMM | the hardware stops it, because our VMM gave the guest RAM at some addresses and deliberately left this one empty (the second translation stage from chapter 00; chapter 05); EL2 forwards it, and our VMM handles it by playing the device (chapter 07) | 3 |
| `wfi`, "wait until an interrupt" | the kernel handles it | with the in-kernel interrupt controller this course uses, the kernel parks the vCPU until an interrupt arrives, without asking us (chapter 12) | 6, 7 |
| `hvc`, "call the level above" | reaches our VMM | a deliberate call to EL2, forwarded (chapter 02); chapter 03 finds one small block of calls the kernel answers itself | 1, 4 |
| `mrs CNTVCT_EL0`, "read a clock the hardware virtualizes" | never leaves the guest | the hardware shows the guest its own offset view of the counter (chapter 11) | 7 |
| a page fault in the guest's own tables | never leaves the guest | the guest kernel's business, as in the `os-basics` primer: its own exception at EL1 | 2 |
| `svc`, "call my own kernel", from a guest app | never leaves the guest | an app calling its own kernel, inside the guest (chapter 02) | 1 |
| `smc`, "call the firmware" | reaches our VMM | the guest's machine has no firmware level of its own; EL2 is set to catch every `smc` and forwards it (chapter 02) | 4 |
| `msr OSLAR_EL1`, "write a system register", here the debugger's lock | reaches our VMM | EL2 traps this debug register and forwards it; we decide what it does (chapter 08) | 1 |
| store to the interrupt controller | the kernel handles it | the kernel emulates the controller itself, so no exit reaches us (chapter 12) | 6 |

*Measured by how often each happens, most of what a guest does never leaves it: a running guest executes millions of loads for every exit. The two supervisors split the rest.*

:::

Notice the first two rows: a load and a store look alike, yet one never stops and the other always does. Journal question 1 asks you why.

Now close the page and redraw the stack figure on paper. Then pick three actions you sorted differently from the reference (or, if none, the three you were least sure of), and under Q1 in your journal write, for each, its ledger row, what stops the guest, and who handles it.

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 2.5 hours.

## The gate: checked when you call

The third opening question: what stops other apps? You read the answer's mechanism in the `codesign-entitlements` primer: the kernel lets a process use Hypervisor.framework only if its code signature carries the [entitlement](/build-your-own/vmm/glossary/#entitlement) `com.apple.security.hypervisor`. Every binary `cargo build` writes has a fresh signature with no entitlements, so the repository runs everything through a signing runner, named in `.cargo/config.toml`:

:::code anchor=cargo_runner file=.cargo/config.toml

The plist it applies holds exactly one key:

:::code anchor=entitlements_plist file=entitlements.plist

And the runner signs a private copy, then runs it:

:::code anchor=sign_and_run file=scripts/sign-and-run.sh

`SIGN-4`, in those comments, is the project's internal name for one rule: only sign or run a binary that cargo built under the repository's `target/` directory, so the runner can never be pointed at some other program.

One reminder you already have as a C or Rust programmer: the linker joins your code to the framework at build time; a run-time check happens only when the call executes.

:::predict At the end of this sitting your doctor works. Suppose you then sign it with no entitlement (`scripts/sign.sh --no-entitlements`) and run it directly. Do you get (a) a link error, (b) a crash, or (c) a clean error value at run time?
Write your choice and one sentence of reasoning under `## Predict` in your journal before you read on. Our run of the reference is below; you repeat it on your own binary at the end of this sitting.
:::

**Deliberate breakage 1: run the doctor without the entitlement.** This is our run, on the reference. First, the build. It links, the framework is on the binary's list of libraries (`otool -L` lists the libraries a binary loads at launch), and the signature holds no entitlements at all (`codesign` prints only the file name):

:::term source=captures/01-built-not-entitled.txt

Then we signed it with none on purpose, and ran it without the runner:

:::term source=captures/01-unsigned-doctor.txt

We checked this on a real Mac: (c). The program started, printed, asked, and got `HV_DENIED (0xfae94007)` back as an ordinary return value, then a hint.

What you saw: a clean refusal at the call. The misconception it exposes: "a missing permission is a build problem". The tool that finds it: the doctor, which turns the number into a name. The entitlement is a capability of the process, checked by the kernel when the call is made; the linker never looks at it.

## Every doctor line, read

Here is the reference's doctor, run through the runner as `cargo run` does, line by line. Yours prints a header and the three lines the checkpoint needs.

:::term source=captures/01-doctor.txt

| Line | What it means |
|---|---|
| `codesign entitlements: … only` | the signature carries exactly our one key, and nothing more |
| `hardened runtime: yes` | the signature asks macOS to ignore library-injecting environment variables at launch (the primer's "going deeper" part) |
| `hv_vm_create: OK` | the kernel's EL2 part made a VM for this process, then destroyed it |
| `max IPA: 40 bits (default 36)` | the widest guest-physical address a VM may use. An [**IPA**](/build-your-own/vmm/glossary/#ipa) (intermediate physical address) is the address the guest thinks is physical; chapter 05 explains the limit (journal question 4) |
| `EL2 supported: yes` | a guest may be offered EL2 itself (nested virtualization, an Aside in chapter 02) |
| `max vCPUs: 64` | how many vCPUs one VM may have (chapter 20) |
| `in-kernel GICv3 …: OK` | the kernel can emulate a GICv3 for us: Arm's Generic Interrupt Controller, version 3, the chip that routes interrupts to CPUs (chapter 12) |
| `page size: 16384` | the Mac's memory page is 16 KiB, the unit guest memory is mapped in (chapter 02) |
| `vm create/destroy x100: OK` | tearing a VM down really releases it, a hundred times running |

## Reading the header, not memory

Every Hypervisor.framework function is declared in C, in the [SDK](/build-your-own/vmm/glossary/#sdk) on your Mac. Rust cannot read C headers, so we write the matching Rust declarations by hand: that is the **foreign function interface** ([FFI](/build-your-own/vmm/glossary/#ffi)). The rule of this course is to read the declarations from the header in front of you, never from memory or a blog post. The two functions:

:::term source=captures/01-hv-vm-header.txt

They use two types declared elsewhere, so follow them into their own headers. [`hv_return_t`](/build-your-own/vmm/glossary/#hv-return-t) is a `mach_error_t`, which is a `kern_return_t`, which is a plain C `int`. `hv_vm_config_t` is a pointer to an opaque framework object:

:::term source=captures/01-hv-return-header.txt

Three translations turn those lines into Rust:

- `hv_return_t` ends in a C `int`, so `i32`. The header writes the codes as unsigned hex, which we come back to below.
- `hv_vm_config_t` is a pointer to an opaque framework object (if you create one, you hold a reference and release it when done), and `_Nullable` says NULL is allowed and means "default". So: a raw pointer, `*mut c_void`. `c_void` is Rust's name for C's `void`, from `core::ffi`, used only behind a pointer.
- `void` in the parameter list means no parameters.

Start `learner/crates/hvf/src/ffi.rs` with the lines that make C's names legal and bring in `c_void` (you need only `c_void` from that list; without the `allow`, the C-style lower-case type names draw warnings):

:::code anchor=ffi_prelude file=crates/hvf/src/ffi.rs

Then the two types:

:::code anchor=ffi_hv_return_t file=crates/hvf/src/ffi.rs

:::code anchor=ffi_vm_config_t file=crates/hvf/src/ffi.rs

Declare the modules in `learner/crates/hvf/src/lib.rs`, below the attributes already there: `pub mod ffi; pub mod error; pub mod vm;` (you write `error.rs` and `vm.rs` below). The checkpoint's tests use `hvf::ffi` directly, so `ffi` must be public.

`extern "C"` says "these functions use the C calling convention", and `#[link]` names the framework to link against. The block opens like this:

:::code anchor=ffi_extern_block file=crates/hvf/src/ffi.rs

Inside it go your two declarations; close the block with `}`:

:::code anchor=ffi_vm_create_destroy_only file=crates/hvf/src/ffi.rs

The block is `unsafe extern`: the compiler cannot check that these lines match the C library, so we promise they do. That promise is checked later by `scripts/check-ffi.sh`, which compiles the real headers and compares.

The reference's block also declares `hv_vm_get_max_vcpu_count`, which you do not need yet. It shows the C pattern you will see everywhere: the return value is taken by the error code, so the real answer comes back through an [out-pointer](/build-your-own/vmm/glossary/#out-pointer), a pointer to memory the *caller* owns, which the function writes into. The doctor's `max vCPUs` line is read like this:

:::code anchor=caps_out_pointer file=crates/hvf/src/caps.rs

The `#[link]` attribute alone is enough to link the framework. The course also adds `learner/crates/hvf/build.rs`, a build script Cargo runs before compiling the crate ([the Cargo book's "Build Scripts"](https://doc.rust-lang.org/cargo/reference/build-scripts.html)), which says the same thing for the whole crate. It is belt and braces: the dependency is written down in one obvious place, and every target of the crate (its tests, its examples) links the framework even if the `extern` block moves.

:::code anchor=build_rs file=crates/hvf/build.rs

C structs cross the boundary too. Rust may reorder a struct's fields; C may not. [`repr(C)`](/build-your-own/vmm/glossary/#repr-c) tells Rust to lay a struct out as C would, padding included. The lab lets you type a struct and see both layouts. Its worked example is the exit record you will declare in chapter 02:

:::lab repr-c-layout

If the lab does not load: `hv_vcpu_exit_t` is a 32-bit reason followed by three 64-bit values, so C puts 4 bytes of padding after the reason to align the next field to 8. Offsets 0, 8, 16 and 24; 32 bytes in all. Without `repr(C)`, Rust promises no particular order.

## What `unsafe` switches on

Calling any of these functions needs an `unsafe` block. A common belief is that [`unsafe`](/build-your-own/vmm/glossary/#unsafe-rust) turns Rust's checks off. It does not. It allows a handful of extra operations the compiler cannot verify; [the Rust book's "Unsafe Rust"](https://doc.rust-lang.org/book/ch20-01-unsafe-rust.html) counts five, among them calling an `unsafe` function (every FFI function is one) and dereferencing a raw pointer. Inside the block, the type checker, the borrow checker and bounds checks on safe indexing all stay on.

What changes is who carries the proof. For an FFI call, the compiler sees a function and some integers; it cannot see that the out-pointer must point at live, writable memory, or that the VM must be destroyed exactly once. Those rules, the **invariants**, become yours, so the course writes each one down in a `// SAFETY:` comment above the block, as in the out-pointer example.

When you run `cargo clippy` (Clippy is Rust's lint tool), a missing comment in the `hvf` crate is an error, as the scaffold's `lib.rs` already says; `cargo run` alone does not check it, so "Your turn" below has you run Clippy. The `macvmm` crate forbids `unsafe` outright: its `main.rs` declares `#![forbid(unsafe_code)]` at the top. [The Rustonomicon's FFI chapter](https://doc.rust-lang.org/nomicon/ffi.html) is the long version.

## Errors with names

Every function returns `hv_return_t`. Zero is success; anything else is the kernel's own error numbering, a 32-bit code whose top bits name the subsystem and whose low bits name the error. The header lists nine error codes besides `HV_SUCCESS`. It writes them as unsigned hex, and `0xfae94007` does not fit a positive `i32`, so we reinterpret the bits with `as i32`; read as a signed `int`, `HV_DENIED` is `-85377017`. Add them to `ffi.rs`:

:::code anchor=ffi_return_codes file=crates/hvf/src/ffi.rs

> **Aside.** The numbering is Mach's, the oldest layer of the macOS kernel: `hv_return_t` is a `mach_error_t`, built with the `err_local` and `err_sub` macros of `mach/error.h` (in the SDK, at `$(xcrun --show-sdk-path)/usr/include/mach/error.h`). For Hypervisor.framework that gives `0xfae94000 | n`. You never need to know more than "the subsystem prefix is `0xfae94`".

A VMM that prints `-85377017` teaches nobody anything. So in `learner/crates/hvf/src/error.rs`, the code becomes a named error. An unknown code is kept exactly, never collapsed into a generic one: a future macOS may add codes, and the exact value is what a bug report needs.

:::code anchor=hv_error_enum file=crates/hvf/src/error.rs

Next, the conversion, and `check`, which turns a call's result into a `Result<(), CallError>`. A **`CallError`** pairs the C function's name with the decoded `HvError`, so a failure remembers which call failed:

:::code anchor=hv_error_from_code file=crates/hvf/src/error.rs

`Display` prints the name and the exact code, so a log line is searchable by either. Write `name()` and `code()` as two `match` expressions over the variants, the reverse of `from_code`:

:::code anchor=hv_error_display file=crates/hvf/src/error.rs

Last, the `CallError` struct itself, whose `Display` reads `hv_vm_create: HV_DENIED (0xfae94007)`:

:::code anchor=call_error file=crates/hvf/src/error.rs

The checkpoint's contract tests check exactly this: the nine codes against the header, the names, the round trip, and unknown codes kept.

## One VM per process, as a value

Look back at the header: `hv_vm_create` makes "a VM instance for the current process", and `hv_vm_destroy` takes no argument at all. There is no handle, because HVF keeps the VM as state of the whole process, and allows exactly one. That is surprising if you expected an object you could make many of, and it shapes everything after: one VMM process per VM.

We model it with a value, `Vm`, that destroys the VM when it is dropped. Your `Vm` in `learner/crates/hvf/src/vm.rs` is a struct with one private field of type `()`, so nobody outside the module can make one, and two methods. `Vm::new()` calls `hv_vm_create` through `check`, returning `Result<Vm, CallError>`. The reference passes a configuration object it built:

:::code anchor=vm_create_call file=crates/hvf/src/vm.rs

Yours passes a null pointer, `core::ptr::null_mut()`, for the default configuration, so its `SAFETY:` comment states a different invariant: NULL is allowed because the parameter is `_Nullable` (the header says to pass NULL for the default), and the framework keeps no pointer of ours.

Then `impl Drop for Vm`. Rust calls a type's `drop` method automatically when a value goes out of scope. The reference's `Drop` hands the work to a `destroy_inner` that also retires some bookkeeping for the interrupt controller of chapter 12:

:::code anchor=vm_drop file=crates/hvf/src/vm.rs

Inside `destroy_inner` is the call itself, with its invariant written down:

:::code anchor=vm_destroy_unsafe file=crates/hvf/src/vm.rs

Your `drop` makes the same call in an `unsafe` block, as `let _ = unsafe { ffi::hv_vm_destroy() };` (a `drop` cannot return an error). Its `SAFETY:` comment says that this value stands for the live VM, which has no vCPUs yet, and that only `Vm::new` makes one, so it is destroyed exactly once.

The pattern has a name: [**RAII**](/build-your-own/vmm/glossary/#raii) (resource acquisition is initialization). Owning the value means owning the VM; an early return or a `?` cannot leak it. Finish `lib.rs` by re-exporting what the doctor uses: `pub use error::{CallError, HvError, check};` and `pub use vm::Vm;`.

## The doctor

Your `macvmm doctor` does two checks, in a new file, `learner/crates/macvmm/src/doctor.rs`. Its output is a contract the checkpoint reads, so here it is in full before any code:

- Standard output first prints the header `macvmm doctor`.
- Check one creates a VM and lets it drop. On success, stdout prints `hv_vm_create: OK`. On failure, stdout prints `hv_vm_create: FAILED (<HvError>)` and standard error prints the `CallError` (which contains `HV_DENIED (0xfae94007)`). If the error is `HvError::Denied`, a hint line on stderr must name `scripts/sign-and-run.sh`, the fix.
- Check two creates and drops a VM a hundred times. Stdout prints `vm create/destroy x100: OK`, or `vm create/destroy x100: FAILED at round N` with the `CallError` on stderr.
- Last, a `run` function prints `DOCTOR OK` and returns `ExitCode::SUCCESS`, or prints `DOCTOR FAILED` on stderr and returns `ExitCode::from(1)`. On a failure, stdout must not contain `DOCTOR OK`; on success, it must not contain `FAILED`.

Here is the reference's check one. In it, `out` and `err` are `println!` and `eprintln!`, and `d.fail(a, b)` records a problem, prints `a` to stdout and `b` to stderr. `hvf::VmBuilder::new().create()` is the reference's constructor and `vm.destroy()` its explicit destroy; you call `Vm::new()` and let the value drop:

:::code anchor=doctor_vm_create file=crates/macvmm/src/doctor.rs

Check two does it a hundred times. If dropping did not really release the VM, the next create would be refused (the Try it below asks you exactly when). The reference destroys explicitly with `vm.destroy()`; yours relies on `Drop`:

:::code anchor=doctor_create_destroy file=crates/macvmm/src/doctor.rs

Now wire it into `learner/crates/macvmm/src/main.rs`. The reference has a fuller argument parser (its `args.log` and `usage_error` come from there):

:::code anchor=main_doctor file=crates/macvmm/src/main.rs

Yours needs only `mod doctor;` near the top, and in `main` a match on `std::env::args().nth(1).as_deref()`, where `Some("doctor")` returns `doctor::run()` and anything else keeps the scaffold's usage message and exit code 2.

Run it from inside `learner/`:

```sh
cd learner
cargo run -q -p macvmm -- doctor
```

Our run of a workspace written by following this page:

:::term source=captures/01-minimal-doctor.txt

Now go back and run your Predict. The signing scripts live at the repository root, so step out of `learner/` first:

```sh
cd ..
scripts/sign.sh --no-entitlements target/learner/debug/macvmm
target/learner/debug/macvmm doctor
```

Ours:

:::term source=captures/01-learner-denied.txt

Record what you saw in your journal.

## Breaking it on purpose

**Deliberate breakage 2: a second VM in the same process.** In your `check_vm_create`, right after the first `Vm::new()` succeeds and while that value is still alive, call `Vm::new()` again and print the result; then drop the first and call it a third time.

:::predict Does the second `Vm::new()` succeed, fail cleanly, or crash? And the third, after the first is dropped?
Write your guesses down, then run the doctor from inside `learner/`.
:::

:::term source=captures/01-second-vm.txt

`HV_BUSY (0xfae94002)` for the second, success for the third. What you saw: the framework refuses a second VM while one exists, and allows a new one once the first is gone. The misconception it exposes: "a VM is an object; make as many as you like". The tool that finds it: `HvError`'s `Display`, which names the code instead of printing a negative number. The third line is the important one: `Drop` is what makes the next create work. Undo the change before you go on (`git diff` in `learner/` shows it).

> **Production note.** The reference does not rely on the framework's refusal, which the header does not promise. A process-wide flag refuses a second `Vm` first, with the same error, so the one-VM rule holds even if a future macOS behaves differently, and the rest of the crate can trust that at most one `Vm` exists:

:::code anchor=vm_singleton file=crates/hvf/src/vm.rs

> **Try it.** Delete your `impl Drop for Vm` and run the doctor again. Before you look: at which round does the hundred-times loop fail? Undo the change afterwards (`git diff` in `learner/` shows it).

:::term source=captures/01-no-drop.txt

Round 1. The first check's `Vm` was dropped without destroying anything, so the VM it made is still alive when the loop starts, and every later create is refused. A leak that would go unnoticed in most programs is fatal here, because the resource is one per process.

> **Security.** The entitlement is a permission, not a fence. It lets our process program the CPU's virtualization state and hand its own memory to a guest, and from chapter 02 on the guest will send us numbers of its choosing. Nothing about the entitlement limits what a bug in our VMM can then do with our process's rights. That is why `unsafe` stays in one crate, every block states its invariant, and the plist holds exactly one key.

## Your turn

If you typed along (typing, not pasting, is where the questions come from), your workspace holds the FFI, `HvError`, `Vm` and the doctor. Before the checkpoint, check, from inside `learner/`:

1. `cargo run -q -p macvmm -- doctor` prints `hv_vm_create: OK`, `vm create/destroy x100: OK` and `DOCTOR OK`.
2. Your unsigned run printed `HV_DENIED (0xfae94007)` and a hint naming `scripts/sign-and-run.sh` on stderr, and your journal records your guess and what you saw.
3. `cargo clippy -p hvf` reports no errors. Delete one `// SAFETY:` line, run it again and watch it fail with "unsafe block missing a safety comment"; then put the line back.

Stuck? `scripts/learner hint 01` gives four hints, from a nudge to the exact reference file.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (your `HV_*` constants against the header's values, every known code to its name and back, unknown codes kept, decoding that never panics). It runs your doctor through the signing runner and expects `hv_vm_create: OK`, `vm create/destroy x100: OK` and `DOCTOR OK`. It runs it again signed with no entitlements and expects `HV_DENIED (0xfae94007)` and `scripts/sign-and-run.sh` on stderr, with exit 1. Then it checks that every journal heading has an answer, and prints the ideas a strong answer contains.

Each line of the report names what it checked: `contract` lines are the tests on your `hvf` crate, `run` lines are runs of your doctor on your Mac, and `journal` is your journal. "Serial markers" is the harness's name for the expected lines it looks for in a program's output; here they come from the doctor's own output. Our run against a copy of the reference, where there is no journal to check:

:::term source=captures/01-checkpoint.txt

In your workspace the journal line instead reads `5/5 answered, predict recorded`, and the rubric follows it.

What now works:

- you can draw where our VMM sits: an EL0 process beside every other app, one of two supervisors;
- your `hvf` crate declares `hv_vm_create` and `hv_vm_destroy` from the header, links the framework, and names every error it can return;
- a `Vm` value owns the process's one VM and destroys it on drop, a hundred times running;
- your doctor tells a signed binary from an unsigned one.

The next chapter starts from this state (the reference at the end of chapter 01).

### What's next

You have a VM with nothing in it: no CPU, no memory. Chapter 02 gives it both, three instructions long, and runs them on your Mac's real CPU until the guest calls the level above. To understand what comes back, it first teaches what an exception is on Arm, and who catches it.

### Open question

Running code is something every process can already do. So why does macOS make you ask, in a signature, for permission to run code inside a VM? What could a process with this one entitlement do that an ordinary process cannot?

## Spec hunt

- The SDK header `hv_vm.h`: what does it say must have happened before `hv_vm_destroy` may be called, and which chapter's code will have to respect that?
- The SDK header `$(xcrun --show-sdk-path)/usr/include/arm64/hv/hv_kern_types.h`: how is `err_common_hypervisor` built? What full 32-bit code would a new `err_common_hypervisor | 0x09` be, and what would your `HvError` return for it?
- The Rust Reference, chapter "Unsafety": the Rust book counts five unsafe operations. Which does the Reference list, and which of them does an FFI declaration need?
