// boot-chain: the view. Renders the model's snapshot; turns clicks into model actions.
// DOM is built with createElement/textContent only (no innerHTML), and nothing outside `el`
// is touched except ctx.hash and ctx.announce. See course/site/LABS.md.
import {
  OWNERS, CHAINS, MAPKEY, CHAIN_TABLE_HEAD, CHAIN_TABLE, CHAIN_TABLE_EXTRA,
  initialState, step, snapshot, summary, ownerChoices, isEfi, encodeHash, decodeHash,
} from "./model.mjs";

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid) n.append(kid);
  return n;
}

// "a `b` c" -> text, <code>b</code>, text. Only our own constant strings come through here.
function withCode(text) {
  const span = h("span");
  text.split("`").forEach((part, i) => {
    if (!part) return;
    span.append(i % 2 ? h("code", { text: part }) : document.createTextNode(part));
  });
  return span;
}

const ACTOR_SHORT = { vmm: "macvmm", uboot: "U-Boot", uefi: "U-Boot (UEFI)", stub: "EFI stub", loader: "loader.efi", kernel: "kernel" };
const EVIDENCE_LEAD = { observed: "Seen on our machine: ", described: "Not run on macvmm; described in ", "what-if": "What-if: " };
const TABLE_ROWS_FOR = { "efi-bsd": ["uboot", "efi-bsd"], "efi-linux": ["uboot", "efi-linux"], booti: ["uboot", "booti"] };

