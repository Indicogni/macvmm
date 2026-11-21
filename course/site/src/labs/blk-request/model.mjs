// blk-request model: one virtio-blk request, checked the way the reference device checks it.
//
// This is a pure port of the request path in crates/vmm/src/virtio/blk.rs (`execute`, `parse`,
// `parse_and_run`, `bounds_check`) plus the three rules of chapter 16's walk that a reader can
// break from this lab (crates/vmm/src/virtio/chain.rs: zero-length descriptor, readable after
// writable, more descriptors than the queue size). The rule numbers are chapter 18's
// ("Every field is hostile"), in the order the reference runs them. No DOM, no I/O: the view
// renders what `run` returns, and model.test.mjs checks it against the Rust source, the
// lesson's numbers and the reference's hostile host tests.
//
// Guest-controlled numbers are 64-bit, so sectors, offsets and capacities are BigInt and every
// sum is checked against 2^64 exactly as `checked_mul` / `checked_add` would. The reader's
// "arithmetic" setting swaps in the chapter's deliberate breakage: `wrapping` (what C does, and
// what `wrapping_mul` / `wrapping_add` do) or `panic` (plain `*` and `+` with overflow checks
// on, which this workspace enables even in release builds).

// ---- constants (each mirrors blk.rs; model.test.mjs re-reads the Rust source) ----------------

export const SECTOR_SIZE = 512n; // backend/file.rs SECTOR_SIZE
export const BLK_HDR_LEN = 16;
export const BLK_ID_BYTES = 20;
export const BLK_CONFIG_LEN = 24;
export const BLK_QUEUE_SIZE = 256;
export const SIZE_MAX = 64 * 1024;
export const SEG_MAX = 126;
export const BLK_MAX_DATA = SEG_MAX * SIZE_MAX; // 8,257,536 bytes, "about 8 MiB"
export const U32_MAX = 0xffff_ffff;
export const U64 = 1n << 64n;
export const U64_MAX = U64 - 1n;

export const REQ = Object.freeze({ IN: 0, OUT: 1, FLUSH: 4, GET_ID: 8 });
export const STATUS = Object.freeze({ OK: 0, IOERR: 1, UNSUPP: 2 });
export const STATUS_NAME = Object.freeze({ 0: "OK", 1: "IOERR", 2: "UNSUPP" });

/** Feature bits the device can offer (blk.rs `blk_features`, virtio/mod.rs `features`). */
export const FEATURES = Object.freeze([
  { name: "SEG_MAX", bit: 2 },
  { name: "RO", bit: 5 },
  { name: "BLK_SIZE", bit: 6 },
  { name: "FLUSH", bit: 9 },
  { name: "INDIRECT_DESC", bit: 28 },
  { name: "VERSION_1", bit: 32 },
]);

/** The guest's bytes in a writable buffer before the device answers (the host tests use 0xee). */
export const GUEST_OLD_BYTE = 0xee;

/** Input limits for the editor and the share string (hostile input is capped, never trusted). */
export const LIMITS = Object.freeze({
  rows: 16, // descriptor rows in the editor
  repeat: 300, // one row may stand for this many identical descriptors
  total: 300, // descriptors in all: above the 256-hop budget, so the walk's refusal is reachable
  share: 600, // characters in a share string
  diskIndex: 99,
});

export function typeName(t) {
  switch (t) {
    case REQ.IN: return "IN";
    case REQ.OUT: return "OUT";
    case REQ.FLUSH: return "FLUSH";
    case REQ.GET_ID: return "GET_ID";
    default: return null;
  }
}

// ---- the request a reader builds ------------------------------------------------------------

/**
 * One request. `descs` are the chain's descriptors in order, after chapter 16's walk has checked
 * their addresses; each row is `{ w, len, n }`: writable or readable, length in bytes (a u32),
 * and how many identical descriptors the row stands for (so 127 one-sector buffers is one row).
 */
export function defaultState() {
  return {
    cap: 64n, // capacity in 512-byte sectors
    ro: false, // opened with ,ro: the device offers RO and refuses OUT
    wb: true, // the driver accepted FLUSH: write-back (else write-through)
    ar: "c", // arithmetic in rule 6: c checked (the reference), w wrapping, p panicking
    type: REQ.IN,
    reserved: 0,
    sector: 64n,
    fill: 0x5a, // the bytes an OUT carries
    disk: 0, // --disk position, for GET_ID's serial
    descs: [{ w: false, len: 16, n: 1 }, { w: true, len: 512, n: 1 }, { w: true, len: 1, n: 1 }],
    predict: false,
  };
}

export function cloneState(s) {
  return { ...s, descs: s.descs.map((d) => ({ ...d })) };
}

