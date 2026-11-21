# Glossary

Every course term, in one plain line, with the chapter or primer that earns it. The site renders
this file at `/build-your-own/vmm/glossary/` (sorted alphabetically), and a lesson links a term's
first use on a page to `/build-your-own/vmm/glossary/#<anchor>`, where the anchor is the bold term
in lowercase with every run of other characters turned into one `-` (`VM exit` is `#vm-exit`,
`CPSR / PSTATE` is `#cpsr-pstate`).

Authors: add a term in the same change that first uses it, in the section of the chapter that
earns it (your own section only), as `- **Term** (expansion): one-line definition.` with the
expansion only for acronyms. A term earned in a primer goes under Primers and ends with
"Taught in `slug`." The format is in `course/STYLE.md` appendix A; `scripts/check-lessons` checks it.

## Primers

- **AArch64**: The 64-bit instruction set of Arm CPUs, the one your Mac runs. Taught in `aarch64-reading`.
- **ad-hoc signature**: A code signature made on your own Mac without an Apple certificate; enough to carry an entitlement for local use. Taught in `codesign-entitlements`.
- **BSS**: The part of a program's memory for variables that start at zero; the file holds no bytes for it, so start-up code must zero it. Taught in `bare-metal-rust`.
- **entitlement**: A permission written into a program's signature; ours is `com.apple.security.hypervisor`. Taught in `codesign-entitlements`.
- **exception**: On Arm, anything that makes the CPU stop the current flow and run a handler at the same or a higher level: a system call, a fault, an interrupt. Not the same as a Rust panic or a C++ exception. Taught in `os-basics`.
- **exception vector table**: A table of handler addresses the kernel sets up; the CPU jumps to the entry for the kind of exception. Its base is in `VBAR`. Taught in `os-basics`.
- **exit code**: The number a process returns to the shell when it ends. `macvmm`'s codes are on the reference card. Not a VM exit. Taught in `os-basics`.
- **fast call**: An SMCCC call that runs to completion without being interrupted part-way; all of ours are fast. Taught in `smccc`.
- **firmware**: The program a CPU runs first after power-on; it sets up the hardware, loads the kernel, and answers a few requests such as power-off. Taught in `os-basics`.
- **granule**: The page size a translation table uses: 4 KiB, 16 KiB or 64 KiB. Taught in `page-granules`.
- **linker script**: A file that tells the linker at which addresses to place each section of a program, such as `_start` at `0x4008_0000`. Taught in `bare-metal-rust`.
- **no_std**: A Rust crate attribute meaning "no standard library": no heap, no files, no threads, only `core`. Taught in `bare-metal-rust`.
- **RAZ/WI** (read as zero, writes ignored): A register behaviour from the Arm manual: reads give 0, writes do nothing. Taught in `reading-arm-specs`.
- **SMCCC** (SMC calling convention): Arm's rules for calls to higher levels: the function number in `x0`, arguments in `x1` onwards, results back in `x0`. Taught in `smccc`.
- **svc** (supervisor call): The instruction an app uses to ask its kernel for a service: Arm's system call. Taught in `os-basics`.
- **sysreg** (system register): A CPU control or ID register read with `mrs` and written with `msr`, named like `SCTLR_EL1`. Taught in `aarch64-reading`.
- **thread**: An independent flow of execution in a process, with its own registers. HVF ties each vCPU to the thread that created it. Taught in `host-concurrency`.

## Chapter 00

- **binary translation**: Rewriting a guest's machine code just before it runs, so the instructions that would misbehave become traps or calls.
- **emulated device**: A device the VMM imitates register by register, so an unmodified guest driver works; every register access traps to the VMM.
- **emulator**: A program that pretends to be a CPU, carrying out each guest instruction in software. Correct, but slow.
- **guest**: The operating system (or test program) running inside a virtual machine.
- **hardware-assisted virtualization**: CPU support for a level above the kernel whose software chooses what traps, so a guest kernel can run in a real kernel mode at full speed.
- **host**: The real machine's operating system, here macOS.
- **hypercall**: A deliberate call from a guest kernel to the VMM, asking for a service, the way a system call asks a kernel.
- **hypervisor**: In this course, the part that runs at a CPU level more privileged than the kernel's (on Arm, EL2) and controls the CPU's support for virtual machines (on a Mac, part of macOS). Elsewhere, often used to mean the whole VMM.
- **paravirtual device**: A device designed for virtual machines, which guest and VMM drive through shared memory instead of trapping on every register; virtio is the standard one.
- **paravirtualization**: Changing the guest so it asks the VMM directly instead of touching hardware.
- **Popek and Goldberg's condition**: Trap-and-emulate works if every instruction that touches what the VMM must control traps when run unprivileged (Popek and Goldberg, 1974, Theorem 1).
- **privileged instruction**: One that traps when run in user mode and runs normally in kernel mode.
- **problem ledger**: The course's list of everything a guest kernel needs from a machine (a CPU, memory, devices, interrupts, time and more); each chapter closes one row.
- **sensitive instruction**: One that reads or changes machine state the VMM must control.
- **shadow page table**: A real page table the VMM keeps for a guest, mapping its addresses straight to host memory, kept in step by write-protecting the guest's own tables so its writes to them fault into the VMM; replaced by a second hardware translation stage.
- **trap**: The hardware stopping an instruction and handing control to a more privileged level.
- **trap-and-emulate**: Run the guest unprivileged; when it does something privileged, it traps; the VMM emulates the effect and resumes it.
- **VM** (virtual machine): The illusion of a whole computer, made for a guest.
- **VMM** (virtual machine monitor): The program that builds and runs the virtual machine around a guest; ours is `macvmm`.

## Chapter 01

- **FFI** (foreign function interface): Calling functions written in another language, here C functions in Apple's framework from Rust, by declaring their exact types.
- **HVF** (Hypervisor.framework): Apple's library that lets an ordinary process create VMs and run vCPUs; it makes system calls into the part of macOS that runs at EL2.
- **out-pointer**: A pointer a C function writes its result through, because its return value is already used for the error code.
- **repr(C)**: A Rust attribute that lays a struct out exactly as C would (same order, same padding), so it can be shared with C code.
- **unsafe Rust**: Five extra operations (such as calling C or dereferencing a raw pointer) that the compiler cannot check; it does not switch the other checks off, and the invariants become yours.
- **VZ** (Virtualization.framework): Apple's ready-made virtual machine, configured rather than built; used in chapter 23.
- **hv_return_t**: The 32-bit result of every Hypervisor.framework call: 0 for success, otherwise an error code of the form `0xfae94000 | n`, such as `HV_DENIED` (`0xfae94007`).
- **RAII** (resource acquisition is initialization): Tying a resource to a value, so creating the value acquires it and dropping the value releases it; our `Vm` destroys the VM in `Drop`.
- **two supervisors**: On a Mac, the macOS kernel's EL2 part decides what leaves the guest, and our VMM, an ordinary process, decides what to do with what it is handed.
- **type 1 / type 2 hypervisor**: An old classification: type 1 runs on the bare machine, type 2 as a program on another operating system. Modern systems blur it; this course asks instead who owns the most privileged level.
- **XNU**: The name of the macOS kernel. Part of it runs at EL2 and supervises our guests.
- **SDK** (software development kit): The headers and libraries Xcode installs for building macOS programs; `xcrun --show-sdk-path` prints where, and Hypervisor.framework's C headers live inside it.
- **reference implementation**: The course's finished VMM, in this repository's `crates/`. Every code block in a lesson is taken from it; your own code lives in `learner/`.

