//! A tiny guest-side device-tree reader (Devicetree Specification v0.4 ch. 5; course ch10).
//!
//! **Why the guest reads the tree too.** The VMM's host tests check the blob it writes, but
//! only a guest can check what the guest *receives*: that `x0` points at it, that it survived
//! the copy into RAM, and that it parses with the same rules a kernel applies
//! (`drivers/of/fdt.c` via libfdt). `guests/dtb-reader` uses this module to print the values a
//! kernel would read first.
//!
//! The format, in one paragraph: a 40-byte big-endian header (`magic = 0xd00dfeed`,
//! `totalsize`, block offsets), then a token stream (`FDT_BEGIN_NODE name`, `FDT_PROP len
//! nameoff value`, `FDT_END_NODE`, `FDT_END`), each item padded to 4 bytes, and a strings block
//! of NUL-terminated property names. Every offset here is bounds-checked: a guest that trusted
//! the header blindly would be a poor example, even though our VMM wrote it.

/// `magic` (DT spec §5.2).
pub const FDT_MAGIC: u32 = 0xd00d_feed;
const BEGIN_NODE: u32 = 1;
const END_NODE: u32 = 2;
const PROP: u32 = 3;
const NOP: u32 = 4;
const END: u32 = 9;
/// booting.rst §2: a DTB is at most 2 MiB.
pub const MAX_SIZE: usize = 2 << 20;
/// Deepest path we track (our tree is 3 levels deep).
const MAX_DEPTH: usize = 8;

/// A validated blob.
pub struct Fdt<'a> {
    structure: &'a [u8],
    strings: &'a [u8],
}

/// One event of a depth-first walk.
pub enum Event<'a> {
    Begin {
        name: &'a str,
        depth: usize,
    },
    Prop {
        name: &'a str,
        value: &'a [u8],
        depth: usize,
    },
    End {
        depth: usize,
    },
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn cstr(b: &[u8], at: usize) -> Option<&str> {
    let rest = b.get(at..)?;
    let nul = rest.iter().position(|&c| c == 0)?;
    core::str::from_utf8(&rest[..nul]).ok()
}

fn align4(p: usize) -> usize {
    (p + 3) & !3
}

impl<'a> Fdt<'a> {
    /// Check the header and the block bounds of `blob`.
    pub fn new(blob: &'a [u8]) -> Result<Fdt<'a>, &'static str> {
        if be32(blob, 0) != Some(FDT_MAGIC) {
            return Err("bad magic");
        }
        let field = |i: usize| be32(blob, i * 4).map(|v| v as usize).ok_or("short header");
        let total = field(1)?;
        if total < 40 || total > blob.len() {
            return Err("bad totalsize");
        }
        let block = |off: usize, size: usize| {
            off.checked_add(size)
                .filter(|&end| off >= 40 && end <= total)
                .and_then(|end| blob.get(off..end))
                .ok_or("block outside the blob")
        };
        Ok(Fdt {
            structure: block(field(2)?, field(9)?)?,
            strings: block(field(3)?, field(8)?)?,
        })
    }

    /// Read the header at guest-physical `addr` (the MMU is off: VA = PA), then the blob.
    ///
    /// # Safety
    /// `addr` must point at readable RAM holding at least 40 bytes, and `totalsize` more if
    /// the magic matches (the VMM's DTB slot guarantees both).
    pub unsafe fn from_addr(addr: u64) -> Result<Fdt<'static>, &'static str> {
        if addr == 0 || addr % 8 != 0 {
            return Err("x0 is not an 8-byte aligned address");
        }
        // SAFETY: the caller guarantees 40 readable bytes at `addr`.
        let head = unsafe { core::slice::from_raw_parts(addr as *const u8, 40) };
        if be32(head, 0) != Some(FDT_MAGIC) {
            return Err("bad magic");
        }
        let total = be32(head, 4).ok_or("short header")? as usize;
        if !(40..=MAX_SIZE).contains(&total) {
            return Err("bad totalsize");
        }
        // SAFETY: the caller guarantees `totalsize` readable bytes once the magic matched, and
        // `totalsize` is capped at 2 MiB above.
        let blob = unsafe { core::slice::from_raw_parts(addr as *const u8, total) };
        Fdt::new(blob)
    }

