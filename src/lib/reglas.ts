// Reglas de control RC1–RC10 (PRD 7.3). Funciones puras: (paquete, maestros) → hallazgos.
import type {
  CentroCosto,
  Derivados,
  Hallazgo,
  Maestros,
  Paquete,
  Proveedor,
  Regla,
  ResultadoValidacion,
} from "../schemas.ts"
import { normalizarNit, normalizarNombre, parsearFecha } from "./normalizar.ts"

type ReglaFn = (p: Paquete, m: Maestros) => Hallazgo[]

const TOLERANCIA_COTIZACION = 0.02
const TOLERANCIA_ARITMETICA = 1

function bloqueo(regla: Regla, detalle: string, valores?: Hallazgo["valores"]): Hallazgo {
  return { regla, tipo: "bloqueo", detalle, ...(valores ? { valores } : {}) }
}

function confirmacion(regla: Regla, detalle: string, valores?: Hallazgo["valores"]): Hallazgo {
  return { regla, tipo: "confirmacion", detalle, ...(valores ? { valores } : {}) }
}

function derivado(regla: Regla, detalle: string, valor: string, fuente: string): Hallazgo {
  return { regla, tipo: "derivado", detalle, valores: { valor, fuente } }
}

// ── Búsquedas en maestros ────────────────────────────────────────────────────

/** Por NIT de la solicitud si existe; si no, por nombre normalizado. */
export function buscarProveedor(p: Paquete, m: Maestros): Proveedor | null {
  const { proveedor_nit, proveedor_nombre } = p.solicitud
  if (proveedor_nit) {
    const nit = normalizarNit(proveedor_nit)
    return m.proveedores.find((x) => normalizarNit(x.nit) === nit) ?? null
  }
  const nombre = normalizarNombre(proveedor_nombre)
  return m.proveedores.find((x) => normalizarNombre(x.nombre) === nombre) ?? null
}

export function buscarCentro(p: Paquete, m: Maestros): CentroCosto | null {
  return m.centros.find((c) => c.centro_costo === p.solicitud.centro_costo) ?? null
}

function buscarAprobador(p: Paquete, centro: CentroCosto | null): CentroCosto["aprobadores"][number] | null {
  const email = p.aprobacion?.de.trim().toLowerCase()
  if (!centro || !email) return null
  return centro.aprobadores.find((a) => a.email.toLowerCase() === email) ?? null
}

function fmt(n: number): string {
  return n.toLocaleString("es-CO")
}

// ── Reglas ───────────────────────────────────────────────────────────────────

export const rc1: ReglaFn = (p, m) => {
  const criterio = p.solicitud.proveedor_nit ? `NIT ${p.solicitud.proveedor_nit}` : `nombre "${p.solicitud.proveedor_nombre}"`
  const proveedor = buscarProveedor(p, m)
  if (!proveedor) return [bloqueo("RC1", `El proveedor (${criterio}) no existe en el maestro de proveedores.`)]
  if (!proveedor.activo) {
    return [bloqueo("RC1", `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) está inactivo.`)]
  }
  return []
}

export const rc2: ReglaFn = (p, m) => {
  const { centro_costo } = p.solicitud
  const centro = buscarCentro(p, m)
  if (!centro) return [bloqueo("RC2", `El centro de costo ${centro_costo} no existe en el maestro.`)]
  if (!p.aprobacion) return [bloqueo("RC2", "No hay correo de aprobación en el paquete.")]
  if (!p.aprobacion.aprobado) return [bloqueo("RC2", `El correo de ${p.aprobacion.de} no contiene "Aprobado".`)]
  if (!buscarAprobador(p, centro)) {
    const validos = centro.aprobadores.map((a) => a.email).join(", ")
    return [
      bloqueo("RC2", `${p.aprobacion.de} no es aprobador de ${centro_costo}. Aprobadores válidos: ${validos}.`, {
        aprobador: p.aprobacion.de,
        centro_costo,
      }),
    ]
  }
  return []
}

/** Solo se evalúa si el aprobador está listado en ESE centro; si no, RC2 ya bloquea. */
export const rc3: ReglaFn = (p, m) => {
  const aprobador = buscarAprobador(p, buscarCentro(p, m))
  const { valor_total, centro_costo } = p.solicitud
  if (!aprobador || valor_total <= aprobador.tope) return []
  return [
    bloqueo(
      "RC3",
      `El valor ${fmt(valor_total)} supera el tope de ${aprobador.email} en ${centro_costo} (${fmt(aprobador.tope)}).`,
      { valor_total, tope: aprobador.tope, aprobador: aprobador.email },
    ),
  ]
}

export const rc4: ReglaFn = (p, m) => {
  const centro = buscarCentro(p, m)
  const { subarea, centro_costo } = p.solicitud
  if (!centro || centro.subareas.includes(subarea)) return []
  return [
    bloqueo("RC4", `La subárea "${subarea}" no pertenece a ${centro_costo} (${centro.subareas.join(", ")}).`),
  ]
}