## Chapter 02

- **CPSR / PSTATE** (current program status register / processor state): The CPU's current mode and flags: which exception level, which stack pointer, which interrupts are masked.
- **DAIF**: Four mask bits in PSTATE (debug, SError, IRQ, FIQ) that stop those kinds of asynchronous exception from interrupting.
- **EC** (exception class): The top six bits of an ESR: the kind of exception, for example `0x16` for an `hvc`.
- **EL0, EL1, EL2, EL3** (exception levels): Arm's privilege levels: EL0 apps, EL1 a kernel, EL2 the level that supervises kernels, EL3 firmware. Higher number, more power.
- **EL1h**: Running at EL1 using EL1's own stack pointer (`SP_EL1`); the usual mode of a kernel.
- **ELR** (exception link register): Where the CPU will return to after an exception; the saved PC.
- **ESR** (exception syndrome register): The register that records *why* an exception happened.
- **FAR** (fault address register): The address a faulting access tried to use.
- **hvc** (hypervisor call): An instruction a guest kernel uses to call the level above it; the `svc` of EL1.
- **IL** (instruction length): Bit 25 of an ESR: 1 when the instruction that caused the exception is 32 bits long, which on AArch64 is always.
- **ISS** (instruction specific syndrome): The lower 25 bits of an ESR; their meaning depends on the EC.
- **preferred return address**: Where the PC goes after an exception: after a call that executed (`svc`, `hvc`); at a fault, so it is retried; and at an instruction the level above intercepted before it executed, such as a trapped `smc`.
- **routing**: The rule that decides which exception level takes an exception, and so whose vector table runs: the guest kernel at EL1, or the level above it.
- **smc** (secure monitor call): An instruction that calls the firmware at EL3. Apple's chips have no EL3; the level above intercepts every guest `smc` before it executes, so it reaches our VMM as a VM exit with the saved PC still pointing at the `smc`.
- **SPSR** (saved program status register): The mode and flags to restore when returning from an exception.
- **synchronous / asynchronous exception**: Caused by the instruction being run (a call, a fault) / caused by something outside it (a timer, an interrupt).
- **syndrome**: The note the hardware writes about an exception: the ESR and, for faults, the addresses.
- **VBAR** (vector base address register): Holds the address of an exception vector table.
- **vCPU** (virtual CPU): One guest CPU; HVF runs it on a host thread when we call `hv_vcpu_run`.
- **VM exit**: The moment the guest stops and our VMM runs, because the guest did something HVF forwards to us. Not an exit code.
- **ERET** (exception return): The instruction that ends an exception handler: the PC is set from `ELR` and the mode and flags from `SPSR`.
- **exit reason**: The first field of HVF's exit record, saying why `hv_vcpu_run` returned: a guest exception (with its syndrome), the virtual timer, a cancel from another thread, or unknown.

## Chapter 03

- **bare-metal program**: A program that runs with no operating system under it: it sets up its own stack and zeroed memory, then calls its main function.
- **debug hypercall**: One of the two calls our test guests make with `hvc` to print a byte or to stop with an exit code; numbered by SMCCC as vendor-specific hypervisor calls.
- **exit trace**: A file with one line per VM exit (time, PC, exception class), written by `macvmm --trace`, so you can count and read a guest's exits.
- **flat binary**: Raw machine code and data copied byte for byte into guest memory, with no headers; what `objcopy` makes from an ELF file.
- **address size fault**: The fault a CPU raises when an address is too large for the memory it can address; with the guest's translation off, it is taken at the guest's own level and never reaches the VMM.
- **exit cost**: The time one VM exit takes, guest to VMM and back; about 1.5 µs on our Mac, thousands of times the cost of one store instruction.
- **monitor**: Our name, from chapter 03 on, for the VMM program we write (`crates/`, an ordinary macOS program), as opposed to the guest it runs.
- **run loop**: The VMM's loop around `hv_vcpu_run`: run the vCPU, decode the exit, handle it, then resume or stop.
- **world switch**: The round trip of one VM exit: the CPU leaves the guest, the hypervisor saves the guest's state and runs the VMM, then restores the guest and enters it again.
- **entry point**: The address of a program's first instruction; for flat binaries loaded with `--raw`, the load address of the first one, since the file has no header to name it.

## Chapter 04

- **volatile access**: A memory access the compiler must perform exactly as written; it gives no atomicity and no ordering with other threads.
- **checked arithmetic**: Arithmetic that reports overflow instead of hiding it; in Rust, `checked_add` returns `None` when the true sum does not fit, so a bounds check cannot be fooled by a sum that wrapped.
- **copy-only access**: The rule that our VMM reaches guest RAM only by copying bytes into and out of its own buffers, never through a reference into guest memory.
- **guest RAM**: Host memory our VMM allocates and maps into the guest's address space; the guest and our VMM see the same bytes.
- **GuestMemory**: The fixed set of calls (`read`, `write`, `check_range`, little-endian helpers, `read_obj`) through which every part of our VMM touches guest RAM, each one bounds-checked.
- **host page**: The Mac's own memory page, 16 KiB on Apple silicon; HVF's stage-2 mappings come in whole, aligned host pages.
- **integer overflow**: A sum or product too large for its type; in wrapping arithmetic it silently becomes a small number, which is how `addr + len` can pass a bounds check it should fail.
- **region table**: Our VMM's list of guest RAM regions, each checked for size, 16 KiB alignment, overflow and overlap; every access must lie inside one region.

## Chapter 05

- **data abort**: The exception a load or store takes when its address cannot be accessed; for a guest, often a VM exit at a stage-2 hole.
- **DFSC** (data fault status code): Low bits of the syndrome that say which kind of data fault happened (for example translation fault).
- **HPFAR_EL2** (hypervisor IPA fault address register): Holds the page number of the guest-physical address (IPA) of a stage-2 fault; with the offset from `FAR_EL2`, it gives the VMM the IPA without reading the guest's page tables.
- **instruction abort**: The exception taken when the CPU cannot fetch the next instruction from its address.
- **IPA** (intermediate physical address): The address a guest believes is physical; stage 2 translates it to real host memory.
- **MMIO** (memory-mapped I/O): Talking to a device by loading and storing at its addresses, where each access has side effects.
- **stage 1, stage 2**: The guest's own page tables (virtual to IPA), then HVF's tables (IPA to host memory).
- **stage-2 hole**: A guest-physical range we deliberately leave unmapped, so every access becomes a VM exit we can answer as a device.
- **translation fault**: The fault a translation table walk raises when it finds no valid entry, or when the address is outside the range the tables cover; its DFSC also says at which level the walk stopped.
- **IPA size**: The number of address bits a VM's stage-2 tables accept: with *n* bits the guest can reach IPAs from 0 up to, but not including, 2 to the power *n*; set with `hv_vm_config_set_ipa_size`.
- **unhandled-MMIO policy**: What our VMM does when the guest touches an address no RAM and no device claims: stop the VM (`fatal`, exit code 3) or read as zero and ignore writes (`log`).
- **virtio slot**: One of 32 reserved MMIO windows of `0x200` bytes from `0x0a00_0000`, each for one paravirtual (virtio) device; slot *i* uses INTID 48 + *i*.

