(() => {
  const $ = (s) => document.querySelector(s);

  const LS = {
    owner: "sv_owner",
    repo: "sv_repo",
    branch: "sv_branch",
    token: "sv_token",
    resApi: "sv_res_api",
  };

  const state = {
    doc: { categories: [], products: [] },
    sales: [],
    reservations: [],
    dirtyReservations: false,
    loaded: false,
    saving: false,
    saveQueued: false,
    dirty: false,
    dirtyProducts: false,
    dirtySales: false,
    saveTimer: null,
    shas: { products: null, sales: null },
    // hogy a public oldal biztosan megtalálja a RAW forrást (telefonon is)
    forceSourceSync: false,
    clientId: (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)),
    filters: {
      productsCat: "all",
      salesCat: "all",
      chartCat: "all",
      productsSearch: "",
      salesSearch: ""
    }
  };

  /* ---------- UI helpers ---------- */
  function setSaveStatus(type, text){
    const dot = $("#saveDot");
    dot.classList.remove("ok","busy","bad");
    dot.classList.add(type);
    $("#saveText").textContent = text;
  }

  
  const modalStack = [];

  function openModal(title, sub, bodyEl, actions){
    const bg = $("#modalBg");
    const body = $("#modalBody");
    const act = $("#modalActions");

    // ✅ modal stack: ne zárja be a "szülő" modalt (pl. eladás űrlap) amikor nyílik a termék picker
    if(bg.style.display === "flex"){
      modalStack.push({
        title: $("#modalTitle").textContent,
        sub: $("#modalSub").textContent,
        bodyNodes: [...body.childNodes],
        actionNodes: [...act.childNodes],
      });
    }

    $("#modalTitle").textContent = title;
    $("#modalSub").textContent = sub || "";

    // move nodes out (eventek megmaradnak)
    body.innerHTML = "";
    body.appendChild(bodyEl);

    act.innerHTML = "";
    actions.forEach(a => {
      const b = document.createElement("button");
      b.textContent = a.label;
      b.className = a.kind === "primary" ? "primary" : (a.kind === "danger" ? "danger" : "ghost");
      b.type = "button";
      b.onclick = a.onClick;
      act.appendChild(b);
    });

    bg.style.display = "flex";
  }

  function closeModal(){
    const bg = $("#modalBg");
    const body = $("#modalBody");
    const act = $("#modalActions");

    if(modalStack.length){
      const prev = modalStack.pop();
      $("#modalTitle").textContent = prev.title || "";
      $("#modalSub").textContent = prev.sub || "";

      body.innerHTML = "";
      (prev.bodyNodes || []).forEach(n => body.appendChild(n));

      act.innerHTML = "";
      (prev.actionNodes || []).forEach(n => act.appendChild(n));

      bg.style.display = "flex";
      return;
    }
    bg.style.display = "none";
  }

  function todayISO(){
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,"0");
    const dd = String(d.getDate()).padStart(2,"0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function escapeHtml(s){
    return String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }

  /* ---------- Cross-tab save lock (ugyanazon böngészőben) ---------- */
  const LOCK_KEY = "sv_save_lock";
  function readLock(){
    try{ return JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); }catch{ return null; }
  }
  function lockValid(lock){
    return !!(lock && lock.id && (Date.now() - Number(lock.ts || 0)) < 15000);
  }
  function acquireLock(){
    try{
      const cur = readLock();
      if(lockValid(cur) && cur.id !== state.clientId) return false;
      localStorage.setItem(LOCK_KEY, JSON.stringify({ id: state.clientId, ts: Date.now() }));
      return true;
    }catch{
      // ha a localStorage valamiért tiltott/tele van, inkább mentsünk, mint hogy szétálljon az admin
      return true;
    }
  }
  function releaseLock(){
    try{
      const cur = readLock();
      if(cur && cur.id === state.clientId) localStorage.removeItem(LOCK_KEY);
    }catch{}
  }
  // ha crash/bezárás: engedjük el
  window.addEventListener("beforeunload", releaseLock);


