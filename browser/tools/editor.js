// ===================================================================== editor + signature
// Objects are kept per page in "displayed page space" (points, origin top-left),
// drawn as HTML/SVG on top of the page picture, and written into the PDF on save.

const ED_TOOLS = [
  ["select", "cursor", "เลือก / ย้าย"], ["text", "text", "ข้อความ"], ["rect", "rect", "สี่เหลี่ยม"], ["ellipse", "ellipse", "วงรี"],
  ["line", "line", "เส้น / ลูกศร"], ["draw", "pen", "ปากกา"], ["hl", "highlight", "ไฮไลต์"], ["cover", "cover", "ปิดทับ"],
];
const SIG_KEY = "pdftools.signatures";
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY) || "[]"); } catch { return []; } };
const storeSigs = (a) => { try { localStorage.setItem(SIG_KEY, JSON.stringify(a.slice(0, 6))); } catch {} };

function editorTool(id, { title, desc, ic, sign }) {
  tool({
    id, group: "edit", title, desc, icon: ic,
    init(ctx) {
      singleFile(ctx, (doc) => runEditor(ctx, doc, { sign }));
    },
  });
}
editorTool("edit", { title: "แก้ไข PDF", desc: "เพิ่มข้อความ รูป รูปทรง ไฮไลต์ วาดด้วยปากกา หรือปิดทับของเดิม", ic: "edit" });
editorTool("sign", { title: "ลงลายเซ็น", desc: "เซ็นด้วยเมาส์/นิ้ว พิมพ์ชื่อ หรืออัปโหลดลายเซ็น แล้ววางลงบนเอกสาร", ic: "sign", sign: true });

