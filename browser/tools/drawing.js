// ===================================================================== Drawing: translate + Ref# tags
// A drawing / datasheet sheet: optionally translate its text (same engine as the
// translator tool), then mark key values with numbered "Ref#" tags and orange
// highlights, and save. Photos / scans can be tagged too, but not translated (no OCR).

async function photoToPdf(file) {
  const bmp = await loadBitmap(file), [w, h] = bmpSize(bmp);
  const im = await imageForPdf({ bmp, file, name: file.name, rot: 0 }, "none");
  const out = await PLIB().PDFDocument.create();
  const emb = im.mime === "image/png" ? await out.embedPng(im.bytes) : await out.embedJpg(im.bytes);
  const page = out.addPage([im.w * 0.75, im.h * 0.75]);
  page.drawImage(emb, { x: 0, y: 0, width: im.w * 0.75, height: im.h * 0.75 });
  return savePdf(out);
}

// ------------------------------------------------------------------ automatic Ref# tags
// The same marks an engineer puts on a printed datasheet: the value of each key
// spec row gets an orange highlight and a "Ref#n" tag, and the U / V / W pins of
// the power connector are Ref#1.
const REF_RULES = [
  { n: 2, what: "กำลังไฟพิกัด (Rated power)", re: /额定功率|RATED\s*POWER/i },
  { n: 3, what: "แรงดันพิกัด (Rated voltage)", re: /额定电压|RATED\s*VOLTAGE/i },
  { n: 4, what: "ความเร็วรอบพิกัด (Rated speed)", re: /额定转速|RATED\s*(ROTATION(AL)?\s*)?SPEED/i, not: /最高|最大|MAX/i },
  { n: 5, what: "จำนวนคู่ขั้วโรเตอร์ (Rotor poles)", re: /转子极对数|极对数|ROTOR\s*POLES?|POLE\s*PAIRS?/i },
];
const REF_COLOR = "#1d3fd8", HL = { fill: "#ff9a2e", op: 0.55 };
const CJK_RE = /[\u3400-\u9fff]/;
const valueLike = (s) => !CJK_RE.test(s) && (/\d/.test(s) || /^\*?A$/.test(s));

async function pageItems(view, p) {
  const page = await view.getPage(p), vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent(), items = [];
  for (const it of tc.items) {
    const s = (it.str || "").trim(); if (!s) continue;
    const [a, b, c, d, e, f] = pdfjsLib.Util.transform(vp.transform, it.transform);
    if (Math.abs(b) > 0.01 * Math.abs(a) || Math.abs(c) > 0.01 * Math.abs(d) || a <= 0 || d >= 0) continue;   // upright on screen only
    const size = Math.abs(d);
    items.push({ s, x0: e, x1: e + Math.max(it.width, 0.3 * size), size, top: f - 0.85 * size, bot: f + 0.2 * size, cy: f - 0.33 * size });
  }
  return { items, w: vp.width, h: vp.height };
}

// x of the first dark vertical rule to the right of the values (the table's right border), or 0
async function tableRight(view, p, vals) {
  try {
    const page = await view.getPage(p), S = 2, vp = page.getViewport({ scale: S });
    const cv = document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const g = cv.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    let best = 0;
    for (const V of vals) {
      const x0 = Math.round((V.x1 + 1) * S), x1 = Math.min(cv.width - 1, Math.round((V.x1 + 40 * V.size) * S));
      const y0 = Math.max(0, Math.round(V.top * S)), y1 = Math.min(cv.height - 1, Math.round(V.bot * S));
      if (x1 <= x0 || y1 <= y0) continue;
      const d = g.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data, w = x1 - x0 + 1, h = y1 - y0 + 1;
      for (let x = 0; x < w; x++) {
        let n = 0; for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 480) n++; }
        if (n >= 0.8 * h) { best = Math.max(best, (x0 + x) / S); break; }
      }
    }
    cv.width = cv.height = 1;
    return best;
  } catch { return 0; }
}

