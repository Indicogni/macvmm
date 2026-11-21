#!/usr/bin/env node
// Pack a real `macvmm run --trace exits:FILE:all` trace for the boot-timeline lab, losslessly.
//
//   node course/site/tools/pack-boot-trace.mjs pack --id ID --jsonl T.jsonl --stdout T.out \
//        --stderr T.err --exit N --meta META.json --out course/site/src/labs/boot-timeline/traces/ID.json
//   node course/site/tools/pack-boot-trace.mjs fallback --out course/site/src/labs/boot-timeline/fallback.svg
//
// `pack` refuses a trace that does not round-trip byte for byte, or whose PL011 data-register
// writes do not rebuild the run's stdout exactly; it records the sha256 of both, so
// src/labs/boot-timeline/model.test.mjs can prove the shipped data is the real run.
// `fallback` draws the static picture (healthy boot against breakage 1) from the shipped packs.
// Node built-ins only. Not shipped (it is outside src/labs).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  packTrace, unpackToJsonl, loadPack, analyze, makeAxis, bin, level, fmtTime, fmtInt, KIND_INDEX,
} from "../src/labs/boot-timeline/model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const LAB = join(here, "..", "src", "labs", "boot-timeline");
const sha = (b) => createHash("sha256").update(b).digest("hex");

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || i + 1 >= argv.length) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function pack(a) {
  for (const k of ["id", "jsonl", "stdout", "stderr", "exit", "meta", "out"]) if (!a[k]) throw new Error(`--${k} is required`);
  const raw = readFileSync(a.jsonl);
  const text = raw.toString("utf8");
  const stdout = readFileSync(a.stdout);
  const meta = JSON.parse(readFileSync(a.meta, "utf8"));
  meta.exit = Number(a.exit);
  meta.stderr = readFileSync(a.stderr, "utf8").split("\n").filter(Boolean);
  meta.sha256 = sha(raw);
  meta.bytes = raw.length;
  meta.stdoutSha256 = sha(stdout);
  const p = packTrace(text, { id: a.id, meta });
  meta.records = p.rows.length / 3;
  const back = unpackToJsonl(p);
  if (back !== text) throw new Error("the pack does not expand to the original file");
  const L = loadPack(p);
  if (!L.ok || L.errorCount) throw new Error("the pack does not load cleanly");
  const bytes = Buffer.from(L.records.filter((r) => r.kind === KIND_INDEX["uart-tx"]).map((r) => parseInt(r.value, 16) & 0xff));
  if (sha(bytes) !== meta.stdoutSha256) throw new Error("the PL011 data-register writes do not rebuild stdout");
  const json = JSON.stringify(p);
  writeFileSync(a.out, json + "\n");
  console.log(`${a.id}: ${meta.records} records, ${raw.length} bytes -> ${json.length} bytes packed; sha256 ${meta.sha256}`);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function fallback(a) {
  const load = (id) => {
    const p = JSON.parse(readFileSync(join(LAB, "traces", `${id}.json`), "utf8"));
    const L = loadPack(p);
    return { meta: p.meta, A: analyze(L.records) };
  };
  const rows = [load("healthy"), load("notimer")];
  const W = 720, LX = 150, PW = W - LX - 12, NB = 120;
  let y = 40;
  const parts = [];
  const descParts = [];
  for (const { meta, A } of rows) {
    const axis = makeAxis(A, { squeeze: true });
    const view = { v0: 0, v1: 1 };
    const b = bin(A, axis, view, new Set(), NB);
    const counts = b.counts.get("vcpu0");
    parts.push(`<text x="12" y="${y + 13}" font-size="12">${esc(meta.short)}</text>`);
    parts.push(`<rect x="${LX}" y="${y}" width="${PW}" height="18" fill="none" stroke="currentColor" stroke-width="0.5"/>`);
    counts.forEach((c, i) => {
      const lv = level(c, b.max);
      if (lv) parts.push(`<rect x="${(LX + (i * PW) / NB).toFixed(1)}" y="${y + 1}" width="${(PW / NB).toFixed(1)}" height="16" fill="currentColor" fill-opacity="${[0.4, 0.55, 0.7, 0.85, 1][lv - 1]}"/>`);
    });
    for (const s of axis.segs.filter((s) => s.squeezed)) {
      const x0 = LX + s.x0 * PW, x1 = LX + s.x1 * PW;
      parts.push(`<rect x="${x0.toFixed(1)}" y="${y - 2}" width="${(x1 - x0).toFixed(1)}" height="22" fill="none" stroke="currentColor" stroke-dasharray="3 2"/>`);
      parts.push(`<text x="${((x0 + x1) / 2).toFixed(1)}" y="${y + 34}" font-size="10" text-anchor="middle">${esc(fmtTime(s.t1 - s.t0))} silent</text>`);
    }
    for (const m of A.milestones.filter((m) => m.stage)) {
      const x = LX + (b.consoleMarks.find((c) => c.line === m.line)?.x ?? 0) * PW;
      parts.push(`<text x="${x.toFixed(1)}" y="${y - 3}" font-size="9" text-anchor="middle">${m.stage}</text>`);
    }
    for (const f of A.failures.slice(0, 1)) {
      const x = LX + (b.consoleMarks.find((c) => c.line === f.line)?.x ?? 0) * PW;
      parts.push(`<text x="${x.toFixed(1)}" y="${y + 34}" font-size="10" text-anchor="middle" font-weight="bold">! ${esc(f.label)}</text>`);
    }
    const fp = A.fingerprint;
    descParts.push(`${meta.short}: ${fmtInt(A.count)} exits over ${fmtTime(A.tEnd)}; last stage reached ${fp.stageText}.${fp.kernelSays.length ? ` The kernel says: ${fp.kernelSays.join(", ")}.` : ""} ${fp.ended.text}`);
    y += 62;
  }
  parts.push(`<text x="${LX}" y="${y}" font-size="10">Darker = more exits in that slice of time. Numbers above a strip are boot stages 1 to 8 from the console output.</text>`);
  const svg = `<svg viewBox="0 0 ${W} ${y + 10}" width="100%" fill="currentColor" font-family="system-ui, sans-serif">
<title>Boot timeline: the healthy boot against a boot with no timer node</title>
<desc>Exit density over time for two real runs of chapter 14's Linux boot, one strip each, each on its own time scale; the long silence of the second run is squeezed into a dashed box. ${esc(descParts.join(" "))}</desc>
${parts.join("\n")}
</svg>
`;
  writeFileSync(a.out, svg);
  console.log(`wrote ${a.out} (${svg.length} bytes)`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "pack") pack(args(rest));
else if (cmd === "fallback") fallback(args(rest));
else { console.error("usage: pack-boot-trace.mjs pack|fallback --flag value ..."); process.exit(2); }
