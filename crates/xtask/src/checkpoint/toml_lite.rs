//! A deliberately small TOML reader for `checkpoint.toml`, `manifest.toml` and
//! `.progress.toml` (PLAN M27; CURRICULUM §3.2).
//!
//! **Why not the `toml` crate:** the harness reads files that a learner (or a downloaded fork
//! of the course) can edit, and CLAUDE.md asks for no dependency where a small, reviewed parser
//! will do. The subset is what the checkpoint format needs and nothing more, so every input
//! outside it is a clear error instead of a silently different meaning.
//!
//! **Supported subset** (TOML v1.0.0, <https://toml.io/en/v1.0.0>, sections "Keys", "String",
//! "Integer", "Boolean", "Array", "Table", "Array of Tables"):
//! - comments (`#` to end of line, outside strings);
//! - bare keys `[A-Za-z0-9_-]+` (no quoted or dotted keys);
//! - basic strings `"…"` with the escapes `\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX`, and literal
//!   strings `'…'`, both on one line;
//! - decimal integers (optional sign, `_` between digits) that fit `i64`;
//! - `true` / `false`;
//! - arrays of strings, which may span lines and end with a trailing comma;
//! - one level of `[table]` and `[[array-of-tables]]` headers (no dotted names).
//!
//! **Refused** (each a [`TomlError`] with a line number): input over [`MAX_INPUT`] bytes, an
//! unterminated string, a duplicate key, a table defined twice (or a name used both as a table
//! and an array of tables, or as a root key), inline tables, nested arrays, arrays of non-strings,
//! multi-line strings, floats, dates, dotted keys and headers, and control characters in strings.
//! The cap and the one-level nesting are threat-model limits (PLAN M27 security checklist): the
//! parser does no recursion at all, so input cannot drive it deep.
#![deny(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

use std::collections::BTreeMap;
use std::fmt;

/// The largest document accepted (PLAN M27: 64 KiB).
pub const MAX_INPUT: usize = 64 * 1024;

/// A value of the subset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Str(String),
    Int(i64),
    Bool(bool),
    StrArray(Vec<String>),
}

impl Value {
    /// The value's type name, for error messages.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Str(_) => "string",
            Value::Int(_) => "integer",
            Value::Bool(_) => "boolean",
            Value::StrArray(_) => "array of strings",
        }
    }
}

/// One table: keys in file order (duplicates are refused while parsing).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Table {
    pub entries: Vec<(String, Value)>,
    /// 1-based line of the header (0 for the root table).
    pub line: usize,
}

impl Table {
    /// The value of `key`, if present.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// A string value; `Err` if present with another type.
    pub fn str(&self, key: &str) -> Result<Option<&str>, String> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Str(s)) => Ok(Some(s)),
            Some(v) => Err(format!("`{key}` must be a string, not {}", v.type_name())),
        }
    }

    /// An integer value; `Err` if present with another type.
    pub fn int(&self, key: &str) -> Result<Option<i64>, String> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Int(i)) => Ok(Some(*i)),
            Some(v) => Err(format!("`{key}` must be an integer, not {}", v.type_name())),
        }
    }

    /// A boolean value; `Err` if present with another type.
    pub fn bool(&self, key: &str) -> Result<Option<bool>, String> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(v) => Err(format!("`{key}` must be a boolean, not {}", v.type_name())),
        }
    }

    /// An array of strings; `Err` if present with another type.
    pub fn strs(&self, key: &str) -> Result<Option<&[String]>, String> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::StrArray(a)) => Ok(Some(a)),
            Some(v) => Err(format!(
                "`{key}` must be an array of strings, not {}",
                v.type_name()
            )),
        }
    }

    /// Every key not in `known`, so a typo in a checkpoint file is an error, not a no-op.
    pub fn unknown_keys(&self, known: &[&str]) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(k, _)| !known.contains(&k.as_str()))
            .map(|(k, _)| k.clone())
            .collect()
    }
}

/// A parsed document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Document {
    pub root: Table,
    pub tables: BTreeMap<String, Table>,
    pub arrays: BTreeMap<String, Vec<Table>>,
}

