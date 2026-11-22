// frame-dissector model: pure logic, no DOM. See course/site/LABS.md section 3.
//
// What it does. It takes the bytes of one virtio-net buffer, a 12-byte `struct virtio_net_hdr`
// followed by an Ethernet frame (chapter 19), and splits them into named fields: the header
// (virtio 1.2 section 5.1.6), Ethernet II (IEEE 802.3 clause 3, EtherType per IEEE 802), and
// the protocol after it: ARP (RFC 826), IPv4 (RFC 791) with ICMP (RFC 792), or IPv6 (RFC 8200)
// with ICMPv6 (RFC 4443, router solicitation RFC 4861). Checksums are recomputed (RFC 1071).
//
// Then it answers two questions:
//   1. What does macvmm's virtio-net device do with this buffer? For a transmitted buffer this is
//      a port of `Net::tx_one` and `header_ok` in crates/vmm/src/virtio/net.rs: the chain length
//      rule (26..=1526) first, then flags and gso_type on the copy, then the backend. For a
//      received frame it is the `Net::receive` length rule (14..=1514) and the header it writes.
//   2. What does the receiving guest's network stack do with the frame? A simplified Linux:
//      the Ethernet destination filter, then ARP, IPv4 and ICMP as a host (not a router) would.
//
// The "strip" option is chapter 19's Predict: a broken device that strips a 10-byte header
// (the pre-1.0 legacy size) while the driver writes 12, so every frame arrives two bytes late.
//
// Every input is hostile: the parser caps the size, every read is bounds-checked, every
// length field is compared with the bytes that are really there, and nothing loops on a
// guest-written count.

/** The largest buffer the lab accepts: more than macvmm's 2048-byte RX buffer. */
export const MAX_BYTES = 4096;

// The reference's constants (crates/vmm/src/virtio/net.rs and net/backend.rs). The model test
// re-reads them from the Rust source so they cannot drift.
export const HDR_LEN = 12;
export const LEGACY_HDR_LEN = 10;
export const ETH_HDR_LEN = 14;
export const ETH_MIN_FRAME = 14;
export const ETH_MAX_FRAME = 1514;
export const MIN_TX_CHAIN = 26;
export const MAX_TX_CHAIN = 1526;

/** The two VMs of chapter 19's runs. */
export const VMS = {
  a: { id: "a", name: "VM A", mac: [0x02, 0x6d, 0x76, 0x00, 0x00, 0x01], ip: [10, 0, 0, 1] },
  b: { id: "b", name: "VM B", mac: [0x02, 0x6d, 0x76, 0x00, 0x00, 0x02], ip: [10, 0, 0, 2] },
};

/**
 * True for the ids VMS really has. `VMS[id]` alone is also truthy for "constructor", "toString"
 * and every other name on Object.prototype, and the id can come from a share link.
 */
export function isVm(id) {
  return typeof id === "string" && Object.hasOwn(VMS, id);
}

export const LAYERS = {
  hdr: "virtio-net header",
  eth: "Ethernet",
  arp: "ARP",
  ip: "IPv4",
  icmp: "ICMP",
  ip6: "IPv6",
  icmp6: "ICMPv6",
  data: "payload",
  pad: "padding",
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

export function hex(n, digits = 2) {
  return `0x${n.toString(16).padStart(digits, "0")}`;
}

export function bytesHex(bytes, sep = " ") {
  const out = [];
  for (const b of bytes) out.push(b.toString(16).padStart(2, "0"));
  return out.join(sep);
}

export function formatMac(b) {
  return bytesHex(b, ":");
}

export function formatIp4(b) {
  return [...b].join(".");
}

/** RFC 5952 text form: lower case, no leading zeros, the longest run of 2+ zero groups as `::`. */
export function formatIp6(b) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push((b[i] << 8) | b[i + 1]);
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const part = (a) => a.map((x) => x.toString(16)).join(":");
  if (best < 0) return part(g);
  return `${part(g.slice(0, best))}::${part(g.slice(best + bestLen))}`;
}

function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function same(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }

/** The RFC 1071 Internet checksum of `bytes` (an odd last byte is padded with zero). */
export function inetChecksum(bytes, initial = 0) {
  let sum = initial;
  for (let i = 0; i + 1 < bytes.length; i += 2) sum += (bytes[i] << 8) | bytes[i + 1];
  if (bytes.length % 2) sum += bytes[bytes.length - 1] << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

function pseudo6(src, dst, len, next) {
  // The IPv6 pseudo-header (RFC 8200 section 8.1), summed but not complemented.
  const p = [...src, ...dst, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, 0, 0, 0, next];
  let sum = 0;
  for (let i = 0; i < p.length; i += 2) sum += (p[i] << 8) | p[i + 1];
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return sum;
}

function macName(m) {
  if (m.every((x) => x === 0xff)) return "broadcast";
  for (const vm of Object.values(VMS)) if (same(m, vm.mac)) return `${vm.name}'s MAC`;
  if (m[0] === 0x33 && m[1] === 0x33) return "IPv6 multicast";
  if (m.every((x) => x === 0)) return "all zeros: unknown";
  const kind = [];
  kind.push(m[0] & 1 ? "multicast" : "unicast");
  kind.push(m[0] & 2 ? "locally administered" : "manufacturer-assigned");
  return kind.join(", ");
}

function ipName(a) {
  for (const vm of Object.values(VMS)) if (same(a, vm.ip)) return vm.name;
  if (a.every((x) => x === 255)) return "broadcast";
  if (a.every((x) => x === 0)) return "unspecified";
  return "";
}

export const ETHERTYPES = {
  0x0800: "IPv4",
  0x0806: "ARP",
  0x86dd: "IPv6",
  0x8100: "VLAN tag",
  0x88cc: "LLDP",
};

const GSO_TYPES = { 0: "GSO_NONE, no segmentation", 1: "GSO_TCPV4", 3: "GSO_UDP", 4: "GSO_TCPV6", 5: "GSO_UDP_L4" };
const HDR_FLAGS = [[1, "NEEDS_CSUM"], [2, "DATA_VALID"], [4, "RSC_INFO"]];
const ICMP_TYPES = { 0: "echo reply", 3: "destination unreachable", 5: "redirect", 8: "echo request", 11: "time exceeded" };
const ICMP6_TYPES = {
  1: "destination unreachable", 2: "packet too big", 3: "time exceeded", 128: "echo request", 129: "echo reply",
  133: "router solicitation", 134: "router advertisement", 135: "neighbour solicitation",
  136: "neighbour advertisement", 143: "multicast listener report v2",
};
const IP_PROTOS = { 1: "ICMP", 6: "TCP", 17: "UDP", 58: "ICMPv6" };

// ---------------------------------------------------------------------------------------------
// Hex input
// ---------------------------------------------------------------------------------------------

/**
 * Parse hex text into bytes. Accepts spaces, newlines, `:`, `-`, `,`, `_` between digits and an
 * optional `0x` before each group. Returns `{ bytes }` or `{ error }`; never throws.
 */
export function parseHex(text) {
  if (typeof text !== "string") return { error: "no text" };
  if (text.length > MAX_BYTES * 5 + 64) return { error: `too long: at most ${MAX_BYTES} bytes` };
  const groups = text.split(/[\s:,\-_]+/).filter(Boolean);
  let digits = "";
  for (const g0 of groups) {
    const g = /^0x/i.test(g0) ? g0.slice(2) : g0;
    const bad = g.search(/[^0-9a-fA-F]/);
    if (bad >= 0) return { error: `"${g0.slice(0, 12)}" is not hex` };
    digits += g;
    if (digits.length > MAX_BYTES * 2) return { error: `too long: at most ${MAX_BYTES} bytes` };
  }
  if (digits.length % 2) return { error: "an odd number of hex digits: every byte needs two" };
  const bytes = [];
  for (let i = 0; i < digits.length; i += 2) bytes.push(parseInt(digits.slice(i, i + 2), 16));
  return { bytes };
}

/** Format bytes as lines of 16, the way the hex box shows them. */
export function formatHexLines(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) lines.push(bytesHex(bytes.slice(i, i + 16)));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------------

const ZERO_HDR = Array(12).fill(0);
const RX_HDR = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]; // num_buffers = 1, little-endian

