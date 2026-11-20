---
title: Getting the CPU back: the timer and a bare interrupt
part: V
chapter: V.1
id: 11
runs: mac+browser
minutes: 270
prereqs: [10]
start_tag: ch-10
labs: [timer-timeline, irq-lifecycle]
command: scripts/checkpoint.sh 11
expect: CHECKPOINT 11 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** interrupts as state (pending, mask, vector); level versus edge; the generic timer (`CNTVCT_EL0`, `CNTV_CVAL_EL0`, `CNTV_CTL_EL0`, `CNTFRQ_EL0`) and the counter offset; `WFI` (closing chapter 01's definition) and `WFE`; the vtimer, the VTIMER exit and the vCPU's IRQ input; exits per tick as a cost (`--stats`).
- **Core, from earlier:** the PC after an exit (chapter 02); exit cost and the exit trace (chapter 03); the kick, `hv_vcpus_exit` and the `CANCELED` exit (chapters 03 and 09); PSTATE's DAIF bits (chapter 06); the `Exit` enum and the exit handler (chapter 07); the vector table (chapter 08); the PL011's `RIS`, `MIS` and `IMSC`, and the stop flag (chapter 09).
- **Primers (read first):** `os-basics` (what an interrupt is; why a kernel needs a timer to get the CPU back).
- **Primers (review):** `host-concurrency` (a condition variable's timed wait, for the WFI sleep; timer-driven preemption).
- **Pointers:** Linux's Arm timer driver; `mach_absolute_time` and the host timebase (both Asides).
- **Forward definitions:** the interrupt controller (chapter 12). It is defined at first use.
:::

Here is a guest that wants to sleep for 100 milliseconds, ten times. Each round it sets an alarm, then runs `wfi`, "wait for interrupt", and the CPU idles until something knocks: on a real board, a wire from the timer. Our virtual machine has no such wire yet: nothing between the timer and the CPU, no [interrupt controller](/build-your-own/vmm/glossary/#interrupt-controller) (the hardware that routes such wires to CPUs; chapter 12). So who wakes the guest, and what does each wake-up cost the monitor you are building, in [VM exits](/build-your-own/vmm/glossary/#vm-exit)?

:::predict How many timer-related VM exits (not counting the guest's printing) will ten 100 ms sleeps produce: (a) about zero, because the timer is hardware; (b) about 20 to 30; (c) thousands?
The answer is in "The run", after we count the exits.
:::

This chapter works on rows 6 and 7 of chapter 00's problem ledger: interrupts from devices, and an alarm clock. By its end a guest is woken by its timer, with your virtual machine monitor (VMM) as the wiring; chapter 12 finishes both rows. Sitting A is ideas, in the browser (about 1.5 hours); sitting B is code and measurement at your Mac (about 3 hours).

Write your choice and one sentence of reasoning under `## Predict` in `learner/journal/11.md` (created by `scripts/learner start 11`, below) before reading on.

:::objectives
- (Sitting A) Explain why a kernel needs an alarm that *interrupts*, not only a counter; name the job of `CNTVCT_EL0`, `CNTV_CVAL_EL0` and `CNTV_CTL_EL0`; derive the offset rule `CNTVCT = mach_absolute_time() - offset`.
- (Sitting A) Explain with an example why a level-triggered line is state that cannot be lost while masked, and an edge is an event that needs latching.
- (Sitting B) With no interrupt controller, handle `VTIMER_ACTIVATED`: raise the vCPU's IRQ (interrupt request) input, keep the vtimer (the guest's virtual timer) masked, and before every entry raise the IRQ again or, once `CNTV_CTL_EL0` shows the timer quiet, drop it and unmask. Observe that the exit arrives even while the guest masks IRQs.
- (Sitting B) Handle WFI exits by sleeping the vCPU thread until the alarm's deadline or a stop, and measure idle host CPU under 10% with `--stats`.
- (Sitting B) Turn exits per second at 10 Hz (ten ticks per second) and 250 Hz into host CPU cost with your chapter 03 number, and compare with the measured cost.
:::

**Before you start.** From the repository root, run `scripts/learner start 11`. It copies this chapter's journal to `learner/journal/11.md`. The code goes into your `learner/` workspace, in the files named above each block; the checkpoint tests your crates through the same public names.

## Why reading a clock is not enough

Picture a guest kernel with one CPU and an app that runs `loop {}`. The app never makes a system call, so the kernel never runs again, and a clock it could *read* does not help. The way out, from the `os-basics` primer: an alarm that makes the CPU take an interrupt into the kernel. A kernel needs it to **preempt** a program that would keep the CPU (the `host-concurrency` primer), to **wake a sleeper** whose 100 ms are up, and to **time out I/O** that never answers.

## Arm's generic timer: a counter and an alarm

Every Arm CPU core has one, the **generic timer**. Three registers matter to a guest kernel, plus one that says how fast it ticks:

| Register | What it is | Who writes it |
|---|---|---|
| `CNTFRQ_EL0` | the counter's frequency in Hz: 24,000,000 as Hypervisor.framework presents it to the guest, so one tick is about 41.7 ns | firmware; here Hypervisor.framework |
| `CNTVCT_EL0` | the virtual count: a number that goes up by one every tick | nobody; it counts |
| `CNTV_CVAL_EL0` | the compare value: "wake me when the count reaches this" | the kernel |
| `CNTV_CTL_EL0` | the control bits: `ENABLE` (bit 0), `IMASK` (bit 1, mask the interrupt), `ISTATUS` (bit 2, read-only: the count has reached the compare value) | the kernel, except `ISTATUS` |

*One counter, one alarm.*

The `_EL0` suffix means even apps (EL0) may read these if the kernel allows it; the kernel at EL1 can always write them.

The timer raises its interrupt output when `ENABLE = 1`, `IMASK = 0` and `ISTATUS = 1`. Our test guest arms it like this (guest code, inside the virtual machine):

:::code anchor=guest_timer_arm file=guests/common/timer.rs

For 100 ms it adds `CNTFRQ / 10` (2,400,000 ticks). To silence the timer, a kernel clears `ENABLE`, sets `IMASK`, or moves the compare value ahead; ours clears `ENABLE`.

## The counter offset

Why "virtual" count? Arm gives every core a physical count and a virtual one, the physical minus an offset that only the hypervisor level (EL2) can set, for exactly this. Hypervisor.framework's `hv_vcpu.h` states its version: `CNTVCT_EL0 = mach_absolute_time() - vtimer_offset`, where `mach_absolute_time()` is the Mac's own tick count and the VMM chooses the offset.

A guest expects its counter to **start near zero**, as after power-on, and to **never go backwards**, the same on every CPU. So the offset is the host's count at boot, given to every vCPU before its first run:

:::code anchor=vtimer_offset_boot file=crates/vmm/src/timer.rs

The subtraction wraps around at 2^64, as the hardware's does, so `restore_offset`, used after a pause or a restored snapshot (chapter 26), works even when the saved count is larger than the host's current one. Every vCPU gets the offset as it is set up (the second call switches on this chapter's no-controller mode; sitting B builds it):

:::code anchor=vcpu_apply_vtimer_offset file=crates/vmm/src/vcpu/manager.rs

Give chapter 06's `reset` the `vtimer_offset` parameter and closing `set_vtimer_offset` call it left out. A guest whose first act is to read `CNTVCT_EL0`, with the reference's offset:

:::term source=captures/11-first-cntvct.txt

133,166 ticks: 5.5 ms, the time it took to build the machine after the offset was taken. With the offset forced to 0:

:::term source=captures/11-offset-zero.txt

3,583,539,855,220 ticks at 24 MHz is about 149,300 seconds, or 41.5 hours: how long this Mac had been awake since it booted (the count pauses during sleep, see the Aside). Journal question 1 asks what that tells a guest.

> **Aside.** On Apple silicon [mach_absolute_time](https://developer.apple.com/documentation/kernel/1462446-mach_absolute_time) also ticks at 24 MHz (`mach_timebase_info` reports 125/3 ns per tick), but the VMM converts with the timebase instead of assuming it. It does not advance while the Mac sleeps.

## An interrupt is state, not a call

It is tempting to picture an interrupt as a function call. This chapter's breaks come from that picture. An interrupt is three pieces of state:

- **pending**: a source wants attention. For the timer, that is the output above (`ENABLE`, not `IMASK`, `ISTATUS`).
- **mask**: whether the CPU is listening. That is the I bit of PSTATE (processor state), one of the four [DAIF](/build-your-own/vmm/glossary/#daif) bits from chapter 06. `msr daifclr, #2` clears it (the immediate's bits are D, A, I, F from 8 down to 1, so 2 is I); `msr daifset, #2` sets it.
- **vector**: where the CPU goes. An [IRQ](/build-your-own/vmm/glossary/#irq) (interrupt request, the ordinary kind) taken at EL1 on EL1's own stack enters at `VBAR_EL1 + 0x280` (group `+0x200`, IRQ slot `+0x80`, chapter 08's table).

The CPU takes the interrupt only when it is pending *and* unmasked, between two instructions. The handler must make the source stop asking, or the CPU takes it again at once.

That depends on *how* the source asks. Our timer's output is **level-triggered**: high for as long as the condition holds. Mask IRQs for an hour and the line is still high when you unmask; it drops only when someone removes the cause.

The other kind is **edge-triggered**: the source signals one event ("a key was pressed"), and then the signal is gone. If the CPU was not listening, the event is lost, unless something **latches** it, remembering it until it is handled. You built such a latch: the PL011's `RIS` remembers that a byte arrived, and `MIS` (`RIS` and `IMSC` combined) is a level output (chapter 09).

The lab plays both kinds against a mask, with and without a latch:

:::lab irq-lifecycle

If the lab does not load, here is what it shows:

```text
step                         level line           edge, no latch       edge, latched
source raises                pending              pulse, gone          latch set, pending
CPU masked, waits            still pending        nothing pending      still pending
CPU unmasks                  handler runs         nothing happens      handler runs
handler returns, cause kept  runs again at once   -                    runs again at once
handler clears the cause     line drops, done     -                    latch cleared, done
```

## No interrupt controller: Hypervisor.framework hands us the timer

On a real board the timer's line goes into an **interrupt controller**, a device that collects every source's line, ranks them and delivers one IRQ to a CPU. Arm's is the [GIC](/build-your-own/vmm/glossary/#gic) (Generic Interrupt Controller), so in our code "nogic" means "no interrupt controller". Here we run without one, in a teaching mode, `--irqchip none`, hidden from `--help` because a real kernel expects a controller.

Without a controller, Hypervisor.framework gives the timer to us. It calls the `CNTV_*` timer the **vtimer**. When the vtimer raises its output, `hv_vcpu_run` returns with `HV_EXIT_REASON_VTIMER_ACTIVATED`, and "the timer is masked automatically" until we clear the mask (the header's words): the framework's own mask, not the guest's `IMASK`. The vCPU's IRQ input, `hv_vcpu_set_pending_interrupt`, is "automatically cleared after hv_vcpu_run returns", so we set it "before every hv_vcpu_run".

That makes three masks, with three owners. Keep them apart; the breaks depend on it:

| Mask | Who sets it | What it stops |
|---|---|---|
| `IMASK`, bit 1 of `CNTV_CTL_EL0` | the guest kernel | the timer's output, at the timer |
| `PSTATE.I` | the guest CPU (`msr daifset`) | the CPU taking IRQs |
| the vtimer mask (`hv_vcpu_set_vtimer_mask`) | the framework, at each VTIMER exit; cleared only by our VMM | the timer causing another VTIMER exit |

*Three masks, three owners.*

So our VMM *is* the wiring for one line. A source **asserts** its line when it drives it high. We keep one boolean, **our line**, up from the VTIMER exit until the guest is done, and copy it into the one-run pending IRQ before every entry.

Derive the rules. A level line unmasked while still high fires again at once, so unmask only once the timer stops asking. The guest silences it with a register write that causes no exit, so we learn of it only by reading `CNTV_CTL_EL0` before the next entry:

| Event | Our VMM does | PC afterwards |
|---|---|---|
| `VTIMER_ACTIVATED` exit | raise our line; leave the vtimer masked | unchanged: an asynchronous exit points at the next instruction not yet run (chapter 02) |
| before every entry | our line is up and the timer still asserts: set the pending IRQ for this run. Timer quiet (`ENABLE = 0`, `IMASK = 1` or `ISTATUS = 0`): drop our line and unmask the vtimer | |
| WFI exit, class `0x01` (next section) | if no IRQ is pending, sleep until the alarm's deadline | + 4 |

*The whole of our "interrupt controller" for one line.*

## WFI: idling without burning a core

`WFI`, **wait for interrupt**, tells the CPU "nothing to do until something happens". Its sibling `WFE`, **wait for event**, is a lighter wait used in **spin locks** (locks a waiting core polls in a loop), ended by an interrupt or an event such as another core releasing the lock. The fine print to chapter 01's definition: the Arm Architecture Reference Manual (the ARM ARM) lets either end early for no visible reason, so a guest always re-checks its condition after a `WFI`.

Here, with no controller, a guest's `WFI` reaches us as an exit with exception class (EC) `0x01`; a two-bit syndrome field, TI, says which wait it was: 0 for WFI, 1 for WFE (2 and 3 are their timed variants, WFIT and WFET). It leaves the PC *at* the `WFI`, so we add 4 when we resume (chapter 02's rule). In between, we could resume at once (correct, but an idle guest would keep a host core busy), or sleep the vCPU's thread until the alarm is due. In host ticks, `CNTVCT = host − offset` reaches `CVAL` when `host = CVAL + offset`.

While our thread sleeps, the vCPU is outside `hv_vcpu_run`, so we are the alarm clock; the VTIMER exit comes as soon as we re-enter.

The timeline lab puts one round of the test guest on one time axis:

:::lab timer-timeline

If the lab does not load, this is one round, in order:

```text
guest   arms CVAL = now + 2,400,000 ticks, ENABLE = 1; unmasks IRQs; runs WFI
exit 1  WFI (class 0x01), PC at the wfi      -> VMM sleeps until CVAL + offset
        ... about 100 ms of nothing, on both sides ...
VMM     wakes, PC + 4, enters the guest
exit 2  VTIMER_ACTIVATED, PC unchanged       -> VMM raises our line (vtimer stays masked)
VMM     before entry: timer still asserts    -> pending IRQ for this run
guest   takes the IRQ at VBAR_EL1 + 0x280, handler clears ENABLE, returns
exit 3  (sitting B explains this one)        -> before entry: timer quiet: drop line, unmask
guest   prints the interval, arms the next round
```

*Three exits per round. Sitting B finds out why there is a third.*

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 3 hours.

## The rules, as functions you can test

Sitting A's table becomes small functions, testable on the host. Create `learner/crates/vmm/src/timer.rs` and declare it in your `lib.rs`. The contract tests use: `guest_counter`, `restore_offset` and `boot_offset` (above); `cntv_ctl` (a module of the three bit constants) and `timer_asserted`; `NoGicTimer` with `new`, `line`, `vtimer_activated`, `before_entry` and `irq_pending`; `nogic_wfi_wait`, its answer `WfiWait` (`Wake` or `Sleep(Duration)`) and `NOGIC_WFI_SLICE`; and `hvf::host::Timebase`. The register bits and the "does it assert" rule:

:::code anchor=timer_cntv_ctl file=crates/vmm/src/timer.rs

Our line. First the answer the rule gives and the state it keeps:

:::code anchor=nogic_entry_action file=crates/vmm/src/timer.rs

Then the rule. `before_entry` is the table's middle row; `masked` is the framework's vtimer mask (not `IMASK`):

:::code anchor=nogic_before_entry_rule file=crates/vmm/src/timer.rs

The WFI deadline. Both registers are guest-written, so every case ends in a bounded answer. We never sleep more than 100 ms at a time (a **slice**), then re-read the guest's timer and the stop flag, so a hostile or missing deadline cannot hold up `--timeout`:

:::code anchor=nogic_wfi_deadline file=crates/vmm/src/timer.rs

Ticks become nanoseconds here, in `learner/crates/hvf/src/host.rs`:

:::code anchor=host_timebase file=crates/hvf/src/host.rs

Test them in a `#[cfg(test)] mod tests` in your `timer.rs`: a past compare value wakes, `u64::MAX` and a disabled timer sleep one slice, and our line follows the table. From inside `learner/`:

```sh
cargo test -p vmm --lib timer::
```

The reference's tests (`line_kicker_fires_once_and_disarms` tests a piece you meet in "The surprise"; your count may differ):

:::term source=captures/11-timer-tests.txt

> **Security.** The guest chooses `CNTV_CVAL_EL0`, say `u64::MAX`, so `CVAL + offset` can overflow. A naive `sleep(cval + offset - now)` would panic, or sleep for centuries and hold up `--timeout`, Ctrl-A x and SIGTERM. Hence `checked_add`, `checked_sub` and the slice. The mode itself is fenced: `--irqchip none` is refused (exit code 2) for anything but a test guest on one vCPU.

:::code anchor=irqchip_none_restrictions file=crates/vmm/src/config.rs

## Declaring the vtimer and IRQ calls

The headers, as in chapter 01:

```sh
ls "$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers/"
```

From `hv_vcpu.h` and `hv_vcpu_types.h`, declare in `learner/crates/hvf/src/ffi.rs`, checking each line against the header, the interrupt type, the pending-interrupt pair and the vtimer calls:

:::code anchor=ffi_interrupt_type file=crates/hvf/src/ffi.rs

:::code anchor=ffi_pending_interrupt file=crates/hvf/src/ffi.rs

:::code anchor=ffi_vtimer_fns file=crates/hvf/src/ffi.rs

Three more calls: the host clock and its timebase (`mach/mach_time.h`, in the C library every program links) and the vCPU's run time (`hv_vcpu.h`):

:::code anchor=ffi_mach_timebase_t file=crates/hvf/src/ffi.rs

:::code anchor=ffi_mach_time_fns file=crates/hvf/src/ffi.rs

:::code anchor=ffi_exec_time file=crates/hvf/src/ffi.rs

The safe wrappers follow chapter 02's pattern. The getters use `get_via_out!`, a small macro that wraps a "get through an out-pointer" call with its `// SAFETY:` comment:

:::code anchor=vcpu_get_via_out file=crates/hvf/src/vcpu.rs

:::code anchor=vcpu_vtimer_fns file=crates/hvf/src/vcpu.rs

:::code anchor=vcpu_set_pending_interrupt file=crates/hvf/src/vcpu.rs

Build it from inside `learner/`:

```sh
cargo build -p hvf
```

:::term source=captures/11-hvf-build.txt

## Wiring the rules into the vCPU

Now the glue in `learner/crates/vmm/src/vcpu/`. Before every entry, read the vtimer mask and `CNTV_CTL_EL0`, ask the rule, and act. `set_pending_interrupt(false, true)` reads "not FIQ (fast interrupt request, the other kind), so IRQ; pending". Ignore the final `nogic_kick` block until the next section:

:::code anchor=nogic_before_entry file=crates/vmm/src/vcpu/mod.rs

:::code anchor=vcpu_run_nogic file=crates/vmm/src/vcpu/mod.rs

Two new arms in chapter 07's exit handler:

:::code anchor=nogic_exit_arms file=crates/vmm/src/vcpu/exit.rs

The sleep re-reads the guest's registers every slice and ends at once on a stop:

:::code anchor=nogic_wfi file=crates/vmm/src/vcpu/exit.rs

It is the `host-concurrency` primer's timed wait, on the condition variable a stop notifies, checking the stop under the lock:

:::code anchor=sleep_unless_stopped file=crates/vmm/src/control.rs

## The surprise: a pending IRQ outlives the guest's answer

Sitting A's table has a gap. The pending IRQ we set stays pending for the *whole* `hv_vcpu_run`. The guest's handler clears `ENABLE` and returns, but that caused no exit, so we could not drop our line, and the CPU takes the same IRQ again and again. The reference with the fix below removed:

:::term source=captures/11-no-kick.txt

After its first tick the guest made no progress, yet `exec` says it ran 9.8 of ten seconds, re-taking an interrupt it had handled: an [**interrupt storm**](/build-your-own/vmm/glossary/#interrupt-storm), from a level line nobody lowered.

A real interrupt controller marks a taken interrupt *active*, so it is not taken again, until the guest says it is done (chapter 12). We have neither, so we bound the damage: while our line is up, a helper thread forces the vCPU out after 1 ms with chapter 09's kick (`hv_vcpus_exit`, a `CANCELED` exit), and the before-entry rule then drops our line. `LineKicker` is plumbing: copy `LineKicker`, the small types it uses (`KickState`, `KickShared`), `kicker_loop` and `NOGIC_LINE_RECHECK` (1 ms) from `../crates/vmm/src/timer.rs`, and read them:

:::code anchor=nogic_line_kicker file=crates/vmm/src/timer.rs

Each vCPU in this mode gets its line and its kicker, whose kick is `hv_vcpus_exit` on this vCPU's handle:

:::code anchor=vcpu_enable_nogic file=crates/vmm/src/vcpu/mod.rs

Until the kick the guest still sees the stale pending IRQ, so its handler tolerates finding the timer quiet, and counts those as `stale`:

:::code anchor=timer_nogic_on_irq file=guests/timer-nogic/main.rs

## The guest and the count

The guest unmasks IRQs only around its `WFI`:

:::code anchor=guest_wait_for_interrupt file=guests/common/timer.rs

and measures ten sleeps with the counter:

:::code anchor=timer_nogic_loop file=guests/timer-nogic/main.rs

To count without a trace, the VMM gets `--stats`, in a new `learner/crates/vmm/src/stats.rs`. **Exits by kind**: put back the `log.stats` line chapter 07's run loop left out, which counts each decoded `Exit` by kind. **`exec`**, the guest's run time: `hv_vcpu_get_exec_time`, in host ticks, read when the vCPU thread ends:

:::code anchor=vcpu_exec_time file=crates/hvf/src/vcpu.rs

:::code anchor=vcpu_file_stats file=crates/vmm/src/vcpu/manager.rs

**Host CPU**: the process's user plus system time from `getrusage`, before and after the run, against the wall clock:

:::code anchor=host_process_cpu_time file=crates/hvf/src/host.rs

:::code anchor=machine_stats_start file=crates/vmm/src/machine/mod.rs

:::code anchor=machine_stats_end file=crates/vmm/src/machine/mod.rs

The report prints them:

:::code anchor=stats_report file=crates/vmm/src/stats.rs

## The run

Build the test guests if you have not since chapter 03 (`scripts/build-guests.sh` from the repository root), then, from inside `learner/`:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --irqchip none --mem 64M --raw $G/timer-nogic.bin@0x40080000 --stats --trace exits:t.jsonl:all --timeout 10
```

Check your Predict entry first. The reference's run (`{guests}` and `{out}` stand for directories):

:::term source=captures/11-timer-nogic.txt

Ten intervals of 100 to 110 ms. The `exits:` line says `total 525`, but 495 are `hvc`: printing, one per character, and the power-off. The timer's own are `vtimer 10, wfx 10, canceled 10`: thirty, three per round, answer (b). `pfr0.gic=0` is the guest reading its CPU feature register `ID_AA64PFR0_EL1`: no GIC interface, because there is no controller.

`stale=362066`: before each kick the guest re-took the stale IRQ about 36,000 times. Harmless at 10 Hz; at 250 Hz it is the whole story.

`wfi n/a` is expected: the framework reports WFI waiting only with its own interrupt controller (chapter 12). Ignore the `serial_*` line (bytes printed) and the `rlimit` line (chapter 25).

The trace, with the printing filtered out, shows the timer exits in order:

:::term source=captures/11-trace-ticks.txt

Second round: a WFI exit at 107.5 ms with the PC at the `wfi` (`0x40081188`); 105 ms later, the VTIMER exit with the PC at the next instruction; 1.3 ms after that, the kick's `canceled`. Sitting A's timeline, with real times.

## Level behaviour, seen from the outside

First, journal question 3: what if the timer fires while the guest has IRQs masked? We changed the guest so that, in its first round only, it spins for 300 ms with `PSTATE.I` still set, then unmasks for one instruction:

:::term source=captures/11-masked-irq.txt

The VTIMER exit came at 101.9 ms, while the guest spun with IRQs masked: the exit does not wait for the guest. Then a `canceled` every 1.3 ms, as each entry set the pending IRQ and armed the kick.

Interval 0 reads 300 ms (exit code 6), because the handler ran only when the guest unmasked. For 200 ms the interrupt existed only as state: `ISTATUS`, our line, and the pending IRQ. (Round 0 had no WFI exit: the handler ran during the one-instruction unmask, so `FIRED_AT` was already set and the loop never called `wait_for_interrupt`, hence `wfx 9`.)

To repeat it: in round 0 of `guests/timer-nogic/main.rs`, after `arm_in`, spin until `guest::cntvct()` passes `start + 3 * freq / 10`, then run `msr daifclr, #2`, `isb`, `msr daifset, #2` once; run `scripts/build-guests.sh`, and undo it afterwards.

> **Try it.** In your `nogic_before_entry`, unmask the vtimer whenever it is masked, instead of waiting until the timer stops asserting (`if action.unmask || masked`). Predict the `vtimer` count after ten seconds, then compare with our run in the next block. Look at what the guest printed.

:::term source=captures/11-unmask-early.txt

8,379,518 VTIMER exits in ten seconds, and no interval printed: unmasked while `ISTATUS = 1`, the vtimer exits again at once. That is why the header says to unmask only once the guest "has completed servicing" the interrupt.

## What a tick costs

Now turn exits into cost, with your own chapter 03 figure from `learner/journal/03.md`; ours was 1.43 µs per exit. At 10 Hz, 30 timer exits per second cost about 43 µs of host CPU per second: 0.004% of one core. The run measured 2% (0.020 s over 1.08 s): the timer exits are a sliver; the rest is starting the VMM, 495 printing exits and the stale re-takes before each kick. Linux commonly ticks at 250 Hz.

:::predict At 250 Hz, a tick every 4 ms, how many timer exits per second do you expect, how much host CPU should they cost by your exit-bench arithmetic, and will the guest still keep good time?
We ran the guest changed to 250 rounds of 4 ms each, printing one summary: total time, ticks per second achieved, and the mean, smallest and largest interval.

:::term source=captures/11-250hz.txt

Three exits per tick: `vtimer 250, wfx 250, canceled 250`. But the 250 ticks took 1,656 ms, 150 ticks per second. The guest did not keep good time: mean interval 5.1 ms against 4 asked, worst 12.4 ms, only 64 of 250 within 3 to 5 ms (hence exit code 6).

Where did the time go? The guest's interval runs from arming to its handler: 4 ms plus about 1.1 ms of lateness (our wake-up and two exits), 5.1 ms. The stale re-takes come after the handler and before the next arm: about 1.4 ms per round (0.358 s of `exec` / 250, `stale=8580120`). So a round is 4 + 1.1 + 1.4, about 6.5 ms, close to the 6.6 ms measured (1,656 / 250).

Exit-bench arithmetic predicted about 0.1% of a core (750 × 1.43 µs, about 1.1 ms per second); we measured 23% (0.369 s). The gap is the stale re-takes, not the exits.
:::

To repeat it, in `guests/timer-nogic/main.rs` change `0..10` to `0..250` and `freq / 10` to `freq / 250`, run `scripts/build-guests.sh` and the command from "The run", and undo it afterwards. Your guest prints 250 interval lines instead of our summary, but the `--stats` lines compare directly.

> **Aside.** Linux's driver for this timer, [`drivers/clocksource/arm_arch_timer.c`](https://github.com/torvalds/linux/blob/master/drivers/clocksource/arm_arch_timer.c), makes our guest's moves (read `CNTFRQ_EL0`, program the compare value, silence the timer in its handler), with a controller in between.

## Breaking it on purpose

Edit, predict, run, undo.

**Deliberate breakage 1: WFI returns at once.** Make your `nogic_wfi` return `Resume { advance_pc: true }` immediately, without sleeping. Predict: do the ten intervals still pass, and what does `--stats` say?

:::term source=captures/11-wfi-spin.txt

Every interval passed. But 900,973 WFI exits and 90% host CPU: the guest's `WFI` and our handler bounced off each other. The checkpoint refuses it twice: the trace of almost half a million WFI exits outgrows its 32 MiB cap, and host CPU is 93%, not under 10%:

:::term source=captures/11-wfi-spin-checkpoint.txt

What you saw: a correct guest, a busy core. The misconception: "a WFI handler must wait, or the guest breaks"; returning at once is correct, only expensive. The tool: `--stats`.

**Deliberate breakage 2: never clear the vtimer mask.** Restore the sleep. In your `nogic_before_entry`, never call `set_vtimer_mask(false)`. Predict how many intervals print:

:::term source=captures/11-mask-forever.txt

One interval, then nothing until the timeout (exit code 5): `vtimer 1` against 9.4 million WFI exits, at 97% CPU. The guest re-armed its timer and it fired, but the vtimer was still masked, so no VTIMER exit came and our line stayed down; our WFI handler found the deadline past and woke at once, every time.

What you saw: one tick, then a hang that burns a core. The misconception: "the guest forgot to re-arm"; the mask was ours to clear. The tool: `--stats` (one VTIMER exit against millions of WFI exits).

## Your turn

Check:

1. Your run prints `10/10 intervals within 95..150 ms` and a `stats:` line under 10% host CPU.
2. Your trace has VTIMER and WFI records. Each of these prints 10:

```sh
grep -c '"reason":"vtimer"' t.jsonl
grep -c '"ec":"0x1"' t.jsonl
```

3. Your journal has the Predict entry, written before your first run, and answers for questions 1 to 5.

Stuck? `scripts/learner hint 11` gives four hints, up to the exact reference anchor.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (offset, deadline and unmask rules, hostile timer values, the one-vCPU fence), runs `timer-nogic` with `--stats` and the trace, and checks your journal. Ours shows the journal skipped because it ran on the reference:

:::term source=captures/11-checkpoint.txt

What now works:

- a guest counter that starts near zero, and an alarm that interrupts, with your VMM as the wire;
- a guest waiting in `WFI` costs about 2% of a core, not 90%;
- `--stats` splits a cost into exits and guest time.

Chapter 12 starts from this state (the reference at the end of chapter 11).

### What's next

Chapter 12 builds the interrupt controller this chapter did without, then hands the job to Hypervisor.framework's own, inside the macOS kernel. The same ten sleeps will run with no VTIMER or WFI exits at all.

### Open question

Our one line served one source. The UART (universal asynchronous receiver-transmitter, our PL011) also wants to interrupt when a byte arrives. With a single IRQ input per CPU, how would a handler know which source fired, which one is more urgent, and which CPU should take it?

## Spec hunt

- ARM ARM (DDI 0487), register page **CNTV_CTL_EL0, Counter-timer Virtual Timer Control Register**: which bit is read-only, what sets it, and what does `IMASK` do to the interrupt output while the condition holds?
- ARM ARM, the description of the **WFI** instruction and the section on wait-for-interrupt wake-up events in the AArch64 power management chapter: which events end a `WFI`, and where does the manual allow it to end for no reason at all?
- The SDK (software development kit) header `hv_vcpu.h`, on `hv_vcpu_set_vtimer_mask` and `hv_vcpu_set_pending_interrupt`: what must a VMM detect before it clears the mask, and how long does a pending interrupt you set stay pending?
