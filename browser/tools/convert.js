// ===================================================================== convert tools
// images -> PDF, scan (camera) -> PDF, PDF -> images

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    return await new Promise((ok, no) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); ok(im); };
      im.onerror = () => { URL.revokeObjectURL(url); no({ title: "เปิดภาพนี้ไม่ได้", body: `${file.name} — รูปแบบที่เบราว์เซอร์นี้อ่านไม่ได้ (เช่น HEIC)` }); };
      im.src = url;
    });
  }
}
const bmpSize = (b) => [b.width || b.naturalWidth, b.height || b.naturalHeight];

// scanner-like clean-up: grey, stretch the levels, optionally pure black/white
function cleanUp(canvas, mode) {
  const g = canvas.getContext("2d"), w = canvas.width, h = canvas.height, img = g.getImageData(0, 0, w, h), d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = d[i + 1] = d[i + 2] = y; hist[y]++; }
  const total = w * h; let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.01) { lo = v; break; } }
  acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.08) { hi = v; break; } }   // paper is the brightest large area
  hi = Math.max(hi, lo + 30);
  for (let i = 0; i < d.length; i += 4) {
    let v = clamp(((d[i] - lo) / (hi - lo)) * 255, 0, 255);
    if (mode === "bw") v = v > 150 ? 255 : v < 90 ? 0 : (v - 90) * 255 / 60;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
}
// one source image -> {bytes, mime, w, h} honouring rotation + filter
async function imageForPdf(it, filter) {
  const [sw, sh] = bmpSize(it.bmp), k = Math.min(1, 3600 / Math.max(sw, sh));
  const swap = it.rot % 180 !== 0, cw = Math.round((swap ? sh : sw) * k), ch = Math.round((swap ? sw : sh) * k);
  const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
  const g = cv.getContext("2d");
  const png = filter === "none" && /png|gif|webp|avif/i.test(it.file.type || it.name);
  if (!png) { g.fillStyle = "#fff"; g.fillRect(0, 0, cw, ch); }
  g.translate(cw / 2, ch / 2); g.rotate(it.rot * Math.PI / 180); g.drawImage(it.bmp, -sw * k / 2, -sh * k / 2, sw * k, sh * k);
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (filter !== "none") cleanUp(cv, filter);
  const blob = await new Promise((r) => cv.toBlob(r, png ? "image/png" : "image/jpeg", 0.92));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: png ? "image/png" : "image/jpeg", w: cw, h: ch };
}

