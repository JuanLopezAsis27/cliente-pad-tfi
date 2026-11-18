"use strict";

// Cliente de prueba del WSFEv1 de ArcaSim. Arma los sobres SOAP 1.1 acá, los manda por el servidor
// de esta app (/api/soap, que solo los reenvía) y lee las respuestas con DOMParser.

const NS = "http://ar.gov.afip.dif.FEV1/";
const SOAPENV = "http://schemas.xmlsoap.org/soap/envelope/";

const OPERACIONES = [
  "FEDummy", "FECompUltimoAutorizado", "FECAESolicitar", "FECompConsultar", "FECompTotXRequest",
  "FEParamGetPtosVenta", "FEParamGetTiposCbte", "FEParamGetTiposDoc", "FEParamGetTiposIva",
  "FEParamGetCondicionIvaReceptor", "FEParamGetTiposConcepto", "FEParamGetTiposMonedas"
];

const TIPOS = [
  [1, "Factura A"], [2, "Nota de Débito A"], [3, "Nota de Crédito A"],
  [6, "Factura B"], [7, "Nota de Débito B"], [8, "Nota de Crédito B"],
  [11, "Factura C"], [12, "Nota de Débito C"], [13, "Nota de Crédito C"]
];
const CONCEPTOS = [[1, "Productos"], [2, "Servicios"], [3, "Productos y servicios"]];
const DOCUMENTOS = [[80, "CUIT"], [86, "CUIL"], [96, "DNI"], [99, "Sin identificar (consumidor final)"]];
const ALICUOTAS = [[5, "21 %", 0.21], [4, "10,5 %", 0.105], [6, "27 %", 0.27], [8, "5 %", 0.05], [9, "2,5 %", 0.025], [3, "0 %", 0]];
const CONDICIONES = [
  [1, "IVA Responsable Inscripto", "AC"], [4, "IVA Sujeto Exento", "BC"], [5, "Consumidor Final", "BC"],
  [6, "Responsable Monotributo", "AC"], [7, "Sujeto No Categorizado", "BC"]
];

const CATALOGOS = [
  ["FEParamGetTiposCbte", "Tipos de comprobante"],
  ["FEParamGetTiposDoc", "Tipos de documento"],
  ["FEParamGetTiposIva", "Alícuotas de IVA"],
  ["FEParamGetCondicionIvaReceptor", "Condiciones frente al IVA del receptor"],
  ["FEParamGetTiposConcepto", "Conceptos"],
  ["FEParamGetTiposMonedas", "Monedas"],
  ["FEParamGetPtosVenta", "Puntos de venta de la CUIT"],
  ["FECompTotXRequest", "Comprobantes por pedido"]
];

const $ = (id) => document.getElementById(id);

// ===================================================================
// Preferencias (la API key queda solo en esta pestaña)
// ===================================================================

const guardado = {
  leer(almacen, clave) { try { return window[almacen].getItem("clienteSoap." + clave); } catch { return null; } },
  escribir(almacen, clave, valor) { try { window[almacen].setItem("clienteSoap." + clave, valor); } catch { /* sin almacenamiento */ } }
};

function credenciales() {
  return { url: $("url").value.trim(), cuit: $("cuit").value.trim(), token: $("token").value.trim() };
}

// ===================================================================
// Armado de sobres
// ===================================================================

function n(nombre, ...hijos) {
  return { nombre, hijos: hijos.flat().filter((h) => h !== null && h !== undefined) };
}

function escaparXml(texto) {
  return String(texto).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializar(nodo, nivel) {
  const pad = "  ".repeat(nivel);
  const etiqueta = "ar:" + nodo.nombre;
  if (nodo.hijos.length === 0) return `${pad}<${etiqueta}></${etiqueta}>`;
  if (nodo.hijos.every((h) => typeof h !== "object")) {
    return `${pad}<${etiqueta}>${escaparXml(nodo.hijos.join(""))}</${etiqueta}>`;
  }
  const interior = nodo.hijos.map((h) => serializar(h, nivel + 1)).join("\n");
  return `${pad}<${etiqueta}>\n${interior}\n${pad}</${etiqueta}>`;
}

function sobre(operacion, ...parametros) {
  return [
    `<soapenv:Envelope xmlns:soapenv="${SOAPENV}" xmlns:ar="${NS}">`,
    "  <soapenv:Body>",
    serializar(n(operacion, ...parametros), 2),
    "  </soapenv:Body>",
    "</soapenv:Envelope>"
  ].join("\n");
}

/** El Auth de ARCA, con la API key en Token y Sign vacío. `cambios` sirve para las pruebas de errores. */
function auth(cambios = {}) {
  const c = { ...credenciales(), sign: "", ...cambios };
  return n("Auth", n("Token", c.token), n("Sign", c.sign), n("Cuit", c.cuit));
}

const PLANTILLAS = {
  FEDummy: () => sobre("FEDummy"),
  FECompUltimoAutorizado: () => sobre("FECompUltimoAutorizado", auth(), n("PtoVta", 1), n("CbteTipo", 6)),
  FECAESolicitar: () => sobre("FECAESolicitar", auth(), feCaeReq(datosEmision())),
  FECompConsultar: () => sobre("FECompConsultar", auth(), n("FeCompConsReq", n("CbteTipo", 6), n("CbteNro", 1), n("PtoVta", 1))),
  FEParamGetCondicionIvaReceptor: () => sobre("FEParamGetCondicionIvaReceptor", auth(), n("ClaseCmp", "B"))
};

function plantilla(operacion) {
  return (PLANTILLAS[operacion] ?? (() => sobre(operacion, auth())))();
}

// ===================================================================
// Envío y lectura de respuestas
// ===================================================================

const historial = [];
let contadorLlamadas = 0;

/**
 * Manda un sobre y devuelve la llamada analizada. Con `mostrar: false` no cambia el panel de
 * resultado (lo usa la prueba automática), pero igual queda en el historial.
 */
async function llamar(operacion, xml, { accion = NS + operacion, mostrar = true, desplazar = true } = {}) {
  const { url } = credenciales();
  const inicio = new Date();
  let datos;
  try {
    const r = await fetch("api/soap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, accion, xml })
    });
    datos = await r.json();
    if (!r.ok) datos = { url, estado: 0, milisegundos: 0, error: datos.error ?? `La app respondió ${r.status}.` };
  } catch (e) {
    datos = { url, estado: 0, milisegundos: 0, error: "La app de prueba no responde (¿se cerró dotnet run?)." };
  }

  const llamada = {
    id: ++contadorLlamadas,
    hora: inicio,
    operacion,
    accion,
    pedido: xml,
    ...datos,
    analisis: analizar(operacion, datos)
  };
  agregarAlHistorial(llamada);
  if (mostrar) mostrarLlamada(llamada, { desplazar });
  return llamada;
}

/** Busca por nombre local, sin importar el prefijo ni el namespace. */
function hijos(elemento, nombre) {
  return elemento ? [...elemento.children].filter((h) => h.localName === nombre) : [];
}
function hijo(elemento, nombre) { return hijos(elemento, nombre)[0] ?? null; }
function texto(elemento, nombre) {
  const h = nombre ? hijo(elemento, nombre) : elemento;
  return h ? h.textContent.trim() : "";
}
function descendiente(doc, nombre) { return doc.getElementsByTagNameNS("*", nombre)[0] ?? null; }

