// Model tests for virtqueue-visualizer. Run with `node --test 'course/site/**/*.test.mjs'`.
//
// The model is a port of crates/vmm/src/virtio/{queue,chain}.rs, so it is checked against:
//   - every case in course/site/labs/vectors/virtqueue.json (exported from the reference's
//     crates/vmm/tests/virtqueue_hostile.rs), verdict for verdict;
//   - ports of reference tests (index wrap, release ordering, exact used.len, the TOCTOU tests);
//   - the chapter 16 captures (self-loop with and without the budget, the re-read len breakage);
//   - the numbers chapters 15 and 16 quote for this lab (the opening puzzle's fallback sketch,
//     8,193 hops, slots 6 7 0 1, about 3 exits for the toy);
// plus the share-string grammar against hostile input.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { slugify } from "../../../lib/html.mjs";
import * as M from "./model.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here("../../../../../");
const read = (p) => readFileSync(ROOT + p, "utf8");

const { desc, F_NEXT, F_WRITE, F_INDIRECT, Memory, Queue, VqError, RAM_BASE, RING_RAM_SIZE } = M;
const BUF = RAM_BASE + 0x8000n;
const DESC = RAM_BASE + 0x1000n;
const AVAIL = RAM_BASE + 0x4000n;
const USED = RAM_BASE + 0x5000n;
const TABLE = RAM_BASE + 0x2_0000n;
const MMIO = 0x0900_0000n;
const K64 = 0x1_0000n;

// ---- a small driver, as crates/vmm/tests/virtio_support/mod.rs's Ring ----
function ring(size, { start = 0 } = {}) {
  const mem = new Memory([{ base: RAM_BASE, size: RING_RAM_SIZE }]);
  let availIdx = start;
  const r = {
    mem,
    setDesc: (i, d) => mem.poke(DESC + 16n * BigInt(i), M.encodeDesc(d)),
    setDescAt: (t, i, d) => mem.poke(t + 16n * BigInt(i), M.encodeDesc(d)),
    push(head) {
      mem.poke(AVAIL + 4n + 2n * BigInt(availIdx % size), M.le16(head));
      availIdx = (availIdx + 1) & 0xffff;
      mem.poke(AVAIL + 2n, M.le16(availIdx));
    },
    get availIdx() { return availIdx; },
    queue({ indirect = false } = {}) {
      const q = new Queue(size);
      q.size = size;
      q.desc = DESC;
      q.avail = AVAIL;
      q.used = USED;
      q.ready = true;
      q.indirect = indirect;
      q.setPositions(start, start);
      return q;
    },
    usedIdx: () => { const b = mem.peek(USED + 2n, 2); return b[0] | (b[1] << 8); },
    usedElem(i) {
      const b = mem.peek(USED + 4n + 8n * BigInt(i), 8);
      return [(b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0, (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0];
    },
  };
  if (start) mem.poke(AVAIL + 2n, M.le16(start));
  return r;
}
function popValidated(q, mem, max, opts) {
  const c = q.pop(mem, opts);
  return c ? c.intoValidated(max) : null;
}
const errOf = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof VqError) return M.debugOf(e);
    if (e instanceof M.Hang) return "hang";
    throw e;
  }
  return null;
};
const readsOf = (log, addr, len) => log.filter((a) => a.op === "read" && a.addr === addr && a.len === len).length;

function capture(name) {
  return read(`course/captures/${name}`);
}

// ---- the vectors ----

test("every vector in labs/vectors/virtqueue.json gets the reference's verdict", () => {
  const path = ROOT + "course/site/labs/vectors/virtqueue.json";
  if (!existsSync(path)) {
    test.skip("labs/vectors/virtqueue.json does not exist yet");
    return;
  }
  const { vectors } = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(vectors.length >= 51, `expected the full corpus, got ${vectors.length}`);
  const kinds = new Set();
  for (const v of vectors) {
    const got = M.runVector(v);
    assert.deepEqual(got, v.outcome, `${v.name}: ${v.about}`);
    kinds.add(got.error ? got.error.split(" ")[0] : got.empty ? "empty" : "ok");
  }
  // The corpus reaches every refusal the lab can show.
  for (const k of ["ChainTooLong", "NextOutOfRange", "HeadOutOfRange", "Overflow", "BufferOutOfRam", "ZeroLength",
    "ReadableAfterWritable", "TooLarge", "AvailIdxJump", "IndirectNotNegotiated", "NestedIndirect", "IndirectWithNext",
    "BadIndirectLen", "Unaligned", "RingOutOfRam", "empty", "ok"]) assert.ok(kinds.has(k), k);
});

