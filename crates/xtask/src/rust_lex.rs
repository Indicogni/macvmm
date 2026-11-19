//! A small Rust tokenizer for the audit: just enough to ignore comments and literals.
//!
//! **Why a lexer instead of `grep`:** the audit bans tokens such as `unsafe`, `println!` and
//! `process::Command` in certain files. A text search would trip on doc comments that *explain*
//! those rules ("`unsafe` is quarantined") and on string literals in tests. Tokenizing lets the
//! audit look only at code. It follows the Rust Reference's lexical structure (§2 "Lexical
//! structure": comments, string/raw-string/byte-string/C-string literals, character literals
//! versus lifetimes, identifiers including raw identifiers, numeric literals) but does not
//! validate anything: malformed input degrades to punctuation tokens, never a panic.

/// One token with the 1-based line it starts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub kind: Kind,
    pub line: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    /// An identifier or keyword (`r#` prefix removed).
    Ident(String),
    /// A numeric literal exactly as written, including `_` and any suffix.
    Number(String),
    /// A single punctuation character (`::` is two `:` tokens).
    Punct(char),
    /// Any string, byte-string, C-string or character literal (contents dropped).
    Literal,
}

impl Token {
    pub fn ident(&self) -> Option<&str> {
        match &self.kind {
            Kind::Ident(s) => Some(s),
            _ => None,
        }
    }
    pub fn is_punct(&self, c: char) -> bool {
        self.kind == Kind::Punct(c)
    }
}

/// Tokenize `src`. Comments and whitespace are dropped.
pub fn tokenize(src: &str) -> Vec<Token> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut line = 1usize;
    let at = |i: usize| chars.get(i).copied();

    while let Some(c) = at(i) {
        // Whitespace.
        if c.is_whitespace() {
            if c == '\n' {
                line += 1;
            }
            i += 1;
            continue;
        }
        // Line comment (including doc comments).
        if c == '/' && at(i + 1) == Some('/') {
            while let Some(c) = at(i) {
                if c == '\n' {
                    break;
                }
                i += 1;
            }
            continue;
        }
        // Block comment, nested.
        if c == '/' && at(i + 1) == Some('*') {
            let mut depth = 0usize;
            while let Some(c) = at(i) {
                if c == '/' && at(i + 1) == Some('*') {
                    depth += 1;
                    i += 2;
                } else if c == '*' && at(i + 1) == Some('/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    if c == '\n' {
                        line += 1;
                    }
                    i += 1;
                }
            }
            continue;
        }
        let start_line = line;
        // Raw strings: r"..", r#".."#, br#".."#, cr#".."#.
        let raw_prefix_len = match (c, at(i + 1), at(i + 2)) {
            ('r', Some('"' | '#'), _) => Some(1),
            ('b' | 'c', Some('r'), Some('"' | '#')) => Some(2),
            _ => None,
        };
        if let Some(plen) = raw_prefix_len {
            let mut j = i + plen;
            let mut hashes = 0usize;
            while at(j) == Some('#') {
                hashes += 1;
                j += 1;
            }
            if at(j) == Some('"') {
                j += 1;
                // Find `"` followed by `hashes` hashes.
                loop {
                    match at(j) {
                        None => break,
                        Some('"') if (1..=hashes).all(|k| at(j + k) == Some('#')) => {
                            j += 1 + hashes;
                            break;
                        }
                        Some(ch) => {
                            if ch == '\n' {
                                line += 1;
                            }
                            j += 1;
                        }
                    }
                }
                out.push(Token {
                    kind: Kind::Literal,
                    line: start_line,
                });
                i = j;
                continue;
            }
            // `r#ident` (raw identifier) falls through to the identifier rule below.
        }
        // Ordinary strings: "..", b"..", c"..".
        let str_prefix_len = match (c, at(i + 1)) {
            ('"', _) => Some(0),
            ('b' | 'c', Some('"')) => Some(1),
            _ => None,
        };
        if let Some(plen) = str_prefix_len {
            let mut j = i + plen + 1;
            while let Some(ch) = at(j) {
                match ch {
                    '\\' => j += 2,
                    '"' => {
                        j += 1;
                        break;
                    }
                    _ => j += 1,
                }
            }
            // Count newlines afterwards: an escaped newline is skipped by `j += 2` above.
            line = start_line
                + chars[i..j.min(chars.len())]
                    .iter()
                    .filter(|&&c| c == '\n')
                    .count();
            out.push(Token {
                kind: Kind::Literal,
                line: start_line,
            });
            i = j;
            continue;
        }
        // Character literals ('x', '\n', b'x') versus lifetimes ('a).
        let quote = if c == '\'' {
            Some(i)
        } else if c == 'b' && at(i + 1) == Some('\'') {
            Some(i + 1)
        } else {
            None
        };
        if let Some(q) = quote {
            if at(q + 1) == Some('\\') {
                // Skip the backslash *and* the escaped character before looking for the closing
                // quote: in `'\''` and `'\\'` the escaped character is itself a quote or a
                // backslash. Starting the scan any earlier stops on the escaped quote, leaves the
                // real closing quote behind as a new token start, and desynchronizes the rest
                // of the file (a `'\'','"'` sequence then swallowed code, `unsafe` included,
                // into a fake string). `\u{...}` contains no quote, so the scan below covers it.
                let mut j = q + 3;
                while let Some(ch) = at(j) {
                    j += 1;
                    if ch == '\'' || ch == '\n' {
                        break;
                    }
                }
                out.push(Token {
                    kind: Kind::Literal,
                    line,
                });
                i = j;
                continue;
            }
            if at(q + 2) == Some('\'') {
                out.push(Token {
                    kind: Kind::Literal,
                    line,
                });
                i = q + 3;
                continue;
            }
            if c == '\'' {
                // A lifetime or label: emit the quote as punctuation; the name follows as an ident.
                out.push(Token {
                    kind: Kind::Punct('\''),
                    line,
                });
                i += 1;
                continue;
            }
        }
        // Identifiers (and raw identifiers `r#name`).
        if c.is_alphabetic() || c == '_' {
            let mut j = i;
            if c == 'r' && at(i + 1) == Some('#') && at(i + 2).is_some_and(is_ident_start) {
                j = i + 2;
            }
            let begin = j;
            while at(j).is_some_and(|ch| ch.is_alphanumeric() || ch == '_') {
                j += 1;
            }
            let word: String = chars[begin..j].iter().collect();
            out.push(Token {
                kind: Kind::Ident(word),
                line,
            });
            i = j;
            continue;
        }
        // Numbers: digits, then letters/digits/underscores (hex digits, suffixes). A `.` is not
        // consumed, so `0..n` stays a range.
        if c.is_ascii_digit() {
            let mut j = i;
            while at(j).is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
                j += 1;
            }
            let word: String = chars[i..j].iter().collect();
            out.push(Token {
                kind: Kind::Number(word),
                line,
            });
            i = j;
            continue;
        }
        out.push(Token {
            kind: Kind::Punct(c),
            line,
        });
        i += 1;
    }
    out
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}

