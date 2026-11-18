# Cliente SOAP de prueba de ArcaSim

Aplicación aparte, con interfaz web, para comprobar que el web service SOAP de ArcaSim (WSFEv1) funciona
como lo usaría el sistema de otro grupo. No comparte código con la solución de ArcaSim: solo conoce la URL
del servicio, la CUIT y la API key, igual que cualquier cliente externo.

## Qué permite hacer

| Pestaña | Operación | Para qué |
|---|---|---|
| Conexión | `FEDummy` y `?WSDL` | Ver si el servicio está en línea y si el WSDL publica las 12 operaciones. |
| Emitir | `FECAESolicitar` | Autorizar una factura (A, B o C; productos o servicios) y obtener el CAE. Pide sola el próximo número. Con *Cargar IVA y total a mano* se pueden provocar rechazos. |
| Último número | `FECompUltimoAutorizado` | Último número autorizado por punto de venta y tipo. |
| Consultar | `FECompConsultar` | Datos y CAE de un comprobante ya autorizado. |
| Catálogos | `FEParamGet*` y `FECompTotXRequest` | Tipos de comprobante, documento, IVA, condiciones del receptor, conceptos, monedas y puntos de venta. |
| Prueba automática | Todas | Recorre el servicio de punta a punta y marca cada punto: WSDL, `FEDummy`, Auth correcto, errores 600 y 601, catálogos, emisión, numeración, consulta y rechazos (número repetido y total mal sumado). |
| XML libre | Cualquiera | Mandar un sobre escrito o editado a mano (por ejemplo, mal formado, para ver el SOAP Fault). |

Cada respuesta se muestra resumida (CAE, errores `Err`, eventos, tablas) y también como XML, junto con el
pedido que se envió. El historial guarda los pedidos de la sesión.

## Cómo usarla

Requisitos: .NET 10 SDK y la API de ArcaSim corriendo (local, en Docker o desplegada).

```powershell
cd ArcaSim.ClienteSoap
dotnet run
```

Y abrir <http://localhost:5090> (desde Visual Studio se abre sola). Ahí:

1. **URL del servicio**: por defecto `http://localhost:5030/wsfev1/service.asmx` (la API con `dotnet run` o
   con `docker compose --profile app up`). Para la API desplegada, poner su URL pública con
   `/wsfev1/service.asmx` al final.
2. **CUIT** y **API key**: la key se genera en el portal, en *Mis contribuyentes → Generar / Regenerar API Key*
   (se muestra una sola vez). Con los datos de prueba, se puede entrar con la CUIT `20255556666` y la clave
   `ArcaSim2026`, y generar la key de `30712345671` (Comercio Demo S.A., responsable inscripto).
3. **Probar conexión** y después cualquiera de las pestañas.

La URL y la CUIT quedan guardadas en el navegador; la API key, solo mientras la pestaña esté abierta.

## Cómo funciona

- `wwwroot/app.js` arma los sobres SOAP 1.1 (namespace `http://ar.gov.afip.dif.FEV1/`, `Auth` con
  `Token` = API key, `Sign` vacío y `Cuit`) y lee las respuestas.
- `Program.cs` reenvía cada sobre tal cual a la URL indicada (`POST /api/soap`, con el header `SOAPAction`) y
  descarga el WSDL (`GET /api/wsdl`). Hace falta porque la API no habilita CORS: un navegador no puede llamarla
  directamente, y los sistemas reales la llaman desde su servidor.
- La app escucha solo en `localhost`.

## Tener en cuenta

- Emitir y la prueba automática (con la casilla de emisión marcada) **autorizan comprobantes de verdad** en la
  base de la API a la que apuntan. La prueba automática emite una factura de $121 a consumidor final por corrida.
- La prueba automática usa Factura B por defecto (CUIT responsable inscripto). Si la CUIT es de un
  monotributista o un exento, elegir Factura C.
- El servicio desplegado en Render Free puede tardar cerca de un minuto en responder el primer pedido; la app
  espera hasta 90 segundos.
