// ===================================================================== compare
// two PDFs: word-level text differences + pixel differences, page by page

const words = (s) => s.split(/\s+/).filter(Boolean);
async function pageWords(pdf, n) {
  const tc = await (await pdf.getPage(n)).getTextContent();
  return words(tc.items.map((i) => i.str).join(" "));
}
// word diff -> [{t: "=" | "-" | "+", s}]; falls back to one replace block for huge pages
function diffWords(a, b) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q), ops = [];
  if (p) ops.push(["=", a.slice(0, p).join(" ")]);
  if (A.length * B.length > 4e6) { if (A.length) ops.push(["-", A.join(" ")]); if (B.length) ops.push(["+", B.join(" ")]); }
  else {
    const n = A.length, m = B.length, w = m + 1, L = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0; const push = (t, s) => { const l = ops[ops.length - 1]; if (l && l[0] === t) l[1] += " " + s; else ops.push([t, s]); };
    while (i < n && j < m) {
      if (A[i] === B[j]) { push("=", A[i]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push("-", A[i++]); else push("+", B[j++]);
    }
    while (i < n) push("-", A[i++]); while (j < m) push("+", B[j++]);
  }
  if (q) ops.push(["=", a.slice(a.length - q).join(" ")]);
  return ops;
}
async function renderSmall(pdf, n, width) {
  const page = await pdf.getPage(n), base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: width / base.width });
  const cv = document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
  const g = cv.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  return cv;
}
// draws A, B resized to A, and the change map; returns share of changed pixels
function pixelDiff(ca, cb, out) {
  const w = ca.width, h = ca.height, ga = ca.getContext("2d", { willReadFrequently: true });
  const tmp = document.createElement("canvas"); tmp.width = w; tmp.height = h;
  const gt = tmp.getContext("2d", { willReadFrequently: true }); gt.fillStyle = "#fff"; gt.fillRect(0, 0, w, h); gt.drawImage(cb, 0, 0, w, h);
  const da = ga.getImageData(0, 0, w, h).data, db = gt.getImageData(0, 0, w, h).data;
  const img = out ? out.getContext("2d").createImageData(w, h) : null;
  let n = 0;
  for (let i = 0; i < da.length; i += 4) {
    const la = (da[i] * 299 + da[i + 1] * 587 + da[i + 2] * 114) / 1000, lb = (db[i] * 299 + db[i + 1] * 587 + db[i + 2] * 114) / 1000, d = lb - la;
    const changed = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])) > 40;
    if (changed) n++;
    if (img) {
      if (changed) {                       // darker in B = new ink (green), lighter = removed (red), same brightness = colour changed (amber)
        const c = d < -20 ? [22, 163, 74] : d > 20 ? [214, 53, 43] : [217, 119, 6];
        img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
      } else { const g = 255 - (255 - lb) * 0.25; img.data[i] = img.data[i + 1] = img.data[i + 2] = g; img.data[i + 3] = 255; }
    }
  }
  if (out) { out.width = w; out.height = h; out.getContext("2d").putImageData(img, 0, 0); }
  return n / (w * h);
}

