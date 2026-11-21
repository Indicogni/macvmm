// The input corpus that oracle.test.mjs checks the port against. The same functions generated
// the inputs fed to macvmm's real filter (crates/vmm/src/backend/ansi.rs) when the expected
// outputs in oracle.test.mjs were recorded, so the corpus must stay deterministic: change it and
// the oracle digests must be regenerated from the Rust filter. Never shipped (*.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, parseInput, CSI_FINALS, PRIVATE_MODES } from "./model.mjs";

const enc = new TextEncoder();
const b = (s) => {
  const p = parseInput(s);
  if (!p.ok) throw new Error(`${s}: ${p.error}`);
  return p.bytes;
};

/** Hand-picked and exhaustive small inputs: every byte in every state the filter has. */
export function structuredInputs() {
  const out = [];
  // Every lab preset, with the 10 MiB string shortened to 4 KiB.
  for (const p of PRESETS) out.push(b(p.text.replace("{10485760}", "{4096}")));
  // The cases of crates/vmm/tests/ansi_filter.rs and the module's own tests.
  for (const s of [
    "hi\\r\\n", "\\x1b[1;31mred\\x1b[0m", "\\x1b[c", "\\x1b]0;title\\x07x", "\\x1b[?1049h", "\\x1b[?1000h", "\\x1b[2 q",
    "\\xc3", "\\xc3x", "\\x1b[12345m", "\\x1b[123456m", "\\x1b[4h", "\\x1b[4l", "\\x1b[ q", "\\x1b[?1;25h",
    "a\\tb\\x08c\\r\\n", "a\\x00b\\x05c\\x0ed\\x0fe\\x0bf\\x0cg\\x7fh", "\\x1b[0c", "\\x1b[>c", "\\x1b[>0c", "\\x1b[=c",
    "\\x1b[6n", "\\x1b[5n", "\\x1b[?6n", "\\x1b[?15n", "\\x1b[21t", "\\x1b[8;1;1t", "\\x1b[14t", "\\x1b[22;0t",
    "\\x1b[i", "\\x1b[5i", "\\x1b[?1$p", "\\x1b[4$p", "\\x1b[!p", "\\x1b[\"p", "\\x1b[x", "\\x1b[?25;1000h", "\\x1b[3h",
    "\\x1b]2;evil\\x1b\\\\", "\\x1b]52;c;cm0gLXJmIH4=\\x07", "\\x1b]8;;https://example.com\\x07link\\x1b]8;;\\x07",
    "a\\x1b]0;t\\x07b", "\\x1bP$q\"p\\x1b\\\\", "\\x1b_Gf=24;AAAA\\x1b\\\\", "\\x1bPq#0;2;0;0;0#0~~\\x1b\\\\",
    "a\\x9b6nb\\x9d0;x\\x07c\\x90q", "a\\u{9b}6n", "\\u{85}\\u{9d}\\u{80}", "\\xc0\\xaf", "\\xe0\\x80\\xaf", "\\xed\\xa0\\x80",
    "\\xf5\\x80", "\\xf4\\x90\\x80\\x80", "\\xbf", "\\xe2\\x9cx", "\\x1bc", "\\x1bZ", "\\x1b#8", "\\x1b(A", "\\x1b%G", "\\x1bN",
    "\\x1bO", "\\x1b\\x1b[6n", "\\x1b#8hello", "\\x1b#3abc", "\\x1b*0hello", "\\x1b(%5hello", "\\x1b)%6hello",
    "\\x1b%Ghello", "\\x1b F x", "\\x1b  #8ok", "\\x1b[1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1mX", "\\x1b[123456mX",
    "\\x1b]0;x\\x18after", "\\x1b]0;x\\x1aafter", "\\x1b]0;broken\\nnext", "\\x1b[3\\n1m", "\\x07\\x07\\x07",
    "\\x05\\x0e\\x0fok", "\\x1b[1mbold\\x1b[0m \\x1b[6nquery\\x1b]0;t\\x07 \\x1b[?1049hscreen", "\\x1b[200~paste\\x1b[201~",
    "\\x1b]0;x\\x1b\\\\\\x1b[1mB\\x1b[0m", "\\x1b[1\\x1b[2mX", "\\x1b]52;c;QQ==\\x07\\x1bP+q544e\\x1b\\\\",
    "\\x1b[\\x31{64}m", "\\x1b[\\x31{63}m", "\\x1b[\\x31{65}mz", "\\x1b[?\\x32{80}hz", "\\x1b[?\\x32{63}hz",
    "\\x1b(\\x1b[1m", "\\x1b#\\x1b[1m", "\\x1b[\\x31{70}\\x1b[1m", "\\x1b[\\x31{70}\\n", "\\x1b]\\x1b\\x1b\\\\x",
    "\\x1b]x\\x1b[1mY", "\\xe2\\x1b[1m", "\\xf0\\x9d\\x84\\x9e", "\\xf0\\x9d\\x84", "\\xf0\\x9d\\x84\\x1b[1m",
    "\\x1b[?2004;25h", "\\x1b[?1049;1000l", "\\x1b[?025h", "\\x1b[?h", "\\x1b[?;25h", "\\x1b[1:2:3m", "\\x1b[;;m",
    "\\x1b[?1 q", "\\x1b[1  q", "\\x1b[1 m", "\\x1b[>1m", "\\x1b[1$m", "\\x1b[<1m", "\\x1b[=4h",
  ]) out.push(b(s));
  for (const s of ["héllo ✓ 𝄞"]) out.push(enc.encode(s));
  for (const f of CSI_FINALS) for (const p of ["", "1", "1;2", "38;5;196", "38:2:0:255:0", "12345"]) out.push(b(`\\x1b[${p}${f}`));
  for (const m of PRIVATE_MODES) for (const hl of "hl") out.push(b(`\\x1b[?${m}${hl}`));
  for (const s of ["\\x1b7", "\\x1b8", "\\x1bM", "\\x1b=", "\\x1b>", "\\x1b(B", "\\x1b(0", "\\x1b)B", "\\x1b)0"]) out.push(b(s));
  // Every byte after each introducer, followed by text, so resynchronisation shows.
  const prefixes = ["", "\\x1b", "\\x1b[", "\\x1b[1", "\\x1b[?", "\\x1b[?25", "\\x1b[2 ", "\\x1b(", "\\x1b)", "\\x1b#",
    "\\x1b]0;t", "\\x1bPx", "\\x1b]0;t\\x1b", "\\xc3", "\\xe2", "\\xe2\\x9c", "\\xf0", "\\xf0\\x9d\\x84", "\\x1b[\\x31{64}"];
  for (const pre of prefixes) {
    const head = b(pre);
    for (let x = 0; x < 256; x++) {
      const v = new Uint8Array(head.length + 3);
      v.set(head);
      v[head.length] = x;
      v[head.length + 1] = 0x61; // 'a'
      v[head.length + 2] = 0x0a; // LF
      out.push(v);
    }
  }
  return out;
}

