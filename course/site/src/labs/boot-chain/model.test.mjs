// Tests for the boot-chain model. Run: node --test 'course/site/**/*.test.mjs'
// The lab quotes chapter 21's chain table and numbers from real captures; these tests read the
// lesson, the primers and the capture files, so the lab cannot drift from what the course shows.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OWNERS, CHAINS, MAPKEY, BOOT_SERVICES, CHAIN_TABLE_HEAD, CHAIN_TABLE, CHAIN_TABLE_EXTRA,
  chainSteps, directSteps, alignedDirect, replayEvents, initialState, step, snapshot, summary,
  ownerChoices, encodeHash, decodeHash, REFERENCE,
} from "./model.mjs";

const path = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const CAPTURES = path("../../../../captures/");
const CH21 = path("../../../../chapters/IX/21-firmware.md");
const UEFI = path("../../../../primers/uefi.md");
const UBOOT = path("../../../../primers/u-boot.md");
const LABS_MD = path("../../../LABS.md");
const LAB_JSON = path("./lab.json");

const allVariants = () => {
  const out = [];
  for (const c of CHAINS) for (const k of Object.keys(MAPKEY)) {
    if (k !== "ok" && c.id === "booti") continue;
    out.push([c.id, k]);
  }
  return out;
};
const allSteps = () => [...directSteps(), ...allVariants().flatMap(([c, k]) => chainSteps(c, k))];

test("chapter 21's chain table is reproduced row for row", (t) => {
  if (!existsSync(CH21)) return t.skip(`lesson missing: ${CH21}`);
  const lines = readFileSync(CH21, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Chain | Loaded by |"));
  assert.ok(start >= 0, "lesson has the table");
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
  assert.deepEqual(cells(lines[start]), CHAIN_TABLE_HEAD);
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) rows.push(cells(lines[i]));
  assert.deepEqual(rows, CHAIN_TABLE.map((r) => r.cells));
  // and the lab is embedded right after it
  assert.ok(lines.slice(start).some((l) => l.trim() === ":::lab boot-chain"));
});

test("every observed number is in its capture", (t) => {
  let checked = 0;
  for (const st of allSteps()) {
    if (st.evidence.kind !== "observed") continue;
    assert.ok(st.evidence.capture, `${st.title}: observed step names a capture`);
    assert.ok(Array.isArray(st.quotes) && st.quotes.length > 0, `${st.title}: observed step lists quotes`);
    const file = CAPTURES + st.evidence.capture;
    if (!existsSync(file)) { t.diagnostic(`capture missing: ${file}`); continue; }
    const text = readFileSync(file, "utf8");
    for (const q of st.quotes) { assert.ok(text.includes(q), `${st.evidence.capture} lacks ${JSON.stringify(q)}`); checked++; }
  }
  assert.ok(checked >= 30, `checked ${checked} quotes`);
});

test("evidence is honest: only the FreeBSD chain and direct boot are fully observed", () => {
  for (const st of allSteps()) {
    assert.ok(["observed", "described", "what-if"].includes(st.evidence.kind), st.title);
    if (st.evidence.kind === "described") assert.match(st.evidence.text, /not (run|traced|started)|was not run|not started/i, st.title);
  }
  assert.ok(directSteps().every((s) => s.evidence.kind === "observed"));
  for (const c of CHAINS) {
    const s = chainSteps(c.id);
    const allObserved = s.every((x) => x.evidence.kind === "observed" || /ExitBootServices/.test(x.title));
    assert.equal(allObserved, c.observed, c.id);
  }
});

