// ===================================================================== page tools
// merge, split, remove pages, extract pages, organize, rotate, crop

async function loadOne(file) {
  const bytes = await readBytes(file);
  const lib = await openPdfLib(bytes);
  const view = await PDFX.openPdf(bytes);
  return { file, name: file.name, bytes, lib, view, n: lib.getPageCount() };
}

// first screen of a one-PDF tool: a big drop zone, then build(doc) fills side + stage
function singleFile(ctx, build) {
  ctx.stage.innerHTML = "";
  ctx.stage.append(dropZone({
    kind: "pdf", title: "เลือกไฟล์ PDF", onFiles: async ([f]) => {
      const doc = await ctx.run(() => loadOne(f), "กำลังอ่านไฟล์…");
      if (!doc) return;
      ctx.side.innerHTML = ""; ctx.stage.innerHTML = ""; ctx.work();
      ctx.side.append(fileChip(doc.name, `${doc.n} หน้า · ${fmtSize(doc.bytes.length)}`, () => ctx.reset()));
      build(doc);
    },
  }));
}

function toRangeString(nums) {
  const a = [...new Set(nums)].sort((x, y) => x - y), out = [];
  for (let i = 0; i < a.length;) {
    let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`); i = j + 1;
  }
  return out.join(", ");
}

// ------------------------------------------------------------------ page grid
// modes: remove | extract | organize | rotate | view
function pageGrid(ctx, doc, mode, extra = {}) {
  const items = Array.from({ length: doc.n }, (_, i) => ({ n: i + 1, rot: 0, del: false, pick: false }));
  const grid = html(`<div class="pgrid"></div>`);
  const els = new Map();
  const organize = mode === "organize", rotMode = mode === "rotate" || organize, selMode = mode === "remove" || mode === "extract";

  function makeEl(it) {
    const el = html(`<div class="pitem ${selMode ? "sel-mode" : ""}" ${organize ? 'draggable="true"' : ""}><div class="thumb"><canvas></canvas></div><div class="num"></div><div class="tools"></div></div>`);
    const tools = el.querySelector(".tools");
    const btn = (ic, title, fn, cls = "") => { const b = html(`<button class="ibtn ${cls}" type="button" title="${title}" aria-label="${title}">${icon(ic, 15)}</button>`); b.onclick = (e) => { e.stopPropagation(); fn(); }; tools.append(b); return b; };
    if (organize) btn("left", "เลื่อนไปก่อนหน้า", () => move(items.indexOf(it), items.indexOf(it) - 1));
    if (rotMode) { btn("rl", "หมุนซ้าย", () => rotate(it, -90)); btn("rr", "หมุนขวา", () => rotate(it, 90)); }
    if (organize) {
      btn("copy", "ทำสำเนาหน้านี้", () => { const c = { ...it, del: false }; items.splice(items.indexOf(it) + 1, 0, c); layout(); });
      btn("x", "ลบ / เอาคืน", () => { it.del = !it.del; layout(); }, "danger");
      btn("right", "เลื่อนไปหลัง", () => move(items.indexOf(it), items.indexOf(it) + 1));
    }
    if (selMode) el.onclick = () => { toggle(it); };
    lazyThumb(el.querySelector("canvas"), doc.view, it.n, 150, it.rot, 170);
    els.set(it, el);
    return el;
  }
  function rotate(it, d) {
    it.rot = (it.rot + d + 360) % 360;
    redrawThumb(els.get(it).querySelector("canvas"), doc.view, it.n, 150, it.rot, 170);
    extra.onChange?.();
  }
  function move(from, to) {
    if (to < 0 || to >= items.length || from === to) return;
    const [x] = items.splice(from, 1); items.splice(to, 0, x); layout();
  }
  function toggle(it) {
    if (mode === "remove") it.del = !it.del; else it.pick = !it.pick;
    layout(); syncText();
  }
  function layout() {
    items.forEach((it, i) => {
      let el = els.get(it) || makeEl(it);
      el.dataset.i = i;
      el.classList.toggle("del", it.del);
      el.classList.toggle("picked", it.pick);
      el.querySelector(".num").textContent = organize && it.n !== i + 1 ? `${i + 1} (เดิม ${it.n})` : `หน้า ${it.n}`;
      grid.append(el);
    });
    for (const [it, el] of els) if (!items.includes(it)) { el.remove(); els.delete(it); }
    extra.onChange?.();
  }
  function syncText() { extra.onText?.(toRangeString(items.filter((i) => (mode === "remove" ? i.del : i.pick)).map((i) => i.n))); }
  if (organize) sortable(grid, move);
  layout();
  return {
    el: grid, items,
    setFromText(txt) {
      const flag = mode === "remove" ? "del" : "pick";
      items.forEach((i) => (i[flag] = false));
      if (txt.trim()) { const set = new Set(rangePages(parseRanges(txt, doc.n))); items.forEach((i) => (i[flag] = set.has(i.n))); }
      layout();
    },
    selected: () => items.filter((i) => (mode === "remove" ? i.del : i.pick)),
    kept: () => items.filter((i) => !i.del),
    rotateAll(d) { items.forEach((it) => { it.rot = (it.rot + d + 360) % 360; redrawThumb(els.get(it).querySelector("canvas"), doc.view, it.n, 150, it.rot, 170); }); extra.onChange?.(); },
    reverse() { items.reverse(); layout(); },
    refreshThumbs() { for (const [it, el] of els) redrawThumb(el.querySelector("canvas"), doc.view, it.n, 150, it.rot, 170); },
  };
}

// ------------------------------------------------------------------ remove / extract
function selectTool(id, { title, desc, ic, verb, mode, suffix, label, hint, goLabel }) {
  tool({
    id, group: "organize", title, desc, icon: ic,
    init(ctx) {
      singleFile(ctx, (doc) => {
        const rangeIn = html(`<input type="text" placeholder="เช่น 1-3, 5, 8-10" autocomplete="off">`);
        const sep = html(`<div class="chk-row"></div>`);
        const split = mode === "extract" ? html(`<label class="chk"><input type="checkbox"> แยกเป็นไฟล์ละหน้า</label>`) : null;
        const go = primaryBtn(goLabel, "check");
        const count = html(`<div class="hint"></div>`);
        let pg = null;
        const upd = () => { const n = pg ? pg.selected().length : 0; count.textContent = n ? `เลือกแล้ว ${n} จาก ${doc.n} หน้า` : `ยังไม่ได้เลือกหน้า`; go.disabled = !n || (mode === "remove" && n >= doc.n); };
        pg = pageGrid(ctx, doc, mode, { onText: (t) => { rangeIn.value = t; }, onChange: upd });
        rangeIn.addEventListener("input", () => { try { pg.setFromText(rangeIn.value); ctx.clearFail(); } catch (e) { /* typing */ } });
        ctx.side.append(field(label, rangeIn, hint), count);
        if (split) ctx.side.append(split);
        ctx.side.append(go);
        ctx.stage.append(html(`<div class="gbar"><span class="muted">${esc(mode === "remove" ? "คลิกที่หน้าเพื่อเลือกหน้าที่จะลบ" : "คลิกที่หน้าเพื่อเลือกหน้าที่จะเก็บ")}</span><span class="spacer"></span></div>`), pg.el);
        const bar = ctx.stage.querySelector(".gbar");
        const all = html(`<button class="mini" type="button">เลือกทั้งหมด</button>`), none = html(`<button class="mini" type="button">ไม่เลือก</button>`);
        all.onclick = () => { rangeIn.value = `1-${doc.n}`; pg.setFromText(rangeIn.value); };
        none.onclick = () => { rangeIn.value = ""; pg.setFromText(""); };
        bar.append(all, none);
        upd();
        go.onclick = () => ctx.run(async () => {
          const sel = pg.selected();
          const keep = mode === "remove" ? pg.kept() : sel;
          const base = baseName(doc.name);
          if (mode === "extract" && split.querySelector("input").checked) {
            const files = [];
            for (const it of keep) files.push({ name: `${base}_หน้า${it.n}.pdf`, mime: "application/pdf", bytes: await savePdf(await buildPdf(doc.lib, [{ n: it.n, rot: 0 }])) });
            return showResult(ctx, { title: `แยกเป็น ${files.length} ไฟล์`, files, previewPdf: false, zipName: `${base}_หน้า.zip` });
          }
          const out = await savePdf(await buildPdf(doc.lib, keep.map((i) => ({ n: i.n, rot: 0 }))));
          await showResult(ctx, { title: mode === "remove" ? `ลบแล้ว ${sel.length} หน้า · เหลือ ${keep.length} หน้า` : `ดึงแล้ว ${keep.length} หน้า`, files: [{ name: `${base}${suffix}.pdf`, mime: "application/pdf", bytes: out }] });
        }, "กำลังสร้างไฟล์…");
      });
    },
  });
}
selectTool("remove", { title: "ลบหน้า", desc: "เลือกหน้าที่ไม่ต้องการแล้วลบออกจากไฟล์", ic: "remove", mode: "remove", suffix: "_ลบหน้า", label: "หน้าที่จะลบ", hint: "พิมพ์ช่วงหน้า หรือคลิกเลือกที่รูปทางขวา", goLabel: "ลบหน้าที่เลือก" });
selectTool("extract", { title: "ดึงหน้าออก", desc: "เลือกเฉพาะบางหน้าออกมาเป็นไฟล์ใหม่", ic: "extract", mode: "extract", suffix: "_ดึงหน้า", label: "หน้าที่จะดึงออก", hint: "พิมพ์ช่วงหน้า หรือคลิกเลือกที่รูปทางขวา", goLabel: "ดึงหน้าที่เลือก" });

// ------------------------------------------------------------------ organize / rotate
function arrangeTool(id, { title, desc, ic, mode, suffix, hintText }) {
  tool({
    id, group: "organize", title, desc, icon: ic,
    init(ctx) {
      singleFile(ctx, (doc) => {
        const go = primaryBtn("บันทึกไฟล์", "check");
        const info = html(`<div class="hint"></div>`);
        let pg = null;
        const upd = () => { if (!pg) return; const k = pg.kept(); info.textContent = `ไฟล์ใหม่ ${k.length} หน้า`; go.disabled = !k.length; };
        pg = pageGrid(ctx, doc, mode, { onChange: upd });
        const bar = html(`<div class="gbar"><span class="muted">${esc(hintText)}</span><span class="spacer"></span></div>`);
        const rl = html(`<button class="mini" type="button">${icon("rl", 14)} หมุนทั้งหมดซ้าย</button>`), rr = html(`<button class="mini" type="button">${icon("rr", 14)} หมุนทั้งหมดขวา</button>`);
        rl.onclick = () => pg.rotateAll(-90); rr.onclick = () => pg.rotateAll(90);
        bar.append(rl, rr);
        if (mode === "organize") {
          const rev = html(`<button class="mini" type="button">กลับลำดับ</button>`); rev.onclick = () => pg.reverse(); bar.append(rev);
        }
        ctx.side.append(info, go);
        ctx.stage.append(bar, pg.el);
        upd();
        go.onclick = () => ctx.run(async () => {
          const out = await savePdf(await buildPdf(doc.lib, pg.kept()));
          await showResult(ctx, { title: "เสร็จแล้ว", files: [{ name: `${baseName(doc.name)}${suffix}.pdf`, mime: "application/pdf", bytes: out }] });
        }, "กำลังสร้างไฟล์…");
      });
    },
  });
}
arrangeTool("organize", { title: "จัดเรียงหน้า", desc: "ลากสลับลำดับ หมุน ลบ หรือทำสำเนาหน้า", ic: "organize", mode: "organize", suffix: "_จัดเรียง", hintText: "ลากหน้าเพื่อสลับตำแหน่ง · ใช้ปุ่มใต้รูปเพื่อหมุน/ลบ/ทำสำเนา" });
arrangeTool("rotate", { title: "หมุนหน้า", desc: "หมุนทั้งไฟล์หรือเฉพาะบางหน้า", ic: "rotate", mode: "rotate", suffix: "_หมุน", hintText: "กดปุ่มใต้รูปเพื่อหมุนทีละหน้า หรือหมุนทั้งหมดด้วยปุ่มด้านบน" });

// ------------------------------------------------------------------ merge
tool({
  id: "merge", group: "organize", title: "รวม PDF", desc: "เอาหลายไฟล์มารวมเป็นไฟล์เดียว เรียงลำดับได้", icon: "merge",
  init(ctx) {
    const files = [];
    let seq = 0;
    const list = html(`<div class="flist"></div>`);
    const go = primaryBtn("รวมไฟล์", "merge");
    const sum = html(`<div class="hint"></div>`);
    const add = html(`<button class="addmore" type="button">+ เพิ่มไฟล์</button>`);
    const adder = dropZone({ kind: "pdf", multiple: true, title: "เลือกไฟล์ PDF หลายไฟล์", hint: "กดเลือกพร้อมกันหลายไฟล์ หรือลากมาวาง · เรียงลำดับได้ภายหลัง", onFiles: addFiles });
    ctx.stage.append(adder);
    add.onclick = () => adder.pick();
    sortable(list, (f, t) => { const [x] = files.splice(f, 1); files.splice(t, 0, x); paint(); });

    async function addFiles(fs) {
      for (const f of fs) {
        const it = { id: ++seq, file: f, name: f.name, size: f.size, n: 0, view: null, lib: null, bytes: null, err: "" };
        files.push(it);
      }
      ctx.work(); ctx.stage.innerHTML = ""; adder.hidden = true; ctx.stage.append(list, add, adder);
      if (!ctx.side.childElementCount) ctx.side.append(html(`<p class="side-title">ไฟล์ที่จะรวม</p>`), sum, go);
      paint();
      for (const it of files.filter((x) => !x.bytes && !x.err)) {
        try { it.bytes = await readBytes(it.file); it.lib = await openPdfLib(it.bytes); it.n = it.lib.getPageCount(); it.view = await PDFX.openPdf(it.bytes); }
        catch (e) { it.err = explain(e)[0]; }
        paint();
      }
    }
    function paint() {
      list.innerHTML = "";
      files.forEach((it, i) => {
        const row = html(`<div class="frow" draggable="true" data-i="${i}"><span class="handle" title="ลากเพื่อเรียง">⋮⋮</span><div class="fthumb"><canvas></canvas></div>
          <div class="fmeta"><div class="fname"></div><div class="fsub"></div></div><div class="fbtns"></div></div>`);
        row.querySelector(".fname").textContent = it.name;
        row.querySelector(".fsub").textContent = it.err ? it.err : it.n ? `${it.n} หน้า · ${fmtSize(it.size)}` : "กำลังอ่าน…";
        if (it.err) row.querySelector(".fsub").style.color = "var(--err)";
        const bt = row.querySelector(".fbtns");
        const mk = (ic, t, fn, dis) => { const b = html(`<button class="ibtn" type="button" title="${t}" aria-label="${t}" ${dis ? "disabled" : ""}>${icon(ic, 15)}</button>`); b.onclick = fn; bt.append(b); };
        mk("up", "เลื่อนขึ้น", () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; paint(); }, i === 0);
        mk("down", "เลื่อนลง", () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; paint(); }, i === files.length - 1);
        mk("x", "เอาออก", () => { files.splice(i, 1); if (!files.length) ctx.reset(); else paint(); });
        if (it.view) lazyThumb(row.querySelector("canvas"), it.view, 1, 52, 0, 68);
        list.append(row);
      });
      const ok = files.filter((f) => f.lib);
      const pages = ok.reduce((s, f) => s + f.n, 0);
      sum.textContent = `${files.length} ไฟล์ · รวม ${pages} หน้า`;
      go.disabled = ok.length < 2 || files.some((f) => !f.lib && !f.err);
      if (ok.length < 2) sum.textContent += " · เลือกอย่างน้อย 2 ไฟล์";
    }
    go.onclick = () => ctx.run(async () => {
      const out = await PLIB().PDFDocument.create();
      for (const f of files.filter((x) => x.lib)) {
        const pgs = await out.copyPages(f.lib, f.lib.getPageIndices());
        pgs.forEach((p) => out.addPage(p));
        await tick();
      }
      await showResult(ctx, { title: `รวม ${files.length} ไฟล์แล้ว`, files: [{ name: "รวมไฟล์.pdf", mime: "application/pdf", bytes: await savePdf(out) }] });
    }, "กำลังรวมไฟล์…");
  },
});

// ------------------------------------------------------------------ split
tool({
  id: "split", group: "organize", title: "แยก PDF", desc: "แยกเป็นหลายไฟล์ ตามช่วงหน้า ทุกหน้า หรือทุก N หน้า", icon: "split",
  init(ctx) {
    singleFile(ctx, (doc) => {
      let mode = "range";
      const seg = html(`<div class="seg"><button type="button" data-m="range" class="on">ตามช่วงหน้า</button><button type="button" data-m="each">ทุกหน้า</button><button type="button" data-m="every">ทุก N หน้า</button></div>`);
      const rangeIn = html(`<input type="text" placeholder="เช่น 1-3, 4-6, 7" autocomplete="off">`);
      const everyIn = html(`<input type="number" min="1" value="2">`);
      const merge = html(`<label class="chk"><input type="checkbox"> รวมทุกช่วงเป็นไฟล์เดียว</label>`);
      const info = html(`<div class="hint"></div>`);
      const go = primaryBtn("แยกไฟล์", "split");
      const fRange = field("ช่วงหน้า (คั่นด้วย ,) — แต่ละช่วงเป็น 1 ไฟล์", rangeIn, "พิมพ์ช่วงหน้า");
      const fEvery = field("จำนวนหน้าต่อไฟล์", everyIn); fEvery.hidden = true;
      ctx.side.append(field("วิธีแยก", seg), fRange, fEvery, merge, info, go);
      const pg = pageGrid(ctx, doc, "view");
      ctx.stage.append(html(`<div class="gbar"><span class="muted">หน้าที่อยู่ในช่วงที่เลือกจะถูกไฮไลต์</span></div>`), pg.el);

      const plan = () => {
        if (mode === "each") return Array.from({ length: doc.n }, (_, i) => ({ a: i + 1, b: i + 1 }));
        if (mode === "every") { const k = Math.max(1, +everyIn.value | 0), r = []; for (let a = 1; a <= doc.n; a += k) r.push({ a, b: Math.min(doc.n, a + k - 1) }); return r; }
        return parseRanges(rangeIn.value, doc.n);
      };
      const refresh = () => {
        let rs = [];
        try { rs = plan(); ctx.clearFail(); } catch { rs = []; }
        const set = new Set(rangePages(rs));
        pg.items.forEach((it) => { it.pick = set.has(it.n); });
        pg.el.querySelectorAll(".pitem").forEach((el) => el.classList.toggle("picked", set.has(+el.dataset.i + 1)));
        const files = mode === "range" && merge.querySelector("input").checked ? (rs.length ? 1 : 0) : rs.length;
        info.textContent = rs.length ? `จะได้ ${files} ไฟล์` : "";
        go.disabled = !rs.length;
      };
      seg.onclick = (e) => {
        const b = e.target.closest("button"); if (!b) return;
        mode = b.dataset.m; seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        fRange.hidden = mode !== "range"; fEvery.hidden = mode !== "every"; merge.hidden = mode !== "range"; refresh();
      };
      [rangeIn, everyIn].forEach((i) => i.addEventListener("input", refresh));
      merge.querySelector("input").addEventListener("change", refresh);
      refresh();
      go.onclick = () => ctx.run(async () => {
        const rs = plan(), base = baseName(doc.name), files = [];
        if (mode === "range" && merge.querySelector("input").checked) {
          files.push({ name: `${base}_แยก.pdf`, mime: "application/pdf", bytes: await savePdf(await buildPdf(doc.lib, rangePages(rs).map((n) => ({ n })))) });
        } else {
          for (const { a, b } of rs) {
            const pages = Array.from({ length: b - a + 1 }, (_, i) => ({ n: a + i }));
            files.push({ name: `${base}_${a === b ? "หน้า" + a : a + "-" + b}.pdf`, mime: "application/pdf", bytes: await savePdf(await buildPdf(doc.lib, pages)) });
            await tick();
          }
        }
        await showResult(ctx, { title: `แยกได้ ${files.length} ไฟล์`, files, zipName: `${base}_แยก.zip` });
      }, "กำลังแยกไฟล์…");
    });
  },
});

// ------------------------------------------------------------------ crop
// margins are fractions of the page as it is displayed; mapped back to the unrotated box
function cropBoxFor(page, m) {
  const box = page.getCropBox(), W = box.width, H = box.height, r = ((page.getRotation().angle % 360) + 360) % 360;
  const { l, t, r: rt, b } = m;
  let L, R, T, B;
  if (r === 0) { L = l * W; R = rt * W; T = t * H; B = b * H; }
  else if (r === 90) { L = t * W; T = rt * H; R = b * W; B = l * H; }
  else if (r === 180) { L = rt * W; R = l * W; T = b * H; B = t * H; }
  else { R = t * W; B = rt * H; L = b * W; T = l * H; }
  return { x: box.x + L, y: box.y + B, width: Math.max(10, W - L - R), height: Math.max(10, H - T - B) };
}
tool({
  id: "crop", group: "organize", title: "ตัดขอบหน้า", desc: "ตัดขอบที่ไม่ต้องการออก หรือตัดขอบขาวอัตโนมัติ", icon: "crop",
  init(ctx) {
    singleFile(ctx, (doc) => {
      const m = { l: 0, t: 0, r: 0, b: 0 };
      let cur = 1;
      const names = { l: "ซ้าย", t: "บน", r: "ขวา", b: "ล่าง" };
      const sliders = {};
      const wrap = html(`<div class="fld"><div class="lbl">ตัดขอบ (% ของหน้า)</div></div>`);
      for (const k of ["t", "b", "l", "r"]) {
        const row = html(`<div class="row"><span style="width:44px;font-size:13px;color:var(--ink-2)">${names[k]}</span><input type="range" min="0" max="45" step="0.5" value="0"><span class="muted" style="width:44px;text-align:right">0%</span></div>`);
        const inp = row.querySelector("input"), val = row.lastElementChild;
        inp.oninput = () => { m[k] = +inp.value / 100; val.textContent = inp.value + "%"; paintBox(); };
        sliders[k] = { inp, val }; wrap.append(row);
      }
      const auto = html(`<button class="mini" type="button">ตัดขอบขาวอัตโนมัติ (ตามหน้านี้)</button>`);
      const scope = html(`<div class="seg"><button type="button" data-s="all" class="on">ทุกหน้า</button><button type="button" data-s="one">หน้านี้</button><button type="button" data-s="range">ช่วงหน้า</button></div>`);
      const rangeIn = html(`<input type="text" placeholder="เช่น 1-3, 5" autocomplete="off">`); rangeIn.hidden = true;
      let sc = "all";
      scope.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; sc = b.dataset.s; scope.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); rangeIn.hidden = sc !== "range"; };
      const go = primaryBtn("ตัดขอบ", "crop");
      ctx.side.append(wrap, auto, field("ใช้กับ", scope), rangeIn, go);

      const pv = html(`<div class="pv"><canvas></canvas><div class="ov"><div class="shade s-t"></div><div class="shade s-b"></div><div class="shade s-l"></div><div class="shade s-r"></div></div></div>`);
      const nav = html(`<div class="gbar"><button class="ibtn" type="button" aria-label="หน้าก่อน">${icon("left", 16)}</button><span class="muted"></span><button class="ibtn" type="button" aria-label="หน้าถัดไป">${icon("right", 16)}</button><span class="spacer"></span></div>`);
      ctx.stage.append(nav, html(`<div class="pvwrap"></div>`));
      ctx.stage.querySelector(".pvwrap").append(pv);
      const cv = pv.querySelector("canvas");
      const [prev, , next] = [nav.children[0], nav.children[1], nav.children[2]], label = nav.children[1];
      function paintBox() {
        const s = (c, css) => Object.assign(pv.querySelector(c).style, css);
        s(".s-t", { left: 0, right: 0, top: 0, height: m.t * 100 + "%" });
        s(".s-b", { left: 0, right: 0, bottom: 0, height: m.b * 100 + "%" });
        s(".s-l", { left: 0, width: m.l * 100 + "%", top: m.t * 100 + "%", bottom: m.b * 100 + "%" });
        s(".s-r", { right: 0, width: m.r * 100 + "%", top: m.t * 100 + "%", bottom: m.b * 100 + "%" });
      }
      async function show() {
        label.textContent = `หน้า ${cur} / ${doc.n}`;
        prev.disabled = cur <= 1; next.disabled = cur >= doc.n;
        await renderPageTo(await doc.view.getPage(cur), cv, Math.min(560, ctx.stage.clientWidth - 60 || 560));
        paintBox();
      }
      prev.onclick = () => { cur--; show(); }; next.onclick = () => { cur++; show(); };
      auto.onclick = () => {
        const w = cv.width, h = cv.height, d = cv.getContext("2d").getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        if (x1 < 0) return;
        const pad = 0.012;
        const set = (k, v) => { v = clamp(v, 0, 0.45); m[k] = v; sliders[k].inp.value = (v * 100).toFixed(1); sliders[k].val.textContent = (v * 100).toFixed(1) + "%"; };
        set("l", x0 / w - pad); set("r", (w - 1 - x1) / w - pad); set("t", y0 / h - pad); set("b", (h - 1 - y1) / h - pad);
        paintBox();
      };
      show();
      go.onclick = () => ctx.run(async () => {
        const { PDFDocument } = PLIB();
        const only = sc === "one" ? new Set([cur]) : sc === "range" ? new Set(rangePages(parseRanges(rangeIn.value, doc.n))) : null;
        if (only && !only.size) throw { title: "ยังไม่ได้ระบุช่วงหน้า", body: "พิมพ์ช่วงหน้าที่จะตัดขอบ" };
        const out = await PDFDocument.load(doc.bytes, { ignoreEncryption: true, updateMetadata: false });
        out.getPages().forEach((p, i) => {
          if (only && !only.has(i + 1)) return;
          const b = cropBoxFor(p, m);
          p.setCropBox(b.x, b.y, b.width, b.height); p.setMediaBox(b.x, b.y, b.width, b.height);
        });
        await showResult(ctx, { title: "ตัดขอบแล้ว", files: [{ name: `${baseName(doc.name)}_ตัดขอบ.pdf`, mime: "application/pdf", bytes: await savePdf(out) }] });
      }, "กำลังตัดขอบ…");
    });
  },
});