// xorshift64* with the seed of crates/vmm/tests/ansi_filter.rs, and its random_input pieces.
const MASK = (1n << 64n) - 1n;
export class XorShift {
  constructor(seed) {
    this.s = BigInt(seed) & MASK;
  }
  next() {
    let x = this.s;
    x ^= x >> 12n;
    x ^= (x << 25n) & MASK;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
}
const PIECES = [
  "\\x1b", "[", "]", "?", ";", "1", "25", "1049", "h", "l", "m", "c", "n", "t", "q", " ", "\\x07", "\\x1b\\\\", "P", "_",
  "(", ")", "B", "0", "\\n", "\\r", "\\x9b", "\\xc2\\x9b", "\\xc3\\xa9", "\\xe2\\x9c\\x93", "\\xf0\\x9d\\x84\\x9e", "\\xff",
  "\\x80", "abc", "\\x18", "\\x00", "$p", ":", "7", "8", "M",
].map(b);

export function randomInputs(count, seed = 0x6d6163766d6d0003n) {
  const r = new XorShift(seed);
  const list = [];
  for (let k = 0; k < count; k++) {
    const n = Number(r.next() % 64n);
    const v = [];
    for (let j = 0; j < n; j++) {
      if (r.next() % 4n === 0n) v.push(Number(r.next() & 0xffn));
      else v.push(...PIECES[Number(r.next() % BigInt(PIECES.length))]);
    }
    list.push(Uint8Array.from(v));
  }
  return list;
}

test("the corpus is deterministic", () => {
  assert.equal(structuredInputs().length, structuredInputs().length);
  const a = randomInputs(50);
  const c = randomInputs(50);
  assert.deepEqual(a, c);
  assert.ok(structuredInputs().length > 4000);
});
