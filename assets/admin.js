(() => {
  const $ = (s) => document.querySelector(s);

  const LS = {
    owner: "sv_owner",
    repo: "sv_repo",
    branch: "sv_branch",
    token: "sv_token",
    resApi: "sv_res_api",
  };

  function makeRuntimeId(prefix="id"){
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;
  }

  function getPersistentId(key, prefix="device"){
    try{
      const cur = String(localStorage.getItem(key) || "").trim();
      if(cur) return cur;
      const next = makeRuntimeId(prefix);
      localStorage.setItem(key, next);
      return next;
    }catch{
      return makeRuntimeId(prefix);
    }
  }

  function createDocMutationTracker(){
    return {
      productUpserts: new Set(),
      productDeletes: new Set(),
      categoryUpserts: new Set(),
      categoryDeletes: new Set(),
      popupsDirty: false,
      metaDirty: false,
    };
  }

  const state = {
    doc: { categories: [], products: [], popups: [], _meta: {} },
    sales: [],
    reservations: [],
    audit: { events: [], users: {}, _meta: {} },
    dirtyReservations: false,
    loaded: false,
    saving: false,
    saveQueued: false,
    dirty: false,
    dirtyProducts: false,
    dirtySales: false,
    dirtyAudit: false,
    productsStructuralDirty: false,
    stockDeltaByProduct: new Map(),
    stockAbsoluteByProduct: new Map(),
    docMutations: createDocMutationTracker(),
    salesUpserts: new Set(),
    salesDeletes: new Set(),
    reservationUpserts: new Set(),
    reservationDeletes: new Set(),
    auditPendingEvents: [],
    auditUsersDirty: new Map(),
    saveTimer: null,
    shas: { products: null, sales: null, reservations: null, audit: null },
    // hogy a public oldal biztosan megtalálja a RAW forrást (telefonon is)
    forceSourceSync: false,
    deviceId: getPersistentId("sv_admin_device_id", "admindev"),
    clientId: (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : makeRuntimeId("adminsess"),
    activeTab: "products",
    filters: {
      productsCat: "all",
      salesCat: "all",
      chartCat: "all",
      chartAllFrom: "",
      chartAllTo: "",
      chartYear: "",
      chartMonth: "",
      chartWeek: "",
      chartDay: "",
      productsSearch: "",
      salesSearch: "",
      historySearch: "",
      historyType: "activity",
      usersSearch: ""
    }
  };

  /* ---------- UI helpers ---------- */
  function setSaveStatus(type, text){
    const dot = $("#saveDot");
    dot.classList.remove("ok","busy","bad");
    dot.classList.add(type);
    $("#saveText").textContent = text;
  }

  function clone(v){
    return JSON.parse(JSON.stringify(v));
  }

  function emptyDoc(){
    return { categories: [], products: [], popups: [], _meta: {} };
  }

  function emptyAudit(){
    return { events: [], users: {}, _meta: {} };
  }

  function safeJsonParse(text, fallback){
    try{
      return JSON.parse(text);
    }catch{
      return fallback;
    }
  }

  function resetDocMutationTracker(){
    state.docMutations = createDocMutationTracker();
  }

  function hasDocMutations(){
    const m = state.docMutations || createDocMutationTracker();
    return !!(m.popupsDirty || m.metaDirty || m.productUpserts.size || m.productDeletes.size || m.categoryUpserts.size || m.categoryDeletes.size || state.stockDeltaByProduct.size || state.stockAbsoluteByProduct.size);
  }

  function trackProductUpsert(pid){
    const key = String(pid || "");
    if(!key) return;
    state.docMutations.productDeletes.delete(key);
    state.docMutations.productUpserts.add(key);
  }

  function trackProductDelete(pid){
    const key = String(pid || "");
    if(!key) return;
    state.docMutations.productUpserts.delete(key);
    state.docMutations.productDeletes.add(key);
    state.stockDeltaByProduct.delete(key);
    state.stockAbsoluteByProduct.delete(key);
  }

  function trackCategoryUpsert(cid){
    const key = String(cid || "");
    if(!key) return;
    state.docMutations.categoryDeletes.delete(key);
    state.docMutations.categoryUpserts.add(key);
  }

  function trackCategoryDelete(cid){
    const key = String(cid || "");
    if(!key) return;
    state.docMutations.categoryUpserts.delete(key);
    state.docMutations.categoryDeletes.add(key);
  }

  function trackPopupsDirty(){
    state.docMutations.popupsDirty = true;
  }

  function trackMetaDirty(){
    state.docMutations.metaDirty = true;
  }

  function resetSalesMutationTracker(){
    state.salesUpserts = new Set();
    state.salesDeletes = new Set();
  }

  function trackSaleUpsert(id){
    const key = String(id || "");
    if(!key) return;
    state.salesDeletes.delete(key);
    state.salesUpserts.add(key);
  }

  function trackSaleDelete(id){
    const key = String(id || "");
    if(!key) return;
    state.salesUpserts.delete(key);
    state.salesDeletes.add(key);
  }

  function resetReservationMutationTracker(){
    state.reservationUpserts = new Set();
    state.reservationDeletes = new Set();
  }

  function trackReservationUpsert(id){
    const key = String(id || "");
    if(!key) return;
    state.reservationDeletes.delete(key);
    state.reservationUpserts.add(key);
  }

  function trackReservationDelete(id){
    const key = String(id || "");
    if(!key) return;
    state.reservationUpserts.delete(key);
    state.reservationDeletes.add(key);
  }

  function normalizeAudit(doc){
    const base = (!doc || typeof doc !== "object") ? emptyAudit() : doc;
    const usersRaw = (base.users && typeof base.users === "object") ? base.users : {};
    const users = {};
    Object.entries(usersRaw).forEach(([key, value]) => {
      if(!key || !value || typeof value !== "object") return;
      users[String(key)] = {
        key: String(key),
        area: String(value.area || "unknown"),
        label: String(value.label || value.area || "unknown"),
        deviceId: String(value.deviceId || key),
        sessionId: String(value.sessionId || ""),
        firstSeen: Number(value.firstSeen || value.createdAt || 0) || 0,
        lastSeen: Number(value.lastSeen || value.updatedAt || 0) || 0,
        sessions: Math.max(1, Number(value.sessions || 1) || 1),
        views: Math.max(0, Number(value.views || 0) || 0),
        actions: Math.max(0, Number(value.actions || 0) || 0),
        lastPage: String(value.lastPage || ""),
        referrer: String(value.referrer || ""),
        ua: String(value.ua || ""),
        platform: String(value.platform || ""),
        language: String(value.language || ""),
        timezone: String(value.timezone || ""),
        screen: String(value.screen || ""),
        viewport: String(value.viewport || ""),
        touch: !!value.touch,
        webdriver: !!value.webdriver,
        suspicious: Math.max(0, Number(value.suspicious || 0) || 0),
        botSignals: Array.isArray(value.botSignals) ? value.botSignals.map(x => String(x)) : [],
        lastEvent: String(value.lastEvent || ""),
        lastSummary: String(value.lastSummary || ""),
        secretSearches: Math.max(0, Number(value.secretSearches || 0) || 0),
        reservations: Math.max(0, Number(value.reservations || 0) || 0),
        cartAdds: Math.max(0, Number(value.cartAdds || 0) || 0),
        cartChanges: Math.max(0, Number(value.cartChanges || 0) || 0),
        searches: Math.max(0, Number(value.searches || 0) || 0),
        lastSearchAt: Math.max(0, Number(value.lastSearchAt || 0) || 0),
        lastSearchText: String(value.lastSearchText || ""),
        lastSecretSearchAt: Math.max(0, Number(value.lastSecretSearchAt || 0) || 0),
        lastReservationAt: Math.max(0, Number(value.lastReservationAt || 0) || 0),
        lastCartAt: Math.max(0, Number(value.lastCartAt || 0) || 0),
        notes: Array.isArray(value.notes) ? value.notes.map(x => String(x)) : [],
      };
    });

    const events = Array.isArray(base.events) ? base.events.map((ev) => ({
      id: String(ev && ev.id || makeRuntimeId("audit")),
      ts: Number(ev && ev.ts || Date.now()) || Date.now(),
      scope: String(ev && ev.scope || "system"),
      area: String(ev && ev.area || "admin"),
      action: String(ev && ev.action || "event"),
      summary: String(ev && ev.summary || ""),
      sessionId: String(ev && ev.sessionId || ""),
      deviceId: String(ev && ev.deviceId || ""),
      details: (ev && typeof ev.details === "object" && ev.details) ? ev.details : {},
    })) : [];

    events.sort((a,b) => Number(b.ts || 0) - Number(a.ts || 0));
    return {
      users,
      events,
      _meta: {
        rev: Number(base._meta && base._meta.rev || 0) || 0,
        updatedAt: String(base._meta && base._meta.updatedAt || "")
      }
    };
  }

  function mergeAuditUser(prev, next){
    const base = prev && typeof prev === "object" ? prev : {};
    const incoming = next && typeof next === "object" ? next : {};
    const botSignals = Array.from(new Set([...(Array.isArray(base.botSignals) ? base.botSignals : []), ...(Array.isArray(incoming.botSignals) ? incoming.botSignals : [])].filter(Boolean))).slice(0, 20);
    const notes = Array.from(new Set([...(Array.isArray(base.notes) ? base.notes : []), ...(Array.isArray(incoming.notes) ? incoming.notes : [])].filter(Boolean))).slice(0, 20);
    return {
      key: String(incoming.key || base.key || incoming.deviceId || base.deviceId || makeRuntimeId("user")),
      area: String(incoming.area || base.area || "unknown"),
      label: String(incoming.label || base.label || incoming.area || base.area || "unknown"),
      deviceId: String(incoming.deviceId || base.deviceId || incoming.key || base.key || ""),
      sessionId: String(incoming.sessionId || base.sessionId || ""),
      firstSeen: Number(base.firstSeen || incoming.firstSeen || Date.now()) || Date.now(),
      lastSeen: Math.max(Number(base.lastSeen || 0) || 0, Number(incoming.lastSeen || 0) || 0, Date.now()),
      sessions: Math.max(1, Number(base.sessions || 1) || 1, Number(incoming.sessions || 1) || 1),
      views: Math.max(0, Number(base.views || 0) || 0) + Math.max(0, Number(incoming.viewsIncrement || 0) || 0),
      actions: Math.max(0, Number(base.actions || 0) || 0) + Math.max(0, Number(incoming.actionsIncrement || 0) || 0),
      lastPage: String(incoming.lastPage || base.lastPage || ""),
      referrer: String(incoming.referrer || base.referrer || ""),
      ua: String(incoming.ua || base.ua || ""),
      platform: String(incoming.platform || base.platform || ""),
      language: String(incoming.language || base.language || ""),
      timezone: String(incoming.timezone || base.timezone || ""),
      screen: String(incoming.screen || base.screen || ""),
      viewport: String(incoming.viewport || base.viewport || ""),
      touch: (incoming.touch === undefined) ? !!base.touch : !!incoming.touch,
      webdriver: (incoming.webdriver === undefined) ? !!base.webdriver : !!incoming.webdriver,
      suspicious: Math.max(0, Number(base.suspicious || 0) || 0, Number(incoming.suspicious || 0) || 0),
      botSignals,
      lastEvent: String(incoming.lastEvent || base.lastEvent || ""),
      lastSummary: String(incoming.lastSummary || base.lastSummary || ""),
      secretSearches: Math.max(0, Number(base.secretSearches || 0) || 0) + Math.max(0, Number(incoming.secretSearchesIncrement || 0) || 0),
      reservations: Math.max(0, Number(base.reservations || 0) || 0) + Math.max(0, Number(incoming.reservationsIncrement || 0) || 0),
      cartAdds: Math.max(0, Number(base.cartAdds || 0) || 0) + Math.max(0, Number(incoming.cartAddsIncrement || 0) || 0),
      cartChanges: Math.max(0, Number(base.cartChanges || 0) || 0) + Math.max(0, Number(incoming.cartChangesIncrement || 0) || 0),
      searches: Math.max(0, Number(base.searches || 0) || 0) + Math.max(0, Number(incoming.searchesIncrement || 0) || 0),
      lastSearchAt: Math.max(Number(base.lastSearchAt || 0) || 0, Number(incoming.lastSearchAt || 0) || 0),
      lastSearchText: String(incoming.lastSearchText !== undefined ? incoming.lastSearchText : (base.lastSearchText || "")),
      lastSecretSearchAt: Math.max(Number(base.lastSecretSearchAt || 0) || 0, Number(incoming.lastSecretSearchAt || 0) || 0),
      lastReservationAt: Math.max(Number(base.lastReservationAt || 0) || 0, Number(incoming.lastReservationAt || 0) || 0),
      lastCartAt: Math.max(Number(base.lastCartAt || 0) || 0, Number(incoming.lastCartAt || 0) || 0),
      notes,
    };
  }

  function currentClientProfile(area="admin"){
    const nav = globalThis.navigator || {};
    const loc = globalThis.location || {};
    const screenObj = globalThis.screen || {};
    const viewport = `${globalThis.innerWidth || 0}x${globalThis.innerHeight || 0}`;
    const screenSize = `${screenObj.width || 0}x${screenObj.height || 0}`;
    const botSignals = [];
    if(nav.webdriver) botSignals.push("webdriver");
    if(Number(nav.maxTouchPoints || 0) > 8) botSignals.push("high-touch");
    return {
      key: state.deviceId,
      label: area === "admin" ? "Admin kliens" : "Publikus kliens",
      area,
      deviceId: state.deviceId,
      sessionId: state.clientId,
      lastSeen: Date.now(),
      viewsIncrement: 0,
      actionsIncrement: 0,
      lastPage: `${loc.pathname || "/"}${loc.search || ""}`,
      referrer: String(document.referrer || ""),
      ua: String(nav.userAgent || ""),
      platform: String(nav.platform || ""),
      language: String(nav.language || ""),
      timezone: (() => { try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }catch{ return ""; } })(),
      screen: screenSize,
      viewport,
      touch: Number(nav.maxTouchPoints || 0) > 0,
      webdriver: !!nav.webdriver,
      suspicious: botSignals.length,
      botSignals,
    };
  }

  function registerAuditUser(profile, { markDirtySave=false } = {}){
    const incoming = profile && typeof profile === "object" ? profile : currentClientProfile("admin");
    const key = String(incoming.key || incoming.deviceId || state.deviceId);
    const prev = state.audit && state.audit.users ? state.audit.users[key] : null;
    const merged = mergeAuditUser(prev, incoming);
    if(!state.audit || typeof state.audit !== "object") state.audit = emptyAudit();
    if(!state.audit.users || typeof state.audit.users !== "object") state.audit.users = {};
    state.audit.users[key] = merged;
    state.auditUsersDirty.set(key, merged);
    if(markDirtySave) markDirty({ audit:true, fast:true });
    return merged;
  }

  function logAudit(action, summary, details={}, opts={}){
    const scope = String(opts.scope || "system");
    const area = String(opts.area || "admin");
    const profile = registerAuditUser({ ...currentClientProfile(area), ...(opts.profile || {}), actionsIncrement: scope === "view" ? 0 : 1, lastEvent: String(action || "event"), lastSummary: String(summary || "") });
    const ev = {
      id: makeRuntimeId("evt"),
      ts: Date.now(),
      scope,
      area,
      action: String(action || "event"),
      summary: String(summary || ""),
      sessionId: String(profile.sessionId || state.clientId),
      deviceId: String(profile.deviceId || state.deviceId),
      details: (details && typeof details === "object") ? details : { value: details }
    };
    if(!state.audit || typeof state.audit !== "object") state.audit = emptyAudit();
    if(!Array.isArray(state.audit.events)) state.audit.events = [];
    state.audit.events.unshift(ev);
    if(state.audit.events.length > 2500) state.audit.events.length = 2500;
    state.auditPendingEvents.push(ev);
    if(opts.persist !== false){
      markDirty({ audit:true, fast: opts.fast !== false });
    }
    return ev;
  }

  function fmtDateTime(value){
    const n = Number(value || 0) || 0;
    if(!n) return "—";
    try{ return new Date(n).toLocaleString("hu-HU"); }catch{ return "—"; }
  }

  const HISTORY_NOISE_ACTIONS = new Set([
    "tab_change",
    "settings_input",
    "manual_load",
    "manual_save",
    "copy_sync_link",
    "reload",
    "admin_load",
    "tab_visible",
    "lang_switch",
    "favorite_add",
    "favorite_remove"
  ]);

  function isImportantAuditEvent(ev){
    const action = String(ev && ev.action || "");
    if(!action) return false;
    return !HISTORY_NOISE_ACTIONS.has(action);
  }

  function buildAuditUserStats(){
    const stats = new Map();
    for(const ev of (Array.isArray(state.audit && state.audit.events) ? state.audit.events : [])){
      const key = String(ev && (ev.deviceId || ev.sessionId) || "");
      if(!key) continue;
      if(!stats.has(key)){
        stats.set(key, {
          key,
          views: 0,
          actions: 0,
          cartAdds: 0,
          cartChanges: 0,
          reservations: 0,
          searches: 0,
          secretSearches: 0,
          lastSearchAt: 0,
          lastSearchText: "",
          lastSecretSearchAt: 0,
          lastReservationAt: 0,
          lastCartAt: 0,
          lastImportantAt: 0,
          areas: new Set(),
        });
      }
      const row = stats.get(key);
      const action = String(ev.action || "");
      const ts = Number(ev.ts || 0) || 0;
      if(ev.area) row.areas.add(String(ev.area));
      if(action === "page_open"){
        row.views += 1;
        continue;
      }
      row.actions += 1;
      if(action === "cart_add"){
        row.cartAdds += 1;
        row.cartChanges += 1;
        row.lastCartAt = Math.max(row.lastCartAt, ts);
      }
      if(action === "cart_qty" || action === "cart_remove"){
        row.cartChanges += 1;
        row.lastCartAt = Math.max(row.lastCartAt, ts);
      }
      if(action === "reservation_success"){
        row.reservations += 1;
        row.lastReservationAt = Math.max(row.lastReservationAt, ts);
      }
      if(action === "search_query"){
        row.searches += 1;
        row.lastSearchAt = Math.max(row.lastSearchAt, ts);
        row.lastSearchText = String(ev?.details?.textMasked || ev?.details?.text || ev?.details?.query || "");
      }
      if(action === "secret_password_search"){
        row.secretSearches += 1;
        row.lastSearchAt = Math.max(row.lastSearchAt, ts);
        row.lastSecretSearchAt = Math.max(row.lastSecretSearchAt, ts);
        row.lastSearchText = "[SECRET_SUCCESS]";
      }
      if(isImportantAuditEvent(ev)) row.lastImportantAt = Math.max(row.lastImportantAt, ts);
    }
    return stats;
  }

  
  function sha256Hex(text){
    const str = String(text ?? "");
    if(!(globalThis.crypto && crypto.subtle && globalThis.TextEncoder)){
      return Promise.resolve(str.trim().toLowerCase());
    }
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then((buf) => {
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }).catch(() => str.trim().toLowerCase());
  }

  function ensureSecretAccessMeta(){
    if(!state.doc || typeof state.doc !== "object") state.doc = { categories: [], products: [], popups: [] };
    if(!state.doc._meta || typeof state.doc._meta !== "object") state.doc._meta = {};
    if(!state.doc._meta.secretAccess || typeof state.doc._meta.secretAccess !== "object") state.doc._meta.secretAccess = {};
    const sa = state.doc._meta.secretAccess;
    sa.passwordHash = String(sa.passwordHash || "").trim().toLowerCase();
    sa.durationMs = Math.max(60_000, Number(sa.durationMs || 3_600_000) || 3_600_000);
    return sa;
  }

  async function syncSecretSettingsFromPanel(){
    const minutesEl = $("#cfgSecretMinutes");
    const passEl = $("#cfgSecretPassword");
    const secretAccess = ensureSecretAccessMeta();

    if(minutesEl){
      const mins = Math.max(1, Number(minutesEl.value || (secretAccess.durationMs / 60000) || 60) || 60);
      secretAccess.durationMs = mins * 60_000;
    }

    if(passEl){
      const nextPassword = String(passEl.value || "").trim();
      if(nextPassword){
        secretAccess.passwordHash = String(await sha256Hex(nextPassword)).trim().toLowerCase();
      }
    }
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


  function naturalCompare(a, b){
    return String(a ?? "").localeCompare(String(b ?? ""), "hu", { numeric: true, sensitivity: "base" });
  }

  function setProductStockValue(pid, nextValue, { absolute=false } = {}){
    const n = Math.max(0, Number(nextValue || 0));
    if(!pid) return n;
    if(absolute){
      state.stockAbsoluteByProduct.set(String(pid), n);
      state.stockDeltaByProduct.delete(String(pid));
    }
    return n;
  }

  function adjustProductStockValue(pid, delta){
    const key = String(pid || "");
    if(!key) return;
    const d = Number(delta || 0) || 0;
    if(!d) return;
    if(state.stockAbsoluteByProduct.has(key)){
      state.stockAbsoluteByProduct.set(key, Math.max(0, Number(state.stockAbsoluteByProduct.get(key) || 0) + d));
      return;
    }
    state.stockDeltaByProduct.set(key, Number(state.stockDeltaByProduct.get(key) || 0) + d);
  }

  function resetStockMergeState(){
    state.productsStructuralDirty = false;
    state.stockDeltaByProduct = new Map();
    state.stockAbsoluteByProduct = new Map();
    resetDocMutationTracker();
  }

  function productDocFromAny(raw){
    const parsed = Array.isArray(raw) ? { categories: [], products: raw, popups: [], _meta: {} } : ((raw && typeof raw === "object") ? raw : emptyDoc());
    return {
      categories: Array.isArray(parsed.categories) ? parsed.categories.map(x => clone(x)) : [],
      products: Array.isArray(parsed.products) ? parsed.products.map(x => clone(x)) : [],
      popups: Array.isArray(parsed.popups) ? parsed.popups.map(x => clone(x)) : [],
      _meta: (parsed._meta && typeof parsed._meta === "object") ? clone(parsed._meta) : {}
    };
  }

  async function buildProductsSavePlan(cfg){
    let sha = state.shas.products;
    let remoteDoc = emptyDoc();

    try{
      const latest = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path: "data/products.json" });
      sha = latest.sha || null;
      remoteDoc = productDocFromAny(safeJsonParse(latest.content || "{}", emptyDoc()));
    }catch(e){
      if(Number(e?.status || 0) !== 404) throw e;
    }

    const localDoc = productDocFromAny(state.doc || emptyDoc());
    const merged = productDocFromAny(remoteDoc);
    const m = state.docMutations || createDocMutationTracker();

    const catMap = new Map((merged.categories || []).map(c => [String(c.id || ""), c]).filter(([id]) => id));
    for(const id of m.categoryDeletes){
      catMap.delete(String(id));
    }
    for(const id of m.categoryUpserts){
      const next = (localDoc.categories || []).find(c => String(c.id || "") === String(id));
      if(next) catMap.set(String(id), clone(next));
    }
    merged.categories = [...catMap.values()];

    const productMap = new Map((merged.products || []).map(p => [String(p.id || ""), p]).filter(([id]) => id));
    for(const id of m.productDeletes){
      productMap.delete(String(id));
    }
    for(const id of m.productUpserts){
      const next = (localDoc.products || []).find(p => String(p.id || "") === String(id));
      if(next) productMap.set(String(id), clone(next));
    }

    for(const [pid, abs] of state.stockAbsoluteByProduct.entries()){
      const p = productMap.get(String(pid));
      if(!p) continue;
      p.stock = Math.max(0, Number(abs || 0));
      if(p.status !== "soon") p.status = p.stock <= 0 ? "out" : ((p.status === "out") ? "ok" : p.status);
    }
    for(const [pid, delta] of state.stockDeltaByProduct.entries()){
      const p = productMap.get(String(pid));
      if(!p) continue;
      p.stock = Math.max(0, Number(p.stock || 0) + Number(delta || 0));
      if(p.status !== "soon") p.status = p.stock <= 0 ? "out" : ((p.status === "out") ? "ok" : p.status);
    }

    merged.products = [...productMap.values()];

    if(m.popupsDirty){
      merged.popups = clone(localDoc.popups || []);
    }

    merged._meta = {
      ...(merged._meta || {}),
      ...(m.metaDirty ? { secretAccess: clone(((localDoc._meta || {}).secretAccess || {})) } : {}),
      rev: Date.now(),
      updatedAt: new Date().toISOString(),
    };

    state.doc = merged;
    normalizeDoc();

    return {
      doc: clone(state.doc || emptyDoc()),
      sha
    };
  }

  async function readJsonFileOrFallback(cfg, path, fallback){
    try{
      const res = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path });
      return { sha: res.sha || null, data: safeJsonParse(res.content || "", fallback) };
    }catch(e){
      if(Number(e?.status || 0) === 404) return { sha: null, data: clone(fallback) };
      throw e;
    }
  }

  async function buildSalesSavePlan(cfg){
    const latest = await readJsonFileOrFallback(cfg, "data/sales.json", []);
    const remote = Array.isArray(latest.data) ? latest.data.map(x => clone(x)) : [];
    const localMap = new Map((state.sales || []).map(s => [String(s.id || ""), clone(s)]).filter(([id]) => id));
    const map = new Map(remote.map(s => [String(s && s.id || ""), clone(s)]).filter(([id]) => id));
    for(const id of state.salesDeletes){ map.delete(String(id)); }
    for(const id of state.salesUpserts){
      const next = localMap.get(String(id));
      if(next) map.set(String(id), next);
    }
    return { sales: [...map.values()], sha: latest.sha };
  }

  async function buildReservationsSavePlan(cfg){
    const latest = await readJsonFileOrFallback(cfg, "data/reservations.json", []);
    const remote = Array.isArray(latest.data) ? latest.data.map(x => clone(x)) : [];
    const localMap = new Map((state.reservations || []).map(r => [String(r.id || ""), clone(r)]).filter(([id]) => id));
    const map = new Map(remote.map(r => [String(r && r.id || ""), clone(r)]).filter(([id]) => id));
    for(const id of state.reservationDeletes){ map.delete(String(id)); }
    for(const id of state.reservationUpserts){
      const next = localMap.get(String(id));
      if(next) map.set(String(id), next);
    }
    return { reservations: [...map.values()], sha: latest.sha };
  }

  async function buildAuditSavePlan(cfg){
    const latest = await readJsonFileOrFallback(cfg, "data/audit.json", emptyAudit());
    const remote = normalizeAudit(latest.data || emptyAudit());

    const eventsMap = new Map((remote.events || []).map(ev => [String(ev.id || makeRuntimeId("evt")), ev]));
    for(const ev of (state.auditPendingEvents || [])){
      if(!ev || !ev.id) continue;
      eventsMap.set(String(ev.id), clone(ev));
    }
    const events = [...eventsMap.values()].sort((a,b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 2500);

    const users = { ...(remote.users || {}) };
    for(const [key, user] of state.auditUsersDirty.entries()){
      users[String(key)] = mergeAuditUser(users[String(key)], user);
    }

    const audit = {
      users,
      events,
      _meta: {
        rev: Date.now(),
        updatedAt: new Date().toISOString(),
      }
    };
    state.audit = normalizeAudit(audit);
    return { audit: clone(state.audit), sha: latest.sha };
  }

  function rerenderWithInputState(selector, renderFn){
    const active = document.querySelector(selector);
    const hadFocus = !!active && document.activeElement === active;
    const start = hadFocus && typeof active.selectionStart === "number" ? active.selectionStart : null;
    const end = hadFocus && typeof active.selectionEnd === "number" ? active.selectionEnd : null;
    renderFn();
    if(!hadFocus) return;
    const next = document.querySelector(selector);
    if(!next) return;
    try{
      next.focus({ preventScroll: true });
      if(start !== null && end !== null) next.setSelectionRange(Math.min(start, next.value.length), Math.min(end, next.value.length));
    }catch{}
  }

  function monthInputValue(dateLike){
    const d = new Date(dateLike);
    if(Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  }

  function startOfWeek(dateLike){
    const d = new Date(dateLike);
    if(Number.isNaN(d.getTime())) return new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() + diff);
    return d;
  }

  function endOfWeek(dateLike){
    const d = startOfWeek(dateLike);
    d.setDate(d.getDate() + 6);
    return d;
  }

  function endOfMonth(year, monthIndex){
    return new Date(year, monthIndex + 1, 0);
  }

  function parseDateInput(value){
    const s = String(value || "").slice(0,10);
    if(!s) return null;
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function getSalesDateBounds(){
    const dates = (state.sales || []).map(s => String(s.date || "").slice(0,10)).filter(Boolean).sort();
    const today = todayISO();
    return {
      min: dates[0] || today,
      max: dates[dates.length - 1] || today
    };
  }

  function initChartFilters(force = false){
    const bounds = getSalesDateBounds();
    const maxDate = parseDateInput(bounds.max) || new Date();

    if(force || !state.filters.chartAllFrom) state.filters.chartAllFrom = bounds.min;
    if(force || !state.filters.chartAllTo) state.filters.chartAllTo = bounds.max;
    if(force || !state.filters.chartYear) state.filters.chartYear = String(maxDate.getFullYear());
    if(force || !state.filters.chartMonth) state.filters.chartMonth = monthInputValue(maxDate);
    if(force || !state.filters.chartWeek) state.filters.chartWeek = bounds.max;
    if(force || !state.filters.chartDay) state.filters.chartDay = bounds.max;
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
    ensureSecretAccessMeta();

    state.doc.categories = state.doc.categories
      .filter(c => c && c.id)
      .map(c => ({
        id: String(c.id),
        label_hu: c.label_hu || c.id,
        label_en: c.label_en || c.label_hu || c.id,
        basePrice: Number(c.basePrice || 0),
        visible: (c.visible === false) ? false : true,
        featuredEnabled: (c.featuredEnabled === false) ? false : true,
        secret: c.secret === true
      }));

    state.doc.products = state.doc.products.map(p => ({
      id: String(p.id || ""),
      categoryId: String(p.categoryId || ""),
      status: (p.status === "ok" || p.status === "out" || p.status === "soon") ? p.status : "ok",
      stock: Math.max(0, Number(p.stock || 0)),
      visible: (p.visible === false) ? false : true,
      secret: p.secret === true,
      price: (p.price === "" || p.price === null || p.price === undefined) ? null : (Number.isFinite(Number(p.price)) ? Number(p.price) : null),
      image: p.image || "",
      name_hu: p.name_hu || "",
      name_en: p.name_en || p.name_hu || "",
      flavor_hu: p.flavor_hu || "",
      flavor_en: p.flavor_en || p.flavor_hu || "",
      soonEta: String(p.soonEta || p.eta || "").replace(/^(\d{4}-\d{2}).*$/, "$1")
    })).filter(p => p.id);

    state.doc.popups = (state.doc.popups || []).map(pp => ({
      id: String(pp.id || ""),
      enabled: (pp.enabled === false) ? false : true,
      rev: Number(pp.rev || pp.updatedAt || pp.createdAt || 0) || 0,
      title_hu: pp.title_hu || "Új termékek elérhetőek",
      title_en: pp.title_en || "New products available",
      categoryIds: Array.isArray(pp.categoryIds) ? pp.categoryIds.map(x=>String(x)) : [],
      productIds: Array.isArray(pp.productIds) ? pp.productIds.map(x=>String(x)) : [],
      createdAt: Number(pp.createdAt || 0) || 0,
      updatedAt: Number(pp.updatedAt || 0) || 0
    })).filter(pp => pp.id);

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

      const items = Array.isArray(r.items) ? r.items.map(it => ({
        productId: String(it.productId || it.pid || ""),
        qty: Math.max(1, Number.parseFloat(it.qty || it.quantity || 1) || 1),
        unitPrice: Math.max(0, Number.parseFloat(it.unitPrice || it.price || 0) || 0)
      })).filter(it => it.productId) : [];

      out.push({
        id,
        publicCode: String(r.publicCode || r.code || ""),
        createdAt,
        expiresAt,
        confirmed,
        modified: !!r.modified,
        modifiedAt: Number(r.modifiedAt || 0) || 0,
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

  function effectivePrice(p){
    const num = (v)=> (v===null || v===undefined || v==="" ? null : Number(v));
    const ov = num(p && p.price);
    if(ov !== null && Number.isFinite(ov) && ov > 0) return ov;

    const c = catById(p.categoryId);
    const bp = c ? num(c.basePrice) : null;
    return (bp !== null && Number.isFinite(bp) && bp > 0) ? bp : 0;
  }

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

        let a = null;
        let audit = emptyAudit();
        try{
          a = await ShadowGH.getFile({ token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: br, path: "data/audit.json" });
          audit = normalizeAudit(safeJsonParse(a.content || "{}", emptyAudit()));
        }catch(e){
          if(Number(e?.status || 0) === 404){
            a = { sha: null };
            audit = emptyAudit();
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
        state.audit = audit;
        state.shas.products = p.sha;
        state.shas.sales = s ? (s.sha || null) : null;
        state.shas.reservations = r ? (r.sha || null) : null;
        state.shas.audit = a ? (a.sha || null) : null;
        normalizeDoc();
        initChartFilters(true);
        state.loaded = true;
        state.forceSourceSync = true;
        resetStockMergeState();
        resetSalesMutationTracker();
        resetReservationMutationTracker();
        state.auditPendingEvents = [];
        state.auditUsersDirty = new Map();
        registerAuditUser({ ...currentClientProfile("admin"), viewsIncrement: 1, lastEvent: "admin_load", lastSummary: "Admin betöltés" });

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
      try{ logAudit("admin_load_error", "Admin betöltési hiba", { message: String(r.err?.message || r.err || "") }, { scope:"system", fast:false }); }catch{}
      return;
    }

    setSaveStatus("ok","Kész");
    renderAll();
  }

  async function saveDataNow(){
    if(!state.loaded) return;

    if (!state.dirtyProducts && !state.dirtySales && !state.dirtyReservations && !state.dirtyAudit) {
      setSaveStatus("ok","Nincs változás");
      return;
    }

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

    await syncSecretSettingsFromPanel();
    normalizeDoc();

    for(const p of (state.doc.products||[])){
      if(p && p.status === "out") p.stock = 0;
      if(p && (!p.name_en || String(p.name_en).trim()==="")) p.name_en = p.name_hu || "";
    }

    let ok = false;
    const wantProducts = !!state.dirtyProducts;
    const wantSales = !!state.dirtySales;
    const wantReservations = !!state.dirtyReservations;
    const wantAudit = !!state.dirtyAudit;

    try{
      if(wantProducts){
        let plan = await buildProductsSavePlan(cfg);
        let textOut = JSON.stringify(plan.doc, null, 2);
        const pRes = await ShadowGH.putFileSafe({
          token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
          path: "data/products.json",
          message: "Update products.json",
          content: textOut,
          sha: plan.sha,
          onConflict: async () => {
            plan = await buildProductsSavePlan(cfg);
            textOut = JSON.stringify(plan.doc, null, 2);
            return { content: textOut, sha: plan.sha };
          }
        });
        state.shas.products = pRes?.content?.sha || plan.sha || state.shas.products;
      }

      if(wantSales){
        let plan = await buildSalesSavePlan(cfg);
        let textOut = JSON.stringify(plan.sales, null, 2);
        const sRes = await ShadowGH.putFileSafe({
          token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
          path: "data/sales.json",
          message: "Update sales.json",
          content: textOut,
          sha: plan.sha,
          onConflict: async () => {
            plan = await buildSalesSavePlan(cfg);
            textOut = JSON.stringify(plan.sales, null, 2);
            return { content: textOut, sha: plan.sha };
          }
        });
        state.shas.sales = sRes?.content?.sha || plan.sha || state.shas.sales;
      }

      if(wantReservations){
        let plan = await buildReservationsSavePlan(cfg);
        let textOut = JSON.stringify(plan.reservations, null, 2);
        const rRes = await ShadowGH.putFileSafe({
          token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
          path: "data/reservations.json",
          message: "Update reservations.json",
          content: textOut,
          sha: plan.sha,
          onConflict: async () => {
            plan = await buildReservationsSavePlan(cfg);
            textOut = JSON.stringify(plan.reservations, null, 2);
            return { content: textOut, sha: plan.sha };
          }
        });
        state.shas.reservations = rRes?.content?.sha || plan.sha || state.shas.reservations;
      }

      if(wantAudit){
        let plan = await buildAuditSavePlan(cfg);
        let textOut = JSON.stringify(plan.audit, null, 2);
        const aRes = await ShadowGH.putFileSafe({
          token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
          path: "data/audit.json",
          message: "Update audit.json",
          content: textOut,
          sha: plan.sha,
          onConflict: async () => {
            plan = await buildAuditSavePlan(cfg);
            textOut = JSON.stringify(plan.audit, null, 2);
            return { content: textOut, sha: plan.sha };
          }
        });
        state.shas.audit = aRes?.content?.sha || plan.sha || state.shas.audit;
      }

      try{
        const srcObj = { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch };
        if(cfg.resApi) srcObj.reserveApi = cfg.resApi;
        const srcText = JSON.stringify(srcObj, null, 2);
        const prev = localStorage.getItem("sv_source_json") || "";
        if(state.forceSourceSync || prev !== srcText){
          state.forceSourceSync = false;
          try{ localStorage.setItem("sv_source_json", srcText); }catch{}
          await ShadowGH.putFileSafe({
            token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch,
            path: "data/sv_source.json",
            message: "Update sv_source.json",
            content: srcText
          });
        }
      }catch{}

      ok = true;

      try{
        const payload = { doc: state.doc, sales: state.sales, reservations: state.reservations, ts: Date.now() };
        localStorage.setItem("sv_live_payload", JSON.stringify(payload));
        try{ new BroadcastChannel("sv_live").postMessage(payload); }catch{}
      }catch{}

      resetStockMergeState();
      resetSalesMutationTracker();
      resetReservationMutationTracker();
      state.auditPendingEvents = [];
      state.auditUsersDirty = new Map();
      state.dirtyProducts = false;
      state.dirtySales = false;
      state.dirtyReservations = false;
      state.dirtyAudit = false;

      try{
        const secretPassEl = $("#cfgSecretPassword");
        if(secretPassEl) secretPassEl.value = "";
      }catch{}
      setSaveStatus("ok","Mentve ✅");
    }catch(e){
      console.error(e);
      setSaveStatus("bad", `Mentés hiba: ${String(e?.message || e)}`);
      state.dirty = true;
      try{ logAudit("save_error", "Mentési hiba", { message: String(e?.message || e || "") }, { scope:"system", fast:false, persist:false }); }catch{}
    }finally{
      state.saving = false;
      releaseLock();
      if(ok && (state.saveQueued || state.dirty)){
        state.saveQueued = false;
        if(state.saveTimer) clearTimeout(state.saveTimer);
        setTimeout(() => saveDataNow(), 350);
      }
    }
  }



function markDirty(flags){
  const f = flags || {};
  if(f.products){
    state.dirtyProducts = true;
    if(!f.stockOnly) state.productsStructuralDirty = true;
  }
  if(f.sales) state.dirtySales = true;
  if(f.reservations) state.dirtyReservations = true;
  if(f.audit) state.dirtyAudit = true;
  queueAutoSave(f.fast ? 250 : null);
}

  function queueAutoSave(delayOverride=null){
    state.dirty = true;
    if(state.saving){
      state.saveQueued = true;
      setSaveStatus("busy","Mentés folyamatban…");
      return;
    }
    if(state.saveTimer) clearTimeout(state.saveTimer);
    setSaveStatus("busy","Változás…");
    const baseMs = Math.max(200, Math.min(2000, Number(localStorage.getItem("sv_autosave_ms") || 700)));
    const ms = Math.max(120, Math.min(2000, Number(delayOverride || baseMs) || baseMs));
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
      state.activeTab = tab;
      $("#panelProducts").style.display = tab === "products" ? "block" : "none";
      $("#panelCategories").style.display = tab === "categories" ? "block" : "none";
      $("#panelSales").style.display = tab === "sales" ? "block" : "none";
      $("#panelChart").style.display = tab === "chart" ? "block" : "none";
      $("#panelPopups").style.display = tab === "popups" ? "block" : "none";
      $("#panelSettings").style.display = tab === "settings" ? "block" : "none";
      $("#panelUsers").style.display = tab === "users" ? "block" : "none";
      $("#panelHistory").style.display = tab === "history" ? "block" : "none";

      if(tab === "chart") drawChart();
      if(tab === "popups") renderPopups();
      if(tab === "users") renderUsers();
      if(tab === "history") renderHistory();
    };
  }

  function renderUsers(){
    const panel = $("#panelUsers");
    if(!panel) return;
    const q = String(state.filters.usersSearch || "").trim().toLowerCase();
    const derivedStats = buildAuditUserStats();
    const usersMap = new Map(Object.entries((state.audit && state.audit.users) ? state.audit.users : {}));
    for(const [key, extra] of derivedStats.entries()){
      if(usersMap.has(key)) continue;
      usersMap.set(key, {
        key,
        area: (extra.areas && extra.areas.has("public")) ? "public" : ((extra.areas && extra.areas.has("admin")) ? "admin" : "unknown"),
        label: (extra.areas && extra.areas.has("public")) ? "Publikus kliens" : ((extra.areas && extra.areas.has("admin")) ? "Admin kliens" : "Ismeretlen kliens"),
        deviceId: key,
        sessionId: "",
        firstSeen: 0,
        lastSeen: Number(extra.lastImportantAt || 0) || 0,
        sessions: 1,
        views: 0,
        actions: 0,
        lastPage: "",
        referrer: "",
        ua: "",
        platform: "",
        language: "",
        timezone: "",
        screen: "",
        viewport: "",
        touch: false,
        webdriver: false,
        suspicious: 0,
        botSignals: [],
        lastEvent: "",
        lastSummary: "",
        secretSearches: 0,
        reservations: 0,
        cartAdds: 0,
        cartChanges: 0,
        lastSecretSearchAt: 0,
        lastReservationAt: 0,
        lastCartAt: 0,
      });
    }
    let list = [...usersMap.values()].map((u) => {
      const extra = derivedStats.get(String(u.deviceId || u.key || "")) || {};
      return {
        ...u,
        views: Math.max(Number(u.views || 0) || 0, Number(extra.views || 0) || 0),
        actions: Math.max(Number(u.actions || 0) || 0, Number(extra.actions || 0) || 0),
        cartAdds: Math.max(Number(u.cartAdds || 0) || 0, Number(extra.cartAdds || 0) || 0),
        cartChanges: Math.max(Number(u.cartChanges || 0) || 0, Number(extra.cartChanges || 0) || 0),
        reservations: Math.max(Number(u.reservations || 0) || 0, Number(extra.reservations || 0) || 0),
        secretSearches: Math.max(Number(u.secretSearches || 0) || 0, Number(extra.secretSearches || 0) || 0),
        lastSecretSearchAt: Math.max(Number(u.lastSecretSearchAt || 0) || 0, Number(extra.lastSecretSearchAt || 0) || 0),
        lastReservationAt: Math.max(Number(u.lastReservationAt || 0) || 0, Number(extra.lastReservationAt || 0) || 0),
        lastCartAt: Math.max(Number(u.lastCartAt || 0) || 0, Number(extra.lastCartAt || 0) || 0),
        areasSeen: Array.from(extra.areas || []),
        lastImportantAt: Math.max(Number(extra.lastImportantAt || 0) || 0, Number(u.lastSeen || 0) || 0),
      };
    });
    list.sort((a,b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
    if(q){
      list = list.filter(u => (`${u.label} ${u.area} ${(u.areasSeen || []).join(' ')} ${u.ua} ${u.platform} ${u.language} ${u.timezone} ${u.referrer} ${u.lastPage} ${(u.botSignals||[]).join(' ')} ${u.lastEvent || ''} ${u.lastSummary || ''} ${u.lastSearchText || ''}`).toLowerCase().includes(q));
    }

    panel.innerHTML = `
      <div class="actions table" style="align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-weight:900;">Users</div>
          <div class="small-muted">Publikus és admin kliensek összesítve. Külön látszanak a fontos user aktivitások is.</div>
        </div>
        <input id="usersSearch" placeholder="Keresés user agent / oldal / referrer / jel alapján..." value="${escapeHtml(state.filters.usersSearch || "")}" style="flex:1;min-width:260px;max-width:520px;">
      </div>
      <div class="small-muted" style="margin-top:8px;">Találat: <b>${list.length}</b> kliens</div>
      <div style="margin-top:12px;display:grid;gap:10px;">
        ${list.length ? list.map(u => `
          <div class="rowline table" style="align-items:flex-start;">
            <div class="left">
              <div style="font-weight:900;">${escapeHtml(u.label || u.area || "Kliens")}</div>
              <div class="small-muted">Terület: <b>${escapeHtml(u.area || "—")}</b>${(u.areasSeen || []).length ? ` • Látott felületek: <b>${escapeHtml(u.areasSeen.join(', '))}</b>` : ""} • Utolsó oldal: <b>${escapeHtml(u.lastPage || "—")}</b></div>
              <div class="small-muted">Első látás: <b>${escapeHtml(fmtDateTime(u.firstSeen))}</b> • Utolsó aktivitás: <b>${escapeHtml(fmtDateTime(u.lastSeen))}</b> • Utolsó fontos aktivitás: <b>${escapeHtml(fmtDateTime(u.lastImportantAt))}</b></div>
              <div class="small-muted">Megnyitások: <b>${Number(u.views || 0)}</b> • Akciók: <b>${Number(u.actions || 0)}</b> • Keresések: <b>${Number(u.searches || 0)}</b> • Kosárba rakás: <b>${Number(u.cartAdds || 0)}</b> • Kosár változás: <b>${Number(u.cartChanges || 0)}</b></div>
              <div class="small-muted">Foglalások: <b>${Number(u.reservations || 0)}</b> • Titkos jelszó keresőből: <b>${Number(u.secretSearches || 0)}</b> • Gyanú pont: <b>${Number(u.suspicious || 0)}</b></div>
              <div class="small-muted">Utolsó keresés: <b>${escapeHtml(u.lastSearchText || "—")}</b> • Utolsó keresés ideje: <b>${escapeHtml(fmtDateTime(u.lastSearchAt))}</b></div>
              <div class="small-muted">Utolsó kosár akció: <b>${escapeHtml(fmtDateTime(u.lastCartAt))}</b> • Utolsó foglalás: <b>${escapeHtml(fmtDateTime(u.lastReservationAt))}</b> • Utolsó jelszó találat: <b>${escapeHtml(fmtDateTime(u.lastSecretSearchAt))}</b></div>
              <div class="small-muted">Utolsó esemény: <b>${escapeHtml(u.lastEvent || "—")}</b> • ${escapeHtml(u.lastSummary || "—")}</div>
              <div class="small-muted">Nyelv / TZ: <b>${escapeHtml(u.language || "—")}</b> / <b>${escapeHtml(u.timezone || "—")}</b> • Platform: <b>${escapeHtml(u.platform || "—")}</b></div>
              <div class="small-muted">Képernyő / viewport: <b>${escapeHtml(u.screen || "—")}</b> / <b>${escapeHtml(u.viewport || "—")}</b> • Touch: <b>${u.touch ? "igen" : "nem"}</b> • Webdriver: <b>${u.webdriver ? "igen" : "nem"}</b></div>
              <div class="small-muted">Referrer: <b>${escapeHtml(u.referrer || "—")}</b></div>
              <div class="small-muted">Bot jelek: <b>${escapeHtml((u.botSignals || []).join(", ") || "—")}</b></div>
              <div class="small-muted" style="word-break:break-word;">UA: <b>${escapeHtml(u.ua || "—")}</b></div>
            </div>
          </div>
        `).join("") : `<div class="small-muted">Még nincs központilag mentett user adat.</div>`}
      </div>
    `;

    const searchEl = $("#usersSearch");
    if(searchEl){
      searchEl.oninput = () => {
        state.filters.usersSearch = searchEl.value;
        rerenderWithInputState("#usersSearch", renderUsers);
      };
    }
  }

  function renderHistory(){
    const panel = $("#panelHistory");
    if(!panel) return;
    const q = String(state.filters.historySearch || "").trim().toLowerCase();
    const type = String(state.filters.historyType || "activity");
    let list = Array.isArray(state.audit && state.audit.events) ? [...state.audit.events] : [];
    if(type === "activity") list = list.filter(isImportantAuditEvent);
    else if(type !== "all") list = list.filter(ev => String(ev.scope || "") === type || String(ev.action || "") === type || String(ev.area || "") === type);
    if(q) list = list.filter(ev => (`${ev.summary} ${ev.action} ${ev.scope} ${ev.area} ${JSON.stringify(ev.details || {})}`).toLowerCase().includes(q));
    list.sort((a,b) => Number(b.ts || 0) - Number(a.ts || 0));

    panel.innerHTML = `
      <div class="actions table" style="align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-weight:900;">Előzmények</div>
          <div class="small-muted">Alapból csak a fontos aktivitások látszanak: kosár, foglalás, készlet, eladás, biztonsági események, stb.</div>
        </div>
        <select id="historyType" style="width:220px;">
          ${["activity","all","admin","public","system","change","security"].map(x => `<option value="${escapeHtml(x)}"${x===type?" selected":""}>${escapeHtml(x)}</option>`).join("")}
        </select>
        <input id="historySearch" placeholder="Keresés összefoglaló / action / részlet alapján..." value="${escapeHtml(state.filters.historySearch || "")}" style="flex:1;min-width:260px;max-width:520px;">
      </div>
      <div class="small-muted" style="margin-top:8px;">Találat: <b>${list.length}</b> esemény</div>
      <div style="margin-top:12px;display:grid;gap:10px;">
        ${list.length ? list.slice(0, 800).map(ev => `
          <div class="rowline table" style="align-items:flex-start;">
            <div class="left">
              <div style="font-weight:900;">${escapeHtml(ev.summary || ev.action || "Esemény")}</div>
              <div class="small-muted">${escapeHtml(fmtDateTime(ev.ts))} • scope: <b>${escapeHtml(ev.scope || "—")}</b> • area: <b>${escapeHtml(ev.area || "—")}</b> • action: <b>${escapeHtml(ev.action || "—")}</b></div>
              <div class="small-muted" style="word-break:break-word;">${escapeHtml(JSON.stringify(ev.details || {}))}</div>
            </div>
          </div>
        `).join("") : `<div class="small-muted">Még nincs audit esemény.</div>`}
      </div>
    `;

    const searchEl = $("#historySearch");
    if(searchEl){
      searchEl.oninput = () => {
        state.filters.historySearch = searchEl.value;
        rerenderWithInputState("#historySearch", renderHistory);
      };
    }
    const typeEl = $("#historyType");
    if(typeEl){
      typeEl.onchange = () => {
        state.filters.historyType = typeEl.value;
        renderHistory();
      };
    }
  }

  function renderSettings(){
    const cfg = loadCfg();
    const secretAccess = ensureSecretAccessMeta();
    const secretMinutes = Math.max(1, Math.round(Number(secretAccess.durationMs || 3_600_000) / 60000) || 60);

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
        <div class="field third">
          <label>Titkos jelszó</label>
          <input id="cfgSecretPassword" type="password" value="" placeholder="Új jelszó megadása" autocomplete="new-password" />
        </div>
        <div class="field third">
          <label>Titkos hozzáférés ideje (perc)</label>
          <input id="cfgSecretMinutes" type="number" min="1" value="${secretMinutes}">
        </div>
        <div class="field full">
          <div class="small-muted">A felhasználó a keresőbe írja be a jelszót. A titkos nézet ennyi percig marad aktív újratöltés után is.</div>
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

    $("#btnLoad").onclick = () => { loadData(); };
    $("#btnSave").onclick = () => { saveDataNow(); };

    try{
      const basePath = location.pathname.replace(/\/admin\.html.*$/,"/");
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
          try{ logAudit("copy_sync_link", "Sync link másolva", { link }, { scope:"admin", fast:true }); }catch{}
        }catch{
          try{
            inp.select();
            document.execCommand("copy");
            setSaveStatus("ok","Sync link másolva ✅");
          }catch{}
        }
      };
    }catch{}
    ["cfgOwner","cfgRepo","cfgBranch","cfgToken","cfgResApi"].forEach(id => {
      $("#"+id).addEventListener("input", () => {
        saveCfg(getCfg());
      });
    });

    try{
      const sel = $("#cfgAutosave");
      if(sel){
        const cur = Number(localStorage.getItem("sv_autosave_ms") || 700);
        sel.value = String(cur);
        sel.onchange = () => {
          const ms = Math.max(200, Math.min(2000, Number(sel.value || 700)));
          localStorage.setItem("sv_autosave_ms", String(ms));
          setSaveStatus("ok","Auto-mentés beállítva ✅");
          try{ logAudit("autosave_change", "Auto-mentés késleltetés módosítva", { ms }, { scope:"admin", fast:true }); }catch{}
        };
      }
    }catch{}

    const secretMinutesEl = $("#cfgSecretMinutes");
    if(secretMinutesEl){
      secretMinutesEl.addEventListener("input", () => {
        const sa = ensureSecretAccessMeta();
        sa.durationMs = Math.max(60_000, (Math.max(1, Number(secretMinutesEl.value || 60) || 60) * 60_000));
        trackMetaDirty();
        try{ logAudit("secret_duration_change", "Titkos hozzáférés ideje módosítva", { minutes: Math.max(1, Number(secretMinutesEl.value || 60) || 60) }, { scope:"security", fast:true }); }catch{}
        markDirty({ products:true, fast:true });
      });
    }

    const secretPassEl = $("#cfgSecretPassword");
    if(secretPassEl){
      secretPassEl.addEventListener("change", () => {
        if(String(secretPassEl.value || "").trim()){
          trackMetaDirty();
          try{ logAudit("secret_password_change", "Titkos jelszó módosítás előkészítve", { hasValue:true }, { scope:"security", fast:false }); }catch{}
          markDirty({ products:true });
        }
      });
    }
  }

  function renderCategories(){
    const cats = [...state.doc.categories].sort((a,b)=> naturalCompare(a.label_hu||a.id, b.label_hu||b.id));

    let rows = cats.map(c => `
      <tr>
        <td><div style="display:flex;gap:8px;align-items:center;justify-content:space-between;"><b>${escapeHtml(c.id)}</b><button type="button" class="ghost" data-ren-cat="${escapeHtml(c.id)}">Szerk</button></div></td>
        <td><input data-cid="${escapeHtml(c.id)}" data-k="label_hu" value="${escapeHtml(c.label_hu)}"></td>
        <td><input data-cid="${escapeHtml(c.id)}" data-k="label_en" value="${escapeHtml(c.label_en)}"></td>
        <td style="width:150px;"><input data-cid="${escapeHtml(c.id)}" data-k="basePrice" type="number" min="0" value="${Number(c.basePrice||0)}"></td>
        <td style="width:90px;text-align:center;"><input type="checkbox" data-cid="${escapeHtml(c.id)}" data-k="visible"${c.visible===false?"":" checked"}></td>
        <td style="width:90px;text-align:center;"><input type="checkbox" data-cid="${escapeHtml(c.id)}" data-k="secret"${c.secret===true?" checked":""}></td>
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
          <tr><th>ID</th><th>HU</th><th>EN</th><th>Alap ár (Ft)</th><th>Látható</th><th>Titkos</th><th>Felkapott</th><th></th></tr>
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
          <div class="field third"><label>Alap ár</label><input id="newCprice" type="number" min="0" value="0"></div>
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

          state.doc.categories.push({
            id,
            label_hu: hu,
            label_en: hu,
            basePrice: bp,
            visible: true,
            featuredEnabled: true,
            secret: false
          });
          trackCategoryUpsert(id);
          try{ logAudit("category_create", `Új kategória: ${id}`, { id, label_hu: hu, basePrice: bp }, { scope:"change", fast:true }); }catch{}
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
        const prevVal = clone(c[k]);
        if(k === "basePrice") c.basePrice = Math.max(0, Number(inp.value||0));
        else if(k === "visible") c.visible = !!inp.checked;
        else if(k === "secret") c.secret = !!inp.checked;
        else if(k === "featuredEnabled") c.featuredEnabled = !!inp.checked;
        else c[k] = inp.value;
        trackCategoryUpsert(id);
        try{ logAudit("category_update", `Kategória módosítva: ${id}`, { id, field:k, before: prevVal, after: clone(c[k]) }, { scope: (k === "secret" ? "security" : "change"), fast:true }); }catch{}

        const fast = (k === "visible" || k === "secret" || k === "featuredEnabled");
        if(fast){
          try{ renderProducts(); }catch{}
          try{ renderPopups(); }catch{}
        }
        markDirty({ products:true, fast });
      };
      if(inp.type === "checkbox") inp.onchange = apply;
      else inp.oninput = apply;
    });

    $("#panelCategories").querySelectorAll("button[data-ren-cat]").forEach(btn => {
      btn.onclick = () => renameCategory(btn.dataset.renCat);
    });

    $("#panelCategories").querySelectorAll("button[data-delcat]").forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.delcat;
        if(state.doc.products.some(p => p.categoryId === id)) return;
        state.doc.categories = state.doc.categories.filter(c => c.id !== id);
        trackCategoryDelete(id);
        try{ logAudit("category_delete", `Kategória törölve: ${id}`, { id }, { scope:"change", fast:true }); }catch{}
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
        trackCategoryDelete(oldId);
        trackCategoryUpsert(newId);

        // update products pointing to it
        for(const p of (state.doc.products || [])){
          if(String(p.categoryId) === oldId){
            p.categoryId = newId;
            trackProductUpsert(p.id);
          }
        }
        try{ logAudit("category_rename", `Kategória átnevezve: ${oldId} → ${newId}`, { from: oldId, to: newId }, { scope:"change", fast:true }); }catch{}

        closeModal();
        renderAll();
        markDirty({ products:true, fast:true });
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

    const rank = (s) => s === "ok" ? 0 : (s === "soon" ? 1 : 2);
    list.sort((a,b) => {
      const ra = rank(a.status), rb = rank(b.status);
      if(ra !== rb) return ra - rb;
      const byName = naturalCompare(a.name_hu||a.name_en||"", b.name_hu||b.name_en||"");
      if(byName !== 0) return byName;
      return naturalCompare(a.flavor_hu||a.flavor_en||"", b.flavor_hu||b.flavor_en||"");
    });

    const rows = list.map(p => {
      const c = catById(p.categoryId);
      const eff = effectivePrice(p);
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
                  • Ár: <b>${eff.toLocaleString("hu-HU")} Ft</b>
                  • Készlet: <b>${p.status==="soon" ? "—" : p.stock}</b>
                  ${p.status==="soon" && p.soonEta ? `• Várható: <b>${escapeHtml(p.soonEta)}</b>` : ""}
                </div>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <label class="chk"><input type="checkbox" data-pid="${escapeHtml(p.id)}" data-k="visible"${p.visible===false?"":" checked"}> Látható</label>
            <label class="chk"><input type="checkbox" data-pid="${escapeHtml(p.id)}" data-k="secret"${p.secret===true?" checked":""}> Titkos</label>
            <select data-pid="${escapeHtml(p.id)}" data-k="categoryId">
              ${state.doc.categories.map(cc => `<option value="${escapeHtml(cc.id)}"${cc.id===p.categoryId?" selected":""}>${escapeHtml(cc.label_hu||cc.id)}</option>`).join("")}
            </select>
            <select data-pid="${escapeHtml(p.id)}" data-k="status">
              <option value="ok"${p.status==="ok"?" selected":""}>ok</option>
              <option value="out"${p.status==="out"?" selected":""}>out</option>
              <option value="soon"${p.status==="soon"?" selected":""}>soon</option>
            </select>
            <input data-pid="${escapeHtml(p.id)}" data-k="stock" type="number" min="0" value="${p.stock}" style="width:110px;">
            <input data-pid="${escapeHtml(p.id)}" data-k="price" type="number" min="0" value="${p.price===null? "" : p.price}" placeholder="(kat ár)" style="width:150px;">
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
    $("#prodSearch").oninput = () => {
      state.filters.productsSearch = $("#prodSearch").value;
      rerenderWithInputState("#prodSearch", renderProducts);
    };

    $("#btnAddProd").onclick = () => openProductModal(null);

    $("#panelProducts").querySelectorAll("[data-pid]").forEach(el => {
      const apply = () => {
        const pid = el.dataset.pid;
        const k = el.dataset.k;
        const p = prodById(pid);
        if(!p) return;

        const before = clone(p[k]);
        if(k === "stock"){
          const prevStock = Number(p.stock || 0);
          p.stock = setProductStockValue(pid, el.value, { absolute:true });
          if(p.stock <= 0 && p.status !== "soon") p.status = "out";
          try{ logAudit("product_stock", `Készlet módosítva: ${pid}`, { id: pid, before: prevStock, after: Number(p.stock || 0) }, { scope:"change", fast:true }); }catch{}
          markDirty({ products:true, stockOnly:true, fast:true });
          return;
        }else if(k === "price"){
          p.price = (el.value === "" ? null : Math.max(0, Number(el.value||0)));
        }else if(k === "status"){
          p.status = el.value;
          if(p.status === "out") p.stock = setProductStockValue(pid, 0, { absolute:true });
        }else if(k === "categoryId"){
          p.categoryId = el.value;
        }else if(k === "visible"){
          p.visible = !!el.checked;
        }else if(k === "secret"){
          p.secret = !!el.checked;
        }
        trackProductUpsert(pid);
        try{ logAudit("product_update", `Termék módosítva: ${pid}`, { id: pid, field: k, before, after: clone(p[k]) }, { scope: (k === "secret" ? "security" : "change"), fast:true }); }catch{}

        const fast = (k === "status" || k === "categoryId" || k === "visible" || k === "secret");
        if(fast){
          try{ renderProducts(); }catch{}
          try{ renderPopups(); }catch{}
        }
        markDirty({ products:true, fast });
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
        if(state.sales.some(s => s.items.some(it => it.productId === id))) return;
        state.doc.products = state.doc.products.filter(p => p.id !== id);
        trackProductDelete(id);
        try{ logAudit("product_delete", `Termék törölve: ${id}`, { id }, { scope:"change", fast:true }); }catch{}
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
      soonEta: "",
      visible: true,
      secret: false
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

        <div class="field third"><label>Látható</label><label class="chk" style="justify-content:flex-start;"><input type="checkbox" id="p_visible" ${p.visible===false?"":"checked"}> Public oldalon</label></div>
        <div class="field third"><label>Titkos</label><label class="chk" style="justify-content:flex-start;"><input type="checkbox" id="p_secret" ${p.secret===true?"checked":""}> Csak jelszóval</label></div>

        <div class="field third"><label>Készlet</label><input id="p_stock" type="number" min="0" value="${p.stock}"></div>
        <div class="field third"><label>Ár (Ft) — üres: kategória ár</label><input id="p_price" type="number" min="0" value="${p.price===null?"":p.price}"></div>
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
          secret: !!$("#p_secret").checked,
          stock: Math.max(0, Number($("#p_stock").value||0)),
          price: ($("#p_price").value === "" ? null : Math.max(0, Number($("#p_price").value||0))),
          image: ($("#p_img").value||"").trim(),
          name_hu: ($("#p_name").value||"").trim(),
          name_en: ($("#p_name").value||"").trim(),
          flavor_hu: ($("#p_fhu").value||"").trim(),
          flavor_en: ($("#p_fen").value||"").trim(),
          soonEta: ($("#p_eta").value||"").replace(/^(\d{4}-\d{2}).*$/, "$1")
        };
        if(np.status !== "soon") np.soonEta = "";
        if(!np.id) return;

        if(editing){
          Object.assign(editing, np);
          trackProductUpsert(editing.id);
          try{ logAudit("product_edit", `Termék szerkesztve: ${editing.id}`, { id: editing.id, categoryId: np.categoryId, status: np.status, stock: np.stock }, { scope:"change", fast:true }); }catch{}
        }else{
          state.doc.products.push(np);
          trackProductUpsert(np.id);
          try{ logAudit("product_create", `Új termék: ${np.id}`, { id: np.id, categoryId: np.categoryId, status: np.status, stock: np.stock }, { scope:"change", fast:true }); }catch{}
        }
        closeModal();
        renderAll();
        markDirty({ products:true });
      }}
    ]);

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
    const q = (state.filters.salesSearch || "").toLowerCase().trim();

    let list = [...state.sales].sort((a,b)=> String(b.date).localeCompare(String(a.date)));
    if(q){
      list = list.filter(s => {
        const productText = (Array.isArray(s.items) ? s.items : []).map(it => {
          const p = prodById(it.productId);
          return [
            it.productId,
            p?.name_hu || p?.name_en || "",
            p?.flavor_hu || p?.flavor_en || ""
          ].join(" ");
        }).join(" ");
        return (`${s.id || ""} ${s.date || ""} ${s.name || ""} ${s.payment || ""} ${productText}`).toLowerCase().includes(q);
      });
    }
    if(filterCat !== "all"){
      list = list.filter(s => saleTotals(s, filterCat).hit);
    }

    const rows = list.map(s => {
      const tot = saleTotals(s, filterCat);
      const itemsCount = s.items.reduce((acc,it)=> acc + Number(it.qty||0), 0);

      return `
        <div class="rowline">
          <div class="left">
            <div style="font-weight:900;">
              ${escapeHtml(s.date)} • ${escapeHtml(s.name || "—")}
              <span class="small-muted">• ${escapeHtml(s.payment || "")}</span>
            </div>
            <div class="small-muted">Tételek: <b>${itemsCount}</b> • Bevétel: <b>${tot.revenue.toLocaleString("hu-HU")} Ft</b></div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
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
      <div class=\"actions table" style="align-items:center;">
        <button class="primary" id="btnAddSale">+ Eladás</button>
        <select id="salesCat">
          ${cats.map(c => `<option value="${escapeHtml(c.id)}"${c.id===filterCat?" selected":""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
        <input id="salesSearch" placeholder="Keresés név / mód / termék / íz szerint..." value="${escapeHtml(state.filters.salesSearch)}" style="flex:1;min-width:220px;">
        <div class="small-muted">Szűrés kategóriára: csak az adott kategória tételeit számolja.</div>
      </div>
      <div style="margin-top:10px;">${rows || `<div class="small-muted">Nincs eladás.</div>`}</div>
    `;

    $("#salesCat").onchange = () => { state.filters.salesCat = $("#salesCat").value; renderSales(); drawChart(); };
    $("#salesSearch").oninput = () => { state.filters.salesSearch = $("#salesSearch").value; rerenderWithInputState("#salesSearch", renderSales); };

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

    // reservation handlers
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

    const cats = [...state.doc.categories].sort((a,b)=> naturalCompare(a.label_hu||a.id, b.label_hu||b.id));

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
        arr.sort((a,b)=> naturalCompare(prodLabel(a), prodLabel(b)));
        const items = arr.map(p => {
          const img = (p.image || "").trim();
          const thumb = img
            ? `<img class="picker-thumb" src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : `<div class="picker-thumb ph">SV</div>`;
          const eff = effectivePrice(p);
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
    const editingSale = (pre && pre.id) ? state.sales.find(x => String(x.id) === String(pre.id)) : null;
    const preDate = (pre && pre.date) ? String(pre.date) : todayISO();
    const preName = (pre && pre.name) ? String(pre.name) : "";
    const prePay  = (pre && pre.payment) ? String(pre.payment) : "";
    const preItems = (pre && Array.isArray(pre.items)) ? pre.items : [];
    const title = (pre && pre.title) ? String(pre.title) : (editingSale ? "Eladás szerkesztése" : "Új eladás");

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
        <button class="ghost" id="btnAddItem">+ Tétel</button>
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
      { label: editingSale ? "Mentés" : "Rögzítés", kind:"primary", onClick: () => {
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

        const oldItems = Array.isArray(editingSale?.items) ? editingSale.items : [];
        const oldQtyMap = new Map();
        const newQtyMap = new Map();

        for(const it of oldItems){
          oldQtyMap.set(String(it.productId), (oldQtyMap.get(String(it.productId)) || 0) + Number(it.qty || 0));
        }
        for(const it of items){
          newQtyMap.set(String(it.productId), (newQtyMap.get(String(it.productId)) || 0) + Number(it.qty || 0));
        }

        const touched = new Set([...oldQtyMap.keys(), ...newQtyMap.keys()]);
        for(const pid of touched){
          const p = prodById(pid);
          if(!p) return;
          if(p.status === 'soon') return;
          const delta = Number(newQtyMap.get(pid) || 0) - Number(oldQtyMap.get(pid) || 0);
          if(delta > 0 && Number(p.stock || 0) < delta){
            alert('Nincs elég raktárkészlet ehhez a módosításhoz.');
            return;
          }
        }

        for(const pid of touched){
          const p = prodById(pid);
          if(!p) continue;
          const delta = Number(newQtyMap.get(pid) || 0) - Number(oldQtyMap.get(pid) || 0);
          p.stock = Math.max(0, Number(p.stock || 0) - delta);
          adjustProductStockValue(pid, -delta);
          if(p.stock <= 0){
            p.stock = 0;
            if(p.status !== "soon") p.status = "out";
          }else if(p.status === "out"){
            p.status = "ok";
          }
        }

        let saleId = editingSale ? String(editingSale.id) : ("s_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16));
        if(editingSale){
          editingSale.date = date;
          editingSale.name = name;
          editingSale.payment = payment;
          editingSale.items = items;
          trackSaleUpsert(saleId);
          try{ logAudit("sale_edit", `Eladás szerkesztve: ${saleId}`, { id: saleId, items: items.length, totalQty: items.reduce((a,it)=>a+Number(it.qty||0),0) }, { scope:"change", fast:true }); }catch{}
        }else{
          state.sales.push({
            id: saleId,
            date,
            name,
            payment,
            items
          });
          trackSaleUpsert(saleId);
          try{ logAudit("sale_create", `Új eladás: ${saleId}`, { id: saleId, items: items.length, totalQty: items.reduce((a,it)=>a+Number(it.qty||0),0) }, { scope:"change", fast:true }); }catch{}
        }

        if(pre && pre.fromReservationId){
          state.reservations = (state.reservations || []).filter(x => String(x.id) !== String(pre.fromReservationId));
          trackReservationDelete(pre.fromReservationId);
          try{ logAudit("reservation_convert_sale", `Foglalás eladássá alakítva: ${pre.fromReservationId}`, { reservationId: pre.fromReservationId, saleId }, { scope:"change", fast:true }); }catch{}
          markDirty({ reservations:true });
        }

        closeModal();
        renderAll();
        markDirty({ products:true, sales:true, reservations: !!(pre && pre.fromReservationId), stockOnly:true });
      }}
    ]);
  }

  function editSale(id){
    const s = state.sales.find(x => String(x.id) === String(id));
    if(!s) return;
    openSaleModal({
      id: s.id,
      title: "Eladás szerkesztése",
      date: s.date,
      name: s.name,
      payment: s.payment,
      items: (s.items || []).map(it => ({...it}))
    });
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
      .filter(r => r && (r.confirmed || !isReservationExpired(r)))
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
      const removed = (state.reservations || []).filter(r => r && !kept.some(x => String(x.id) === String(r.id)));
      state.reservations = kept;
      removed.forEach(r => trackReservationDelete(r.id));
      try{ if(removed.length) logAudit("reservation_expire", `Lejárt foglalások törölve: ${removed.length} db`, { ids: removed.map(r => r.id) }, { scope:"system", fast:true }); }catch{}
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
    state.reservations = (state.reservations || []).filter(x => String(x.id) !== String(id));
    trackReservationDelete(id);
    try{ logAudit("reservation_delete", `Foglalás törölve: ${id}`, { id }, { scope:"change", fast:true }); }catch{}
    renderAll();
    markDirty({ reservations:true });
  }

  function confirmReservation(id){
    const r = findReservation(id);
    if(!r) return;
    r.confirmed = true;
    r.expiresAt = null;
    trackReservationUpsert(r.id);
    try{ logAudit("reservation_confirm", `Foglalás megerősítve: ${id}`, { id }, { scope:"change", fast:true }); }catch{}
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
        trackReservationUpsert(r.id);
        try{ logAudit("reservation_edit", `Foglalás szerkesztve: ${r.id}`, { id: r.id, items: items.length }, { scope:"change", fast:true }); }catch{}
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
function deleteSale(id){
    const idx = state.sales.findIndex(x => x.id === id);
    if(idx < 0) return;
    const s = state.sales[idx];

    // rollback stock
    for(const it of s.items){
      const p = prodById(it.productId);
      if(!p) continue;
      p.stock = Math.max(0, Number(p.stock||0) + Number(it.qty||0));
      adjustProductStockValue(it.productId, Number(it.qty||0));
      if(p.stock > 0 && p.status === "out") p.status = "ok";
    }

    state.sales.splice(idx, 1);
    trackSaleDelete(id);
    try{ logAudit("sale_delete", `Eladás törölve: ${id}`, { id }, { scope:"change", fast:true }); }catch{}
    renderAll();
    markDirty({ products:true, sales:true, stockOnly:true });
  }

  function renderChartPanel(){
  initChartFilters();

  const cats = [{id:"all", label:"Mind"}, ...state.doc.categories.map(c=>({id:c.id,label:c.label_hu||c.id}))];
  const years = [...new Set((state.sales || []).map(s => String(s.date || "").slice(0,4)).filter(Boolean))].sort();
  if(!years.length) years.push(String(new Date().getFullYear()));
  if(!years.includes(String(state.filters.chartYear || ""))) state.filters.chartYear = years[years.length - 1];

  const weekStart = startOfWeek(parseDateInput(state.filters.chartWeek) || new Date());
  const weekEnd = endOfWeek(parseDateInput(state.filters.chartWeek) || new Date());

  $("#panelChart").innerHTML = `
    <div class="chart-toolbar">
      <div class="chart-toolbar-group">
        <div class="small-muted">Kategória</div>
        <select id="chartCat">
          ${cats.map(c => `<option value="${escapeHtml(c.id)}"${c.id===state.filters.chartCat?" selected":""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
      </div>

      <div class="chart-toolbar-group">
        <div class="small-muted">Összesen: ettől</div>
        <input type="date" id="chartAllFrom" value="${escapeHtml(state.filters.chartAllFrom || "")}">
      </div>
      <div class="chart-toolbar-group">
        <div class="small-muted">Összesen: eddig</div>
        <input type="date" id="chartAllTo" value="${escapeHtml(state.filters.chartAllTo || "")}">
      </div>
      <div class="chart-toolbar-group">
        <div class="small-muted">Év</div>
        <select id="chartYear">${years.map(y => `<option value="${escapeHtml(y)}"${String(state.filters.chartYear)===String(y)?" selected":""}>${escapeHtml(y)}</option>`).join("")}</select>
      </div>
      <div class="chart-toolbar-group">
        <div class="small-muted">Hónap</div>
        <input type="month" id="chartMonth" value="${escapeHtml(state.filters.chartMonth || "")}">
      </div>
      <div class="chart-toolbar-group">
        <div class="small-muted">Hét (bármelyik nap)</div>
        <input type="date" id="chartWeek" value="${escapeHtml(state.filters.chartWeek || "")}">
      </div>
      <div class="chart-toolbar-group">
        <div class="small-muted">Nap</div>
        <input type="date" id="chartDay" value="${escapeHtml(state.filters.chartDay || "")}">
      </div>
      <div class="chart-toolbar-group chart-toolbar-actions">
        <button class="ghost" id="chartResetBtn" type="button">Vissza alapra</button>
      </div>
    </div>

    <div class="kpi" style="margin-top:10px;">
      <div class="box" style="min-width:170px;">
        <div class="t">Összesen</div>
        <div class="v" id="kpi_all">0 Ft</div>
      </div>
      <div class="box" style="min-width:170px;">
        <div class="t">Év</div>
        <div class="v" id="kpi_year">0 Ft</div>
      </div>
      <div class="box" style="min-width:170px;">
        <div class="t">Hónap</div>
        <div class="v" id="kpi_month">0 Ft</div>
      </div>
      <div class="box" style="min-width:170px;">
        <div class="t">Hét</div>
        <div class="v" id="kpi_week">0 Ft</div>
      </div>
      <div class="box" style="min-width:170px;">
        <div class="t">Nap</div>
        <div class="v" id="kpi_day">0 Ft</div>
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-head">
        <div>
          <div class="chart-title">Összesen</div>
          <div class="small-muted" id="chartSubAll">${escapeHtml(state.filters.chartAllFrom || "—")} – ${escapeHtml(state.filters.chartAllTo || "—")}</div>
        </div>
      </div>
      <canvas id="revAll" height="220"></canvas>
    </div>

    <div class="chart-card">
      <div class="chart-head">
        <div>
          <div class="chart-title">Évi</div>
          <div class="small-muted" id="chartSubYear">${escapeHtml(String(state.filters.chartYear || ""))}.01.01 – ${escapeHtml(String(state.filters.chartYear || ""))}.12.31</div>
        </div>
      </div>
      <canvas id="revYear" height="220"></canvas>
    </div>

    <div class="chart-card">
      <div class="chart-head">
        <div>
          <div class="chart-title">Havi</div>
          <div class="small-muted" id="chartSubMonth">${escapeHtml(state.filters.chartMonth || "")}</div>
        </div>
      </div>
      <canvas id="revMonth" height="220"></canvas>
    </div>

    <div class="chart-card">
      <div class="chart-head">
        <div>
          <div class="chart-title">Heti</div>
          <div class="small-muted" id="chartSubWeek">${escapeHtml((weekStart.toISOString().slice(0,10)))} – ${escapeHtml((weekEnd.toISOString().slice(0,10)))}</div>
        </div>
      </div>
      <canvas id="revWeek" height="220"></canvas>
    </div>

    <div class="chart-card">
      <div class="chart-head">
        <div>
          <div class="chart-title">Napi</div>
          <div class="small-muted" id="chartSubDay">${escapeHtml(state.filters.chartDay || "")}</div>
        </div>
      </div>
      <canvas id="revDay" height="220"></canvas>
    </div>
  `;

  const syncAndDraw = () => {
    state.filters.chartCat = $("#chartCat")?.value || "all";
    state.filters.chartAllFrom = $("#chartAllFrom")?.value || state.filters.chartAllFrom;
    state.filters.chartAllTo = $("#chartAllTo")?.value || state.filters.chartAllTo;
    state.filters.chartYear = $("#chartYear")?.value || state.filters.chartYear;
    state.filters.chartMonth = $("#chartMonth")?.value || state.filters.chartMonth;
    state.filters.chartWeek = $("#chartWeek")?.value || state.filters.chartWeek;
    state.filters.chartDay = $("#chartDay")?.value || state.filters.chartDay;
    drawChart();
  };

  ["#chartCat", "#chartAllFrom", "#chartAllTo", "#chartYear", "#chartMonth", "#chartWeek", "#chartDay"].forEach(sel => {
    const el = $(sel);
    if(el) el.addEventListener("change", syncAndDraw);
  });

  $("#chartResetBtn").onclick = () => {
    initChartFilters(true);
    renderChartPanel();
  };

  drawChart();
}


  /* ---------- Popups (Új termékek) ---------- */
  function renderPopups(){
    const panel = $("#panelPopups");
    if(!panel) return;

    const popups = [...(state.doc.popups || [])].sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    panel.innerHTML = `
      <div class="actions table" style="align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-weight:900;">Pop-upok</div>
          <div class="small-muted">Itt tudod kezelni, melyik új termékes pop-up jelenjen meg a user oldalon.</div>
        </div>
        <button class="primary" id="btnAddPopup" type="button">+ Új pop-up</button>
      </div>
      <div style="margin-top:12px;display:grid;gap:10px;" id="popupRows">
        ${popups.length ? popups.map(pp => {
          const cats = (pp.categoryIds || []).map(id => catById(id)?.label_hu || id).join(", ");
          const prods = (pp.productIds || []).map(id => {
            const p = prodById(id);
            if(!p) return id;
            return `${p.name_hu || p.name_en || "—"} — ${p.flavor_hu || p.flavor_en || ""}`;
          }).join(", ");
          return `
            <div class="rowline table popup-row">
              <div class="left">
                <div style="font-weight:900;">${escapeHtml(pp.title_hu || "Új termékek elérhetőek")}</div>
                <div class="small-muted">ID: <b>${escapeHtml(pp.id)}</b> • Rev: <b>${Number(pp.rev || 0)}</b></div>
                <div class="small-muted">Kategóriák: <b>${escapeHtml(cats || "—")}</b></div>
                <div class="small-muted">Kézi termékek: <b>${escapeHtml(prods || "—")}</b></div>
              </div>
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <label class="chk"><input type="checkbox" data-popup-toggle="${escapeHtml(pp.id)}" ${pp.enabled === false ? "" : "checked"}> Aktív</label>
                <button class="ghost" data-popup-edit="${escapeHtml(pp.id)}" type="button">Szerkeszt</button>
                <button class="danger" data-popup-delete="${escapeHtml(pp.id)}" type="button">Töröl</button>
              </div>
            </div>
          `;
        }).join("") : `<div class="small-muted">Nincs még pop-up.</div>`}
      </div>
    `;

    $("#btnAddPopup").onclick = () => openPopupModal(null);

    panel.querySelectorAll("[data-popup-toggle]").forEach(el => {
      el.addEventListener("change", () => {
        const id = String(el.getAttribute("data-popup-toggle") || "");
        const idx = (state.doc.popups || []).findIndex(x => String(x.id) === id);
        if(idx < 0) return;
        state.doc.popups[idx] = {
          ...state.doc.popups[idx],
          enabled: !!el.checked,
          updatedAt: Date.now(),
          rev: Date.now()
        };
        trackPopupsDirty();
        try{ logAudit("popup_toggle", `Pop-up állapot módosítva: ${id}`, { id, enabled: !!el.checked }, { scope:"change", fast:true }); }catch{}
        markDirty({ products:true, fast:true });
      });
    });

    panel.querySelectorAll("[data-popup-edit]").forEach(btn => {
      btn.onclick = () => openPopupModal(btn.getAttribute("data-popup-edit"));
    });

    panel.querySelectorAll("[data-popup-delete]").forEach(btn => {
      btn.onclick = () => {
        const id = String(btn.getAttribute("data-popup-delete") || "");
        const body = document.createElement("div");
        body.innerHTML = `<div class="small-muted">Biztos törlöd ezt a pop-upot? <b>${escapeHtml(id)}</b></div>`;
        openModal("Pop-up törlése", "", body, [
          { label:"Mégse", kind:"ghost", onClick: closeModal },
          { label:"Törlés", kind:"danger", onClick: () => {
            state.doc.popups = (state.doc.popups || []).filter(x => String(x.id) !== id);
            trackPopupsDirty();
            try{ logAudit("popup_delete", `Pop-up törölve: ${id}`, { id }, { scope:"change", fast:true }); }catch{}
            closeModal();
            renderPopups();
            markDirty({ products:true, fast:true });
          }}
        ]);
      };
    });
  }

  function openPopupModal(id){
    const editing = id ? (state.doc.popups || []).find(x => String(x.id) === String(id)) : null;
    const base = editing ? { ...editing } : {
      id: "popup_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16),
      enabled: true,
      rev: Date.now(),
      title_hu: "Új termékek elérhetőek",
      title_en: "Új termékek elérhetőek",
      categoryIds: [],
      productIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const cats = [...state.doc.categories].sort((a,b) => (a.label_hu || a.id).localeCompare((b.label_hu || b.id), "hu"));
    const catMap = new Map(cats.map(c => [String(c.id), c]));
    const prods = [...state.doc.products].sort((a,b) => {
      const catA = catMap.get(String(a.categoryId || ""))?.label_hu || "";
      const catB = catMap.get(String(b.categoryId || ""))?.label_hu || "";
      if(catA !== catB) return catA.localeCompare(catB, "hu");
      const nameA = a.name_hu || a.name_en || "";
      const nameB = b.name_hu || b.name_en || "";
      if(nameA !== nameB) return nameA.localeCompare(nameB, "hu");
      return (a.flavor_hu || a.flavor_en || "").localeCompare((b.flavor_hu || b.flavor_en || ""), "hu");
    });

    const body = document.createElement("div");
    body.innerHTML = `
      <div class="form-grid">
        <div class="field third"><label>ID</label><input id="pp_id" value="${escapeHtml(base.id)}" ${editing ? "disabled" : ""}></div>
        <div class="field third"><label>Aktív</label><label class="chk"><input type="checkbox" id="pp_enabled" ${base.enabled === false ? "" : "checked"}> Bekapcsolva</label></div>
        <div class="field third"><label>Rev</label><input id="pp_rev" value="${Number(base.rev || 0)}" disabled></div>
        <div class="field full"><label>Cím</label><input id="pp_thu" value="${escapeHtml(base.title_hu || "")}"></div>
        <div class="field full"><label>Kategóriák</label>
          <div class="check-grid">
            ${cats.map(c => `<label class="chk"><input type="checkbox" class="pp_cat" value="${escapeHtml(c.id)}" ${(base.categoryIds || []).includes(c.id) ? "checked" : ""}> ${escapeHtml(c.label_hu || c.id)}</label>`).join("")}
          </div>
        </div>
        <div class="field full"><label>Kézi termékek</label>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
            <input id="pp_search" placeholder="Keresés név / íz szerint..." style="flex:1;min-width:240px;">
            <select id="pp_catfilter" style="width:240px;">
              <option value="all">Összes kategória</option>
              ${cats.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label_hu || c.id)}</option>`).join("")}
            </select>
          </div>
          <div class="check-grid" id="pp_prod_list">
            ${prods.map(p => {
              const cid = String(p.categoryId || "");
              const cname = catMap.get(cid)?.label_hu || cid;
              return `
                <label class="chk" data-cat="${escapeHtml(cid)}" data-search="${escapeHtml(`${p.name_hu || p.name_en || ""} ${(p.flavor_hu || p.flavor_en || "")}`.toLowerCase())}" style="display:flex;flex-direction:column;gap:2px;padding:10px;border-radius:8px;background:rgba(255,255,255,0.05);">
                  <div style="display:flex;align-items:flex-start;gap:8px;">
                    <input type="checkbox" class="pp_prod" value="${escapeHtml(p.id)}" ${(base.productIds || []).includes(p.id) ? "checked" : ""}>
                    <div>
                      <div style="font-weight:700;">${escapeHtml(p.name_hu || p.name_en || "—")}</div>
                      <div style="font-size:12px;color:var(--muted);">${escapeHtml(p.flavor_hu || p.flavor_en || "")}</div>
                      <div style="font-size:11px;color:var(--brand2);margin-top:4px;">[${escapeHtml(cname || "—")}]</div>
                    </div>
                  </div>
                </label>
              `;
            }).join("")}
          </div>
        </div>
      </div>
    `;

    openModal(editing ? "Pop-up szerkesztése" : "Új pop-up", "Csak X-szel vagy gombbal zárható.", body, [
      { label:"Mégse", kind:"ghost", onClick: closeModal },
      { label:"Mentés", kind:"primary", onClick: () => {
        const next = {
          id: String($("#pp_id")?.value || "").trim(),
          enabled: !!$("#pp_enabled")?.checked,
          title_hu: String($("#pp_thu")?.value || "").trim() || "Új termékek elérhetőek",
          title_en: String($("#pp_thu")?.value || "").trim() || "Új termékek elérhetőek",
          categoryIds: Array.from(body.querySelectorAll(".pp_cat:checked")).map(x => String(x.value)),
          productIds: Array.from(body.querySelectorAll(".pp_prod:checked")).map(x => String(x.value)),
          createdAt: editing ? Number(editing.createdAt || Date.now()) : Date.now(),
          updatedAt: Date.now(),
          rev: Date.now()
        };
        if(!next.id) return;
        if(editing){
          state.doc.popups = (state.doc.popups || []).map(x => String(x.id) === String(editing.id) ? next : x);
          try{ logAudit("popup_edit", `Pop-up szerkesztve: ${next.id}`, { id: next.id, enabled: next.enabled }, { scope:"change", fast:true }); }catch{}
        }else{
          state.doc.popups = [...(state.doc.popups || []), next];
          try{ logAudit("popup_create", `Új pop-up: ${next.id}`, { id: next.id, enabled: next.enabled }, { scope:"change", fast:true }); }catch{}
        }
        trackPopupsDirty();
        closeModal();
        renderPopups();
        markDirty({ products:true });
      }}
    ]);

    const search = $("#pp_search");
    const filter = $("#pp_catfilter");
    const applyFilter = () => {
      const q = String(search?.value || "").trim().toLowerCase();
      const cf = String(filter?.value || "all");
      body.querySelectorAll("#pp_prod_list > label.chk").forEach(lab => {
        const text = String(lab.getAttribute("data-search") || "");
        const cat = String(lab.getAttribute("data-cat") || "");
        const ok = (!q || text.includes(q)) && (cf === "all" || cat === cf);
        lab.style.display = ok ? "" : "none";
      });
    };
    if(search) search.addEventListener("input", applyFilter);
    if(filter) filter.addEventListener("change", applyFilter);
    applyFilter();
  }

  function drawChart(){
  initChartFilters();
  const cat = state.filters.chartCat || "all";

  const css = getComputedStyle(document.documentElement);
  const accent = (css.getPropertyValue("--brand2") || "#4aa3ff").trim();
  const fill = "rgba(40,215,255,.14)";
  const grid = "rgba(255,255,255,.08)";
  const text = "rgba(255,255,255,.82)";
  const muted = "rgba(255,255,255,.55)";

  const fmtFt = (n) => `${Math.round(n).toLocaleString("hu-HU")} Ft`;
  const iso = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
  };
  const parseISO = (s) => parseDateInput(s) || new Date();
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };

  const allFrom = parseDateInput(state.filters.chartAllFrom) || parseDateInput(getSalesDateBounds().min) || new Date();
  const allToRaw = parseDateInput(state.filters.chartAllTo) || parseDateInput(getSalesDateBounds().max) || new Date();
  const allTo = allToRaw < allFrom ? new Date(allFrom) : allToRaw;

  const selectedYear = Number(state.filters.chartYear || new Date().getFullYear()) || new Date().getFullYear();
  const yearStart = new Date(selectedYear, 0, 1);
  const yearEnd = new Date(selectedYear, 11, 31);

  const monthValue = String(state.filters.chartMonth || monthInputValue(new Date()));
  let monthYear = Number(monthValue.slice(0,4));
  let monthIdx = Number(monthValue.slice(5,7)) - 1;
  if(!Number.isFinite(monthYear) || !Number.isFinite(monthIdx) || monthIdx < 0 || monthIdx > 11){
    const now = new Date();
    monthYear = now.getFullYear();
    monthIdx = now.getMonth();
  }
  const monthStart = new Date(monthYear, monthIdx, 1);
  const monthEnd = endOfMonth(monthYear, monthIdx);

  const weekPivot = parseDateInput(state.filters.chartWeek) || new Date();
  const weekStart = startOfWeek(weekPivot);
  const weekEnd = endOfWeek(weekPivot);

  const daySelected = parseDateInput(state.filters.chartDay) || new Date();
  const dayIso = iso(daySelected);

  const allDayMap = new Map();
  const yearDayMap = new Map();
  const monthDayMap = new Map();
  const weekDayMap = new Map();
  const dayContextMap = new Map();

  let allTotal = 0, yearTotal = 0, monthTotal = 0, weekTotal = 0, dayTotal = 0;

  for(const sale of (state.sales || [])){
    const dt = String(sale.date || "").slice(0,10);
    if(!dt) continue;
    const d = parseDateInput(dt);
    if(!d) continue;

    const totals = saleTotals(sale, cat);
    const revenue = Number(totals.revenue || 0);
    if(!revenue) continue;

    const key = iso(d);
    if(d >= allFrom && d <= allTo){
      allDayMap.set(key, (allDayMap.get(key) || 0) + revenue);
      allTotal += revenue;
    }
    if(d >= yearStart && d <= yearEnd){
      yearDayMap.set(key, (yearDayMap.get(key) || 0) + revenue);
      yearTotal += revenue;
    }
    if(d >= monthStart && d <= monthEnd){
      monthDayMap.set(key, (monthDayMap.get(key) || 0) + revenue);
      monthTotal += revenue;
    }
    if(d >= weekStart && d <= weekEnd){
      weekDayMap.set(key, (weekDayMap.get(key) || 0) + revenue);
      weekTotal += revenue;
    }
    if(key === dayIso) dayTotal += revenue;
    if(key === iso(addDays(daySelected, -1)) || key === dayIso){
      dayContextMap.set(key, (dayContextMap.get(key) || 0) + revenue);
    }
  }

  const setKpi = (id, val) => { const el = $(id); if(el) el.textContent = fmtFt(val); };
  setKpi("#kpi_all", allTotal);
  setKpi("#kpi_year", yearTotal);
  setKpi("#kpi_month", monthTotal);
  setKpi("#kpi_week", weekTotal);
  setKpi("#kpi_day", dayTotal);

  const setSub = (id, value) => { const el = $(id); if(el) el.textContent = value; };
  setSub("#chartSubAll", `${iso(allFrom)} – ${iso(allTo)}`);
  setSub("#chartSubYear", `${selectedYear}.01.01 – ${selectedYear}.12.31`);
  setSub("#chartSubMonth", `${monthValue} (${iso(monthStart)} – ${iso(monthEnd)})`);
  setSub("#chartSubWeek", `${iso(weekStart)} – ${iso(weekEnd)}`);
  setSub("#chartSubDay", `${dayIso} (előző nap + kiválasztott nap)`);

  const buildDailySeries = (startDate, endDate, sourceMap) => {
    const arr = [];
    for(let d = new Date(startDate); d <= endDate; d = addDays(d,1)){
      const key = iso(d);
      arr.push({ label: key, rev: Number(sourceMap.get(key) || 0) });
    }
    return arr;
  };

  const buildMonthlySeries = (startDate, endDate, sourceMap) => {
    const monthly = new Map();
    for(const [key, value] of sourceMap.entries()){
      const ym = key.slice(0,7);
      monthly.set(ym, (monthly.get(ym) || 0) + Number(value || 0));
    }
    const arr = [];
    const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
    while(cur <= end){
      const ym = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,"0")}`;
      arr.push({ label: ym, rev: Number(monthly.get(ym) || 0) });
      cur.setMonth(cur.getMonth()+1);
    }
    return arr;
  };

  const drawLine = (canvas, points) => {
    if(!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width || canvas.clientWidth || 300);
    const h = Math.max(1, rect.height || 220);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    const ctx = canvas.getContext("2d");
    if(!ctx) return;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);

    const safePoints = points.length ? points : [{ label:"—", rev:0 }];
    const padL = 52, padR = 14, padT = 18, padB = 36;
    const pw = Math.max(1, w - padL - padR);
    const ph = Math.max(1, h - padT - padB);
    const max = Math.max(1, ...safePoints.map(p => Number(p.rev || 0)));
    const n = safePoints.length;

    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    for(let i=0;i<=4;i++){
      const y = padT + (ph * i / 4);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
      ctx.stroke();
    }

    ctx.fillStyle = muted;
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for(let i=0;i<=4;i++){
      const v = Math.round(max * (1 - i/4));
      const y = padT + (ph * i / 4);
      ctx.fillText(fmtFt(v).replace(" Ft",""), padL - 8, y);
    }

    const xAt = (i) => n <= 1 ? padL + pw / 2 : padL + (pw * (i / (n - 1)));
    const yAt = (v) => padT + ph - (ph * (Number(v || 0) / max));

    ctx.beginPath();
    safePoints.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.rev);
      if(i === 0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    });
    ctx.lineTo(xAt(n - 1), padT + ph);
    ctx.lineTo(xAt(0), padT + ph);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    safePoints.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.rev);
      if(i === 0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    });
    ctx.stroke();

    ctx.fillStyle = accent;
    safePoints.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.rev);
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = text;
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labels = [];
    if(n === 1){
      labels.push({ i:0, t:safePoints[0].label });
    }else if(n === 2){
      labels.push({ i:0, t:safePoints[0].label });
      labels.push({ i:1, t:safePoints[1].label });
    }else{
      labels.push({ i:0, t:safePoints[0].label });
      labels.push({ i:Math.floor((n - 1) / 2), t:safePoints[Math.floor((n - 1) / 2)].label });
      labels.push({ i:n - 1, t:safePoints[n - 1].label });
    }
    labels.forEach(obj => ctx.fillText(String(obj.t || ""), xAt(obj.i), padT + ph + 10));
  };

  const seriesAll = buildMonthlySeries(allFrom, allTo, allDayMap);
  const seriesYear = buildMonthlySeries(yearStart, yearEnd, yearDayMap);
  const seriesMonth = buildDailySeries(monthStart, monthEnd, monthDayMap);
  const seriesWeek = buildDailySeries(weekStart, weekEnd, weekDayMap);
  const seriesDay = buildDailySeries(addDays(daySelected, -1), daySelected, dayContextMap);

  drawLine($("#revAll"), seriesAll);
  drawLine($("#revYear"), seriesYear);
  drawLine($("#revMonth"), seriesMonth);
  drawLine($("#revWeek"), seriesWeek);
  drawLine($("#revDay"), seriesDay);
}


  function renderAll(){
    renderSettings();
    renderCategories();
    renderProducts();
    renderSales();
    renderChartPanel();
    renderPopups();
    renderUsers();
    renderHistory();
    drawChart();
  }

  /* ---------- init ---------- */
  function init(){
    renderTabs();
    $("#btnReload").onclick = () => {
      location.reload();
    };
    const historyBtn = $("#btnHistory");
    if(historyBtn) historyBtn.onclick = () => document.querySelector('#tabs button[data-tab="history"]')?.click();

    const modalBg = $("#modalBg");
    const modalCloseBtn = $("#modalCloseBtn");
    if(modalCloseBtn) modalCloseBtn.onclick = closeModal;
    if(modalBg){
      modalBg.addEventListener("click", (e)=>{
        if(e.target === modalBg) return;
      });
    }
    window.addEventListener("keydown", (e)=>{
      if(e.key === "Escape" && modalBg && modalBg.style.display === "flex") closeModal();
    });

    // first render panels + inject settings inputs ids
    renderSettings();
    renderUsers();
    renderHistory();

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