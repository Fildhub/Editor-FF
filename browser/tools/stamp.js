// ===================================================================== stamp tools
// page numbers, watermark. Everything is drawn in "displayed page space"
// (origin bottom-left of the page as the viewer shows it), so rotated pages work.

// pageSpace(page): size of the displayed page + enter()/leave() operator pairs
function pageSpace(page) {
  const L = PLIB(), box = page.getCropBox(), W = box.width, H = box.height, r = ((page.getRotation().angle % 360) + 360) % 360;
  const m = r === 90 ? [0, 1, -1, 0, box.x + W, box.y] : r === 180 ? [-1, 0, 0, -1, box.x + W, box.y + H] : r === 270 ? [0, -1, 1, 0, box.x, box.y + H] : [1, 0, 0, 1, box.x, box.y];
  return {
    w: r % 180 ? H : W, h: r % 180 ? W : H,
    enter: () => page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(...m)),
    leave: () => page.pushOperators(L.popGraphicsState()),
  };
}
const hexRgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; };
const needsThai = (s) => /[^\u0000-ÿ]/.test(s);

// page picture with a redraw hook for overlays: nav + canvas
function previewPane(ctx, doc, draw) {
  let cur = 1, w = 0, h = 0, base = null;
  const nav = html(`<div class="gbar"><button class="ibtn" type="button" aria-label="หน้าก่อน">${icon("left", 16)}</button><span class="muted"></span><button class="ibtn" type="button" aria-label="หน้าถัดไป">${icon("right", 16)}</button><span class="spacer"></span><span class="muted">ตัวอย่าง</span></div>`);
  const wrap = html(`<div class="pvwrap"><div class="pv"><canvas></canvas></div></div>`);
  ctx.stage.append(nav, wrap);
  const cv = wrap.querySelector("canvas"), label = nav.children[1], [prev, next] = [nav.children[0], nav.children[2]];
  const g = cv.getContext("2d");
  async function load() {
    label.textContent = `หน้า ${cur} / ${doc.n}`; prev.disabled = cur <= 1; next.disabled = cur >= doc.n;
    const page = await doc.view.getPage(cur), vp = page.getViewport({ scale: 1 });
    w = vp.width; h = vp.height;
    await renderPageTo(page, cv, Math.min(520, Math.max(260, ctx.stage.clientWidth - 70)));
    base = g.getImageData(0, 0, cv.width, cv.height);
    paint();
  }
  function paint() {
    if (!base) return;
    g.putImageData(base, 0, 0);
    g.save(); const s = cv.width / w; g.scale(s, s); draw(g, { page: cur, total: doc.n, w, h, s }); g.restore();
  }
  prev.onclick = () => { cur--; load(); }; next.onclick = () => { cur++; load(); };
  load();
  return { paint, current: () => cur };
}

