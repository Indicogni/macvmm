---
title: A device is a state machine: the bus, PL011 and PL031
part: IV
chapter: IV.1
id: 09
runs: mac+browser
minutes: 240
prereqs: [08]
start_tag: ch-08
labs: [pl011-poke, lock-order, ansi-filter]
command: scripts/checkpoint.sh 09
expect: CHECKPOINT 09 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** a device as a state machine with side-effecting reads; the frozen `MmioDevice`, `AccessSize` and `Bus` types; a device that answers every offset and width of its window (RAZ/WI plus a rate-limited warning); filtering guest output, and restoring the terminal on every exit path; the `AtomicBool` stop flag in `control.rs`, and the kick that makes a running vCPU see it.
- **Core, from earlier:** the `--timeout` deadline (chapter 03); stage-2 holes, the machine's memory map and the unhandled-MMIO policy (chapter 05); decoding a memory-mapped I/O (MMIO) access, the one-entry bus and the exit trace (chapter 07); RAZ/WI and the exit codes (chapter 08).
- **Primers (read first):** `primecell-ids` (the eight identification bytes at `0xFE0` and how Linux matches on them); `host-concurrency` (threads, `Arc`, `Mutex`, atomics, lock order; its `lock-order` lab); `unix-signals` (SIGINT, SIGTERM, exit code 130, the self-pipe trick); `tty-termios` (raw mode, `stty -g`, escape sequences; its `ansi-filter` lab).
- **Primers (review):** `reading-arm-specs` (register pages, RAZ/WI); `os-basics` (what an interrupt is).
- **Pointers:** UART (universal asynchronous receiver-transmitter) basics, with the PL011 technical reference manual (ARM DDI 0183), an Aside; the PL031 manual (ARM DDI 0224); panics and panic hooks (`std::panic::set_hook`), an Aside.
- **Forward definitions:** interrupt status and mask (`RIS`, `MIS`, `IMSC`), a latched bit, a level-triggered line and the interrupt line a device drives (chapters 11 and 12); terminal injection (chapter 25); the interrupt controller's per-CPU frames (chapter 12). Each is defined at first use.
:::

Type `ping` and press Enter. The five bytes travel from your keyboard into a queue inside the serial port your virtual machine monitor (VMM) emulates, where a guest program sits in a loop, waiting for them. Now change one thing: the port's status register always answers "nothing received". The bytes are still in the queue.

:::predict The UART holds `ping` and a newline in its receive queue, but its flag register `FR` always reports `RXFE = 1`, "receive queue empty". Does the guest print `pong` anyway?
Write your answer and one sentence of reasoning under `## Predict` in your journal. Sitting A builds the device; sitting B runs this experiment.
:::

This chapter closes row 3 of chapter 00's problem ledger, devices at fixed physical addresses: since chapter 05, `0x0900_0000` has been a hole that stops the guest; by the end, a serial port answers there, with a clock beside it. Sitting A is the device itself, checked by host tests, no guest needed (about 2 hours); sitting B is the host side, threads, terminal and signals, then the clock and the bus (about 2 hours).

:::objectives
- (Sitting A) Implement the PL011 registers that Linux and U-Boot use (`DR`, `FR`, `IBRD`, `FBRD`, `LCR_H`, `CR`, `IFLS`, `IMSC`, `RIS`, `MIS`, `ICR`, plus the stored-only `RSR`, `ILPR` and `DMACR`) and the identification registers at `0xFE0` to `0xFFC`, as a state machine in which a `DR` read pops the receive FIFO (first in, first out queue).
- (Sitting A) Make the device total over its 4 KiB window: answer every offset and every access width, with RAZ/WI and a rate-limited warning for what names no register; predict the value of `FR`, `RIS` and `MIS` in hex after a sequence of accesses.
- (Sitting B) Feed received bytes from a stdin thread through a bounded `SerialInput`, filter guest output before it reaches the terminal, choose where it goes with `--serial stdio|file:F|none`, and restore the terminal on every exit path (normal stop, Ctrl-A x, SIGINT and SIGTERM, a panic).
- (Sitting B) Implement the stop flag and the kick, and explain with an example why the `Mutex` around each device is needed (the stdin thread is a real second thread) and in which order two locks are taken.
- (Sitting B) Implement PL031 reads from the host's wall clock, then turn chapter 07's bus into the checked `Bus`, which refuses overlapping, empty and overflowing windows when they are inserted.
:::

**Before you start.** From the repository root, run `scripts/learner start 09`. It copies this chapter's journal to `learner/journal/09.md`. The code goes into your `learner/` workspace, in the files named above each block; the checkpoint tests your crates through the same public names. Before sitting B, do the `lock-order` lab in the `host-concurrency` primer.

## What a guest asks of a serial port