/** Why a state cannot be run (an editor or share-string mistake), or null. */
export function validateState(s) {
  if (!s || typeof s !== "object") return "no request";
  if (typeof s.cap !== "bigint" || s.cap < 1n || s.cap > U64_MAX) return "the capacity must be 1 to 2^64 - 1 sectors";
  if (!isU32(s.type)) return "the type must fit in 32 bits";
  if (!isU32(s.reserved)) return "the reserved field must fit in 32 bits";
  if (typeof s.sector !== "bigint" || s.sector < 0n || s.sector > U64_MAX) return "the sector must fit in 64 bits";
  if (!Number.isInteger(s.fill) || s.fill < 0 || s.fill > 0xff) return "the data byte must be 0x00 to 0xff";
  if (!Number.isInteger(s.disk) || s.disk < 0 || s.disk > LIMITS.diskIndex) return `the disk number must be 0 to ${LIMITS.diskIndex}`;
  if (!["c", "w", "p"].includes(s.ar)) return "unknown arithmetic";
  if (!Array.isArray(s.descs) || s.descs.length === 0) return "a chain has at least one descriptor";
  if (s.descs.length > LIMITS.rows) return `at most ${LIMITS.rows} descriptor rows`;
  let total = 0;
  for (const d of s.descs) {
    if (!d || typeof d.w !== "boolean") return "each descriptor is readable or writable";
    if (!isU32(d.len)) return "a descriptor's length is a 32-bit number (0 to 4294967295)";
    if (!Number.isInteger(d.n) || d.n < 1 || d.n > LIMITS.repeat) return `a row repeats 1 to ${LIMITS.repeat} times`;
    total += d.n;
  }
  if (total > LIMITS.total) return `at most ${LIMITS.total} descriptors in all`;
  return null;
}

function isU32(v) {
  return Number.isInteger(v) && v >= 0 && v <= U32_MAX;
}

// ---- bytes -----------------------------------------------------------------------------------

/** The 16 header bytes the driver wrote: le32 type, le32 reserved, le64 sector (virtio 1.2 5.2.6). */
export function headerBytes(s) {
  const b = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    b[i] = (s.type >>> (8 * i)) & 0xff;
    b[4 + i] = (s.reserved >>> (8 * i)) & 0xff;
  }
  for (let i = 0; i < 8; i++) b[8 + i] = Number((s.sector >> BigInt(8 * i)) & 0xffn);
  return b;
}

/** Decode 16 header bytes, as `BlkHeader::decode_le` does. */
export function decodeHeader(b) {
  if (!Array.isArray(b) || b.length !== 16) throw new Error("a header is 16 bytes");
  const u32 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  let sector = 0n;
  for (let i = 7; i >= 0; i--) sector = (sector << 8n) | BigInt(b[8 + i]);
  return { type: u32(0), reserved: u32(4), sector };
}

/**
 * The byte at disk offset `i` of the lab's disk: the pattern of the host tests' `MockDisk`
 * (`(i * 7 + i / 512) as u8`), so sector N's bytes are recognisable.
 */
export function diskByte(i) {
  return Number((i * 7n + i / 512n) & 0xffn);
}

/** GET_ID's serial for disk `index`: `macvmm-disk<index>`, zero-padded to 20 (`disk_serial`). */
export function diskSerial(index) {
  const id = new Array(BLK_ID_BYTES).fill(0);
  const s = `macvmm-disk${index}`;
  for (let i = 0; i < Math.min(s.length, BLK_ID_BYTES); i++) id[i] = s.charCodeAt(i);
  return id;
}

/** Capacity in bytes, clamped as `Blk::new` does when `sectors × 512` would not fit in a u64. */
export function capacityBytes(sectors) {
  const b = sectors * SECTOR_SIZE;
  return b > U64_MAX ? (U64_MAX / SECTOR_SIZE) * SECTOR_SIZE : b;
}

/** The feature bits the device offers (`device_features`). */
export function offeredFeatures(ro) {
  let f = 0n;
  for (const x of FEATURES) if (x.name !== "RO" || ro) f |= 1n << BigInt(x.bit);
  return f;
}

/** The 24 configuration-space bytes (`Blk::config`): capacity, size_max, seg_max, geometry 0, blk_size. */
export function configBytes(sectors) {
  const c = new Array(BLK_CONFIG_LEN).fill(0);
  const cap = capacityBytes(sectors) / SECTOR_SIZE;
  for (let i = 0; i < 8; i++) c[i] = Number((cap >> BigInt(8 * i)) & 0xffn);
  const put32 = (o, v) => { for (let i = 0; i < 4; i++) c[o + i] = (v >>> (8 * i)) & 0xff; };
  put32(8, SIZE_MAX);
  put32(12, SEG_MAX);
  put32(20, 512);
  return c;
}

// ---- number formatting -----------------------------------------------------------------------

/** Plain decimal below 2^32, else hex grouped by 4 (`0x0080_0000_0000_0000` style). */
export function fmt(v) {
  const b = BigInt(v);
  if (b >= 0n && b < 1n << 32n) return b.toString(10);
  return hexU(b);
}

export function hexU(v, width = 0) {
  let s = BigInt(v).toString(16);
  if (s.length < width) s = s.padStart(width, "0");
  const groups = [];
  for (let i = s.length; i > 0; i -= 4) groups.unshift(s.slice(Math.max(0, i - 4), i));
  return `0x${groups.join("_")}`;
}

export function hex2(b) {
  return b.toString(16).padStart(2, "0");
}

/** "2^55" for exact powers of two at or above 2^32, else `fmt`. */
export function fmtPow(v) {
  const b = BigInt(v);
  if (b >= 1n << 32n && (b & (b - 1n)) === 0n) return `2^${b.toString(2).length - 1}`;
  return fmt(b);
}

// ---- parsing (hardened: the reader's text and share strings are untrusted) -------------------

/**
 * A u64 from text: decimal, `0x` hex (underscores allowed), or `2^n` (0 <= n <= 63). Returns a
 * BigInt or null. At most 40 characters.
 */
export function parseU64(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/_/g, "");
  if (t === "" || t.length > 40) return null;
  let v;
  const pow = /^2\^(\d{1,2})$/.exec(t);
  if (pow) {
    const n = Number(pow[1]);
    if (n > 63) return null;
    v = 1n << BigInt(n);
  } else if (/^0[xX][0-9a-fA-F]{1,16}$/.test(t)) v = BigInt(t);
  else if (/^\d{1,20}$/.test(t)) v = BigInt(t);
  else return null;
  return v <= U64_MAX ? v : null;
}