function mensajesDe(elemento, contenedor, item) {
  return hijos(hijo(elemento, contenedor), item).map((m) => ({ codigo: texto(m, "Code"), mensaje: texto(m, "Msg") }));
}

function analizar(operacion, datos) {
  if (datos.error) return { tipo: "sin-conexion", titulo: "Sin conexión", detalle: datos.error };

  const doc = new DOMParser().parseFromString(datos.cuerpo ?? "", "text/xml");
  if (!datos.cuerpo || doc.getElementsByTagName("parsererror").length) {
    return {
      tipo: "no-soap",
      titulo: `HTTP ${datos.estado}`,
      detalle: datos.cuerpo ? "La respuesta no es XML." : "La respuesta vino vacía."
    };
  }

  const falla = descendiente(doc, "Fault");
  if (falla) {
    return {
      tipo: "fault",
      titulo: "SOAP Fault",
      detalle: texto(falla, "faultstring") || "El servicio devolvió un SOAP Fault.",
      codigoFalla: texto(falla, "faultcode")
    };
  }

  const resultado = descendiente(doc, operacion + "Result");
  if (!resultado) {
    return { tipo: "no-soap", titulo: `HTTP ${datos.estado}`, detalle: `La respuesta no trae ${operacion}Result.` };
  }

  const errores = mensajesDe(resultado, "Errors", "Err");
  const eventos = mensajesDe(resultado, "Events", "Evt");
  return { tipo: errores.length ? "errores" : "ok", resultado, errores, eventos };
}

