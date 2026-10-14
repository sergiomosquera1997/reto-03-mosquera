// Implementación de LlmAdapter para Claude (@anthropic-ai/sdk).
import { setTimeout as esperar } from "node:timers/promises"
import Anthropic from "@anthropic-ai/sdk"
import { ErrorLlm, type DefinicionHerramienta, type LlmAdapter, type Mensaje, type RespuestaLlm } from "./adapter.ts"
import { esquemaJson } from "./esquema.ts"

type Bloque = Anthropic.ContentBlock
type MensajeApi = Anthropic.MessageParam

const TIMEOUT_MS = 60_000
const MAX_TOKENS = 16_000
const REINTENTOS = 3
const ESPERA_BASE_MS = 2_000
const ESPERA_MAXIMA_MS = 30_000
const REINTENTABLES = new Set([429, 500, 503, 529])

function esError(contenido: string): boolean {
  try {
    const valor: unknown = JSON.parse(contenido)
    return typeof valor === "object" && valor !== null && (valor as { ok?: unknown }).ok === false
  } catch {
    return false
  }
}

function aMensaje(m: Exclude<Mensaje, { rol: "sistema" }>): MensajeApi {
  if (m.rol === "usuario") return { role: "user", content: m.texto || "(mensaje vacío)" }
  if (m.rol === "herramienta") {
    const content = m.resultados.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.id,
      content: r.contenido,
      is_error: esError(r.contenido),
    }))
    return { role: "user", content }
  }
  // El turno original se reenvía intacto: incluye bloques de pensamiento y de fallback,
  // que deben volver sin cambios (historial solo de anexado).
  if (m.nativo) return { role: "assistant", content: m.nativo as Bloque[] }
  const content: Anthropic.ContentBlockParam[] = [
    ...(m.texto ? [{ type: "text" as const, text: m.texto }] : []),
    ...m.llamadas.map((l) => ({ type: "tool_use" as const, id: l.id, name: l.nombre, input: l.args })),
  ]
  return { role: "assistant", content: content.length > 0 ? content : "(sin respuesta)" }
}

function leerRespuesta(r: Anthropic.Message): RespuestaLlm {
  if (r.stop_reason === "refusal") {
    const categoria = r.stop_details?.category ?? "sin categoría"
    throw new ErrorLlm(`El modelo declinó la solicitud (categoría: ${categoria}). Reformúlala o procesa el caso manualmente.`)
  }
  if (r.stop_reason === "max_tokens") throw new ErrorLlm("La respuesta del modelo se cortó por longitud. Intenta de nuevo.")
  const texto = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
  const llamadas = r.content.flatMap((b) =>
    b.type === "tool_use" ? [{ id: b.id, nombre: b.name, args: (b.input ?? {}) as Record<string, unknown> }] : [],
  )
  const u = r.usage
  const uso = u.input_tokens + u.output_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  // Desglose para el análisis de costos (cada tipo de token tiene precio distinto). Nunca incluye la clave.
  console.log(
    `[llm] ${r.model} entrada=${u.input_tokens} salida=${u.output_tokens} cache_escritura=${u.cache_creation_input_tokens ?? 0} cache_lectura=${u.cache_read_input_tokens ?? 0}`,
  )
  return { texto, llamadas, uso_tokens: uso, nativo: r.content }
}

function esperaSugerida(e: InstanceType<typeof Anthropic.APIError>, intento: number): number {
  const segundos = Number(e.headers?.get("retry-after"))
  const ms = Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : ESPERA_BASE_MS * 2 ** intento
  return Math.min(ms, ESPERA_MAXIMA_MS)
}

export class AnthropicAdapter implements LlmAdapter {
  readonly proveedor = "anthropic"
  readonly modelo: string
  private readonly apiKey: string
  private readonly cliente: Anthropic

  constructor(apiKey: string, modelo: string) {
    this.apiKey = apiKey
    this.modelo = modelo
    // Reintentos propios (incluido 529) en lugar de los del SDK, con el mismo tope que Gemini.
    this.cliente = new Anthropic({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    for (let intento = 0; ; intento++) {
      try {
        return leerRespuesta(await this.crear(mensajes, herramientas))
      } catch (e) {
        if (e instanceof Anthropic.APIError && REINTENTABLES.has(e.status ?? 0) && intento < REINTENTOS) {
          await esperar(esperaSugerida(e, intento))
          continue
        }
        throw this.traducirError(e)
      }
    }
  }

  private crear(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<Anthropic.Message> {
    const sistema = mensajes.flatMap((m) => (m.rol === "sistema" ? [m.texto] : [])).join("\n\n")
    const tools = herramientas.map((h) => ({
      name: h.nombre,
      description: h.descripcion,
      input_schema: esquemaJson(h.esquema) as Anthropic.Tool.InputSchema,
    }))
    return this.cliente.messages.create({
      model: this.modelo,
      max_tokens: MAX_TOKENS,
      // Caché fija: el prefijo herramientas + sistema es idéntico en todas las sesiones,
      // así que la primera llamada de una sesión nueva lo lee de caché en vez de reescribirlo.
      ...(sistema ? { system: [{ type: "text" as const, text: sistema, cache_control: { type: "ephemeral" as const } }] } : {}),
      messages: mensajes.flatMap((m) => (m.rol === "sistema" ? [] : [aMensaje(m)])),
      ...(tools.length > 0 ? { tools } : {}),
      // Caché móvil del historial: cada iteración reenvía la conversación completa.
      cache_control: { type: "ephemeral" },
      // Flujo de varias herramientas: "medium" equilibra calidad y tokens en Sonnet 5.5.
      output_config: { effort: "medium" },
    })
  }

  /** Mensaje claro para la analista; nunca incluye la clave. */
  private traducirError(e: unknown): ErrorLlm {
    if (e instanceof ErrorLlm) return e
    if (e instanceof Anthropic.APIConnectionTimeoutError) {
      return new ErrorLlm(`El modelo no respondió en ${TIMEOUT_MS / 1000} s. Intenta de nuevo.`)
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return new ErrorLlm("El proveedor rechazó la clave del modelo (revisa ANTHROPIC_API_KEY en el servidor).")
    }
    if (e instanceof Anthropic.NotFoundError) return new ErrorLlm(`El modelo "${this.modelo}" no está disponible (revisa LLM_MODEL).`)
    if (e instanceof Anthropic.RateLimitError) return new ErrorLlm("Límite del modelo alcanzado, intenta en un minuto.")
    if (e instanceof Anthropic.APIError && (e.status === 529 || (e.status ?? 0) >= 500)) {
      return new ErrorLlm("El modelo está saturado o con fallas temporales, intenta en un minuto.")
    }
    if (e instanceof Anthropic.APIConnectionError) return new ErrorLlm("No se pudo conectar con el proveedor del modelo. Revisa la red.")
    const detalle = e instanceof Error ? e.message.replaceAll(this.apiKey, "***").slice(0, 300) : "sin detalle"
    return new ErrorLlm(`Error del proveedor del modelo: ${detalle}`)
  }
}
