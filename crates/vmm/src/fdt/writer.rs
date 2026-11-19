//! `FdtWriter`: a generic, dependency-free flattened-device-tree serializer (architecture §6.7;
//! Devicetree Specification v0.4 ch. 5 "Flattened Devicetree (DTB) Format"; course ch10).
//!
//! **Why write our own** (CLAUDE.md: DTB generation is a lesson topic, so no `vm-fdt` crate):
//! the format is small and every rule it has is a bug a learner can hit, so the writer enforces
//! them instead of trusting its caller:
//!
//! - **Layout** (DT spec §5.1): a 40-byte header, the memory-reservation block (8-byte aligned,
//!   §5.3), the structure block (4-byte aligned, §5.4), then the strings block (§5.5). Every
//!   header field and token is a big-endian `u32` (§5.2).
//! - **Tokens** (§5.4.1): `FDT_BEGIN_NODE` + NUL-terminated name padded to 4, `FDT_PROP` +
//!   `{len, nameoff}` + value padded to 4, `FDT_END_NODE`, and one final `FDT_END`.
//! - **Properties before children** (§5.4.2: "all property tokens of a node must precede any
//!   subnode tokens"). A property after a child is [`FdtError::PropAfterChild`].
//! - **Balanced nodes**: [`FdtWriter::end_node`] takes the [`NodeId`] that
//!   [`FdtWriter::begin_node`] returned, so closing the wrong node is an error at the call site
//!   rather than a silently mis-nested tree.
//! - **Names** (§2.2.1 node names, §2.2.4 property names): a NUL would end the name early and a
//!   `/` would make a path, so both are refused (threat model FDT-2), and so is any character
//!   outside the spec's tables. Only the root node has the empty name.
//! - **Strings are deduplicated** (§5.5: names "are stored only once"): two `compatible`
//!   properties share one strings-block entry (anchor `fdt_strings_dedup`).
//! - **Size**: the blob is at most [`FDT_MAX_SIZE`] (2 MiB, Linux
//!   `Documentation/arch/arm64/booting.rst` §2 "Setup the device tree": "must not exceed 2
//!   megabytes in size"). The check runs on every append, so a runaway caller fails early
//!   instead of growing a huge buffer.
//!
//! The writer never parses anything: it only turns calls from our own code into bytes. The
//! test-only parser that checks its output is `fdt/reader.rs` (threat model FDT-1).

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use core::fmt;
use std::collections::BTreeMap;

/// `magic` (DT spec §5.2).
pub const FDT_MAGIC: u32 = 0xd00d_feed;
/// The format version we write, and the oldest version it is compatible with (§5.2: version
/// 17, `last_comp_version` 16).
pub const FDT_VERSION: u32 = 17;
pub const FDT_LAST_COMP_VERSION: u32 = 16;
/// Structure-block tokens (§5.4.1).
pub const FDT_BEGIN_NODE: u32 = 0x1;
pub const FDT_END_NODE: u32 = 0x2;
pub const FDT_PROP: u32 = 0x3;
pub const FDT_NOP: u32 = 0x4;
pub const FDT_END: u32 = 0x9;
/// `struct fdt_header` is ten `u32`s (§5.2).
pub const FDT_HEADER_SIZE: usize = 40;
/// One memory-reservation entry: `{u64 address, u64 size}` (§5.3).
pub const FDT_RSV_ENTRY_SIZE: usize = 16;
/// The largest blob we produce (booting.rst §2: at most 2 MiB).
pub const FDT_MAX_SIZE: usize = 2 << 20;
/// Node names are at most 31 characters before the `@` (DT spec §2.2.1), property names at
/// most 31 (§2.2.4). The unit address adds at most 16 hex digits and the `@`.
pub const MAX_NODE_NAME: usize = 31 + 1 + 16;
pub const MAX_PROP_NAME: usize = 31;
/// The deepest nesting the writer accepts (our tree is 3 levels deep; a cap keeps the open
/// node stack bounded whatever the caller does).
pub const MAX_DEPTH: usize = 16;
/// At most this many `/memreserve/` entries (we normally emit none).
pub const MAX_MEM_RESERVE: usize = 64;

