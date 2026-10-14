// Front del agente OC: chat, llamadas a herramientas visibles y confirmación por caso.
// Solo habla con /api/*; nunca maneja claves.
import { escapar, renderizarMarkdown } from "./markdown.js"

const CLAVE_SESION = "agente-oc-sesion"
const $ = (id) => document.getElementById(id)

const ui = {
  chat: $("chat"),
  bienvenida: $("bienvenida"),
  mensajes: $("mensajes"),
  pensando: $("pensando"),
  confirmacion: $("confirmacion"),
  form: $("entrada"),
  texto: $("mensaje"),
  enviar: $("enviar"),
  nueva: $("nueva-sesion"),
  estado: $("estado-modelo"),
}

let sessionId = ""
let ocupado = false

// ── Sesión (localStorage puede no existir o fallar) ─────────────────────────

function leerSesionGuardada() {
  try {
    return localStorage.getItem(CLAVE_SESION)
  } catch {
    return null
  }
}

function guardarSesion(id) {
  try {
    localStorage.setItem(CLAVE_SESION, id)
  } catch {
    // Sin almacenamiento: la sesión dura lo que dure la pestaña.
  }
}

function generarId() {
  const aleatorio = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `s-${aleatorio}`
}

// ── Render ──────────────────────────────────────────────────────────────────

function alFinal() {
  requestAnimationFrame(() => {
    ui.chat.scrollTop = ui.chat.scrollHeight
  })
}

function agregar(elemento) {
  ui.bienvenida.hidden = true
  ui.mensajes.append(elemento)
  alFinal()
}

function li(clase, html) {
  const el = document.createElement("li")
  el.className = `mensaje ${clase}`
  el.innerHTML = html
  return el
}

function mostrarUsuario(texto) {
  const el = li("usuario", "")
  el.textContent = texto
  agregar(el)
}

function mostrarError(texto) {
  agregar(li("error", `<strong>No se pudo completar:</strong> ${escapar(texto)}`))
}

function argumentosVisibles(args) {
  try {
    return JSON.stringify(args ?? {}, null, 2)
  } catch {
    return String(args)
  }
}

function herramientaHtml(t) {
  const estado = t.ok ? "ok" : "error"
  const icono = t.ok ? "✓" : "✕"
  return `
    <details class="herramienta ${estado}">
      <summary>
        <span class="icono" aria-label="${t.ok ? "correcta" : "con error"}">${icono}</span>
        <span class="nombre">${escapar(t.nombre)}</span>
        <span class="resumen">${escapar(t.resumen)}</span>
        <span class="ms">${Number(t.ms) || 0} ms</span>
      </summary>
      <div class="cuerpo">
        <h4>Argumentos</h4>
        <pre>${escapar(argumentosVisibles(t.args))}</pre>
        <h4>Resultado</h4>
        <p>${escapar(t.resumen)}</p>
      </div>
    </details>`
}

function mostrarAgente(texto, toolCalls = []) {
  const herramientas = toolCalls.length
    ? `<div class="herramientas" aria-label="Llamadas a herramientas">${toolCalls.map(herramientaHtml).join("")}</div>`
    : ""
  agregar(li("agente", `<div class="etiqueta-rol">Agente</div>${herramientas}<div class="contenido">${renderizarMarkdown(texto)}</div>`))
}

function pendienteHtml(p) {
  const reglas = (p.confirmaciones ?? [])
    .map((c) => `<li><span class="regla">${escapar(c.regla)}</span> — ${escapar(c.detalle)}</li>`)
    .join("")
  const caso = escapar(p.caso)
  return `
    <div class="pendiente">
      <div class="detalle">
        <span class="caso">${caso}</span> requiere tu confirmación para crear la OC:
        <ul>${reglas}</ul>
      </div>
      <div class="botones">
        <button type="button" class="boton exito" data-caso="${caso}" data-valor="true">Confirmar ${caso}</button>
        <button type="button" class="boton peligro" data-caso="${caso}" data-valor="false">Cancelar</button>
      </div>
    </div>`
}

function mostrarConfirmaciones(pendientes) {
  const lista = Array.isArray(pendientes) ? pendientes : []
  ui.confirmacion.hidden = lista.length === 0
  ui.confirmacion.innerHTML = lista.length
    ? `<h2>⚠ Confirmación requerida antes de crear la OC</h2>${lista.map(pendienteHtml).join("")}`
    : ""
  bloquear(ocupado)
}