/* ---------- Settings ---------- */
function getCfg(){
  return {
    owner: ($("#cfgOwner")?.value || "").trim(),
    repo: ($("#cfgRepo")?.value || "").trim(),
    branch: ($("#cfgBranch")?.value || "main").trim() || "main",
    token: ($("#cfgToken")?.value || "").trim(),
    resApi: ($("#cfgResApi")?.value || "").trim()
  };
}
function loadCfg(){
  const owner = localStorage.getItem(LS.owner) || "";
  const repo = localStorage.getItem(LS.repo) || "";
  const branch = localStorage.getItem(LS.branch) || "main";
  const token = localStorage.getItem(LS.token) || "";
  const resApi = localStorage.getItem(LS.resApi) || "";
  return { owner, repo, branch, token, resApi };
}
function saveCfg(cfg){
  localStorage.setItem(LS.owner, cfg.owner);
  localStorage.setItem(LS.repo, cfg.repo);
  localStorage.setItem(LS.branch, cfg.branch);
  localStorage.setItem(LS.token, cfg.token);
  localStorage.setItem(LS.resApi, cfg.resApi || "");
}

  /* ---------- Data logic ---------- */
  function normalizeDoc(){
    if(Array.isArray(state.doc)) state.doc = { categories: [], products: state.doc };
    if(!state.doc || typeof state.doc !== "object") state.doc = { categories: [], products: [] };
    if(!Array.isArray(state.doc.categories)) state.doc.categories = [];
    if(!Array.isArray(state.doc.products)) state.doc.products = [];
    if(!Array.isArray(state.doc.popups)) state.doc.popups = [];
    if(!Array.isArray(state.sales)) state.sales = [];

    state.doc.categories = state.doc.categories
      .filter(c => c && c.id)
      .map(c => ({
        id: String(c.id),
        label_hu: c.label_hu || c.id,
        label_en: c.label_en || c.label_hu || c.id,
        basePrice: Number(c.basePrice || 0),

        // ✅ JD Vapes: külön kategória ár (üres/null => SV fallback)
        basePriceJD: (c.basePriceJD === "" || c.basePriceJD === null || c.basePriceJD === undefined)
          ? null
          : (Number.isFinite(Number(c.basePriceJD)) ? Number(c.basePriceJD) : null),

        visible: (c.visible === false) ? false : true,
        visibleJD: (c.visibleJD === false) ? false : true,

        featuredEnabled: (c.featuredEnabled === false) ? false : true
      }));

    state.doc.products = state.doc.products.map(p => ({
      id: String(p.id || ""),
      categoryId: String(p.categoryId || ""),
      status: (p.status === "ok" || p.status === "out" || p.status === "soon") ? p.status : "ok",
      stock: Math.max(0, Number(p.stock || 0)),
      visible: (p.visible === false) ? false : true,
      visibleJD: (p.visibleJD === false) ? false : true,
      // price lehet null/üres => kategória alapár
      price: (p.price === "" || p.price === null || p.price === undefined) ? null : (Number.isFinite(Number(p.price)) ? Number(p.price) : null),
      // ✅ JD ár: üres/null => JD kategória ár (és ha az sincs, SV fallback)
      priceJD: (p.priceJD === "" || p.priceJD === null || p.priceJD === undefined) ? null : (Number.isFinite(Number(p.priceJD)) ? Number(p.priceJD) : null),
      image: p.image || "",
      name_hu: p.name_hu || "",
      name_en: p.name_en || "",
      flavor_hu: p.flavor_hu || "",
      flavor_en: p.flavor_en || "",
      // ✅ Csak hónap formátum: YYYY-MM
      soonEta: String(p.soonEta || p.eta || "").replace(/^(\d{4}-\d{2}).*$/, "$1")
    })).filter(p => p.id);

    // Popups normalize
    state.doc.popups = (state.doc.popups || []).map(pp => ({
      id: String(pp.id || ""),
      enabled: (pp.enabled === false) ? false : true,
      // rev: ha változik, a "ne mutasd többször" újra feloldódik
      rev: Number(pp.rev || pp.updatedAt || pp.createdAt || 0) || 0,
      title_hu: pp.title_hu || "Új termékek elérhetőek",
      title_en: pp.title_en || "New products available",
      categoryIds: Array.isArray(pp.categoryIds) ? pp.categoryIds.map(x=>String(x)) : [],
      productIds: Array.isArray(pp.productIds) ? pp.productIds.map(x=>String(x)) : [],
      createdAt: Number(pp.createdAt || 0) || 0,
      updatedAt: Number(pp.updatedAt || 0) || 0
    })).filter(pp => pp.id);

    // Sales normalize (kompatibilis a régi formátummal is)
state.sales = state.sales.map(s => {
  const legacyPid = s.productId || s.pid || s.product || "";
  const legacyQty = s.qty || s.quantity || 1;
  const legacyPrice = s.unitPrice || s.price || s.amount || 0;

  const items = Array.isArray(s.items)
    ? s.items.map(it => ({
        productId: String(it.productId || it.pid || ""),
        qty: Math.max(1, Number.parseFloat(it.qty || it.quantity || 1) || 1),
        unitPrice: Math.max(0, Number.parseFloat(it.unitPrice || it.price || 0) || 0)
      })).filter(it => it.productId)
    : (legacyPid ? [{
        productId: String(legacyPid),
        qty: Math.max(1, Number.parseFloat(legacyQty) || 1),
        unitPrice: Math.max(0, Number.parseFloat(legacyPrice) || 0)
      }] : []);

  return {
    id: String(s.id || ""),
    date: String(s.date || s.day || s.createdAt || ""),
    name: s.name || "",
    payment: s.payment || s.method || "",
    fromReservationSnapshot: s.fromReservationSnapshot || s.fromReservation || null,
    items
  };
}).filter(s => s.id);
  }


  function normalizeReservations(list){
    if(!Array.isArray(list)) return [];
    const out = [];
    for(const r of list){
      if(!r) continue;
      const id = String(r.id || r._id || r.resId || "");
      if(!id) continue;

      const confirmed = !!r.confirmed;
      const createdAt = Number(r.createdAt || r.ts || 0) || 0;

      let expiresAt = null;
      if(!confirmed){
        const ex = (r.expiresAt === null || r.expiresAt === undefined || r.expiresAt === "") ? null : Number(r.expiresAt || 0) || null;
        expiresAt = ex;
      }

      const items = Array.isArray(r.items) ? r.items.map(it => {
        const ujdRaw = (it.unitPriceJD === null || it.unitPriceJD === undefined || it.unitPriceJD === "")
          ? (it.priceJD === null || it.priceJD === undefined || it.priceJD === "" ? null : it.priceJD)
          : it.unitPriceJD;
        const ujd = (ujdRaw === null || ujdRaw === undefined || ujdRaw === "") ? null : (Number.isFinite(Number(ujdRaw)) ? Math.max(0, Number(ujdRaw)) : null);

        return {
          productId: String(it.productId || it.pid || it.product || ""),
          qty: Math.max(1, Number(it.qty || it.quantity || 1) || 1),
          unitPrice: Math.max(0, Number(it.unitPrice || it.price || 0) || 0),
          unitPriceJD: ujd
        };
      }).filter(it => it.productId) : [];

      out.push({
        id,
        publicCode: String(r.publicCode || r.code || ""),
        createdAt,
        expiresAt,
        confirmed,
        modified: !!r.modified,
        modifiedAt: Number(r.modifiedAt || 0) || 0,
        editCount: Math.max(0, Number(r.editCount ?? r.editedCount ?? (r.modified ? 1 : 0) ?? 0) || 0),
        recorded: !!r.recorded,
        deleted: !!r.deleted,
        lastAction: String(r.lastAction || ""),
        discordMessageId: String(r.discordMessageId || r.discord_message_id || ""),
        items
      });
    }
    return out;
  }


  function catById(id){
    return state.doc.categories.find(c => c.id === String(id)) || null;
  }
  function prodById(id){
    return state.doc.products.find(p => p.id === String(id)) || null;
  }

  function effectivePriceStore(p, store="sv"){
    const num = (v)=> (v===null || v===undefined || v==="" ? null : Number(v));
    const pickOverride = (key)=>{
      const v = num(p && p[key]);
      return (v!==null && Number.isFinite(v) && v>0) ? v : null;
    };

    if(store === "jd"){
      const ov = pickOverride("priceJD");
      if(ov !== null) return ov;

      const c = catById(p.categoryId);
      const bpjd = c ? num(c.basePriceJD) : null;
      if(bpjd !== null && Number.isFinite(bpjd) && bpjd > 0) return bpjd;

      // fallback: SV pricing
      return effectivePriceStore(p, "sv");
    }

    // SV pricing (default)
    const ov = pickOverride("price");
    if(ov !== null) return ov;

    const c = catById(p.categoryId);
    const bp = c ? num(c.basePrice) : null;
    const out = (bp !== null && Number.isFinite(bp) && bp > 0) ? bp : 0;
    return out;
  }

  function effectivePrice(p){ return effectivePriceStore(p, "sv"); }
  function effectivePriceJD(p){ return effectivePriceStore(p, "jd"); }

  function saleTotals(sale, catFilterId){
    // catFilterId: "all" or category id -> csak az adott kategória tételeit számoljuk
    let revenue = 0;
    let qty = 0;
    let hit = false;

    for(const it of sale.items){
      const p = prodById(it.productId);
      if(!p) continue;
      if(catFilterId !== "all" && p.categoryId !== catFilterId) continue;
      hit = true;
      revenue += Number(it.unitPrice || 0) * Number(it.qty || 0);
      qty += Number(it.qty || 0);
    }

    return { revenue, qty, hit };
  }

  /* ---------- GitHub load/save ---------- */
  async function tryLoadFromGithub(cfg){
    // branch fallback main/master automatikusan, ha "No commit found for the ref ..."
    const branchesToTry = [cfg.branch, "main", "master"].filter((v,i,a)=> v && a.indexOf(v)===i);

    let lastErr = null;
    for(const br of branchesToTry){
      try{
        const p = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: br, path: "data/products.json" });
        // sales.json lehet, hogy még nincs a repo-ban → ilyenkor induljunk üres eladásokkal
        let s = null;
        let sales = [];
        try{
          s = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: br, path: "data/sales.json" });
          sales = JSON.parse(s.content || "[]");
        }catch(e){
          if(Number(e?.status || 0) === 404){
            s = { sha: null };
            sales = [];
          }else{
            throw e;
          }
        }

        // reservations.json lehet, hogy még nincs a repo-ban → ilyenkor induljunk üres foglalásokkal
        let r = null;
        let reservations = [];
        try{
          r = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: br, path: "data/reservations.json" });
          reservations = JSON.parse(r.content || "[]");
        }catch(e){
          if(Number(e?.status || 0) === 404){
            r = { sha: null };
            reservations = [];
          }else{
            throw e;
          }
        }

        const doc = JSON.parse(p.content);

        cfg.branch = br;
        saveCfg(cfg);

        state.doc = doc;
        state.sales = sales;
        state.reservations = normalizeReservations(reservations);
        state.shas.products = p.sha;
        state.shas.sales = s ? (s.sha || null) : null;
        state.shas.reservations = r ? (r.sha || null) : null;
        normalizeDoc();
        state.loaded = true;
        state.forceSourceSync = true;

        return { ok:true };
      }catch(e){
        lastErr = e;
      }
    }
    return { ok:false, err:lastErr };
  }

  async function loadData(){
    const cfg = getCfg();
    saveCfg(cfg);

    if(!cfg.owner || !cfg.repo || !cfg.token){
      setSaveStatus("bad","Hiányzó GH beállítás");
      return;
    }

    setSaveStatus("busy","Betöltés...");
    const r = await tryLoadFromGithub(cfg);
    if(!r.ok){
      console.error(r.err);
      setSaveStatus("bad", "Betöltés hiba: " + String(r.err?.message || ""));
      return;
    }

    setSaveStatus("ok","Kész");
    renderAll();
  }

  async function saveDataNow(){
    if(!state.loaded) return;

    // ✅ MENTÉS GYORSÍTÁS: Csak akkor mentünk, ha tényleges változás van
    if (!state.dirtyProducts && !state.dirtySales && !state.dirtyReservations) {
      setSaveStatus("ok","Nincs változás");
      return;
    }

    // Ne fusson párhuzamos mentés (különben SHA mismatch)
    if(state.saving){
      state.saveQueued = true;
      state.dirty = true;
      setSaveStatus("busy","Mentés sorban…");
      return;
    }

    const cfg = getCfg();
    saveCfg(cfg);
    if(!cfg.owner || !cfg.repo || !cfg.token){
      setSaveStatus("bad","Hiányzó GH beállítás");
      return;
    }

    // ugyanazon böngészőben: csak 1 admin tab mentsen
    if(!acquireLock()){
      state.saveQueued = true;
      state.dirty = true;
      setSaveStatus("busy","Másik admin tab ment…");
      setTimeout(() => saveDataNow(), 1200 + Math.random()*400);
      return;
    }

    state.saving = true;
    state.saveQueued = false;
    state.dirty = false;
    setSaveStatus("busy","Mentés...");

    // biztos rend
    normalizeDoc();

    for(const p of (state.doc.products||[])){
      if(p && p.status === "out") p.stock = 0;
      if(p && (!p.name_en || String(p.name_en).trim()==="")) p.name_en = p.name_hu || "";
    }
    // _meta.rev: public old cache ne tudja felülírni a friss mentést
    if(state.dirtyProducts){
      state.doc._meta = {
        ...(state.doc._meta || {}),
        rev: Date.now(),
        updatedAt: new Date().toISOString(),
      };
    }

    const productsText = JSON.stringify(state.doc, null, 2);
    const salesText = JSON.stringify(state.sales, null, 2);
    const reservationsText = JSON.stringify(state.reservations, null, 2);

    
let ok = false;
const wantProducts = !!state.dirtyProducts;
const wantSales = !!state.dirtySales;
const wantReservations = !!state.dirtyReservations;

try{
  // SHA csak akkor kell, ha még nincs meg (a putFileSafe úgyis frissít konflikt esetén)
  if(wantProducts && !state.shas.products){
    // refresh sha, ha nincs
    const pOld = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path: "data/products.json" });
    state.shas.products = pOld.sha;
  }

  if(wantSales && !state.shas.sales){
    try{
      const sOld = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path: "data/sales.json" });
      state.shas.sales = sOld.sha;
    }catch(e){
      if(Number(e?.status || 0) === 404) state.shas.sales = null;
      else throw e;
    }
  }

  if(wantReservations && !state.shas.reservations){
    try{
      const rOld = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path: "data/reservations.json" });
      state.shas.reservations = rOld.sha;
    }catch(e){
      if(Number(e?.status || 0) === 404) state.shas.reservations = null;
      else throw e;
    }
  }

  const tasks = [];

  if(wantProducts){
    tasks.push(
      ShadowGH.putFileSafe({
        token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
        path: "data/products.json",
        message: "Update products.json",
        content: productsText,
        sha: state.shas.products
      }).then((pRes) => {
        state.shas.products = pRes?.content?.sha || state.shas.products;
      })
    );
  }

  if(wantSales){
    tasks.push(
      ShadowGH.putFileSafe({
        token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
        path: "data/sales.json",
        message: "Update sales.json",
        content: salesText,
        sha: state.shas.sales
      }).then((sRes) => {
        state.shas.sales = sRes?.content?.sha || state.shas.sales;
      })
    );
  }

if(wantReservations){
    tasks.push(
      ShadowGH.putFileSafe({
        token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
        path: "data/reservations.json",
        message: "Update reservations.json",
        content: reservationsText,
        sha: state.shas.reservations
      }).then((rRes) => {
        state.shas.reservations = rRes?.content?.sha || state.shas.reservations;
      })
    );
  }


  // ✅ sv_source.json (custom domain + telefon): a public oldal ebből találja meg a RAW forrást
  try{
    const srcObj = { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch };
    if(cfg.resApi) srcObj.reserveApi = cfg.resApi;
    const srcText = JSON.stringify(srcObj, null, 2);
    const prev = localStorage.getItem("sv_source_json") || "";
    if(state.forceSourceSync || prev !== srcText){
      state.forceSourceSync = false;
      try{ localStorage.setItem("sv_source_json", srcText); }catch{}
      tasks.push(
        ShadowGH.putFileSafe({
          token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
          path: "data/sv_source.json",
          message: "Update sv_source.json",
          content: srcText
        })
      );
    }
  }catch{}

  // ha nincs mit menteni, ne üssük a GH-t
  if(!tasks.length){
    ok = true;
    setSaveStatus("ok","Nincs változás");
    return;
  }

  await Promise.all(tasks);
  ok = true;

  // ✅ azonnali update a katalógus tabnak (ha nyitva van ugyanabban a böngészőben)
  try{
    const payload = { doc: state.doc, sales: state.sales, reservations: state.reservations, ts: Date.now() };
    localStorage.setItem("sv_live_payload", JSON.stringify(payload));
    try{ new BroadcastChannel("sv_live").postMessage(payload); }catch{}
  }catch{}

  // ✅ ne reloadoljunk minden autosave után (lassú) — a state már friss
  state.dirtyProducts = false;
  state.dirtySales = false;
  state.dirtyReservations = false;

  setSaveStatus("ok","Mentve ✅");
}catch(e){
      console.error(e);
      setSaveStatus("bad", `Mentés hiba: ${String(e?.message || e)}`);
      // hagyjuk dirty-n, de nem loopolunk végtelenbe
      state.dirty = true;
    }finally{
      state.saving = false;
      releaseLock();

      // Ha mentés közben jött új változás, és ez a mentés OK volt, futtassuk le még egyszer
      if(ok && (state.saveQueued || state.dirty)){
        state.saveQueued = false;
        if(state.saveTimer) clearTimeout(state.saveTimer);
        setTimeout(() => saveDataNow(), 350);
      }
    }
  }


