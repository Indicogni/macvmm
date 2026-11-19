//! A minimal, bounds-checked FDT parser **for tests and fuzzing only** (threat model FDT-1;
//! Devicetree Specification v0.4 ch. 5).
//!
//! **Why it exists, and why it is fenced off.** The VMM *generates* its device tree and never
//! parses one from the user or the guest (architecture §12.2): a parser is a hostile-input
//! surface, and the VMM does not need one. The tests do: they round-trip `FdtWriter` output,
//! check the machine tree node by node, and the e2e suite reads back the `--dtb-out` file. So
//! this module is compiled only under `cfg(test)` or the `test-util` feature (`fdt/mod.rs`), and
//! `cargo xtask audit` (rule `fdt-reader-unreachable`) fails if any non-test code names it. If a
//! future `--dtb F` override ever made it reachable, it would need an ADR and a fuzz target
//! first; this file is written as if that day had come (it is the M22 fuzz target's input).
//!
//! **Every offset is bounded** (it is a future fuzz target): the header is checked against the
//! buffer (`totalsize`, the three block offsets and sizes, with `checked_add`), every token
//! read uses `.get()`, names must be NUL-terminated inside their block, a property's
//! `nameoff` must point inside the strings block, the nesting depth is capped at
//! [`MAX_DEPTH`], and so is the total number of tokens. A malformed blob is a [`ReadError`],
//! never a panic.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::writer::{
    FDT_BEGIN_NODE, FDT_END, FDT_END_NODE, FDT_HEADER_SIZE, FDT_MAGIC, FDT_MAX_SIZE, FDT_NOP,
    FDT_PROP, FDT_RSV_ENTRY_SIZE,
};
use core::fmt;

/// Deepest nesting accepted.
pub const MAX_DEPTH: usize = 64;
/// Most tokens accepted (each costs at least 4 bytes, so 2 MiB holds at most 512 Ki).
pub const MAX_TOKENS: usize = 1 << 19;
/// Most reservation entries accepted before the `{0, 0}` terminator.
pub const MAX_RESERVATIONS: usize = 1024;

/// Why a blob was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// Shorter than the 40-byte header.
    TruncatedHeader,
    BadMagic(u32),
    /// `totalsize` is past the end of the buffer, below the header, or above 2 MiB.
    BadTotalSize(u32),
    /// `version` below 16 or `last_comp_version` above 17 (§5.2).
    BadVersion {
        version: u32,
        last_comp: u32,
    },
    /// A block offset or size lies outside `totalsize`, or is misaligned.
    BadBlock(&'static str),
    /// The reservation map has no `{0, 0}` terminator inside the blob, or too many entries.
    BadReservations,
    /// The structure block ended in the middle of a token.
    Truncated(&'static str),
    /// A node name has no NUL inside the structure block.
    UnterminatedName,
    /// A property `nameoff` is past the strings block, or its name has no NUL there.
    BadNameOffset(u32),
    /// A name or string is not valid UTF-8.
    NotUtf8,
    /// A token value outside §5.4.1.
    BadToken(u32),
    /// Nodes are not balanced, a property comes outside a node or after a child, or there is
    /// more than one root.
    BadStructure(&'static str),
    /// Deeper than [`MAX_DEPTH`] or more tokens than [`MAX_TOKENS`].
    TooComplex,
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ReadError {}

/// The header fields (§5.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub magic: u32,
    pub totalsize: u32,
    pub off_dt_struct: u32,
    pub off_dt_strings: u32,
    pub off_mem_rsvmap: u32,
    pub version: u32,
    pub last_comp_version: u32,
    pub boot_cpuid_phys: u32,
    pub size_dt_strings: u32,
    pub size_dt_struct: u32,
}

/// One property: its name and raw value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prop {
    pub name: String,
    pub value: Vec<u8>,
}

impl Prop {
    /// The value as big-endian cells, if its length is a multiple of 4.
    pub fn cells(&self) -> Option<Vec<u32>> {
        let (chunks, rest) = self.value.as_chunks::<4>();
        if !rest.is_empty() {
            return None;
        }
        Some(chunks.iter().map(|c| u32::from_be_bytes(*c)).collect())
    }

    /// The value as one cell.
    pub fn u32(&self) -> Option<u32> {
        let b: [u8; 4] = self.value.as_slice().try_into().ok()?;
        Some(u32::from_be_bytes(b))
    }

    /// The value as a `<u64>`.
    pub fn u64(&self) -> Option<u64> {
        let b: [u8; 8] = self.value.as_slice().try_into().ok()?;
        Some(u64::from_be_bytes(b))
    }

    /// The value as a string list (every entry NUL-terminated, valid UTF-8).
    pub fn strs(&self) -> Option<Vec<&str>> {
        let body = self.value.strip_suffix(&[0])?;
        body.split(|&b| b == 0)
            .map(|s| core::str::from_utf8(s).ok())
            .collect()
    }

    /// The value as one string.
    pub fn str(&self) -> Option<&str> {
        match self.strs()?.as_slice() {
            [one] => Some(one),
            _ => None,
        }
    }
}

/// One node: name, properties in order, children in order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Node {
    pub name: String,
    pub props: Vec<Prop>,
    pub children: Vec<Node>,
}

