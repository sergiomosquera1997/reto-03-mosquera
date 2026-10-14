// Confirmación humana controlada por el servidor (CA3). Funciones puras.
import { quitarTildes } from "../lib/normalizar.ts"
import type { Hallazgo } from "../schemas.ts"

export type Intencion = "confirmar" | "cancelar" | "otro"

/** Qué expresó el último mensaje del usuario y, si lo dijo, sobre qué caso. */
export type Decision = { intencion: Intencion; caso: string | null }

/** Lo que llega del botón del front: confirmar o cancelar un caso concreto. */
export type ConfirmacionBoton = { caso: string; valor: boolean }

export type Pendiente = { caso: string; confirmaciones: Hallazgo[]; mensajeUsuario: number }

export type EstadoConfirmacion = {
  pendientes: Map<string, Pendiente>
  /** Número del último mensaje del usuario (1, 2, 3…). */
  mensajesUsuario: number
  /** Decisión expresada en el último mensaje del usuario. */
  ultimaDecision: Decision
}

/** Resultado de una herramienta ejecutada en el turno, para actualizar los pendientes. */
export type EventoHerramienta = { nombre: string; caso: string | null; ok: boolean; data: unknown }

/** Respuesta que el servidor da sin consultar al modelo; null si el turno sigue al modelo. */
export type Atajo = { reply: string } | null

const AFIRMATIVAS = new Set(["confirmo", "si", "confirmar", "procede", "adelante"])
const NEGATIVAS = new Set(["no", "cancela", "cancelar", "cancelo"])
const PATRON_CASO = /^sol-\d{3}$/

export function normalizarFrase(texto: string): string {
  return quitarTildes(texto).toLowerCase().replace(/[¡!¿?.,;:]/g, " ").replace(/\s+/g, " ").trim()
}

function intencionDeTexto(palabras: string[], casos: string[]): Intencion {
  if (palabras.length === 0 || casos.length > 1) return "otro"
  if (palabras.every((p) => AFIRMATIVAS.has(p))) return "confirmar"
  if (palabras.every((p) => NEGATIVAS.has(p))) return "cancelar"
  return "otro"
}

/**
 * El botón manda y siempre trae el caso. En texto libre, el mensaje confirma (o cancela)
 * solo si TODAS sus palabras son afirmativas (o negativas), aparte de un caso opcional:
 * "Sí, confirmo" y "confirmo sol-004" confirman; "sí pero cambia el IVA" no.
 */
export function clasificarMensaje(texto: string, boton?: ConfirmacionBoton): Decision {
  if (boton) return { intencion: boton.valor ? "confirmar" : "cancelar", caso: boton.caso }
  const tokens = normalizarFrase(texto).split(" ").filter(Boolean)
  const casos = [...new Set(tokens.filter((t) => PATRON_CASO.test(t)))]
  const intencion = intencionDeTexto(tokens.filter((t) => !PATRON_CASO.test(t)), casos)
  return { intencion, caso: intencion === "otro" ? null : (casos[0] ?? null) }
}

function listar(pendientes: Map<string, Pendiente>): string {
  return [...pendientes.values()].map((p) => `${p.caso} (${p.confirmaciones.map((c) => c.regla).join(", ")})`).join(", ")
}

/** Sin caso, cancela todos los pendientes: nunca queda uno vivo sin una confirmación nueva. */
function cancelar(estado: EstadoConfirmacion, caso: string | null): Atajo {
  if (estado.pendientes.size === 0) return null
  if (caso && !estado.pendientes.has(caso)) return { reply: `No hay una OC pendiente de confirmación para ${caso}; no se canceló nada.` }
  const casos = caso ? [caso] : [...estado.pendientes.keys()]
  for (const c of casos) estado.pendientes.delete(c)
  return {
    reply: `Cancelado. No se creó la OC de ${casos.join(", ")}; se descartaron sus confirmaciones pendientes. Si quieres retomarla, pídeme procesarla de nuevo.`,
  }
}

/**
 * Casos que el servidor resuelve sin el modelo: cancelaciones, confirmaciones de un caso
 * que no está pendiente y confirmaciones ambiguas (varios pendientes y ningún caso).
 */