function imagesTool({ id, title, desc, ic, scan }) {
  tool({
    id, group: "convert", title, desc, icon: ic,
    init(ctx) {
      const items = []; let seq = 0;
      const list = html(`<div class="flist"></div>`);
      const go = primaryBtn("สร้าง PDF", "check");
      const sum = html(`<div class="hint"></div>`);
      const opt = { size: "a4", orient: "auto", margin: "small", filter: scan ? "gray" : "none" };
      const seg = (key, labels) => {
        const el = html(`<div class="seg">${labels.map(([v, t]) => `<button type="button" data-v="${v}" class="${opt[key] === v ? "on" : ""}">${t}</button>`).join("")}</div>`);
        el.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; opt[key] = b.dataset.v; el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); sync(); };
        return el;
      };
      const fOrient = field("ทิศทางหน้า", seg("orient", [["auto", "อัตโนมัติ"], ["portrait", "แนวตั้ง"], ["landscape", "แนวนอน"]]));
      ctx.side.append(
        html(`<p class="side-title">ภาพที่จะรวมเป็น PDF</p>`), sum,
        field("ขนาดหน้า", seg("size", [["a4", "A4"], ["letter", "Letter"], ["fit", "ตามขนาดภาพ"]])), fOrient,
        field("ขอบกระดาษ", seg("margin", [["none", "ไม่มี"], ["small", "เล็ก"], ["big", "ใหญ่"]])),
        field("ปรับภาพ", seg("filter", scan ? [["gray", "ขาวดำเทา (เอกสาร)"], ["bw", "ขาวดำสนิท"], ["none", "สีต้นฉบับ"]] : [["none", "ต้นฉบับ"], ["gray", "ขาวดำเทา"], ["bw", "ขาวดำสนิท"]]),
          scan ? "โหมดเอกสารช่วยให้กระดาษดูขาว ตัวหนังสือคมขึ้น" : ""),
        go);
      const sync = () => { fOrient.hidden = opt.size === "fit"; };
      sync();

      const adder = dropZone({ kind: "image", multiple: true, title: scan ? "เลือกรูปที่ถ่ายไว้ หรือถ่ายใหม่" : "เลือกรูปภาพ (หลายรูปได้)", hint: "JPG, PNG, WebP, GIF, BMP · ลากมาวางได้ · เรียงลำดับได้ภายหลัง", onFiles: addFiles });
      if (scan) {
        const camBtn = html(`<button class="primary" type="button" style="margin-top:12px">${icon("camera", 18)} เปิดกล้องถ่ายเอกสาร</button>`);
        camBtn.onclick = () => openCamera(ctx, (f) => addFiles([f]));
        ctx.stage.append(adder, camBtn);
        ctx.stage.firstElementChild.style.marginBottom = "0";
      } else ctx.stage.append(adder);

      const add = html(`<button class="addmore" type="button">+ เพิ่มรูป</button>`);
      add.onclick = () => adder.pick();
      const camMore = scan ? html(`<button class="addmore" type="button">${icon("camera", 16)} ถ่ายเพิ่ม</button>`) : null;
      if (camMore) camMore.onclick = () => openCamera(ctx, (f) => addFiles([f]));
      sortable(list, (f, t) => { const [x] = items.splice(f, 1); items.splice(t, 0, x); paint(); });

      async function addFiles(fs) {
        const fresh = await ctx.run(async () => {
          const out = [];
          for (const f of fs) { const bmp = await loadBitmap(f); out.push({ id: ++seq, file: f, name: f.name, bmp, rot: 0 }); }
          return out;
        }, "กำลังเปิดภาพ…");
        if (!fresh) return;
        items.push(...fresh);
        ctx.work(); ctx.stage.innerHTML = ""; adder.hidden = true;
        ctx.stage.append(list, add); if (camMore) ctx.stage.append(camMore); ctx.stage.append(adder);
        paint();
      }
      function paint() {
        list.innerHTML = "";
        items.forEach((it, i) => {
          const row = html(`<div class="frow" draggable="true" data-i="${i}"><span class="handle">⋮⋮</span><div class="fthumb"><canvas></canvas></div><div class="fmeta"><div class="fname"></div><div class="fsub"></div></div><div class="fbtns"></div></div>`);
          row.querySelector(".fname").textContent = `${i + 1}. ${it.name}`;
          const [w, h] = bmpSize(it.bmp); row.querySelector(".fsub").textContent = `${w}×${h} px`;
          const cv = row.querySelector("canvas"), swap = it.rot % 180 !== 0, k = Math.min(52 / (swap ? h : w), 68 / (swap ? w : h));
          cv.width = Math.round((swap ? h : w) * k); cv.height = Math.round((swap ? w : h) * k);
          const g = cv.getContext("2d"); g.translate(cv.width / 2, cv.height / 2); g.rotate(it.rot * Math.PI / 180); g.drawImage(it.bmp, -w * k / 2, -h * k / 2, w * k, h * k);
          const bt = row.querySelector(".fbtns");
          const mk = (ic, t, fn, dis) => { const b = html(`<button class="ibtn" type="button" title="${t}" aria-label="${t}" ${dis ? "disabled" : ""}>${icon(ic, 15)}</button>`); b.onclick = fn; bt.append(b); };
          mk("rl", "หมุนซ้าย", () => { it.rot = (it.rot + 270) % 360; paint(); });
          mk("rr", "หมุนขวา", () => { it.rot = (it.rot + 90) % 360; paint(); });
          mk("up", "เลื่อนขึ้น", () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; paint(); }, i === 0);
          mk("down", "เลื่อนลง", () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; paint(); }, i === items.length - 1);
          mk("x", "เอาออก", () => { items.splice(i, 1); if (!items.length) ctx.reset(); else paint(); });
          list.append(row);
        });
        sum.textContent = `${items.length} ภาพ → ${items.length} หน้า`;
        go.disabled = !items.length;
      }
      go.onclick = () => ctx.run(async () => {
        const { PDFDocument } = PLIB();
        const out = await PDFDocument.create();
        const margin = { none: 0, small: 24, big: 56 }[opt.margin];
        for (let i = 0; i < items.length; i++) {
          ctx.busy(`กำลังสร้างหน้า ${i + 1} จาก ${items.length}`, i / items.length);
          const im = await imageForPdf(items[i], opt.filter);
          const emb = im.mime === "image/png" ? await out.embedPng(im.bytes) : await out.embedJpg(im.bytes);
          let pw, ph;
          if (opt.size === "fit") { pw = im.w * 0.75; ph = im.h * 0.75; }
          else {
            [pw, ph] = PAGE_SIZES[opt.size];
            const land = opt.orient === "landscape" || (opt.orient === "auto" && im.w > im.h);
            if (land) [pw, ph] = [ph, pw];
          }
          const page = out.addPage([pw, ph]);
          const bw = pw - 2 * (opt.size === "fit" ? 0 : margin), bh = ph - 2 * (opt.size === "fit" ? 0 : margin);
          const k = Math.min(bw / im.w, bh / im.h), dw = im.w * k, dh = im.h * k;
          page.drawImage(emb, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
          await tick();
        }
        await showResult(ctx, { title: `สร้าง PDF ${items.length} หน้าแล้ว`, files: [{ name: `${scan ? "สแกน" : "รูปภาพ"}.pdf`, mime: "application/pdf", bytes: await savePdf(out) }] });
      }, "กำลังสร้าง PDF…");
    },
  });
}
imagesTool({ id: "img2pdf", title: "ภาพ → PDF", desc: "รวมรูปภาพ JPG, PNG เป็นไฟล์ PDF เรียงลำดับและหมุนได้", ic: "image" });
imagesTool({ id: "scan", title: "สแกนเป็น PDF", desc: "ถ่ายเอกสารด้วยกล้อง ปรับให้คมชัดแบบสแกนเนอร์ แล้วรวมเป็น PDF", ic: "camera", scan: true });