function runEditor(ctx, doc, { sign }) {
  const pages = new Map();                       // page number -> [objects]
  const imgs = new Map();                        // image id -> {bytes, mime, w, h, url}
  const D = {                                    // defaults for new objects
    text: { size: 16, color: "#111827", bold: false },
    rect: { stroke: "#e11d48", sw: 2, fill: null, op: 1 }, ellipse: { stroke: "#e11d48", sw: 2, fill: null, op: 1 },
    line: { stroke: "#e11d48", sw: 3, arrow: false }, draw: { stroke: "#1d4ed8", sw: 3 },
    hl: { fill: "#ffe14d", op: 0.4 }, cover: { fill: "#ffffff" }, img: { op: 1 },
  };
  let userZoom = false, cur = 1, z = 1, tool_ = "select", sel = null, uid = 0, pageW = 0, pageH = 0, editing = null;
  let undo = [], redo = [], snap = "[]";
  const objs = () => { if (!pages.has(cur)) pages.set(cur, []); return pages.get(cur); };

  // ---------- layout
  const bar = html(`<div class="edbar"></div>`);
  const toolBtns = {};
  for (const [k, ic, t] of ED_TOOLS) {
    const b = html(`<button class="ibtn" type="button" title="${t}" aria-label="${t}">${icon(ic, 17)}</button>`);
    b.onclick = () => setTool(k); toolBtns[k] = b; bar.append(b);
  }
  const imgBtn = html(`<button class="ibtn" type="button" title="รูปภาพ" aria-label="รูปภาพ">${icon("image", 17)}</button>`);
  const sigBtn = html(`<button class="ibtn" type="button" title="ลายเซ็น" aria-label="ลายเซ็น">${icon("sign", 17)}</button>`);
  const undoBtn = html(`<button class="ibtn" type="button" title="ย้อนกลับ (Ctrl+Z)" aria-label="ย้อนกลับ">${icon("undo", 17)}</button>`);
  const redoBtn = html(`<button class="ibtn" type="button" title="ทำซ้ำ (Ctrl+Y)" aria-label="ทำซ้ำ">${icon("redo", 17)}</button>`);
  const zin = html(`<button class="ibtn" type="button" title="ขยาย" aria-label="ขยาย">${icon("zoomin", 17)}</button>`);
  const zout = html(`<button class="ibtn" type="button" title="ย่อ" aria-label="ย่อ">${icon("zoomout", 17)}</button>`);
  const prev = html(`<button class="ibtn" type="button" aria-label="หน้าก่อน">${icon("left", 17)}</button>`);
  const next = html(`<button class="ibtn" type="button" aria-label="หน้าถัดไป">${icon("right", 17)}</button>`);
  const plabel = html(`<span class="muted" style="min-width:76px;text-align:center"></span>`);
  bar.append(imgBtn, sigBtn, html(`<span class="sep"></span>`), undoBtn, redoBtn, html(`<span class="sep"></span>`), zout, zin, html(`<span class="spacer"></span>`), prev, plabel, next);
  const scroller = html(`<div class="edscroll"><div class="edpage"><canvas></canvas><div class="edov"></div></div></div>`);
  ctx.stage.append(bar, scroller);
  const pageEl = scroller.querySelector(".edpage"), cv = pageEl.querySelector("canvas"), ov = pageEl.querySelector(".edov");
  const imgFile = html(`<input type="file" accept="image/*" hidden>`);
  ctx.stage.append(imgFile);
  ctx.stage.style.padding = "14px";

  const props = html(`<div class="props"></div>`);
  const actions = html(`<div class="row" style="flex-wrap:wrap"></div>`);
  const save = primaryBtn("บันทึกไฟล์", "check");
  ctx.side.append(props, actions, save);

  // ---------- history
  const serialize = () => JSON.stringify([...pages.entries()]);
  function commit() { undo.push(snap); if (undo.length > 80) undo.shift(); snap = serialize(); redo = []; syncBtns(); }
  function restore(s) { pages.clear(); for (const [k, v] of JSON.parse(s)) pages.set(k, v); snap = s; sel = null; renderAll(); renderProps(); syncBtns(); }
  undoBtn.onclick = () => { if (!undo.length) return; redo.push(snap); restore(undo.pop()); };
  redoBtn.onclick = () => { if (!redo.length) return; undo.push(snap); restore(redo.pop()); };
  function syncBtns() { undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length; prev.disabled = cur <= 1; next.disabled = cur >= doc.n; plabel.textContent = `หน้า ${cur} / ${doc.n}`; }

  // ---------- page
  async function showPage(n, fit) {
    cur = clamp(n, 1, doc.n); sel = null; editing = null;
    const page = await doc.view.getPage(cur), vp = page.getViewport({ scale: 1 });
    pageW = vp.width; pageH = vp.height;
    if (fit || !userZoom) z = Math.min(1.5, Math.max(0.4, (scroller.clientWidth - 24) / pageW));
    await renderPageTo(page, cv, Math.round(pageW * z));
    pageEl.style.width = cv.style.width; pageEl.style.height = cv.style.height;
    renderAll(); renderProps(); syncBtns();
  }
  prev.onclick = () => showPage(cur - 1); next.onclick = () => showPage(cur + 1);
  const rezoom = (f) => { userZoom = true; z = clamp(z * f, 0.3, 3.5); showPage(cur); };
  zin.onclick = () => rezoom(1.2); zout.onclick = () => rezoom(1 / 1.2);

  function setTool(k) {
    tool_ = k; editing = null;
    for (const [n, b] of Object.entries(toolBtns)) b.classList.toggle("on", n === k);
    ov.dataset.tool = k;
    if (k !== "select") sel = null;
    renderAll(); renderProps();
  }

  // ---------- object elements
  const SVGNS = "http://www.w3.org/2000/svg";
  function paintObj(o, el) {
    const s = (p) => p * z;
    el.className = "eo e-" + o.t + (sel === o ? " esel" : "");
    el.style.cssText = "";
    el.innerHTML = "";
    if (o.t === "text") {
      Object.assign(el.style, { left: s(o.x) + "px", top: s(o.y) + "px", fontSize: s(o.size) + "px", color: o.color, fontWeight: o.bold ? "700" : "400" });
      el.textContent = o.text;
    } else if (o.t === "rect" || o.t === "ellipse" || o.t === "hl" || o.t === "cover") {
      Object.assign(el.style, { left: s(o.x) + "px", top: s(o.y) + "px", width: s(o.w) + "px", height: s(o.h) + "px" });
      if (o.t === "hl") { el.style.background = o.fill; el.style.opacity = o.op; el.style.mixBlendMode = "multiply"; }
      else if (o.t === "cover") el.style.background = o.fill;
      else { el.style.border = `${Math.max(0.5, s(o.sw))}px solid ${o.stroke}`; if (o.fill) el.style.background = o.fill; el.style.opacity = o.op; if (o.t === "ellipse") el.style.borderRadius = "50%"; }
    } else if (o.t === "img") {
      const im = imgs.get(o.id);
      Object.assign(el.style, { left: s(o.x) + "px", top: s(o.y) + "px", width: s(o.w) + "px", height: s(o.h) + "px", opacity: o.op });
      const i = new Image(); i.src = im.url; i.draggable = false; i.style.cssText = "width:100%;height:100%;display:block;pointer-events:none"; el.append(i);
    } else {                                           // line + pen: an svg over the whole page
      el.style.cssText = `left:0;top:0;width:${s(pageW)}px;height:${s(pageH)}px;pointer-events:none`;
      const svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("width", s(pageW)); svg.setAttribute("height", s(pageH)); svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none";
      const add = (d, w, extra = {}) => {
        const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d);
        p.setAttribute("fill", "none"); p.setAttribute("stroke", extra.stroke || o.stroke); p.setAttribute("stroke-width", w);
        p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round"); p.style.pointerEvents = extra.hit ? "stroke" : "none";
        if (extra.hit) p.setAttribute("stroke", "transparent"); svg.append(p); return p;
      };
      let d;
      if (o.t === "line") {
        d = `M${s(o.x1)} ${s(o.y1)} L${s(o.x2)} ${s(o.y2)}`;
        if (o.arrow) { const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1), L = Math.max(8, o.sw * 4); for (const k of [-0.45, 0.45]) d += ` M${s(o.x2)} ${s(o.y2)} L${s(o.x2 - L * Math.cos(a + k))} ${s(o.y2 - L * Math.sin(a + k))}`; }
      } else d = "M" + o.pts.map((p) => `${s(p[0])} ${s(p[1])}`).join(" L");
      add(d, s(o.sw)); add(d, Math.max(12, s(o.sw) + 8), { hit: true });
      el.append(svg);
    }
    el.dataset.u = o.u;
    if (sel === o) addHandles(o, el);
  }
  function addHandles(o, el) {
    const h = (cls, x, y, onDrag) => {
      const d = html(`<div class="${cls}"></div>`); d.style.left = x + "px"; d.style.top = y + "px"; el.append(d);
      d.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); drag({ currentTarget: ov, pointerId: e.pointerId }, onDrag); });
    };
    if (o.t === "line") {
      h("ept", o.x1 * z, o.y1 * z, (p) => { o.x1 = p.x; o.y1 = p.y; });
      h("ept", o.x2 * z, o.y2 * z, (p) => { o.x2 = p.x; o.y2 = p.y; });
    } else if (["rect", "ellipse", "hl", "cover", "img"].includes(o.t)) {
      h("erz", o.w * z, o.h * z, (p) => {
        let w = Math.max(6, p.x - o.x), hh = Math.max(6, p.y - o.y);
        if (o.t === "img") { const r = imgs.get(o.id); hh = w * r.h / r.w; }
        o.w = w; o.h = hh;
      });
    }
  }
  const elOf = (o) => ov.querySelector(`[data-u="${o.u}"]`);
  function renderAll() {
    ov.innerHTML = "";
    for (const o of objs()) { const el = document.createElement("div"); paintObj(o, el); ov.append(el); }
  }
  function repaint(o) { const el = elOf(o); if (el) paintObj(o, el); }

  const point = (e) => { const r = ov.getBoundingClientRect(); return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z }; };
  // generic pointer drag on the page: fn(point) while moving, commit at the end
  function drag(e, fn, end) {
    const target = e.currentTarget || ov;
    try { target.setPointerCapture(e.pointerId); } catch {}
    let moved = false;
    const move = (ev) => { moved = true; fn(point(ev)); if (sel) repaintLive(sel); };
    const up = () => {
      target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up);
      const forced = end?.(moved); if (moved || forced) commit();
    };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up); target.addEventListener("pointercancel", up);
  }
  function repaintLive(o) {
    const el = elOf(o); if (!el) return;
    // keep the element being dragged (it holds pointer capture): update styles in place
    const s = (p) => p * z;
    if (o.t === "text" || o.t === "rect" || o.t === "ellipse" || o.t === "hl" || o.t === "cover" || o.t === "img") {
      el.style.left = s(o.x) + "px"; el.style.top = s(o.y) + "px";
      if (o.w) { el.style.width = s(o.w) + "px"; el.style.height = s(o.h) + "px"; }
      const rz = el.querySelector(".erz"); if (rz) { rz.style.left = s(o.w) + "px"; rz.style.top = s(o.h) + "px"; }
    } else { paintObj(o, el); }
  }

  // ---------- creating + moving
  ov.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const t = e.target.closest(".eo");
    if (tool_ === "select") {
      if (!t) { select(null); return; }
      const o = objs().find((x) => String(x.u) === t.dataset.u); if (!o) return;
      if (editing === o) return;
      select(o);
      const p0 = point(e); const start = JSON.parse(JSON.stringify(o));
      e.preventDefault();
      const t2 = ov;
      drag({ currentTarget: t2, pointerId: e.pointerId }, (p) => {
        const dx = p.x - p0.x, dy = p.y - p0.y;
        if (o.t === "line") { o.x1 = start.x1 + dx; o.y1 = start.y1 + dy; o.x2 = start.x2 + dx; o.y2 = start.y2 + dy; }
        else if (o.t === "draw") o.pts = start.pts.map((q) => [q[0] + dx, q[1] + dy]);
        else { o.x = start.x + dx; o.y = start.y + dy; }
      });
      return;
    }
    e.preventDefault();
    const p0 = point(e);
    if (tool_ === "text") {
      const o = { u: ++uid, t: "text", x: p0.x, y: p0.y - D.text.size * 0.6, text: "ข้อความ", ...D.text };
      objs().push(o); setTool("select"); select(o); setTimeout(() => startEdit(o, true), 0);
      return;
    }
    if (tool_ === "draw") {
      const o = { u: ++uid, t: "draw", pts: [[p0.x, p0.y]], ...D.draw };
      objs().push(o); renderAll();
      drag({ currentTarget: ov, pointerId: e.pointerId }, (p) => { const l = o.pts[o.pts.length - 1]; if (Math.hypot(p.x - l[0], p.y - l[1]) > 1.2) o.pts.push([p.x, p.y]); repaintFor(o); }, (moved) => { if (!moved) { objs().pop(); renderAll(); } return moved; });
      return;
    }
    const kind = tool_;
    const o = kind === "line" ? { u: ++uid, t: "line", x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y, ...D.line }
      : { u: ++uid, t: kind, x: p0.x, y: p0.y, w: 0, h: 0, ...D[kind] };
    objs().push(o); renderAll();
    drag({ currentTarget: ov, pointerId: e.pointerId }, (p) => {
      if (kind === "line") { o.x2 = p.x; o.y2 = p.y; }
      else { o.x = Math.min(p0.x, p.x); o.y = Math.min(p0.y, p.y); o.w = Math.abs(p.x - p0.x); o.h = Math.abs(p.y - p0.y); }
      repaintFor(o);
    }, (moved) => {
      if (kind !== "line" && (!moved || o.w < 4 || o.h < 4)) { if (!moved || (o.w < 4 && o.h < 4)) { o.x = p0.x - 60; o.y = p0.y - 20; o.w = 120; o.h = 40; } }
      if (kind === "cover") o.fill = sampleBackground(o);
      select(o); if (kind !== "hl") setTool("select"); select(o);
      return true;
    });
  });
  const repaintFor = (o) => { const el = elOf(o); if (el) paintObj(o, el); };

  function select(o) { sel = o; renderAll(); renderProps(); }
  // most common colour in a thin ring around the rectangle: the page's own background
  function sampleBackground(o) {
    const dpr = cv.width / (pageW * z), k = z * dpr, g = cv.getContext("2d");
    const x0 = Math.max(0, Math.floor(o.x * k) - 3), y0 = Math.max(0, Math.floor(o.y * k) - 3);
    const x1 = Math.min(cv.width - 1, Math.ceil((o.x + o.w) * k) + 3), y1 = Math.min(cv.height - 1, Math.ceil((o.y + o.h) * k) + 3);
    if (x1 - x0 < 2 || y1 - y0 < 2) return "#ffffff";
    const d = g.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data, w = x1 - x0 + 1, h = y1 - y0 + 1, cnt = new Map();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x > 2 && y > 2 && x < w - 3 && y < h - 3) continue;
      const i = (y * w + x) * 4, key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3), e = cnt.get(key) || [0, 0, 0, 0];
      e[0]++; e[1] += d[i]; e[2] += d[i + 1]; e[3] += d[i + 2]; cnt.set(key, e);
    }
    let best = null; for (const e of cnt.values()) if (!best || e[0] > best[0]) best = e;
    if (!best) return "#ffffff";
    return "#" + [1, 2, 3].map((j) => Math.round(best[j] / best[0]).toString(16).padStart(2, "0")).join("");
  }

  // ---------- text editing
  function startEdit(o, selectAll) {
    const el = elOf(o); if (!el) return;
    editing = o; el.contentEditable = "true"; el.classList.add("editing"); el.focus();
    if (selectAll) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    const finish = () => {
      el.removeEventListener("blur", finish); el.contentEditable = "false"; editing = null;
      const t = el.innerText.replace(/\n$/, "");
      if (!t.trim()) { pages.set(cur, objs().filter((x) => x !== o)); sel = null; }
      else o.text = t;
      commit(); renderAll(); renderProps();
    };
    el.addEventListener("blur", finish);
    el.addEventListener("keydown", (e) => { if (e.key === "Escape") el.blur(); e.stopPropagation(); });
  }
  ov.addEventListener("dblclick", (e) => {
    const t = e.target.closest(".e-text"); if (!t) return;
    const o = objs().find((x) => String(x.u) === t.dataset.u); if (o) { select(o); startEdit(o, false); }
  });

  // ---------- property panel
  function renderProps() {
    props.innerHTML = "";
    const kind = sel ? sel.t : (tool_ === "select" ? null : tool_);
    if (!kind) {
      props.append(html(`<div class="note">${sign ? "กดปุ่ม <b>ลายเซ็น</b> ด้านบนเพื่อสร้างหรือเลือกลายเซ็น แล้วลากไปวางบนหน้ากระดาษ" : "เลือกเครื่องมือจากแถบด้านบน แล้วคลิก/ลากบนหน้ากระดาษ · ดับเบิลคลิกข้อความเพื่อแก้ไข · ถ้าจะแก้ข้อความเดิม ใช้ “ปิดทับ” แล้วพิมพ์ทับ (ข้อความเดิมยังอยู่ใต้แผ่นปิดในไฟล์ ไม่ได้ถูกลบจริง)"}</div>`));
      actions.innerHTML = ""; return;
    }
    const t = sel || D[kind], onEdit = (live) => { if (sel) repaint(sel); if (!live) { if (sel) commit(); } };
    const addColor = (label, key, nullable) => {
      const i = html(`<input type="color" value="${t[key] || "#000000"}">`);
      const row = html(`<div class="row"></div>`); row.append(i);
      if (nullable) { const c = html(`<label class="chk"><input type="checkbox" ${t[key] ? "" : "checked"}> ไม่เติมสี</label>`); c.firstElementChild.onchange = (e) => { t[key] = e.target.checked ? null : i.value; onEdit(); }; row.append(c); }
      i.oninput = () => { t[key] = i.value; onEdit(true); }; i.onchange = () => { t[key] = i.value; onEdit(); };
      props.append(field(label, row));
    };
    const addRange = (label, key, min, max, step, scale = 1, unit = "") => {
      const i = html(`<input type="range" min="${min * scale}" max="${max * scale}" step="${step * scale}" value="${Math.round((t[key] ?? min) * scale * 100) / 100}">`);
      const v = html(`<span class="muted" style="width:46px;text-align:right"></span>`); v.textContent = i.value + unit;
      const row = html(`<div class="row"></div>`); row.append(i, v);
      i.oninput = () => { t[key] = +i.value / scale; v.textContent = i.value + unit; onEdit(true); }; i.onchange = () => { onEdit(); };
      props.append(field(label, row));
    };
    const titles = { text: "ข้อความ", rect: "สี่เหลี่ยม", ellipse: "วงรี", line: "เส้น", draw: "ปากกา", hl: "ไฮไลต์", cover: "ปิดทับ", img: "รูปภาพ" };
    props.append(html(`<p class="side-title">${titles[kind]}${sel ? "" : " (ค่าเริ่มต้น)"}</p>`));
    if (kind === "text") {
      addColor("สีตัวอักษร", "color"); addRange("ขนาด", "size", 6, 120, 1, 1, " pt");
      const b = html(`<label class="chk"><input type="checkbox" ${t.bold ? "checked" : ""}> ตัวหนา</label>`); b.firstElementChild.onchange = (e) => { t.bold = e.target.checked; onEdit(); }; props.append(b);
    } else if (kind === "rect" || kind === "ellipse") { addColor("สีเส้น", "stroke"); addColor("สีเติม", "fill", true); addRange("ความหนาเส้น", "sw", 0.5, 12, 0.5, 1, " pt"); addRange("โปร่งใส", "op", 0.1, 1, 0.05, 100, "%"); }
    else if (kind === "line") { addColor("สี", "stroke"); addRange("ความหนา", "sw", 0.5, 14, 0.5, 1, " pt"); const a = html(`<label class="chk"><input type="checkbox" ${t.arrow ? "checked" : ""}> มีหัวลูกศร</label>`); a.firstElementChild.onchange = (e) => { t.arrow = e.target.checked; onEdit(); }; props.append(a); }
    else if (kind === "draw") { addColor("สี", "stroke"); addRange("ความหนา", "sw", 1, 24, 0.5, 1, " pt"); }
    else if (kind === "hl") { addColor("สีไฮไลต์", "fill"); addRange("ความเข้ม", "op", 0.1, 1, 0.05, 100, "%"); }
    else if (kind === "cover") {
      addColor("สีที่ปิดทับ", "fill");
      if (sel) { const b = html(`<button class="mini" type="button">ดูดสีพื้นหลังอัตโนมัติ</button>`); b.onclick = () => { sel.fill = sampleBackground(sel); repaint(sel); commit(); renderProps(); }; props.append(b); }
      props.append(html(`<div class="hint">ใช้ปิดข้อความเดิมที่จะแก้ แล้วใช้เครื่องมือ “ข้อความ” พิมพ์ทับ</div>`));
    } else if (kind === "img") addRange("โปร่งใส", "op", 0.1, 1, 0.05, 100, "%");
    actions.innerHTML = "";
    if (sel) {
      const mk = (label, ic, fn, cls = "") => { const b = html(`<button class="mini ${cls}" type="button">${icon(ic, 14)} ${label}</button>`); b.onclick = fn; actions.append(b); };
      mk("ลบ", "remove", delSel, "danger");
      mk("ทำสำเนา", "copy", () => { const c = JSON.parse(JSON.stringify(sel)); c.u = ++uid; shift(c, 14); objs().push(c); commit(); select(c); });
      if (doc.n > 1) mk("ใส่ทุกหน้า", "plus", () => {
        for (let p = 1; p <= doc.n; p++) { if (p === cur) continue; const c = JSON.parse(JSON.stringify(sel)); c.u = ++uid; if (!pages.has(p)) pages.set(p, []); pages.get(p).push(c); }
        commit(); actions.lastChild.lastChild.textContent = " ใส่แล้ว ✓";
      });
    }
  }
  function shift(o, d) { if (o.t === "line") { o.x1 += d; o.x2 += d; o.y1 += d; o.y2 += d; } else if (o.t === "draw") o.pts = o.pts.map((q) => [q[0] + d, q[1] + d]); else { o.x += d; o.y += d; } }
  function delSel() { if (!sel) return; pages.set(cur, objs().filter((x) => x !== sel)); sel = null; commit(); renderAll(); renderProps(); }

  // ---------- keyboard
  const onKey = (e) => {
    if (!ctx.stage.isConnected || editing || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || document.querySelector(".cam,.sigdlg")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? redoBtn : undoBtn).click(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redoBtn.click(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); delSel(); }
    else if (e.key === "Escape") { setTool("select"); select(null); }
    else if (sel && e.key.startsWith("Arrow")) {
      e.preventDefault(); const d = e.shiftKey ? 10 : 1;
      const [dx, dy] = e.key === "ArrowLeft" ? [-d, 0] : e.key === "ArrowRight" ? [d, 0] : e.key === "ArrowUp" ? [0, -d] : [0, d];
      if (sel.t === "line") { sel.x1 += dx; sel.x2 += dx; sel.y1 += dy; sel.y2 += dy; } else if (sel.t === "draw") sel.pts = sel.pts.map((q) => [q[0] + dx, q[1] + dy]); else { sel.x += dx; sel.y += dy; }
      repaint(sel); commit();
    }
  };
  document.addEventListener("keydown", onKey); ctx.onClose(() => document.removeEventListener("keydown", onKey));

  // ---------- images + signatures
  function addImage(bytes, mime, w, h, widthPt) {
    const id = "i" + (++uid), url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    ctx.onClose(() => URL.revokeObjectURL(url));
    imgs.set(id, { bytes, mime, w, h, url });
    const ww = Math.min(widthPt || pageW * 0.3, pageW * 0.9), hh = ww * h / w;
    const o = { u: ++uid, t: "img", id, x: (pageW - ww) / 2, y: (pageH - hh) / 2, w: ww, h: hh, ...D.img };
    objs().push(o); commit(); setTool("select"); select(o);
  }
  imgBtn.onclick = () => imgFile.click();
  imgFile.onchange = () => ctx.run(async () => {
    const f = imgFile.files[0]; imgFile.value = ""; if (!f) return;
    const bmp = await loadBitmap(f), [w, h] = bmpSize(bmp), k = Math.min(1, 2400 / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const png = /png|gif|webp|avif/i.test(f.type || f.name);
    const blob = await new Promise((r) => c.toBlob(r, png ? "image/png" : "image/jpeg", 0.92));
    addImage(new Uint8Array(await blob.arrayBuffer()), png ? "image/png" : "image/jpeg", c.width, c.height);
  }, "กำลังเปิดรูป…");
  sigBtn.onclick = () => signatureDialog((png) => addImage(png.bytes, "image/png", png.w, png.h, Math.min(170, pageW * 0.3)));

  // ---------- save
  save.onclick = () => ctx.run(async () => {
    const { PDFDocument, rgb, degrees, BlendMode, LineCapStyle } = PLIB();
    const out = await PDFDocument.load(doc.bytes, { ignoreEncryption: true, updateMetadata: false });
    const all = [...pages.entries()].filter(([, l]) => l.length);
    if (!all.length) throw { title: "ยังไม่ได้เพิ่มอะไรลงในเอกสาร", body: "เพิ่มข้อความ รูป หรือรูปทรงก่อนบันทึก" };
    const thai = all.some(([, l]) => l.some((o) => o.t === "text" && needsThai(o.text)));
    const hasText = all.some(([, l]) => l.some((o) => o.t === "text"));
    const F = hasText ? await PDFX.loadFonts(out, thai) : null;
    const emb = new Map();
    for (const [pn, list] of all) {
      const page = out.getPage(pn - 1), sp = pageSpace(page); sp.enter();
      const Y = (y) => sp.h - y;
      for (const o of list) {
        if (o.t === "text") {
          const font = o.bold ? F.bold : F.reg, lines = F.clean(o.text).split("\n"), lh = o.size * 1.25;
          lines.forEach((ln, i) => { if (ln) PDFX.drawLine(page, F, font, ln, o.x, Y(o.y + o.size * (F.raw ? 1.04 : 0.97) + i * lh), o.size, hexRgb(o.color)); });
        } else if (o.t === "rect") {
          page.drawRectangle({ x: o.x, y: Y(o.y + o.h), width: o.w, height: o.h, borderColor: rgb(...hexRgb(o.stroke)), borderWidth: o.sw, color: o.fill ? rgb(...hexRgb(o.fill)) : undefined, opacity: o.fill ? o.op : undefined, borderOpacity: o.op });
        } else if (o.t === "ellipse") {
          page.drawEllipse({ x: o.x + o.w / 2, y: Y(o.y + o.h / 2), xScale: o.w / 2, yScale: o.h / 2, borderColor: rgb(...hexRgb(o.stroke)), borderWidth: o.sw, color: o.fill ? rgb(...hexRgb(o.fill)) : undefined, opacity: o.fill ? o.op : undefined, borderOpacity: o.op });
        } else if (o.t === "hl") {
          page.drawRectangle({ x: o.x, y: Y(o.y + o.h), width: o.w, height: o.h, color: rgb(...hexRgb(o.fill)), opacity: o.op, blendMode: BlendMode.Multiply });
        } else if (o.t === "cover") {
          page.drawRectangle({ x: o.x, y: Y(o.y + o.h), width: o.w, height: o.h, color: rgb(...hexRgb(o.fill)), borderWidth: 0 });
        } else if (o.t === "line") {
          const col = rgb(...hexRgb(o.stroke)), seg = (a, b, c, d) => page.drawLine({ start: { x: a, y: Y(b) }, end: { x: c, y: Y(d) }, thickness: o.sw, color: col, lineCap: LineCapStyle.Round });
          seg(o.x1, o.y1, o.x2, o.y2);
          if (o.arrow) { const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1), L = Math.max(8, o.sw * 4); for (const k of [-0.45, 0.45]) seg(o.x2, o.y2, o.x2 - L * Math.cos(a + k), o.y2 - L * Math.sin(a + k)); }
        } else if (o.t === "draw") {
          const d = "M" + o.pts.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" L");
          page.drawSvgPath(d, { x: 0, y: sp.h, borderColor: rgb(...hexRgb(o.stroke)), borderWidth: o.sw, borderLineCap: LineCapStyle.Round });
        } else if (o.t === "img") {
          const im = imgs.get(o.id);
          if (!emb.has(o.id)) emb.set(o.id, im.mime === "image/png" ? await out.embedPng(im.bytes) : await out.embedJpg(im.bytes));
          page.drawImage(emb.get(o.id), { x: o.x, y: Y(o.y + o.h), width: o.w, height: o.h, opacity: o.op });
        }
      }
      sp.leave();
    }
    await showResult(ctx, { title: sign ? "ลงลายเซ็นแล้ว" : "บันทึกการแก้ไขแล้ว", files: [{ name: `${baseName(doc.name)}${sign ? "_เซ็น" : "_แก้ไข"}.pdf`, mime: "application/pdf", bytes: await savePdf(out) }] });
  }, "กำลังบันทึก…");

  setTool("select");
  showPage(1, true).then(() => { if (sign) sigBtn.click(); });
}