## Chapter 06

- **affinity**: The fields of `MPIDR_EL1` that give a CPU's address in a hierarchy: `Aff0` numbers CPUs within a cluster, `Aff1` numbers clusters.
- **alignment fault**: The exception a load or store takes when its address is not a multiple of its size and the CPU checks alignment (`SCTLR_EL1.A = 1`, or Device memory).
- **EL1t**: Running at EL1 but using EL0's stack pointer (`SP_EL0`); PSTATE `0x3c4` with all masks set. Exceptions taken to EL1 still switch to `SP_EL1`.
- **MPIDR_EL1** (multiprocessor affinity register): A CPU's own identity number, which an OS uses to tell its CPUs apart; vCPU 0's is `0x8000_0000`.
- **register dump**: A snapshot of a vCPU's registers printed when the guest stops for good, in the order a reader asks: where it was, what it computed, which exception it took first.
- **RES0 / RES1** (reserved, zero / reserved, one): Arm's marks for register bits with no function that must read as 0 or as 1; bit 31 of `MPIDR_EL1` is RES1.
- **reset state**: The register values a CPU has at power-on; not the same as a *system reset* the guest asks for through PSCI.
- **SCTLR_EL1** (system control register, EL1): The switches a kernel flips as it starts: M turns stage-1 translation on, C and I the caches, A alignment checking.
- **SPSel** (stack pointer select): Bit 0 of PSTATE's mode field: 0 means code at EL1 uses `SP_EL0` (EL1t), 1 means it uses its own `SP_EL1` (EL1h).

## Chapter 07

- **ISV** (instruction syndrome valid): A bit that says whether the hardware described a faulting load or store for us (size, register, direction).
- **SAS** (syndrome access size): Two bits of a data-abort syndrome giving the access size as a power of two: 0 is 1 byte, 3 is 8 bytes.
- **SRT** (syndrome register transfer): Five bits of a data-abort syndrome naming the register loaded or stored; 31 means `xzr`, never `sp`.
- **SSE** (syndrome sign extend): A data-abort syndrome bit that says a load must be sign-extended into its register.
- **SF** (sixty-four-bit flag): A data-abort syndrome bit that says the register is a 64-bit `x` register, not a 32-bit `w` register.
- **WnR** (write not read): A data-abort syndrome bit that is 1 for a store and 0 for a load.
- **PC-advance table**: The rule, per kind of VM exit, for whether the VMM moves the guest's PC past the instruction before running it again.
- **exit ring**: A small per-vCPU memory of the last 256 VM exits, printed when the guest stops with a fatal error.
- **test device**: A device with 512 scratch registers at `0x0b00_0000` (`--testdev`) that returns what was last written, so any surprise is the decoder's fault.

## Chapter 08

- **injection** (of an exception): Our VMM doing by hand what the hardware would have done to deliver an exception to the guest.
- **PSCI** (power state coordination interface): A standard set of calls a kernel uses to power off, reset or start CPUs.
- **UNDEF / UNDEFINED**: The exception real hardware raises for an instruction or register it does not have.
- **conduit**: The instruction that carries an SMCCC call to the level above: `hvc` (to EL2) or `smc` (to EL3). Under HVF both reach our VMM, with different PC rules.
- **function ID**: The 32-bit number in `w0` that names an SMCCC call, with fields for fast or yielding, 32- or 64-bit convention, owner and function number.
- **ID register**: A read-only system register, such as `ID_AA64DFR0_EL1`, that tells software which features the CPU has.
- **NOT_SUPPORTED**: The SMCCC and PSCI return value -1 (all ones in `x0`): "no such function here".
- **OS lock**: A debug bit an operating system sets while it saves or restores debug registers, so that an external debugger cannot interfere; written through `OSLAR_EL1`, read back in `OSLSR_EL1`. It is set at cold reset and Linux clears it early in boot. Our VMM emulates it.
- **policy table**: Our VMM's list of what to do with each system register that traps (emulate, read as zero, or inject UNDEF), with a reason per row.
- **system reset**: A restart of the whole machine that the guest asks for with PSCI `SYSTEM_RESET`; not the reset state of one CPU.
- **trap-control register**: A register at EL2, such as `HCR_EL2` or `MDCR_EL2`, whose bits decide which guest actions trap; HVF owns them, so what traps is measured.
- **vector offset**: The distance from `VBAR_EL1` to the handler entry the CPU jumps to, chosen by where the exception came from and by its kind (synchronous, IRQ, FIQ or SError).
- **PAN** (privileged access never): A PSTATE bit that stops EL1 code from touching EL0's memory by accident; exception entry to EL1 sets it unless `SCTLR_EL1.SPAN` is 1, so an injected exception must set it too.
- **PMU** (performance monitoring unit): The CPU's performance counters, controlled through registers such as `PMCR_EL0`; `ID_AA64DFR0_EL1.PMUVer` says whether one exists.

## Chapter 09

- **FIFO** (first in, first out): A small queue inside a device; bytes leave in the order they arrived. The PL011's receive FIFO holds 32 bytes.
- **interrupt line**: The object a device drives to say it wants attention: one method, `set_level`, held high while the device's masked status is non-zero. Connected to nothing until chapter 12 wires it to the interrupt controller.
- **MMIO bus**: The VMM's table from guest-physical address ranges to emulated devices: it decides which device answers an access, and refuses overlapping ranges.
- **output filter**: The code that removes dangerous escape sequences from guest output before the bytes reach your terminal or a file.
- **PL011**: Arm's PrimeCell UART, the serial port at `0x0900_0000` on our machine and on QEMU's `virt` machine.
- **PL031**: Arm's PrimeCell real-time clock at `0x0901_0000`; its data register gives seconds since 1 January 1970.
- **RTC** (real-time clock): A device that knows the date and time, not only how much time has passed.
- **side-effecting read**: A register read that changes the device, such as a read of the PL011's data register, which removes the byte it returns.
- **sink**: Where guest output goes: an output filter, then a destination (stdout, a file, or nothing), chosen with `--serial`.
- **stop flag**: A shared boolean (an atomic) that any thread sets to ask the VM to stop; each vCPU thread checks it before entering the guest again.
- **TRM** (technical reference manual): Arm's datasheet for one device, such as ARM DDI 0183 for the PL011.
- **UART** (universal asynchronous receiver-transmitter): The simplest serial port: write a byte to send it, read to receive. Ours is the PL011.
- **Weak** (weak reference): A Rust `Arc` that does not keep its value alive; `upgrade()` gives `None` once the last strong `Arc` is gone. Used to break reference cycles.