export function mount(el, ctx) {
  const id = ctx.id || "lab-boot-chain";
  let state;
  try {
    const shared = ctx.hash && ctx.hash.get();
    state = shared ? decodeHash(shared) : initialState();
  } catch {
    state = initialState();
  }

  const root = h("div", { class: "bc" + (ctx.reducedMotion ? " bc--still" : "") });
  // Embedded, the lab's title is an h3, so its sections are h4; on the standalone page the
  // title is the page's h1, so they are h2.
  const H = ctx.standalone ? "h2" : "h4";

  // --- controls ---------------------------------------------------------------------------
  const chainSel = h("select", { id: `${id}-chain` },
    ...CHAINS.map((c) => h("option", { value: c.id, text: c.label + (c.observed ? " (seen on macvmm)" : " (not run on macvmm)") })));
  const chainBox = h("div", { class: "bc__group" }, h("label", { for: chainSel.id, text: "Firmware boot chain" }), chainSel);

  const fixupBox = h("input", { type: "checkbox", id: `${id}-fixup` });
  const fixupLabel = h("label", { class: "bc__choice", for: fixupBox.id }, fixupBox,
    document.createTextNode(" what-if: U-Boot edits its own copy of the DTB"));

  const keySel = h("select", { id: `${id}-key` },
    ...Object.entries(MAPKEY).map(([k, v]) => h("option", { value: k, text: v })));
  const keyBox = h("div", { class: "bc__group" }, h("label", { for: keySel.id, text: "ExitBootServices is called with" }), keySel);

  const skipBox = h("input", { type: "checkbox", id: `${id}-skip` });
  const skipLabel = h("label", { class: "bc__choice", for: skipBox.id }, skipBox,
    document.createTextNode(" skip the questions"));

  const backBtn = h("button", { type: "button", class: "bc__btn", text: "Back" });
  const nextBtn = h("button", { type: "button", class: "bc__btn bc__btn--primary", text: "Next step" });
  const resetBtn = h("button", { type: "button", class: "bc__btn", text: "Reset" });
  const shareBtn = h("button", { type: "button", class: "bc__btn", text: "Copy link to this state" });
  const buttons = h("div", { class: "bc__buttons" }, backBtn, nextBtn, resetBtn, shareBtn);

  const controls = h("div", { class: "bc__controls" }, chainBox, fixupLabel, keyBox, skipLabel, buttons);

  // --- lanes ----------------------------------------------------------------------------
  const directLane = h("ol", { class: "bc__lane", "aria-label": "Direct boot, step by step" });
  const fwLane = h("ol", { class: "bc__lane", "aria-label": "Firmware boot, step by step" });
  const lanes = h("div", { class: "bc__lanes" },
    h("div", { class: "bc__lanecol" }, h(H, { class: "bc__h", text: "Direct boot" }), directLane),
    h("div", { class: "bc__lanecol" }, h(H, { class: "bc__h", text: "Firmware boot" }),
      h("p", { class: "bc__hint", text: "Each step is a button. Jumping to a step shows its answer; use Next step to be asked first." }), fwLane));

  // --- question -------------------------------------------------------------------------
  const stepTitle = h("p", { class: "bc__steptitle" });
  const qText = h("p", { class: "bc__q", text: "Who owns the DTB now? (The owner is the program that decides what it says, and may edit it.)" });
  const answers = h("div", { class: "bc__answers", role: "group", "aria-label": "Who owns the DTB now?" });
  const revealBtn = h("button", { type: "button", class: "bc__btn", text: "Show without guessing" });
  const feedback = h("p", { class: "bc__feedback" });
  const why = h("p", { class: "bc__why" });
  const question = h("div", { class: "bc__question" }, stepTitle, qText, answers, revealBtn, feedback, why);

  // --- details --------------------------------------------------------------------------
  const cmpBody = h("tbody");
  const cmpTable = h("table", { class: "bc__table" },
    h("caption", { text: "This moment, side by side" }),
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: "" }),
      h("th", { scope: "col", text: "Direct boot" }),
      h("th", { scope: "col", text: "Firmware boot" }))),
    cmpBody);
  const note = h("p", { class: "bc__note" });
  const evidence = h("p", { class: "bc__evidence" });
  const dtbList = h("ul", { class: "bc__dtbs" });
  const regionList = h("ul", { class: "bc__regions" });
  // A sideways-scrolling table must be reachable by keyboard: focusable, named, outlined.
  const scroller = (label, table) => h("div", { class: "bc__scroll", tabindex: "0", role: "region", "aria-label": label }, table);
  const details = h("div", { class: "bc__details" },
    scroller("This moment, side by side (scrolls sideways)", cmpTable), note, evidence,
    h(H, { class: "bc__h", text: "DTB copies so far" }), dtbList,
    h(H, { class: "bc__h", text: "Memory regions so far (firmware boot)" }), regionList);

  const chainTbody = h("tbody");
  const chainTable = h("table", { class: "bc__table bc__table--chains" },
    h("caption", { text: "Who loads what, and which DTB each stage sees" }),
    h("thead", {}, h("tr", {}, ...CHAIN_TABLE_HEAD.map((t) => h("th", { scope: "col", text: t })), h("th", { scope: "col", text: "" }))),
    chainTbody);

  // The question comes first, right after the buttons, so Next step changes what is in view.
  const viz = h("div", { class: "bc__viz" }, question, lanes, details, scroller("Boot chains table (scrolls sideways)", chainTable));

  // --- readout --------------------------------------------------------------------------
  const live = h("p", { class: "bc__summary", "aria-live": "polite", "aria-atomic": "true" });
  const readout = h("div", { class: "bc__readout" }, h(H, { class: "bc__h", text: "Readout" }), live);

  root.append(controls, viz, readout);
  el.replaceChildren(root);

  // --- render ---------------------------------------------------------------------------
  function cmpRow(label, direct, fw) {
    return h("tr", {}, h("th", { scope: "row", text: label }),
      h("td", { class: "bc__cell", text: direct }), h("td", { class: "bc__cell", text: fw }));
  }

  let builtLane = null, laneItems = [];
  let builtAnswers = null, answerBtns = [];

  function render() {
    const sn = snapshot(state);
    const st = sn.step;
    chainSel.value = state.chain;
    fixupBox.checked = state.fixup;
    keySel.value = state.mapkey;
    keyBox.hidden = !isEfi(state.chain);
    skipBox.checked = state.skipQuiz;
    backBtn.disabled = sn.index === 0;
    nextBtn.disabled = sn.index === sn.count - 1;

    directLane.replaceChildren(...["macvmm loads the kernel and the DTB", "Linux runs"].map((t, i) => {
      const here = i === sn.directIndex;
      const li = h("li", { class: "bc__item" + (here ? " bc__item--here" : "") },
        h("span", { text: t }), here ? h("span", { class: "bc__badge", text: "same moment" }) : null);
      if (here) li.setAttribute("aria-current", "step");
      return li;
    }));
    if (sn.directIndex < 0) {
      directLane.append(h("li", { class: "bc__item bc__item--none", text: "No matching step: in direct boot macvmm has already started the kernel." }));
    }

    // Lane and answer buttons are rebuilt only when the list itself changes (another chain or
    // map-key choice), so the button a keyboard user just pressed keeps its focus.
    const laneKey = sn.titles.join("\n");
    if (laneKey !== builtLane) {
      builtLane = laneKey;
      laneItems = sn.titles.map((t, i) => {
        const badge = h("span", { class: "bc__badge", text: "now" });
        const btn = h("button", { type: "button", class: "bc__jump" },
          h("span", { class: "bc__actor", text: `${i + 1}. ${ACTOR_SHORT[sn.actors[i]]}` }),
          h("span", { class: "bc__jumptext", text: t }), badge);
        btn.addEventListener("click", () => update({ type: "goto", step: i }));
        return { li: h("li", { class: "bc__item" }, btn), btn, badge };
      });
      fwLane.replaceChildren(...laneItems.map((x) => x.li));
    }
    laneItems.forEach((x, i) => {
      const here = i === sn.index;
      x.li.className = "bc__item" + (here ? " bc__item--here" : "");
      x.badge.hidden = !here;
      if (here) x.btn.setAttribute("aria-current", "step");
      else x.btn.removeAttribute("aria-current");
    });

    stepTitle.textContent = `Step ${sn.index + 1} of ${sn.count}: ${st.title}`;
    const choices = ownerChoices(state.chain, state.mapkey);
    if (choices.join() !== builtAnswers) {
      builtAnswers = choices.join();
      answerBtns = choices.map((o) => {
        const b = h("button", { type: "button", class: "bc__btn bc__answer", text: OWNERS[o] });
        b.addEventListener("click", () => update({ type: "guess", owner: o }));
        return { o, b };
      });
      answers.replaceChildren(...answerBtns.map((x) => x.b));
    }
    for (const { o, b } of answerBtns) {
      const picked = state.guess === o;
      b.className = "bc__btn bc__answer" + (picked ? " bc__answer--picked" : "");
      b.setAttribute("aria-pressed", picked ? "true" : "false");
    }
    revealBtn.hidden = state.revealed;
    if (!state.revealed) feedback.textContent = "";
    else if (sn.correct === true) feedback.textContent = `Right: ${OWNERS[st.owner]}.`;
    else if (sn.correct === false) feedback.textContent = `Not quite: the owner is ${OWNERS[st.owner]}.`;
    else feedback.textContent = `The owner is ${OWNERS[st.owner]}.`;
    why.textContent = state.revealed ? `Why: ${st.ownerWhy}` : "";
    why.hidden = !state.revealed;

    details.hidden = !state.revealed;
    const d = sn.direct;
    const none = "(no such step)";
    cmpBody.replaceChildren(
      cmpRow("Running now", d ? ACTOR_SHORT[d.actor] : none, ACTOR_SHORT[st.actor]),
      cmpRow("Loaded by", d ? d.loadedBy : none, st.loadedBy),
      cmpRow("Where", d ? d.where : none, st.where),
      cmpRow("pc", d ? d.pc : none, st.pc),
      cmpRow("x0", d ? d.x0 : none, st.x0),
      cmpRow("x1", d ? d.x1 : none, st.x1),
      cmpRow("UEFI boot services", d ? "none: no firmware runs" : none, sn.bootServices),
      cmpRow("DTB owner", d ? OWNERS[d.owner] : none, OWNERS[st.owner]),
      cmpRow("DTB the code reads", d ? "our DTB at 0x40000000" : none, sn.reads),
    );
    note.replaceChildren(...(st.note ? [withCode(st.note)] : []));
    note.hidden = !st.note;
    evidence.textContent = EVIDENCE_LEAD[st.evidence.kind] + st.evidence.text + ".";

    dtbList.replaceChildren(...sn.dtbs.map((x) => {
      const inUse = x.key === st.reads;
      const edits = h("ul", { class: "bc__edits" }, ...x.edits.map((e) => h("li", { class: e.whatIf ? "bc__edit bc__edit--whatif" : "bc__edit" },
        document.createTextNode(e.text),
        e.inherited ? h("span", { class: "bc__tag", text: "inherited" }) : h("span", { class: "bc__tag", text: `by ${ACTOR_SHORT[e.by]}` }),
        e.src && !e.inherited ? h("span", { class: "bc__src", text: `From the source code: ${e.src}.` }) : null)));
      if (!x.edits.length) edits.append(h("li", { class: "bc__edit", text: "no edits" }));
      return h("li", { class: "bc__dtb" + (inUse ? " bc__dtb--inuse" : "") },
        h("span", { class: "bc__dtbname", text: `${x.label}, at ${x.addr}` }),
        inUse ? h("span", { class: "bc__badge", text: "in use now" }) : null,
        h("span", { class: "bc__detail", text: (x.from ? `copied by ${ACTOR_SHORT[x.by]} from ${sn.dtbs.find((p) => p.key === x.from).label}` : `written by ${ACTOR_SHORT[x.by]}`) + (x.src ? ` (from the source code: ${x.src})` : "") }),
        edits);
    }));
    regionList.replaceChildren(...sn.regions.map((r) => h("li", {}, h("code", { text: r.range }), document.createTextNode(` ${r.what}`))));

    const mine = TABLE_ROWS_FOR[state.chain];
    chainTbody.replaceChildren(...[...CHAIN_TABLE, ...CHAIN_TABLE_EXTRA].map((row) => {
      const tag = row.key === "direct" ? "left lane" : mine.includes(row.key) ? "this chain" : "";
      return h("tr", { class: tag ? "bc__row--mine" : "" },
        ...row.cells.map((c, i) => (i === 0 ? h("th", { scope: "row" }, withCode(c)) : h("td", {}, withCode(c)))),
        h("td", {}, tag ? h("span", { class: "bc__badge", text: tag }) : null));
    }));

    live.textContent = summary(state);
  }

  function update(action) {
    state = step(state, action);
    render();
    try { ctx.hash && ctx.hash.set(encodeHash(state)); } catch { /* sharing is optional */ }
  }

  // --- events (all inside el) -----------------------------------------------------------
  chainSel.addEventListener("change", () => update({ type: "setChain", chain: chainSel.value }));
  fixupBox.addEventListener("change", () => update({ type: "setFixup", on: fixupBox.checked }));
  keySel.addEventListener("change", () => update({ type: "setMapKey", mapkey: keySel.value }));
  skipBox.addEventListener("change", () => update({ type: "setSkipQuiz", on: skipBox.checked }));
  revealBtn.addEventListener("click", () => { update({ type: "reveal" }); nextBtn.focus(); });
  backBtn.addEventListener("click", () => {
    update({ type: "back" });
    if (backBtn.disabled) nextBtn.focus(); // a disabled button would drop focus to the page
  });
  nextBtn.addEventListener("click", () => {
    update({ type: "next" });
    if (nextBtn.disabled) resetBtn.focus();
  });
  resetBtn.addEventListener("click", () => { update({ type: "reset" }); nextBtn.focus(); });
  shareBtn.addEventListener("click", async () => {
    try { ctx.hash && ctx.hash.set(encodeHash(state)); } catch { /* ignore */ }
    let copied = false;
    try {
      if (navigator.clipboard && typeof location !== "undefined") {
        await navigator.clipboard.writeText(location.href);
        copied = true;
      }
    } catch { /* clipboard may be refused; the address bar still holds the link */ }
    const msg = copied ? "Link copied." : "The link to this state is in the address bar.";
    if (ctx.announce) ctx.announce(msg);
    else live.textContent = msg;
  });

  render();
  return { destroy() { el.replaceChildren(); } };
}