impl Node {
    /// The property called `name`.
    pub fn prop(&self, name: &str) -> Option<&Prop> {
        self.props.iter().find(|p| p.name == name)
    }

    /// The direct child called `name`.
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    /// The node at `path` below this one (`"cpus/cpu@0"`; `""` is this node).
    pub fn find(&self, path: &str) -> Option<&Node> {
        path.split('/')
            .filter(|s| !s.is_empty())
            .try_fold(self, |n, seg| n.child(seg))
    }

    /// Every node of the subtree, depth first, with its path (`/`, `/cpus`, ...).
    pub fn walk(&self) -> Vec<(String, &Node)> {
        let mut out = Vec::new();
        let mut stack: Vec<(String, &Node)> = vec![("/".to_owned(), self)];
        while let Some((path, n)) = stack.pop() {
            for c in n.children.iter().rev() {
                let p = if path == "/" {
                    format!("/{}", c.name)
                } else {
                    format!("{path}/{}", c.name)
                };
                stack.push((p, c));
            }
            out.push((path, n));
        }
        out
    }
}

/// A parsed blob.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fdt {
    pub header: Header,
    pub reservations: Vec<(u64, u64)>,
    pub root: Node,
}

impl Fdt {
    /// The node at an absolute `path` (`"/chosen"`, `"/"`).
    pub fn find(&self, path: &str) -> Option<&Node> {
        self.root.find(path)
    }
}

/// A bounded cursor over one block.
struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn u32(&mut self, what: &'static str) -> Result<u32, ReadError> {
        let end = self.pos.checked_add(4).ok_or(ReadError::Truncated(what))?;
        let b: [u8; 4] = self
            .buf
            .get(self.pos..end)
            .and_then(|b| b.try_into().ok())
            .ok_or(ReadError::Truncated(what))?;
        self.pos = end;
        Ok(u32::from_be_bytes(b))
    }

    fn bytes(&mut self, len: usize, what: &'static str) -> Result<&[u8], ReadError> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or(ReadError::Truncated(what))?;
        let b = self
            .buf
            .get(self.pos..end)
            .ok_or(ReadError::Truncated(what))?;
        self.pos = end;
        Ok(b)
    }

    /// Skip the zero padding to the next 4-byte boundary (§5.4.1). Past the end of the block
    /// the next read fails, so saturating is safe.
    fn align4(&mut self) {
        self.pos = self.pos.checked_next_multiple_of(4).unwrap_or(usize::MAX);
    }
}

/// `buf[at..at + 4]` as a big-endian u32.
fn be32(buf: &[u8], at: usize) -> Result<u32, ReadError> {
    Cursor { buf, pos: at }.u32("header")
}

/// The NUL-terminated string starting at `buf[at]`.
fn cstr(buf: &[u8], at: usize) -> Option<&[u8]> {
    let rest = buf.get(at..)?;
    let nul = rest.iter().position(|&b| b == 0)?;
    rest.get(..nul)
}

