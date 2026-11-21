// trap-or-not view: renders the model's state and turns events into model steps.
//
// Two ways to sort, so no one is left out: drag a card onto a bucket (mouse), or pick its bucket
// in the card's own <select> (keyboard, touch, screen readers). Both send the same model action.
// DOM is built with createElement/textContent only; nothing from the hash reaches the page except
// through decode(), which accepts exactly eleven known characters. Links come from the model's
// fixed LINKS table.
//
// The board is built once and then updated in place: a move relocates the existing card node,
// so the <select> a keyboard user is on stays the same element. Changes made through a select are
// committed after a short pause (SELECT_SETTLE_MS), because some browsers fire `change` on every
// arrow key press on a closed select; arrowing past two buckets must not move the card three
// times and queue three announcements.
//
// Keyboard sorting walks the pool: when a select moves a card out of "Not sorted yet", focus goes
// to the next unsorted card's select (in lesson order, wrapping), so Tab order never has to be
// fought; only when the pool is empty does focus follow the moved card. Only the card's title is
// draggable, never the <li>, so the select is never inside a draggable element (a draggable
// ancestor can steal mouse and long-press input from form controls in some engines).
import {
  BUCKETS,
  ITEMS,
  initialState,
  step,
  unsorted,
  inBucket,
  sortedCount,
  status,
  ledgerText,
  nextLinks,
  bucket,
  item,
  encode,
  decode,
} from "./model.mjs";

const DRAG_TYPE = "text/plain";
const ANNOUNCE_GAP_MS = 300;
const SELECT_SETTLE_MS = 350;

/** Small element builder: h("p", {class: "x"}, "text", child, ...). Attributes are set, never parsed. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** The course base URL (`/build-your-own/vmm/`): the lab's assets live at `assets/labs/<name>/`. */
function courseBase(ctx) {
  for (const from of [ctx.base, import.meta.url]) {
    try {
      if (from) return new URL("../../../", from);
    } catch {
      // try the next one
    }
  }
  return null;
}