// ---- ports of reference tests ----

test("avail_and_used_idx_wrap_at_65535 (virtqueue_hostile.rs)", () => {
  const r = ring(4, { start: 65533 });
  for (let i = 0; i < 4; i++) r.setDesc(i, desc(BUF + 64n * BigInt(i), 16, F_WRITE, 0));
  const q = r.queue();
  for (let i = 0; i < 4; i++) r.push(i);
  assert.equal(r.availIdx, 1, "avail.idx wrapped");
  const heads = [];
  for (;;) {
    const v = popValidated(q, r.mem, K64);
    if (!v) break;
    heads.push(v.head);
    q.addUsed(r.mem, v.head, 16);
  }
  assert.deepEqual(heads, [0, 1, 2, 3]);
  assert.equal(q.nextAvail, 1);
  assert.equal(r.usedIdx(), 1, "used.idx wrapped: 65533 + 4");
  assert.equal(r.usedElem(1)[0], 0);
  assert.equal(r.usedElem(0)[0], 3);
});

test("add_used writes the exact len (write_writable returns bytes produced)", () => {
  const r = ring(8);
  r.setDesc(3, desc(BUF, 100, F_WRITE | F_NEXT, 4));
  r.setDesc(4, desc(BUF + 0x200n, 100, F_WRITE, 0));
  r.push(3);
  const q = r.queue();
  const v = popValidated(q, r.mem, K64);
  assert.equal(v.writableLen, 200n);
  const written = M.writeWritable(r.mem, v, 150, () => 0x5a);
  assert.equal(written, 150);
  q.addUsed(r.mem, v.head, written);
  assert.deepEqual(r.usedElem(0), [3, 150]);
});

test("used_idx_release_order: element, then release store of used.idx; fence before avail.flags", () => {
  const r = ring(8);
  r.setDesc(0, desc(BUF, 16, F_WRITE, 0));
  r.push(0);
  const q = r.queue();
  const v = popValidated(q, r.mem, K64);
  r.mem.log = [];
  q.addUsed(r.mem, v.head, 16);
  q.shouldInterrupt(r.mem);
  const log = r.mem.log;
  const elem = log.findIndex((a) => a.op === "write" && a.addr === USED + 4n && a.len === 8 && !a.ordered);
  const idx = log.findIndex((a) => a.op === "write" && a.addr === USED + 2n && a.len === 2 && a.ordered);
  const fence = log.findIndex((a) => a.op === "fence");
  const flags = log.findIndex((a) => a.op === "read" && a.addr === AVAIL && a.len === 2);
  assert.ok(elem >= 0 && idx > elem, "release store of used.idx after the element");
  assert.ok(fence > idx && flags > fence, "SeqCst fence between used.idx and avail.flags");
});

test("pop starts with an acquire load of avail.idx, and each descriptor is copied exactly once", () => {
  const r = ring(8);
  r.setDesc(0, desc(BUF, 16, F_NEXT, 1));
  r.setDesc(1, desc(BUF + 0x100n, 512, F_WRITE | F_NEXT, 2));
  r.setDesc(2, desc(BUF + 0x400n, 1, F_WRITE, 0));
  r.push(0);
  const q = r.queue();
  popValidated(q, r.mem, K64);
  const log = r.mem.log;
  assert.deepEqual([log[0].op, log[0].addr, log[0].ordered], ["read", AVAIL + 2n, true]);
  for (let i = 0; i < 3; i++) assert.equal(readsOf(log, DESC + 16n * BigInt(i), 16), 1, `descriptor ${i}`);
});

test("descriptor_rewritten_after_its_first_read (virtqueue_toctou.rs), and breakage 3", () => {
  const build = () => {
    const r = ring(8);
    r.setDesc(0, desc(BUF, 16, F_NEXT, 1));
    r.setDesc(1, desc(BUF + 0x100n, 64, F_WRITE, 0));
    r.push(0);
    r.mem.hook = { afterReads: 2 + 1, addr: DESC, bytes: M.encodeDesc(desc(MMIO, 0xffff_ffff, F_NEXT | F_WRITE, 0)) };
    return r;
  };
  let r = build();
  const v = popValidated(r.queue(), r.mem, K64);
  assert.deepEqual(v.readable, [desc(BUF, 16, F_NEXT, 1)], "the first copy is used");
  assert.equal(v.writableLen, 64n);
  assert.equal(readsOf(r.mem.log, DESC, 16), 1);
  assert.equal(readsOf(r.mem.log, DESC + 16n, 16), 1);
  // Deliberate breakage 3: len re-read after validation.
  r = build();
  const got = errOf(() => popValidated(r.queue(), r.mem, K64, { reread: true }));
  assert.equal(got, "TooLarge { total: 4294967295, max: 65536 }");
  const cap = capture("16-reread-len.txt");
  assert.ok(cap.includes("panicked at crates/vmm/tests/virtqueue_toctou.rs:62:46:\ncalled `Result::unwrap()` on an `Err` value: TooLarge { total: 4294967295, max: 65536 }"), "16-reread-len.txt quotes this error");
});

