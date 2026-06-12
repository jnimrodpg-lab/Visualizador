const BUILD_MARK = 'cloudflare-v10-drive-video-proxy';

const COOKIE_NAME = 'wms.sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_COMPANY_NAME = 'WMS Control';
const DEFAULT_COMPANY_CODE = 'WMS-CF';

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  const rawPath = Array.isArray(params.path)
    ? params.path.join('/')
    : String(params.path || '');

  const path = '/' + rawPath.replace(/^\/+/, '').replace(/\/+$/, '');

  try {
    await ensureSchema(env.DB, env);

    if (request.method === 'OPTIONS') {
      return withJson({ ok: true });
    }

    if (path === '/healthz' && request.method === 'GET') {
      return withJson({
        ok: true,
        status: 'ok',
        runtime: 'cloudflare-pages',
        build: BUILD_MARK
      });
    }

    if (path === '/drive-video' && request.method === 'GET') {
      await requireAuth(request, env.DB);
      return proxyGoogleDriveVideo(request, url);
    }

    if (path === '/session' && request.method === 'GET') {
      const session = await getSession(request, env.DB);
      if (!session) return withJson({ ok: false, build: BUILD_MARK }, 401);
      const company = await getCompanyById(env.DB, session.company_id);
      return withJson({
        ok: true,
        user: session.username,
        role: session.role,
        company_name: company?.name || DEFAULT_COMPANY_NAME,
        company_code: company?.code || DEFAULT_COMPANY_CODE,
        build: BUILD_MARK
      });
    }

    if (path === '/login' && request.method === 'POST') {
      const body = await readJson(request);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) {
        return withJson({ ok: false, error: 'Completa usuario y contraseña', build: BUILD_MARK }, 400);
      }

      const user = await getUserByUsername(env.DB, username);
      if (!user || !(await verifyPassword(user.password_hash, password))) {
        return withJson({ ok: false, error: 'Credenciales inválidas', build: BUILD_MARK }, 401);
      }

      const company = await getCompanyById(env.DB, user.company_id);
      const sid = await createSession(env.DB, {
        user_id: user.id,
        username: user.username,
        role: user.role,
        company_id: user.company_id
      });

      return withJson({
        ok: true,
        user: user.username,
        role: user.role,
        company_name: company?.name || DEFAULT_COMPANY_NAME,
        company_code: company?.code || DEFAULT_COMPANY_CODE,
        build: BUILD_MARK
      }, 200, [makeSessionCookie(sid)]);
    }

    if (path === '/register' && request.method === 'POST') {
      const body = await readJson(request);
      const mode = String(body.mode || 'admin').trim().toLowerCase();
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const companyName = String(body.companyName || '').trim() || 'Nueva empresa';
      const companyCode = String(body.companyCode || '').trim().toUpperCase();

      if (!username || !password) {
        return withJson({ ok: false, error: 'Completa usuario y contraseña', build: BUILD_MARK }, 400);
      }

      const existing = await getUserByUsername(env.DB, username);
      if (existing) return withJson({ ok: false, error: 'Ese usuario ya existe', build: BUILD_MARK }, 400);

      const created = await createCompanyBundle(env.DB, {
        companyName,
        username,
        password,
        role: mode === 'viewer' ? 'viewer' : 'admin',
        companyCode
      });

      const company = await getCompanyById(env.DB, created.companyId);
      const sid = await createSession(env.DB, {
        user_id: created.userId,
        username,
        role: mode === 'viewer' ? 'viewer' : 'admin',
        company_id: created.companyId
      });

      return withJson({
        ok: true,
        user: username,
        role: mode === 'viewer' ? 'viewer' : 'admin',
        company_name: company?.name || companyName,
        company_code: company?.code || '',
        message: mode === 'viewer'
          ? 'Cuenta visualizadora creada.'
          : 'Cuenta administradora creada.',
        build: BUILD_MARK
      }, 200, [makeSessionCookie(sid)]);
    }

    if (path === '/logout' && request.method === 'POST') {
      const sid = readCookie(request, COOKIE_NAME);
      if (sid) {
        await env.DB.prepare('DELETE FROM sessions_store WHERE sid = ?').bind(sid).run();
      }
      return withJson({ ok: true, build: BUILD_MARK }, 200, [clearSessionCookie()]);
    }

    if (path === '/app-state' && request.method === 'GET') {
      const session = await getSession(request, env.DB, true);
      const companyId = session?.company_id || 1;
      const stored = await getStoredAppState(env.DB, companyId);
      return withJson({
        ok: true,
        state: stored || (await buildFallbackAppState(env.DB, companyId)),
        build: BUILD_MARK
      });
    }

    if (path === '/app-state' && request.method === 'POST') {
      const session = await requireAuth(request, env.DB);
      if (session.error) return session.error;

      const body = await readJson(request);
      const admin = body.admin && typeof body.admin === 'object' ? body.admin : null;
      const models = Array.isArray(body.models) ? body.models : null;
      const branchLayouts = body.branchLayouts && typeof body.branchLayouts === 'object'
        ? body.branchLayouts
        : null;

      await env.DB.prepare(`
        INSERT INTO app_state_blobs (company_id, admin_json, rack_models_json, branch_layouts_json, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(company_id) DO UPDATE SET
          admin_json = excluded.admin_json,
          rack_models_json = excluded.rack_models_json,
          branch_layouts_json = excluded.branch_layouts_json,
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        session.company_id,
        JSON.stringify(admin),
        JSON.stringify(models),
        JSON.stringify(branchLayouts)
      ).run();

      const companyName = String(admin?.company || '').trim();
      if (companyName) {
        await env.DB.prepare(
          'UPDATE companies SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(companyName, session.company_id).run();
      }

      const companyCode = String(admin?.companyCode || '').trim();
      if (companyCode) {
        await env.DB.prepare(
          'UPDATE companies SET code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(companyCode, session.company_id).run();
      }

      return withJson({ ok: true, build: BUILD_MARK });
    }

    if (path === '/branches' && request.method === 'GET') {
      const session = await requireAuth(request, env.DB);
      if (session.error) return session.error;

      const rows = await all(
        env.DB.prepare(
          'SELECT * FROM branches WHERE active = 1 AND company_id = ? ORDER BY id ASC'
        ).bind(session.company_id)
      );

      return withJson({ branches: rows.map(normalizeBranch), build: BUILD_MARK });
    }

    if (path === '/branches' && request.method === 'POST') {
      const session = await requireAdmin(request, env.DB);
      if (session.error) return session.error;

      const body = await readJson(request);
      const name = String(body.name || '').trim();
      const type = String(body.type || 'tienda').trim() || 'tienda';
      const slug = String(body.slug || slugify(name || `sucursal-${Date.now()}`)).trim();
      const warehouses = Array.isArray(body.warehouses) ? body.warehouses : ['Almacén principal'];
      const canvasWidth = Number(body.canvas_width || 900);
      const canvasHeight = Number(body.canvas_height || 620);

      if (!name) return withJson({ error: 'El nombre es obligatorio', build: BUILD_MARK }, 400);

      const safeSlug = await uniqueSlug(env.DB, slug, session.company_id);
      const info = await env.DB.prepare(`
        INSERT INTO branches (company_id, name, type, slug, warehouses_json, canvas_width, canvas_height, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(
        session.company_id,
        name,
        type,
        safeSlug,
        JSON.stringify(warehouses),
        canvasWidth,
        canvasHeight
      ).run();

      const branchId = Number(info.meta.last_row_id);
      await ensureBranchScaffolding(env.DB, branchId, canvasWidth, canvasHeight);

      return withJson({
        ok: true,
        branch: await getOwnedBranch(env.DB, session.company_id, branchId),
        build: BUILD_MARK
      });
    }

    const branchIdMatch = path.match(/^\/branches\/(\d+)(?:\/(.+))?$/);
    if (branchIdMatch) {
      const branchId = Number(branchIdMatch[1]);
      const tail = branchIdMatch[2]
        ? '/' + branchIdMatch[2].replace(/^\/+|\/+$/g, '')
        : '';

      if (!tail && request.method === 'PUT') {
        const session = await requireAdmin(request, env.DB);
        if (session.error) return session.error;

        const existing = await getOwnedBranch(env.DB, session.company_id, branchId);
        if (!existing) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);

        const body = await readJson(request);
        const name = String(body.name || existing.name).trim();
        const type = String(body.type || existing.type).trim() || existing.type;
        const slug = await uniqueSlug(
          env.DB,
          String(body.slug || existing.slug).trim(),
          session.company_id,
          branchId
        );
        const warehouses = Array.isArray(body.warehouses) ? body.warehouses : existing.warehouses;
        const canvasWidth = Number(body.canvas_width || existing.canvas_width || 900);
        const canvasHeight = Number(body.canvas_height || existing.canvas_height || 620);

        await env.DB.prepare(`
          UPDATE branches
          SET name = ?, type = ?, slug = ?, warehouses_json = ?, canvas_width = ?, canvas_height = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          name,
          type,
          slug,
          JSON.stringify(warehouses),
          canvasWidth,
          canvasHeight,
          branchId
        ).run();

        return withJson({
          ok: true,
          branch: await getOwnedBranch(env.DB, session.company_id, branchId),
          build: BUILD_MARK
        });
      }

      if (!tail && request.method === 'DELETE') {
        const session = await requireAdmin(request, env.DB);
        if (session.error) return session.error;

        const existing = await getOwnedBranch(env.DB, session.company_id, branchId);
        if (!existing) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);

        const total = await firstValue(
          env.DB.prepare('SELECT COUNT(*) AS total FROM branches WHERE active = 1 AND company_id = ?')
            .bind(session.company_id),
          'total'
        );

        if (Number(total || 0) <= 1) {
          return withJson({ error: 'Debe quedar al menos una sucursal', build: BUILD_MARK }, 400);
        }

        await env.DB.prepare('DELETE FROM branches WHERE id = ?').bind(branchId).run();
        return withJson({ ok: true, build: BUILD_MARK });
      }

      if (tail === '/layout' && request.method === 'GET') {
        const session = await requireAuth(request, env.DB);
        if (session.error) return session.error;

        const branch = await getOwnedBranch(env.DB, session.company_id, branchId);
        if (!branch) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);

        await ensureBranchScaffolding(env.DB, branchId, branch.canvas_width, branch.canvas_height);

        const row = await first(
          env.DB.prepare('SELECT layout_json, viewbox_json, updated_at FROM branch_layouts WHERE branch_id = ?')
            .bind(branchId)
        );
        if (!row) return withJson({ error: 'Layout no encontrado', build: BUILD_MARK }, 404);

        return withJson({
          ok: true,
          layout: {
            layout: safeJsonParse(row.layout_json, defaultLayout()),
            viewBox: safeJsonParse(row.viewbox_json, {
              x: 0,
              y: 0,
              w: branch.canvas_width || 900,
              h: branch.canvas_height || 620
            }),
            updated_at: row.updated_at
          },
          build: BUILD_MARK
        });
      }

      if (tail === '/layout' && request.method === 'POST') {
        const session = await requireAdmin(request, env.DB);
        if (session.error) return session.error;

        const branch = await getOwnedBranch(env.DB, session.company_id, branchId);
        if (!branch) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);

        const payload = await readJson(request);
        const layout = payload.layout && typeof payload.layout === 'object'
          ? payload.layout
          : defaultLayout();
        const viewBox = payload.viewBox && typeof payload.viewBox === 'object'
          ? payload.viewBox
          : { x: 0, y: 0, w: branch.canvas_width || 900, h: branch.canvas_height || 620 };

        await ensureBranchScaffolding(env.DB, branchId, branch.canvas_width || 900, branch.canvas_height || 620);

        await env.DB.prepare(`
          UPDATE branch_layouts
          SET layout_json = ?, viewbox_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE branch_id = ?
        `).bind(JSON.stringify(layout), JSON.stringify(viewBox), branchId).run();

        return withJson({ ok: true, build: BUILD_MARK });
      }

      if (tail === '/sheet' && request.method === 'GET') {
        const session = await requireAuth(request, env.DB);
        if (session.error) return session.error;

        const branch = await getOwnedBranch(env.DB, session.company_id, branchId);
        if (!branch) return withJson({
          ok: false,
          error: 'Sucursal no encontrada',
          build: BUILD_MARK,
          debug: { path, rawPath, paramsPath: params.path, branchId, tail }
        }, 404);

        await ensureBranchScaffolding(env.DB, branchId, branch.canvas_width, branch.canvas_height);

        const row = await first(
          env.DB.prepare(`
            SELECT sheet_id, sheet_name, source_type, updated_at, sheet_map_json, imported_products_json,
                   last_sheet_count, sheet_headers_json, sheet_header_index
            FROM branch_sheet_config
            WHERE branch_id = ?
          `).bind(branchId)
        );

        const config = row || {
          sheet_id: '',
          sheet_name: 'Productos',
          source_type: 'google_sheet',
          sheet_map_json: null,
          imported_products_json: '[]',
          last_sheet_count: 0,
          sheet_headers_json: '[]',
          sheet_header_index: 0
        };

        return withJson({
          ok: true,
          config: {
            ...config,
            sheet_map_rows: safeJsonParse(config.sheet_map_json, null),
            imported_products: safeJsonParse(config.imported_products_json, []),
            sheet_headers: safeJsonParse(config.sheet_headers_json, []),
            sheet_header_index: Number(config.sheet_header_index || 0)
          },
          build: BUILD_MARK,
          debug: { path, rawPath, paramsPath: params.path, branchId, tail }
        });
      }

      if (tail === '/sheet' && request.method === 'POST') {
        const session = await requireAdmin(request, env.DB);
        if (session.error) return session.error;

        const branch = await getOwnedBranch(env.DB, session.company_id, branchId);
        if (!branch) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);

        const body = await readJson(request);
        await ensureBranchScaffolding(env.DB, branchId, branch.canvas_width, branch.canvas_height);

        const current = await first(
          env.DB.prepare(`
            SELECT sheet_id, sheet_name, source_type, sheet_map_json, imported_products_json,
                   last_sheet_count, sheet_headers_json, sheet_header_index
            FROM branch_sheet_config
            WHERE branch_id = ?
          `).bind(branchId)
        ) || {};

        const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

        const sheet_id = has('sheet_id') ? String(body.sheet_id || '') : String(current.sheet_id || '');
        const sheet_name = has('sheet_name') ? String(body.sheet_name || 'Productos') : String(current.sheet_name || 'Productos');
        const source_type = has('source_type') ? String(body.source_type || 'google_sheet') : String(current.source_type || 'google_sheet');
        const sheet_map_rows = has('sheet_map_rows') ? body.sheet_map_rows : safeJsonParse(current.sheet_map_json, null);
        const imported_products = has('imported_products') ? body.imported_products : safeJsonParse(current.imported_products_json, []);
        const last_sheet_count = has('last_sheet_count') ? Number(body.last_sheet_count || 0) : Number(current.last_sheet_count || 0);
        const sheet_headers = has('sheet_headers') ? body.sheet_headers : safeJsonParse(current.sheet_headers_json, []);
        const sheet_header_index = has('sheet_header_index') ? Number(body.sheet_header_index || 0) : Number(current.sheet_header_index || 0);

        await env.DB.prepare(`
          UPDATE branch_sheet_config
          SET sheet_id = ?, sheet_name = ?, source_type = ?, sheet_map_json = ?, imported_products_json = ?,
              last_sheet_count = ?, sheet_headers_json = ?, sheet_header_index = ?, updated_at = CURRENT_TIMESTAMP
          WHERE branch_id = ?
        `).bind(
          sheet_id,
          sheet_name,
          source_type,
          JSON.stringify(sheet_map_rows),
          JSON.stringify(Array.isArray(imported_products) ? imported_products.slice(0, 50000) : []),
          last_sheet_count,
          JSON.stringify(Array.isArray(sheet_headers) ? sheet_headers : []),
          sheet_header_index,
          branchId
        ).run();

        return withJson({ ok: true, build: BUILD_MARK });
      }

      if (tail === '/sheet-metadata' && request.method === 'POST') {
        const session = await requireAdmin(request, env.DB);
        if (session.error) return session.error;

        const branch = await getOwnedBranch(env.DB, session.company_id, branchId);
        if (!branch) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);

        const body = await readJson(request);
        await ensureBranchScaffolding(env.DB, branchId, branch.canvas_width, branch.canvas_height);

        const current = await first(
          env.DB.prepare(`
            SELECT sheet_id, sheet_name, source_type, sheet_map_json, imported_products_json,
                   last_sheet_count, sheet_headers_json, sheet_header_index
            FROM branch_sheet_config
            WHERE branch_id = ?
          `).bind(branchId)
        ) || {};

        const sheet_id = String(body.sheet_id != null ? body.sheet_id : (current.sheet_id || ''));
        const sheet_name = String(body.sheet_name != null ? body.sheet_name : (current.sheet_name || 'Productos'));
        const source_type = String(body.source_type != null ? body.source_type : (current.source_type || 'google_sheet'));
        const sheet_map_rows = Array.isArray(body.sheet_map_rows) ? body.sheet_map_rows : safeJsonParse(current.sheet_map_json, null);
        const imported_products = safeJsonParse(current.imported_products_json, []);
        const last_sheet_count = Number(current.last_sheet_count || (Array.isArray(imported_products) ? imported_products.length : 0) || 0);
        const sheet_headers = Array.isArray(body.sheet_headers) ? body.sheet_headers : safeJsonParse(current.sheet_headers_json, []);
        const sheet_header_index = Number(body.sheet_header_index != null ? body.sheet_header_index : (current.sheet_header_index || 0));

        await env.DB.prepare(`
          UPDATE branch_sheet_config
          SET sheet_id = ?, sheet_name = ?, source_type = ?, sheet_map_json = ?, imported_products_json = ?,
              last_sheet_count = ?, sheet_headers_json = ?, sheet_header_index = ?, updated_at = CURRENT_TIMESTAMP
          WHERE branch_id = ?
        `).bind(
          sheet_id,
          sheet_name,
          source_type,
          JSON.stringify(sheet_map_rows),
          JSON.stringify(Array.isArray(imported_products) ? imported_products.slice(0, 50000) : []),
          last_sheet_count,
          JSON.stringify(Array.isArray(sheet_headers) ? sheet_headers : []),
          sheet_header_index,
          branchId
        ).run();

        return withJson({
          ok: true,
          preserved_products: Array.isArray(imported_products) ? imported_products.length : 0,
          build: BUILD_MARK
        });
      }


      if (tail === '/products' && request.method === 'GET') {
        const session = await requireAuth(request, env.DB);
        if (session.error) return session.error;
        const effectiveCompanyId = session.company_id || 1;
        const branch = await getOwnedBranch(env.DB, effectiveCompanyId, branchId);
        if (!branch) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);

        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 120) || 120));
        const q = String(url.searchParams.get('q') || '').trim();
        const filters = {
          brand: url.searchParams.get('brand') || '',
          category: url.searchParams.get('category') || '',
          zone: url.searchParams.get('zone') || '',
          warehouse: url.searchParams.get('warehouse') || '',
          rack: url.searchParams.get('rack') || '',
          image_state: url.searchParams.get('image_state') || '',
          location_state: url.searchParams.get('location_state') || '',
          stock_state: url.searchParams.get('stock_state') || ''
        };

        const products = await getImportedProductsForBranch(env.DB, branchId);
        const filtered = filterImportedProducts(products, q, filters);
        const groupBy = String(url.searchParams.get('group_by') || '').trim().toLowerCase();
        let output = filtered;
        let grouped = false;
        let groupTotalProducts = filtered.length;

        if (groupBy === 'name' || groupBy === 'nombre') {
          output = groupProductsByName(filtered);
          grouped = true;
        }

        const total = output.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * limit;
        const items = output.slice(start, start + limit);

        return withJson({
          ok: true,
          items,
          total,
          page: safePage,
          limit,
          total_pages: totalPages,
          grouped,
          group_total_products: groupTotalProducts,
          facets: buildProductFacets(products),
          summary: buildProductSummary(products),
          build: BUILD_MARK
        });
      }

      if (tail === '/products-summary' && request.method === 'GET') {
        const session = await requireAuth(request, env.DB);
        if (session.error) return session.error;
        const effectiveCompanyId = session.company_id || 1;
        const branch = await getOwnedBranch(env.DB, effectiveCompanyId, branchId);
        if (!branch) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);
        const products = await getImportedProductsForBranch(env.DB, branchId);
        return withJson({
          ok: true,
          summary: buildProductSummary(products),
          facets: buildProductFacets(products),
          build: BUILD_MARK
        });
      }

      if (tail === '/view-link' && request.method === 'POST') {
        const session = await requireAdmin(request, env.DB);
        if (session.error) return session.error;

        const branch = await getOwnedBranch(env.DB, session.company_id, branchId);
        if (!branch) return withJson({ error: 'Sucursal no encontrada', build: BUILD_MARK }, 404);

        let existing = await first(
          env.DB.prepare('SELECT token FROM viewer_links WHERE branch_id = ? AND active = 1 ORDER BY id DESC LIMIT 1')
            .bind(branchId)
        );

        if (!existing) {
          const token = generateToken();
          await env.DB.prepare('INSERT INTO viewer_links (branch_id, token, active) VALUES (?, ?, 1)')
            .bind(branchId, token)
            .run();
          existing = { token };
        }

        const base = `${url.protocol}//${url.host}`;
        return withJson({ ok: true, token: existing.token, url: `${base}/viewer/${existing.token}`, build: BUILD_MARK });
      }
    }

    const tokenMatch = path.match(/^\/view-links\/([^/]+)$/);
    if (tokenMatch && request.method === 'GET') {
      const token = decodeURIComponent(tokenMatch[1]);
      const link = await first(
        env.DB.prepare('SELECT * FROM viewer_links WHERE token = ? AND active = 1').bind(token)
      );
      if (!link) return withJson({ error: 'Link no encontrado o inactivo', build: BUILD_MARK }, 404);

      const branch = await getBranchById(env.DB, link.branch_id);
      const layout = await first(
        env.DB.prepare('SELECT layout_json, viewbox_json FROM branch_layouts WHERE branch_id = ?')
          .bind(link.branch_id)
      );
      const sheet = await first(
        env.DB.prepare(`
          SELECT sheet_id, sheet_name, source_type, imported_products_json, last_sheet_count,
                 sheet_map_json, sheet_headers_json, sheet_header_index, updated_at
          FROM branch_sheet_config
          WHERE branch_id = ?
        `).bind(link.branch_id)
      );

      const importedProducts = safeJsonParse(sheet?.imported_products_json, []);
      return withJson({
        ok: true,
        branch,
        layout: {
          layout: safeJsonParse(layout?.layout_json, defaultLayout()),
          viewBox: safeJsonParse(layout?.viewbox_json, {
            x: 0,
            y: 0,
            w: branch?.canvas_width || 900,
            h: branch?.canvas_height || 620
          })
        },
        sheet: {
          ...(sheet || { sheet_id: '', sheet_name: 'Productos', source_type: 'google_sheet' }),
          imported_products: importedProducts,
          last_sheet_count: Number(sheet?.last_sheet_count || importedProducts.length || 0),
          sheet_map_rows: safeJsonParse(sheet?.sheet_map_json, null),
          sheet_headers: safeJsonParse(sheet?.sheet_headers_json, []),
          sheet_header_index: Number(sheet?.sheet_header_index || 0)
        },
        build: BUILD_MARK
      });
    }

    if (path === '/sheets/meta' && request.method === 'GET') {
      const sheetId = parseSheetId(url.searchParams.get('url') || '');
      if (!sheetId) return withJson({ error: 'URL/ID inválido', build: BUILD_MARK }, 400);
      const meta = await fetchSheetMeta(sheetId);
      return withJson({ ok: true, ...meta, build: BUILD_MARK });
    }

    if (path === '/sheets/probe' && request.method === 'GET') {
      const response = await handleSheetProbe(url);
      return response;
    }

    if (path === '/sheets/rows' && request.method === 'GET') {
      const response = await handleSheetRows(url);
      return response;
    }

    return withJson({
      ok: false,
      error: 'No encontrado',
      build: BUILD_MARK,
      debug: { path, rawPath, paramsPath: params.path }
    }, 404);
  } catch (err) {
    return withJson({
      ok: false,
      error: err?.message || 'Error interno',
      build: BUILD_MARK,
      debug: { path, rawPath, paramsPath: params.path }
    }, 500);
  }
}

