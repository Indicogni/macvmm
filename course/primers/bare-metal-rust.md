---
title: Bare-metal Rust: no_std, linker scripts, flat binaries
slug: bare-metal-rust
kind: primer
minutes: 30
required_by: [03]
also_used_by: [13]
lab: linker-map
runs: mac+browser
command: wc -c < bare.bin
expect: 68
objectives:
- Explain what `#![no_std]` and `#![no_main]` remove from a Rust program, and what is left (`core`, a panic handler you write, an entry symbol you name).
- Read a target triple, tell `aarch64-apple-darwin` from `aarch64-unknown-none`, and install a target with `rustup target add`.
- Sort a program's statics into `.text`, `.rodata`, `.data` and `.bss`, and confirm the placement with `llvm-nm` and `llvm-size`.
- Write a linker script that puts `_start` at `0x4008_0000`, and explain load address versus run address.
- Turn an ELF into a flat binary with `llvm-objcopy`, account for every byte in it, and say why the BSS and the stack are not there.
---

# A program with nothing underneath

Make a fresh Rust project and ask Cargo to build it for a machine with no operating system:

```sh
cargo new bare
cd bare
cargo build --target aarch64-unknown-none
```

Output (paths shortened):

```text
error[E0463]: can't find crate for `std`
  |
  = note: the `aarch64-unknown-none` target may not support the standard library
  = note: `std` is required by `bare` because it does not declare `#![no_std]`

error: cannot resolve a prelude import

error: cannot find macro `println` in this scope
 --> src/main.rs:2:5

error: `#[panic_handler]` function required, but not found
```

Four errors for a three-line "Hello, world". Some context first. macvmm is a **VMM** (virtual
machine monitor): a Mac program that pretends to be a whole computer, with RAM, a CPU and devices.
The program running *inside* that pretend computer is the **guest**, and the pretend CPU it runs
on is a **virtual CPU** (vCPU). This primer builds a tiny guest. Your Mac's CPU and the vCPU speak
exactly the same instructions, so what is missing? By the end of this primer you will have fixed
all four errors, built a 68-byte program that a vCPU could run, and found the one thing it still
lacks before it can run safely.

:::objectives
- Say what `no_std` and `no_main` remove, and what remains.
- Read a target triple and install a target.
- Sort statics into `.text`, `.rodata`, `.data` and `.bss`.
- Write a linker script that places `_start` at `0x4008_0000`; tell load from run address.
- Flatten an ELF with `llvm-objcopy` and account for every byte.
:::

:::prereqs
- [`aarch64-reading`](/build-your-own/vmm/primers/aarch64-reading/): what a register is, and how to read a short listing of Arm instructions
  (`sub`, `ldr`, `str`, `adr`, `adrp`, `b`). The disassembly below assumes it.
- Enough Rust to read a `static`, a function and an attribute such as `#[...]`. A Mac with
  `rustup` installed.
:::

## Same CPU, different world: target triples

A compiler has to know more than the instruction set. It has to know what the finished program
will stand on: which operating system will load it, which file format that loader reads, which
libraries exist. Rust names all of that in one string, the **target triple**. Ask `rustc` for the
one it builds for by default:

```sh
rustc -vV
```

Among the lines you should see:

```text
host: aarch64-apple-darwin
```

Read it as architecture, vendor, operating system: AArch64 instructions, made by Apple, running on
Darwin (the kernel under macOS). A triple can carry a fourth part for the environment, as in
`aarch64-unknown-linux-gnu`. Our guest's triple is **`aarch64-unknown-none`**: the same
instructions, no particular vendor, and *no operating system at all*.

| | `aarch64-apple-darwin` | `aarch64-unknown-none` |
|---|---|---|
| Instructions | AArch64 | AArch64 |
| Who loads the program | macOS (`dyld`, its program loader) | whoever puts bytes in memory and sets the PC |
| File format the linker writes | Mach-O | ELF |
| Standard library | `std` (files, threads, `println!`) | `core` only |
| What a panic does | unwinds by default | aborts (`panic="abort"`) |

Four words in that table need a gloss. The **PC** (program counter) is the CPU register that holds
the address of the next instruction; "setting the PC" means choosing where execution starts.
**Mach-O** and **ELF** are file formats for compiled programs: Mach-O is Apple's, ELF is the one
almost everyone else uses (we look inside an ELF file later in this primer). To **unwind** after a
panic is to walk back up the chain of function calls, running each function's clean-up code
(destructors) on the way; that needs tables and library support. To **abort** is simply to stop.

Each row is something you can check. `file` on a normal Mac build prints
`Mach-O 64-bit executable arm64`; on the program we build below it prints
`ELF 64-bit LSB executable, ARM aarch64`. And `rustc --print cfg --target aarch64-unknown-none`
lists `target_os="none"` and `panic="abort"`, where the host says `target_os="macos"` and
`panic="unwind"`.

Building for a triple other than your host's is **cross-compiling**. Rust's compiler can already
emit code for every triple; what you install per target is the precompiled `core` library for it:

```sh
rustup target add aarch64-unknown-none
```

```text
info: component rust-std for target aarch64-unknown-none is up to date
```

(The first time, it downloads instead of saying "up to date". The macvmm repo's
`rust-toolchain.toml` lists this target, so inside the repo it is installed for you.)

## What `no_std` takes away

`std` is the part of Rust that asks an operating system for things. `println!` writes to file
descriptor 1; `Vec` gets memory from the system allocator; `std::thread` asks the kernel for a
thread. On `aarch64-unknown-none` there is nobody to ask, so `std` does not exist, and the first
error says so.

What remains is **`core`**: everything that needs no OS. `Option`, `Result`, iterators, slices,
`str`, `core::fmt`, atomics and `core::ptr` all live there. (There is also `alloc`, with `Vec` and
`Box`, which works once you supply a memory allocator yourself; our guests never need it.) Add
`#![no_std]` at the top of `src/main.rs`, delete the `println!`, and build again:

```text
error: `#[panic_handler]` function required, but not found
```

A panic has to go *somewhere*. On macOS, `std` prints the message and ends the process; here there
is no screen and no process to end. Rust makes you decide, by writing one function marked
`#[panic_handler]`. It receives a `&PanicInfo` and returns `!` ("never returns"), because there is
nothing sensible to return to. Ours will loop forever for now; macvmm's guests instead tell the VMM
"I failed" and stop (chapter 03).

Add it, build again, and meet the last error:

```text
error: using `fn main` requires the standard library
  |
  = help: use `#![no_main]` to bypass the Rust generated entrypoint and declare a platform specific entrypoint yourself, usually with `#[no_mangle]`
```

## What `no_main` takes away

Your `fn main` is never the first code that runs. On macOS, the kernel and `dyld` load the program
and call a C-style `main` that `rustc` generates for you; that one calls `std::rt::lang_start`,
which sets up a few things (command-line arguments, a guard page against stack overflow) and only
then calls your `main`. All of that machinery is `std`, so without `std` there is no `fn main` in
the usual sense. `#![no_main]` tells `rustc` not to generate any of it.

File `src/main.rs`, version 1:

```rust
#![no_std]
#![no_main]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}
```

```sh
cargo build --target aarch64-unknown-none
```

```text
warning: linker stderr: rust-lld: cannot find entry symbol _start; not setting start address
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s
```

It builds, and the program is empty. Nothing calls `panic`, so the linker throws it away, and
`llvm-readobj --file-headers` on the result shows `Entry: 0x0`. The warning is the real lesson: the
**linker**, the tool that glues the compiler's pieces into one file and decides where each piece
lives in memory, looks for a symbol named `_start` as the place execution begins. Nobody wrote one.

## Giving the program an entry

On bare metal, "the program starts" means something very physical: the PC holds an address, and
the CPU fetches the four bytes there as an instruction. In macvmm, the VMM sets the vCPU's PC
before the first run (chapter 02). So we need a function whose name the linker can find and whose
code sits where the PC will point. A **symbol** is exactly such a name: a string in the compiled
file that the linker maps to an address (a function's first instruction, or a variable's first
byte).

File `src/main.rs`, version 2 (the panic handler from version 1 stays below it):

```rust
#![no_std]
#![no_main]

use core::hint::black_box;
use core::panic::PanicInfo;
use core::sync::atomic::{AtomicU32, Ordering::Relaxed};

static GREETING: [u8; 6] = *b"hello\n"; // never changes
static BOOTS: AtomicU32 = AtomicU32::new(7); // starts non-zero
static COUNTER: AtomicU32 = AtomicU32::new(0); // starts at zero

#[unsafe(no_mangle)]
#[unsafe(link_section = ".text.boot")]
pub extern "C" fn _start() -> ! {
    black_box(&GREETING);
    BOOTS.store(BOOTS.load(Relaxed) + 1, Relaxed);
    loop {
        COUNTER.store(COUNTER.load(Relaxed) + 1, Relaxed);
    }
}
```

Three attributes carry the weight:

- `#[unsafe(no_mangle)]` keeps the symbol's name exactly `_start`. Rust normally encodes the crate
  and a hash into every name (you will see one in a moment), so two functions called `panic` in
  different crates never collide. Here we *want* a fixed, global name. Edition 2024 spells it
  `unsafe(...)` because if some other code also defines a global `_start`, the linker may silently
  pick the wrong one, and the compiler cannot check for that. In Rust, "the compiler cannot check
  this, you promise it is fine" is what `unsafe` means.
- `#[unsafe(link_section = ".text.boot")]` puts this function's code in a piece named
  `.text.boot`, so the linker script can place it first. Hold that thought.
- `extern "C"` gives the function the standard Arm **calling convention**: the agreement on which
  registers carry a function's arguments and return value, and which registers a function must
  leave as it found them. Arm's is called AAPCS64 (more in `aarch64-reading`). Rust's own
  convention is unspecified and may change; in chapter 03, assembly code calls into Rust, and
  assembly needs a convention it can rely on.