function eth(dst, src, type) {
  return [...dst, ...src, type >> 8, type & 0xff];
}

function arp(op, sha, spa, tha, tpa) {
  return [0x00, 0x01, 0x08, 0x00, 6, 4, 0x00, op, ...sha, ...spa, ...tha, ...tpa];
}

function ipv4(src, dst, proto, id, payload) {
  const total = 20 + payload.length;
  const h = [0x45, 0x00, total >> 8, total & 0xff, id >> 8, id & 0xff, 0x40, 0x00, 64, proto, 0, 0, ...src, ...dst];
  const c = inetChecksum(h);
  h[10] = c >> 8;
  h[11] = c & 0xff;
  return [...h, ...payload];
}

function icmpEcho(type, ident, seq, data) {
  const m = [type, 0, 0, 0, ident >> 8, ident & 0xff, seq >> 8, seq & 0xff, ...data];
  const c = inetChecksum(m);
  m[2] = c >> 8;
  m[3] = c & 0xff;
  return m;
}

function pingData(n) {
  return Array.from({ length: n }, (_, i) => i & 0xff);
}

const LL_B = [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0x00, 0x6d, 0x76, 0xff, 0xfe, 0x00, 0x00, 0x02];
const ALL_ROUTERS = [0xff, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02];

function routerSolicitation() {
  const body = [133, 0, 0, 0, 0, 0, 0, 0, 1, 1, ...VMS.b.mac];
  const c = inetChecksum(body, pseudo6(LL_B, ALL_ROUTERS, body.length, 58));
  body[2] = c >> 8;
  body[3] = c & 0xff;
  const h = [0x60, 0, 0, 0, 0, body.length, 58, 255, ...LL_B, ...ALL_ROUTERS];
  return [...h, ...body];
}

const A = VMS.a, B = VMS.b;
const BCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const ZMAC = [0, 0, 0, 0, 0, 0];

const ARP_REQ = [...ZERO_HDR, ...eth(BCAST, A.mac, 0x0806), ...arp(1, A.mac, A.ip, ZMAC, B.ip)];

/**
 * The preset buffers. `source` says where the bytes come from: "lesson" (chapter 19 prints
 * them), or "built" (assembled by this model from the protocol rules, with correct checksums,
 * because no run recorded the bytes; the lab labels them so).
 */
export const PRESETS = [
  {
    id: "arp", dir: "tx", to: "b", source: "lesson",
    title: "ARP request from VM A (the lesson's)",
    bytes: ARP_REQ,
  },
  {
    id: "arp-reply", dir: "rx", to: "a", source: "built",
    title: "ARP reply, as VM A's driver reads it",
    bytes: [...RX_HDR, ...eth(A.mac, B.mac, 0x0806), ...arp(2, B.mac, B.ip, A.mac, A.ip)],
  },
  {
    id: "ping", dir: "tx", to: "b", source: "built",
    title: "Ping (ICMP echo request) from VM A",
    bytes: [...ZERO_HDR, ...eth(B.mac, A.mac, 0x0800), ...ipv4(A.ip, B.ip, 1, 0x3c1d, icmpEcho(8, 0x0042, 1, pingData(56)))],
  },
  {
    id: "pong", dir: "rx", to: "a", source: "built",
    title: "Ping answer (echo reply), as VM A's driver reads it",
    bytes: [...RX_HDR, ...eth(A.mac, B.mac, 0x0800), ...ipv4(B.ip, A.ip, 1, 0x91e4, icmpEcho(0, 0x0042, 1, pingData(56)))],
  },
  {
    id: "rs", dir: "tx", to: "a", source: "built",
    title: "IPv6 router solicitation from VM B (70 bytes)",
    bytes: [...ZERO_HDR, ...eth([0x33, 0x33, 0, 0, 0, 2], B.mac, 0x86dd), ...routerSolicitation()],
  },
  {
    id: "csum", dir: "tx", to: "b", source: "built",
    title: "Header asks for checksum offload (flags = 1)",
    bytes: [1, ...ARP_REQ.slice(1)],
  },
  {
    id: "short", dir: "tx", to: "b", source: "built",
    title: "Too short: 12 + 10 bytes",
    bytes: ARP_REQ.slice(0, 22),
  },
  {
    id: "big", dir: "tx", to: "b", source: "built",
    title: "Too long: a 1515-byte frame (a 1501-byte IPv4 packet in one frame)",
    bytes: [...ZERO_HDR, ...eth(B.mac, A.mac, 0x0800), ...ipv4(A.ip, B.ip, 1, 0x3c1e, icmpEcho(8, 0x0042, 2, pingData(1473)))],
  },
];

export function preset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/** The default state: the lesson's ARP request, transmitted by A, the device stripping 12. */
export const DEFAULT = Object.freeze({ preset: "arp", bytes: null, dir: "tx", strip: 12, to: "b" });

/** The share-state reference: the Predict's answer (the lesson's ARP request, 10 bytes stripped). */
export const REFERENCE = "p=arp;h=10";

// ---------------------------------------------------------------------------------------------
// The dissector
// ---------------------------------------------------------------------------------------------

/**
 * A cursor over `bytes` that emits fields. `take(n)` returns the offset of the next `n` bytes,
 * or -1 (after emitting one "truncated" field) if fewer remain.
 */