// -> { pages: Map(page -> [objects]), found: [n...], missing: [rule...] }
async function detectRefs(view) {
  const pages = new Map(), found = new Set();
  const hl = (it) => ({ t: "hl", x: it.x0 - 0.45 * it.size, y: it.top - 0.2 * it.size, w: it.x1 - it.x0 + 0.9 * it.size, h: it.bot - it.top + 0.35 * it.size, ...HL });
  const tag = (n, x, y, size) => ({ t: "text", ref: true, text: `Ref#${n}`, x, y, size, color: REF_COLOR, bold: true });
  for (let p = 1; p <= view.numPages && found.size < 5; p++) {
    const { items, w, h } = await pageItems(view, p), list = [];
    // Ref#2..#5: label row -> nearest value on the same row, to the right
    const hits = [];
    for (const r of REF_RULES) {
      if (found.has(r.n)) continue;
      let best = null;
      for (const L of items) {
        if (!r.re.test(L.s) || (r.not && r.not.test(L.s))) continue;
        for (const V of items) {
          if (V === L || !valueLike(V.s) || V.x0 < L.x1 + 2) continue;
          const dy = Math.abs(V.cy - L.cy), lim = 1.35 * Math.max(L.size, V.size);
          if (dy > lim || V.x0 - L.x1 > 60 * L.size) continue;
          const score = dy / L.size + 0.01 * (V.x0 - L.x1) / L.size;
          if (!best || score < best.score) best = { score, V };
        }
      }
      if (best) { hits.push({ n: r.n, V: best.V }); found.add(r.n); }
    }
    if (hits.length) {
      // put the tags just outside the table: find the cell border to the right of each value on the rendered page
      const border = await tableRight(view, p, hits.map((x) => x.V));
      const col = border || Math.max(...hits.map((x) => x.V.x1)) + 1.6 * hits[0].V.size;
      const ys = hits.map((x) => x.V.cy).sort((a, b) => a - b), gaps = ys.slice(1).map((y, i) => y - ys[i]);
      const room = gaps.length ? 1.05 * Math.min(...gaps) : 99;     // neighbouring rows: tags must not run into each other
      const ts = Math.max(11, Math.min(26, room, 2.2 * Math.max(...hits.map((x) => x.V.size))));
      for (const { n, V } of hits) list.push(hl(V), tag(n, Math.min(w - 4 * ts, col + 6), V.cy - ts * 0.62, ts));
    }
    // Ref#1: the U, V, W rows of the power connector table
    if (!found.has(1)) {
      const one = (ch) => items.filter((it) => it.s === ch);
      let grp = null;
      for (const U of one("U")) for (const V of one("V")) for (const W of one("W")) {
        const xs = [U.x0, V.x0, W.x0], ys = [U.cy, V.cy, W.cy], sz = U.size;
        if (Math.max(...xs) - Math.min(...xs) > 1.5 * sz) continue;
        const span = Math.max(...ys) - Math.min(...ys);
        if (span > 8 * sz || span < 1.5 * sz) continue;
        if (!grp || span < grp.span) grp = { span, U, V, W };
      }
      if (grp) {
        const g = [grp.U, grp.V, grp.W], sz = grp.U.size, ts = Math.max(14, Math.min(26, 2.2 * sz));
        const top = Math.min(...g.map((x) => x.top)), right = Math.max(...g.map((x) => x.x1));
        const tx = Math.min(w - 4 * ts, right + 7 * sz), ty = Math.max(2, top - 2.6 * ts);
        g.forEach((x) => list.push(hl(x)));
        list.push(tag(1, tx, ty, ts), { t: "line", x1: tx + 0.2 * ts, y1: ty + 1.05 * ts, x2: grp.U.x1 + 0.6 * sz, y2: grp.U.cy, stroke: REF_COLOR, sw: 1.4, arrow: false });
        found.add(1);
      }
    }
    if (list.length) pages.set(p, list);
  }
  return { pages, found: [...found].sort(), missing: [{ n: 1, what: "ขั้วต่อสายกำลัง U / V / W" }, ...REF_RULES].filter((r) => !found.has(r.n)) };
}