/// Why the writer refused a call. All of these are bugs in the code that builds the tree
/// (every name and value comes from our own code, FDT-2), so the machine build reports them as
/// an internal error rather than a guest or user error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FdtError {
    /// A node name with a NUL, a `/`, a character outside DT spec §2.2.1 Table 2.1, an empty
    /// non-root name, or one that is too long.
    InvalidNodeName { name: String },
    /// A property name with a NUL or a character outside DT spec §2.2.4 Table 2.2, empty, or
    /// longer than 31 characters.
    InvalidPropName { name: String },
    /// A string value with an interior NUL (it would end the string early).
    StringHasNul { prop: String },
    /// A property was added after the current node already has a child (§5.4.2).
    PropAfterChild { prop: String },
    /// A property was added with no node open.
    PropOutsideNode { prop: String },
    /// `end_node` was given a node that is not the innermost open one, or nothing is open.
    UnbalancedEnd,
    /// The first node is not the root (`""`), or a second root was started.
    BadRoot,
    /// Nesting deeper than [`MAX_DEPTH`].
    TooDeep,
    /// More than [`MAX_MEM_RESERVE`] reservation entries.
    TooManyReservations,
    /// `finish` with nodes still open, or with no root at all.
    Unfinished,
    /// The blob would exceed its size cap.
    TooLarge { size: usize, max: usize },
    /// The machine description cannot be turned into a tree (`fdt/machine.rs`).
    InvalidMachine(String),
    /// A blob handed to `machine::redact_seeds` is not one we can redact.
    Malformed(&'static str),
}

impl fmt::Display for FdtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FdtError::InvalidNodeName { name } => write!(f, "invalid DT node name {name:?}"),
            FdtError::InvalidPropName { name } => write!(f, "invalid DT property name {name:?}"),
            FdtError::StringHasNul { prop } => {
                write!(f, "DT property {prop:?}: string value contains a NUL")
            }
            FdtError::PropAfterChild { prop } => write!(
                f,
                "DT property {prop:?} added after a child node (DT spec §5.4.2)"
            ),
            FdtError::PropOutsideNode { prop } => {
                write!(f, "DT property {prop:?} added outside any node")
            }
            FdtError::UnbalancedEnd => f.write_str("unbalanced DT end_node"),
            FdtError::BadRoot => f.write_str("the DT must have exactly one root node named \"\""),
            FdtError::TooDeep => write!(f, "DT nesting deeper than {MAX_DEPTH}"),
            FdtError::TooManyReservations => {
                write!(f, "more than {MAX_MEM_RESERVE} DT memory reservations")
            }
            FdtError::Unfinished => f.write_str("DT finished with nodes still open (or no root)"),
            FdtError::TooLarge { size, max } => {
                write!(f, "device tree of {size} bytes exceeds the {max}-byte cap")
            }
            FdtError::InvalidMachine(why) => write!(f, "cannot describe the machine: {why}"),
            FdtError::Malformed(why) => write!(f, "malformed device tree: {why}"),
        }
    }
}

impl std::error::Error for FdtError {}

/// A handle to an open node, returned by [`FdtWriter::begin_node`] and consumed by
/// [`FdtWriter::end_node`]. Deliberately not `Clone`: each node is closed exactly once.
#[derive(Debug, PartialEq, Eq)]
#[must_use = "a node must be closed with end_node"]
pub struct NodeId(usize);

/// One open node: its sequence number and whether it already has a child.
#[derive(Debug)]
struct Open {
    id: usize,
    has_child: bool,
}

/// The streaming writer (module docs).
#[derive(Debug, Default)]
pub struct FdtWriter {
    /// The structure block so far (tokens, big-endian).
    structure: Vec<u8>,
    /// The strings block so far.
    strings: Vec<u8>,
    /// Name → offset into `strings` (dedup, §5.5).
    string_offsets: BTreeMap<String, u32>,
    /// Memory reservations (§5.3).
    reservations: Vec<(u64, u64)>,
    /// The stack of open nodes; `open[0]` is the root.
    open: Vec<Open>,
    /// Nodes begun so far (the next `NodeId`).
    nodes: usize,
    /// The root has been closed: nothing more may be added.
    root_done: bool,
}

/// DT spec §2.2.1 Table 2.1: characters allowed in a node name (plus `@` before the unit
/// address).
fn node_char_ok(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b',' | b'.' | b'_' | b'+' | b'-')
}

/// DT spec §2.2.4 Table 2.2: characters allowed in a property name.
fn prop_char_ok(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b',' | b'.' | b'_' | b'+' | b'?' | b'#' | b'-')
}