test("next_rewritten and indirect_table_rewritten (virtqueue_toctou.rs), with and without breakage 3", () => {
  const nextRewritten = (opts) => {
    const r = ring(8);
    r.setDesc(0, desc(BUF, 16, F_NEXT, 1));
    r.setDesc(1, desc(BUF, 16, 0, 0));
    r.push(0);
    r.mem.hook = { afterReads: 2 + 2, addr: DESC + 16n, bytes: M.encodeDesc(desc(BUF, 16, F_NEXT, 0)) };
    return popValidated(r.queue(), r.mem, K64, opts);
  };
  assert.equal(nextRewritten().readable.length, 2);
  assert.equal(errOf(() => nextRewritten({ reread: true })), "ChainTooLong { budget: 8 }");
  const indirectRewritten = (opts) => {
    const r = ring(8);
    r.setDesc(0, desc(TABLE, 32, F_INDIRECT, 0));
    r.setDescAt(TABLE, 0, desc(BUF, 16, F_NEXT, 1));
    r.setDescAt(TABLE, 1, desc(BUF + 0x40n, 32, F_WRITE, 0));
    r.push(0);
    r.mem.hook = { afterReads: 2 + 2, addr: TABLE, bytes: M.encodeDesc(desc(MMIO, 0xffff_ffff, F_INDIRECT, 0)) };
    const v = popValidated(r.queue({ indirect: true }), r.mem, K64, opts);
    return [v, r.mem.log];
  };
  const [v, log] = indirectRewritten();
  assert.deepEqual([v.readableLen, v.writableLen], [16n, 32n]);
  assert.equal(readsOf(log, DESC, 16), 1);
  assert.equal(readsOf(log, TABLE, 16), 1);
  assert.equal(readsOf(log, TABLE + 16n, 16), 1);
  assert.equal(errOf(() => indirectRewritten({ reread: true })), "TooLarge { total: 4294967295, max: 65536 }");
  // The capture of breakage 3 lists exactly these failures and errors.
  const cap = capture("16-reread-len.txt");
  assert.match(cap, /next_rewritten_into_a_loop_after_the_read_changes_nothing stdout ----\n\n[^\n]*\ncalled `Result::unwrap\(\)` on an `Err` value: ChainTooLong \{ budget: 8 \}/);
  assert.match(cap, /indirect_table_rewritten_after_the_first_read stdout ----\n\n[^\n]*\ncalled `Result::unwrap\(\)` on an `Err` value: TooLarge \{ total: 4294967295, max: 65536 \}/);
});

// ---- the chapter 16 captures ----

function selfLoop() {
  const r = ring(8);
  r.setDesc(0, desc(BUF, 8, F_NEXT, 0));
  r.push(0);
  return r;
}

test("16-self-loop-budget.txt: the bare iterator is refused after 8 descriptors", () => {
  const r = selfLoop();
  const chain = r.queue().pop(r.mem);
  let count = 0;
  let line = null;
  for (;;) {
    try {
      if (chain.nextDesc() === null) break;
      count += 1;
    } catch (e) {
      line = `walk_a_self_loop: refused after ${count} descriptors: ${M.displayOf(e)}`;
      break;
    }
  }
  assert.equal(line, "walk_a_self_loop: refused after 8 descriptors: virtqueue: ChainTooLong { budget: 8 }");
  assert.ok(capture("16-self-loop-budget.txt").split("\n").includes(line));
  assert.equal(chain.nextDesc(), null, "after the first error the iterator yields nothing more");
});

test("16-self-loop-no-budget.txt: without the budget the bare iterator never ends", () => {
  const r = selfLoop();
  const chain = r.queue().pop(r.mem, { budget: false, hopLimit: 50_000 });
  const got = errOf(() => { for (;;) if (chain.nextDesc() === null) break; });
  assert.equal(got, "hang");
  assert.match(capture("16-self-loop-no-budget.txt"), /exit: none \(stopped by --timeout 5 s: still running\)/);
});

