// model.mjs: readable cases (mirroring crates/vmm/tests/ansi_filter.rs), the primer's two
// predictions, the real captures the presets reproduce, the input notation, the tokenizer, the
// segments and the share hash. oracle.test.mjs does the bulk comparison with the Rust filter.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AnsiFilter, runFilter, parseInput, escapeBytes, escapeCompact, tokenize, analyze, csiVerdict,
  PRESETS, presetById, initialState, encodeHash, decodeHash, checkPrediction, summary,
  HOSTILE_TTY_ATTACKS, EXIT_RESET, MAX_INPUT, CSI_FINALS, PRIVATE_MODES,
} from "./model.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const COURSE = "../../../../";
const bytes = (s) => {
  const p = parseInput(s);
  assert.ok(p.ok, `${s}: ${p.error}`);
  return p.bytes;
};
const safe = (s, opts) => runFilter("safe", bytes(s), opts).out;
const strict = (s) => runFilter("strict", bytes(s)).out;
const txt = (b) => Buffer.from(b).toString("latin1");
const show = (b) => escapeBytes(b).text;

// ---- the filter ----

test("allowed sequences pass byte-exact", () => {
  for (const f of CSI_FINALS) {
    for (const p of ["", "1", "1;2", "38;5;196", "38:2:0:255:0", "12345"]) {
      const s = `\\x1b[${p}${f}`;
      assert.equal(show(safe(s)), show(bytes(s)), s);
    }
  }
  for (const m of PRIVATE_MODES) for (const hl of "hl") assert.equal(show(safe(`\\x1b[?${m}${hl}`)), `\\x1b[?${m}${hl}`);
  for (const s of ["\\x1b[4h", "\\x1b[4l", "\\x1b[2 q", "\\x1b[ q", "\\x1b[?1;25h", "\\x1b7", "\\x1b8", "\\x1bM", "\\x1b=", "\\x1b>", "\\x1b(B", "\\x1b(0", "\\x1b)B", "\\x1b)0"]) {
    assert.equal(show(safe(s)), s, s);
  }
});

test("queries, strings and other controls are dropped whole", () => {
  const cases = [
    ["\\x1b[c", ""], ["\\x1b]0;title\\x07x", "x"], ["\\x1b[?1000h", ""], ["\\x1b[6n", ""], ["\\x1b[21t", ""],
    ["\\x1b[?25;1000h", ""], ["\\x1b[3h", ""], ["a\\x1b]0;t\\x07b", "ab"], ["\\x1b]8;;u\\x07link\\x1b]8;;\\x07", "link"],
    ["a\\x9b6nb\\x9d0;x\\x07c\\x90q", "a6nb0;x\\x07cq"], ["a\\u{9b}6n", "a6n"], ["\\u{85}\\u{9d}\\u{80}", ""],
    ["\\x1b#8hello", "hello"], ["\\x1b(%5hello", "hello"], ["\\x1b F x", " x"], ["\\x1b  #8ok", "ok"],
    ["\\x1b[1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1mX", "X"], ["\\x1b[123456mX", "X"], ["\\x1b[12345m", "\\x1b[12345m"],
    ["\\x1b]0;x\\x18after", "after"], ["\\x1b]0;x\\x1aafter", "after"], ["\\x1b]0;broken\\nnext", "\\nnext"],
    ["\\x1b[3\\n1m", "\\n1m"], ["\\x05\\x0e\\x0fok", "ok"], ["\\x1b[200~paste\\x1b[201~", "paste"],
    ["\\x1b]0;x\\x1b\\\\\\x1b[1mB\\x1b[0m", "\\x1b[1mB\\x1b[0m"], ["\\x1b[1\\x1b[2mX", "\\x1b[2mX"],
    ["\\x1b[1mbold\\x1b[0m \\x1b[6nquery\\x1b]0;t\\x07 \\x1b[?1049hscreen", "\\x1b[1mbold\\x1b[0m query \\x1b[?1049hscreen"],
    ["a\\x00b\\x05c\\x0ed\\x0fe\\x0bf\\x0cg\\x7fh", "abcdefgh"],
  ];
  for (const [inp, want] of cases) assert.equal(show(safe(inp)), want, inp);
});