/// A parse error with its 1-based line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TomlError {
    pub line: usize,
    pub message: String,
}

impl fmt::Display for TomlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for TomlError {}

fn err<T>(line: usize, message: impl Into<String>) -> Result<T, TomlError> {
    Err(TomlError {
        line,
        message: message.into(),
    })
}

/// Which table the following `key = value` lines go to.
enum Target {
    Root,
    Table(String),
    Array(String),
}

/// Parse a whole document.
pub fn parse(text: &str) -> Result<Document, TomlError> {
    if text.len() > MAX_INPUT {
        return err(
            0,
            format!("input is {} bytes (max {MAX_INPUT})", text.len()),
        );
    }
    let mut doc = Document::default();
    let mut target = Target::Root;
    let lines: Vec<&str> = text.lines().collect();
    let mut idx = 0usize;
    while let Some(raw) = lines.get(idx) {
        let line_no = idx.saturating_add(1);
        idx = idx.saturating_add(1);
        let line = strip_comment(raw, line_no)?;
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(rest) = t.strip_prefix("[[") {
            let name = rest
                .strip_suffix("]]")
                .ok_or_else(|| TomlError {
                    line: line_no,
                    message: "an array-of-tables header must end with `]]`".into(),
                })?
                .trim();
            check_header_name(name, line_no)?;
            if doc.tables.contains_key(name) || doc.root.get(name).is_some() {
                return err(
                    line_no,
                    format!("`{name}` is already defined as a table or key"),
                );
            }
            doc.arrays.entry(name.to_owned()).or_default().push(Table {
                entries: Vec::new(),
                line: line_no,
            });
            target = Target::Array(name.to_owned());
            continue;
        }
        if let Some(rest) = t.strip_prefix('[') {
            let name = rest
                .strip_suffix(']')
                .ok_or_else(|| TomlError {
                    line: line_no,
                    message: "a table header must end with `]`".into(),
                })?
                .trim();
            check_header_name(name, line_no)?;
            if doc.tables.contains_key(name)
                || doc.arrays.contains_key(name)
                || doc.root.get(name).is_some()
            {
                return err(line_no, format!("table `{name}` is defined twice"));
            }
            doc.tables.insert(
                name.to_owned(),
                Table {
                    entries: Vec::new(),
                    line: line_no,
                },
            );
            target = Target::Table(name.to_owned());
            continue;
        }
        // key = value
        let (key, value_text) = t.split_once('=').ok_or_else(|| TomlError {
            line: line_no,
            message: format!("expected `key = value`, found {t:?}"),
        })?;
        let key = key.trim();
        if key.contains('.') {
            return err(line_no, format!("dotted key `{key}` is not supported"));
        }
        if !valid_bare_key(key) {
            return err(line_no, format!("invalid key {key:?} (bare keys only)"));
        }
        let mut value_text = value_text.trim().to_owned();
        // A string array may continue over several lines until its closing `]`.
        if value_text.starts_with('[') {
            while !array_closed(&value_text, line_no)? {
                let Some(next) = lines.get(idx) else {
                    return err(line_no, format!("array for `{key}` is never closed"));
                };
                let next_no = idx.saturating_add(1);
                idx = idx.saturating_add(1);
                value_text.push('\n');
                value_text.push_str(strip_comment(next, next_no)?.trim());
            }
        }
        let value = parse_value(&value_text, line_no)?;
        if matches!(target, Target::Root)
            && (doc.tables.contains_key(key) || doc.arrays.contains_key(key))
        {
            return err(line_no, format!("`{key}` is already a table"));
        }
        let table = match &target {
            Target::Root => &mut doc.root,
            Target::Table(n) => doc.tables.get_mut(n).ok_or_else(|| TomlError {
                line: line_no,
                message: "internal: lost table".into(),
            })?,
            Target::Array(n) => doc
                .arrays
                .get_mut(n)
                .and_then(|v| v.last_mut())
                .ok_or_else(|| TomlError {
                    line: line_no,
                    message: "internal: lost array table".into(),
                })?,
        };
        if table.get(key).is_some() {
            return err(line_no, format!("duplicate key `{key}`"));
        }
        table.entries.push((key.to_owned(), value));
    }
    Ok(doc)
}

