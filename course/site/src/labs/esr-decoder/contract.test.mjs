// Static checks of the LABS.md contract for the shipped files of this lab (the builder will
// enforce the same rules; this catches a slip before it exists). The view's behaviour is tested
// under a fake DOM in view.test.mjs; neither needs a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shipped = readdirSync(here).filter((f) => !f.endsWith(".test.mjs"));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("only allowed file types ship", () => {
  for (const f of shipped) assert.match(f, /\.(mjs|js|css|json|svg)$/, f);
  for (const f of ["model.mjs", "view.mjs"]) assert.ok(shipped.includes(f), f);
});

test("shipped code avoids the forbidden strings", () => {
  for (const f of shipped.filter((f) => /\.(mjs|js)$/.test(f))) {
    const src = stripComments(readFileSync(join(here, f), "utf8"));
    for (const bad of ["eval(", "new Function", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "http://", "https://", "localStorage", "fetch(", "WebAssembly", "setAttribute(\"style\"", "javascript:"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
    assert.doesNotMatch(src, /setTimeout\(\s*["'`]/, `${f}: string timer`);
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /^export function mount\(/m);
});

test("model.mjs is pure: no DOM or window", () => {
  const src = stripComments(readFileSync(join(here, "model.mjs"), "utf8"));
  assert.doesNotMatch(src, /\b(document|window|navigator|location|globalThis)\b/);
});

test("every CSS rule is scoped to this lab and uses tokens, not colors", () => {
  const css = stripComments(readFileSync(join(here, "style.css"), "utf8"));
  const selectors = [...css.matchAll(/([^{}@]+)\{/g)].map((m) => m[1].trim()).filter((s) => s && !/^(media|supports)\b/.test(s) && !/^(from|to|\d+%)$/.test(s));
  for (const group of selectors) {
    for (const sel of group.split(",")) assert.match(sel.trim(), /^\.lab\[data-lab="esr-decoder"\]/, sel.trim());
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/, "hard-coded color");
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("fallback.svg is safe to inline and has a text equivalent", () => {
  const svg = readFileSync(join(here, "fallback.svg"), "utf8");
  assert.match(svg, /<title>[^<]+<\/title>/);
  assert.match(svg, /<desc>[^<]{100,}<\/desc>/);
  assert.doesNotMatch(svg, /<script|<foreignObject|\son[a-z]+=|href=|https?:|url\(|\sid=/i);
  assert.match(svg, /0x9389_0046/, "the value from chapter 05's captured stop");
});

test("lab.json has a title and a one-sentence goal", () => {
  const lab = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));
  assert.equal(lab.title, "ESR decoder");
  assert.ok(lab.goal.length > 20 && lab.goal.trim().endsWith("."));
});