test("invalid UTF-8 becomes U+FFFD, exactly as ansi.rs", () => {
  const F = "\u{FFFD}";
  for (const [inp, want] of [
    ["\\xc0\\xaf", F + F], ["\\xe0\\x80\\xaf", F], ["\\xed\\xa0\\x80", F], ["\\xf5\\x80", F], ["\\xf4\\x90\\x80\\x80", F],
    ["\\xbf", F], ["\\xe2\\x9cx", F + "x"], ["\\xc3", ""], ["\\xc3x", F + "x"],
  ]) {
    assert.equal(new TextDecoder().decode(safe(inp)), want, inp);
  }
});

test("BEL is rate limited to one per second", () => {
  const f = new AnsiFilter("safe");
  f.push(bytes("\\x07\\x07\\x07"), 0);
  assert.equal(show(f.output()), "\\x07");
  f.push(bytes("\\x07"), 999);
  assert.equal(show(f.output()), "\\x07");
  f.push(bytes("\\x07"), 1000);
  assert.equal(show(f.output()), "\\x07\\x07");
});

test("UTF-8 and CSI split across pushes give the same output", () => {
  const f = new AnsiFilter("safe");
  for (const part of ["\\xe2", "\\x9c", "\\x93 \\x1b[3", "1m", "x\\x1b]0", ";t\\x07y"]) f.push(bytes(part), 0);
  assert.equal(new TextDecoder().decode(f.output()), "✓ \x1b[31mxy");
});

test("strict renders every control visibly (the Rust golden test)", () => {
  assert.equal(txt(strict("ok\\x1b[6n\\x07\\x9b\\xc2\\x9b\\x7f\\tz\\xff\\xe2\\x82y\\r\\n\\x08\\x00")), "ok^[[6n^G\\x9b\\u{9b}^?\tz\\xff\\xe2\\x82y\r\n\x08^@");
  assert.equal(txt(strict("\\x1b]52;c;QQ==\\x07\\x1bP+q544e\\x1b\\\\")), "^[]52;c;QQ==^G^[P+q544e^[\\");
  const r = runFilter("strict", bytes("\\x1b[6n"));
  assert.equal(txt(r.out), "^[[6n");
  assert.equal(r.dropped, 1);
  for (let cp = 0x80; cp <= 0x9f; cp++) assert.equal(txt(runFilter("strict", new TextEncoder().encode(String.fromCodePoint(cp))).out), `\\u{${cp.toString(16)}}`);
});

test("raw passes every byte", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(runFilter("raw", all).out, all);
});

test("a 10 MiB OSC string is swallowed and the text after it survives", () => {
  const p = presetById("osc-10mb");
  const r = runFilter("safe", bytes(p.text), { trace: true });
  assert.equal(txt(r.out), "after");
  assert.ok(r.dropped >= 10 << 20);
  assert.equal(r.segments.length, 2, "one dropped string, one text run");
  assert.equal(r.segments[0].verdict, "drop");
  assert.equal(r.segments[0].end - r.segments[0].start, 10485768);
});

test("csiVerdict explains refusals and agrees with the allow-list", () => {
  const v = (s, f) => csiVerdict([...s].map((c) => c.charCodeAt(0)), f.charCodeAt(0));
  assert.match(v("6", "n").rule, /final byte 'n' \(device status report, a query\)/);
  assert.match(v("?1000", "h").rule, /private mode 1000 \(mouse click reporting\)/);
  assert.match(v("123456", "m").rule, /more than 5 digits/);
  assert.match(v("1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1", "m").rule, /more than 16 parameters/);
  assert.match(v(">", "c").rule, /parameter byte '>'/);
  assert.match(v("3", "h").rule, /only mode 4/);
  assert.equal(v("2 ", "q").ok, true);
  assert.equal(v("?2 ", "q").ok, false);
});

// ---- the lesson's numbers ----

test("the primer's two predictions", () => {
  assert.equal(show(safe("\\x1b[1;31mhi\\x1b[0m")), "\\x1b[1;31mhi\\x1b[0m");
  assert.equal(show(safe("\\x1b]0;rm -rf ~\\x07ok")), "ok");
  // The self-check: safe keeps ESC [ 1 ; 3 1 m and drops ESC ] 0 ; h i BEL entirely.
  assert.equal(show(safe("\\x1b[1;31m\\x1b]0;hi\\x07")), "\\x1b[1;31m");
});