function cursor(bytes, fields) {
  const c = {
    pos: 0,
    end: bytes.length,
    truncated: false,
    take(n, layer, what) {
      if (c.truncated) return -1;
      if (c.pos + n > c.end) {
        const left = c.end - c.pos;
        fields.push({
          layer, off: c.pos, len: left, name: `${what} (cut short)`, value: `${left} of ${n} bytes`,
          status: "bad", check: "truncated", note: `The buffer ends ${n - left} byte${n - left === 1 ? "" : "s"} too early.`,
        });
        c.pos = c.end;
        c.truncated = true;
        return -1;
      }
      const o = c.pos;
      c.pos += n;
      return o;
    },
  };
  return c;
}

function field(fields, bytes, layer, off, len, name, value, extra = {}) {
  fields.push({ layer, off, len, name, value, status: "ok", check: "", note: "", ...extra, hex: bytesHex(bytes.slice(off, off + len)) });
}

function dissectHeader(b, c, fields, dir, strip) {
  const tx = dir === "tx";
  const out = { flags: null, gso: null };
  let o = c.take(1, "hdr", "flags");
  if (o < 0) return out;
  const flags = b[o];
  out.flags = flags;
  const names = HDR_FLAGS.filter(([m]) => flags & m).map(([, n]) => n);
  const unknown = flags & ~7;
  const fv = flags === 0 ? "0" : `${hex(flags)}${names.length ? ` (${names.join(", ")}${unknown ? ", unknown bits" : ""})` : " (unknown bits)"}`;
  field(fields, b, "hdr", o, 1, "flags", fv, flags === 0
    ? { note: tx ? "The driver must send 0: no offload was negotiated." : "The device writes 0." }
    : { status: "bad", check: tx ? "drop" : "unexpected", note: tx ? "Non-zero asks the device to do work on the frame (an offload we never offered), so the device drops it." : "macvmm's device always writes 0 here." });

  o = c.take(1, "hdr", "gso_type");
  if (o < 0) return out;
  const gso = b[o];
  out.gso = gso;
  const gname = GSO_TYPES[gso & 0x7f] ?? "unknown type";
  const gv = gso === 0 ? "0, GSO_NONE: no segmentation" : `${hex(gso)} (${gname}${gso & 0x80 ? ", ECN" : ""})`;
  field(fields, b, "hdr", o, 1, "gso_type", gv, gso === 0
    ? { note: tx ? "The driver must send 0." : "The device writes 0." }
    : { status: "bad", check: tx ? "drop" : "unexpected", note: tx ? "Non-zero asks the device to cut the packet into frames (segmentation offload, not offered), so the device drops it." : "macvmm's device always writes 0 here." });

  for (const [off, name] of [[2, "hdr_len"], [4, "gso_size"], [6, "csum_start"], [8, "csum_offset"]]) {
    o = c.take(2, "hdr", name);
    if (o < 0) return out;
    const v = u16le(b, o);
    field(fields, b, "hdr", o, 2, `${name} (offset ${off})`, `${v}`, {
      status: v === 0 ? "ok" : "info", check: "ignored",
      note: tx ? "Means nothing without an offload; the device never reads it." : "The device writes 0.",
    });
  }
  if (strip === LEGACY_HDR_LEN) return out;
  o = c.take(2, "hdr", "num_buffers");
  if (o < 0) return out;
  const nb = u16le(b, o);
  if (tx) {
    field(fields, b, "hdr", o, 2, "num_buffers (offset 10)", `${nb}`, {
      status: nb === 0 ? "ok" : "info", check: "ignored",
      note: "On transmit the driver writes 0 and the device does not look.",
    });
  } else {
    field(fields, b, "hdr", o, 2, "num_buffers (offset 10)", `${nb}`, nb === 1
      ? { note: "The device writes 1: the packet fits one buffer (no mergeable receive buffers)." }
      : { status: "warn", check: "not 1", note: "Without mergeable receive buffers the device must write 1 (virtio 1.2 section 5.1.6.4.1)." });
  }
  return out;
}

function receiverOf(to) {
  return isVm(to) ? VMS[to] : VMS.b;
}

function dissectEthernet(b, c, fields, me) {
  const o = c.take(ETH_HDR_LEN, "eth", "Ethernet header");
  if (o < 0) return null;
  return ethFields(b, o, fields, me);
}

/** What Linux's eth_type_trans makes of a type field below 0x0600 (an 802.3 length). */
function lengthNote(b, o) {
  const n = b.length - (o + 14);
  if (n >= 2 && b[o + 14] === 0xff && b[o + 15] === 0xff) {
    return "Below 0x0600 the field is read as an IEEE 802.3 length, not a type. The next two bytes are ff ff, so Linux takes it for raw 802.3 (old Novell IPX) and finds no protocol bound to it.";
  }
  if (n >= 2) {
    return `Below 0x0600 the field is read as an IEEE 802.3 length, not a type. Linux then reads the next bytes as an 802.2 LLC header (here DSAP ${hex(b[o + 14])}, SSAP ${hex(b[o + 15])}) and finds no protocol bound to it.`;
  }
  return "Below 0x0600 the field is read as an IEEE 802.3 length, not a type. Linux would read the next bytes as an 802.2 LLC header, and this frame ends first.";
}

function ethFields(b, o, fields, me) {
  const dst = b.slice(o, o + 6), src = b.slice(o + 6, o + 12), type = u16be(b, o + 12);
  const dstNote = dst.every((x) => x === 0xff) ? "Every NIC on the wire takes a broadcast."
    : same(dst, me.mac) ? `This is ${me.name}'s address.`
    : dst[0] & 1 ? "A multicast group address (lowest bit of the first byte set)."
    : `Not ${me.name}'s address (${formatMac(me.mac)}).`;
  field(fields, b, "eth", o, 6, "destination MAC", `${formatMac(dst)} (${macName(dst)})`, { note: dstNote });
  field(fields, b, "eth", o + 6, 6, "source MAC", `${formatMac(src)} (${macName(src)})`, {
    note: src[0] & 1 ? "A source address with the multicast bit set: no NIC sends from such an address." : (src[0] & 2 ? "Bit 1 of the first byte set: locally administered, no manufacturer owns it." : ""),
    status: src[0] & 1 ? "warn" : "ok", check: src[0] & 1 ? "not a NIC" : "",
  });
  let tv, extra = {};
  if (type >= 0x0600) {
    tv = `${hex(type, 4)} (${ETHERTYPES[type] ?? "a type this lab does not decode"})`;
    extra.note = "At least 0x0600, so it names the protocol that follows (Ethernet II).";
  } else if (type <= 1500) {
    tv = `${hex(type, 4)} (an 802.3 length: ${type} bytes)`;
    extra = { status: "warn", check: "length, not type", note: lengthNote(b, o) };
  } else {
    tv = `${hex(type, 4)} (neither a length nor a type)`;
    extra = { status: "bad", check: "invalid", note: "Values 1501 to 1535 are undefined." };
  }
  field(fields, b, "eth", o + 12, 2, "EtherType", tv, extra);
  return { dst, src, type };
}