/** Operación de un SOAPAction escrito a mano: lo que sigue al namespace (o a la última barra). */
function operacionDeAccion(accion) {
  const limpia = accion.trim().replace(/^"|"$/g, "");
  return limpia.startsWith(NS) ? limpia.slice(NS.length) : limpia.split(/[/#]/).pop();
}

// ===================================================================
// Panel de resultado
// ===================================================================

function crear(etiqueta, atributos = {}, ...contenido) {
  const el = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(atributos)) {
    if (valor === null || valor === undefined || valor === false) continue;
    if (clave === "class") el.className = valor;
    else if (clave.startsWith("on")) el.addEventListener(clave.slice(2), valor);
    else el.setAttribute(clave, valor === true ? "" : valor);
  }
  el.append(...contenido.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

function insignia(texto, tono) { return crear("span", { class: `insignia ${tono}` }, texto); }

/** Pares [nombre, valor, ancho?]: con ancho, el dato ocupa toda la fila (textos largos). */
function listaDatos(pares) {
  return crear("dl", { class: "datos" },
    pares.filter(([, v]) => v !== "" && v !== null && v !== undefined)
      .map(([k, v, ancho]) => crear("div", { class: ancho ? "ancho" : null }, crear("dt", {}, k), crear("dd", {}, String(v)))));
}

function listaMensajes(titulo, mensajes, clase) {
  if (!mensajes.length) return null;
  return crear("div", {},
    crear("p", { class: "subtitulo" }, titulo),
    crear("ul", { class: `mensajes ${clase}` },
      mensajes.map((m) => crear("li", {}, crear("span", { class: "codigo" }, m.codigo), crear("span", {}, m.mensaje)))));
}

/** Tabla con todos los elementos hijos de cada fila (sirve para cualquier ResultGet). */
function tablaDe(filas) {
  const columnas = [];
  for (const fila of filas) for (const c of fila.children) if (!columnas.includes(c.localName)) columnas.push(c.localName);
  return crear("div", { class: "tabla-envoltura" },
    crear("table", {},
      crear("thead", {}, crear("tr", {}, columnas.map((c) => crear("th", {}, c)))),
      crear("tbody", {}, filas.map((f) => crear("tr", {}, columnas.map((c) => crear("td", {}, texto(f, c))))))));
}

function fecha8(valor) {
  return /^\d{8}/.test(valor) ? `${valor.slice(6, 8)}/${valor.slice(4, 6)}/${valor.slice(0, 4)}${valor.length > 8 ? " " + valor.slice(8, 10) + ":" + valor.slice(10, 12) : ""}` : valor;
}

/** Resumen de cada operación: insignia y contenido. */
function resumen(llamada) {
  const a = llamada.analisis;
  if (a.tipo === "sin-conexion" || a.tipo === "no-soap") {
    return { insignia: insignia(a.titulo, "error"), cuerpo: [crear("p", {}, a.detalle)] };
  }
  if (a.tipo === "fault") {
    return {
      insignia: insignia("SOAP Fault", "error"),
      cuerpo: [listaDatos([["faultcode", a.codigoFalla], ["faultstring", a.detalle, true]])]
    };
  }

  const r = a.resultado;
  const extras = [listaMensajes("Errores", a.errores, "err"), listaMensajes("Eventos", a.eventos, "evt")];
  const conErrores = () => insignia(`Error ${a.errores.map((e) => e.codigo).join(", ")}`, "error");

  switch (llamada.operacion) {
    case "FEDummy": {
      const pares = ["AppServer", "DbServer", "AuthServer"].map((k) => [k, texto(r, k)]);
      const todoOk = pares.every(([, v]) => v === "OK");
      return { insignia: insignia(todoOk ? "En línea" : "Con problemas", todoOk ? "ok" : "aviso"), cuerpo: [listaDatos(pares)] };
    }

    case "FECompUltimoAutorizado": {
      const ultimo = Number(texto(r, "CbteNro"));
      const cuerpo = a.errores.length ? [] : [
        crear("div", { class: "destacado" },
          crear("div", { class: "etiqueta" }, "Último número autorizado"),
          crear("div", { class: "valor" }, String(ultimo)),
          crear("div", { class: "nota" }, `El próximo es el ${ultimo + 1}.`)),
        crear("div", { class: "res-acciones" },
          crear("button", {
            type: "button", class: "boton boton-chico secundario",
            onclick: () => usarProximoEnEmision(Number(texto(r, "PtoVta")), Number(texto(r, "CbteTipo")), ultimo + 1)
          }, `Emitir el ${ultimo + 1}`))
      ];
      if (!a.errores.length) {
        cuerpo.push(listaDatos([["PtoVta", texto(r, "PtoVta")], ["CbteTipo", nombreTipo(texto(r, "CbteTipo"))], ["CbteNro", texto(r, "CbteNro")]]));
      }
      return { insignia: a.errores.length ? conErrores() : insignia("OK", "ok"), cuerpo: [...cuerpo, ...extras] };
    }

    case "FECAESolicitar": {
      const cab = hijo(r, "FeCabResp");
      const det = hijo(hijo(r, "FeDetResp"), "FECAEDetResponse");
      const resultadoCab = texto(cab, "Resultado") || texto(det, "Resultado");
      const obs = mensajesDe(det, "Observaciones", "Obs");
      const cuerpo = [];
      if (resultadoCab === "A") {
        const ptoVta = Number(texto(cab, "PtoVta")), tipo = Number(texto(cab, "CbteTipo")), nro = Number(texto(det, "CbteDesde"));
        cuerpo.push(
          crear("div", { class: "destacado" },
            crear("div", { class: "etiqueta" }, "CAE"),
            crear("div", { class: "valor" }, texto(det, "CAE")),
            crear("div", { class: "nota" }, `Vence el ${fecha8(texto(det, "CAEFchVto"))} · ${soloNombreTipo(tipo)} ${String(ptoVta).padStart(5, "0")}-${String(nro).padStart(8, "0")}`)),
          crear("div", { class: "res-acciones" },
            crear("button", { type: "button", class: "boton boton-chico secundario", onclick: () => consultarComprobante(ptoVta, tipo, nro) }, "Consultar este comprobante")));
      }
      if (cab) {
        cuerpo.push(listaDatos([
          ["Resultado", resultadoCab], ["Cuit", texto(cab, "Cuit")], ["PtoVta", texto(cab, "PtoVta")],
          ["CbteTipo", nombreTipo(texto(cab, "CbteTipo"))], ["CbteDesde", texto(det, "CbteDesde")],
          ["CbteFch", fecha8(texto(det, "CbteFch"))], ["FchProceso", fecha8(texto(cab, "FchProceso"))], ["Reproceso", texto(cab, "Reproceso")]
        ]));
      }
      const tono = resultadoCab === "A" ? insignia("Aprobado (A)", "ok")
        : resultadoCab === "R" ? insignia("Rechazado (R)", "error")
          : a.errores.length ? conErrores() : insignia("Sin resultado", "aviso");
      return { insignia: tono, cuerpo: [...cuerpo, listaMensajes("Observaciones", obs, "obs"), ...extras] };
    }

    case "FECompConsultar": {
      const g = hijo(r, "ResultGet");
      const cuerpo = [];
      if (g) {
        cuerpo.push(
          crear("div", { class: "destacado" },
            crear("div", { class: "etiqueta" }, `${texto(g, "EmisionTipo") || "CAE"} · resultado ${texto(g, "Resultado")}`),
            crear("div", { class: "valor" }, texto(g, "CodAutorizacion")),
            crear("div", { class: "nota" }, `Vence el ${fecha8(texto(g, "FchVto"))}`)),
          listaDatos([
            ["Comprobante", `${soloNombreTipo(texto(g, "CbteTipo"))} ${texto(g, "PtoVta").padStart(5, "0")}-${texto(g, "CbteDesde").padStart(8, "0")}`],
            ["CbteFch", fecha8(texto(g, "CbteFch"))], ["Concepto", nombreDe(CONCEPTOS, texto(g, "Concepto"))],
            ["DocTipo / DocNro", `${texto(g, "DocTipo")} / ${texto(g, "DocNro")}`],
            ["ImpNeto", texto(g, "ImpNeto")], ["ImpIVA", texto(g, "ImpIVA")], ["ImpTotConc", texto(g, "ImpTotConc")],
            ["ImpOpEx", texto(g, "ImpOpEx")], ["ImpTotal", texto(g, "ImpTotal")], ["Moneda", `${texto(g, "MonId")} × ${texto(g, "MonCotiz")}`]
          ]));
        const iva = hijos(hijo(g, "Iva"), "AlicIva");
        if (iva.length) cuerpo.push(crear("div", {}, crear("p", { class: "subtitulo" }, "Alícuotas"), tablaDe(iva)));
      }
      return { insignia: a.errores.length ? conErrores() : insignia("OK", "ok"), cuerpo: [...cuerpo, ...extras] };
    }

    case "FECompTotXRequest":
      return {
        insignia: a.errores.length ? conErrores() : insignia("OK", "ok"),
        cuerpo: [a.errores.length ? null : listaDatos([["RegXReq (comprobantes por pedido)", texto(r, "RegXReq")]]), ...extras]
      };

    default: {
      // Catálogos y cualquier otra respuesta: si hay ResultGet con filas, se muestran en tabla.
      const filas = [...(hijo(r, "ResultGet")?.children ?? [])];
      const cuerpo = filas.length ? [crear("p", { class: "subtitulo" }, registros(filas.length)), tablaDe(filas)]
        : a.errores.length ? [] : [crear("p", {}, "La respuesta no trae registros.")];
      return { insignia: a.errores.length ? conErrores() : insignia("OK", "ok"), cuerpo: [...cuerpo, ...extras] };
    }
  }
}

function mostrarLlamada(llamada, { desplazar = true } = {}) {
  const { insignia: badge, cuerpo } = resumen(llamada);
  const meta = llamada.estado
    ? `HTTP ${llamada.estado} ${llamada.motivo ?? ""} · ${llamada.milisegundos} ms · ${llamada.hora.toLocaleTimeString("es-AR")}`
    : `${llamada.milisegundos} ms · ${llamada.hora.toLocaleTimeString("es-AR")}`;

  $("resultado").replaceChildren(
    crear("div", { class: "res-cabecera" }, crear("h3", {}, llamada.operacion), badge),
    crear("p", { class: "res-meta" }, meta),
    crear("div", { class: "res-cuerpo" }, ...cuerpo.filter(Boolean), visorXml(llamada)));

  for (const b of document.querySelectorAll("#historial button")) {
    b.setAttribute("aria-current", String(Number(b.dataset.id) === llamada.id));
  }

  // En pantallas angostas el resultado queda debajo del formulario: se lo trae a la vista.
  const tarjeta = $("resultado").closest(".tarjeta");
  if (desplazar && window.matchMedia("(max-width: 1039px)").matches && tarjeta.getBoundingClientRect().top > window.innerHeight * 0.6) {
    tarjeta.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ===================================================================
// Visor de XML
// ===================================================================

function formatearXml(textoXml) {
  const doc = new DOMParser().parseFromString(textoXml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length) return textoXml;

  const atributo = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const formatear = (nodo, nivel) => {
    const pad = "  ".repeat(nivel);
    const atributos = [...nodo.attributes].map((a) => ` ${a.name}="${atributo(a.value)}"`).join("");
    const contenido = [...nodo.childNodes].filter((c) => c.nodeType === 1 || c.nodeType === 8 || (c.nodeType === 3 && c.nodeValue.trim()));
    if (!contenido.length) return `${pad}<${nodo.nodeName}${atributos} />`;
    if (contenido.every((c) => c.nodeType === 3)) return `${pad}<${nodo.nodeName}${atributos}>${escaparXml(nodo.textContent.trim())}</${nodo.nodeName}>`;
    const interior = contenido.map((c) =>
      c.nodeType === 1 ? formatear(c, nivel + 1)
        : c.nodeType === 8 ? `${pad}  <!--${c.nodeValue}-->`
          : `${pad}  ${escaparXml(c.nodeValue.trim())}`).join("\n");
    return `${pad}<${nodo.nodeName}${atributos}>\n${interior}\n${pad}</${nodo.nodeName}>`;
  };
  return formatear(doc.documentElement, 0);
}

function resaltar(xml) {
  const html = xml.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.replace(/(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)(\s*\/?&gt;)/g,
    (m, comentario, abre, nombre, atributos, cierra) => {
      if (comentario) return `<span class="x-com">${comentario}</span>`;
      const attrs = atributos.replace(/([\w:.-]+)=("[^"]*")/g, '<span class="x-attr">$1</span>=<span class="x-val">$2</span>');
      return `<span class="x-tag">${abre}${nombre}</span>${attrs}<span class="x-tag">${cierra}</span>`;
    });
}

let vistaXml = "respuesta";

function visorXml(llamada) {
  const textos = {
    respuesta: llamada.cuerpo ? formatearXml(llamada.cuerpo) : "(sin respuesta)",
    pedido: llamada.pedido
  };
  const info = {
    respuesta: llamada.tipoContenido ? `Content-Type: ${llamada.tipoContenido}` : "",
    pedido: `POST ${llamada.url} · SOAPAction: "${llamada.accion}"`
  };

  const pre = crear("pre", { tabindex: "0" });
  const detalle = crear("span", { class: "visor-info" });
  const botones = {};
  const cambiar = (vista) => {
    vistaXml = vista;
    pre.innerHTML = resaltar(textos[vista]);
    detalle.textContent = info[vista];
    for (const [k, b] of Object.entries(botones)) b.setAttribute("aria-pressed", String(k === vista));
  };
  botones.respuesta = crear("button", { type: "button", onclick: () => cambiar("respuesta") }, "Respuesta");
  botones.pedido = crear("button", { type: "button", onclick: () => cambiar("pedido") }, "Pedido");

  const copiar = crear("button", {
    type: "button", class: "boton boton-chico secundario",
    onclick: async () => {
      try { await navigator.clipboard.writeText(textos[vistaXml]); copiar.textContent = "Copiado"; }
      catch { copiar.textContent = "No se pudo copiar"; }
      setTimeout(() => { copiar.textContent = "Copiar"; }, 1500);
    }
  }, "Copiar");
  const editar = crear("button", {
    type: "button", class: "boton boton-chico secundario",
    onclick: () => abrirEnXmlLibre(llamada.operacion, llamada.pedido, llamada.accion)
  }, "Reenviar editado");

  const visor = crear("div", { class: "visor" },
    crear("div", { class: "visor-barra" },
      crear("div", { class: "segmentos", role: "group", "aria-label": "XML" }, botones.respuesta, botones.pedido),
      crear("div", { class: "res-acciones" }, copiar, editar)),
    crear("div", { class: "visor-barra" }, detalle),
    pre);
  cambiar(vistaXml);
  return visor;
}

// ===================================================================
// Historial
// ===================================================================

function tonoDe(llamada) {
  const a = llamada.analisis;
  const resultadoCae = llamada.operacion === "FECAESolicitar" ? texto(hijo(a.resultado, "FeCabResp"), "Resultado") : "";
  if (resultadoCae === "A") return ["A", "ok"];
  if (resultadoCae === "R") return ["R", "error"];
  if (a.tipo === "ok") return ["OK", "ok"];
  if (a.tipo === "errores") return [a.errores[0].codigo, "error"];
  return [a.tipo === "fault" ? "Fault" : a.tipo === "sin-conexion" ? "Sin conexión" : `HTTP ${llamada.estado}`, "error"];
}

function agregarAlHistorial(llamada) {
  historial.unshift(llamada);
  if (historial.length > 100) historial.pop();
  const [etiqueta, tono] = tonoDe(llamada);
  const item = crear("li", {},
    crear("button", { type: "button", "data-id": llamada.id, onclick: () => mostrarLlamada(llamada) },
      crear("span", { class: "hora" }, llamada.hora.toLocaleTimeString("es-AR")),
      crear("span", { class: "op" }, llamada.operacion),
      insignia(etiqueta, tono),
      crear("span", { class: "ms" }, `${llamada.milisegundos} ms`)));
  $("historial").prepend(item);
  while ($("historial").children.length > 100) $("historial").lastElementChild.remove();
  $("h-vacio").hidden = true;
}

$("h-limpiar").addEventListener("click", () => {
  historial.length = 0;
  $("historial").replaceChildren();
  $("h-vacio").hidden = false;
});

// ===================================================================
// Utilidades de formulario
// ===================================================================

function llenarSelect(select, opciones, seleccionado) {
  select.replaceChildren(...opciones.map(([valor, nombre]) => crear("option", { value: valor }, `${valor} · ${nombre}`)));
  if (seleccionado !== undefined) select.value = String(seleccionado);
}

function nombreDe(lista, codigo) {
  const item = lista.find(([c]) => String(c) === String(codigo));
  return item ? `${codigo} · ${item[1]}` : String(codigo);
}

function nombreTipo(codigo) { return nombreDe(TIPOS, codigo); }

function soloNombreTipo(codigo) {
  return TIPOS.find(([c]) => String(c) === String(codigo))?.[1] ?? `Tipo ${codigo}`;
}

const registros = (cantidad) => `${cantidad} ${cantidad === 1 ? "registro" : "registros"}`;

function claseDe(tipo) { return Number(tipo) <= 3 ? "A" : Number(tipo) <= 8 ? "B" : "C"; }

function hoyArgentina() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" });
}

const aFecha8 = (iso) => (iso ?? "").replaceAll("-", "");
const redondear = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const importe = (v) => String(redondear(v));

async function conBotonOcupado(boton, accion) {
  const textoOriginal = boton.textContent;
  boton.disabled = true;
  boton.textContent = "Enviando…";
  try { return await accion(); }
  finally { boton.disabled = false; boton.textContent = textoOriginal; }
}

/** Revisa la conexión antes de enviar. FEDummy y el WSDL no piden Auth: solo necesitan la URL. */
function validarConexion({ conAuth = true } = {}) {
  const { url, cuit, token } = credenciales();
  const problemas = [];
  if (!/^https?:\/\/.+/i.test(url)) problemas.push(["url", "la URL del servicio (http:// o https://)"]);
  if (conAuth && !/^\d{11}$/.test(cuit)) problemas.push(["cuit", "la CUIT (11 dígitos, sin guiones)"]);
  if (conAuth && !token) problemas.push(["token", "la API key"]);
  if (!problemas.length) return true;
  $("resultado").replaceChildren(crear("div", { class: "vacio" },
    crear("p", {}, `Falta completar ${problemas.map(([, texto]) => texto).join(", ")}.`)));
  $(problemas[0][0]).focus();
  return false;
}

/** El botón que envió el formulario (con Enter, el primero de tipo submit). */
function botonDe(evento) {
  return evento.submitter ?? evento.currentTarget.querySelector('[type="submit"]');
}

// ===================================================================
// Pestañas
// ===================================================================

const pestanas = [...document.querySelectorAll('[role="tab"]')];

function activarPestana(pestana) {
  for (const p of pestanas) {
    const activa = p === pestana;
    p.setAttribute("aria-selected", String(activa));
    p.tabIndex = activa ? 0 : -1;
    $(p.getAttribute("aria-controls")).hidden = !activa;
  }
  try { sessionStorage.setItem("clienteSoap.pestana", pestana.id); } catch { /* sin almacenamiento */ }
}

for (const p of pestanas) {
  p.addEventListener("click", () => activarPestana(p));
  p.addEventListener("keydown", (e) => {
    const i = pestanas.indexOf(p);
    const destino = e.key === "ArrowRight" ? pestanas[(i + 1) % pestanas.length]
      : e.key === "ArrowLeft" ? pestanas[(i - 1 + pestanas.length) % pestanas.length] : null;
    if (destino) { e.preventDefault(); activarPestana(destino); destino.focus(); }
  });
}

// ===================================================================
// Conexión: FEDummy y WSDL
// ===================================================================

function estadoConexion(textoEstado, clase) {
  $("estado-conexion").textContent = textoEstado;
  $("estado-conexion").className = `estado ${clase}`;
}

$("btn-dummy").addEventListener("click", (e) => {
  if (!validarConexion({ conAuth: false })) return;
  conBotonOcupado(e.currentTarget, async () => {
    estadoConexion("Conectando…", "cargando");
    const llamada = await llamar("FEDummy", sobre("FEDummy"), { desplazar: false });
    const ok = llamada.analisis.tipo === "ok"
      && ["AppServer", "DbServer", "AuthServer"].every((k) => texto(llamada.analisis.resultado, k) === "OK");
    estadoConexion(ok ? `En línea · ${llamada.milisegundos} ms` : llamada.analisis.detalle ?? "El servicio respondió con problemas", ok ? "ok" : "error");
  });
});

async function leerWsdl() {
  const { url } = credenciales();
  try {
    const r = await fetch(`api/wsdl?url=${encodeURIComponent(url)}`);
    const datos = await r.json();
    if (!r.ok || datos.error) return { error: datos.error ?? `HTTP ${r.status}` };
    if (datos.estado !== 200) return { error: `El WSDL respondió HTTP ${datos.estado}.`, datos };
    const doc = new DOMParser().parseFromString(datos.cuerpo, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) return { error: "El WSDL no es XML válido.", datos };
    const portType = descendiente(doc, "portType");
    const operaciones = portType ? hijos(portType, "operation").map((o) => o.getAttribute("name")) : [];
    const servicio = descendiente(doc, "service");
    const direccion = servicio ? doc.getElementsByTagNameNS("*", "address")[0]?.getAttribute("location") : null;
    return {
      datos, operaciones, direccion,
      nombre: servicio?.getAttribute("name"),
      espacio: doc.documentElement.getAttribute("targetNamespace"),
      faltan: OPERACIONES.filter((o) => !operaciones.includes(o))
    };
  } catch {
    return { error: "La app de prueba no responde." };
  }
}

$("btn-wsdl").addEventListener("click", (e) => {
  if (!validarConexion({ conAuth: false })) return;
  conBotonOcupado(e.currentTarget, async () => {
    const info = await leerWsdl();
    const caja = $("wsdl-info");
    caja.hidden = false;
    if (info.error) {
      caja.replaceChildren(crear("strong", {}, "No se pudo leer el WSDL: "), info.error);
      return;
    }
    caja.replaceChildren(
      crear("div", {},
        crear("strong", {}, `WSDL de ${info.nombre ?? "servicio"} · ${info.operaciones.length} operaciones`),
        info.faltan.length ? crear("span", { class: "insignia error", style: "margin-left:8px" }, `Faltan ${info.faltan.length}`) : crear("span", { class: "insignia ok", style: "margin-left:8px" }, "Completo")),
      crear("div", { class: "visor-info" }, `targetNamespace ${info.espacio} · ${info.datos.milisegundos} ms${info.direccion ? " · address " + info.direccion : ""}`),
      crear("div", { class: "chips" },
        info.operaciones.map((o) => crear("span", { class: "chip" }, o)),
        info.faltan.map((o) => crear("span", { class: "chip falta", title: "No figura en el WSDL" }, o))));
  });
});

// ===================================================================
// Emitir (FECAESolicitar)
// ===================================================================

function datosEmision() {
  const tipo = Number($("e-tipo").value);
  const clase = claseDe(tipo);
  const concepto = Number($("e-concepto").value);
  const neto = redondear($("e-neto").value || 0);
  const noGravado = clase === "C" ? 0 : redondear($("e-no-gravado").value || 0);
  const exento = clase === "C" ? 0 : redondear($("e-exento").value || 0);
  const alicuota = ALICUOTAS.find(([id]) => id === Number($("e-alicuota").value));
  const ivaCalculado = clase === "C" ? 0 : redondear(neto * alicuota[2]);
  const manual = $("e-manual").checked;
  const iva = manual ? redondear($("e-iva").value || 0) : ivaCalculado;
  const total = manual ? redondear($("e-total").value || 0) : redondear(neto + noGravado + exento + iva);
  const numero = Number($("e-numero").value) || 0;

  return {
    ptoVta: Number($("e-ptovta").value), tipo, clase, concepto, numero,
    fecha: aFecha8($("e-fecha").value),
    servDesde: aFecha8($("e-serv-desde").value), servHasta: aFecha8($("e-serv-hasta").value), vtoPago: aFecha8($("e-vto-pago").value),
    docTipo: Number($("e-doctipo").value), docNro: $("e-docnro").value.trim() || "0",
    condicion: Number($("e-condicion").value),
    neto, noGravado, exento, iva, total, alicuotaId: alicuota[0]
  };
}

function feCaeReq(d) {
  const servicios = d.concepto !== 1;
  return n("FeCAEReq",
    n("FeCabReq", n("CantReg", 1), n("PtoVta", d.ptoVta), n("CbteTipo", d.tipo)),
    n("FeDetReq", n("FECAEDetRequest",
      n("Concepto", d.concepto),
      n("DocTipo", d.docTipo), n("DocNro", d.docNro),
      n("CbteDesde", d.numero), n("CbteHasta", d.numero),
      n("CbteFch", d.fecha),
      n("ImpTotal", importe(d.total)), n("ImpTotConc", importe(d.noGravado)), n("ImpNeto", importe(d.neto)),
      n("ImpOpEx", importe(d.exento)), n("ImpTrib", 0), n("ImpIVA", importe(d.iva)),
      servicios ? [n("FchServDesde", d.servDesde), n("FchServHasta", d.servHasta), n("FchVtoPago", d.vtoPago)] : null,
      n("MonId", "PES"), n("MonCotiz", 1),
      // Una sola alícuota: su importe es el ImpIVA (si se cargó a mano, también va acá y se rechaza con 10051).
      d.clase === "C" ? null : n("Iva", n("AlicIva", n("Id", d.alicuotaId), n("BaseImp", importe(d.neto)), n("Importe", importe(d.iva)))),
      n("CondicionIVAReceptorId", d.condicion))));
}

function recalcular() {
  const clase = claseDe($("e-tipo").value);
  const esC = clase === "C";
  $("e-alicuota-campo").hidden = esC;
  $("e-noGravado-campo").hidden = esC;
  $("e-exento-campo").hidden = esC;
  $("e-neto-etiqueta").textContent = esC ? "Subtotal" : "Neto gravado";
  $("e-servicios").hidden = Number($("e-concepto").value) === 1;

  const manual = $("e-manual").checked;
  $("e-iva").readOnly = !manual || esC;
  $("e-total").readOnly = !manual;
  if (!manual) {
    const d = datosEmision();
    $("e-iva").value = d.iva.toFixed(2);
    $("e-total").value = d.total.toFixed(2);
  } else if (esC) {
    $("e-iva").value = "0.00";
  }
}

/** Al cambiar la clase, deja un receptor que el servicio acepte para esa clase. */
function ajustarReceptor() {
  const clase = claseDe($("e-tipo").value);
  const anterior = Number($("e-condicion").value);
  const opciones = CONDICIONES.filter(([, , clases]) => clases.includes(clase));
  llenarSelect($("e-condicion"), opciones);
  if (opciones.some(([id]) => id === anterior)) {
    $("e-condicion").value = String(anterior);
  } else if (clase === "A") {
    // Monotributista de los datos de prueba de ArcaSim.
    $("e-condicion").value = "6";
    $("e-doctipo").value = "80";
    $("e-docnro").value = "27287654311";
  } else {
    $("e-condicion").value = "5";
    $("e-doctipo").value = "99";
    $("e-docnro").value = "0";
  }
}

async function pedirUltimo(ptoVta, tipo, opciones) {
  const llamada = await llamar("FECompUltimoAutorizado",
    sobre("FECompUltimoAutorizado", auth(), n("PtoVta", ptoVta), n("CbteTipo", tipo)), opciones);
  const ok = llamada.analisis.tipo === "ok";
  return { llamada, ok, ultimo: ok ? Number(texto(llamada.analisis.resultado, "CbteNro")) : null };
}

function usarProximoEnEmision(ptoVta, tipo, numero) {
  $("e-ptovta").value = ptoVta;
  $("e-tipo").value = String(tipo);
  ajustarReceptor();
  $("e-numero").value = numero;
  $("e-auto").checked = false;
  recalcular();
  activarPestana($("tab-emitir"));
  $("e-numero").focus();
}

async function consultarComprobante(ptoVta, tipo, numero) {
  $("c-ptovta").value = ptoVta;
  $("c-tipo").value = String(tipo);
  $("c-numero").value = numero;
  activarPestana($("tab-consultar"));
  await llamar("FECompConsultar", sobre("FECompConsultar", auth(),
    n("FeCompConsReq", n("CbteTipo", tipo), n("CbteNro", numero), n("PtoVta", ptoVta))));
}

$("e-proximo").addEventListener("click", (e) => {
  if (!validarConexion()) return;
  conBotonOcupado(e.currentTarget, async () => {
    const { ok, ultimo } = await pedirUltimo(Number($("e-ptovta").value), Number($("e-tipo").value));
    if (ok) { $("e-numero").value = ultimo + 1; $("e-auto").checked = false; }
  });
});

/** Completa el número con el último autorizado + 1 si hace falta. Devuelve false si no se pudo. */
async function asegurarNumero() {
  if (!$("e-auto").checked && $("e-numero").value) return true;
  const { ok, ultimo } = await pedirUltimo(Number($("e-ptovta").value), Number($("e-tipo").value));
  if (ok) $("e-numero").value = ultimo + 1;
  return ok;  // si falló, el error de FECompUltimoAutorizado ya está a la vista
}

$("panel-emitir").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!validarConexion()) return;
  conBotonOcupado(botonDe(e), async () => {
    if (!await asegurarNumero()) return;
    await llamar("FECAESolicitar", sobre("FECAESolicitar", auth(), feCaeReq(datosEmision())));
    // Después de un envío con número fijo, el próximo se vuelve a pedir solo.
    $("e-auto").checked = true;
  });
});

$("e-editar").addEventListener("click", (e) => {
  if (!validarConexion()) return;
  conBotonOcupado(e.currentTarget, async () => {
    if (!await asegurarNumero()) return;
    abrirEnXmlLibre("FECAESolicitar", sobre("FECAESolicitar", auth(), feCaeReq(datosEmision())));
  });
});

for (const id of ["e-neto", "e-no-gravado", "e-exento"]) $(id).addEventListener("input", recalcular);
for (const id of ["e-alicuota", "e-concepto", "e-manual"]) $(id).addEventListener("change", recalcular);
$("e-tipo").addEventListener("change", () => { ajustarReceptor(); recalcular(); });

// ===================================================================
// Último autorizado y consulta
// ===================================================================

$("panel-ultimo").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!validarConexion()) return;
  conBotonOcupado(botonDe(e), () => pedirUltimo(Number($("u-ptovta").value), Number($("u-tipo").value)));
});