/// The sub-slice `[off, off + size)` of `blob`, which must lie inside `total`.
fn block<'a>(
    blob: &'a [u8],
    off: u32,
    size: u32,
    total: usize,
    what: &'static str,
) -> Result<&'a [u8], ReadError> {
    let start = usize::try_from(off).map_err(|_| ReadError::BadBlock(what))?;
    let len = usize::try_from(size).map_err(|_| ReadError::BadBlock(what))?;
    let end = start.checked_add(len).ok_or(ReadError::BadBlock(what))?;
    if start < FDT_HEADER_SIZE || end > total {
        return Err(ReadError::BadBlock(what));
    }
    blob.get(start..end).ok_or(ReadError::BadBlock(what))
}

/// Parse and check the header.
pub fn header(blob: &[u8]) -> Result<Header, ReadError> {
    if blob.len() < FDT_HEADER_SIZE {
        return Err(ReadError::TruncatedHeader);
    }
    let f = |i: usize| be32(blob, i.saturating_mul(4));
    let h = Header {
        magic: f(0)?,
        totalsize: f(1)?,
        off_dt_struct: f(2)?,
        off_dt_strings: f(3)?,
        off_mem_rsvmap: f(4)?,
        version: f(5)?,
        last_comp_version: f(6)?,
        boot_cpuid_phys: f(7)?,
        size_dt_strings: f(8)?,
        size_dt_struct: f(9)?,
    };
    if h.magic != FDT_MAGIC {
        return Err(ReadError::BadMagic(h.magic));
    }
    let total = usize::try_from(h.totalsize).map_err(|_| ReadError::BadTotalSize(h.totalsize))?;
    if total < FDT_HEADER_SIZE || total > blob.len() || total > FDT_MAX_SIZE {
        return Err(ReadError::BadTotalSize(h.totalsize));
    }
    if h.version < 16 || h.last_comp_version > 17 {
        return Err(ReadError::BadVersion {
            version: h.version,
            last_comp: h.last_comp_version,
        });
    }
    if !h.off_mem_rsvmap.is_multiple_of(8) {
        return Err(ReadError::BadBlock("reservation map alignment"));
    }
    if !h.off_dt_struct.is_multiple_of(4) || !h.size_dt_struct.is_multiple_of(4) {
        return Err(ReadError::BadBlock("structure block alignment"));
    }
    Ok(h)
}

/// Parse a whole blob (module docs).
pub fn parse(blob: &[u8]) -> Result<Fdt, ReadError> {
    let h = header(blob)?;
    let total = usize::try_from(h.totalsize).map_err(|_| ReadError::BadTotalSize(h.totalsize))?;
    let structure = block(
        blob,
        h.off_dt_struct,
        h.size_dt_struct,
        total,
        "structure block",
    )?;
    let strings = block(
        blob,
        h.off_dt_strings,
        h.size_dt_strings,
        total,
        "strings block",
    )?;
    let reservations = parse_reservations(blob, h.off_mem_rsvmap, total)?;
    let root = parse_structure(structure, strings)?;
    Ok(Fdt {
        header: h,
        reservations,
        root,
    })
}

fn parse_reservations(blob: &[u8], off: u32, total: usize) -> Result<Vec<(u64, u64)>, ReadError> {
    let mut pos = usize::try_from(off).map_err(|_| ReadError::BadReservations)?;
    if pos < FDT_HEADER_SIZE {
        return Err(ReadError::BadReservations);
    }
    let mut out = Vec::new();
    loop {
        let end = pos
            .checked_add(FDT_RSV_ENTRY_SIZE)
            .ok_or(ReadError::BadReservations)?;
        if end > total {
            return Err(ReadError::BadReservations);
        }
        let e = blob.get(pos..end).ok_or(ReadError::BadReservations)?;
        let (a, s) = e.split_at(8);
        let addr = u64::from_be_bytes(a.try_into().map_err(|_| ReadError::BadReservations)?);
        let size = u64::from_be_bytes(s.try_into().map_err(|_| ReadError::BadReservations)?);
        if addr == 0 && size == 0 {
            return Ok(out);
        }
        if out.len() >= MAX_RESERVATIONS {
            return Err(ReadError::BadReservations);
        }
        out.push((addr, size));
        pos = end;
    }
}