export const rc5: ReglaFn = (p) => {
  const sol = p.solicitud.valor_total
  if (!p.cotizacion) return [confirmacion("RC5", "No hay cotización en el paquete; confirme crear la OC sin ella.")]
  const cot = p.cotizacion.total
  const diferencia = Math.abs(cot - sol) / sol
  if (diferencia <= TOLERANCIA_COTIZACION) return []
  const pct = Math.round(diferencia * 10_000) / 100
  return [
    confirmacion(
      "RC5",
      `La cotización (${fmt(cot)}) difiere ${pct} % de la solicitud (${fmt(sol)}); el máximo es 2 %.`,
      { solicitud: sol, cotizacion: cot, diferencia_pct: pct },
    ),
  ]
}

export const rc6: ReglaFn = (p, m) => {
  const proveedor = buscarProveedor(p, m)
  if (p.solicitud.indicador_iva || !proveedor) return []
  const codigo = proveedor.indicador_iva_default
  const iva = m.ivas.find((i) => i.codigo === codigo)
  if (!iva) return [bloqueo("RC6", `El IVA por defecto del proveedor (${codigo}) no existe en el maestro de IVA.`)]
  const detalle = `La solicitud no informa IVA; se usa ${codigo} (${iva.descripcion}), default del proveedor ${proveedor.nombre}`
  return [
    derivado("RC6", detalle, codigo, "maestro.proveedores"),
    confirmacion("RC6", `${detalle}; confirme el indicador.`, { indicador_iva: codigo }),
  ]
}

export const rc7: ReglaFn = (p, m) => {
  const proveedor = buscarProveedor(p, m)
  if (p.solicitud.condiciones_pago || !proveedor) return []
  const codigo = proveedor.condiciones_pago_default
  const condicion = m.condiciones.find((c) => c.codigo === codigo)
  const descripcion = condicion ? ` (${condicion.descripcion})` : ""
  const detalle = `La solicitud no informa condiciones de pago; se usa ${codigo}${descripcion} del proveedor.`
  return [derivado("RC7", detalle, codigo, "maestro.proveedores")]
}

export const rc8: ReglaFn = (p) => {
  const factura = p.factura
  const fechaFactura = factura ? parsearFecha(factura.fecha) : null
  const fechaSolicitud = parsearFecha(p.solicitud.fecha_solicitud)
  if (!factura || !fechaFactura || !fechaSolicitud) return []
  if (fechaFactura.getTime() >= fechaSolicitud.getTime()) return []
  return [
    confirmacion(
      "RC8",
      `OC retroactiva: la factura ${factura.numero} (${factura.fecha}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}).`,
      { factura: factura.numero, fecha_factura: factura.fecha, fecha_solicitud: p.solicitud.fecha_solicitud },
    ),
  ]
}

export const rc9: ReglaFn = (p) => {
  if (!p.aprobacion) return []
  const fechaAprobacion = parsearFecha(p.aprobacion.fecha)
  const fechaSolicitud = parsearFecha(p.solicitud.fecha_solicitud)
  if (!fechaAprobacion || !fechaSolicitud) {
    return [confirmacion("RC9", `No se pudo interpretar la fecha de aprobación (${p.aprobacion.fecha}).`)]
  }
  if (fechaAprobacion.getTime() >= fechaSolicitud.getTime()) return []
  return [
    confirmacion(
      "RC9",
      `La aprobación (${p.aprobacion.fecha}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}).`,
      { fecha_aprobacion: p.aprobacion.fecha, fecha_solicitud: p.solicitud.fecha_solicitud },
    ),
  ]
}

export const rc10: ReglaFn = (p) => {
  const { cantidad, valor_unitario, valor_total } = p.solicitud
  const calculado = cantidad * valor_unitario
  if (Math.abs(calculado - valor_total) <= TOLERANCIA_ARITMETICA) return []
  return [
    bloqueo(
      "RC10",
      `cantidad × valor_unitario = ${fmt(calculado)} no coincide con valor_total ${fmt(valor_total)}.`,
      { cantidad, valor_unitario, valor_total, calculado },
    ),
  ]
}

export const REGLAS: readonly ReglaFn[] = [rc1, rc2, rc3, rc4, rc5, rc6, rc7, rc8, rc9, rc10]

// ── Agregación ───────────────────────────────────────────────────────────────

function valorDerivado(h: Hallazgo | undefined): { valor: string; fuente: string } | undefined {
  const valor = h?.valores?.["valor"]
  const fuente = h?.valores?.["fuente"]
  return typeof valor === "string" && typeof fuente === "string" ? { valor, fuente } : undefined
}

function armarDerivados(hallazgos: Hallazgo[]): Derivados {
  const derivados: Derivados = { hallazgos }
  const iva = valorDerivado(hallazgos.find((h) => h.regla === "RC6"))
  const pago = valorDerivado(hallazgos.find((h) => h.regla === "RC7"))
  if (iva) derivados.indicador_iva = iva
  if (pago) derivados.condiciones_pago = pago
  return derivados
}

export function evaluarReglas(p: Paquete, m: Maestros): ResultadoValidacion {
  const hallazgos = REGLAS.flatMap((regla) => regla(p, m))
  const bloqueos = hallazgos.filter((h) => h.tipo === "bloqueo")
  const confirmaciones = hallazgos.filter((h) => h.tipo === "confirmacion")
  return {
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados: armarDerivados(hallazgos.filter((h) => h.tipo === "derivado")),
    retroactiva: confirmaciones.some((h) => h.regla === "RC8"),
  }
}
