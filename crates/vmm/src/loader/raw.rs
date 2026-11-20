//! `--raw F@ADDR`: a flat binary copied byte for byte to a guest-physical address
//! (architecture §12.1, threat model PATH-8; course ch03).
//!
//! **Why raw loading exists.** It is the simplest loader there is, so it is where the course
//! starts: a flat binary has no header, no entry point, no segments. The bytes go to `ADDR`,
//! and the vCPU starts at `ADDR` (unless `--kernel` names an ELF whose entry wins). That only
//! works because the test guests' linker script puts `_start` first (`guests/common/link.ld`).
//!
//! **Parsing** ([`parse_spec`], PATH-8). The address needs an explicit `0x` and must fit in 64
//! bits: `F@40080000` and `F@0xffffffffffffffffff` are both refused, so a typo can never wrap
//! around to a different address. The split is at the *last* `@`, so a path containing `@`
//! still works. Placement ([`check_placement`]) is checked against RAM with `checked_add`.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{LoaderError, Placement, RamRange};
use crate::config::RawSpec;
use core::fmt;
use std::path::PathBuf;

/// Why a `--raw` argument is malformed (a usage error, exit code 2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RawSpecError {
    /// No `@` separating the file from the address.
    MissingAt,
    /// The file part is empty.
    EmptyPath,
    /// The address lacks the `0x` prefix.
    MissingHexPrefix,
    /// The address is not a hex number of at most 64 bits.
    BadAddress,
}

impl fmt::Display for RawSpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            RawSpecError::MissingAt => "--raw needs FILE@ADDR",
            RawSpecError::EmptyPath => "--raw FILE@ADDR: the file is empty",
            RawSpecError::MissingHexPrefix => "--raw FILE@ADDR: ADDR needs a 0x prefix",
            RawSpecError::BadAddress => {
                "--raw FILE@ADDR: ADDR must be a hex number of at most 64 bits"
            }
        })
    }
}

impl std::error::Error for RawSpecError {}

// ANCHOR: raw_parse_spec
/// Parse `FILE@0xADDR` (module docs).
pub fn parse_spec(s: &str) -> Result<RawSpec, RawSpecError> {
    let (path, addr) = s.rsplit_once('@').ok_or(RawSpecError::MissingAt)?;
    if path.is_empty() {
        return Err(RawSpecError::EmptyPath);
    }
    let hex = addr
        .strip_prefix("0x")
        .or_else(|| addr.strip_prefix("0X"))
        .ok_or(RawSpecError::MissingHexPrefix)?;
    // `_` separators are allowed (`0x4008_0000`), like Rust literals; nothing else is.
    let digits: String = hex.chars().filter(|&c| c != '_').collect();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(RawSpecError::BadAddress);
    }
    // `from_str_radix` fails on overflow: more than 64 bits is an error, never a wrap.
    let addr = u64::from_str_radix(&digits, 16).map_err(|_| RawSpecError::BadAddress)?;
    Ok(RawSpec {
        path: PathBuf::from(path),
        addr,
    })
}
// ANCHOR_END: raw_parse_spec

// ANCHOR: raw_check_placement
/// Check that `len` bytes at `addr` fit inside guest RAM, and describe the placement.
pub fn check_placement(
    ram: RamRange,
    index: usize,
    addr: u64,
    len: u64,
) -> Result<Placement, LoaderError> {
    let what = format!("--raw blob {index}");
    if !ram.contains(addr, len) {
        return Err(LoaderError::OutsideRam { what, addr, len });
    }
    Ok(Placement { what, addr, len })
}
// ANCHOR_END: raw_check_placement

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;

    #[test]
    fn parse_examples() {
        let s = parse_spec("a@b@0x4008_0000").unwrap();
        assert_eq!((s.path.to_str(), s.addr), (Some("a@b"), 0x4008_0000));
        assert_eq!(
            parse_spec("f@40080000"),
            Err(RawSpecError::MissingHexPrefix)
        );
        assert_eq!(parse_spec("f@0x"), Err(RawSpecError::BadAddress));
        assert_eq!(parse_spec("f@0x+1"), Err(RawSpecError::BadAddress));
        assert_eq!(parse_spec("@0x1"), Err(RawSpecError::EmptyPath));
        assert_eq!(parse_spec("f"), Err(RawSpecError::MissingAt));
        assert_eq!(
            parse_spec("f@0xffffffffffffffffff"),
            Err(RawSpecError::BadAddress)
        );
        assert_eq!(parse_spec("f@0xFFFFFFFFFFFFFFFF").unwrap().addr, u64::MAX);
    }
}