tool({
  id: "compare", group: "check", title: "เปรียบเทียบ PDF", desc: "ดูว่าสองไฟล์ต่างกันตรงไหน ทั้งตัวหนังสือและภาพ ทีละหน้า", icon: "compare",
  init(ctx) {
    const docs = [null, null];
    const slots = html(`<div class="cmpslots"></div>`);
    const go = primaryBtn("เปรียบเทียบ", "compare"); go.disabled = true; go.style.maxWidth = "320px"; go.style.margin = "14px auto 0";
    const slotEls = ["ไฟล์เดิม", "ไฟล์ใหม่"].map((label, k) => {
      const box = html(`<div class="cmpslot"><div class="lbl">${label}</div></div>`);
      const put = () => {
        box.querySelector(".drop, .chip")?.remove();
        if (docs[k]) box.append(fileChip(docs[k].name, `${docs[k].n} หน้า · ${fmtSize(docs[k].bytes.length)}`, () => { docs[k] = null; put(); }));
        else box.append(dropZone({ kind: "pdf", title: "เลือกไฟล์ PDF", hint: "หรือลากมาวาง", onFiles: async ([f]) => { const d = await ctx.run(() => loadOne(f), "กำลังอ่านไฟล์…"); if (d) { docs[k] = d; put(); } } }));
        go.disabled = !(docs[0] && docs[1]);
      };
      put(); slots.append(box); return box;
    });
    ctx.stage.append(slots, go);
    go.onclick = () => ctx.run(() => compare(), "กำลังเปรียบเทียบ…");

    async function compare() {
      const [A, B] = docs, N = Math.max(A.n, B.n), res = [];
      for (let n = 1; n <= N; n++) {
        ctx.busy(`กำลังเทียบหน้า ${n} จาก ${N}`, (n - 1) / N);
        if (n > A.n || n > B.n) { res.push({ n, status: n > A.n ? "onlyB" : "onlyA" }); continue; }
        const [wa, wb] = [await pageWords(A.view, n), await pageWords(B.view, n)];
        const ops = diffWords(wa, wb), textChanges = ops.filter((o) => o[0] !== "=").length;
        const [ca, cb] = [await renderSmall(A.view, n, 360), await renderSmall(B.view, n, 360)];
        const px = pixelDiff(ca, cb, null);
        res.push({ n, status: textChanges || px > 0.0008 ? "diff" : "same", textChanges, px });
        await tick();
      }
      show(A, B, res);
    }

    function show(A, B, res) {
      ctx.stage.innerHTML = ""; ctx.work(); ctx.side.hidden = true; ctx.grid.classList.add("solo");
      const diffs = res.filter((r) => r.status !== "same");
      const head = html(`<div class="done"><div class="donehead"><span class="pill" style="${diffs.length ? "background:var(--warn-soft);color:var(--warn)" : ""}">${diffs.length ? `พบความต่าง ${diffs.length} หน้า จาก ${res.length}` : `เหมือนกันทุกหน้า (${res.length} หน้า)`}</span>
        <button class="ghost" type="button" style="margin-left:auto">เทียบไฟล์ใหม่</button></div>
        <div class="muted">${esc(A.name)} (${A.n} หน้า) ↔ ${esc(B.name)} (${B.n} หน้า)</div>
        <div class="plist"></div><div class="cmpdetail"></div></div>`);
      head.querySelector(".ghost").onclick = () => ctx.reset();
      ctx.stage.append(head);
      ctx.grid.style.gridTemplateColumns = "minmax(0, 1100px)";
      const list = head.querySelector(".plist"), detail = head.querySelector(".cmpdetail");
      let on = null;
      const pick = async (r) => {
        list.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.n === r.n));
        on = r.n; detail.innerHTML = "";
        if (r.status === "onlyA" || r.status === "onlyB") { detail.append(html(`<div class="msg warn"><b>หน้า ${r.n} มีเฉพาะ${r.status === "onlyA" ? "ในไฟล์เดิม (ถูกลบไปในไฟล์ใหม่)" : "ในไฟล์ใหม่ (เพิ่มเข้ามา)"}</b></div>`)); return; }
        const box = html(`<div><div class="cmpgrid"><figure><figcaption>ไฟล์เดิม</figcaption><canvas></canvas></figure><figure><figcaption>ไฟล์ใหม่</figcaption><canvas></canvas></figure>
          <figure><figcaption>ส่วนที่ต่าง <span style="color:#16a34a">เขียว = เพิ่ม</span> · <span style="color:#d6352b">แดง = หายไป</span> · <span style="color:#d97706">เหลือง = สีเปลี่ยน</span></figcaption><canvas></canvas></figure></div>
          <div class="lbl" style="margin-top:14px">ข้อความที่เปลี่ยน <span class="muted">(<del>ลบ</del> / <ins>เพิ่ม</ins>)</span></div><div class="tdiff"></div></div>`);
        detail.append(box);
        const cs = box.querySelectorAll("canvas"), [ca, cb] = [await renderSmall(A.view, r.n, 520), await renderSmall(B.view, r.n, 520)];
        if (on !== r.n) return;
        for (const [dst, src] of [[cs[0], ca], [cs[1], cb]]) { dst.width = src.width; dst.height = src.height; dst.getContext("2d").drawImage(src, 0, 0); }
        pixelDiff(ca, cb, cs[2]);
        const t = box.querySelector(".tdiff"), ops = diffWords(await pageWords(A.view, r.n), await pageWords(B.view, r.n));
        if (ops.every((o) => o[0] === "=")) t.textContent = ops.length ? "ข้อความเหมือนกัน (ความต่างอยู่ที่ภาพ/การจัดวาง)" : "หน้านี้ไม่มีข้อความ";
        else for (const [k, s] of ops) { const el = document.createElement(k === "-" ? "del" : k === "+" ? "ins" : "span"); el.textContent = (k === "=" && s.length > 220 ? s.slice(0, 90) + " … " + s.slice(-90) : s) + " "; t.append(el); }
      };
      for (const r of res) {
        const b = html(`<button type="button" class="${r.status === "same" ? "same" : "diff"}" data-n="${r.n}" title="${r.status === "same" ? "เหมือนกัน" : "ต่างกัน"}">${r.n}</button>`);
        b.onclick = () => pick(r); list.append(b);
      }
      pick(diffs[0] || res[0]);
    }
    ctx.onClose(() => { ctx.grid.style.gridTemplateColumns = ""; });
  },
});
