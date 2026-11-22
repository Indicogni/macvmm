// Tests for the pl011-poke model. Run: node --test 'course/site/**/*.test.mjs'
// The first test replays the lesson's walk and compares it, byte for byte, with the real capture
// the chapter prints (course/captures/09-poke.txt). The rest port the reference device's own
// tests (crates/vmm/tests/pl011_regs.rs), so the lab and the Rust PL011 cannot drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REG, INT, FIFO_DEPTH, HOST_CAP, ID_BYTES, WINDOW, LCR_H_FEN, MAX_PUSH,
  reset, apply, replay, formatTable, status, fr, ris, mis, depth,
  REFERENCE, encodeShare, decodeShare, validateAction, parseNumber, textToBytes, scoreLine,
  bitNames, FR_BITS, quoteBytes, describeAction,
} from "./model.mjs";

const CAPTURE = fileURLToPath(new URL("../../../../captures/09-poke.txt", import.meta.url));
const LABS_MD = fileURLToPath(new URL("../../../LABS.md", import.meta.url));

// A tiny rig in the shape of the Rust tests: w/r at 32 bits, push from the host.
function rig() {
  let s = reset();
  return {
    get s() { return s; },
    w(off, val, size = 4) { s = apply(s, { op: "w", off, val, size }).state; },
    r(off, size = 4) { const x = apply(s, { op: "r", off, size }); s = x.state; return x.read; },
    push(bytes) { for (let i = 0; i < bytes.length; i += MAX_PUSH) s = apply(s, { op: "h", bytes: bytes.slice(i, i + MAX_PUSH) }).state; },
  };
}

test("the lesson's walk reproduces captures/09-poke.txt exactly", (t) => {
  if (!existsSync(CAPTURE)) {
    t.skip(`capture missing: ${CAPTURE}`);
    return;
  }
  const lines = readFileSync(CAPTURE, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("step "));
  const end = lines.findIndex((l) => l.startsWith("sent to the terminal:"));
  assert.ok(start > 0 && end > start, "capture has the table");
  const want = lines.slice(start, end + 1).join("\n");
  assert.equal(formatTable(replay(REFERENCE)), want);
});

test("LABS.md quotes the reference share string", () => {
  const ref = encodeShare({ actions: [...REFERENCE], cursor: REFERENCE.length });
  assert.equal(ref, "w0.68_w38.10_h6f6b_w44.70_r0_r0_r0");
  if (existsSync(LABS_MD)) assert.ok(readFileSync(LABS_MD, "utf8").includes(ref), "LABS.md row names the reference");
});

test("reset state", () => {
  const r = rig();
  assert.equal(r.r(REG.FR), 0x90);
  assert.equal(r.r(REG.CR), 0x300);
  assert.equal(r.r(REG.IFLS), 0x12);
  assert.equal(r.r(REG.RIS), 0);
  assert.equal(r.r(REG.MIS), 0);
  assert.equal(r.r(REG.IMSC), 0);
  assert.equal(r.r(REG.DR), 0, "empty FIFO reads 0");
  assert.equal(r.s.line, false);
  assert.equal(status(reset()), "FR=0x90 RIS=0x00 MIS=0x00 line=low");
});

test("DR write transmits the low byte and latches TX; masked TX needs IMSC.TX", () => {
  const r = rig();
  for (const b of [0x68, 0x69]) r.w(REG.DR, (b | 0xffffff00) >>> 0); // only the low 8 bits are data
  assert.deepEqual(r.s.tx, [0x68, 0x69]);
  assert.equal(r.r(REG.RIS) & INT.TX, INT.TX);
  assert.equal(r.r(REG.FR) & 0x80, 0x80, "TXFE stays 1");
  assert.equal(r.r(REG.FR) & (0x20 | 0x08), 0, "never TXFF or BUSY");
  assert.equal(r.s.line, false);
  r.w(REG.IMSC, INT.TX);
  assert.equal(r.s.line, true);
  assert.equal(r.r(REG.MIS), INT.TX);
  r.w(REG.ICR, INT.TX);
  assert.equal(r.r(REG.RIS), 0);
  assert.equal(r.s.line, false);
  assert.deepEqual(r.s.transitions, [true, false]);
});

test("host input fills a one-byte FIFO and drives RX and RT", () => {
  const r = rig();
  r.w(REG.IMSC, INT.RX | INT.RT);
  r.push([0x6f, 0x6b]);
  assert.equal(r.r(REG.FR) & 0x10, 0, "not empty");
  assert.equal(r.r(REG.FR) & 0x40, 0x40, "full");
  assert.equal(r.r(REG.RIS) & 0x50, 0x50);
  assert.equal(r.r(REG.MIS), 0x50);
  assert.equal(r.s.host.length, 1, "the k waits in the host queue");
  assert.equal(r.r(REG.DR), 0x6f);
  assert.equal(r.r(REG.DR), 0x6b, "refilled on pop");
  assert.equal(r.r(REG.FR) & 0x10, 0x10);
  assert.equal(r.r(REG.RIS), 0);
  assert.deepEqual(r.s.transitions, [true, false]);
});

