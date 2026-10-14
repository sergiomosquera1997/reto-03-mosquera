// Parsers puros de los textos de cotización y factura (fixtures normalizados desde PDF).
import type { Cotizacion, Factura } from "../schemas.ts"
import { formatearFecha, parsearFecha, parsearMonto, sumarDias } from "./normalizar.ts"
import { ErrorNegocio } from "./resultado.ts"

function capturar(texto: string, patron: RegExp): string | null {
  return patron.exec(texto)?.[1]?.trim() ?? null
}

function fechaNormalizada(texto: string | null): string | null {
  const fecha = texto === null ? null : parsearFecha(texto)
  return fecha === null ? null : formatearFecha(fecha)
}

function leerTotal(texto: string, patron: RegExp, documento: string): { total: number; moneda: string } {
  const m = patron.exec(texto)
  const total = m?.[2] === undefined ? null : parsearMonto(m[2])
  if (!m?.[1] || total === null) {
    throw new ErrorNegocio(`No se pudo leer el TOTAL de la ${documento}. Pida al solicitante una copia legible.`)
  }
  return { total, moneda: m[1] }
}

function calcularValidez(fecha: string | null, texto: string): string | null {
  const dias = capturar(texto, /Validez de la oferta:\s*(\d+)\s*d[ií]as/i)
  const base = fecha === null ? null : parsearFecha(fecha)
  if (dias === null || base === null) return null
  return formatearFecha(sumarDias(base, Number(dias)))
}

export function parsearCotizacion(texto: string): Cotizacion {
  const fecha = fechaNormalizada(capturar(texto, /^Fecha:\s*(.+)$/m))
  const { total, moneda } = leerTotal(texto, /^TOTAL[^:\n]*:\s*(COP|USD)\s*([\d.,]+)/m, "cotización")
  return {
    numero: capturar(texto, /COTIZACI[ÓO]N\s+(\S+)/i),
    fecha,
    proveedor: capturar(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: capturar(texto, /^NIT:\s*([\d.\-]+)/m),
    total,
    moneda,
    validez_hasta: calcularValidez(fecha, texto),
    texto,
  }
}

export function parsearFactura(texto: string): Factura {
  const numero = capturar(texto, /No\.\s*(\S+)/)
  const fecha = fechaNormalizada(capturar(texto, /Fecha de emisi[óo]n:\s*(.+)$/im))
  if (numero === null || fecha === null) {
    throw new ErrorNegocio("No se pudo leer el número o la fecha de la factura. Pida al solicitante una copia legible.")
  }
  const { total } = leerTotal(texto, /^TOTAL:\s*(COP|USD)\s*([\d.,]+)/m, "factura")
  return { numero, fecha, total }
}