$("panel-consultar").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!validarConexion()) return;
  conBotonOcupado(botonDe(e), () =>
    consultarComprobante(Number($("c-ptovta").value), Number($("c-tipo").value), Number($("c-numero").value)));
});

// ===================================================================
// Catálogos
// ===================================================================

for (const [operacion, descripcion] of CATALOGOS) {
  const conClase = operacion === "FEParamGetCondicionIvaReceptor";
  const clase = conClase
    ? crear("select", { "aria-label": "ClaseCmp" },
      ["A", "B", "C", ""].map((c) => crear("option", { value: c }, c ? `Clase ${c}` : "Todas")))
    : null;
  const boton = crear("button", { type: "button", class: "boton boton-chico" }, "Consultar");
  boton.addEventListener("click", () => {
    if (!validarConexion()) return;
    const parametros = conClase ? [auth(), n("ClaseCmp", clase.value)] : [auth()];
    conBotonOcupado(boton, () => llamar(operacion, sobre(operacion, ...parametros)));
  });
  $("lista-catalogos").append(crear("div", { class: "catalogo" },
    crear("div", {}, crear("strong", {}, descripcion), crear("small", {}, operacion)),
    crear("span", { class: "con-boton" }, clase, boton)));
}

// ===================================================================
// XML libre
// ===================================================================