test("ICR cannot hide a non-empty FIFO", () => {
  const r = rig();
  r.w(REG.IMSC, INT.RX);
  r.push([0x7a]);
  r.w(REG.ICR, INT.ALL);
  assert.equal(r.s.line, true);
  assert.equal(r.r(REG.DR), 0x7a);
  assert.equal(r.s.line, false);
});

test("a 32-byte FIFO with FEN; the 33rd byte stays in the host queue", () => {
  const r = rig();
  r.w(REG.LCR_H, LCR_H_FEN);
  assert.equal(depth(r.s), FIFO_DEPTH);
  r.push([...Array(33).keys()]);
  assert.equal(r.s.rx.length, 32);
  assert.equal(r.s.host.length, 1);
  assert.equal(r.r(REG.FR) & 0x40, 0x40);
  for (let want = 0; want <= 32; want++) assert.equal(r.r(REG.DR), want);
  assert.equal(r.s.host.length, 0);
  assert.equal(r.r(REG.FR) & 0x10, 0x10);
});

test("turning FEN off keeps the bytes already in the FIFO", () => {
  const r = rig();
  r.w(REG.LCR_H, LCR_H_FEN);
  r.push([1, 2, 3]);
  r.w(REG.LCR_H, 0);
  assert.equal(r.s.rx.length, 3);
  assert.equal(fr(r.s), 0xc0, "TXFE | RXFF");
  assert.equal(r.r(REG.DR), 1);
});

test("the host queue is bounded at 4 KiB and drops the rest", () => {
  const r = rig();
  r.push(Array(3 * HOST_CAP).fill(0x61));
  // Rust pushes 12 KiB in one call: 4096 accepted, then one byte moves into the holding
  // register. The lab pushes at most 64 bytes at a time, and the first byte moves out after the
  // first chunk, so the queue ends full and one more byte was accepted in total.
  assert.equal(r.s.host.length, HOST_CAP);
  assert.equal(r.s.rx.length, 1);
  assert.equal(r.s.hostDropped, 3 * HOST_CAP - HOST_CAP - 1);
});

test("identification registers, 32- and 8-bit, read-only", () => {
  const r = rig();
  ID_BYTES.forEach((b, i) => {
    assert.equal(r.r(0xfe0 + 4 * i), b);
    assert.equal(r.r(0xfe0 + 4 * i, 1), b);
  });
  r.w(0xfe0, 0);
  assert.equal(r.r(0xfe0), 0x11);
});

test("narrow accesses; 64-bit and misaligned are read-as-zero, write-ignored", () => {
  const r = rig();
  r.w(REG.DR, 0x51, 1);
  assert.equal(r.r(REG.FR, 1), 0x90);
  assert.equal(r.r(REG.FR, 2), 0x90);
  r.w(REG.CR, 0x0301, 2);
  assert.equal(r.r(REG.CR), 0x301);
  assert.equal(r.r(REG.CR, 1), 0x01);
  r.w(REG.CR, 0, 8);
  assert.equal(r.r(REG.CR), 0x301);
  assert.equal(r.r(REG.FR, 8), 0);
  assert.equal(r.r(REG.FR + 1, 1), 0);
  r.w(REG.DR + 2, 0x58, 1);
  assert.deepEqual(r.s.tx, [0x51], "misaligned DR write ignored");
  assert.ok(r.s.warnings >= 3);
});

test("every offset and width is total, and the device still works", () => {
  const r = rig();
  r.push(Array(64).fill(0x55));
  for (const size of [1, 2, 4, 8]) {
    for (let off = 0; off + size <= WINDOW; off++) {
      const v = r.r(off, size);
      assert.ok(Number.isInteger(v) && v >= 0 && (size >= 4 || v < 2 ** (8 * size)));
      if (off !== REG.DR) r.w(off, 0xffffffff, size);
    }
  }
  r.w(REG.ICR, 0xffffffff);
  r.w(REG.DR, 0x6b);
  assert.equal(r.s.tx[r.s.tx.length - 1], 0x6b);
});

test("apply is pure: the old state is untouched", () => {
  const s0 = reset();
  const snap = JSON.stringify(s0);
  apply(s0, { op: "h", bytes: [1, 2] });
  apply(s0, { op: "w", off: REG.DR, size: 4, val: 0x41 });
  assert.equal(JSON.stringify(s0), snap);
});

test("explanations name the side effects", () => {
  const rows = replay(REFERENCE);
  assert.match(rows[1].effect, /TX latches/);
  assert.match(rows[3].effect, /went high/);
  assert.match(rows[4].effect, /RX and RT stay set/);
  assert.match(rows[5].effect, /refilled/);
  assert.match(rows[6].effect, /went low/);
  assert.match(rows[6].effect, /now empty/);
  assert.match(rows[7].effect, /RXFE before/);
  assert.equal(mis(rows[3].state), 0x10);
  assert.equal(ris(rows[3].state), 0x70);
});

