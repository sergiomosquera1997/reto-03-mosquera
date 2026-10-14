// Sesiones en memoria (PRD 6.1: memoria o archivo).
import type { Mensaje } from "../llm/adapter.ts"
import type { EstadoConfirmacion } from "./confirmacion.ts"

export type ToolCallVisible = {
  nombre: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  ms: number
}

export type EntradaHistorial =
  | { rol: "usuario"; texto: string; ts: string }
  | { rol: "agente"; texto: string; ts: string; toolCalls: ToolCallVisible[]; needsConfirmation: boolean }

export type Sesion = EstadoConfirmacion & {
  id: string
  /** Conversación en formato neutro para el LLM (sin el prompt de sistema). */
  mensajes: Mensaje[]
  /** Historial visible para el front y GET /api/sessions/:id. */
  historial: EntradaHistorial[]
  tokens: number
  ocupada: boolean
}

export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()

  obtener(id: string): Sesion {
    const existente = this.sesiones.get(id)
    if (existente) return existente
    const nueva: Sesion = {
      id,
      mensajes: [],
      historial: [],
      tokens: 0,
      ocupada: false,
      pendientes: new Map(),
      mensajesUsuario: 0,
      ultimaDecision: { intencion: "otro", caso: null },
    }
    this.sesiones.set(id, nueva)
    return nueva
  }

  buscar(id: string): Sesion | null {
    return this.sesiones.get(id) ?? null
  }
}