## Chapter 10

- **#address-cells / #size-cells**: Two properties of a device-tree node that say how many cells each address and each size in its children's `reg` takes.
- **binding document**: A short schema, one per kind of device, kept in the Linux source tree, that says what each device-tree property of that device means. Not the same as driver binding.
- **bootargs**: The property of `/chosen` that holds the kernel command line, such as `console=ttyAMA0`.
- **cell**: The unit device-tree numbers are counted in: one 32-bit big-endian value. A 64-bit address takes two.
- **/chosen**: The device-tree node that describes no device: it carries settings for the operating system, such as its console (`stdout-path`) and command line (`bootargs`).
- **compatible**: The device-tree property that names what a device is, most specific first, such as `"arm,pl011", "arm,primecell"`; a kernel picks a driver by matching it.
- **Device Tree** (DT): A tree of nodes and properties that describes a machine's memory, CPUs and devices to the operating system that runs on it.
- **driver binding**: The kernel attaching a driver to a device-tree node whose `compatible` string the driver lists.
- **DTB** (device tree blob): The binary form of a Device Tree that firmware or a VMM hands to a kernel; on arm64 its address arrives in `x0`.
- **dtc** (device tree compiler): The standard tool that converts between a DTB and its text form; we use it as an independent checker.
- **DTS** (device tree source): The text form of a Device Tree, as `dtc` prints it.
- **FDT** (flattened device tree): The binary format of a DTB: a header, a memory reservation map, a structure block of tokens and a strings block, all big-endian.
- **device-tree node**: One entry of a Device Tree, named like `pl011@9000000`, holding properties and child nodes.
- **phandle**: A number given to a device-tree node so that other nodes can refer to it, as the PL011's `clocks` property refers to the fixed clock.
- **probe**: To find hardware by asking for it, such as reading a bus's list of devices; Arm platform devices cannot be found that way, so they are described instead. Linux also says a driver "probes" a device when it attaches to a node it was told about; that is driver binding, not discovery.
- **device-tree property**: A named value inside a node, such as `reg` or `compatible`; its bytes mean whatever the binding for that name says.
- **reg**: The device-tree property that lists a device's address ranges as (address, size) pairs of cells.
- **unit address**: The part of a node name after the `@`, which must equal the first address in its `reg`.
- **big-endian**: Storing a multi-byte number most significant byte first; every number in a DTB is stored this way, the opposite of AArch64's usual little-endian order.
- **memory reservation map**: The part of a DTB after the header that lists RAM ranges the kernel must not use, as (address, size) pairs ending with (0, 0).
- **structure block**: The part of a DTB that holds the tree itself, written depth first as tokens: begin node, property, end node, end.
- **strings block**: The part of a DTB that holds every property name once; each property points into it by offset.

## Chapter 11

- **assert**: For an interrupt line, to drive it high: the source is asking for attention now. A level-triggered source keeps asserting its line until its cause is removed.
- **CNTFRQ_EL0** (counter-timer frequency): The register that tells a guest how fast its counter ticks, in Hz; 24,000,000 under Hypervisor.framework.
- **CNTV_CTL_EL0** (counter-timer virtual timer control): The virtual timer's control bits: `ENABLE`, `IMASK` (mask its interrupt) and the read-only `ISTATUS` (the count has reached the compare value).
- **CNTV_CVAL_EL0** (counter-timer virtual timer compare value): The virtual timer's alarm: the count at which it raises its interrupt.
- **CNTVCT_EL0** (counter-timer virtual count): The count a guest reads for time; under Hypervisor.framework it is the host's tick count minus the VM's counter offset, at 24 MHz as Hypervisor.framework presents it.
- **counter offset**: The number Hypervisor.framework subtracts from the host's tick count to make a vCPU's virtual counter; a VMM sets it so the guest's counter starts near zero and is the same on every vCPU.
- **edge-triggered**: An interrupt signalled by a change, a one-off event; if nobody is listening and nothing latches it, it is lost.
- **FIQ** (fast interrupt request): Arm's second kind of interrupt, with its own PSTATE mask bit (F) and its own vector entries; the kernels in this course use IRQ.
- **interrupt controller**: The device between interrupt sources and CPUs: it collects every source's line, ranks them and delivers one interrupt at a time to a chosen CPU. Arm's is the GIC.
- **generic timer**: Arm's per-core counter and alarm: a count that rises at a fixed rate, a compare value and control bits that raise an interrupt when the count reaches it.
- **IRQ** (interrupt request): The ordinary kind of interrupt on Arm; the CPU takes it through the IRQ entry of its vector table when the I bit of PSTATE is clear.
- **interrupt storm**: An interrupt that is delivered again as soon as its handler ends, because its cause was never removed, so the CPU makes no other progress.
- **latch**: A bit that remembers an event until someone clears it, so an edge is not lost while nobody listens; the PL011's `RIS` is one.
- **level-triggered**: An interrupt line that stays raised as long as its cause holds; it cannot be lost while masked, and it drops only when the cause is removed.
- **pending interrupt**: One raised by its source but not yet taken by the CPU; it waits as state while the CPU has interrupts masked.
- **spin lock**: A lock that a waiting core polls in a loop instead of sleeping; Arm cores often pause in `WFE` between polls.
- **vtimer**: Hypervisor.framework's name for a guest's virtual timer; with no interrupt controller its firing reaches the VMM as a `VTIMER_ACTIVATED` exit.
- **vtimer mask**: Hypervisor.framework's own mask on the vtimer, set by the framework at each `VTIMER_ACTIVATED` exit and cleared only by the VMM (`hv_vcpu_set_vtimer_mask`); not the guest's `IMASK`.
- **WFE** (wait for event): An instruction that idles a CPU until an event from another CPU or an interrupt; used inside spin locks.
- **WFI** (wait for interrupt): An instruction that idles a CPU until an interrupt or another wake-up arrives; it may also end early, so code re-checks its condition after it.

## Chapter 12