The three statics are there to be found later: one for each kind of data a program has. The
`black_box` stops the optimiser from deleting `GREETING` as unused. Why atomics? Safe Rust does not
let you change an ordinary `static` (that needs `static mut` and `unsafe`), but an atomic can be
changed through a shared reference, safely. `Relaxed` asks for no ordering guarantees between
threads, which is all a single-threaded program needs. We call `load` and `store` rather than
`fetch_add` only so the disassembly stays a list of plain loads and stores.

## Sections: sorting a program by what it needs

The compiler does not hand the linker one blob. It hands over named pieces called **sections**,
sorted by what the bytes need at run time:

| Section | Holds | In our program | Needs bytes in the file? |
|---|---|---|---|
| `.text` | machine code | `_start` | yes |
| `.rodata` | constants, never written | `GREETING` | yes |
| `.data` | variables that start non-zero | `BOOTS` (7) | yes |
| `.bss` | variables that start at zero | `COUNTER` (0) | **no** |

Why sort at all? Two reasons. Permissions: the **MMU** (memory management unit) is the part of the
CPU that translates addresses and enforces per-region permissions. Once a program turns it on (our
tiny guest never does), code can be made executable and read-only, constants read-only, and
variables writable but never executable (the [`page-tables`](/build-your-own/vmm/primers/page-tables/) primer).
And size: if a variable starts at zero, there is no point storing its zeros in the file. The file
records only "this many bytes, all zero", and somebody must write the zeros at start-up. That
zero-initialised region is called the **BSS** (the name is a fossil from a 1950s assembler,
"Block Started by Symbol"; nobody expands it in conversation).

Rust picks the section from the type. `GREETING` is an immutable static, so it is a constant.
`BOOTS` and `COUNTER` are atomics, which can change even through a shared, read-only-looking
reference (Rust calls this **interior mutability**), so they are variables: `.data` if the initial
value has any non-zero byte, `.bss` if every byte is zero.

One case surprises people: `static A: u64 = 0;` goes to `.rodata`, not `.bss`. It is zero, but it
can never change, so it is a constant. We checked: adding it to the program below puts it next to
`GREETING`, with the letter `r` in `llvm-nm`'s output. "Starts at zero" only sends *variables* to
the BSS.

## The linker script: putting `_start` at `0x4008_0000`

The linker decides the final address of every section. By default it uses rules meant for a
program an OS will load. We want something exact: the VMM will copy our bytes to guest address
`0x4008_0000` and set the PC there. Why that address? Guest RAM starts at `0x4000_0000` in macvmm's
memory map (it mirrors QEMU's `virt` machine), and macvmm keeps the first 512 KiB of RAM for the
**device tree**: a small data blob, written by the VMM, that describes the machine's hardware (how
much RAM, where each device lives) to the guest. Chapter 10 builds it. `0x4000_0000 + 0x8_0000` is
the first byte after that reserved space.

A **linker script** is the instruction sheet for the linker. File `link.ld`, in the project's top
directory next to `Cargo.toml`:

```text
ENTRY(_start)

SECTIONS
{
  . = 0x40080000;

  .text   : { KEEP(*(.text.boot)) *(.text .text.*) }
  .rodata : { *(.rodata .rodata.*) }
  .data   : { *(.data .data.*) }

  .bss (NOLOAD) : ALIGN(16) {
    __bss_start = .;
    *(.bss .bss.*)
    . = ALIGN(16);
    __bss_end = .;
    . += 0x4000;               /* 16 KiB for the stack */
    __stack_top = .;
  }

  /DISCARD/ : { *(.eh_frame*) *(.comment) }
}
```

Two ideas first. The compiler's object files contain **input sections** (`.text.boot`,
`.text._ZN...`, `.rodata.foo`, one or more per function or static); the linker gathers them into
the **output sections** of the finished file (`.text`, `.rodata`, ...). Inside `SECTIONS { }`, the
dot `.` is the **location counter**: the address the next byte will get. It moves forward by
itself as sections are placed, and you can also set it. Now line by line:

- `ENTRY(_start)` records `_start`'s address in the file's header as "the entry point".
- `. = 0x40080000;` starts the location counter at our load address.
- `.text : { KEEP(*(.text.boot)) *(.text .text.*) }` makes an output section `.text`. Read
  `*(.text.boot)` as "from every input file (`*`), take the sections named `.text.boot`". Patterns
  are placed in the order written, so our `_start` lands first, at exactly `0x40080000`. `KEEP`
  stops the linker from discarding it as unreferenced: nothing in the program calls `_start`, only
  the CPU does.
- `.rodata` and `.data` follow the same pattern, each starting where the previous one ended.
- `.bss (NOLOAD) : ALIGN(16)` makes the BSS, starting at the next multiple of 16. `NOLOAD` means
  "takes space in memory, but no bytes in the file".
- `__bss_start = .;` and `__bss_end = .;` define **symbols in the script**: names for the current
  address, with no storage of their own, so start-up code can find the BSS. `. = ALIGN(16);`
  rounds the counter up to a multiple of 16.