function stdoutOf(capture) {
  const lines = readFileSync(here(COURSE + "captures/" + capture), "utf8").split("\n");
  const a = lines.indexOf("--- stdout ---");
  const b = lines.indexOf("--- stderr ---");
  return { stdout: lines.slice(a + 1, b), stderr: lines.slice(b + 1) };
}

test("tty-hygiene preset reproduces captures/09-filter.txt", (t) => {
  if (!existsSync(here(COURSE + "captures/09-filter.txt"))) return t.skip("capture missing");
  const { stdout } = stdoutOf("09-filter.txt");
  assert.equal(stdout[stdout.length - 1], "");
  const want = bytes(stdout.slice(0, -1).join("\\n") + "\\n");
  assert.equal(show(safe(presetById("tty-hygiene").text)), show(want));
});

test("hostile-tty preset reproduces captures/25-phase-tty.txt, including serial_filtered", (t) => {
  if (!existsSync(here(COURSE + "captures/25-phase-tty.txt"))) return t.skip("capture missing");
  const { stdout, stderr } = stdoutOf("25-phase-tty.txt");
  const guestLines = stdout.slice(0, stdout.indexOf("hostile-tty: end") + 1);
  const want = bytes(guestLines.join("\\n") + "\\n"); // the capture writes BEL as \u{7}
  const r = runFilter("safe", bytes(presetById("hostile-tty").text));
  assert.equal(show(r.out), show(want));
  const filtered = Number(/serial_filtered=(\d+)/.exec(stderr.join("\n"))[1]);
  assert.equal(r.dropped, filtered);
  assert.equal(filtered, 160);
  assert.equal(HOSTILE_TTY_ATTACKS.length, 22);
});