A [UART](/build-your-own/vmm/glossary/#uart) (universal asynchronous receiver-transmitter) is the oldest console there is: the guest stores a byte to one address to send it, and loads from the same address to receive one. Ours is Arm's [PL011](/build-your-own/vmm/glossary/#pl011), at `0x0900_0000`, where QEMU's `virt` machine puts it, so stock kernels and firmware find their console with no help from us.

> **Aside.** A real UART sends a byte one bit at a time, at a rate set by a divisor of its clock (the baud rate), and buffers bytes in two small queues, one for transmit (TX) and one for receive (RX). The PL011's manual, the technical reference manual (TRM) ARM DDI 0183, is free from Arm's developer site; chapter 3, "Programmers Model", is the part we implement.

Here is how our test guests drive it, from `guests/common/uart.rs`. Every `read` and `write` is a load or store at the UART's address:

:::code anchor=guest_uart_poll file=guests/common/uart.rs

Read it as the device would. The guest asks `FR`, the flag register, before every move: `TXFF` (transmit FIFO full) before it sends, `RXFE` (receive FIFO empty) before it reads. Only then does it touch `DR`, the data register. A [FIFO](/build-your-own/vmm/glossary/#fifo) (first in, first out) is the device's small queue.

Every one of these accesses lands in a stage-2 hole, so each is a data abort. Chapter 07's decoder turns it into "a 4-byte load from `0x9000018` into `w11`"; the trace prints addresses without the underscores, so `0x9000018` is `0x0900_0018`, the UART's base plus `0x18`, which is `FR`. What the guest knows about the device is exactly what those loads return.

## Registers with consequences

The registers our model implements, with their names from the TRM (the PL011 calls them `UARTDR` and so on; we drop the prefix):

| Offset | Register | What our model does |
|---|---|---|
| `0x000` | `DR`, data | write: send the low byte; read: pop the RX FIFO (0 when empty) |
| `0x004` | `RSR`, receive status | reads 0 (no line errors ever happen); writes do nothing |
| `0x018` | `FR`, flags | computed from the FIFO on every read; read-only |
| `0x020` | `ILPR`, infrared low-power | stored; unused by our guests |
| `0x024`, `0x028` | `IBRD`, `FBRD`, integer and fractional baud divisors | stored and read back; a baud rate means nothing here |
| `0x02c` | `LCR_H`, line control | stored; bit 4, `FEN`, selects a 32-byte FIFO, else a 1-byte one |
| `0x030`, `0x034` | `CR`, control; `IFLS`, FIFO level select | stored (reset values `0x300` and `0x12`) |
| `0x038` to `0x044` | `IMSC`, `RIS`, `MIS`, `ICR` | the interrupt mask and status, below |
| `0x048` | `DMACR`, DMA control | stored; there is no DMA (direct memory access) here |
| `0xfe0` to `0xffc` | identification | eight constant bytes, from the `primecell-ids` primer |

`FR` is the register to know by heart, because every guest reads it before every byte. Its bits, and the interrupt bits that `IMSC`, `RIS`, `MIS` and `ICR` share:

| `FR` bit | Mask | Name | Meaning when 1 |
|---|---|---|---|
| 3 | `0x08` | `BUSY` | still shifting a byte out (ours: never) |
| 4 | `0x10` | `RXFE` | receive FIFO empty |
| 5 | `0x20` | `TXFF` | transmit FIFO full |
| 6 | `0x40` | `RXFF` | receive FIFO full |
| 7 | `0x80` | `TXFE` | transmit FIFO empty (ours: always) |

| Interrupt bit | Mask | Name | Raised when |
|---|---|---|---|
| 4 | `0x10` | `RX` | received data waits |
| 5 | `0x20` | `TX` | a byte was sent |
| 6 | `0x40` | `RT` | receive timeout (below) |

So `FR = 0x90` after reset is `0x80 | 0x10`, `TXFE | RXFE`: both queues empty. And `0xc0` is `0x80 | 0x40`, `TXFE | RXFF`: nothing to send, and the receive FIFO full. In `learner/crates/vmm/src/devices/pl011.rs`, the offsets and bits:

:::code anchor=pl011_regs file=crates/vmm/src/devices/pl011.rs

Now the question that decides the design: what is the device's *state*? Not one value per register. Most registers are plain storage, but `DR` is a window onto a queue, and `FR` stores nothing at all: it is computed from the queue each time it is read, as is most of `RIS`:

:::code anchor=pl011_state file=crates/vmm/src/devices/pl011.rs

:::code anchor=pl011_new file=crates/vmm/src/devices/pl011.rs

Three things come in from outside. A [sink](/build-your-own/vmm/glossary/#sink) is where guest output goes: a filter, then a bounded queue drained by a writer thread; the Output section builds it. `SerialInput` is the host's input queue, built in sitting B. The interrupt line comes in the next section.

For sitting A, stand-ins are enough, in `learner/crates/vmm/src/backend/serial.rs`. Make `Sink` a struct holding a `Mutex<Box<dyn Write + Send>>`, with a `write_guest(&self, bytes)` that writes the bytes as they are, and `SinkHandle` an `Arc<Sink>`. Make `SerialInput` a struct holding a `Mutex<VecDeque<u8>>` with the `pop` method that `refill` calls.

A device is a state machine: hidden state (the FIFO, and a few bits the device sets and keeps until they are cleared), moved by inputs (register accesses, bytes arriving from the host), producing outputs (values the guest reads, bytes to the terminal, an interrupt line). The registers are its interface, not its memory. The clearest sign is a [side-effecting read](/build-your-own/vmm/glossary/#side-effecting-read): reading `DR` removes the byte it returns, so two reads give two answers.

The status half, computed on demand:

:::code anchor=pl011_status file=crates/vmm/src/devices/pl011.rs

`FR` tells a lie: `TXFE` (transmit FIFO empty) is always 1 and `BUSY` always 0, because our "transmission" is over the moment the guest writes `DR`. A real UART would show `BUSY` for the time it takes to shift the byte out. The lie is fine because it is *consistent*: an always-ready port is a very fast one, and every driver must accept a fast one. Journal question 1 asks you to push on this.

Writing `DR` sends the byte on and sets the transmit bit, which stays set until the guest clears it. Reading `DR` pops, then refills from the host's queue:

:::code anchor=pl011_write_dr file=crates/vmm/src/devices/pl011.rs

:::code anchor=pl011_read_reg file=crates/vmm/src/devices/pl011.rs

:::code anchor=pl011_write_reg file=crates/vmm/src/devices/pl011.rs

## Remembering versus telling

Four registers handle "I need attention". Here is the idea in one sentence, ahead of its full story: the device remembers that it wants attention, and a mask says whether to say so; who listens is chapters 11 and 12. `RIS` (raw interrupt status) is the remembering: `RX` while received data waits, `TX` after a transmit. In our model `RT` comes with `RX`; on real hardware, receive timeout means data has sat in the FIFO for a while unread, and we raise it whenever data waits.

`IMSC` (interrupt mask set/clear) is the mask the guest writes. `MIS` (masked interrupt status) is `RIS & IMSC`. `ICR` (interrupt clear) clears [latched](/build-your-own/vmm/glossary/#latch) bits when the guest writes 1s to it.

The device turns `MIS` into a level on an [interrupt line](/build-your-own/vmm/glossary/#interrupt-line): the line stays high for as long as `MIS` is non-zero, rather than pulsing once (a [level-triggered](/build-your-own/vmm/glossary/#level-triggered) line). The line is an object with one method, `set_level`, which chapter 12 connects to the interrupt controller and freezes. Until then the machine passes a line connected to nothing (`NullIrq`), and the tests pass one that records every change (`TestIrq`, with `new`, `level`, `transitions` and `clear`); all three live in `learner/crates/vmm/src/irq.rs`:

:::code anchor=irq_line_trait file=crates/vmm/src/irq.rs

:::code anchor=pl011_update_irq file=crates/vmm/src/devices/pl011.rs

Step through it in the lab: write registers, push bytes from the "host" side, and watch `FR`, the FIFO, `RIS` and `MIS` move.

:::lab pl011-poke

If the lab does not load, here is the same walk run against the reference device on a real Mac, by a short test written for this page:

:::term source=captures/09-poke.txt

Read it line by line, with the tables above. After the `DR` write, `RIS = 0x20` is `TX`, but `MIS` stays 0: the mask `0x10` lets only `RX` through. When the host types `ok`, `RIS = 0x70` is `RX | TX | RT`, and `FR = 0xc0` is `TXFE | RXFF`: not empty, and full, because with `FEN` clear the FIFO holds one byte (the `k` waits in the host's queue).

Writing `ICR = 0x70` clears the latched `TX` bit (`RIS` drops to `0x50`) but, in our model, not the receive bits: their condition still holds, so the device still wants attention. Only the reads of `DR` change that.

## An answer for every access

A guest can make any access it likes: a 1-byte store to offset `0x7`, an 8-byte load of `FR`, a read at `0x800`, where nothing lives. Each still arrives as a data abort, and each needs an answer. The rule: **the device is total over its window**. Every offset and every width gets a defined result, never a panic.

The contract a device fulfils is two frozen types: the checkpoint, later chapters and the lifelines all use them exactly as given. Chapter 07 had you write a first version; declare these in `learner/crates/vmm/src/bus.rs`:

:::code anchor=mmio_device_trait file=crates/vmm/src/bus.rs

:::code anchor=access_size file=crates/vmm/src/bus.rs

The `Send` bound comes into play in sitting B, when a second thread arrives. Now the PL011's side of that contract: 8-, 16- and 32-bit accesses at a register's aligned offset reach the register, and everything else is [RAZ/WI](/build-your-own/vmm/glossary/#raz-wi) (read as zero, writes ignored) with a warning:

:::code anchor=pl011_mmio file=crates/vmm/src/devices/pl011.rs

The warning is rate-limited, because a guest decides how often it fires. Here is the reference's own register test, which sweeps every offset at every width (we ran it on a real Mac):

:::term source=captures/09-pl011-tests.txt

Nine tests pass, and the warnings show the limiter at work. Each call site prints its first 10 messages, then one in every thousand, hence "989 similar messages suppressed" the first time and "999" after that. A guest probing every byte of the window costs a handful of lines, not a flooded terminal.

## Where the UART plugs in

Chapter 07 gave your machine a bus with one entry, the test device. Your MMIO handler, `handle` in `learner/crates/vmm/src/vcpu/mmio.rs`, already sends every device access through `env.bus`, and applies chapter 05's unhandled-MMIO policy when the bus answers `Unmapped` (no device there) or `Straddle` (an access that runs past a window's end).

So the UART needs no new routing: it becomes a second entry, inserted at the first run. Chapter 07's bus checks nothing about its entries; with two, you can check by eye that they do not overlap, and the last section makes the bus check it.

:::stopping-point Good place to stop. Sitting A ends when, in `learner/`, `cargo build -p vmm` succeeds and `cargo test -p vmm pl011` passes your own unit tests of the device (reset `FR` is `0x90`; a `DR` write sets `TX`; two `DR` reads after one pushed byte give the byte, then 0). The checkpoint's PL011 contract also needs the real `SerialInput` and the filtered sink, so it passes only after sitting B.

## Input needs a second thread

The guest polls `FR`, but who puts bytes into the FIFO? Not the [thread](/build-your-own/vmm/glossary/#thread) of the virtual CPU (vCPU): it spends its life inside `hv_vcpu_run`, and if it stopped to wait for the keyboard, the guest would freeze with it. So a second thread does one thing forever: read standard input, and hand the bytes over. In `learner/crates/macvmm/src/term.rs`:

:::code anchor=stdin_loop file=crates/macvmm/src/term.rs

The parser takes the Ctrl-A escapes out before anything reaches the guest, so a guest can never produce a host command. The rest goes to `SerialInput`, now the real queue in `learner/crates/vmm/src/backend/serial.rs`. It holds 4 KiB (`SERIAL_INPUT_CAP`) and **never waits for room**: it may wait a few milliseconds for the UART's lock, never indefinitely.

:::code anchor=serial_input_push file=crates/vmm/src/backend/serial.rs

Why drop bytes rather than wait for room? The same thread reads Ctrl-A x. If a guest stopped reading its UART and the push waited, the thread could never see your quit keys again. Besides `push` and `pop`, give it `new`, `len`, `is_empty`, `dropped` (the count of bytes it refused) and `set_hook`.

After a push, the hook moves bytes into the UART's FIFO and updates its line. The machine installs it when it builds the UART:

:::code anchor=serial_input_hook file=crates/vmm/src/machine/mod.rs

:::code anchor=pl011_input_ready file=crates/vmm/src/devices/pl011.rs

The hook holds a [Weak](/build-your-own/vmm/glossary/#weak): an `Arc` that does not keep its value alive, whose `upgrade()` gives `None` once the last `Arc` is dropped. A strong `Arc` here would form a cycle, the UART holding the input and the input's hook holding the UART, and neither would ever be freed.

Now the UART is touched by two threads: the vCPU's (register accesses) and the stdin thread's (the hook). That is why each device sits behind an `Arc<Mutex<…>>`. Without the lock, the compiler will not let two threads call its `&mut self` methods through a shared `Arc` (the `host-concurrency` primer); with it, each access or push is applied whole.

And two locks are now in play, the device's and the queue's. `refill` takes the queue's lock while holding the device's; `push` calls the hook only *after* releasing the queue's. So both threads take them in the same order:

```text
stdin thread:  lock queue, push, unlock queue -> hook -> lock device -> refill -> lock queue
vCPU thread:                                             lock device -> read DR -> refill -> lock queue
```

Both threads take the device before the queue, so the deadlock from the primer's `lock-order` lab cannot happen.

## The first run

Write `register_platform(bus, sink, input, ncpus)` in `learner/crates/vmm/src/machine/virt.rs`, for now with one `bus.insert("pl011", PL011_BASE, PL011_SIZE, uart)` that returns the UART, and call it where chapter 07 calls `register_devices`. Build the test guests if you have not since chapter 03 (`scripts/build-guests.sh` from the repository root), then, from inside `learner/`:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --raw $G/uart-echo.bin@0x40080000 --timeout 10
```

Wait for `uart-echo: ready`, type `ping`, press Enter. The guest answers `pong`, then reads a clock at `0x0901_0000`, which this chapter builds last. In your tree that address is still a hole, so the run stops right after `pong` with `unhandled MMIO read at 0x9010000 size 4` and exit code 3. That is expected: the UART works, and the dump shows the clock is missing. Ours, from a reference with the clock removed, fed the line through a pipe so it could be recorded:

:::term source=captures/09-first-run-no-rtc.txt

Now the Predict fork: in your `fr()`, start from `TXFE | RXFE` instead of `TXFE`, so `FR` always claims the receive FIFO is empty, and run again. Ours, on the finished chapter:

:::term source=captures/09-predict-rxfe.txt

No `pong`: the guest polled until the timeout ended it (exit code 5). The exit trace shows what it was doing for those seconds. The command runs the guest for 2 seconds with `--trace exits:t.jsonl:mmio`, then prints four things from the trace: the number of records, the number of `FR` reads, the number of `DR` reads, and the last record. Its `exit: 0` is the last command's, `tail`; macvmm itself exited 5, as above.

:::term source=captures/09-predict-rxfe-trace.txt

In 2 seconds, 601,453 MMIO exits. All but 18 of them are 4-byte reads of `0x9000018` (`FR`) returning `0x90`, like the last one shown; the 18 are the `LCR_H` setup and the 17 bytes of `uart-echo: ready` and its newline. And there are **zero** reads of `DR`.

The bytes were in the FIFO the whole time; the guest never asked for them, because the flags said there was nothing to ask for. If you predicted "yes", you were thinking of the device as storage. A driver acts on what the status registers say: the status register is half of the data path.

**Deliberate breakage 1: a transmit FIFO that is always full.** Undo the fork, then make `fr()` start from `TXFE | TXFF`. Predict: what does the guest print, and how does the run end?

:::term source=captures/09-break-txff.txt

Nothing at all, not even `ready`. `putc` waits while `TXFF` is set, so the very first byte never leaves. The same trace, counted the same way, with every record that is not an `FR` read, and the number of records per PC (program counter):

:::term source=captures/09-break-txff-trace.txt

One `LCR_H` write (`0x900002c`, value `0x70`, which sets `FEN`), then 509,268 `FR` reads, all at one PC, the `putc` loop's. What you saw: silence, then exit 5. The misconception: "a device is whatever the datasheet's register list says"; both registers were "implemented", but the state machine behind them was wrong. The tool that finds it: the exit trace.

## Output: never trust the bytes

The other direction starts in `write_dr`, which hands each byte to the sink. The sink passes it through the [output filter](/build-your-own/vmm/glossary/#output-filter) before anything else.

> **Security.** The guest chooses every byte it writes to `DR`, and your terminal does not only display bytes: it obeys escape sequences, which can retitle the window, write your clipboard, or make the terminal *type* a reply into whatever reads its input next. That is terminal injection, guest bytes driving the host terminal; the threat model in chapter 25 treats it in full. So guest output is filtered on every sink, a file included, with an allow-list of harmless sequences (colours, cursor movement, erasing, and a few terminal modes such as the alternate screen and bracketed paste, which macvmm resets on exit); everything else is dropped whole.

The filter is a byte-at-a-time state machine of its own, about 500 lines, and its rules are the `tty-termios` primer's subject, not this chapter's. Borrow it: `scripts/learner lifeline backend::ansi` copies the reference's `backend/ansi.rs` into your tree (declare it with `pub mod ansi;` in `backend/mod.rs`), and the checkpoint then passes marked as borrowed. Its entry point is one call:

:::code anchor=ansi_filter_push file=crates/vmm/src/backend/ansi.rs

Now replace your stand-in sink. `Sink::new(name, out, policy)` takes a `Box<dyn Write + Send>` and a `FilterPolicy`; `Sink::none()` discards everything. `write_guest` filters, then writes what survives:

:::code anchor=sink_write_guest file=crates/vmm/src/backend/serial.rs

A sink made by `Sink::new` writes on the caller's thread (the `inline` branch); that is the sink the contract tests build, and it is enough for a file.

> **Under the hood.** The stdout sink never writes from the vCPU's thread: it has a bounded queue drained by its own writer thread, and a vCPU waits at most 10 ms for room, then drops the rest. A stalled stdout (a pager waiting for a key) would otherwise block the vCPU outside `hv_vcpu_run`, where no stop request can reach it.

> **Try it.** Run the `tty-hygiene` guest. It switches to the alternate screen (`ESC [ ? 1049 h`), hides the cursor (`ESC [ ? 25 l`), turns on bracketed paste (`ESC [ ? 2004 h`), asks for the cursor position (`ESC [ 6 n`) and writes the clipboard (an `ESC ] 52` sequence). Check whether the last two survive.

:::term source=captures/09-filter.txt

The screen, cursor and paste modes passed (macvmm undoes them when it exits on a terminal); the cursor query and the clipboard write are gone. To see what the `safe` policy keeps and drops for bytes of your own, use the `ansi-filter` lab in the `tty-termios` primer.

Where the sink writes is the `--serial` option: `stdio` (the default), `file:F` or `none`. Parse it in `parse_serial`, in `learner/crates/macvmm/src/cli.rs`, into a kind and a path; the reference also accepts a policy and a size cap after a comma, which you can skip. A file console must leave stdout empty. Here the console goes to `s.txt`; the command then prints the exit code, the file, and how many stdout lines mention the greeting (the capture's `exit: 1` is that last `grep`, which found none):

:::term source=captures/09-serial-file-run.txt

## Raw mode, and every way out

A console wants each keystroke as it is typed, so when stdin is a terminal macvmm switches it to raw mode, the setting from the `tty-termios` primer:

:::code anchor=term_raw_mode file=crates/macvmm/src/term.rs

Raw mode includes Ctrl-C: it becomes a byte for the guest, not a signal. So on a terminal, Ctrl-C no longer quits macvmm; use Ctrl-A x. SIGINT still arrives when stdin is not a terminal, or from `kill -INT <pid>` in another window.

Raw mode is a promise to put things back, on every path out. The saved settings live in one place that every exit path can reach:

:::code anchor=restore_saved file=crates/macvmm/src/term.rs

There are four paths: a normal stop (the terminal's `Drop`), Ctrl-A x, a signal, and a panic. The last needs a hook, installed before raw mode is entered:

:::code anchor=panic_hook file=crates/macvmm/src/term.rs

> **Aside.** A Rust panic runs the panic hook first, then unwinds the thread. `std::panic::set_hook` replaces the hook for the whole process, which is why ours calls the previous one after restoring the terminal. The standard library's documentation for `std::panic::set_hook` has the details.

The hook only repairs the terminal. Stopping the virtual machine (VM) is a second job: a guard on each vCPU thread notices the unwind (`std::thread::panicking()` in its `Drop`) and requests a stop, so a VMM bug ends the run with exit code 1 instead of leaving it half alive. In `learner/crates/vmm/src/vcpu/manager.rs`:

:::code anchor=vcpu_stop_on_exit file=crates/vmm/src/vcpu/manager.rs

We have not found a way to make the reference panic from the command line, so the panic path is the one exit this chapter does not show running.

To check Ctrl-A x yourself, run under `script`, which gives the run a real terminal, and print the terminal settings before and after; press Ctrl-A, then x, once `ready` appears:

```sh
script -q /dev/null sh -c 'stty -g; cargo run -q -p macvmm -- run --mem 64M --raw $G/uart-echo.bin@0x40080000 --timeout 10; echo rc=$?; stty -g'
```

We typed the two keys through a pipe so the run could be recorded:

:::term source=captures/09-tty-escape-run.txt

The two `gfmt1:` lines are identical: the terminal is exactly as macvmm found it. The long run of escape sequences before `macvmm: user quit` is the reset written after the guest's last byte, which undoes any mode a guest set, and the exit code is 130.

## Stopping from another thread: the flag

Ctrl-A x is read by the stdin thread; SIGINT and SIGTERM by a signal thread, fed by the self-pipe from the `unix-signals` primer. Neither can stop the vCPU loop directly. They need to tell it, and that takes two parts. The message is the [stop flag](/build-your-own/vmm/glossary/#stop-flag), an `AtomicBool` in `learner/crates/vmm/src/control.rs`:

:::code anchor=vm_control_stop_flag file=crates/vmm/src/control.rs

:::code anchor=request_stop file=crates/vmm/src/control.rs

:::code anchor=is_stopping file=crates/vmm/src/control.rs

The first `request_stop` wins: its reason decides the exit code (`UserQuit` gives 130, `Timeout` 5). `changed` is a condition variable that wakes the main thread waiting for the verdict. The flag uses `Ordering::SeqCst`, the `host-concurrency` primer's rule until chapter 16 refines it.

The second part is the [kick](/build-your-own/vmm/glossary/#kick). A vCPU inside `hv_vcpu_run` never looks at the flag, so it must be forced out. If you kept chapter 03's simple timeout, which ended the process instead, implement the kick now: declare `hv_vcpus_exit` in your `ffi.rs` as in chapter 01, and wrap it. Each vCPU thread registers its handle with `VmControl::register` when it creates its vCPU, and `kick_all_vcpus` kicks them all:

:::code anchor=vcpus_exit_handle file=crates/hvf/src/vcpu.rs

:::code anchor=kick_all_vcpus file=crates/vmm/src/control.rs

The order matters: the flag is set *before* the kick. A vCPU checks the flag right before each `hv_vcpu_run`. If it checked a moment too early, it still stops: a kick sent to a vCPU that is not in the guest makes its next `hv_vcpu_run` return at once, and then it sees the flag. The signal side, in `learner/crates/macvmm/src/signals.rs`:

:::code anchor=signal_thread file=crates/macvmm/src/signals.rs

SIGHUP (the terminal went away) is treated like SIGTERM. SIGUSR1 prints the exit trace's ring, a debugging aid you can skip. A second quit signal, if the first did not stop the VM, restores the terminal and exits at once with 130.

To try SIGTERM, start the guest in one window and, once `ready` appears, send the signal from a second:

```sh
pkill -TERM -x macvmm
```

Ours sent it from the same shell, 2 seconds after the start:

:::term source=captures/09-sigterm-run.txt

`user quit`, exit code 130, the same as Ctrl-A x. A process killed by SIGTERM would report 143 (128 + 15), but macvmm catches the signal, stops the VM, and chooses its own code.

## A second device: the clock, and a real bus

The guest wanted the year. Where does it get it? A CPU's counter (chapter 11) says how much time has passed, not what time it is. A real-time clock, an [RTC](/build-your-own/vmm/glossary/#rtc), knows the date; QEMU's `virt` machine has Arm's [PL031](/build-your-own/vmm/glossary/#pl031) at `0x0901_0000`. The manual is ARM DDI 0224. The constant names in the first column are the ones the contract tests import from `vmm::devices::pl031`:

| Constant | Offset | TRM name | What our model does |
|---|---|---|---|
| `DR` | `0x000` | `RTCDR` | seconds since 1 January 1970, as a 32-bit number |
| `MR` | `0x004` | `RTCMR` | the match register: an alarm time, below |
| `LR` | `0x008` | `RTCLR` | a write sets the time `DR` reads from now on |
| `CR` | `0x00c` | `RTCCR` | the start bit, which our model always reads as 1 because our counter always runs |
| `IMSC`, `RIS`, `MIS`, `ICR` | `0x010` to `0x01c` | | mask and status of the one alarm interrupt bit, as in the PL011 |
| | `0xfe0` to `0xffc` | | identification bytes |

This one is yours: write `learner/crates/vmm/src/devices/pl031.rs`, in the PL011's shape, with `PL031_SIZE` (4 KiB). Two pieces from the reference to start from. The clock is passed in as a `WallClock`, so tests can control time; `host_clock()` reads the wall clock on every call and never goes backwards:

:::code anchor=pl031_host_clock file=crates/vmm/src/devices/pl031.rs

`Relaxed` is enough here, an exception to the primer's rule: `fetch_max` is one indivisible step on one value, and nothing else is ordered by it (chapter 16's `memory-ordering` primer explains why that suffices).

A guest that sets the clock through `LR` gets an offset, applied in wrapping 32-bit arithmetic:

:::code anchor=pl031_read_dr file=crates/vmm/src/devices/pl031.rs

Why the wall clock on every read, not the boot time plus the time elapsed? Rust's `Instant` stops while the Mac sleeps, so that sum would fall behind.

The interrupt half is an alarm the guest sets: a write to `MR` arms a match that fires when the counter *equals* it, `MR - DR` seconds ahead in wrapping arithmetic. So a value in the past is 2^32 seconds away, about 136 years. On each access, if that second has come, `RIS` becomes 1, and the line follows `RIS & IMSC` as in the PL011:

:::code anchor=pl031_match file=crates/vmm/src/devices/pl031.rs

A guest that arms the alarm and then waits for the interrupt never touches the device again, so the reference also runs a helper thread that checks the match when the second comes. It matters only once interrupts reach the guest; it is optional until chapter 12. The contract tests build your RTC with `Pl031::with_clock(clock, irq)` and `Pl031::new(irq)` (which uses `host_clock()`), read `dr()`, and check the match against a clock they move by hand.

With the clock on the bus, the first run finishes:

:::term source=captures/09-echo-pipe.txt

Now two devices need routing, and chapter 07's in-order list would work, today. But its entries would have to be checked by hand, forever, for one property: no two windows may overlap, or one address would have two owners. So the check moves into the bus, once. The `Bus`, our [MMIO bus](/build-your-own/vmm/glossary/#mmio-bus), is a list of windows sorted by base address:

:::code anchor=bus_struct file=crates/vmm/src/bus.rs

`insert` refuses a window of size 0 or one whose end overflows a `u64` (`BusError::InvalidRange`), and one that overlaps a window already there (`BusError::Overlap`):

:::code anchor=bus_insert file=crates/vmm/src/bus.rs

Lookup is a binary search, and an access that starts inside a window but runs past its end is refused as a `Straddle`, so no device ever sees a partial access:

:::code anchor=bus_lookup file=crates/vmm/src/bus.rs

:::code anchor=bus_dispatch file=crates/vmm/src/bus.rs

The table is built once, before the first vCPU runs, and never changes, so looking up needs no lock; only the device found is locked, for one call. Add `new`, `len`, `is_empty` and `device_at`, and keep `register_devices` from chapter 07 inserting the test device.

One more window belongs to the machine. Chapter 05's map reserves room for the interrupt controller's per-CPU frames, one 128 KiB frame per vCPU (chapter 12 explains them), but a machine with one vCPU uses only the first. A guest may probe the rest, and it must get an answer, not a fatal unhandled-MMIO stop. So the rest of that window, from `GICR_BASE + gicr_size(ncpus)` to `GICR_WINDOW_END` (both from your `layout.rs`), goes on the bus as a `RazWi` device named `gicr-unused`, in `learner/crates/vmm/src/devices/razwi.rs`:

:::code anchor=razwi_device file=crates/vmm/src/devices/razwi.rs

The checkpoint calls the four-argument `register_platform`, and expects it to insert exactly three windows: `pl011`, `pl031` and `gicr-unused`. The reference writes it as a wrapper:

:::code anchor=register_platform_wrapper file=crates/vmm/src/machine/virt.rs

:::code anchor=register_platform file=crates/vmm/src/machine/virt.rs

Two names in it come from later chapters. `PlatformIrqs` holds the two interrupt lines, and `PlatformIrqs::none()` is two `NullIrq`s; `crate::timer::pl031_time_base()` is `host_clock()` until chapter 11 adds the timer module. Your version can be the one function, with `Arc::new(NullIrq)` for each line and `host_clock()` for the clock.

**Deliberate breakage 2: two owners for one address.** Insert the PL031 at `PL011_BASE + 0x800` instead of `PL031_BASE`. Predict: which access fails, and when?

:::term source=captures/09-break-overlap.txt

None: the VM never starts. The overlap is refused while the machine is built, with both names, and macvmm exits with code 1 before a single guest instruction runs. What you saw: an error at build time, not a strange value at run time. The misconception: "the guest will tell us if the map is wrong". It would not; with a list searched in order, the first entry silently wins. The tool that finds it: the check in `insert`, which the contract tests exercise with adjacent, overlapping, empty and overflowing windows.

## Your turn

The contract tests use these public names; each must exist with the signature shown on this page:

- `vmm::bus`: `AccessSize` (`B1` to `B8`, `bytes`, `mask`), `MmioDevice`, `Bus` (`new`, `insert`, `read`, `write`, `device_at`, `len`, `is_empty`), `BusError::{Overlap, InvalidRange, Straddle, Unmapped}`.
- `vmm::devices::pl011`: the register constants, `LCR_H_FEN`, `PL011_SIZE`, `PL011_FIFO_DEPTH`, the `fr` and `int` bit modules (with `int::ALL`), and `Pl011` (`new`, `rx_len`, `input_ready`).
- `vmm::devices::pl031`: `DR`, `MR`, `LR`, `CR`, `IMSC`, `RIS`, `MIS`, `ICR`, `PL031_SIZE`, `host_clock`, and `Pl031` (`new`, `with_clock`, `dr`).
- `vmm::backend::serial`: `SerialInput` (`new`, `push`, `pop`, `len`, `is_empty`, `dropped`, `set_hook`), `SERIAL_INPUT_CAP`, and `Sink` (`new`, `none`, `write_guest`); `vmm::backend::ansi::FilterPolicy` (borrowed).
- `vmm::irq::TestIrq` (`new`, `level`, `transitions`, `clear`); `vmm::devices::razwi::RazWi::new`; `vmm::config::VmConfig` with its `testdev` field; `vmm::machine::virt::{register_devices, register_platform}`; and `vmm::Error::Bus`.

Before the checkpoint, check:

1. `cargo test -p vmm` in `learner/` passes your PL011, PL031 and bus tests.
2. `uart-echo` prints `pong` and a year from 2025 on when you type `ping`, and Ctrl-A x leaves your terminal working.
3. Your journal has the Predict entry, written before you ran the fork.

Stuck? `scripts/learner hint 09` gives four hints, from a nudge to the exact reference file.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (the PL011's reset state, the `DR`, `RIS`, `MIS`, `IMSC` and `ICR` behaviour, the identification bytes, narrow accesses, a 33rd input byte that stays queued, the PL031 against an injected clock, and the bus's overlap, adjacency, size-0, overflow and straddle rules), then four runs on your Mac: `uart-echo` with `ping`, a file console, Ctrl-A x under a real terminal, and SIGTERM. Then it checks your journal:

:::term source=captures/09-checkpoint.txt

What now works:

- a device that answers every access to its window, with the side effects of the real one;
- a console in both directions, through a stdin thread, a bounded queue and an output filter;
- every way out of `macvmm`, normal or not, leaves your terminal as it found it, and the user's quit always reaches the vCPU through the stop flag and the kick;
- a clock that tells the guest the date, and a bus that cannot hand one address to two devices.

The next chapter starts from this state (the reference at the end of chapter 09).

### What's next

Our guests find the UART because `0x0900_0000` is written into their source. A general kernel cannot be compiled for every machine, so the VMM must describe the machine to it: its memory, its CPUs, and which devices sit at which addresses. Chapter 10 generates that description, a device tree blob (DTB), from the same `layout.rs` table the bus is filled from.

### Open question

Our test guests never read the identification registers at `0xFE0`. Linux does, before it binds a driver to the device. What happens to a guest that probes our UART and reads zeros there? Record your guess in the journal; chapter 14 boots Linux and checks it.

## Spec hunt

- PL011 TRM (ARM DDI 0183), the register description of **UARTFR**: after a write to `UARTDR`, when does a real PL011 set `BUSY` and clear `TXFE`, and which of those bits does our model hold constant?
- PL011 TRM, the section on **interrupts** and the description of **UARTICR**: in which two ways can the real receive interrupt be cleared, and how does our model, which keeps the receive bits set while the FIFO holds data, differ?
- PL031 TRM (ARM DDI 0224), **RTCDR** and **RTCLR**: what does a write to `RTCLR` do to the value `RTCDR` returns afterwards, and where does our model keep that difference?