- `. += 0x4000;` moves the counter 16 KiB forward without placing anything: that empty space is
  our stack, and `__stack_top` names its upper end.
- `/DISCARD/` is a special name: whatever it collects is thrown away. Here, unwinding tables
  (`.eh_frame`, unused since we abort on panic) and a compiler banner (`.comment`).

`ENTRY(_start)` only writes `_start`'s address into the ELF header. Remember that; it matters
soon.

Two small files tell Cargo to use this target and this script. The project now looks like this:

```text
bare/
  Cargo.toml
  build.rs              <- new
  link.ld               <- new
  .cargo/config.toml    <- new
  src/main.rs
```

File `.cargo/config.toml` makes `aarch64-unknown-none` the default target, so from here on a plain
`cargo build` means what `cargo build --target aarch64-unknown-none` meant before:

```toml
[build]
target = "aarch64-unknown-none"
```

File `build.rs`:

```rust
fn main() {
    // Hand our linker script to the linker, and relink when it changes.
    println!("cargo:rustc-link-arg=-Tlink.ld");
    println!("cargo:rerun-if-changed=link.ld");
}
```

A **build script** is a small separate program that Cargo compiles and runs *on your Mac*, before
building the crate. It runs on the host, so it has `std` and `println!` is fine. Cargo reads
the lines it prints that start with `cargo:` as instructions. `cargo:rustc-link-arg=-Tlink.ld`
passes `-Tlink.ld` to the linker, which means "use this linker script". The second line is not
decoration. Cargo tracks Rust sources, not linker scripts; without it, you
edit `link.ld`, rebuild, see `Finished` in zero seconds, and stare at a binary that ignored you.
(Ask us how we know.)

```sh
cargo build --release
```

```text
   Compiling bare v0.1.0 (...)
    Finished `release` profile [optimized] target(s) in 0.29s
```

We use `--release` throughout. In a debug build, `+ 1` checks for overflow and can panic, so the
panic machinery and its message strings get linked in and the sections grow more than tenfold.

## Reading what the linker made

The llvm tools that ship with Rust can take the result apart. Install them once and remember where
they live:

```sh
rustup component add llvm-tools
LLVM="$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin"
"$LLVM/llvm-nm" -n -C target/aarch64-unknown-none/release/bare
```

```text
0000000040080000 T _start
0000000040080038 r bare::GREETING
0000000040080040 d bare::BOOTS (.0)
0000000040080050 b bare::COUNTER (.0)
0000000040080050 B __bss_start
0000000040080060 B __bss_end
0000000040084060 B __stack_top
```

`_start` is at `0x40080000`, as ordered. The letter is the section: `T` text, `r` read-only data,
`d` data, `b`/`B` BSS. Every static went where the table above predicted, and `__stack_top` sits
16 KiB (`0x4000`) above `__bss_end`.

`llvm-size -A` gives the same picture as one size per section:

```sh
"$LLVM/llvm-size" -A target/aarch64-unknown-none/release/bare
```

```text
section      size         addr
.text          56   1074266112
.rodata         6   1074266168
.data           4   1074266176
.bss        16400   1074266192
Total       16466
```

The addresses are printed in decimal (`1074266112` is `0x40080000`). `.bss` is 16,400 bytes:
16 for `COUNTER` (4 bytes, rounded up to 16) plus the 16,384-byte stack.

> **Aside.** Drop the `-C` (demangle) flag and `GREETING` appears as something like
> `_RNvCs2IAovmNIQZv_4bare8GREETING`: Rust's mangling scheme, "v0", with the crate name `bare`,
> the item name `GREETING`, their lengths, and a hash. Your hash will differ; that is the point of
> a hash. This is the name `no_mangle` protected `_start` from.

Now disassemble `_start`, using what you learned in `aarch64-reading`:

```sh
"$LLVM/llvm-objdump" -d --no-show-raw-insn target/aarch64-unknown-none/release/bare
```

```text
0000000040080000 <_start>:
40080000:      	sub	sp, sp, #0x10
40080004:      	nop
40080008:      	adr	x8, 0x40080038 <_RNvCs2IAovmNIQZv_4bare8GREETING>
4008000c:      	str	x8, [sp, #0x8]
40080010:      	add	x8, sp, #0x8
40080014:      	adrp	x8, 0x40080000 <_start>
40080018:      	ldr	w9, [x8, #0x40]
4008001c:      	add	w9, w9, #0x1
40080020:      	str	w9, [x8, #0x40]
40080024:      	adrp	x8, 0x40080000 <_start>
40080028:      	ldr	w9, [x8, #0x50]
4008002c:      	add	w9, w9, #0x1
40080030:      	str	w9, [x8, #0x50]
40080034:      	b	0x40080028 <_start+0x28>
```

Fourteen instructions of 4 bytes each, `0x38` bytes. The last five lines are the loop: load
`COUNTER`, add 1, store it back, branch back to the load.