// camera sheet: keeps taking pictures until "เสร็จ"
async function openCamera(ctx, onShot) {
  const sheet = html(`<div class="cam" role="dialog" aria-label="กล้อง"><div class="box"><video autoplay playsinline muted></video>
    <div class="bar2"><button class="mini" type="button" data-a="close">เสร็จ</button><button class="shutter" type="button" aria-label="ถ่ายภาพ"></button><span class="cnt">ถ่ายแล้ว 0 รูป</span></div>
    <div class="hint" style="color:#aab2c7;text-align:center"></div></div></div>`);
  const video = sheet.querySelector("video"), note = sheet.querySelector(".hint");
  let stream = null, n = 0;
  const close = () => { stream?.getTracks().forEach((t) => t.stop()); sheet.remove(); };
  ctx.onClose(close);
  document.body.append(sheet);
  sheet.querySelector('[data-a="close"]').onclick = close;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera api");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } }, audio: false });
    video.srcObject = stream;
  } catch {
    note.textContent = "เปิดกล้องไม่ได้ (อาจยังไม่อนุญาตให้ใช้กล้อง) — ปิดหน้าต่างนี้แล้วเลือกรูปที่ถ่ายไว้แทน";
  }
  sheet.querySelector(".shutter").onclick = () => {
    if (!video.videoWidth) return;
    const cv = document.createElement("canvas"); cv.width = video.videoWidth; cv.height = video.videoHeight;
    cv.getContext("2d").drawImage(video, 0, 0);
    cv.toBlob((b) => { onShot(new File([b], `ถ่ายภาพ ${++n}.jpg`, { type: "image/jpeg" })); sheet.querySelector(".cnt").textContent = `ถ่ายแล้ว ${n} รูป`; }, "image/jpeg", 0.92);
  };
}