fn valid_bare_key(k: &str) -> bool {
    !k.is_empty()
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn check_header_name(name: &str, line: usize) -> Result<(), TomlError> {
    if name.contains('.') {
        return err(
            line,
            format!("nested table `{name}` is beyond the supported subset"),
        );
    }
    if name.contains('[') || name.contains(']') {
        return err(line, format!("malformed table header `{name}`"));
    }
    if !valid_bare_key(name) {
        return err(line, format!("invalid table name {name:?}"));
    }
    Ok(())
}

/// Remove a trailing `# comment` that is outside any string. An unterminated string is an
/// error here already.
fn strip_comment(line: &str, line_no: usize) -> Result<&str, TomlError> {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in line.char_indices() {
        match quote {
            Some('"') => {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    quote = None;
                }
            }
            Some(_) => {
                if c == '\'' {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' => quote = Some(c),
                '#' => return Ok(line.get(..i).unwrap_or("")),
                _ => {}
            },
        }
    }
    if quote.is_some() {
        return err(line_no, "unterminated string");
    }
    Ok(line)
}

/// True when the brackets of an array value (outside strings) balance.
fn array_closed(text: &str, line_no: usize) -> Result<bool, TomlError> {
    let mut depth = 0u32;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in text.chars() {
        match quote {
            Some('"') => {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    quote = None;
                }
            }
            Some(_) => {
                if c == '\'' {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' => quote = Some(c),
                '[' => {
                    depth = depth.saturating_add(1);
                    if depth > 1 {
                        return err(line_no, "nested arrays are beyond the supported subset");
                    }
                }
                ']' => depth = depth.saturating_sub(1),
                _ => {}
            },
        }
    }
    Ok(depth == 0)
}

fn parse_value(text: &str, line: usize) -> Result<Value, TomlError> {
    let t = text.trim();
    if t.starts_with('{') {
        return err(line, "inline tables are beyond the supported subset");
    }
    if let Some(inner) = t.strip_prefix('[') {
        let inner = inner.strip_suffix(']').ok_or_else(|| TomlError {
            line,
            message: "text after the closing `]` of an array".into(),
        })?;
        return parse_str_array(inner, line).map(Value::StrArray);
    }
    if t.starts_with("\"\"\"") || t.starts_with("'''") {
        return err(line, "multi-line strings are beyond the supported subset");
    }
    if t.starts_with('"') || t.starts_with('\'') {
        let (s, rest) = parse_string(t, line)?;
        if !rest.trim().is_empty() {
            return err(line, format!("unexpected text after a string: {rest:?}"));
        }
        return Ok(Value::Str(s));
    }
    match t {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        _ => {}
    }
    parse_int(t, line).map(Value::Int)
}

fn parse_int(t: &str, line: usize) -> Result<i64, TomlError> {
    let (neg, digits) = match t.strip_prefix('-') {
        Some(d) => (true, d),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let bad = || TomlError {
        line,
        message: format!("unsupported value {t:?} (strings, integers, booleans, string arrays)"),
    };
    if digits.is_empty()
        || digits.starts_with('_')
        || digits.ends_with('_')
        || digits.contains("__")
        || !digits.bytes().all(|b| b.is_ascii_digit() || b == b'_')
        || (digits.len() > 1 && digits.starts_with('0'))
    {
        return Err(bad());
    }
    let clean: String = digits.chars().filter(|&c| c != '_').collect();
    let v: i64 = clean.parse().map_err(|_| TomlError {
        line,
        message: format!("integer {t:?} does not fit 64 bits"),
    })?;
    Ok(if neg {
        v.checked_neg().ok_or_else(bad)?
    } else {
        v
    })
}

/// Parse one string at the start of `t`; returns it and the rest of the text.
fn parse_string(t: &str, line: usize) -> Result<(String, &str), TomlError> {
    let mut chars = t.char_indices();
    let Some((_, q)) = chars.next() else {
        return err(line, "expected a string");
    };
    let mut out = String::new();
    if q == '\'' {
        for (i, c) in chars {
            if c == '\'' {
                return Ok((out, t.get(i.saturating_add(1)..).unwrap_or("")));
            }
            check_char(c, line)?;
            out.push(c);
        }
        return err(line, "unterminated string");
    }
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Ok((out, t.get(i.saturating_add(1)..).unwrap_or(""))),
            '\\' => {
                let Some((_, e)) = chars.next() else {
                    return err(line, "unterminated string");
                };
                match e {
                    'b' => out.push('\u{8}'),
                    't' => out.push('\t'),
                    'n' => out.push('\n'),
                    'f' => out.push('\u{c}'),
                    'r' => out.push('\r'),
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    'u' | 'U' => {
                        let n = if e == 'u' { 4 } else { 8 };
                        let mut hex = String::new();
                        for _ in 0..n {
                            match chars.next() {
                                Some((_, h)) if h.is_ascii_hexdigit() => hex.push(h),
                                _ => return err(line, "bad \\u escape"),
                            }
                        }
                        let cp = u32::from_str_radix(&hex, 16).map_err(|_| TomlError {
                            line,
                            message: "bad \\u escape".into(),
                        })?;
                        out.push(char::from_u32(cp).ok_or_else(|| TomlError {
                            line,
                            message: format!("\\u{hex} is not a Unicode scalar value"),
                        })?);
                    }
                    other => return err(line, format!("unknown escape \\{other}")),
                }
            }
            c => {
                check_char(c, line)?;
                out.push(c);
            }
        }
    }
    err(line, "unterminated string")
}