test("16-self-loop-cap.txt: without the budget, the 64 KiB cap stops the walk at hop 8,193", () => {
  const withBudget = errOf(() => { const r = selfLoop(); popValidated(r.queue(), r.mem, K64); });
  const r = selfLoop();
  const chain = r.queue().pop(r.mem, { budget: false });
  const without = errOf(() => chain.intoValidated(K64));
  assert.equal(chain.hops, 8193);
  const cap = capture("16-self-loop-cap.txt");
  assert.ok(cap.includes(`  left: Err(${without})`), without);
  assert.ok(cap.includes(`\n right: Err(${withBudget})`), withBudget);
  // The lesson's arithmetic: 8,193 hops of 8 bytes, about 900 times the 9 hops of the budget.
  const lesson = read("course/chapters/VII/16-virtqueues.md");
  assert.ok(lesson.includes("`TooLarge` with a total of 65544 bytes, which is 8,193 hops of 8 bytes"));
  assert.equal(8193 * 8, 65544);
});

// ---- the lab, through its actions ----

const run = (str, ...extra) => {
  const s = M.decode(str);
  assert.ok(s, `decodes: ${str}`);
  return M.simulate({ cfg: s.cfg, actions: [...s.actions, ...extra] });
};

test("chapter 16's paper fallback is the lab's opening-puzzle state", () => {
  const lesson = read("course/chapters/VII/16-virtqueues.md");
  const i = lesson.indexOf("If the lab does not load, here is a sketch");
  assert.ok(i > 0);
  const block = lesson.slice(lesson.indexOf("```text", i), lesson.indexOf("```\n", lesson.indexOf("```text", i) + 7));
  const before = run(M.PRESETS.find((p) => p.id === "puzzle").state);
  const d0 = before.descs[0];
  const m = /DESC\s+\[0: addr=0x([0-9a-f]+) len=(\d+) flags=(\w+) next=(\d+)\] \[1\.\.7: unused\]\s+N = (\d+)/.exec(block);
  assert.ok(m, block);
  assert.equal(BigInt(`0x${m[1]}`), d0.addr);
  assert.equal(Number(m[2]), d0.len);
  assert.equal(m[3], M.flagNames(d0.flags));
  assert.equal(Number(m[4]), d0.next);
  assert.equal(Number(m[5]), before.n);
  assert.ok(before.descs.slice(1).every((d) => d.addr === 0n && d.len === 0 && d.free), "1..7 unused");
  const a = /AVAIL idx=(\d+)\s+ring=\[(\d+)\]\s+device next_avail=(\d+)\s+->\s+(\d+) pending, head (\d+)/.exec(block);
  assert.ok(a, block);
  assert.deepEqual(a.slice(1).map(Number), [before.avail.idx, before.avail.ring[0], before.device.nextAvail, before.device.pending, before.avail.ring[0]]);
  const after = run(M.PRESETS.find((p) => p.id === "puzzle").state, "p");
  const texts = after.last.checks.map((c) => c.text);
  for (const [hop, from, to] of [...block.matchAll(/hop (\d+): desc 0 \(budget (\d+) -> (\d+)\)/g)].map((x) => x.slice(1).map(Number))) {
    assert.ok(texts.includes(`hop ${hop}: descriptor 0 (budget ${from} → ${to})`), `hop ${hop}`);
  }
  const last = /hop (\d+): budget exhausted\s+->\s+(ChainTooLong \{ budget: \d+ \})\s+->\s+DEVICE_NEEDS_RESET/.exec(block);
  assert.ok(last, block);
  assert.ok(texts.some((t) => t.startsWith(`hop ${last[1]}: budget exhausted`)));
  assert.equal(after.last.debug, last[2]);
  assert.equal(after.device.status, "reset", "DEVICE_NEEDS_RESET");
  assert.ok(after.device.intStatus & M.INT_CONFIG, "configuration interrupt");
});

