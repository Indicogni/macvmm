// inflate.mjs: a small, hardened DEFLATE decoder (RFC 1951) for the cpio-inspector lab.
//
// Why write one instead of using the browser's DecompressionStream? The lab must know exactly how
// many *input* bytes one gzip member used, because the kernel's unpacker carries on at the byte
// after it (init/initramfs.c, unpack_to_rootfs: `buf += my_inptr`). DecompressionStream only hands
// back output. It also must cap the output, so a tiny hostile file cannot ask for gigabytes.
//
// Every input byte is untrusted: all reads are bounds-checked, Huffman tables are checked for
// over-subscription and incompleteness, back-references are checked against the output so far,
// and the output is capped. Errors are values ({ error }), never exceptions escaping to the page.
// Pure module: no DOM, no I/O.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class InflateError extends Error {}
const fail = (msg) => { throw new InflateError(msg); };

/**
 * Build a lookup table from code lengths (canonical Huffman, RFC 1951 section 3.2.2).
 * Returns { table, bits }: table[i] = (symbol << 4) | length for the code whose bit-reversed
 * value is i (low `length` bits); 0 marks an unused slot.
 */
function buildTable(lengths, allowIncomplete) {
  let max = 0;
  const count = new Uint16Array(16);
  for (const l of lengths) { if (l) { count[l]++; if (l > max) max = l; } }
  if (max === 0) return { table: new Uint32Array(1), bits: 1, empty: true };
  // Check the code space: over-subscribed is always an error; incomplete is allowed only for
  // the single-code distance case the RFC permits.
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - count[len];
    if (left < 0) fail("over-subscribed Huffman code");
  }
  if (left > 0 && !allowIncomplete) fail("incomplete Huffman code");
  const next = new Uint16Array(16);
  let code = 0;
  for (let len = 1; len <= 15; len++) { code = (code + count[len - 1]) << 1; next[len] = code; }
  const table = new Uint32Array(1 << max);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    let c = next[len]++;
    let rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | (c & 1); c >>= 1; }
    for (let i = rev; i < table.length; i += 1 << len) table[i] = (sym << 4) | len;
  }
  return { table, bits: max };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: buildTable(l, false), dist: buildTable(d, true) };
  return FIXED;
}

/**
 * Inflate a raw DEFLATE stream starting at `start` in `src` (a Uint8Array).
 * Options: { maxOut } output cap in bytes (default 128 MiB).
 * Returns { out, consumed, end: true } when the final block ended (consumed counts whole bytes
 * from `start`, the last partial byte included), or { out, consumed, error, truncated } where
 * `truncated` is true when the input ran out before the stream ended, `capped` when the output
 * cap was hit, and `out` holds what was produced before the error.
 */
const INITIAL_OUT = 64 * 1024;

export function inflateRaw(src, start = 0, opts = {}) {
  const maxOut = opts.maxOut ?? 128 * 1024 * 1024;
  let pos = start;
  let bitBuf = 0;
  let bitCnt = 0;
  // Start small and let grow() double. Sizing this from the input that is left would give every
  // member of a many-member archive megabytes up front: 1,024 members at the head of a 2 MiB
  // file came to about 8 GiB of buffers.
  let out = new Uint8Array(Math.min(maxOut, INITIAL_OUT, Math.max(1024, (src.length - start) * 4)));
  let outLen = 0;
  let truncated = false;
  let capped = false;

  const need = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) { truncated = true; fail("input ended inside the compressed stream"); }
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
  };
  const bits = (n) => {
    if (n === 0) return 0;
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const grow = (extra) => {
    const want = outLen + extra;
    if (want > maxOut) { capped = true; fail(`output larger than the lab's ${maxOut} byte cap`); }
    if (want <= out.length) return;
    let size = out.length * 2;
    while (size < want) size *= 2;
    const next = new Uint8Array(Math.min(size, maxOut));
    next.set(out.subarray(0, outLen));
    out = next;
  };
  const decode = (t) => {
    // Pull in up to t.bits bits, but at the very end of the input accept a shorter code.
    while (bitCnt < t.bits && pos < src.length) { bitBuf |= src[pos++] << bitCnt; bitCnt += 8; }
    const e = t.table[bitBuf & ((1 << t.bits) - 1)];
    const len = e & 15;
    if (len === 0) fail("invalid Huffman code");
    if (len > bitCnt) { truncated = true; fail("input ended inside the compressed stream"); }
    bitBuf >>>= len;
    bitCnt -= len;
    return e >>> 4;
  };

  try {
    let final = 0;
    do {
      final = bits(1);
      const type = bits(2);
      if (type === 0) {
        // Drop to a byte boundary, giving back whole bytes the decoder read ahead.
        pos -= bitCnt >> 3;
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > src.length) { truncated = true; fail("input ended inside a stored block header"); }
        const len = src[pos] | (src[pos + 1] << 8);
        const nlen = src[pos + 2] | (src[pos + 3] << 8);
        pos += 4;
        if ((len ^ 0xffff) !== nlen) fail("stored block length check failed");
        if (pos + len > src.length) { truncated = true; fail("input ended inside a stored block"); }
        grow(len);
        out.set(src.subarray(pos, pos + len), outLen);
        outLen += len;
        pos += len;
      } else if (type === 1 || type === 2) {
        let lit, dist;
        if (type === 1) ({ lit, dist } = fixedTables());
        else {
          const hlit = bits(5) + 257;
          const hdist = bits(5) + 1;
          const hclen = bits(4) + 4;
          if (hlit > 286 || hdist > 30) fail("too many length or distance codes");
          const cl = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
          const clt = buildTable(cl, false);
          const lens = new Uint8Array(hlit + hdist);
          let i = 0;
          while (i < hlit + hdist) {
            const sym = decode(clt);
            if (sym < 16) { lens[i++] = sym; continue; }
            let rep, val = 0;
            if (sym === 16) {
              if (i === 0) fail("repeat with no previous length");
              val = lens[i - 1]; rep = 3 + bits(2);
            } else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > hlit + hdist) fail("code lengths overflow the table");
            lens.fill(val, i, i + rep);
            i += rep;
          }
          if (lens[256] === 0) fail("no end-of-block code");
          lit = buildTable(lens.subarray(0, hlit), false);
          // A distance code with one used symbol is allowed to be incomplete (RFC 1951 3.2.7).
          let used = 0;
          for (const l of lens.subarray(hlit)) if (l) used++;
          dist = buildTable(lens.subarray(hlit), used <= 1);
        }
        for (;;) {
          const sym = decode(lit);
          if (sym < 256) { grow(1); out[outLen++] = sym; continue; }
          if (sym === 256) break;
          const li = sym - 257;
          if (li >= 29) fail("invalid length symbol");
          const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
          if (dist.empty) fail("distance code used but none defined");
          const di = decode(dist);
          if (di >= 30) fail("invalid distance symbol");
          const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
          if (d > outLen) fail("distance too far back");
          grow(len);
          let from = outLen - d;
          for (let k = 0; k < len; k++) out[outLen++] = out[from++];
        }
      } else {
        fail("invalid block type 3");
      }
    } while (!final);
  } catch (e) {
    if (!(e instanceof InflateError)) throw e;
    return { out: out.subarray(0, outLen), consumed: pos - start, error: e.message, truncated, capped };
  }
  // Unused whole bytes in the bit buffer were read ahead; give them back.
  pos -= bitCnt >> 3;
  return { out: out.subarray(0, outLen), consumed: pos - start, end: true };
}

let CRC_TABLE = null;
/** CRC-32 (the gzip trailer's checksum, RFC 1952 section 8). */
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