function bloquear(valor) {
  ocupado = valor
  ui.enviar.disabled = valor
  ui.texto.disabled = valor
  ui.nueva.disabled = valor
  ui.pensando.hidden = !valor
  for (const b of ui.confirmacion.querySelectorAll("button")) b.disabled = valor
  for (const b of ui.bienvenida.querySelectorAll("button")) b.disabled = valor
  if (valor) alFinal()
}

// ── API ─────────────────────────────────────────────────────────────────────

async function leerJson(respuesta) {
  try {
    return await respuesta.json()
  } catch {
    return null
  }
}

async function enviar(cuerpo, textoVisible) {
  if (ocupado) return
  mostrarUsuario(textoVisible)
  bloquear(true)
  try {
    const respuesta = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, ...cuerpo }),
    })
    const datos = await leerJson(respuesta)
    if (!respuesta.ok || !datos) {
      mostrarError(datos?.error ?? `El servidor respondió ${respuesta.status}.`)
      return
    }
    mostrarAgente(datos.reply, datos.toolCalls)
    mostrarConfirmaciones(datos.needsConfirmation ? datos.pendientes : [])
  } catch {
    mostrarError("No hay conexión con el servidor. Revisa que esté en marcha e inténtalo de nuevo; la sesión se conserva.")
  } finally {
    bloquear(false)
    ui.texto.focus()
  }
}

async function cargarHistorial() {
  try {
    const respuesta = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
    if (!respuesta.ok) return
    const datos = await respuesta.json()
    for (const entrada of datos.historial ?? []) {
      if (entrada.rol === "usuario") mostrarUsuario(entrada.texto)
      else mostrarAgente(entrada.texto, entrada.toolCalls)
    }
    mostrarConfirmaciones(datos.pendientes)
  } catch {
    // Sin historial (servidor reiniciado o sin conexión): se empieza en blanco.
  }
}

async function cargarEstado() {
  try {
    const datos = await (await fetch("/api/health")).json()
    ui.estado.textContent = `${datos.provider} · ${datos.model}`
    ui.estado.className = "insignia ok"
  } catch {
    ui.estado.textContent = "sin conexión"
    ui.estado.className = "insignia error"
  }
}

// ── Eventos ─────────────────────────────────────────────────────────────────

function enviarTexto(texto) {
  const limpio = texto.trim()
  if (!limpio) return
  ui.texto.value = ""
  ajustarAltura()
  enviar({ message: limpio }, limpio)
}

const ALTURA_MAXIMA = 180

function ajustarAltura() {
  ui.texto.style.height = "auto"
  ui.texto.style.height = `${Math.min(ui.texto.scrollHeight, ALTURA_MAXIMA)}px`
  ui.texto.style.overflowY = ui.texto.scrollHeight > ALTURA_MAXIMA ? "auto" : "hidden"
}

function nuevaSesion() {
  sessionId = generarId()
  guardarSesion(sessionId)
  ui.mensajes.replaceChildren()
  ui.bienvenida.hidden = false
  mostrarConfirmaciones([])
  ui.texto.focus()
}

ui.form.addEventListener("submit", (e) => {
  e.preventDefault()
  enviarTexto(ui.texto.value)
})

ui.texto.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    enviarTexto(ui.texto.value)
  }
})

ui.texto.addEventListener("input", ajustarAltura)
window.addEventListener("resize", ajustarAltura)

ui.bienvenida.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-mensaje]")
  if (chip) enviarTexto(chip.dataset.mensaje)
})

ui.confirmacion.addEventListener("click", (e) => {
  const boton = e.target.closest("button[data-caso]")
  if (!boton) return
  const caso = boton.dataset.caso
  const valor = boton.dataset.valor === "true"
  enviar({ confirm: { caso, valor } }, valor ? `✓ Confirmo ${caso}` : `✕ Cancelo ${caso}`)
})

ui.nueva.addEventListener("click", nuevaSesion)

// ── Inicio ──────────────────────────────────────────────────────────────────

const guardada = leerSesionGuardada()
sessionId = guardada || generarId()
guardarSesion(sessionId)
cargarEstado()
// Una sesión recién generada no tiene historial en el servidor: no se consulta.
if (guardada) cargarHistorial()
ajustarAltura()
ui.texto.focus()
