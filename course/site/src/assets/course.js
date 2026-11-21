// Page behaviour for the course site (DESIGN.md §3). Loaded as an external module on every page:
// the CSP forbids inline scripts and handlers. Everything here is an enhancement: with JS off,
// every page still reads correctly (predicts are native <details>, code is plain text).
//
// Storage: one key, `vmm-progress-v1`, holding {"done": [chapter ids], "seen": [chapter ids]}
// ("seen" = the checkpoint's "I saw this output" box), plus `vmm-retrieval-v1` counting visits
// so warm-up questions rotate. Stored only in this browser; every access is wrapped, because
// storage can be blocked, full or absent.

const PROGRESS_KEY = "vmm-progress-v1";
const RETRIEVAL_KEY = "vmm-retrieval-v1";

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: fine */ }
}
function progress() {
  const p = load(PROGRESS_KEY, {});
  return { done: Array.isArray(p.done) ? p.done.map(String) : [], seen: Array.isArray(p.seen) ? p.seen.map(String) : [] };
}

let liveTimer = 0;
export function announce(text) {
  const live = document.getElementById("live");
  if (!live) return;
  clearTimeout(liveTimer);
  live.textContent = "";
  liveTimer = setTimeout(() => { live.textContent = String(text); }, 50);
}

// ---- copy buttons --------------------------------------------------------------------------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for http://localhost previews and older browsers.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "visually-hidden";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
function textFor(button) {
  const host = button.closest("figure, .checkpoint, .cmdline");
  if (!host) return "";
  if (button.dataset.copy === "cmd") {
    return [...host.querySelectorAll(".cmd")].map((c) => [...c.childNodes].filter((n) => !(n.classList && n.classList.contains("prompt"))).map((n) => n.textContent).join("")).join("\n");
  }
  const lines = host.querySelectorAll("pre .line");
  if (lines.length) return [...lines].map((l) => l.textContent).join("\n");
  const pre = host.querySelector("pre");
  return pre ? pre.textContent : "";
}
function initCopy() {
  for (const b of document.querySelectorAll("button.copy")) {
    b.addEventListener("click", async () => {
      const ok = await copyText(textFor(b));
      const old = b.textContent;
      b.textContent = ok ? "Copied" : "Copy failed";
      announce(ok ? "Copied to the clipboard" : "Copy failed; select the text instead");
      setTimeout(() => { b.textContent = old; }, 1500);
    });
  }
}

// ---- predict: show all answers (a toggle with a fixed label; aria-pressed carries the state) --
function initPredict() {
  const tools = document.querySelector(".predict-tools");
  const all = [...document.querySelectorAll("details.predict")];
  if (!tools || all.length < 2) return;
  const btn = tools.querySelector("button");
  tools.hidden = false;
  const sync = () => {
    btn.setAttribute("aria-pressed", String(all.every((d) => d.open)));
  };
  btn.addEventListener("click", () => {
    const open = !all.every((d) => d.open);
    for (const d of all) d.open = open;
    sync();
    announce(open ? "All answers revealed" : "All answers hidden");
  });
  for (const d of all) d.addEventListener("toggle", sync);
  sync();
}

// ---- progress ------------------------------------------------------------------------------
function renderProgress() {
  const p = progress();
  for (const a of document.querySelectorAll("[data-chapter-link]")) {
    const done = p.done.includes(a.dataset.chapterLink);
    let mark = a.querySelector(".done-mark");
    if (done && !mark) {
      mark = document.createElement("span");
      mark.className = "done-mark";
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "✓";
      mark.append(glyph);
      const sr = document.createElement("span");
      sr.className = "visually-hidden";
      sr.textContent = " (completed)";
      mark.append(sr);
      a.append(mark);
    } else if (!done && mark) mark.remove();
  }
  const btn = document.querySelector("button.mark-done");
  if (btn) {
    const done = p.done.includes(btn.dataset.chapter);
    // A toggle button keeps one label; its pressed state says whether the chapter is complete.
    btn.setAttribute("aria-pressed", String(done));
  }
  const cont = document.querySelector("[data-continue]");
  if (cont) {
    const order = JSON.parse(cont.dataset.continue || "[]");
    const next = order.find((c) => !p.done.includes(c.id));
    if (p.done.length && next) {
      const a = cont.querySelector("a");
      a.href = next.url;
      a.textContent = `Continue: ${next.number} ${next.title}`;
      cont.hidden = false;
    }
  }
}
function initProgress() {
  const btn = document.querySelector("button.mark-done");
  if (btn) {
    btn.hidden = false;
    btn.addEventListener("click", () => {
      const p = progress();
      const id = btn.dataset.chapter;
      p.done = p.done.includes(id) ? p.done.filter((x) => x !== id) : [...p.done, id];
      save(PROGRESS_KEY, p);
      renderProgress();
      announce(p.done.includes(id) ? "Chapter marked complete" : "Chapter marked not complete");
    });
  }
  const seen = document.querySelector("input.checkpoint-seen");
  if (seen) {
    const id = seen.dataset.chapter;
    seen.closest("label").hidden = false;
    seen.checked = progress().seen.includes(id);
    seen.addEventListener("change", () => {
      const p = progress();
      p.seen = seen.checked ? [...new Set([...p.seen, id])] : p.seen.filter((x) => x !== id);
      save(PROGRESS_KEY, p);
      if (seen.checked && btn) btn.classList.add("btn--primary");
    });
    if (seen.checked && btn) btn.classList.add("btn--primary");
  }
  renderProgress();
}

