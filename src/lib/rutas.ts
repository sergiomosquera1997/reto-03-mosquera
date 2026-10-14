import { join, relative } from "node:path"
import type { Ctx } from "../schemas.ts"
import { ErrorNegocio } from "./resultado.ts"

const PATRON_CASO = /^[a-z0-9][a-z0-9-]*$/

export function validarCaso(caso: string): string {
  if (!PATRON_CASO.test(caso)) {
    throw new ErrorNegocio(`Nombre de caso inválido: "${caso}". Use solo minúsculas, dígitos y guiones (ej. "sol-001").`)
  }
  return caso
}

export function rutaCaso(ctx: Ctx, caso: string, archivo: string): string {
  return join(ctx.directory, "fixtures", "reto-03", "solicitudes", validarCaso(caso), archivo)
}

export function rutaMaestro(ctx: Ctx, archivo: string): string {
  return join(ctx.directory, "fixtures", "reto-03", "maestros", archivo)
}

export function rutaOut(ctx: Ctx, ...partes: string[]): string {
  return join(ctx.directory, "out", ...partes)
}

/** Ruta relativa a la raíz del proyecto, para devolver al modelo sin exponer rutas absolutas. */
export function relativa(ctx: Ctx, ruta: string): string {
  return relative(ctx.directory, ruta).replaceAll("\\", "/")
}