export function parseU32(text) {
  const v = parseU64(text);
  return v === null || v > BigInt(U32_MAX) ? null : Number(v);
}

// ---- the walk and the six rules --------------------------------------------------------------

/** Expand rows into descriptors, stopping one past the walk's hop budget. */
function expand(descs) {
  const out = [];
  descs.forEach((d, row) => {
    for (let k = 0; k < d.n && out.length <= BLK_QUEUE_SIZE; k++) out.push({ w: d.w, len: d.len, row });
  });
  return out;
}

const RULES = [
  ["walk", "Chapter 16's walk"],
  ["r1", "Rule 1: a status byte"],
  ["r2", "Rule 2: a 16-byte readable header, copied once"],
  ["r3", "Rule 3: at most 128 descriptors"],
  ["r4", "Rule 4: a known type, data one way"],
  ["r5", "Rule 5: no writes to a read-only disk"],
  ["r6", "Rule 6: the range is inside the disk"],
];
export const RULE_TITLES = Object.freeze(Object.fromEntries(RULES));

/**
 * rule 6 (`bounds_check`) under the chosen arithmetic. Returns
 * `{ ok, offset, end, detail, panic?, wrapped, mulWrapped, addWrapped }` where `offset`/`end` are
 * what the check saw; `mulWrapped` is the `sector × 512` wrap, `addWrapped` the `+ length` wrap.
 */
export function boundsCheck(sector, len, capBytes, ar = "c") {
  const L = BigInt(len);
  const lenText = fmt(L);
  if (L % SECTOR_SIZE !== 0n) {
    return { ok: false, detail: `the length ${lenText} is not a whole number of 512-byte sectors (${lenText} mod 512 = ${fmt(L % SECTOR_SIZE)})` };
  }
  if (L > BigInt(BLK_MAX_DATA)) {
    return { ok: false, detail: `the length ${lenText} is over the cap of 126 × 64 KiB = ${BLK_MAX_DATA} bytes` };
  }
  const prod = sector * SECTOR_SIZE;
  const mulText = `${fmtPow(sector)} × 512`;
  let offset = prod;
  let mulWrapped = false;
  let addWrapped = false;
  if (prod > U64_MAX) {
    if (ar === "c") return { ok: false, detail: `${mulText} does not fit in 64 bits: checked_mul returns None` };
    if (ar === "p") return { ok: false, panic: "attempt to multiply with overflow", detail: `${mulText} does not fit in 64 bits, and plain * with overflow checks on panics` };
    offset = prod % U64;
    mulWrapped = true;
  }
  const sum = offset + L;
  let end = sum;
  const sumText = `${mulWrapped ? fmt(offset) : mulText} + ${lenText}`;
  if (sum > U64_MAX) {
    if (ar === "c") return { ok: false, offset, detail: `offset ${mulText} = ${fmt(offset)} fits, but ${fmt(offset)} + ${lenText} does not fit in 64 bits: checked_add returns None` };
    if (ar === "p") return { ok: false, offset, panic: "attempt to add with overflow", detail: `${mulText} = ${fmt(offset)} fits, but + ${lenText} overflows, and plain + with overflow checks on panics` };
    end = sum % U64;
    addWrapped = true;
  }
  const wrapped = mulWrapped || addWrapped;
  const trueEnd = prod + L;
  let wrapNote = "";
  if (mulWrapped && addWrapped) wrapNote = ` (wrapped twice: the true offset is ${fmtPow(prod)} and the true end is ${fmtPow(trueEnd)}, neither fits in 64 bits)`;
  else if (mulWrapped) wrapNote = ` (wrapped: the true offset is ${fmtPow(prod)}, which does not fit in 64 bits)`;
  else if (addWrapped) wrapNote = ` (wrapped: the true end is ${fmtPow(trueEnd)}, which does not fit in 64 bits)`;
  const eq = wrapped
    ? `offset ${fmt(offset)}, end ${fmt(end)}${wrapNote}`
    : `${mulText} + ${lenText} = ${fmt(end)}`;
  if (end > capBytes) {
    return { ok: false, offset, end, wrapped, mulWrapped, addWrapped, detail: `${eq} > ${fmt(capBytes)}, the disk's size in bytes`, sumText };
  }
  return { ok: true, offset, end, wrapped, mulWrapped, addWrapped, detail: `${eq} <= ${fmt(capBytes)}, the disk's size in bytes`, sumText };
}

/**
 * Run one request. `opts.embedded` (the view passes `!ctx.standalone`) makes references to
 * chapter 18 read "this chapter's". Returns
 * ```
 * { checks: [{ id, title, verdict: "pass"|"fail"|"skip"|"not reached", detail }],
 *   outcome: { kind: "reset"|"status"|"panic"|"backend", status?, used?, text },
 *   readableLen, writableLen, dataOut, dataIn, header, headerFrom, rows: [...per row...],
 *   disk: { asked, reads, writes, syncs }, guest: { kind, offset?, n? }, summary }
 * ```
 */
