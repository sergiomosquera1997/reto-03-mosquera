// Implementación de LlmAdapter para Google Gemini (@google/genai).
import { setTimeout as esperar } from "node:timers/promises"
import { ApiError, GoogleGenAI, type Content, type GenerateContentResponse, type Part } from "@google/genai"
import { ErrorLlm, type DefinicionHerramienta, type LlmAdapter, type Mensaje, type RespuestaLlm } from "./adapter.ts"
import { limpiarParaGemini } from "./esquema.ts"

const TIMEOUT_MS = 60_000
const REINTENTOS = 3
const ESPERA_BASE_MS = 2_000
const ESPERA_MAXIMA_MS = 30_000

function aObjeto(contenido: string): Record<string, unknown> {
  try {
    const valor: unknown = JSON.parse(contenido)
    if (typeof valor === "object" && valor !== null && !Array.isArray(valor)) return valor as Record<string, unknown>
  } catch {
    // no es JSON: se envuelve como texto
  }
  return { resultado: contenido }
}

function aContenido(m: Exclude<Mensaje, { rol: "sistema" }>): Content {
  if (m.rol === "usuario") return { role: "user", parts: [{ text: m.texto }] }
  if (m.rol === "herramienta") {
    const parts = m.resultados.map((r) => ({ functionResponse: { id: r.id, name: r.nombre, response: aObjeto(r.contenido) } }))
    return { role: "user", parts }
  }
  if (m.nativo) return m.nativo as Content
  const parts: Part[] = [
    ...(m.texto ? [{ text: m.texto }] : []),
    ...m.llamadas.map((l) => ({ functionCall: { id: l.id, name: l.nombre, args: l.args } })),
  ]
  return { role: "model", parts }
}

function esLimite(e: unknown): boolean {
  return (e instanceof ApiError && e.status === 429) || (e instanceof Error && e.message.includes("RESOURCE_EXHAUSTED"))
}

/** 500 INTERNAL / 503 UNAVAILABLE: fallas transitorias del proveedor; también se reintentan. */
function esSaturacion(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 500 || e.status === 503
  return e instanceof Error && /"status":\s*"(UNAVAILABLE|INTERNAL)"/.test(e.message)
}

function esperaSugerida(e: unknown, intento: number): number {
  const sugerida = e instanceof Error ? /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/.exec(e.message)?.[1] : undefined
  const ms = sugerida ? Number(sugerida) * 1000 : ESPERA_BASE_MS * 2 ** intento
  return Math.min(ms, ESPERA_MAXIMA_MS)
}

function leerRespuesta(r: GenerateContentResponse): RespuestaLlm {
  const candidato = r.candidates?.[0]
  const parts = candidato?.content?.parts ?? []
  if (!candidato?.content) {
    const motivo = candidato?.finishReason ?? r.promptFeedback?.blockReason ?? "desconocido"
    throw new ErrorLlm(`El modelo no devolvió contenido (motivo: ${motivo}).`)
  }
  const texto = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("")
  const llamadas = parts
    .flatMap((p) => (p.functionCall?.name ? [p.functionCall] : []))
    .map((fc, i) => ({ id: fc.id ?? `${fc.name}-${i}`, nombre: fc.name ?? "", args: fc.args ?? {} }))
  return { texto, llamadas, uso_tokens: r.usageMetadata?.totalTokenCount ?? 0, nativo: candidato.content }
}

export class GeminiAdapter implements LlmAdapter {
  readonly proveedor = "gemini"
  readonly modelo: string
  private readonly apiKey: string
  private readonly cliente: GoogleGenAI

  constructor(apiKey: string, modelo: string) {
    this.apiKey = apiKey
    this.modelo = modelo
    this.cliente = new GoogleGenAI({ apiKey })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    for (let intento = 0; ; intento++) {
      try {
        return leerRespuesta(await this.generar(mensajes, herramientas))
      } catch (e) {
        if ((esLimite(e) || esSaturacion(e)) && intento < REINTENTOS) {
          await esperar(esperaSugerida(e, intento))
          continue
        }
        throw this.traducirError(e)
      }
    }
  }

  private generar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<GenerateContentResponse> {
    const sistema = mensajes.flatMap((m) => (m.rol === "sistema" ? [m.texto] : [])).join("\n\n")
    const contents = mensajes.flatMap((m) => (m.rol === "sistema" ? [] : [aContenido(m)]))
    const functionDeclarations = herramientas.map((h) => ({
      name: h.nombre,
      description: h.descripcion,
      parameters: limpiarParaGemini(h.parametros),
    }))
    return this.cliente.models.generateContent({
      model: this.modelo,
      contents,
      config: {
        ...(sistema ? { systemInstruction: sistema } : {}),
        ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    })
  }

  /** Mensaje claro para la analista; nunca incluye la clave. */
  private traducirError(e: unknown): ErrorLlm {
    if (e instanceof ErrorLlm) return e
    if (esLimite(e)) return new ErrorLlm("Límite del modelo alcanzado, intenta en un minuto.")
    if (esSaturacion(e)) return new ErrorLlm("El modelo está saturado o con fallas temporales, intenta en un minuto.")
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return new ErrorLlm(`El modelo no respondió en ${TIMEOUT_MS / 1000} s. Intenta de nuevo.`)
    }
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      return new ErrorLlm("El proveedor rechazó la clave del modelo (revisa GEMINI_API_KEY en el servidor).")
    }
    if (e instanceof ApiError && e.status === 404) {
      const motivo = /"message":\s*"([^"]+)"/.exec(e.message)?.[1] ?? "no existe"
      return new ErrorLlm(`El modelo "${this.modelo}" no está disponible (revisa LLM_MODEL): ${motivo}`)
    }
    const detalle = e instanceof Error ? e.message.replaceAll(this.apiKey, "***").slice(0, 300) : "sin detalle"
    return new ErrorLlm(`Error del proveedor del modelo: ${detalle}`)
  }
}