/// TOML forbids control characters other than tab inside strings.
fn check_char(c: char, line: usize) -> Result<(), TomlError> {
    if (c.is_control() && c != '\t') || c == '\u{7f}' {
        return err(
            line,
            format!("control character U+{:04X} in a string", u32::from(c)),
        );
    }
    Ok(())
}

fn parse_str_array(inner: &str, line: usize) -> Result<Vec<String>, TomlError> {
    let mut out = Vec::new();
    let mut rest = inner.trim_start();
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            return Ok(out);
        }
        if !(rest.starts_with('"') || rest.starts_with('\'')) {
            if rest.starts_with('[') {
                return err(line, "nested arrays are beyond the supported subset");
            }
            return err(
                line,
                format!(
                    "arrays may hold only strings (found {:?})",
                    rest.lines().next().unwrap_or("")
                ),
            );
        }
        let (s, after) = parse_string(rest, line)?;
        out.push(s);
        let after = after.trim_start();
        if after.is_empty() {
            return Ok(out);
        }
        rest = after.strip_prefix(',').ok_or_else(|| TomlError {
            line,
            message: "expected `,` between array elements".into(),
        })?;
    }
}

/// Quote `s` as a TOML basic string (for writing `.progress.toml`).
pub fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04X}", u32::from(c)));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `["a", "b"]`
pub fn quote_array(items: &[String]) -> String {
    let inner: Vec<String> = items.iter().map(|s| quote(s)).collect();
    format!("[{}]", inner.join(", "))
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn subset_round_trip() {
        let d = parse(
            "id = \"07\" # c\nrequires = [\"06\",\n  'x#y', # c\n]\n[contract]\ncrate = \"vmm\"\n[[run]]\nname='a'\nexpect_exit_code = -3\nok = true\n[[run]]\nname = \"b\\u0041\"\n",
        )
        .unwrap();
        assert_eq!(d.root.str("id").unwrap(), Some("07"));
        assert_eq!(
            d.root.strs("requires").unwrap().unwrap(),
            ["06".to_owned(), "x#y".to_owned()]
        );
        assert_eq!(d.tables["contract"].str("crate").unwrap(), Some("vmm"));
        let runs = &d.arrays["run"];
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].int("expect_exit_code").unwrap(), Some(-3));
        assert_eq!(runs[0].bool("ok").unwrap(), Some(true));
        assert_eq!(runs[1].str("name").unwrap(), Some("bA"));
    }

    #[test]
    fn quote_round_trips() {
        let s = "a\"b\\c\n\u{1}é";
        let d = parse(&format!("k = {}\n", quote(s))).unwrap();
        assert_eq!(d.root.str("k").unwrap(), Some(s));
    }
}