export function run(state, opts = {}) {
  const err = validateState(state);
  if (err) throw new Error(err);
  const s = state;
  // Words for chapter 18 itself: "this chapter's" when the lab is embedded there.
  const ch = opts.embedded ? "this chapter's" : "chapter 18's";
  const capBytes = capacityBytes(s.cap);
  const checks = RULES.map(([id, title]) => ({ id, title, verdict: "not reached", detail: "" }));
  const C = Object.fromEntries(checks.map((c) => [c.id, c]));
  const res = {
    checks, capBytes, readableLen: 0, writableLen: 0, dataOut: 0, dataIn: 0,
    header: null, headerFrom: 0, descCount: 0,
    disk: { asked: null, reads: [], writes: [], syncs: 0, wrong: false },
    guest: { kind: "none" },
    outcome: null,
  };
  const set = (id, verdict, detail) => { C[id].verdict = verdict; C[id].detail = detail; };
  res.ch = ch;
  const finish = (outcome) => { res.outcome = outcome; res.summary = summarize(s, res); return res; };

  // Chapter 16's walk (chain.rs): descriptors one by one, in chain order.
  const exp = expand(s.descs);
  let seenW = false;
  const R = [];
  const W = [];
  for (let i = 0; i < exp.length; i++) {
    const d = exp[i];
    if (i >= BLK_QUEUE_SIZE) {
      set("walk", "fail", `more than ${BLK_QUEUE_SIZE} descriptors in the queue's own table. The walk's hop budget is the queue size (here ${BLK_QUEUE_SIZE}, the largest this device allows; a driver may choose a smaller queue), and a ${BLK_QUEUE_SIZE}-entry table cannot hold a longer chain without a loop, so the walk refuses it (ChainTooLong). Through an indirect table the budget restarts, and such a chain would reach rule 3 instead`);
      return finish(resetOutcome("the walk refused the chain (too long)"));
    }
    if (d.len === 0) {
      set("walk", "fail", `descriptor ${i} has length 0, which the walk refuses (ZeroLength)`);
      return finish(resetOutcome("the walk refused the chain (a zero-length descriptor)"));
    }
    if (d.w) {
      seenW = true;
      W.push({ ...d, index: i });
    } else {
      if (seenW) {
        set("walk", "fail", `descriptor ${i} is readable but comes after a writable one; section 2.7.4.2 puts every readable buffer first (ReadableAfterWritable)`);
        return finish(resetOutcome("the walk refused the chain (readable after writable)"));
      }
      R.push({ ...d, index: i });
    }
  }
  const rl = R.reduce((a, d) => a + d.len, 0);
  const wl = W.reduce((a, d) => a + d.len, 0);
  res.readableLen = rl;
  res.writableLen = wl;
  res.descCount = exp.length;
  set("walk", "pass", `${exp.length} descriptor${exp.length === 1 ? "" : "s"}, none of length 0, readable before writable: ${rl} readable bytes, ${wl} writable bytes`);

  // Rule 1 (`execute`): the status is the last writable byte.
  if (W.length === 0) {
    set("r1", "fail", "no writable byte at all, so there is nowhere to put any answer: a protocol violation, not a failed request");
    return finish(resetOutcome("rule 1: no status byte"));
  }
  const dataIn = wl - 1;
  res.dataIn = dataIn;
  set("r1", "pass", `the status goes in the last byte of descriptor ${W[W.length - 1].index}; ${dataIn} writable byte${dataIn === 1 ? "" : "s"} before it are data`);

  // Rule 2 (`parse`): 16 readable bytes, copied once.
  if (rl < BLK_HDR_LEN) {
    const where = R.length === 0 ? "there are no readable bytes (a header in a writable descriptor does not count)" : `only ${rl} readable byte${rl === 1 ? "" : "s"}`;
    set("r2", "fail", `the header needs 16 readable bytes; ${where}`);
    return finish(statusOutcome(STATUS.IOERR, 0, "rule 2"));
  }
  let covered = 0;
  for (const d of R) { res.headerFrom++; covered += d.len; if (covered >= BLK_HDR_LEN) break; }
  res.header = decodeHeader(headerBytes(s));
  const tn = typeName(res.header.type);
  set("r2", "pass", `copied once from ${res.headerFrom === 1 ? "descriptor 0" : `${res.headerFrom} descriptors (section 2.7.4 allows any split)`}: type ${res.header.type}${tn ? ` (${tn})` : ""}, reserved ${res.header.reserved}, sector ${fmt(res.header.sector)}`);

  // Rule 3 (`parse`): header + SEG_MAX data + status.
  const descs = R.length + W.length;
  if (descs > SEG_MAX + 2) {
    set("r3", "fail", `${descs} descriptors > 128 (126 data buffers, the header, the status)`);
    return finish(statusOutcome(STATUS.IOERR, 0, "rule 3"));
  }
  set("r3", "pass", `${descs} descriptor${descs === 1 ? "" : "s"} <= 128`);

  const dataOut = rl - BLK_HDR_LEN;
  res.dataOut = dataOut;
  const t = res.header.type;
  const dirText = `${dataOut} readable data byte${dataOut === 1 ? "" : "s"} after the header, ${dataIn} writable data byte${dataIn === 1 ? "" : "s"} before the status`;

  // Rule 4 (`parse_and_run`'s match guards), then 5 and 6 inside the arms.
  if (t === REQ.IN && dataOut === 0) {
    set("r4", "pass", `IN moves data from the disk to the guest: ${dirText}`);
    set("r5", "skip", "only OUT writes");
    return ioArm(s, res, set, finish, dataIn, false);
  }
  if (t === REQ.OUT && dataIn === 0) {
    set("r4", "pass", `OUT moves data from the guest to the disk: ${dirText}`);
    if (s.ro) {
      set("r5", "fail", "the disk was opened ,ro and this is an OUT");
      return finish(statusOutcome(STATUS.IOERR, 0, "rule 5"));
    }
    set("r5", "pass", "the disk is read-write");
    return ioArm(s, res, set, finish, dataOut, true);
  }
  if (t === REQ.FLUSH && dataOut === 0 && dataIn === 0) {
    set("r4", "pass", "FLUSH carries no data in either direction");
    set("r5", "skip", "only OUT writes");
    set("r6", "skip", "FLUSH names no range");
    if (!s.ro) res.disk.syncs = 1;
    res.guest = { kind: "flush" };
    return finish(statusOutcome(STATUS.OK, 0, s.ro ? "flush-ro" : "flush"));
  }
  if (t === REQ.GET_ID && dataOut === 0) {
    const n = Math.min(BLK_ID_BYTES, dataIn);
    set("r4", "pass", `GET_ID writes the serial into the writable data: min(20, ${dataIn}) = ${n} byte${n === 1 ? "" : "s"}`);
    set("r5", "skip", "only OUT writes");
    set("r6", "skip", "GET_ID reads no sectors (the sector field is ignored)");
    res.guest = { kind: "id", n };
    return finish(statusOutcome(STATUS.OK, n, "get-id"));
  }
  if (tn) {
    const want = t === REQ.IN ? "IN takes writable data only" : t === REQ.OUT ? "OUT takes readable data only" : t === REQ.FLUSH ? "FLUSH takes no data" : "GET_ID takes writable data only";
    set("r4", "fail", `${tn} with data the wrong way: ${want}, and this chain has ${dirText}`);
    return finish(statusOutcome(STATUS.IOERR, 0, "rule 4 direction"));
  }
  set("r4", "fail", `type ${t} is none of IN (0), OUT (1), FLUSH (4), GET_ID (8)`);
  return finish(statusOutcome(STATUS.UNSUPP, 0, "rule 4 type"));
}