/// Check a non-root node name: `node-name[@unit-address]` (§2.2.1). Rejects NUL and `/`
/// explicitly (FDT-2) as well as everything else outside the tables.
pub fn check_node_name(name: &str) -> Result<(), FdtError> {
    let bad = || FdtError::InvalidNodeName {
        name: name.to_owned(),
    };
    if name.is_empty() || name.len() > MAX_NODE_NAME || name.bytes().any(|b| b == 0 || b == b'/') {
        return Err(bad());
    }
    let (base, unit) = match name.split_once('@') {
        Some((b, u)) => (b, Some(u)),
        None => (name, None),
    };
    let base_ok = !base.is_empty()
        && base.len() <= 31
        && base.bytes().all(node_char_ok)
        && base.bytes().next().is_some_and(|c| c.is_ascii_alphabetic());
    let unit_ok = unit.is_none_or(|u| !u.is_empty() && u.bytes().all(node_char_ok));
    if base_ok && unit_ok {
        Ok(())
    } else {
        Err(bad())
    }
}

/// Check a property name (§2.2.4).
pub fn check_prop_name(name: &str) -> Result<(), FdtError> {
    if name.is_empty() || name.len() > MAX_PROP_NAME || !name.bytes().all(prop_char_ok) {
        return Err(FdtError::InvalidPropName {
            name: name.to_owned(),
        });
    }
    Ok(())
}

/// Append `n` zero bytes so `buf.len()` is a multiple of 4.
fn pad4(buf: &mut Vec<u8>) {
    while !buf.len().is_multiple_of(4) {
        buf.push(0);
    }
}

impl FdtWriter {
    /// An empty writer. The first call must be `begin_node("")` (the root).
    pub fn new() -> FdtWriter {
        FdtWriter::default()
    }

    fn token(&mut self, t: u32) {
        self.structure.extend_from_slice(&t.to_be_bytes());
    }

    /// The size the blob would have now, if finished (header + reservations + blocks + the
    /// `FDT_END` token, and `FDT_END_NODE` for every node still open).
    fn projected_size(&self) -> Option<usize> {
        let rsv = self
            .reservations
            .len()
            .checked_add(1)?
            .checked_mul(FDT_RSV_ENTRY_SIZE)?;
        let closing = self.open.len().checked_add(1)?.checked_mul(4)?;
        FDT_HEADER_SIZE
            .checked_add(rsv)?
            .checked_add(self.structure.len())?
            .checked_add(closing)?
            .checked_add(self.strings.len())
    }

    /// Refuse to grow past [`FDT_MAX_SIZE`].
    fn check_size(&self) -> Result<(), FdtError> {
        match self.projected_size() {
            Some(size) if size <= FDT_MAX_SIZE => Ok(()),
            size => Err(FdtError::TooLarge {
                size: size.unwrap_or(usize::MAX),
                max: FDT_MAX_SIZE,
            }),
        }
    }

    // ANCHOR: fdt_begin_node
    /// Open a node. The first node must be the root, named `""` (§5.4.1: "the root node's name
    /// is the empty string"); every later one needs a valid, non-empty name (FDT-2).
    pub fn begin_node(&mut self, name: &str) -> Result<NodeId, FdtError> {
        // Nothing after the root closes, and the first node is the root.
        if self.root_done || (self.open.is_empty() && !name.is_empty()) {
            return Err(FdtError::BadRoot);
        }
        if !self.open.is_empty() {
            check_node_name(name)?; // also refuses "" for a child
        }
        if self.open.len() >= MAX_DEPTH {
            return Err(FdtError::TooDeep);
        }
        if let Some(parent) = self.open.last_mut() {
            parent.has_child = true;
        }
        self.token(FDT_BEGIN_NODE);
        self.structure.extend_from_slice(name.as_bytes());
        self.structure.push(0); // NUL terminator, then zero padding to 4
        pad4(&mut self.structure);
        let id = self.nodes;
        self.nodes = self.nodes.checked_add(1).ok_or(FdtError::TooDeep)?;
        self.open.push(Open {
            id,
            has_child: false,
        });
        self.check_size()?;
        Ok(NodeId(id))
    }
    // ANCHOR_END: fdt_begin_node

    /// Close `node`, which must be the innermost open node.
    pub fn end_node(&mut self, node: NodeId) -> Result<(), FdtError> {
        match self.open.last() {
            Some(top) if top.id == node.0 => {}
            _ => return Err(FdtError::UnbalancedEnd),
        }
        self.open.pop();
        self.token(FDT_END_NODE);
        if self.open.is_empty() {
            self.root_done = true;
        }
        self.check_size()
    }

