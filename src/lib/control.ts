// Log de control para contabilidad/auditoría (HU-5): out/control.csv
import { existsSync } from "node:fs"
import type { Ctx, Hallazgo } from "../schemas.ts"
import { agregarLinea } from "./archivos.ts"
import { rutaOut } from "./rutas.ts"

export type ResultadoControl = "creada" | "bloqueada" | "pendiente" | "idempotente"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"]

export function escaparCsv(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replaceAll('"', '""')}"` : valor
}

function codigos(hallazgos: Hallazgo[]): string {
  return hallazgos.map((h) => h.regla).join("|")
}

export function formatearFila(fila: FilaControl, ts: string): string {
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    codigos(fila.bloqueos),
    codigos(fila.confirmaciones),
    ts,
  ]
  return valores.map(escaparCsv).join(",")
}

export async function registrarControl(ctx: Ctx, fila: FilaControl): Promise<void> {
  const ruta = rutaOut(ctx, "control.csv")
  if (!existsSync(ruta)) await agregarLinea(ruta, COLUMNAS.join(","))
  await agregarLinea(ruta, formatearFila(fila, new Date().toISOString()))
}
