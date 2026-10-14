// Fábrica de adaptadores LLM según LLM_PROVIDER.
import type { LlmAdapter } from "./adapter.ts"
import { AnthropicAdapter } from "./anthropic.ts"
import { GeminiAdapter } from "./gemini.ts"
import { MockAdapter } from "./mock.ts"

type Entorno = Record<string, string | undefined>

function requerida(env: Entorno, nombre: string): string {
  const valor = env[nombre]?.trim()
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`)
  return valor
}

export function crearAdaptador(env: Entorno = process.env): LlmAdapter {
  const proveedor = (env["LLM_PROVIDER"] ?? "gemini").trim().toLowerCase()
  if (proveedor === "gemini") return new GeminiAdapter(requerida(env, "GEMINI_API_KEY"), requerida(env, "LLM_MODEL"))
  if (proveedor === "anthropic") return new AnthropicAdapter(requerida(env, "ANTHROPIC_API_KEY"), requerida(env, "LLM_MODEL"))
  if (proveedor === "mock") return new MockAdapter(env["LLM_MODEL"]?.trim() || "mock-reglas")
  throw new Error(`LLM_PROVIDER "${proveedor}" no soportado. Opciones: anthropic, gemini, mock.`)
}