    // ANCHOR: fdt_strings_dedup
    /// The strings-block offset of `name`, adding it on first use (§5.5).
    fn name_offset(&mut self, name: &str) -> Result<u32, FdtError> {
        if let Some(&off) = self.string_offsets.get(name) {
            return Ok(off);
        }
        let off = u32::try_from(self.strings.len()).map_err(|_| FdtError::TooLarge {
            size: self.strings.len(),
            max: FDT_MAX_SIZE,
        })?;
        self.strings.extend_from_slice(name.as_bytes());
        self.strings.push(0);
        self.string_offsets.insert(name.to_owned(), off);
        Ok(off)
    }
    // ANCHOR_END: fdt_strings_dedup

    // ANCHOR: fdt_prop
    /// Add a property with raw `value` bytes to the innermost open node (§5.4.1 `FDT_PROP`:
    /// `u32 len`, `u32 nameoff`, then `len` bytes padded to 4). Every typed helper below ends
    /// here.
    pub fn prop_bytes(&mut self, name: &str, value: &[u8]) -> Result<(), FdtError> {
        check_prop_name(name)?;
        match self.open.last() {
            None => {
                return Err(FdtError::PropOutsideNode {
                    prop: name.to_owned(),
                });
            }
            Some(top) if top.has_child => {
                return Err(FdtError::PropAfterChild {
                    prop: name.to_owned(),
                });
            }
            Some(_) => {}
        }
        // Check the size before touching the buffers: `value` may be large. Exact: the
        // 12-byte `FDT_PROP` header, the value padded to 4, and the name if it is new.
        let new_name = if self.string_offsets.contains_key(name) {
            0
        } else {
            name.len().saturating_add(1)
        };
        let grown = self.projected_size().and_then(|s| {
            s.checked_add(12)?
                .checked_add(value.len().checked_next_multiple_of(4)?)?
                .checked_add(new_name)
        });
        match grown {
            Some(s) if s <= FDT_MAX_SIZE => {}
            s => {
                return Err(FdtError::TooLarge {
                    size: s.unwrap_or(usize::MAX),
                    max: FDT_MAX_SIZE,
                });
            }
        }
        let len = u32::try_from(value.len()).map_err(|_| FdtError::TooLarge {
            size: value.len(),
            max: FDT_MAX_SIZE,
        })?;
        let nameoff = self.name_offset(name)?;
        self.token(FDT_PROP);
        self.structure.extend_from_slice(&len.to_be_bytes());
        self.structure.extend_from_slice(&nameoff.to_be_bytes());
        self.structure.extend_from_slice(value);
        pad4(&mut self.structure);
        self.check_size()
    }
    // ANCHOR_END: fdt_prop

    /// An empty (boolean) property, such as `interrupt-controller` (§2.2.4.2 `<empty>`).
    pub fn prop_null(&mut self, name: &str) -> Result<(), FdtError> {
        self.prop_bytes(name, &[])
    }

    /// One big-endian cell (`<u32>`).
    pub fn prop_u32(&mut self, name: &str, v: u32) -> Result<(), FdtError> {
        self.prop_bytes(name, &v.to_be_bytes())
    }

    /// A `<u64>`: two cells, high first (§2.2.4.2).
    pub fn prop_u64(&mut self, name: &str, v: u64) -> Result<(), FdtError> {
        self.prop_bytes(name, &v.to_be_bytes())
    }

    /// A `<prop-encoded-array>` of cells.
    pub fn prop_cells(&mut self, name: &str, cells: &[u32]) -> Result<(), FdtError> {
        let bytes: Vec<u8> = cells.iter().flat_map(|c| c.to_be_bytes()).collect();
        self.prop_bytes(name, &bytes)
    }

    /// A `<string>`: the bytes and one NUL. An interior NUL is refused.
    pub fn prop_str(&mut self, name: &str, s: &str) -> Result<(), FdtError> {
        self.prop_strs(name, &[s])
    }

    /// A `<stringlist>`: each string NUL-terminated, concatenated
    /// (`"arm,pl011\0arm,primecell\0"`).
    pub fn prop_strs(&mut self, name: &str, list: &[&str]) -> Result<(), FdtError> {
        let mut bytes = Vec::new();
        for s in list {
            if s.as_bytes().contains(&0) {
                return Err(FdtError::StringHasNul {
                    prop: name.to_owned(),
                });
            }
            bytes.extend_from_slice(s.as_bytes());
            bytes.push(0);
        }
        self.prop_bytes(name, &bytes)
    }