export function resolverAtajo(estado: EstadoConfirmacion): Atajo {
  const { intencion, caso } = estado.ultimaDecision
  if (intencion === "cancelar") return cancelar(estado, caso)
  if (intencion !== "confirmar" || estado.pendientes.size === 0) return null
  if (caso && !estado.pendientes.has(caso)) {
    return { reply: `No hay una OC pendiente de confirmación para ${caso}. Pendientes: ${listar(estado.pendientes)}.` }
  }
  if (!caso && estado.pendientes.size > 1) {
    const ejemplo = [...estado.pendientes.keys()][0] ?? ""
    return {
      reply: `Hay varias OC pendientes de confirmación: ${listar(estado.pendientes)}. ¿Cuál confirmas? Responde, por ejemplo, "confirmo ${ejemplo}", o usa el botón de esa OC.`,
    }
  }
  return null
}

/** null = permitido; string = motivo del rechazo que se devuelve al modelo. */
export function autorizarCreacion(estado: EstadoConfirmacion, caso: string, confirmado: boolean): string | null {
  if (!confirmado) return null
  const pendiente = estado.pendientes.get(caso)
  if (!pendiente) {
    return `Rechazado por el servidor: no hay confirmaciones pendientes registradas para ${caso}. Valida el caso, presenta las confirmaciones a la analista y termina el turno con la pregunta.`
  }
  const { intencion, caso: casoConfirmado } = estado.ultimaDecision
  if (intencion !== "confirmar" || estado.mensajesUsuario <= pendiente.mensajeUsuario) {
    return `Rechazado por el servidor: la analista no ha confirmado explícitamente ${caso}. Pregúntale y termina el turno; no uses confirmado: true hasta que responda "confirmo" o pulse Confirmar.`
  }
  if (casoConfirmado && casoConfirmado !== caso) {
    return `Rechazado por el servidor: la analista confirmó ${casoConfirmado}, no ${caso}. Crea solo la OC confirmada.`
  }
  if (!casoConfirmado && estado.pendientes.size > 1) {
    return "Rechazado por el servidor: hay varias OC pendientes y la analista no indicó cuál confirma. Pregúntale cuál."
  }
  return null
}

function campo(data: unknown, clave: string): unknown {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>)[clave] : undefined
}

function hallazgos(data: unknown, clave: string): Hallazgo[] {
  const valor = campo(data, clave)
  return Array.isArray(valor) ? (valor as Hallazgo[]) : []
}

function fijar(pendientes: Map<string, Pendiente>, caso: string, lista: Hallazgo[], mensajeUsuario: number): void {
  if (lista.length > 0) pendientes.set(caso, { caso, confirmaciones: lista, mensajeUsuario })
  else pendientes.delete(caso)
}

function aplicarEvento(pendientes: Map<string, Pendiente>, e: EventoHerramienta, mensajeUsuario: number): void {
  if (!e.caso) return
  if (e.nombre === "oc_validar" && e.ok) {
    const apta = campo(e.data, "apta") === true
    fijar(pendientes, e.caso, apta ? hallazgos(e.data, "confirmaciones") : [], mensajeUsuario)
  } else if (e.nombre === "oc_crear" && e.ok) {
    pendientes.delete(e.caso)
  } else if (e.nombre === "oc_crear" && campo(e.data, "confirmaciones_pendientes") !== undefined) {
    fijar(pendientes, e.caso, hallazgos(e.data, "confirmaciones_pendientes"), mensajeUsuario)
  } else if (e.nombre === "oc_crear" && campo(e.data, "bloqueos") !== undefined) {
    pendientes.delete(e.caso)
  }
  // Otros errores de oc_crear (payload alterado, args inválidos) no tocan el pendiente.
}

/**
 * Al cerrar el turno: oc_validar con confirmaciones (o oc_crear pendiente) y sin OC
 * creada → pendiente; OC creada, bloqueo o validación limpia → se borra.
 */
export function actualizarPendientes(estado: EstadoConfirmacion, eventos: EventoHerramienta[]): void {
  for (const e of eventos) aplicarEvento(estado.pendientes, e, estado.mensajesUsuario)
}
