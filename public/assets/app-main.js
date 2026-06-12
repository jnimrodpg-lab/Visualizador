(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const API = '/api';
  const PAGE_SIZE = 48;

  const state = {
    auth: null,
    publicMode: false,
    token: '',
    branches: [],
    branchId: null,
    products: [],
    facets: {},
    summary: {},
    page: 1,
    totalPages: 1,
    total: 0,
    selected: null,
    currentGroups: [],
    groupTotalProducts: 0,
    authMode: 'login',
    headers: [],
    mapping: {},
    sidebarCollapsed: localStorage.getItem('catalogoSidebarCollapsed') === '1'
  };

  const fields = [
    ['sku', 'SKU', ['sku', 'código sku', 'codigo sku']],
    ['nombre', 'Nombre del producto', ['nombre', 'producto', 'descripcion', 'descripción', 'name']],
    ['variante', 'Variante', ['variante', 'modelo', 'cod / modelo', 'cod/modelo', 'codigo modelo']],
    ['marca', 'Marca', ['marca', 'brand']],
    ['categoria', 'Categoría', ['categoria', 'categoría', 'category']],
    ['genero', 'Género', ['genero', 'género']],
    ['estado', 'Estado', ['estado']],
    ['grosor', 'Grosor', ['grosor']],
    ['talla', 'Talla', ['talla', 'size']],
    ['color', 'Color', ['color']],
    ['linea', 'Línea', ['linea', 'línea']],
    ['barras', 'Código de barras', ['barras', 'barcode', 'codigo de barras', 'código de barras']],
    ['ubicacion', 'Ubicación', ['ubicacion', 'ubicación', 'location']],
    ['zona', 'Zona', ['zona']],
    ['estante', 'Estante', ['estante', 'rack']],
    ['nivel', 'Nivel', ['nivel']],
    ['slot', 'Slot', ['slot']],
    ['almacen', 'Almacén', ['almacen', 'almacén', 'warehouse']],
    ['precio', 'Precio', ['p.lista(+igv)', 'precio', 'p lista', 'lista']],
    ['stock', 'Stock / Cantidad', ['cant. restock', 'stock', 'cantidad', 'cant']],
    ['imagen', 'Imagen', ['imagen', 'foto', 'image', 'url imagen', 'link imagen']],
    ['video', 'Video', ['video', 'link video', 'url video']]
  ];

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[ch]));
  }

  function norm(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  function toast(message, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    $('#toastStack').appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || data.message || `Error ${res.status}`);
    return data;
  }

  function parseSheetId(input) {
    const text = String(input || '').trim();
    const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : text;
  }

  function getBranch() {
    return state.branches.find(b => String(b.id) === String(state.branchId)) || state.branches[0] || null;
  }

  function isAdmin() { return !!state.auth && String(state.auth.role || '').toLowerCase() === 'admin'; }
  function isViewer() { return state.publicMode || (!!state.auth && String(state.auth.role || '').toLowerCase() !== 'admin'); }

  function setView(name) {
    if ((name === 'sheet' || name === 'settings') && !isAdmin()) name = 'catalog';
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view${name[0].toUpperCase() + name.slice(1)}`)?.classList.add('active');
    $$('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  }

  function hydrateSessionLabel() {
    const pill = $('#sessionPill');
    if (state.publicMode) {
      pill.textContent = 'Modo viewer · link público';
      $('#adminNav').classList.add('hidden');
      $('#btnAuth').classList.add('hidden');
      $('#btnGoSheet').classList.add('hidden');
      $('#btnShareViewer').classList.add('hidden');
      document.body.classList.add('viewer-mode');
      return;
    }
    const logged = !!state.auth;
    const admin = isAdmin();
    pill.textContent = logged ? `${state.auth.user} · ${admin ? 'admin' : 'viewer'}` : 'Sin sesión';
    $('#btnAuth').textContent = logged ? 'Cerrar sesión' : 'Ingresar';
    $('#adminNav').classList.toggle('hidden', !admin);
    $('#btnGoSheet').classList.toggle('hidden', !admin);
    $('#btnShareViewer').classList.toggle('hidden', !admin);
    document.body.classList.toggle('viewer-mode', logged && !admin);
    if (logged && !admin) setView('catalog');
  }

  async function init() {
    const m = location.pathname.match(/^\/viewer\/([^/]+)/);
    if (m) {
      state.publicMode = true;
      state.token = decodeURIComponent(m[1]);
      $('#authModal').classList.remove('show');
      await loadPublicViewer();
      bindEvents();
      hydrateSessionLabel();
      return;
    }

    bindEvents();
    try {
      state.auth = await api('/session');
      $('#authModal').classList.remove('show');
      await loadBranches();
    } catch {
      hydrateSessionLabel();
      $('#authModal').classList.add('show');
      renderEmptyState('Ingresa como administrador para vincular un Sheet o usa un link público de cliente.');
    }
  }

  function bindEvents() {
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
    $('#btnToggleSidebar')?.addEventListener('click', toggleSidebar);
    applySidebarState();
    $('#btnGoSheet').addEventListener('click', () => setView('sheet'));
    $('#btnAuth').addEventListener('click', authAction);
    $('#btnCloseAuth').addEventListener('click', () => $('#authModal').classList.remove('show'));
    $('#btnDoAuth').addEventListener('click', doAuth);
    $$('.auth-tab').forEach(btn => btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode)));
    $('#branchSelect').addEventListener('change', async () => { state.branchId = $('#branchSelect').value; state.page = 1; await loadSheetConfig(); await loadProducts(); });
    $('#btnReloadProducts').addEventListener('click', () => loadProducts());
    $('#btnSearch').addEventListener('click', () => { state.page = 1; loadProducts(); });
    $('#btnIndividualView')?.addEventListener('click', () => openActiveProductCard());
    $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') { state.page = 1; loadProducts(); } });
    ['filterBrand','filterCategory','filterWarehouse','filterImage'].forEach(id => $(`#${id}`).addEventListener('change', () => { state.page = 1; loadProducts(); }));
    $('#btnClearFilters').addEventListener('click', () => { ['searchInput','filterBrand','filterCategory','filterWarehouse','filterImage'].forEach(id => $(`#${id}`).value = ''); state.page = 1; loadProducts(); });
    $('#btnPrevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadProducts(); } });
    $('#btnNextPage').addEventListener('click', () => { if (state.page < state.totalPages) { state.page++; loadProducts(); } });
    $('#btnProbeSheet').addEventListener('click', probeSheet);
    $('#btnImportSheet').addEventListener('click', importSheet);
    $('#btnCreateBranch').addEventListener('click', createBranch);
    $('#btnShareViewer').addEventListener('click', generateViewerLink);
    $('#btnCopyViewer').addEventListener('click', generateViewerLink);
    $('#btnOpenProductViewer')?.addEventListener('click', e => { e.stopPropagation(); openActiveProductCard(); });
    $('#activeProductCard')?.addEventListener('click', e => {
      if (e.target.closest('button, select, input, textarea, a, video, iframe')) return;
      openActiveProductCard();
    });
    $('#btnCopyProductInfo')?.addEventListener('click', e => { e.stopPropagation(); copySelectedProductInfo(); });
    $('#btnScanFake')?.addEventListener('click', () => toast('Puedes pegar o escanear el código con un lector físico en la barra de búsqueda.'));
    $('#searchCardOverlay')?.addEventListener('click', closeActiveProductCard);
    $('#activeProductCardClose')?.addEventListener('click', e => { e.stopPropagation(); closeActiveProductCard(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeActiveProductCard(); if ($('#activeProductCard')?.classList.contains('search-card-expanded')) handleExpandedKeys(e); });
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    $$('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.authMode === mode));
    $$('.register-only').forEach(el => el.classList.toggle('hidden', mode !== 'register'));
    $('#btnDoAuth').textContent = mode === 'register' ? 'Crear cuenta' : 'Ingresar';
    $('#authStatus').textContent = '';
  }

  async function authAction() {
    if (state.auth) {
      try { await api('/logout', { method:'POST', body:'{}' }); } catch {}
      state.auth = null;
      state.branches = [];
      state.products = [];
      hydrateSessionLabel();
      $('#authModal').classList.add('show');
      renderEmptyState('Sesión cerrada.');
      return;
    }
    $('#authModal').classList.add('show');
  }

  async function doAuth() {
    const payload = {
      username: $('#loginUsername').value.trim(),
      password: $('#loginPassword').value,
      mode: $('#accountRole')?.value || 'admin',
      companyName: $('#companyName').value.trim(),
      companyCode: $('#companyCode').value.trim()
    };
    $('#authStatus').textContent = 'Validando...';
    try {
      state.auth = await api(state.authMode === 'register' ? '/register' : '/login', { method:'POST', body: JSON.stringify(payload) });
      $('#authModal').classList.remove('show');
      $('#authStatus').textContent = '';
      await loadBranches();
      toast('Acceso correcto.');
    } catch (err) {
      $('#authStatus').textContent = err.message;
    }
  }

  async function loadBranches() {
    const data = await api('/branches');
    state.branches = data.branches || [];
    if (!state.branchId && state.branches[0]) state.branchId = state.branches[0].id;
    renderBranches();
    hydrateSessionLabel();
    await loadSheetConfig();
    await loadProducts();
  }

  async function loadPublicViewer() {
    try {
      const data = await api(`/view-links/${encodeURIComponent(state.token)}`);
      const branch = data.branch || { id:'public', name:'Catálogo' };
      state.branches = [branch];
      state.branchId = branch.id;
      state.products = data.sheet?.imported_products || [];
      state.summary = { total: state.products.length, with_image: state.products.filter(p => mediaUrl(p)).length, with_stock: state.products.filter(p => val(p,'stock')).length };
      renderBranches();
      renderLocalPublicProducts();
      const company = branch.name || 'Catálogo';
      $('#brandName').textContent = company;
    } catch (err) {
      renderEmptyState(err.message || 'No se pudo abrir el link público.');
    }
  }

  function renderBranches() {
    const select = $('#branchSelect');
    select.innerHTML = state.branches.map(b => `<option value="${esc(b.id)}">${esc(b.name || 'Sucursal')}</option>`).join('');
    if (state.branchId) select.value = state.branchId;
    const b = getBranch();
    if (b) {
      $('#brandSubtitle').textContent = b.name || 'Catálogo';
    }
  }

  async function loadSheetConfig() {
    if (state.publicMode || !state.branchId || !state.auth) return;
    try {
      const data = await api(`/branches/${state.branchId}/sheet`);
      const cfg = data.config || {};
      $('#sheetUrl').value = cfg.sheet_id || '';
      $('#sheetName').value = cfg.sheet_name || 'Productos';
      state.headers = cfg.sheet_headers || [];
      state.mapping = normalizeMapping(cfg.sheet_map_rows || cfg.mapping || {});
      $('#sheetStatus').textContent = state.headers.length ? `${state.headers.length} encabezados · ${Number(cfg.last_sheet_count || 0)} productos` : 'Sin encabezados';
      renderMapping();
    } catch (err) {
      $('#sheetStatus').textContent = err.message;
    }
  }

  async function loadProducts() {
    if (state.publicMode) return renderLocalPublicProducts();
    if (!state.branchId || !state.auth) return;
    const params = new URLSearchParams({ page: String(state.page), limit: String(PAGE_SIZE), q: $('#searchInput').value.trim(), group_by: 'name' });
    const map = { filterBrand:'brand', filterCategory:'category', filterWarehouse:'warehouse', filterImage:'image_state' };
    Object.entries(map).forEach(([id,key]) => { const v = $(`#${id}`).value; if (v) params.set(key, v); });
    try {
      const data = await api(`/branches/${state.branchId}/products?${params}`);
      state.products = data.items || [];
      state.facets = data.facets || {};
      state.summary = data.summary || {};
      state.total = Number(data.total || 0);
      state.groupTotalProducts = Number(data.group_total_products || 0);
      state.page = Number(data.page || 1);
      state.totalPages = Number(data.total_pages || 1);
      renderFacets();
      renderSummary();
      renderProducts(state.products);
    } catch (err) {
      renderEmptyState(err.message);
    }
  }

  function renderLocalPublicProducts() {
    const q = norm($('#searchInput')?.value || '');
    const terms = q.split(/\s+/).filter(Boolean);
    const brand = norm($('#filterBrand')?.value || '');
    const category = norm($('#filterCategory')?.value || '');
    const warehouse = norm($('#filterWarehouse')?.value || '');
    const imageState = $('#filterImage')?.value || '';
    let filtered = state.products.filter(p => {
      const hay = norm(Object.values(p || {}).join(' '));
      if (terms.length && !terms.every(t => hay.includes(t))) return false;
      if (brand && norm(val(p,'marca')) !== brand) return false;
      if (category && norm(val(p,'categoria')) !== category) return false;
      if (warehouse && norm(val(p,'almacen')) !== warehouse) return false;
      if (imageState === 'with' && !mediaUrl(p)) return false;
      if (imageState === 'without' && mediaUrl(p)) return false;
      return true;
    });
    const groups = groupProductsByName(filtered);
    buildLocalFacets();
    state.groupTotalProducts = filtered.length;
    state.total = groups.length;
    state.totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
    state.page = Math.min(state.page, state.totalPages);
    const slice = groups.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    renderFacets();
    renderSummary();
    renderProducts(slice);
  }

  function buildLocalFacets() {
    const unique = key => [...new Map(state.products.map(p => val(p,key)).filter(Boolean).map(v => [norm(v), v])).values()].sort((a,b)=>String(a).localeCompare(String(b),'es'));
    state.facets = { brand_options: unique('marca'), category_options: unique('categoria'), warehouse_options: unique('almacen') };
  }

  function renderFacets() {
    fillSelect('filterBrand', 'Todas las marcas', state.facets.brand_options || state.facets.brands || []);
    fillSelect('filterCategory', 'Todas las categorías', state.facets.category_options || state.facets.categories || []);
    fillSelect('filterWarehouse', 'Todos los almacenes', state.facets.warehouse_options || state.facets.warehouses || []);
  }

  function fillSelect(id, label, values) {
    const el = $(`#${id}`);
    const current = el.value;
    el.innerHTML = `<option value="">${esc(label)}</option>` + (values || []).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    el.value = current;
  }

  function renderSummary() {
    const total = state.summary.total ?? state.total ?? 0;
    $('#statTotal').textContent = total;
    $('#statTotalTop').textContent = total;
    $('#statImages').textContent = state.summary.with_image ?? 0;
    $('#statStock').textContent = state.summary.with_stock ?? 0;
    const groupText = state.groupTotalProducts ? ` · ${state.groupTotalProducts} variantes/registros` : '';
    $('#resultSummary').textContent = `Mostrando ${state.products.length} familias de ${state.total || state.products.length}${groupText}`;
    $('#pageSummary').textContent = `Página ${state.page} de ${state.totalPages}`;
    $('#paginationText').textContent = `Página ${state.page} / ${state.totalPages}`;
    $('#btnPrevPage').disabled = state.page <= 1;
    $('#btnNextPage').disabled = state.page >= state.totalPages;
  }

  function val(product, key) {
    const aliases = {
      sku:['sku','Sku','SKU'], nombre:['nombre','Nombre','name','producto'], variante:['variante','Variante','modelo','cod_modelo','cod / modelo'], marca:['marca','brand'], categoria:['categoria','categoría','category'], almacen:['almacen','almacén','warehouse'], ubicacion:['ubicacion','ubicación','location'], stock:['stock','cantidad','cant','Cant. Restock'], imagen:['imagen','image','foto','url_imagen','link imagen'], video:['video','link_video','url_video','link video'], color:['color','Color'], talla:['talla','Talla','size'], barras:['barras','Barras','barcode','codigo de barras']
    };
    const keys = aliases[key] || [key];
    for (const k of keys) if (product?.[k] != null && String(product[k]).trim()) return String(product[k]).trim();
    return '';
  }

  function mediaUrl(product) { return val(product,'imagen') || val(product,'video'); }
  function videoUrl(product) { return val(product,'video'); }

  function driveId(url) {
    const text = String(url || '');
    return (text.match(/\/file\/d\/([^/]+)/) || text.match(/[?&]id=([^&]+)/) || [])[1] || '';
  }


  function renderThumb(product) {
    const src = val(product,'imagen') || val(product,'video');
    if (!src) return `<div class="group-thumb-empty">—</div>`;
    const id = driveId(src);
    const img = id ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w320` : src;
    if (/\.mp4($|\?)/i.test(src) && !id) return `<video src="${esc(src)}" muted playsinline></video>`;
    return `<img src="${esc(img)}" alt="${esc(val(product,'nombre') || 'Producto')}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;group-thumb-empty&quot;>—</div>'">`;
  }

  function renderMedia(product, mode = 'card') {
    const video = videoUrl(product);
    const img = val(product,'imagen');
    const src = video || img;
    const wrapClass = mode === 'card' ? 'product-photo' : 'product-photo';
    if (!src) return `<div class="media-empty">Sin imagen</div>`;
    const id = driveId(src);
    if (video) {
      if (/youtube\.com|youtu\.be/.test(src)) {
        const yt = (src.match(/[?&]v=([^&]+)/) || src.match(/youtu\.be\/([^?]+)/) || [])[1];
        if (yt) return `<iframe loading="lazy" src="https://www.youtube.com/embed/${esc(yt)}" allowfullscreen></iframe>`;
      }
      if (id) {
        const poster = `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1200`;
        const proxy = `${API}/drive-video?id=${encodeURIComponent(id)}`;
        return `<video src="${esc(proxy)}" poster="${esc(poster)}" controls playsinline preload="metadata"></video>`;
      }
      if (/\.mp4($|\?)/i.test(src)) return `<video src="${esc(src)}" controls ${mode === 'card' ? 'muted' : ''}></video>`;
    }
    const finalSrc = id ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1600` : src;
    return `<img src="${esc(finalSrc)}" alt="${esc(val(product,'nombre') || 'Producto')}" loading="lazy" onerror="this.parentElement.classList.add('empty');this.remove();">`;
  }

  function productIdentity(product) {
    return [val(product,'sku'), val(product,'nombre'), val(product,'variante'), val(product,'ubicacion'), val(product,'almacen')].join('¦');
  }

  function productGroupKey(product) {
    if (!product) return '';
    if (product._groupKey) return product._groupKey;
    return [norm(val(product,'nombre') || val(product,'sku') || val(product,'barras') || 'sin-nombre'), norm(val(product,'marca'))].join('¦');
  }

  function uniqueValues(list, key) {
    const seen = new Map();
    (list || []).forEach(p => {
      const v = val(p, key);
      if (v && !seen.has(norm(v))) seen.set(norm(v), v);
    });
    return [...seen.values()];
  }

  function groupProductsByName(products) {
    const groups = new Map();
    (products || []).forEach(p => {
      const key = productGroupKey(p);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });
    return [...groups.entries()].map(([key, items]) => {
      const preferred = items.find(p => mediaUrl(p)) || items[0] || {};
      return {
        ...preferred,
        _grouped: true,
        _groupKey: key,
        _groupName: val(preferred,'nombre') || 'Sin nombre',
        _groupItems: items,
        _variantCount: items.length,
        _sizeOptions: uniqueValues(items, 'talla'),
        _colorOptions: uniqueValues(items, 'color'),
        _locationOptions: uniqueValues(items, 'ubicacion'),
        _warehouseOptions: uniqueValues(items, 'almacen'),
        _skuOptions: uniqueValues(items, 'sku')
      };
    }).sort((a,b)=>String(a._groupName).localeCompare(String(b._groupName),'es'));
  }

  function renderProducts(products) {
    const list = $('#productGrid');
    state.currentResults = products || [];
    state.currentGroups = products || [];
    if (!products.length) {
      renderEmptyState('No hay productos para mostrar. Revisa la búsqueda o importa tu Sheet.');
      selectProduct(null);
      return;
    }
    list.innerHTML = products.map((p, idx) => {
      const variants = Number(p._variantCount || p._groupItems?.length || 1);
      const sizes = p._sizeOptions?.length ? p._sizeOptions : uniqueValues(p._groupItems || [p], 'talla');
      const colors = p._colorOptions?.length ? p._colorOptions : uniqueValues(p._groupItems || [p], 'color');
      const locs = p._locationOptions?.length ? p._locationOptions : uniqueValues(p._groupItems || [p], 'ubicacion');
      const whs = p._warehouseOptions?.length ? p._warehouseOptions : uniqueValues(p._groupItems || [p], 'almacen');
      const skuLabel = (p._skuOptions?.[0] || val(p,'sku') || val(p,'barras') || '—');
      const title = p._groupName || val(p,'nombre') || 'Sin nombre';
      const subtitle = [val(p,'marca'), val(p,'categoria')].filter(Boolean).join(' · ');
      return `
      <div class="product-row product-family-row model-one-row" data-index="${idx}" tabindex="0" title="Seleccionar producto agrupado">
        <div class="group-product-cell">
          <div class="group-thumb">${renderThumb(p)}</div>
          <div class="group-info">
            <strong>${esc(title)}</strong>
            <small>${esc(subtitle || `SKU ${skuLabel}`)}</small>
            <span class="group-location-mini">${esc(locs[0] || val(p,'ubicacion') || whs[0] || 'Sin ubicación')}</span>
          </div>
        </div>
        <div><span class="metric-pill">${esc(variants)}</span><small>${esc(variants === 1 ? (val(p,'variante') || '1 variante') : 'variantes')}</small></div>
        <div><span class="metric-pill">${esc(colors.length || '—')}</span><small>${esc(colors.slice(0,3).join(' · ') || 'colores')}</small></div>
        <div><span class="metric-pill">${esc(sizes.length || '—')}</span><small>${esc(sizes.slice(0,4).join(' · ') || 'tallas')}</small></div>
      </div>`;
    }).join('');
    $$('.product-row', list).forEach(row => {
      const pick = () => {
        const group = products[Number(row.dataset.index)];
        const item = group?._groupItems?.find(p => mediaUrl(p)) || group?._groupItems?.[0] || group;
        if (group?._groupItems && !item._groupItems) item._groupItems = group._groupItems;
        if (group?._groupKey && !item._groupKey) item._groupKey = group._groupKey;
        selectProduct(item);
      };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
    });
    const keep = state.selected && products.find(p => productGroupKey(p) === productGroupKey(state.selected));
    const first = keep || products[0];
    const selected = first?._groupItems?.find(p => mediaUrl(p)) || first?._groupItems?.[0] || first;
    if (first?._groupItems && selected && !selected._groupItems) selected._groupItems = first._groupItems;
    if (first?._groupKey && selected && !selected._groupKey) selected._groupKey = first._groupKey;
    selectProduct(selected);
  }

  function renderEmptyState(message) {
    $('#productGrid').innerHTML = `<div class="empty-grid">${esc(message)}</div>`;
    $('#resultSummary').textContent = 'Mostrando 0 productos';
  }

  function siblingProducts(product) {
    if (!product) return [];
    if (Array.isArray(product._groupItems) && product._groupItems.length) return product._groupItems;
    const group = state.currentGroups?.find(g => productGroupKey(g) === productGroupKey(product));
    if (group?._groupItems?.length) return group._groupItems;
    const all = Array.isArray(state.publicMode ? state.products : state.currentResults) ? (state.publicMode ? state.products : state.currentResults) : [];
    const name = norm(val(product,'nombre'));
    const marca = norm(val(product,'marca'));
    return all.flatMap(p => p._groupItems || [p]).filter(p => norm(val(p,'nombre')) === name && (!marca || norm(val(p,'marca')) === marca));
  }

  function chipStyle(label) {
    const c = norm(label);
    const map = [
      [['blanco','white'], '#f8fafc', '#334155', '#e2e8f0'], [['negro','black'], '#151922', '#f8fafc', '#31394b'],
      [['amarillo','yellow'], '#fff1a8', '#705d00', '#f7d85d'], [['beige','nude'], '#eadfcf', '#6f5d49', '#dac7ad'],
      [['rojo','red'], '#ffd3d3', '#842222', '#f6aaaa'], [['azul','blue'], '#d9e8ff', '#254b87', '#abc8f5'],
      [['verde','green'], '#d9fbe8', '#1f6a42', '#a8eac4'], [['lila','morado','azalea'], '#eadcff', '#624a99', '#d6c2fa']
    ];
    const hit = map.find(([keys]) => keys.some(k => c.includes(k)));
    return hit ? `background:${hit[1]};color:${hit[2]};border-color:${hit[3]}` : '';
  }

  function renderVariantChips(product) {
    const siblings = siblingProducts(product);
    const make = (key, hostId) => {
      const host = $(`#${hostId}`);
      if (!host) return;
      const seen = new Map();
      siblings.forEach(p => { const v = val(p,key); if (v && !seen.has(norm(v))) seen.set(norm(v), { label:v, product:p }); });
      if (!seen.size) { host.innerHTML = '<span class="muted tiny">—</span>'; return; }
      host.innerHTML = [...seen.values()].map(item => `<button type="button" class="variant-chip ${norm(item.label)===norm(val(product,key))?'active':''} ${key==='color'?'variant-color':''}" data-key="${key}" data-value="${esc(item.label)}" style="${key==='color'?chipStyle(item.label):''}">${esc(item.label)}</button>`).join('');
      $$('button', host).forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const wanted = btn.dataset.value;
        const currentOther = key === 'talla' ? val(product,'color') : val(product,'talla');
        const exact = siblings.find(p => norm(val(p,key)) === norm(wanted) && (!currentOther || norm(val(p, key === 'talla' ? 'color':'talla')) === norm(currentOther)));
        const fallback = siblings.find(p => norm(val(p,key)) === norm(wanted));
        const picked = exact || fallback || siblings.find(Boolean) || product;
        if (picked && product._groupItems && !picked._groupItems) picked._groupItems = product._groupItems;
        if (picked && product._groupKey && !picked._groupKey) picked._groupKey = product._groupKey;
        selectProduct(picked);
      }));
    };
    make('talla', 'activeSizeStrip');
    make('color', 'activeColorStrip');
  }

  function selectProduct(product) {
    state.selected = product;
    $$('.product-row').forEach(row => {
      const p = state.currentResults?.[Number(row.dataset.index)];
      row.classList.toggle('active', !!p && !!product && productGroupKey(p) === productGroupKey(product));
    });
    if (!product) {
      $('#activeProductMedia').innerHTML = '<div class="media-empty">Selecciona un producto</div>';
      $('#activeProductName').textContent = 'Busca o selecciona un producto';
      $('#activeProductSku').textContent = 'SKU —';
      ['activeProductLocation','activeProductWarehouse','activeProductBrand','activeProductCategory'].forEach(id => $(`#${id}`).textContent = '—');
      $('#activeProductMeta').textContent = 'Variante activa: —';
      $('#activeSizeStrip').innerHTML = '';
      $('#activeColorStrip').innerHTML = '';
      return;
    }
    $('#activeProductMedia').innerHTML = renderMedia(product, 'featured');
    $('#activeProductName').textContent = val(product,'nombre') || 'Sin nombre';
    $('#activeProductSku').textContent = `SKU ${val(product,'sku') || val(product,'barras') || '—'}`;
    $('#activeProductLocation').textContent = val(product,'ubicacion') || [product.zona, product.estante, product.nivel, product.slot].filter(Boolean).join(' · ') || '—';
    $('#activeProductWarehouse').textContent = val(product,'almacen') || '—';
    $('#activeProductBrand').textContent = val(product,'marca') || '—';
    $('#activeProductCategory').textContent = val(product,'categoria') || '—';
    const family = siblingProducts(product);
    $('#activeProductMeta').textContent = `Familia agrupada: ${family.length || 1} variante(s) · activa: talla ${val(product,'talla') || '—'}${val(product,'color') ? ` • color ${val(product,'color')}` : ''}`;
    renderVariantChips(product);
    updateExpandedSideCards();
  }

  function copySelectedProductInfo() {
    const p = state.selected;
    if (!p) return toast('Selecciona un producto primero.', 'bad');
    const text = [
      val(p,'nombre') || 'Sin nombre',
      `SKU: ${val(p,'sku') || '—'}`,
      `Marca: ${val(p,'marca') || '—'}`,
      `Talla: ${val(p,'talla') || '—'}`,
      `Color: ${val(p,'color') || '—'}`,
      `Ubicación: ${val(p,'ubicacion') || '—'}`,
      `Almacén: ${val(p,'almacen') || '—'}`
    ].join('\n');
    navigator.clipboard?.writeText(text).then(() => toast('Información copiada.')).catch(() => toast(text));
  }

  function modalItems() {
    const source = (state.currentGroups && state.currentGroups.length ? state.currentGroups : (state.currentResults && state.currentResults.length ? state.currentResults : state.products));
    return source.filter(Boolean).map(g => {
      const item = g?._groupItems?.find(p => mediaUrl(p)) || g?._groupItems?.[0] || g;
      if (item && g?._groupItems && !item._groupItems) item._groupItems = g._groupItems;
      if (item && g?._groupKey && !item._groupKey) item._groupKey = g._groupKey;
      return item;
    });
  }

  function currentModalIndex() {
    const items = modalItems();
    return Math.max(0, items.findIndex(p => state.selected && productGroupKey(p) === productGroupKey(state.selected)));
  }

  function ensureSideCard(side) {
    let el = document.getElementById(`expandedSideCard-${side}`);
    if (el) return el;
    el = document.createElement('button');
    el.type = 'button';
    el.id = `expandedSideCard-${side}`;
    el.className = `search-card-side-nav ${side}`;
    el.innerHTML = `<div class="side-nav-kicker">${side === 'left' ? 'Anterior' : 'Siguiente'}</div><div class="side-nav-media"></div><div class="side-nav-body"><div class="side-nav-title">—</div><div class="side-nav-sku">SKU —</div><div class="side-nav-mini"><div class="side-nav-pill"><span class="side-nav-label">Ubicación</span><span class="side-nav-value">—</span></div></div></div><div class="side-nav-hint">Haz clic para cambiar de producto</div>`;
    document.body.appendChild(el);
    return el;
  }

  function fillSideCard(el, product, side) {
    if (!product) { el.classList.remove('visible'); return; }
    el.querySelector('.side-nav-kicker').textContent = side === 'left' ? 'Anterior' : 'Siguiente';
    el.querySelector('.side-nav-media').innerHTML = renderMedia(product, 'card');
    el.querySelector('.side-nav-title').textContent = val(product,'nombre') || 'Sin nombre';
    el.querySelector('.side-nav-sku').textContent = `SKU ${val(product,'sku') || '—'}`;
    el.querySelector('.side-nav-value').textContent = val(product,'ubicacion') || '—';
    el.onclick = e => { e.preventDefault(); e.stopPropagation(); selectProduct(product); };
    el.classList.add('visible');
  }

  function updateExpandedSideCards() {
    const card = $('#activeProductCard');
    if (!card?.classList.contains('search-card-expanded') || window.innerWidth <= 980) return hideExpandedSideCards();
    const items = modalItems();
    if (items.length <= 1) return hideExpandedSideCards();
    const idx = currentModalIndex();
    fillSideCard(ensureSideCard('left'), items[(idx - 1 + items.length) % items.length], 'left');
    fillSideCard(ensureSideCard('right'), items[(idx + 1) % items.length], 'right');
  }

  function hideExpandedSideCards() {
    ['left','right'].forEach(side => document.getElementById(`expandedSideCard-${side}`)?.classList.remove('visible'));
  }

  function openActiveProductCard() {
    if (!state.selected) return toast('Selecciona un producto primero.', 'bad');
    $('#activeProductCard')?.classList.add('search-card-expanded');
    $('#searchCardOverlay')?.classList.add('active');
    document.body.classList.add('search-card-modal-open');
    setTimeout(updateExpandedSideCards, 30);
  }

  function closeActiveProductCard() {
    $('#activeProductCard')?.classList.remove('search-card-expanded');
    $('#searchCardOverlay')?.classList.remove('active');
    document.body.classList.remove('search-card-modal-open');
    hideExpandedSideCards();
  }

  function handleExpandedKeys(e) {
    const items = modalItems();
    if (items.length <= 1) return;
    const idx = currentModalIndex();
    if (e.key === 'ArrowLeft') { e.preventDefault(); selectProduct(items[(idx - 1 + items.length) % items.length]); }
    if (e.key === 'ArrowRight') { e.preventDefault(); selectProduct(items[(idx + 1) % items.length]); }
  }

  function autoMap(headers) {
    const hNorm = headers.map(h => norm(h));
    const out = {};
    for (const [key,, aliases] of fields) {
      let idx = hNorm.findIndex(h => aliases.some(a => h === norm(a)));
      if (idx < 0) idx = hNorm.findIndex(h => aliases.some(a => h.includes(norm(a)) || norm(a).includes(h)));
      out[key] = idx >= 0 ? headers[idx] : '';
    }
    return out;
  }

  function normalizeMapping(input) {
    if (Array.isArray(input)) {
      const out = {};
      input.forEach(row => {
        const key = row.key || row.field || row.target || row.name;
        const value = row.header || row.source || row.column || row.value;
        if (key) out[key] = value || '';
      });
      return out;
    }
    return input && typeof input === 'object' ? input : {};
  }

  function renderMapping() {
    const panel = $('#mappingPanel');
    if (!state.headers.length) {
      panel.innerHTML = '<div class="import-log">Aún no hay encabezados. Presiona “Leer encabezados”.</div>';
      return;
    }
    if (!Object.keys(state.mapping).length) state.mapping = autoMap(state.headers);
    panel.innerHTML = fields.map(([key,label]) => `
      <div class="map-card">
        <label>${esc(label)}
          <select data-map="${esc(key)}">
            <option value="">No usar</option>
            ${state.headers.map(h => `<option value="${esc(h)}" ${state.mapping[key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}
          </select>
        </label>
      </div>`).join('');
    $$('[data-map]', panel).forEach(sel => sel.addEventListener('change', () => { state.mapping[sel.dataset.map] = sel.value; }));
  }

  async function probeSheet() {
    requireAdmin();
    const url = $('#sheetUrl').value.trim();
    const sheet = $('#sheetName').value.trim() || 'Productos';
    if (!url) return toast('Coloca la URL del Sheet.', 'bad');
    $('#importLog').textContent = 'Leyendo encabezados...';
    try {
      const data = await api(`/sheets/probe?url=${encodeURIComponent(url)}&sheet=${encodeURIComponent(sheet)}`);
      state.headers = data.headers || [];
      state.mapping = autoMap(state.headers);
      renderMapping();
      $('#sheetStatus').textContent = `${state.headers.length} encabezados detectados`;
      $('#importLog').textContent = `Encabezados leídos desde ${data.source || 'Google Sheets'}. Filas detectadas: ${data.previewCount ?? '—'}`;
      await saveSheetMetadata(false);
    } catch (err) {
      $('#importLog').textContent = err.message;
      toast(err.message, 'bad');
    }
  }

  function mappedProducts(headers, rows) {
    const index = new Map(headers.map((h,i) => [h, i]));
    const get = (row, key) => {
      const header = state.mapping[key];
      const idx = index.get(header);
      return idx == null ? '' : String(row[idx] ?? '').trim();
    };
    return rows.map((row, i) => {
      const raw = {};
      headers.forEach((h, idx) => raw[h] = String(row[idx] ?? '').trim());
      const p = { id:`sheet-${i+1}`, raw };
      for (const [key] of fields) p[key] = get(row, key);
      if (!p.ubicacion) p.ubicacion = [p.zona, p.estante, p.nivel, p.slot].filter(Boolean).join('-');
      return p;
    }).filter(p => (p.nombre || p.sku || p.barras) && norm(p.nombre) !== 'producto');
  }

  async function saveSheetMetadata(withProducts, products = [], totalRows = 0) {
    const body = {
      sheet_id: $('#sheetUrl').value.trim(),
      sheet_name: $('#sheetName').value.trim() || 'Productos',
      source_type: 'google_sheet',
      sheet_headers: state.headers,
      sheet_header_index: 0,
      sheet_map_rows: state.mapping
    };
    if (withProducts) {
      body.imported_products = products;
      body.last_sheet_count = totalRows || products.length;
    }
    await api(`/branches/${state.branchId}/sheet`, { method:'POST', body: JSON.stringify(body) });
  }

  async function importSheet() {
    requireAdmin();
    const url = $('#sheetUrl').value.trim();
    const sheet = $('#sheetName').value.trim() || 'Productos';
    if (!url) return toast('Coloca la URL del Sheet.', 'bad');
    $('#importLog').textContent = 'Importando hasta 50,000 filas...';
    try {
      if (!state.headers.length) await probeSheet();
      const data = await api(`/sheets/rows?url=${encodeURIComponent(url)}&sheet=${encodeURIComponent(sheet)}&limit=50000`);
      state.headers = data.headers || state.headers;
      if (!Object.keys(state.mapping).length) state.mapping = autoMap(state.headers);
      const products = mappedProducts(state.headers, data.rows || []);
      await saveSheetMetadata(true, products, data.totalRows || products.length);
      $('#sheetStatus').textContent = `${products.length} productos importados`;
      $('#importLog').textContent = `Listo. Importados: ${products.length}\nFilas detectadas en Sheet: ${data.totalRows ?? products.length}\nFuente: ${data.source || 'Google Sheets'}`;
      state.page = 1;
      await loadProducts();
      setView('catalog');
      toast('Productos importados correctamente.');
    } catch (err) {
      $('#importLog').textContent = err.message;
      toast(err.message, 'bad');
    }
  }

  function requireAdmin() {
    if (!state.auth) {
      $('#authModal').classList.add('show');
      throw new Error('Necesitas iniciar sesión como administrador.');
    }
    if (!isAdmin()) {
      toast('Modo viewer: solo puedes observar el catálogo.', 'bad');
      throw new Error('Modo viewer sin permisos de edición.');
    }
  }

  async function createBranch() {
    requireAdmin();
    const name = $('#newBranchName').value.trim();
    if (!name) return toast('Coloca un nombre para la sucursal.', 'bad');
    const warehouses = $('#newBranchWarehouses').value.split(',').map(x => x.trim()).filter(Boolean);
    try {
      const data = await api('/branches', { method:'POST', body: JSON.stringify({ name, type: $('#newBranchType').value.trim() || 'catálogo', warehouses: warehouses.length ? warehouses : ['Principal'] }) });
      state.branchId = data.branch?.id;
      await loadBranches();
      toast('Sucursal creada.');
    } catch (err) { toast(err.message, 'bad'); }
  }

  async function generateViewerLink() {
    requireAdmin();
    if (!state.branchId) return toast('Selecciona una sucursal.', 'bad');
    try {
      const data = await api(`/branches/${state.branchId}/view-link`, { method:'POST', body:'{}' });
      $('#viewerLinkBox').textContent = data.url;
      await navigator.clipboard?.writeText(data.url).catch(() => null);
      toast('Link cliente generado y copiado.');
      setView('settings');
    } catch (err) { toast(err.message, 'bad'); }
  }

  function applySidebarState() {
    document.body.classList.toggle('sidebar-collapsed', !!state.sidebarCollapsed);
    const btn = $('#btnToggleSidebar');
    if (btn) {
      btn.textContent = state.sidebarCollapsed ? '☰' : '‹';
      btn.setAttribute('aria-label', state.sidebarCollapsed ? 'Expandir menú' : 'Minimizar menú');
      btn.title = state.sidebarCollapsed ? 'Expandir menú' : 'Minimizar menú';
    }
  }

  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    localStorage.setItem('catalogoSidebarCollapsed', state.sidebarCollapsed ? '1' : '0');
    applySidebarState();
  }


  setAuthMode('login');
  init();
})();
