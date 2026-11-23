#!/usr/bin/env node
// Pre-render the course's diagrams to sanitized SVG (DESIGN.md section 3.6). Node built-ins only.
//
//   node course/site/tools/diagrams.mjs           write docs/diagrams/*.svg, github/*.svg and src/*.mmd
//   node course/site/tools/diagrams.mjs --check   fail if any written file differs from what it would write
//
// Why not Mermaid itself: the site never loads Mermaid (CSP 'self', zero dependencies), and a
// diagram a learner reads on a phone deserves a layout someone chose. So each diagram below is
// written twice, on purpose: its Mermaid source (kept in docs/diagrams/src/ for anyone who wants
// to edit it in a Mermaid tool) and a small layout spec this file turns into SVG. Edit both.
//
// Output rules, checked again by lib/svg.mjs when the page is built: no <style>, no style=, no
// scripts or handlers, nothing external; a <title> and a <desc> that is a complete text version
// of the diagram. Colours come from the site's tokens through classes (`.dg-*` in course.css),
// with currentColor presentation attributes as the fallback, so light and dark mode both work.
//
// Each diagram is also written to docs/diagrams/github/NAME.svg for Markdown read on GitHub
// (the README), which shows an SVG only through <img>, where the site's CSS cannot reach. That
// copy is the same markup plus one <style> holding the `.dg` rules of course.css with every
// var(--token) replaced by its light value, again under prefers-color-scheme: dark with the dark
// values, and an opaque background, so it stays legible when GitHub's theme and the reader's
// system scheme disagree. The site never inlines those files: the sanitizer refuses <style>.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { themeTokens } from "../lib/checks.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = join(REPO, "docs", "diagrams");
const CSS = join(REPO, "course", "site", "src", "assets", "course.css");

const FS = 14; // node text
const FS_LABEL = 13; // edge labels
const LINE = 1.3;
const CHAR = 0.56; // average glyph width / font size for the system sans stack (generous)

const escXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const textWidth = (s, fs) => s.length * fs * CHAR;
const r1 = (n) => Math.round(n * 10) / 10;

/** Split on explicit breaks ("\n"), then wrap each piece to `maxw` pixels. */
function wrap(text, maxw, fs) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = line ? `${line} ${word}` : word;
      if (line && textWidth(cand, fs) > maxw) { out.push(line); line = word; } else line = cand;
    }
    out.push(line);
  }
  return out;
}

function textBlock(lines, cx, cy, fs, cls = "dg-text", anchor = "middle") {
  if (!lines.length) return "";
  const h = lines.length * fs * LINE;
  const y0 = cy - h / 2 + fs * LINE / 2 + fs * 0.35;
  return lines.map((l, i) => `<text class="${cls}" x="${r1(cx)}" y="${r1(y0 + i * fs * LINE)}" font-size="${fs}" text-anchor="${anchor}" fill="currentColor">${escXml(l)}</text>`).join("");
}

function arrowDefs(id) {
  return `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dg-arrow" d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>`;
}

function svgDoc(name, w, h, title, desc, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" class="dg" font-family="system-ui, -apple-system, sans-serif">\n` +
    `<title>${escXml(title)}</title>\n<desc>${escXml(desc)}</desc>\n${arrowDefs(`${name}-arrow`)}\n${body}\n</svg>\n`
  );
}

// ---------------------------------------------------------------------------------------------
// Sequence diagrams: participants in columns, messages top to bottom.

function sequence(name, spec) {
  const colW = spec.colW || 170;
  const pad = 16;
  const heads = spec.participants.map((p, i) => ({ ...p, x: pad + colW / 2 + i * colW, lines: wrap(p.label, colW - 24, FS) }));
  const headH = Math.max(...heads.map((h) => h.lines.length)) * FS * LINE + 18;
  const W = pad * 2 + colW * heads.length;
  const at = Object.fromEntries(heads.map((h) => [h.id, h]));
  let y = 14 + headH + 18;
  let body = "";
  const msgs = [];
  for (const m of spec.steps) {
    if (m.note) {
      const h = at[m.note];
      const lines = wrap(m.text, colW + 30, FS_LABEL);
      const bh = lines.length * FS_LABEL * LINE + 12;
      const bw = Math.max(...lines.map((l) => textWidth(l, FS_LABEL))) + 20;
      msgs.push(`<rect class="dg-note" x="${r1(h.x - bw / 2)}" y="${r1(y)}" width="${r1(bw)}" height="${r1(bh)}" rx="4" fill="none" stroke="currentColor"/>` + textBlock(lines, h.x, y + bh / 2, FS_LABEL, "dg-text"));
      y += bh + 16;
      continue;
    }
    const a = at[m.from], b = at[m.to];
    if (a === b) {
      // A step a participant does on its own: a short loop to the right, text beside it.
      const lines = wrap(m.text, colW - 40, FS_LABEL);
      const th = lines.length * FS_LABEL * LINE;
      // The last column has no room on its right, so its loop and text go to the left.
      const left = a === heads.at(-1);
      const lx = a.x, loopW = 22, h = Math.max(22, th), s = left ? -1 : 1;
      msgs.push(`<path class="dg-edge" d="M${r1(lx)} ${r1(y)}h${s * loopW}v${r1(h)}h${-s * (loopW - 2)}" fill="none" stroke="currentColor" marker-end="url(#${name}-arrow)"/>` +
        textBlock(lines, lx + s * (loopW + 8), y + h / 2, FS_LABEL, "dg-text", left ? "end" : "start"));
      y += h + 22;
      continue;
    }
    const span = Math.abs(b.x - a.x);
    const lines = wrap(m.text, span - 20, FS_LABEL);
    const th = lines.length * FS_LABEL * LINE;
    const ty = y + th / 2;
    const ly = y + th + 6;
    const dir = b.x > a.x ? 1 : -1;
    // A message that spans more than one column crosses a lifeline: a background keeps it readable.
    const bw = Math.max(...lines.map((l) => textWidth(l, FS_LABEL))) + 8;
    const bg = span > colW ? `<rect class="dg-label-bg" x="${r1((a.x + b.x) / 2 - bw / 2)}" y="${r1(y - 2)}" width="${r1(bw)}" height="${r1(th + 2)}" rx="3" fill="none" stroke="none"/>` : "";
    msgs.push(bg + textBlock(lines, (a.x + b.x) / 2, ty, FS_LABEL, "dg-text") +
      `<line class="dg-edge${m.dashed ? " dg-dashed" : ""}" x1="${r1(a.x)}" y1="${r1(ly)}" x2="${r1(b.x - dir * 2)}" y2="${r1(ly)}" stroke="currentColor"${m.dashed ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#${name}-arrow)"/>`);
    y = ly + 22;
  }
  const H = y + 6;
  for (const h of heads) {
    const bw = colW - 16;
    body += `<rect class="dg-node" x="${r1(h.x - bw / 2)}" y="14" width="${r1(bw)}" height="${r1(headH)}" rx="6" fill="none" stroke="currentColor"/>` + textBlock(h.lines, h.x, 14 + headH / 2, FS);
    body += `<line class="dg-life" x1="${r1(h.x)}" y1="${r1(14 + headH)}" x2="${r1(h.x)}" y2="${r1(H - 4)}" stroke="currentColor" stroke-dasharray="3 4"/>`;
  }
  return svgDoc(name, W, H, spec.title, spec.desc, body + msgs.join(""));
}

