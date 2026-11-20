//! A bounded JSON reader for exit-trace lines (PLAN M27; `course/checkpoints/TRACE.md`).
//!
//! **Why:** a checkpoint reads the JSONL trace a learner's VMM wrote. That file is produced by
//! code under test and indirectly shaped by a guest, so the harness treats it as hostile input:
//! every line must be one valid JSON value (RFC 8259 §2–§7) or the checkpoint fails with the line
//! number, instead of a marker silently matching half a record.
//!
//! **Limits** (PLAN M27 security checklist): a line longer than [`MAX_LINE`] bytes and nesting
//! deeper than [`MAX_DEPTH`] are errors. Depth counts containers: a trace record (one object)
//! is depth 1. The recursion is bounded by [`MAX_DEPTH`], so input cannot overflow the stack.
//! Duplicate object keys are refused (RFC 8259 §4 leaves them undefined; we pick "error").
//! Numbers are validated against the RFC grammar and kept as their source text, because trace
//! integers are counters and 64-bit values travel as hex strings anyway.
#![deny(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

use std::fmt;

/// The longest accepted line (PLAN M27: 64 KiB).
pub const MAX_LINE: usize = 64 * 1024;
/// The deepest accepted nesting of arrays and objects (PLAN M27: 4).
pub const MAX_DEPTH: usize = 4;

/// A JSON value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Json {
    Null,
    Bool(bool),
    /// The number's source text (already checked against the grammar).
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    /// Members in source order.
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// The member `key` of an object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The string value of member `key`.
    pub fn get_str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Json::Str(s)) => Some(s),
            _ => None,
        }
    }
}

/// Why a line was refused, with the byte offset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonError {
    pub at: usize,
    pub message: String,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "byte {}: {}", self.at, self.message)
    }
}

impl std::error::Error for JsonError {}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

/// Parse one line holding exactly one JSON value.
pub fn parse_line(line: &str) -> Result<Json, JsonError> {
    if line.len() > MAX_LINE {
        return Err(JsonError {
            at: MAX_LINE,
            message: format!("line is {} bytes (max {MAX_LINE})", line.len()),
        });
    }
    let mut p = Parser {
        s: line.as_bytes(),
        i: 0,
    };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return p.fail("trailing characters after the value");
    }
    Ok(v)
}

