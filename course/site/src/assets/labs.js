// Lab host: mounts every in-browser lab on the page through the contract in course/site/LABS.md.
//
// The builder emits, per embed:
//   <section class="lab" data-lab="NAME" data-src="<abs URL of the lab's directory>/" data-id="lab-NAME-1"
//            data-standalone="true|false"> ... <div class="lab__fallback"> ... <div class="lab__root">
// This module imports `view.mjs` from data-src (a same-origin module: allowed by script-src 'self'),
// calls mount(el, ctx), and hides the static fallback once mount succeeds. A lab that throws shows
// its error and keeps the fallback visible.

import { announce } from "./course.js";

// The fragment can hold a heading id and lab state together: "#spec-hunt&esr-decoder=...".
// Parts without "=" are plain fragments (a heading deep link) and are kept as they are, first;
// course.js scrolls to such an id on load.
function plainParts() {
  return location.hash.slice(1).split("&").filter((p) => p !== "" && !p.includes("="));
}

function hashState() {
  const out = new Map();
  const h = location.hash.slice(1);
  if (!h.includes("=")) return out;
  for (const part of h.split("&")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try { out.set(decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))); } catch { /* malformed: ignore */ }
    }
  }
  return out;
}

function writeHash(name, value) {
  const m = hashState();
  if (value == null) m.delete(name); else m.set(name, String(value));
  const h = [...plainParts(), ...[...m].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)].join("&");
  history.replaceState(history.state, "", `${location.pathname}${location.search}${h ? `#${h}` : ""}`);
}

function throttled(fn, ms) {
  let last = 0, timer = 0, pending = null;
  return (text) => {
    pending = text;
    const now = Date.now();
    const run = () => { last = Date.now(); timer = 0; fn(pending); };
    if (now - last >= ms) run();
    else if (!timer) timer = setTimeout(run, ms - (now - last));
  };
}

async function mountOne(section) {
  const name = section.dataset.lab;
  const base = new URL(section.dataset.src, location.href).href;
  const root = section.querySelector(".lab__root");
  const fallback = section.querySelector(".lab__fallback");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = {
    name,
    id: section.dataset.id,
    base,
    standalone: section.dataset.standalone === "true",
    reducedMotion: reduced,
    announce: throttled(announce, 300),
    hash: {
      get: () => hashState().get(name) ?? null,
      set: (v) => writeHash(name, v),
    },
  };
  try {
    const mod = await import(new URL("view.mjs", base).href);
    if (typeof mod.mount !== "function") throw new Error("view.mjs does not export mount()");
    await mod.mount(root, ctx);
    if (fallback) fallback.hidden = true;
    section.classList.add("lab--live");
  } catch (e) {
    const p = document.createElement("p");
    p.className = "lab__error";
    p.textContent = `This lab failed to load: ${e && e.message ? e.message : String(e)}`;
    section.insertBefore(p, root);
  }
}

for (const s of document.querySelectorAll("section.lab[data-src]")) mountOne(s);
