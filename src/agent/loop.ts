// Ciclo del agente (PRD 6.3): modelo → herramientas → modelo, con topes y confirmación humana.
import { join } from "node:path"
import { agregarLinea } from "../lib/archivos.ts"
import { ErrorLlm, type LlamadaHerramienta, type LlmAdapter, type Mensaje } from "../llm/adapter.ts"
import {
  actualizarPendientes,
  autorizarCreacion,
  clasificarMensaje,
  resolverAtajo,
  type ConfirmacionBoton,
  type EventoHerramienta,
  type Pendiente,
} from "./confirmacion.ts"
import { DEFINICIONES, HERRAMIENTAS } from "./herramientas.ts"
import type { Sesion, ToolCallVisible } from "./sesiones.ts"

export type Dependencias = {
  llm: LlmAdapter
  directory: string
  /** prompt.md + conocimiento, ya concatenados. */
  sistema: string
  maxIter: number
  maxTokensSesion: number
}

export type Entrada = { message?: string; confirm?: ConfirmacionBoton }

export type RespuestaTurno = {
  reply: string
  toolCalls: ToolCallVisible[]
  needsConfirmation: boolean
  pendientes: Array<Pick<Pendiente, "caso" | "confirmaciones">>
}

type Respuesta = { ok: boolean; error?: string; data?: unknown }

type Turno = { toolCalls: ToolCallVisible[]; eventos: EventoHerramienta[] }

// ── Utilidades ───────────────────────────────────────────────────────────────

function parsearRespuesta(contenido: string): Respuesta {
  try {
    return JSON.parse(contenido) as Respuesta
  } catch {
    return { ok: false, error: contenido }
  }
}

function campo(data: unknown, clave: string): unknown {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>)[clave] : undefined
}

function reglas(lista: unknown): string {
  return Array.isArray(lista) ? lista.map((h) => String(campo(h, "regla"))).join(", ") || "-" : "-"
}

/** Resumen corto del resultado para el front y el log (no el payload completo). */
export function resumir(nombre: string, r: Respuesta): string {
  if (!r.ok) return `error: ${r.error ?? "sin detalle"}`
  const d = r.data
  switch (nombre) {
    case "oc_leer_paquete": {
      const faltantes = campo(d, "faltantes")
      const lista = Array.isArray(faltantes) && faltantes.length > 0 ? faltantes.join(", ") : "ninguno"
      return `${String(campo(campo(d, "solicitud"), "solicitud_id"))} leída; faltantes: ${lista}`
    }
    case "oc_validar":
      return `apta: ${String(campo(d, "apta"))}; bloqueos: ${reglas(campo(d, "bloqueos"))}; confirmaciones: ${reglas(campo(d, "confirmaciones"))}; retroactiva: ${String(campo(d, "retroactiva"))}`
    case "oc_construir_payload":
      return `OC construida; trazabilidad en ${String(campo(d, "ruta_trazabilidad"))}`
    case "oc_generar_evidencia":
      return `evidencia en ${String(campo(d, "ruta"))}`
    case "oc_crear":
      return `OC ${String(campo(d, "numero_oc"))}${campo(d, "idempotente") === true ? " (ya existía)" : " creada"}`
    default:
      return "ok"
  }
}

/** Args para mostrar: los objetos grandes (paquete, payload) se abrevian. */
function argsVisibles(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === "object" && v !== null ? `{${k}}` : v]),
  )
}

function estadoPendientes(sesion: Sesion): Pick<RespuestaTurno, "needsConfirmation" | "pendientes"> {
  const pendientes = [...sesion.pendientes.values()].map(({ caso, confirmaciones }) => ({ caso, confirmaciones }))
  return { needsConfirmation: pendientes.length > 0, pendientes }
}

async function registrarLog(deps: Dependencias, entrada: Record<string, unknown>): Promise<void> {
  try {
    await agregarLinea(join(deps.directory, "out", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entrada }))
  } catch {
    // El log no debe tumbar la sesión.
  }
}

// ── Ejecución de herramientas ────────────────────────────────────────────────

function rechazoCa3(sesion: Sesion, llamada: LlamadaHerramienta): string | null {
  if (llamada.nombre !== "oc_crear") return null
  const caso = typeof llamada.args["caso"] === "string" ? llamada.args["caso"] : ""
  return autorizarCreacion(sesion, caso, llamada.args["confirmado"] === true)
}

async function ejecutarLlamada(sesion: Sesion, llamada: LlamadaHerramienta, deps: Dependencias, turno: Turno): Promise<string> {
  const inicio = performance.now()
  const herramienta = HERRAMIENTAS.get(llamada.nombre)
  const rechazo = rechazoCa3(sesion, llamada)
  const contenido = !herramienta
    ? JSON.stringify({ ok: false, error: `Herramienta desconocida: ${llamada.nombre}` })
    : rechazo
      ? JSON.stringify({ ok: false, error: rechazo })
      : await herramienta.ejecutar(llamada.args, { directory: deps.directory, sessionId: sesion.id })
  const respuesta = parsearRespuesta(contenido)
  const visible: ToolCallVisible = {
    nombre: llamada.nombre,
    args: argsVisibles(llamada.args),
    ok: respuesta.ok,
    resumen: resumir(llamada.nombre, respuesta),
    ms: Math.round(performance.now() - inicio),
  }
  turno.toolCalls.push(visible)
  // Una llamada rechazada por CA3 no se ejecutó: no altera los pendientes.
  if (!rechazo) {
    const caso = typeof llamada.args["caso"] === "string" ? llamada.args["caso"] : null
    turno.eventos.push({ nombre: llamada.nombre, caso, ok: respuesta.ok, data: respuesta.data })
  }
  await registrarLog(deps, { sessionId: sesion.id, herramienta: llamada.nombre, args: llamada.args, ok: visible.ok, resumen: visible.resumen, ms: visible.ms })
  return contenido
}

