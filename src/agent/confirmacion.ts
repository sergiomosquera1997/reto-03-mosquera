// Confirmación humana controlada por el servidor (CA3). Funciones puras.
import { quitarTildes } from "../lib/normalizar.ts"
import type { Hallazgo } from "../schemas.ts"

export type Intencion = "confirmar" | "cancelar" | "otro"

export type Pendiente = { caso: string; confirmaciones: Hallazgo[]; mensajeUsuario: number }

export type EstadoConfirmacion = {
  pendientes: Map<string, Pendiente>
  /** Número del último mensaje del usuario (1, 2, 3…). */
  mensajesUsuario: number
  /** Intención del último mensaje del usuario. */
  ultimaIntencion: Intencion
}

/** Resultado de una herramienta ejecutada en el turno, para actualizar los pendientes. */
export type EventoHerramienta = { nombre: string; caso: string | null; ok: boolean; data: unknown }

const AFIRMATIVAS = new Set(["confirmo", "si", "confirmar", "procede", "adelante"])
const NEGATIVAS = new Set(["no", "cancela", "cancelar", "cancelo"])

export function normalizarFrase(texto: string): string {
  return quitarTildes(texto).toLowerCase().replace(/[¡!¿?.,;:]/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * El botón (confirm) manda. En texto libre, el mensaje confirma (o cancela) solo si
 * TODAS sus palabras están en la lista: "Sí, confirmo" confirma; "sí pero cambia el IVA" no.
 */
export function clasificarMensaje(texto: string, confirm?: boolean): Intencion {
  if (confirm === true) return "confirmar"
  if (confirm === false) return "cancelar"
  const palabras = normalizarFrase(texto).split(" ").filter(Boolean)
  if (palabras.length === 0) return "otro"
  if (palabras.every((p) => AFIRMATIVAS.has(p))) return "confirmar"
  if (palabras.every((p) => NEGATIVAS.has(p))) return "cancelar"
  return "otro"
}

/** null = permitido; string = motivo del rechazo que se devuelve al modelo. */
export function autorizarCreacion(estado: EstadoConfirmacion, caso: string, confirmado: boolean): string | null {
  if (!confirmado) return null
  const pendiente = estado.pendientes.get(caso)
  if (!pendiente) {
    return `Rechazado por el servidor: no hay confirmaciones pendientes registradas para ${caso}. Valida el caso, presenta las confirmaciones a la analista y termina el turno con la pregunta.`
  }
  const explicita = estado.ultimaIntencion === "confirmar" && estado.mensajesUsuario > pendiente.mensajeUsuario
  if (!explicita) {
    return `Rechazado por el servidor: la analista no ha confirmado explícitamente ${caso}. Pregúntale y termina el turno; no uses confirmado: true hasta que responda "confirmo" o pulse Confirmar.`
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
