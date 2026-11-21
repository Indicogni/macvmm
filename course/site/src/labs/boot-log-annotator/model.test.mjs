// Tests for the boot-log-annotator model (node --test). The lesson texts and captures are read at
// test time, so the lab cannot drift from them: the primer's eight-stage table, chapter 14's
// "line in the log" table and its three failure fingerprints, the primer's quoted log lines and
// self-check, macvmm's memory map in layout.rs, chapter titles in chapters.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as M from "./model.mjs";
import SAMPLES from "./samples.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REPO = here("../../../../../");
const read = (p) => readFileSync(REPO + p, "utf8");
const PRIMER = read("course/primers/linux-boot-sequence.md");
const CH14 = read("course/chapters/VI/14-linux-boot.md");
const sample = (id) => SAMPLES.samples.find((s) => s.id === id);
const run = (id) => M.annotate(sample(id).text);

/** Rows of the first Markdown table after `marker`: arrays of trimmed cells. */
function table(md, marker) {
  const at = md.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const lines = md.slice(at).split("\n");
  let i = lines.findIndex((l) => l.startsWith("|"));
  const rows = [];
  for (; i < lines.length && lines[i].startsWith("|"); i++) {
    // Split on pipes that are not inside backticks.
    const cells = [];
    let cur = "";
    let tick = false;
    for (const ch of lines[i].slice(1, lines[i].trimEnd().length - 1)) {
      if (ch === "`") tick = !tick;
      if (ch === "|" && !tick) { cells.push(cur.trim()); cur = ""; } else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows.slice(2); // header and separator
}
const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
/** A table's quoted line, with `...` meaning "anything", as a RegExp over a message. */
function quoted(label) {
  const parts = label.split("...").map((p) => p.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join(".*"));
}

// ---- the primer's eight stages ---------------------------------------------------------------

test("STAGES reproduce the primer's table: names, milestone lines, suspects and chapters", () => {
  const rows = table(PRIMER, "## The eight stages, mapped to lines");
  assert.equal(rows.length, 8);
  for (const [num, name, milestone, suspectCell] of rows) {
    const st = M.STAGES[Number(num)];
    assert.equal(st.name, name, `stage ${num} name`);
    const labels = ticks(milestone);
    // Stage 2's cell also mentions the earlycon line in brackets; the milestone is the first.
    const want = Number(num) === 2 ? labels.slice(0, 1) : labels;
    assert.deepEqual(st.milestones.map((m) => m.label), want, `stage ${num} milestones`);
    const chs = [...suspectCell.matchAll(/ch(\d\d)/g)].map((m) => m[1]);
    assert.deepEqual(st.ch, chs, `stage ${num} chapters`);
    const text = suspectCell.replace(/\s*\((?:ch\d\d(?:, )?)+\)/g, "");
    assert.equal(st.suspect, text, `stage ${num} suspect`);
  }
});

test("every milestone line is found in the healthy boot, by the rule that claims it", () => {
  const r = run("boot");
  for (let s = 1; s <= 8; s++) {
    for (const m of M.STAGES[s].milestones) {
      const re = quoted(m.label);
      const line = r.lines.find((l) => re.test(l.msg));
      assert.ok(line, `no line for ${m.label}`);
      assert.equal(line.ruleId, m.rule, m.label);
      assert.equal(line.kind, "milestone", m.label);
      assert.equal(line.stage, s, m.label);
    }
  }
  assert.equal(r.summary.completed, 8);
  assert.ok(r.summary.stages.every((x) => x.status === "done"));
  assert.equal(r.summary.ending, "power-off");
  assert.equal(r.summary.exit, 0);
  assert.equal(r.summary.exits, 32829);
});

// ---- chapter 14 -------------------------------------------------------------------------------

test("chapter 14's table: each line gets the lesson's stage and the chapters it names", () => {
  const rows = table(CH14, "| Line in the log | Stage | Caused by, in our machine |");
  assert.equal(rows.length, 14);
  const r = run("boot");
  for (const [lineCell, stageCell, causeCell] of rows) {
    const label = ticks(lineCell)[0];
    const re = quoted(label);
    const line = r.lines.find((l) => re.test(l.msg));
    assert.ok(line, `chapter 14 quotes a line the capture lacks: ${label}`);
    const want = /^after/.test(stageCell) ? 8 : Number(stageCell.split(",")[0]);
    assert.equal(line.stage, want, `stage of ${label}`);
    assert.ok(line.ruleId, `no annotation for ${label}`);
    assert.ok(["milestone", "machine"].includes(line.kind), `${label} is caused by our machine`);
    const rule = M.ruleById(line.ruleId);
    const cited = [...causeCell.matchAll(/chapters? (\d\d)(?: and (\d\d))?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean);
    for (const c of cited) assert.ok(rule.ch.includes(c), `${label}: the lesson cites chapter ${c}, the lab does not`);
  }
});

test("chapter 14's objective: at least 20 lines of the boot mapped to a part of our machine", () => {
  const r = run("boot");
  const mapped = r.lines.filter((l) => l.kind === "milestone" || l.kind === "machine");
  assert.ok(mapped.length >= 20, `only ${mapped.length}`);
  const withNode = mapped.filter((l) => M.ruleById(l.ruleId).node);
  assert.ok(withNode.length >= 20, `only ${withNode.length} name a device-tree node`);
});

test("chapter 14's three fingerprints: last stage reached, what the kernel says, macvmm's exit", () => {
  const rows = table(CH14, "| Broken part | Last stage reached | Kernel says | `macvmm` exit |");
  assert.equal(rows.length, 3);
  const ids = ["no-timer", "wrong-gicr", "no-id"];
  rows.forEach(([, reachedCell, saysCell, exitCell], i) => {
    const r = run(ids[i]);
    assert.equal(r.summary.reached, Number(reachedCell.split(",")[0]), `${ids[i]} reached`);
    const says = ticks(saysCell)[0];
    const fail = r.lines.find((l) => l.kind === "failure" && l.msg.includes(says));
    assert.ok(fail, `${ids[i]}: no failure line saying ${says}`);
    assert.equal(r.summary.exit, Number(exitCell.split(",")[0]), `${ids[i]} exit`);
  });
});

test("the three breakages: what the verdict says", () => {
  const nt = run("no-timer").summary;
  assert.equal(nt.completed, 3);
  assert.equal(nt.waiting, 4);
  assert.equal(nt.ending, "panic");
  assert.equal(nt.panic, "Unable to initialise architected timer.");
  assert.equal(nt.traceStage, 4);
  assert.equal(nt.firstFailure, 61);
  assert.ok(nt.allZero && !nt.schedClock);
  assert.match(nt.text, /suspect: \/timer node \(compatible, PPIs\), CNTFRQ_EL0; vtimer exits only with --irqchip none \(chapter 11\)/i);
  assert.match(nt.text, /status 5/);

  const gr = run("wrong-gicr").summary;
  assert.equal(gr.completed, 2);
  assert.equal(gr.waiting, 3);
  assert.equal(gr.panic, "Attempted to kill the idle task!");
  assert.equal(gr.traceStage, 3);
  assert.match(gr.text, /\/intc node, GIC bases \(chapter 12\)/);

  const ni = run("no-id").summary;
  assert.equal(ni.reached, 8);
  assert.equal(ni.completed, 5);
  assert.equal(ni.stages[5].status, "partial");
  assert.deepEqual(ni.stages[5].milestones.map((m) => m.line === null), [true, false]);
  assert.equal(ni.ending, "power-off");
  assert.match(ni.text, /stage 6 \(Driver binding\) is incomplete: no ttyAMA0 at MMIO 0x9000000 line/);
  assert.equal(ni.exits, 35470);

  const si = run("silent").summary;
  assert.equal(si.lineCount, 0);
  assert.equal(si.ending, "empty");
  assert.equal(si.exits, 82);
  assert.equal(si.exit, 0);
  assert.match(si.text, /Nothing reached the serial port\. Yet the VMM counted 82 exits/);

  const pa = run("panic").summary;
  assert.equal(pa.completed, 8);
  assert.equal(pa.panic, "sysrq triggered crash");
  assert.equal(pa.exit, 4);
});

test("the wrong-redistributor Oops links into the ESR decoder and PSTATE builder, which accept the values", async () => {
  const r = run("wrong-gicr");
  const esr = r.lines.find((l) => l.ruleId === "esr");
  assert.equal(esr.link.href, "/build-your-own/vmm/labs/esr-decoder/#esr-decoder=0x96000044");
  const E = await import("../esr-decoder/model.mjs");
  const parsed = E.parseEsr("0x96000044");
  assert.ok(parsed.ok);
  assert.equal(parsed.value, 0x96000044n);
  const ps = r.lines.find((l) => l.ruleId === "pstate");
  assert.equal(ps.link.href, "/build-your-own/vmm/labs/pstate-builder/#pstate-builder=0x600000c5");
  const P = await import("../pstate-builder/model.mjs");
  assert.ok(P.decode("0x600000c5"));
  const paging = r.lines.find((l) => l.ruleId === "paging");
  assert.match(paging.notes.join(" "), /0x10100 = a redistributor base of 0 \+ 0x10000/);
});

test("checks against macvmm's machine on the healthy boot", () => {
  const r = run("boot");
  const notes = (id) => r.lines.find((l) => l.ruleId === id).notes.join(" ");
  assert.match(notes("gicr"), /0x80a0000 = 0x080a_0000 \+ 0 × 0x2_0000/);
  assert.match(notes("ttyama"), /MMIO 0x9000000: the node's `reg`/);
  assert.match(notes("ttyama"), /rev1: from peripheral ID 0x00141011/);
  assert.match(notes("initrd-freed"), /9,204 KiB/);
  assert.match(notes("memory"), /524288K = 512 MiB/);
  assert.match(notes("mem-node"), /512 MiB starting at 0x40000000/);
  assert.match(notes("model"), /macvmm-virt/);
  assert.match(notes("lpj"), /= 24,000/);
  // The initrd arithmetic in the note is the DTB's own numbers.
  const dts = M.dtsFromCapture(SAMPLES.dts.text);
  assert.match(dts, /linux,initrd-start = <0x00 0x42600000>/);
  assert.match(dts, /linux,initrd-end = <0x00 0x42efd8fc>/);
  assert.equal(((0x42efd8fc & ~0xfff) - 0x42600000) / 1024, 9204);
  // Secondary redistributors (chapter 20's capture): stage 5, macvmm's stride.
  const smp = M.annotate(read("course/captures/20-linux-smp-log.txt"));
  const cpu3 = smp.lines.find((l) => /CPU3: found redistributor 3/.test(l.msg));
  assert.equal(cpu3.stage, 5);
  assert.equal(cpu3.kind, "machine");
  assert.match(cpu3.notes.join(" "), /0x8100000 = 0x080a_0000 \+ 3 × 0x2_0000/);
  assert.equal(smp.lines.find((l) => l.ruleId === "smp-up").notes[0], "4 CPUs: one per `cpu` node in the DT.");
});

// ---- the primer's quoted lines and self-check ------------------------------------------------

test("the primer's quoted boot lines are all recognised, in the primer's stages", () => {
  const blocks = [...PRIMER.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);
  const logLines = blocks.flatMap((b) => b.split("\n")).filter((l) => /^\[\s*\d+\.\d+\]/.test(l));
  assert.ok(logLines.length > 30);
  const r = M.annotate(logLines.join("\n"));
  const by = (re) => r.lines.find((l) => re.test(l.msg));
  assert.equal(by(/^Machine model: linux,dummy-virt/).notes[0].includes("QEMU"), true);
  assert.equal(by(/^earlycon: pl11/).ruleId, "earlycon");
  assert.equal(by(/^GICv3: CPU0: found redistributor/).stage, 3);
  assert.equal(by(/^arch_timer:/).stage, 4);
  assert.equal(by(/^timer_probe:/).kind, "failure");
  assert.equal(by(/^Freeing initrd memory/).stage, 7);
  assert.equal(by(/^Run \/init/).stage, 8);
  assert.equal(by(/^Mounting boot media: failed/).kind, "failure");
  assert.equal(by(/^Kernel panic - not syncing: Attempted to kill init!/).ruleId, "panic-init");
  // The initcall_debug excerpt: two calls start and the excerpt ends before they return.
  assert.deepEqual(r.summary.hungInitcalls.map((h) => h.name), ["populate_rootfs", "pl031_driver_init"]);
  // Every quoted line with a recognisable shape gets a rule (only a few housekeeping lines do not).
  const unknown = r.lines.filter((l) => !l.ruleId).map((l) => l.msg);
  assert.ok(unknown.length <= 4, `unrecognised: ${unknown.join(" | ")}`);
});

test("time stamps stay at zero until sched_clock, as the primer says", () => {
  const r = run("boot");
  const sc = r.lines.findIndex((l) => l.ruleId === "sched-clock");
  assert.ok(sc > 0);
  assert.ok(r.lines.slice(0, sc + 1).every((l) => l.ts === 0));
  assert.ok(r.lines[sc + 1].ts > 0);
});

test("self-check: thirty lines stamped 0.000000 that stop", () => {
  const lines = M.splitInput(sample("boot").text).lines.slice(0, 30);
  const s = M.annotate(lines.join("\n")).summary;
  assert.ok(s.allZero);
  assert.ok(s.completed < 4);
  assert.ok(s.sentences.some((t) => /^Every time stamp is 0\.000000.*`sched_clock`.*stage 4/.test(t)));
  assert.equal(s.ending, "stopped");
});

test("self-check: no earlycon, empty serial port", () => {
  const s = M.annotate("").summary;
  assert.equal(s.ending, "empty");
  assert.match(s.text, /earlycon=pl011,0x09000000/);
});

// ---- review fixes: what the verdict must (and must not) claim -------------------------------

test("the MIDR note says it is Hypervisor.framework's default, never the real CPU's identity", () => {
  const line = run("boot").lines[0];
  assert.equal(line.ruleId, "booting");
  const text = [M.ruleById("booting").what, ...line.notes].join(" ");
  assert.match(text, /part number 0: Hypervisor\.framework's default `MIDR_EL1`, not the chip's own/);
  assert.ok(!/real CPU's identity|identifies the CPU model/.test(text), text);
});

test("the silent run: exit 0 means the console never registered, a stage 6 binding failure", () => {
  const s = run("silent").summary;
  assert.equal(s.serialWritten, 0);
  assert.match(s.text, /status 0: the guest powered off/);
  assert.match(s.text, /serial_written=0/);
  assert.match(s.text, /stage 6's binding of ttyAMA0 failed\. Suspect: the PL011's identification registers, its compatible and reg \(chapters 09 and 10\)/);
  assert.ok(!/stuck \(or dead\) in any stage/.test(s.text), "exit 0 contradicts 'stuck in stages 1 to 5'");
  // With no exit status, every stage before 6 is still a suspect.
  const bare = M.annotate("").summary;
  assert.match(bare.text, /stuck \(or dead\) in any stage before that/);
  const timeout = M.annotate(sample("silent").text.replace("exit: 0", "exit: 5")).summary;
  assert.match(timeout.text, /stuck \(or dead\)/);
});

test("a log that starts mid-boot: earlier stages are not in it, not missing", () => {
  const lines = M.splitInput(sample("boot").text).lines;
  const s = M.annotate(lines.slice(60).join("\n")).summary;
  assert.equal(s.midBoot, true);
  assert.deepEqual(s.stages.map((x) => x.status), ["absent", "absent", "absent", "done", "done", "done", "done", "done"]);
  assert.equal(s.completed, 8);
  assert.match(s.text, /This log starts mid-boot: its earliest line belongs to stage 4/);
  assert.ok(!/No stage completed|entry state/.test(s.text), s.text);
  // Chapter 20's grep-filtered capture: stages 1 and 2 not in it, stage 4 filtered out.
  const g = M.annotate(read("course/captures/20-linux-smp-log.txt")).summary;
  assert.equal(g.midBoot, true);
  assert.equal(g.stages[0].status, "absent");
  assert.equal(g.stages[3].status, "absent");
  assert.deepEqual(g.filteredGaps, [4]);
  assert.ok(!/No stage completed|entry state/.test(g.text), g.text);
  assert.match(g.text, /excerpt or was filtered/);
});

test("stage 7's background lines do not count as reaching stage 7", () => {
  const lines = M.splitInput(sample("boot").text).lines;
  const unpack = lines.findIndex((l) => /Unpacking initramfs/.test(l));
  const rtc = lines.findIndex((l) => /rtc-pl031 .*registered as rtc0/.test(l));
  assert.ok(unpack > 0 && rtc > unpack);
  for (let cut = unpack + 1; cut <= rtc; cut++) {
    const s = M.annotate(lines.slice(0, cut).join("\n")).summary;
    assert.equal(s.reached, 6, `cut at ${cut}`);
    assert.ok(!/reached stage 7/.test(s.text), `cut at ${cut}: ${s.text}`);
    assert.match(s.text, /stops while stages 6 \(Driver binding\) and 7 \(initramfs\) run together/);
  }
});

test("chapter 13's BSS overlap: the verdict names stage 7's suspects too", () => {
  const r = M.annotate(read("course/captures/13-initrd-in-bss.txt"));
  const s = r.summary;
  assert.equal(s.exit, 5);
  assert.equal(s.ending, "stopped");
  assert.equal(s.reached, 6);
  assert.equal(s.sixSeven, true);
  assert.match(s.text, /The next line in order would be Unpacking initramfs\.\.\./);
  assert.match(s.text, /\/chosen initrd addresses, BSS overlap \(chapter 13\)/);
  assert.match(M.ruleById("initrd-fail").cause, /silent stall before `Unpacking initramfs\.\.\.`/);
});

test("an exit status counts only when the capture's command ran macvmm, and only 0 to 255", () => {
  const smp = M.splitInput(read("course/captures/20-linux-smp-log.txt")).info;
  assert.match(smp.command, /^grep /);
  assert.equal(smp.exit, null);
  assert.ok(!/macvmm exited/.test(M.annotate(read("course/captures/20-linux-smp-log.txt")).summary.text));
  const cap = (cmd, exit) => `# h\n$ ${cmd}\nexit: ${exit}\n--- stdout ---\n[    0.000000] Booting Linux on physical CPU 0x0 [0x610f0000]\n--- stderr ---\n`;
  assert.equal(M.splitInput(cap("cargo run -q -p macvmm -- run --kernel K", 3)).info.exit, 3);
  assert.equal(M.splitInput(cap("target/release/macvmm run --kernel K", 0)).info.exit, 0);
  assert.equal(M.splitInput(cap("scripts/run-linux.sh --test boot", 5)).info.exit, 5);
  assert.equal(M.splitInput(cap("cargo run -q -p macvmm -- run --kernel K", 999)).info.exit, null);
  assert.equal(M.splitInput(cap("cat boot.txt", 0)).info.exit, null);
});

test("the call-trace function the verdict names is the frame actually in the log", () => {
  const head = "[    0.000000] Booting Linux on physical CPU 0x0 [0x610f0000]\n[    0.000000] Kernel panic - not syncing: boom\n[    0.000000] Call trace:\n";
  const a = M.annotate(`${head}[    0.000000]  timer_probe+0x10/0x20\n`).summary;
  assert.equal(a.traceFn, "timer_probe");
  assert.match(a.text, /with timer_probe in the call trace \(stage 4\)/);
  const b = M.annotate(`${head}[    0.000000]  gic_of_init+0x10/0x20\n`).summary;
  assert.match(b.text, /with gic_of_init in the call trace \(stage 3\)/);
  assert.equal(run("no-timer").summary.traceFn, "time_init");
});

test("zone lines are described from their own numbers", () => {
  const r = run("boot");
  const dma = r.lines.find((l) => /^\s+DMA\s+\[mem/.test(l.msg));
  assert.match(dma.notes.join(" "), /`DMA`: 512 MiB, 0x40000000 to 0x5fffffff, all below 4 GiB/);
  assert.match(dma.notes.join(" "), /--mem 512M/);
  assert.ok(!/512 MiB/.test(M.ruleById("zones").what));
  const big4 = M.annotate("[    0.000000]   DMA      [mem 0x0000000040000000-0x00000000ffffffff]\n[    0.000000]   DMA32    empty\n[    0.000000]   Normal   [mem 0x0000000100000000-0x000000013fffffff]");
  assert.match(big4.lines[0].notes.join(" "), /3072 MiB.*all below 4 GiB/);
  assert.ok(!/--mem 512M/.test(big4.lines[0].notes.join(" ")));
  assert.match(big4.lines[1].notes.join(" "), /`DMA32` is empty/);
  assert.match(big4.lines[2].notes.join(" "), /1024 MiB.*all above 4 GiB/);
});

test("the stage 3 stop and the all-zero stamps read as one finding, not two", () => {
  const s = run("wrong-gicr").summary;
  assert.match(s.text, /Every time stamp is 0\.000000, which fits: sched_clock, the clock behind the stamps, only starts in stage 4, and this boot stopped in stage 3\./);
  assert.ok(!/stopped before finishing stage 4/.test(s.text));
});

test("text that is not a boot log gets no stage diagnosis", () => {
  for (const t of ["hello\nworld", "error[E0308]: mismatched types\n  --> src/main.rs:4:5", "$ ls\nfoo bar"]) {
    const s = M.annotate(t).summary;
    assert.equal(s.notLog, true, t);
    assert.match(s.text, /^This does not look like a Linux boot log/);
    assert.ok(!/Suspect|entry state|stage/.test(s.text.replace(/does not look like a Linux boot log/, "")), s.text);
    assert.equal(s.waiting, null);
  }
});

test("broken runs open on their first milestone, not on the answer", () => {
  assert.equal(M.defaultLine(run("no-id"), { quiz: true }), 1);
  assert.equal(M.defaultLine(run("silent"), { quiz: true }), null);
  assert.equal(M.defaultLine(run("no-id")), run("no-id").summary.firstFailure);
});

test("sample names and blurbs do not give the breakages away", () => {
  for (const sm of SAMPLES.samples.filter((x) => x.quiz)) {
    const t = `${sm.label} ${sm.about}`;
    assert.ok(!/timer|redistributor|identification|ID register|PL011|breakage/i.test(t), t);
  }
});

// ---- input handling --------------------------------------------------------------------------

test("a capture and its plain stdout annotate the same lines", () => {
  const cap = sample("no-timer").text;
  const { lines, info } = M.splitInput(cap);
  assert.equal(info.format, "capture");
  assert.equal(info.exit, 5);
  assert.match(info.header[1], /Deliberate breakage 1/);
  assert.match(info.stderr[0], /^macvmm: timeout/);
  assert.equal(lines.length, 74);
  assert.ok(lines.every((l) => !l.endsWith("\\x0d")));
  const plain = M.annotate(lines.map((l) => `${l}\r\n`).join(""));
  const viaCap = M.annotate(cap);
  assert.deepEqual(plain.lines.map((l) => [l.stage, l.ruleId]), viaCap.lines.map((l) => [l.stage, l.ruleId]));
  assert.equal(plain.summary.exit, null);
  // dmesg -r style level prefixes
  const d = M.annotate("<6>[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x610f0000]\n<4>[    0.1] Machine model: x");
  assert.equal(d.lines[0].level, 6);
  assert.equal(d.lines[0].ruleId, "booting");
  assert.equal(d.lines[1].ts, 0.1);
});

test("hostile input: control bytes and bidi overrides are shown, sizes are capped, nothing is slow", () => {
  const r = M.annotate("[    0.000000] Machine model: \u001b[2J‮evil\u0007\n<script>alert(1)</script>");
  assert.equal(r.lines[0].text, "[    0.000000] Machine model: \\x1b[2J\\u{202e}evil\\x07");
  assert.equal(r.lines[1].text, "<script>alert(1)</script>");
  assert.equal(r.summary.escapes, 3);
  assert.match(r.summary.text, /3 control bytes are shown as escapes/);

  const long = "[    0.000000] " + "a".repeat(100000);
  const rl = M.annotate(long);
  assert.equal(rl.lines[0].cut, true);
  assert.ok(rl.lines[0].text.length <= M.LIMITS.maxLineLen);

  const many = Array.from({ length: 30000 }, (_, i) => `line ${i}`).join("\n");
  const rm = M.annotate(many);
  assert.equal(rm.lines.length, M.LIMITS.maxLines);
  assert.ok(rm.summary.truncated);

  // 2 MiB of near-misses for every rule: must stay fast (no catastrophic backtracking).
  const junk = ("[ 0.000000] GICv3: CPU0: found redistributor 0 region 0:0x" + "0".repeat(1900) + "\n").repeat(1100);
  const t0 = Date.now();
  const rj = M.annotate(junk);
  assert.ok(rj.summary.truncated);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);

  assert.deepEqual(M.annotate(null).lines, []);
  assert.deepEqual(M.annotate(12345).lines, []);
});

test("every rule's pattern is anchored, and every rule's links and nodes resolve", () => {
  const dts = M.parseDts(M.dtsFromCapture(SAMPLES.dts.text));
  for (const r of M.RULES) {
    assert.ok(r.re.source.startsWith("^"), `${r.id} is not anchored`);
    assert.ok(r.title && r.what, `${r.id} lacks text`);
    for (const c of r.ch || []) assert.ok(M.CHAPTERS[c], `${r.id} cites unknown chapter ${c}`);
    for (const p of r.primers || []) assert.ok(M.PRIMERS[p], `${r.id} cites unknown primer ${p}`);
    if (r.node) assert.ok(M.dtsNode(dts, r.node), `${r.id}: node ${r.node} is not in the captured DTB`);
    // Learner-visible text: no internal IDs (STYLE A.10).
    for (const t of [r.title, r.what, r.cause || ""]) assert.ok(!/\b(M\d+|K\d+|R\d+|L[123]|PLAN|CURRICULUM)\b|§/.test(t), `${r.id}: ${t}`);
  }
  assert.equal(new Set(M.RULES.map((r) => r.id)).size, M.RULES.length);
});

test("parseDts gives each node its block, the root only its own properties", () => {
  const dts = M.parseDts(M.dtsFromCapture(SAMPLES.dts.text));
  assert.equal(dts.get("/timer").split("\n")[0], "timer {");
  assert.match(dts.get("/timer"), /compatible = "arm,armv8-timer", "arm,armv7-timer";/);
  assert.match(dts.get("/intc@8000000"), /reg = <0x00 0x8000000 0x00 0x10000 0x00 0x80a0000 0x00 0x20000>;/);
  assert.equal(dts.get("/cpus/cpu@0").split("\n")[0], "cpu@0 {");
  const root = dts.get("/");
  assert.match(root, /model = "macvmm-virt";/);
  assert.ok(!root.includes("chosen {") && !root.includes("bootargs"));
  // Hostile depth does not blow up.
  const deep = Array.from({ length: 100 }, (_, i) => `${"\t".repeat(i)}n${i} {`).join("\n");
  assert.ok(M.parseDts(deep) instanceof Map);
});

// ---- references to the rest of the repo --------------------------------------------------------

test("LAYOUT matches crates/vmm/src/arch/layout.rs", () => {
  const src = read("crates/vmm/src/arch/layout.rs");
  for (const [k, v] of Object.entries(M.LAYOUT)) {
    const m = new RegExp(`pub const ${k}: u\\d+ = (0x[0-9A-Fa-f_]+|\\d+);`).exec(src);
    assert.ok(m, `${k} not in layout.rs`);
    assert.equal(Number(m[1].replace(/_/g, "")), v, k);
  }
});

test("CHAPTERS and PRIMERS match chapters.json", () => {
  const cj = JSON.parse(read("course/chapters.json"));
  for (const [id, [title, path]] of Object.entries(M.CHAPTERS)) {
    const c = cj.chapters.find((x) => x.id === id);
    assert.ok(c, id);
    assert.equal(c.title, title, `chapter ${id} title`);
    assert.equal(c.url, path, `chapter ${id} url`);
  }
  for (const [slug, title] of Object.entries(M.PRIMERS)) {
    const p = cj.primers.find((x) => x.slug === slug);
    assert.ok(p, slug);
    assert.equal(p.title, title, slug);
  }
  const lab = cj.labs.find((l) => l.name === "boot-log-annotator");
  assert.deepEqual(lab.chapters, ["14"]);
});

test("EXIT_MEANING covers every code StopReason::exit_code returns", () => {
  const src = read("crates/vmm/src/control.rs");
  const fn = src.slice(src.indexOf("pub fn exit_code(&self) -> i32"), src.indexOf("// ANCHOR_END: exit_code_match"));
  const codes = [...fn.matchAll(/=> (\d+),/g)].map((m) => Number(m[1]));
  assert.ok(codes.length >= 5);
  for (const c of codes) assert.ok(M.EXIT_MEANING[c], `no meaning for exit ${c}`);
  for (const c of [1, 2]) assert.ok(M.EXIT_MEANING[c]);
});

// ---- share state -----------------------------------------------------------------------------

test("share state round-trips; the reference opens on the no-timer probe line", () => {
  const ref = M.decodeShare(M.REFERENCE);
  assert.deepEqual(ref, { sample: "no-timer", colour: "s", onlyAnnotated: false, line: 61 });
  assert.equal(M.encodeShare(ref), M.REFERENCE);
  const r = run("no-timer");
  assert.equal(r.lines[60].ruleId, "timer-probe");
  assert.equal(M.defaultLine(r), 61);
  assert.equal(M.encodeShare(M.DEFAULT_STATE), null);
  for (const st of [
    { sample: "wrong-gicr", colour: "k", onlyAnnotated: true, line: 56 },
    { sample: "paste", colour: "s", onlyAnnotated: false, line: null },
    { sample: "boot", colour: "s", onlyAnnotated: true, line: null },
  ]) assert.deepEqual(M.decodeShare(M.encodeShare(st)), st);
  for (const bad of ["", "x", "boot", "boot.z", "boot.s.0", "boot.s.a.a", "boot.s.12.13", "boot.s.-1", "<img src=x>", "boot.s." + "9".repeat(80), null, 7, "constructor.s", "__proto__.s"]) {
    assert.equal(M.decodeShare(bad), null, String(bad));
  }
});

test("lab.json's reference and captures agree with the model and the samples", () => {
  const lab = JSON.parse(readFileSync(here("./lab.json"), "utf8"));
  assert.equal(lab.reference, M.REFERENCE);
  assert.deepEqual(lab.captures, [...SAMPLES.samples.map((s) => s.source), SAMPLES.dts.source]);
  assert.deepEqual(M.SAMPLE_IDS, SAMPLES.samples.map((s) => s.id));
});