function dissectArp(b, c, fields) {
  const o = c.take(8, "arp", "ARP header");
  if (o < 0) return null;
  const htype = u16be(b, o), ptype = u16be(b, o + 2), hlen = b[o + 4], plen = b[o + 5], op = u16be(b, o + 6);
  field(fields, b, "arp", o, 2, "hardware type", `${htype}${htype === 1 ? " (Ethernet)" : ""}`, htype === 1 ? {} : { status: "warn", check: "not Ethernet" });
  field(fields, b, "arp", o + 2, 2, "protocol type", `${hex(ptype, 4)}${ptype === 0x0800 ? " (IPv4)" : ""}`, ptype === 0x0800 ? {} : { status: "warn", check: "not IPv4" });
  field(fields, b, "arp", o + 4, 1, "hardware size", `${hlen}`, hlen === 6 ? {} : { status: "warn", check: "not 6" });
  field(fields, b, "arp", o + 5, 1, "protocol size", `${plen}`, plen === 4 ? {} : { status: "warn", check: "not 4" });
  field(fields, b, "arp", o + 6, 2, "operation", `${op}${op === 1 ? " (request)" : op === 2 ? " (reply)" : ""}`, op === 1 || op === 2 ? {} : { status: "warn", check: "unknown" });
  if (htype !== 1 || ptype !== 0x0800 || hlen !== 6 || plen !== 4) {
    return { op, ok: false };
  }
  const p = c.take(20, "arp", "ARP addresses");
  if (p < 0) return { op, ok: false, truncated: true };
  const sha = b.slice(p, p + 6), spa = b.slice(p + 6, p + 10), tha = b.slice(p + 10, p + 16), tpa = b.slice(p + 16, p + 20);
  const nm = (a) => (ipName(a) ? ` (${ipName(a)})` : "");
  field(fields, b, "arp", p, 6, "sender MAC", `${formatMac(sha)} (${macName(sha)})`);
  field(fields, b, "arp", p + 6, 4, "sender IP", `${formatIp4(spa)}${nm(spa)}`);
  field(fields, b, "arp", p + 10, 6, "target MAC", `${formatMac(tha)}${tha.every((x) => x === 0) ? " (unknown: that is the question)" : ` (${macName(tha)})`}`);
  field(fields, b, "arp", p + 16, 4, "target IP", `${formatIp4(tpa)}${nm(tpa)}`);
  return { op, ok: true, sha, spa, tha, tpa };
}

function dissectIcmp(b, c, fields, len) {
  const o = c.take(4, "icmp", "ICMP header");
  if (o < 0) return null;
  const type = b[o], code = b[o + 1], sum = u16be(b, o + 2);
  const msg = b.slice(o, o + len);
  const ok = msg.length === len && inetChecksum(msg) === 0;
  const want = (() => { const m = [...msg]; m[2] = 0; m[3] = 0; return inetChecksum(m); })();
  field(fields, b, "icmp", o, 1, "type", `${type} (${ICMP_TYPES[type] ?? "not decoded here"})`);
  field(fields, b, "icmp", o + 1, 1, "code", `${code}`);
  field(fields, b, "icmp", o + 2, 2, "checksum", `${hex(sum, 4)} (${ok ? "correct" : `wrong: should be ${hex(want, 4)}`})`, ok
    ? { check: "ok", note: "Over the whole ICMP message." }
    : { status: "bad", check: "bad checksum", note: "The receiver drops an ICMP message whose checksum fails." });
  let ident = null, seq = null;
  if ((type === 0 || type === 8) && len >= 8) {
    const q = c.take(4, "icmp", "echo identifier and sequence");
    if (q < 0) return { type, code, ok };
    ident = u16be(b, q);
    seq = u16be(b, q + 2);
    field(fields, b, "icmp", q, 2, "identifier", `${ident} (${hex(ident, 4)})`, { note: "Chosen by ping, copied into the answer." });
    field(fields, b, "icmp", q + 2, 2, "sequence", `${seq}`, { note: "Counts the pings; copied into the answer." });
  }
  const rest = o + len - c.pos;
  if (rest > 0) {
    const d = c.take(rest, "data", "ICMP data");
    if (d >= 0) field(fields, b, "data", d, rest, type === 0 || type === 8 ? "echo data" : "rest of the message", `${rest} byte${rest === 1 ? "" : "s"}`, { note: type === 0 || type === 8 ? "Whatever ping put here; the answer carries it back unchanged." : "" });
  }
  return { type, code, ok, ident, seq };
}

