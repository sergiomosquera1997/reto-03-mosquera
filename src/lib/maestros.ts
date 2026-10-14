import { readFile } from "node:fs/promises"
import { z } from "zod"
import {
  CentroCostoSchema,
  CondicionPagoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  type Ctx,
  type Maestros,
} from "../schemas.ts"
import { parsearJson } from "./archivos.ts"
import { rutaMaestro } from "./rutas.ts"

async function leerMaestro<T>(ctx: Ctx, archivo: string, schema: z.ZodType<T>): Promise<T[]> {
  const texto = await readFile(rutaMaestro(ctx, archivo), "utf8")
  return parsearJson(texto, z.array(schema), `Maestro ${archivo}`)
}

export async function cargarMaestros(ctx: Ctx): Promise<Maestros> {
  const [proveedores, centros, ivas, condiciones] = await Promise.all([
    leerMaestro(ctx, "proveedores.json", ProveedorSchema),
    leerMaestro(ctx, "centros-costo.json", CentroCostoSchema),
    leerMaestro(ctx, "indicadores-iva.json", IndicadorIvaSchema),
    leerMaestro(ctx, "condiciones-pago.json", CondicionPagoSchema),
  ])
  return { proveedores, centros, ivas, condiciones }
}