// ---------------------------------------------------------------------------------------------
// Flowcharts: nodes at chosen centres, edges as polylines between node sides and waypoints.

// Optional extras, for the overview diagrams: `fs`/`fsLabel` on the spec (larger text for a
// diagram drawn narrow enough to fit a phone without scrolling); per node a fixed `h`, a `sub`
// line in the smaller muted font, `cls` ("accent", "muted" or "note", a .dg-* class), `align`
// ("start" for left-aligned text), `mono`, and `shape: "text"` for a label with no box; per edge
// `dashed`; and `groups`, labelled rectangles drawn behind the nodes.
const PAD = 12;

function flow(name, spec) {
  const fs = spec.fs || FS, fsl = spec.fsLabel || FS_LABEL;
  const nodes = {};
  for (const n of spec.nodes) {
    const pad = n.shape === "text" ? 0 : PAD;
    const maxw = n.w ? n.w - pad * 2 : 200;
    const lines = n.text ? wrap(n.text, maxw, fs) : [];
    const sub = n.sub ? wrap(n.sub, maxw, fsl) : [];
    const widest = Math.max(...lines.map((l) => textWidth(l, fs)), ...sub.map((l) => textWidth(l, fsl)));
    const w = n.w || Math.max(90, widest + 28);
    const textH = lines.length * fs * LINE + (sub.length ? (lines.length ? 4 : 0) + sub.length * fsl * LINE : 0);
    nodes[n.id] = { ...n, lines, sub, w, textH, h: n.h || textH + 20 };
  }
  const side = (id, s) => {
    const n = nodes[id];
    if (!n) throw new Error(`${name}: no node ${id}`);
    const [k, off = 0] = s.split(/(?=[+-])/);
    const o = Number(off);
    return { n: [n.x + o, n.y - n.h / 2], s: [n.x + o, n.y + n.h / 2], w: [n.x - n.w / 2, n.y + o], e: [n.x + n.w / 2, n.y + o] }[k];
  };
  const pt = (p) => (typeof p[0] === "string" ? side(p[0], p[1]) : p);
  let groups = "";
  for (const g of spec.groups || []) {
    const lines = wrap(g.label, g.w - PAD * 2, fsl);
    groups += `<rect class="dg-group" x="${r1(g.x)}" y="${r1(g.y)}" width="${r1(g.w)}" height="${r1(g.h)}" rx="10" fill="none" stroke="currentColor"/>` +
      textBlock(lines, g.x + PAD, g.y + 8 + (lines.length * fsl * LINE) / 2, fsl, "dg-text dg-group-label", "start");
  }
  let edges = "", labels = "";
  for (const e of spec.edges) {
    const pts = e.path.map(pt);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${r1(p[0])} ${r1(p[1])}`).join("");
    edges += `<path class="dg-edge${e.dashed ? " dg-dashed" : ""}" d="${d}" fill="none" stroke="currentColor"${e.dashed ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#${name}-arrow)"/>`;
    if (e.label) {
      const seg = e.seg ?? 0;
      const [a, b] = [pts[seg], pts[seg + 1]];
      const t = e.t ?? 0.5;
      const cx = a[0] + (b[0] - a[0]) * t + (e.dx || 0), cy = a[1] + (b[1] - a[1]) * t + (e.dy || 0);
      const lines = wrap(e.label, e.lw || 150, fsl);
      const lw = Math.max(...lines.map((l) => textWidth(l, fsl))) + 10;
      const lh = lines.length * fsl * LINE + 4;
      const anchor = e.anchor || "middle";
      const rx = anchor === "start" ? cx - 4 : anchor === "end" ? cx - lw + 4 : cx - lw / 2;
      const tx = anchor === "start" ? cx + 1 : anchor === "end" ? cx - 1 : cx;
      labels += `<rect class="dg-label-bg" x="${r1(rx)}" y="${r1(cy - lh / 2)}" width="${r1(lw)}" height="${r1(lh)}" rx="3" fill="none" stroke="none"/>` + textBlock(lines, tx, cy, fsl, "dg-text dg-label", anchor);
    }
  }
  let shapes = "";
  for (const n of Object.values(nodes)) {
    const x = n.x - n.w / 2, y = n.y - n.h / 2;
    const cls = n.cls ? ` dg-${n.cls}` : "";
    if (n.shape === "decision") {
      const k = 12;
      shapes += `<path class="dg-node dg-decision${cls}" d="M${r1(x)} ${r1(n.y)}L${r1(x + k)} ${r1(y)}H${r1(x + n.w - k)}L${r1(x + n.w)} ${r1(n.y)}L${r1(x + n.w - k)} ${r1(y + n.h)}H${r1(x + k)}Z" fill="none" stroke="currentColor"/>`;
    } else if (n.shape !== "text") {
      shapes += `<rect class="dg-node${n.shape === "end" ? " dg-end" : ""}${cls}" x="${r1(x)}" y="${r1(y)}" width="${r1(n.w)}" height="${r1(n.h)}" rx="${n.shape === "end" ? 14 : 6}" fill="none" stroke="currentColor"${n.cls === "muted" ? ' stroke-dasharray="5 4"' : ""}/>`;
    }
    const anchor = n.align || "middle";
    const pad = n.shape === "text" ? 0 : PAD;
    const tx = anchor === "start" ? x + pad : anchor === "end" ? x + n.w - pad : n.x;
    const top = n.y - n.textH / 2;
    const mainH = n.lines.length * fs * LINE;
    shapes += textBlock(n.lines, tx, top + mainH / 2, fs, `dg-text${n.mono ? " dg-mono" : ""}`, anchor);
    shapes += textBlock(n.sub, tx, n.y + n.textH / 2 - (n.sub.length * fsl * LINE) / 2, fsl, "dg-text dg-label", anchor);
  }
  return svgDoc(name, spec.width, spec.height, spec.title, spec.desc, groups + edges + shapes + labels);
}

// ---------------------------------------------------------------------------------------------
// The diagrams. `mmd` is the Mermaid source the primer used to carry; keep it in step.

export const DIAGRAMS = {
  // The visual tour (course/site/src/pages/how-it-works.md, the landing page and the README).
  // Drawn 336 units wide with 14px as the smallest text, so each fits a phone without scrolling.
  overview: {
    kind: "flow",
    title: "The whole picture",
    desc: "Four layers, top to bottom. 1. The guest: Linux, U-Boot then FreeBSD, or a test guest. It believes it runs on a QEMU virt board. 2. The macvmm process, one macOS process that sandboxes itself. It holds the command line (crates/macvmm), the VMM library (crates/vmm: vCPU threads, devices, virtio, loaders and the device tree) and the FFI bindings (crates/hvf). Beside it, on the host, are the input files (kernel, initramfs, disk image), which macvmm reads, and the terminal, which carries the serial console both ways. 3. Hypervisor.framework and the macOS kernel, called through the FFI bindings: the stage-2 memory map, vCPUs, the in-kernel GIC interrupt controller and the virtual timer. 4. The Apple Silicon CPU, which runs the guest's instructions directly, at full speed.",
    width: 336, height: 812, fs: 15, fsLabel: 14,
    groups: [
      { x: 8, y: 122, w: 320, h: 292, label: "macvmm: one macOS process, sandboxed" },
      { x: 8, y: 562, w: 320, h: 144, label: "Hypervisor.framework + macOS kernel" },
    ],
    nodes: [
      { id: "G", x: 168, y: 57, w: 320, text: "The guest", sub: "Linux, U-Boot then FreeBSD, or a test guest. It believes it runs on a QEMU virt board.", cls: "accent" },
      { id: "C", x: 168, y: 189, w: 296, text: "Command line", sub: "crates/macvmm" },
      { id: "V", x: 168, y: 279, w: 296, text: "VMM library", sub: "crates/vmm\nvCPU threads, devices, virtio,\nloaders and the device tree" },
      { id: "F", x: 168, y: 369, w: 200, text: "FFI bindings", sub: "crates/hvf" },
      { id: "HF", x: 72, y: 489, w: 128, h: 98, text: "Host files", sub: "kernel, initramfs, disk image", cls: "muted" },
      { id: "T", x: 264, y: 489, w: 128, h: 98, text: "Terminal", sub: "the serial console", cls: "muted" },
      { id: "S2", x: 91, y: 616, w: 142, h: 44, text: "Stage-2 memory" },
      { id: "VC", x: 245, y: 616, w: 142, h: 44, text: "vCPUs" },
      { id: "GIC", x: 91, y: 670, w: 142, h: 44, text: "In-kernel GIC" },
      { id: "TM", x: 245, y: 670, w: 142, h: 44, text: "Virtual timer" },
      { id: "CPU", x: 168, y: 762, w: 320, text: "Apple Silicon CPU", sub: "runs the guest's instructions directly, at full speed", cls: "accent" },
    ],
    edges: [
      { path: [["HF", "n"], [72, 414]] },
      { path: [["T", "n-16"], [248, 414]] },
      { path: [[280, 414], ["T", "n+16"]] },
      { path: [["F", "s"], [168, 562]] },
    ],
    mmd: `flowchart TB
  G["The guest<br/>Linux, U-Boot then FreeBSD, or a test guest.<br/>It believes it runs on a QEMU virt board."]
  subgraph P["macvmm: one macOS process, sandboxed"]
    C["Command line<br/>crates/macvmm"]
    V["VMM library<br/>crates/vmm<br/>vCPU threads, devices, virtio,<br/>loaders and the device tree"]
    F["FFI bindings<br/>crates/hvf"]
  end
  HF["Host files<br/>kernel, initramfs, disk image"] --> P
  T["Terminal<br/>the serial console"] <--> P
  subgraph H["Hypervisor.framework + macOS kernel"]
    S2["Stage-2 memory"]
    VC["vCPUs"]
    GIC["In-kernel GIC"]
    TM["Virtual timer"]
  end
  CPU["Apple Silicon CPU<br/>runs the guest's instructions directly, at full speed"]
  G ~~~ P
  F --> H
  H ~~~ CPU`,
  },
  "exit-loop": {
    kind: "flow",
    title: "The heart of a VMM: run, exit, emulate, resume",
    desc: "A loop of five steps. 1. macvmm calls hv_vcpu_run and the guest runs at full speed. 2. Exit: the guest touched a device address or made a hypercall, so the CPU stops it and hv_vcpu_run returns. 3. macvmm decodes the syndrome register, ESR_EL2, which says why the guest stopped. 4. A device model, or the PSCI code for a hypercall, emulates the access. 5. macvmm advances the program counter to the next instruction (after a hypercall the CPU has already done this), then calls hv_vcpu_run again. Measured on 2026-11-22 on an Apple M5 Pro with scripts/run-linux.sh --cpus 4 --stats, booting Linux to a shell and powering it off: 35,271 exits in total, the same in each of 4 runs. 35,235 were device accesses (MMIO data aborts), 25 were hypercalls and 11 were other kinds. There were no timer or WFI exits, because the in-kernel GIC handles those inside Hypervisor.framework.",
    width: 336, height: 506, fs: 15, fsLabel: 14,
    nodes: [
      { id: "R", x: 168, y: 48, w: 160, h: 80, text: "hv_vcpu_run", sub: "the guest runs at full speed", cls: "accent", mono: true },
      { id: "E", x: 254, y: 160, w: 148, h: 80, text: "Exit", sub: "device access or hypercall" },
      { id: "D", x: 254, y: 284, w: 148, h: 80, text: "Decode the ESR", sub: "why it stopped" },
      { id: "M", x: 82, y: 284, w: 148, h: 80, text: "Emulate", sub: "a device model or PSCI answers" },
      { id: "A", x: 82, y: 160, w: 148, h: 80, text: "Advance the PC", sub: "to the next instruction" },
      { id: "N", x: 168, y: 424, w: 320, shape: "end", align: "start", text: "Measured: one Linux run, 4 vCPUs", sub: "35,271 exits in total.\n35,235 were device accesses (MMIO),\n25 were hypercalls, 11 other kinds.\nNo timer or WFI exits at all:\nthe in-kernel GIC handles those." },
    ],
    edges: [
      { path: [["R", "e"], [290, 48], ["E", "n+36"]] },
      { path: [["E", "s"], ["D", "n"]] },
      { path: [["D", "w"], ["M", "e"]] },
      { path: [["M", "n"], ["A", "s"]] },
      { path: [["A", "n-36"], [46, 48], ["R", "w"]] },
    ],
    mmd: `flowchart TB
  R["hv_vcpu_run<br/>the guest runs at full speed"] --> E["Exit<br/>device access or hypercall"]
  E --> D["Decode the ESR<br/>why it stopped"]
  D --> M["Emulate<br/>a device model or PSCI answers"]
  M --> A["Advance the PC<br/>to the next instruction"]
  A --> R
  N["Measured: one Linux run, 4 vCPUs<br/>35,271 exits in total.<br/>35,235 were device accesses (MMIO),<br/>25 were hypercalls, 11 other kinds.<br/>No timer or WFI exits at all:<br/>the in-kernel GIC handles those."]`,
  },
  "memory-map": {
    kind: "flow",
    title: "The board the guest sees",
    desc: "The guest-physical address map of macvmm's virt board, lowest address at the top, not to scale. 0x0000_0000: flash, for firmware, mapped only with --bios. 0x0800_0000: the GIC interrupt controller's distributor, then its redistributors from 0x080A_0000; Hypervisor.framework answers these accesses itself, with no exit. Then the trapped devices, which are deliberately left unmapped so that every access exits to macvmm: 0x0900_0000 the PL011 UART, the serial console; 0x0901_0000 the PL031 RTC, the clock; 0x0a00_0000 the virtio-mmio slots, 32 of them 0x200 bytes apart. Unused holes follow, also unmapped. 0x4000_0000: RAM, 512 MiB by default, mapped, so the guest reads and writes it with no exit.",
    width: 336, height: 640, fs: 15, fsLabel: 14,
    groups: [
      { x: 110, y: 206, w: 224, h: 270, label: "Trapped: every access exits to macvmm" },
    ],
    nodes: [
      { id: "a0", x: 53, y: 20, w: 100, shape: "text", align: "end", mono: true, text: "0x0000_0000" },
      { id: "FL", x: 222, y: 48, w: 208, h: 80, text: "Flash", sub: "firmware code,\nmapped only with --bios" },
      { id: "a1", x: 53, y: 110, w: 100, shape: "text", align: "end", mono: true, text: "0x0800_0000" },
      { id: "GIC", x: 222, y: 147, w: 208, h: 98, text: "GIC", sub: "interrupt controller.\nHandled in HVF: no exit" },
      { id: "a2", x: 53, y: 270, w: 100, shape: "text", align: "end", mono: true, text: "0x0900_0000" },
      { id: "U", x: 222, y: 289, w: 208, h: 62, text: "PL011 UART", sub: "the serial console" },
      { id: "a3", x: 53, y: 342, w: 100, shape: "text", align: "end", mono: true, text: "0x0901_0000" },
      { id: "RTC", x: 222, y: 361, w: 208, h: 62, text: "PL031 RTC", sub: "the clock" },
      { id: "a4", x: 53, y: 414, w: 100, shape: "text", align: "end", mono: true, text: "0x0a00_0000" },
      { id: "VIO", x: 222, y: 433, w: 208, h: 62, text: "virtio-mmio", sub: "32 slots, 0x200 apart" },
      { id: "gap", x: 222, y: 502, w: 208, shape: "text", text: "", sub: "unused holes, also unmapped" },
      { id: "a5", x: 53, y: 542, w: 100, shape: "text", align: "end", mono: true, text: "0x4000_0000" },
      { id: "RAM", x: 222, y: 579, w: 208, h: 98, text: "RAM", sub: "512 MiB by default.\nMapped, so accesses\nnever exit.", cls: "accent" },
    ],
    edges: [],
    mmd: `flowchart TB
  FL["0x0000_0000 Flash<br/>firmware code,<br/>mapped only with --bios"]
  GIC["0x0800_0000 GIC<br/>interrupt controller.<br/>Handled in HVF: no exit"]
  subgraph T["Trapped: every access exits to macvmm"]
    U["0x0900_0000 PL011 UART<br/>the serial console"]
    RTC["0x0901_0000 PL031 RTC<br/>the clock"]
    VIO["0x0a00_0000 virtio-mmio<br/>32 slots, 0x200 apart"]
  end
  RAM["0x4000_0000 RAM<br/>512 MiB by default.<br/>Mapped, so accesses never exit."]
  FL ~~~ GIC ~~~ T ~~~ RAM`,
  },
  "boot-flow": {
    kind: "flow",
    title: "From macvmm run to a shell prompt",
    desc: "Eight steps, top to bottom. 1. macvmm opens the input files, reading each one once. 2. It enters its sandbox: no new files or network after this. 3. It builds the machine: the VM, the GIC, RAM, the devices and the device tree. 4. It loads the guest: the device tree, kernel and initramfs go into guest RAM. 5. vCPU 0 starts at the kernel's entry point with register x0 holding the device tree's address. 6. Linux boots, and PSCI CPU_ON wakes the other vCPUs. 7. A shell prompt, / #, appears on the serial console. 8. poweroff -f makes Linux call PSCI SYSTEM_OFF, and macvmm exits with code 0. A reboot instead calls PSCI SYSTEM_RESET, and macvmm goes back to step 3 and builds a fresh machine from the files it already read.",
    width: 336, height: 812, fs: 15, fsLabel: 14,
    nodes: [
      { id: "O", x: 118, y: 39, w: 216, text: "Open the input files", sub: "read each one once" },
      { id: "S", x: 118, y: 136, w: 216, text: "Enter the sandbox", sub: "no new files or network after this" },
      { id: "B", x: 118, y: 240, w: 216, text: "Build the machine", sub: "VM, GIC, RAM, devices, device tree", cls: "accent" },
      { id: "L", x: 118, y: 344, w: 216, text: "Load the guest", sub: "device tree, kernel, initramfs into RAM" },
      { id: "V", x: 118, y: 448, w: 216, text: "Start vCPU 0", sub: "kernel entry point,\nx0 = device tree address" },
      { id: "K", x: 118, y: 552, w: 216, text: "Linux boots", sub: "PSCI CPU_ON wakes the other vCPUs" },
      { id: "SH", x: 118, y: 647, w: 216, shape: "end", text: "/ #", mono: true, sub: "a shell prompt" },
      { id: "X", x: 118, y: 771, w: 216, shape: "end", text: "macvmm exits", sub: "exit code 0" },
    ],
    edges: [
      { path: [["O", "s"], ["S", "n"]] },
      { path: [["S", "s"], ["B", "n"]] },
      { path: [["B", "s"], ["L", "n"]] },
      { path: [["L", "s"], ["V", "n"]] },
      { path: [["V", "s"], ["K", "n"]] },
      { path: [["K", "s"], ["SH", "n"]] },
      { path: [["SH", "s"], ["X", "n"]], label: "poweroff -f: PSCI SYSTEM_OFF", anchor: "start", dx: 10, lw: 140 },
      { path: [["SH", "e"], [283, 647], [283, 240], ["B", "e"]], seg: 1, t: 0.5, label: "reboot:\nPSCI\nSYSTEM_RESET", lw: 100 },
    ],
    mmd: `flowchart TB
  O["Open the input files<br/>read each one once"] --> S["Enter the sandbox<br/>no new files or network after this"]
  S --> B["Build the machine<br/>VM, GIC, RAM, devices, device tree"]
  B --> L["Load the guest<br/>device tree, kernel, initramfs into RAM"]
  L --> V["Start vCPU 0<br/>kernel entry point,<br/>x0 = device tree address"]
  V --> K["Linux boots<br/>PSCI CPU_ON wakes the other vCPUs"]
  K --> SH(["/ #<br/>a shell prompt"])
  SH -->|"poweroff -f: PSCI SYSTEM_OFF"| X(["macvmm exits<br/>exit code 0"])
  SH -->|"reboot: PSCI SYSTEM_RESET"| B`,
  },
  "virtio-request": {
    kind: "sequence",
    title: "How a disk write travels",
    desc: "Sequence between the Linux virtio-blk driver in the guest, a vCPU thread in macvmm, the virtio-blk worker thread in macvmm, and the disk image, a file on the host. 1. The driver puts the request's descriptors in guest RAM and adds them to the available ring. 2. The driver writes the QueueNotify register, which is an MMIO exit to the vCPU thread. 3. The vCPU thread wakes the worker. 4. The vCPU thread returns to the guest at once. 5. The worker walks the descriptor chain, checking every address against RAM and stopping a chain that loops. 6. The worker calls pwrite on the disk image. 7. The worker writes the used ring in guest RAM. 8. The worker raises the device's interrupt through the in-kernel GIC. 9. The driver sees the used ring and completes the request.",
    colW: 160,
    participants: [{ id: "D", label: "Linux driver\n(in the guest)" }, { id: "V", label: "vCPU thread\n(macvmm)" }, { id: "W", label: "virtio-blk worker\n(macvmm)" }, { id: "F", label: "Disk image\n(host file)" }],
    steps: [
      { from: "D", to: "D", text: "puts descriptors in guest RAM" },
      { from: "D", to: "V", text: "writes QueueNotify: an MMIO exit" },
      { from: "V", to: "W", text: "wakes the worker" },
      { from: "V", to: "D", text: "returns to the guest at once", dashed: true },
      { from: "W", to: "W", text: "walks the chain: bounds-checked, loop-proof" },
      { from: "W", to: "F", text: "pwrite" },
      { from: "W", to: "W", text: "writes the used ring" },
      { from: "W", to: "D", text: "raises the interrupt through the in-kernel GIC" },
      { from: "D", to: "D", text: "completes the request" },
    ],
    mmd: `sequenceDiagram
    participant D as Linux driver (in the guest)
    participant V as vCPU thread (macvmm)
    participant W as virtio-blk worker (macvmm)
    participant F as Disk image (host file)
    D->>D: puts descriptors in guest RAM
    D->>V: writes QueueNotify: an MMIO exit
    V->>W: wakes the worker
    V-->>D: returns to the guest at once
    W->>W: walks the chain: bounds-checked, loop-proof
    W->>F: pwrite
    W->>W: writes the used ring
    W->>D: raises the interrupt through the in-kernel GIC
    D->>D: completes the request`,
  },
  "boot-handoff": {
    kind: "sequence",
    title: "The arm64 boot hand-off",
    desc: "Sequence between the VMM acting as boot loader on the host, guest RAM, and vCPU 0. 1. The VMM writes the DTB, the kernel Image and the initramfs into guest RAM. 2. The VMM sets registers x0 to x3, CPSR and the PC of vCPU 0. Note on vCPU 0: the MMU is off and interrupts (DAIF) are masked. 3. The VMM runs the vCPU. 4. The vCPU fetches the kernel's first instruction from guest RAM.",
    colW: 180,
    participants: [{ id: "V", label: "VMM (boot loader, host)" }, { id: "M", label: "Guest RAM" }, { id: "C", label: "vCPU 0" }],
    steps: [
      { from: "V", to: "M", text: "writes DTB, Image, initramfs" },
      { from: "V", to: "C", text: "sets x0..x3, CPSR, PC" },
      { note: "C", text: "MMU off, DAIF masked" },
      { from: "V", to: "C", text: "runs" },
      { from: "C", to: "M", text: "kernel fetches its first instruction" },
    ],
    mmd: `sequenceDiagram
    participant V as VMM (boot loader, host)
    participant M as Guest RAM
    participant C as vCPU 0
    V->>M: writes DTB, Image, initramfs
    V->>C: sets x0..x3, CPSR, PC
    Note over C: MMU off, DAIF masked
    V->>C: runs
    C->>M: kernel fetches its first instruction`,
  },
  "smccc-call": {
    kind: "sequence",
    title: "One SMCCC call through HVF",
    desc: "Sequence between the guest kernel (EL1, untrusted), HVF (EL2) and macvmm (a host process). 1. The guest puts the function ID in w0 and arguments in x1 onwards. 2. The guest executes hvc #0, an exception to EL2. 3. HVF makes hv_vcpu_run return to macvmm, with ESR_EL2 exception class 0x16 (HVC). 4. macvmm reads x0 to x3, decodes the ID and acts. 5. macvmm writes the result into x0 and calls hv_vcpu_run again. 6. The guest resumes after the hvc and reads x0.",
    colW: 190,
    participants: [{ id: "G", label: "Guest kernel (EL1, untrusted)" }, { id: "H", label: "HVF (EL2)" }, { id: "V", label: "macvmm (host process)" }],
    steps: [
      { from: "G", to: "G", text: "put function ID in w0, arguments in x1.." },
      { from: "G", to: "H", text: "executes hvc #0 (exception to EL2)" },
      { from: "H", to: "V", text: "hv_vcpu_run returns, ESR_EL2 class 0x16 (HVC)" },
      { from: "V", to: "V", text: "reads x0..x3, decodes the ID, acts" },
      { from: "V", to: "H", text: "writes the result into x0, calls hv_vcpu_run" },
      { from: "H", to: "G", text: "guest resumes after the hvc, reads x0" },
    ],
    mmd: `sequenceDiagram
    participant G as Guest kernel (EL1, untrusted)
    participant H as HVF (EL2)
    participant V as macvmm (host process)
    G->>G: put function ID in w0, arguments in x1..
    G->>H: executes hvc #0 (exception to EL2)
    H->>V: hv_vcpu_run returns, ESR_EL2 class 0x16 (HVC)
    V->>V: reads x0..x3, decodes the ID, acts
    V->>H: writes the result into x0, calls hv_vcpu_run
    H->>G: guest resumes after the hvc, reads x0`,
  },
  "uefi-handoff": {
    kind: "sequence",
    title: "UEFI firmware, an EFI application and the OS",
    desc: "Sequence between UEFI firmware, an EFI application (the Linux stub or loader.efi) and the OS kernel. 1. Firmware calls StartImage: x0 is the image handle, x1 the System Table. 2. The application uses boot services: allocate memory, read files, print, GetMemoryMap. 3. The application calls ExitBootServices with its handle and the MapKey. 4. The application jumps to the kernel entry. 5. From then on the OS uses only runtime services: GetTime, SetVariable, ResetSystem.",
    colW: 190,
    participants: [{ id: "FW", label: "UEFI firmware" }, { id: "L", label: "EFI application (Linux stub, loader.efi)" }, { id: "OS", label: "OS kernel" }],
    steps: [
      { from: "FW", to: "L", text: "StartImage: x0 = image handle, x1 = System Table" },
      { from: "L", to: "FW", text: "boot services: allocate, read files, print, GetMemoryMap" },
      { from: "L", to: "FW", text: "ExitBootServices(handle, MapKey)" },
      { from: "L", to: "OS", text: "jump to kernel entry" },
      { from: "OS", to: "FW", text: "runtime services only: GetTime, SetVariable, ResetSystem" },
    ],
    mmd: `sequenceDiagram
    participant FW as UEFI firmware
    participant L as EFI application (Linux stub, loader.efi)
    participant OS as OS kernel
    FW->>L: StartImage: x0 = image handle, x1 = System Table
    L->>FW: boot services: allocate, read files, print, GetMemoryMap
    L->>FW: ExitBootServices(handle, MapKey)
    L->>OS: jump to kernel entry
    OS->>FW: runtime services only: GetTime, SetVariable, ResetSystem`,
  },
  "self-pipe": {
    kind: "sequence",
    title: "The self-pipe pattern",
    desc: "Sequence between the kernel, a signal handler running on any thread, a pipe, and a dedicated signal thread. 1. The kernel interrupts a thread and runs the handler. 2. The handler writes one byte, the signal number, to the pipe. 3. The handler returns to the kernel and the interrupted code resumes. 4. On the signal thread, read() returns the byte. 5. The signal thread does the real work: locks, I/O, exit.",
    colW: 150,
    participants: [{ id: "K", label: "Kernel" }, { id: "H", label: "Handler (any thread)" }, { id: "P", label: "Pipe" }, { id: "S", label: "Signal thread" }],
    steps: [
      { from: "K", to: "H", text: "interrupts a thread, runs handler" },
      { from: "H", to: "P", text: "write(1 byte = signal number)" },
      { from: "H", to: "K", text: "returns; interrupted code resumes", dashed: true },
      { from: "P", to: "S", text: "read() returns the byte" },
      { from: "S", to: "S", text: "does the real work (locks, I/O, exit)" },
    ],
    mmd: `sequenceDiagram
    participant K as Kernel
    participant H as Handler (any thread)
    participant P as Pipe
    participant S as Signal thread
    K->>H: interrupts a thread, runs handler
    H->>P: write(1 byte = signal number)
    H-->>K: returns; interrupted code resumes
    P->>S: read() returns the byte
    S->>S: does the real work (locks, I/O, exit)`,
  },
  "codesign-checks": {
    kind: "flow",
    title: "Where each signature check happens",
    desc: "A chain of five stages, top to bottom. 1. clang or cargo build writes a linker signature. 2. codesign -s - adds entitlements. 3. At launch, exec checks the signature and any restricted entitlements: copy A dies here. 4. At page-in, the kernel hashes each page as it loads: a tampered copy dies here. 5. The program calls hv_vm_create: copy B is refused here.",
    width: 470, height: 520,
    nodes: [
      { id: "B", x: 150, y: 40, text: "clang / cargo build", w: 220 },
      { id: "S", x: 150, y: 145, text: "codesign -s -\nadds entitlements", w: 220 },
      { id: "L", x: 150, y: 260, text: "launch\n(copy A dies here)", w: 220 },
      { id: "P", x: 150, y: 375, text: "page-in\n(tampered copy dies here)", w: 220 },
      { id: "H", x: 150, y: 480, text: "hv_vm_create\n(copy B refused here)", w: 220 },
    ],
    edges: [
      { path: [["B", "s"], ["S", "n"]], label: "writes linker signature", anchor: "start", dx: 12, lw: 180 },
      { path: [["S", "s"], ["L", "n"]], label: "exec checks signature, restricted entitlements", anchor: "start", dx: 12, lw: 180 },
      { path: [["L", "s"], ["P", "n"]], label: "kernel hashes each page as it loads", anchor: "start", dx: 12, lw: 180 },
      { path: [["P", "s"], ["H", "n"]], label: "program calls", anchor: "start", dx: 12, lw: 180 },
    ],
    mmd: `graph LR
  B["clang / cargo build"] -- "writes linker signature" --> S["codesign -s -<br/>adds entitlements"]
  S -- "exec checks signature,<br/>restricted entitlements" --> L["launch<br/>(copy A dies here)"]
  L -- "kernel hashes each page<br/>as it loads" --> P["page-in<br/>(tampered copy dies here)"]
  P -- "program calls" --> H["hv_vm_create<br/>(copy B refused here)"]`,
  },
  "initramfs-unpack": {
    kind: "flow",
    title: "How the kernel walks an initramfs buffer",
    desc: "A loop over the next byte in the buffer, with three branches. If it is the character 0 at a multiple of 4, it is a raw newc member: parse newc entries, and when TRAILER!!! is seen go back to the next byte. If it is a zero byte, skip it and go back to the next byte. Anything else: pick a decompressor by its magic (for example 1f 8b is gzip); the decompressed stream is parsed as newc, then go back to the next byte.",
    width: 640, height: 400,
    nodes: [
      { id: "A", x: 340, y: 40, text: "next byte in the buffer", w: 240 },
      { id: "B", x: 130, y: 230, text: "parse newc entries", w: 170 },
      { id: "C", x: 340, y: 230, text: "skip it", w: 120 },
      { id: "D", x: 530, y: 230, text: "pick a decompressor by magic,\ne.g. 1f 8b = gzip", w: 210 },
    ],
    edges: [
      { path: [["A", "s-60"], [280, 120], [130, 120], ["B", "n"]], seg: 2, t: 0.45, label: "the character 0, at a multiple of 4: a raw newc member", lw: 150 },
      { path: [["A", "s"], ["C", "n"]], label: "a zero byte", t: 0.55, lw: 100 },
      { path: [["A", "s+60"], [400, 120], [530, 120], ["D", "n"]], seg: 2, t: 0.45, label: "anything else", lw: 120 },
      { path: [["B", "s"], [130, 340], [24, 340], [24, 40], ["A", "w"]], seg: 0, t: 0.5, label: "TRAILER!!! seen", anchor: "start", dx: 8, lw: 120 },
      { path: [["C", "s"], [340, 360], [16, 360], [16, 48], ["A", "w+8"]] },
      { path: [["D", "s"], [530, 380], [8, 380], [8, 32], ["A", "w-8"]], seg: 0, t: 0.45, label: "decompressed stream is parsed as newc", anchor: "end", dx: -8, lw: 130 },
    ],
    mmd: `flowchart TD
    A[next byte in the buffer] -->|"the character 0, at a multiple of 4: a raw newc member"| B[parse newc entries]
    A -->|a zero byte| C[skip it]
    A -->|anything else| D[pick a decompressor by magic, e.g. 1f 8b = gzip]
    B -->|TRAILER!!! seen| A
    C --> A
    D -->|decompressed stream is parsed as newc| A`,
  },
  "linux-boot-stages": {
    kind: "flow",
    title: "The eight stages of a Linux boot",
    desc: "Eight stages in order, top to bottom. 1. head.S: MMU on, jump to C. 2. start_kernel: banner, first device-tree read, command line. Then init_IRQ leads to 3. the interrupt controller (GIC). Then time_init leads to 4. timer, clocksource, delay loop. It creates PID 1: 5. kernel_init: other CPUs, initcalls. 6. Drivers bind to device-tree nodes. 7. The initramfs is unpacked. Then exec of 8. /init in user space.",
    width: 470, height: 760,
    nodes: [
      { id: "S1", x: 170, y: 40, w: 300, text: "1. head.S: MMU on, jump to C" },
      { id: "S2", x: 170, y: 135, w: 300, text: "2. start_kernel: banner, first DT read, command line" },
      { id: "S3", x: 170, y: 235, w: 300, text: "3. interrupt controller (GIC)" },
      { id: "S4", x: 170, y: 330, w: 300, text: "4. timer, clocksource, delay loop" },
      { id: "S5", x: 170, y: 430, w: 300, text: "5. kernel_init: other CPUs, initcalls" },
      { id: "S6", x: 170, y: 525, w: 300, text: "6. drivers bind to DT nodes" },
      { id: "S7", x: 170, y: 615, w: 300, text: "7. initramfs unpacked" },
      { id: "S8", x: 170, y: 715, w: 300, text: "8. /init in user space" },
    ],
    edges: [
      { path: [["S1", "s"], ["S2", "n"]] },
      { path: [["S2", "s"], ["S3", "n"]], label: "init_IRQ", anchor: "start", dx: 10 },
      { path: [["S3", "s"], ["S4", "n"]], label: "time_init", anchor: "start", dx: 10 },
      { path: [["S4", "s"], ["S5", "n"]], label: "creates PID 1", anchor: "start", dx: 10 },
      { path: [["S5", "s"], ["S6", "n"]] },
      { path: [["S6", "s"], ["S7", "n"]] },
      { path: [["S7", "s"], ["S8", "n"]], label: "exec", anchor: "start", dx: 10 },
    ],
    mmd: `flowchart TD
    S1["1. head.S: MMU on, jump to C"] --> S2["2. start_kernel: banner, first DT read, command line"]
    S2 -->|init_IRQ| S3["3. interrupt controller (GIC)"]
    S3 -->|time_init| S4["4. timer, clocksource, delay loop"]
    S4 -->|creates PID 1| S5["5. kernel_init: other CPUs, initcalls"]
    S5 --> S6["6. drivers bind to DT nodes"]
    S6 --> S7["7. initramfs unpacked"]
    S7 -->|exec| S8["8. /init in user space"]`,
  },
  "sandbox-check": {
    kind: "flow",
    title: "How a sandbox check happens",
    desc: "A process opens /etc/hosts. The system call reaches XNU, which looks up the path. A MAC hook asks Sandbox.kext, which evaluates the profile. If it allows, the file descriptor is returned. If it denies, the process gets EPERM and the kernel logs a line from Sandbox.",
    width: 470, height: 430,
    nodes: [
      { id: "P", x: 235, y: 40, w: 220, text: "process\nopen /etc/hosts" },
      { id: "K", x: 235, y: 150, w: 220, text: "XNU: path lookup" },
      { id: "S", x: 235, y: 255, w: 220, text: "Sandbox.kext\nevaluates profile" },
      { id: "R", x: 110, y: 385, w: 170, text: "fd returned", shape: "end" },
      { id: "E", x: 360, y: 385, w: 190, text: "EPERM + log line\n(kernel, Sandbox)", shape: "end" },
    ],
    edges: [
      { path: [["P", "s"], ["K", "n"]], label: "system call", anchor: "start", dx: 10 },
      { path: [["K", "s"], ["S", "n"]], label: "MAC hook asks", anchor: "start", dx: 10 },
      { path: [["S", "s-60"], [175, 320], [110, 320], ["R", "n"]], seg: 1, label: "allow", dy: -12 },
      { path: [["S", "s+60"], [295, 320], [360, 320], ["E", "n"]], seg: 1, label: "deny", dy: -12 },
    ],
    mmd: `graph LR
  P["process<br/>open /etc/hosts"] -- "system call" --> K["XNU: path lookup"]
  K -- "MAC hook asks" --> S["Sandbox.kext<br/>evaluates profile"]
  S -- "allow" --> R["fd returned"]
  S -- "deny" --> E["EPERM + log line<br/>(kernel, Sandbox)"]`,
  },
  "primecell-binding": {
    kind: "flow",
    title: "How Linux binds a PrimeCell device",
    desc: "A device-tree node lists 'arm,primecell', which creates an AMBA device, not a platform device. Linux checks whether the node has an 'arm,primecell-periphid' property. If yes, it uses that as the ID and goes to matching. If no, it enables the apb_pclk clock: if there is no such clock it defers and tries again later, forever; if that works it reads the last 0x20 bytes of the register window. If the cell ID is not 0xB105F00D it defers, forever. If it is, it stores the peripheral ID and goes to matching. Matching asks whether (ID AND mask) equals id for a driver's table entry. If yes, probe enables apb_pclk again: with no such clock the probe fails and the device is not bound; if that works the driver binds.",
    width: 640, height: 1010,
    nodes: [
      { id: "A", x: 290, y: 36, w: 300, text: "DT node lists 'arm,primecell'" },
      { id: "B", x: 290, y: 126, w: 300, text: "an AMBA device, not a platform device" },
      { id: "C", x: 290, y: 226, w: 300, text: "'arm,primecell-periphid' property in the node?", shape: "decision" },
      { id: "D", x: 290, y: 336, w: 220, text: "enable apb_pclk", shape: "decision" },
      { id: "G", x: 540, y: 400, w: 170, text: "defer: try again later, forever", shape: "end" },
      { id: "R", x: 290, y: 446, w: 280, text: "read last 0x20 bytes of the window" },
      { id: "E", x: 290, y: 546, w: 260, text: "cell ID is 0xB105F00D?", shape: "decision" },
      { id: "M", x: 290, y: 676, w: 300, text: "(ID & mask) == id for a driver's table entry?", shape: "decision" },
      { id: "P", x: 290, y: 806, w: 260, text: "probe: enable apb_pclk again", shape: "decision" },
      { id: "X", x: 540, y: 880, w: 170, text: "probe fails, not bound", shape: "end" },
      { id: "H", x: 290, y: 960, w: 220, text: "the driver binds", shape: "end" },
    ],
    edges: [
      { path: [["A", "s"], ["B", "n"]], label: "creates", anchor: "start", dx: 10 },
      { path: [["B", "s"], ["C", "n"]], label: "checks", anchor: "start", dx: 10 },
      { path: [["C", "w"], [40, 226], [40, 676], ["M", "w"]], seg: 1, t: 0.3, label: "yes: use it as the ID", anchor: "start", dx: 6, lw: 90 },
      { path: [["C", "s"], ["D", "n"]], label: "no", anchor: "start", dx: 10 },
      { path: [["D", "e"], [540, 336], ["G", "n"]], seg: 0, label: "no such clock", lw: 110, dy: -13 },
      { path: [["D", "s"], ["R", "n"]], label: "ok", anchor: "start", dx: 10 },
      { path: [["R", "s"], ["E", "n"]] },
      { path: [["E", "e"], [540, 546], ["G", "s"]], seg: 0, label: "no", dy: -12 },
      { path: [["E", "s"], ["M", "n"]], label: "yes: store peripheral ID", anchor: "start", dx: 10, lw: 170 },
      { path: [["M", "s"], ["P", "n"]], label: "yes", anchor: "start", dx: 10 },
      { path: [["P", "e"], [540, 806], ["X", "n"]], seg: 0, label: "no such clock", lw: 110, dy: -13 },
      { path: [["P", "s"], ["H", "n"]], label: "ok", anchor: "start", dx: 10 },
    ],
    mmd: `flowchart TD
  A["DT node lists 'arm,primecell'"] -->|creates| B["an AMBA device, not a platform device"]
  B -->|checks| C{"'arm,primecell-periphid'<br/>property in the node?"}
  C -->|yes: use it as the ID| M
  C -->|no| D{"enable apb_pclk"}
  D -->|no such clock| G["defer: try again later, forever"]
  D -->|ok| R["read last 0x20 bytes of the window"]
  R --> E{"cell ID is 0xB105F00D?"}
  E -->|no| G
  E -->|yes: store peripheral ID| M{"(ID & mask) == id<br/>for a driver's table entry?"}
  M -->|yes| P{"probe: enable apb_pclk again"}
  P -->|no such clock| X["probe fails, not bound"]
  P -->|ok| H["the driver binds"]`,
  },
  "tty-path": {
    kind: "flow",
    title: "The path of a keystroke through a terminal",
    desc: "Your keyboard sends keystrokes to Terminal.app, which writes bytes into the primary end of a pty that it holds. The bytes pass through the line discipline in the macOS kernel, which delivers them to the replica end, /dev/ttys001, held by the shell. The shell, sleep or macvmm read from it. Their output bytes go back through the line discipline, which passes them to Terminal.app to draw on the screen.",
    width: 520, height: 640,
    nodes: [
      { id: "K", x: 180, y: 36, w: 220, text: "Your keyboard" },
      { id: "T", x: 180, y: 136, w: 220, text: "Terminal.app" },
      { id: "M", x: 180, y: 246, w: 240, text: "pty primary end\nheld by Terminal.app" },
      { id: "LD", x: 180, y: 366, w: 240, text: "line discipline\nin the macOS kernel" },
      { id: "S", x: 180, y: 486, w: 260, text: "pty replica end, /dev/ttys001\nheld by the shell" },
      { id: "P", x: 180, y: 600, w: 240, text: "shell, sleep, macvmm" },
    ],
    edges: [
      { path: [["K", "s"], ["T", "n"]], label: "keystrokes", anchor: "start", dx: 10 },
      { path: [["T", "s"], ["M", "n"]], label: "writes bytes", anchor: "start", dx: 10 },
      { path: [["M", "s"], ["LD", "n"]], label: "passes through", anchor: "start", dx: 10 },
      { path: [["LD", "s"], ["S", "n"]], label: "delivers", anchor: "start", dx: 10 },
      { path: [["S", "s"], ["P", "n"]], label: "read by", anchor: "start", dx: 10 },
      { path: [["P", "e"], [400, 600], [400, 376], ["LD", "e+10"]], seg: 1, label: "output bytes", anchor: "start", dx: 8, lw: 90 },
      { path: [["LD", "e-10"], [470, 356], [470, 136], ["T", "e"]], seg: 1, label: "draws on screen", anchor: "end", dx: -8, lw: 80 },
    ],
    mmd: `flowchart LR
  K[Your keyboard] -->|keystrokes| T[Terminal.app]
  T -->|writes bytes| M[pty primary end<br/>held by Terminal.app]
  M -->|passes through| LD[line discipline<br/>in the macOS kernel]
  LD -->|delivers| S["pty replica end, /dev/ttys001<br/>held by the shell"]
  S -->|read by| P[shell, sleep, macvmm]
  P -->|output bytes| LD
  LD -->|draws on screen| T`,
  },
  "socket-bind": {
    kind: "flow",
    title: "Binding a Unix socket path safely",
    desc: "Step 1: lstat the path, without following symlinks. If nothing is there, bind. If something is there, step 2: is it a socket file? If not (a symlink, a regular file or anything else), refuse and exit 2. If yes, step 3: is it owned by our uid? If not, refuse and exit 2. If yes, step 4: a test connect. ECONNREFUSED means the socket is stale: unlink it, then bind. If the connection is accepted the socket is live, and any other error, both refuse and exit 2.",
    width: 600, height: 640,
    nodes: [
      { id: "A", x: 180, y: 40, w: 240, text: "1. lstat the path\n(do not follow symlinks)" },
      { id: "N", x: 480, y: 40, w: 150, text: "bind", shape: "end" },
      { id: "B", x: 180, y: 170, w: 240, text: "2. is it a socket file?", shape: "decision" },
      { id: "C", x: 180, y: 300, w: 240, text: "3. owned by our uid?", shape: "decision" },
      { id: "D", x: 180, y: 430, w: 240, text: "4. test connect", shape: "decision" },
      { id: "X", x: 480, y: 300, w: 150, text: "refuse, exit 2", shape: "end" },
      { id: "U", x: 180, y: 590, w: 240, text: "unlink, then bind", shape: "end" },
    ],
    edges: [
      { path: [["A", "e"], ["N", "w"]], label: "nothing there", dy: -16, lw: 120 },
      { path: [["A", "s"], ["B", "n"]], label: "something there", anchor: "start", dx: 10 },
      { path: [["B", "e"], [480, 170], ["X", "n"]], seg: 0, label: "no: symlink, regular file, other", dy: -18, lw: 150 },
      { path: [["B", "s"], ["C", "n"]], label: "yes", anchor: "start", dx: 10 },
      { path: [["C", "e"], ["X", "w"]], label: "no", dy: -12 },
      { path: [["C", "s"], ["D", "n"]], label: "yes", anchor: "start", dx: 10 },
      { path: [["D", "e"], [480, 430], ["X", "s"]], seg: 0, label: "accepted: live, or any other error", dy: 22, lw: 150 },
      { path: [["D", "s"], ["U", "n"]], label: "ECONNREFUSED: stale", anchor: "start", dx: 10, lw: 170 },
    ],
    mmd: `flowchart TD
  A["1. lstat the path<br/>(do not follow symlinks)"] -->|"nothing there"| N["bind"]
  A -->|"something there"| B["2. is it a socket file?"]
  B -->|"no: symlink, regular file, other"| X["refuse, exit 2"]
  B -->|yes| C["3. owned by our uid?"]
  C -->|no| X
  C -->|yes| D["4. test connect"]
  D -->|"ECONNREFUSED: stale"| U["unlink, then bind"]
  D -->|"accepted: live"| X
  D -->|"any other error"| X`,
  },
};

export function renderDiagram(name) {
  const d = DIAGRAMS[name];
  return d.kind === "sequence" ? sequence(name, d) : flow(name, d);
}

/**
 * The GitHub copy of a rendered diagram: its own size, an opaque background, and a <style> made
 * from course.css (see the top of this file). `css` is course.css's text.
 */
export function githubSvg(svg, css) {
  const { light, dark } = themeTokens(css);
  const rules = [...css.matchAll(/^(\.dg\b[^{]*)\{([^}]*)\}/gm)].map((m) => [m[1].trim(), m[2].trim()]);
  rules.push([".dg .dg-bg", "fill: var(--card)"]);
  const sheet = (t) => rules.map(([sel, body]) => `${sel}{${body.replace(/var\(--([a-z0-9-]+)\)/g, (all, k) => {
    if (!(k in t)) throw new Error(`course.css: .dg rule uses --${k}, which is not a token`);
    return t[k];
  })}}`).join("\n");
  const [, w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  return svg
    .replace(/^<svg /, `<svg width="${w}" height="${h}" `)
    .replace(/(<\/desc>\n)/, `$1<style>\n${sheet(light)}\n@media (prefers-color-scheme: dark) {\n${sheet(dark)}\n}\n</style>\n`)
    .replace(/(<\/defs>\n)/, `$1<rect class="dg-bg" x="0" y="0" width="${w}" height="${h}" rx="10" fill="${light.card}"/>\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  const stale = [];
  mkdirSync(join(OUT, "src"), { recursive: true });
  mkdirSync(join(OUT, "github"), { recursive: true });
  const css = readFileSync(CSS, "utf8");
  for (const name of Object.keys(DIAGRAMS)) {
    const svg = renderDiagram(name);
    const files = [[join(OUT, `${name}.svg`), svg], [join(OUT, "github", `${name}.svg`), githubSvg(svg, css)], [join(OUT, "src", `${name}.mmd`), DIAGRAMS[name].mmd + "\n"]];
    for (const [f, text] of files) {
      if (check) { if (!existsSync(f) || readFileSync(f, "utf8") !== text) stale.push(f); }
      else writeFileSync(f, text);
    }
  }
  if (stale.length) { console.error(`diagrams out of date (run node course/site/tools/diagrams.mjs):\n  ${stale.join("\n  ")}`); process.exit(1); }
  console.log(check ? "DIAGRAMS OK" : `wrote ${Object.keys(DIAGRAMS).length} diagrams to docs/diagrams/`);
}
