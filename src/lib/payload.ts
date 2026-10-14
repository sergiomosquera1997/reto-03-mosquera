// Construcción pura del payload OrdenCompra (PRD 7.4) y su trazabilidad (HU-3).
import {
  OrdenCompraSchema,
  type Maestros,
  type OrdenCompra,
  type Paquete,
  type ResultadoValidacion,
  type Unidad,
} from "../schemas.ts"
import { buscarProveedor } from "./reglas.ts"
import { ErrorNegocio } from "./resultado.ts"

// PRD solo nombra solicitud | cotizacion | maestro.<nombre> | derivado. Se añaden
// "aprobacion" y "correo" porque email, fecha de aprobación y correo_id salen de ahí.
export type Fuente = "solicitud" | "cotizacion" | "aprobacion" | "correo" | `maestro.${string}` | "derivado"
export type Trazabilidad = Record<string, Fuente>

const LIMITE_DESCRIPCION = 40

/**
 * Supuesto: la unidad es "UN" salvo que la descripción lo diga claramente.
 * "H" si menciona hora(s); "MES" solo con "mensual" o "por mes" — "vigencia 12 meses"
 * describe la duración de una licencia, no la unidad de compra.
 */
export function inferirUnidad(descripcion: string): Unidad {
  if (/\bhoras?\b/i.test(descripcion)) return "H"
  if (/\b(mensual(es)?|por mes)\b/i.test(descripcion)) return "MES"
  return "UN"
}

/** Corta en el último espacio dentro del límite SAP, sin partir palabras ni dejar puntuación colgando. */
export function recortarDescripcion(descripcion: string): string {
  const texto = descripcion.trim()
  if (texto.length <= LIMITE_DESCRIPCION) return texto
  const corte = texto.slice(0, LIMITE_DESCRIPCION + 1).lastIndexOf(" ")
  const recortado = corte > 0 ? texto.slice(0, corte) : texto.slice(0, LIMITE_DESCRIPCION)
  return recortado.replace(/[\s,;:.\-]+$/, "")
}

function exigirApta(p: Paquete, m: Maestros, r: ResultadoValidacion) {
  const proveedor = buscarProveedor(p, m)
  if (!r.apta || !proveedor || !p.aprobacion) {
    const motivos = r.bloqueos.map((b) => `${b.regla}: ${b.detalle}`).join(" ")
    throw new ErrorNegocio(`No se puede construir la OC porque la solicitud tiene bloqueos. ${motivos}`.trim())
  }
  return { proveedor, aprobacion: p.aprobacion }
}

function trazar(p: Paquete, r: ResultadoValidacion): Trazabilidad {
  const s = p.solicitud
  return {
    "referencia.solicitud_id": "solicitud",
    "referencia.correo_id": "correo",
    "referencia.cotizacion_ref": "cotizacion",
    sociedad: "derivado",
    organizacion_compras: "derivado",
    "proveedor.codigo_sap": "maestro.proveedores",
    "proveedor.nit": "maestro.proveedores",
    "proveedor.nombre": "maestro.proveedores",
    moneda: "solicitud",
    condiciones_pago: s.condiciones_pago ? "solicitud" : "derivado",
    "aprobador.email": "aprobacion",
    "aprobador.fecha_aprobacion": "aprobacion",
    "aprobador.evidencia_sha256": "derivado",
    "posiciones[0].numero": "derivado",
    "posiciones[0].descripcion": "solicitud",
    "posiciones[0].cantidad": "solicitud",
    "posiciones[0].unidad": "derivado",
    "posiciones[0].precio_unitario": "solicitud",
    "posiciones[0].centro_costo": "solicitud",
    "posiciones[0].subarea": "solicitud",
    "posiciones[0].indicador_iva": r.derivados.indicador_iva ? "derivado" : "solicitud",
    excepciones: "derivado",
  }
}

export function construirOrden(
  p: Paquete,
  m: Maestros,
  r: ResultadoValidacion,
  evidenciaSha256: string,
): { orden: OrdenCompra; trazabilidad: Trazabilidad } {
  const { proveedor, aprobacion } = exigirApta(p, m, r)
  const s = p.solicitud
  const orden = OrdenCompraSchema.parse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.numero ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: s.condiciones_pago ?? r.derivados.condiciones_pago?.valor ?? proveedor.condiciones_pago_default,
    aprobador: { email: aprobacion.de, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: evidenciaSha256 },
    posiciones: [
      {
        numero: 10,
        descripcion: recortarDescripcion(s.descripcion),
        cantidad: s.cantidad,
        unidad: inferirUnidad(s.descripcion),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: s.indicador_iva ?? r.derivados.indicador_iva?.valor ?? proveedor.indicador_iva_default,
      },
    ],
    excepciones: r.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.detalle, confirmado_por: null })),
  })
  return { orden, trazabilidad: trazar(p, r) }
}

/** Campos que el modelo no puede alterar: si difieren del payload reconstruido, crear se niega. */
export function diferenciasCriticas(recibida: OrdenCompra, esperada: OrdenCompra): string[] {
  const pares: Array<[string, unknown, unknown]> = [
    ["proveedor.codigo_sap", recibida.proveedor.codigo_sap, esperada.proveedor.codigo_sap],
    ["proveedor.nit", recibida.proveedor.nit, esperada.proveedor.nit],
    ["moneda", recibida.moneda, esperada.moneda],
    ["posiciones (cantidad)", recibida.posiciones.length, esperada.posiciones.length],
  ]
  esperada.posiciones.forEach((e, i) => {
    const r = recibida.posiciones[i]
    pares.push(
      [`posiciones[${i}].cantidad`, r?.cantidad, e.cantidad],
      [`posiciones[${i}].precio_unitario`, r?.precio_unitario, e.precio_unitario],
      [`posiciones[${i}].centro_costo`, r?.centro_costo, e.centro_costo],
      [`posiciones[${i}].subarea`, r?.subarea, e.subarea],
      [`posiciones[${i}].indicador_iva`, r?.indicador_iva, e.indicador_iva],
    )
  })
  return pares.filter(([, a, b]) => a !== b).map(([campo, a, b]) => `${campo}: recibido ${String(a)}, esperado ${String(b)}`)
}
