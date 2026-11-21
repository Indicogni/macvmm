// durability-ladder view: renders the model's state and turns presses into model steps.
// All logic lives in model.mjs; this file only builds DOM (createElement + textContent, never
// innerHTML) inside the element the lab shell hands us. See course/site/LABS.md.
//
// Nothing animates and nothing plays by itself, so reduced motion needs no special path: the
// guest's fsync() is walked one step at a time with "Next step", never auto-played.
import {
  RUNGS, BLOCKS, SYNCS, FAILURES, MEASURED, MOVED_BY, PRESETS, VERDICTS,
  initialState, replay, step, canDo, summary, spoken, survivalLines, encode, decode, ladder, failureTable, blockById,
} from "./model.mjs";

const ANNOUNCE_GAP_MS = 300;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const PREDICTIONS = [
  { id: "", label: "No prediction" },
  { id: "ok", label: VERDICTS.ok.label },
  { id: "old", label: VERDICTS.old.label },
  { id: "lost", label: VERDICTS.lost.label },
  { id: "broken", label: "Inconsistent: the file system needs repair" },
];
const predictionOf = (verdict) => (verdict === "corrupt" || verdict === "stale" ? "broken" : verdict);

function focus(e) {
  if (e && !e.disabled && typeof e.focus === "function") { e.focus(); return true; }
  return false;
}

