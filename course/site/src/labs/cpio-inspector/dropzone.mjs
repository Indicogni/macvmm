// dropzone.mjs: the "drop a file here" control. CURRICULUM has cpio-inspector share its drop zone
// with image-inspector and elf-inspector, so this file has no cpio knowledge: it reads one local
// file into a Uint8Array and hands it over. It can move to src/labs/_shared/ when the sibling labs
// exist. The file is read with File.arrayBuffer() in this browser tab; it is never uploaded,
// stored or sent anywhere, and anything larger than `maxBytes` is refused before it is read.

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

/**
 * createDropZone({ id, maxBytes, onFile, onError, label, hint })
 *   onFile({ name, size, bytes }) is called with the file's bytes.
 *   onError(message) is called for a refused or unreadable file.
 *   hint, if given, is one more line of help under the note.
 * Returns { node }.
 */
export function createDropZone({ id, maxBytes, onFile, onError, label = "Drop a file here, or choose one", hint = null }) {
  const input = el("input", { type: "file", id: `${id}-file`, class: "dz-input" });
  const choose = el("label", { for: `${id}-file`, class: "dz-choose", text: "Choose a file..." });
  const zone = el("div", { class: "dz-zone" },
    el("p", { class: "dz-title", text: label }),
    input, choose, // input first, so ".dz-input:focus-visible + .dz-choose" can show its focus
    el("p", { class: "dz-note", text: `Read inside this page and never uploaded. Up to ${Math.round(maxBytes / 1048576)} MiB.` }),
    hint ? el("p", { class: "dz-note", text: hint }) : null,
  );

  async function take(file) {
    if (!file) return;
    if (file.size > maxBytes) { onError(`That file is ${file.size.toLocaleString("en-US")} bytes; the lab reads at most ${maxBytes.toLocaleString("en-US")}.`); return; }
    try {
      const buf = await file.arrayBuffer();
      onFile({ name: String(file.name || "file").slice(0, 120), size: buf.byteLength, bytes: new Uint8Array(buf) });
    } catch (e) {
      onError(`The browser could not read that file${e && e.message ? `: ${e.message}` : ""}.`);
    }
  }

  input.addEventListener("change", () => { take(input.files && input.files[0]); input.value = ""; });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dz-zone--over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dz-zone--over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dz-zone--over");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    take(f);
  });
  return { node: zone, input };
}