$("l-operacion").replaceChildren(...OPERACIONES.map((o) => crear("option", { value: o }, o)));

function abrirEnXmlLibre(operacion, xml, accion = NS + operacion) {
  if (OPERACIONES.includes(operacion)) $("l-operacion").value = operacion;
  $("l-accion").value = accion;
  $("l-xml").value = xml;
  activarPestana($("tab-libre"));
  $("l-xml").focus();
  $("l-xml").setSelectionRange(0, 0);
  $("l-xml").scrollTop = 0;
}

$("l-operacion").addEventListener("change", () => {
  const op = $("l-operacion").value;
  $("l-accion").value = NS + op;
  $("l-xml").value = plantilla(op);
});

$("l-plantilla").addEventListener("click", () => {
  const op = $("l-operacion").value;
  $("l-accion").value = NS + op;
  $("l-xml").value = plantilla(op);
});

$("l-xml").addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const t = e.currentTarget;
    t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end");
  }
});

$("panel-libre").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!validarConexion({ conAuth: false })) return;
  const accion = $("l-accion").value.trim().replace(/^"|"$/g, "");
  conBotonOcupado(botonDe(e), () => llamar(operacionDeAccion(accion), $("l-xml").value, { accion }));
});

// ===================================================================
// Prueba automática
// ===================================================================