tool({
  id: "drawing", group: "edit", title: "ทำ Drawing (แปล + ป้าย Ref#)", icon: "tag",
  desc: "แปลข้อความในแบบ แล้วติดป้าย Ref#1, 2, 3 … และไฮไลต์จุดสำคัญ เหมือนที่ขีดเขียนบนกระดาษ",
  init(ctx) {
    ctx.stage.innerHTML = "";
    ctx.stage.append(dropZone({
      kind: "pdfimg", title: "เลือกไฟล์ Drawing (PDF หรือภาพถ่าย)",
      hint: "PDF แปลข้อความได้ · ภาพถ่าย/สแกนติดป้ายได้อย่างเดียว (ยังแปลไม่ได้ ต้องมี OCR)",
      onFiles: async ([f]) => {
        const isImg = !isPdf(f);
        const doc = await ctx.run(async () => loadOne(isImg ? new File([await photoToPdf(f)], baseName(f.name) + ".pdf", { type: "application/pdf" }) : f), "กำลังอ่านไฟล์…");
        if (doc) options(doc, isImg);
      },
    }));

    function options(doc, isImg) {
      ctx.side.innerHTML = ""; ctx.stage.innerHTML = ""; ctx.work();
      ctx.side.append(fileChip(doc.name, `${doc.n} หน้า · ${fmtSize(doc.bytes.length)}`, () => ctx.reset()));
      const useTr = html(`<label class="chk"><input type="checkbox" ${isImg ? "disabled" : "checked"}> แปลข้อความในแบบ</label>`);
      const src = $("src").cloneNode(true), tgt = $("tgt").cloneNode(true);
      src.removeAttribute("id"); tgt.removeAttribute("id"); src.value = "zh"; tgt.value = "Thai";
      const pages = html(`<input type="text" placeholder="ทุกหน้า" autocomplete="off">`);
      const box = html(`<div class="trbox"></div>`);
      const keep = html(`<label class="chk"><input type="checkbox" checked> คงบรรทัดภาษาอื่นไว้ (เช่น อังกฤษใต้ภาษาจีน) — ได้แบบสองภาษา</label>`);
      box.append(field("แปลจาก", src), field("แปลเป็น", tgt), keep, field("หน้าที่จะแปล", pages, "เว้นว่าง = ทุกหน้า"));
      const syncKeep = () => { keep.hidden = src.value === "any"; };
      src.addEventListener("change", syncKeep); syncKeep();
      const auto = html(`<label class="chk"><input type="checkbox" ${isImg ? "disabled" : "checked"}> ติดป้าย Ref# อัตโนมัติ</label>`);
      const autoHelp = html(`<div class="hint">Ref#1 ขั้ว U/V/W ของสายกำลัง · Ref#2 กำลังไฟ · Ref#3 แรงดัน · Ref#4 รอบพิกัด · Ref#5 จำนวนคู่ขั้ว — ไฮไลต์สีส้มที่ค่าในตาราง แก้/ลากย้ายได้ทีหลัง</div>`);
      const go = primaryBtn(isImg ? "ไปติดป้าย Ref#" : "ต่อไป: ติดป้าย Ref#", "tag");
      useTr.querySelector("input").onchange = (e) => { box.hidden = !e.target.checked; go.lastChild.textContent = ` ${e.target.checked ? "แปลแล้วไปติดป้าย Ref#" : "ไปติดป้าย Ref#"}`; };
      if (isImg) box.hidden = true;
      const note = html(`<div class="note"></div>`);
      note.textContent = isImg
        ? "ไฟล์นี้เป็นภาพ จึงแปลข้อความไม่ได้ — ติดป้าย Ref# และไฮไลต์ได้ตามปกติ ถ้าต้องการแปล ให้ใช้ไฟล์ PDF ต้นฉบับของแบบ"
        : "ตั้งค่าเริ่มต้น: แปลเฉพาะบรรทัดภาษาจีนเป็นไทย ส่วนบรรทัดภาษาอังกฤษ ตัวเลข และรหัสรุ่นคงเดิม";
      const found = html(`<div class="hint"></div>`);
      ctx.side.append(useTr, found, box, auto, autoHelp, note, go);
      if (!isImg) PDFX.scan(doc.bytes).then((st) => {              // pick the source language from what the page really contains
        found.textContent = PDFX.describeStats(st);
        const total = st.cjk + st.latin + st.digit + st.other;
        if (st.cjk > 0) { src.value = "zh"; }
        else if (st.latin > 0) { src.value = "en"; }
        else if (total < 5) found.textContent += " — แทบไม่มีข้อความจริงในไฟล์ (น่าจะเป็นภาพหรือตัวอักษรแบบเส้น) แปลไม่ได้ แต่ติดป้าย Ref# ได้";
        syncKeep();
      }).catch(() => {});
      if (!isImg) go.lastChild.textContent = " แปลแล้วไปติดป้าย Ref#";

      const pv = html(`<div class="pvwrap"><div class="pv"><canvas></canvas></div></div>`);
      ctx.stage.append(html(`<div class="muted" style="margin-bottom:8px">ตัวอย่างหน้าแรก</div>`), pv);
      doc.view.getPage(1).then((p) => renderPageTo(p, pv.querySelector("canvas"), Math.min(560, Math.max(260, ctx.stage.clientWidth - 70))));

      go.onclick = async () => {
        let useDoc = doc;
        if (useTr.querySelector("input").checked && !isImg) {
          const ctl = new AbortController(); ctx.onClose(() => ctl.abort());
          const r = await ctx.run(() => PDFX.translate(doc.bytes, {
            srcKey: src.value, tgtName: tgt.value, pagesSpec: pages.value, signal: ctl.signal, keepOther: keep.querySelector("input").checked && src.value !== "any",
            ui: {
              s1: (t) => ctx.busy("1/3 " + t), s2: (t, f) => ctx.busy("2/3 " + t, f), s3: (t) => ctx.busy("3/3 " + t),
            },
          }), "กำลังแปล…");
          if (!r) return;                                             // an error is shown on the page; the user can switch translation off
          useDoc = await ctx.run(() => loadOne(new File([r.out.bytes], doc.name, { type: "application/pdf" })), "กำลังเปิดผลการแปล…");
          if (!useDoc) return;
        }
        let pre = null, notice = "";
        if (!isImg && auto.querySelector("input").checked) {
          pre = await ctx.run(() => detectRefs(doc.view), "กำลังหาตำแหน่ง Ref#…");
          if (pre) {
            notice = pre.found.length ? `ติดป้ายอัตโนมัติแล้ว: ${pre.found.map((n) => "Ref#" + n).join(", ")}` : "ไม่พบตำแหน่งสำหรับป้ายอัตโนมัติ";
            if (pre.missing.length) notice += ` · ไม่พบ: ${pre.missing.map((r) => `Ref#${r.n} ${r.what}`).join(", ")} — วางเองได้ด้วยเครื่องมือ “ป้าย Ref#”`;
            else notice += " · ลากย้ายหรือแก้ได้ แล้วกดบันทึกไฟล์";
          }
        }
        ctx.side.innerHTML = ""; ctx.stage.innerHTML = "";
        ctx.side.append(fileChip(useDoc.name, `${useDoc.n} หน้า`, () => ctx.reset()));
        const next = pre && pre.found.length ? Math.max(...pre.found) + 1 : 1;
        runEditor(ctx, useDoc, { drawing: true, suffix: "_Drawing", initial: pre ? pre.pages : null, refStart: next, notice });
      };
    }
  },
});