- **active interrupt**: One the CPU has acknowledged (read from the IAR) and not yet ended with an EOI; while active it is not delivered again. *Active and pending* means it is being handled and its source is asking again.
- **affinity routing**: The GICv3 rule that names a CPU by its `MPIDR_EL1` affinity number; a shared interrupt is sent to the CPU whose affinity is written in its routing register.
- **CPU interface**: The part of the GIC inside each CPU, used through `ICC_*` system registers: it masks by priority, hands the CPU the next interrupt (IAR) and takes the end-of-interrupt (EOI).
- **distributor**: The one GIC block shared by all CPUs; it holds the settings of every shared interrupt (enabled, priority, trigger, target CPU). Its registers are named `GICD_*`.
- **EOI** (end of interrupt): The write (`ICC_EOIR1_EL1`) with which a handler tells the GIC it has finished an interrupt; a level line still high at that moment makes the interrupt pending again.
- **GIC** (Generic Interrupt Controller): Arm's interrupt controller. It gathers many interrupt lines, ranks them by priority and delivers each to a chosen CPU; we use version 3, which Hypervisor.framework emulates in the kernel.
- **GicSpi**: Our `IrqLine` connected to one SPI of the in-kernel GIC; it refuses an INTID that is not an SPI, and passes each level change to `hv_gic_set_spi`.
- **IAR** (interrupt acknowledge register): The register (`ICC_IAR1_EL1`) a handler reads first; it returns the INTID of the most urgent pending interrupt and marks it active, or 1023 if there is none.
- **in-kernel GIC**: Hypervisor.framework's GICv3, emulated inside the macOS kernel: guest accesses to it, the timer's interrupts and WFI never exit to the VMM, which only raises and lowers SPI lines.
- **interrupt-parent**: The device-tree property that names, by phandle, the interrupt controller a node's `interrupts` refer to; set once at the root, it applies to every node below.
- **interrupt specifier**: The cells of a device tree `interrupts` property; for a GICv3, three cells: the kind (0 SPI, 1 PPI), the number within that kind, and the trigger (4 is level-high).
- **INTID**: The number that names an interrupt line in Arm's interrupt controller: 0 to 15 SGIs, 16 to 31 PPIs, 32 to 1019 SPIs, 1023 for "nothing pending".
- **IrqLine**: Our devices' one-method interface to an interrupt line, `set_level(high)`; the machine decides what the line is connected to (the GIC, nothing, or a test recorder).
- **LPI** (locality-specific peripheral interrupt): A GICv3 interrupt, INTID 8192 and up, sent as a message written to memory instead of on a wire; used for message-signalled interrupts. Our board has none.
- **MSI** (message-signalled interrupt): An interrupt a device raises by writing a value to an address instead of driving a line; our board reserves INTIDs 80 to 143 for them.
- **PPI** (private peripheral interrupt): An interrupt that belongs to one CPU, such as its own timer; INTIDs 16 to 31, configured in that CPU's redistributor.
- **priority mask**: The CPU interface's threshold (`ICC_PMR_EL1`): only interrupts more urgent than it, that is with a lower priority number, reach the CPU; `0xff` lets every priority through.
- **redistributor**: The per-CPU GIC block that holds that CPU's private interrupts (SGIs and PPIs) and forwards interrupts to it; 128 KiB per vCPU here, named `GICR_*`.
- **SGI** (software-generated interrupt): An interrupt one CPU sends to another by writing a register; INTIDs 0 to 15, used by kernels to wake or signal other CPUs.
- **SPI** (shared peripheral interrupt): An interrupt from a device that any CPU could take; INTIDs 32 to 1019, configured in the distributor. Device tree SPI *n* is INTID 32 + *n*.
- **spurious interrupt**: What the IAR reports (INTID 1023) when the CPU asks for an interrupt and none is pending any more; the handler returns without an EOI.

## Chapter 13

- **arm64 Image**: The flat-binary form of a Linux kernel for 64-bit Arm; its first 64 bytes are a header that tells the loader where the kernel must sit and how much memory it uses.
- **boot plan**: The printed, testable list of where every boot input goes in guest RAM and which register values the vCPU starts with; ours is `BootPlan`, shown by `--dry-run`.
- **EFI stub**: Code built into a Linux kernel that lets UEFI firmware start it directly as a UEFI program; it is why an arm64 Image begins with the bytes `MZ`.
- **EFI zboot**: A wrapper around a compressed Linux kernel: a small UEFI program (its file starts with `MZ`, with `zimg` at offset 4) that decompresses the real Image and jumps to it. Our VMM refuses it by name; `cargo xtask unzboot` unwraps it on the host.
- **entry state**: The registers and CPU mode a kernel may rely on at its first instruction; for Linux on 64-bit Arm, section 4 of `booting.rst`.
- **initramfs**: A cpio archive of files, such as `/init`, that the kernel unpacks into memory and uses as its first file system, before it has a disk driver; the VMM places it in RAM and names its range in `/chosen`.
- **image_size**: The Image header field at offset `0x10`: how many bytes of memory, from its first byte, the kernel uses, including the zeroed BSS the file need not carry.
- **kernel command line**: The text a kernel reads at boot to set options such as `console=`; our VMM passes it in the device tree's `/chosen` node.
- **loader**: The code that copies a kernel and its companions into memory and starts it; in a VMM, the VMM itself.
- **property-based test**: A test that checks a rule over many generated inputs, from a fixed seed so a failure can be replayed, instead of over a few written examples.
- **sha256 pinning**: Recording a file's SHA-256 hash once, committing it, and refusing any later download whose hash differs.
- **text_offset**: The Image header field at offset `0x8`: how far above a 2 MiB-aligned base the kernel's first byte must sit; 0 for modern kernels.

## Chapter 14

- **boot log**: The lines a kernel prints while it starts, in stages that each depend on the one before; on Arm most of them report what the device tree told the kernel.
- **earlycon**: A Linux command-line option that makes the kernel write to a serial port by address from its first moments, before any console driver exists.
- **failure fingerprint**: What a broken part of the machine looks like from outside: the last boot stage reached, what the kernel says, and how the VMM exits.
- **KASLR** (kernel address space layout randomisation): Placing the kernel's code at a random address on each boot so an attacker cannot predict it; on arm64 the seed can come from `/chosen` in the device tree.
- **kernel panic**: A kernel's last resort: it prints why it cannot continue and stops, by default spinning forever unless told to reboot (`panic=`).
- **Oops**: Linux's report of a fault inside the kernel itself (the registers, the faulting address, a call trace); the kernel may survive one, or panic after it.
- **ring dump**: Printing every running vCPU's exit ring on request, with `Ctrl-A t` or SIGUSR1, while the guest keeps running.
- **trace category**: A filter on the exit trace (`mmio`, `hvc`, `sysreg`, `psci`, `cancel` or `all`) that keeps only the exits of that kind.

## Chapter 15