/** IN or OUT after rule 5: rule 6, then the bounce-buffer copy (or the breakage's consequence). */
function ioArm(s, res, set, finish, len, out) {
  const b = boundsCheck(s.sector, len, res.capBytes, s.ar);
  res.bounds = b;
  res.disk.asked = { sector: s.sector, len };
  if (b.panic) {
    set("r6", "fail", b.detail);
    return finish({ kind: "panic", text: `the VMM panics: ${b.panic}. No status, no used entry: the guest can stop the VMM at will.` });
  }
  if (!b.ok) {
    set("r6", "fail", b.detail);
    return finish(statusOutcome(STATUS.IOERR, 0, "rule 6"));
  }
  set("r6", "pass", b.detail);
  const L = BigInt(len);
  const reallyInside = b.offset + L <= res.capBytes;
  const access = { offset: b.offset, len };
  if (!reallyInside) {
    // A wrapped end let a huge offset through: the check's promise is broken.
    (out ? res.disk.writes : res.disk.reads).push(access);
    res.disk.wrong = true;
    return finish({
      kind: "backend",
      text: `the ${out ? "write" : "read"} reaches the disk backend at offset ${fmt(b.offset)}, far past the end of a ${fmt(res.capBytes)}-byte disk. The check exists so that this never happens; what follows depends on the backend${s.sector === U64_MAX / SECTOR_SIZE ? ` (this is the request of ${res.ch} wrapping run, sector u64::MAX / 512, and there the test's in-memory disk panicked)` : ` (in ${res.ch} wrapping run, sector u64::MAX / 512 got this far, and the test's in-memory disk panicked)`}.`,
    });
  }
  if (len > 0) (out ? res.disk.writes : res.disk.reads).push(access);
  res.disk.wrong = b.wrapped;
  if (out) {
    if (!s.wb) res.disk.syncs = 1; // write-through: synced before OK
    res.guest = { kind: "out" };
    return finish(statusOutcome(STATUS.OK, 0, "out"));
  }
  res.guest = { kind: "in", offset: b.offset, n: len };
  return finish(statusOutcome(STATUS.OK, len, "in"));
}

function resetOutcome(why) {
  return { kind: "reset", text: `DEVICE_NEEDS_RESET: ${why}. Nothing goes in the used ring, no status byte is written, and the disk stops until the driver resets it.` };
}

function statusOutcome(status, written, why) {
  return { kind: "status", status, written, used: written + 1, why };
}

// ---- what the guest sees afterwards ----------------------------------------------------------

/** The byte at position `pos` of the readable stream (header, then OUT data). */
export function readableByte(s, pos) {
  if (pos < BLK_HDR_LEN) return headerBytes(s)[pos];
  return s.fill;
}

/** The byte at position `pos` of the writable stream after the device answered. */
export function writableByteAfter(s, res, pos) {
  const o = res.outcome;
  if (o.kind !== "status") return GUEST_OLD_BYTE;
  if (pos === res.writableLen - 1) return o.status;
  if (o.status === STATUS.OK && res.guest.kind === "in" && pos < res.guest.n) return diskByte(res.guest.offset + BigInt(pos));
  if (o.status === STATUS.OK && res.guest.kind === "id" && pos < res.guest.n) return diskSerial(s.disk)[pos];
  return GUEST_OLD_BYTE;
}

/**
 * Per descriptor row: where its bytes sit in the readable or writable stream and what they are
 * (header, data, status, unused), for the view's chain table. Rows past the walk's refusal are
 * still laid out; the view dims them.
 */
