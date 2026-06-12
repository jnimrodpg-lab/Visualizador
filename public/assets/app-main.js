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
    authMode: 'login',
    headers: [],
    mapping: {}
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

  function setView(name) {
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view${name[0].toUpperCase() + name.slice(1)}`)?.classList.add('active');
    $$('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  }

  function hydrateSessionLabel() {
    const pill = $('#sessionPill');
    if (state.publicMode) {
      pill.textContent = 'Link cliente público';
      $('#adminNav').classList.add('hidden');
      $('#btnAuth').classList.add('hidden');
      $('#btnGoSheet').classList.add('hidden');
      $('#btnShareViewer').classList.add('hidden');
      return;
    }
    const logged = !!state.auth;
    pill.textContent = logged ? `${state.auth.user} · ${state.auth.role}` : 'Sin sesión';
    $('#btnAuth').textContent = logged ? 'Cerrar sesión' : 'Ingresar admin';
    $('#adminNav').classList.toggle('hidden', !logged);
    $('#btnGoSheet').classList.toggle('hidden', !logged);
    $('#btnShareViewer').classList.toggle('hidden', !logged);
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
    $('#btnGoSheet').addEventListener('click', () => setView('sheet'));
    $('#btnAuth').addEventListener('click', authAction);
    $('#btnCloseAuth').addEventListener('click', () => $('#authModal').classList.remove('show'));
    $('#btnDoAuth').addEventListener('click', doAuth);
    $$('.auth-tab').forEach(btn => btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode)));
    $('#branchSelect').addEventListener('change', async () => { state.branchId = $('#branchSelect').value; state.page = 1; await loadSheetConfig(); await loadProducts(); });
    $('#btnReloadProducts').addEventListener('click', () => loadProducts());
    $('#btnSearch').addEventListener('click', () => { state.page = 1; loadProducts(); });
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
      mode: 'admin',
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
    const params = new URLSearchParams({ page: String(state.page), limit: String(PAGE_SIZE), q: $('#searchInput').value.trim() });
    const map = { filterBrand:'brand', filterCategory:'category', filterWarehouse:'warehouse', filterImage:'image_state' };
    Object.entries(map).forEach(([id,key]) => { const v = $(`#${id}`).value; if (v) params.set(key, v); });
    try {
      const data = await api(`/branches/${state.branchId}/products?${params}`);
      state.products = data.items || [];
      state.facets = data.facets || {};
      state.summary = data.summary || {};
      state.total = Number(data.total || 0);
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
    let list = state.products.filter(p => {
      const hay = norm(Object.values(p || {}).join(' '));
      if (terms.length && !terms.every(t => hay.includes(t))) return false;
      if (brand && norm(val(p,'marca')) !== brand) return false;
      if (category && norm(val(p,'categoria')) !== category) return false;
      if (warehouse && norm(val(p,'almacen')) !== warehouse) return false;
      if (imageState === 'with' && !mediaUrl(p)) return false;
      if (imageState === 'without' && mediaUrl(p)) return false;
      return true;
    });
    buildLocalFacets();
    state.total = list.length;
    state.totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = Math.min(state.page, state.totalPages);
    const slice = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
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
    $('#statTotal').textContent = state.summary.total ?? state.total ?? 0;
    $('#statImages').textContent = state.summary.with_image ?? 0;
    $('#statStock').textContent = state.summary.with_stock ?? 0;
    $('#resultSummary').textContent = `Mostrando ${state.products.length} de ${state.total || state.products.length} productos`;
    $('#pageSummary').textContent = `Página ${state.page} de ${state.totalPages}`;
    $('#paginationText').textContent = `Página ${state.page} / ${state.totalPages}`;
    $('#btnPrevPage').disabled = state.page <= 1;
    $('#btnNextPage').disabled = state.page >= state.totalPages;
  }

  function val(product, key) {
    const aliases = {
      sku:['sku','Sku','SKU'], nombre:['nombre','Nombre','name','producto'], variante:['variante','Variante','modelo','cod_modelo'], marca:['marca','brand'], categoria:['categoria','categoría','category'], almacen:['almacen','almacén','warehouse'], ubicacion:['ubicacion','ubicación','location'], stock:['stock','cantidad','cant','Cant. Restock'], imagen:['imagen','image','foto','url_imagen'], video:['video','link_video','url_video']
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

  function renderMedia(product, mode = 'card') {
    const video = videoUrl(product);
    const img = val(product,'imagen');
    const src = video || img;
    if (!src) return `<div class="media-empty">Sin imagen</div>`;
    const id = driveId(src);
    if (video) {
      if (/youtube\.com|youtu\.be/.test(src)) {
        const yt = (src.match(/[?&]v=([^&]+)/) || src.match(/youtu\.be\/([^?]+)/) || [])[1];
        if (yt) return `<iframe loading="lazy" src="https://www.youtube.com/embed/${esc(yt)}" allowfullscreen></iframe>`;
      }
      if (id) return `<iframe loading="lazy" src="https://drive.google.com/file/d/${esc(id)}/preview" allowfullscreen></iframe>`;
      if (/\.mp4($|\?)/i.test(src)) return `<video src="${esc(src)}" controls ${mode === 'card' ? 'muted' : ''}></video>`;
    }
    const finalSrc = id ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1200` : src;
    return `<img src="${esc(finalSrc)}" alt="${esc(val(product,'nombre') || 'Producto')}" loading="lazy" onerror="this.closest('.featured-media,.product-card-media').innerHTML='<div class=&quot;media-empty&quot;>Imagen no disponible</div>'">`;
  }

  function renderProducts(products) {
    const grid = $('#productGrid');
    if (!products.length) {
      renderEmptyState('No hay productos para mostrar. Revisa la búsqueda o importa tu Sheet.');
      return;
    }
    grid.innerHTML = products.map((p, idx) => `
      <article class="product-card" data-index="${idx}" tabindex="0">
        <div class="product-card-media">${renderMedia(p, 'card')}</div>
        <div class="product-card-body">
          <div class="sku">${esc(val(p,'sku') || val(p,'barras') || 'Sin SKU')}</div>
          <h3>${esc(val(p,'nombre') || 'Producto sin nombre')}</h3>
          <div class="card-tags">
            ${[val(p,'marca'), val(p,'variante'), val(p,'color'), val(p,'talla'), val(p,'ubicacion'), val(p,'almacen')].filter(Boolean).slice(0,6).map(x => `<span>${esc(x)}</span>`).join('')}
          </div>
        </div>
      </article>`).join('');
    $$('.product-card', grid).forEach(card => {
      const pick = () => selectProduct(products[Number(card.dataset.index)]);
      card.addEventListener('click', pick);
      card.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
    });
    selectProduct(state.selected && products.find(p => val(p,'sku') === val(state.selected,'sku')) ? state.selected : products[0]);
  }

  function renderEmptyState(message) {
    $('#productGrid').innerHTML = `<div class="empty-grid">${esc(message)}</div>`;
    $('#resultSummary').textContent = 'Mostrando 0 productos';
  }

  function selectProduct(product) {
    state.selected = product;
    $('#featuredMedia').innerHTML = renderMedia(product, 'featured');
    $('#featuredBrand').textContent = val(product,'marca') || val(product,'categoria') || 'Producto';
    $('#featuredName').textContent = val(product,'nombre') || 'Producto sin nombre';
    $('#featuredSku').textContent = `SKU ${val(product,'sku') || '—'}`;
    $('#featuredVariant').textContent = val(product,'variante') || '—';
    $('#featuredColor').textContent = product.color || '—';
    $('#featuredSize').textContent = product.talla || '—';
    $('#featuredLocation').textContent = val(product,'ubicacion') || [product.zona, product.estante, product.nivel, product.slot].filter(Boolean).join(' · ') || '—';
    $('#featuredWarehouse').textContent = val(product,'almacen') || '—';
    $('#featuredStock').textContent = val(product,'stock') || '—';
    const raw = product.raw && typeof product.raw === 'object' ? product.raw : product;
    $('#featuredRaw').innerHTML = Object.entries(raw).filter(([,v]) => String(v ?? '').trim()).slice(0,18).map(([k,v]) => `<span>${esc(k)}: ${esc(v)}</span>`).join('');
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

  setAuthMode('login');
  init();
})();