- **DMA** (direct memory access): A device reading or writing RAM by itself, without the CPU.
- **virtio**: A standard for paravirtual devices: the guest and the VMM share rings in memory instead of trapping on every register.
- **bus mastering**: A device reading and writing main memory by itself, without the CPU copying each byte; the hardware name for what DMA does.
- **ConfigGeneration**: A virtio-mmio register the device changes whenever its configuration changes; a driver reads it before and after reading config fields and retries if it moved.
- **DEVICE_NEEDS_RESET**: The virtio status bit (value 64) a device sets when the driver gave it something it cannot use, such as a ring outside RAM; the device does nothing more until the driver writes 0 to `Status`.
- **device status**: The virtio `Status` register: bits the driver sets one at a time (ACKNOWLEDGE, DRIVER, FEATURES_OK, DRIVER_OK) as it brings a device up, and clears all at once by writing 0.
- **doorbell**: A register a driver writes only to say "look now": one MMIO exit that tells the device new requests are waiting in memory. In virtio-mmio it is `QueueNotify`.
- **feature negotiation**: The virtio step in which the device offers feature bits, the driver accepts a subset, and the device confirms or refuses it through `FEATURES_OK`.
- **used-buffer notification**: The interrupt a virtio device raises after it has put finished requests in a used ring; bit 0 of `InterruptStatus`.
- **virtio-mmio**: The virtio transport in which each device is a 0x200-byte MMIO register window, found through the device tree.
- **configuration space**: A virtio device's own settings, such as a disk's capacity or a network card's MAC address; in virtio-mmio it starts at offset `0x100` of the device's window. Config space for short.

## Chapter 16

- **virtqueue**: A queue of buffers that a virtio driver and device share in guest RAM; the split layout used here has three parts: a descriptor table, an available ring and a used ring.
- **descriptor**: A 16-byte entry in a virtqueue's descriptor table naming one guest buffer: its address, its length, flags (`NEXT`, `WRITE`, `INDIRECT`) and the index of the next descriptor.
- **descriptor table**: The first part of a split virtqueue: N descriptors of 16 bytes, written only by the driver, at the address the driver wrote to `QueueDesc`.
- **head**: The index of a request's first descriptor, which the driver puts in the available ring and the device returns in the used ring.
- **descriptor chain**: The descriptors of one request, linked through their `next` fields; buffers the device reads come first, buffers it writes come after.
- **available ring**: The ring only the driver writes: the head descriptor of each request it offers, and `avail.idx`, how many requests it has offered so far.
- **used ring**: The ring only the device writes: for each finished request, its head and how many bytes the device wrote (`len`), and `used.idx`, how many requests it has finished so far.
- **free-running index**: A counter that only goes up and wraps at 65536; the ring slot is the counter modulo the queue size, and the wrapping difference of two counters is how many entries lie between them.
- **indirect descriptor**: A descriptor whose buffer is itself a table of descriptors, so one ring slot can carry a long request.
- **hop budget**: A limit on how many descriptors one chain walk may visit (the queue size); it stops loops without remembering where the walk has been.
- **TOCTOU** (time of check to time of use): A bug where a value is checked, then read again to be used, and someone changed it in between.
- **double fetch**: Reading the same guest value twice, once to check it and once to use it; the TOCTOU bug in its most common form.
- **copy-then-validate**: The rule that defeats double fetches: copy a guest structure once, check the copy, and use only the copy.
- **GuestMemoryOrdered**: The guest-memory trait that adds the two ordered accessors a split virtqueue needs (an acquire load and a release store of a 16-bit index) and a full fence.
- **ValidatedChain**: What macvmm's chain walker hands a device: one request's buffers, already copied, checked and split into readable and writable, so no device ever parses a ring.

## Chapter 17

- **device worker thread**: A host thread that belongs to one virtio device and does its queue work, so the vCPU thread that took the doorbell exit only sets a bit, wakes it, and returns to the guest.
- **notify coalescing**: Several doorbells that arrive while the worker is busy becoming one pass over the ring; safe because a doorbell carries no data, only "look now".
- **virtio-rng**: The virtio entropy device (device ID 4): one queue of device-writable buffers that the device fills with random bytes. Linux shows it as `/dev/hwrng`.
- **virtio-console**: The virtio console device (device ID 3): a receive queue the device fills and a transmit queue it reads, for one byte stream in each direction.
- **hvc0**: Linux's first hypervisor virtual console, the tty name a virtio-console gets; unrelated to the `hvc` instruction.
- **CSPRNG** (cryptographically secure pseudo-random number generator): A generator whose output cannot be predicted from earlier output; on a Mac, the kernel's, read with `getentropy`.

## Chapter 18

- **virtio-blk**: The virtio block device (device ID 2): a disk the guest drives through one queue, with requests that read, write, flush or identify it.
- **virtio-blk request**: One descriptor chain holding a 16-byte header (the type and a sector number), the data buffers, and a one-byte status the device writes last.
- **IOERR**: The virtio-blk status value 1: the device understood the request but could not or would not do it, such as a sector past the end of the disk.
- **UNSUPP**: The virtio-blk status value 2: the device does not implement this request type.
- **FLUSH**: The virtio-blk request (type 4) that asks for every completed write to be made durable; the device may answer OK only once the data would survive a power cut.
- **write-back**: A cache mode in which a completed write may still sit in a volatile cache; the writer must ask for a flush to make it durable.
- **write-through**: A cache mode in which every write is durable before it is reported complete.
- **bounce buffer**: A fresh, zeroed host buffer that data passes through between a file and guest memory, capped in size, so the guest never sees bytes left from another request.
- **image lock**: The advisory `flock` a VMM takes on a disk image while it runs (exclusive to write, shared to read), so a second VMM cannot open the same image.
- **GET_ID**: The virtio-blk request (type 8) that asks for the disk's serial number, at most 20 bytes; Linux sends it when `/sys/block/vda/serial` is read.

## Chapter 19

- **virtio-net**: The virtio network card (device ID 1): a receive queue of guest-posted buffers the device fills with incoming frames, and a transmit queue of frames the device reads and sends.
- **virtio_net_hdr**: The 12-byte header in front of every frame in a virtio-net buffer; with no offloads, the driver sends `flags` and `gso_type` as 0 and the device writes `num_buffers = 1` on receive.
- **Ethernet frame**: The unit a network card sends: a 14-byte header (destination MAC, source MAC, a two-byte type) and up to 1500 bytes of payload, so at most 1514 bytes without the wire's checksum.
- **MAC address** (media access control address): The six-byte address of one network interface, such as `02:6d:76:00:00:01`; `ff:ff:ff:ff:ff:ff` means every interface (broadcast).
- **NIC** (network interface card): One network card of a machine, real or virtual; each has its own MAC address. In macvmm, one virtio-net device.
- **RX thread**: The host thread each macvmm network card gets for incoming frames (RX is receive, TX transmit); it waits on the host socket, never on the guest, and is the worker's companion.
- **ARP** (Address Resolution Protocol): The broadcast question "who has this IPv4 address?" and its answer, which tells a sender the MAC address to put in its frames.
- **drop-and-count**: A device's answer to a frame it cannot deliver (no buffer posted, wrong size, wrong sender): discard it, add one to a named counter, never wait and never fail the device.
- **NetBackend**: The trait between macvmm's virtio-net device and the host: `send` one frame, `recv` one frame, each with a short timeout.
- **unixgram backend**: macvmm's `--net unixgram:LOCAL,peer=REMOTE`: one Unix datagram socket per network card, one datagram per frame, accepting datagrams only from the peer's path; it needs no entitlement. The opt-in `unixgram:LOCAL,learn` instead locks onto the first sender with an absolute path, a weaker rule than `peer=`.
- **Companion**: In macvmm, a second host thread that belongs to one virtio device, such as a network card's receive thread; it is attached to the device's worker, so stopping the worker stops and joins it too.
- **containment**: Limiting what a program can do even after an attacker has taken it over, such as a sandbox the kernel enforces; not the same as holding no entitlement.
- **offload**: Work a guest hands to its network device through header fields, such as computing checksums or cutting a large packet into frames; faster, but more guest-written fields to check.