impl Parser<'_> {
    fn fail<T>(&self, message: &str) -> Result<T, JsonError> {
        Err(JsonError {
            at: self.i,
            message: message.to_owned(),
        })
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn bump(&mut self) {
        self.i = self.i.saturating_add(1);
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.bump();
        }
    }

    fn lit(&mut self, word: &str, v: Json) -> Result<Json, JsonError> {
        let end = self.i.saturating_add(word.len());
        if self.s.get(self.i..end) == Some(word.as_bytes()) {
            self.i = end;
            Ok(v)
        } else {
            self.fail("invalid literal")
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.ws();
        match self.peek() {
            None => self.fail("expected a value"),
            Some(b'{') => self.object(depth.saturating_add(1)),
            Some(b'[') => self.array(depth.saturating_add(1)),
            Some(b'"') => self.string().map(Json::Str),
            Some(b't') => self.lit("true", Json::Bool(true)),
            Some(b'f') => self.lit("false", Json::Bool(false)),
            Some(b'n') => self.lit("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => self.fail("unexpected character"),
        }
    }

    fn enter(&self, depth: usize) -> Result<(), JsonError> {
        if depth > MAX_DEPTH {
            return self.fail(&format!("nesting deeper than {MAX_DEPTH}"));
        }
        Ok(())
    }

    fn object(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.enter(depth)?;
        self.bump(); // {
        let mut members: Vec<(String, Json)> = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.bump();
            return Ok(Json::Obj(members));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return self.fail("expected a string key");
            }
            let key = self.string()?;
            if members.iter().any(|(k, _)| *k == key) {
                return self.fail(&format!("duplicate key {key:?}"));
            }
            self.ws();
            if self.peek() != Some(b':') {
                return self.fail("expected `:`");
            }
            self.bump();
            let v = self.value(depth)?;
            members.push((key, v));
            self.ws();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b'}') => {
                    self.bump();
                    return Ok(Json::Obj(members));
                }
                _ => return self.fail("expected `,` or `}`"),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.enter(depth)?;
        self.bump(); // [
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.bump();
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value(depth)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b']') => {
                    self.bump();
                    return Ok(Json::Arr(items));
                }
                _ => return self.fail("expected `,` or `]`"),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let end = self.i.saturating_add(4);
        let h = self
            .s
            .get(self.i..end)
            .and_then(|b| std::str::from_utf8(b).ok())
            .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))
            .and_then(|h| u32::from_str_radix(h, 16).ok());
        match h {
            Some(v) => {
                self.i = end;
                Ok(v)
            }
            None => self.fail("bad \\u escape"),
        }
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.bump(); // "
        let mut out = String::new();
        loop {
            let Some(b) = self.peek() else {
                return self.fail("unterminated string");
            };
            match b {
                b'"' => {
                    self.bump();
                    return Ok(out);
                }
                b'\\' => {
                    self.bump();
                    let Some(e) = self.peek() else {
                        return self.fail("unterminated escape");
                    };
                    self.bump();
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xd800..0xdc00).contains(&hi) {
                                // A high surrogate must be followed by `\u` + low surrogate.
                                let end = self.i.saturating_add(2);
                                if self.s.get(self.i..end) != Some(b"\\u") {
                                    return self.fail("lone surrogate");
                                }
                                self.i = end;
                                let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) {
                                    return self.fail("lone surrogate");
                                }
                                0x1_0000u32
                                    .saturating_add((hi.saturating_sub(0xd800)) << 10)
                                    .saturating_add(lo.saturating_sub(0xdc00))
                            } else {
                                hi
                            };
                            match char::from_u32(cp) {
                                Some(c) => out.push(c),
                                None => return self.fail("lone surrogate"),
                            }
                        }
                        _ => return self.fail("unknown escape"),
                    }
                }
                0..=0x1f => return self.fail("unescaped control character in a string"),
                _ => {
                    // Copy one UTF-8 scalar (the input is a &str, so it is well formed).
                    let len = match b {
                        0x00..=0x7f => 1,
                        0xc0..=0xdf => 2,
                        0xe0..=0xef => 3,
                        _ => 4,
                    };
                    let end = self.i.saturating_add(len);
                    match self
                        .s
                        .get(self.i..end)
                        .and_then(|c| std::str::from_utf8(c).ok())
                    {
                        Some(c) => out.push_str(c),
                        None => return self.fail("invalid UTF-8"),
                    }
                    self.i = end;
                }
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.bump();
        }
        self.i.saturating_sub(start)
    }

    fn number(&mut self) -> Result<Json, JsonError> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.bump();
        }
        match self.peek() {
            Some(b'0') => self.bump(),
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return self.fail("bad number"),
        }
        if self.peek() == Some(b'.') {
            self.bump();
            if self.digits() == 0 {
                return self.fail("bad number");
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.bump();
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.bump();
            }
            if self.digits() == 0 {
                return self.fail("bad number");
            }
        }
        let text = self
            .s
            .get(start..self.i)
            .and_then(|b| std::str::from_utf8(b).ok())
            .unwrap_or("");
        Ok(Json::Num(text.to_owned()))
    }
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn trace_record() {
        let r = parse_line(r#"{"t_ns":1234,"vcpu":0,"reason":"exception","ec":"0x24","wnr":true,"x":null,"a":[1,-2.5e3]}"#).unwrap();
        assert_eq!(r.get_str("ec"), Some("0x24"));
        assert_eq!(r.get("t_ns"), Some(&Json::Num("1234".into())));
        assert_eq!(r.get("wnr"), Some(&Json::Bool(true)));
    }

    #[test]
    fn escapes() {
        let r = parse_line(r#""a\né😀\"""#).unwrap();
        assert_eq!(r, Json::Str("a\n\u{e9}\u{1f600}\"".into()));
    }
}