test("share state round-trips and rejects hostile strings", () => {
  for (const cursor of [0, 3, 7]) {
    const str = encodeShare({ actions: [...REFERENCE], cursor });
    const back = decodeShare(str);
    assert.equal(back.cursor, cursor);
    assert.equal(encodeShare(back), str);
  }
  assert.equal(encodeShare({ actions: [...REFERENCE], cursor: 0 }), "w0.68_w38.10_h6f6b_w44.70_r0_r0_r0~0");
  assert.deepEqual(decodeShare(""), { actions: [], cursor: 0 });
  assert.deepEqual(decodeShare("r18.1"), { actions: [{ op: "r", off: 0x18, size: 1 }], cursor: 1 });
  const bad = [
    null, 42, "x", "w0", "w0.123456789", "r1000", "rffc.8", "wfff.1.2", "h", "h6", "hzz",
    "h" + "00".repeat(65), "r0~2", "r0~-1", "r0_", "_r0", "R0", "r0.3", "w0.68~", "<b>",
    Array(257).fill("r0").join("_"), "r0".padEnd(5000, "_"),
  ];
  for (const b of bad) assert.equal(decodeShare(b), null, String(b).slice(0, 40));
});

test("validateAction bounds every field", () => {
  assert.equal(validateAction({ op: "r", off: 0, size: 4 }), null);
  assert.ok(validateAction({ op: "r", off: 0xffe, size: 4 }));
  assert.ok(validateAction({ op: "r", off: -4, size: 4 }));
  assert.ok(validateAction({ op: "w", off: 0, size: 3, val: 0 }));
  assert.ok(validateAction({ op: "w", off: 0, size: 4, val: 2 ** 32 }));
  assert.ok(validateAction({ op: "h", bytes: [256] }));
  assert.ok(validateAction({ op: "h", bytes: [] }));
  assert.ok(validateAction({ op: "x" }));
  assert.throws(() => apply(reset(), { op: "r", off: 0x1000, size: 4 }));
});

test("reader input parsing", () => {
  assert.equal(parseNumber("0x10"), 0x10);
  assert.equal(parseNumber(" 0X7FF "), 0x7ff);
  assert.equal(parseNumber("16"), 16);
  assert.equal(parseNumber("0xfe0", 0xfff), 0xfe0);
  assert.equal(parseNumber("0x1000", 0xfff), null);
  assert.equal(parseNumber("0x123456789"), null);
  assert.equal(parseNumber("abc"), null);
  assert.equal(parseNumber(""), null);
  assert.deepEqual(textToBytes("ok"), { bytes: [0x6f, 0x6b] });
  assert.deepEqual(textToBytes("é"), { bytes: [0xc3, 0xa9] });
  assert.ok(textToBytes("").error);
  assert.ok(textToBytes("a".repeat(65)).error);
  assert.equal(quoteBytes([0x6f, 0x0d, 0x1b, 0x22]), "\"o\\r\\x1b\\\"\"");
  assert.equal(bitNames(0x90, FR_BITS), "RXFE TXFE");
  assert.equal(scoreLine(null, true), null);
  assert.deepEqual(scoreLine("high", true), { right: true, guess: "high", actual: "high" });
  assert.equal(scoreLine("low", true).right, false);
});

test("labels: a wide DR write names the byte it sends, RAZ/WI accesses name no register", () => {
  const s = reset();
  assert.equal(apply(s, { op: "w", off: REG.DR, size: 2, val: 0x1234 }).label, "write DR = 0x1234 (sends '4', 0x34) (16-bit)");
  assert.equal(apply(s, { op: "w", off: REG.DR, size: 4, val: 0x180 }).label, "write DR = 0x180 (sends 0x80)");
  assert.equal(apply(s, { op: "r", off: 0xff0, size: 8 }).label, "read 0xff0 (64-bit, no register)");
  assert.equal(apply(s, { op: "r", off: REG.DR, size: 8 }).label, "read 0x000 (64-bit, no register)");
  assert.equal(apply(s, { op: "r", off: 0x050, size: 4 }).label, "read 0x050 (no register)");
  assert.equal(apply(s, { op: "w", off: 0x002, size: 1, val: 1 }).label, "write 0x002 = 0x01 (8-bit, no register)");
  assert.equal(describeAction({ op: "r", off: 0xff0, size: 8 }), "read 0xff0 (64-bit, no register)");
  assert.equal(describeAction({ op: "w", off: REG.IMSC, size: 4, val: 0x10 }), "write IMSC = 0x10 (RX)");
});

test("IMSC keeps all 11 bits and says which of them can never fire", () => {
  const r = apply(reset(), { op: "w", off: REG.IMSC, size: 4, val: 0xffffffff });
  assert.equal(r.state.imsc, 0x7ff);
  assert.equal(r.label, "write IMSC = 0xffffffff (RX TX RT RI CTS DCD DSR FE PE BE OE)");
  assert.match(r.effect, /IMSC now holds 0x7ff/);
  assert.match(r.effect, /never fire/);
  const o = apply(reset(), { op: "w", off: REG.IMSC, size: 4, val: 0x400 });
  assert.equal(o.label, "write IMSC = 0x400 (OE)");
  assert.match(o.effect, /OE, never fire\), so the mask lets through nothing/);
});