export function layout(s, res) {
  let rpos = 0;
  let wpos = 0;
  const wl = res.writableLen;
  return s.descs.map((d, row) => {
    const total = d.len * d.n;
    const start = d.w ? wpos : rpos;
    if (d.w) wpos += total; else rpos += total;
    const parts = [];
    if (total > 0) {
      if (!d.w) {
        if (start < BLK_HDR_LEN) parts.push(`header bytes ${start}-${Math.min(BLK_HDR_LEN, start + total) - 1}`);
        if (start + total > BLK_HDR_LEN) parts.push(`data bytes ${Math.max(0, start - BLK_HDR_LEN)}-${start + total - BLK_HDR_LEN - 1}`);
      } else {
        const lastData = Math.min(start + total, Math.max(0, wl - 1));
        if (start < lastData) parts.push(`data bytes ${start}-${lastData - 1}`);
        if (wl > 0 && start + total === wl) parts.push("the status (its last byte)");
      }
    }
    return { row, w: d.w, len: d.len, n: d.n, start, total, parts };
  });
}

/** Up to `max` bytes of a row, before and after, as hex strings, plus how many were left out. */
export function rowPreview(s, res, lay, max = 16) {
  const n = Math.min(lay.total, max);
  const before = [];
  const after = [];
  for (let i = 0; i < n; i++) {
    const pos = lay.start + i;
    if (lay.w) {
      before.push(GUEST_OLD_BYTE);
      after.push(res.outcome ? writableByteAfter(s, res, pos) : GUEST_OLD_BYTE);
    } else {
      const b = readableByte(s, pos);
      before.push(b);
      after.push(b);
    }
  }
  // Show the status byte even when it is past the preview window.
  let tail = null;
  if (lay.w && lay.total > max && lay.start + lay.total === res.writableLen) {
    tail = { before: GUEST_OLD_BYTE, after: writableByteAfter(s, res, res.writableLen - 1) };
  }
  return { before, after, more: lay.total - n, tail };
}

// ---- words -----------------------------------------------------------------------------------

function summarize(s, res) {
  const o = res.outcome;
  const fired = res.checks.find((c) => c.verdict === "fail");
  if (o.kind === "reset") return `${fired ? `${fired.title.split(":")[0]} fails: ${fired.detail}. ` : ""}${o.text}`;
  if (o.kind === "panic") return `${fired.title.split(":")[0]}, with plain arithmetic: ${fired.detail}. ${cap1(o.text)}`;
  if (o.kind === "backend") return `${res.bounds.wrapped ? "With wrapping arithmetic, rule 6 passes: " : ""}${res.bounds.detail}. Then ${o.text}`;
  const st = `status ${STATUS_NAME[o.status]} (${o.status}), used length ${o.used}`;
  const sb = `${STATUS_NAME[o.status]} (${o.status}), used length ${o.used}`;
  if (fired) {
    let short = fired.detail;
    if (fired.id === "r6" && res.bounds && !res.bounds.panic && res.bounds.end !== undefined && res.bounds.offset !== undefined && !res.bounds.wrapped) {
      short = `${res.bounds.sumText} = ${fmt(res.bounds.end)} > ${fmt(res.capBytes)}`;
    }
    const untouched = o.status === STATUS.IOERR || o.status === STATUS.UNSUPP ? " The disk file is never touched." : "";
    return `${fired.title.split(":")[0]} fires: ${short}. ${cap1(st)}.${untouched}`;
  }
  const g = res.guest;
  if (g.kind === "in") {
    const wrong = res.bounds.wrapped ? ` But the offset wrapped: these are the bytes at disk offset ${fmt(g.offset)} (sector ${fmt(g.offset / SECTOR_SIZE)}), not at sector ${fmtPow(s.sector)}. A wrapped offset is a valid offset, only the wrong one.` : "";
    const bounce = g.n > 0 ? " (through fresh, zeroed bounce buffers of at most 64 KiB each, one per chunk)" : "";
    const what = g.n > 0 ? `copies ${fmt(BigInt(g.n))} bytes from disk offset ${fmt(g.offset)} into the guest's buffers${bounce}, then writes` : "has no data to copy, so it only writes";
    return `Every check passes. The device ${what} the status byte: ${sb} (the data plus the status byte).${wrong}`;
  }
  if (g.kind === "out") {
    const wrong = res.bounds.wrapped ? ` But the offset wrapped: the bytes land at disk offset ${fmt(res.bounds.offset)} (sector ${fmt(res.bounds.offset / SECTOR_SIZE)}), not at sector ${fmtPow(s.sector)}.` : "";
    const sync = s.wb ? "The driver accepted FLUSH, so the write may still sit in the host's cache until a later FLUSH makes it durable (write-back; see What FLUSH promises)." : "The driver did not accept FLUSH, so the device syncs before it answers (write-through; see What FLUSH promises).";
    return `Every check passes. The device writes ${res.dataOut} bytes at disk offset ${fmt(res.bounds.offset)}, then writes the status byte: ${sb}, because no data went into guest memory. ${sync}${wrong}`;
  }
  if (g.kind === "flush") {
    return s.ro
      ? `Every check passes. A read-only disk has nothing to flush, so no sync is made: ${st}.`
      : `Every check passes. The device asks the host to make every earlier write durable (one sync call; see What FLUSH promises) and writes the status byte only after that returned: ${sb}.`;
  }
  if (g.kind === "id") {
    const id = diskSerial(s.disk).slice(0, g.n);
    const text = id.filter((b) => b !== 0).map((b) => String.fromCharCode(b)).join("");
    const pad = id.filter((b) => b === 0).length;
    return `Every check passes. The device writes ${g.n} byte${g.n === 1 ? "" : "s"} of the serial ("${text}"${pad ? ` and ${pad} zero byte${pad === 1 ? "" : "s"}` : ""}), then the status byte: ${sb}.`;
  }
  return st;
}