// ── Bucle ────────────────────────────────────────────────────────────────────

function conSistema(deps: Dependencias, mensajes: Mensaje[]): Mensaje[] {
  return [{ rol: "sistema", texto: deps.sistema }, ...mensajes]
}

/** Devuelve el texto final, o null si se agotaron las iteraciones o los tokens. */
async function iterar(sesion: Sesion, deps: Dependencias, turno: Turno): Promise<string | null> {
  for (let i = 0; i < deps.maxIter; i++) {
    if (sesion.tokens >= deps.maxTokensSesion) return null
    const r = await deps.llm.enviar(conSistema(deps, sesion.mensajes), DEFINICIONES)
    sesion.tokens += r.uso_tokens
    sesion.mensajes.push({ rol: "modelo", texto: r.texto, llamadas: r.llamadas, nativo: r.nativo })
    if (r.llamadas.length === 0) return r.texto || "(El modelo no devolvió texto.)"
    const resultados = []
    for (const llamada of r.llamadas) {
      resultados.push({ id: llamada.id, nombre: llamada.nombre, contenido: await ejecutarLlamada(sesion, llamada, deps, turno) })
    }
    sesion.mensajes.push({ rol: "herramienta", resultados })
  }
  return null
}

function resumenDeterminista(turno: Turno, motivo: string): string {
  const hechas = turno.toolCalls.map((t) => `- ${t.nombre}: ${t.resumen}`).join("\n") || "- (ninguna herramienta ejecutada)"
  return `${motivo}\n\nLo que tengo:\n${hechas}\n\nLo que falta: continuar el flujo en un nuevo mensaje.`
}

/** Al llegar al tope: una última llamada sin herramientas para resumir qué hay y qué falta. */
async function cerrarPorTope(sesion: Sesion, deps: Dependencias, turno: Turno): Promise<string> {
  const motivo =
    sesion.tokens >= deps.maxTokensSesion
      ? "Se alcanzó el tope de tokens de esta sesión; abre una sesión nueva para seguir."
      : `Se alcanzó el tope de ${deps.maxIter} pasos en este turno.`
  if (sesion.tokens >= deps.maxTokensSesion) return resumenDeterminista(turno, motivo)
  try {
    const instruccion: Mensaje = {
      rol: "usuario",
      texto: `[Servidor] ${motivo} Sin llamar herramientas, resume qué datos ya tienes (solo de resultados de herramientas) y qué falta para terminar.`,
    }
    const r = await deps.llm.enviar(conSistema(deps, [...sesion.mensajes, instruccion]), [])
    sesion.tokens += r.uso_tokens
    return r.texto ? `${motivo}\n\n${r.texto}` : resumenDeterminista(turno, motivo)
  } catch {
    return resumenDeterminista(turno, motivo)
  }
}

function mensajeDeFallo(e: unknown): string {
  if (e instanceof ErrorLlm) return e.message
  return `Ocurrió un error inesperado procesando el turno: ${e instanceof Error ? e.message : "sin detalle"}`
}

/** Texto que representa al botón en la conversación, para que el modelo sepa qué caso se decidió. */
function textoDeBoton(boton: ConfirmacionBoton | undefined): string {
  if (!boton) return ""
  return boton.valor ? `Confirmo ${boton.caso}.` : `Cancelo ${boton.caso}.`
}

function registrarEntrada(sesion: Sesion, entrada: Entrada): string {
  const texto = entrada.message?.trim() || textoDeBoton(entrada.confirm)
  sesion.mensajesUsuario += 1
  sesion.ultimaDecision = clasificarMensaje(texto, entrada.confirm)
  sesion.mensajes.push({ rol: "usuario", texto })
  sesion.historial.push({ rol: "usuario", texto, ts: new Date().toISOString() })
  return texto
}

function cerrarTurno(sesion: Sesion, reply: string, turno: Turno): RespuestaTurno {
  actualizarPendientes(sesion, turno.eventos)
  // Si el turno terminó sin texto del modelo (tope o error), se deja constancia en la conversación.
  const ultimo = sesion.mensajes.at(-1)
  if (ultimo?.rol !== "modelo" || ultimo.llamadas.length > 0) sesion.mensajes.push({ rol: "modelo", texto: reply, llamadas: [] })
  const estado = estadoPendientes(sesion)
  sesion.historial.push({ rol: "agente", texto: reply, ts: new Date().toISOString(), toolCalls: turno.toolCalls, ...estado })
  return { reply, toolCalls: turno.toolCalls, ...estado }
}

export async function procesarTurno(sesion: Sesion, entrada: Entrada, deps: Dependencias): Promise<RespuestaTurno> {
  registrarEntrada(sesion, entrada)
  const turno: Turno = { toolCalls: [], eventos: [] }
  const atajo = resolverAtajo(sesion)
  if (atajo) return cerrarTurno(sesion, atajo.reply, turno)
  let reply: string
  try {
    reply = (await iterar(sesion, deps, turno)) ?? (await cerrarPorTope(sesion, deps, turno))
  } catch (e) {
    reply = mensajeDeFallo(e)
    await registrarLog(deps, { sessionId: sesion.id, error: reply })
  }
  return cerrarTurno(sesion, reply, turno)
}
