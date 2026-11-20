# Checkpoint definitions

Every chapter ends with a checkpoint: `scripts/checkpoint.sh NN` decides, the same way for a
learner and for an author, whether the chapter's code works. This directory holds one
definition per chapter (`NN/checkpoint.toml`) plus the files it names. The harness is
`cargo xtask checkpoint` (PLAN M27, `crates/xtask/src/checkpoint/`); the learner-facing
description is CURRICULUM §3.2–§3.3.

```
scripts/checkpoint.sh 07                # ./learner if it exists, else the reference
scripts/checkpoint.sh 07 --ref          # the reference (authors, CI)
scripts/checkpoint.sh 07 --impl DIR     # any other implementation tree
scripts/checkpoint.sh all --ref         # ends with CHECKPOINTS: 13/13 PASS
scripts/capture.sh 07                   # the same, recording course/captures/07-<run>.txt
```

## Layout of a chapter

```
NN/
  checkpoint.toml      the definition (format below)
  contract/*.rs        L1, the contract tests (and data files they read, e.g. contract/data/*.json)
  expected/*.txt       marker files for serial output and traces
```

`course/journal/NN.md` is the journal template `scripts/learner start NN` copies, and
`course/journal/NN.rubric.md` (optional) is printed after a passing L3.

## The three levels

Authors call the levels L1, L2 and L3; the harness prints them as `contract tests`,
`runs on your Mac` and `journal`, because learners never see the level numbers (CURRICULUM §7
item 10).

| Level (printed label) | What runs | Decides by |
|---|---|---|
| **L1** (`contract tests`) | A throwaway crate in `target/checkpoint/NN/<key>/crate/` (`<key>`: a hash of the implementation tree's path) depending on `<impl>/crates/vmm` (feature `test-util`) and/or `<impl>/crates/hvf`, with `contract/` mirrored to `tests/`; `cargo test --offline --test <stem>` for each listed file, build included, with a 600 s timeout and the same hard kill as L2. Host only. | every test passes, at least one ran |
| **L2** (`runs on your Mac`) | Each `[[run]]`: the tree's `macvmm` built once, copied to a private directory and signed with `scripts/sign.sh` (or `--no-entitlements`); run with piped stdio, the interaction steps, a timeout and a hard kill at timeout + 10 s. The child leads its own process group and the kill reaches every process in it (a wrapper such as `cargo run`, `sh -c` or `script(1)` cannot keep the real program alive); a subprocess still holding the output pipes after the run ended is killed and the run FAILs. | exit code (always), serial markers, trace markers, extra checks |
| **L3** (`journal`) | Learner trees only (a tree with `.progress.toml`): `journal/NN.md` must answer every `## Q<n>`, and `## Predict` when asked. Never uploaded. | presence, not grading |

Contract tests use **only items the chapter's lesson names** (the frozen contracts of
architecture §6), so a learner's own types satisfy them. Where an earlier chapter's item would
otherwise be needed (for example `arch::layout` before ch05), the test spells the PLAN §1
constant locally instead.

## `checkpoint.toml`

The parser is `toml_lite` (a small TOML subset: bare keys, strings, integers, booleans, string
arrays, one level of `[table]` and `[[array]]`; 64 KiB at most). Unknown keys and tables are
errors, so a typo cannot silently weaken a checkpoint.

```toml
id = "07"                       # must match the directory
slug = "exit-loop"
requires = ["06"]               # earlier checkpoints; reported (INFO) if not yet passed

[contract]                      # L1
crates = ["vmm", "hvf"]         # default ["vmm"]; `crate = "vmm"` is accepted too
tests = ["contract/esr_vectors.rs"]

[[run]]                         # L2, at most 32 per checkpoint
name = "mmio-probe"             # ^[a-z0-9][a-z0-9-]*$, unique
guest = "mmio-probe"            # a guests/ binary; enables {guest}, {guest_raw}, {guest_bin}
args = ["run", "--mem", "64M", "--testdev", "--raw", "{guest_raw}",
        "--trace", "exits:{out}/t.jsonl:mmio", "--timeout", "10"]
expect_exit_code = 0            # required (AS10)
serial = "expected/mmio-probe.txt"
trace = "expected/mmio-probe.trace.txt"

[journal]                       # L3
file = "journal/07.md"
questions = 4                   # must equal the `## Q` headings of course/journal/07.md
predict = true