function cap1(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The whole result as plain text (for the view's copyable trace and for tests). */
export function formatTrace(s, res) {
  const lines = [];
  for (const c of res.checks) lines.push(`${c.verdict.padEnd(11)} ${c.title}${c.detail ? `: ${c.detail}` : ""}`);
  lines.push("", res.summary);
  return lines.join("\n");
}

// ---- presets: every one is a case from chapter 18 or the reference's hostile host tests -------

function P(id, label, patch, note) {
  const s = { ...defaultState(), ...patch };
  if (patch.descs) s.descs = patch.descs.map(([w, len, n = 1]) => ({ w: w === "w", len, n }));
  return { id, label, state: s, note };
}
const STD = (data, dir) => (data > 0 ? [["r", 16], [dir, data], ["w", 1]] : [["r", 16], ["w", 1]]);
const BIG = 1n << 15n; // a 16 MiB disk, for the 8 MiB cases

export const PRESETS = Object.freeze([
  P("past-end", "Past the end: 512 bytes at sector 64 (the lesson's example)", {}, "The disk has 64 sectors, 0 to 63."),
  P("read", "A good read: 1024 bytes at sector 3", { sector: 3n, descs: STD(1024, "w") }),
  P("last", "The last sector: 512 bytes at sector 63", { sector: 63n }),
  P("write", "A good write: 512 bytes at sector 7", { type: REQ.OUT, sector: 7n, descs: STD(512, "r") }),
  P("write-through", "A write when the driver did not accept FLUSH", { type: REQ.OUT, sector: 7n, wb: false, descs: STD(512, "r") }),
  P("mul-overflow", "sector × 512 overflows: sector 2^55", { sector: 1n << 55n }, "Once you reach Breaking it on purpose: open Later in this chapter and switch the arithmetic to wrapping."),
  P("end-overflow", "The end overflows: sector u64::MAX / 512", { sector: U64_MAX / 512n }, "Times 512 this fits; adding the length does not."),
  P("odd-len", "A length that is not whole sectors: 100 bytes", { sector: 0n, descs: STD(100, "w") }),
  P("no-status", "No status byte: an OUT whose parts are all readable", { type: REQ.OUT, sector: 0n, descs: [["r", 16], ["r", 512]] }),
  P("status-readable", "A readable status after writable data", { sector: 0n, descs: [["r", 16], ["w", 512], ["r", 1]] }),
  P("zero-status", "A zero-length status descriptor", { sector: 0n, descs: [["r", 16], ["w", 512], ["w", 0]] }),
  P("short-header", "A header of 8 bytes", { sector: 0n, descs: [["r", 8], ["w", 512], ["w", 1]] }),
  P("writable-header", "The header in a writable descriptor", { sector: 0n, descs: [["w", 16], ["w", 512], ["w", 1]] }),
  P("split", "Any layout: a split header, data and status in one descriptor", { sector: 2n, descs: [["r", 8], ["r", 8], ["w", 513]] }),
  P("merged-out", "Any layout: an OUT with header and data in one descriptor", { type: REQ.OUT, sector: 5n, fill: 0x77, descs: [["r", 528], ["w", 1]] }),
  P("in-readable", "Wrong direction: an IN with readable data", { sector: 0n, descs: STD(512, "r") }),
  P("out-ro", "An OUT on a read-only disk", { type: REQ.OUT, sector: 0n, ro: true, fill: 0x11, descs: STD(512, "r") }),
  P("unknown", "An unknown type: 3", { type: 3, sector: 0n }),
  P("get-id", "GET_ID with a 20-byte buffer", { type: REQ.GET_ID, sector: 0n, descs: STD(20, "w") }),
  P("get-id-8", "GET_ID with an 8-byte buffer", { type: REQ.GET_ID, sector: 0n, descs: STD(8, "w") }),
  P("flush", "FLUSH", { type: REQ.FLUSH, sector: 0n, descs: STD(0) }),
  P("flush-16", "FLUSH with a 16-byte status descriptor", { type: REQ.FLUSH, sector: 0n, descs: [["r", 16], ["w", 16]] }),
  P("segs-127", "127 data buffers of one sector", { sector: 0n, descs: [["r", 16], ["w", 512, 127], ["w", 1]] }),
  P("segs-126", "126 data buffers of 256 bytes", { sector: 0n, descs: [["r", 16], ["w", 256, 126], ["w", 1]] }),
  P("over-8m", "Over 8 MiB: 17 buffers of 512 KiB on a 16 MiB disk", { cap: BIG, sector: 0n, descs: [["r", 16], ["w", 512 * 1024, 17], ["w", 1]] }),
  P("exactly-8m", "Exactly 126 × 64 KiB on a 16 MiB disk", { cap: BIG, sector: 0n, descs: [["r", 16], ["w", SIZE_MAX, SEG_MAX], ["w", 1]] }),
  P("explain-back", "The hostile chain from Explain it back (after you reach that section)", { type: REQ.OUT, sector: 1n << 55n, ro: true, descs: [["r", 8], ["r", 520], ["w", 1]] }, "Then untick read-only, and try wrapping arithmetic (under Later in this chapter)."),
]);

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

// ---- share state -----------------------------------------------------------------------------
//
// `cap=<sectors>;ro=<0|1>;wb=<0|1>;ar=<c|w|p>;t=<type hex>;s=<sector hex>;c=<descs>` then the
// optional `rs=<reserved hex>`, `f=<data byte hex>`, `n=<disk number>` and `p=1` (predict first).
// Descriptors are `r<len>` or `w<len>`, then `x<count>` when a row repeats, joined by `,`.
// Lengths, counts, capacity and disk number are decimal; the rest is hex without 0x.
// The default request encodes as "" (the view then clears the hash).

export const REFERENCE = "cap=64;ro=0;wb=1;ar=w;t=0;s=80000000000000;c=r16,w512,w1";

export function encodeShare(s) {
  if (sameState(s, defaultState())) return "";
  const parts = [
    `cap=${s.cap.toString(10)}`, `ro=${s.ro ? 1 : 0}`, `wb=${s.wb ? 1 : 0}`, `ar=${s.ar}`,
    `t=${s.type.toString(16)}`, `s=${s.sector.toString(16)}`,
    `c=${s.descs.map((d) => `${d.w ? "w" : "r"}${d.len}${d.n > 1 ? `x${d.n}` : ""}`).join(",")}`,
  ];
  if (s.reserved !== 0) parts.push(`rs=${s.reserved.toString(16)}`);
  if (s.fill !== 0x5a) parts.push(`f=${s.fill.toString(16)}`);
  if (s.disk !== 0) parts.push(`n=${s.disk}`);
  if (s.predict) parts.push("p=1");
  return parts.join(";");
}

/** Parse a share string; null for anything malformed (never throws). */
export function decodeShare(str) {
  if (typeof str !== "string" || str === "" || str.length > LIMITS.share) return null;
  const s = defaultState();
  const seen = new Set();
  for (const part of str.split(";")) {
    const m = /^([a-z]{1,3})=([0-9a-zA-Z,]{1,400})$/.exec(part);
    if (!m || seen.has(m[1])) return null;
    seen.add(m[1]);
    const [, k, v] = m;
    const dec = (max) => (/^\d{1,20}$/.test(v) && BigInt(v) <= max ? BigInt(v) : null);
    const hx = (max) => (/^[0-9a-f]{1,16}$/.test(v) && BigInt(`0x${v}`) <= max ? BigInt(`0x${v}`) : null);
    const bit = () => (v === "0" ? false : v === "1" ? true : null);
    let x;
    switch (k) {
      case "cap": x = dec(U64_MAX); if (x === null || x < 1n) return null; s.cap = x; break;
      case "ro": x = bit(); if (x === null) return null; s.ro = x; break;
      case "wb": x = bit(); if (x === null) return null; s.wb = x; break;
      case "p": x = bit(); if (x === null) return null; s.predict = x; break;
      case "ar": if (!["c", "w", "p"].includes(v)) return null; s.ar = v; break;
      case "t": x = hx(BigInt(U32_MAX)); if (x === null) return null; s.type = Number(x); break;
      case "rs": x = hx(BigInt(U32_MAX)); if (x === null) return null; s.reserved = Number(x); break;
      case "s": x = hx(U64_MAX); if (x === null) return null; s.sector = x; break;
      case "f": x = hx(0xffn); if (x === null) return null; s.fill = Number(x); break;
      case "n": x = dec(BigInt(LIMITS.diskIndex)); if (x === null) return null; s.disk = Number(x); break;
      case "c": {
        const rows = v.split(",");
        if (rows.length > LIMITS.rows) return null;
        const descs = [];
        for (const r of rows) {
          const dm = /^([rw])(\d{1,10})(?:x(\d{1,3}))?$/.exec(r);
          if (!dm) return null;
          const len = Number(dm[2]);
          const n = dm[3] === undefined ? 1 : Number(dm[3]);
          if (!isU32(len) || n < 1 || n > LIMITS.repeat) return null;
          descs.push({ w: dm[1] === "w", len, n });
        }
        s.descs = descs;
        break;
      }
      default: return null;
    }
  }
  for (const req of ["cap", "ro", "wb", "ar", "t", "s", "c"]) if (!seen.has(req)) return null;
  return validateState(s) ? null : s;
}

export function sameState(a, b) {
  return a.cap === b.cap && a.ro === b.ro && a.wb === b.wb && a.ar === b.ar && a.type === b.type &&
    a.reserved === b.reserved && a.sector === b.sector && a.fill === b.fill && a.disk === b.disk &&
    a.predict === b.predict && a.descs.length === b.descs.length &&
    a.descs.every((d, i) => d.w === b.descs[i].w && d.len === b.descs[i].len && d.n === b.descs[i].n);
}

/** The prediction choices and how the outcome scores against them. */
export const PREDICTIONS = Object.freeze([
  { value: "ok", label: "OK (0)" },
  { value: "ioerr", label: "IOERR (1)" },
  { value: "unsupp", label: "UNSUPP (2)" },
  { value: "reset", label: "DEVICE_NEEDS_RESET (no status at all)" },
  { value: "panic", label: "The VMM panics (no answer at all)" },
  { value: "backend", label: "A bad offset reaches the disk" },
]);

/** The choices offered for a request: the last two only exist once rule 6's arithmetic is broken. */
export function predictionsFor(s) {
  return s.ar === "c" ? PREDICTIONS.slice(0, 4) : PREDICTIONS.slice();
}

export function outcomeKey(res) {
  const o = res.outcome;
  if (o.kind === "status") return o.status === STATUS.OK ? "ok" : o.status === STATUS.IOERR ? "ioerr" : "unsupp";
  return o.kind; // reset, panic, backend
}