function otraCuit(cuit) { return cuit === "27287654311" ? "30712345671" : "27287654311"; }

function errorConCodigo(llamada, codigo) {
  return llamada.analisis.tipo === "errores" && llamada.analisis.errores.some((e) => e.codigo === String(codigo));
}

function describirFalla(llamada) {
  const a = llamada.analisis;
  if (a.tipo === "errores") return a.errores.map((e) => `${e.codigo}: ${e.mensaje}`).join(" · ");
  if (a.tipo === "ok") return "Respondió sin errores.";
  return a.detalle;
}

function facturaDePrueba(ptoVta, tipo, numero, { total } = {}) {
  const esC = claseDe(tipo) === "C";
  const neto = esC ? 121 : 100, iva = esC ? 0 : 21;
  return {
    ptoVta, tipo, clase: claseDe(tipo), concepto: 1, numero, fecha: aFecha8(hoyArgentina()),
    docTipo: 99, docNro: "0", condicion: 5,
    neto, noGravado: 0, exento: 0, iva, total: total ?? neto + iva, alicuotaId: 5
  };
}

function definirPasos({ ptoVta, tipo, emitir }) {
  const ctx = {};
  const pasos = [
    {
      nombre: "El WSDL se publica con las 12 operaciones",
      correr: async () => {
        const info = await leerWsdl();
        if (info.error) return { ok: false, detalle: info.error, ms: info.datos?.milisegundos };
        return {
          ok: info.faltan.length === 0 && info.espacio === NS,
          detalle: info.faltan.length ? `Faltan: ${info.faltan.join(", ")}` : `${info.operaciones.length} operaciones · targetNamespace ${info.espacio}`,
          ms: info.datos.milisegundos
        };
      }
    },
    {
      nombre: "FEDummy responde AppServer, DbServer y AuthServer en OK",
      critico: true,
      correr: async () => {
        const l = await llamar("FEDummy", sobre("FEDummy"), { mostrar: false });
        const valores = l.analisis.tipo === "ok" ? ["AppServer", "DbServer", "AuthServer"].map((k) => `${k}=${texto(l.analisis.resultado, k)}`) : [];
        return { ok: valores.length === 3 && valores.every((v) => v.endsWith("=OK")), detalle: valores.join(" · ") || describirFalla(l), llamada: l };
      }
    },
    {
      nombre: "Con la API key y la CUIT correctas, el Auth se acepta",
      critico: true,
      correr: async () => {
        const l = await llamar("FECompTotXRequest", sobre("FECompTotXRequest", auth()), { mostrar: false });
        return { ok: l.analisis.tipo === "ok", detalle: l.analisis.tipo === "ok" ? `FECompTotXRequest → RegXReq = ${texto(l.analisis.resultado, "RegXReq")}` : describirFalla(l), llamada: l };
      }
    },
    {
      nombre: "Una API key inexistente devuelve el error 600",
      correr: async () => {
        const l = await llamar("FECompTotXRequest", sobre("FECompTotXRequest", auth({ token: "clave-inexistente-" + Date.now() })), { mostrar: false });
        return { ok: errorConCodigo(l, 600), detalle: describirFalla(l), llamada: l };
      }
    },
    {
      nombre: "Una CUIT que no es la de la API key devuelve el error 601",
      correr: async () => {
        const cuit = otraCuit(credenciales().cuit);
        const l = await llamar("FECompTotXRequest", sobre("FECompTotXRequest", auth({ cuit })), { mostrar: false });
        return { ok: errorConCodigo(l, 601), detalle: `Con CUIT ${cuit}: ${describirFalla(l)}`, llamada: l };
      }
    },
    {
      nombre: "Mandar Sign (firma WSAA) devuelve el error 600",
      correr: async () => {
        const l = await llamar("FECompTotXRequest", sobre("FECompTotXRequest", auth({ sign: "firma-de-prueba" })), { mostrar: false });
        return { ok: errorConCodigo(l, 600), detalle: describirFalla(l), llamada: l };
      }
    },
    ...CATALOGOS.filter(([op]) => op.startsWith("FEParam")).map(([op, descripcion]) => ({
      nombre: `${op} devuelve ${descripcion.charAt(0).toLowerCase()}${descripcion.slice(1)}`,
      correr: async () => {
        const parametros = op === "FEParamGetCondicionIvaReceptor" ? [auth(), n("ClaseCmp", "")] : [auth()];
        const l = await llamar(op, sobre(op, ...parametros), { mostrar: false });
        const filas = l.analisis.tipo === "ok" ? [...(hijo(l.analisis.resultado, "ResultGet")?.children ?? [])] : [];
        const muestra = filas.slice(0, 4).map((f) => texto(f, "Id") || texto(f, "Nro")).filter(Boolean).join(", ");
        return {
          ok: filas.length > 0,
          detalle: filas.length ? `${registros(filas.length)}${muestra ? ` (${muestra}${filas.length > 4 ? "…" : ""})` : ""}` : describirFalla(l),
          llamada: l
        };
      }
    })),
    {
      nombre: `FECompUltimoAutorizado para el punto de venta ${ptoVta}, ${nombreTipo(tipo)}`,
      critico: emitir,
      correr: async () => {
        const { llamada, ok, ultimo } = await pedirUltimo(ptoVta, tipo, { mostrar: false });
        ctx.ultimo = ultimo;
        return { ok, detalle: ok ? `Último autorizado: ${ultimo}` : describirFalla(llamada), llamada };
      }
    }
  ];

  if (!emitir) return pasos.concat(
    ["FECAESolicitar aprueba una factura válida", "El último autorizado aumentó en 1", "FECompConsultar devuelve el mismo CAE e importes",
      "Reenviar el mismo número se rechaza", "Un total mal sumado se rechaza con 10048"]
      .map((nombre) => ({ nombre, omitir: "Desactivaste las pruebas que emiten." })));

  return pasos.concat([
    {
      nombre: "FECAESolicitar aprueba una factura válida y devuelve el CAE",
      critico: true,
      correr: async () => {
        ctx.numero = ctx.ultimo + 1;
        const l = await llamar("FECAESolicitar", sobre("FECAESolicitar", auth(), feCaeReq(facturaDePrueba(ptoVta, tipo, ctx.numero))), { mostrar: false });
        const det = l.analisis.tipo === "ok" || l.analisis.tipo === "errores" ? hijo(hijo(l.analisis.resultado, "FeDetResp"), "FECAEDetResponse") : null;
        const resultado = texto(hijo(l.analisis.resultado, "FeCabResp"), "Resultado");
        ctx.cae = texto(det, "CAE");
        const ok = resultado === "A" && /^\d{14}$/.test(ctx.cae);
        return { ok, detalle: ok ? `N.º ${ctx.numero} · CAE ${ctx.cae} · vence ${fecha8(texto(det, "CAEFchVto"))}` : `Resultado ${resultado || "—"} · ${describirFalla(l)}`, llamada: l };
      }
    },
    {
      nombre: "El último autorizado aumentó en 1",
      correr: async () => {
        const { llamada, ok, ultimo } = await pedirUltimo(ptoVta, tipo, { mostrar: false });
        return { ok: ok && ultimo === ctx.numero, detalle: ok ? `Ahora es ${ultimo} (se esperaba ${ctx.numero})` : describirFalla(llamada), llamada };
      }
    },
    {
      nombre: "FECompConsultar devuelve el mismo CAE e importes",
      correr: async () => {
        const l = await llamar("FECompConsultar", sobre("FECompConsultar", auth(),
          n("FeCompConsReq", n("CbteTipo", tipo), n("CbteNro", ctx.numero), n("PtoVta", ptoVta))), { mostrar: false });
        const g = l.analisis.tipo === "ok" ? hijo(l.analisis.resultado, "ResultGet") : null;
        const cae = texto(g, "CodAutorizacion"), total = Number(texto(g, "ImpTotal"));
        return { ok: !!g && cae === ctx.cae && total === 121, detalle: g ? `CAE ${cae} · ImpTotal ${total}` : describirFalla(l), llamada: l };
      }
    },
    {
      nombre: "Reenviar el mismo número se rechaza",
      correr: async () => {
        const l = await llamar("FECAESolicitar", sobre("FECAESolicitar", auth(), feCaeReq(facturaDePrueba(ptoVta, tipo, ctx.numero))), { mostrar: false });
        const resultado = texto(hijo(l.analisis.resultado, "FeCabResp"), "Resultado");
        return { ok: resultado === "R" && l.analisis.errores?.length > 0, detalle: `Resultado ${resultado || "—"} · ${describirFalla(l)}`, llamada: l };
      }
    },
    {
      nombre: "Un total mal sumado se rechaza con 10048",
      correr: async () => {
        const l = await llamar("FECAESolicitar", sobre("FECAESolicitar", auth(),
          feCaeReq(facturaDePrueba(ptoVta, tipo, ctx.numero + 1, { total: 120 }))), { mostrar: false });
        const resultado = texto(hijo(l.analisis.resultado, "FeCabResp"), "Resultado");
        const con10048 = (l.analisis.errores ?? []).some((e) => e.mensaje.includes("10048"));
        return { ok: resultado === "R" && con10048, detalle: `ImpTotal 120 en vez de 121 · Resultado ${resultado || "—"} · ${describirFalla(l)}`, llamada: l };
      }
    }
  ]);
}