How does `adrp x8, 0x40080000` followed by `ldr w9, [x8, #0x50]` reach `COUNTER`? `adrp` takes the
PC, clears its low 12 bits (rounding down to a 4 KiB "page" boundary) and adds a page offset coded
in the instruction, here 0. At PC `0x40080014` that gives `0x40080000`. The `ldr` then adds `0x50`:
`0x40080000 + 0x50 = 0x40080050`, `COUNTER`'s address in the table above. `adr`, two lines earlier,
is the same idea without the rounding: PC plus an offset. Both are **PC-relative**, which matters
in a moment.

Keep the two instructions that use `sp` in mind, the `sub sp` at `0x40080000` and the `str` at
`0x4008000c`; we come back to them at the end.

## BSS: bytes the file does not carry

A program file is more than its sections. The linker also writes **program headers**, one per
region a loader must place in memory. Each says where the region goes, how many bytes to copy from
the file (**`filesz`**) and how big the region is in memory (**`memsz`**):

```sh
"$LLVM/llvm-readobj" --program-headers target/aarch64-unknown-none/release/bare
```

Trimmed to the fields that matter:

```text
    Type: PT_LOAD (0x1)
    Offset: 0x10000
    VirtualAddress: 0x40080000
    FileSize: 56
    MemSize: 56
    Flags: PF_R PF_X
    Type: PT_LOAD (0x1)
    Offset: 0x10038
    VirtualAddress: 0x40080038
    FileSize: 6
    MemSize: 6
    Flags: PF_R
    Type: PT_LOAD (0x1)
    Offset: 0x10040
    VirtualAddress: 0x40080040
    FileSize: 4
    MemSize: 16416
    Flags: PF_R PF_W
    Type: PT_GNU_STACK (0x6474E551)
    ...
```

`PT_LOAD` means "a loader must place this region in memory". There are three because the regions
need different permissions (the `Flags`: read, write, execute): `.text` is read and execute,
`.rodata` read only, and `.data` plus `.bss` read and write. `Offset` is where the region's bytes
sit inside the file; the linker starts them at `0x10000` (64 KiB in), which is why the file is much
bigger than the program. The last entry, `PT_GNU_STACK`, places nothing; ignore it.

Look at the third `PT_LOAD`. Four bytes of file (`BOOTS`, the value 7) become 16,416 bytes of memory: `.data`, padding, and
`.bss` including our 16 KiB stack. A **loader** (whatever program puts this one into memory: `dyld`
on a Mac, the VMM for our guest) that understands this format copies 4 bytes and zeroes the other
16,412. The format, by the way, is **ELF** (Executable and Linkable Format), a container
that records sections, program headers, symbols and the entry address. It gets its own primer
([`elf`](/build-your-own/vmm/primers/elf/)) before chapter 13; for now, `filesz` and `memsz` are the two fields you need.

## Load address versus run address

There are two addresses hiding behind "where the program goes". The **run address** is the
address the linker assumed when it fixed up the code: where the program must be when it runs. The
**load address** is where somebody actually puts the bytes. GNU ld's manual calls them the VMA and
LMA (virtual and load memory address); `llvm-readobj` prints them as `VirtualAddress` and
`PhysicalAddress`. Do not read too much into "virtual": with the MMU off, as here, every address is
a plain physical address, and these are just the tools' historical names for "run" and "load". In
our file they are equal.

What happens if they disagree? Look at the disassembly again. `adr` and `adrp` compute addresses
*relative to the PC*, so this particular code would find its data even if loaded somewhere else.
Work it through: load the same bytes at `0x40100000` instead. The `adrp` is now at `0x40100014`,
rounds down to `0x40100000`, and the `ldr` adds `0x50`: `0x40100050`, which is exactly where
`COUNTER` now is, because it moved by the same amount.

But the linker can also write an absolute address into the bytes. Add one more static and pass
its address to `black_box` (fragment, `src/main.rs`):

```rust
static WHERE: &[u8; 6] = &GREETING; // an address, stored as data
// in _start, replace black_box(&GREETING) with:
black_box(&WHERE);
```

The new static shifts the layout: `WHERE` (8 bytes, a pointer) takes `0x40080038`, `GREETING`
moves up to `0x40080040` and `BOOTS` to `0x40080048`. After a rebuild and the flattening step of
the next section, the bytes at `0x40080038` read `4000 0840 0000 0000`. Arm stores multi-byte
values **little-endian**, least significant byte first, so read those bytes backwards:
`00 00 00 00 40 08 00 40` is `0x4008_0040`, `GREETING`'s address. That number is now part of the
program. Load the program anywhere but `0x4008_0000` and `WHERE` points at whatever happens to live
at `0x4008_0040`. Every pointer stored in a static works this way, and so do tables the compiler
builds for you, such as the jump table behind a large `match`. So our rule is blunt: **the load
address must equal the link address.**

Now undo the `WHERE` change (delete the static and restore `black_box(&GREETING)`), so that the
numbers in the rest of this primer match yours.