/// The value of an integer literal written in hex (`0x0900_0000u64` → 0x0900_0000), or `None`
/// for anything else.
pub fn hex_value(literal: &str) -> Option<u128> {
    let body = literal
        .strip_prefix("0x")
        .or_else(|| literal.strip_prefix("0X"))?;
    let digits: String = body
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '_')
        .collect();
    let digits: String = digits.chars().filter(|c| *c != '_').collect();
    if digits.is_empty() {
        return None;
    }
    u128::from_str_radix(&digits, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idents(src: &str) -> Vec<String> {
        tokenize(src)
            .into_iter()
            .filter_map(|t| t.ident().map(str::to_owned))
            .collect()
    }

    #[test]
    fn comments_and_strings_are_dropped() {
        let src = r##"
            // unsafe in a comment
            /* unsafe /* nested */ unsafe */
            let s = "unsafe { }";
            let r = r#"println!("x")"#;
            let b = b"unsafe";
            real
        "##;
        let ids = idents(src);
        assert!(
            !ids.iter().any(|i| i == "unsafe" || i == "println"),
            "{ids:?}"
        );
        assert!(ids.iter().any(|i| i == "real"));
    }

    #[test]
    fn lines_are_tracked_across_literals() {
        let src = "a\n\"x\ny\"\nb\nr#\"\n\"#\nc";
        let toks = tokenize(src);
        let line_of = |name: &str| {
            toks.iter()
                .find(|t| t.ident() == Some(name))
                .map(|t| t.line)
        };
        assert_eq!(line_of("a"), Some(1));
        assert_eq!(line_of("b"), Some(4));
        assert_eq!(line_of("c"), Some(7));
    }

    #[test]
    fn chars_and_lifetimes() {
        let ids = idents("fn f<'a>(x: &'a u8) { let c = '\\''; let d = 'u'; let e = b'x'; }");
        assert!(ids.contains(&"a".to_owned()));
        assert!(!ids.contains(&"u".to_owned()));
        // `x` appears once, as the parameter name; `b'x'` is a literal.
        assert_eq!(ids.iter().filter(|i| *i == "x").count(), 1);
    }

    #[test]
    fn escaped_quote_and_backslash_chars_keep_sync() {
        // Regression: `'\''` directly followed by `'"'` used to open a fake string literal.
        let src = "const A: [char; 2] = ['\\'','\"'];\nfn h() { unsafe { x() } }\nconst B: &str = \"\";\n";
        let ids = idents(src);
        assert!(ids.contains(&"unsafe".to_owned()), "{ids:?}");
        assert!(ids.contains(&"h".to_owned()), "{ids:?}");
        assert!(ids.contains(&"B".to_owned()), "{ids:?}");
        let src = "let a = '\\\\'; let b = '\"'; unsafe_marker(); let c = \"s\";";
        let ids = idents(src);
        assert!(ids.contains(&"unsafe_marker".to_owned()), "{ids:?}");
        assert!(ids.contains(&"c".to_owned()), "{ids:?}");
        let src = "let a = '\\u{1F600}'; let b = b'\\''; after();";
        assert!(idents(src).contains(&"after".to_owned()));
        // Exactly one literal per char literal.
        let lits = tokenize("['\\'','\"','\\\\']")
            .iter()
            .filter(|t| t.kind == Kind::Literal)
            .count();
        assert_eq!(lits, 3);
    }

    #[test]
    fn hex_values() {
        assert_eq!(hex_value("0x0900_0000"), Some(0x0900_0000));
        assert_eq!(hex_value("0X9000000u64"), Some(0x0900_0000));
        assert_eq!(hex_value("0x4000_0000_usize"), Some(0x4000_0000));
        assert_eq!(hex_value("1234"), None);
        assert_eq!(hex_value("0b1010"), None);
    }
}