    /// Walk every node and property, depth first, calling `f` for each event.
    pub fn walk(&self, mut f: impl FnMut(Event<'a>)) -> Result<(), &'static str> {
        let s = self.structure;
        let mut pos = 0usize;
        let mut depth = 0usize;
        loop {
            let tok = be32(s, pos).ok_or("truncated structure block")?;
            pos += 4;
            match tok {
                BEGIN_NODE => {
                    let name = cstr(s, pos).ok_or("unterminated node name")?;
                    pos = align4(pos + name.len() + 1);
                    f(Event::Begin { name, depth });
                    depth += 1;
                    if depth > MAX_DEPTH {
                        return Err("tree too deep");
                    }
                }
                END_NODE => {
                    depth = depth.checked_sub(1).ok_or("unbalanced FDT_END_NODE")?;
                    f(Event::End { depth });
                }
                PROP => {
                    let len = be32(s, pos).ok_or("truncated property")? as usize;
                    let nameoff = be32(s, pos + 4).ok_or("truncated property")? as usize;
                    let start = pos + 8;
                    let value = start
                        .checked_add(len)
                        .and_then(|end| s.get(start..end))
                        .ok_or("property value outside the block")?;
                    let name = cstr(self.strings, nameoff).ok_or("bad property name offset")?;
                    pos = align4(start + len);
                    f(Event::Prop { name, value, depth });
                }
                NOP => {}
                END => {
                    return if depth == 0 {
                        Ok(())
                    } else {
                        Err("FDT_END inside a node")
                    };
                }
                _ => return Err("unknown token"),
            }
        }
    }

    /// The value of property `prop` of the node at absolute `path` (`"/chosen"`, `"/"`).
    pub fn prop(&self, path: &str, prop: &str) -> Option<&'a [u8]> {
        let want: heapless_path::Path = heapless_path::Path::parse(path)?;
        let mut stack = heapless_path::Stack::new();
        let mut found = None;
        self.walk(|e| match e {
            Event::Begin { name, depth } => stack.set(depth, name),
            Event::Prop { name, value, depth } => {
                if found.is_none() && name == prop && stack.matches(&want, depth) {
                    found = Some(value);
                }
            }
            Event::End { .. } => {}
        })
        .ok()?;
        found
    }

    /// The names of the direct children of the node at `path` that start with `prefix`,
    /// passed to `f` in order; returns how many there were.
    pub fn children(&self, path: &str, prefix: &str, mut f: impl FnMut(&'a str)) -> usize {
        let Some(want) = heapless_path::Path::parse(path) else {
            return 0;
        };
        let mut stack = heapless_path::Stack::new();
        let mut n = 0;
        let _ = self.walk(|e| {
            if let Event::Begin { name, depth } = e {
                if depth == want.len + 1 && stack.matches(&want, depth) && name.starts_with(prefix)
                {
                    n += 1;
                    f(name);
                }
                stack.set(depth, name);
            }
        });
        n
    }
}

/// Fixed-capacity path bookkeeping (no allocator in a guest).
mod heapless_path {
    use super::MAX_DEPTH;

    /// A parsed absolute path: up to `MAX_DEPTH` segments below the root.
    pub struct Path<'p> {
        pub segs: [&'p str; MAX_DEPTH],
        pub len: usize,
    }

    impl<'p> Path<'p> {
        pub fn parse(path: &'p str) -> Option<Path<'p>> {
            let mut p = Path {
                segs: [""; MAX_DEPTH],
                len: 0,
            };
            for seg in path.split('/').filter(|s| !s.is_empty()) {
                *p.segs.get_mut(p.len)? = seg;
                p.len += 1;
            }
            Some(p)
        }
    }

    /// The names of the currently open nodes, by depth (depth 0 is the root, named "").
    pub struct Stack<'a> {
        names: [&'a str; MAX_DEPTH + 1],
    }

    impl<'a> Stack<'a> {
        pub fn new() -> Stack<'a> {
            Stack {
                names: [""; MAX_DEPTH + 1],
            }
        }

        pub fn set(&mut self, depth: usize, name: &'a str) {
            if let Some(slot) = self.names.get_mut(depth) {
                *slot = name;
            }
        }

        /// True if the nodes open at depths `1..depth` are exactly `want` (so an event at
        /// `depth` belongs to the node `want` names, or to its direct child).
        pub fn matches(&self, want: &Path<'_>, depth: usize) -> bool {
            depth == want.len + 1
                && (0..want.len).all(|i| self.names.get(i + 1) == want.segs.get(i))
        }
    }
}
