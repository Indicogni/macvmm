//! `macvmm`: your VMM's command line (architecture §13.1 is the contract the checkpoints use).
//!
//! Chapter 01 adds `doctor`, chapter 02 `first-exit`, chapter 03 `run`. An unknown command or
//! flag is a usage error: exit code 2.
#![forbid(unsafe_code)]

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!("usage: macvmm <doctor|first-exit|run> ... (nothing is implemented yet: start with chapter 01)");
    ExitCode::from(2)
}
