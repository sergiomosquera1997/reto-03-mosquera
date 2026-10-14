// Verificación sin modelo: leer_paquete + validar sobre los 6 casos (PRD 3.1).
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { leer_paquete, validar } from "../src/tools/oc.ts"
import type { Ctx, Hallazgo, Paquete, ResultadoValidacion } from "../src/schemas.ts"

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }

const ctx: Ctx = { directory: join(import.meta.dirname, ".."), sessionId: "check" }

function codigos(hallazgos: Hallazgo[]): string {
  return hallazgos.map((h) => h.regla).join(", ") || "-"
}

function derivados(r: ResultadoValidacion): string {
  const { indicador_iva, condiciones_pago } = r.derivados
  const partes = [
    ...(indicador_iva ? [`IVA=${indicador_iva.valor}`] : []),
    ...(condiciones_pago ? [`pago=${condiciones_pago.valor}`] : []),
  ]
  return partes.join(", ") || "-"
}

async function revisar(caso: string): Promise<Record<string, string>> {
  const leido = JSON.parse(await leer_paquete.execute({ caso }, ctx)) as Respuesta<Paquete>
  if (!leido.ok) return { caso, apta: "ERROR", bloqueos: leido.error, confirmaciones: "", derivados: "", retroactiva: "" }
  const validado = JSON.parse(await validar.execute({ caso, paquete: leido.data }, ctx)) as Respuesta<ResultadoValidacion>
  if (!validado.ok) return { caso, apta: "ERROR", bloqueos: validado.error, confirmaciones: "", derivados: "", retroactiva: "" }
  const r = validado.data
  return {
    caso,
    apta: r.apta ? "sí" : "no",
    bloqueos: codigos(r.bloqueos),
    confirmaciones: codigos(r.confirmaciones),
    derivados: derivados(r),
    retroactiva: r.retroactiva ? "sí" : "no",
    faltantes: leido.data.faltantes.join(", ") || "-",
  }
}

function detalle(r: ResultadoValidacion): string[] {
  return [...r.bloqueos, ...r.confirmaciones].map((h) => `    ${h.regla} [${h.tipo}] ${h.detalle}`)
}

const casos = (await readdir(join(ctx.directory, "fixtures", "reto-03", "solicitudes"))).sort()
const filas = await Promise.all(casos.map(revisar))
console.table(filas)

for (const caso of casos) {
  const leido = JSON.parse(await leer_paquete.execute({ caso }, ctx)) as Respuesta<Paquete>
  if (!leido.ok) continue
  const validado = JSON.parse(await validar.execute({ caso, paquete: leido.data }, ctx)) as Respuesta<ResultadoValidacion>
  if (validado.ok && (validado.data.bloqueos.length > 0 || validado.data.confirmaciones.length > 0)) {
    console.log(`${caso}:\n${detalle(validado.data).join("\n")}`)
  }
}
