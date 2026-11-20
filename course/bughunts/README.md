# Bug hunts

A bug hunt (CURRICULUM §6.4) trains the skill a checkpoint cannot: finding a fault you did not
write, from its symptom. `scripts/bughunt.sh <part>` copies the reference into a new private
directory under `$TMPDIR`, applies **one** planted fault from `course/bughunts/<part>/` chosen at
random, runs the checkpoint that must catch it against the copy, and prints only the failing
symptom (the `[FAIL]` lines, their detail and the verdict). The patch's name and contents are
never printed: that is the puzzle.

```
scripts/bughunt.sh iii            # one random Part III fault
scripts/bughunt.sh iii --keep     # keep the patched copy in $TMPDIR to debug it
```

Exit 0 means the checkpoint caught the fault (the expected outcome). Your working tree is
never touched: the copy is made from `git ls-files` (tracked and untracked-but-not-ignored
files under `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `clippy.toml`,
`entitlements.plist`, `.cargo/`, `crates/`, `scripts/`), symlinks are skipped, the patch is applied
inside the copy with `git apply`, the copy and its build output are removed afterwards, and
`scripts/bughunt.sh` fails if `git status --porcelain` differs before and after.

## Planted faults

Files are named `NN-<slug>.patch`, where `NN` is the checkpoint that must catch the fault. Each
is a `git diff` against the reference; authors refresh a patch when the reference moves and it
stops applying (the hunt then says so instead of running).

| Part | Patch | Checkpoint | Symptom family (what the learner sees, not the cause) |
|---|---|---|---|
| III | `07-halfword-load.patch` | 07 | `mmio-probe` misses one marker; the trace shows the value of one load |
| III | `07-zero-register.patch` | 07 | `mmio-probe` misses one marker; the trace shows the value of one store |
| III | `08-vector-entry.patch` | 08 | L1 `inject` failures; the injected exception goes somewhere unexpected |
| VII | (M22) | 25 | the three planted fuzzer bugs of PLAN M22 (`crates/fuzz`), moved here as `vii/*.patch` when M22 lands |

The Part VII hunts are not here yet: they are the three faults M22 plants for `bughunt-selftest`,
and M22 has not run. Until then `scripts/bughunt.sh vii` reports that the part has no faults.

## Writing a new one

1. Copy the files you will change into a scratch directory, `git init` it and commit them there
   (never in this repository), make the fault, then
   `git diff > course/bughunts/<part>/NN-<slug>.patch`. Keep it to a few lines, compiling, and
   subtle enough that the symptom does not name the file.
2. Run `scripts/bughunt.sh <part> --patch NN-<slug>.patch` and check that checkpoint `NN`
   fails with a symptom a learner can reason from (a missing marker, a trace record, a dump).
   A fault the checkpoint misses means the checkpoint needs strengthening, not the patch.