test("hostile-tty preset carries the guest's attack strings verbatim", (t) => {
  const src = here(COURSE + "../guests/hostile-tty/main.rs");
  if (!existsSync(src)) return t.skip("guest source missing");
  const rs = readFileSync(src, "utf8");
  const found = [...rs.matchAll(/b"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
  const ours = HOSTILE_TTY_ATTACKS.map((a) => a[1]).join("");
  assert.equal(show(bytes(found.replace(/\\"/g, '"'))), show(bytes(ours)));
});

test("macvmm's exit reset (captures/09-tty-escape.txt) passes safe unchanged", (t) => {
  if (!existsSync(here(COURSE + "captures/09-tty-escape.txt"))) return t.skip("capture missing");
  const { stdout } = stdoutOf("09-tty-escape.txt");
  const line = stdout.find((l) => l.includes("macvmm: user quit"));
  const reset = line.slice(0, line.indexOf("macvmm: user quit"));
  assert.equal(show(bytes(reset)), show(bytes(EXIT_RESET)));
  assert.equal(show(safe(EXIT_RESET)), show(bytes(EXIT_RESET)));
});

test("the shared vector file, when it exists, agrees with the model", (t) => {
  const f = here("../../../labs/vectors/ansi.json");
  if (!existsSync(f)) {
    t.skip("course/site/labs/vectors/ansi.json does not exist yet; oracle.test.mjs checks against recorded Rust outputs instead");
    return;
  }
  const doc = JSON.parse(readFileSync(f, "utf8"));
  assert.ok(Array.isArray(doc.vectors) && doc.vectors.length > 0);
  for (const v of doc.vectors) {
    const input = Buffer.from(v.input, "hex");
    for (const policy of ["safe", "strict"]) {
      if (v[policy] === undefined) continue;
      assert.equal(Buffer.from(runFilter(policy, input).out).toString("hex"), v[policy], `${v.name || v.input} ${policy}`);
    }
  }
});

// ---- segments ----

test("segments cover the input and the output exactly, in order", () => {
  for (const p of PRESETS) {
    const b = bytes(p.text);
    for (const policy of ["safe", "strict"]) {
      const r = runFilter(policy, b, { trace: true, maxSegments: 1e9 });
      let at = 0;
      let outAt = 0;
      for (const s of r.segments) {
        assert.equal(s.start, at, `${p.id} ${policy}: gap before ${s.start}`);
        assert.equal(s.outStart, outAt, `${p.id} ${policy}: output gap`);
        assert.ok(s.end >= s.start && s.outEnd >= s.outStart);
        assert.ok(s.verdict === "text" || s.rule, `${p.id} ${policy}: ${s.verdict} without a rule`);
        at = s.end;
        outAt = s.outEnd;
      }
      assert.equal(at, b.length, `${p.id} ${policy}: input not covered`);
      assert.equal(outAt, r.out.length, `${p.id} ${policy}: output not covered`);
    }
  }
});

test("segments name the rule that dropped each piece", () => {
  const r = runFilter("safe", bytes("ok\\x1b[6n\\x9b\\x1bP$qm\\x1b\\\\\\x07\\x07end"), { trace: true });
  const drops = r.segments.filter((s) => s.verdict === "drop").map((s) => s.rule);
  assert.match(drops[0], /final byte 'n'/);
  assert.match(drops[1], /raw C1 byte 0x9B \(8-bit CSI\)/);
  assert.match(drops[2], /DCS string dropped whole, up to its terminator ST/);
  assert.match(drops[3], /BEL rate limit/);
  const tmux = runFilter("safe", bytes(presetById("tmux").text), { trace: true }).segments;
  assert.deepEqual(tmux.map((s) => s.verdict), ["drop", "drop", "drop", "drop", "text"]);
  const pend = runFilter("safe", bytes("x\\x1b]0;open"), { trace: true });
  assert.equal(pend.segments.at(-1).verdict, "pending");
  assert.match(pend.pending, /OSC string is still open/);
});

// ---- the terminal's reading ----

test("the tokenizer reads what a terminal would do", () => {
  const t = (s) => tokenize(bytes(s)).tokens.map((k) => `${k.label}:${k.effect}`);
  assert.deepEqual(t("\\x1b[1;31mhi\\x1b[0m"), ["SGR:format", "text:text", "SGR:format"]);
  assert.deepEqual(t("\\x1b]0;rm -rf ~\\x07ok"), ["OSC 0:host", "text:text"]);
  assert.deepEqual(t("\\x1b[6n"), ["DSR:query"]);
  assert.deepEqual(t("\\x9b6n"), ["DSR:query"], "a terminal honouring 8-bit controls reads 0x9B as CSI");
  assert.deepEqual(t("\\xc2\\x9b6n"), ["DSR:query"]);
  assert.deepEqual(t("\\x1b[?1000h"), ["DECSET:query"]);
  assert.deepEqual(t("\\x1b[?1049h\\x1b(0\\x1bc"), ["DECSET:mode", "SCS:mode", "RIS:reset"]);
  assert.deepEqual(t("\\x1bPtmux;\\x1b\\x1b]52;c;AAAA\\x07\\x1b\\\\"), ["tmux passthrough:host"]);
  assert.deepEqual(t("\\x05\\x0e"), ["ENQ:query", "SO:mode"]);
  assert.deepEqual(t("\\x1b]2;x"), ["OSC 2:broken"]);
  const sgr = tokenize(bytes("\\x1b[1;31m")).tokens[0];
  assert.match(sgr.meaning, /bold, red foreground/);
  assert.deepEqual(sgr.parts, { intro: "ESC [", params: "1;31", inter: "", final: "m" });
  const all = tokenize(bytes(presetById("hostile-tty").text)).tokens;
  assert.ok(all.filter((k) => k.effect === "query").length >= 8);
});

test("the tokenizer follows the VT500 parser: controls inside a sequence run, DEL is ignored", () => {
  const tok = (s) => tokenize(bytes(s)).tokens;
  // A terminal does LF and then SGR 31; safe drops the partial sequence and writes "\\n1m".
  const [lf] = tok("\\x1b[3\\n1m");
  assert.equal(tok("\\x1b[3\\n1m").length, 1);
  assert.equal(lf.label, "SGR");
  assert.match(lf.meaning, /red foreground\. The LF inside it is run by the terminal at once, and then the sequence carries on\./);
  assert.deepEqual(lf.parts, { intro: "ESC [", params: "31", inter: "", final: "m" });
  assert.deepEqual(lf.executed.map((x) => [x.label, x.start, x.end]), [["LF", 3, 4]]);
  assert.match(lf.executed[0].meaning, /^Executed mid-sequence/);
  assert.equal(escapeBytes(runFilter("safe", bytes("\\x1b[3\\n1m")).out).text, "\\n1m");
  assert.ok(presetById("mid-control"), "a preset shows the contrast");
  // DEL inside a sequence is ignored, not an end.
  const [del] = tok("\\x1b[2\\x7fm");
  assert.equal(del.label, "SGR");
  assert.match(del.meaning, /dim\. The DEL inside is ignored\./);
  // Also in the escape state, before the introducer and inside an ESC ( sequence.
  assert.deepEqual(tok("\\x1b\\n[31m").map((k) => k.label), ["SGR"]);
  assert.deepEqual(tok("\\x1b(\\nB").map((k) => k.label), ["SCS"]);
  // CAN and SUB cancel; ESC starts over; a byte >= 0x80 is not a control.
  assert.deepEqual(tok("\\x1b[3\\x181m").map((k) => `${k.label}:${k.effect}`), ["CSI:broken", "CAN:control", "text:text"]);
  assert.match(tok("\\x1b[3\\x1b[0m")[0].meaning, /cut short by another ESC/);
  assert.match(tok("\\x1b\\xc3\\xa9")[0].meaning, /An escape sequence abandoned at byte 0xC3, which is not part of an escape sequence\./);
  // A parameter byte after an intermediate: read to the final byte and ignored.
  assert.deepEqual(tok("\\x1b[1$2mx").map((k) => `${k.label}:${k.effect}`), ["CSI:ignored", "text:text"]);
});

test("the filter's rule names the kind of byte that interrupted a sequence", () => {
  const rule = (s) => runFilter("safe", bytes(s), { trace: true }).segments[0].rule;
  assert.match(rule("\\x1b[3\\n1m"), /^sequence interrupted by control byte 0x0A \(LF\).*A terminal would run the control and carry on/);
  assert.match(rule("\\x1b\\xc3\\xa9"), /^sequence interrupted by byte 0xC3 \(not part of an escape sequence\)/);
});

test("CSI meanings: mouse reporting vs encoding, SGR colon form, 0 as default", () => {
  const m = (s) => tokenize(bytes(s)).tokens[0];
  assert.equal(m("\\x1b[?1006h").effect, "mode");
  assert.match(m("\\x1b[?1006h").meaning, /only changes the format of the reports another mode turns on/);
  assert.doesNotMatch(m("\\x1b[?1006h").meaning, /click/);
  assert.equal(m("\\x1b[?1000h").effect, "query");
  assert.match(m("\\x1b[?1004h").meaning, /focus/);
  assert.equal(m("\\x1b[?1004h").effect, "query");
  assert.match(m("\\x1b[38:2::1:2:3m").meaning, /: foreground RGB colour\.$/);
  assert.match(m("\\x1b[38;2;1;2;3;3m").meaning, /foreground RGB colour, italic/);
  assert.match(m("\\x1b[38:5:196;1m").meaning, /foreground colour 196 of 256, bold/);
  assert.match(m("\\x1b[0;0r").meaning, /rows 1 to the bottom/);
  assert.match(m("\\x1b[0A").meaning, /Cursor up 1\./);
  assert.match(m("\\x1b[0;0H").meaning, /row 1, column 1/);
  assert.match(m("\\x1b[5;20r").meaning, /rows 5 to 20/);
});

test("the tokenizer covers every byte once and caps its output", () => {
  for (const p of PRESETS) {
    const b = bytes(p.text);
    const { tokens, omitted } = tokenize(b, { maxTokens: 1e9 });
    assert.equal(omitted, 0);
    let at = 0;
    for (const k of tokens) {
      assert.equal(k.start, at, `${p.id}: token gap at ${at}`);
      assert.ok(k.end > k.start, `${p.id}: empty token`);
      at = k.end;
    }
    assert.equal(at, b.length);
  }
  const many = tokenize(bytes("\\x07".repeat(1000)), { maxTokens: 10 });
  assert.equal(many.tokens.length, 10);
  assert.equal(many.omitted, 990);
});

// ---- input notation ----

test("parseInput: escapes, octal, \\u{}, repetition, errors", () => {
  assert.deepEqual([...bytes("a\\e\\033\\x1B\\n\\r\\t\\a\\b\\\\\\0")], [0x61, 0x1b, 0x1b, 0x1b, 10, 13, 9, 7, 8, 0x5c, 0]);
  assert.deepEqual([...bytes("\\u{9b}é")], [0xc2, 0x9b, 0xc3, 0xa9]);
  assert.equal(bytes("\\x41{100000}").length, 100000);
  assert.equal(parseInput("\\x4").ok, false);
  assert.equal(parseInput("\\q").ok, false);
  assert.equal(parseInput("abc\\").ok, false);
  assert.equal(parseInput("\\u{d800}").ok, false);
  assert.equal(parseInput("\\400").ok, false);
  assert.equal(parseInput(`\\x41{${MAX_INPUT + 1}}`).ok, false);
  assert.equal(parseInput("\\x41{999999999}").ok, false);
  assert.equal(parseInput("abcdef", { max: 4 }).ok, false);
  assert.equal(parseInput("\\x1b").at, undefined);
  assert.equal(parseInput("ab\\zcd").at, 2);
});

test("escapeBytes is the inverse of parseInput", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(bytes(escapeBytes(all).text), all);
  for (const s of ["\\x1b{3}", "\\x00{", "a\\\\x41", "héllo ✓ 𝄞\\xc3", "\\xc2\\x9b{2}"]) {
    const b = bytes(s);
    assert.deepEqual(bytes(escapeBytes(b).text), b, s);
    assert.deepEqual(bytes(escapeCompact(b).text), b, s);
  }
  const big = bytes("\\x1b]52;c;\\x41{5000}\\x07after");
  assert.equal(escapeCompact(big).text, "\\x1b]52;c;\\x41{5000}\\x07after");
  assert.deepEqual(bytes(escapeCompact(big).text), big);
  const capped = escapeBytes(big, 0, big.length, 50);
  assert.ok(capped.truncated && capped.text.length <= 56);
  for (const p of PRESETS) {
    const b = bytes(p.text);
    assert.deepEqual(bytes(escapeCompact(b).text), b, p.id);
  }
});

// ---- presets, state, hash ----

test("presets parse, have unique ids and notes", () => {
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(/^[a-z0-9-]+$/.test(p.id) && !ids.has(p.id), p.id);
    ids.add(p.id);
    assert.ok(p.label && p.note);
    assert.ok(parseInput(p.text).ok, p.id);
  }
  for (const id of ["osc-10mb", "lone-9b", "title-query"]) assert.ok(presetById(id), id); // the primer's suggestions
});

test("share hash round-trips presets and custom input, and rejects junk", () => {
  const s = initialState();
  assert.equal(encodeHash(s), "bold-red");
  assert.equal(decodeHash("hostile-tty").text, presetById("hostile-tty").text);
  const custom = { text: "x\\x1b[6n é #&=", preset: null };
  const h = encodeHash(custom);
  assert.ok(h.startsWith("t:"));
  assert.equal(decodeHash(h).text, custom.text);
  assert.equal(encodeHash({ text: "a".repeat(5000), preset: null }), null);
  for (const junk of [null, "", "nope", "t:%E0%A4%A", "t:" + "a".repeat(9000)]) assert.equal(decodeHash(junk), null, String(junk));
});

test("analyze, prediction check and summary", () => {
  const a = analyze("\\x1b]0;rm -rf ~\\x07ok");
  assert.ok(a.ok);
  assert.deepEqual(checkPrediction("ok", a.safe.out), { ok: true, match: true });
  assert.deepEqual(checkPrediction("rm -rf ~ok", a.safe.out), { ok: true, match: false });
  assert.equal(checkPrediction("\\x", a.safe.out).ok, false);
  assert.match(summary(a), /^15 input bytes\. The safe policy keeps 2 bytes, removes 1 piece and replaces 0 with U\+FFFD\. Its dropped counter, roughly the number of bytes removed, ends at 10 \(macvmm prints it as serial_filtered\)\./);
  // Replacements are counted on their own, not lost in the removal count.
  assert.match(summary(analyze(presetById("utf8").text)), /removes 1 piece and replaces 3 with U\+FFFD/);
  assert.match(summary(analyze("\\q")), /Input error/);
});