function dissectIpv4(b, c, fields) {
  const start = c.pos;
  const o = c.take(20, "ip", "IPv4 header");
  if (o < 0) return null;
  const vihl = b[o], ver = vihl >> 4, ihl = vihl & 15;
  const total = u16be(b, o + 2), id = u16be(b, o + 4), ff = u16be(b, o + 6);
  const ttl = b[o + 8], proto = b[o + 9], sum = u16be(b, o + 10);
  const src = b.slice(o + 12, o + 16), dst = b.slice(o + 16, o + 20);
  const hlen = ihl * 4;
  field(fields, b, "ip", o, 1, "version, header length", `version ${ver}, ${ihl} words = ${hlen} bytes`,
    ver === 4 && ihl >= 5 ? {} : { status: "bad", check: ver !== 4 ? "not 4" : "under 5", note: "Version must be 4 and the header at least 5 words (20 bytes)." });
  field(fields, b, "ip", o + 1, 1, "DSCP, ECN", `${hex(b[o + 1])}`, { note: "Priority and congestion marks; 0 is ordinary traffic." });
  const avail = c.end - start;
  const totOk = total >= hlen && total <= avail;
  field(fields, b, "ip", o + 2, 2, "total length", `${total} bytes`, totOk
    ? { note: avail > total ? `The frame carries ${avail - total} more bytes than the packet: Ethernet padding.` : "Header plus data." }
    : { status: "bad", check: total > avail ? "longer than the frame" : "shorter than its header", note: `The frame holds ${avail} bytes from here.` });
  field(fields, b, "ip", o + 4, 2, "identification", `${id} (${hex(id, 4)})`, { note: "Ties the fragments of one packet together." });
  const df = (ff & 0x4000) !== 0, mf = (ff & 0x2000) !== 0, frag = ff & 0x1fff;
  field(fields, b, "ip", o + 6, 2, "flags, fragment offset", `${[df ? "DF (don't fragment)" : "", mf ? "MF (more fragments)" : ""].filter(Boolean).join(", ") || "no flags"}, offset ${frag * 8}`,
    mf || frag ? { status: "info", check: "fragment", note: "A piece of a larger packet; this lab does not reassemble." } : {});
  field(fields, b, "ip", o + 8, 1, "time to live", `${ttl}`, { note: "Each router subtracts 1; 64 is Linux's default." });
  field(fields, b, "ip", o + 9, 1, "protocol", `${proto} (${IP_PROTOS[proto] ?? "not decoded here"})`);
  let hdrOk = false, want = 0;
  if (ihl >= 5 && start + hlen <= c.end) {
    const hb = b.slice(start, start + hlen);
    hdrOk = inetChecksum(hb) === 0;
    hb[10] = 0;
    hb[11] = 0;
    want = inetChecksum(hb);
  }
  field(fields, b, "ip", o + 10, 2, "header checksum", `${hex(sum, 4)} (${hdrOk ? "correct" : ihl < 5 ? "cannot check" : `wrong: should be ${hex(want, 4)}`})`, hdrOk
    ? { check: "ok", note: "Over the header only." }
    : { status: "bad", check: "bad checksum", note: "The receiver drops a packet whose header checksum fails, without a word." });
  const nm = (a) => (ipName(a) ? ` (${ipName(a)})` : "");
  field(fields, b, "ip", o + 12, 4, "source IP", `${formatIp4(src)}${nm(src)}`);
  field(fields, b, "ip", o + 16, 4, "destination IP", `${formatIp4(dst)}${nm(dst)}`);
  const info = { ver, ihl, total, ttl, proto, src, dst, hdrOk, totOk, frag: mf || frag !== 0, icmp: null };
  if (ver !== 4 || ihl < 5) return info;
  if (hlen > 20) {
    const q = c.take(hlen - 20, "ip", "IPv4 options");
    if (q < 0) return info;
    field(fields, b, "ip", q, hlen - 20, "options", `${hlen - 20} bytes`, { status: "info", check: "not decoded" });
  }
  if (!totOk) return info;
  const plen = total - hlen;
  c.end = start + total; // the rest of the frame is padding, dissected by the caller
  if (proto === 1 && !info.frag && plen >= 4) {
    info.icmp = dissectIcmp(b, c, fields, plen);
  } else if (plen > 0) {
    const q = c.take(plen, "data", "IPv4 payload");
    if (q >= 0) field(fields, b, "data", q, plen, `${IP_PROTOS[proto] ?? `protocol ${proto}`} data`, `${plen} bytes`, { status: "info", check: "not decoded" });
  }
  return info;
}

function dissectIpv6(b, c, fields) {
  const start = c.pos;
  const o = c.take(40, "ip6", "IPv6 header");
  if (o < 0) return null;
  const ver = b[o] >> 4;
  const plen = u16be(b, o + 4), next = b[o + 6], hop = b[o + 7];
  const src = b.slice(o + 8, o + 24), dst = b.slice(o + 24, o + 40);
  field(fields, b, "ip6", o, 4, "version, class, flow label", `version ${ver}`, ver === 6 ? {} : { status: "bad", check: "not 6" });
  const avail = c.end - start - 40;
  const ok = plen <= avail;
  field(fields, b, "ip6", o + 4, 2, "payload length", `${plen} bytes`, ok ? {} : { status: "bad", check: "longer than the frame", note: `The frame holds ${avail} bytes after this header.` });
  field(fields, b, "ip6", o + 6, 1, "next header", `${next} (${IP_PROTOS[next] ?? "not decoded here"})`);
  field(fields, b, "ip6", o + 7, 1, "hop limit", `${hop}`, { note: hop === 255 ? "255: neighbour discovery messages must arrive with 255, proof they came from this link." : "" });
  field(fields, b, "ip6", o + 8, 16, "source IP", formatIp6(src), { note: src[0] === 0xfe && (src[1] & 0xc0) === 0x80 ? "Link-local (fe80::/10): valid only on this wire." : "" });
  field(fields, b, "ip6", o + 24, 16, "destination IP", formatIp6(dst), { note: same(dst, ALL_ROUTERS) ? "ff02::2, all routers on this link." : dst[0] === 0xff ? "A multicast group." : "" });
  const info = { ver, plen, next, src, dst, ok, icmp: null };
  if (ver !== 6 || !ok) return info;
  c.end = start + 40 + plen;
  if (next === 58 && plen >= 4) {
    const q = c.take(4, "icmp6", "ICMPv6 header");
    if (q < 0) return info;
    const msg = b.slice(q, q + plen);
    const sumOk = inetChecksum(msg, pseudo6(src, dst, plen, 58)) === 0;
    const type = b[q];
    field(fields, b, "icmp6", q, 1, "type", `${type} (${ICMP6_TYPES[type] ?? "not decoded here"})`);
    field(fields, b, "icmp6", q + 1, 1, "code", `${b[q + 1]}`);
    field(fields, b, "icmp6", q + 2, 2, "checksum", `${hex(u16be(b, q + 2), 4)} (${sumOk ? "correct" : "wrong"})`, sumOk
      ? { check: "ok", note: "Over the message and a pseudo-header of both addresses." }
      : { status: "bad", check: "bad checksum" });
    info.icmp = { type, ok: sumOk };
    const rest = plen - 4;
    if (rest > 0) {
      const d = c.take(rest, "data", "ICMPv6 body");
      if (d >= 0) field(fields, b, "data", d, rest, type === 133 ? "reserved, then a source MAC option" : "message body", `${rest} bytes`, { status: "info", check: "not decoded" });
    }
  } else if (plen > 0) {
    const d = c.take(plen, "data", "IPv6 payload");
    if (d >= 0) field(fields, b, "data", d, plen, "payload", `${plen} bytes`, { status: "info", check: "not decoded" });
  }
  return info;
}

/**
 * Dissect one buffer.
 * @param {number[]} bytes  the buffer: header then frame
 * @param {{dir?: "tx"|"rx", strip?: 12|10, to?: "a"|"b"}} opts
 *   dir: "tx" the guest transmits it (the device checks it), "rx" a guest's driver reads it.
 *   strip: header bytes the device strips on transmit (10 = chapter 19's broken device).
 *   to: the VM whose guest receives the frame.
 * @returns {{fields, frameStart, frameLen, device, peerDevice, guest, eth, net}}
 */
