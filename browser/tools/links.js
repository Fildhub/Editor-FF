// ===================================================================== shortcut links
// A direct link (and a desktop shortcut file) for every tool. The links are built from the
// address this page was opened from, so they work wherever it lives: a local file or a website.

const cleanUrl = () => location.href.split("#")[0];
const plist = (url) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${esc(url)}</string></dict></plist>\n`;
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

tool({
  id: "links", group: "meta", title: "ลิงก์ลัด", icon: "link",
  desc: "คัดลอกลิงก์ตรงไปแต่ละเครื่องมือ หรือดาวน์โหลดทางลัดไปวางบน Desktop",
  init(ctx) {
    const base = cleanUrl(), local = /^file:/.test(base);
    let fmt = "url";
    const items = [{ id: "", title: "หน้าแรก (รวมทุกเครื่องมือ)" }, ...TOOLS.filter((t) => t.group !== "meta").sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))];
    const urlOf = (t) => (t.id ? `${base}#/${t.id}` : base);
    const fileOf = (t) => {
      const name = `PDF Tools - ${safeName(t.title)}`;
      return fmt === "url" ? { name: `${name}.url`, bytes: new TextEncoder().encode(`[InternetShortcut]\r\nURL=${urlOf(t)}\r\n`), mime: "application/octet-stream" }
        : { name: `${name}.webloc`, bytes: new TextEncoder().encode(plist(urlOf(t))), mime: "application/xml" };
    };
    const box = html(`<div class="linkpage"></div>`);
    box.append(html(`<div class="note"></div>`));
    box.firstChild.textContent = local
      ? "หน้านี้เปิดจากไฟล์ในเครื่อง ลิงก์ด้านล่างจึงใช้ได้เฉพาะเครื่องนี้ (ถ้าย้ายหรือลบไฟล์ ลิงก์จะเสีย) — เมื่ออัปขึ้นเว็บแล้ว ให้เปิดหน้านี้จากเว็บจริง ลิงก์จะเปลี่ยนเป็นที่อยู่ของเว็บให้เอง"
      : "ลิงก์ด้านล่างสร้างจากที่อยู่ของเว็บนี้ ส่งต่อให้คนอื่นเปิดได้ทันที";
    const bar = html(`<div class="row" style="flex-wrap:wrap;margin:14px 0"><span class="muted">ชนิดทางลัด</span></div>`);
    const seg = html(`<div class="seg" style="max-width:320px"><button type="button" data-f="url" class="on">Windows (.url)</button><button type="button" data-f="webloc">Mac (.webloc)</button></div>`);
    seg.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; fmt = b.dataset.f; seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
    const all = html(`<button class="dl" type="button">${icon("download", 16)} ดาวน์โหลดทางลัดทั้งหมด (ZIP)</button>`);
    all.onclick = async () => saveBytes(await zipStore(items.map(fileOf)), "PDF Tools - ทางลัด.zip", "application/zip");
    bar.append(seg, html(`<span class="spacer"></span>`), all);
    const list = html(`<div class="linklist"></div>`);
    for (const t of items) {
      const row = html(`<div class="linkrow"><div class="lname"></div><input type="text" readonly><div class="lbtns"></div></div>`);
      row.querySelector(".lname").textContent = t.title;
      const inp = row.querySelector("input"); inp.value = urlOf(t); inp.onfocus = () => inp.select();
      const copy = html(`<button class="mini" type="button">${icon("copy", 14)} คัดลอก</button>`);
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(inp.value); } catch { inp.select(); document.execCommand?.("copy"); }
        copy.lastChild.textContent = " คัดลอกแล้ว ✓"; setTimeout(() => { copy.lastChild.textContent = " คัดลอก"; }, 1500);
      };
      const open = html(`<a class="mini" target="_self">เปิด</a>`); open.href = urlOf(t);
      const dl = html(`<button class="mini" type="button">${icon("download", 14)} ทางลัด</button>`);
      dl.onclick = () => { const f = fileOf(t); saveBytes(f.bytes, f.name, f.mime); };
      row.querySelector(".lbtns").append(copy, dl, open);
      list.append(row);
    }
    ctx.stage.append(box, bar, list);
    ctx.work(); ctx.side.hidden = true; ctx.grid.classList.add("solo");
    ctx.grid.style.gridTemplateColumns = "minmax(0, 900px)"; ctx.onClose(() => { ctx.grid.style.gridTemplateColumns = ""; });
  },
});
