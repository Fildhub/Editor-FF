// ===================================================================== core
// Shared pieces for every tool: registry + routing, home screen, drop zones,
// thumbnails, results, ZIP writer, range parsing. Tools live in the other
// files of this folder and register themselves with tool({...}).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (s) => { const t = document.createElement("template"); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
const baseName = (n) => String(n).replace(/\.[^.]+$/, "");
const tick = () => new Promise((r) => setTimeout(r, 0));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const PLIB = () => window.PDFLib;

const ICONS = {
  translate: '<path d="M4 5h9M8.5 3v2M6 5c0 4 3 7 6.5 8M12 5c-.5 3-3 6.500-7 8.500"/><path d="m13 21 4-9 4 9M14.500 18h5"/>',
  merge: '<rect x="3" y="3" width="8" height="10" rx="1.500"/><rect x="13" y="11" width="8" height="10" rx="1.500"/><path d="M7 16v2a2 2 0 0 0 2 2h2M17 8V6a2 2 0 0 0-2-2h-2"/>',
  split: '<path d="M12 3v18M8 7 4 12l4 5M16 7l4 5-4 5"/>',
  remove: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  extract: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6m0 0-2.500 2.500M12 12l2.500 2.500"/>',
  organize: '<rect x="3" y="3" width="7" height="9" rx="1.500"/><rect x="14" y="3" width="7" height="9" rx="1.500"/><rect x="3" y="15" width="7" height="6" rx="1.500"/><path d="M14 18h7M17.500 15l3.500 3-3.500 3"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.300 6.300"/><path d="M20 4v7h-7"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.500" r="3.500"/>',
  toimg: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="10" cy="13" r="1.200"/><path d="m16 18-3-3-4 4"/>',
  number: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 17h6M12 14v3"/>',
  watermark: '<path d="M12 3s6 6.500 6 11a6 6 0 0 1-12 0c0-4.500 6-11 6-11z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.500 6.500 4 4"/>',
  sign: '<path d="M3 17c2 0 3-8 5-8 2.500 0 .5 8 3 8s2-5 4-5 1 5 3 5"/><path d="M3 21h18"/>',
  compare: '<rect x="3" y="4" width="8" height="16" rx="1.500"/><rect x="13" y="4" width="8" height="16" rx="1.500"/><path d="M6 9h2M6 13h2M16 9h2M16 13h2"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.500-2"/>',
  ocr: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  redact: '<rect x="3" y="9" width="18" height="6" rx="1"/><path d="M6 5h12M6 19h8"/>',
  repair: '<path d="M14.500 6.500a4 4 0 0 0-5.300 5.300L3 18l3 3 6.200-6.200a4 4 0 0 0 5.300-5.300l-2.500 2.500-2.500-.5-.5-2.500z"/>',
  word: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 8 1.500 8L12 10l3.500 6L17 8"/>',
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 5 5L20 7"/>',
  rl: '<path d="M4 11a8 8 0 1 1 2.300 6.300"/><path d="M4 4v7h7"/>', rr: '<path d="M20 11a8 8 0 1 0-2.300 6.300"/><path d="M20 4v7h-7"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  download: '<path d="M12 4v12m0 0-4-4m4 4 4-4M4 20h16"/>',
  upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>', redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>', rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>', ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  line: '<path d="M5 19 19 5"/>', pen: '<path d="M3 21c3 0 4-3 6-3 2 0 2 3 4 3M14 4l6 6L10 20H4v-6z"/>', highlight: '<path d="m9 11 6 6M5 21l4-1 10-10-3-3L6 17z" /><path d="M14 4l6 6"/>',
  cover: '<rect x="4" y="5" width="16" height="14" rx="1" fill="currentColor" fill-opacity=".25"/>', cursor: '<path d="m5 3 14 8-6 1.500L10 19z"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.500-4.500M11 8v6M8 11h6"/>', zoomout: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.500-4.500M8 11h6"/>',
};
const icon = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ""}</svg>`;

// ------------------------------------------------------------------ registry + router
const GROUPS = [
  { id: "translate", title: "แปลเอกสาร" },
  { id: "organize", title: "จัดการหน้า" },
  { id: "convert", title: "แปลงไฟล์" },
  { id: "edit", title: "แก้ไขและตกแต่ง" },
  { id: "check", title: "ตรวจสอบ" },
];
const TOOLS = [];
const tool = (def) => TOOLS.push(def);
const SOON = [
  { title: "ลดขนาดไฟล์", desc: "บีบอัด PDF ให้เล็กลง", icon: "compress", group: "organize" },
  { title: "ใส่รหัสผ่าน", desc: "ล็อก PDF ด้วยรหัสผ่าน", icon: "lock", group: "edit" },
  { title: "ปลดล็อก PDF", desc: "ถอดรหัสผ่านที่รู้อยู่แล้ว", icon: "unlock", group: "edit" },
  { title: "OCR", desc: "ให้ไฟล์สแกนค้นหาข้อความได้", icon: "ocr", group: "convert" },
  { title: "ลบข้อมูลถาวร", desc: "ปิดทับข้อมูลสำคัญจริง ๆ", icon: "redact", group: "check" },
  { title: "ซ่อมไฟล์เสีย", desc: "กู้ PDF ที่เปิดไม่ได้", icon: "repair", group: "organize" },
  { title: "PDF → Word / Excel", desc: "แปลงเป็นเอกสารแก้ไขได้", icon: "word", group: "convert" },
];
tool({ id: "translate", group: "translate", title: "แปล PDF", desc: "แปลทั้งไฟล์ด้วย Google Translate โดยตำแหน่ง ตาราง และรูปอยู่ที่เดิม", icon: "translate", native: "tool-translate" });

let current = null;           // the open generic tool instance
const ORDER = ["translate", "merge", "split", "remove", "extract", "organize", "rotate", "crop", "img2pdf", "scan", "pdf2img",
  "edit", "sign", "pagenum", "watermark", "compare"];
function renderHome() {
  const home = $("home");
  home.innerHTML = "";
  const rank = (t) => { const i = ORDER.indexOf(t.id); return i < 0 ? 99 : i; };
  const card = (t) => html(`<a class="tcard" href="#/${t.id}"><span class="ticon">${icon(t.icon, 24)}</span><span class="ttxt"><b>${esc(t.title)}</b><span>${esc(t.desc)}</span></span></a>`);
  for (const g of GROUPS) {
    const list = TOOLS.filter((t) => t.group === g.id).sort((x, y) => rank(x) - rank(y));
    if (!list.length) continue;
    const sec = html(`<div class="hgroup g-${g.id}"><h2>${g.title}</h2><div class="tcards"></div></div>`);
    list.forEach((t) => sec.querySelector(".tcards").append(card(t)));
    home.append(sec);
  }
  const soon = html(`<div class="hgroup soongroup"><h2>กำลังจะมา</h2><div class="tcards"></div></div>`);
  for (const t of SOON) soon.querySelector(".tcards").append(html(`<div class="tcard soon g-${t.group}" aria-disabled="true"><span class="ticon">${icon(t.icon, 22)}</span><span class="ttxt"><b>${esc(t.title)}</b><span>${esc(t.desc)}</span></span></div>`));
  home.append(soon);
}
function closeCurrent() {
  if (current) { for (const f of current.closers.splice(0)) { try { f(); } catch {} } current = null; }
  $("tool-generic").innerHTML = "";
}
function route() {
  const id = (location.hash.match(/^#\/([\w-]+)/) || [])[1] || "";
  const def = TOOLS.find((t) => t.id === id);
  closeCurrent();
  $("home").hidden = !!def; $("homebtn").hidden = !def;
  $("tool-translate").hidden = !(def && def.native);
  $("tool-generic").hidden = !(def && !def.native);
  $("h-title").textContent = def ? def.title : "PDF Tools";
  $("h-sub").textContent = def ? def.desc : "เครื่องมือ PDF ครบในไฟล์เดียว · ทำงานในเครื่องคุณ ไฟล์ไม่ถูกอัปโหลด";
  document.title = def ? `${def.title} · PDF Tools` : "PDF Tools";
  if (def && !def.native) openTool(def);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ generic tool shell
function openTool(def) {
  const root = $("tool-generic");
  root.innerHTML = `<div class="tgrid solo"><section class="card settings tside" hidden></section><main class="card stage tstage"></main></div>`;
  const grid = root.firstElementChild, side = grid.children[0], stage = grid.children[1];
  const ctx = {
    def, grid, side, stage, closers: [],
    onClose(f) { this.closers.push(f); },
    work() { grid.classList.remove("solo"); side.hidden = false; },       // show options + preview
    solo() { grid.classList.add("solo"); side.hidden = true; },            // only the big drop zone
    reset() { this.closers.splice(0).forEach((f) => { try { f(); } catch {} }); side.innerHTML = ""; stage.innerHTML = ""; this.solo(); def.init(this); },
    busy(text, frac) {
      let b = stage.querySelector(":scope > .busy");
      if (text == null) { b?.remove(); return; }
      if (!b) { b = html(`<div class="busy"><div class="spin"></div><div class="btxt"></div><div class="bar"><i></i></div></div>`); stage.append(b); }
      b.querySelector(".btxt").textContent = text;
      b.querySelector(".bar").hidden = frac == null;
      if (frac != null) b.querySelector(".bar i").style.width = Math.round(100 * clamp(frac, 0, 1)) + "%";
    },
    fail(e) {
      this.busy(null);
      console.error(e);
      let box = stage.querySelector(":scope > .errbox");
      if (!box) { box = html(`<div class="errbox"></div>`); stage.prepend(box); }
      const m = explain(e);
      box.innerHTML = `<div class="msg err"><b>${esc(m[0])}</b><div>${esc(m[1])}</div></div>`;
      box.scrollIntoView({ block: "nearest" });
    },
    clearFail() { stage.querySelector(":scope > .errbox")?.remove(); },
    async run(fn, label) {
      this.clearFail(); this.busy(label || "กำลังทำงาน…");
      try { return await fn(); } catch (e) { if (e?.code !== "cancelled") this.fail(e); } finally { this.busy(null); }
    },
  };
  current = ctx;
  if (!window.PDFLib || !window.pdfjsLib || !window.PDFX) {
    stage.innerHTML = `<div class="msg err"><b>โหลดส่วนประกอบของหน้าเว็บไม่สำเร็จ</b><div>ตรวจอินเทอร์เน็ต แล้วโหลดหน้านี้ใหม่</div></div>`;
    return;
  }
  def.init(ctx);
}
function explain(e) {
  if (e && e.title) return [e.title, e.body || ""];
  const m = String((e && e.message) || e || "");
  if (/encrypt/i.test(m)) return ["ไฟล์นี้ถูกล็อกด้วยรหัสผ่าน", "ปลดล็อกไฟล์ก่อน แล้วลองใหม่"];
  if (/parse|Invalid PDF|No PDF header|trailer|xref/i.test(m)) return ["อ่านไฟล์ PDF นี้ไม่ได้", "ไฟล์อาจเสียหรือไม่ใช่ PDF จริง"];
  return ["ทำรายการไม่สำเร็จ", m || "เกิดข้อผิดพลาดที่ไม่รู้สาเหตุ"];
}

// ------------------------------------------------------------------ files
const readBytes = async (f) => new Uint8Array(await f.arrayBuffer());
const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name);
const KINDS = { pdf: [isPdf, "ไฟล์ PDF"], image: [isImage, "ไฟล์ภาพ"], any: [() => true, "ไฟล์"] };

// big drop zone; calls onFiles(files[]) with only the files of the right kind
function dropZone({ kind = "pdf", multiple = false, title, hint, onFiles, capture = false }) {
  const [ok, what] = KINDS[kind];
  const accept = kind === "pdf" ? "application/pdf,.pdf" : kind === "image" ? "image/*" : "";
  const z = html(`<label class="drop big"><input type="file" hidden ${multiple ? "multiple" : ""} accept="${accept}" ${capture ? 'capture="environment"' : ""}>
    ${icon("upload", 38)}<b>${esc(title || (multiple ? "กดเพื่อเลือกไฟล์ หรือลากมาวาง" : "กดเพื่อเลือกไฟล์ หรือลากมาวาง"))}</b>
    <span>${esc(hint || "ไฟล์อยู่ในเครื่องคุณ ไม่ถูกอัปโหลดที่ไหน")}</span><em class="dzerr"></em></label>`);
  const input = z.querySelector("input"), err = z.querySelector(".dzerr");
  const take = (list) => {
    const all = [...list], good = all.filter(ok);
    err.textContent = good.length < all.length ? `ข้ามไฟล์ที่ไม่ใช่${what} ${all.length - good.length} ไฟล์` : "";
    if (good.length) onFiles(multiple ? good : [good[0]]);
  };
  input.addEventListener("change", () => { take(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach((t) => z.addEventListener(t, (e) => { e.preventDefault(); z.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => z.addEventListener(t, (e) => { e.preventDefault(); z.classList.remove("drag"); }));
  z.addEventListener("drop", (e) => take(e.dataTransfer.files));
  z.pick = () => input.click();
  return z;
}
function fileChip(name, sub, onChange) {
  const c = html(`<div class="chip"><div class="pdf">PDF</div><div class="meta"><div class="name"></div><div class="sub"></div></div>${onChange ? '<button class="linkbtn" type="button">เปลี่ยน</button>' : ""}</div>`);
  c.querySelector(".name").textContent = name; c.querySelector(".sub").textContent = sub;
  if (onChange) c.querySelector("button").onclick = onChange;
  return c;
}

// ------------------------------------------------------------------ saving
function saveBytes(bytes, name, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
// ZIP without compression (PDF and JPG are compressed already)
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  const d = new Date(), dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.bytes), size = f.bytes.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosT, true); lh.setUint16(12, dosD, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.bytes);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosT, true); ch.setUint16(14, dosD, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + size;
  }
  const csize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]).arrayBuffer().then((b) => new Uint8Array(b));
}

// result screen: files = [{name, bytes, mime}]
async function showResult(ctx, { title = "เสร็จแล้ว", files, note, onAgain, previewPdf = true, zipName }) {
  const stage = ctx.stage;
  ctx.work();
  ctx.side.hidden = true; ctx.grid.classList.add("solo");
  stage.innerHTML = "";
  const box = html(`<div class="done"><div class="donehead"><span class="pill">${icon("check", 14)} ${esc(title)}</span></div><div class="dlist"></div><div class="dnote"></div><div class="dactions"></div><div class="dprev"></div></div>`);
  const list = box.querySelector(".dlist");
  const rows = files.length > 12 ? [] : files;
  for (const f of rows) {
    const r = html(`<div class="drow"><span class="dname"></span><span class="dsize"></span><button class="dl" type="button">${icon("download", 16)} ดาวน์โหลด</button></div>`);
    r.querySelector(".dname").textContent = f.name; r.querySelector(".dsize").textContent = fmtSize(f.bytes.length);
    r.querySelector("button").onclick = () => saveBytes(f.bytes, f.name, f.mime);
    list.append(r);
  }
  if (files.length > 1) {
    const z = html(`<button class="dl zip" type="button">${icon("download", 16)} ดาวน์โหลดทั้งหมด (ZIP · ${files.length} ไฟล์)</button>`);
    z.onclick = async () => saveBytes(await zipStore(files), zipName || "files.zip", "application/zip");
    box.querySelector(".dactions").append(z);
  }
  if (note) box.querySelector(".dnote").textContent = note;
  const again = html(`<button class="ghost" type="button">ทำไฟล์ใหม่</button>`);
  again.onclick = () => (onAgain ? onAgain() : ctx.reset());
  box.querySelector(".dactions").append(again);
  stage.append(box);
  if (files[0] && /^image\//.test(files[0].mime || "")) {
    const strip = html(`<div class="istrip"></div>`);
    for (const f of files.slice(0, 12)) {
      const url = URL.createObjectURL(new Blob([f.bytes], { type: f.mime }));
      ctx.onClose(() => URL.revokeObjectURL(url));
      const im = new Image(); im.src = url; im.alt = f.name; strip.append(im);
    }
    box.querySelector(".dprev").append(strip);
  }
  if (previewPdf && files[0] && /pdf$/.test(files[0].mime || "")) {
    try {
      const pdf = await PDFX.openPdf(files[0].bytes), pv = box.querySelector(".dprev");
      pv.innerHTML = `<div class="muted">ตัวอย่างหน้าแรก · ทั้งหมด ${pdf.numPages} หน้า</div><canvas></canvas>`;
      await renderPageTo(await pdf.getPage(1), pv.querySelector("canvas"), 720);
    } catch {}
  }
}

// ------------------------------------------------------------------ PDF helpers
async function renderPageTo(page, canvas, cssWidth, rotate, maxH) {
  const base = page.getViewport({ scale: 1, rotation: ((page.rotate + (rotate || 0)) % 360 + 360) % 360 });
  if (maxH) cssWidth = Math.min(cssWidth, Math.floor(maxH * base.width / base.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: (cssWidth * dpr) / base.width, rotation: base.rotation });
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  canvas.style.width = cssWidth + "px"; canvas.style.height = Math.round(cssWidth * vp.height / vp.width) + "px";
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  return vp;
}
// thumbnails rendered one at a time, only when they scroll into view
const thumbJobs = new Map();
let thumbBusy = false;
const thumbObs = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { const j = thumbJobs.get(en.target); if (j) { j.want = true; } }
  pumpThumbs();
}, { rootMargin: "300px" });
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    for (;;) {
      const next = [...thumbJobs.entries()].find(([c, j]) => j.want && !j.done);
      if (!next) break;
      const [canvas, j] = next;
      j.done = true; thumbObs.unobserve(canvas);
      if (canvas.isConnected) { try { await renderPageTo(await j.pdf.getPage(j.n), canvas, j.w, j.rot, j.maxH); } catch {} }
      thumbJobs.delete(canvas);
    }
  } finally { thumbBusy = false; }
}
function lazyThumb(canvas, pdf, n, width, rot = 0, maxH = 0) {
  canvas.width = 1; canvas.height = 1;
  thumbJobs.set(canvas, { pdf, n, w: width, rot, maxH, want: false, done: false });
  thumbObs.observe(canvas);
}
// re-render one thumbnail with a different rotation
function redrawThumb(canvas, pdf, n, width, rot, maxH) { thumbJobs.delete(canvas); lazyThumb(canvas, pdf, n, width, rot, maxH); }

// "1-3, 5, 8-" -> [{a,b}, ...]; throws {title, body} on mistakes
function parseRanges(spec, n) {
  const out = [];
  for (const part of String(spec).split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)-(\d*)$/);
    let a, b;
    if (m && (m[1] || m[2])) { a = +(m[1] || 1); b = +(m[2] || n); }
    else if (/^\d+$/.test(part)) { a = b = +part; }
    else throw { title: "รูปแบบช่วงหน้าไม่ถูกต้อง", body: `"${part}" — ใช้แบบ 1-3, 5, 8-10` };
    if (a < 1 || b < 1 || a > n || b > n) throw { title: "ช่วงหน้าเกินจำนวนหน้าของไฟล์", body: `"${part}" — ไฟล์นี้มี ${n} หน้า` };
    if (a > b) throw { title: "ช่วงหน้าไม่ถูกต้อง", body: `"${part}" — เลขแรกต้องไม่มากกว่าเลขหลัง` };
    out.push({ a, b });
  }
  return out;
}
const rangePages = (rs) => rs.flatMap(({ a, b }) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

async function openPdfLib(bytes) {
  return PLIB().PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}
// copy the listed pages [{n (1-based), rot}] of src into a fresh document
async function buildPdf(src, list) {
  const { PDFDocument, degrees } = PLIB();
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, list.map((p) => p.n - 1));
  pages.forEach((pg, i) => {
    const r = list[i].rot || 0;
    if (r) pg.setRotation(degrees((((pg.getRotation().angle + r) % 360) + 360) % 360));
    out.addPage(pg);
  });
  return out;
}
const savePdf = async (doc) => new Uint8Array(await doc.save({ useObjectStreams: true }));

// a small labelled number/select/range row used by option panels
function field(label, inner, hint) {
  const f = html(`<div class="fld"><div class="lbl"></div></div>`);
  f.querySelector(".lbl").textContent = label;
  if (typeof inner === "string") f.append(html(`<div>${inner}</div>`)); else f.append(inner);
  if (hint) { const h = html(`<div class="hint"></div>`); h.textContent = hint; f.append(h); }
  return f;
}
const primaryBtn = (label, ic = "check") => html(`<button class="primary" type="button">${icon(ic, 18)} ${esc(label)}</button>`);

// pretty-printing of a drag-sortable list of elements
function sortable(container, onMove) {
  let from = -1;
  container.addEventListener("dragstart", (e) => {
    const it = e.target.closest?.("[data-i]"); if (!it || !container.contains(it)) return;
    from = +it.dataset.i; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", String(from)); } catch {}
    it.classList.add("dragging");
  });
  container.addEventListener("dragend", () => { from = -1; container.querySelectorAll(".dragging,.dropat").forEach((x) => x.classList.remove("dragging", "dropat")); });
  container.addEventListener("dragover", (e) => {
    if (from < 0) return;
    const it = e.target.closest?.("[data-i]"); if (!it) return;
    e.preventDefault(); container.querySelectorAll(".dropat").forEach((x) => x.classList.remove("dropat")); it.classList.add("dropat");
  });
  container.addEventListener("drop", (e) => {
    const it = e.target.closest?.("[data-i]"); if (!it || from < 0) return;
    e.preventDefault(); const to = +it.dataset.i; const f = from; from = -1;
    if (f !== to) onMove(f, to);
  });
}

// ------------------------------------------------------------------ boot
function boot() { renderHome(); route(); }