export function mount(el, ctx) {
  const id = ctx.id;
  let state = decode(ctx.hash.get()) ?? initialState();
  let script = null; // { preset, target }: a preset being walked with "Next step"
  let predicted = "";

  // ---- throttled announcements (about one per 300 ms; the latest text wins) ----
  let timer = null;
  let lastSpoke = 0;
  function say(text) {
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, lastSpoke + ANNOUNCE_GAP_MS - Date.now());
    timer = setTimeout(() => {
      timer = null;
      lastSpoke = Date.now();
      ctx.announce(text);
    }, wait);
  }

  // ---- static frame: configuration ----
  const flushBox = h("fieldset", { class: "dl-field dl-radios" }, h("legend", { text: "The virtio-blk device" }));
  const flushInputs = {};
  for (const [val, label] of [["f", "FLUSH negotiated (write-back)"], ["w", "FLUSH not negotiated (write-through)"]]) {
    const inputId = `${id}-flush-${val}`;
    const input = h("input", { type: "radio", name: `${id}-flush`, id: inputId, value: val });
    input.addEventListener("change", () => { if (input.checked) apply({ type: "config", flush: val === "f" }, { clearScript: true }); });
    flushInputs[val] = input;
    flushBox.append(h("span", { class: "dl-radio" }, input, h("label", { for: inputId, text: label })));
  }
  flushBox.append(h("p", { class: "dl-hint", text: "Write-back: the device completes a write before it is durable and relies on FLUSH to make it so. Write-through: it makes each write durable before completing it. macvmm always offers FLUSH; it is write-through only when the guest's driver does not accept it." }));

  const syncLegend = h("legend", { text: "The VMM answers FLUSH with" });
  const syncBox = h("fieldset", { class: "dl-field dl-radios dl-radios--col" }, syncLegend);
  const syncInputs = {};
  for (const s of SYNCS) {
    const inputId = `${id}-sync-${s.id}`;
    const input = h("input", { type: "radio", name: `${id}-sync`, id: inputId, value: s.id });
    input.addEventListener("change", () => { if (input.checked) apply({ type: "config", sync: s.id }, { clearScript: true }); });
    syncInputs[s.id] = input;
    syncBox.append(h("span", { class: "dl-radio" }, input, h("label", { for: inputId, text: s.label })));
  }
  const measured = h("p", { class: "dl-measured" });

  const presetSel = h("select", { id: `${id}-preset` });
  presetSel.append(h("option", { value: "", text: "Free play" }));
  for (const p of PRESETS) presetSel.append(h("option", { value: p.id, text: p.title }));
  const presetField = h("div", { class: "dl-field" }, h("label", { for: `${id}-preset`, text: "Scenario" }), presetSel);
  presetSel.addEventListener("change", () => {
    const p = PRESETS.find((x) => x.id === presetSel.value);
    if (!p) { script = null; render(); return; }
    const target = decode(p.hash);
    state = { ...target, actions: [] };
    script = { preset: p, target };
    predicted = "";
    commit(`Scenario: ${p.title}. ${p.goal} Press Next step.`);
  });

  // ---- static frame: run controls ----
  const nextBtn = h("button", { type: "button", class: "dl-btn dl-btn--primary" });
  const undoBtn = h("button", { type: "button", class: "dl-btn", text: "Undo" });
  const resetBtn = h("button", { type: "button", class: "dl-btn", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "dl-btn", text: "Copy link to this state" });
  const runBox = h("div", { class: "dl-buttons", role: "group", "aria-label": "Run" }, nextBtn, undoBtn, resetBtn, copyBtn);
  const scriptNote = h("p", { class: "dl-script" });
  const stepNote = h("p", { class: "dl-step" });

  const howTo = h("ol", { class: "dl-howto", "aria-label": "How to use this lab" },
    h("li", { text: "Press Next step until fsync() returns." }),
    h("li", { text: "Predict what the guest will find after a failure." }),
    h("li", { text: "Pick a failure. Then undo, change a choice, or try another scenario." }),
  );
  const howToNote = h("p", { class: "dl-hint", text: "The defaults are what macvmm really does." });

  const predictSel = h("select", { id: `${id}-predict` });
  for (const p of PREDICTIONS) predictSel.append(h("option", { value: p.id, text: p.label }));
  predictSel.addEventListener("change", () => { predicted = predictSel.value; render(); });
  const predictField = h("div", { class: "dl-field" },
    h("label", { for: `${id}-predict`, text: "Predict first: after the failure, the guest boots again and finds" }), predictSel);
  const failBox = h("div", { class: "dl-buttons", role: "group", "aria-label": "Failures" });
  const failButtons = {};
  for (const f of FAILURES) {
    const b = h("button", { type: "button", class: "dl-btn dl-btn--fail", text: f.button });
    b.addEventListener("click", () => { if (apply({ type: "do", token: `x${f.id}` })) focus(outcomeBox); });
    failButtons[f.id] = b;
    failBox.append(b);
  }

  const ladderBox = h("div", { class: "dl-ladder" });
  const ladderHead = h("h3", { class: "dl-h", tabindex: "-1", text: "Where each block is" });
  // A visual summary only: announcements go through ctx.announce (LABS.md section 6), so this
  // paragraph is deliberately not a live region.
  const readout = h("p", { class: "dl-readout" });
  const outcomeBox = h("div", { class: "dl-outcome", tabindex: "-1" });
  const realBox = h("div", { class: "dl-real" });
  const historyWrap = h("div", { class: "dl-scroll", tabindex: "0", role: "region", "aria-label": "Every step so far, scrollable" });

  const legend = h("dl", { class: "dl-legend", "aria-label": "The blocks" });
  for (const b of BLOCKS) legend.append(h("dt", { text: b.name }), h("dd", { text: b.long }));

  const tableWrap = h("div", { class: "dl-scroll", tabindex: "0", role: "region", "aria-label": "Which failure reaches which rung, scrollable" }, failureTableEl());

  const simplifies = h("details", { class: "dl-more" },
    h("summary", { text: "What this toy simplifies" }),
    h("ul", {},
      h("li", { text: "One fsync() of one appended block, three blocks on the disk. Real ext4 batches many files into one transaction and may write several journal blocks." }),
      h("li", { text: "The guest page cache is drawn as one rung. The guest also keeps clean copies of what it has sent; only the newest copy's deepest rung matters for what survives, so that is where each block is drawn." }),
      h("li", { text: "The inode in place stays dirty in the guest for the whole run. ext4 writes it home later, at a checkpoint, and it is the journal that makes that safe." }),
      h("li", { text: "Real ext4 sends the commit record with flags asking for a flush before it and durability for itself; the guest's block layer turns those into the two FLUSH requests shown here, because the virtio-blk device has a write cache but no FUA (a per-write \"make this one durable\" flag)." }),
      h("li", { text: "The journal entry stands for two real blocks: a descriptor block that says where the copy belongs, and the copied inode block. Real recovery also checks sequence numbers and, by default today, checksums before it trusts a transaction." }),
      h("li", { text: "The drive and macOS write back only when you press their buttons. In real life they do it on their own schedule, in any order, which is why every order is allowed." }),
      h("li", { text: "\"Inconsistent\" is the toy's verdict. What real ext4 does next depends on its journal checksums and on e2fsck; neither leaves you the file you were promised." }),
    ),
  );

  el.append(h("div", { class: "dl-wrap" },
    h("div", { class: "dl-intro" }, howTo, howToNote),
    h("div", { class: "dl-controls" }, flushBox, syncBox, presetField),
    measured,
    runBox,
    scriptNote,
    stepNote,
    h("div", { class: "dl-main" },
      h("div", { class: "dl-col" }, ladderHead, ladderBox, legend),
      h("div", { class: "dl-col" },
        h("h3", { class: "dl-h", text: "Then something fails" }),
        predictField, failBox, readout, outcomeBox, realBox),
    ),
    h("h3", { class: "dl-h", text: "What happened, step by step" }),
    historyWrap,
    h("h3", { class: "dl-h", text: "Which failure reaches which rung" }),
    tableWrap,
    simplifies,
  ));

  // ---- state changes ----
  function commit(message) {
    ctx.hash.set(encode(state));
    render();
    say(message ?? spoken(state));
  }

  function apply(action, { clearScript = false } = {}) {
    const next = step(state, action);
    if (clearScript) script = null;
    if (next === state) { render(); return false; }
    state = next;
    if (script) {
      const t = script.target;
      const onPath = t.flush === state.flush && t.sync === state.sync
        && state.actions.every((a, i) => t.actions[i] === a);
      if (!onPath) script = null;
    }
    commit();
    return true;
  }

  // Focus never falls to <body>: a button that disables itself, or a ladder button that the
  // re-render replaces, hands focus to where the learner goes next.
  function afterRun() {
    if (replay(state).world.failed) { focus(outcomeBox); return; }
    if (nextBtn.disabled) focus(predictSel); // fsync() returned: predict, then pick a failure
  }
  nextBtn.addEventListener("click", () => {
    if (script) {
      const tok = script.target.actions[state.actions.length];
      if (tok) apply({ type: "do", token: tok });
    } else {
      apply({ type: "do", token: "n" });
    }
    afterRun();
  });
  undoBtn.addEventListener("click", () => { apply({ type: "undo" }); if (undoBtn.disabled) focus(nextBtn); });
  resetBtn.addEventListener("click", () => { predicted = ""; apply({ type: "reset" }); focus(nextBtn); });
  copyBtn.addEventListener("click", async () => {
    commit("Link updated.");
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this state is in the address bar.");
    }
  });

  // ---- rendering ----
  function failureTableEl() {
    const table = h("table", { class: "dl-table dl-table--wide" });
    table.append(
      h("caption", { text: "Each failure wipes every rung above a line; everything below it survives. The last row says which call moves a block past each rung." }),
      h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "failure" }), ...RUNGS.map((r) => h("th", { scope: "col", text: `${r.n}. ${r.name}` })))),
    );
    const body = h("tbody");
    for (const row of failureTable()) {
      body.append(h("tr", {}, h("th", { scope: "row", text: row.failure }),
        ...row.cells.map((c) => h("td", { class: c === "lost" ? "dl-cell--lost" : "dl-cell--ok", text: c }))));
    }
    body.append(h("tr", { class: "dl-row--moved" }, h("th", { scope: "row", text: "moved past by" }), ...MOVED_BY.map((t) => h("td", { text: t }))));
    table.append(body);
    return table;
  }

  function chip(bid, rungN, world) {
    const b = blockById(bid);
    const lost = world.failed && rungN <= FAILURES.find((f) => f.id === world.failed).loses;
    const box = h("li", { class: `dl-chip dl-chip--${bid}${lost ? " dl-chip--lost" : ""}` },
      h("span", { class: "dl-chip__name", text: b.name }),
      lost ? h("span", { class: "dl-chip__tag", text: "lost" }) : null,
    );
    let token = null;
    let label = "";
    if (rungN === 3) { token = `h${bid}`; label = "macOS writes it back"; }
    if (rungN === 4) { token = `d${bid}`; label = "drive writes it to flash"; }
    if (token && !world.failed) {
      const btn = h("button", { type: "button", class: "dl-btn dl-btn--small", text: label, "aria-label": `${label}: the ${b.name}`, "data-token": token });
      btn.disabled = !canDo(state, token);
      btn.addEventListener("click", () => {
        apply({ type: "do", token }, { clearScript: true });
        restoreLadderFocus(token);
      });
      box.append(btn);
    }
    return box;
  }

  /** After a writeback button (and the ladder with it) is rebuilt: focus the follow-on action
   *  for the same block (h<b> leads to d<b>), else the same token, else Next step, else the
   *  ladder heading. */
  function restoreLadderFocus(token) {
    const btns = ladderBox.querySelectorAll ? [...ladderBox.querySelectorAll("button[data-token]")] : [];
    const byTok = (t) => btns.find((b) => b.getAttribute("data-token") === t);
    const follow = token[0] === "h" ? `d${token[1]}` : null;
    if (follow && focus(byTok(follow))) return;
    if (focus(byTok(token))) return;
    if (focus(nextBtn)) return;
    focus(ladderHead);
  }

  function renderLadder(r) {
    const where = ladder(r.world);
    const loses = r.world.failed ? FAILURES.find((f) => f.id === r.world.failed).loses : 0;
    const list = h("ol", { class: "dl-rungs", "aria-label": "The five rungs, top to bottom" });
    RUNGS.forEach((rung, i) => {
      const lost = rung.n <= loses;
      const chips = h("ul", { class: "dl-chips", "aria-label": `Blocks on rung ${rung.n}` });
      for (const bid of where[rung.n]) chips.append(chip(bid, rung.n, r.world));
      if (!where[rung.n].length) chips.append(h("li", { class: "dl-empty", text: "empty" }));
      const li = h("li", { class: `dl-rung dl-rung--${rung.id}${lost ? " dl-rung--lost" : ""}` },
        h("div", { class: "dl-rung__head" },
          h("span", { class: "dl-rung__n", text: String(rung.n) }),
          h("span", { class: "dl-rung__name", text: rung.name }),
          lost ? h("span", { class: "dl-rung__wiped", text: "wiped" }) : null),
        h("p", { class: "dl-rung__where", text: rung.where }),
        chips,
      );
      list.append(li);
      if (i < RUNGS.length - 1) {
        list.append(h("li", { class: "dl-arrow", "aria-hidden": "true", text: `↓ ${MOVED_BY[i]}` }));
        // Not a rung: role "none" keeps the list at five items for screen readers.
        if (i === 1) list.append(h("li", { class: "dl-boundary", role: "none", text: "Above this line: memory of the VMM process (guest RAM is part of it), so kill -9 loses rungs 1 and 2 together. Below: the macOS kernel and the drive." }));
      }
    });
    ladderBox.replaceChildren(list);
  }

  function renderHistory(r) {
    const table = h("table", { class: "dl-table" });
    table.append(
      h("caption", { text: "Every step so far: who acted, and what happened." }),
      h("thead", {}, h("tr", {}, ...["#", "who", "what", "details"].map((x) => h("th", { scope: "col", text: x })))),
    );
    const body = h("tbody");
    if (!r.rows.length) body.append(h("tr", {}, h("td", { colspan: "4", text: "Nothing yet. Press Next step, or pick a scenario." })));
    r.rows.forEach((row, i) => {
      body.append(h("tr", { class: `${i === r.rows.length - 1 ? "dl-row--last" : ""}${row.kind === "failure" ? " dl-row--failure" : ""}`.trim() || null },
        h("td", { text: String(i + 1) }),
        h("td", { text: row.who }),
        h("th", { scope: "row", text: row.title }),
        h("td", { text: row.text })));
    });
    table.append(body);
    historyWrap.replaceChildren(table);
  }

  function renderOutcome(r) {
    outcomeBox.replaceChildren();
    if (!r.outcome) return;
    const v = r.outcome.verdict;
    const good = v === "ok" || v === "old";
    outcomeBox.className = `dl-outcome ${good ? "dl-outcome--ok" : "dl-outcome--bad"}`;
    outcomeBox.append(
      h("h4", { class: "dl-outcome__head", text: "What the guest finds" }),
      h("p", { class: "dl-outcome__verdict" },
        h("span", { class: "dl-mark", "aria-hidden": "true", text: good ? "✓ " : "✗ " }),
        VERDICTS[v].label),
      h("p", { text: r.outcome.text }),
    );
    const surv = h("ul", { class: "dl-surv" });
    for (const line of survivalLines(r.world, r.outcome)) surv.append(h("li", { text: line.text }));
    outcomeBox.append(surv);
    if (predicted) {
      const right = predicted === predictionOf(v);
      outcomeBox.append(h("p", { class: "dl-predicted" },
        `You predicted: ${PREDICTIONS.find((p) => p.id === predicted).label}. `,
        right ? "That is what happened." : "Not this time: look at which rungs were wiped and where each block was."));
    }
  }

  function renderReal() {
    realBox.replaceChildren();
    const p = PRESETS.find((x) => x.hash === encode(state));
    if (!p || !p.real) return;
    realBox.append(
      h("p", { class: "dl-label", text: "On the real machine" }),
      h("p", { text: p.real.says }),
      h("p", { class: "dl-quote" }, h("code", { text: p.real.quote })),
      h("p", { class: "dl-src", text: `From the capture ${p.real.capture}.` }),
    );
  }

  function render() {
    const r = replay(state);
    flushInputs.f.checked = state.flush;
    flushInputs.w.checked = !state.flush;
    for (const s of SYNCS) syncInputs[s.id].checked = state.sync === s.id;
    const m = MEASURED[state.sync];
    syncLegend.textContent = state.flush ? "The VMM answers FLUSH with" : "The VMM syncs after each OUT with";
    measured.textContent = state.flush
      ? `Measured in chapter 18 with this choice: 100 flushed 4 KiB writes from the guest took ${m.hundred} s; one 64 MiB write with a single flush took ${m.bulk} s (busybox time, 10 ms resolution, ${m.capture}).`
      : "Chapter 18 measured its costs with FLUSH negotiated, one sync per FLUSH. Write-through pays one sync per OUT request instead, so a large write that needed a single FLUSH becomes many syncs; those numbers do not apply here.";
    presetSel.value = script ? script.preset.id : "";

    let nextTok = null;
    if (script) nextTok = script.target.actions[state.actions.length] || null;
    else if (r.next) nextTok = "n";
    if (nextTok === "n" && r.next) nextBtn.textContent = `Next step: ${r.next.title}`;
    else if (nextTok && nextTok[0] === "x") nextBtn.textContent = `Next step: ${FAILURES.find((f) => f.id === nextTok[1]).button}`;
    else if (nextTok && nextTok[0] === "h") nextBtn.textContent = `Next step: macOS writes back the ${blockById(nextTok[1]).name}`;
    else if (nextTok && nextTok[0] === "d") nextBtn.textContent = `Next step: drive writes the ${blockById(nextTok[1]).name} to flash`;
    else nextBtn.textContent = "Next step";
    nextBtn.disabled = !nextTok || !canDo(state, nextTok);
    undoBtn.disabled = !state.actions.length;
    resetBtn.disabled = !state.actions.length;

    scriptNote.hidden = !script;
    scriptNote.textContent = script
      ? `${script.preset.goal} Step ${Math.min(state.actions.length + 1, script.target.actions.length)} of ${script.target.actions.length}${state.actions.length >= script.target.actions.length ? ", done" : ""}.`
      : "";
    const last = r.rows[r.rows.length - 1];
    stepNote.textContent = last ? `${last.who[0].toUpperCase()}${last.who.slice(1)}: ${last.text}` : `The program is about to append 4 KiB to a file on the guest's ext4 disk and call fsync(). The VMM answers each FLUSH with ${SYNCS.find((s) => s.id === state.sync).call}.`;

    for (const f of FAILURES) failButtons[f.id].disabled = !canDo(state, `x${f.id}`);
    predictSel.value = predicted;
    predictSel.disabled = !!r.world.failed;

    renderLadder(r);
    readout.textContent = summary(state);
    renderOutcome(r);
    renderReal();
    renderHistory(r);
  }

  render();
  ctx.hash.set(encode(state));

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