// ------------------------------------------------------------------ signature dialog
function signatureDialog(onDone) {
  const sigs = loadSigs();
  const dlg = html(`<div class="cam sigdlg" role="dialog" aria-label="ลายเซ็น"><div class="box sigbox card">
    <div class="phead"><h2 style="margin:0;font-size:18px">สร้างลายเซ็น</h2><button class="ibtn" type="button" data-a="close" aria-label="ปิด">${icon("x", 16)}</button></div>
    <div class="seg" data-tabs><button type="button" data-t="draw" class="on">วาด</button><button type="button" data-t="type">พิมพ์ชื่อ</button><button type="button" data-t="img">อัปโหลดรูป</button></div>
    <div data-pane="draw"><canvas class="sigpad" width="1200" height="400"></canvas><div class="hint">ใช้เมาส์หรือนิ้วเซ็นในกรอบ</div></div>
    <div data-pane="type" hidden><input type="text" class="signame" placeholder="พิมพ์ชื่อของคุณ" autocomplete="off"><div class="sigstyles"></div></div>
    <div data-pane="img" hidden><button class="mini" type="button" data-a="pickimg">${icon("image", 14)} เลือกรูปลายเซ็น…</button><input type="file" accept="image/*" hidden>
      <label class="chk" style="margin-top:8px"><input type="checkbox" checked> ลบพื้นหลังสีขาวให้โปร่งใส</label><canvas class="sigprev" width="600" height="200"></canvas></div>
    <div class="row" data-colors><span class="muted">สี</span></div>
    <div class="sigsaved"></div>
    <div class="row" style="justify-content:flex-end"><button class="mini" type="button" data-a="clear">ล้าง</button><button class="primary" type="button" data-a="use" style="width:auto;padding:10px 22px">ใช้ลายเซ็นนี้</button></div>
  </div></div>`);
  document.body.append(dlg);
  const close = () => dlg.remove();
  dlg.addEventListener("pointerdown", (e) => { if (e.target === dlg) close(); });
  dlg.querySelector('[data-a="close"]').onclick = close;
  let tab = "draw", color = "#111827", style = 0, upImg = null;
  const pad = dlg.querySelector(".sigpad"), pg = pad.getContext("2d");
  const err = html(`<div class="msg err" hidden><b></b></div>`); dlg.querySelector(".sigbox").insertBefore(err, dlg.querySelector("[data-colors]"));
  for (const c of ["#111827", "#1d4ed8", "#c81e1e"]) { const b = html(`<button type="button" class="ibtn" style="background:${c};border-color:${c}" aria-label="${c}"></button>`); b.onclick = () => { color = c; renderType(); }; dlg.querySelector("[data-colors]").append(b); }
  // drawing
  let down = false, last = null;
  const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.addEventListener("pointerdown", (e) => { down = true; last = pos(e); pad.setPointerCapture(e.pointerId); pg.beginPath(); pg.arc(last[0], last[1], 3, 0, 7); pg.fillStyle = color; pg.fill(); });
  pad.addEventListener("pointermove", (e) => {
    if (!down) return; const p = pos(e);
    pg.strokeStyle = color; pg.lineWidth = 7; pg.lineCap = pg.lineJoin = "round"; pg.beginPath(); pg.moveTo(last[0], last[1]); pg.lineTo(p[0], p[1]); pg.stroke(); last = p;
  });
  pad.addEventListener("pointerup", () => { down = false; }); pad.addEventListener("pointercancel", () => { down = false; });
  // typed
  const FONTS = [`"Segoe Script","Brush Script MT","Lucida Handwriting","Apple Chancery","Z003","URW Chancery L",cursive`, `"Georgia","Times New Roman",serif`, `"IBM Plex Sans Thai","Noto Sans Thai",sans-serif`];
  const nameIn = dlg.querySelector(".signame"), styles = dlg.querySelector(".sigstyles");
  FONTS.forEach((f, i) => { const c = document.createElement("canvas"); c.width = 560; c.height = 92; c.className = "sigstyle"; c.onclick = () => { style = i; renderType(); }; styles.append(c); });
  function renderType() {
    styles.querySelectorAll("canvas").forEach((c, i) => {
      const g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
      const t = nameIn.value || "ชื่อของคุณ"; let size = 60; g.font = `italic ${size}px ${FONTS[i]}`;
      while (g.measureText(t).width > c.width - 40 && size > 20) { size -= 4; g.font = `italic ${size}px ${FONTS[i]}`; }
      g.fillStyle = color; g.textBaseline = "middle"; g.fillText(t, 20, c.height / 2);
      c.classList.toggle("on", i === style);
    });
  }
  nameIn.oninput = renderType; renderType();
  // uploaded
  const upIn = dlg.querySelector('[data-pane="img"] input[type=file]'), upPrev = dlg.querySelector(".sigprev"), upChk = dlg.querySelector('[data-pane="img"] input[type=checkbox]');
  function renderUp() {
    const g = upPrev.getContext("2d"); g.clearRect(0, 0, upPrev.width, upPrev.height); if (!upImg) return;
    const k = Math.min(upPrev.width / upImg.w, upPrev.height / upImg.h); g.drawImage(upImg.bmp, 0, 0, upImg.w * k, upImg.h * k);
  }
  dlg.querySelector('[data-a="pickimg"]').onclick = () => upIn.click();
  upIn.onchange = async () => { const f = upIn.files[0]; if (!f) return; try { const bmp = await loadBitmap(f), [w, h] = bmpSize(bmp); upImg = { bmp, w, h }; renderUp(); } catch (e) { showErr(explain(e)[0]); } };
  const showErr = (m) => { err.hidden = !m; err.firstElementChild.textContent = m || ""; };
  // saved
  const saved = dlg.querySelector(".sigsaved");
  function renderSaved() {
    saved.innerHTML = sigs.length ? `<div class="lbl">ลายเซ็นที่เคยใช้</div>` : "";
    sigs.forEach((s, i) => {
      const b = html(`<span class="sigchip"><img alt="ลายเซ็น"><button type="button" aria-label="ลบ">${icon("x", 12)}</button></span>`);
      b.querySelector("img").src = s.url; b.querySelector("img").onclick = () => { close(); onDone({ bytes: dataUrlBytes(s.url), w: s.w, h: s.h }); };
      b.querySelector("button").onclick = () => { sigs.splice(i, 1); storeSigs(sigs); renderSaved(); };
      saved.append(b);
    });
  }
  renderSaved();
  const dataUrlBytes = (u) => Uint8Array.from(atob(u.split(",")[1]), (c) => c.charCodeAt(0));
  // tabs
  dlg.querySelector("[data-tabs]").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return; tab = b.dataset.t;
    dlg.querySelectorAll("[data-tabs] button").forEach((x) => x.classList.toggle("on", x === b));
    dlg.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab)); showErr("");
  };
  dlg.querySelector('[data-a="clear"]').onclick = () => { pg.clearRect(0, 0, pad.width, pad.height); nameIn.value = ""; renderType(); upImg = null; renderUp(); showErr(""); };
  // result: transparent PNG trimmed to the ink
  dlg.querySelector('[data-a="use"]').onclick = async () => {
    const src = document.createElement("canvas");
    if (tab === "draw") { src.width = pad.width; src.height = pad.height; src.getContext("2d").drawImage(pad, 0, 0); }
    else if (tab === "type") { if (!nameIn.value.trim()) return showErr("พิมพ์ชื่อก่อน"); const c = styles.children[style]; src.width = c.width; src.height = c.height; src.getContext("2d").drawImage(c, 0, 0); }
    else {
      if (!upImg) return showErr("เลือกรูปลายเซ็นก่อน");
      const k = Math.min(1, 1200 / Math.max(upImg.w, upImg.h)); src.width = Math.round(upImg.w * k); src.height = Math.round(upImg.h * k);
      const g = src.getContext("2d"); g.drawImage(upImg.bmp, 0, 0, src.width, src.height);
      if (upChk.checked) { const im = g.getImageData(0, 0, src.width, src.height), d = im.data; for (let i = 0; i < d.length; i += 4) { const l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; if (l > 235) d[i + 3] = 0; else if (l > 190) d[i + 3] = Math.round(d[i + 3] * (235 - l) / 45); } g.putImageData(im, 0, 0); }
    }
    const g = src.getContext("2d"), d = g.getImageData(0, 0, src.width, src.height).data;
    let x0 = src.width, y0 = src.height, x1 = -1, y1 = -1;
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) if (d[(y * src.width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return showErr(tab === "draw" ? "ยังไม่ได้เซ็น" : "ไม่พบลายเซ็นในรูป");
    const pad4 = 6, w = x1 - x0 + 1 + 2 * pad4, h = y1 - y0 + 1 + 2 * pad4, out = document.createElement("canvas"); out.width = w; out.height = h;
    out.getContext("2d").drawImage(src, x0 - pad4, y0 - pad4, w, h, 0, 0, w, h);
    const url = out.toDataURL("image/png");
    sigs.unshift({ url, w, h }); storeSigs(sigs);
    close(); onDone({ bytes: dataUrlBytes(url), w, h });
  };
}