export function dissect(bytes, opts = {}) {
  const dir = opts.dir === "rx" ? "rx" : "tx";
  const strip = dir === "tx" && opts.strip === LEGACY_HDR_LEN ? LEGACY_HDR_LEN : HDR_LEN;
  const me = receiverOf(opts.to);
  const b = Array.from(bytes.slice(0, MAX_BYTES), (x) => x & 0xff);
  const fields = [];
  const c = cursor(b, fields);
  const hdr = dissectHeader(b, c, fields, dir, strip);
  const frameStart = Math.min(strip, b.length);
  const frameLen = b.length - frameStart;
  const device = dir === "tx" ? txVerdict(b, strip, hdr) : rxVerdict(frameLen);
  const peerDevice = dir === "tx" && device.sent ? rxVerdict(frameLen) : null;

  let e = null, net = null;
  if (!c.truncated && b.length > frameStart) {
    e = dissectEthernet(b, c, fields, me);
    if (e) {
      if (e.type === 0x0806) net = { kind: "arp", ...dissectArp(b, c, fields) };
      else if (e.type === 0x0800) net = { kind: "ip", ...dissectIpv4(b, c, fields) };
      else if (e.type === 0x86dd) net = { kind: "ip6", ...dissectIpv6(b, c, fields) };
    }
  } else if (!c.truncated) {
    fields.push({ layer: "eth", off: b.length, len: 0, name: "Ethernet frame", value: "missing", status: "bad", check: "no frame", note: "Nothing follows the header.", hex: "" });
  }
  // Whatever the protocol did not claim: inside the frame, padding or undecoded bytes.
  const endTop = b.length;
  if (c.pos < c.end && !c.truncated) {
    const n = c.end - c.pos;
    const known = e && (e.type === 0x0806 || e.type === 0x0800 || e.type === 0x86dd) && net && net.ok !== false;
    field(fields, b, known ? "pad" : "data", c.pos, n, known ? "padding" : "payload", `${n} byte${n === 1 ? "" : "s"}`, known ? { note: "After the packet: padding, ignored by the receiver." } : { status: "info", check: "not decoded" });
    c.pos = c.end;
  }
  if (c.pos < endTop) {
    const n = endTop - c.pos;
    field(fields, b, "pad", c.pos, n, "padding", `${n} byte${n === 1 ? "" : "s"}`, { note: "Bytes after the packet's own length: Ethernet padding, ignored." });
  }
  const guest = guestVerdict({ dir, device, peerDevice, eth: e, net, me, frameLen });
  return { bytes: b, dir, strip, to: me.id, fields, frameStart, frameLen, hdr, device, peerDevice, guest, eth: e, net };
}

// ---------------------------------------------------------------------------------------------
// What macvmm's device does (ports of Net::tx_one / header_ok and Net::receive's length rule)
// ---------------------------------------------------------------------------------------------

/** The `{why:?}` text of a `TxDrop`, as the reference's warning prints it. */
export function txDropDebug(why) {
  if (why.kind === "length") return `Length(${why.total})`;
  if (why.kind === "header") return `Header { flags: ${why.flags}, gso_type: ${why.gso_type} }`;
  return why.kind === "writable" ? "Writable" : "Send";
}

function txVerdict(b, strip, hdr) {
  const total = b.length;
  const warn = (why) => `macvmm: warn: [virtio-net-0] guest: virtio-net: TX frame dropped: ${txDropDebug(why)}`;
  if (total < MIN_TX_CHAIN || total > MAX_TX_CHAIN) {
    const why = { kind: "length", total };
    return {
      sent: false, counter: "tx_dropped", warn: warn(why), short: `drops it, ${txDropDebug(why)}`,
      text: `Drops it: the chain holds ${total} bytes, outside ${MIN_TX_CHAIN} to ${MAX_TX_CHAIN} (header plus 14 to 1514). The length is checked before anything is copied or allocated. tx_dropped +1; the chain still goes back on the used ring with length 0.`,
    };
  }
  const flags = hdr.flags ?? 0xff, gso = hdr.gso ?? 0xff;
  if (flags !== 0 || gso !== 0) {
    const why = { kind: "header", flags, gso_type: gso };
    return {
      sent: false, counter: "tx_dropped", warn: warn(why), short: `drops it, ${txDropDebug(why)}`,
      text: `Drops it: the header asks for an offload (flags ${flags}, gso_type ${gso}) that was never negotiated. It checks the copy, not guest memory. tx_dropped +1, and the device carries on.`,
    };
  }
  const n = total - strip;
  return {
    sent: true, counter: "tx_packets", warn: null, frameLen: n, short: `sends a ${n}-byte frame`,
    text: `Strips the ${strip}-byte header and hands the backend a ${n}-byte frame: tx_packets +1, tx_bytes +${n}.${strip === LEGACY_HDR_LEN ? " The driver wrote 12 header bytes, so the frame now starts with the last two of them." : ""}`,
  };
}

function rxVerdict(frameLen) {
  if (frameLen < ETH_MIN_FRAME || frameLen > ETH_MAX_FRAME) {
    return {
      delivered: false, counter: "rx_dropped_len", short: "drops it, rx_dropped_len",
      warn: `macvmm: warn: [virtio-net-rx-0] guest: virtio-net: RX datagram of ${frameLen} bytes dropped (not ${ETH_MIN_FRAME}..=${ETH_MAX_FRAME})`,
      text: `Drops it: a ${frameLen}-byte datagram is not an Ethernet frame (${ETH_MIN_FRAME} to ${ETH_MAX_FRAME} bytes). rx_dropped_len +1.`,
    };
  }
  return {
    delivered: true, counter: "rx_packets", warn: null, short: `delivers a ${frameLen}-byte frame`,
    text: `Writes 12 header bytes (zeros, num_buffers = 1) and the ${frameLen}-byte frame into the next posted receive buffer, and reports ${HDR_LEN + frameLen} bytes used: rx_packets +1, rx_bytes +${frameLen}. (With no buffer posted it would drop and count it instead.)`,
  };
}

// ---------------------------------------------------------------------------------------------
// What the receiving guest's network stack does (simplified Linux, as a host, not a router)
// ---------------------------------------------------------------------------------------------

