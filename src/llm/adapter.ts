// Interfaz neutra entre el ciclo del agente y cualquier proveedor de LLM (PRD 6.1).
// El ciclo solo conoce estos tipos; cambiar de proveedor no lo toca.

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

export type DefinicionHerramienta = { nombre: string; descripcion: string; parametros: JsonSchema }

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