async function ensureSchema(db, env) {
  if (env.__SCHEMA_READY) return;

  const now = new Date().toISOString();
  const defaultAdminUser = String(env.ADMIN_USERNAME || 'admin');
  const defaultAdminPassword = String(env.ADMIN_PASSWORD || 'admin123');
  const defaultCompanyName = String(env.DEFAULT_COMPANY_NAME || DEFAULT_COMPANY_NAME);
  const defaultCompanyCode = String(env.DEFAULT_COMPANY_CODE || DEFAULT_COMPANY_CODE);
  const defaultHash = await hashPassword(defaultAdminPassword);

  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS admin_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      company_name TEXT DEFAULT '${escapeSql(defaultCompanyName)}',
      company_id INTEGER
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'tienda',
      slug TEXT NOT NULL,
      warehouses_json TEXT NOT NULL DEFAULT '[]',
      canvas_width INTEGER NOT NULL DEFAULT 900,
      canvas_height INTEGER NOT NULL DEFAULT 620,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, slug)
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS branch_sheet_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL UNIQUE,
      sheet_id TEXT,
      sheet_name TEXT DEFAULT 'Productos',
      source_type TEXT DEFAULT 'google_sheet',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sheet_map_json TEXT,
      imported_products_json TEXT,
      last_sheet_count INTEGER NOT NULL DEFAULT 0,
      sheet_headers_json TEXT,
      sheet_header_index INTEGER NOT NULL DEFAULT 0
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS branch_layouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL UNIQUE,
      layout_json TEXT NOT NULL,
      viewbox_json TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS viewer_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS app_state_blobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL UNIQUE,
      admin_json TEXT,
      rack_models_json TEXT,
      branch_layouts_json TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS sessions_store (
      sid TEXT PRIMARY KEY,
      sess_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
  ]);

  await db.prepare(`
    INSERT INTO system_meta (key, value, updated_at)
    VALUES ('last_boot_at', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind(now).run();

  await db.prepare(`
    INSERT INTO system_meta (key, value, updated_at)
    VALUES ('db_path', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind('cloudflare-d1').run();

  await db.prepare(`
    INSERT INTO companies (id, name, code, updated_at)
    VALUES (1, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `).bind(defaultCompanyName, defaultCompanyCode).run();

  await db.prepare(`
    INSERT INTO admin_config (id, username, password_hash, company_name, company_id)
    VALUES (1, ?, ?, ?, 1)
    ON CONFLICT(id) DO NOTHING
  `).bind(defaultAdminUser, defaultHash, defaultCompanyName).run();

  await db.prepare(`
    INSERT INTO users (company_id, username, password_hash, role, updated_at)
    VALUES (1, ?, ?, 'admin', CURRENT_TIMESTAMP)
    ON CONFLICT(username) DO NOTHING
  `).bind(defaultAdminUser, defaultHash).run();

  const branchCount = Number(
    await firstValue(
      db.prepare('SELECT COUNT(*) AS total FROM branches WHERE company_id = 1'),
      'total'
    ) || 0
  );

  if (branchCount === 0) {
    const result = await db.prepare(`
      INSERT INTO branches (company_id, name, type, slug, warehouses_json, canvas_width, canvas_height, updated_at)
      VALUES (1, 'Sucursal principal', 'tienda', 'sucursal-principal', ?, 900, 620, CURRENT_TIMESTAMP)
    `).bind(JSON.stringify(['Almacén principal'])).run();

    const branchId = Number(result.meta.last_row_id);
    await ensureBranchScaffolding(db, branchId, 900, 620);

    await db.prepare(`
      INSERT INTO app_state_blobs (company_id, admin_json, rack_models_json, branch_layouts_json, updated_at)
      VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(company_id) DO NOTHING
    `).bind(
      JSON.stringify({
        company: defaultCompanyName,
        companyCode: defaultCompanyCode,
        logo: '',
        branches: [{
          id: branchId,
          name: 'Sucursal principal',
          type: 'tienda',
          color: '#ffd84d',
          warehouses: ['Almacén principal'],
          sheetUrl: '',
          sheetName: 'Productos',
          sheetConnected: false,
          lastSheetCount: 0,
          sheetHeaders: [],
          sheetStatusText: '',
          sheetHeaderIndex: 0,
          sheetPreviewProducts: [],
          sheetMapRows: null,
          cardConfig: null
        }],
        activeBranch: 0
      }),
      JSON.stringify(null),
      JSON.stringify({ '0': defaultLayout() })
    ).run();
  }

  env.__SCHEMA_READY = true;
}

async function ensureBranchScaffolding(db, branchId, width = 900, height = 620) {
  const layout = await first(db.prepare('SELECT id FROM branch_layouts WHERE branch_id = ?').bind(branchId));
  if (!layout) {
    await db.prepare(`
      INSERT INTO branch_layouts (branch_id, layout_json, viewbox_json, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
      branchId,
      JSON.stringify(defaultLayout()),
      JSON.stringify({ x: 0, y: 0, w: width, h: height })
    ).run();
  }

  const sheet = await first(db.prepare('SELECT id FROM branch_sheet_config WHERE branch_id = ?').bind(branchId));
  if (!sheet) {
    await db.prepare(`
      INSERT INTO branch_sheet_config (
        branch_id, sheet_id, sheet_name, source_type, sheet_map_json,
        imported_products_json, last_sheet_count, sheet_headers_json, sheet_header_index, updated_at
      ) VALUES (?, '', 'Productos', 'google_sheet', ?, ?, 0, ?, 0, CURRENT_TIMESTAMP)
    `).bind(
      branchId,
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify([])
    ).run();
  }
}

async function createCompanyBundle(db, { companyName, username, password, role = 'admin', companyCode = null }) {
  if (role === 'viewer') {
    const company = await first(db.prepare('SELECT * FROM companies WHERE code = ?').bind(companyCode));
    if (!company) throw new Error('Código de empresa inválido');

    const hash = await hashPassword(password);
    const info = await db.prepare(`
      INSERT INTO users (company_id, username, password_hash, role, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(company.id, username, hash, 'viewer').run();

    return { companyId: Number(company.id), code: company.code, userId: Number(info.meta.last_row_id) };
  }

  const code = await uniqueCompanyCode(db, companyName);
  const companyInfo = await db.prepare(`
    INSERT INTO companies (name, code, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).bind(companyName, code).run();

  const companyId = Number(companyInfo.meta.last_row_id);

  const branchInfo = await db.prepare(`
    INSERT INTO branches (company_id, name, type, slug, warehouses_json, canvas_width, canvas_height, updated_at)
    VALUES (?, 'Sucursal principal', 'tienda', 'sucursal-principal', ?, 900, 620, CURRENT_TIMESTAMP)
  `).bind(companyId, JSON.stringify(['Almacén principal'])).run();

  const branchId = Number(branchInfo.meta.last_row_id);
  await ensureBranchScaffolding(db, branchId, 900, 620);

  await db.prepare(`
    INSERT INTO app_state_blobs (company_id, admin_json, rack_models_json, branch_layouts_json, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    companyId,
    JSON.stringify({
      company: companyName,
      companyCode: code,
      logo: '',
      branches: [{
        id: branchId,
        name: 'Sucursal principal',
        type: 'tienda',
        color: '#ffd84d',
        warehouses: ['Almacén principal'],
        sheetUrl: '',
        sheetName: 'Productos',
        sheetConnected: false,
        lastSheetCount: 0,
        sheetHeaders: [],
        sheetStatusText: '',
        sheetHeaderIndex: 0,
        sheetPreviewProducts: [],
        sheetMapRows: null,
        cardConfig: null
      }],
      activeBranch: 0
    }),
    JSON.stringify(null),
    JSON.stringify({ '0': defaultLayout() })
  ).run();

  const hash = await hashPassword(password);
  const userInfo = await db.prepare(`
    INSERT INTO users (company_id, username, password_hash, role, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(companyId, username, hash, 'admin').run();

  return { companyId, code, userId: Number(userInfo.meta.last_row_id) };
}

async function buildFallbackAppState(db, companyId = 1) {
  const admin = await buildAdminStateFromDb(db, companyId, null);
  const branches = await all(
    db.prepare('SELECT * FROM branches WHERE active = 1 AND company_id = ? ORDER BY id ASC')
      .bind(companyId)
  );

  const branchLayouts = {};
  for (let index = 0; index < branches.length; index += 1) {
    const row = branches[index];
    const layoutRow = await first(
      db.prepare('SELECT layout_json FROM branch_layouts WHERE branch_id = ?').bind(row.id)
    );
    branchLayouts[index] = safeJsonParse(layoutRow?.layout_json, defaultLayout());
  }

  return { admin, models: null, branchLayouts };
}

async function getStoredAppState(db, companyId = 1) {
  const row = await first(
    db.prepare('SELECT admin_json, rack_models_json, branch_layouts_json, updated_at FROM app_state_blobs WHERE company_id = ?')
      .bind(companyId)
  );
  if (!row) return null;

  const savedAdmin = safeJsonParse(row.admin_json, null);
  return {
    admin: await buildAdminStateFromDb(db, companyId, savedAdmin),
    models: safeJsonParse(row.rack_models_json, null),
    branchLayouts: safeJsonParse(row.branch_layouts_json, null),
    updated_at: row.updated_at
  };
}

async function buildAdminStateFromDb(db, companyId = 1, savedAdmin = null) {
  const companyRow = await getCompanyById(db, companyId) || {
    name: DEFAULT_COMPANY_NAME,
    code: DEFAULT_COMPANY_CODE
  };

  const branches = await all(
    db.prepare('SELECT * FROM branches WHERE active = 1 AND company_id = ? ORDER BY id ASC')
      .bind(companyId)
  );

  const adminBranches = [];
  for (let index = 0; index < branches.length; index += 1) {
    const row = branches[index];
    const savedBranch = Array.isArray(savedAdmin?.branches)
      ? (savedAdmin.branches.find((b) => Number(b?.id) === Number(row.id)) || savedAdmin.branches[index] || {})
      : {};

    const branch = normalizeBranch(row);
    const sheet = await first(
      db.prepare(`
        SELECT sheet_id, sheet_name, source_type, updated_at, sheet_map_json, imported_products_json,
               last_sheet_count, sheet_headers_json, sheet_header_index
        FROM branch_sheet_config
        WHERE branch_id = ?
      `).bind(row.id)
    ) || {};

    adminBranches.push({
      id: row.id,
      name: savedBranch.name || branch.name,
      type: savedBranch.type || branch.type,
      color: savedBranch.color || '#ffd84d',
      warehouses:
        Array.isArray(savedBranch.warehouses) && savedBranch.warehouses.length
          ? savedBranch.warehouses
          : (Array.isArray(branch.warehouses) && branch.warehouses.length
              ? branch.warehouses
              : ['Almacén principal']),
      sheetUrl: sheet.sheet_id || savedBranch.sheetUrl || '',
      sheetName: sheet.sheet_name || savedBranch.sheetName || 'Productos',
      sheetConnected: !!(sheet.sheet_id && sheet.sheet_name),
      lastSheetCount: Number(sheet.last_sheet_count || savedBranch.lastSheetCount || 0),
      sheetHeaders: safeJsonParse(
        sheet.sheet_headers_json,
        Array.isArray(savedBranch.sheetHeaders) ? savedBranch.sheetHeaders : []
      ),
      sheetStatusText: savedBranch.sheetStatusText || '',
      sheetHeaderIndex: Number(sheet.sheet_header_index || savedBranch.sheetHeaderIndex || 0),
      sheetPreviewProducts: safeJsonParse(
        sheet.imported_products_json,
        Array.isArray(savedBranch.sheetPreviewProducts) ? savedBranch.sheetPreviewProducts : []
      ),
      sheetMapRows: safeJsonParse(
        sheet.sheet_map_json,
        Array.isArray(savedBranch.sheetMapRows) ? savedBranch.sheetMapRows : null
      ),
      cardConfig: savedBranch.cardConfig && typeof savedBranch.cardConfig === 'object' ? savedBranch.cardConfig : null
    });
  }

  return {
    company: savedAdmin?.company || companyRow.name || DEFAULT_COMPANY_NAME,
    companyCode: companyRow.code || savedAdmin?.companyCode || DEFAULT_COMPANY_CODE,
    logo: savedAdmin?.logo || '',
    branches: adminBranches,
    activeBranch: Number(savedAdmin?.activeBranch || 0)
  };
}

async function getCompanyById(db, id) {
  return first(db.prepare('SELECT * FROM companies WHERE id = ?').bind(id));
}

async function getUserByUsername(db, username) {
  return first(db.prepare('SELECT * FROM users WHERE lower(username) = lower(?) AND active = 1').bind(username));
}

async function getBranchById(db, id) {
  const row = await first(db.prepare('SELECT * FROM branches WHERE id = ?').bind(id));
  return normalizeBranch(row);
}

async function getOwnedBranch(db, companyId, id) {
  const row = await first(
    db.prepare('SELECT * FROM branches WHERE id = ? AND company_id = ?').bind(id, companyId)
  );
  return normalizeBranch(row);
}

function normalizeBranch(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    type: row.type,
    slug: row.slug,
    warehouses: safeJsonParse(row.warehouses_json, []),
    canvas_width: Number(row.canvas_width || 900),
    canvas_height: Number(row.canvas_height || 620),
    active: !!row.active,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function getDriveFileInfoFromAny(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!host.includes('drive.google.com') && !host.includes('docs.google.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const dIdx = parts.indexOf('d');
    const fileIdx = parts.indexOf('file');
    const id = (dIdx >= 0 && parts[dIdx + 1])
      ? parts[dIdx + 1]
      : ((fileIdx >= 0 && parts[fileIdx + 2]) ? parts[fileIdx + 2] : (u.searchParams.get('id') || ''));
    if (!id) return null;
    return { id, resourcekey: u.searchParams.get('resourcekey') || '' };
  } catch (_) {
    return null;
  }
}

function safeDriveFileId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{10,}$/.test(text) ? text : '';
}

async function proxyGoogleDriveVideo(request, currentUrl) {
  const explicitId = safeDriveFileId(currentUrl.searchParams.get('id'));
  const sourceInfo = getDriveFileInfoFromAny(currentUrl.searchParams.get('source') || currentUrl.searchParams.get('url'));
  const id = explicitId || sourceInfo?.id || '';
  const resourcekey = String(currentUrl.searchParams.get('resourcekey') || sourceInfo?.resourcekey || '').trim();
  if (!id) return withJson({ ok: false, error: 'ID de video de Google Drive inválido', build: BUILD_MARK }, 400);

  const upstreamUrl = new URL('https://drive.google.com/uc');
  upstreamUrl.searchParams.set('export', 'download');
  upstreamUrl.searchParams.set('id', id);
  if (resourcekey) upstreamUrl.searchParams.set('resourcekey', resourcekey);

  const range = request.headers.get('range');
  const fetchHeaders = new Headers();
  if (range) fetchHeaders.set('range', range);
  fetchHeaders.set('user-agent', 'Mozilla/5.0 WMS-Drive-Video-Proxy');

  let upstream = await fetch(upstreamUrl.toString(), {
    method: 'GET',
    headers: fetchHeaders,
    redirect: 'follow'
  });

  const contentType = upstream.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const html = await upstream.text();
    const confirm = html.match(/confirm=([0-9A-Za-z_\-]+)/)?.[1] || html.match(/name="confirm" value="([^"]+)"/)?.[1] || '';
    if (confirm) {
      upstreamUrl.searchParams.set('confirm', confirm);
      upstream = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: fetchHeaders,
        redirect: 'follow'
      });
    } else {
      return new Response('Google Drive no entregó el archivo como video público. Verifica que esté en “Cualquier usuario con el vínculo → Lector”.', {
        status: 403,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-wms-drive-proxy': 'html-access-blocked'
        }
      });
    }
  }

  const headers = new Headers();
  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
  for (const key of pass) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  if (!headers.has('content-type')) headers.set('content-type', 'video/mp4');
  headers.set('cache-control', 'public, max-age=3600');
  headers.set('x-wms-drive-proxy', 'ok');
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  headers.set('access-control-allow-headers', 'Range, Content-Type');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

async function getSession(request, db, allowAnonymous = false) {
  const sid = readCookie(request, COOKIE_NAME);
  if (!sid) return allowAnonymous ? null : null;

  const row = await first(
    db.prepare('SELECT sess_json, expires_at FROM sessions_store WHERE sid = ?').bind(sid)
  );
  if (!row) return null;

  if (Number(row.expires_at || 0) <= Date.now()) {
    await db.prepare('DELETE FROM sessions_store WHERE sid = ?').bind(sid).run();
    return null;
  }

  const sess = safeJsonParse(row.sess_json, null);
  if (!sess || !sess.isAuthenticated) return null;

  await db.prepare(`
    UPDATE sessions_store
    SET expires_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE sid = ?
  `).bind(Date.now() + SESSION_TTL_MS, sid).run();

  return sess;
}

async function createSession(db, data) {
  const sid = crypto.randomUUID().replace(/-/g, '');
  const sess = {
    isAuthenticated: true,
    user_id: Number(data.user_id || 0),
    username: String(data.username || ''),
    role: String(data.role || 'viewer'),
    company_id: Number(data.company_id || 1)
  };

  await db.prepare(`
    INSERT INTO sessions_store (sid, sess_json, expires_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(sid, JSON.stringify(sess), Date.now() + SESSION_TTL_MS).run();

  return sid;
}

async function requireAuth(request, db) {
  const session = await getSession(request, db);
  if (!session) return { error: withJson({ ok: false, error: 'No autorizado', build: BUILD_MARK }, 401) };
  return session;
}

async function requireAdmin(request, db) {
  const session = await getSession(request, db);
  if (!session) return { error: withJson({ ok: false, error: 'No autorizado', build: BUILD_MARK }, 401) };
  if (String(session.role || '') !== 'admin') {
    return { error: withJson({ ok: false, error: 'Solo administradores', build: BUILD_MARK }, 403) };
  }
  return session;
}

function defaultLayout() {
  return {
    zones: [
      {
        id: 'Z1',
        name: 'Zona Z1',
        color: '#ffd84d',
        pts: [{ x: 60, y: 60 }, { x: 300, y: 60 }, { x: 300, y: 210 }, { x: 60, y: 210 }]
      },
      {
        id: 'Z2',
        name: 'Zona Z2',
        color: '#4dd6ff',
        pts: [{ x: 350, y: 60 }, { x: 620, y: 60 }, { x: 620, y: 250 }, { x: 350, y: 250 }]
      },
      {
        id: 'Z3',
        name: 'Zona Z3',
        color: '#50e37b',
        pts: [{ x: 90, y: 290 }, { x: 350, y: 290 }, { x: 350, y: 520 }, { x: 90, y: 520 }]
      }
    ],
    racks: []
  };
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `item-${Date.now()}`;
}

async function uniqueSlug(db, baseSlug, companyId, ignoreBranchId = 0) {
  const base = slugify(baseSlug || `sucursal-${Date.now()}`);
  let candidate = base;
  let i = 2;

  while (true) {
    const row = ignoreBranchId
      ? await first(
          db.prepare('SELECT id FROM branches WHERE company_id = ? AND slug = ? AND id <> ?')
            .bind(companyId, candidate, ignoreBranchId)
        )
      : await first(
          db.prepare('SELECT id FROM branches WHERE company_id = ? AND slug = ?')
            .bind(companyId, candidate)
        );

    if (!row) return candidate;
    candidate = `${base}-${i++}`;
  }
}

async function uniqueCompanyCode(db, base = 'WMS') {
  const cleaned = String(base || 'WMS')
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 6)
    .toUpperCase() || 'WMS';

  let code = '';
  do {
    code = `${cleaned}-${generateToken(6).toUpperCase()}`;
  } while (await first(db.prepare('SELECT id FROM companies WHERE code = ?').bind(code)));

  return code;
}

function generateToken(size = 18) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  for (let i = 0; i < bytes.length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function readCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(
    new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`)
  );
  return match ? decodeURIComponent(match[1]) : '';
}

function makeSessionCookie(sid) {
  return `${COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function hashPassword(password) {
  const salt = generateToken(16);
  const encoded = new TextEncoder().encode(`${salt}:${String(password || '')}`);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return `${salt}$${bufToHex(digest)}`;
}

async function verifyPassword(stored, password) {
  const [salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const encoded = new TextEncoder().encode(`${salt}:${String(password || '')}`);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bufToHex(digest) === hash;
}

function bufToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleSheetProbe(url) {
  const id = parseSheetId(url.searchParams.get('url') || '');
  const sheet = String(url.searchParams.get('sheet') || '').trim();
  if (!id || !sheet) return withJson({ error: 'URL/ID y hoja son obligatorios', build: BUILD_MARK }, 400);

  const gid = await resolveSheetGid(id, sheet);
  try {
    const jsonUrl = gid
      ? `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&gid=${encodeURIComponent(gid)}&headers=1`
      : `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheet)}&headers=1`;

    const r = await fetch(jsonUrl);
    if (r.ok) {
      const parsed = parseGoogleVizJson(await r.text());
      const table = parsed?.table || {};
      const headers = dedupeHeaders(
        (table.cols || []).map((c, idx) => String((c && (c.label || c.id)) || '').trim() || `Columna ${idx + 1}`)
      );
      const rows = ((table.rows || []).map((row) => ((row.c) || []).map((c) => (c && c.v != null ? c.v : ''))))
        .filter((rw) => rw.some(hasVisibleValue));

      return withJson({
        ok: true,
        headers,
        headerIndex: 0,
        previewCount: rows.length,
        source: 'gviz-json',
        build: BUILD_MARK
      });
    }
  } catch (_err) {}

  const rowsPayload = await getSheetRowsPayload(id, sheet, 200, true);
  return withJson({ ...rowsPayload, build: BUILD_MARK });
}

async function handleSheetRows(url) {
  const id = parseSheetId(url.searchParams.get('url') || '');
  const sheet = String(url.searchParams.get('sheet') || '').trim();
  const headerOnly = String(url.searchParams.get('headerOnly') || '') === '1';
  const limit = Math.max(
    1,
    Math.min(50000, Number(url.searchParams.get('limit') || (headerOnly ? 1 : 50000)) || (headerOnly ? 1 : 50000))
  );

  if (!id || !sheet) return withJson({ error: 'URL/ID y hoja son obligatorios', build: BUILD_MARK }, 400);
  const payload = await getSheetRowsPayload(id, sheet, limit, headerOnly);
  return withJson({ ...payload, build: BUILD_MARK });
}


async function getSheetRowsPayloadFromCsv(id, sheet, gid, limit = 200, headerOnly = false) {
  const tryUrls = [];
  if (gid) tryUrls.push(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`);
  tryUrls.push(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`);

  let rows = [];
  let source = gid ? 'csv-gid' : 'csv-sheet';
  for (const csvUrl of tryUrls) {
    try {
      const response = await fetch(csvUrl);
      if (!response.ok) continue;
      const csv = await response.text();
      const parsed = parseCsv(csv).map((row) => row.map((v) => String(v || '').trim()));
      if (parsed.some((r0) => r0.some(hasVisibleValue))) {
        rows = parsed;
        source = csvUrl.includes('gid=') ? 'csv-gid' : 'csv-sheet';
        break;
      }
    } catch (_err) {}
  }

  const nonEmptyRows = rows.filter((r0) => r0.some(hasVisibleValue));
  if (!nonEmptyRows.length) return null;

  let headerIndex = 0;
  let headerRow = nonEmptyRows[0] || [];
  if ((headerRow.filter(hasVisibleValue).length <= 1) && nonEmptyRows[1] && nonEmptyRows[1].filter(hasVisibleValue).length >= 2) {
    headerIndex = 1;
    headerRow = nonEmptyRows[1] || [];
  }

  const dataRowsAllRaw = nonEmptyRows.slice(headerIndex + 1);
  const maxLen = Math.max(headerRow.length, ...dataRowsAllRaw.map((r0) => r0.length), 0);

  let lastMeaningfulCol = 0;
  for (let i = 0; i < maxLen; i += 1) {
    if (hasVisibleValue(headerRow[i])) {
      lastMeaningfulCol = i;
      continue;
    }
    if (dataRowsAllRaw.slice(0, 200).some((r0) => hasVisibleValue((r0 || [])[i]))) lastMeaningfulCol = i;
  }

  const headers = dedupeHeaders(headerRow.slice(0, lastMeaningfulCol + 1));
  const dataRowsAll = dataRowsAllRaw.map((r0) => (r0 || []).slice(0, lastMeaningfulCol + 1));

  if (headerOnly) {
    return { ok: true, headers, headerIndex, previewCount: dataRowsAll.length, source };
  }

  return { ok: true, headers, rows: dataRowsAll.slice(0, limit), headerIndex, totalRows: dataRowsAll.length, source };
}

async function getSheetRowsPayload(id, sheet, limit = 200, headerOnly = false) {
  const gid = await resolveSheetGid(id, sheet);

  if (!headerOnly) {
    const csvPayload = await getSheetRowsPayloadFromCsv(id, sheet, gid, limit, false);
    if (csvPayload && Array.isArray(csvPayload.rows) && csvPayload.rows.length) return csvPayload;
  }

  try {
    const jsonUrl = gid
      ? `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&gid=${encodeURIComponent(gid)}&headers=1`
      : `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheet)}&headers=1`;

    const r = await fetch(jsonUrl);
    if (r.ok) {
      const parsed = parseGoogleVizJson(await r.text());
      const table = parsed?.table || {};
      const gvizHeaders = (table.cols || []).map((c, idx) =>
        String((c && (c.label || c.id)) || '').trim() || `Columna ${idx + 1}`
      );

      const rows = ((table.rows || []).map((row) => ((row.c) || []).map((c) => (c && c.v != null ? c.v : ''))))
        .map((r0) => r0.map((v) => String(v ?? '').trim()))
        .filter((rw) => rw.some(hasVisibleValue));

      const lastCol = gvizHeaders.reduce((last, h, i) => {
        if (hasVisibleValue(h)) return i;
        if (rows.some((r0) => hasVisibleValue((r0 || [])[i]))) return i;
        return last;
      }, 0);

      const headers = dedupeHeaders(gvizHeaders.slice(0, lastCol + 1));
      const trimmedRows = rows.map((r0) => r0.slice(0, lastCol + 1));

      if (headerOnly) {
        return { ok: true, headers, headerIndex: 0, previewCount: trimmedRows.length, source: 'gviz-json' };
      }

      if (trimmedRows.length) {
        return { ok: true, headers, rows: trimmedRows.slice(0, limit), headerIndex: 0, totalRows: trimmedRows.length, source: 'gviz-json' };
      }
    }
  } catch (_err) {}

  const csvPayload = await getSheetRowsPayloadFromCsv(id, sheet, gid, limit, headerOnly);
  if (csvPayload) return csvPayload;
  throw new Error('La hoja está vacía o no se pudo leer');
}


async function getImportedProductsForBranch(db, branchId) {
  const row = await first(
    db.prepare('SELECT imported_products_json FROM branch_sheet_config WHERE branch_id = ?').bind(branchId)
  );
  const products = safeJsonParse(row?.imported_products_json, []);
  return Array.isArray(products) ? products : [];
}

function normalizeSearchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function productValue(product, keys) {
  for (const key of keys) {
    const value = product && product[key];
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function productSearchHaystack(product) {
  return normalizeSearchText([
    productValue(product, ['sku', 'Sku', 'SKU']),
    productValue(product, ['nombre', 'Nombre', 'name', 'producto']),
    productValue(product, ['variante', 'Variante', 'variant']),
    productValue(product, ['barras', 'barcode', 'codigoBarras']),
    productValue(product, ['ubicacion', 'ubicación', 'location']),
    productValue(product, ['almacen', 'almacén', 'warehouse']),
    productValue(product, ['zona', 'zone', 'zonaStore']),
    productValue(product, ['rack', 'estante', 'rackStore', 'estanteStore']),
    productValue(product, ['nivel', 'level', 'nivelStore']),
    productValue(product, ['slot', 'slotStore']),
    productValue(product, ['talla', 'size']),
    productValue(product, ['color']),
    productValue(product, ['marca', 'brand']),
    productValue(product, ['categoria', 'categoría', 'category']),
    productValue(product, ['linea', 'línea'])
  ].join(' '));
}

function productHasImage(product) {
  return !!productValue(product, ['imagen', 'image', 'foto', 'imagen2', 'image2', 'foto2']);
}

function productHasLocation(product) {
  return !!productValue(product, ['ubicacion', 'ubicación', 'location', 'almacen', 'almacén', 'warehouse', 'zona', 'rack', 'estante']);
}

function productHasStock(product) {
  const raw = productValue(product, ['stock', 'cantidad', 'cant', 'Cant. Restock', 'cantRestock', 'cantidadRestock']);
  if (!raw) return false;
  const numeric = Number(String(raw).replace(',', '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric > 0 : true;
}


function productGroupIdentity(product) {
  const name = productValue(product, ['nombre', 'Nombre', 'name', 'producto']).trim();
  const brand = productValue(product, ['marca', 'brand']).trim();
  const base = name || productValue(product, ['sku', 'Sku', 'SKU', 'barras', 'barcode']).trim() || 'Sin nombre';
  return `${normalizeSearchText(base)}¦${normalizeSearchText(brand)}`;
}

function uniqueNonEmpty(values) {
  const seen = new Map();
  for (const value of values || []) {
    const clean = String(value || '').trim();
    if (!clean) continue;
    const key = normalizeSearchText(clean);
    if (!seen.has(key)) seen.set(key, clean);
  }
  return [...seen.values()];
}

function groupProductsByName(products) {
  const groups = new Map();
  for (const product of products || []) {
    const key = productGroupIdentity(product);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }

  return [...groups.entries()].map(([key, items]) => {
    const preferred = items.find(productHasImage) || items[0] || {};
    const sizes = uniqueNonEmpty(items.map(p => productValue(p, ['talla', 'Talla', 'size'])));
    const colors = uniqueNonEmpty(items.map(p => productValue(p, ['color', 'Color'])));
    const locations = uniqueNonEmpty(items.map(p => productValue(p, ['ubicacion', 'ubicación', 'location']) || [
      productValue(p, ['zona', 'zone']),
      productValue(p, ['estante', 'rack']),
      productValue(p, ['nivel']),
      productValue(p, ['slot'])
    ].filter(Boolean).join('-')));
    const warehouses = uniqueNonEmpty(items.map(p => productValue(p, ['almacen', 'almacén', 'warehouse'])));
    const skus = uniqueNonEmpty(items.map(p => productValue(p, ['sku', 'Sku', 'SKU']) || productValue(p, ['barras', 'barcode'])));

    return {
      ...preferred,
      _grouped: true,
      _groupKey: key,
      _groupName: productValue(preferred, ['nombre', 'Nombre', 'name', 'producto']) || 'Sin nombre',
      _groupItems: items,
      _variantCount: items.length,
      _sizeOptions: sizes,
      _colorOptions: colors,
      _locationOptions: locations,
      _warehouseOptions: warehouses,
      _skuOptions: skus
    };
  }).sort((a, b) => String(a._groupName || '').localeCompare(String(b._groupName || ''), 'es'));
}

function filterImportedProducts(products, q, filters = {}) {
  const terms = normalizeSearchText(q).split(/\s+/).filter(Boolean);
  return (products || []).filter((product) => {
    if (terms.length) {
      const haystack = productSearchHaystack(product);
      if (!terms.every((term) => haystack.includes(term))) return false;
    }

    const brand = normalizeSearchText(filters.brand);
    if (brand && normalizeSearchText(productValue(product, ['marca', 'brand'])) !== brand) return false;

    const category = normalizeSearchText(filters.category);
    if (category && normalizeSearchText(productValue(product, ['categoria', 'categoría', 'category'])) !== category) return false;

    const zone = normalizeSearchText(filters.zone);
    if (zone && normalizeSearchText(productValue(product, ['zona', 'zone', 'zonaStore'])) !== zone) return false;

    const warehouse = normalizeSearchText(filters.warehouse);
    if (warehouse && normalizeSearchText(productValue(product, ['almacen', 'almacén', 'warehouse'])) !== warehouse) return false;

    const rack = normalizeSearchText(filters.rack);
    if (rack && normalizeSearchText(productValue(product, ['rack', 'estante', 'rackStore', 'estanteStore'])) !== rack) return false;

    const imageState = String(filters.image_state || '').trim();
    if (imageState === 'with' && !productHasImage(product)) return false;
    if (imageState === 'without' && productHasImage(product)) return false;

    const locationState = String(filters.location_state || '').trim();
    if (locationState === 'with' && !productHasLocation(product)) return false;
    if (locationState === 'without' && productHasLocation(product)) return false;

    const stockState = String(filters.stock_state || '').trim();
    if (stockState === 'with' && !productHasStock(product)) return false;
    if (stockState === 'without' && productHasStock(product)) return false;

    return true;
  });
}

function uniqueSortedFacet(products, keys) {
  const seen = new Map();
  for (const product of products || []) {
    const value = productValue(product, keys);
    if (!value) continue;
    const normalized = normalizeSearchText(value);
    if (!seen.has(normalized)) seen.set(normalized, value);
  }
  return Array.from(seen.values()).sort((a, b) => String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' }));
}

function buildProductFacets(products) {
  return {
    brands: uniqueSortedFacet(products, ['marca', 'brand']),
    brand_options: uniqueSortedFacet(products, ['marca', 'brand']),
    categories: uniqueSortedFacet(products, ['categoria', 'categoría', 'category']),
    category_options: uniqueSortedFacet(products, ['categoria', 'categoría', 'category']),
    zones: uniqueSortedFacet(products, ['zona', 'zone', 'zonaStore']),
    zone_options: uniqueSortedFacet(products, ['zona', 'zone', 'zonaStore']),
    warehouses: uniqueSortedFacet(products, ['almacen', 'almacén', 'warehouse']),
    warehouse_options: uniqueSortedFacet(products, ['almacen', 'almacén', 'warehouse']),
    racks: uniqueSortedFacet(products, ['rack', 'estante', 'rackStore', 'estanteStore']),
    rack_options: uniqueSortedFacet(products, ['rack', 'estante', 'rackStore', 'estanteStore'])
  };
}

function buildProductSummary(products) {
  const list = Array.isArray(products) ? products : [];
  return {
    total: list.length,
    with_location: list.filter(productHasLocation).length,
    with_image: list.filter(productHasImage).length,
    with_stock: list.filter(productHasStock).length
  };
}

async function fetchSheetMeta(id) {
  const html = await fetch(`https://docs.google.com/spreadsheets/d/${id}/edit`).then((r) => r.text());
  const sheets = [];
  const re = /"sheetId":(\d+),"title":"([^"]+)"/g;
  let match;

  while ((match = re.exec(html))) {
    sheets.push({ gid: match[1], title: decodeUnicodeEscapes(match[2]) });
  }

  return { sheets };
}

async function resolveSheetGid(id, sheetName) {
  const meta = await fetchSheetMeta(id);
  const hit = (meta.sheets || []).find(
    (s) => String(s.title || '').trim().toLowerCase() === String(sheetName || '').trim().toLowerCase()
  );
  return hit ? String(hit.gid) : '';
}

function parseGoogleVizJson(text) {
  const m = String(text || '').match(/google\.visualization\.Query\.setResponse\((.*)\);?\s*$/s);
  if (!m) return null;
  return safeJsonParse(m[1], null);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(text || '');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      cell += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\r') continue;

    cell += ch;
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function dedupeHeaders(row) {
  const seen = new Map();
  return (row || []).map((v, i) => {
    const base = String(v || '').trim() || `Columna ${i + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function hasVisibleValue(value) {
  return String(value == null ? '' : value).trim() !== '';
}

function parseSheetId(input) {
  const value = String(input || '').trim();
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(value) ? value : '';
}

function decodeUnicodeEscapes(str) {
  return String(str || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\"/g, '"');
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_err) {
    return {};
  }
}

function withJson(data, status = 200, cookies = []) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function safeJsonParse(value, fallback) {
  try {
    return value == null || value === '' ? fallback : JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

async function first(stmt) {
  const out = await stmt.first();
  return out || null;
}

async function all(stmt) {
  const out = await stmt.all();
  return Array.isArray(out?.results) ? out.results : [];
}

async function firstValue(stmt, key) {
  const row = await first(stmt);
  return row ? row[key] : null;
}

function escapeSql(value) {
  return String(value || '').replace(/'/g, "''");
}