function guestVerdict({ dir, device, peerDevice, eth, net, me, frameLen }) {
  const who = `${me.name}'s guest`;
  const r = (outcome, text) => ({ outcome, text, who });
  if (dir === "tx" && !device.sent) return r("never", `${who} never sees it: the sending device dropped it.`);
  if (dir === "tx" && peerDevice && !peerDevice.delivered) return r("never", `${who} never sees it: ${me.name}'s device drops the ${frameLen}-byte datagram (rx_dropped_len).`);
  if (dir === "rx" && !device.delivered) return r("never", `${who} never sees it.`);
  if (!eth) return r("drop", `${who} drops it: too short for an Ethernet header.`);
  const d = eth.dst;
  const bcast = d.every((x) => x === 0xff);
  const mine = same(d, me.mac);
  if (!bcast && !mine) {
    if (d[0] & 1) {
      if (eth.type === 0x86dd && net && net.kind === "ip6" && same(net.dst || [], ALL_ROUTERS)) {
        return r("ignore", `A multicast frame for ff02::2, all routers. ${who} keeps a multicast frame only for a group it joined; neither guest is a router, so nobody answers. (VM B's two transmitted frames in chapter 19's "Two bytes off" run were 70 bytes each, this message's size.)`);
      }
      return r("ignore", `A multicast frame: ${who} keeps it only if its interface joined that group.`);
    }
    return r("drop", `${who} discards it without a word: the destination ${formatMac(d)} is not ${me.name}'s ${formatMac(me.mac)}, and a broadcast would be ff:ff:ff:ff:ff:ff. A frame for somebody else is not an error, just not ours.`);
  }
  if (eth.type < 0x0600) return r("drop", `${who} reads the EtherType ${hex(eth.type, 4)} as an 802.3 length and finds no protocol it speaks: dropped.`);
  if (!net) return r("drop", `${who} has no handler for EtherType ${hex(eth.type, 4)} in this lab's model: dropped.`);
  if (net.kind === "arp") {
    if (net.truncated) return r("drop", `${who} drops it: the ARP packet is shorter than its addresses (28 bytes).`);
    if (!net.ok) return r("drop", `${who} drops it: not an Ethernet/IPv4 ARP packet.`);
    if (net.op === 1) {
      if (same(net.tpa, me.ip) && net.spa.every((x) => x === 0)) return r("answer", `"Who has ${formatIp4(net.tpa)}?" from sender IP 0.0.0.0: a probe, a machine checking that nobody already uses the address (RFC 5227). That is ${me.name}, so ${who} answers, and the prober learns the address is taken. It remembers nothing: 0.0.0.0 is nobody's address.`);
      if (same(net.tpa, me.ip)) return r("answer", `"Who has ${formatIp4(net.tpa)}? Tell ${formatIp4(net.spa)}." That is ${me.name}, so ${who} answers with an ARP reply to ${formatMac(net.sha)} and remembers that ${formatIp4(net.spa)} is at ${formatMac(net.sha)}.`);
      return r("ignore", `An ARP request for ${formatIp4(net.tpa)}, which is not ${me.name} (${formatIp4(me.ip)}): ${who} does not answer.`);
    }
    if (net.op === 2) {
      if (same(net.tpa, me.ip)) return r("learn", `${who} learns that ${formatIp4(net.spa)} is at ${formatMac(net.sha)} and sends whatever was waiting for that address.`);
      return r("ignore", `An ARP reply for ${formatIp4(net.tpa)}, not for ${me.name}: ignored.`);
    }
    return r("drop", `${who} drops an ARP operation it does not know.`);
  }
  if (net.kind === "ip") {
    if (net.ver !== 4 || net.ihl < 5) return r("drop", `${who} drops it: not a well-formed IPv4 header.`);
    if (!net.totOk) return r("drop", `${who} drops it: the total length does not fit the frame.`);
    if (!net.hdrOk) return r("drop", `${who} drops it without a word: the IPv4 header checksum is wrong.`);
    const toBcast = net.dst.every((x) => x === 255);
    if (!same(net.dst, me.ip) && !toBcast) return r("drop", `${who} drops it: ${formatIp4(net.dst)} is not its address, and a host does not forward.`);
    if (net.frag) return r("other", `${who} keeps the fragment until the rest arrive (not modelled here).`);
    if (net.proto !== 1 || !net.icmp) return r("other", `${who} hands it to ${IP_PROTOS[net.proto] ?? `protocol ${net.proto}`} (not decoded here).`);
    if (!net.icmp.ok) return r("drop", `${who} drops it: the ICMP checksum is wrong.`);
    if (net.icmp.type === 8 && toBcast) return r("ignore", `A ping to the broadcast address 255.255.255.255. ${who} does not answer: Linux ignores broadcast pings by default (net.ipv4.icmp_echo_ignore_broadcasts = 1).`);
    if (net.icmp.type === 8) return r("answer", `A ping. ${who} answers with an echo reply (type 0) to ${formatIp4(net.src)}, with the same identifier ${net.icmp.ident}, sequence ${net.icmp.seq} and data.`);
    if (net.icmp.type === 0) return r("deliver", `${who} hands the echo reply (sequence ${net.icmp.seq}) to the ping waiting for identifier ${net.icmp.ident}, which prints a line.`);
    return r("other", `${who} handles ICMP type ${net.icmp.type} (not modelled here).`);
  }
  if (net.kind === "ip6") {
    if (net.ver !== 6 || !net.ok) return r("drop", `${who} drops it: not a well-formed IPv6 packet.`);
    return r("other", `${who} hands it to its IPv6 stack (only the headers are decoded here).`);
  }
  return r("other", "");
}

// ---------------------------------------------------------------------------------------------
// Edits that keep a frame sensible
// ---------------------------------------------------------------------------------------------