function filaPaso(paso, indice) {
  const icono = crear("span", { class: "paso-icono", "aria-hidden": "true" }, String(indice + 1));
  const nombre = crear("span", { class: "paso-nombre" }, paso.nombre);
  const detalle = crear("span", { class: "paso-detalle" });
  const tiempo = crear("span", { class: "paso-tiempo" });
  const fila = crear("button", { type: "button", class: "paso", disabled: true }, icono, crear("span", {}, nombre, detalle), tiempo);
  return {
    li: crear("li", {}, fila),
    estado(clase, simbolo, textoDetalle, ms, llamada) {
      fila.className = `paso ${clase}`;
      icono.textContent = simbolo;
      detalle.textContent = textoDetalle ?? "";
      tiempo.textContent = ms !== undefined && ms !== null ? `${ms} ms` : "";
      if (llamada) {
        fila.disabled = false;
        fila.title = "Ver el pedido y la respuesta";
        fila.onclick = () => mostrarLlamada(llamada);
      }
    }
  };
}

$("a-correr").addEventListener("click", (e) => {
  if (!validarConexion()) return;
  const config = { ptoVta: Number($("a-ptovta").value) || 1, tipo: Number($("a-tipo").value), emitir: $("a-emitir").checked };
  const pasos = definirPasos(config);
  const filas = pasos.map(filaPaso);
  $("a-pasos").replaceChildren(...filas.map((f) => f.li));
  $("a-resumen").textContent = "";
  $("a-resumen").className = "resumen-pruebas";

  conBotonOcupado(e.currentTarget, async () => {
    let bien = 0, mal = 0, omitidas = 0, cortar = null;
    for (const [i, paso] of pasos.entries()) {
      const fila = filas[i];
      if (paso.omitir || cortar) {
        fila.estado("omitido", "–", paso.omitir ?? cortar);
        omitidas++;
        continue;
      }
      fila.estado("corriendo", "…", "Ejecutando…");
      let r;
      try { r = await paso.correr(); }
      catch (error) { r = { ok: false, detalle: `Error inesperado: ${error.message}` }; }
      fila.estado(r.ok ? "ok" : "error", r.ok ? "✓" : "✗", r.detalle, r.ms ?? r.llamada?.milisegundos, r.llamada);
      if (r.ok) bien++; else mal++;
      if (!r.ok && paso.critico) cortar = `Se omitió porque falló el paso ${i + 1}.`;
      $("a-resumen").textContent = `${bien} de ${bien + mal} bien…`;
    }
    $("a-resumen").textContent = `${bien} bien · ${mal} mal${omitidas ? ` · ${omitidas} omitidas` : ""}`;
    $("a-resumen").className = `resumen-pruebas ${mal ? "error" : "ok"}`;
  });
});

