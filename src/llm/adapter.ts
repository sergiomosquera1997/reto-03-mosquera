// Interfaz neutra entre el ciclo del agente y cualquier proveedor de LLM (PRD 6.1).
// El ciclo solo conoce estos tipos; cambiar de proveedor no lo toca.
import type { ZodTypeAny } from "zod"

export type JsonSchema = { [clave: string]: unknown }

export type LlamadaHerramienta = { id: string; nombre: string; args: Record<string, unknown> }

export type ResultadoHerramienta = { id: string; nombre: string; contenido: string }

export type Mensaje =
  | { rol: "sistema"; texto: string }
  | { rol: "usuario"; texto: string }
  // `nativo` es opaco para el ciclo: el adaptador guarda ahí el turno original del
  // proveedor (p. ej. firmas de pensamiento de Gemini) para reenviarlo tal cual.
  | { rol: "modelo"; texto: string; llamadas: LlamadaHerramienta[]; nativo?: unknown }
  | { rol: "herramienta"; resultados: ResultadoHerramienta[] }

/** El esquema va en zod: cada adaptador lo convierte al dialecto de JSON Schema de su proveedor. */
export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: ZodTypeAny }

export type RespuestaLlm = {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso_tokens: number
  nativo?: unknown
}

export interface LlmAdapter {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm>
}

/** Error del proveedor con mensaje apto para mostrar a la analista. */
export class ErrorLlm extends Error {}