/** Recompute the IPv4 header, ICMP and ICMPv6 checksums in place (header stripped at `strip`). */
export function fixChecksums(bytes, strip = HDR_LEN) {
  const b = [...bytes];
  const f = strip;
  if (b.length < f + 14) return b;
  const type = u16be(b, f + 12);
  const ip = f + 14;
  if (type === 0x0800 && b.length >= ip + 20) {
    const ihl = (b[ip] & 15) * 4;
    if (ihl < 20 || ip + ihl > b.length) return b;
    b[ip + 10] = 0;
    b[ip + 11] = 0;
    const s = inetChecksum(b.slice(ip, ip + ihl));
    b[ip + 10] = s >> 8;
    b[ip + 11] = s & 0xff;
    const total = u16be(b, ip + 2);
    if (b[ip + 9] === 1 && total > ihl + 4 && ip + total <= b.length && (u16be(b, ip + 6) & 0x3fff) === 0) {
      const o = ip + ihl;
      b[o + 2] = 0;
      b[o + 3] = 0;
      const t = inetChecksum(b.slice(o, ip + total));
      b[o + 2] = t >> 8;
      b[o + 3] = t & 0xff;
    }
  } else if (type === 0x86dd && b.length >= ip + 44) {
    const plen = u16be(b, ip + 4);
    if (b[ip + 6] !== 58 || ip + 40 + plen > b.length || plen < 4) return b;
    const o = ip + 40;
    b[o + 2] = 0;
    b[o + 3] = 0;
    const t = inetChecksum(b.slice(o, o + plen), pseudo6(b.slice(ip + 8, ip + 24), b.slice(ip + 24, ip + 40), plen, 58));
    b[o + 2] = t >> 8;
    b[o + 3] = t & 0xff;
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// Summary and the lesson's "Two bytes off" table
// ---------------------------------------------------------------------------------------------

/** One plain sentence for the readout and the live region. */
export function summary(d) {
  const dirText = d.dir === "tx" ? "Transmitted" : "Received";
  const parts = [`${dirText} buffer, ${d.bytes.length} bytes.`];
  if (d.net && d.net.kind === "arp" && d.net.ok) {
    parts.push(d.net.op === 1 ? `ARP request: who has ${formatIp4(d.net.tpa)}? Tell ${formatIp4(d.net.spa)}.` : `ARP reply: ${formatIp4(d.net.spa)} is at ${formatMac(d.net.sha)}.`);
  } else if (d.net && d.net.kind === "ip" && d.net.icmp) {
    parts.push(`IPv4 ${formatIp4(d.net.src)} to ${formatIp4(d.net.dst)}, ICMP ${ICMP_TYPES[d.net.icmp.type] ?? `type ${d.net.icmp.type}`}.`);
  } else if (d.net && d.net.kind === "ip6" && d.net.icmp) {
    parts.push(`IPv6, ICMPv6 ${ICMP6_TYPES[d.net.icmp.type] ?? `type ${d.net.icmp.type}`}.`);
  } else if (d.eth) {
    parts.push(`Ethernet from ${formatMac(d.eth.src)} to ${formatMac(d.eth.dst)}.`);
  }
  const problems = d.fields.filter((f) => f.status === "bad" || f.status === "warn");
  if (problems.length) parts.push(`${problems.length} field${problems.length === 1 ? "" : "s"} flagged: ${problems.slice(0, 3).map((f) => f.name).join(", ")}${problems.length > 3 ? ", ..." : ""}.`);
  parts.push(`The device ${d.device.short}.`);
  parts.push(d.guest.text);
  return parts.join(" ");
}

/**
 * The first 14 frame bytes the receiver reads, sent versus read: the lesson's "Two bytes off"
 * table. `sent` is the frame as the driver meant it (after 12 bytes), `read` after `strip`.
 */
export function shiftRows(bytes, strip) {
  const sent = bytes.slice(HDR_LEN, HDR_LEN + 14);
  const read = bytes.slice(strip, strip + 14);
  return [
    { range: "0 to 5", sent: bytesHex(sent.slice(0, 6)), read: bytesHex(read.slice(0, 6)), what: "destination" },
    { range: "6 to 11", sent: bytesHex(sent.slice(6, 12)), read: bytesHex(read.slice(6, 12)), what: "source" },
    { range: "12 to 13", sent: bytesHex(sent.slice(12, 14)), read: bytesHex(read.slice(12, 14)), what: "EtherType" },
  ];
}

/**
 * What the real runs printed (captures/19-legacy-hdr-a.txt and -b.txt). The model test checks
 * every number against the captures.
 */
export const LEGACY_RUN = Object.freeze({
  aStats: "tx_packets=20 tx_bytes=1200",
  aPing: "macvmm-net: FAILED ping 0/5",
  bStats: "rx_packets=20 rx_bytes=1200",
  bTx: "tx_packets=2 tx_bytes=140",
  text: "In the real run, A's device sent 20 frames (tx_packets=20 tx_bytes=1200), B's device delivered all 20 (rx_packets=20 rx_bytes=1200), and A printed \"FAILED ping 0/5\": B's guest answered none. Not all 20 were this ARP request: Linux sends other frames when an interface comes up, which is why 1200 / 20 is not 44.",
});

// ---------------------------------------------------------------------------------------------
// Share state
// ---------------------------------------------------------------------------------------------

/**
 * Encode `{preset, bytes, dir, strip, to}` as `p=<id>` or `b=<hex>`, then `d=`, `h=`, `r=` only
 * where they differ from the preset's defaults. The default state encodes as "".
 */
export function encodeShare(s) {
  const p = s.preset ? preset(s.preset) : null;
  const parts = [];
  if (p) parts.push(`p=${p.id}`);
  else parts.push(`b=${bytesHex(s.bytes || [], "")}`);
  const baseDir = p ? p.dir : "tx";
  const baseTo = p ? p.to : (s.dir === "rx" ? "a" : "b");
  if (s.dir !== baseDir) parts.push(`d=${s.dir}`);
  if (s.dir === "tx" && s.strip === LEGACY_HDR_LEN) parts.push("h=10");
  if (s.to !== baseTo) parts.push(`r=${s.to}`);
  const str = parts.join(";");
  return str === "p=arp" ? "" : str;
}

/**
 * What the lab keeps in the address bar without being asked: `encodeShare` for a preset (an id
 * and settings, nothing of the reader's), `null` for bytes the reader typed or pasted. Those go
 * into the address only when the reader presses "Copy link" (the view then uses `encodeShare`).
 */
export function encodeAuto(s) {
  if (!s.preset || !preset(s.preset)) return null;
  const str = encodeShare(s);
  return str === "" ? null : str;
}

/** Decode a share string; `null` for anything malformed (the view then starts at the default). */
export function decodeShare(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > MAX_BYTES * 2 + 64) return null;
  const kv = new Map();
  for (const part of str.split(";")) {
    const m = /^([pbdhr])=([0-9a-z-]*)$/.exec(part);
    if (!m || kv.has(m[1])) return null;
    kv.set(m[1], m[2]);
  }
  if (kv.has("p") === kv.has("b")) return null;
  let s;
  if (kv.has("p")) {
    const p = preset(kv.get("p"));
    if (!p) return null;
    s = { preset: p.id, bytes: null, dir: p.dir, strip: HDR_LEN, to: p.to };
  } else {
    const hexs = kv.get("b");
    if (!/^([0-9a-f]{2})*$/.test(hexs) || hexs.length > MAX_BYTES * 2) return null;
    const r = parseHex(hexs);
    if (r.error) return null;
    s = { preset: null, bytes: r.bytes, dir: "tx", strip: HDR_LEN, to: "b" };
  }
  if (kv.has("d")) {
    const d = kv.get("d");
    if (d !== "tx" && d !== "rx") return null;
    s.dir = d;
    if (!kv.has("p")) s.to = d === "rx" ? "a" : "b";
  }
  if (kv.has("h")) {
    if (kv.get("h") !== "10" || s.dir !== "tx") return null;
    s.strip = LEGACY_HDR_LEN;
  }
  if (kv.has("r")) {
    const r = kv.get("r");
    if (!isVm(r)) return null;
    s.to = r;
  }
  return s;
}

/** The bytes a state stands for. */
export function stateBytes(s) {
  if (s.preset) return [...preset(s.preset).bytes];
  return [...(s.bytes || [])];
}
