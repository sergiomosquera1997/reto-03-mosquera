// Registro de herramientas expuestas al modelo como <archivo>_<export> (PRD 6.2).
import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter.ts"
import { fallo } from "../lib/resultado.ts"
import type { Ctx } from "../schemas.ts"
import * as oc from "../tools/oc.ts"

type Herramienta<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: Ctx): Promise<string>
}

export type HerramientaRegistrada = {
  definicion: DefinicionHerramienta
  /** Valida los args con zod; si no cumplen, devuelve el error al modelo sin ejecutar. */
  ejecutar(args: unknown, ctx: Ctx): Promise<string>
}

function registrar<S extends z.ZodRawShape>(nombre: string, h: Herramienta<S>): [string, HerramientaRegistrada] {
  const esquema = z.object(h.args)
  const ejecutar = async (args: unknown, ctx: Ctx): Promise<string> => {
    const r = esquema.safeParse(args)
    if (r.success) return h.execute(r.data, ctx)
    const detalle = r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    return fallo(`Argumentos inválidos para ${nombre}: ${detalle}`)
  }
  return [nombre, { definicion: { nombre, descripcion: h.description, esquema }, ejecutar }]
}

export const HERRAMIENTAS: ReadonlyMap<string, HerramientaRegistrada> = new Map([
  registrar("oc_leer_paquete", oc.leer_paquete),
  registrar("oc_validar", oc.validar),
  registrar("oc_construir_payload", oc.construir_payload),
  registrar("oc_generar_evidencia", oc.generar_evidencia),
  registrar("oc_crear", oc.crear),
])

export const DEFINICIONES: DefinicionHerramienta[] = [...HERRAMIENTAS.values()].map((h) => h.definicion)
