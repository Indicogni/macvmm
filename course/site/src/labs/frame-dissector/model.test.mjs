// Tests for the frame-dissector model. Run: node --test 'course/site/**/*.test.mjs'
//
// The lab must reproduce chapter 19 exactly: the ARP request's byte table, the "Two bytes off"
// table, and the numbers it quotes from the captures. These tests read the lesson, the captures
// and the Rust source, so none of them can drift silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_BYTES, HDR_LEN, LEGACY_HDR_LEN, ETH_MIN_FRAME, ETH_MAX_FRAME, MIN_TX_CHAIN, MAX_TX_CHAIN,
  PRESETS, preset, REFERENCE, DEFAULT, LEGACY_RUN, VMS,
  parseHex, formatHexLines, dissect, summary, shiftRows, inetChecksum, fixChecksums,
  formatIp6, formatMac, txDropDebug, encodeShare, encodeAuto, decodeShare, stateBytes, isVm,
} from "./model.mjs";

const root = (p) => fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));
const read = (p) => readFileSync(root(p), "utf8");
const lesson = read("course/chapters/VII/19-virtio-net.md");
const netRs = read("crates/vmm/src/virtio/net.rs");
const backendRs = read("crates/vmm/src/net/backend.rs");

// ---------------------------------------------------------------------------------------------
// Drift against the Rust reference
// ---------------------------------------------------------------------------------------------

function rustConst(src, name) {
  const m = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(src);
  assert.ok(m, `${name} not found`);
  return Number(m[1]);
}

test("constants match crates/vmm/src/virtio/net.rs and net/backend.rs", () => {
  assert.equal(rustConst(netRs, "HDR_LEN"), HDR_LEN);
  assert.equal(rustConst(netRs, "MIN_TX_CHAIN"), MIN_TX_CHAIN);
  assert.equal(rustConst(netRs, "MAX_TX_CHAIN"), MAX_TX_CHAIN);
  assert.equal(rustConst(backendRs, "ETH_MIN_FRAME"), ETH_MIN_FRAME);
  assert.equal(rustConst(backendRs, "ETH_MAX_FRAME"), ETH_MAX_FRAME);
  assert.ok(MAX_BYTES > rustConst(netRs, "RX_BUFFER"), "the lab accepts more than the RX buffer");
});

