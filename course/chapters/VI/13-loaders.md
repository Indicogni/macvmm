---
title: Loading kernels: arm64 Image, initramfs and ELF
part: VI
chapter: VI.1
id: 13
runs: mac+browser
minutes: 270
prereqs: [12]
start_tag: ch-12
labs: [image-inspector, elf-inspector, cpio-inspector, cache-views]
command: scripts/checkpoint.sh 13
expect: CHECKPOINT 13 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** placement as a contract, written down as a boot plan (`BootPlan`); the 64-byte arm64 Image header as hostile input; the Linux boot protocol's entry state; an ELF64 loader (a spec exercise); refusing an EFI (Extensible Firmware Interface) zboot wrapper.
- **Core, from earlier:** `x0` and `/chosen` (chapter 10); checked arithmetic and guest memory (chapter 04); `layout.rs` (chapter 05); PSTATE `0x3c5` (chapter 02) and the virtual CPU (vCPU) reset (chapter 06); the random seeds in `/chosen` (chapter 10); `--raw`, `hello` and exit codes 2 and 5 (chapter 03).
- **Primers (read first):** `arm64-boot-protocol` (header, placement, entry state); `elf` (program headers, `filesz` versus `memsz`); `cpio-initramfs` (the initramfs); `efi-zboot` (Alpine's kernel as a UEFI (Unified Extensible Firmware Interface) program in PE/COFF (Portable Executable / Common Object File Format)); `caches` (cleaning to the Point of Coherency (PoC)).
- **Primers (review):** `bare-metal-rust` (BSS, load versus run address); `page-granules` (supported page sizes).
- **Pointers:** sha256 pinning (an Aside); property-based testing (an Aside); gzip, RFC 1952 (a link). For the curious: the UEFI primer, required in chapter 21.
- **Forward definitions:** the Linux boot log and earlycon (chapter 14); kernel address space layout randomisation (KASLR, chapter 14). Each is defined in a sentence where it first appears.
:::

Here are the first 64 bytes of the Linux kernel you will boot in chapter 14. At offset `0x10` sit the bytes `00 00 2a 02 00 00 00 00`. Read right to left, because the header is little-endian, they are the number `0x022a_0000`: the kernel's own statement of how much memory it needs. Copy the file, overwrite those eight bytes with `ff`, and hand the copy to your virtual machine monitor (VMM). Who notices first?

:::term source=captures/13-image-header.txt

:::predict In a copy of the Image, set the eight bytes at offset `0x10` to `ff` and run it. (a) Linux starts and fails to boot, with nothing from the VMM, or (b) the VMM refuses the file with a named error before any guest instruction runs?
Write your guess and one sentence of reasoning under `## Predict` in your journal. "It is the kernel's problem" is the tempting answer. The section on placing the kernel runs it.
:::

This chapter opens row 10 of the problem ledger, the boot chain: the kernel assumes someone loaded it, so our VMM becomes its bootloader. Chapter 14 closes the row.

:::objectives
- Parse the arm64 Image header field by field, refusing every hostile value with a named error.
- Recognise Alpine's `vmlinuz-virt` as an EFI zboot wrapper, refuse it by name, and unwrap it with `cargo xtask unzboot`.
- Implement a boot plan you can print and test: device tree at `0x4000_0000`, Image at `0x4020_0000 + text_offset`, initramfs at `align_up(kernel end, 2 MiB)`, all inside RAM and the protocol's 1 GiB window, with the initramfs range in `/chosen`.
- Set the protocol's entry state (`x0` = device tree, `x1` to `x3` = 0, CPSR (current program status register) = `0x3c5`, the memory management unit (MMU) off) and explain, with the measurement, why we do no cache maintenance.
- Write a loader for 64-bit ELF (Executable and Linkable Format) files from their specification, and predict which check a hostile file trips.
:::

**Before you start.** From the repository root, run `scripts/learner start 13` (it copies the journal) and type the code into `learner/` as you go. Until "Wire it to the command line" nothing calls your loader, so earlier runs use the reference, from the repository root. After it, run your own code from inside `learner/`, where the cache is `../.cache/`; our captures, made from the root, lack the `../`. Fetch the kernel and its initramfs:

```sh
scripts/fetch.sh linux
```

:::term source=captures/13-fetch.txt

The last line builds the course's test initramfs from Alpine's.

> **Aside.** Every download is named in `scripts/fetch-manifest.txt` with its SHA-256 hash (sha256 pinning); yours must match byte for byte. The script uses HTTPS only and never executes what it downloaded: a kernel is data for the VMM, not a program for your Mac. Chapter 25 writes the threat model behind this rule.

## Loading is not copying

The first plan that comes to mind: copy the file to guest RAM, set the program counter (PC) there, run. Chapter 03 did that with `--raw hello.bin@0x40080000`, and it worked because we wrote that guest.

A Linux kernel was written by someone else, for every machine. It needs five answers, and the file holds only some:

| The kernel needs to know | Who decides | Where it comes from |
|---|---|---|
| where it sits | the kernel, partly | a 2 MiB-aligned base plus `text_offset` from its header |
| how much room it has | the kernel | `image_size` from its header: the file *plus* the memory it will clear |
| what machine this is | the VMM | the device tree, with its address in `x0` (chapter 10) |
| where its first files are | the VMM | the initramfs, with its range in `/chosen` |
| what state the CPU is in | the protocol | [`booting.rst`](https://docs.kernel.org/arch/arm64/booting.html), section 4 |

So loading is a contract between the kernel's header, the boot protocol and the VMM's memory map. We write it down as data, a [**boot plan**](/build-your-own/vmm/glossary/#boot-plan), check it, print it, and only then copy bytes.

## The 64-byte header, read as hostile input

The kernel format is the [**arm64 Image**](/build-your-own/vmm/glossary/#arm64-image): one flat binary whose first 64 bytes form a header for its loader. Read the capture above beside this table; all fields are little-endian.

| Offset | Field | Alpine's bytes | Our rule |
|---|---|---|---|
| `0x00` | `code0`, `code1` | `4d5a 40fa 27b4 5514` | code, not ours to read |
| `0x08` | [`text_offset`](/build-your-own/vmm/glossary/#text-offset) | `0` | a multiple of 4 KiB |
| `0x10` | [`image_size`](/build-your-own/vmm/glossary/#image-size) | `0x022a_0000` | not zero; start plus size inside RAM, without overflow |
| `0x18` | `flags` | `0xa` (`0b1010`) | bit 0: 0 = little-endian; bits 1-2: page size (0 unspecified, 1 = 4 KiB, 2 = 16 KiB, 3 = 64 KiB, refused); bit 3: may sit anywhere in RAM |
| `0x20`..`0x37` | reserved | zeros | ignored |
| `0x38` | `magic` | `41 52 4d 64`, `ARM\x64` | must match |
| `0x3c` | `res5` | `0x40` | ignored |
| (the file) | its length | `0x022a_0000` | at most `image_size` |

Alpine's flags say 4 KiB pages, bit 3 set. The CPU lists what it supports in `ID_AA64MMFR0_EL1` (AArch64 Memory Model Feature Register 0); the `page-granules` primer reads ours through Hypervisor.framework: `0x000010000f100022`. `TGran64` (bits 24 to 27) is `0xF`, no 64 KiB pages; `BigEnd` (bits 8 to 11) is 0, no big-endian mode. Reading the kernel's early boot code, such a kernel would stop before printing anything; we have not run one on a Mac. We refuse both by name. An `image_size` of 0 is a kernel older than 3.17 that never said how much memory it needs.

Every value came from a file, maybe from a fuzzer. The parser checks the length before reading, the magic before trusting the rest, and every field before using it. Each refusal is a typed `LoaderError` (exit code 2), never a panic. In `learner/crates/vmm/src/loader/image.rs`:

:::code anchor=image_header_parse file=crates/vmm/src/loader/image.rs

The last check, file length at most `image_size`, is the least expected. The plan puts the initramfs right after `image_size` bytes, so a longer file would be copied over it. A file that breaks its own promise is malformed.

:::lab image-inspector

Drop `.cache/macvmm/Image-virt` on the inspector (nothing is uploaded), flip a byte and watch which check fails first.

## Placing the kernel

The protocol: "placed `text_offset` bytes from a 2MB aligned base address anywhere in usable system RAM", with `image_size` bytes free. Our first 2 MiB belong to the device tree, so the base is `0x4020_0000`. Alpine sets bit 3, so any 2 MiB base would do; we take the lowest, which also serves kernels with bit 3 clear (they must sit as close to the start of RAM as possible). In `learner/crates/vmm/src/arch/layout.rs`:

:::code anchor=layout_linux file=crates/vmm/src/arch/layout.rs

Chapter 03's two helpers do the range arithmetic; every loader here reuses them unchanged:

:::code anchor=loader_ram_range file=crates/vmm/src/loader/mod.rs

:::code anchor=loader_overlaps file=crates/vmm/src/loader/mod.rs

Placing the kernel is two checked additions and one range check over the whole `image_size`, not the file:

:::code anchor=bootplan_place_kernel file=crates/vmm/src/loader/image.rs

Now run your Predict, on the reference for now. Make the copy in `.cache/ch13/` (ignored by git), patch it, and run:

```sh
mkdir -p .cache/ch13
cp .cache/macvmm/Image-virt .cache/ch13/Image-huge
printf '\377\377\377\377\377\377\377\377' | dd of=.cache/ch13/Image-huge bs=1 seek=16 conv=notrunc
cargo run -q -p macvmm -- run --kernel .cache/ch13/Image-huge --initrd .cache/macvmm/initramfs-test.img --mem 512M --timeout 10
```

`dd` reports `8+0 records in`; that is expected.

:::term source=captures/13-image-size-max.txt

Answer (b): exit code 2, and no virtual machine (VM) was created. The VMM acts on the header *before* the kernel gets control. With wrapping arithmetic, `0x4020_0000 + 0xFFFF_FFFF_FFFF_FFFF` would be `0x401F_FFFF`, inside RAM, and a check `end <= ram_end` would wave it through. `checked_add` turns the overflow into `None`, and `place()` turns that into `OutsideRam`.

> **Security.** The attacker controls a file: every header field, its length, its format. Without these checks what breaks is the VMM, the process holding the hypervisor entitlement.

## Which file is it? Magic numbers

`--kernel` accepts two formats and recognises a third only to refuse it, by the first bytes, never the file name:

:::code anchor=loader_detect file=crates/vmm/src/loader/mod.rs

Alpine ships its kernel as `vmlinuz-virt`. Its first 64 bytes:

:::term source=captures/13-zboot-header.txt

`MZ` at offset 0, `zimg` at 4, `gzip` at `0x18`, and `cd23 8281` where the magic should be. This is an [**EFI zboot**](/build-your-own/vmm/glossary/#efi-zboot) wrapper: a small UEFI program, in the PE/COFF format whose files start with `MZ`, that decompresses the real Image and jumps to it (the `efi-zboot` primer).

The unwrapped Image also begins with `MZ`, because it carries an EFI stub: code that lets UEFI firmware start the kernel directly. The wrapper's mark is `zimg` at offset 4, which `detect` checks. We have no UEFI firmware, so the VMM says what it is:

```sh
cargo run -q -p macvmm -- run --kernel .cache/macvmm/vmlinuz-virt
```

:::term source=captures/13-zboot-refused.txt

The payload is gzip ([RFC 1952](https://www.rfc-editor.org/rfc/rfc1952)). We unwrap it once, on the host, and check the result against the pinned hash. `fetch.sh` did this for you; do it yourself once:

```sh
cargo xtask unzboot .cache/macvmm/vmlinuz-virt .cache/ch13/Image
shasum -a 256 .cache/ch13/Image .cache/macvmm/Image-virt
```

:::term source=captures/13-unzboot.txt

:::term source=captures/13-unzboot-sha.txt

Why not decompress in the VMM at every boot? Decompressors are a classic home of memory-safety bugs, and this one would parse internet bytes in the process that creates VMs. On the host it runs once, against a pinned hash, and the VMM's input stays a format we validate in about 45 lines.

## The initramfs: opaque bytes, one rule

The kernel needs files before it has a disk driver: its first program, `/init`, and what that needs. They arrive as the [**initramfs**](/build-your-own/vmm/glossary/#initramfs), a cpio archive the kernel unpacks into memory. The VMM never parses it; it places it by three rules: outside the kernel's `image_size` span; with the kernel, inside "a 1 GB aligned physical memory window of up to 32 GB" (`booting.rst` section 4); and inside RAM. We start it at the kernel's end rounded up to 2 MiB: the protocol asks for no alignment, but this keeps it page-aligned and the numbers readable. `align_up(x, a)` rounds up to a multiple of the power of two `a`, or returns `None` on overflow:

:::code anchor=bootplan_place_initrd file=crates/vmm/src/loader/initrd.rs

For the window, the best candidate starts at the 1 GiB boundary at or below the lower start (a higher one misses that start, a lower one wastes its 32 GiB), so if it fails every window fails:

:::code anchor=initrd_window_check file=crates/vmm/src/loader/initrd.rs

Because the initramfs sits right after the kernel, near our 1 GiB-aligned RAM base, the window fails only for an initramfs of about 32 GiB, which needs `--mem` above 32G. The contract test `one_gib_window_rule` builds exactly that case.

:::lab cpio-inspector

Drop `.cache/macvmm/initramfs-test.img` on the inspector and find `/init`.

The kernel learns the range from chapter 10's `/chosen` node, which gains `linux,initrd-start`, `linux,initrd-end` and `bootargs`, the [kernel command line](/build-your-own/vmm/glossary/#kernel-command-line) (options such as `console=`). It keeps chapter 10's two fresh random seeds, for the kernel's random number generator (RNG) and for KASLR, which puts the kernel's code at a random address each boot so an attacker cannot guess it (chapter 14). The kernel needs this randomness before it has any of its own. In `learner/crates/vmm/src/fdt/machine.rs`:

:::code anchor=fdt_machine_chosen file=crates/vmm/src/fdt/machine.rs

## The plan, printed

All of this is one pure function: bytes and a RAM size in, a `BootPlan` or a named error out. In `learner/crates/vmm/src/loader/plan.rs`:

:::code anchor=bootplan_struct file=crates/vmm/src/loader/plan.rs

Before looking at the kernel, `plan()` always reserves the first 512 KiB of RAM for the device tree:

:::code anchor=plan_dtb_slot file=crates/vmm/src/loader/plan.rs

For an Image, the plan keeps the kernel clear of the device tree's full 2 MiB, makes the PC its first byte, places the initramfs and picks the command line. The default, `console=ttyAMA0 earlycon=pl011,0x09000000`, names the first PL011 and makes the kernel print through it before its drivers load (chapter 14).

:::code anchor=bootplan_plan_image file=crates/vmm/src/loader/plan.rs

Last, `dtb_limit`, how far the device tree may actually grow: at most 2 MiB, inside RAM, never into the lowest image:

:::code anchor=plan_dtb_limit file=crates/vmm/src/loader/plan.rs

## Wire it to the command line

Your `plan()` has taken a `BootInputs` since chapter 03, with `kernel` always `None`. In `learner/crates/macvmm/src/cli.rs`, `run` learns `--kernel FILE`, refused if given twice:

:::code anchor=cli_parse_kernel file=crates/macvmm/src/cli.rs

and the two inputs only an Image may take:

:::code anchor=cli_parse_linux_inputs file=crates/macvmm/src/cli.rs

The parser records paths only. Then, in your `run` command, before any Hypervisor.framework call:

1. Read each file whole, as your `--raw` path reads its blob: a regular file, not empty, at most the RAM size. (The reference's is `read_input` in `crates/vmm/src/backend/hostio.rs`.)
2. Hand the bytes to `plan()` in the `kernel`, `initrd` and `cmdline` fields of `BootInputs`; `plan()` calls `detect`, so the file name never matters.
3. Print a `LoaderError` as `macvmm: cannot load the guest: ` and its message, and exit with code 2.
4. Add `--dry-run`, a flag with no value (chapter 05 ran only the reference's): print `macvmm boot plan (dry run, no VM created)` and the plan, exit 0, create no VM.
5. Until the ELF loader, let the `ImageKind::Elf` arm return `LoaderError::NotAKernel` (its "not an ELF file" message is wrong for a real ELF until then).

From here on, run from inside `learner/`. First, your Predict again, now on your own code:

```sh
cargo run -q -p macvmm -- run --kernel ../.cache/ch13/Image-huge --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --timeout 10
```

It must print the same refusal, with exit code 2.

Because the plan is pure, `--dry-run` creates no VM. To prove it, use a binary with no hypervisor entitlement. Your workspace builds into `../target/learner`; copy the binary and sign the copy with no entitlement. `codesign` must then print only the `Executable=` line, no `com.apple.security.hypervisor` key:

```sh
cargo build -q -p macvmm
mkdir -p ../target/ch13
cp ../target/learner/debug/macvmm ../target/ch13/macvmm-noent
../scripts/sign.sh --no-entitlements ../target/ch13/macvmm-noent
codesign -d --entitlements - ../target/ch13/macvmm-noent
```

:::term source=captures/13-noent-sign.txt

Now the dry run, from that copy:

```sh
../target/ch13/macvmm-noent run --dry-run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M
```

:::term source=captures/13-dry-run.txt

Exit 0, and every number this chapter set out to produce. Ask the same copy to boot for real:

```sh
../target/ch13/macvmm-noent run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --timeout 10
```

:::term source=captures/13-no-entitlement.txt

`hv_vm_create` returns `HV_DENIED`. So the dry run cannot have created a VM: `plan()` is a pure function that never reaches the `hvf` crate.

> **Try it.** The `header` row says `file=0x22a0000`, equal to `image_size`: is the Image padded with zeros? Its last non-zero byte is at `0x1972807` (we searched backwards). `tail` counts from 1, so `+26683401` (`echo $((0x1972808 + 1))`) starts right after it; `cmp` compares the rest with zeros.

```sh
xxd -s 0x1972800 -l 16 ../.cache/macvmm/Image-virt
tail -c +26683401 ../.cache/macvmm/Image-virt | cmp - /dev/zero
```

:::term source=captures/13-image-tail.txt

`EOF on stdin`: the file ran out before any non-zero byte, so its last 9 MiB or so are zeros, standing in for the kernel's BSS and early page tables. Another build may leave them out; only the header says how far the kernel reaches.

:::stopping-point Good place to stop. The parser, the plan and `--dry-run` build and run. The rest needs your Mac, your workspace and about 2 hours.

## The entry state, register by register

Chapter 10 set `x0` and chapter 06 the reset state. What `booting.rst` section 4 asks of the registers, for a kernel entered at exception level 1 (EL1):

| State | Value | Why |
|---|---|---|
| PC | the kernel's first byte, `0x4020_0000` | the header's first two words are instructions that branch into the kernel; the first is chosen so its bytes also spell `MZ` and it does nothing (the `arm64-boot-protocol` primer) |
| `x0` | `0x4000_0000`, the device tree | the kernel's only description of the machine |
| `x1`, `x2`, `x3` | 0 | "reserved for future use"; a non-zero value may mean something one day |
| CPSR (Hypervisor.framework's name for the vCPU's PSTATE, chapter 02) | `0x3c5` | EL1h (EL1, using its own stack pointer), with debug, SError (system error), IRQ (interrupt request) and FIQ (fast interrupt request) masked |
| MMU | off (`SCTLR_EL1.M = 0`, in the system control register, chapter 06) | required: the kernel builds its own page tables |
| instruction cache | on or off | required: no stale lines for the Image |
| `SCTLR_EL1.C` and `.I` | 0 | our reset's choice, not the protocol's; with the MMU off, data accesses are non-cacheable anyway |
| the Image's bytes | cleaned to the Point of Coherency (PoC) | below |

`booting.rst` also requires the timer frequency programmed, one counter offset across CPUs, and the interrupt controller's system-register interface enabled: Hypervisor.framework and its Generic Interrupt Controller (GIC, chapter 12) provide these, except the offset, which is ours (chapter 11).

The plan's numbers become the boot parameters, in `learner/crates/vmm/src/machine/mod.rs`, and chapter 06's reset applies them:

:::code anchor=boot_params_x0 file=crates/vmm/src/machine/mod.rs

:::code anchor=vcpu_reset file=crates/vmm/src/vcpu/mod.rs

The last row needs the `caches` primer. With its MMU off, the kernel reads memory around the caches, while our VMM wrote the Image through a cacheable mapping; if our writes still sat in a cache, the kernel would read old RAM. So the protocol asks that the Image be cleaned to the PoC, where every observer agrees. Our copy is a plain bounds-checked write:

:::code anchor=image_load file=crates/vmm/src/loader/image.rs

No cache maintenance follows: a measured decision. The measurement is chapter 04's `memtest`, run here by the reference from the repository root, since it loads `memtest` from its ELF file and your ELF loader comes last. With its MMU off the guest writes patterns over 16 MiB, then our VMM hashes the same memory through its cacheable mapping:

:::term source=captures/13-memtest.txt

The line `memhash ok` is the comparison: the guest's hash of what it wrote equals the hash our VMM computed through its own mapping. That is guest to host. Host to guest, which loading needs, is shown by every Linux boot here and in chapter 14: about 35 MiB of kernel copied in, then run with the MMU off. The `caches` primer explains why this is a measured property of Apple Silicon, not a rule. The lab shows the hazard:

:::lab cache-views

## Breaking it on purpose

Two breaks, each predicted first, on your own code. The second needs an edit; undo it afterwards.

**Deliberate breakage 1: flip the magic.** Copy the Image and change the byte at `0x38` from `A` to `B`:

```sh
cp ../.cache/macvmm/Image-virt ../.cache/ch13/Image-badmagic
printf 'B' | dd of=../.cache/ch13/Image-badmagic bs=1 seek=56 conv=notrunc
cargo run -q -p macvmm -- run --kernel ../.cache/ch13/Image-badmagic --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --timeout 10
```

Predict the message, then what happens if the same bytes go through `--raw`, which parses nothing:

:::term source=captures/13-bad-magic.txt

Your `ImageBadMagic` never fires here. `detect` looks at the magic first, decides this is not an Image, and the plan refuses the `--initrd` that only an Image may take. Drop `--initrd` and `detect`'s verdict shows directly:

```sh
cargo run -q -p macvmm -- run --kernel ../.cache/ch13/Image-badmagic --mem 512M --timeout 10
```

:::term source=captures/13-bad-magic-no-initrd.txt

No magic matched, so `detect` returned `Raw` and the plan refused it as `NotAKernel`, exit 2. That message assumes you meant an ELF and points at `--raw` for flat binaries: the next command. (The magic check in `parse_header` guards callers that skip `detect`; the checkpoint's tests reach it.) With no parser, copied to `0x4020_0000` and started there:

```sh
cargo run -q -p macvmm -- run --raw ../.cache/ch13/Image-badmagic@0x40200000 --mem 512M --timeout 10
```

:::term source=captures/13-bad-magic-raw.txt

Surprise: Linux boots. The magic is a promise to the loader; the kernel never checks it. `--raw` still generates the device tree and puts its address in `x0` (chapter 10), hence `Machine model: macvmm-virt`; it skips only the header checks, the initramfs and the command line.

About 180 lines in, it ends in `Kernel panic - not syncing: VFS: Unable to mount root fs`, then spins until our timeout (exit 5). No initramfs was passed, so there was no `/init`; the kernel looked for a root disk, found none, and panicked. The message blames the root file system, far from the cause.

What you saw: with the loader, a refusal before any guest code ran; without it, a misleading panic.
The misconception: "a corrupt kernel fails fast on its own".
The tool: the loader's checks, and `--dry-run` to see what the VMM decided before anything runs.

**Deliberate breakage 2: put the initramfs inside the kernel's BSS.** In your `initrd.rs`, make `place()` start the initramfs 4 MiB lower: replace `align_up(kernel_end, LINUX_ALIGN)` with `align_up(kernel_end, LINUX_ALIGN).and_then(|a| a.checked_sub(4 << 20))`. Nothing else checks this overlap. The plan, then the boot:

```sh
cargo run -q -p macvmm -- run --dry-run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --timeout 15
```

:::term source=captures/13-initrd-in-bss-plan.txt

The kernel ends at `0x424a0000`; the initramfs starts at `0x42200000`, inside it. Predict the boot: an immediate error, a panic about the archive, or something else?

:::term source=captures/13-initrd-in-bss.txt

About 140 lines in, the boot stops after `IP idents hash table entries`, with no error, until our timeout (exit 5). Early in boot the kernel clears the end of its `image_size` span for its BSS and early page tables, and the first 2.6 MiB of the initramfs sat there. We have not traced which later step stalls; another overlap would change the last line.

What you saw: a silent stop whose last printed line comes from networking code, nothing to do with the cause.
The misconception: "loading means copying the file to RAM; the file's size is the kernel's footprint".
The tool: the boot plan's tests. Copy the checkpoint's boot-plan test into your workspace and run it, with the edit still in place (the next section opens this file):

```sh
mkdir -p crates/vmm/tests
cp ../course/checkpoints/13/contract/bootplan.rs crates/vmm/tests/
cargo test -q -p vmm --test bootplan
```

:::term source=captures/13-initrd-in-bss-test.txt

All four tests fail at once. Undo the edit before you go on.

## Ten thousand plans

The test `alpine_numbers` in your copy, `crates/vmm/tests/bootplan.rs`, pins the plan for one kernel: your dry run's numbers. The property test asks more: for 10,000 combinations of RAM size, `text_offset`, `image_size`, file length and initramfs size, does every plan the code *accepts* keep everything in RAM, disjoint, aligned and inside the window? Its heart:

:::code anchor=bootplan_property_asserts file=crates/vmm/tests/bootplan.rs

> **Aside.** This is property-based testing: a generator produces many inputs and the test checks a rule that must hold for all of them. Ours uses a seeded pseudo-random generator (a small xorshift, no extra crate), so a failure prints its seed; the broken run above printed `seed 7881690183168229385 iter 0`. Tools such as `proptest` also shrink a failure to a minimal case. An introduction: ["What is property-based testing?"](https://hypothesis.works/articles/what-is-property-based-testing/) from the Hypothesis project.

To replay that exact failure, set the seed:

```sh
MACVMM_SEED=7881690183168229385 cargo test -q -p vmm --test bootplan
```

## The ELF loader: a spec exercise

Our test guests are ELF files, so far fed to the VMM as flat binaries. An ELF file says where every byte goes and where execution starts. You write this loader from the specification, with no code shown first: the System V Application Binary Interface (ABI), whose generic part (the gABI) has the [ELF Header](https://refspecs.linuxfoundation.org/elf/gabi4+/ch4.eheader.html) and [Program Header](https://refspecs.linuxfoundation.org/elf/gabi4+/ch5.pheader.html) chapters; the `elf` primer walks both. The rules, each one a test in the checkpoint's `course/checkpoints/13/contract/elf_hostile.rs`:

1. `e_ident`: the magic `\x7fELF`, `ELFCLASS64`, little-endian data, version 1; then `e_type = ET_EXEC`, `e_machine = 183` (AArch64), `e_version = 1`.
2. `e_phentsize = 56`, `e_phnum` at most 64, and `e_phoff + e_phnum * 56` inside the file, with `checked_mul` and `checked_add`.
3. For each `PT_LOAD`: `p_filesz <= p_memsz`; `[p_offset, p_offset + p_filesz)` inside the file; `p_vaddr == p_paddr` (the MMU is off, so the address the code runs at is the physical address); `[p_paddr, p_paddr + p_memsz)`, computed with `checked_add`, inside RAM; at or above RAM base + 512 KiB, clear of the device-tree slot `plan()` reserved first; and disjoint from every other segment.
4. `e_entry` inside a segment marked executable.
5. Ignore section headers: a loader does not need them, and every field you do not read is a field nobody can attack.
6. Load by copying `p_filesz` bytes and zeroing the rest up to `p_memsz`, through the guest-memory API, in fixed-size chunks, so `p_memsz` never sizes a host buffer.

The test guests start at `0x4008_0000`, right above the slot. Write `learner/crates/vmm/src/loader/elf.rs` now, from these rules, and replace the stand-in `ImageKind::Elf` arm of `plan()` with one that calls it. Then run chapter 03's guest from its ELF file:

```sh
cargo run -q -p macvmm -- run --dry-run --mem 64M --kernel ../target/guests/aarch64-unknown-none/release/hello
cargo run -q -p macvmm -- run --mem 64M --kernel ../target/guests/aarch64-unknown-none/release/hello --timeout 10
```

:::term source=captures/13-hello-elf-plan.txt

:::term source=captures/13-hello-elf.txt

Segment 2 occupies `0x80020` bytes of RAM. How many come from the file? `objdump` (Xcode's command-line tools) prints the program headers:

```sh
objdump -p ../target/guests/aarch64-unknown-none/release/hello
```

:::term source=captures/13-hello-phdrs.txt

The third `LOAD` has `filesz 0`: the guest's BSS and stack, which only `p_memsz` describes. The lesson of `image_size` again.

> **Try it.** Set `e_phnum` (two bytes at `0x38`) of a `hello` copy to `ff ff`, then run it. Which rule fires first? A loader that loops before checking that the table fits reads far past the file's end.

```sh
cp ../target/guests/aarch64-unknown-none/release/hello ../.cache/ch13/hello-phnum
printf '\377\377' | dd of=../.cache/ch13/hello-phnum bs=1 seek=56 conv=notrunc
cargo run -q -p macvmm -- run --mem 64M --kernel ../.cache/ch13/hello-phnum --timeout 10
```

Check your guess:

:::term source=captures/13-elf-phnum.txt

:::lab elf-inspector

## Your turn

Check your `learner/` against the list and finish what is missing:

1. `arch/layout.rs`: the seven constants shown.
2. `loader/mod.rs`: `ImageKind`, `detect`, and the `LoaderError` variants below, each with a one-line message, plus a `Memory(MemoryError)` variant and `From<MemoryError> for LoaderError`, so that `?` works on guest-memory writes. `RamRange` and `overlaps` are chapter 03's, unchanged.
3. `loader/image.rs`: `parse_header`, `place` and `load` as shown, with `TEXT_OFFSET_ALIGN` (4096), the flag bits from the table, and the types `PageSize`, `ImageHeader` and `ArmImage` (whose `placement()` is the kernel's plan row). Two helpers the code above uses: `fn le64(b: &[u8], off: usize) -> Option<u64>` reads the little-endian `u64` at `off`, or returns `None` when the slice is too short (compute the end with `checked_add`); and `placement()` returns `plan.rs`'s `pub struct Placement { pub what: String, pub addr: u64, pub len: u64 }`, with `what` set to `"kernel (arm64 Image)"`, `addr` to the load address and `len` to `image_size`.
4. `loader/initrd.rs`: `align_up`, `place` and `check_window`.
5. `loader/plan.rs`: `BootPlan` and `plan()`: the 512 KiB device-tree slot first, then the ELF arm, the Image arm as shown, `--initrd` and `--cmdline` refused for anything but an Image, and `dtb_limit` last, as shown. Its printed lines must match the `--dry-run` capture exactly, from `dtb     0x40000000` to `entry   pc=… x0=… cpsr=0x3c5`.
6. `loader/elf.rs`: from the rules, then compare with the reference.
7. `fdt/machine.rs`: `/chosen` gains `bootargs`, `linux,initrd-start` and `linux,initrd-end`.
8. `machine/mod.rs`: `BootParams { pc, x: [x0, 0, 0, 0], cpsr }` from the plan.
9. `crates/macvmm/src/cli.rs`: `--kernel` (ELF or Image, decided by `detect`), `--initrd`, `--cmdline` and `--dry-run`, as in "Wire it to the command line", with the ELF arm now real.

The error variants, with the cases the checkpoint's tests build:

:::code anchor=loader_error file=crates/vmm/src/loader/mod.rs

Then rerun every `learner/` command on this page and compare with the captures; with your ELF loader in place, the `memtest` run works too (`--mem 64M --kernel ../target/guests/aarch64-unknown-none/release/memtest --timeout 10`). Answer journal question 2 right after the second break.

Stuck? `scripts/learner hint 13` gives four hints, from a nudge to the exact reference file.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (hostile Image and ELF files, the boot plan and its property test), then three runs on your Mac: `hello` from its ELF file, the Alpine dry run from an unentitled binary, and the `vmlinuz-virt` refusal, then checks your journal. On our Mac, against the reference:

:::term source=captures/13-checkpoint.txt

The `contract` line is the contract tests, `run` the runs on your Mac, `journal` the journal check.

What now works:

- your VMM parses an arm64 Image header, refusing hostile fields and zboot wrappers by name;
- it plans and prints the boot without a VM, and survives 10,000 generated cases;
- it starts a kernel in the protocol's entry state, with the initramfs in `/chosen`;
- it loads ELF files by their program headers.

The next chapter starts from this state (the reference at the end of chapter 13, tag `ch-13`).

### What's next

Chapter 14 boots Alpine to a shell, then breaks the machine three ways and diagnoses each break from the outside.

### Open question

The ELF rules say `p_filesz <= p_memsz`. A program header says `p_filesz = 4096` and `p_memsz = 2^40`, which passes that rule. What is the loader's rule for this header, and which two numbers do you compare `p_memsz` with before you zero anything?

## Spec hunt

- Linux `Documentation/arch/arm64/booting.rst`, section 4, "Call the kernel image": when header flag bit 3 is 0, what does the document say about memory below the kernel's base address, and why (look for the linear mapping)?
- The System V gABI, the "Program Header" chapter, the entries for `p_filesz` and `p_memsz`: what must the loader put in the bytes between them, and what does the specification say if `p_filesz` is larger?
- Linux `drivers/of/fdt.c`, the function `early_init_dt_check_for_initrd`: what does the kernel do if `linux,initrd-start` or `linux,initrd-end` is missing, or if start is above end?
