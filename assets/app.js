(() => {
  const $ = (s) => document.querySelector(s);

  const state = {
    lang: localStorage.getItem("sv_lang") || "hu",
    active: "all",
    productsDoc: { categories: [], products: [], popups: [], _meta: null },
    sales: [],
    salesFresh: false,
    search: "",
    etagProducts: "",
    etagSales: "",
    featuredByCat: new Map(), // categoryId -> productId

    // anti-flicker / anti-stale overwrites
    docRev: 0,
    docHash: "",
    salesHash: "",
    lastLiveTs: 0,

    // cart (client)
    cart: new Map(),
    cartOpen: false,
    reservedByProduct: new Map(),
    reservations: [],
    reservationsHash: "",
    reservationsFresh: false,
    reserveApi: "",
    favorites: new Set(),
    secretUnlocked: false,
    secretExpiresAt: 0,
    secretExpiryTimer: null,
    searchSeq: 0,
  };

  const SECRET_SESSION_LS_KEY = "sv_secret_session_v1";

  const isAdminMode = (()=>{
    try{ return new URLSearchParams(location.search).get("sv_admin") === "1"; }catch{ return false; }
  })();

  const UI = {
    all: { hu: "Összes termék", en: "All products" },
    soon: { hu: "Hamarosan", en: "Coming soon" },
    stock: { hu: "Készlet", en: "Stock" },
    pcs: { hu: "db", en: "pcs" },
    out: { hu: "Elfogyott", en: "Sold out" },
    hot: { hu: "Felkapott", en: "Trending" },
    newAvail: { hu: "Új termékek elérhetőek", en: "New products available" },
    understood: { hu: "Értettem", en: "Got it" },
    skipAll: { hu: "Összes átugrása", en: "Skip all" },
    dontShow: { hu: "Ne mutasd többször", en: "Don't show again" },
    expected: { hu: "Várható", en: "Expected" },
    favorites: { hu: "Kedvencek", en: "Favorites" },
    addFav: { hu: "Kedvenc", en: "Favorite" },
    removeFav: { hu: "Kedvenc törlése", en: "Remove favorite" }
  };

  const t = (k) => (UI[k] ? UI[k].hu : k);

  const locale = () => "hu";

  const norm = (s) =>
    (s || "")
      .toString()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  function naturalCompare(a, b){
    return String(a ?? "").localeCompare(String(b ?? ""), locale(), { numeric: true, sensitivity: "base" });
  }

  function loadFavorites(){
    try{
      const raw = localStorage.getItem(FAVORITES_LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set((Array.isArray(arr) ? arr : []).map(x => String(x || "")).filter(Boolean));
    }catch{ return new Set(); }
  }

  function saveFavorites(){
    try{ localStorage.setItem(FAVORITES_LS_KEY, JSON.stringify([...state.favorites])); }catch{}
  }

  function isFavorite(productId){
    return state.favorites.has(String(productId || ""));
  }

  function toggleFavorite(productId){
    const pid = String(productId || "");
    if(!pid) return;
    const p = (state.productsDoc.products || []).find(x => String(x?.id || "") === pid);
    if(!canInteractProduct(p)){
      showToast("Ismeretlen hiba.");
      return;
    }
    const wasFav = state.favorites.has(pid);
    if(wasFav) state.favorites.delete(pid);
    else state.favorites.add(pid);
    saveFavorites();
    renderNav();
    renderGrid();

    if(!wasFav){
      const p = (state.productsDoc.products || []).find(x => String(x?.id || "") === pid);
      if(p){
        const nm = getName(p);
        const fl = getFlavor(p);
        showToast(`${nm}${fl ? " • " + fl : ""} hozzáadva a kedvencek közé`);
      }else{
        showToast(`Hozzáadva a kedvencek közé`);
      }
    }
  }


  /* ----------------- Cart (client) ----------------- */
  function escHtml(s){
    return String(s ?? "")
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/\"/g,"&quot;")
      .replace(/'/g,"&#39;");
  }

  const CART_LS_KEY = "sv_cart_v1";
  const FAVORITES_LS_KEY = "sv_favorites_v1";

  function sha256Hex(text){
    const str = String(text ?? "");
    if(!(globalThis.crypto && crypto.subtle && globalThis.TextEncoder)){
      return Promise.resolve(norm(str));
    }
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then((buf) => {
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }).catch(() => norm(str));
  }

  function getSecretCfg(){
    const meta = state.productsDoc && state.productsDoc._meta && typeof state.productsDoc._meta === "object"
      ? state.productsDoc._meta
      : {};
    const raw = meta.secretAccess && typeof meta.secretAccess === "object" ? meta.secretAccess : {};
    const durationMs = Math.max(60_000, Number(raw.durationMs || 3_600_000) || 3_600_000);
    return {
      passwordHash: String(raw.passwordHash || "").trim().toLowerCase(),
      durationMs
    };
  }

  function categoryById(categoryId){
    return (state.productsDoc.categories || []).find(c => String(c && c.id || "") === String(categoryId || "")) || null;
  }

  function isSecretCategory(category){
    return !!(category && category.secret === true);
  }

  function isSecretProduct(product){
    if(!product) return false;
    if(product.secret === true) return true;
    return isSecretCategory(categoryById(product.categoryId));
  }

  function isSecretModeActive(){
    if(isAdminMode) return true;
    return !!state.secretUnlocked && Number(state.secretExpiresAt || 0) > Date.now();
  }

  function canSeeProduct(product){
    if(isAdminMode) return true;
    return isSecretModeActive() ? isSecretProduct(product) : !isSecretProduct(product);
  }

  function canInteractProduct(product){
    if(isAdminMode) return true;
    return isSecretModeActive() && isSecretProduct(product);
  }

  function getRenderableCartEntries(){
    const products = new Map((state.productsDoc.products || []).filter(p => p && p.id).map(p => [String(p.id), p]));
    const out = [];
    for(const [pid, qty0] of state.cart.entries()){
      const p = products.get(String(pid));
      if(!p) continue;
      if(!canInteractProduct(p)) continue;
      const qty = Math.max(0, Number(qty0 || 0) || 0);
      if(!qty) continue;
      out.push([String(pid), qty, p]);
    }
    return out;
  }

  function cartQtyVisible(productId){
    const pid = String(productId || "");
    let qty = 0;
    for(const [id, q] of getRenderableCartEntries()){
      if(id === pid) qty += Number(q || 0);
    }
    return qty;
  }

  function clearSecretExpiryTimer(){
    try{
      if(state.secretExpiryTimer) clearTimeout(state.secretExpiryTimer);
    }catch{}
    state.secretExpiryTimer = null;
  }

  function persistSecretSession(expiresAt){
    const cfg = getSecretCfg();
    try{
      localStorage.setItem(SECRET_SESSION_LS_KEY, JSON.stringify({
        expiresAt: Number(expiresAt || 0) || 0,
        passwordHash: cfg.passwordHash || ""
      }));
    }catch{}
  }

  function normalizeActiveView(){
    const ids = new Set(orderedCategories().map(c => String(c.id)));
    if(!ids.has(String(state.active || ""))){
      state.active = "all";
    }
  }

  function deactivateSecretMode({ rerender=true } = {}){
    const had = state.secretUnlocked || state.secretExpiresAt;
    clearSecretExpiryTimer();
    state.secretUnlocked = false;
    state.secretExpiresAt = 0;
    state.search = "";
    try{
      localStorage.removeItem(SECRET_SESSION_LS_KEY);
    }catch{}
    const searchEl = $("#search");
    if(searchEl) searchEl.value = "";
    if(had && rerender){
      normalizeActiveView();
      renderNav();
      renderGrid();
      updateCartBadge();
      if(state.cartOpen) renderCart();
    }
  }

  function scheduleSecretExpiry(){
    clearSecretExpiryTimer();
    if(isAdminMode) return;
    const ms = Number(state.secretExpiresAt || 0) - Date.now();
    if(ms <= 0){
      deactivateSecretMode({ rerender:true });
      return;
    }
    state.secretExpiryTimer = setTimeout(() => {
      deactivateSecretMode({ rerender:true });
    }, ms + 20);
  }

  function activateSecretMode(durationMs){
    if(isAdminMode) return;
    const ttl = Math.max(60_000, Number(durationMs || getSecretCfg().durationMs || 3_600_000) || 3_600_000);
    state.secretUnlocked = true;
    state.secretExpiresAt = Date.now() + ttl;
    persistSecretSession(state.secretExpiresAt);
    scheduleSecretExpiry();
    state.search = "";
    const searchEl = $("#search");
    if(searchEl) searchEl.value = "";
    normalizeActiveView();
    renderNav();
    renderGrid();
    updateCartBadge();
    if(state.cartOpen) renderCart();
  }

  function syncSecretSessionWithDoc({ rerender=false } = {}){
    if(isAdminMode) return;
    const cfg = getSecretCfg();
    if(!cfg.passwordHash){
      deactivateSecretMode({ rerender });
      return;
    }
    let raw = null;
    try{
      raw = JSON.parse(localStorage.getItem(SECRET_SESSION_LS_KEY) || "null");
    }catch{
      raw = null;
    }
    const expiresAt = Number(raw && raw.expiresAt || 0) || 0;
    const passwordHash = String(raw && raw.passwordHash || "").trim().toLowerCase();
    if(expiresAt > Date.now() && passwordHash && passwordHash === cfg.passwordHash){
      state.secretUnlocked = true;
      state.secretExpiresAt = expiresAt;
      scheduleSecretExpiry();
      if(rerender){
        normalizeActiveView();
        renderNav();
        renderGrid();
        updateCartBadge();
        if(state.cartOpen) renderCart();
      }
      return;
    }
    deactivateSecretMode({ rerender });
  }

  async function tryUnlockFromSearchValue(rawValue){
    if(isAdminMode) return false;
    const cfg = getSecretCfg();
    const candidate = String(rawValue || "").trim();
    if(!candidate || !cfg.passwordHash) return false;
    const hash = await sha256Hex(candidate);
    if(String(hash || "").trim().toLowerCase() !== cfg.passwordHash) return false;
    activateSecretMode(cfg.durationMs);
    return true;
  }

  function loadCart(){
    try{
      const raw = localStorage.getItem(CART_LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      const m = new Map();
      for(const it of (Array.isArray(arr) ? arr : [])){
        const pid = String(it?.productId || "");
        const qty = Math.max(0, Number(it?.qty || 0));
        if(pid && qty) m.set(pid, qty);
      }
      return m;
    }catch{ return new Map(); }
  }

  function saveCart(){
    try{
      const arr = [...state.cart.entries()].map(([productId, qty]) => ({ productId, qty }));
      localStorage.setItem(CART_LS_KEY, JSON.stringify(arr));
    }catch{}
  }

  function cartQty(productId){
    return Number(state.cart.get(String(productId)) || 0);
  }

  function cartCount(){
    let n = 0;
    for(const [, qty] of getRenderableCartEntries()) n += Number(qty || 0);
    return n;
  }

  function reservedQty(productId){
    return Number(state.reservedByProduct.get(String(productId)) || 0);
  }

  function ensureCartUI(){
    if(document.querySelector("#svCartBtn")) return;

    const topbar = document.querySelector(".topbar");
    const search = $("#search");

    if(topbar && search){
      const right = document.createElement("div");
      right.className = "topbar-right";
      topbar.appendChild(right);
      right.appendChild(search);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "svCartBtn";
      btn.className = "cart-btn";
      btn.innerHTML = `
        <span class="cart-ico" aria-hidden="true">🛒</span>
        <span class="cart-label">Kosár</span>
        <span class="cart-badge" id="svCartBadge">0</span>
      `;
      btn.addEventListener("click", (e)=>{
        e.preventDefault();
        e.stopPropagation();
        toggleCart(true);
      });

      document.body.appendChild(btn);
    }

    // toast (fixed, no layout shift)
    const toast = document.createElement("div");
    toast.id = "svToast";
    toast.className = "sv-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);

    // cart overlay
    const overlay = document.createElement("div");
    overlay.id = "svCartOverlay";
    overlay.className = "cart-overlay";
    overlay.innerHTML = `
      <div class="cart-panel" role="dialog" aria-modal="true" aria-label="Kosár">
        <div class="cart-head">
          <div class="cart-title">Kosár</div>
          <button type="button" class="cart-close" id="svCartClose">✕</button>
        </div>
        <div class="cart-body">
          <div id="svCartItems"></div>
          <div id="svCartEmpty" class="small-muted" style="display:none;margin-top:10px;">A kosár üres.</div>
          <div id=\"svCartTotals\" class=\"cart-totals\" style=\"display:none;\"></div>
        </div>
        <div class="cart-foot">
          <div class="cart-foot-actions">
            <button type="button" class="ghost" id="svCartClearBtn" disabled>Kosár ürítése</button>
            <button type="button" class="cart-action-btn" id="svCartActionBtn" disabled>${isAdminMode ? "Eladás rögzítése" : "Foglalás"}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e)=>{
      if(e.target === overlay) toggleCart(false);
    });
    document.querySelector("#svCartClose")?.addEventListener("click", (e)=>{
      e.preventDefault(); e.stopPropagation();
      toggleCart(false);
    });

    document.querySelector("#svCartActionBtn")?.addEventListener("click", (e)=>{
      e.preventDefault(); e.stopPropagation();
      if(!cartCount()) return;
      if(isAdminMode) return adminSaleFromCart();
      return reservationFromCart();
    });

    document.querySelector("#svCartClearBtn")?.addEventListener("click", (e)=>{
      e.preventDefault(); e.stopPropagation();
      clearCartAll({ toast: true });
    });

    document.addEventListener("keydown", (e)=>{
      if(e.key === "Escape" && state.cartOpen) toggleCart(false);
    });

    updateCartBadge();
    updateCartActionBtn();
  }

  function updateCartBadge(){
    const b = document.querySelector("#svCartBadge");
    if(b) b.textContent = String(cartCount());
    updateCartActionBtn();
  }

  function updateCartActionBtn(){
    const total = cartCount();
    const btn = document.querySelector("#svCartActionBtn");
    if(btn){
      btn.textContent = isAdminMode ? "Eladás rögzítése" : "Foglalás";
      btn.disabled = total <= 0;
    }
    const clearBtn = document.querySelector("#svCartClearBtn");
    if(clearBtn) clearBtn.disabled = total <= 0;
  }

  function clearCartAll({ toast=false } = {}){
    if(cartCount() <= 0) return;
    state.cart = new Map();
    saveCart();
    updateCartBadge();
    if(state.cartOpen) renderCart();
    renderGrid();
    if(toast) showToast("Kosár ürítve.");
  }

  let toastTimer = null;
  function showToast(text){
    const el = document.querySelector("#svToast");
    if(!el) return;
    el.textContent = String(text || "");
    el.classList.add("show");
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(()=> el.classList.remove("show"), 3400);
  }

  function toggleCart(forceOpen){
    const overlay = document.querySelector("#svCartOverlay");
    if(!overlay) return;
    const open = (typeof forceOpen === "boolean") ? forceOpen : !state.cartOpen;
    state.cartOpen = open;
    overlay.style.display = open ? "block" : "none";
    if(open) renderCart();
  }

  function addToCart(p){
    try{
      if(!p) return;
      const pid = String(p.id || "");
      if(!pid) return;
      if(!canInteractProduct(p)){
        showToast("Ismeretlen hiba.");
        return;
      }
      if(isOut(p) || isSoon(p)) return;

      const baseStock = Math.max(0, Number(p.stock || 0));
      const available = Math.max(0, baseStock - reservedQty(pid));
      const cur = cartQty(pid);

      if(available <= 0){
        showToast("Nincs készleten.");
        return;
      }
      if(cur >= available){
        showToast("Nincs több készleten ebből a termékből.");
        return;
      }

      state.cart.set(pid, cur + 1);
      saveCart();
      updateCartBadge();
      if(state.cartOpen) renderCart();

      const nm = getName(p);
      const fl = getFlavor(p);
      showToast(`${nm}${fl ? " • " + fl : ""} kosárba helyezve`);
    }catch{}
  }

  function setCartQty(productId, nextQty){
    const pid = String(productId || "");
    const q = Math.max(0, Number(nextQty || 0));
    if(!pid) return;
    if(q <= 0) state.cart.delete(pid);
    else state.cart.set(pid, q);
    saveCart();
    updateCartBadge();
    if(state.cartOpen) renderCart();
  }

  function confirmRemove(productId, label){
    const panel = document.querySelector("#svCartOverlay .cart-panel");
    if(!panel) return;

    const m = document.createElement("div");
    m.className = "cart-confirm";
    m.innerHTML = `
      <div class="cart-confirm-card">
        <div class="cart-confirm-title">Biztos szeretnéd törölni a "${escHtml(label)}" terméket?</div>
        <div class="cart-confirm-actions">
          <button type="button" class="ghost" id="svNo">Mégse</button>
          <button type="button" class="danger" id="svYes">Igen</button>
        </div>
      </div>
    `;
    panel.appendChild(m);

    const close = () => { try{ m.remove(); }catch{} };
    m.querySelector("#svNo")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); close(); });
    m.querySelector("#svYes")?.addEventListener("click", (e)=>{
      e.preventDefault(); e.stopPropagation();
      setCartQty(productId, 0);
      close();
    });
  }

  function renderCart(){
    const wrap = document.querySelector("#svCartItems");
    const empty = document.querySelector("#svCartEmpty");
    const totalsEl = document.querySelector("#svCartTotals");
    if(!wrap || !empty) return;

    const products = (state.productsDoc.products || []).filter(p => p && p.id);
    const productMap = new Map(products.map(p => [String(p.id), p]));
    const rows = [];
    let totalSum = 0;

    for(const [pid, qty0, p] of getRenderableCartEntries()){
      if(!p) continue;
      const qty = Math.max(1, Number(qty0||0)||0);

      const nm = getName(p);
      const fl = getFlavor(p);
      const label = `${nm}${fl ? ", " + fl : ""}`;

      const unit = Number(effectivePrice(p) || 0);
      const lineTotal = unit * qty;
      totalSum += lineTotal;

      const img = (p.image || "").trim();
      const imgTag = img
        ? `<img class="cart-item-img" src="${escHtml(img)}" alt="${escHtml(label)}" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="cart-item-img ph" aria-hidden="true"></div>`;

      rows.push(`
        <div class="cart-item">
          ${imgTag}
          <div class="cart-item-main">
            <div class="cart-item-name">${escHtml(nm)}</div>
            <div class="cart-item-sub">${escHtml(fl || "")} • Darabár: ${fmtFt(unit)} • Össz: <b>${fmtFt(lineTotal)}</b></div>
          </div>
          <div class="cart-qty">
            <button type="button" class="qty-btn" data-minus="${escHtml(pid)}">−</button>
            <div class="qty-num">${qty}</div>
            <button type="button" class="qty-btn" data-plus="${escHtml(pid)}">+</button>
          </div>
        </div>
      `);
    }

    wrap.innerHTML = rows.join("");
    empty.style.display = rows.length ? "none" : "block";

    if(totalsEl){
      if(rows.length){
        totalsEl.style.display = "flex";
        totalsEl.innerHTML = `<span class="muted">Végösszeg</span><b>${fmtFt(totalSum)}</b>`;
      }else{
        totalsEl.style.display = "none";
        totalsEl.innerHTML = "";
      }
    }

    updateCartActionBtn();

    wrap.querySelectorAll("button[data-plus]").forEach(b=>{
      b.addEventListener("click", (e)=>{
        e.preventDefault(); e.stopPropagation();
        const pid = b.dataset.plus;
        const p = productMap.get(String(pid));
        if(!p) return;
        addToCart(p);
      });
    });

    wrap.querySelectorAll("button[data-minus]").forEach(b=>{
      b.addEventListener("click", (e)=>{
        e.preventDefault(); e.stopPropagation();
        const pid = b.dataset.minus;
        const cur = cartQty(pid);
        const p = productMap.get(String(pid));
        const nm = p ? getName(p) : "Termék";
        const fl = p ? getFlavor(p) : "";
        const label = `${nm}${fl ? ", " + fl : ""}`;
        if(cur <= 1){
          confirmRemove(pid, label);
          return;
        }
        setCartQty(pid, cur - 1);
      });
    });
  }


  /* ----------------- Cart actions ----------------- */
  function adminSaleFromCart(){
    try{
      const items = getRenderableCartEntries().map(([productId, qty]) => ({ productId: String(productId), qty: Number(qty||0) })).filter(it => it.productId && it.qty > 0);
      if(!items.length) return;
      // Parent admin page will open the real sale modal + save/rollback logic.
      if(window.parent && window.parent !== window){
        window.parent.postMessage({ type:"sv_admin_cart_sale", items }, "*");
        showToast("Tételek átadva az eladás rögzítéséhez.");
        toggleCart(false);
      }else{
        showToast("Admin mód: nincs parent ablak.");
      }
    }catch{}
  }

  function reservationFromCart(){
    const panel = document.querySelector("#svCartOverlay .cart-panel");
    if(!panel) return;

    const products = (state.productsDoc.products || []).filter(p => p && p.id);
    const productMap = new Map(products.map(p => [String(p.id), p]));

    const items = getRenderableCartEntries().map(([pid, qty0]) => {
      const p = productMap.get(String(pid));
      if(!p || !canInteractProduct(p)) return null;
      const qty = Math.max(1, Number(qty0||0)||0);
      const unit = Number(effectivePrice(p) || 0);
      return {
        productId: String(pid),
        qty,
        unitPrice: unit,
        name: getName(p),
        flavor: getFlavor(p),
        image: (p.image || "").trim()
      };
    }).filter(Boolean);

    if(!items.length) return;

    const totalQty = items.reduce((a,it)=>a+it.qty,0);
    const totalSum = items.reduce((a,it)=>a+(it.unitPrice*it.qty),0);

    const lines = items.map(it => {
      const label = `${it.name}${it.flavor ? " • " + it.flavor : ""}`;
      const lineTotal = it.unitPrice * it.qty;
      const img = (it.image || "").trim();
      const thumb = img
        ? `<img class="res-sum-thumb" src="${escHtml(img)}" alt="">`
        : `<div class="res-sum-thumb ph">SV</div>`;

      return `
        <div class="res-sum-item">
          ${thumb}
          <div class="res-sum-mid">
            <div class="res-sum-name">${escHtml(label)}</div>
            <div class="res-sum-meta">
              <span>Egységár: <b>${fmtFt(it.unitPrice)}</b></span>
              <span>Db: <b>${it.qty}</b></span>
            </div>
          </div>
          <div class="res-sum-right">
            <div class="line">${fmtFt(lineTotal)}</div>
            <div class="unit small-muted">Sorösszeg</div>
          </div>
        </div>
      `;
    }).join("");

    const m = document.createElement("div");
    m.className = "cart-confirm";
    m.innerHTML = `
      <div class="cart-confirm-card">
        <div class="cart-confirm-title">Foglalás összegzés</div>
        <div class="small-muted" style="margin-top:6px;">${totalQty} db • ${fmtFt(totalSum)}</div>
        <div class="res-sum-list">${lines}</div>
        <div style="margin-top:10px;display:flex;justify-content:space-between;gap:10px;">
          <span class="muted">Végösszeg</span>
          <b>${fmtFt(totalSum)}</b>
        </div>
        <div class="small-muted" style="margin-top:10px;">A foglalás 2 nap múlva automatikusan lejár!</div>
        <div class="cart-confirm-actions">
          <button type="button" class="ghost" id="svResNo">Mégse</button>
          <button type="button" class="primary" id="svResYes">Megerősítés</button>
        </div>
      </div>
    `;
    panel.appendChild(m);

    const btnYes = m.querySelector("#svResYes");
    const btnNo = m.querySelector("#svResNo");

    const close = () => { try{ m.remove(); }catch{} };
    btnNo?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); close(); });


    function makeId(){
      return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    }

    function genPublicCode(){
      const used = new Set((state.reservations || []).map(r=>String(r.publicCode||"")));
      for(let i=0;i<60;i++){
        const code = String(Math.floor(100 + Math.random()*900));
        if(!used.has(code)) return code;
      }
      return String(Math.floor(100 + Math.random()*900));
    }


    // ✅ Token NÉLKÜLI foglalás mentés: Foglalás API (Cloudflare Worker / backend)
    function getReserveApiUrl(){
      try{
        const api = String(state.reserveApi || localStorage.getItem("sv_res_api") || "").trim();
        return api.replace(/\/+$/,'');
      }catch{ return ""; }
    }

    async function callReserveApi(action, payload){
      const api = getReserveApiUrl();
      if(!api){
        const e = new Error("NO_RES_API");
        e.code = "NO_RES_API";
        throw e;
      }
      const r = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(payload||{}) })
      });
      const txt = await r.text();
      let j = null;
      try{ j = txt ? JSON.parse(txt) : null; }catch{ j = { message: txt }; }
      if(!r.ok || (j && j.ok === false)){
        const e = new Error(j?.message || `Foglalás mentési hiba (${r.status})`);
        e.status = r.status;
        e.data = j;
        throw e;
      }
      return j;
    }

    async function createReservationViaApi(reservation){
      return await callReserveApi("reservation.create", { reservation });
    }

    async function updateReservationViaApi(id, reservation){
      return await callReserveApi("reservation.update", { id, reservation });
    }

    function getWriteCfg(){
      try{
        const token = String(localStorage.getItem('sv_token') || '').trim();
        let owner = String(localStorage.getItem('sv_owner') || '').trim();
        let repo  = String(localStorage.getItem('sv_repo') || '').trim();
        let branch = String(localStorage.getItem('sv_branch') || '').trim();

        if(!owner || !repo){
          try{
            const src = JSON.parse(localStorage.getItem('sv_source') || 'null');
            if(src && src.owner && src.repo){
              owner = String(src.owner).trim();
              repo = String(src.repo).trim();
              branch = String(src.branch || 'main').trim();
            }
          }catch{}
        }
        if(!branch) branch = 'main';
        if(!token || !owner || !repo) return null;
        return { token, owner, repo, branch };
      }catch{ return null; }
    }


    async function ensureWriteCfgInteractive(){
      let cfg = getWriteCfg();
      if(cfg) return cfg;

      return await new Promise((resolve) => {
        const ov = document.createElement("div");
        ov.className = "cart-confirm";
        ov.innerHTML = `
          <div class="cart-confirm-card">
            <div class="cart-confirm-title">Mentéshez beállítás kell</div>
            <div class="small-muted" style="margin-top:6px;">Telefonon is ugyanúgy kell a GitHub token (admin). Ha van Sync link, ide be tudod másolni.</div>

            <div style="margin-top:10px;">
              <div class="small-muted" style="margin-bottom:6px;">Sync link (opcionális)</div>
              <input id="svSyncLink" class="picker-search" placeholder="https://...">
            </div>

            <div style="margin-top:10px;">
              <div class="small-muted" style="margin-bottom:6px;">GitHub token</div>
              <input id="svTokenInput" class="picker-search" type="password" placeholder="ghp_..." autocomplete="off">
            </div>

            <div class="small-muted" id="svCfgErr" style="margin-top:10px;color:rgba(255,77,109,.95);display:none;"></div>

            <div class="cart-confirm-actions" style="margin-top:14px;justify-content:space-between;">
              <button type="button" class="ghost" id="svCfgCancel">Mégse</button>
              <button type="button" class="primary" id="svCfgSave">Mentés</button>
            </div>
          </div>
        `;
        panel.appendChild(ov);

        const errEl = ov.querySelector("#svCfgErr");
        const showErr = (txt) => {
          if(!errEl) return;
          errEl.textContent = String(txt || "Hiányzó adatok.");
          errEl.style.display = "block";
        };

        const cleanup = () => { try{ ov.remove(); }catch{} };

        ov.querySelector("#svCfgCancel")?.addEventListener("click", (e)=>{
          e.preventDefault(); e.stopPropagation();
          cleanup();
          resolve(null);
        });

        ov.querySelector("#svCfgSave")?.addEventListener("click", (e)=>{
          e.preventDefault(); e.stopPropagation();

          try{
            const link = String(ov.querySelector("#svSyncLink")?.value || "").trim();
            if(link){
              try{
                const u = new URL(link);
                const sp = u.searchParams;
                const owner = sp.get("sv_owner") || sp.get("owner") || "";
                const repo  = sp.get("sv_repo")  || sp.get("repo")  || "";
                const branch= sp.get("sv_branch")|| sp.get("branch")|| "main";
                if(owner) localStorage.setItem("sv_owner", owner);
                if(repo) localStorage.setItem("sv_repo", repo);
                if(branch) localStorage.setItem("sv_branch", branch);
                try{
                  if(owner && repo){
                    localStorage.setItem("sv_source", JSON.stringify({ owner, repo, branch }));
                  }
                }catch{}
              }catch{}
            }

            const token = String(ov.querySelector("#svTokenInput")?.value || "").trim();
            if(token) localStorage.setItem("sv_token", token);

            cfg = getWriteCfg();
            if(!cfg){
              showErr("Add meg a tokent és/vagy a Sync linket (owner/repo).");
              return;
            }

            cleanup();
            resolve(cfg);
          }catch(err){
            showErr("Hiba a beállítás mentésekor.");
          }
        });
      });
    }

    function b64encode(str){
      return btoa(unescape(encodeURIComponent(str)));
    }

    async function ghReq(cfg, method, url, body){
      const headers = {
        'Accept':'application/vnd.github+json',
        'Authorization':`Bearer ${cfg.token}`,
        'X-GitHub-Api-Version':'2022-11-28'
      };
      if(body) headers['Content-Type']='application/json';
      const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const txt = await r.text();
      let j = null;
      try{ j = txt ? JSON.parse(txt) : null; }catch{ j = { message: txt }; }
      if(!r.ok){
        const err = new Error(j?.message || `GitHub hiba (${r.status})`);
        err.status = r.status;
        err.data = j;
        throw err;
      }
      return j;
    }

    async function appendReservationToGithub(cfg, reservation){
      const path = 'data/reservations.json';
      const base = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
      let lastErr = null;

      for(let attempt=0; attempt<3; attempt++){
        try{
          let sha = null;
          let data = [];

          try{
            const cur = await ghReq(cfg, 'GET', `${base}?ref=${encodeURIComponent(cfg.branch)}`);
            sha = cur.sha || null;
            const raw = cur && cur.content ? atob(String(cur.content).replace(/\n/g,'')) : '[]';
            const parsed = JSON.parse(raw || '[]');
            data = Array.isArray(parsed) ? parsed : [];
          }catch(e){
            if(Number(e.status||0) === 404){
              sha = null;
              data = [];
            }else{
              throw e;
            }
          }

          data.push(reservation);
          const content = JSON.stringify(data, null, 2);

          const body = {
            message: 'Add reservation',
            content: b64encode(content),
            branch: cfg.branch
          };
          if(sha) body.sha = sha;

          await ghReq(cfg, 'PUT', base, body);
          return true;
        }catch(e){
          lastErr = e;
          await new Promise(r=>setTimeout(r, 250 + Math.random()*250));
        }
      }
      throw lastErr || new Error('Mentés hiba');
    }

    async function finalizeReservation(){
      const id = makeId();
      const publicCode = genPublicCode();
      const createdAt = Date.now();
      const expiresAt = createdAt + 48*60*60*1000;

      const reservation = {
        id,
        publicCode,
        createdAt,
        expiresAt,
        confirmed: false,
        editCount: 0,
        recorded: false,
        deleted: false,
        lastAction: 'Új foglalás érkezett',
        items: items.map(it => ({ productId: it.productId, qty: it.qty, unitPrice: it.unitPrice }))
      };

      const apiUrl = getReserveApiUrl();
      if(apiUrl){
        await createReservationViaApi(reservation);
      }else{
        const cfg = await ensureWriteCfgInteractive();
        if(!cfg){
          const e = new Error('NO_RES_API');
          e.code = 'NO_RES_API';
          throw e;
        }
        await appendReservationToGithub(cfg, reservation);
      }


      try{
        state.reservations = [...(state.reservations||[]), reservation];
        state.reservationsHash = '';
        rebuildReservedMap();
      }catch{}

      state.cart = new Map();
      saveCart();
      updateCartBadge();
      renderCart();
      renderGrid();

      const card = m.querySelector('.cart-confirm-card');
      if(card){
        card.innerHTML = `
          <div class="cart-confirm-title">Foglalás leadva ✅</div>
          <div class="res-code" style="margin-top:10px;text-align:center;font-weight:950;font-size:34px;letter-spacing:.14em;">${escHtml(publicCode)}</div>
          <div class="small-muted" style="margin-top:10px;">A foglalás 2 nap múlva automatikusan lejár!</div>
          <div class="cart-confirm-actions" style="margin-top:14px;justify-content:space-between;">
            <button type="button" class="ghost" id="svCopyCode">Kód másolása</button>
            <button type="button" class="primary" id="svCloseDone">Bezárás</button>
          </div>
        `;

        card.querySelector('#svCopyCode')?.addEventListener('click', async (e)=>{
          e.preventDefault(); e.stopPropagation();
          try{
            await navigator.clipboard.writeText(String(publicCode));
            showToast('Kód másolva ✅');
          }catch{
            showToast(String(publicCode));
          }
        });
        card.querySelector('#svCloseDone')?.addEventListener('click', (e)=>{
          e.preventDefault(); e.stopPropagation();
          close();
          toggleCart(false);
        });
      }
    }

    btnYes?.addEventListener('click', async (e)=>{
      e.preventDefault(); e.stopPropagation();
      if(btnYes) btnYes.disabled = true;
      try{
        await finalizeReservation();
      }catch(err){
        console.error(err);
        const code = String(err?.code || err?.message || '');
        if(code === 'NO_RES_API'){
          showToast('Foglalás most nem menthető: nincs foglalás-szinkron beállítva.');
        }else{
          showToast('Foglalás mentése nem sikerült.');
        }
        try{ if(btnYes) btnYes.disabled = false; }catch{}
      }
    });
  }


  function catLabel(c) {
    return (c && (c.label_hu || c.label_en || c.id)) || "";
  }

  function getName(p) {
    return (p && (p.name_hu || p.name_en || p.name)) || "";
  }
  function getFlavor(p) {
    if (!p) return "";
    return state.lang === "en"
      ? (p.flavor_en || p.flavor_hu || p.flavor || "")
      : (p.flavor_hu || p.flavor_en || p.flavor || "");
  }

  // ✅ Csak hónap: YYYY-MM -> "December" (évszám nélkül)
  function formatMonth(monthStr) {
    if (!monthStr) return "";
    try {
      const [, month] = String(monthStr).split("-");
      if (!month) return String(monthStr);

      const monthNum = parseInt(month, 10);
      if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) return String(monthStr);

      const monthNamesHU = ["Január", "Február", "Március", "Április", "Május", "Június",
        "Július", "Augusztus", "Szeptember", "Október", "November", "December"];

      return monthNamesHU[monthNum - 1];
    } catch {
      return String(monthStr);
    }
  }

  function effectivePrice(p) {
    const price = p && p.price;
    if (price !== null && price !== undefined && price !== "" && Number(price) > 0) return Number(price);
    const c = (state.productsDoc.categories || []).find((x) => String(x.id) === String(p.categoryId));
    const bp = c ? Number(c.basePrice || 0) : 0;
    return Number.isFinite(bp) ? bp : 0;
  }

  function isOut(p) {
    const st = (p && p.status) || "ok";
    const stock = Math.max(0, Number(p && p.stock ? p.stock : 0));
    return st === "out" || stock <= 0;
  }

  function isSoon(p) {
    return ((p && p.status) || "ok") === "soon";
  }

  /* ----------------- Source resolving (RAW preferált, custom domainen is) ----------------- */
  let source = null; // {owner, repo, branch}

  async function validateSource(s){
    try{
      if(!s || !s.owner || !s.repo || !s.branch) return false;
      const testUrl = `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${s.branch}/data/products.json?_=${Date.now()}`;
      const r = await fetch(testUrl, { cache: "no-store" });
      return r.ok;
    }catch{ return false; }
  }

  function getOwnerRepoFromUrl() {
    const host = location.hostname;
    if (!host.endsWith(".github.io")) return null;
    const owner = host.replace(".github.io", "");
    const parts = location.pathname.split("/").filter(Boolean);
    const repo = parts.length ? parts[0] : null;
    if (!repo) return null;
    return { owner, repo };
  }

  function getOwnerRepoCfg() {
    const owner = (localStorage.getItem("sv_owner") || "").trim();
    const repo = (localStorage.getItem("sv_repo") || "").trim();
    const branch = (localStorage.getItem("sv_branch") || "").trim();
    if (!owner || !repo) return null;
    return { owner, repo, branch: branch || null };
  }

  function applySyncParams(){
    try{
      const u = new URL(location.href);
      const o = (u.searchParams.get("sv_owner")||"").trim();
      const r = (u.searchParams.get("sv_repo")||"").trim();
      const b = (u.searchParams.get("sv_branch")||"").trim();
      if(o && r){
        localStorage.setItem("sv_owner", o);
        localStorage.setItem("sv_repo", r);
        if(b) localStorage.setItem("sv_branch", b);
        const src = { owner:o, repo:r, branch: b || "main" };
        localStorage.setItem("sv_source", JSON.stringify(src));
        u.searchParams.delete("sv_owner");
        u.searchParams.delete("sv_repo");
        u.searchParams.delete("sv_branch");
        history.replaceState({}, "", u.pathname + (u.search ? u.search : "") + u.hash);
      }
    }catch{}
  }

  async function resolveSource() {
    if (source) return source;

    try {
      const cached = JSON.parse(localStorage.getItem("sv_source") || "null");
      if (cached && cached.owner && cached.repo && cached.branch) {
        try{
          const api = String(cached.reserveApi || cached.reserve_api || cached.reservationsApi || cached.reservations_api || cached.resApi || cached.res_api || localStorage.getItem("sv_res_api") || "").trim();
          if(api){
            state.reserveApi = api;
            try{ localStorage.setItem("sv_res_api", api); }catch{}
          }
        }catch{}
        const ok = await validateSource(cached);
        if (ok) {
          source = { owner: cached.owner, repo: cached.repo, branch: cached.branch };
          return source;
        }
        try { localStorage.removeItem("sv_source"); } catch {}
      }
    } catch {}

    try {
      const r = await fetch(`data/sv_source.json?_=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.owner && j.repo) {
          const br = String(j.branch || j.ref || "main").trim();
          source = { owner: String(j.owner).trim(), repo: String(j.repo).trim(), branch: br };
          // ✅ Foglalás API (token nélküli mentéshez)
          try{
            const api = String(j.reserveApi || j.reserve_api || j.reservationsApi || j.reservations_api || j.resApi || j.res_api || "").trim();
            if(api){
              state.reserveApi = api;
              try{ localStorage.setItem("sv_res_api", api); }catch{}
            }
          }catch{}
          try { localStorage.setItem("sv_source", JSON.stringify({ ...source, reserveApi: state.reserveApi || "" })); } catch {}
          return source;
        }
      }
    } catch {}

    const or = getOwnerRepoFromUrl() || getOwnerRepoCfg();
    if (!or) return null;

    const branches = [or.branch, "main", "master", "gh-pages"]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);

    for (const br of branches) {
      const testUrl = `https://raw.githubusercontent.com/${or.owner}/${or.repo}/${br}/data/products.json?_=${Date.now()}`;
      try {
        const r = await fetch(testUrl, { cache: "no-store" });
        if (r.ok) {
          source = { owner: or.owner, repo: or.repo, branch: br };
          try { localStorage.setItem("sv_source", JSON.stringify(source)); } catch {}
          return source;
        }
      } catch {}
    }

    return null;
  }

  async function fetchJson(relPath, { forceBust=false } = {}){
    const src = await resolveSource();
    const relBase = relPath;
    const rawBase = src ? `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${src.branch}/${relPath}` : null;

    const mkUrl = (base) => forceBust ? `${base}${base.includes("?") ? "&" : "?"}_=${Date.now()}` : base;

    const headers = {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    };

    if (rawBase) {
      try {
        const url = mkUrl(rawBase);
        const r = await fetch(url, { cache: "no-store", headers });
        if (r.status === 304) return null;
        if (r.ok) return await r.json();
        try { localStorage.removeItem("sv_source"); } catch {}
        source = null;
      } catch {
        try { localStorage.removeItem("sv_source"); } catch {}
        source = null;
      }
    }

    const url = mkUrl(relBase);
    const r = await fetch(url, { cache: "no-store", headers });
    if (r.status === 304) return null;
    if (!r.ok) throw new Error(`Nem tudtam betölteni: ${relPath} (${r.status})`);
    return await r.json();
  }

  async function fetchProducts({ forceBust=false } = {}){
    return await fetchJson("data/products.json", { forceBust });
  }
  async function fetchSales({ forceBust=false } = {}){
    return await fetchJson("data/sales.json", { forceBust });
  }

  async function fetchReservations({ forceBust=false } = {}){
    return await fetchJson("data/reservations.json", { forceBust });
  }

  function normalizeDoc(data) {
    if (Array.isArray(data)) return { categories: [], products: data, popups: [], _meta: null };
    const categories = data && Array.isArray(data.categories) ? data.categories : [];
    const products = data && Array.isArray(data.products) ? data.products : [];
    const popups = data && Array.isArray(data.popups) ? data.popups : [];
    const _meta = data && typeof data === "object" ? (data._meta || null) : null;
    return { categories, products, popups, _meta };
  }

  function normalizeSales(data){
    if(!Array.isArray(data)) return [];
    return data.map(s => {
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


  function normalizeReservations(data){
    if(!Array.isArray(data)) return [];
    return data.map(r => {
      const createdAt = (typeof r.createdAt === "string") ? Date.parse(r.createdAt) : Number(r.createdAt||0);
      const expiresAt = (r.expiresAt === null || r.expiresAt === undefined || r.expiresAt === "")
        ? null
        : ((typeof r.expiresAt === "string") ? Date.parse(r.expiresAt) : Number(r.expiresAt||0));

      const items = Array.isArray(r.items)
        ? r.items.map(it => ({
            productId: String(it.productId || it.pid || ""),
            qty: Math.max(1, Number.parseFloat(it.qty || it.quantity || 1) || 1),
            unitPrice: Math.max(0, Number.parseFloat(it.unitPrice || it.price || 0) || 0)
          })).filter(it => it.productId)
        : [];

      return {
        id: String(r.id || ""),
        publicCode: String(r.publicCode || r.code || ""),
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        expiresAt: (expiresAt === null) ? null : (Number.isFinite(expiresAt) ? expiresAt : null),
        confirmed: !!r.confirmed,
        modified: !!r.modified,
        modifiedAt: (typeof r.modifiedAt === "string") ? Date.parse(r.modifiedAt) : (Number(r.modifiedAt||0) || 0),
        editCount: Math.max(0, Number(r.editCount ?? r.editedCount ?? 0) || 0),
        recorded: !!r.recorded,
        deleted: !!r.deleted,
        lastAction: String(r.lastAction || ""),
        discordMessageId: String(r.discordMessageId || r.discord_message_id || ""),
        items
      };
    }).filter(r => r.id && r.items && r.items.length);
  }

  function reservationsSig(res){
    try{ return hashStr(JSON.stringify(res || [])); }catch{ return ""; }
  }

  function applyReservationsIfChanged(nextRes, { fresh=false } = {}){
    const arr = normalizeReservations(nextRes);
    const sig = reservationsSig(arr);
    if(sig && sig === state.reservationsHash){
      if(fresh) state.reservationsFresh = true;
      return false;
    }
    state.reservations = arr;
    state.reservationsHash = sig;
    state.reservationsFresh = !!fresh;
    rebuildReservedMap();
    return true;
  }

  function rebuildReservedMap(){
    const m = new Map();
    const now = Date.now();
    for(const r of (state.reservations || [])){
      if(!r) continue;
      if(!r.confirmed && r.expiresAt && r.expiresAt <= now) continue;
      for(const it of (r.items || [])){
        const pid = String(it.productId || "");
        const qty = Number(it.qty || 0) || 0;
        if(!pid || qty <= 0) continue;
        m.set(pid, (m.get(pid)||0) + qty);
      }
    }
    state.reservedByProduct = m;
  }


  /* ----------------- Featured (Felkapott) ----------------- */
  function computeFeaturedByCategory(){
    state.featuredByCat = new Map();
    if(!state.salesFresh) return; // ✅ ha nem friss a sales, ne találgassunk felkapottat
    
    const products = (state.productsDoc.products || []).filter(p => p && p.id && p.visible !== false);
    const cats = (state.productsDoc.categories || []);
    const enabledCats = new Set(cats.filter(c => c && c.id && (c.featuredEnabled === false ? false : true)).map(c => String(c.id)));

    // totals: categoryId -> productId -> qty
    const totals = new Map();
    let any = 0;

    for(const sale of (state.sales || [])){
      for(const it of (sale.items || [])){
        const pid = String(it.productId || "");
        const qty = Number(it.qty || 0) || 0;
        if(!pid || qty <= 0) continue;
        const p = products.find(x => String(x.id) === pid);
        if(!p) continue;
        
        // ✅ Kizárjuk az "out" státuszú és 0 készletű termékeket
        if(p.status === "out" || p.stock <= 0) continue;
        
        const cid = String(p.categoryId || "");
        if(!cid || !enabledCats.has(cid)) continue;
        any += qty;
        if(!totals.has(cid)) totals.set(cid, new Map());
        const m = totals.get(cid);
        m.set(pid, (m.get(pid)||0) + qty);
      }
    }

    if(any <= 0) return; // ✅ nincs eladás → nincs felkapott

    for(const [cid, m] of totals.entries()){
      let bestPid = null;
      let bestQty = -1;

      for(const [pid, qty] of m.entries()){
        if(qty > bestQty){
          bestQty = qty; bestPid = pid;
        }else if(qty === bestQty && bestPid){
          // tie-break: íz név abc szerint (HU/EN locale)
          const a = products.find(x=>String(x.id)===pid);
          const b = products.find(x=>String(x.id)===bestPid);
          const fa = norm(getFlavor(a));
          const fb = norm(getFlavor(b));
          const cmp = naturalCompare(fa, fb);
          if(cmp < 0) bestPid = pid;
        }
      }

      if(bestPid) state.featuredByCat.set(cid, bestPid);
    }
  }


  /* ----------------- Change detection (avoid flicker + stale overwrites) ----------------- */
  function hashStr(str){
    // tiny fast hash (djb2)
    let h = 5381;
    for(let i=0;i<str.length;i++){
      h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }
  function docRev(doc){
    const r = doc && doc._meta ? Number(doc._meta.rev || doc._meta.updatedAt || 0) : 0;
    return Number.isFinite(r) ? r : 0;
  }
  function docSig(doc){
    try{
      return hashStr(JSON.stringify({
        c: doc.categories || [],
        p: doc.products || [],
        pp: doc.popups || [],
        m: doc._meta || null
      }));
    }catch{ return ""; }
  }
  function salesSig(sales){
    try{ return hashStr(JSON.stringify(sales || [])); }catch{ return ""; }
  }

  function applyDocIfNewer(nextDoc, { source="net" } = {}){
    const next = normalizeDoc(nextDoc);
    const nextSig = docSig(next);
    if(!nextSig) return false;

    const nextRev = docRev(next);
    const now = Date.now();

    // same content -> nothing
    if(state.docHash && nextSig === state.docHash) return false;

    // protect against stale RAW/Pages caches overwriting a just-saved live payload
    if(state.docRev && nextRev && nextRev < state.docRev) return false;

    // if we have a recent live update with rev, and network doc has no rev -> ignore briefly
    if(state.docRev && !nextRev && state.lastLiveTs && (now - state.lastLiveTs) < 90_000){
      return false;
    }

    state.productsDoc = next;
    state.docHash = nextSig;
    if(nextRev) state.docRev = nextRev;
    if(source === "live") state.lastLiveTs = now;
    syncSecretSessionWithDoc({ rerender:false });
    return true;
  }

  function applySalesIfChanged(nextSales, { fresh=false } = {}){
    const arr = Array.isArray(nextSales) ? nextSales : [];
    const sig = salesSig(arr);
    if(sig && sig === state.salesHash){
      // keep fresh flag updated only if it becomes true
      if(fresh) state.salesFresh = true;
      return false;
    }
    state.sales = arr;
    state.salesHash = sig;
    state.salesFresh = !!fresh;
    return true;
  }

  /* ----------------- Rendering ----------------- */
  function orderedCategories() {
    const cats = (state.productsDoc.categories || [])
      .filter((c) => c && c.id)
      .map((c) => ({
        id: String(c.id),
        label_hu: c.label_hu || c.id,
        label_en: c.label_en || c.label_hu || c.id,
        basePrice: Number(c.basePrice || 0),
        featuredEnabled: (c.featuredEnabled === false) ? false : true,
        visible: (c.visible === false) ? false : true,
        secret: c.secret === true
      }))
      .filter(c => isAdminMode || c.visible !== false);

    const modeCats = new Set();
    if(isAdminMode){
      for(const c of cats) modeCats.add(String(c.id));
    }else{
      for(const c of cats){
        const cid = String(c.id);
        const hasPublic = (state.productsDoc.products || []).some(p => p && String(p.categoryId || "") === cid && p.visible !== false && !isSecretProduct(p));
        const hasSecret = (state.productsDoc.products || []).some(p => p && String(p.categoryId || "") === cid && p.visible !== false && isSecretProduct(p));
        if(isSecretModeActive()){
          if(c.secret || hasSecret) modeCats.add(cid);
        }else{
          if(!c.secret || hasPublic) modeCats.add(cid);
        }
      }
    }

    const visibleCats = cats
      .filter(c => modeCats.has(String(c.id)))
      .sort((a, b) => naturalCompare(catLabel(a), catLabel(b)));

    const visibleFavoriteCount = (state.productsDoc.products || []).filter(p => p && p.id && p.visible !== false && canInteractProduct(p) && isFavorite(p.id)).length;

    const out = [
      { id: "all", label_hu: t("all"), label_en: t("all"), virtual: true },
    ];
    if(visibleFavoriteCount || state.active === "favorites"){
      out.push({ id: "favorites", label_hu: t("favorites"), label_en: t("favorites"), virtual: true });
    }
    out.push(...visibleCats);
    out.push({ id: "soon", label_hu: t("soon"), label_en: t("soon"), virtual: true });
    return out;
  }

  function filterList() {
    const q = norm(state.search);

    const catVisible = new Map();
    for(const c of (state.productsDoc.categories || [])){
      if(c && c.id) catVisible.set(String(c.id), (c.visible === false) ? false : true);
    }

    let list = (state.productsDoc.products || []).map((p) => ({
      ...p,
      id: String(p.id || ""),
      categoryId: String(p.categoryId || ""),
      status: p.status === "soon" || p.status === "out" || p.status === "ok" ? p.status : "ok",
      stock: Math.max(0, Number(p.stock || 0)),
      visible: (p.visible === false) ? false : true,
      secret: p.secret === true
    })).filter(p => p.id && p.visible !== false);

    if(!isAdminMode){
      list = list.filter(p => canSeeProduct(p));
      list = list.filter(p => p.status === "soon" || (catVisible.get(String(p.categoryId)) !== false));
    }

    if (state.active === "soon") {
      list = list.filter((p) => p.status === "soon");
    } else if (state.active === "favorites") {
      list = list.filter((p) => canInteractProduct(p) && isFavorite(p.id));
    } else {
      if (state.active !== "all") list = list.filter((p) => String(p.categoryId) === String(state.active));
    }

    if (q) {
      list = list.filter((p) => norm(getName(p) + " " + getFlavor(p)).includes(q));
    }

    const okPart = list.filter((p) => !isOut(p) && !isSoon(p));
    const soonPart = list.filter((p) => !isOut(p) && isSoon(p));
    const outPart = list.filter((p) => isOut(p));

    const groupSort = (arr) => {
      const map = new Map();
      for (const p of arr) {
        const key = norm(getName(p));
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(p);
      }
      const keys = [...map.keys()].sort((a, b) => naturalCompare(a, b));
      const out = [];
      for (const k of keys) {
        const items = map.get(k);
        items.sort((a, b) => naturalCompare(getFlavor(a), getFlavor(b)));
        out.push(...items);
      }
      return out;
    };

    return [...groupSort(okPart), ...groupSort(soonPart), ...groupSort(outPart)];
  }

  function fmtFt(n) {
    const v = Number(n || 0);
    return v.toLocaleString("hu-HU") + " Ft";
  }

  function renderNav() {
    const nav = $("#nav");
    nav.innerHTML = "";

    normalizeActiveView();
    const cats = orderedCategories();
    for (const c of cats) {
      const btn = document.createElement("button");
      btn.textContent = c.id === "all" ? t("all") : c.id === "favorites" ? t("favorites") : c.id === "soon" ? t("soon") : catLabel(c);
      if (state.active === c.id) btn.classList.add("active");
      btn.onclick = () => {
        state.active = c.id;
        $("#title").textContent = btn.textContent;
        renderNav();
        renderGrid();
      };
      nav.appendChild(btn);
    }
  }

  function getFeaturedListForAll(){
    const cats = (state.productsDoc.categories || []).filter(c => c && c.id && (c.featuredEnabled === false ? false : true) && (isAdminMode || c.visible !== false));
    cats.sort((a,b)=>naturalCompare(catLabel(a), catLabel(b)));
    const out = [];
    for(const c of cats){
      const pid = state.featuredByCat.get(String(c.id));
      if(!pid) continue;
      const p = (state.productsDoc.products||[]).find(x=>String(x.id)===String(pid));
      if(p && p.visible !== false && canSeeProduct(p)) out.push(p);
    }
    return out;
  }

  function renderGrid() {
    const grid = $("#grid");
    const empty = $("#empty");
    grid.innerHTML = "";

    let list = filterList();

    // ✅ Featured: kategóriánként 1-1 (ha van eladás) + kategória toggle (admin)
    const featuredIds = new Set();
    let featuredToPrepend = [];

    if(state.active !== "soon"){
      if(state.active === "all"){
        featuredToPrepend = getFeaturedListForAll();
      }else{
        const pid = state.featuredByCat.get(String(state.active));
        if(pid){
          const p = (state.productsDoc.products||[]).find(x=>String(x.id)===String(pid));
          if(p && p.visible !== false && canSeeProduct(p)) featuredToPrepend = [p];
        }
      }
    }

    for(const fp of featuredToPrepend){
      featuredIds.add(String(fp.id));
    }

    if(featuredToPrepend.length){
      // remove from main list so ne duplázzon
      list = list.filter(p => !featuredIds.has(String(p.id)));
      list = [...featuredToPrepend, ...list];
    }

    $("#count").textContent = String(list.length);
    empty.style.display = list.length ? "none" : "block";

    for (const p of list) {
      const name = getName(p);
      const flavor = getFlavor(p);
      const out = isOut(p);
      const soon = isSoon(p);
      const featured = featuredIds.has(String(p.id));
      const stockShown = out ? 0 : (soon ? Math.max(0, Number(p.stock || 0)) : Math.max(0, Number(p.stock || 0)));
      const price = effectivePrice(p);

      // Determine card classes based on status
      let cardClass = "card fade-in";
      if (out) cardClass += " dim outline-red";
      else if (soon) cardClass += " outline-yellow";
      if (featured) cardClass += " outline-orange";

      const card = document.createElement("div");
      card.className = cardClass;

      const hero = document.createElement("div");
      hero.className = "hero";

      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = (name + (flavor ? " - " + flavor : "")).trim();
      img.src = p.image || "";

      // sold-out legyen szürke (CSS is)
      if (out) {
        img.style.filter = "grayscale(.75) contrast(.95) brightness(.85)";
      } else if (soon) {
        // hamarosan: kicsit szürkébb, de ne annyira mint az elfogyott
        img.style.filter = "grayscale(.25) contrast(.98) brightness(.92)";
      }

      const badges = document.createElement("div");
      badges.className = "badges";

      const favBtn = document.createElement("button");
      favBtn.type = "button";
      const favActive = canInteractProduct(p) && isFavorite(p.id);
      favBtn.className = `fav-btn${favActive ? " is-active" : ""}`;
      favBtn.setAttribute("aria-label", favActive ? t("removeFav") : t("addFav"));
      favBtn.setAttribute("title", favActive ? t("removeFav") : t("addFav"));
      favBtn.innerHTML = "❤";
      favBtn.addEventListener("click", (e)=>{
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(p.id);
      });

      if(featured){
        const b = document.createElement("div");
        b.className = "badge hot";
        b.textContent = t("hot");
        badges.appendChild(b);
      }

      if (soon) {
        const b = document.createElement("div");
        b.className = "badge soon";
        b.textContent = t("soon");
        badges.appendChild(b);
        
        // Add expected month badge if available
        if (p.soonEta) {
          const expectedBadge = document.createElement("div");
          expectedBadge.className = "badge soon";
          expectedBadge.textContent = `📅 ${t("expected")}: ${formatMonth(p.soonEta)}`;
          badges.appendChild(expectedBadge);
        }
      }

      if (out) {
        const b = document.createElement("div");
        b.className = "badge out";
        b.textContent = t("out");
        badges.appendChild(b);
      }

      const overlay = document.createElement("div");
      overlay.className = "overlay-title";
      overlay.innerHTML = `
        <div class="name">${name}</div>
        <div class="flavor">${flavor}</div>
      `;

      hero.appendChild(img);
      hero.appendChild(badges);
      hero.appendChild(favBtn);
      hero.appendChild(overlay);

      const body = document.createElement("div");
      body.className = "card-body";

      const reserved = soon ? 0 : reservedQty(String(p.id));
      const available = soon ? 0 : Math.max(0, Math.max(0, Number(p.stock || 0)) - reserved);

      const meta = document.createElement("div");
      meta.className = "meta-grid";

      const priceEl = document.createElement("div");
      priceEl.className = "price";
      priceEl.textContent = fmtFt(price);

      const stockEl = document.createElement("div");
      stockEl.className = "stock";
      stockEl.innerHTML = `${t("stock")}: <b>${soon ? "—" : available} ${soon ? "" : t("pcs")}</b>`;

      const resEl = document.createElement("div");
      resEl.className = "reserved";
      resEl.innerHTML = `Foglalt: <b>${soon ? "—" : reserved} ${soon ? "" : t("pcs")}</b>`;

      meta.appendChild(priceEl);
      meta.appendChild(stockEl);
      meta.appendChild(resEl);
      body.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "card-actions";

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "add-cart-btn";
      addBtn.textContent = "Kosárba teszem";
      addBtn.disabled = out || soon || available <= cartQtyVisible(String(p.id));
      addBtn.addEventListener("click", (e)=>{
        e.preventDefault();
        e.stopPropagation();
        addToCart(p);
      });

      actions.appendChild(addBtn);
      body.appendChild(actions);

      card.appendChild(hero);
      card.appendChild(body);

      grid.appendChild(card);
    }
  }

  /* ----------------- Popups (New products) ----------------- */
  function popupHideKey(pp){
    const id = String(pp.id||"");
    const rev = Number(pp.rev || pp.updatedAt || pp.createdAt || 0) || 0;
    return `sv_popup_hide_${id}_${rev}`;
  }

  function buildPopupQueue(){
    const popups = (state.productsDoc.popups || []).filter(pp => pp && pp.id && (pp.enabled === false ? false : true));
    // sort: newest first (admin list is newest first)
    popups.sort((a,b)=>(Number(b.createdAt||0)-Number(a.createdAt||0)));

    const products = (state.productsDoc.products || []).filter(p=>p && p.id && p.visible !== false && canSeeProduct(p));
    const cats = (state.productsDoc.categories || []);

    const queue = [];

    for(const pp of popups){
      // skip if user hid this rev
      try{
        if(localStorage.getItem(popupHideKey(pp)) === "1") continue;
      }catch{}

      // collect product ids
      const ids = new Set();
      for(const cid of (pp.categoryIds||[])){
        for(const p of products){
          if(String(p.categoryId) === String(cid)) ids.add(String(p.id));
        }
      }
      for(const pid of (pp.productIds||[])){
        ids.add(String(pid));
      }

      const picked = [...ids].map(id => products.find(p=>String(p.id)===String(id))).filter(Boolean);

      // group by category
      const byCat = new Map();
      for(const p of picked){
        const cid = String(p.categoryId||"");
        if(!byCat.has(cid)) byCat.set(cid, []);
        byCat.get(cid).push(p);
      }

      // sort categories by label
      const catIds = [...byCat.keys()].sort((a,b)=>{
        const ca = cats.find(x=>String(x.id)===String(a));
        const cb = cats.find(x=>String(x.id)===String(b));
        return catLabel(ca).localeCompare(catLabel(cb), locale());
      });

      if(!catIds.length) continue;

      queue.push({
        popup: pp,
        categories: catIds.map(cid => ({
          id: cid,
          label: catLabel(cats.find(x=>String(x.id)===String(cid)) || {id:cid, label_hu:cid, label_en:cid}),
          products: byCat.get(cid)
            .slice()
            .sort((a,b)=> norm(getFlavor(a)).localeCompare(norm(getFlavor(b)), locale()))
        }))
      });
    }

    return queue;
  }

  function showPopupsIfNeeded(){
    const queue = buildPopupQueue();
    if(!queue.length) return;

    // Remove existing popup if any
    const existing = document.getElementById("popupBg");
    if(existing) existing.remove();

    // Create popup container
    const bg = document.createElement("div");
    bg.id = "popupBg";
    bg.className = "popup-backdrop";

    const modal = document.createElement("div");
    modal.className = "popup-modal";

    const header = document.createElement("div");
    header.className = "popup-header";

    const content = document.createElement("div");
    content.className = "popup-content";

    const slider = document.createElement("div");
    slider.className = "popup-slider";

    const footer = document.createElement("div");
    footer.className = "popup-footer";

    modal.appendChild(header);
    modal.appendChild(content);
    modal.appendChild(footer);
    bg.appendChild(modal);
    document.body.appendChild(bg);

    let currentPopup = 0;
    let currentSlide = 0; // kategória slide index
    let currentProductSlide = 0; // termék slide index
    let slides = []; // termék slide-ok
    let slideInterval = null;

    function renderPopup() {
        if (currentPopup >= queue.length) {
            bg.remove();
            return;
        }

        const popupData = queue[currentPopup];
        const popup = popupData.popup;
        const categories = popupData.categories;

        if (currentSlide >= categories.length) {
            currentPopup++;
            currentSlide = 0;
            renderPopup();
            return;
        }

        const category = categories[currentSlide];
        const products = category.products;

        if (products.length === 0) {
            currentSlide++;
            renderPopup();
            return;
        }

        // Clear existing slides
        slider.innerHTML = "";
        slides = [];

        // Create slides for each product
        products.forEach((product, index) => {
            const slide = document.createElement("div");
            slide.className = "popup-slide";
            
            const name = getName(product);
            const flavor = getFlavor(product);
            const price = effectivePrice(product);
            const stock = Math.max(0, (product.stock||0) - reservedQty(product.id));
            const isProductSoon = isSoon(product);
            const isProductOut = isOut(product);
            const imgFilter = isProductOut
              ? "grayscale(.75) contrast(.95) brightness(.85)"
              : (isProductSoon ? "grayscale(.25) contrast(.98) brightness(.92)" : "none");
            
            slide.innerHTML = `
                <div class="popup-product-image">
                    <img src="${product.image || ''}" alt="${name} ${flavor}" loading="lazy" style="object-fit: contain;max-height:350px;width:100%;filter:${imgFilter};">
                </div>
                <div class="popup-product-info">
                    <div class="popup-product-name">${name}</div>
                    <div class="popup-product-flavor">${flavor}</div>
                    <div class="popup-product-price">${fmtFt(price)}</div>
                    <div class="popup-product-stock">${t("stock")}: <b>${isProductSoon ? "—" : (isProductOut ? 0 : stock)} ${isProductSoon ? "" : t("pcs")}</b></div>
                    ${product.soonEta ? `<div class="popup-product-expected">${t("expected")}: ${formatMonth(product.soonEta)}</div>` : ''}
                </div>
            `;
            
            slider.appendChild(slide);
            slides.push(slide);
        });

        // ✅ Infinite slider setup: only clone the first slide and append to the end (csak jobbról balra)
        if (slides.length > 1) {
            const firstClone = slides[0].cloneNode(true);
            slider.appendChild(firstClone);
        }

        const totalSlides = slides.length;

        // 🔧 Fontos: a slider szélessége maradjon 100% (különben "szétcsúszik" / belenagyít)
        slider.style.width = "100%";

        function goToSlide(index, animate = true) {
            if (totalSlides <= 1) return;

            currentProductSlide = index;

            if (animate) {
                slider.style.transition = 'transform 0.5s ease';
            } else {
                slider.style.transition = 'none';
            }

            const offset = -currentProductSlide * 100;
            slider.style.transform = `translateX(${offset}%)`;

            // ✅ Ha elérjük a klónt (utolsó slide), azonnal ugorjunk vissza az elsőre (láthatatlan ugrás)
            if (currentProductSlide === totalSlides) {
                setTimeout(() => {
                    slider.style.transition = 'none';
                    currentProductSlide = 0;
                    slider.style.transform = `translateX(0%)`;
                }, 500);
            }

            updateDots();
        }

        function nextSlide() {
            if (slides.length <= 1) return;
            goToSlide(currentProductSlide + 1, true);
        }

        function prevSlide() {
            if (slides.length <= 1) return;
            let newIndex = currentProductSlide - 1;
            if (newIndex < 0) {
                // Ha az elsőnél vagyunk és visszamegyünk, ugorjunk az utolsó igazi slide-ra
                newIndex = totalSlides - 1;
                // Először ugorjunk a klónra (láthatatlan), majd animálva az utolsóra
                slider.style.transition = 'none';
                currentProductSlide = totalSlides;
                slider.style.transform = `translateX(-${currentProductSlide * 100}%)`;
                
                setTimeout(() => {
                    goToSlide(newIndex, true);
                }, 50);
                return;
            }
            goToSlide(newIndex, true);
        }

        // Create dots
        const dots = document.createElement("div");
        dots.className = "popup-dots";
        
        function updateDots() {
            dots.innerHTML = '';
            for(let i = 0; i < totalSlides; i++) {
                const dot = document.createElement("div");
                const displayIndex = currentProductSlide >= totalSlides ? 0 : currentProductSlide;
                dot.className = `popup-dot ${i === displayIndex ? 'active' : ''}`;
                dot.addEventListener('click', () => goToSlide(i));
                dots.appendChild(dot);
            }
        }

        // ✅ Auto slide (csak jobbra)
        if(slideInterval) clearInterval(slideInterval);
        if(totalSlides > 1) {
            slideInterval = setInterval(nextSlide, 4000);
        }

        // Update header and footer
        header.innerHTML = `
            <div class="popup-title">${popup.title_hu || t("newAvail")}</div>
            <div class="popup-subtitle">${category.label}</div>
        `;

        footer.innerHTML = '';
        
        const dontShow = document.createElement("label");
        dontShow.className = "chk";
        dontShow.innerHTML = `<input type="checkbox" id="dontShowAgain"> ${t("dontShow")}`;
        
        // ✅ "Skip all" csak akkor, ha több popup van
        const buttons = document.createElement("div");
        buttons.className = "popup-buttons";
        
        if(queue.length > 1) {
            const skipAllBtn = document.createElement("button");
            skipAllBtn.className = "ghost";
            skipAllBtn.textContent = t("skipAll");
            skipAllBtn.onclick = () => {
                // Hide all popups
                queue.forEach(q => {
                    try {
                        localStorage.setItem(popupHideKey(q.popup), "1");
                    } catch {}
                });
                if(slideInterval) clearInterval(slideInterval);
                bg.remove();
            };
            buttons.appendChild(skipAllBtn);
        }
        
        const understoodBtn = document.createElement("button");
        understoodBtn.className = "primary";
        understoodBtn.textContent = t("understood");
        understoodBtn.onclick = () => {
            const checkbox = document.getElementById("dontShowAgain");
            if(checkbox && checkbox.checked) {
                try {
                    localStorage.setItem(popupHideKey(popup), "1");
                } catch {}
            }
            currentSlide++;
            if(slideInterval) clearInterval(slideInterval);
            renderPopup();
        };
        buttons.appendChild(understoodBtn);
        
        footer.appendChild(dontShow);
        if(totalSlides > 1) footer.appendChild(dots);
        footer.appendChild(buttons);

        // ✅ Navigation arrows (mindkét irányba)
        if(totalSlides > 1) {
            const prevArrow = document.createElement("button");
            prevArrow.className = "popup-arrow prev";
            prevArrow.textContent = "‹";
            prevArrow.onclick = prevSlide;
            
            const nextArrow = document.createElement("button");
            nextArrow.className = "popup-arrow next";
            nextArrow.textContent = "›";
            nextArrow.onclick = nextSlide;
            
            content.appendChild(prevArrow);
            content.appendChild(nextArrow);
        }

        content.innerHTML = '';
        content.appendChild(slider);
        if(totalSlides > 1) updateDots();
        goToSlide(0, false);
    }

    renderPopup();

    // ✅ Swipe support for mobile (mindkét irány)
    let touchStartX = 0;
    let touchEndX = 0;

    content.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    });

    content.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    });

    function handleSwipe() {
        const swipeThreshold = 50;
        const diff = touchStartX - touchEndX;

        if(Math.abs(diff) > swipeThreshold) {
            if(diff > 0) {
                // Swipe left - next
                nextSlide();
            } else {
                // Swipe right - previous
                prevSlide();
            }
        }
    }

    // Close on background click
    bg.addEventListener("click", (e) => {
        if(e.target === bg) {
            if(slideInterval) clearInterval(slideInterval);
            bg.remove();
        }
    });
  }

  /* ----------------- Init ----------------- */
  function setLangUI(){
    $("#langLabel").textContent = state.lang.toUpperCase();
    $("#search").placeholder = "Keresés...";
  }

  function initSearch(){
    const input = $("#search");
    if(!input) return;

    const applySearch = async () => {
      const seq = ++state.searchSeq;
      const raw = input.value || "";
      const unlocked = await tryUnlockFromSearchValue(raw);
      if(seq !== state.searchSeq) return;
      if(unlocked){
        state.search = "";
        input.value = "";
        return;
      }
      state.search = raw;
      renderGrid();
    };

    try{
      input.setAttribute("autocomplete", "off");
      input.setAttribute("autocapitalize", "none");
      input.spellcheck = false;
    }catch{}

    input.addEventListener("input", applySearch);
    input.addEventListener("search", applySearch);
    input.addEventListener("change", applySearch);
    input.addEventListener("compositionend", applySearch);
    input.addEventListener("keyup", (e)=>{
      if(e.key === "Enter" || e.key === "Escape") applySearch();
    });
  }

  function initLang(){
    $("#langBtn").onclick = () => {
      state.lang = state.lang === "hu" ? "en" : "hu";
      localStorage.setItem("sv_lang", state.lang);
      setLangUI();
      renderNav();
      renderGrid();
      // popups szöveg is nyelv függő – újrarender
      showPopupsIfNeeded();
    };
  }

  function hydrateFromLivePayload(){
    try{
      const raw = localStorage.getItem("sv_live_payload");
      if(!raw) return false;
      const payload = JSON.parse(raw);
      if(!payload || !payload.doc) return false;

      // csak friss live payloadot fogadjunk el (különben régi eladások / termékek ragadhatnak be)
      const ts = Number(payload.ts || 0) || 0;
      if(!ts || (Date.now() - ts) > 120_000) return false;

      const docChanged = applyDocIfNewer(payload.doc, { source: "live" });

      // sales: csak akkor frissnek tekintjük, ha a payload ténylegesen tartalmaz sales adatot
      const salesChanged = applySalesIfChanged(normalizeSales(payload.sales || []), { fresh: true });

      const resChanged = ("reservations" in payload) ? applyReservationsIfChanged(payload.reservations || [], { fresh: true }) : false;

      if(docChanged || salesChanged || resChanged){
        computeFeaturedByCategory();
      }
      return (docChanged || salesChanged);
    }catch{ return false; }
  }

  async function loadAll({ forceBust=false } = {}){
    let changed = false;

    // products
    const docRaw = await fetchProducts({ forceBust });
    if(docRaw){
      const docChanged = applyDocIfNewer(docRaw, { source: "net" });
      if(docChanged) changed = true;
    }

    // sales
    let salesOk = false;
    try{
      const salesRaw = await fetchSales({ forceBust });
      salesOk = true;
      // [] is truthy, so ok
      const sChanged = applySalesIfChanged(normalizeSales(salesRaw || []), { fresh:true });
      if(sChanged) changed = true;
    }catch{
      // ha nem tudjuk biztosan betölteni, ne jelenítsünk meg felkapottat
      state.salesFresh = false;
    }

    // reservations
    try{
      const reservationsRaw = await fetchReservations({ forceBust });
      const rChanged = applyReservationsIfChanged(reservationsRaw || [], { fresh:true });
      if(rChanged) changed = true;
    }catch{
      state.reservationsFresh = false;
    }

    // featured depends on BOTH products+sales; csak ha változott valami (vagy ha salesFresh változott)
    if(changed || !state.salesFresh){
      computeFeaturedByCategory();
    }

    return changed;
  }

  async function init() {
    applySyncParams();
    setLangUI();
    initLang();
    initSearch();

    // if admin pushed live payload (same browser) use it first
    hydrateFromLivePayload();

    // cart (load before first render)
    state.cart = loadCart();
    state.favorites = loadFavorites();

    // load from network (RAW) to be sure
    await loadAll({ forceBust:true });
    syncSecretSessionWithDoc({ rerender:false });

    renderNav();
    renderGrid();

    // cart ui
    ensureCartUI();
    updateCartBadge();

    // show app
    $("#loader").style.display = "none";
    $("#app").style.display = "grid";

    // popups
    setTimeout(() => showPopupsIfNeeded(), 500);

    // live updates from admin (same browser)
    try{
      const bc = new BroadcastChannel("sv_live");
      bc.onmessage = (e) => {
        try{
          if(!e.data) return;

          let changed = false;
          if(e.data.doc){
            changed = applyDocIfNewer(e.data.doc, { source:"live" }) || changed;
          }
          if("sales" in e.data){
            // admin mentés után ez friss
            changed = applySalesIfChanged(normalizeSales(e.data.sales || []), { fresh:true }) || changed;
          }
          if("reservations" in e.data){
            changed = applyReservationsIfChanged(e.data.reservations || [], { fresh:true }) || changed;
          }
          if(changed){
            computeFeaturedByCategory();
            renderNav();
            renderGrid();
            setTimeout(() => showPopupsIfNeeded(), 100);
          }
        }catch{}
      };
    }catch{}

    // polling (light) - increased interval for mobile
    const loop = async () => {
      try{
        const changed = await loadAll({ forceBust:false });
        if(changed){
          renderNav();
          renderGrid();
          setTimeout(() => showPopupsIfNeeded(), 100);
        }
      }catch{}
      setTimeout(loop, 30_000);
    };

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadAll({ forceBust:true }).then((changed)=>{ if(changed){ renderNav(); renderGrid(); } setTimeout(() => showPopupsIfNeeded(), 100); }).catch(()=>{});
    });

    loop();
  }

  init().catch((err) => {
    console.error(err);
    $("#loaderText").textContent =
      "Betöltési hiba. (Nyisd meg a konzolt.) Ha telefonon vagy ...vagy: nyisd meg egyszer a Sync linket az admin Beállításokból.";
  });
})();
