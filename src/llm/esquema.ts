// Conversión de esquemas zod al JSON Schema de cada proveedor.
import type { ZodTypeAny } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import type { JsonSchema } from "./adapter.ts"

/** JSON Schema estándar (draft-07) sin $schema: lo que espera input_schema de Anthropic. */
export function esquemaJson(esquema: ZodTypeAny): JsonSchema {
  const { $schema: _descartado, ...resto } = zodToJsonSchema(esquema, { target: "jsonSchema7", $refStrategy: "none" }) as JsonSchema
  return resto
}

/** Dialecto OpenAPI 3 limpio para el function calling de Gemini. */
export function esquemaGemini(esquema: ZodTypeAny): JsonSchema {
  return limpiarParaGemini(zodToJsonSchema(esquema, { target: "openApi3", $refStrategy: "none" }) as JsonSchema)
}

const CLAVES_PERMITIDAS = new Set([
  "type", "description", "enum", "format", "nullable", "properties", "required", "items",
  "anyOf", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
])

function esObjeto(valor: unknown): valor is JsonSchema {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
}

function limpiarPropiedades(propiedades: unknown): JsonSchema {
  if (!esObjeto(propiedades)) return {}
  return Object.fromEntries(Object.entries(propiedades).map(([k, v]) => [k, limpiarParaGemini(esObjeto(v) ? v : {})]))
}

function limpiarValor(clave: string, valor: unknown): unknown {
  if (clave === "type" && typeof valor === "string") return valor.toUpperCase()
  if (clave === "properties") return limpiarPropiedades(valor)
  if (clave === "items") return limpiarParaGemini(esObjeto(valor) ? valor : {})
  if (clave === "anyOf" && Array.isArray(valor)) return valor.map((v) => limpiarParaGemini(esObjeto(v) ? v : {}))
  return valor
}

/**
 * Lista blanca recursiva: quita $schema, additionalProperties, default, $ref,
 * exclusiveMinimum, etc. Un anyOf de una sola opción (típico de nullable) se aplana.
 */
export function limpiarParaGemini(schema: JsonSchema): JsonSchema {
  const limpio: JsonSchema = {}
  for (const [clave, valor] of Object.entries(schema)) {
    if (CLAVES_PERMITIDAS.has(clave)) limpio[clave] = limpiarValor(clave, valor)
  }
  const opciones = limpio["anyOf"]
  if (Array.isArray(opciones) && opciones.length === 1 && esObjeto(opciones[0])) {
    const { anyOf: _descartado, ...resto } = limpio
    return { ...opciones[0], ...resto }
  }
  return limpio
}