test("the wrap preset: next_avail 0xFFFE plus 4 requests, slots 6 7 0 1, pending 4 (chapter 16)", () => {
  const lesson = read("course/chapters/VII/16-virtqueues.md");
  assert.ok(lesson.includes("say `next_avail` is `0xFFFE` and the driver adds 4: `avail.idx` is now `0x0002`, and `0x0002 - 0xFFFE` in `u16` is 4"));
  assert.ok(lesson.includes("the slots are `0xFFFE % 8 = 6`, then 7, 0 and 1"));
  const snap = run(M.PRESETS.find((p) => p.id === "wrap").state);
  assert.equal(snap.device.nextAvail, 0xfffe);
  assert.equal(snap.avail.idx, 0x0002);
  assert.equal(snap.device.pending, 4);
  const slots = snap.history.filter((h) => h.token.startsWith("q")).map((h) => Number(/avail\.ring\[(\d+)\]/.exec(h.text)[1]));
  assert.deepEqual(slots, [6, 7, 0, 1]);
  // Serve and reclaim all four: everything comes back, counters wrapped.
  const done = run(M.PRESETS.find((p) => p.id === "wrap").state, "p", "p", "p", "p", "p", "u");
  assert.equal(done.device.nextAvail, 2);
  assert.equal(done.used.idx, 2);
  assert.equal(done.driver.lastUsed, 2);
  assert.equal(done.driver.free.length, 8);
  assert.equal(done.device.notified, false, "the fifth process found the ring empty");
});

test("every preset decodes in full and gives the outcome its title promises", () => {
  const want = {
    read: "ok", puzzle: "ChainTooLong { budget: 8 }", nobudget: "TooLarge { total: 65544, max: 65536 }", hang: "hang",
    wrap: "ok", jump: "AvailIdxJump { avail_idx: 9, next_avail: 0, size: 8 }", mmio: "BufferOutOfRam { addr: 150994944, len: 4 }",
    flip: "ok", reread: "TooLarge { total: 4294967295, max: 65536 }", indirect: "ok",
  };
  for (const p of M.PRESETS) {
    const s = M.decode(p.state);
    assert.equal(M.encode(s), p.state, `${p.id} round-trips`);
    assert.equal(s.actions.length, p.state.split(":")[1].split("_").length, `${p.id}: every action allowed`);
    const snap = run(p.state, "p");
    const got = snap.last.outcome === "error" ? snap.last.debug : snap.last.outcome;
    assert.equal(got, want[p.id], p.id);
  }
  // The vectors agree with the presets that share a case.
  const { vectors } = JSON.parse(read("course/site/labs/vectors/virtqueue.json"));
  const v = (n) => vectors.find((x) => x.name === n).outcome.error;
  assert.equal(want.puzzle, v("self_loop"));
  assert.equal(want.jump, v("avail_idx_jump_n_plus_1"));
  assert.equal(want.mmio, v("addr_in_mmio"));
});

test("avail.idx moving backwards is refused like the avail_idx_backwards vector", () => {
  const { vectors } = JSON.parse(read("course/site/labs/vectors/virtqueue.json"));
  const vec = vectors.find((x) => x.name === "avail_idx_backwards");
  // The vector: next_avail 5, avail.idx 4. The lab: counters from 5 (one request served), then back.
  const snap = run("ring-n8-s5-c10000:hback_n", "p");
  assert.equal(snap.last.debug, vec.outcome.error);
  // From the 0xFFFE start the same misbehaviour crosses 0 the other way.
  assert.equal(run("ring-n8-s0-c10000:hback_n", "p").last.debug, "AvailIdxJump { avail_idx: 65535, next_avail: 0, size: 8 }");
});

test("hostile requests meet the same rule as the matching vector", () => {
  const { vectors } = JSON.parse(read("course/site/labs/vectors/virtqueue.json"));
  const v = (n) => vectors.find((x) => x.name === n).outcome.error;
  const lab = (h, flags = "") => run(`ring-n8-s0-c10000${flags}:h${h}_n`, "p").last.debug;
  assert.equal(lab("cycle"), v("two_cycle"));
  assert.equal(lab("next"), v("next_ge_n"));
  assert.equal(lab("end"), v("buffer_straddles_ram_end"));
  assert.equal(lab("wrap"), v("len_u32_max_overflow"));
  assert.equal(lab("zero"), v("zero_length"));
  assert.equal(lab("order"), v("writable_before_readable"));
  assert.equal(lab("cap"), v("one_descriptor_over_cap"));
  assert.equal(lab("head"), v("head_ge_n"));
  assert.equal(lab("ind"), v("indirect_not_negotiated"));
  assert.equal(lab("indnext", "-i"), v("indirect_with_next"));
  assert.equal(lab("nest", "-i"), v("nested_indirect"));
  assert.equal(lab("indlen", "-i"), v("indirect_len_not_multiple_of_16"));
  assert.equal(lab("huge"), "BufferOutOfRam { addr: 1073774592, len: 4294967295 }");
  // With no cap, the 512 KiB buffer is served and used.len is exact.
  const big = run("ring-n8-s0-cnone:hcap_n", "p");
  assert.equal(big.last.outcome, "ok");
  assert.equal(big.used.ring[0].len, 0x8_0000);
});

