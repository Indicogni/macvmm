//! `fuzz`: dependency-free, deterministic fuzzers for every surface where macvmm parses hostile
//! input (PLAN M22; threat model §9.3, TEST-3, TEST-4, TEST-5).
//!
//! **What a target is.** One function `run(&[u8]) -> Verdict` that decodes the bytes into an
//! input for one parser or device model (a virtqueue, an ELF file, a sequence of MMIO accesses),
//! runs the real code against test doubles (`VecMemory`, `TestIrq`, mock disks), and then checks
//! **invariants**, not only "it did not panic". "No panic" finds crashes; invariants find the
//! bugs that matter in a VMM, which are silent: a buffer accepted although it lies half outside
//! RAM, a descriptor read twice (a double fetch the guest can race), a used element written one
//! slot past the ring. Each target documents its invariants and the requirement IDs they check.
//!
//! **Why no libFuzzer.** The workspace has no dependencies beyond `libc` (CLAUDE.md), and the
//! course runs this on a stock toolchain. The driver (`main.rs`) is a blind mutational fuzzer
//! with structural mutators (`mutate.rs`). The same targets are exported as
//! `pub fn fuzz_<target>(data: &[u8])` (panicking on a violated invariant), so an optional,
//! out-of-workspace `cargo fuzz` wrapper can add coverage guidance without touching them
//! (TEST-5).
//!
//! **Determinism.** Iteration `i` of `--seed s` is generated from `Rng::derive(s, i)`, so a run
//! is reproducible on any machine, and every failing input is also saved to disk (`main.rs`).
#![forbid(unsafe_code)]

pub mod mutate;
pub mod rng;
// Every target's `mutate` has the `Target::mutate` signature (`&mut Vec<u8>`: some grow the
// input), even those that only overwrite bytes in place.
#[allow(clippy::ptr_arg)]
pub mod targets;

/// `Ok` if every invariant held, else a description of the first violation.
pub type Verdict = Result<(), String>;

/// One fuzz target.
pub struct Target {
    /// The name on the command line (`cargo run -p fuzz -- <name>`).
    pub name: &'static str,
    /// Run one input and check the invariants.
    pub run: fn(&[u8]) -> Verdict,
    /// A random *well-formed* input: the starting point the mutators corrupt.
    pub seed: fn(&mut rng::Rng) -> Vec<u8>,
    /// Target-specific structural mutation (descriptor shapes, MMIO op fields, ...).
    pub mutate: fn(&mut rng::Rng, &mut Vec<u8>),
    /// Inputs are truncated to this length.
    pub max_len: usize,
}

/// Every target, in the order `all` runs them.
pub fn targets() -> &'static [Target] {
    targets::ALL
}

/// The target called `name`, including the hidden ones (`targets::HIDDEN`), which `list` and
/// `all` leave out.
pub fn find(name: &str) -> Option<&'static Target> {
    targets()
        .iter()
        .chain(targets::HIDDEN)
        .find(|t| t.name == name)
}

/// Run target `name` on `data` and panic with the violation, libFuzzer style.
fn check(name: &str, data: &[u8]) {
    let t = find(name).unwrap_or_else(|| panic!("no fuzz target {name}"));
    if let Err(e) = (t.run)(data) {
        panic!("fuzz {name}: invariant violated: {e}");
    }
}

/// `pub fn fuzz_<target>(data: &[u8])` for an external libFuzzer wrapper (TEST-5).
macro_rules! exports {
    ($($f:ident => $name:literal),* $(,)?) => {
        $(
            #[doc = concat!("Run the `", $name, "` target on `data`; panics on a violated invariant.")]
            pub fn $f(data: &[u8]) {
                check($name, data)
            }
        )*
    };
}

exports! {
    fuzz_virtqueue => "virtqueue",
    fuzz_virtqueue_race => "virtqueue_race",
    fuzz_virtio_mmio => "virtio_mmio",
    fuzz_blk => "blk",
    fuzz_rng => "rng",
    fuzz_console => "console",
    fuzz_elf => "elf",
    fuzz_image => "image",
    fuzz_initrd_plan => "initrd_plan",
    fuzz_esr => "esr",
    fuzz_insn => "insn",
    fuzz_stage1 => "stage1",
    fuzz_pl011 => "pl011",
    fuzz_pl031 => "pl031",
    fuzz_testdev => "testdev",
    fuzz_razwi => "razwi",
    fuzz_smccc => "smccc",
    fuzz_ansi => "ansi",
    fuzz_cli => "cli",
    fuzz_tar => "tar",
    fuzz_cpio => "cpio",
    fuzz_zboot => "zboot",
}
