import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname } from "node:path"
import type { z } from "zod"
import { ErrorNegocio } from "./resultado.ts"

function esNoEncontrado(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT"
}

export async function leerTextoOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch (e) {
    if (esNoEncontrado(e)) return null
    throw e
  }
}

function describirProblemas(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
}

/** Parsea y valida JSON. Lanza ErrorNegocio legible si está malformado o no cumple el esquema. */
export function parsearJson<T>(texto: string, schema: z.ZodType<T>, nombre: string): T {
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    throw new ErrorNegocio(`${nombre} no es un JSON válido. Pida al solicitante que reenvíe el archivo.`)
  }
  const resultado = schema.safeParse(crudo)
  if (!resultado.success) {
    throw new ErrorNegocio(
      `${nombre} tiene datos inválidos (${describirProblemas(resultado.error)}). Pida al solicitante que lo corrija y reenvíe.`,
    )
  }
  return resultado.data
}

export async function leerJsonOpcional<T>(ruta: string, schema: z.ZodType<T>): Promise<T | null> {
  const texto = await leerTextoOpcional(ruta)
  return texto === null ? null : parsearJson(texto, schema, basename(ruta))
}

export async function escribirArchivo(ruta: string, contenido: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido, "utf8")
}

export async function agregarLinea(ruta: string, linea: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, `${linea}\n`, "utf8")
}
