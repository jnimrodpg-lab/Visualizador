# Catálogo Visual para Cliente

App web ligera derivada del ZIP WMS base.

## Qué conserva

- Login / registro de administrador.
- Empresa y sucursales.
- Vinculación con Google Sheets.
- Lectura de encabezados desde fila 1.
- Mapeo editable de columnas.
- Importación de productos desde Google Sheets, hasta 50,000 filas.
- Búsqueda por SKU, nombre, variante, barras, marca, talla, color, ubicación y almacén.
- Cards visuales de producto con imagen o video.
- Link público para cliente por sucursal.
- Backend Cloudflare Pages Functions + D1.

## Qué se eliminó del frontend

- Editor de layout.
- Editor de racks.
- Modelos de rack.
- Vista de mapa / plano.
- Paneles internos que no son necesarios para consulta de cliente.

## Uso rápido

1. Despliega en Cloudflare Pages con D1 vinculado como `DB`.
2. Ingresa con el usuario admin configurado en variables o usa los defaults del backend si aplica.
3. Crea o selecciona una sucursal.
4. En “Vincular Sheet”, pega la URL pública o compartida del Google Sheet.
5. Escribe el nombre de hoja, por ejemplo `Productos`.
6. Presiona “Leer encabezados”, revisa el mapeo y luego “Importar productos”.
7. Genera el link cliente desde “Configuración”.

## Encabezados recomendados

La app reconoce automáticamente columnas como:

`Genero, Categoria, Estado, marca, cod / modelo, GROSOR, talla, color, Linea, Barras, Sku, Nombre, Variante, Zona, Estante, Nivel, Slot, Ubicación, Almacen, P.Lista(+igv), Cant. Restock, Imagen, Video`

También puedes ajustar manualmente el mapeo antes de importar.