test("a normal disk read: one doorbell, the exact used.len, an interrupt, reclaim frees all three", () => {
  let snap = run("ring-n8-s0-c10000:qr10.w200.w1");
  assert.equal(snap.exits.total, 0, "publishing a request is ordinary memory");
  assert.equal(snap.device.pending, 1);
  assert.deepEqual(snap.descs.slice(0, 3).map((d) => [d.flags, d.next]), [[F_NEXT, 1], [F_NEXT | F_WRITE, 2], [F_WRITE, 0]]);
  snap = run("ring-n8-s0-c10000:qr10.w200.w1_n_p");
  assert.equal(snap.exits.total, 1);
  assert.deepEqual(snap.used.ring[0], { id: 0, len: 513 });
  assert.equal(snap.used.idx, 1);
  assert.equal(snap.device.line, true);
  snap = run("ring-n8-s0-c10000:qr10.w200.w1_n_p_u");
  assert.equal(snap.exits.total, 3, "doorbell + InterruptStatus + InterruptACK");
  assert.equal(snap.device.line, false);
  assert.equal(snap.driver.free.length, 8);
  assert.equal(snap.driver.unreclaimed, 0);
});

test("NO_INTERRUPT suppresses the interrupt; reset after an error restores a working ring", () => {
  let snap = run("ring-n8-s0-c10000:f_qw40_n_p");
  assert.equal(snap.device.line, false);
  assert.equal(snap.used.idx, 1);
  snap = run("ring-n8-s0-c10000:hloop_n_p");
  assert.equal(snap.device.status, "reset");
  assert.equal(M.canDo(M.decode("ring-n8-s0-c10000:hloop_n_p"), "p"), "The device needs a reset: it does no work until the driver writes 0 to Status.");
  snap = run("ring-n8-s0-c10000:hloop_n_p_n");
  assert.match(snap.last.text, /ignored/);
  snap = run("ring-n8-s0-c10000:hloop_n_p_u_z_qw40_n_p");
  assert.equal(snap.device.status, "ok");
  assert.equal(snap.last.outcome, "ok");
  assert.equal(snap.exits.reset, 1);
});

test("the hop budget toggle replays the same ring under the other rule", () => {
  const s = M.decode("ring-n8-s0-c10000:hloop_n_p");
  const off = M.step(s, { type: "config", cfg: { budget: false } });
  assert.deepEqual(off.actions, s.actions, "walker options keep the actions");
  assert.equal(M.simulate(off).last.debug, "TooLarge { total: 65544, max: 65536 }");
  const geometry = M.step(s, { type: "config", cfg: { n: 4 } });
  assert.deepEqual(geometry.actions, [], "a new queue size starts a fresh ring");
  const hang = M.simulate(M.step(off, { type: "config", cap: "none", cfg: { cap: "none" } }));
  assert.equal(hang.last.outcome, "hang");
  assert.equal(hang.device.status, "hung");
  assert.ok(hang.last.checks.length < 200, "a long walk keeps a short trace");
  assert.ok(hang.last.checks.some((c) => c.gap), "with a gap marker");
});

test("refusals: no free descriptors, ring full, no doorbell, nothing to reclaim", () => {
  const s = M.decode("ring-n2-s0-c10000");
  assert.match(M.canDo(s, "qr10.w200.w1"), /needs 3/);
  assert.match(M.canDo(s, "p"), /No doorbell yet/);
  assert.match(M.canDo(s, "u"), /Nothing to reclaim/);
  const full = M.decode("ring-n2-s0-c10000:qw40_qw40");
  assert.match(M.canDo(full, "hhead"), /All 2 ring slots/);
  assert.equal(M.step(full, { type: "do", token: "qw40" }), full, "a refused action leaves the state as it was");
});

// ---- the toy (chapter 15) ----

