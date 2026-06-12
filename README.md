# Catálogo PG — Buscador cliente + Cards agrupadas

App web para Cloudflare Pages + Functions + D1.

## Cambios de esta versión

- Buscador tipo cliente: simple, directo y sin layout/racks.
- El producto seleccionado se mantiene dentro del panel de búsqueda.
- La lista se agrupa por nombre de producto/marca para evitar repetir productos con muchas variantes.
- Cada familia muestra cantidad de variantes, tallas, colores, ubicaciones y almacenes.
- Al hacer clic en una fila se selecciona la familia y se actualiza la card principal.
- Al hacer clic en la card o en “Abrir visor” se despliega la card grande.
- Dos modos:
  - Admin: puede vincular Sheets, importar productos, crear sucursales y generar link viewer.
  - Viewer: solo observa, busca, selecciona y abre cards; no puede editar.

## Cloudflare Pages

Configuración recomendada:

- Framework preset: None
- Build command: vacío
- Build output directory: public
- Root directory: /

## D1

Binding requerido:

- Variable name: DB
- Database: wms-industrial-db

El archivo `wrangler.toml` ya está preparado para Pages + D1.
