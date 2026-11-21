---
title: Hardening: threat model, fuzzing and sandboxing
part: XI
chapter: XI.1
id: 25
runs: mac+browser
minutes: 360
prereqs: [16]
start_tag: ch-24
labs: [hostile-guest]
command: scripts/checkpoint.sh 25
expect: CHECKPOINT 25 PASS
---

:::retrieval from=13,09,04

:::concepts
- **Core, taught here:** the trust boundaries of a virtual machine monitor (VMM) and a threat model; terminal injection in full; fuzzing (a seeded pseudo-random number generator, structure-aware mutation, a corpus, invariants, minimisation); the hostile guest; confining the VMM process after set-up.
- **Core, from earlier:** the guest as an adversary (chapter 04); virtqueues, the hop budget, TOCTOU and copy-then-validate (chapter 16); the output filter (chapter 09); containment and the opt-in `,learn` peer (chapter 19); UNDEF injection and exit codes (chapter 08); the reset limit and PSCI, the power state coordination interface (chapters 08, 14); `DEVICE_NEEDS_RESET` (chapter 15); `CPU_ON` (chapter 20); accesses whose instruction syndrome is not valid (ISV=0) and the injected abort (chapter 21).
- **Primers (read first):** `macos-sandbox` (Seatbelt, SBPL profiles, `sandbox_init`, the "checked when a resource is acquired" rule, rlimits and core dumps, `umask`, `O_CLOEXEC`, why the run path never forks).
- **Primers (review):** `tty-termios` (escape sequences, the terminal attack strings); `codesign-entitlements` (its "going deeper" parts: an entitlement is a permission, not a fence; the hardened runtime).
- **Pointers:** STRIDE and `docs/security/threat-model.md` (an Aside); `cargo fuzz` and coverage-guided fuzzing (an Aside); the confused deputy (one sentence and a link).
- **Forward definitions:** none.
:::

Outside two quarantined places (the `hvf` crate, which holds the hypervisor calls and a few host calls such as the sandbox, and the guest-memory mapping), our VMM forbids `unsafe` code. Now delete one line from chapter 16's descriptor-chain walker, the hop budget, and point a program that invents hostile virtqueues at it. Then plant a subtler bug that fires only when a chain holds three buffers and the first and third share an address. How long does an automatic search need for each?

:::predict For the missing hop budget, and then for the three-buffer bug: will a fuzzer find it in about 10 seconds, about 10 minutes, or never?
Write both guesses, with one sentence of reasoning each, under `## Predict` in your journal. Sitting A runs both plants with the reference's fuzzer; then you time your own fuzzer on the same two.
:::

Chapter 00's [problem ledger](/build-your-own/vmm/glossary/#problem-ledger) listed what a kernel assumes it owns. Every row is now closed, and each mechanism that closed one (exits, memory-mapped I/O (MMIO), rings, the console) is also a door the guest can push on. This chapter adds no row; it reads the ledger the other way round: every row is also an input the guest controls, so what can a guest that is *trying* to hurt us do with each one? Sitting A (about 3.5 hours) is the threat model, the reference's fuzzer, and your own fuzzer; sitting B (about 2.5 hours, at your Mac) is the hostile guest and the sandbox.

:::objectives
- (Sitting A) Write a threat model for your VMM in STRIDE style (a six-letter checklist of threat kinds, below): assets, every trust boundary, what each attacker can do. Cross-check it against the reference's `docs/security/threat-model.md`.
- (Sitting A) Build a dependency-free fuzz harness (a seeded generator, structure-aware mutation of descriptor chains, invariants checked after every input) that runs device models on the host, find each planted bug in the queue code, and minimise each reproducer.
- (Sitting B) Run the hostile guest's eight attack phases (MMIO, ISV=0, system registers, SMCCC (SMC calling convention, where SMC is the Secure Monitor Call instruction) calls, virtqueues with a live time-of-check-to-time-of-use (TOCTOU) race, terminal strings, a reset storm, an output flood) and explain each expected exit code.
- (Sitting B) Confine the process after set-up with `--sandbox`, set `RLIMIT_CORE` to 0, and measure what the sandbox denies.
:::

**Before you start.** From the repository root, run `scripts/learner start 25`; it copies this chapter's journal to `learner/journal/25.md`, "your journal" below. There is no starter code: you create `learner/crates/fuzz/` and `learner/crates/macvmm/src/sandbox.rs` in Your turn.

## Memory-safe is not the same as safe

The tempting belief is "Rust is memory safe, so a Rust VMM is secure". `forbid(unsafe_code)` rules out reading past a buffer, using freed memory, a race that tears a value in half. It cannot rule out a program that is memory safe and *wrong*. Five classes survive, each with a candidate in our VMM:

| Class | What the guest controls | An instance in our VMM |
|---|---|---|
| logic bug | the numbers we check | a range check that adds `addr + len` with wrapping arithmetic (chapter 04) |
| resource exhaustion | how much work it asks for | a `--trace` file the guest could grow without bound, had it no size cap |
| infinite loop | the shape of a data structure | a descriptor whose `next` points at itself (chapter 16) |
| TOCTOU (time of check to time of use) | the bytes between our two reads | a descriptor `len` read once to check and again to use (chapter 16) |
| confused deputy | a name we act on with our rights | a `--serial file:` path (chapter 09) that names the guest's own disk image |

A [confused deputy](/build-your-own/vmm/glossary/#confused-deputy) is a privileged program tricked into using its rights for someone else ([Hardy, 1988](https://dl.acm.org/doi/10.1145/54289.871709)). Our VMM can open any file you can, so a path handed over for one purpose must never serve another.

None of these is a crash. The worst return `Ok` with a wrong answer, so a test that only asks "did it panic?" finds none of them.

## A threat model on one page

Before hunting bugs, decide what you are protecting and from whom. Writing that down is a [**threat model**](/build-your-own/vmm/glossary/#threat-model). It has three parts.

**Assets**, what an attacker wants: your user account (files, keys, shell), your terminal, the VMM process itself (it holds guest RAM and open disk images), the disk images and the files near them, and the Mac's CPU, memory and disk space.

[**Trust boundaries**](/build-your-own/vmm/glossary/#trust-boundary), where data crosses from someone you trust less to someone you trust more:

```text
 guest (hostile)            macvmm process (your rights)              host
+--------------+ traps into +--------------------------+ writes to +---------------+
| guest kernel | ---------> | exit decode, devices,    | --------> | your terminal |
| and its apps |            | GuestMemory copies,      |           +---------------+
|              | =========> | loaders, CLI             | <-------- | your files,   |
+--------------+ shares RAM +--------------------------+   reads   | .cache/macvmm |
                    with                 ^                         +---------------+
                                         | plant links for,                ^
                                         | connect to                      | downloads into
                               +-------------------+               +---------------+
                               | other local users |               |   internet    |
                               +-------------------+               +---------------+
```

*Each row below is an arrow; the guest has two, because it reaches us by trapping and through shared RAM.*

| Boundary | Who is distrusted | What crosses |
|---|---|---|
| guest to VMM | the guest, fully | every register on an exit, every MMIO value, every byte of guest RAM, at any moment |
| VMM to terminal | the guest's output | serial and console bytes, which can be escape sequences: [terminal injection](/build-your-own/vmm/glossary/#terminal-injection) |
| host files to VMM | the file's *content* | Image, ELF, initramfs and disk bytes (you chose the path, not what is inside) |
| internet to cache | the download | anything until its sha256 matches the pinned value |
| other users to VMM | other accounts on the Mac | planted symlinks, world-readable outputs, connections to sockets |

**Attackers and their capabilities.** The [malicious guest](/build-your-own/vmm/glossary/#malicious-guest) runs any code at exception level 1 (EL1, the guest kernel's level) on every virtual CPU (vCPU) at once, rewrites RAM while we read it, traps as often as it likes and chooses every value it hands us; stage 2 keeps it out of host memory. A malicious *file* can be any bytes. Another local user can create files and symbolic links in shared directories such as `/tmp` before macvmm does, and connect to any socket macvmm leaves open to everyone; the `umask 077` below and opens that never follow a symbolic link answer that (see the next paragraph). A network attacker on the download path can serve any bytes; the pinned sha256 answers that. A [**compromised VMM**](/build-your-own/vmm/glossary/#compromised-vmm) is what you get if any of them succeeds: code running as you, with the hypervisor entitlement and every file descriptor macvmm holds. Sitting B shrinks that last one.

Chapter 10 promised to explain why the reference's `open_output` (in `crates/vmm/src/backend/hostio.rs`), which opens every file macvmm writes, checks more than "no symbolic link". Each check answers one of the attackers above. It resolves the directory you named once (a link you typed, such as `/tmp`, is your intent), then opens the file with a flag that refuses a symbolic link anywhere in that path, so a link planted as the file's name, or swapped in afterwards, is refused. It requires a regular file *owned by you*, so a file another user planted at the name is refused rather than written. It requires a link count of 1, because macOS lets any user make a hard link (a second name for the same file) to a file they do not own: a hard link to one of *your* files, planted in `/tmp`, passes the owner check, and writing through it would empty the original. It refuses a file that is already open as an input or output, the confused-deputy row of the table above: `--serial file:` naming the guest's own disk image. Only after every check passes does it empty the file.

[**STRIDE**](/build-your-own/vmm/glossary/#stride) is a checklist so no kind of threat is forgotten. Each letter is a kind of threat: **S**poofing (pretending to be someone else), **T**ampering (changing data you rely on), **R**epudiation (doing something and denying it), **I**nformation disclosure (reading what you should not), **D**enial of service (making the VMM stop or crawl), **E**levation of privilege (gaining rights you were not given). Walk each boundary through the six letters and write the mitigation, or "n/a", next to each. One row, worked:

```text
guest to VMM
  S  n/a: the guest is the only party on this boundary
  T  rewrites descriptors mid-walk         -> copy-then-validate (chapter 16)
  R  n/a: we do not hold the guest to account
  I  reads past its buffer                 -> bounds-checked GuestMemory (chapter 04)
  D  a descriptor chain that loops         -> the hop budget (chapter 16)
  E  runs code inside macvmm               -> --sandbox (sitting B)
```

> **Aside.** STRIDE comes from Microsoft ([their description](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)). The reference's `docs/security/threat-model.md` has a STRIDE table naming each surface and mitigation; its row tags (`VQ-5`, `MEM-7`, `SBX-2` and so on) reappear in the reference's code and messages below.

Write yours now in `learner/docs/security/threat-model.md`: the assets, the boundary table, five attackers with one paragraph each, and a STRIDE row for each of the other four boundaries. It is the evidence for journal question 2.

## Let a program write the hostile inputs

Chapter 16's hostile tests are cases *someone thought of*; the bugs that survive are the ones nobody did. So let a program build millions of slightly wrong inputs, run the real code on each, and check that nothing went wrong. That is [**fuzzing**](/build-your-own/vmm/glossary/#fuzzing). Five decisions turn the idea into a tool; the reference's `crates/fuzz/` depends only on the workspace's own crates (`vmm` and `xtask`).

**Randomness you can replay.** A bug found once and never again is useless, so inputs come from a [**seeded PRNG**](/build-your-own/vmm/glossary/#seeded-prng) (pseudo-random number generator): arithmetic that turns a starting number, the seed, into a random-looking stream, identical on every run. Ours is xorshift64*, three shifts and a multiply:

:::code anchor=fuzz_rng_next file=crates/fuzz/src/rng.rs

Iteration `i` derives its own generator from the seed and `i`, so iteration 23,338,941 *could* be regenerated from those two numbers alone, without the 23 million before it. In practice the saved input replays it (below); a `--start N` flag would be a small addition to your own fuzzer:

:::code anchor=fuzz_rng_derive file=crates/fuzz/src/rng.rs

**A target is a function of bytes.** Each [fuzz target](/build-your-own/vmm/glossary/#fuzz-target) decodes bytes into an input for one parser or device model, runs the real code against test doubles (chapter 04's `VecMemory` RAM, a fake interrupt line), and reports a verdict. It also knows how to build a well-formed input and how to damage one:

:::code anchor=fuzz_target_struct file=crates/fuzz/src/lib.rs

No Hypervisor.framework: the virtqueue target drives the device worker's own `Queue::pop`, `into_validated` and `add_used` on the host.

**Invariants, not only panics.** The [invariants](/build-your-own/vmm/glossary/#invariant) are the test oracle, the part that decides pass or fail: properties that must hold after *every* input. The virtqueue target checks five:

1. No panic, and a ring error marks the queue broken.
2. Bounded work: at most `2N + 1` descriptor reads per pop, for a queue of `N` entries. The hop budget allows `N` reads in the main table and restarts for one indirect table of at most `N` entries; the `+ 1` is one read of slack.
3. Each descriptor of a validated chain was read once; a second read is a double fetch.
4. Every validated buffer lies inside one RAM region, and each direction's total is within the cap.
5. The device writes only into the chain's writable buffers and the used ring.

Messages carry the tag of a row of the reference's threat model: invariant 2 reports as `VQ-5`, 3 as `MEM-7`, 4 as `VQ-4` and 5 as `VQ-9`. Here are invariants 3 and 4. Invariant 4 adds address and length in 128-bit arithmetic, so the check itself cannot overflow:

:::code anchor=fuzz_read_once file=crates/fuzz/src/targets/virtqueue.rs

:::code anchor=fuzz_in_one_region file=crates/fuzz/src/targets/mod.rs

The fuzz RAM has two regions and a hole on purpose: "inside one region" can only fail, and so be tested, when there are two. We write a buffer as address+length, so `0x40008000+16` means 16 bytes starting at `0x40008000`:

```text
0x4000_0000  region A, 256 KiB: descriptor table 0x4000_1000, avail ring 0x4000_2000,
             used ring 0x4000_3000, indirect table 0x4000_4000, buffers from 0x4000_8000
0x4004_0000  the hole, 256 KiB of not-RAM
0x4008_0000  region B, 64 KiB: more buffers
0x4009_0000  end of RAM
```

How do bytes become a ring? The input has fixed offsets, so the mutations below know where each descriptor sits:

:::code anchor=fuzz_vq_input file=crates/fuzz/src/targets/virtqueue.rs

Byte 0 picks the queue size, byte 1 the options, bytes 8 onwards are the avail-ring entries (the heads of the chains the driver offers), and from byte 520 come 16-byte descriptors, each laid out as chapter 16's descriptor (address, length, flags, next). When you design your own target, choose your own layout or copy this one. The target writes those bytes into the fuzz RAM as rings, then runs them:

:::code anchor=fuzz_virtqueue_target file=crates/fuzz/src/targets/virtqueue.rs

**Mutation that knows the shape.** Random bit flips mostly give chains that die at the first check (`next` out of range). The [structure-aware mutation](/build-your-own/vmm/glossary/#structure-aware-mutation) knows where the 16-byte descriptors are and damages them as an attacker would: `next` pointing back, or a length that ends a few bytes into a region, often the other one. `rec` is the byte offset of descriptor `i`; `ADDR`, `LEN`, `FLAGS` and `NEXT` are field offsets, and `F_NEXT` is the NEXT flag:

:::code anchor=fuzz_mutate_shapes file=crates/fuzz/src/mutate.rs

Another move aims the address at the edges, the "specials": the last bytes of a region, the hole, a device window, the rings themselves:

:::code anchor=fuzz_mutate_aim file=crates/fuzz/src/mutate.rs

**An input generator instead of a stored corpus.** Fuzzers usually damage a [**corpus**](/build-your-own/vmm/glossary/#corpus), a set of good inputs. Ours draws a fresh well-formed ring each iteration (one to four buffers per chain, readable before writable, some indirect; the target's `seed` function, not the PRNG's seed), then damages it up to eight times, each step, by coin toss, a structure-aware move or a byte-level mutation (a bit flip, a random byte, a boundary integer such as `0xffff_ffff`):

:::code anchor=fuzz_loop file=crates/fuzz/src/main.rs

A failing input is saved (mode `0600`, never overwriting) and becomes a regression test. Safe Rust cannot interrupt a hang, so a watchdog thread saves any input that runs over two seconds and exits with `HANG`.

> **Aside.** Our fuzzer is blind: it never learns which inputs reached new code. A [**coverage-guided**](/build-your-own/vmm/glossary/#coverage-guided-fuzzing) fuzzer does, and keeps mutating those. `cargo fuzz` drives one, libFuzzer ([the Rust Fuzz Book](https://rust-fuzz.github.io/book/cargo-fuzz.html)); it needs a nightly compiler, so it stays optional here, and every target is exported as `fuzz_<target>(&[u8])` for it.

The lab brings the fuzzer to your browser:

:::lab hostile-guest

If it does not load, nothing is lost: it mutates chains for chapter 16's queue model and stops at the first input that breaks an invariant.

## Ten seconds, or never?

The plants are patches in `crates/fuzz/planted/`, written against the reference's `chain.rs` and `queue.rs`, so they will not apply to your own walker. To run one, copy the reference, patch the copy, and fuzz it. Use one fresh copy per plant, and never patch a copy twice: a second patch either fails or stacks two bugs. From the repository root:

```sh
P=02-chain-no-hop-budget
rsync -a --exclude /target --exclude /.cache --exclude /.git --exclude /learner ./ "$TMPDIR/$P/"
cd "$TMPDIR/$P" && patch -p1 < "crates/fuzz/planted/$P.patch"
cargo run -q --release -p fuzz -- virtqueue --seconds 600
cd -
```

The leading `/` makes each `--exclude` skip only the top-level directory of that name; without it, rsync also drops the course tooling's own `learner` module, and the copy does not build. The first run in a copy builds the workspace in release mode before fuzzing, so judge the fuzzer by its iteration count, not your stopwatch. `cd -` returns you to the repository root.

This plant deletes the hop-budget decrement. With the default seed, 1, you should see our iteration numbers on any Mac; the seconds depend on the machine, and `--seed 2` gives other numbers. (Most of our runs used `--seconds 590` so they fit our recording tool's ten-minute limit; use 600. `/usr/bin/time -p` adds the real/user/sys lines.) Check your Predict entry, then our run:

:::term source=captures/25-predict-hop.txt

Iteration 7, under a second, and not a hang. The saved input is a two-entry queue whose second descriptor points at itself. The walk went round it until the chain's total passed its 64 KiB cap and the walker gave up by itself; only invariant 2 noticed that 2,838 reads for a two-entry queue is a loop. One check (the byte cap) covering for a missing one (the hop budget) is [**defence in depth**](/build-your-own/vmm/glossary/#defence-in-depth), and here it hid the bug from everything except the invariant.

The second plant, `05-chain-verdict-cache.patch`, adds a "verdict cache": a buffer at the same address as the buffer two hops earlier skips the RAM check, whatever its length:

:::term source=captures/25-predict-seq3.txt

Iteration 23,338,941, after 128 seconds. The failing buffer, `0x40003000+0x80000000`, starts at the used ring, one of the specials. Two descriptors two hops apart had to receive the *same* special address; drawn from all 2^64 addresses, they would essentially never match. Structure made the search possible. Would coverage guidance make it shorter? We did not measure that; it is worth asking which new code path a coverage-guided fuzzer would see first. Write our two times in your journal; you add your own fuzzer's times in Your turn.

The saved input replays, as it must:

:::term source=captures/25-replay-saved.txt

It is 5,640 bytes, of which 162 are not zero (`wc -c`, before and after deleting the zero bytes with `tr -d '\000'`), and most of those are unrelated to the bug. [**Minimising**](/build-your-own/vmm/glossary/#minimisation) a reproducer means finding the smallest input that still fails, so a human can read the cause: repeatedly zero or delete a chunk (halves, then quarters, down to single bytes), keep each change after which the replay still fails, and stop when none does.

You write the minimiser in Your turn; the reference has none yet. So we built by hand what one aims for, from the input layout above: one chain of three buffers, readable `0x40008000+16`, writable `0x40009000+16`, writable `0x40008000+0x40000`, which runs off the end of region A. It ships as `crates/fuzz/planted/05-three-buffers.bin`: 568 bytes (the header, the avail entries and three descriptors), 17 of them not zero. It fails against the planted copy, and passes against the unmodified reference:

:::term source=captures/25-replay-seq3.txt

:::term source=captures/25-replay-ref.txt

## Breaking it on purpose

The other plants are the chapter's mandatory breaks. Run each in its own fresh copy, with the recipe above and `P` set to the plant's name.

**Deliberate breakage 1: drop the `checked_add`.** `01-chain-range-no-checked-add.patch` checks a buffer's first and last byte separately, computed with wrapping arithmetic, instead of the span. Predict: which invariant fires, and does any single byte of the buffer lie outside RAM?

:::term source=captures/25-break-checked-add.txt

`0x4002e6e9+0x5193a` ends at `0x40080023`: first byte in region A, last in region B, the hole between them not RAM. Each endpoint passed; the span did not. The plant removes two checks, the `checked_add` and the span check, and the fuzzer hit the second. In this machine it can only ever hit the second. A length is 32 bits and all RAM lies below `0x4009_0000`, so a sum that wraps past 2^64 must start above 2^64 − 2^32. No RAM is there, and the first-byte check refuses it. Predict, then check it in your patched copy: a descriptor at `0xffff_ffff_ffff_fff0` with length `0x40000020` wraps to `0x40000010`, inside RAM, yet it is refused at its first byte. The `checked_add` earns its place when RAM sits near the top of the address space, or when a length is 64 bits wide. The misconception: "checking both ends checks the range". The tool: invariant 4, computed independently in wider arithmetic.

**Deliberate breakage 2: an off-by-one in the ring index.** `03-used-idx-off-by-one.patch` computes the used-ring slot as `next_used % (N + 1)` instead of `% N`. Predict: what does the device write, and where?

:::term source=captures/25-break-ring-index.txt

A two-entry used ring at `0x40003000` is `0x16` bytes: flags, index, 8-byte elements at `+4` and `+12`, and the 2-byte `avail_event` at `+0x14` (chapter 16). Slot 2 lands at `+0x14`: over `avail_event` and six bytes past the ring's end. The misconception: "an index bug only corrupts the guest's own ring". The tool: invariant 5, the audit of every device write.

> **Try it.** `04-desc-len-double-fetch.patch` re-reads a descriptor after validating it and keeps the second `len`. The plain target catches it from the access log (invariant 3). The hidden `virtqueue_race_only` variant has no log, only a second thread rewriting lengths during the walk, so it finds the bug only by winning the race. Run it twice with the same seed: ours failed once at iteration 87,420 and once, in the self-test below, at 2,025. A race does not replay from a seed.

The reference's self-test, `scripts/bughunt-selftest.sh`, runs plants 1 to 4, each in a private copy, and requires each to be found within the time limit (ten minutes by default; two in this run). It counts the double fetch too, so it ends with `4/4`:

:::term source=captures/25-bughunt-selftest.txt

Descriptor chains are one hostile input; the reference has 21 more targets: the MMIO register files, the Image, ELF and initramfs loaders, the blk device and the output filter among them (`scripts/fuzz.sh all --seconds 2` runs each for a two-second smoke test; all 22 passed on our Mac). The virtio-mmio target decodes its bytes as a sequence of guest register accesses, 11 bytes each, and checks after every write that no queue register changed while the queue was ready:

:::code anchor=fuzz_mmio_sequence file=crates/fuzz/src/targets/virtio_mmio.rs

Before you stop, do Your turn items 1 to 4 (the crate, the virtqueue target, the minimiser, the plants), and check that `cargo run -q --release -p fuzz -- virtqueue --seconds 20 --seed 1` exits 0 from inside `learner/`.

:::stopping-point Good place to stop. Sitting B needs your Mac and about 2.5 hours.

## The hostile guest

Since chapter 00, "a hostile guest" has meant any guest that misbehaves on purpose, the malicious guest above. Here it is also a program you run. The [**hostile guest**](/build-your-own/vmm/glossary/#hostile-guest) suite attacks the real VMM from inside a virtual machine: bare-metal guests in `guests/hostile-*`, each a phase with an exit code the VMM must end with. A VMM survives by turning every misdeed into a guest-visible answer (an exception, `-1` in `x0`, `DEVICE_NEEDS_RESET`) or a defined stop; exit code 1, a VMM error, caused by a guest is always a bug.

| Phase (guest) | The attack | Expected outcome |
|---|---|---|
| MMIO sweep (`hostile-mmio`) | every device window, width and byte offset, then 20,000 random accesses | exit 0 with `--unhandled-mmio log`; unknown registers read as zero |
| ISV=0 garbage (`hostile-isv0`) | load and store pairs across a device boundary, SIMD (single instruction, multiple data: vector-register) stores | exit 0; an abort injected each time |
| system registers (`hostile-sysreg`) | all 16,384 `S3_*` encodings read; each whose read was UNDEF is then written (the Generic Interrupt Controller (GIC) CPU-interface block is skipped) | exit 0; a value or an UNDEF each time |
| SMCCC garbage (`hostile-smp`, 4 vCPUs) | 12,000 random calls, then a `CPU_ON` storm | exit 0; `-1` for every unknown call |
| virtqueues (`hostile-vq`, `hostile-smp`) | loops, rings at the end of RAM, index jumps, a second vCPU rewriting descriptors | exit 0; `DEVICE_NEEDS_RESET`, then recovery |
| terminal strings (`hostile-tty`) | 22 attack strings: title, clipboard, queries | exit 0; no escape sequence reaches stdout |
| reset storm (`hostile-reset`) | `SYSTEM_RESET` on every boot | exit 3 (guest fatal) within 10 s |
| output flood (`hostile-flood`) | 4 MiB into `--serial file:F,max=1M`, a file capped at 1 MiB | exit 0; the file holds exactly 1 MiB |

The phases exercise chapters 17 (virtio-rng), 18 (a read-only virtio-blk disk), 20 (several vCPUs) and 21 (accesses with ISV=0); if your VMM lacks one, that phase cannot pass. As a reminder: an UNDEF is an undefined-instruction exception, `CPU_ON` starts another vCPU, and the abort (a synchronous external abort) is what a real bus gives for an access the VMM will not decode: errors the guest can handle.

Run the phases from inside `learner/`, so `cargo run` builds *your* VMM, with `G` set as in chapter 09. Our captures ran from the repository root, so their paths start at `target/`; from `learner/`, prefix them with `../`. Each phase is one guest run, and each capture shows its flags:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --testdev --kernel $G/hostile-isv0 --timeout 10
```

:::term source=captures/25-hostile-isv0.txt

All 15 attempts came back as aborts, and the device kept its state. The MMIO sweep needs `--unhandled-mmio log`, because it probes addresses where no device lives; under the default policy, `fatal`, the first such access ends the run with exit 3. The stray characters are bytes written into the data register of the UART (the universal asynchronous receiver-transmitter, our PL011):

:::term source=captures/25-hostile-mmio.txt

The 150,926 alignment faults are the guest's own. It runs with its memory management unit (MMU) off, so every access is to Device memory, where an unaligned access faults inside the guest (chapter 06) before it could reach us; the guest counts them and moves on. What matters is `0 other data aborts` and exit 0.

The live TOCTOU phase is the one Rust cannot help with. vCPU 1 scribbles over the descriptor table while vCPU 0 rings the doorbell. Before and after, the guest hashes 16 MiB of its own RAM that no descriptor names, a [**canary**](/build-your-own/vmm/glossary/#canary) region. The VMM's device writes land in guest RAM, so a stray write would change the hash, and the guest would see it. It needs chapter 18's test disk, opened read-only. As in chapter 18, the disk tool runs at the repository root; make it once:

```sh
cargo xtask mkdisk --size 64M --seed 1 --out learner/disk.img
```

Then, back in `learner/`, the run uses `--disk disk.img,ro`; our capture, from the root, names `learner/disk.img`:

:::term source=captures/25-hostile-toctou.txt

About 10,600 requests served, about 187,000 attacks ended in a device reset, the canary intact, the image unchanged. Each refusal is the walker's own copy of a descriptor failing a check, whatever vCPU 1 wrote afterwards.

The terminal phase writes the forbidden list to the UART:

:::term source=captures/25-hostile-tty.txt

The odd middle line is all that is left of 22 attack strings: `link` is a hyperlink's text. `6n` and `52;c;AAAA` are the tails of a status query and a clipboard write sent with a one-byte introducer (`0x9B`, `0x9D`): the filter drops that byte, so the rest is inert text. (`0x9D` is the one-byte form of `ESC ]`, which starts an operating system command, OSC.) `\x07` is how the capture shows one BEL (bell) byte, 0x07, allowed at most once a second. The final `6n` is the same status query again, its introducer encoded as UTF-8 (U+009B, bytes `C2 9B`), dropped the same way. Nothing left can make a terminal act. The reset storm is the one phase whose correct ending is a fatal stop:

:::term source=captures/25-hostile-reset.txt

## Tying our own hands: the sandbox

Suppose a bug survives all that and a guest runs code inside macvmm. Our one entitlement is a permission, not a fence (the `codesign-entitlements` primer): the process can still read `~/.ssh`, open sockets and start a shell. Chapter 19 named what we want instead, [containment](/build-your-own/vmm/glossary/#containment). The fence is a [**sandbox**](/build-your-own/vmm/glossary/#sandbox), rules the kernel enforces on a process: `sandbox_init` (the `macos-sandbox` primer), applied once, irrevocably, with a profile. macvmm's base profile is `(deny default)` with almost nothing allowed:

:::code anchor=sandbox_profile file=crates/macvmm/src/sandbox.rs

Four `ioctl`s (device commands, here to the terminal) are allowed so the exit path can restore your terminal settings; `TIOCSTI`, which fakes typed input, stays denied. There is no `mach-lookup` and no `iokit-open`: Hypervisor.framework needs neither to create, run, destroy and re-create a virtual machine (VM). One thing is added per run: for each `--net ...,peer=PATH` (chapter 19), `profile_for` appends an `allow network-outbound` rule for exactly that Unix socket, plus metadata reads of the symbolic links on its path. `--net ...,learn` is refused under `--sandbox`, because its peer is not known when the profile is written. Three tests checked this on a real Mac: four vCPUs created after the lockdown, an in-process reboot that builds a new VM under it, and the limits line:

:::term source=captures/25-sandbox-reboot.txt

*When* matters as much as *what*. The sandbox checks a resource when it is acquired, so `run` first opens every file and starts every host thread (the terminal, the signal thread, the stdin thread):

:::code anchor=sandbox_threads_first file=crates/macvmm/src/cli.rs

and only then locks down, before the first guest instruction:

:::code anchor=sandbox_confine_call file=crates/macvmm/src/cli.rs

`confine`, above it, [fails closed](/build-your-own/vmm/glossary/#fail-closed): `--sandbox` exits 1 if the lockdown fails; only `--sandbox=best-effort` warns and runs without it. The lockdown first drops the file-descriptor limit (`RLIMIT_NOFILE`, `nofile=` in `--stats`) to one past the highest descriptor in use, plus 16. The profile still lets the process create descriptors that need no path, so the cap bounds how many a compromised macvmm could hoard; the 16 spare cover what later work opens without a path, such as vCPU threads and the new VM of a reboot:

:::code anchor=sandbox_lockdown file=crates/macvmm/src/sandbox.rs

The `sandbox_init` call is one of the few `unsafe` blocks, in the `hvf` crate. Its header declares it deprecated, and passing profile text rather than a built-in profile name is undocumented. Deprecated means Apple may stop honouring it in a future macOS. If the call ever started failing, a silent fallback would run the guest unconfined while you believed otherwise, so `--sandbox` treats any failure as fatal:

:::code anchor=host_sandbox file=crates/hvf/src/host.rs

Two smaller defences run first in `main`, sandbox or not. `RLIMIT_CORE` goes to 0, soft and hard: no core dumps (a core would be a file full of guest RAM). That one is a one-way door, since an unprivileged process cannot raise its hard limit again. The `umask` of `077` is only a default, which any code in the process could change, but it makes sure that only you can read what macvmm creates during set-up:

:::code anchor=harden_process file=crates/macvmm/src/main.rs

The hidden `--sandbox-selftest` flag tries three things after the lockdown and requires each to be refused:

:::code anchor=sandbox_selftest file=crates/macvmm/src/sandbox.rs

```sh
cargo run -q -p macvmm -- run --mem 64M --sandbox --sandbox-selftest --stats --kernel target/guests/aarch64-unknown-none/release/hello --timeout 10
```

:::term source=captures/25-sandbox-selftest.txt

The guest ran to completion under the profile. Unsandboxed:

:::term source=captures/25-stats-unsandboxed.txt

`core=0` in both, and the file-descriptor limit fell from 1,048,576 to 21 (the unsandboxed number is inherited from your shell). The kernel also reports each denial to the unified log, as the primer showed. `--last 10s` only covers the last ten seconds, so run `log show` within ten seconds of the self-test, or widen it to `--last 1m`:

:::term source=captures/25-sandbox-log.txt

The open of `/etc/hosts` died resolving the symbolic link `/etc` (on macOS, `/etc` is a link to `/private/etc`, the `macos-sandbox` primer), the connect as `network-outbound`, the spawn at `process-fork`. The socket itself was created: only its use was refused.

> **Production note.** Inside `--sandbox` the process keeps what it holds: guest RAM, the opened disks, the hypervisor. Production VMMs such as crosvm also confine each device in its own process.

> **Security.** The fuzzer asks "is there a bug in the parsers?", the hostile guest "does the whole VMM survive a guest that misbehaves on purpose?", the sandbox "if both missed one, what does the attacker get?". Rely on only one and you fail the day it misses.

## Your turn

The reference shows the finished harness; yours goes in `learner/crates/fuzz/`. Items 1 to 4 belong to sitting A, before the stopping point; items 5 to 7 to sitting B.

1. Create the crate: package and binary both named `fuzz`, a workspace member depending on `vmm` as `{ path = "../vmm", features = ["test-util"] }` and on nothing outside the workspace. Write `rng.rs`, the `Target` struct and the loop. The checkpoint runs `fuzz virtqueue --seconds S --seed 1` and reads two things: a finding prints a line containing `FAILURE` (or `HANG`) and exits 1; a clean run exits 0. Add `--replay FILE`; check that one seed always gives the same iteration numbers. One trap: the checkpoint builds your fuzzer against the *reference's* `vmm`, not yours, so use only the names the reference exports: `vmm::virtio::Queue` (its `pop` and `add_used`), `vmm::virtio::DescriptorChain::into_validated`, `vmm::virtio::ValidatedChain` and `Descriptor`, `vmm::memory::VecMemory` (behind the `test-util` feature) and `vmm::memory::prelude::*`. If your own walker uses other names, add aliases in your `vmm` with the reference's names.
2. Write the virtqueue target through those functions (`pop`, `into_validated`, `add_used`); choose your own input layout, or copy the one above. Start with invariants 2 and 4, then add 3 and 5.
3. Add `--minimise FILE`, the chunk-zeroing loop above, writing the smallest failing input next to the original. Minimise each planted bug's reproducer and note its non-zero byte count.
4. Plant each bug by hand in a copy of your own tree: delete the hop-budget decrement; check a buffer's first and last byte separately with wrapping addition; take the used slot modulo `N + 1`; re-read a descriptor after validating it; and the verdict cache, skipping the RAM check when a buffer's address equals the one two hops earlier. Record how long your fuzzer takes on each, and write its times for the hop budget and the verdict cache under your journal's Predict entry, next to ours.
5. Optional: write a second target, for the virtio-mmio register file or the Image header, with one invariant each.
6. Run each hostile phase in the table on your VMM, from `learner/`, with the flags in its capture. Every phase must end with its exit code; fix what does not.
7. Write `sandbox.rs` (the profile, `profile_for` with its `--net` peers, `lockdown`, the self-test) and call `harden_process` first in `main`. Add `--sandbox` and `--sandbox=best-effort`, the hidden `--sandbox-selftest`, and the `--stats` line `macvmm: stats: rlimit core=0 nofile=N`. Call the lockdown after every file is open and every thread exists, as `run` does above. The self-test must print exactly `sandbox: open denied, socket denied, spawn denied` on stderr (after the `macvmm: ` prefix), the line the checkpoint matches.
8. Finish your threat model, then compare it with the reference's, row by row.

Stuck? `scripts/learner hint 25` gives a ladder of hints, from the concept to the reference file to read. Read the matching reference file only after a real attempt.

## Checkpoint

Back at the repository root, run:

:::checkpoint

The plants cannot apply to your walker, so the checkpoint brings your fuzzer to them: it copies the reference's crates, puts your `crates/fuzz` in place of ours, applies one plant, builds, and runs `fuzz virtqueue --seed 1`. If it reports that the fuzzer "does not build against the reference", your fuzzer uses a name the reference's `vmm` lacks (Your turn, item 1). It checks:

- a 20-second control on the unplanted reference finds nothing (a fuzzer that reports everything proves nothing);
- plants 1 to 3 (the missing `checked_add`, the missing hop budget, the ring-index off-by-one) are each found within ten minutes, build included, each printing a line such as `bughunt: plant 2 (missing hop budget) found after 0s`;
- the sandbox self-test with `hello` prints the three denials and exits 0, and `--stats` shows `rlimit core=0` with and without `--sandbox`;
- each hostile phase on your VMM ends with its exit code and the guest's lines; no forbidden escape sequence in stdout, a flood file of exactly 1 MiB, an unchanged read-only disk, every TOCTOU-phase MMIO access in the virtio window;
- your journal answers every question.

Against a copy of the reference:

:::term source=captures/25-checkpoint.txt

What now works:

- a threat model naming the mechanism that guards each asset;
- a dependency-free fuzzer whose invariants find bugs that never panic, with replayable, minimised reproducers;
- a VMM that survives a guest attacking it on purpose;
- a process that, after set-up, can open no file, reach no network except the configured virtio-net peer socket, start no process, and never dumps core.

The next chapter starts from this state (the reference at the end of chapter 25).

### What's next

Chapter 26, planned for after the course's first release, freezes a running VM to a file and brings it back in a fresh process. A snapshot is not a memory dump: the Generic Interrupt Controller (GIC), the timers and in-flight disk requests hold state that RAM does not, and the file itself is hostile input the moment it touches disk.

### Open question

Your fuzzer is structure-aware: its input generator and mutations encode what you believe a ring looks like. Which input shape does it never generate, and what bug could hide there?

## Spec hunt

- virtio 1.2, section 2.7.5.3.1 "Driver Requirements: Indirect Descriptors": which combinations of `INDIRECT` and `NEXT` may a driver not send, and which of them does your fuzzer's flag-flip mutation produce?
- `man 2 setrlimit`, the `RLIMIT_CORE` entry and the paragraph on hard limits: why does macvmm set both the soft and the hard value to 0, and what could a compromised macvmm do if only the soft value were 0?
- ECMA-48, section 5.6 "Control strings": which introducers start an operating system command and a device control string, and how does a filter know where such a string ends?