test("the toy: eight steps, one doorbell exit, three exits in all, sector 8 holds the data", () => {
  const ch15 = read("course/chapters/VII/15-virtio-mmio.md");
  for (const q of ["\"4096 bytes at address `0x4410_0000`, write them to sector 8\"", "Try its ten-minute toy: one descriptor, one doorbell, one \"done\".",
    "a lone 4 KiB block costs about 3 exits (a doorbell, then two accesses in the interrupt handler)", "A 4 KiB block at 2.7 exits per byte is about 11,000 exits"]) {
    assert.ok(ch15.includes(q), q);
  }
  const exits = [];
  let s = M.initialState();
  assert.equal(M.encode(s), null, "the default clears the hash");
  for (let k = 0; k < 8; k++) {
    s = M.step(s, { type: "do", token: "s" });
    const snap = M.simulate(s);
    exits.push(snap.exits.total);
    assert.equal(snap.toyStep, k + 1);
  }
  assert.deepEqual(exits, [0, 0, 1, 1, 1, 1, 1, 3]);
  assert.equal(M.step(s, { type: "do", token: "s" }), s, "nine steps is one too many");
  const end = M.simulate(s);
  assert.equal(end.descs[0].addr, M.TOY_DATA_ADDR);
  assert.equal(end.descs[0].len, M.TOY_LEN);
  assert.deepEqual(end.used.ring[0], { id: 0, len: 0 });
  assert.equal(end.disk.sector, 8);
  assert.equal(end.disk.bytes.length, 4096);
  assert.ok(end.disk.bytes.every((b, i) => b === M.toyByte(i)));
  assert.equal(end.device.line, false);
  assert.equal(end.driver.free.length, 1);
  assert.equal(M.encode(s), "toy.8");
  assert.deepEqual(M.decode("toy.3").actions.length, 3);
  // Step 7 raises the line without an exit.
  const s7 = M.simulate({ cfg: s.cfg, actions: s.actions.slice(0, 7) });
  assert.equal(s7.device.line, true);
  assert.equal(s7.exits.total, 1);
});

// ---- share strings ----

test("share strings: the reference, round trips and hostile input", () => {
  const lab = JSON.parse(read("course/site/src/labs/virtqueue-visualizer/lab.json"));
  const ref = M.decode(lab.reference);
  assert.equal(M.encode(ref), lab.reference);
  assert.equal(run(lab.reference).last.debug, "ChainTooLong { budget: 8 }");
  for (const bad of ["", "ring", "ring-n3-s0-c10000", "ring-n8-s0-c999", "ring-n8-s10000-c10000", "ring-n8-s0-c10000:", "ring-n8-s0-c10000:x",
    "ring-n8-s0-c10000:q", "ring-n8-s0-c10000:qr0", "ring-n8-s0-c10000:qr1001", "ring-n8-s0-c10000:qr1.r1.r1.r1", "ring-n8-s0-c10000:hnope",
    "toy.9", "toy.", "ring-n8-s0-c10000-i-i", "ring-n8-s0-c10000:" + Array(65).fill("f").join("_"), "a".repeat(5000), "ring-n8-s0-c10000:qr10.w200.w1_<script>"]) {
    assert.equal(M.decode(bad), null, JSON.stringify(bad.slice(0, 60)));
  }
  assert.equal(M.decode(null), null);
  assert.equal(M.decode(42), null);
  // A link with a refused action keeps the allowed prefix.
  assert.deepEqual(M.decode("ring-n8-s0-c10000:p_n").actions, []);
  assert.deepEqual(M.decode("ring-n8-s0-c10000:qw40_p_n").actions, ["qw40"]);
});

test("random share strings never throw and always re-encode to themselves", () => {
  let x = 0x2545f491n;
  const rnd = (n) => { x ^= x << 13n; x &= (1n << 64n) - 1n; x ^= x >> 7n; x ^= x << 17n; x &= (1n << 64n) - 1n; return Number(x % BigInt(n)); };
  const toks = ["n", "p", "u", "z", "f", "qw40", "qr10.w200.w1", "qr8", ...M.HOSTILE.map((h) => `h${h.id}`)];
  for (let i = 0; i < 300; i++) {
    const cfg = `ring-n${M.SIZES[rnd(5)]}-s${["0", "fffe", "ffff"][rnd(3)]}-c${["10000", "400", "none"][rnd(3)]}${rnd(2) ? "-i" : ""}${rnd(4) ? "" : "-nobudget"}${rnd(3) ? "" : "-reread"}`;
    const acts = Array.from({ length: 1 + rnd(20) }, () => toks[rnd(toks.length)]);
    const s = M.decode(`${cfg}:${acts.join("_")}`);
    assert.ok(s, cfg);
    const snap = M.simulate(s);
    assert.equal(M.encode(s), s.actions.length ? `${cfg}:${s.actions.join("_")}` : cfg);
    assert.ok(snap.descs.length === s.cfg.n);
  }
});

// ---- links and text ----