function markDirty(flags){
  const f = flags || {};
  if(f.products) state.dirtyProducts = true;
  if(f.sales) state.dirtySales = true;
  if(f.reservations) state.dirtyReservations = true;
  queueAutoSave();
}

  function queueAutoSave(){
    state.dirty = true;
    if(state.saving){
      state.saveQueued = true;
      setSaveStatus("busy","Mentés folyamatban…");
      return;
    }
    if(state.saveTimer) clearTimeout(state.saveTimer);
    setSaveStatus("busy","Változás…");
    // ✅ MENTÉS GYORSÍTÁS: növelt alapérték 1000 ms
    const ms = Math.max(200, Math.min(2000, Number(localStorage.getItem("sv_autosave_ms") || 1000)));
    state.saveTimer = setTimeout(() => {
      saveDataNow();
    }, ms);
  }

  /* ---------- Rendering ---------- */
  function renderTabs(){
    $("#tabs").onclick = (e) => {
      const b = e.target.closest("button[data-tab]");
      if(!b) return;
      $("#tabs").querySelectorAll("button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");

      const tab = b.dataset.tab;
      $("#panelProducts").style.display = tab === "products" ? "block" : "none";
      $("#panelCategories").style.display = tab === "categories" ? "block" : "none";
      $("#panelSales").style.display = tab === "sales" ? "block" : "none";
      $("#panelChart").style.display = tab === "chart" ? "block" : "none";
      $("#panelPopups").style.display = tab === "popups" ? "block" : "none";
      $("#panelSettings").style.display = tab === "settings" ? "block" : "none";

      if(tab === "chart") drawChart();
      if(tab === "popups") renderPopups();
    };
  }

  function renderSettings(){
    const cfg = loadCfg();
    $("#panelSettings").innerHTML = `
      <div class="small-muted">GitHub mentés (token localStorage-ben). Branch: ha rossz, automatikusan próbál main/master.</div>
      <div class="form-grid" style="margin-top:12px;">
        <div class="field third"><label>Owner</label><input id="cfgOwner" value="${escapeHtml(cfg.owner)}" placeholder="pl. tesouser" /></div>
        <div class="field third"><label>Repo</label><input id="cfgRepo" value="${escapeHtml(cfg.repo)}" placeholder="pl. shadowvapes" /></div>
        <div class="field third"><label>Branch</label><input id="cfgBranch" value="${escapeHtml(cfg.branch)}" placeholder="main" /></div>
        <div class="field full"><label>Token</label><input id="cfgToken" value="${escapeHtml(cfg.token)}" type="password" placeholder="ghp_..." /></div>
        <div class="field full"><label>Foglalás API (token nélkül a felhasználóknak)</label><input id="cfgResApi" value="${escapeHtml(cfg.resApi || '')}" placeholder="https://... (Cloudflare Worker URL)" /></div>
      </div>
      <div class="actions">
        <button class="ghost" id="btnLoad">Betöltés</button>
        <button class="primary" id="btnSave">Mentés most</button>
      </div>

      <div class="form-grid" style="margin-top:12px;">
        <div class="field third">
          <label>Auto-mentés késleltetés</label>
          <select id="cfgAutosave">
            <option value="350">350 ms (gyors)</option>
            <option value="550">550 ms</option>
            <option value="650">650 ms</option>
            <option value="850">850 ms</option>
            <option value="1000" selected>1000 ms (alap)</option>
          </select>
        </div>
        <div class="field full">
          <div class="small-muted">Minél nagyobb, annál kevesebb GitHub hívás (mobilon stabilabb).</div>
        </div>
      </div>

      <div class="small-muted" style="margin-top:10px;">
        Tipp: public oldalon RAW-ból töltünk, ezért a frissítés gyorsabb lesz (nem vársz 6 percet).
      </div>

      <div class="small-muted" style="margin-top:14px;">Telefon / másik eszköz gyorsítás: nyisd meg ezt a linket egyszer, és onnantól a katalógus RAW-ról tölt (gyors frissülés).</div>
      <div class="actions table" style="margin-top:10px;align-items:center;">
        <input id="syncUrl" readonly value="" style="min-width:280px;width:100%;" />
        <button class="ghost" id="btnCopySync">Link másolás</button>
      </div>
    `;

    $("#btnLoad").onclick = loadData;
    $("#btnSave").onclick = saveDataNow;

    // Sync link generálás (katalógus URL + query paramok)
    try{
      const basePath = location.pathname.replace(/\/admin\.html.*$/,"/"); // /repo/ vagy /
      const base = location.origin + basePath;
      const u = new URL(base);
      if(cfg.owner) u.searchParams.set("sv_owner", cfg.owner);
      if(cfg.repo) u.searchParams.set("sv_repo", cfg.repo);
      if(cfg.branch) u.searchParams.set("sv_branch", cfg.branch);
      const link = u.toString();

      const inp = $("#syncUrl");
      if(inp) inp.value = link;

      const btn = $("#btnCopySync");
      if(btn) btn.onclick = async () => {
        try{
          await navigator.clipboard.writeText(link);
          setSaveStatus("ok","Sync link másolva ✅");
        }catch{
          // fallback
          try{
            inp.select();
            document.execCommand("copy");
            setSaveStatus("ok","Sync link másolva ✅");
          }catch{}
        }
      };
    }catch{}
    ["cfgOwner","cfgRepo","cfgBranch","cfgToken","cfgResApi"].forEach(id => {
      $("#"+id).addEventListener("input", () => saveCfg(getCfg()));
    });

    // Auto-mentés késleltetés (lokális beállítás)
    try{
      const sel = $("#cfgAutosave");
      if(sel){
        const cur = Number(localStorage.getItem("sv_autosave_ms") || 1000);
        sel.value = String(cur);
        sel.onchange = () => {
          const ms = Math.max(200, Math.min(2000, Number(sel.value || 1000)));
          localStorage.setItem("sv_autosave_ms", String(ms));
          setSaveStatus("ok","Auto-mentés beállítva ✅");
        };
      }
    }catch{}

  }

  function renderCategories(){
    const cats = [...state.doc.categories].sort((a,b)=> (a.label_hu||a.id).localeCompare(b.label_hu||b.id,"hu"));

    let rows = cats.map(c => `
      <tr>
        <td><div style="display:flex;gap:8px;align-items:center;justify-content:space-between;"><b>${escapeHtml(c.id)}</b><button type="button" class="ghost" data-ren-cat="${escapeHtml(c.id)}">Szerk</button></div></td>
        <td><input data-cid="${escapeHtml(c.id)}" data-k="label_hu" value="${escapeHtml(c.label_hu)}"></td>
        <td><input data-cid="${escapeHtml(c.id)}" data-k="label_en" value="${escapeHtml(c.label_en)}"></td>
        <td style="width:150px;"><input data-cid="${escapeHtml(c.id)}" data-k="basePrice" type="number" min="0" value="${Number(c.basePrice||0)}"></td>
        <td style="width:150px;"><input data-cid="${escapeHtml(c.id)}" data-k="basePriceJD" type="number" min="0" value="${Number((c.basePriceJD ?? c.basePrice ?? 0) || 0)}"></td>
        <td style="width:90px;text-align:center;"><input type="checkbox" data-cid="${escapeHtml(c.id)}" data-k="visible"${c.visible===false?"":" checked"}></td>
        <td style="width:90px;text-align:center;"><input type="checkbox" data-cid="${escapeHtml(c.id)}" data-k="visibleJD"${c.visibleJD===false?"":" checked"}></td>
        <td style="width:120px;text-align:center;"><input type="checkbox" data-cid="${escapeHtml(c.id)}" data-k="featuredEnabled"${c.featuredEnabled===false?"":" checked"}></td>
        <td style="width:110px;"><button class="danger" data-delcat="${escapeHtml(c.id)}">Töröl</button></td>
      </tr>
    `).join("");

    $("#panelCategories").innerHTML = `
      <div class="actions">
        <button class="primary" id="btnAddCat">+ Kategória</button>
        <div class="small-muted">Ha terméknél az ár üres/null → kategória alap árát használja.</div>
      </div>
      <table class="table">
        <thead>
          <tr><th>ID</th><th>HU</th><th>EN</th><th>Alap ár SV (Ft)</th><th>Alap ár JD (Ft)</th><th>SV</th><th>JD</th><th>Felkapott</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    $("#btnAddCat").onclick = () => {
      const body = document.createElement("div");
      body.innerHTML = `
        <div class="form-grid">
          <div class="field third"><label>ID (pl. elf)</label><input id="newCid" placeholder="elf"></div>
          <div class="field third"><label>HU</label><input id="newChu" placeholder="ELF"></div>
          <div class="field third"><label>Alap ár SV</label><input id="newCprice" type="number" min="0" value="0"></div>
          <div class="field third"><label>Alap ár JD</label><input id="newCpriceJD" type="number" min="0" value="0"></div>
        </div>
      `;
      openModal("Új kategória", "Nem prompt, rendes modal 😄", body, [
        { label:"Mégse", kind:"ghost", onClick: closeModal },
        { label:"Létrehozás", kind:"primary", onClick: () => {
          const id = ($("#newCid").value||"").trim();
          if(!id) return;
          if(state.doc.categories.some(x => x.id === id)) return;

          const hu = ($("#newChu").value||"").trim() || id;

          const bp = Math.max(0, Number($("#newCprice").value||0));
          const bpjdInput = $("#newCpriceJD") ? $("#newCpriceJD").value : "";
          const bpjd = (bpjdInput === "" ? bp : Math.max(0, Number(bpjdInput||0)));

          state.doc.categories.push({
            id,
            label_hu: hu,
            label_en: hu, // ✅ EN nem kell külön, maradjon HU
            basePrice: bp,
            basePriceJD: bpjd,
            visible: true,
            visibleJD: true,
            featuredEnabled: true
          });
          closeModal();
          renderAll();
          markDirty({ products:true });
        }}
      ]);
    };

    $("#panelCategories").querySelectorAll("input[data-cid]").forEach(inp => {
      const apply = () => {
        const id = inp.dataset.cid;
        const k = inp.dataset.k;
        const c = catById(id);
        if(!c) return;
        if(k === "basePrice") c.basePrice = Math.max(0, Number(inp.value||0));
        else if(k === "basePriceJD") c.basePriceJD = Math.max(0, Number(inp.value||0));
        else if(k === "visible") c.visible = !!inp.checked;
        else if(k === "visibleJD") c.visibleJD = !!inp.checked;
        else if(k === "featuredEnabled") c.featuredEnabled = !!inp.checked;
        else c[k] = inp.value;
        markDirty({ products:true });
      };
      // checkbox → change, a többi → input
      if(inp.type === "checkbox") inp.onchange = apply;
      else inp.oninput = apply;
    });

    $("#panelCategories").querySelectorAll("button[data-ren-cat]").forEach(btn => {
      btn.onclick = () => renameCategory(btn.dataset.renCat);
    });

    $("#panelCategories").querySelectorAll("button[data-delcat]").forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.delcat;
        // ha használja termék, ne engedjük
        if(state.doc.products.some(p => p.categoryId === id)) return;
        state.doc.categories = state.doc.categories.filter(c => c.id !== id);
        renderAll();
        markDirty({ products:true });
      };
    });
  }

  

  function renameCategory(oldId){
    const c = catById(oldId);
    if(!c) return;

    const body = document.createElement("div");
    body.innerHTML = `
      <div class="field">
        <label>Új kategória ID</label>
        <input id="renCatId" value="${escapeHtml(oldId)}" placeholder="pl. elf" />
      </div>
      <div class="small-muted" style="margin-top:10px;">
        Ez átírja a termékekben is a kategóriát (categoryId).
      </div>
    `;

    openModal("Kategória szerkesztése", "ID átnevezés", body, [
      { label:"Mégse", kind:"ghost", onClick: closeModal },
      { label:"Mentés", kind:"primary", onClick: () => {
        const newId = (document.querySelector("#renCatId")?.value || "").trim();
        if(!newId) return;
        if(newId === oldId){ closeModal(); return; }
        if(state.doc.categories.some(x => String(x.id) === newId)) return;

        // update category
        c.id = newId;

        // update products pointing to it
        for(const p of (state.doc.products || [])){
          if(String(p.categoryId) === oldId) p.categoryId = newId;
        }

        closeModal();
        renderAll();
        markDirty({ products:true });
      }}
    ]);
  }

function renderProducts(){
    const cats = [{id:"all", label:"Mind"}, ...state.doc.categories.map(c=>({id:c.id,label:c.label_hu||c.id}))];

    const filterCat = state.filters.productsCat;
    const q = (state.filters.productsSearch || "").toLowerCase();

    let list = [...state.doc.products];
    if(filterCat !== "all"){
      list = list.filter(p => p.categoryId === filterCat);
    }
    if(q){
      list = list.filter(p => (`${p.name_hu} ${p.name_en} ${p.flavor_hu} ${p.flavor_en}`).toLowerCase().includes(q));
    }

    // rend: ok, soon, out (admin nézethez)
    const rank = (s) => s === "ok" ? 0 : (s === "soon" ? 1 : 2);
    list.sort((a,b) => {
      const ra = rank(a.status), rb = rank(b.status);
      if(ra !== rb) return ra - rb;
      return (a.name_hu||a.name_en||"").localeCompare((b.name_hu||b.name_en||""),"hu");
    });

    const rows = list.map(p => {
      const c = catById(p.categoryId);
      const eff = effectivePrice(p);
      const effJD = effectivePriceJD(p);
      const img = (p.image || "").trim();

      return `
        <div class="rowline table">
          <div class="left">
            <div class="admin-prod-left">
              <img class="admin-prod-thumb" src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.display='none'">
              <div>
                <div style="font-weight:900;">${escapeHtml(p.name_hu||p.name_en||"—")} <span class="small-muted">• ${escapeHtml(p.flavor_hu||p.flavor_en||"")}</span></div>
                <div class="small-muted">
                  Kategória: <b>${escapeHtml(c ? (c.label_hu||c.id) : "—")}</b>
                  • Ár SV: <b>${eff.toLocaleString("hu-HU")} Ft</b> • Ár JD: <b>${effJD.toLocaleString("hu-HU")} Ft</b>
                  • Készlet: <b>${p.status==="soon" ? "—" : p.stock}</b>
                  ${p.status==="soon" && p.soonEta ? `• Várható: <b>${escapeHtml(p.soonEta)}</b>` : ""}
                </div>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <label class="chk"><input type="checkbox" data-pid="${escapeHtml(p.id)}" data-k="visible"${p.visible===false?"":" checked"}> SV</label>
            <label class="chk"><input type="checkbox" data-pid="${escapeHtml(p.id)}" data-k="visibleJD"${p.visibleJD===false?"":" checked"}> JD</label>
            <select data-pid="${escapeHtml(p.id)}" data-k="categoryId">
              ${state.doc.categories.map(cc => `<option value="${escapeHtml(cc.id)}"${cc.id===p.categoryId?" selected":""}>${escapeHtml(cc.label_hu||cc.id)}</option>`).join("")}
            </select>
            <select data-pid="${escapeHtml(p.id)}" data-k="status">
              <option value="ok"${p.status==="ok"?" selected":""}>ok</option>
              <option value="out"${p.status==="out"?" selected":""}>out</option>
              <option value="soon"${p.status==="soon"?" selected":""}>soon</option>
            </select>
            <input data-pid="${escapeHtml(p.id)}" data-k="stock" type="number" min="0" value="${p.stock}" style="width:110px;">
            <input data-pid="${escapeHtml(p.id)}" data-k="price" type="number" min="0" value="${p.price===null? "" : p.price}" placeholder="(SV kat ár)" style="width:150px;">
            <input data-pid="${escapeHtml(p.id)}" data-k="priceJD" type="number" min="0" value="${(p.priceJD===null||p.priceJD===undefined)? "" : p.priceJD}" placeholder="(JD kat ár)" style="width:150px;">
            <button class="ghost" data-edit="${escapeHtml(p.id)}">Szerkeszt</button>
            <button class="danger" data-del="${escapeHtml(p.id)}">Töröl</button>
          </div>
        </div>
      `;
    }).join("");

    $("#panelProducts").innerHTML = `
      <div class="actions table" style="align-items:center;">
        <button class="primary" id="btnAddProd">+ Termék</button>
        <select id="prodCat">
          ${cats.map(c => `<option value="${escapeHtml(c.id)}"${c.id===filterCat?" selected":""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
        <input id="prodSearch" placeholder="Keresés..." value="${escapeHtml(state.filters.productsSearch)}" style="flex:1;min-width:220px;">
        <div class="small-muted">Out termékek a public oldalon automatikusan leghátul.</div>
      </div>
      <div style="margin-top:10px;">${rows || `<div class="small-muted">Nincs találat.</div>`}</div>
    `;

    $("#prodCat").onchange = () => { state.filters.productsCat = $("#prodCat").value; renderProducts(); };
    $("#prodSearch").oninput = () => { state.filters.productsSearch = $("#prodSearch").value; renderProducts(); };

    $("#btnAddProd").onclick = () => openProductModal(null);

    $("#panelProducts").querySelectorAll("[data-pid]").forEach(el => {
      const apply = () => {
        const pid = el.dataset.pid;
        const k = el.dataset.k;
        const p = prodById(pid);
        if(!p) return;

        if(k === "stock"){
          p.stock = Math.max(0, Number(el.value||0));
          if(p.stock <= 0 && p.status !== "soon") p.status = "out";
        }else if(k === "price"){
          p.price = (el.value === "" ? null : Math.max(0, Number(el.value||0)));
        }else if(k === "priceJD"){
          p.priceJD = (el.value === "" ? null : Math.max(0, Number(el.value||0)));
        }else if(k === "status"){
          p.status = el.value;
          if(p.status === "out") p.stock = 0;
        }else if(k === "categoryId"){
          p.categoryId = el.value;
        }else if(k === "visible"){
          p.visible = !!el.checked;
        }else if(k === "visibleJD"){
          p.visibleJD = !!el.checked;
        }

        markDirty({ products:true });
      };

      const tag = String(el.tagName||"").toLowerCase();
      if(tag === "select" || el.type === "checkbox") el.onchange = apply;
      else el.oninput = apply;
    });

    $("#panelProducts").querySelectorAll("button[data-edit]").forEach(b => {
      b.onclick = () => openProductModal(b.dataset.edit);
    });
    $("#panelProducts").querySelectorAll("button[data-del]").forEach(b => {
      b.onclick = () => {
        const id = b.dataset.del;
        // ha eladásban van, ne engedjük törölni
        if(state.sales.some(s => s.items.some(it => it.productId === id))) return;
        state.doc.products = state.doc.products.filter(p => p.id !== id);
        renderAll();
        markDirty({ products:true });
      };
    });
  }

  function openProductModal(id){
    const editing = id ? prodById(id) : null;
    const p = editing ? {...editing} : {
      id: "p_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16),
      categoryId: state.doc.categories[0]?.id || "",
      status: "ok",
      stock: 0,
      price: null,
      image: "",
      name_hu: "",
      name_en: "",
      flavor_hu: "",
      flavor_en: "",
      soonEta: "", // ✅ Csak hónap formátum
      visible: true,
      visibleJD: true,
      priceJD: null
    };

    const body = document.createElement("div");
    body.innerHTML = `
      <div class="form-grid">
        <div class="field third"><label>ID</label><input id="p_id" value="${escapeHtml(p.id)}" ${editing?"disabled":""}></div>
        <div class="field third"><label>Kategória</label>
          <select id="p_cat">
            ${state.doc.categories.map(c => `<option value="${escapeHtml(c.id)}"${c.id===p.categoryId?" selected":""}>${escapeHtml(c.label_hu||c.id)}</option>`).join("")}
          </select>
        </div>
        <div class="field third"><label>Status</label>
          <select id="p_status">
            <option value="ok"${p.status==="ok"?" selected":""}>ok</option>
            <option value="out"${p.status==="out"?" selected":""}>out</option>
            <option value="soon"${p.status==="soon"?" selected":""}>soon</option>
          </select>
        </div>

        <div class="field third"><label>Várható hónap (csak "soon")</label><input id="p_eta" type="month" value="${escapeHtml(p.soonEta||"")}" placeholder="YYYY-MM"></div>

        <div class="field third"><label>Látható (SV)</label><label class="chk" style="justify-content:flex-start;"><input type="checkbox" id="p_visible" ${p.visible===false?"":"checked"}> SV oldalon</label></div>

        <div class="field third"><label>Látható (JD)</label><label class="chk" style="justify-content:flex-start;"><input type="checkbox" id="p_visibleJD" ${p.visibleJD===false?"":"checked"}> JD oldalon</label></div>

        <div class="field third"><label>Készlet</label><input id="p_stock" type="number" min="0" value="${p.stock}"></div>
        <div class="field third"><label>Ár SV (Ft) — üres: SV kategória ár</label><input id="p_price" type="number" min="0" value="${p.price===null?"":p.price}"></div>
        <div class="field third"><label>Ár JD (Ft) — üres: JD kategória ár</label><input id="p_priceJD" type="number" min="0" value="${(p.priceJD===null||p.priceJD===undefined)?"":p.priceJD}"></div>
        <div class="field full"><label>Kép URL</label><input id="p_img" value="${escapeHtml(p.image)}"></div>

        <div class="field third"><label>Termék neve</label><input id="p_name" value="${escapeHtml(p.name_hu)}"></div>
        <div class="field third"><label>Íz HU</label><input id="p_fhu" value="${escapeHtml(p.flavor_hu)}"></div>
        <div class="field third"><label>Íz EN</label><input id="p_fen" value="${escapeHtml(p.flavor_en)}"></div>
      </div>
      <div class="small-muted" style="margin-top:10px;">
        soon → csak a "Hamarosan" tabban látszik. out/stock=0 → public oldalon leghátul + szürke.<br>
        Várható hónap formátum: ÉÉÉÉ-HH (pl. 2025-12)
      </div>
    `;

    openModal(editing ? "Termék szerkesztése" : "Új termék", "", body, [
      { label:"Mégse", kind:"ghost", onClick: closeModal },
      { label:"Mentés", kind:"primary", onClick: () => {
        const np = {
          id: ($("#p_id").value||"").trim(),
          categoryId: $("#p_cat").value,
          status: $("#p_status").value,
          visible: !!$("#p_visible").checked,
          visibleJD: !!$("#p_visibleJD").checked,
          stock: Math.max(0, Number($("#p_stock").value||0)),
          price: ($("#p_price").value === "" ? null : Math.max(0, Number($("#p_price").value||0))),
          priceJD: ($("#p_priceJD").value === "" ? null : Math.max(0, Number($("#p_priceJD").value||0))),
          image: ($("#p_img").value||"").trim(),
          name_hu: ($("#p_name").value||"").trim(),
          name_en: ($("#p_name").value||"").trim(),
          flavor_hu: ($("#p_fhu").value||"").trim(),
          flavor_en: ($("#p_fen").value||"").trim(),
          // ✅ Csak hónap formátumot fogadunk el
          soonEta: ($("#p_eta").value||"").replace(/^(\d{4}-\d{2}).*$/, "$1")
        };
        if(np.status !== "soon") np.soonEta = "";
        if(!np.id) return;

        if(editing){
          Object.assign(editing, np);
        }else{
          state.doc.products.push(np);
        }
        closeModal();
        renderAll();
        markDirty({ products:true });
      }}
    ]);

    // out -> stock automatikusan 0 + lock
    const stSel = $("#p_status");
    const stInp = $("#p_stock");
    const syncStockLock = () => {
      if(!stSel || !stInp) return;
      if(stSel.value === "out"){
        stInp.value = "0";
        stInp.disabled = true;
      }else{
        stInp.disabled = false;
      }
    };
    if(stSel){
      stSel.addEventListener("change", syncStockLock);
    }
    syncStockLock();
  }


function renderSales(){
  const cats = [{id:"all", label:"Mind"}, ...state.doc.categories.map(c=>({id:c.id,label:c.label_hu||c.id}))];

  const filterCat = state.filters.salesCat;
  const q = (state.filters.salesSearch || "").toLowerCase();

  let list = [...state.sales].sort((a,b)=> String(b.date).localeCompare(String(a.date)));
  if(q){
    list = list.filter(s => (`${s.name} ${s.payment}`).toLowerCase().includes(q));
  }
  if(filterCat !== "all"){
    list = list.filter(s => saleTotals(s, filterCat).hit);
  }

  const rows = list.map(s => {
    const tot = saleTotals(s, filterCat);
    const itemsCount = (s.items || []).reduce((acc,it)=> acc + Number(it.qty||0), 0);

    return `
      <div class="rowline">
        <div class="left">
          <div style="font-weight:900;">
            ${escapeHtml(s.date)} • ${escapeHtml(s.name || "—")}
            <span class="small-muted">• ${escapeHtml(s.payment || "")}</span>
          </div>
          <div class="small-muted">Tételek: <b>${itemsCount}</b> • Bevétel: <b>${tot.revenue.toLocaleString("hu-HU")} Ft</b></div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
          <button class="ghost" data-view="${escapeHtml(s.id)}">Megnéz</button>
          <button class="ghost" data-editsale="${escapeHtml(s.id)}">Szerkeszt</button>
          <button class="danger" data-delsale="${escapeHtml(s.id)}">Töröl (rollback)</button>
        </div>
      </div>
    `;
  }).join("");

  $("#panelSales").innerHTML = `
    <div class="admin-sales-embedwrap">
      <iframe class="admin-sales-embed" src="./?sv_admin=1" loading="lazy" referrerpolicy="no-referrer"></iframe>
    </div>
    ${renderReservationsSection()}
    <div class="actions table" style="align-items:center;">
      <button class="primary" id="btnAddSale">+ Eladás</button>
      <select id="salesCat">
        ${cats.map(c => `<option value="${escapeHtml(c.id)}"${c.id===filterCat?" selected":""}>${escapeHtml(c.label)}</option>`).join("")}
      </select>
      <input id="salesSearch" placeholder="Keresés név / mód szerint..." value="${escapeHtml(state.filters.salesSearch)}" style="flex:1;min-width:220px;">
      <div class="small-muted">Szűrés kategóriára: csak az adott kategória tételeit számolja.</div>
    </div>
    <div style="margin-top:10px;">${rows || `<div class="small-muted">Nincs eladás.</div>`}</div>
  `;

  $("#salesCat").onchange = () => { state.filters.salesCat = $("#salesCat").value; renderSales(); drawChart(); };
  $("#salesSearch").oninput = () => { state.filters.salesSearch = $("#salesSearch").value; renderSales(); };
  $("#btnAddSale").onclick = () => openSaleModal();

  $("#panelSales").querySelectorAll("button[data-delsale]").forEach(b => {
    b.onclick = () => deleteSale(b.dataset.delsale);
  });
  $("#panelSales").querySelectorAll("button[data-editsale]").forEach(b => {
    b.onclick = () => editSale(b.dataset.editsale);
  });
  $("#panelSales").querySelectorAll("button[data-view]").forEach(b => {
    b.onclick = () => viewSale(b.dataset.view);
  });

  $("#panelSales").querySelectorAll("button[data-res-del]").forEach(b=>{ b.onclick = () => deleteReservation(b.dataset.resDel); });
  $("#panelSales").querySelectorAll("button[data-res-confirm]").forEach(b=>{ b.onclick = () => confirmReservation(b.dataset.resConfirm); });
  $("#panelSales").querySelectorAll("button[data-res-edit]").forEach(b=>{ b.onclick = () => openReservationEditModal(b.dataset.resEdit); });
  $("#panelSales").querySelectorAll("button[data-res-sale]").forEach(b=>{ b.onclick = () => saleFromReservation(b.dataset.resSale); });

  startReservationTicker();
}


function prodLabel(p){
  const n = (p && (p.name_hu || p.name_en)) || "—";
  const f = (p && (p.flavor_hu || p.flavor_en)) || "";
  return n + (f ? " • " + f : "");
}

function openProductPicker(opts = {}){
  const title = opts.title || "Válassz terméket";
  const allowSoon = !!opts.allowSoon;

  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.innerHTML = `
      <input class="picker-search" id="pp_q" placeholder="Keresés (név / íz)...">
      <div id="pp_list" style="margin-top:12px;"></div>
    `;

    const qEl = body.querySelector("#pp_q");
    const listEl = body.querySelector("#pp_list");

    const cats = [...state.doc.categories].sort((a,b)=> (a.label_hu||a.id).localeCompare(b.label_hu||b.id,"hu"));

    const render = () => {
      const q = String(qEl.value || "").trim().toLowerCase();

      let prods = state.doc.products
        .filter(p => p && p.id)
        .filter(p => allowSoon ? true : (p.status !== "soon"));

      if(q){
        prods = prods.filter(p => (prodLabel(p).toLowerCase()).includes(q));
      }

      const byCat = new Map();
      for(const c of cats) byCat.set(String(c.id), []);
      byCat.set("_other", []);

      for(const p of prods){
        const k = byCat.has(String(p.categoryId)) ? String(p.categoryId) : "_other";
        byCat.get(k).push(p);
      }

      const sections = [];

      const renderGroup = (title, arr) => {
        if(!arr || !arr.length) return;
        arr.sort((a,b)=> prodLabel(a).localeCompare(prodLabel(b),"hu"));
        const items = arr.map(p => {
          const img = (p.image || "").trim();
          const thumb = img
            ? `<img class="picker-thumb" src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : `<div class="picker-thumb ph">SV</div>`;
          const eff = effectivePrice(p);
      const effJD = effectivePriceJD(p);
          const stockTxt = (p.status === "out") ? "Elfogyott" : (p.status === "soon" ? "Hamarosan" : `Készlet: ${Number(p.stock||0)}`);
          return `
            <button type="button" class="picker-item" data-pid="${escapeHtml(p.id)}">
              ${thumb}
              <div>
                <div class="picker-name">${escapeHtml(prodLabel(p))}</div>
                <div class="picker-sub">${escapeHtml(stockTxt)}</div>
              </div>
              <div class="picker-right"><b>${eff.toLocaleString("hu-HU")} Ft</b></div>
            </button>
          `;
        }).join("");
        sections.push(`
          <div class="picker-cat">${escapeHtml(title)}</div>
          <div class="picker-list">${items}</div>
        `);
      };

      for(const c of cats){
        renderGroup(c.label_hu || c.id, byCat.get(String(c.id)));
      }
      renderGroup("Egyéb", byCat.get("_other"));

      listEl.innerHTML = sections.length ? sections.join("") : `<div class="small-muted">Nincs találat.</div>`;
    };

    qEl.oninput = render;
    render();

    listEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pid]");
      if(!b) return;
      const pid = String(b.dataset.pid || "");
      closeModal();
      resolve(pid || null);
    });

    openModal(title, "Képes lista, kategóriánként", body, [
      { label:"Mégse", kind:"ghost", onClick: () => { closeModal(); resolve(null); } }
    ]);

    setTimeout(()=>{ try{ qEl.focus(); }catch{} }, 60);
  });
}


function openSaleModal(pre){
  const editingSaleId = (pre && pre.editSaleId) ? String(pre.editSaleId) : "";
  const existingSale = editingSaleId ? state.sales.find(x => String(x.id) === editingSaleId) : null;

  const preDate = (pre && pre.date) ? String(pre.date) : todayISO();
  const preName = (pre && pre.name) ? String(pre.name) : "";
  const prePay  = (pre && pre.payment) ? String(pre.payment) : "";
  const preItems = (pre && Array.isArray(pre.items)) ? pre.items : [];
  const title = (pre && pre.title) ? String(pre.title) : (existingSale ? "Eladás szerkesztése" : "Új eladás");

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="grid2">
      <div class="field"><label>Dátum (YYYY-MM-DD)</label><input id="s_date" type="text" value="${escapeHtml(preDate)}"></div>
      <div class="field"><label>Név (opcionális)</label><input id="s_name" type="text" value="${escapeHtml(preName)}"></div>
    </div>
    <div class="field" style="margin-top:10px;"><label>Fizetési mód (opcionális)</label><input id="s_pay" type="text" value="${escapeHtml(prePay)}"></div>
    <div class="field" style="margin-top:10px;">
      <label>Tételek</label>
      <div id="s_items"></div>
    </div>
    <div class="actions">
      <button class="ghost" id="btnAddItem" type="button">+ Tétel</button>
    </div>
  `;

  const itemsRoot = body.querySelector("#s_items");

  const addItemRow = (pref = {}) => {
    const row = document.createElement("div");
    row.className = "rowline table";
    row.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;width:100%;">
        <img class="it-thumb" alt="" />
        <button type="button" class="it-pick-btn it_pick">Válassz terméket…</button>
        <input type="hidden" class="it_prod" value="">
        <input class="it_qty" type="number" min="1" value="1" style="width:110px;">
        <input class="it_price" type="number" min="0" value="0" style="width:150px;">
        <button class="danger it_del" type="button">Töröl</button>
      </div>
    `;

    const pidInp = row.querySelector(".it_prod");
    const pickBtn = row.querySelector(".it_pick");
    const qtyInp = row.querySelector(".it_qty");
    const priceInp = row.querySelector(".it_price");
    const thumb = row.querySelector(".it-thumb");

    const syncThumb = (p) => {
      const img = p && (p.image || "").trim();
      if(!thumb) return;
      if(img){
        thumb.src = img;
        thumb.style.visibility = "visible";
      }else{
        thumb.removeAttribute("src");
        thumb.style.visibility = "hidden";
      }
    };

    const applyPid = (pid, setPrice = true) => {
      pidInp.value = String(pid || "");
      const p = prodById(pidInp.value);
      pickBtn.textContent = p ? prodLabel(p) : "Válassz terméket…";
      if(setPrice){
        priceInp.value = String(p ? effectivePrice(p) : 0);
      }
      syncThumb(p);
    };

    pickBtn.onclick = async () => {
      const pid = await openProductPicker({ title: "Válassz terméket" });
      if(pid) applyPid(pid, true);
    };

    row.querySelector(".it_del").onclick = () => row.remove();

    if(pref && pref.productId){
      applyPid(pref.productId, false);
      qtyInp.value = String(Math.max(1, Number(pref.qty || 1) || 1));
      const p = prodById(pidInp.value);
      if(pref.unitPrice !== undefined && pref.unitPrice !== null && String(pref.unitPrice) !== ""){
        priceInp.value = String(Math.max(0, Number(pref.unitPrice) || 0));
      }else{
        priceInp.value = String(p ? effectivePrice(p) : 0);
      }
      syncThumb(p);
    }else{
      applyPid("", true);
      priceInp.value = "0";
    }

    itemsRoot.appendChild(row);
  };

  if(preItems && preItems.length){
    for(const it of preItems) addItemRow(it);
  }else{
    addItemRow();
  }

  body.querySelector("#btnAddItem").onclick = () => addItemRow();

  openModal(title, "Név + dátum + mód + több termék", body, [
    { label:"Mégse", kind:"ghost", onClick: closeModal },
    { label:"Mentés", kind:"primary", onClick: () => {
      const date = ((document.querySelector('#s_date')?.value)||"").trim();
      const name = ((document.querySelector('#s_name')?.value)||"").trim();
      const payment = ((document.querySelector('#s_pay')?.value)||"").trim();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

      const rows = [...itemsRoot.querySelectorAll('.rowline')];
      const items = [];
      for(const r of rows){
        const pid = r.querySelector('.it_prod').value;
        if(!pid) continue;
        const qty = Math.max(1, Number(r.querySelector('.it_qty').value || 1) || 1);
        const unitPrice = Math.max(0, Number(r.querySelector('.it_price').value || 0) || 0);
        items.push({ productId: pid, qty, unitPrice });
      }
      if(!items.length) return;

      const workingStock = new Map(state.doc.products.map(p => [String(p.id), Number(p.stock || 0)]));
      if(existingSale){
        for(const old of (existingSale.items || [])){
          const prev = Number(workingStock.get(String(old.productId)) || 0);
          workingStock.set(String(old.productId), prev + Math.max(0, Number(old.qty || 0) || 0));
        }
      }

      for(const it of items){
        const p = prodById(it.productId);
        if(!p) return;
        if(p.status === 'soon') return;
        const available = Number(workingStock.get(String(it.productId)) || 0);
        if(available < it.qty){
          alert('Nincs elég készlet ehhez a mentéshez.');
          return;
        }
        workingStock.set(String(it.productId), available - it.qty);
      }

      if(existingSale){
        for(const old of (existingSale.items || [])){
          const p = prodById(old.productId);
          if(!p) continue;
          p.stock = Math.max(0, Number(p.stock || 0) + Math.max(0, Number(old.qty || 0) || 0));
          if(p.stock > 0 && p.status === 'out') p.status = 'ok';
        }
      }

      for(const it of items){
        const p = prodById(it.productId);
        if(!p) continue;
        p.stock = Math.max(0, Number(p.stock || 0) - it.qty);
        p.status = p.stock <= 0 ? 'out' : 'ok';
      }

      if(existingSale){
        existingSale.date = date;
        existingSale.name = name;
        existingSale.payment = payment;
        existingSale.items = items;
        existingSale.updatedAt = Date.now();
      }else{
        const saleRecord = {
          id: "s_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16),
          date,
          name,
          payment,
          items,
          createdAt: Date.now()
        };
        state.sales.push(saleRecord);

        if(pre && pre.fromReservationId){
          state.reservations = (state.reservations || []).filter(x => String(x.id) !== String(pre.fromReservationId));
          markDirty({ reservations:true });
        }
      }

      closeModal();
      renderAll();
      markDirty({ products:true, sales:true, reservations: !!(pre && pre.fromReservationId) });
    }}
  ]);
}

function viewSale(id){
    const s = state.sales.find(x => x.id === id);
    if(!s) return;

    const body = document.createElement("div");
    const lines = s.items.map(it => {
      const p = prodById(it.productId);
      const n = p ? (p.name_hu||p.name_en||"—") : "—";
      const f = p ? (p.flavor_hu||p.flavor_en||"") : "";
      const sum = Number(it.qty||0) * Number(it.unitPrice||0);
      return `<tr>
        <td>${escapeHtml(n)} <span class="small-muted">${escapeHtml(f? "• "+f:"")}</span></td>
        <td><b>${it.qty}</b></td>
        <td>${Number(it.unitPrice||0).toLocaleString("hu-HU")} Ft</td>
        <td><b>${sum.toLocaleString("hu-HU")} Ft</b></td>
      </tr>`;
    }).join("");

    const tot = saleTotals(s, "all").revenue;

    body.innerHTML = `
      <div class="small-muted">${escapeHtml(s.date)} • ${escapeHtml(s.name)} • ${escapeHtml(s.payment)}</div>
      <div style="margin-top:6px;font-weight:900;">Összesen: ${tot.toLocaleString("hu-HU")} Ft</div>
      <table class="table" style="margin-top:10px;">
        <thead><tr><th>Termék</th><th>Db</th><th>Egységár</th><th>Összeg</th></tr></thead>
        <tbody>${lines}</tbody>
      </table>
    `;

    openModal("Eladás", "", body, [
      { label:"Bezár", kind:"primary", onClick: closeModal }
    ]);
  }

  


  function isReservationExpired(r){
    if(!r) return true;
    if(r.confirmed) return false;
    const ex = Number(r.expiresAt || 0) || 0;
    if(!ex) return false;
    return Date.now() >= ex;
  }

  function formatRemaining(ms){
    const sec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const hh = String(h).padStart(2,"0");
    const mm = String(m).padStart(2,"0");
    const ss = String(s).padStart(2,"0");
    return (d > 0 ? `${d}n ` : "") + `${hh}:${mm}:${ss}`;
  }

  function reservationTotals(r){
    let qty = 0;
    let sum = 0;
    for(const it of (r.items || [])){
      const q = Number(it.qty || 0) || 0;
      const up = Number(it.unitPrice || 0) || 0;
      qty += q;
      sum += q * up;
    }
    return { qty, sum };
  }

  function renderReservationsSection(){
    const list = (state.reservations || [])
      .filter(r => r && !r.recorded && !r.deleted && (r.confirmed || !isReservationExpired(r)))
      .sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    if(!list.length){
      return `<div class="small-muted" style="margin:10px 0;">Nincs aktív foglalás.</div>`;
    }

    const rows = list.map(r => {
      const code = r.publicCode || "—";
      const dateTxt = r.createdAt ? new Date(Number(r.createdAt)).toLocaleString("hu-HU") : "—";
      const { qty, sum } = reservationTotals(r);

      const ex = (!r.confirmed && r.expiresAt) ? Number(r.expiresAt) : 0;
      const timerTxt = r.confirmed ? "Megerősítve" : (ex ? formatRemaining(ex - Date.now()) : "—");

      return `
        <div class="rowline table reservation-row" style="align-items:center;">
          <div class="left" style="min-width:0;">
            <div style="font-weight:950;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <span>Foglalás <b>#${escapeHtml(code)}</b></span>
              <span class="small-muted">• ${escapeHtml(dateTxt)}</span>
              <span class="small-muted">• ID: <b>${escapeHtml(r.id)}</b></span>
            </div>
            <div class="small-muted" style="margin-top:2px;">
              Tételek: <b>${qty}</b> • Összeg: <b>${Number(sum || 0).toLocaleString("hu-HU")} Ft</b>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
            ${r.confirmed ? `<span class="res-timer">—</span>` : `<span class="res-timer" data-expires="${escapeHtml(ex)}">${escapeHtml(timerTxt)}</span>`}
            <button class="ghost" data-res-edit="${escapeHtml(r.id)}">Szerkesztés</button>
            ${r.confirmed ? "" : `<button class="primary" data-res-confirm="${escapeHtml(r.id)}">Megerősítés</button>`}
            <button class="primary" data-res-sale="${escapeHtml(r.id)}">Eladás rögzítése</button>
            <button class="danger" data-res-del="${escapeHtml(r.id)}">Törlés</button>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div style="margin:12px 0 6px;font-weight:950;">Foglalások</div>
      ${rows}
    `;
  }

  function purgeExpiredReservations(){
    const before = (state.reservations || []).length;
    if(!before) return;
    const now = Date.now();
    const kept = (state.reservations || []).filter(r => {
      if(!r) return false;
      if(r.confirmed) return true;
      const ex = Number(r.expiresAt || 0) || 0;
      if(!ex) return true;
      return ex > now;
    });
    if(kept.length !== before){
      state.reservations = kept;
      markDirty({ reservations:true });
      renderAll();
    }
  }

  let _resTick = null;
  function startReservationTicker(){
    try{ if(_resTick) clearInterval(_resTick); }catch{}
    _resTick = setInterval(() => {
      try{ purgeExpiredReservations(); }catch{}
      document.querySelectorAll('.res-timer[data-expires]').forEach(el => {
        const ex = Number(el.dataset.expires||0) || 0;
        const ms = ex - Date.now();
        if(ms <= 0){
          el.textContent = 'LEJÁRT';
        }else{
          el.textContent = formatRemaining(ms);
        }
      });
    }, 1000);
  }

  function findReservation(id){
    return (state.reservations || []).find(r => String(r.id) === String(id));
  }


function deleteReservation(id){
  const r = findReservation(id);
  if(!r) return;
  if(!confirm('Biztos törlöd ezt a foglalást?')) return;
  r.deleted = true;
  r.lastAction = 'Foglalás törölve';
  renderAll();
  markDirty({ reservations:true });
}

function confirmReservation(id){
  const r = findReservation(id);
  if(!r) return;
  r.confirmed = true;
  r.expiresAt = null;
  r.lastAction = 'Foglalás megerősítve';
  renderAll();
  markDirty({ reservations:true });
}

function reservedByOthers(pid, excludeId){
    let sum = 0;
    for(const r of (state.reservations||[])){
      if(!r) continue;
      if(String(r.id) === String(excludeId)) continue;
      if(isReservationExpired(r)) continue;
      for(const it of (r.items||[])){
        if(String(it.productId) === String(pid)) sum += Number(it.qty||0)||0;
      }
    }
    return sum;
  }

  function openReservationEditModal(id){
    const r = findReservation(id);
    if(!r) return;

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="small-muted">#${escapeHtml(r.publicCode||'---')} • ID: ${escapeHtml(r.id)}</div>
      <div class="small-muted" style="margin-top:6px;">${r.confirmed ? 'Megerősítve' : ('Lejárat: ' + (r.expiresAt ? new Date(Number(r.expiresAt)).toLocaleString('hu-HU') : '—'))}</div>
      <div class="field" style="margin-top:12px;">
        <label>Tételek</label>
        <div id="r_items"></div>
      </div>
      <div class="actions">
        <button class="ghost" id="btnAddResItem">+ Tétel</button>
      </div>
    `;

    const itemsRoot = body.querySelector('#r_items');


const addRow = (pref) => {
  const row = document.createElement('div');
  row.className = 'rowline table';
  row.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;width:100%;">
      <img class="it-thumb" alt="" />
      <button type="button" class="it-pick-btn it_pick">Válassz terméket…</button>
      <input type="hidden" class="it_prod" value="">
      <input class="it_qty" type="number" min="1" value="1" style="width:110px;">
      <button class="danger it_del" type="button">Töröl</button>
    </div>
  `;

  const pidInp = row.querySelector('.it_prod');
  const pickBtn = row.querySelector('.it_pick');
  const qtyInp = row.querySelector('.it_qty');
  const thumb = row.querySelector('.it-thumb');

  const syncThumb = (p) => {
    const img = p && (p.image||'').trim();
    if(!thumb) return;
    if(img){
      thumb.src = img;
      thumb.style.visibility = 'visible';
    }else{
      thumb.removeAttribute('src');
      thumb.style.visibility = 'hidden';
    }
  };

  const applyPid = (pid) => {
    pidInp.value = String(pid || '');
    const p = prodById(pidInp.value);
    pickBtn.textContent = p ? prodLabel(p) : 'Válassz terméket…';
    syncThumb(p);
  };

  pickBtn.onclick = async () => {
    const pid = await openProductPicker({ title: "Válassz terméket" });
    if(pid) applyPid(pid);
  };

  row.querySelector('.it_del').onclick = () => row.remove();

  if(pref && pref.productId){
    applyPid(pref.productId);
    qtyInp.value = String(Math.max(1, Number(pref.qty||1)||1));
  }else{
    applyPid('');
  }

  itemsRoot.appendChild(row);
};

    for(const it of (r.items||[])) addRow({ productId: it.productId, qty: it.qty });
    body.querySelector('#btnAddResItem').onclick = () => addRow();

    openModal('Foglalás szerkesztése', 'Tételek módosítása', body, [
      { label:'Mégse', kind:'ghost', onClick: closeModal },
      { label:'Mentés', kind:'primary', onClick: () => {
        const rows = [...itemsRoot.querySelectorAll('.rowline')];
        const items = [];
        for(const rr of rows){
          const pid = rr.querySelector('.it_prod').value;
          if(!pid) continue;
          const qty = Math.max(1, Number(rr.querySelector('.it_qty').value||1));
          const p = prodById(pid);
          if(!p || p.status === 'soon') return;
          items.push({ productId: pid, qty, unitPrice: effectivePrice(p) });
        }
        if(!items.length) return;

        for(const it of items){
          const p = prodById(it.productId);
          const other = reservedByOthers(it.productId, r.id);
          if((Number(p.stock||0) - other) < it.qty){
            alert('Nincs elég raktárkészlet ehhez a módosításhoz.');
            return;
          }
        }

        r.items = items;
        r.modified = true;
        r.modifiedAt = Date.now();
        r.editCount = Math.max(0, Number(r.editCount || 0) || 0) + 1;
        r.lastAction = 'Foglalás szerkesztve';
        closeModal();
        renderAll();
        markDirty({ reservations:true });
      }}
    ]);
  }

  function saleFromReservation(id){
    const r = findReservation(id);
    if(!r) return;
    const preItems = (r.items||[]).map(it => ({ productId: it.productId, qty: it.qty, unitPrice: it.unitPrice }));
    openSaleModal({
      title: `Eladás rögzítése (foglalás #${r.publicCode||'---'})`,
      date: todayISO(),
      name: '',
      payment: '',
      items: preItems,
      fromReservationId: r.id
    });
  }

function editSale(id){
  const s = state.sales.find(x => String(x.id) === String(id));
  if(!s) return;
  openSaleModal({
    title: `Eladás szerkesztése (${s.id})`,
    date: String(s.date || todayISO()),
    name: String(s.name || ''),
    payment: String(s.payment || ''),
    items: (s.items || []).map(it => ({ productId: it.productId, qty: it.qty, unitPrice: it.unitPrice })),
    editSaleId: s.id
  });
}


function deleteSale(id){
    const idx = state.sales.findIndex(x => x.id === id);
    if(idx < 0) return;
    const s = state.sales[idx];

    for(const it of (s.items || [])){
      const p = prodById(it.productId);
      if(!p) continue;
      p.stock = Math.max(0, Number(p.stock||0) + Number(it.qty||0));
      if(p.stock > 0 && p.status === "out") p.status = "ok";
    }

    state.sales.splice(idx, 1);
    renderAll();
    markDirty({ products:true, sales:true });
  }

  function pad2(n){ return String(n).padStart(2,"0"); }
  function toLocalISODate(d){
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }
  function parseLocalISODate(s){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return new Date();
    const [y,m,d] = String(s).split('-').map(Number);
    return new Date(y, (m||1)-1, d||1);
  }
  function startOfWeekMonday(date){
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0,0,0,0);
    return d;
  }
  function endOfWeekSunday(date){
    const s = startOfWeekMonday(date);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    e.setHours(0,0,0,0);
    return e;
  }
  function weekInputFromDate(date){
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
  }
  function dateFromWeekInput(weekValue){
    const m = String(weekValue || '').match(/^(\d{4})-W(\d{2})$/);
    if(!m) return startOfWeekMonday(new Date());
    const year = Number(m[1]);
    const week = Number(m[2]);
    const jan4 = new Date(year, 0, 4);
    const jan4Monday = startOfWeekMonday(jan4);
    const d = new Date(jan4Monday);
    d.setDate(jan4Monday.getDate() + (week - 1) * 7);
    d.setHours(0,0,0,0);
    return d;
  }
  function endOfMonth(date){
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
  }
  function shortMonthHu(monthIndex){
    return ['Jan','Febr','Márc','Ápr','Máj','Jún','Júl','Aug','Szept','Okt','Nov','Dec'][monthIndex] || '';
  }
  function chartLabelForDate(isoDate, mode){
    const d = parseLocalISODate(isoDate);
    if(mode === 'month') return `${pad2(d.getMonth()+1)}.${pad2(d.getDate())}`;
    if(mode === 'week') return ['H','K','Sze','Cs','P','Szo','V'][d.getDay() === 0 ? 6 : d.getDay()-1];
    if(mode === 'day') return isoDate;
    return isoDate.slice(0,7);
  }

  function renderChartPanel(){
    const cats = [{id:"all", label:"Mind"}, ...state.doc.categories.map(c=>({id:c.id,label:c.label_hu||c.id}))];
    const now = new Date();
    if(!state.filters.chartYear) state.filters.chartYear = String(now.getFullYear());
    if(!state.filters.chartMonth) state.filters.chartMonth = `${now.getFullYear()}-${pad2(now.getMonth()+1)}`;
    if(!state.filters.chartWeek) state.filters.chartWeek = weekInputFromDate(now);
    if(!state.filters.chartDay) state.filters.chartDay = toLocalISODate(now);

    $("#panelChart").innerHTML = `
      <div class="actions table" style="align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div class="small-muted">Bevétel diagrammok (eladások alapján)</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
          <div class="small-muted">Kategória:</div>
          <select id="chartCat">
            ${cats.map(c => `<option value="${escapeHtml(c.id)}"${c.id===state.filters.chartCat?" selected":""}>${escapeHtml(c.label)}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="kpi" style="margin-top:10px;">
        <div class="box" style="min-width:170px;"><div class="t">Összesen</div><div class="v" id="kpi_all">0 Ft</div></div>
        <div class="box" style="min-width:170px;"><div class="t">Év</div><div class="v" id="kpi_year">0 Ft</div></div>
        <div class="box" style="min-width:170px;"><div class="t">Hónap</div><div class="v" id="kpi_month">0 Ft</div></div>
        <div class="box" style="min-width:170px;"><div class="t">Hét</div><div class="v" id="kpi_week">0 Ft</div></div>
        <div class="box" style="min-width:170px;"><div class="t">Nap</div><div class="v" id="kpi_day">0 Ft</div></div>
      </div>

      <div class="chart-card">
        <div class="chart-head"><div><div class="chart-title">Összesen</div><div class="small-muted">Havi bontás (teljes időszak)</div></div></div>
        <canvas id="revAll" height="220"></canvas>
      </div>

      <div class="chart-card">
        <div class="chart-head" style="gap:12px;flex-wrap:wrap;justify-content:space-between;">
          <div><div class="chart-title">Évi</div><div class="small-muted">Jan 1 – Dec 31</div></div>
          <input id="chartYearRef" type="number" min="2020" max="2100" value="${escapeHtml(state.filters.chartYear)}" style="width:120px;">
        </div>
        <canvas id="revYear" height="220"></canvas>
      </div>

      <div class="chart-card">
        <div class="chart-head" style="gap:12px;flex-wrap:wrap;justify-content:space-between;">
          <div><div class="chart-title">Havi</div><div class="small-muted">A kiválasztott hónap teljes időszaka</div></div>
          <input id="chartMonthRef" type="month" value="${escapeHtml(state.filters.chartMonth)}">
        </div>
        <canvas id="revMonth" height="220"></canvas>
      </div>

      <div class="chart-card">
        <div class="chart-head" style="gap:12px;flex-wrap:wrap;justify-content:space-between;">
          <div><div class="chart-title">Heti</div><div class="small-muted">Hétfő – vasárnap</div></div>
          <input id="chartWeekRef" type="week" value="${escapeHtml(state.filters.chartWeek)}">
        </div>
        <canvas id="revWeek" height="220"></canvas>
      </div>

      <div class="chart-card">
        <div class="chart-head" style="gap:12px;flex-wrap:wrap;justify-content:space-between;">
          <div><div class="chart-title">Napi</div><div class="small-muted">A kiválasztott nap teljes összege</div></div>
          <input id="chartDayRef" type="date" value="${escapeHtml(state.filters.chartDay)}">
        </div>
        <canvas id="revDay" height="220"></canvas>
      </div>
    `;

    $("#chartCat").onchange = () => { state.filters.chartCat = $("#chartCat").value; drawChart(); };
    $("#chartYearRef").onchange = () => { state.filters.chartYear = $("#chartYearRef").value || String(new Date().getFullYear()); drawChart(); };
    $("#chartMonthRef").onchange = () => { state.filters.chartMonth = $("#chartMonthRef").value || state.filters.chartMonth; drawChart(); };
    $("#chartWeekRef").onchange = () => { state.filters.chartWeek = $("#chartWeekRef").value || state.filters.chartWeek; drawChart(); };
    $("#chartDayRef").onchange = () => { state.filters.chartDay = $("#chartDayRef").value || state.filters.chartDay; drawChart(); };

    drawChart();
  }

function drawChart(){
  const cat = state.filters.chartCat || "all";

  const css = getComputedStyle(document.documentElement);
  const accent = (css.getPropertyValue("--brand2") || "#4aa3ff").trim();
  const accentSoft = "rgba(40,215,255,.22)";
  const grid = "rgba(255,255,255,.08)";
  const text = "rgba(255,255,255,.82)";
  const muted = "rgba(255,255,255,.55)";
  const fmtFt = (n) => `${Math.round(n).toLocaleString("hu-HU")} Ft`;

  const now = new Date();
  const todayIso = toLocalISODate(now);
  const selectedYear = Math.max(2000, Number(state.filters.chartYear || now.getFullYear()) || now.getFullYear());
  const selectedMonth = /^\d{4}-\d{2}$/.test(String(state.filters.chartMonth || '')) ? state.filters.chartMonth : `${now.getFullYear()}-${pad2(now.getMonth()+1)}`;
  const selectedWeek = /^\d{4}-W\d{2}$/.test(String(state.filters.chartWeek || '')) ? state.filters.chartWeek : weekInputFromDate(now);
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(String(state.filters.chartDay || '')) ? state.filters.chartDay : todayIso;

  const yearStartIso = `${selectedYear}-01-01`;
  const yearEndIso = `${selectedYear}-12-31`;
  const monthDate = parseLocalISODate(`${selectedMonth}-01`);
  const monthStartIso = toLocalISODate(new Date(monthDate.getFullYear(), monthDate.getMonth(), 1));
  const monthEndIso = toLocalISODate(endOfMonth(monthDate));
  const weekStart = dateFromWeekInput(selectedWeek);
  const weekEnd = endOfWeekSunday(weekStart);
  const weekStartIso = toLocalISODate(weekStart);
  const weekEndIso = toLocalISODate(weekEnd);
  const dayStartIso = selectedDay;
  const dayEndIso = selectedDay;

  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
  const inRange = (isoDate, startIso, endIso) => isoDate >= startIso && isoDate <= endIso;

  const dayMap = new Map();
  let allTotal = 0, yearTotal = 0, monthTotal = 0, weekTotal = 0, dayTotal = 0;

  for(const s of (state.sales || [])){
    const dt = String(s.date || '').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;

    const tot = saleTotals(s, cat);
    const rev = Number(tot.revenue || 0);
    if(!rev) continue;

    dayMap.set(dt, (dayMap.get(dt) || 0) + rev);
    allTotal += rev;
    if(inRange(dt, yearStartIso, yearEndIso)) yearTotal += rev;
    if(inRange(dt, monthStartIso, monthEndIso)) monthTotal += rev;
    if(inRange(dt, weekStartIso, weekEndIso)) weekTotal += rev;
    if(inRange(dt, dayStartIso, dayEndIso)) dayTotal += rev;
  }

  const setKpi = (id, val) => { const el = $(id); if(el) el.textContent = fmtFt(val); };
  setKpi('#kpi_all', allTotal);
  setKpi('#kpi_year', yearTotal);
  setKpi('#kpi_month', monthTotal);
  setKpi('#kpi_week', weekTotal);
  setKpi('#kpi_day', dayTotal);

  const buildDailySeries = (startIso, endIso, mode='month') => {
    const s = parseLocalISODate(startIso);
    const e = parseLocalISODate(endIso);
    const arr = [];
    for(let d = new Date(s); d <= e; d = addDays(d,1)){
      const key = toLocalISODate(d);
      arr.push({ label: chartLabelForDate(key, mode), rev: Number(dayMap.get(key) || 0), rawLabel: key });
    }
    return arr;
  };

  const buildMonthlySeries = (startIso, endIso, labelMode='all') => {
    const s = parseLocalISODate(startIso);
    const e = parseLocalISODate(endIso);
    const m = new Map();
    for(const [k, v] of dayMap.entries()){
      if(k < startIso || k > endIso) continue;
      const ym = k.slice(0,7);
      m.set(ym, (m.get(ym) || 0) + Number(v || 0));
    }
    const arr = [];
    const cur = new Date(s.getFullYear(), s.getMonth(), 1);
    const end = new Date(e.getFullYear(), e.getMonth(), 1);
    while(cur <= end){
      const ym = `${cur.getFullYear()}-${pad2(cur.getMonth()+1)}`;
      const label = labelMode === 'year' ? shortMonthHu(cur.getMonth()) : ym;
      arr.push({ label, rev: Number(m.get(ym) || 0), rawLabel: ym });
      cur.setMonth(cur.getMonth() + 1);
    }
    return arr;
  };

  const drawLine = (canvas, points) => {
    if(!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width || canvas.parentElement?.clientWidth || 300);
    const h = Math.max(1, rect.height || Number(canvas.getAttribute('height')) || 220);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    const ctx = canvas.getContext('2d');
    if(!ctx) return;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);

    const padL = 54, padR = 18, padT = 20, padB = 42;
    const pw = Math.max(1, w - padL - padR);
    const ph = Math.max(1, h - padT - padB);
    const max = Math.max(1, ...points.map(p => Number(p.rev || 0)));
    const n = points.length;

    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    for(let i=0;i<=4;i++){
      const y = padT + (ph * i/4);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
      ctx.stroke();
    }

    ctx.fillStyle = muted;
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for(let i=0;i<=4;i++){
      const v = Math.round(max * (1 - i/4));
      const y = padT + (ph * i/4);
      ctx.fillText(fmtFt(v).replace(' Ft',''), padL - 8, y);
    }

    const xAt = (i) => n <= 1 ? (padL + pw / 2) : padL + (pw * (i / (n - 1)));
    const yAt = (v) => padT + ph - (ph * (Number(v || 0) / max));

    if(n === 1){
      const p = points[0] || { rev:0, label:'' };
      const x = xAt(0);
      const y = yAt(p.rev);
      ctx.fillStyle = accentSoft;
      ctx.fillRect(x - 26, y, 52, padT + ph - y);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 26, y, 52, padT + ph - y);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(p.label || ''), x, padT + ph + 10);
      return;
    }

    const area = ctx.createLinearGradient(0, padT, 0, padT + ph);
    area.addColorStop(0, accentSoft);
    area.addColorStop(1, 'rgba(40,215,255,0)');

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.rev);
      if(i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xAt(n - 1), padT + ph);
    ctx.lineTo(xAt(0), padT + ph);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.rev);
      if(i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = accent;
    points.forEach((p,i)=>{
      const x = xAt(i);
      const y = yAt(p.rev);
      ctx.beginPath();
      ctx.arc(x,y,3.4,0,Math.PI*2);
      ctx.fill();
    });

    ctx.fillStyle = text;
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const labelIndexes = n <= 3 ? [...Array(n).keys()] : [0, Math.floor((n - 1) / 2), n - 1];
    [...new Set(labelIndexes)].forEach(i => {
      const p = points[i];
      if(!p) return;
      ctx.fillText(String(p.label || ''), xAt(i), padT + ph + 10);
    });
  };

  const allDates = [...dayMap.keys()].sort();
  const allStart = allDates[0] || todayIso;
  const allEnd = allDates[allDates.length - 1] || todayIso;

  const seriesAll = buildMonthlySeries(allStart, allEnd, 'all');
  const seriesYear = buildMonthlySeries(yearStartIso, yearEndIso, 'year');
  const seriesMonth = buildDailySeries(monthStartIso, monthEndIso, 'month');
  const seriesWeek = buildDailySeries(weekStartIso, weekEndIso, 'week');
  const seriesDay = buildDailySeries(dayStartIso, dayEndIso, 'day');

  drawLine($('#revAll'), seriesAll);
  drawLine($('#revYear'), seriesYear);
  drawLine($('#revMonth'), seriesMonth);
  drawLine($('#revWeek'), seriesWeek);
  drawLine($('#revDay'), seriesDay);
}

  function renderAll(){
    renderSettings();
    renderCategories();
    renderProducts();
    renderSales();
    renderChartPanel();
    renderPopups();
    drawChart();
  }

  /* ---------- init ---------- */
  async function hydrateSourceConfig(){
    try{
      const cfg = loadCfg();
      const needApi = !String(cfg.resApi || '').trim();
      if(!needApi) return;
      const r = await fetch(`data/sv_source.json?_=${Date.now()}`, { cache:'no-store' });
      if(!r.ok) return;
      const j = await r.json();
      const next = { ...cfg };
      next.resApi = String(j.reserveApi || j.reserve_api || j.reservationsApi || j.reservations_api || j.resApi || j.res_api || cfg.resApi || '').trim();
      saveCfg(next);
      try{
        const src = JSON.parse(localStorage.getItem('sv_source') || 'null') || {};
        localStorage.setItem('sv_source', JSON.stringify({ ...src, reserveApi: next.resApi || src.reserveApi || '' }));
      }catch{}
    }catch{}
  }

  async function init(){
    renderTabs();
    $("#btnReload").onclick = () => location.reload();
    $("#modalCloseBtn")?.addEventListener("click", closeModal);

    // first render panels + inject settings inputs ids
    await hydrateSourceConfig();
    renderSettings();

    // reservation expiry ticker (safe even before load)
    startReservationTicker();

    // Cart -> Sale (iframe) bridge
    window.addEventListener("message", (ev)=>{
      const d = ev && ev.data;
      if(!d || d.type !== "sv_admin_cart_sale") return;
      const items = Array.isArray(d.items) ? d.items : [];
      if(!items.length) return;
      try{ document.querySelector('#tabs button[data-tab="sales"]')?.click(); }catch{}
      openSaleModal({ items });
    });

    // betöltés ha van config
    const cfg = loadCfg();

    // autoload, ha van minden
    if(cfg.owner && cfg.repo && cfg.token){
      // töltsük be az inputokba is
      $("#cfgOwner").value = cfg.owner;
      $("#cfgRepo").value = cfg.repo;
      $("#cfgBranch").value = cfg.branch || "main";
      $("#cfgToken").value = cfg.token;

      loadData();
    }else{
      setSaveStatus("bad","Add meg a GH adatokat");
    }
  }

  init();
})();