> **Under the hood** (optional; it previews later chapters). Load and run addresses differ on
> purpose in firmware, the first code a real board runs. A board boots from
> read-only flash, but `.data` must be writable, so the linker script places `.data` with
> `AT> FLASH` (load address in flash, run address in RAM) and start-up code copies it across
> before anything touches it. U-Boot, which macvmm boots from emulated flash in chapter 21, goes
> further and copies its whole self to the top of RAM, patching its own absolute addresses as it
> goes. The Linux `Image` is built to cope with being placed anywhere the boot protocol allows
> (chapter 13, [`arm64-boot-protocol`](/build-your-own/vmm/primers/arm64-boot-protocol/)).

## From ELF to flat binary

Here is the catch with ELF. Our VMM's simplest loader, `--raw FILE@ADDR` in chapter 03, copies a
file's bytes to guest memory and points the PC at the first one. Look at the first bytes of our
ELF:

```sh
head -c 16 target/aarch64-unknown-none/release/bare | xxd
```

```text
00000000: 7f45 4c46 0201 0100 0000 0000 0000 0000  .ELF............
```

`7f 45 4c 46` is the ELF magic number, not an instruction. Copy this file to `0x4008_0000` and the
CPU's first fetch is a header. What we want is a **flat binary**: the bytes of memory, in address
order, starting at the first loadable address, and nothing else. `llvm-objcopy` produces it:

```sh
"$LLVM/llvm-objcopy" -O binary target/aarch64-unknown-none/release/bare bare.bin
wc -c < bare.bin
```

> **Predict.** The ELF is about 67 KB on our machine (it pads each region to a 64 KiB file offset
> and carries a symbol table). The program's memory image runs from `0x4008_0000` to
> `__stack_top`, more than 16 KiB. How many bytes will `bare.bin` hold? Hint: use the `llvm-nm`
> addresses above, ask which sections need bytes in a file, and remember `.data` starts at
> `0x40080040`, not straight after `.rodata`.

```text
      68
```

Sixty-eight. Dump them:

```sh
xxd bare.bin
```

```text
00000000: ff43 00d1 1f20 03d5 8801 0010 e807 00f9  .C... ..........
00000010: e823 0091 0800 0090 0941 40b9 2905 0011  .#.......A@.)...
00000020: 0941 00b9 0800 0090 0951 40b9 2905 0011  .A.......Q@.)...
00000030: 0951 00b9 fdff ff17 6865 6c6c 6f0a 0000  .Q......hello...
00000040: 0700 0000                                ....
```

`xxd` prints the file's bytes in order, grouped in pairs; it does not reorder anything. Every byte
is accounted for. `0x00` to `0x37` is `.text`: fourteen instructions, each a 4-byte word stored
little-endian. The first word's bytes are `ff 43 00 d1`; read backwards that is `0xd10043ff`, the
encoding of `sub sp, sp, #0x10` (the `a64-encoder` lab from `aarch64-reading` decodes it). `0x38`
is `hello\n`, then two bytes of padding (`0x3e`, `0x3f`) because `.data` is placed at the next
16-byte boundary, then `07 00 00 00` at `0x40`, `BOOTS`. That is `0x38 + 6 + 2 + 4 = 68`. The file
ends there. `.bss`, `COUNTER` and the stack occupy memory from `0x4008_0050` up, but because they
are `NOLOAD` and come last, they contribute nothing.

The flat binary has also forgotten everything the ELF knew: no entry address (`ENTRY(_start)` is
gone, which is why `_start` must be the *first* byte), no `memsz`, no section names. The person
loading it supplies the address, and the program must zero its own BSS.

```text
ELF file (~67 KB)          flat binary (68 B)        guest memory after --raw @0x40080000
+--------------------+     +------------------+      +----------------------------+ 0x40080000
| header, entry      |     | .text    0x38    |      | .text  (_start first)      |
| program headers    | --> | .rodata  0x6     | -->  | .rodata, pad, .data        |
| .text .rodata .data|     | pad, .data 0x4   |      +----------------------------+ 0x40080044
| .bss: size only    |     +------------------+      | 12-byte gap (align to 16)  |
| symbols            |      objcopy -O binary        +----------------------------+ 0x40080050
+--------------------+                               | .bss + stack: old contents |
                                                     | of RAM. Zero it yourself!  |
                                                     +----------------------------+ 0x40084060
                                                       (first 68 bytes copied by the VMM)
```

*What to notice: the ELF knows the BSS exists; the flat binary does not; guest memory beyond byte
68 is whatever was there before. The BSS starts at `0x40080050`, not `0x40080044`, because the
script aligns it to 16; those 12 bytes are not in the file either.*

> **Try it.** Add a section far away in `link.ld`, for example
> `.far 0x40180000 : { BYTE(1) }` before `.bss`, rebuild and flatten. The new section starts
> `0x40180000 - 0x40080000 = 0x100000` bytes (1 MiB) after `_start` and holds 1 byte, so
> `bare.bin` becomes `0x100001` = 1,048,577 bytes. A flat binary has no headers saying "skip
> ahead", so the only way `objcopy` can keep every byte at its offset is to write out the gap as
> zeros. (The BSS escapes this only because it comes *last*: nothing after it needs an offset.) A
> stray section at address 0 would make a gigabyte-sized file. Remove `.far` afterwards.

