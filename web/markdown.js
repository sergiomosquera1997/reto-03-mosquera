// Markdown mínimo y seguro para las respuestas del agente: tablas, listas, títulos,
// negrita, cursiva y código. Todo el texto se escapa ANTES de dar formato, así que el
// HTML que devuelve no puede contener etiquetas que vengan del modelo.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

export function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

function enLinea(texto) {
  const codigos = []
  let html = escapar(texto).replace(/`([^`]+)`/g, (_, codigo) => {
    codigos.push(`<code>${codigo}</code>`)
    return `\u0000${codigos.length - 1}\u0000`
  })
  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => codigos[Number(i)])
}

function celdas(linea) {
  return linea.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

const ES_SEPARADOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const ES_FILA = /^\s*\|.*\|\s*$/
const ES_VIÑETA = /^\s*[-*]\s+/
const ES_NUMERADA = /^\s*\d+[.)]\s+/
const ES_TITULO = /^(#{1,4})\s+(.*)$/

function tabla(lineas, i) {
  const encabezado = celdas(lineas[i])
  const filas = []
  let j = i + 2
  while (j < lineas.length && ES_FILA.test(lineas[j])) filas.push(celdas(lineas[j++]))
  const th = encabezado.map((c) => `<th>${enLinea(c)}</th>`).join("")
  const tr = filas.map((f) => `<tr>${f.map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`).join("")
  return { html: `<div class="tabla"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`, siguiente: j }
}

function lista(lineas, i, patron, etiqueta) {
  const items = []
  let j = i
  while (j < lineas.length && patron.test(lineas[j])) items.push(`<li>${enLinea(lineas[j++].replace(patron, ""))}</li>`)
  return { html: `<${etiqueta}>${items.join("")}</${etiqueta}>`, siguiente: j }
}

function bloqueCodigo(lineas, i) {
  let j = i + 1
  const contenido = []
  while (j < lineas.length && !lineas[j].trim().startsWith("```")) contenido.push(lineas[j++])
  return { html: `<pre><code>${escapar(contenido.join("\n"))}</code></pre>`, siguiente: j + 1 }
}

function parrafo(lineas, i) {
  const partes = []
  let j = i
  const corta = (l) => !l.trim() || ES_FILA.test(l) || ES_VIÑETA.test(l) || ES_NUMERADA.test(l) || ES_TITULO.test(l) || l.trim().startsWith("```")
  while (j < lineas.length && (j === i || !corta(lineas[j]))) partes.push(enLinea(lineas[j++].trim()))
  return { html: `<p>${partes.join("<br>")}</p>`, siguiente: j }
}

function bloque(lineas, i) {
  const linea = lineas[i]
  if (linea.trim().startsWith("```")) return bloqueCodigo(lineas, i)
  if (ES_FILA.test(linea) && ES_SEPARADOR.test(lineas[i + 1] ?? "")) return tabla(lineas, i)
  if (ES_VIÑETA.test(linea)) return lista(lineas, i, ES_VIÑETA, "ul")
  if (ES_NUMERADA.test(linea)) return lista(lineas, i, ES_NUMERADA, "ol")
  const titulo = ES_TITULO.exec(linea)
  if (titulo) return { html: `<h${titulo[1].length + 2}>${enLinea(titulo[2])}</h${titulo[1].length + 2}>`, siguiente: i + 1 }
  if (/^\s*(---+|\*\*\*+)\s*$/.test(linea)) return { html: "<hr>", siguiente: i + 1 }
  return parrafo(lineas, i)
}

export function renderizarMarkdown(texto) {
  const lineas = String(texto ?? "").replace(/\r\n/g, "\n").split("\n")
  const html = []
  let i = 0
  while (i < lineas.length) {
    if (!lineas[i].trim()) {
      i++
      continue
    }
    const { html: fragmento, siguiente } = bloque(lineas, i)
    html.push(fragmento)
    i = siguiente
  }
  return html.join("")
}