## Chapter 20

- **SMP** (symmetric multiprocessing): A machine with several CPUs that share one memory and can each run any work; for us, a guest with more than one vCPU.
- **boot CPU**: The CPU that starts running at power-on (our vCPU 0); every other CPU is a secondary CPU and starts off.
- **secondary CPU**: A CPU other than the boot CPU; it stays off until the guest starts it with PSCI `CPU_ON`.
- **CPU_ON**: The PSCI call that starts an off CPU at an entry point, with a context ID in its `x0`; it names the CPU by its MPIDR affinity.
- **CPU_OFF**: The PSCI call with which a CPU turns itself off; it does not return to the caller while the CPU is off.
- **AFFINITY_INFO**: The PSCI call that asks whether a CPU is on (0), off (1) or on pending (2).
- **context ID**: The value the caller of `CPU_ON` chooses; the new CPU finds it in `x0` at its first instruction.
- **ON_PENDING / ALREADY_ON**: The PSCI refusals -5 and -4 to a `CPU_ON` for a CPU that is already starting or already running.
- **CPU_ON mailbox**: Our VMM's one slot per vCPU that holds the entry point and context ID of an accepted `CPU_ON` until that vCPU's thread takes it.
- **parked vCPU**: A vCPU whose CPU is off; its thread waits on a condition variable, outside `hv_vcpu_run`, until its mailbox is filled or the VM stops.
- **kick**: Forcing a running vCPU out of `hv_vcpu_run` from another thread with `hv_vcpus_exit`; the run returns with the reason `CANCELED`. A kick is sticky (one sent before the vCPU enters the guest is kept for its next run) and can be spurious (a `CANCELED` exit with nothing left to do), so it means "look at what was posted", never "stop".
- **rendezvous**: A point where one thread waits until another reports that a step is done; our VMM spawns the next vCPU thread only after the previous one has created its vCPU, so vCPU *i* gets redistributor frame *i*.
- **start gate**: The barrier that keeps vCPU 0 out of the guest until every vCPU has been created.
- **IPI** (inter-processor interrupt): Linux's name for an interrupt one CPU sends another; on GICv3 it is an SGI.
- **RCU stall warning / soft lockup**: Linux's warnings (`rcu: INFO`, `soft lockup`) that one CPU has made no progress for about 20 seconds; in a VM they usually mean the VMM starved or blocked that vCPU's thread.
- **lock order**: One fixed order in which every thread takes the locks it needs; if all threads follow it, no two can wait for each other forever.

## Chapter 21

- **firmware boot protocol**: The rule for starting a QEMU-`virt` style machine through firmware: the firmware sits in flash at `0x0`, the DTB at the start of RAM (where U-Boot looks for it), and the vCPU starts at `PC = 0`. Our VMM also passes the DTB's address in `x0`, as Linux's boot protocol does.
- **flash** (NOR flash): Memory that keeps its contents without power and reads like ROM, so firmware can run from it in place; changing it takes a command sequence, not a plain store.
- **CFI** (Common Flash Interface): The JEDEC standard command set (JESD68) that software uses to query, erase and program a flash chip.
- **execute in place**: Running code straight from flash, before the program has copied itself into RAM.
- **writeback** (of a base register): A load or store form that also updates its address register, before the access (pre-index, `[x0, #8]!`) or after it (post-index, `[x0], #8`).
- **stage-1 walk**: Reading the guest's own page tables in software to turn a guest virtual address into an IPA, as the guest's MMU would.
- **synchronous external abort**: A data abort that tells the guest the memory system refused an access (fault status code `0x10`); our VMM injects one for any access it will not emulate.
- **ADR** (architecture decision record): A short document recording one design decision: its context, the choice, the alternatives and the consequences.
- **EDK2**: The reference implementation of UEFI; its `ArmVirtQemu` build is firmware for QEMU's `virt` machine.
- **exclusive monitor**: The hardware that remembers which address a load-exclusive (`ldxr`) reserved, so that the matching store-exclusive (`stxr`) can fail if anyone else wrote there; our VMM does not model it, so it refuses exclusives.
- **unscaled offset**: An addressing form (`ldur x0, [x1, #-3]`) whose signed 9-bit offset counts bytes, not multiples of the access size.
- **register offset**: An addressing form (`ldr x0, [x1, x2, lsl #3]`) that adds a second register, optionally shifted, to the base.
- **direct boot**: Starting a guest with the VMM as its bootloader: the VMM places the kernel, initramfs and DTB in RAM and starts the vCPU at the kernel's entry with `x0` = the DTB's address; no firmware runs. The other way is the firmware boot protocol.

## Chapter 22

- **loader.efi**: FreeBSD's boot loader built as an EFI application: firmware starts it, it reads the kernel from FreeBSD's file system through the firmware's disk services, and hands the kernel the DTB from the configuration table.
- **UFS** (Unix File System): FreeBSD's traditional file system; the FreeBSD image keeps its root on a UFS partition.
- **xz**: A compression format and the program that unpacks it; FreeBSD ships its disk images as `.raw.xz`.
- **VIRTIO_BLK_F_SIZE_MAX**: The virtio-blk feature bit (bit 1) that promises every data segment of a request (one data buffer, one descriptor) is at most `size_max` bytes; a driver that cannot keep that promise may refuse the device.
- **mountroot prompt**: The `mountroot>` prompt FreeBSD shows when it cannot find the device its root file system should be on.
- **compatibility log**: A file per guest (ours are in `docs/compat/`) that records how far the guest boots, the transcript and trace at any blocker, its root cause, and a ranked list of what could go wrong next.
- **reference machine**: A widely supported machine model whose behaviour helps settle whether our machine or a guest is wrong, beside the specification and the guest's source; ours is QEMU's `virt`, whose memory map we copy.

## Chapter 23