> **Security.** From the VMM's side, a flat binary is untrusted input with no structure to
> validate: the only facts are its length and the address the user asked for. Chapter 03's raw
> loader therefore checks that `ADDR` lies in guest RAM and that `ADDR + length` neither overflows
> nor runs past the end of RAM (`checked_add`, not `+`), before copying a single byte. Why
> overflow? Addresses are 64-bit numbers, and a plain `+` in release Rust wraps around:
> `0xffff_ffff_ffff_f000 + 0x2000` gives `0x1000`, which looks small and passes a naive
> "end <= end of RAM" check, while the copy runs off the top of memory. `checked_add` returns
> `None` instead, and the loader refuses the file.

## Nothing in the CPU gives you a stack

First, what a stack is. Every function needs scratch memory: room for local variables that do
not fit in registers, and for the return address when it calls another function. That memory is
the **stack**, a region used top-down: a function reserves space by moving a pointer down, and
gives it back by moving it up on return. The pointer is the register **`sp`** (stack pointer).
On Arm each exception level (privilege level, from `aarch64-reading`) has its own `sp`, which is
why the manuals speak of "stack pointers", plural.

Now go back to the two instructions of `_start` that use `sp`:

```text
40080000:      	sub	sp, sp, #0x10
4008000c:      	str	x8, [sp, #0x8]
```

The compiler assumed, reasonably, that `sp` points at a usable stack: it reserved 16 bytes by
moving `sp` down and stored into them. On macOS that assumption always holds, because the kernel
builds a stack for every thread before running a single instruction. On bare metal, who did?
Nobody. The Arm architecture says the stack pointers are UNKNOWN out of reset (a defined term in
the Arm manual: the value could be anything, and software must not rely on it; *Arm Architecture
Reference Manual*, chapter D1, on the processor state at reset). A **boot protocol** is the
written contract between a loader and the program it starts, listing what each register holds at
entry. Linux's, which our VMM follows for real kernels, specifies `x0` to `x3` (`x0` holds the
device tree's address) but says nothing about `sp`. A store through an unknown `sp` writes
somewhere random, or faults, and the guest dies before it has printed a byte.

Could the VMM not just set `sp`, the way it sets the PC? It could; it is one more register. We do
not rely on it, because our guests should also run when started by firmware or by another loader
that follows the same contract, and the contract does not promise a stack. A program that sets
its own stack works under every loader; one that expects the VMM to do it works under one.

And `COUNTER` is no safer: the program believes it starts at zero, yet nobody wrote that zero.

So the very first code of a bare-metal program cannot be compiled Rust. It has to be a few
instructions of assembly that set `sp` to `__stack_top`, write zeros from `__bss_start` to
`__bss_end`, and only then call Rust. AAPCS64 requires `sp` to be 16-byte aligned at all times
(§6.4.5.1, the universal stack constraints), and the CPU can be set to fault on a misaligned `sp`;
that is why the script aligns everything to 16. That short piece of assembly is where chapter 03
begins.

## Lab

:::lab linker-map
:::

Optional, and it runs in your browser on the course site (no Mac needed). Goal: predict where the
linker puts every byte, then check yourself.

In the `linker-map` lab you get the statics and the linker script from this primer on one screen.
Drag sections into a different order, change the start address or the stack size, and watch three
views update together: the address of every symbol, each program header's `filesz` and `memsz`,
and the exact bytes `objcopy` would write, with the gap-filling and the missing BSS highlighted.
Try to make the flat binary larger without adding any code (recall the `.far` experiment). Then
move `.rodata` in front of `.text`, so `_start` is no longer the first byte, and see what the CPU
would execute instead (recall that a raw loader starts at the first byte, and that the bytes of
`hello\n` are not instructions).

## Self-check

Commit to an answer before you reveal it.

:::predict Your crate builds for `aarch64-unknown-none` with only a warning, but `llvm-readobj` says `Entry: 0x0` and `.text` is missing. What happened?
No symbol named `_start` existed (the linker warned "cannot find entry symbol _start"). The linker
keeps only code reachable from the entry point (or marked `KEEP`); with no entry, nothing was
reachable, so it discarded all of it, the panic handler included. Add `_start` with
`#[unsafe(no_mangle)]` and keep it with `KEEP(...)` in the linker script.
:::

:::predict Which section does each static land in? (a) `static A: u64 = 0;` (b) `static B: AtomicU64 = AtomicU64::new(0);` (c) `static C: AtomicU64 = AtomicU64::new(1);`
(a) `.rodata`: it is immutable, so it is a constant, even though it is zero. (b) `.bss`: it can
change and starts all-zero. (c) `.data`: it can change and starts non-zero. Confirm with
`llvm-nm -n -C`: `r`, `b`, `d`.
:::

