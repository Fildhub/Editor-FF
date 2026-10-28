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
      const go = primaryBtn(isImg ? "ไปติดป้าย Ref#" : "ต่อไป: ติดป้าย Ref#", "tag");
      useTr.querySelector("input").onchange = (e) => { box.hidden = !e.target.checked; go.lastChild.textContent = ` ${e.target.checked ? "แปลแล้วไปติดป้าย Ref#" : "ไปติดป้าย Ref#"}`; };
      if (isImg) box.hidden = true;
      const note = html(`<div class="note"></div>`);
      note.textContent = isImg
        ? "ไฟล์นี้เป็นภาพ จึงแปลข้อความไม่ได้ — ติดป้าย Ref# และไฮไลต์ได้ตามปกติ ถ้าต้องการแปล ให้ใช้ไฟล์ PDF ต้นฉบับของแบบ"
        : "ตั้งค่าเริ่มต้น: แปลเฉพาะบรรทัดภาษาจีนเป็นไทย ส่วนบรรทัดภาษาอังกฤษ ตัวเลข และรหัสรุ่นคงเดิม";
      ctx.side.append(useTr, box, note, go);
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
        ctx.side.innerHTML = ""; ctx.stage.innerHTML = "";
        ctx.side.append(fileChip(useDoc.name, `${useDoc.n} หน้า`, () => ctx.reset()));
        runEditor(ctx, useDoc, { drawing: true, suffix: "_Drawing" });
      };
    }
  },
});