// ---- retrieval rotation --------------------------------------------------------------------
function initRetrieval() {
  const list = document.querySelector("ol.retrieval[data-chapter]");
  if (!list) return;
  const visits = load(RETRIEVAL_KEY, {});
  const id = list.dataset.chapter;
  const n = Number.isInteger(visits[id]) ? visits[id] : 0;
  visits[id] = n + 1;
  save(RETRIEVAL_KEY, visits);
  for (const slot of list.querySelectorAll(".retrieval__slot")) {
    const items = [...slot.querySelectorAll(".retrieval__item")];
    if (items.length < 2) continue;
    const base = Number(slot.dataset.offset || 0);
    const pick = (base + n) % items.length;
    items.forEach((it, k) => { it.hidden = k !== pick; });
  }
}

// ---- scroll regions: focusable and named only when they actually overflow ----------------------
// Tables, wide SVGs and <pre> blocks can scroll sideways on a phone. A keyboard user must be able
// to reach such a scroller, but one that fits needs no tab stop and no landmark. (Without JS,
// code blocks keep a static tabindex as the fallback.) Re-checked on resize and when a
// <details> opens, since content inside a closed one measures zero.
function initScrollRegions() {
  const els = [...document.querySelectorAll("[data-scroll-label]")];
  if (!els.length) return;
  const update = () => {
    for (const el of els) {
      if (el.scrollWidth > el.clientWidth + 1) {
        el.tabIndex = 0;
        el.setAttribute("role", "region");
        el.setAttribute("aria-label", el.dataset.scrollLabel);
      } else {
        el.removeAttribute("tabindex");
        el.removeAttribute("role");
        el.removeAttribute("aria-label");
      }
    }
  };
  update();
  let t = 0;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(update, 150); });
  document.addEventListener("toggle", (e) => { if (e.target instanceof HTMLDetailsElement && e.target.open) update(); }, true);
}

// ---- landing curriculum: parts open on a wide screen, closed on a phone (DESIGN.md §2.1) ------
// Applied once, on load, at the same 64rem breakpoint as the CSS. After that the reader's own
// toggles win: rotating a tablet must not close what they opened.
function initParts() {
  const parts = [...document.querySelectorAll("details[data-desktop-open]")];
  if (!parts.length || !window.matchMedia) return;
  const wide = window.matchMedia("(min-width: 64rem)").matches;
  for (const d of parts) d.open = wide;
}

// ---- "#heading&lab=state" fragments: the browser does not scroll to "heading" by itself --------
function initFragment() {
  const h = location.hash.slice(1);
  if (!h.includes("&")) return;
  const plain = h.split("&").find((p) => p !== "" && !p.includes("="));
  if (!plain) return;
  let id;
  try { id = decodeURIComponent(plain); } catch { return; }
  const el = document.getElementById(id);
  if (el) el.scrollIntoView();
}

// ---- contents drawer: Escape closes and returns focus --------------------------------------
function initDrawer() {
  const d = document.querySelector("details.toc-drawer");
  if (!d) return;
  d.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && d.open) {
      d.open = false;
      d.querySelector("summary").focus();
    }
  });
}

function init() {
  initCopy();
  initPredict();
  initProgress();
  initRetrieval();
  initDrawer();
  initScrollRegions();
  initParts();
  initFragment();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