export function mount(el, ctx) {
  let state = decode(ctx.hash.get()) ?? initialState();
  const pid = ctx.id;
  // Bucket headings sit one level under the lab's own title: the standalone page's title is an
  // h1 (so h2 here); embedded, the lab title is an h3 under the chapter's h2 (so h4 here).
  const headTag = ctx.standalone ? "h2" : "h4";
  const base = courseBase(ctx);

  // ---- throttled announcements (about one per 300 ms; the last message wins) ----
  let lastSpoke = 0;
  let pendingTimer = null;
  let pendingText = "";
  function say(text) {
    readout.textContent = text;
    pendingText = text;
    const now = Date.now();
    const wait = lastSpoke + ANNOUNCE_GAP_MS - now;
    if (wait <= 0 && pendingTimer === null) {
      lastSpoke = now;
      ctx.announce(text);
      return;
    }
    if (pendingTimer === null) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastSpoke = Date.now();
        ctx.announce(pendingText);
      }, Math.max(wait, 0));
    }
  }

  // ---- static frame ----
  const intro = h(
    "p",
    { class: "ton__help", id: `${pid}-help` },
    "Sort each guest action into a bucket: drag its card, or choose the bucket in the card's menu. ",
    "Nothing is scored. When you have sorted all ten, show the feedback and read why.",
  );
  // A toggle button keeps one label; aria-pressed carries the state (ARIA APG, button pattern).
  // Its label carries the progress until all ten are sorted ("Show feedback (3 of 10 sorted)"),
  // never the pressed state, and a note under the controls asks for a guess first: the button
  // still works, but skipping the prediction should be a choice, not an accident.
  const revealBtn = h("button", { type: "button", class: "ton__btn ton__btn--primary", "aria-pressed": "false", text: "Show feedback" });
  const resetBtn = h("button", { type: "button", class: "ton__btn", text: "Reset" });
  // Undo sits right after Reset, so it is one Tab away, and it stays until the next change
  // (no timer: a timed offer is a barrier for keyboard and screen-reader users).
  const undoBtn = h("button", { type: "button", class: "ton__btn ton__undo", text: "Undo reset" });
  undoBtn.hidden = true;
  const copyBtn = h("button", { type: "button", class: "ton__btn", text: "Copy link to this sort" });
  const progress = h("p", { class: "ton__progress" });
  const controls = h("div", { class: "ton__controls" }, revealBtn, resetBtn, undoBtn, copyBtn, progress);
  const sortFirst = h("p", { class: "ton__sortfirst", text: "Sort first: the feedback means more once you have guessed." });
  const board = h("div", { class: "ton__board" });
  const after = h("p", {
    class: "ton__after",
    text:
      "Measured by how often each happens, most of what a guest does never leaves it: a running guest executes millions of loads for every exit. " +
      "The two supervisors split the rest. Now pick three actions you sorted differently from the reference (or the three you were least sure of) " +
      "and, under Q1 in your journal, write for each its ledger row, what stops the guest, and who handles it.",
  });
  after.hidden = true;
  const readout = h("p", { class: "ton__readout", id: `${pid}-readout` });
  const readoutBox = h("div", { class: "ton__readoutbox" }, h("span", { class: "ton__label", text: "Readout" }), readout);
  el.append(intro, controls, sortFirst, board, after, readoutBox);

  // ---- cards, built once ----
  const cards = new Map();
  for (const it of ITEMS) {
    const selId = `${pid}-sel-${it.id}`;
    const li = h("li", { class: "ton__card", "data-item": it.id });
    const title = h(
      "p",
      { class: "ton__plain", id: `${pid}-t-${it.id}`, draggable: "true", title: "Drag to a bucket" },
      h("span", { class: "ton__grip", "aria-hidden": "true", text: "⠿" }),
      " ",
      it.plain,
    );
    if (it.insn) title.append(" ", h("code", { class: "ton__insn", text: it.insn }));
    const select = h("select", { id: selId, class: "ton__select", "data-item": it.id });
    select.append(h("option", { value: "", text: "Not sorted yet" }));
    for (const b of BUCKETS) select.append(h("option", { value: b.id, text: b.label }));
    const label = h(
      "label",
      { class: "ton__sellabel", for: selId },
      h("span", { class: "ton__vh", text: `Bucket for: ${it.plain}` }),
      h("span", { "aria-hidden": "true", text: "Bucket" }),
    );
    const fb = h("div", { class: "ton__fbslot" });
    li.append(title, label, select, fb);
    cards.set(it.id, { li, select, fb, key: "" });
  }

  // ---- zones, built once ----
  const zones = new Map();
  function zone(id, labelText, hint) {
    const headId = `${pid}-z-${id || "pool"}`;
    const sec = h("section", { class: `ton__zone${id ? "" : " ton__zone--pool"}`, "data-bucket": id, "aria-labelledby": headId });
    const count = h("span", { class: "ton__count" });
    sec.append(h(headTag, { class: "ton__zonehead", id: headId }, labelText, count));
    if (hint) sec.append(h("p", { class: "ton__hint", text: hint }));
    const list = h("ul", { class: "ton__list", role: "list" });
    const empty = h("p", {
      class: "ton__empty",
      text: id ? "Nothing here yet. Drag a card here, or pick this bucket in a card's Bucket menu." : "All ten are sorted.",
    });
    sec.append(list, empty);
    zones.set(id, { sec, count, list, empty });
    return sec;
  }
  const buckets = h("div", { class: "ton__buckets" });
  for (const b of BUCKETS) buckets.append(zone(b.id, b.label, b.hint));
  board.append(zone("", "Not sorted yet", null), buckets);

  // ---- feedback for one card ----
  function feedback(it, st) {
    const tagText = st === "same" ? "Same as the reference" : st === "different" ? "Different from the reference" : "Not sorted";
    const box = h("div", { class: "ton__fb" });
    box.append(
      h(
        "p",
        { class: `ton__status ton__status--${st}` },
        h("span", { class: "ton__mark", "aria-hidden": "true", text: st === "same" ? "=" : st === "different" ? "≠" : "?" }),
        ` ${tagText}`,
      ),
    );
    if (st !== "same") box.append(h("p", { class: "ton__ref" }, "Reference bucket: ", h("strong", { text: bucket(it.answer).label })));
    // The chapter's two questions lead; a note appears only where it adds something; the rest
    // (definition, ledger row, where to read on) waits behind a <details>.
    const dl = h("dl", { class: "ton__dl" });
    const row = (list, k, v) => list.append(h("dt", { text: k }), typeof v === "string" ? h("dd", { text: v }) : v);
    row(dl, "What stops it", it.stops);
    row(dl, "Who handles it", it.handles);
    if (it.note) row(dl, "Note", it.note);
    const more = h("dl", { class: "ton__dl" });
    row(more, it.insn ? `${it.insn} means` : "What it is", it.def);
    row(more, "Problem ledger", ledgerText(it).replace(/^Ledger rows? /, "row "));
    const links = nextLinks(it);
    const dd = h("dd");
    if (it.chapters.length) dd.append("More in ");
    links.forEach((l, i) => {
      if (i > 0) dd.append(i === links.length - 1 ? " and " : ", ");
      dd.append(base ? h("a", { href: new URL(l.path, base).href, text: l.text }) : l.text);
    });
    row(more, "Next", dd);
    box.append(dl, h("details", { class: "ton__more" }, h("summary", { text: "More about this action" }), more));
    return box;
  }

  // ---- bring the DOM in line with the state, moving only what changed ----
  function sync() {
    const active = document.activeElement;
    const n = sortedCount(state);
    revealBtn.setAttribute("aria-pressed", state.revealed ? "true" : "false");
    revealBtn.textContent = n < ITEMS.length ? `Show feedback (${n} of ${ITEMS.length} sorted)` : "Show feedback";
    sortFirst.hidden = state.revealed || n === ITEMS.length;
    progress.textContent = `${n} of ${ITEMS.length} sorted`;
    after.hidden = !state.revealed;

    for (const [id, z] of zones) {
      const items = id ? inBucket(state, id) : unsorted(state);
      // Insert out-of-place cards before the cursor; cards already in order are not touched.
      let cursor = z.list.firstChild;
      for (const it of items) {
        const li = cards.get(it.id).li;
        if (cursor === li) cursor = cursor.nextSibling;
        else z.list.insertBefore(li, cursor);
      }
      z.count.textContent = ` (${items.length})`;
      z.empty.hidden = items.length > 0;
    }

    ITEMS.forEach((it, i) => {
      const c = cards.get(it.id);
      const st = status(state, it.id);
      const want = state.placed[i] ?? "";
      if (c.select.value !== want) c.select.value = want;
      c.li.className = `ton__card${state.revealed ? ` ton__card--${st}` : ""}`;
      const key = state.revealed ? st : "";
      if (c.key !== key) {
        c.key = key;
        c.fb.replaceChildren(...(state.revealed ? [feedback(it, st)] : []));
      }
    });

    // Moving a node drops focus in some browsers; give it back to the same element.
    if (active && active !== document.activeElement && el.contains(active)) active.focus();
  }

  // ---- state changes ----
  let settleTimer = null;
  let settle = null;
  function flushSettle() {
    if (settleTimer === null) return;
    clearTimeout(settleTimer);
    settleTimer = null;
    const s = settle;
    settle = null;
    s();
  }

  let undoState = null;
  function clearUndo() {
    undoState = null;
    if (!undoBtn.hidden && document.activeElement === undoBtn) resetBtn.focus();
    undoBtn.hidden = true;
  }

  function commit(next) {
    if (next === state) return false;
    state = next;
    ctx.hash.set(encode(state));
    sync();
    return true;
  }

  function apply(action, message) {
    flushSettle();
    const next = step(state, action);
    if (next === state) return false;
    clearUndo();
    commit(next);
    if (message) say(message);
    return true;
  }

  function moveMessage(it, bucketId) {
    const where = bucketId ? bucket(bucketId).label : "Not sorted yet";
    let msg = `${it.plain}: moved to ${where}. ${sortedCount(state)} of ${ITEMS.length} sorted.`;
    if (state.revealed && bucketId) {
      msg += status(state, it.id) === "same" ? " Same as the reference." : ` Different from the reference, which is: ${bucket(it.answer).label}.`;
    }
    return msg;
  }

  function placeAction(itemId, bucketId) {
    return bucketId ? { type: "place", item: itemId, bucket: bucketId } : { type: "unplace", item: itemId };
  }

  function move(it, target) {
    if (apply(placeAction(it.id, target), null)) say(moveMessage(it, target));
  }

  /** The unsorted item to work on after `it`: the next one in lesson order, wrapping; null if none. */
  function nextUnsorted(it) {
    const i = ITEMS.indexOf(it);
    for (let k = 1; k < ITEMS.length; k++) {
      const j = (i + k) % ITEMS.length;
      if (state.placed[j] === null) return ITEMS[j];
    }
    return null;
  }

  // A select moved a card: if it left the pool and others are still there, hand focus to the
  // next unsorted card's select and say so; otherwise focus stays on the moved select.
  function moveFromSelect(it, target, select) {
    const wasUnsorted = state.placed[ITEMS.indexOf(it)] === null;
    if (!apply(placeAction(it.id, target), null)) return;
    let msg = moveMessage(it, target);
    const next = wasUnsorted && target !== null && document.activeElement === select ? nextUnsorted(it) : null;
    if (next) {
      cards.get(next.id).select.focus();
      msg += ` Next: ${next.plain}.`;
    }
    say(msg);
  }

  // ---- events (delegated to el; the nodes are built once, so nothing leaks) ----
  el.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement) || !t.dataset.item) return;
    const it = item(t.dataset.item);
    if (!it) return;
    const target = t.value === "" ? null : t.value;
    if (target !== null && !bucket(target)) return;
    // Commit once the select has been still for a moment; the newest value wins.
    if (settleTimer !== null) clearTimeout(settleTimer);
    settle = () => moveFromSelect(it, target, t);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const s = settle;
      settle = null;
      s();
    }, SELECT_SETTLE_MS);
  });

  let dragging = null;
  el.addEventListener("dragstart", (e) => {
    const grip = e.target instanceof Element ? e.target.closest(".ton__plain") : null;
    const li = grip ? grip.closest(".ton__card") : null;
    if (!li || !item(li.dataset.item)) return;
    dragging = li.dataset.item;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_TYPE, dragging);
    li.classList.add("ton__card--dragging");
  });
  el.addEventListener("dragend", () => {
    dragging = null;
    for (const n of el.querySelectorAll(".ton__card--dragging, .ton__zone--over")) n.classList.remove("ton__card--dragging", "ton__zone--over");
  });
  el.addEventListener("dragover", (e) => {
    const z = e.target instanceof Element ? e.target.closest(".ton__zone") : null;
    if (!z || !dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    for (const n of el.querySelectorAll(".ton__zone--over")) if (n !== z) n.classList.remove("ton__zone--over");
    z.classList.add("ton__zone--over");
  });
  el.addEventListener("dragleave", (e) => {
    const z = e.target instanceof Element ? e.target.closest(".ton__zone") : null;
    if (z && !(e.relatedTarget instanceof Node && z.contains(e.relatedTarget))) z.classList.remove("ton__zone--over");
  });
  el.addEventListener("drop", (e) => {
    const z = e.target instanceof Element ? e.target.closest(".ton__zone") : null;
    if (!z) return;
    e.preventDefault();
    // Only drags that started in this lab count; text dropped from elsewhere is ignored.
    const id = dragging;
    dragging = null;
    z.classList.remove("ton__zone--over");
    const it = id ? item(id) : null;
    if (!it) return;
    const target = z.dataset.bucket || null;
    if (target !== null && !bucket(target)) return;
    move(it, target);
  });

  revealBtn.addEventListener("click", () => {
    if (state.revealed) apply({ type: "hide" }, "Feedback hidden.");
    else apply({ type: "reveal" }, "Feedback shown under each action. Actions you placed differently from the reference say so.");
  });
  // Reset is one keypress from Show feedback, so it can be undone until the next change.
  resetBtn.addEventListener("click", () => {
    flushSettle();
    const prev = state;
    if (!apply({ type: "reset" }, null)) {
      say("Already reset: all ten actions are unsorted.");
      return;
    }
    undoState = prev;
    undoBtn.hidden = false;
    say("Reset: all ten actions are unsorted. The next button, Undo reset, brings your sort back.");
  });
  undoBtn.addEventListener("click", () => {
    const prev = undoState;
    if (!prev) return;
    resetBtn.focus();
    clearUndo();
    commit(prev);
    say(`Reset undone: ${sortedCount(state)} of ${ITEMS.length} sorted${state.revealed ? ", feedback shown" : ""}.`);
  });
  copyBtn.addEventListener("click", async () => {
    flushSettle();
    ctx.hash.set(encode(state));
    const link = location.href;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(link);
      say("Link copied. It reopens the lab with this sort.");
    } catch {
      say("Could not copy here. The address bar already holds a link to this sort.");
    }
  });

  sync();
  // The first readout is shown but not spoken: announcing on page load is noise.
  readout.textContent =
    sortedCount(state) > 0
      ? `Opened a shared sort: ${sortedCount(state)} of ${ITEMS.length} sorted${state.revealed ? ", feedback shown" : ""}.`
      : "Ten guest actions, none sorted yet.";

  return {
    destroy() {
      for (const t of [pendingTimer, settleTimer]) if (t !== null) clearTimeout(t);
      pendingTimer = settleTimer = null;
    },
  };
}