- **auxiliary storage**: A file VZ keeps beside a macOS guest's disk, holding data the boot loader and the guest need, such as boot settings; a VM must always boot with the one it was installed with.
- **bundle**: In vz-mac, the directory that holds one macOS guest: its disk image, auxiliary storage, hardware model and machine identifier.
- **C1 control**: One of the 8-bit control bytes `0x80` to `0x9F`; some terminals treat one alone as the start of an escape sequence (`0x9b` as CSI, the same as `ESC [`), so vz-mac's console filter never prints one raw.
- **caret notation**: Showing a control byte as `^` followed by the byte plus `0x40`, so ESC (`0x1b`) prints as `^[`; vz-mac's console filter uses it so no escape sequence reaches your terminal.
- **ECAM** (Enhanced Configuration Access Mechanism): The PCI Express rule that maps every device's configuration space into one block of memory addresses; under VZ, Linux lists it as `PCI ECAM` in `/proc/iomem`.
- **hardware model**: In VZ, an opaque value naming the kind of virtual Mac a macOS guest was installed for; every later boot must use the same one.
- **host bridge**: The PCI device that connects the CPU to the PCI bus; under VZ it is the Apple device (vendor `0x106b`) at the start of the bus.
- **machine identifier**: In VZ, an opaque value that gives one macOS VM its own identity; two VMs made from the same configuration each need their own.
- **MIDR** (Main ID Register): The Arm register `MIDR_EL1` that names a CPU's maker and model; under Hypervisor.framework the guest sees a value the hypervisor supplies, `0x610f0000` by default, not the chip's own.
- **PCIe** (PCI Express): The bus ordinary computers use for expansion devices; the operating system finds each device by reading its vendor and device IDs. VZ puts its virtio devices on it; our VMM does not.
- **restore image**: Apple's installation file for macOS, a file ending in `.ipsw`; VZ installs a macOS guest from one.
- **XPC service**: A helper program macOS starts on an app's behalf and talks to by messages; VZ runs each virtual machine inside one, not inside the app that configured it.

## Chapter 24

- **AVPBooter**: Apple's boot ROM for macOS virtual machines, `AVPBooter.vmapple2.bin` inside Virtualization.framework; macvmm reads it in place at run time and never copies it.
- **bdif** (backdoor block interface): The simple disk-reading device of QEMU's vmapple board: the guest writes the address of a three-entry descriptor (sector, data, status) and the device copies 512-byte sectors into guest memory.
- **cfg block**: The configuration page of QEMU's vmapple board that the boot ROM reads to learn about its machine (version, CPU count, ECID, RAM size and fields nobody has explained).
- **controlled variable**: In an experiment, the one thing you change on purpose while keeping everything else the same, so that any difference in the result can be traced to it.
- **device-access trace**: The record of every guest access to an address with no device behind it, as program counter, address, size, direction and value; macvmm's logger prints at most 256 per boot, and none of it is published.
- **ECID** (exclusive chip ID): The 64-bit identity number of a macOS virtual machine, held inside its machine identifier; QEMU's vmapple board hands it to the boot ROM in the cfg block and calls it `uuid`.
- **iBoot**: Apple's boot loader on physical Apple-silicon Macs, the stages between the boot ROM and the kernel; whether a macOS virtual machine uses it is unknown to us.
- **kernelcache**: The macOS kernel linked together with its drivers into one file that the boot loader loads.
- **observed, inferred, unknown**: The three columns every claim about an undocumented machine goes into: seen in your own run, derived from runs plus a named public source, or not shown by anyone.
- **private CPU mode**: A CPU setting, reported by an unmerged QEMU patch series as needed by recent macOS guests, that macvmm asks for and is refused with `HV_DENIED`; that a restricted entitlement unlocks it is inferred, not shown.
- **pvpanic**: A tiny device a guest writes to when it panics, so the host can tell a crash from a hang.
- **unknown-MMIO logger**: The vmapple board's answer to an access no device claims: read as zero, ignore the write, record one line, and stop after 256 entries.
- **vmapple**: The board, first built in QEMU, whose memory map and devices match what Apple's macOS boot ROM expects; in macvmm, a second machine behind the `experimental-vmapple` feature.
- **watcher**: A hook a machine profile may install in macvmm's run loop, called before each exit is handled and for each access no device claims, so the board can log, answer or stop before the generic policy decides; `virt` installs none, vmapple installs one.

## Chapter 25

- **threat model**: A written list of what you protect (assets), where untrusted data crosses into trusted code (trust boundaries), and what each attacker can do; the security work is then checked against it.
- **trust boundary**: A place where data passes from someone you trust less to someone you trust more, such as guest RAM read by the VMM; every value crossing it is checked.
- **malicious guest**: The attacker a VMM is designed against: guest code that runs on every vCPU at once, rewrites its RAM while we read it and chooses every value it hands us, but cannot touch host memory directly.
- **compromised VMM**: The VMM process after an attacker has made it run their code: it acts with your rights, the hypervisor entitlement and every file it holds open.
- **terminal injection**: Guest output that makes your terminal act instead of display, such as retitling the window, writing your clipboard or typing a reply into whatever reads its input; the output filter stops it.
- **STRIDE**: A checklist of six threat kinds to walk each trust boundary through: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege.
- **confused deputy**: A privileged program tricked into using its rights for someone else, such as a VMM opening a file it was handed for another purpose.
- **fuzzing**: Testing by generating very many slightly wrong inputs, running the real code on each, and checking that nothing went wrong.
- **seeded PRNG** (seeded pseudo-random number generator): A small function that turns a starting number into a stream of numbers that look random and are identical on every run, so any fuzz input can be regenerated.
- **fuzz target**: One function the fuzzer calls with a byte string; it decodes the bytes into an input for one parser or device model, runs the real code, and checks the invariants.
- **invariant**: A property that must hold after every input, such as "every validated buffer lies in one RAM region"; the fuzzer's test oracle, which finds bugs that never panic.
- **structure-aware mutation**: Changing an input the way an attacker would, knowing its layout (a `next` pointing backwards, a length ending in the next region), instead of flipping random bits.
- **corpus**: The set of good inputs a fuzzer starts from and damages; ours is drawn fresh from a generator of well-formed rings.
- **coverage-guided fuzzing**: Fuzzing that watches which code each input reaches and keeps mutating the inputs that reached new code; libFuzzer, behind `cargo fuzz`, works this way, and our blind loop does not.
- **defence in depth**: Several independent checks guarding the same thing, so that one missing check is caught by another.
- **canary**: A region of memory nobody should touch, hashed before and after a test; if any byte changed, something wrote where it had no right to.
- **minimisation**: Shrinking a failing input, by zeroing or deleting chunks while it still fails, until it is small enough for a person to see the cause.
- **hostile guest**: Any guest that misbehaves on purpose (a malicious guest); in this course also the suite of test guests that attacks the VMM from inside a real virtual machine, phase by phase, each phase with the exit code the VMM must end with.
- **sandbox**: Rules the kernel enforces on a process, which the process cannot lift; macvmm applies one with `sandbox_init` after set-up, so a compromised VMM can open no file, start no program and reach no network except its configured peer.
- **fail closed**: To stop when a safety mechanism cannot be applied, instead of carrying on without it; macvmm's default sandbox exits 1 if the lockdown fails.
- **RLIMIT_CORE**: The resource limit on the size of a core dump, the file a crashing process can leave with its whole memory; macvmm sets it to 0 so no file of guest RAM is ever written.

## Chapter 26

## Chapter 27