:::predict A program header says `FileSize: 4096` and `MemSize: 69632`. What must happen to the other 65,536 bytes, and who does it when the program is a flat binary?
They must be zeroed (they are BSS, and here probably a stack). An ELF loader would do it from
`memsz`, but a flat binary does not record `memsz`, so the program's own start-up code zeroes the
range between its linker-script symbols. (Same shape as our third `PT_LOAD`: 4 bytes of file,
16,416 of memory.)
:::

:::predict You link a guest for `0x4008_0000` but load the flat binary at `0x4010_0000`. Its code uses only `adr`/`adrp` to reach data, but one static holds `&GREETING`. What breaks, and what does not?
PC-relative code keeps working, because code and data moved together (as in the worked
`0x40100000` example, `adrp` now yields the new page). The static still contains the
absolute link-time address of `GREETING` (`0x4008_xxxx`), so following that pointer reads the wrong
memory. Rule: load address must equal link address unless the program relocates itself.
:::

:::predict Why is `KEEP(*(.text.boot))` listed first in `.text`, when `ENTRY(_start)` already names the entry point?
`ENTRY` only fills in the ELF header's entry field, which `objcopy -O binary` throws away. A raw
loader starts the CPU at the first byte, so `_start` must be that byte. `KEEP` prevents the linker
from discarding a function nothing calls.
:::

:::predict Why can't `_start` be written in ordinary Rust, even with `no_std` and `no_main`?
Compiled Rust assumes a valid, 16-byte-aligned `sp` and zero-initialised statics. On entry neither
is true: `sp` is whatever the CPU or VMM left there, and BSS holds whatever RAM held. A few
instructions of assembly must set `sp` and zero BSS before any Rust runs.
:::

## Where this shows up in macvmm

- [Chapter 03, test-guests](/build-your-own/vmm/bare-machine/test-guests/) (requires this primer):
  the guests in `guests/` are `no_std`, `no_main` programs for `aarch64-unknown-none`, linked by a
  shared linker script at `0x4008_0000`, flattened by the build script, and loaded with
  `--raw hello.bin@0x40080000`. The lesson writes the assembly `_start` (set `sp`, zero BSS, call
  Rust), a panic handler that reports failure to the VMM, and the raw loader with its bounds
  checks. Its BSS example is the `COUNTER` you met here.
- [Chapter 13, loaders](/build-your-own/vmm/linux/loaders/): the ELF loader reads the program
  headers you saw here and honours `filesz` versus `memsz`; the arm64 `Image` loader handles a
  kernel that is itself a flat binary with a header in front (`elf` and `arm64-boot-protocol`
  primers).
- [Chapter 21, firmware](/build-your-own/vmm/firmware/firmware/): U-Boot arrives as a flat
  `u-boot.bin` and copies itself from flash to RAM, the load-versus-run story in the wild.

## Going further

- *The Rust Reference*, "Preludes" (the `no_std` attribute), "Crates and source files" (`no_main`)
  and "The Rust runtime" (`#[panic_handler]`): https://doc.rust-lang.org/reference/ . The rustc book's "Platform Support"
  page lists `aarch64-unknown-none` and its tier: https://doc.rust-lang.org/rustc/platform-support.html
- GNU ld manual, §3.1 "Basic Linker Script Concepts" (sections, VMA and LMA) and §3.6 "SECTIONS
  Command" (`KEEP`, `NOLOAD`, `/DISCARD/`, `AT>`). LLVM's `ld.lld`, which `rust-lld` is, follows
  the same language. LLVM's `llvm-objcopy` command guide documents `-O binary`.
- Arm, *Procedure Call Standard for the Arm 64-bit Architecture* (AAPCS64), §6.4.5 "The Stack";
  and the *Arm Architecture Reference Manual* (DDI 0487), chapter D1, the processor state on reset.
- Linux, `Documentation/arch/arm64/booting.rst`, "Call the kernel image": the registers a kernel
  may rely on at entry (and the absence of a stack among them).

## Checkpoint

- **What you can do now.** Build a `no_std`, `no_main` program for `aarch64-unknown-none`, place
  `_start` at `0x4008_0000` with a linker script, and explain every byte of its flat binary. Verify
  with `wc -c < bare.bin`, which prints `68` for the program in this primer, and
  `llvm-nm -n -C`, which shows `_start` at `0000000040080000`. (If you kept the `WHERE` static or
  the `.far` section from the experiments, remove them first: `WHERE` makes the file 76 bytes and
  `.far` makes it 1,048,577.)
- **What's next.** Chapter 03 hands these 68 bytes' bigger sibling to a real vCPU. Before it can
  say hello, it needs the dozen lines of assembly this primer kept pointing at: a stack, a zeroed
  BSS, and a way to talk to the VMM.
- **One open question.** We zero the BSS from code that lives inside the program. But the stack
  is inside the BSS too, and the zeroing loop runs before any stack exists. What would go wrong if
  that loop were written in Rust and the compiler decided to spill a register to the stack halfway
  through? (A **spill** is the compiler saving a register's value to the stack because it ran out
  of registers, like the `str x8, [sp, #0x8]` you saw. Hint: where does `sp` point before anyone
  sets it, and if it already pointed into the stack, what is the loop about to write there?)