test("the DTB owner, step by step", () => {
  const owners = (c, k) => chainSteps(c, k).map((s) => s.owner);
  assert.deepEqual(directSteps().map((s) => s.owner), ["vmm", "kernel"]);
  assert.deepEqual(owners("booti"), ["vmm", "uboot", "uboot", "uboot", "kernel"]);
  assert.deepEqual(owners("efi-linux"), ["vmm", "uboot", "uboot", "uefi", "stub", "stub", "kernel"]);
  assert.deepEqual(owners("efi-linux", "retry"), ["vmm", "uboot", "uboot", "uefi", "stub", "stub", "stub", "stub", "kernel"]);
  assert.deepEqual(owners("efi-bsd"), ["vmm", "uboot", "uboot", "uefi", "loader", "loader", "kernel"]);
  assert.deepEqual(ownerChoices("efi-bsd"), ["vmm", "uboot", "uefi", "loader", "kernel"]);
  for (const [c, k] of allVariants()) for (const s of chainSteps(c, k)) assert.ok(Object.hasOwn(OWNERS, s.owner));
});

test("x0 and x1 at the hand-offs match the lessons", () => {
  const d = directSteps()[0];
  assert.match(d.pc, /^0x40200000/);
  assert.match(d.x0, /^0x40000000/);
  for (const c of CHAINS) {
    const s = chainSteps(c.id);
    assert.match(s[0].pc, /^0x0 /, "firmware boot starts at PC = 0");
    assert.match(s[0].x0, /^0x40000000/, "x0 = the DTB, as booting.rst asks");
  }
  for (const c of ["efi-linux", "efi-bsd"]) {
    const start = chainSteps(c)[3];
    assert.equal(start.x0, "image handle");
    assert.equal(start.x1, "the System Table");
  }
  assert.match(chainSteps("efi-bsd").at(-1).x0, /not the DTB/, "FreeBSD gets the DTB in metadata, not x0");
  assert.match(chainSteps("efi-linux").at(-1).x0, /stub's DTB/);
});

test("boot services: alive between the EFI start and ExitBootServices only", () => {
  const bs = (c, k) => chainSteps(c, k).map((s) => s.bs);
  assert.deepEqual(directSteps().map((s) => s.bs), ["none", "none"]);
  assert.deepEqual(bs("booti"), ["none", "not-yet", "not-yet", "unused", "unused"]);
  assert.deepEqual(bs("efi-bsd"), ["none", "not-yet", "not-yet", "alive", "alive", "gone", "gone"]);
  assert.deepEqual(bs("efi-bsd", "retry"), ["none", "not-yet", "not-yet", "alive", "alive", "alive", "partial", "gone", "gone"]);
  assert.deepEqual(bs("efi-linux", "ignore"), ["none", "not-yet", "not-yet", "alive", "alive", "alive", "partial", "never-exited", "never-exited"]);
  for (const [c, k] of allVariants()) for (const s of chainSteps(c, k)) assert.ok(Object.hasOwn(BOOT_SERVICES, s.bs));
  // the stale call is EFI_INVALID_PARAMETER and only GetMemoryMap may follow (UEFI 2.10 section 7.4)
  const stale = chainSteps("efi-linux", "retry")[6];
  assert.match(stale.note, /EFI_INVALID_PARAMETER/);
  assert.match(BOOT_SERVICES[stale.bs], /GetMemoryMap/);
});

test("our DTB is never edited after macvmm writes it; copies inherit edits", () => {
  for (const [c, k] of allVariants()) for (const fixup of [false, true]) {
    const s = chainSteps(c, k);
    const { dtbs } = replayEvents(s, s.length - 1, fixup);
    const ours = dtbs.find((d) => d.key === "ours");
    assert.ok(ours.edits.every((e) => e.by === "vmm"), `${c}: ours untouched`);
    const whatIfs = dtbs.flatMap((d) => d.edits.filter((e) => e.whatIf));
    if (!fixup) assert.equal(whatIfs.length, 0, `${c}: no what-if edits without the toggle`);
    else {
      // the what-if edit lands on U-Boot's control copy and on its descendants only
      const descendsFromUboot = (d) => d && (d.key === "uboot" || descendsFromUboot(dtbs.find((p) => p.key === d.from)));
      for (const d of dtbs) {
        assert.equal(d.edits.some((e) => e.whatIf), !!descendsFromUboot(d), `${c}: ${d.key}`);
      }
    }
  }
  // the EFI chains' configuration-table copy descends from OURS ($fdt_addr), not from U-Boot's copy,
  // and U-Boot edits it (described from its source, not dumped on macvmm)
  for (const c of ["efi-linux", "efi-bsd"]) {
    const s = chainSteps(c);
    const { dtbs } = replayEvents(s, s.length - 1, true);
    const cfg = dtbs.find((d) => d.key === "cfg");
    assert.equal(cfg.from, "ours", `${c}: cfg copied from ours`);
    const own = cfg.edits.filter((e) => !e.inherited && !e.whatIf);
    assert.equal(own.length, 1);
    assert.equal(own[0].by, "uefi");
    assert.match(own[0].text, /u-boot,version/);
    assert.match(own[0].src, /efi_install_fdt.*not dumped on macvmm/);
    assert.ok(!cfg.edits.some((e) => e.whatIf), `${c}: the control-copy what-if does not reach the EFI copy`);
    assert.match(s[3].note, /\$fdt_addr/);
  }
  // FreeBSD: loader.efi makes one more copy, from the configuration table, and the kernel reads it
  {
    const s = chainSteps("efi-bsd");
    const { dtbs } = replayEvents(s, s.length - 1, false);
    assert.deepEqual(dtbs.map((d) => [d.key, d.from]), [["ours", null], ["uboot", "ours"], ["cfg", "ours"], ["loader", "cfg"]]);
    const loader = dtbs.find((d) => d.key === "loader");
    assert.ok(loader.edits.some((e) => !e.inherited && /fixup-applied/.test(e.text) && /not traced/.test(e.src)));
    assert.match(s.at(-1).note, /two copies down/);
  }
  // what the kernel reads in each chain
  const reads = (c) => chainSteps(c).at(-1).reads;
  assert.equal(directSteps()[1].reads, "ours");
  assert.equal(reads("booti"), "uboot");
  assert.equal(reads("efi-linux"), "stub");
  assert.equal(reads("efi-bsd"), "loader");
  for (const [c, k] of allVariants()) for (const st of chainSteps(c, k)) assert.ok(snapshot({ ...initialState(), chain: c, mapkey: k, step: chainSteps(c, k).indexOf(st) }).reads, `${c}: ${st.title} names the DTB it reads`);
  // the configuration-table copy in the FreeBSD chain is at the address loader.efi printed
  const s = chainSteps("efi-bsd");
  assert.equal(replayEvents(s, s.length - 1, false).dtbs.find((d) => d.key === "cfg").addr, "0xbd600000");
});

test("the stub's edits are the uefi primer's /chosen list, plus the /memory deletion", (t) => {
  const s = chainSteps("efi-linux");
  const { dtbs } = replayEvents(s, s.length - 1, false);
  const edit = dtbs.find((d) => d.key === "stub").edits.find((e) => !e.inherited).text;
  for (const p of ["bootargs", "uefi-system-table", "mmap", "kaslr-seed", "/memory", "memreserve"]) assert.ok(edit.includes(p), p);
  const booti = chainSteps("booti");
  const bEdit = replayEvents(booti, booti.length - 1, false).dtbs.find((d) => d.key === "uboot").edits.find((e) => !e.inherited).text;
  for (const p of ["bootargs", "linux,initrd-start", "linux,initrd-end", "memory"]) assert.ok(bEdit.includes(p), p);
  if (!existsSync(UEFI)) return t.skip("primer missing");
  assert.ok(readFileSync(UEFI, "utf8").includes("adds /chosen (bootargs, uefi-system-table, mmap, kaslr-seed)"));
});

test("the primers' Lab sections describe what the lab does", (t) => {
  if (!existsSync(UEFI) || !existsSync(UBOOT)) return t.skip("primers missing");
  const uefi = readFileSync(UEFI, "utf8");
  const uboot = readFileSync(UBOOT, "utf8");
  for (const p of ["x0` and `x1", "boot services are still", "who currently owns the DTB", "edit the DTB", "ExitBootServices` with a stale map key"]) {
    assert.ok(uefi.includes(p), `uefi primer: ${p}`);
  }
  assert.ok(uboot.includes("you click the owner and see the copy"));
  // features behind those sentences
  const sn = snapshot({ ...initialState(), chain: "efi-linux", step: 3, revealed: true });
  assert.equal(sn.step.x1, "the System Table");
  assert.ok(Object.keys(MAPKEY).includes("retry"));
});

test("direct boot lines up with the first and last firmware steps only", () => {
  assert.equal(alignedDirect(0, 7), directSteps()[0]);
  assert.equal(alignedDirect(6, 7), directSteps()[1]);
  for (let i = 1; i < 6; i++) assert.equal(alignedDirect(i, 7), null);
  const sn = snapshot({ ...initialState(), step: 3 });
  assert.equal(sn.direct, null);
  assert.equal(sn.directIndex, -1);
});

test("transitions: next, back, goto, guess, reveal, options", () => {
  let s = initialState();
  assert.equal(s.revealed, false);
  s = step(s, { type: "guess", owner: "uboot" });
  assert.equal(snapshot(s).correct, false);
  assert.match(summary(s), /Not U-Boot\. The DTB's owner is macvmm/);
  s = step(s, { type: "next" });
  assert.equal(s.step, 1);
  assert.equal(s.revealed, false);
  assert.match(summary(s), /Who owns the DTB now\?$/);
  s = step(s, { type: "guess", owner: "uboot" });
  assert.equal(snapshot(s).correct, true);
  s = step(s, { type: "guess", owner: "nobody" });
  assert.equal(s.guess, "uboot", "unknown owner ignored");
  s = step(s, { type: "goto", step: 99 });
  assert.equal(s.step, 1);
  s = step(s, { type: "goto", step: 6 });
  assert.equal(s.step, 6);
  assert.equal(step(s, { type: "next" }), s, "no step past the end");
  s = step(s, { type: "setMapKey", mapkey: "retry" });
  assert.equal(s.step, 6, "kept where possible");
  s = step(s, { type: "setChain", chain: "booti" });
  assert.equal(s.mapkey, "ok", "booti has no ExitBootServices");
  assert.equal(s.step, 0);
  assert.equal(step(s, { type: "setMapKey", mapkey: "ignore" }), s);
  assert.equal(step(s, { type: "setChain", chain: "edk2" }), s);
  s = step(s, { type: "setSkipQuiz", on: true });
  s = step(s, { type: "next" });
  assert.equal(s.revealed, true, "skip the questions reveals each step");
  s = step(s, { type: "reset" });
  assert.equal(s.chain, "efi-bsd");
  assert.equal(s.skipQuiz, true);
  assert.equal(step(s, { type: "bogus" }), s);
  // shortening the tail clamps the step
  let r = { ...initialState(), chain: "efi-bsd", mapkey: "retry", step: 8 };
  r = step(r, { type: "setMapKey", mapkey: "ok" });
  assert.equal(r.step, 6);
});

test("share state round-trips and the reference is quoted in LABS.md and lab.json", () => {
  assert.equal(encodeHash(initialState()), null, "the default clears the hash");
  for (const [c, k] of allVariants()) for (const fixup of [false, true]) {
    const n = chainSteps(c, k).length;
    for (let i = 0; i < n; i++) {
      const s = { ...initialState(), chain: c, mapkey: k, fixup, step: i };
      const enc = encodeHash(s);
      if (enc === null) continue;
      const back = decodeHash(enc);
      assert.deepEqual([back.chain, back.mapkey, back.fixup, back.step, back.revealed], [c, k, fixup, i, true]);
    }
  }
  const ref = decodeHash(REFERENCE);
  assert.equal(ref.chain, "efi-linux");
  assert.match(snapshot(ref).step.title, /stale key/);
  if (existsSync(LABS_MD)) assert.ok(readFileSync(LABS_MD, "utf8").includes(`\`${REFERENCE}\``), "LABS.md row names the reference");
  assert.equal(JSON.parse(readFileSync(LAB_JSON, "utf8")).reference, REFERENCE);
});

test("hostile share strings are refused", () => {
  for (const bad of [null, 7, "", "efi-bsd", "efi-bsd@0", "efi-bsd@10", "booti.kr@1", "booti@6", "efi-bsd.kx@1",
    "efi-bsd@1;alert(1)", "EFI-BSD@1", "efi-bsd.f.f@1", "efi-bsd@01", "x".repeat(1000), "efi-bsd.kr.f@1"]) {
    assert.throws(() => decodeHash(bad), `refused: ${String(bad).slice(0, 30)}`);
  }
  assert.equal(decodeHash("efi-bsd.kr@9").step, 8);
  assert.throws(() => decodeHash("efi-bsd@8"), /range/);
});

test("the extra table row is marked as the lab's own and the chain list is complete", () => {
  assert.deepEqual(CHAIN_TABLE_EXTRA.map((r) => r.key), ["efi-linux"]);
  assert.deepEqual(CHAINS.map((c) => c.id).sort(), ["booti", "efi-bsd", "efi-linux"]);
  assert.ok(chainSteps("efi-bsd").every((s) => s.title && s.loadedBy && s.where && s.pc && s.x0 && s.x1));
  assert.throws(() => chainSteps("edk2"));
  assert.throws(() => chainSteps("efi-bsd", "maybe"));
});

test("every step says why its owner owns the DTB, and the summary says it too", () => {
  for (const st of allSteps()) {
    assert.ok(typeof st.ownerWhy === "string" && st.ownerWhy.length > 20, `${st.title}: ownerWhy`);
  }
  const s = step(step(initialState(), { type: "next" }), { type: "guess", owner: "vmm" });
  assert.ok(summary(s).includes(chainSteps("efi-bsd")[1].ownerWhy));
});

test("registers the lab does not show are said in words, not a dash", () => {
  for (const st of allSteps()) for (const k of ["pc", "x0", "x1"]) assert.notEqual(st[k].trim(), "-", `${st.title}: ${k}`);
});

test("after ExitBootServices the System Table and runtime services survive; boot-services memory does not", () => {
  for (const c of ["efi-linux", "efi-bsd"]) for (const k of ["ok", "retry", "ignore"]) {
    const s = chainSteps(c, k);
    const keys = replayEvents(s, s.length - 1, false).regions.map((r) => r.what);
    assert.ok(keys.some((w) => /System Table and runtime services/.test(w)), `${c}/${k}: runtime kept`);
    assert.equal(keys.some((w) => /boot-services memory/.test(w)), k === "ignore", `${c}/${k}: boot-services memory`);
  }
  assert.match(BOOT_SERVICES.partial, /memory allocation services/);
});

test("the u-boot primer's DTB-copy address is explained against chapter 21's capture", (t) => {
  if (!existsSync(UBOOT)) return t.skip("primer missing");
  const capture = CAPTURES + "21-uboot-dtb.txt";
  if (existsSync(capture)) assert.ok(readFileSync(capture, "utf8").includes("fdtcontroladdr=5e6596e0"));
  const uboot = readFileSync(UBOOT, "utf8");
  assert.ok(uboot.includes("5e6596e0"), "primer names macvmm's address");
  assert.ok(chainSteps("booti")[2].note.includes("0x5e559d80"), "lab names the primer's QEMU address");
  // and the primers no longer say bootefi installs U-Boot's own copy
  const uefi = existsSync(UEFI) ? readFileSync(UEFI, "utf8") : "";
  assert.ok(!uefi.includes("installs U-Boot's DTB in the configuration table"));
  assert.ok(uboot.includes("$fdt_addr") || uboot.includes("`fdt_addr`"));
});
