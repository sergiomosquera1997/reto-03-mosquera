// Demo sin modelo (PRD 6.6): procesa los 6 casos llamando directamente a las herramientas.
// Uso: bun install && bun run demo.ts
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { construir_payload, crear, generar_evidencia, leer_paquete, validar } from "./src/tools/oc.ts"
import type { Ctx, Hallazgo, OrdenCompra, Paquete, ResultadoValidacion } from "./src/schemas.ts"

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string; data?: unknown }
type Herramienta<A> = { execute(args: A, ctx: Ctx): Promise<string> }
type ResultadoCrear = { numero_oc: string; fecha: string | null; idempotente: boolean; retroactiva: boolean }
type Intento = { etiqueta: string; confirmado?: boolean }
type FilaResumen = {
  caso: string
  intento: string
  apta: string
  bloqueos: string
  confirmaciones: string
  retroactiva: string
  resultado: string
}

const ctx: Ctx = { directory: import.meta.dirname, sessionId: "demo" }

const PLAN: Array<{ caso: string; intentos: Intento[] }> = [
  { caso: "sol-001", intentos: [{ etiqueta: "1ª ejecución" }] },
  { caso: "sol-001", intentos: [{ etiqueta: "2ª ejecución (idempotencia)" }] },
  { caso: "sol-002", intentos: [{ etiqueta: "única" }] },
  { caso: "sol-003", intentos: [{ etiqueta: "única" }] },
  { caso: "sol-004", intentos: [{ etiqueta: "sin confirmar" }, { etiqueta: "confirmado: true", confirmado: true }] },
  { caso: "sol-005", intentos: [{ etiqueta: "confirmado: true", confirmado: true }] },
  { caso: "sol-006", intentos: [{ etiqueta: "sin confirmar" }, { etiqueta: "confirmado: true", confirmado: true }] },
]

async function llamar<A, T>(herramienta: Herramienta<A>, args: A): Promise<Respuesta<T>> {
  return JSON.parse(await herramienta.execute(args, ctx)) as Respuesta<T>
}

function codigos(hallazgos: Hallazgo[]): string {
  return hallazgos.map((h) => h.regla).join(", ") || "-"
}

function imprimirValidacion(r: ResultadoValidacion): void {
  console.log(`  apta: ${r.apta ? "sí" : "no"} · retroactiva: ${r.retroactiva}`)
  for (const h of [...r.bloqueos, ...r.confirmaciones, ...r.derivados.hallazgos]) {
    console.log(`  ${h.regla} [${h.tipo}] ${h.detalle}`)
  }
}

function hallazgosEn(data: unknown, clave: "confirmaciones_pendientes" | "bloqueos"): Hallazgo[] | null {
  if (typeof data !== "object" || data === null || !(clave in data)) return null
  return (data as Record<typeof clave, Hallazgo[]>)[clave]
}

function describirCrear(respuesta: Respuesta<ResultadoCrear>): string {
  if (!respuesta.ok) {
    const bloqueos = hallazgosEn(respuesta.data, "bloqueos")
    if (bloqueos) return `bloqueada: ${codigos(bloqueos)}`
    const pendientes = hallazgosEn(respuesta.data, "confirmaciones_pendientes")
    return pendientes ? `pendiente de confirmación: ${codigos(pendientes)}` : `no creada: ${respuesta.error}`
  }
  const { numero_oc, idempotente, retroactiva } = respuesta.data
  return `OC ${numero_oc} · idempotente: ${idempotente} · retroactiva: ${retroactiva}`
}

function fila(caso: string, intento: string, r: ResultadoValidacion, resultado: string): FilaResumen {
  return {
    caso,
    intento,
    apta: r.apta ? "sí" : "no",
    bloqueos: codigos(r.bloqueos),
    confirmaciones: codigos(r.confirmaciones),
    retroactiva: r.retroactiva ? "sí" : "no",
    resultado,
  }
}

async function construir(caso: string, paquete: Paquete, r: ResultadoValidacion): Promise<Respuesta<{ orden: OrdenCompra }>> {
  const payload = await llamar<Parameters<typeof construir_payload.execute>[0], { orden: OrdenCompra }>(construir_payload, {
    caso,
    paquete,
    derivados: r.derivados,
  })
  if (!payload.ok) return payload
  const evidencia = await llamar<{ caso: string }, { ruta: string; sha256: string }>(generar_evidencia, { caso })
  console.log(evidencia.ok ? `  evidencia: ${evidencia.data.ruta} (sha256 ${evidencia.data.sha256.slice(0, 12)}…)` : `  evidencia: ${evidencia.error}`)
  return payload
}

async function procesar(caso: string, intentos: Intento[]): Promise<FilaResumen[]> {
  console.log(`\n━━ ${caso} ━━`)
  const paquete = await llamar<{ caso: string }, Paquete>(leer_paquete, { caso })
  if (!paquete.ok) {
    console.log(`  error al leer: ${paquete.error}`)
    return [{ caso, intento: "-", apta: "-", bloqueos: "-", confirmaciones: "-", retroactiva: "-", resultado: paquete.error }]
  }
  const validacion = await llamar<{ caso: string; paquete: Paquete }, ResultadoValidacion>(validar, { caso, paquete: paquete.data })
  if (!validacion.ok) throw new Error(`validar falló en ${caso}: ${validacion.error}`)
  const r = validacion.data
  imprimirValidacion(r)
  const payload = await construir(caso, paquete.data, r)
  // Bloqueada: no hay payload, pero igual se intenta crear para que quede la fila en control.csv (HU-5).
  if (!payload.ok) console.log(`  → no se construye la OC: ${payload.error}`)
  const orden = payload.ok ? { payload: payload.data.orden } : {}
  const filas: FilaResumen[] = []
  for (const intento of intentos) {
    const args = { caso, ...orden, ...(intento.confirmado ? { confirmado: true } : {}) }
    const resultado = describirCrear(await llamar<typeof args, ResultadoCrear>(crear, args))
    console.log(`  → crear (${intento.etiqueta}): ${resultado}`)
    filas.push(fila(caso, intento.etiqueta, r, resultado))
  }
  return filas
}

await rm(join(ctx.directory, "out"), { recursive: true, force: true })
console.log("Demo reto-03 · herramientas OC sin modelo")

const resumen: FilaResumen[] = []
for (const { caso, intentos } of PLAN) resumen.push(...(await procesar(caso, intentos)))

console.log("\nResumen")
console.table(resumen)
console.log("out/control.csv")
console.log(await readFile(join(ctx.directory, "out", "control.csv"), "utf8"))