    /// Add a `/memreserve/` entry (§5.3). We normally emit none: Linux reserves the DTB and
    /// the initrd itself (booting.rst §2).
    pub fn add_mem_reserve(&mut self, addr: u64, size: u64) -> Result<(), FdtError> {
        if self.reservations.len() >= MAX_MEM_RESERVE {
            return Err(FdtError::TooManyReservations);
        }
        self.reservations.push((addr, size));
        self.check_size()
    }

    // ANCHOR: fdt_finish_header
    /// Serialize: header, reservation map (8-aligned, `{0, 0}`-terminated), structure block
    /// (4-aligned, ending in `FDT_END`), strings block. `boot_cpuid` is the `reg` of the boot
    /// CPU (§5.2 `boot_cpuid_phys`).
    pub fn finish(mut self, boot_cpuid: u32) -> Result<Vec<u8>, FdtError> {
        if !self.root_done || !self.open.is_empty() {
            return Err(FdtError::Unfinished);
        }
        // No `check_size()` here: `projected_size` already counts this `FDT_END`, so it would
        // count it twice. The exact `total` check below is the cap.
        self.token(FDT_END);
        let too_large = |size: usize| FdtError::TooLarge {
            size,
            max: FDT_MAX_SIZE,
        };
        // The header is 40 bytes, already a multiple of 8, so the reservation map follows it
        // directly; each entry is 16 bytes, so the structure block is 8-aligned as well.
        let off_rsvmap = FDT_HEADER_SIZE;
        let rsv_len = self
            .reservations
            .len()
            .checked_add(1)
            .and_then(|n| n.checked_mul(FDT_RSV_ENTRY_SIZE))
            .ok_or(too_large(usize::MAX))?;
        let off_struct = off_rsvmap
            .checked_add(rsv_len)
            .ok_or(too_large(usize::MAX))?;
        let off_strings = off_struct
            .checked_add(self.structure.len())
            .ok_or(too_large(usize::MAX))?;
        let total = off_strings
            .checked_add(self.strings.len())
            .ok_or(too_large(usize::MAX))?;
        if total > FDT_MAX_SIZE {
            return Err(too_large(total));
        }
        let u = |v: usize| u32::try_from(v).map_err(|_| too_large(v));
        let header = [
            FDT_MAGIC,
            u(total)?,
            u(off_struct)?,
            u(off_strings)?,
            u(off_rsvmap)?,
            FDT_VERSION,
            FDT_LAST_COMP_VERSION,
            boot_cpuid,
            u(self.strings.len())?,
            u(self.structure.len())?,
        ];
        let mut blob = Vec::with_capacity(total);
        for field in header {
            blob.extend_from_slice(&field.to_be_bytes());
        }
        for (addr, size) in self.reservations.iter().chain(&[(0, 0)]) {
            blob.extend_from_slice(&addr.to_be_bytes());
            blob.extend_from_slice(&size.to_be_bytes());
        }
        blob.extend_from_slice(&self.structure);
        blob.extend_from_slice(&self.strings);
        Ok(blob)
    }
    // ANCHOR_END: fdt_finish_header
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)] // tests: a panic fails it
mod tests {
    use super::*;

    #[test]
    fn names() {
        for ok in [
            "cpus",
            "cpu@0",
            "pl011@9000000",
            "apb-pclk",
            "virtio_mmio@a000200",
        ] {
            assert_eq!(check_node_name(ok), Ok(()), "{ok}");
        }
        for bad in ["", "a/b", "a\0b", "@1", "cpu@", "9lives", "a b", "x@1@2"] {
            assert!(check_node_name(bad).is_err(), "{bad:?}");
        }
        for ok in [
            "#address-cells",
            "linux,initrd-start",
            "compatible",
            "rng-seed",
        ] {
            assert_eq!(check_prop_name(ok), Ok(()), "{ok}");
        }
        for bad in ["", "a\0", "a/b", "a b", &"x".repeat(32)] {
            assert!(check_prop_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn root_rules() {
        let mut w = FdtWriter::new();
        assert_eq!(w.begin_node("cpus"), Err(FdtError::BadRoot));
        let root = w.begin_node("").unwrap();
        assert!(matches!(
            w.begin_node(""),
            Err(FdtError::InvalidNodeName { .. })
        ));
        w.end_node(root).unwrap();
        assert_eq!(w.begin_node(""), Err(FdtError::BadRoot));
        assert_eq!(w.begin_node("late"), Err(FdtError::BadRoot));
        assert!(matches!(
            w.prop_null("x"),
            Err(FdtError::PropOutsideNode { .. })
        ));
        assert!(FdtWriter::new().finish(0).is_err());
    }
}