[hints]                         # scripts/learner hint 07 [1-4]
conceptual = "…"
spec = "…"
pseudocode = "…"
anchor = "…"
```

### `[[run]]` keys

Exactly one of:

- `args = [...]`: run the implementation's signed `macvmm` with these arguments, in `{out}`.
- `command = [...]`: run this argv (a repository script, `/bin/sh -c …`, `script(1)` for a
  pty). The working directory is the implementation (`cwd = "impl"`, default) or the
  repository (`cwd = "repo"`). For an implementation other than the reference,
  `CARGO_TARGET_DIR` points at the harness's build directory.
- `contract_hvf = "contract/x.rs"`: an HVF contract test, run in the L1 crate with
  `--features hvf-tests -- --test-threads=1` (signed by the runner). It needs an explicit
  `timeout` (it bounds the build and the tests, then the hard kill) and `expect_exit_code = 0`
  (it passes only when `cargo test` exits 0 with at least one test run).

Optional:

| Key | Meaning |
|---|---|
| `sign = "no-entitlements"` | use the copy signed without entitlements (ch01's HV_DENIED run) |
| `steps = [...]` | `wait:TEXT` (until stdout contains it), `send:TEXT` (to stdin; `\u0001` for Ctrl-A), `sleep:MS` (≤ 60000), `signal:TERM\|INT\|USR1\|HUP` |
| `timeout = N` | seconds, 1..=600 (default: the `--timeout` in `args`, else 30); the hard kill comes 10 s later |
| `serial`, `trace` | marker files (below); `trace` needs `--trace exits:{out}/FILE` in `args` or `trace_file = "FILE"` |
| `count_trace = "S"` + `count_equals_stdout_bytes_plus = K` | the number of trace lines containing `S` must equal the stdout byte count plus `K` (ch03's exit counting) |
| `max_host_cpu_percent = N` | the `stats: host cpu … (P%)` line on stderr must say `P < N` (needs `--stats`) |
| `equal_lines = "PREFIX"` | at least two stdout lines start with `PREFIX` and all are identical (ch09's `stty -g` check) |
| `requires_tool = "dtc"` | skip as `[INFO]` when the tool is not on `PATH` |
| `blob_hex = "00000014"` | bytes written to `{out}/blob.bin` first; `{blob_raw}` is `{out}/blob.bin@0x40080000` |

### Placeholders

| Placeholder | Becomes |
|---|---|
| `{guest}` | the guest's ELF (`target/guests/aarch64-unknown-none/release/<guest>`) |
| `{guest_raw}` | `<guest>.bin@0x40080000`: chapters before 13 load flat binaries, because learners write the ELF loader in ch13 (CURRICULUM §3.3) |
| `{guest_bin}` | the flat binary's path |
| `{blob_raw}` | see `blob_hex` |
| `{out}` | the run's private output directory, `target/checkpoint/NN/<key>/out/<pid>/<run>/` (removed afterwards unless `--keep`) |
| `{macvmm}` | the signed `macvmm` copy (for `command` runs) |
| `{repo}`, `{impl}` | the repository and the implementation tree |

## Marker files

The rules of PLAN §0.3 (decision D9), the same for the e2e suite and the checkpoints; the
fixture table `crates/xtask/tests/data/markers_fixtures.txt` is run against both
implementations:

- each non-empty line is one marker; trailing spaces are ignored;
- markers on one stream must appear **in order**, as substrings (the same text twice needs two
  occurrences);
- `*` matches any run of characters **except a newline**;
- a line starting `[stderr] ` matches stderr; every other line matches stdout (the serial
  output) or, in a trace marker file, the trace;
- a line starting `!` must appear **nowhere** (`!` alone: neither stream; `![stderr] `: not on
  stderr), checked over the whole output, not only after the last match.

A guest can print any text, so a marker that only the VMM prints is written as `[stderr] …`,
and every run asserts its exit code.

## Output

```
[PASS] contract tests   esr_vectors (2 tests)
[PASS] runs on your Mac mmio-probe: 5/5 serial markers, 8/8 trace markers, exit 0 in 0.07s
[INFO] journal          not checked (not a learner tree)
CHECKPOINT 07 PASS
```

On failure the harness prints the first mismatching marker (file and line), the last 20 trace
records, and the register dump `macvmm` printed (or the last 20 stderr lines). With a lifeline
the verdict is `CHECKPOINT NN PASS (borrowed: <module>)`.

## Golden files

`expected/*` and `course/captures/*` come from the reference on real hardware:
`scripts/capture.sh NN` writes one transcript per run (`course/captures/NN-<run>.txt`, plus
`NN-<run>.trace.jsonl`) with machine paths replaced by `{out}`, `{guests}`, `{macvmm}` and
`<repo>` and control characters made visible. Marker files are chosen from those transcripts;
never invent a marker that was not observed (CURRICULUM §3.6). When a capture differs from what
CURRICULUM.md says (for example `exit-bench`'s real line, or the sysreg-probe UNDEF register on
this machine), the checkpoint follows the observation.

## Safety

The harness runs only local code and never uploads anything (there is no network code in
`xtask`). Definitions, marker files, journals and traces are read with size caps and never
through a symlink; definition paths must be plain relative names inside the checkpoint
directory. Output from the code under test is echoed with control characters made visible.
Threat model §5 row S25.