fn utf8(b: &[u8]) -> Result<String, ReadError> {
    core::str::from_utf8(b)
        .map(str::to_owned)
        .map_err(|_| ReadError::NotUtf8)
}

fn parse_structure(structure: &[u8], strings: &[u8]) -> Result<Node, ReadError> {
    let mut c = Cursor {
        buf: structure,
        pos: 0,
    };
    // `stack[k]` is an open node; `has_child[k]` records whether it already has one.
    let mut stack: Vec<(Node, bool)> = Vec::new();
    let mut root: Option<Node> = None;
    for _ in 0..MAX_TOKENS {
        let tok = c.u32("token")?;
        match tok {
            FDT_BEGIN_NODE => {
                if root.is_some() {
                    return Err(ReadError::BadStructure("a second root node"));
                }
                if stack.len() >= MAX_DEPTH {
                    return Err(ReadError::TooComplex);
                }
                let name = cstr(structure, c.pos).ok_or(ReadError::UnterminatedName)?;
                let name = utf8(name)?;
                c.pos = c
                    .pos
                    .checked_add(name.len())
                    .and_then(|p| p.checked_add(1))
                    .ok_or(ReadError::UnterminatedName)?;
                c.align4();
                if let Some(parent) = stack.last_mut() {
                    parent.1 = true;
                } else if !name.is_empty() {
                    return Err(ReadError::BadStructure("the root node has a name"));
                }
                stack.push((
                    Node {
                        name,
                        ..Node::default()
                    },
                    false,
                ));
            }
            FDT_END_NODE => {
                let (node, _) = stack
                    .pop()
                    .ok_or(ReadError::BadStructure("FDT_END_NODE without a node"))?;
                match stack.last_mut() {
                    Some((parent, _)) => parent.children.push(node),
                    None => root = Some(node),
                }
            }
            FDT_PROP => {
                let len = c.u32("property length")?;
                let nameoff = c.u32("property name offset")?;
                let len = usize::try_from(len).map_err(|_| ReadError::Truncated("value"))?;
                let value = c.bytes(len, "property value")?.to_vec();
                c.align4();
                let at = usize::try_from(nameoff).map_err(|_| ReadError::BadNameOffset(nameoff))?;
                let name = cstr(strings, at).ok_or(ReadError::BadNameOffset(nameoff))?;
                let name = utf8(name)?;
                let (node, has_child) = stack
                    .last_mut()
                    .ok_or(ReadError::BadStructure("a property outside any node"))?;
                if *has_child {
                    return Err(ReadError::BadStructure("a property after a child node"));
                }
                node.props.push(Prop { name, value });
            }
            FDT_NOP => {}
            FDT_END => {
                if !stack.is_empty() {
                    return Err(ReadError::BadStructure("FDT_END inside a node"));
                }
                return root.ok_or(ReadError::BadStructure("no root node"));
            }
            other => return Err(ReadError::BadToken(other)),
        }
    }
    Err(ReadError::TooComplex)
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)] // tests: a panic fails it
mod tests {
    use super::*;
    use crate::fdt::writer::FdtWriter;

    #[test]
    fn round_trip_small_tree() {
        let mut w = FdtWriter::new();
        let r = w.begin_node("").unwrap();
        w.prop_strs("compatible", &["a,b", "c"]).unwrap();
        let n = w.begin_node("n@1").unwrap();
        w.prop_u64("x", 0x1122_3344_5566_7788).unwrap();
        w.end_node(n).unwrap();
        w.end_node(r).unwrap();
        let f = parse(&w.finish(7).unwrap()).unwrap();
        assert_eq!(f.header.boot_cpuid_phys, 7);
        assert_eq!(
            f.root.prop("compatible").unwrap().strs(),
            Some(vec!["a,b", "c"])
        );
        assert_eq!(
            f.find("/n@1").unwrap().prop("x").unwrap().u64(),
            Some(0x1122_3344_5566_7788)
        );
        let paths: Vec<String> = f.root.walk().into_iter().map(|(p, _)| p).collect();
        assert_eq!(paths, ["/", "/n@1"]);
    }
}