test("the TX rules and warning texts are the reference's", () => {
  // tx_one: shape and length first, then header_ok on the copy.
  assert.match(netRs, /if total < MIN_TX_CHAIN as u64 \|\| total > MAX_TX_CHAIN as u64 \{\s*return Ok\(Err\(TxDrop::Length\(total\)\)\);/);
  assert.match(netRs, /let \(hdr, frame\) = pkt\.split_at\(HDR_LEN\);\s*if let Err\(why\) = header_ok\(hdr\)/);
  assert.match(netRs, /if flags != 0 \|\| gso_type != 0 \{\s*return Err\(TxDrop::Header \{ flags, gso_type \}\);/);
  assert.match(netRs, /Length\(u64\),\s*Header \{ flags: u8, gso_type: u8 \},/);
  assert.ok(netRs.includes('crate::guest_warn!("virtio-net: TX frame dropped: {why:?}");'));
  assert.ok(netRs.includes('"virtio-net: RX datagram of {:?} bytes dropped (not 14..=1514)"'));
  // The RX header: zeros, num_buffers = 1 at bytes 10..12.
  assert.match(netRs, /pkt\.get_mut\(10\.\.12\)[\s\S]{0,80}1u16\.to_le_bytes\(\)/);
  // The thread names in the warning prefix come from the captures.
  assert.ok(read("course/captures/19-net-b.txt").includes("macvmm: warn: [virtio-net-0] guest: virtio-net: TX frame dropped: Send"));
  assert.ok(read("course/captures/19-iface-down.txt").includes("macvmm: warn: [virtio-net-rx-0] guest: virtio-net: RX frame dropped:"));
});

test("TxDrop Debug text matches Rust's derive(Debug)", () => {
  assert.equal(txDropDebug({ kind: "length", total: 22 }), "Length(22)");
  assert.equal(txDropDebug({ kind: "header", flags: 1, gso_type: 0 }), "Header { flags: 1, gso_type: 0 }");
  assert.equal(txDropDebug({ kind: "send" }), "Send");
});

// ---------------------------------------------------------------------------------------------
// The lesson's numbers
// ---------------------------------------------------------------------------------------------

function lessonArpRows() {
  const lines = lesson.split("\n");
  const start = lines.findIndex((l) => /^offset\s+bytes\s+field$/.test(l));
  assert.ok(start >= 0, "the lesson's ARP byte table");
  const rows = [];
  for (let i = start + 1; !lines[i].startsWith("```"); i++) {
    const m = /^(\d+)\s+((?:[0-9a-f]{2} )*[0-9a-f]{2})\s{2,}(.+)$/.exec(lines[i]);
    assert.ok(m, `row: ${lines[i]}`);
    rows.push({ off: Number(m[1]), bytes: m[2].split(" ").map((x) => parseInt(x, 16)), text: m[3] });
  }
  return rows;
}

test("the ARP preset is the lesson's table, byte for byte, and its rows start fields", () => {
  const rows = lessonArpRows();
  assert.equal(rows.length, 11);
  const all = rows.flatMap((r) => r.bytes);
  assert.deepEqual(preset("arp").bytes, all);
  let off = 0;
  for (const r of rows) {
    assert.equal(r.off, off, `row offset ${r.off}`);
    off += r.bytes.length;
  }
  const d = dissect(all, { dir: "tx", to: "b" });
  const starts = new Set(d.fields.map((f) => f.off));
  for (const r of rows) assert.ok(starts.has(r.off), `a field starts at ${r.off}`);
  const at = (o) => d.fields.find((f) => f.off === o);
  assert.equal(at(0).name, "flags");
  assert.equal(at(1).name, "gso_type");
  assert.match(at(10).name, /^num_buffers/);
  assert.match(at(12).value, /broadcast/);
  assert.match(at(18).value, /VM A's MAC/);
  assert.match(at(24).value, /^0x0806 \(ARP\)/);
  assert.match(at(32).value, /request/);
  assert.match(at(40).value, /^10\.0\.0\.1/);
  assert.match(at(50).value, /^10\.0\.0\.2/);
  assert.equal(d.device.short, "sends a 42-byte frame");
  assert.equal(d.guest.outcome, "answer");
});

test("the lesson's MAC addresses and the VMs' IPs", () => {
  assert.ok(lesson.includes(formatMac(VMS.a.mac)));
  assert.ok(lesson.includes(`mac=${formatMac(VMS.a.mac)}`));
  assert.ok(lesson.includes(`mac=${formatMac(VMS.b.mac)}`));
  assert.ok(lesson.includes("`net-b` brings up `eth0` (Linux's name for its first network interface) as `10.0.0.2`"));
  assert.ok(lesson.includes("`net-a` comes up as `10.0.0.1`"));
});

function lessonShiftTable() {
  const lines = lesson.split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Bytes B reads | Sent as | Read as |"));
  assert.ok(start >= 0, "the Two bytes off table");
  const rows = [];
  for (let i = start + 2; lines[i] && lines[i].startsWith("|"); i++) {
    const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    const code = (c) => /`([0-9a-f ]+)`/.exec(c)[1];
    rows.push({ range: cells[0], sent: code(cells[1]), read: code(cells[2]) });
  }
  return rows;
}

test("strip 10 reproduces the lesson's Two bytes off table and its answer (c)", () => {
  const rows = lessonShiftTable();
  assert.equal(rows.length, 3);
  const mine = shiftRows(preset("arp").bytes, LEGACY_HDR_LEN);
  rows.forEach((r, i) => {
    assert.equal(mine[i].range, r.range);
    assert.equal(mine[i].sent, r.sent);
    assert.equal(mine[i].read, r.read);
  });
  const d = dissect(preset("arp").bytes, { dir: "tx", strip: 10, to: "b" });
  assert.equal(d.frameStart, 10);
  assert.equal(d.device.short, "sends a 44-byte frame");
  const et = d.fields.find((f) => f.name === "EtherType");
  assert.equal(et.off, 22);
  assert.equal(et.check, "length, not type");
  assert.equal(d.guest.outcome, "drop");
  assert.match(d.guest.text, /discards it without a word/);
  assert.ok(lesson.includes("The answer is (c), nothing: a frame addressed to somebody else, which a network stack discards without a word."));
});

test("the legacy run's numbers are the captures'", () => {
  const a = read("course/captures/19-legacy-hdr-a.txt");
  const b = read("course/captures/19-legacy-hdr-b.txt");
  assert.ok(a.includes(LEGACY_RUN.aStats));
  assert.ok(a.includes(LEGACY_RUN.aPing));
  assert.ok(b.includes(LEGACY_RUN.bStats));
  assert.ok(b.includes(LEGACY_RUN.bTx));
  for (const q of [LEGACY_RUN.aStats, LEGACY_RUN.bStats, LEGACY_RUN.aPing.replace("macvmm-net: ", "")]) assert.ok(LEGACY_RUN.text.includes(q), q);
  assert.ok(lesson.includes("B's VMM delivered all 20 of A's frames into B's buffers; B's guest answered none."));
});

test("the router solicitation is 70 bytes, the size the lesson and the capture give", () => {
  const d = dissect(preset("rs").bytes, { dir: "tx", to: "a" });
  assert.equal(d.frameLen, 70);
  assert.ok(lesson.includes("B's two transmitted frames, 70 bytes each, are the size of the IPv6 (Internet Protocol version 6) router solicitation"));
  assert.ok(read("course/captures/19-legacy-hdr-b.txt").includes("tx_packets=2 tx_bytes=140"));
  assert.equal(d.net.icmp.type, 133);
  assert.ok(d.net.icmp.ok);
  assert.equal(formatIp6(d.net.src), "fe80::6d:76ff:fe00:2");
  assert.equal(d.guest.outcome, "ignore");
});

test("the header table: field offsets and the TX/RX rules of the lesson", () => {
  const lines = lesson.split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Offset | Field | With no offload negotiated |"));
  const rows = [];
  for (let i = start + 2; lines[i].startsWith("|"); i++) {
    const c = lines[i].split("|").slice(1, -1).map((x) => x.trim());
    rows.push({ off: Number(c[0]), name: /`(\w+)`/.exec(c[1])[1] });
  }
  assert.equal(rows.length, 7);
  const d = dissect(preset("arp").bytes, { dir: "tx" });
  const hdr = d.fields.filter((f) => f.layer === "hdr");
  assert.deepEqual(hdr.map((f) => f.off), rows.map((r) => r.off));
  hdr.forEach((f, i) => assert.ok(f.name.startsWith(rows[i].name), f.name));
  const rx = dissect(preset("arp-reply").bytes, { dir: "rx", to: "a" });
  assert.equal(rx.fields.find((f) => f.off === 10).value, "1");
  assert.equal(rx.fields.find((f) => f.off === 10).status, "ok");
  const rx0 = dissect(preset("arp").bytes, { dir: "rx", to: "b" });
  assert.equal(rx0.fields.find((f) => f.off === 10).status, "warn");
});

// ---------------------------------------------------------------------------------------------
// Device rules (ports of tx_one, header_ok and receive's length rule)
// ---------------------------------------------------------------------------------------------

function txOfTotal(total) {
  const base = preset("ping").bytes;
  const b = total <= base.length ? base.slice(0, total) : [...base, ...Array(total - base.length).fill(0)];
  return dissect(b, { dir: "tx" });
}

test("TX length boundaries 25/26/1526/1527", () => {
  assert.equal(txOfTotal(25).device.warn, "macvmm: warn: [virtio-net-0] guest: virtio-net: TX frame dropped: Length(25)");
  assert.ok(txOfTotal(26).device.sent);
  assert.ok(txOfTotal(1526).device.sent);
  assert.equal(txOfTotal(1527).device.counter, "tx_dropped");
  assert.equal(dissect(preset("big").bytes).device.warn, "macvmm: warn: [virtio-net-0] guest: virtio-net: TX frame dropped: Length(1527)");
  assert.equal(dissect(preset("short").bytes).device.warn, "macvmm: warn: [virtio-net-0] guest: virtio-net: TX frame dropped: Length(22)");
  assert.equal(dissect([]).device.short, "drops it, Length(0)");
});

test("TX header rule: flags or gso_type non-zero drops; other fields are ignored", () => {
  assert.equal(dissect(preset("csum").bytes).device.warn, "macvmm: warn: [virtio-net-0] guest: virtio-net: TX frame dropped: Header { flags: 1, gso_type: 0 }");
  const g = [...preset("arp").bytes];
  g[1] = 0x81;
  assert.equal(dissect(g).device.short, "drops it, Header { flags: 0, gso_type: 129 }");
  const ign = [...preset("arp").bytes];
  for (let i = 2; i < 12; i++) ign[i] = 0xee;
  const d = dissect(ign);
  assert.ok(d.device.sent);
  assert.ok(d.fields.filter((f) => f.layer === "hdr" && f.off >= 2).every((f) => f.check === "ignored"));
  // The length rule comes first, like tx_one.
  const both = [1, ...preset("short").bytes.slice(1)];
  assert.match(dissect(both).device.warn, /Length\(22\)$/);
});

test("RX length boundaries 13/14/1514/1515 and the peer's check after a strip-10 send", () => {
  const rx = (n) => dissect([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, ...Array(n).fill(0xff)], { dir: "rx", to: "a" });
  assert.equal(rx(13).device.warn, "macvmm: warn: [virtio-net-rx-0] guest: virtio-net: RX datagram of 13 bytes dropped (not 14..=1514)");
  assert.ok(rx(14).device.delivered);
  assert.ok(rx(1514).device.delivered);
  assert.equal(rx(1515).device.counter, "rx_dropped_len");
  const b = txOfTotal(1526);
  assert.ok(b.peerDevice.delivered);
  const b10 = dissect(txOfTotal(1526).bytes, { strip: 10 });
  assert.ok(b10.device.sent);
  assert.equal(b10.peerDevice.counter, "rx_dropped_len");
  assert.equal(b10.guest.outcome, "never");
});

// ---------------------------------------------------------------------------------------------
// Protocol decoding
// ---------------------------------------------------------------------------------------------

test("RFC 1071 checksum: the RFC's example and every built preset", () => {
  // RFC 1071 section 3: 00 01 f2 03 f4 f5 f6 f7 sums to 0xddf2; the checksum is its complement.
  assert.equal(inetChecksum([0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7]), (~0xddf2) & 0xffff);
  for (const p of PRESETS) {
    const d = dissect(p.bytes, { dir: p.dir, to: p.to });
    const bad = d.fields.filter((f) => f.check === "bad checksum");
    assert.equal(bad.length, 0, `${p.id} checksums`);
    assert.deepEqual(fixChecksums(p.bytes), p.bytes, `${p.id} is already fixed`);
  }
});

test("a changed address breaks the checksum; Fix checksums repairs it", () => {
  const b = [...preset("ping").bytes];
  b[12 + 14 + 19] = 3; // destination 10.0.0.3
  let d = dissect(b, { dir: "tx", to: "b" });
  assert.equal(d.fields.find((f) => f.name === "header checksum").check, "bad checksum");
  assert.match(d.guest.text, /header checksum is wrong/);
  d = dissect(fixChecksums(b), { dir: "tx", to: "b" });
  assert.equal(d.fields.find((f) => f.name === "header checksum").check, "ok");
  assert.match(d.guest.text, /10\.0\.0\.3 is not its address/);
  const e = [...preset("ping").bytes];
  e[60] ^= 0xff; // echo data
  assert.equal(dissect(e).fields.find((f) => f.layer === "icmp" && f.name === "checksum").check, "bad checksum");
  assert.equal(dissect(e, { to: "b" }).guest.outcome, "drop");
  assert.equal(dissect(fixChecksums(e), { to: "b" }).guest.outcome, "answer");
});

test("guest verdicts: ping and pong, ARP to the wrong VM, unicast to somebody else", () => {
  assert.equal(dissect(preset("ping").bytes, { to: "b" }).guest.outcome, "answer");
  assert.equal(dissect(preset("pong").bytes, { dir: "rx", to: "a" }).guest.outcome, "deliver");
  assert.equal(dissect(preset("arp").bytes, { to: "a" }).guest.outcome, "ignore");
  assert.equal(dissect(preset("ping").bytes, { to: "a" }).guest.outcome, "drop");
  assert.equal(dissect(preset("arp-reply").bytes, { dir: "rx", to: "a" }).guest.outcome, "learn");
});

test("IPv4 padding and a total length longer than the frame", () => {
  const arp = preset("arp").bytes;
  const padded = [...arp, ...Array(18).fill(0)]; // 42 + 18 = the 60-byte wire minimum
  const d = dissect(padded);
  const last = d.fields[d.fields.length - 1];
  assert.equal(last.layer, "pad");
  assert.equal(last.len, 18);
  const b = [...preset("ping").bytes];
  b[12 + 14 + 3] = 200; // total length 200 > 84
  const t = dissect(fixChecksums(b));
  assert.equal(t.fields.find((f) => f.name === "total length").status, "bad");
  assert.match(t.guest.text, /total length does not fit/);
});

test("IPv6 text form follows RFC 5952", () => {
  const z = Array(16).fill(0);
  assert.equal(formatIp6(z), "::");
  assert.equal(formatIp6([...z.slice(0, 15), 1]), "::1");
  assert.equal(formatIp6([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]), "2001:db8:0:1::1");
  assert.equal(formatIp6([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]), "2001:db8::1:0:0:1");
  assert.equal(formatIp6([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]), "2001:db8:0:1:1:1:1:1");
});

// ---------------------------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------------------------

test("parseHex: separators, 0x, errors, cap", () => {
  assert.deepEqual(parseHex("0xff 00:0a-0B,1_2\n33").bytes, [0xff, 0x00, 0x0a, 0x0b, 0x12, 0x33]);
  assert.deepEqual(parseHex("").bytes, []);
  assert.match(parseHex("abc").error, /odd/);
  assert.match(parseHex("zz").error, /not hex/);
  assert.match(parseHex("ff".repeat(MAX_BYTES + 1)).error, /too long/);
  assert.equal(parseHex("ff".repeat(MAX_BYTES)).bytes.length, MAX_BYTES);
  assert.match(parseHex("f".repeat(MAX_BYTES * 6)).error, /too long/);
  assert.equal(parseHex(null).error, "no text");
  const lines = formatHexLines(preset("arp").bytes);
  assert.deepEqual(parseHex(lines).bytes, preset("arp").bytes);
});

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test("random and mutated buffers never throw, and fields tile the buffer exactly", () => {
  const r = rng(19);
  const bases = PRESETS.map((p) => p.bytes);
  for (let i = 0; i < 3000; i++) {
    let b;
    if (i % 3 === 0) {
      b = Array.from({ length: Math.floor(r() * 120) }, () => Math.floor(r() * 256));
    } else {
      b = [...bases[i % bases.length]];
      const n = 1 + Math.floor(r() * 6);
      for (let k = 0; k < n; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
      if (r() < 0.3) b = b.slice(0, Math.floor(r() * b.length));
    }
    for (const opts of [{ dir: "tx" }, { dir: "tx", strip: 10 }, { dir: "rx", to: "a" }]) {
      const d = dissect(b, opts);
      let pos = 0;
      for (const f of d.fields.filter((x) => x.len > 0)) {
        assert.equal(f.off, pos, `gap or overlap at ${pos} in ${JSON.stringify(b)} ${JSON.stringify(opts)}`);
        pos += f.len;
      }
      assert.equal(pos, b.length);
      assert.equal(typeof summary(d), "string");
      assert.equal(typeof d.guest.text, "string");
    }
  }
});

test("share state: default, reference, round trips, hostile strings", () => {
  assert.equal(encodeShare(DEFAULT), "");
  const ref = decodeShare(REFERENCE);
  assert.deepEqual(ref, { preset: "arp", bytes: null, dir: "tx", strip: 10, to: "b" });
  assert.equal(encodeShare(ref), REFERENCE);
  const states = [
    { preset: "pong", bytes: null, dir: "rx", strip: 12, to: "a" },
    { preset: "pong", bytes: null, dir: "tx", strip: 10, to: "b" },
    { preset: null, bytes: [0, 1, 2, 0xff], dir: "rx", strip: 12, to: "b" },
    { preset: null, bytes: [], dir: "tx", strip: 12, to: "b" },
  ];
  for (const s of states) assert.deepEqual(decodeShare(encodeShare(s)), s, encodeShare(s));
  assert.equal(encodeShare(states[0]), "p=pong");
  for (const bad of [null, "", "p=nope", "p=arp;p=arp", "p=arp;b=00", "b=0", "b=zz", "p=arp;h=11", "p=pong;h=10", "p=arp;r=c", "p=arp;d=xx",
    "x=1", "p=arp;;", `b=${"00".repeat(MAX_BYTES + 1)}`, "p=arp;h=10;d=rx", "P=arp", "p=ARP", "p=arp&b=00", "p=<script>"]) {
    assert.equal(decodeShare(bad), null, String(bad));
  }
  const r = rng(7);
  const alphabet = "pbdhr=;0123456789abcdef-xyz<>%&";
  for (let i = 0; i < 2000; i++) {
    const s = Array.from({ length: Math.floor(r() * 30) }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
    const d = decodeShare(s);
    if (d) {
      assert.ok(Array.isArray(stateBytes(d)));
      assert.doesNotThrow(() => dissect(stateBytes(d), d));
    }
  }
});

test("every preset has a title, a direction, a receiver and a source", () => {
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(!ids.has(p.id));
    ids.add(p.id);
    assert.ok(p.title && (p.dir === "tx" || p.dir === "rx") && VMS[p.to] && (p.source === "lesson" || p.source === "built"), p.id);
    assert.ok(p.bytes.length <= MAX_BYTES);
  }
  assert.equal(preset("arp").source, "lesson");
});

test("lab.json carries the reference share state", () => {
  const lab = JSON.parse(readFileSync(new URL("./lab.json", import.meta.url), "utf8"));
  assert.equal(lab.reference, REFERENCE);
  assert.ok(lab.title && lab.goal);
});

test("vectors: no labs/vectors/net.json yet", (t) => {
  const p = root("course/site/labs/vectors/net.json");
  if (!existsSync(p)) {
    t.skip("course/site/labs/vectors/net.json does not exist yet; the lesson, captures and Rust source are the oracle");
    return;
  }
  const v = JSON.parse(readFileSync(p, "utf8"));
  for (const c of v.cases || []) {
    const d = dissect(parseHex(c.hex).bytes, { dir: c.dir || "tx" });
    if (c.warn !== undefined) assert.equal(d.device.warn, c.warn);
  }
});

test("Linux details: broadcast pings ignored, truncated ARP, ARP probes, 802.2 LLC reading", () => {
  // A ping to 255.255.255.255 in a broadcast frame: icmp_echo_ignore_broadcasts = 1.
  const b = [...preset("ping").bytes];
  for (let i = 12; i < 18; i++) b[i] = 0xff;
  for (let i = 12 + 14 + 16; i < 12 + 14 + 20; i++) b[i] = 255;
  const d = dissect(fixChecksums(b), { to: "b" });
  assert.equal(d.guest.outcome, "ignore");
  assert.match(d.guest.text, /icmp_echo_ignore_broadcasts = 1/);
  // ARP cut inside its addresses, as received: truncated, not "not Ethernet/IPv4 ARP".
  const cut = [...preset("arp").bytes.slice(0, 40)];
  cut[11] = 1; // num_buffers = 1, as the device writes it
  const t = dissect(cut, { dir: "rx", to: "b" });
  assert.equal(t.guest.outcome, "drop");
  assert.match(t.guest.text, /shorter than its addresses \(28 bytes\)/);
  // RFC 5227 probe: sender IP 0.0.0.0, target B. B answers but remembers nothing.
  const probe = [...preset("arp").bytes];
  for (let i = 12 + 14 + 14; i < 12 + 14 + 18; i++) probe[i] = 0;
  const p = dissect(probe, { to: "b" });
  assert.equal(p.guest.outcome, "answer");
  assert.match(p.guest.text, /probe/);
  assert.doesNotMatch(p.guest.text, /0\.0\.0\.0 is at/);
  // Strip 10: the type reads 00 01 and the next bytes 08 06 are DSAP and SSAP.
  const s = dissect(preset("arp").bytes, { strip: 10, to: "b" });
  const et = s.fields.find((f) => f.name === "EtherType");
  assert.match(et.note, /802\.2 LLC header \(here DSAP 0x08, SSAP 0x06\)/);
  // The 1515-byte preset no longer suggests that a plain ping makes one frame that size.
  assert.doesNotMatch(preset("big").title, /ping/);
  assert.equal(preset("big").bytes.length - HDR_LEN, 1515);
  // The run totals explain why they are not 20 copies of the ARP request.
  assert.match(LEGACY_RUN.text, /1200 \/ 20 is not 44/);
});

test("share and dissect: Object.prototype keys are not VMs", () => {
  // `#frame-dissector=p=arp;r=constructor` used to decode (VMS["constructor"] is truthy) and the
  // view then threw on mount, reading `.mac` of a function.
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    assert.equal(decodeShare(`p=arp;r=${key}`), null, key);
    assert.equal(decodeShare(`b=00;r=${key}`), null, key);
    assert.equal(isVm(key), false, key);
    // dissect() itself falls back to VM B for an id it does not know.
    const d = dissect(preset("arp").bytes, { dir: "tx", strip: 12, to: key });
    assert.deepEqual(d.guest, dissect(preset("arp").bytes, { dir: "tx", strip: 12, to: "b" }).guest, key);
  }
  assert.equal(isVm("a"), true);
  assert.equal(decodeShare("p=arp;r=a").to, "a");
});

test("encodeAuto: presets only, never the reader's bytes", () => {
  assert.equal(encodeAuto(DEFAULT), null);
  assert.equal(encodeAuto({ preset: "pong", bytes: null, dir: "rx", strip: 12, to: "a" }), "p=pong");
  assert.equal(encodeAuto(decodeShare(REFERENCE)), REFERENCE);
  const own = { preset: null, bytes: [0xde, 0xad], dir: "tx", strip: 12, to: "b" };
  assert.equal(encodeAuto(own), null);
  assert.equal(encodeShare(own), "b=dead", "Copy link still carries them");
  assert.deepEqual(decodeShare("b=dead"), own);
});