function segment(opt, key, labels, onChange) {
  const el = html(`<div class="seg">${labels.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(opt[key]) === String(v) ? "on" : ""}">${t}</button>`).join("")}</div>`);
  el.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const raw = b.dataset.v; opt[key] = /^-?\d+(\.\d+)?$/.test(raw) ? +raw : raw;
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); onChange?.();
  };
  return el;
}
function posPicker(opt, key, keys, onChange) {
  const el = html(`<div class="posgrid">${keys.map((k) => `<button type="button" data-k="${k}" class="${opt[key] === k ? "on" : ""}" aria-label="${k}"></button>`).join("")}</div>`);
  el.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; opt[key] = b.dataset.k; el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); onChange(); };
  return el;
}
const pagesToDo = (spec, n) => (spec.trim() ? new Set(rangePages(parseRanges(spec, n))) : null);

// ------------------------------------------------------------------ page numbers
const NUM_FORMATS = [["{n}", "1, 2, 3 …"], ["หน้า {n}", "หน้า 1"], ["{n} / {N}", "1 / 10"], ["หน้า {n} จาก {N}", "หน้า 1 จาก 10"], ["Page {n}", "Page 1"], ["Page {n} of {N}", "Page 1 of 10"], ["- {n} -", "- 1 -"], ["custom", "กำหนดเอง…"]];
function numberPos(pos, w, size, pw, ph, margin) {
  const x = pos.endsWith("l") ? margin : pos.endsWith("r") ? pw - margin - w : (pw - w) / 2;
  const y = pos.startsWith("t") ? ph - margin - size * 0.78 : margin;
  return [x, y];
}
tool({
  id: "pagenum", group: "edit", title: "ใส่เลขหน้า", desc: "ใส่เลขหน้าที่มุมหรือกึ่งกลางหน้า เลือกรูปแบบและหน้าเริ่มต้นได้", icon: "number",
  init(ctx) {
    singleFile(ctx, (doc) => {
      const opt = { pos: "bc", fmt: "{n}", custom: "หน้า {n}", start: 1, from: 1, to: doc.n, size: 11, color: "#000000", margin: 28 };
      const fmt = html(`<select>${NUM_FORMATS.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`);
      const custom = html(`<input type="text" value="${opt.custom}" autocomplete="off">`); custom.hidden = true;
      const num = (key, min, max, val) => { const i = html(`<input type="number" min="${min}" max="${max}" value="${val}">`); i.oninput = () => { opt[key] = +i.value || 0; pv.paint(); }; return i; };
      const color = html(`<input type="color" value="${opt.color}">`);
      const go = primaryBtn("ใส่เลขหน้า", "number");
      const fmtText = () => (opt.fmt === "custom" ? opt.custom : opt.fmt);
      const label = (p, total) => fmtText().replaceAll("{n}", String(opt.start + p - opt.from)).replaceAll("{N}", String(total)) || "";
      const inRange = (p) => p >= opt.from && p <= opt.to;
      const warn = html(`<div class="hint"></div>`);
      ctx.side.append(
        field("ตำแหน่ง", posPicker(opt, "pos", ["tl", "tc", "tr", "bl", "bc", "br"], () => pv.paint())),
        field("รูปแบบ", fmt), custom, warn,
        html(`<div class="row2c"></div>`),
        go);
      const two = ctx.side.querySelector(".row2c");
      two.append(field("เริ่มนับที่เลข", num("start", -999, 99999, 1)), field("ขนาดตัวอักษร", num("size", 6, 48, 11)),
        field("เริ่มใส่ที่หน้า", num("from", 1, doc.n, 1)), field("ถึงหน้า", num("to", 1, doc.n, doc.n)),
        field("ระยะจากขอบ (pt)", num("margin", 0, 200, 28)), field("สี", color));
      fmt.onchange = () => { opt.fmt = fmt.value; custom.hidden = fmt.value !== "custom"; pv.paint(); };
      custom.oninput = () => { opt.custom = custom.value; pv.paint(); };
      color.oninput = () => { opt.color = color.value; pv.paint(); };
      const pv = previewPane(ctx, doc, (g, { page, total, w, h }) => {
        if (!inRange(page)) return;
        const t = label(page, total), size = opt.size;
        g.font = `${size}px "IBM Plex Sans Thai", Arial, sans-serif`; g.fillStyle = opt.color;
        const tw_ = g.measureText(t).width, [x, y] = numberPos(opt.pos, tw_, size, w, h, opt.margin);
        g.fillText(t, x, h - y);
      });
      go.onclick = () => ctx.run(async () => {
        if (opt.from > opt.to) throw { title: "ช่วงหน้าไม่ถูกต้อง", body: "หน้าเริ่มต้องไม่มากกว่าหน้าสุดท้าย" };
        const { PDFDocument } = PLIB();
        const out = await PDFDocument.load(doc.bytes, { ignoreEncryption: true, updateMetadata: false });
        const sample = fmtText();
        const F = await PDFX.loadFonts(out, needsThai(sample));
        const font = F.reg;
        out.getPages().forEach((p, i) => {
          const n = i + 1; if (!inRange(n)) return;
          const t = F.clean(label(n, doc.n)); if (!t) return;
          const sp = pageSpace(p), w = PDFX.tw(font, t, opt.size), [x, y] = numberPos(opt.pos, w, opt.size, sp.w, sp.h, opt.margin);
          sp.enter(); PDFX.drawLine(p, F, font, t, x, y, opt.size, hexRgb(opt.color)); sp.leave();
        });
        await showResult(ctx, { title: "ใส่เลขหน้าแล้ว", files: [{ name: `${baseName(doc.name)}_เลขหน้า.pdf`, mime: "application/pdf", bytes: await savePdf(out) }] });
      }, "กำลังใส่เลขหน้า…");
    });
  },
});

// ------------------------------------------------------------------ watermark
const WM9 = { tl: [0.2, 0.8], tc: [0.5, 0.8], tr: [0.8, 0.8], cl: [0.2, 0.5], cc: [0.5, 0.5], cr: [0.8, 0.5], bl: [0.2, 0.2], bc: [0.5, 0.2], br: [0.8, 0.2] };
// centres of the stamps on a page of w x h (y up); tiled = covers the whole page
function wmCentres(opt, w, h, bw, bh) {
  if (!opt.tile) { const [fx, fy] = WM9[opt.pos]; return [[w * fx, h * fy]]; }
  const a = opt.angle * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), sx = bw * 1.5 + 30, sy = bh * 2.6 + 30, out = [];
  const R = Math.hypot(w, h) / 2 + Math.max(sx, sy);
  for (let j = -Math.ceil(R / sy); j <= Math.ceil(R / sy); j++) for (let i = -Math.ceil(R / sx); i <= Math.ceil(R / sx); i++) {
    const lx = i * sx + (j % 2 ? sx / 2 : 0), ly = j * sy, x = w / 2 + lx * cs - ly * sn, y = h / 2 + lx * sn + ly * cs;
    if (x > -bw && x < w + bw && y > -bh && y < h + bh) out.push([x, y]);
  }
  return out;
}
tool({
  id: "watermark", group: "edit", title: "ใส่ลายน้ำ", desc: "ประทับข้อความหรือรูปภาพทับทุกหน้า เช่น ลับ สำเนา ร่าง", icon: "watermark",
  init(ctx) {
    singleFile(ctx, (doc) => {
      const opt = { kind: "text", text: "สำเนา", size: 72, color: "#cc2f2f", opacity: 28, angle: 45, pos: "cc", tile: false, imgW: 50, pages: "" };
      let img = null;                                   // {bmp, bytes, mime, w, h}
      const textIn = html(`<input type="text" value="${opt.text}" autocomplete="off">`);
      const sizeIn = html(`<input type="range" min="12" max="200" value="${opt.size}">`);
      const colorIn = html(`<input type="color" value="${opt.color}">`);
      const opIn = html(`<input type="range" min="5" max="100" value="${opt.opacity}">`);
      const imgW = html(`<input type="range" min="10" max="100" value="${opt.imgW}">`);
      const imgBtn = html(`<button class="mini" type="button">${icon("image", 14)} เลือกรูป…</button>`);
      const imgFile = html(`<input type="file" accept="image/*" hidden>`);
      const tile = html(`<label class="chk"><input type="checkbox"> วนซ้ำเต็มหน้า</label>`);
      const pagesIn = html(`<input type="text" placeholder="ทุกหน้า" autocomplete="off">`);
      const go = primaryBtn("ใส่ลายน้ำ", "watermark");
      const kindSeg = segment(opt, "kind", [["text", "ข้อความ"], ["image", "รูปภาพ"]], () => { sync(); pv.paint(); });
      const angSeg = segment(opt, "angle", [[0, "0°"], [45, "45°"], [90, "90°"], [-45, "-45°"]], () => pv.paint());
      const posP = posPicker(opt, "pos", Object.keys(WM9), () => pv.paint());
      const fText = html(`<div></div>`), fImg = html(`<div></div>`);
      fText.append(field("ข้อความ", textIn), field("ขนาดตัวอักษร", sizeIn), field("สี", colorIn));
      fImg.append(field("รูปลายน้ำ", imgBtn, "PNG พื้นโปร่งใสจะสวยที่สุด"), field("ขนาด (% ของความกว้างหน้า)", imgW));
      ctx.side.append(field("ชนิด", kindSeg), fText, fImg, field("โปร่งใส (ยิ่งน้อยยิ่งจาง)", opIn), field("มุมเอียง", angSeg),
        field("ตำแหน่ง", posP), tile, field("ใส่ที่หน้า", pagesIn, "เว้นว่าง = ทุกหน้า"), go, imgFile);
      const sync = () => { fText.hidden = opt.kind !== "text"; fImg.hidden = opt.kind !== "image"; go.disabled = opt.kind === "image" && !img; };
      sync();
      const bind = (el, key, conv = (v) => v) => el.addEventListener("input", () => { opt[key] = conv(el.value); pv.paint(); });
      bind(textIn, "text"); bind(sizeIn, "size", Number); bind(colorIn, "color"); bind(opIn, "opacity", Number); bind(imgW, "imgW", Number);
      tile.querySelector("input").onchange = (e) => { opt.tile = e.target.checked; pv.paint(); };
      imgBtn.onclick = () => imgFile.click();
      imgFile.onchange = () => ctx.run(async () => {
        const f = imgFile.files[0]; if (!f) return;
        const bmp = await loadBitmap(f), [w, h] = bmpSize(bmp);
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d").drawImage(bmp, 0, 0);
        const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
        img = { bmp, w, h, bytes: new Uint8Array(await blob.arrayBuffer()) };
        imgBtn.lastChild.textContent = ` ${f.name}`; sync(); pv.paint();
      });

      const rgbCss = () => opt.color;
      const pv = previewPane(ctx, doc, (g, { page, w, h }) => {
        const only = (() => { try { return pagesToDo(pagesIn.value, doc.n); } catch { return null; } })();
        if (only && !only.has(page)) return;
        g.globalAlpha = opt.opacity / 100;
        if (opt.kind === "text") {
          const t = opt.text || " "; g.font = `${opt.size}px "IBM Plex Sans Thai", Arial, sans-serif`;
          const bw = g.measureText(t).width, bh = opt.size;
          for (const [cx, cy] of wmCentres(opt, w, h, bw, bh)) {
            g.save(); g.translate(cx, h - cy); g.rotate(-opt.angle * Math.PI / 180);
            g.fillStyle = rgbCss(); g.textBaseline = "middle"; g.fillText(t, -bw / 2, 0); g.restore();
          }
        } else if (img) {
          const bw = w * opt.imgW / 100, bh = bw * img.h / img.w;
          for (const [cx, cy] of wmCentres(opt, w, h, bw, bh)) {
            g.save(); g.translate(cx, h - cy); g.rotate(-opt.angle * Math.PI / 180); g.drawImage(img.bmp, -bw / 2, -bh / 2, bw, bh); g.restore();
          }
        }
        g.globalAlpha = 1;
      });
      pagesIn.addEventListener("input", () => pv.paint());

      go.onclick = () => ctx.run(async () => {
        const only = pagesToDo(pagesIn.value, doc.n);
        const { PDFDocument, degrees } = PLIB();
        const out = await PDFDocument.load(doc.bytes, { ignoreEncryption: true, updateMetadata: false });
        let F = null, font = null, emb = null;
        if (opt.kind === "text") {
          if (!opt.text.trim()) throw { title: "ยังไม่ได้พิมพ์ข้อความลายน้ำ", body: "" };
          F = await PDFX.loadFonts(out, needsThai(opt.text)); font = F.bold;
          if (F.clean(opt.text) !== opt.text.normalize("NFC").trim()) ctx.stage.prepend(html(`<div class="msg warn"><b>ตัวอักษรบางตัวใส่ไม่ได้</b><div>ลายน้ำรองรับอังกฤษ ไทย และสัญลักษณ์ทั่วไป</div></div>`));
        } else emb = await out.embedPng(img.bytes);
        const op = opt.opacity / 100, a = opt.angle * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
        out.getPages().forEach((p, i) => {
          if (only && !only.has(i + 1)) return;
          const sp = pageSpace(p); sp.enter();
          if (F) {
            const t = F.clean(opt.text), bw = PDFX.tw(font, t, opt.size), bh = opt.size;
            for (const [cx, cy] of wmCentres(opt, sp.w, sp.h, bw, bh)) {
              // baseline origin so that the middle of the text sits on the centre
              const ox = cx - (cs * bw / 2 - sn * bh * 0.3), oy = cy - (sn * bw / 2 + cs * bh * 0.3);
              PDFX.drawLine(p, F, font, t, ox, oy, opt.size, hexRgb(opt.color), { angle: opt.angle, opacity: op });
            }
          } else {
            const bw = sp.w * opt.imgW / 100, bh = bw * img.h / img.w;
            for (const [cx, cy] of wmCentres(opt, sp.w, sp.h, bw, bh)) {
              p.drawImage(emb, { x: cx - (cs * bw / 2 - sn * bh / 2), y: cy - (sn * bw / 2 + cs * bh / 2), width: bw, height: bh, rotate: degrees(opt.angle), opacity: op });
            }
          }
          sp.leave();
        });
        await showResult(ctx, { title: "ใส่ลายน้ำแล้ว", files: [{ name: `${baseName(doc.name)}_ลายน้ำ.pdf`, mime: "application/pdf", bytes: await savePdf(out) }] });
      }, "กำลังใส่ลายน้ำ…");
    });
  },
});
