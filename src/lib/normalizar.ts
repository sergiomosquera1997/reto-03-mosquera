// Normalizaciones puras: NIT, nombres de proveedor, montos y fechas.

const SUFIJOS_SOCIETARIOS = new Set(["sas", "sa", "ltda"])

/** "900.555.111-2" → "900555111"; "900555111" → "900555111". El DV va tras el guion. */
export function normalizarNit(nit: string): string {
  const sinDv = nit.includes("-") ? nit.slice(0, nit.lastIndexOf("-")) : nit
  return sinDv.replace(/\D/g, "")
}

export function quitarTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/** "TecnoSuministros S.A.S." → "tecnosuministros". */
export function normalizarNombre(nombre: string): string {
  const palabras = quitarTildes(nombre).toLowerCase().replace(/[.,]/g, "").split(/\s+/).filter(Boolean)
  while (palabras.length > 1 && SUFIJOS_SOCIETARIOS.has(palabras[palabras.length - 1] ?? "")) palabras.pop()
  return palabras.join(" ")
}

/** Formato colombiano: punto de miles, coma decimal. "26.500.000" → 26500000; "1.234,5" → 1234.5. */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.trim().replace(/\./g, "").replace(",", ".")
  if (!/^\d+(\.\d+)?$/.test(limpio)) return null
  return Number(limpio)
}

const ISO_FECHA = /^(\d{4})-(\d{2})-(\d{2})/
const DMY_FECHA = /^(\d{2})\/(\d{2})\/(\d{4})$/

function fechaUtc(anio: number, mes: number, dia: number): Date | null {
  const fecha = new Date(Date.UTC(anio, mes - 1, dia))
  const valida = fecha.getUTCFullYear() === anio && fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === dia
  return valida ? fecha : null
}

/**
 * Devuelve el día calendario del documento como Date a las 00:00 UTC.
 * Acepta YYYY-MM-DD, DD/MM/YYYY e ISO con hora/offset (se toma la fecha local
 * escrita en el documento, ignorando la hora), para que una aprobación del mismo
 * día que la solicitud no parezca anterior por diferencia de zona horaria.
 */
export function parsearFecha(texto: string): Date | null {
  const t = texto.trim()
  const iso = ISO_FECHA.exec(t)
  if (iso) return fechaUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const dmy = DMY_FECHA.exec(t)
  if (dmy) return fechaUtc(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))
  return null
}

export function formatearFecha(fecha: Date): string {
  return fecha.toISOString().slice(0, 10)
}

export function sumarDias(fecha: Date, dias: number): Date {
  return new Date(fecha.getTime() + dias * 86_400_000)
}