// ------------------------------------------------------------------ PDF -> images
tool({
  id: "pdf2img", group: "convert", title: "PDF → ภาพ", desc: "แปลงทุกหน้า (หรือบางหน้า) เป็นรูป JPG หรือ PNG", icon: "toimg",
  init(ctx) {
    singleFile(ctx, (doc) => {
      const opt = { fmt: "jpg", dpi: 150 };
      const seg = (key, labels) => {
        const el = html(`<div class="seg">${labels.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(opt[key]) === String(v) ? "on" : ""}">${t}</button>`).join("")}</div>`);
        el.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; opt[key] = key === "dpi" ? +b.dataset.v : b.dataset.v; el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
        return el;
      };
      const pages = html(`<input type="text" placeholder="เช่น 1-3, 5" autocomplete="off">`);
      const go = primaryBtn("บันทึกเป็นภาพ", "toimg");
      const count = html(`<div class="hint"></div>`);
      let pg = null;
      const upd = () => {
        const n = pg ? pg.selected().length : 0;
        count.textContent = n ? `เลือกแล้ว ${n} จาก ${doc.n} หน้า` : "ยังไม่ได้เลือกหน้า — คลิกที่หน้าทางขวา";
        go.disabled = !n;
        go.lastChild.textContent = n ? ` บันทึกเป็นภาพ (${n} หน้า)` : " บันทึกเป็นภาพ";
      };
      pg = pageGrid(ctx, doc, "extract", { onText: (t) => { pages.value = t; }, onChange: upd });
      pages.addEventListener("input", () => { try { pg.setFromText(pages.value); ctx.clearFail(); } catch { /* still typing */ } });
      const all = html(`<button class="mini" type="button">เลือกทั้งหมด</button>`), none = html(`<button class="mini" type="button">ไม่เลือก</button>`);
      all.onclick = () => { pages.value = `1-${doc.n}`; pg.setFromText(pages.value); };
      none.onclick = () => { pages.value = ""; pg.setFromText(""); };
      ctx.side.append(field("ชนิดไฟล์", seg("fmt", [["jpg", "JPG (เล็ก)"], ["png", "PNG (คมชัด)"]])),
        field("ความละเอียด", seg("dpi", [[100, "ต่ำ"], [150, "กลาง"], [220, "สูง"], [300, "สูงมาก"]]), "ยิ่งสูงยิ่งคมชัด ไฟล์ใหญ่ขึ้น"),
        field("หน้าที่จะบันทึก", pages, "คลิกเลือกหน้าที่รูปทางขวา หรือพิมพ์ช่วงหน้า"), count, go);
      const bar = html(`<div class="gbar"><span class="muted">คลิกที่หน้าเพื่อเลือก / ยกเลิก</span><span class="spacer"></span></div>`);
      bar.append(all, none);
      ctx.stage.append(bar, pg.el);
      all.click();                                   // start with every page selected
      go.onclick = () => ctx.run(async () => {
        const list = pg.selected().map((it) => it.n);
        const mime = opt.fmt === "png" ? "image/png" : "image/jpeg", ext = opt.fmt === "png" ? "png" : "jpg", base = baseName(doc.name), files = [];
        for (let i = 0; i < list.length; i++) {
          ctx.busy(`กำลังแปลงหน้า ${list[i]} (${i + 1}/${list.length})`, i / list.length);
          const page = await doc.view.getPage(list[i]);
          let scale = opt.dpi / 72; const v1 = page.getViewport({ scale: 1 });
          scale = Math.min(scale, 9000 / Math.max(v1.width, v1.height), Math.sqrt(60e6 / (v1.width * v1.height)));
          const vp = page.getViewport({ scale });
          const cv = document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
          const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
          await page.render({ canvasContext: g, viewport: vp }).promise;
          const blob = await new Promise((r) => cv.toBlob(r, mime, 0.92));
          files.push({ name: `${base}_หน้า${String(list[i]).padStart(String(doc.n).length, "0")}.${ext}`, mime, bytes: new Uint8Array(await blob.arrayBuffer()) });
          cv.width = cv.height = 1; page.cleanup();
        }
        await showResult(ctx, { title: `แปลงแล้ว ${files.length} ภาพ`, files, zipName: `${base}_ภาพ.zip` });
      }, "กำลังแปลง…");
    });
  },
});
