import { z } from "zod"

// ── Contexto de ejecución de herramientas (6.2) ─────────────────────────────
export type Ctx = { directory: string; sessionId: string }

// ── Fixtures de entrada (7.1) ────────────────────────────────────────────────
export const MonedaSchema = z.enum(["COP", "USD"])

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().positive(),
  moneda: MonedaSchema,
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().min(1),
})

export const AprobacionRawSchema = z.object({
  de: z.string(),
  para: z.string(),
  cc: z.array(z.string()).optional(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
})

// ── Paquete normalizado (7.2) ────────────────────────────────────────────────
// Extensiones sobre 7.2: cotizacion.numero / cotizacion.fecha (para cotizacion_ref
// y validez_hasta) y `faltantes` (HU-1: adjuntos ausentes por nombre).
export const CotizacionSchema = z.object({
  numero: z.string().nullable(),
  fecha: z.string().nullable(),
  proveedor: z.string(),
  nit: z.string().nullable(),
  total: z.number(),
  moneda: z.string(),
  validez_hasta: z.string().nullable(),
  texto: z.string(),
})

export const AprobacionSchema = z.object({
  de: z.string(),
  fecha: z.string(),
  aprobado: z.boolean(),
  texto: z.string(),
})

export const FacturaSchema = z.object({
  numero: z.string(),
  fecha: z.string(),
  total: z.number(),
})

export const PaqueteSchema = z.object({
  correo: z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() }),
  solicitud: SolicitudSchema,
  cotizacion: CotizacionSchema.nullable(),
  aprobacion: AprobacionSchema.nullable(),
  factura: FacturaSchema.nullable(),
  faltantes: z.array(z.string()),
})

// ── Maestros (7.1) ───────────────────────────────────────────────────────────
export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

// ── Validación (7.3 / HU-2) ──────────────────────────────────────────────────
export const ReglaSchema = z.enum(["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"])
export const TipoHallazgoSchema = z.enum(["bloqueo", "confirmacion", "derivado"])

export const HallazgoSchema = z.object({
  regla: ReglaSchema,
  tipo: TipoHallazgoSchema,
  detalle: z.string(),
  valores: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
})

export const ValorDerivadoSchema = z.object({ valor: z.string(), fuente: z.string() })

export const DerivadosSchema = z.object({
  indicador_iva: ValorDerivadoSchema.optional(),
  condiciones_pago: ValorDerivadoSchema.optional(),
  hallazgos: z.array(HallazgoSchema),
})

export const ResultadoValidacionSchema = z.object({
  apta: z.boolean(),
  bloqueos: z.array(HallazgoSchema),
  confirmaciones: z.array(HallazgoSchema),
  derivados: DerivadosSchema,
  retroactiva: z.boolean(),
})

// ── Orden de compra (7.4) ────────────────────────────────────────────────────
export const UnidadSchema = z.enum(["UN", "H", "MES"])

export const PosicionSchema = z.object({
  numero: z.number().int().positive(),
  descripcion: z.string().min(1).max(40),
  cantidad: z.number().positive(),
  unidad: UnidadSchema,
  precio_unitario: z.number().nonnegative(),
  centro_costo: z.string(),
  subarea: z.string(),
  indicador_iva: z.string(),
})

export const ExcepcionSchema = z.object({
  codigo: z.string(),
  detalle: z.string(),
  confirmado_por: z.string().nullable(),
})

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: MonedaSchema,
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string() }),
  posiciones: z.array(PosicionSchema).min(1),
  excepciones: z.array(ExcepcionSchema),
})

// ── Tipos ────────────────────────────────────────────────────────────────────
export type Moneda = z.infer<typeof MonedaSchema>
export type Correo = z.infer<typeof CorreoSchema>
export type Solicitud = z.infer<typeof SolicitudSchema>
export type AprobacionRaw = z.infer<typeof AprobacionRawSchema>
export type Cotizacion = z.infer<typeof CotizacionSchema>
export type Aprobacion = z.infer<typeof AprobacionSchema>
export type Factura = z.infer<typeof FacturaSchema>
export type Paquete = z.infer<typeof PaqueteSchema>
export type Proveedor = z.infer<typeof ProveedorSchema>
export type CentroCosto = z.infer<typeof CentroCostoSchema>
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>
export type CondicionPago = z.infer<typeof CondicionPagoSchema>
export type Regla = z.infer<typeof ReglaSchema>
export type Hallazgo = z.infer<typeof HallazgoSchema>
export type Derivados = z.infer<typeof DerivadosSchema>
export type ResultadoValidacion = z.infer<typeof ResultadoValidacionSchema>
export type Unidad = z.infer<typeof UnidadSchema>
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  ivas: IndicadorIva[]
  condiciones: CondicionPago[]
}