test("every rule link points at a real heading of chapter 15 or 16", () => {
  const chapters = JSON.parse(read("course/chapters.json")).chapters;
  const byUrl = new Map(chapters.map((c) => [`/build-your-own/vmm/${c.url}`, c]));
  for (const [rule, { href, chapter, section }] of Object.entries(M.RULES)) {
    const [path, frag] = href.split("#");
    const ch = byUrl.get(path);
    assert.ok(ch, `${rule}: ${path} is a chapter`);
    const md = read(ch.file);
    const heads = [...md.matchAll(/^##+ (.*)$/gm)].map((m) => m[1].trim());
    const slugs = heads.map(slugify);
    assert.ok(slugs.includes(frag), `${rule}: ${ch.file} has no heading #${frag}`);
    // The link's accessible name quotes the heading and the chapter it jumps to.
    assert.equal(heads[slugs.indexOf(frag)], section, `${rule}: section name`);
    assert.equal(path, chapter === 15 ? M.CH15 : M.CH16, `${rule}: chapter number`);
  }
});

test("learner-visible text names no internal plan or threat-model IDs", () => {
  const texts = [
    ...M.HOSTILE.flatMap((h) => [h.label, h.about]), ...M.PRESETS.flatMap((p) => [p.title, p.goal]),
    ...M.TOY_STEPS.map((t) => t.text), ...M.REQUEST_SHAPES.map((r) => r.label),
    ...M.PRESETS.flatMap((p) => run(p.state, "p").history.map((h) => h.text)),
    ...M.PRESETS.flatMap((p) => (run(p.state, "p").last.checks || []).map((c) => c.text)),
  ];
  for (const t of texts) {
    assert.doesNotMatch(t, /\b(?:M\d+|PLAN|VQ-\d|MEM-\d|R\d+|D\d+)\b|§/, t);
  }
});

test("display details: padded addresses, cap labels, status byte, start mode, hints", () => {
  assert.equal(M.hexAddr(0x0900_0000n), "0x0900_0000");
  assert.equal(M.hexAddr(0x0a00_0050n), "0x0a00_0050");
  assert.equal(M.hexAddr(0x4000_8000n), "0x4000_8000");
  assert.equal(M.hexAddr(0xffff_ffff_ffff_fff5n), "0xffff_ffff_ffff_fff5");
  assert.equal(M.hexAddr(0x1_0000_0000n), "0x0001_0000_0000");
  assert.doesNotMatch(M.CAP_LABELS["10000"], /blk/, "virtio-blk never passes a 64 KiB cap");
  assert.match(M.CAP_LABELS["10000"], /virtio-rng/);
  // A disk read: the trailing 1-byte status is 0 (OK), the data is filler.
  const s = M.decode("ring-n8-s0-c10000:qr10.w200.w1_n_p");
  const w = M.replay(s);
  const status = w.mem.peek(M.LAYOUT.buf + 0x2000n, 1)[0];
  assert.equal(status, 0);
  assert.equal(M.snapshot(w).used.ring[0].len, 513);
  // Chapter 16's embed opens on the full ring; everything else on the toy.
  assert.equal(M.startModeFor({ pathname: M.CH16 }), "ring");
  assert.equal(M.startModeFor({ pathname: M.CH16, standalone: true }), "toy");
  assert.equal(M.startModeFor({ pathname: M.CH15 }), "toy");
  const ringStart = M.initialState("ring");
  assert.equal(M.encode(ringStart, "ring"), null, "chapter 16's start state clears the hash");
  assert.equal(M.encode(ringStart), "ring-n8-s0-c10000");
  assert.equal(M.encode(M.initialState(), "ring"), "toy");
  assert.deepEqual(M.decode("toy"), M.initialState());
  // Try next walks the honest sequence.
  const seq = ["", "qr10.w200.w1", "qr10.w200.w1_n", "qr10.w200.w1_n_p"].map((a) =>
    M.nextHint(M.snapshot(M.replay(M.decode(`ring-n8-s0-c10000${a ? `:${a}` : ""}`)))));
  assert.match(seq[0], /add request/);
  assert.match(seq[1], /ring the doorbell/);
  assert.match(seq[2], /process one/);
  assert.match(seq[3], /reclaim used/);
  // The toy's announcement carries the step's own sentence.
  const toy3 = M.snapshot(M.replay({ cfg: M.defaultConfig("toy"), actions: ["s", "s", "s"] }));
  assert.match(M.summary(toy3), /^Step 3 of 8: .*first VM exit\..*Exits so far: 1\.$/);
});