// ===================================================================
// Inicio
// ===================================================================

(function iniciar() {
  $("url").value = guardado.leer("localStorage", "url") ?? "http://localhost:5030/wsfev1/service.asmx";
  $("cuit").value = guardado.leer("localStorage", "cuit") ?? "30712345671";
  $("token").value = guardado.leer("sessionStorage", "token") ?? "";
  $("url").addEventListener("change", () => guardado.escribir("localStorage", "url", $("url").value.trim()));
  $("cuit").addEventListener("change", () => guardado.escribir("localStorage", "cuit", $("cuit").value.trim()));
  $("token").addEventListener("input", () => guardado.escribir("sessionStorage", "token", $("token").value.trim()));
  $("form-conexion").addEventListener("submit", (e) => e.preventDefault());

  $("ver-token").addEventListener("click", (e) => {
    const visible = $("token").type === "text";
    $("token").type = visible ? "password" : "text";
    e.currentTarget.textContent = visible ? "Mostrar" : "Ocultar";
    e.currentTarget.setAttribute("aria-pressed", String(!visible));
  });

  for (const select of document.querySelectorAll('select[data-catalogo="tipos"]')) llenarSelect(select, TIPOS, 6);
  for (const select of document.querySelectorAll('select[data-catalogo="conceptos"]')) llenarSelect(select, CONCEPTOS, 1);
  for (const select of document.querySelectorAll('select[data-catalogo="documentos"]')) llenarSelect(select, DOCUMENTOS, 99);
  for (const select of document.querySelectorAll('select[data-catalogo="alicuotas"]')) llenarSelect(select, ALICUOTAS, 5);

  const hoy = hoyArgentina();
  for (const id of ["e-fecha", "e-serv-desde", "e-serv-hasta", "e-vto-pago"]) $(id).value = hoy;

  ajustarReceptor();
  recalcular();

  $("l-operacion").value = "FECompUltimoAutorizado";
  $("l-accion").value = NS + "FECompUltimoAutorizado";
  $("l-xml").value = plantilla("FECompUltimoAutorizado");

  let pestana = null;
  try { pestana = sessionStorage.getItem("clienteSoap.pestana"); } catch { /* sin almacenamiento */ }
  if (pestana && $(pestana)) activarPestana($(pestana));
})();
