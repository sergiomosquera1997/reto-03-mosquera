// Herramientas del agente (PRD 6.2). El modelo las ve como oc_<export>.
// Cada execute devuelve un string JSON { ok, data } | { ok:false, error } y nunca lanza.
import { z } from "zod"
import { escribirArchivo, leerJsonOpcional, leerTextoOpcional } from "../lib/archivos.ts"
import { registrarControl, type FilaControl } from "../lib/control.ts"
import { renderizarEvidencia } from "../lib/evidencia.ts"
import { cargarMaestros } from "../lib/maestros.ts"
import { parsearFecha } from "../lib/normalizar.ts"
import { parsearCotizacion, parsearFactura } from "../lib/parsers.ts"
import { construirOrden, diferenciasCriticas, type Trazabilidad } from "../lib/payload.ts"
import { igualesJson } from "../lib/json.ts"
import { evaluarReglas } from "../lib/reglas.ts"
import { ErrorNegocio, envolver, fallo, ok } from "../lib/resultado.ts"
import { relativa, rutaCaso, rutaOut, validarCaso } from "../lib/rutas.ts"
import { SapMock } from "../sap/mock.ts"
import {
  AprobacionRawSchema,
  CorreoSchema,
  DerivadosSchema,
  OrdenCompraSchema,
  PaqueteSchema,
  SolicitudSchema,
  type Aprobacion,
  type Ctx,
  type Derivados,
  type OrdenCompra,
  type Paquete,
  type ResultadoValidacion,
} from "../schemas.ts"

const casoArg = z.string().describe('Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. "sol-001")')
const paqueteArg = PaqueteSchema.optional().describe(
  "Opcional; no hace falta enviarlo: la herramienta usa el paquete que oc_leer_paquete guardó para el caso",
)

/** Valida los argumentos aunque la herramienta se llame sin el backend (demo.ts). */
function validarArgs<S extends z.ZodRawShape>(args: S, valor: unknown): z.infer<z.ZodObject<S>> {
  const r = z.object(args).safeParse(valor)
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new ErrorNegocio(`Argumentos inválidos: ${detalle}`)
  }
  return r.data
}

// ── Lectura del paquete ──────────────────────────────────────────────────────

async function leerObligatorio<T>(ctx: Ctx, caso: string, archivo: string, schema: z.ZodType<T>): Promise<T> {
  const valor = await leerJsonOpcional(rutaCaso(ctx, caso, archivo), schema)
  if (valor === null) throw new ErrorNegocio(`Falta ${archivo} en el caso ${caso}. Pida al solicitante que lo envíe.`)
  return valor
}

async function leerAprobacionRaw(ctx: Ctx, caso: string) {
  return leerJsonOpcional(rutaCaso(ctx, caso, "aprobacion.json"), AprobacionRawSchema)
}

function normalizarAprobacion(raw: z.infer<typeof AprobacionRawSchema>): Aprobacion {
  return { de: raw.de, fecha: raw.fecha, aprobado: /aprobado/i.test(raw.cuerpo), texto: raw.cuerpo }
}

export async function cargarPaquete(ctx: Ctx, caso: string): Promise<Paquete> {
  const correo = await leerObligatorio(ctx, caso, "correo.json", CorreoSchema)
  const solicitud = await leerObligatorio(ctx, caso, "solicitud.json", SolicitudSchema)
  if (!parsearFecha(solicitud.fecha_solicitud)) {
    throw new ErrorNegocio(`fecha_solicitud "${solicitud.fecha_solicitud}" no es una fecha válida. Pida al solicitante que la corrija.`)
  }
  const textoCotizacion = await leerTextoOpcional(rutaCaso(ctx, caso, "cotizacion.txt"))
  const aprobacionRaw = await leerAprobacionRaw(ctx, caso)
  const textoFactura = await leerTextoOpcional(rutaCaso(ctx, caso, "factura.txt"))
  const faltantes = [
    ...(textoCotizacion === null ? ["cotizacion.txt"] : []),
    ...(aprobacionRaw === null ? ["aprobacion.json"] : []),
  ]
  return {
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion: textoCotizacion === null ? null : parsearCotizacion(textoCotizacion),
    aprobacion: aprobacionRaw === null ? null : normalizarAprobacion(aprobacionRaw),
    factura: textoFactura === null ? null : parsearFactura(textoFactura),
    faltantes,
  }
}

// ── Paquete persistido por caso ──────────────────────────────────────────────
// Los valores nunca salen del modelo: validar y construir leen el paquete de
// out/<caso>/paquete.json (o lo recalculan desde los fixtures). Si el modelo envía
// uno distinto, se ignora y se devuelve una advertencia.

async function guardarPaquete(ctx: Ctx, caso: string, paquete: Paquete): Promise<void> {
  await escribirArchivo(rutaOut(ctx, caso, "paquete.json"), JSON.stringify(paquete, null, 2))
}

async function paqueteDelCaso(ctx: Ctx, caso: string): Promise<Paquete> {
  const guardado = await leerJsonOpcional(rutaOut(ctx, validarCaso(caso), "paquete.json"), PaqueteSchema)
  if (guardado) return guardado
  const paquete = await cargarPaquete(ctx, caso)
  await guardarPaquete(ctx, caso, paquete)
  return paquete
}

async function resolverPaquete(ctx: Ctx, caso: string, recibido?: Paquete): Promise<{ paquete: Paquete; advertencias: string[] }> {
  const paquete = await paqueteDelCaso(ctx, caso)
  const advertencias =
    recibido && !igualesJson(recibido, paquete)
      ? [`El paquete enviado no coincide con el del caso; se usó el guardado en out/${caso}/paquete.json.`]
      : []
  return { paquete, advertencias }
}

function conAdvertencias<T extends object>(data: T, advertencias: string[]): T & { advertencias?: string[] } {
  return advertencias.length > 0 ? { ...data, advertencias } : data
}

// ── Preparación compartida (validar → evidencia → payload) ───────────────────

async function calcularEvidencia(ctx: Ctx, caso: string) {
  const raw = await leerAprobacionRaw(ctx, caso)
  if (raw === null) throw new ErrorNegocio(`No hay aprobacion.json en ${caso}; pida al líder el correo de aprobación.`)
  return renderizarEvidencia(raw)
}

type Preparacion = { resultado: ResultadoValidacion; orden: OrdenCompra | null; trazabilidad: Trazabilidad | null }

async function preparar(ctx: Ctx, caso: string, paquete: Paquete): Promise<Preparacion> {
  const maestros = await cargarMaestros(ctx)
  const resultado = evaluarReglas(paquete, maestros)
  if (!resultado.apta) return { resultado, orden: null, trazabilidad: null }
  const { sha256 } = await calcularEvidencia(ctx, caso)
  const { orden, trazabilidad } = construirOrden(paquete, maestros, resultado, sha256)
  return { resultado, orden, trazabilidad }
}

function compararDerivados(recibidos: Derivados, calculados: Derivados): string[] {
  const campos = ["indicador_iva", "condiciones_pago"] as const
  return campos
    .filter((c) => recibidos[c]?.valor !== calculados[c]?.valor)
    .map((c) => `${c}: recibido ${recibidos[c]?.valor ?? "(vacío)"}, esperado ${calculados[c]?.valor ?? "(vacío)"}`)
}

// ── Herramientas ─────────────────────────────────────────────────────────────

const argsLeer = { caso: casoArg }
export const leer_paquete = {
  description:
    "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y los devuelve normalizados.",
  args: argsLeer,
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return envolver(async () => {
      const { caso } = validarArgs(argsLeer, args)
      const paquete = await cargarPaquete(ctx, caso)
      await guardarPaquete(ctx, caso, paquete)
      return ok(paquete)
    })
  },
}

const argsValidar = { caso: casoArg, paquete: paqueteArg }
export const validar = {
  description:
    "Aplica las reglas de control RC1–RC10 al paquete y devuelve si es apta, los bloqueos, las confirmaciones, los valores derivados y si es retroactiva.",
  args: argsValidar,
  async execute(args: { caso: string; paquete?: Paquete }, ctx: Ctx): Promise<string> {
    return envolver(async () => {
      const { caso, paquete: recibido } = validarArgs(argsValidar, args)
      const { paquete, advertencias } = await resolverPaquete(ctx, caso, recibido)
      return ok(conAdvertencias(evaluarReglas(paquete, await cargarMaestros(ctx)), advertencias))
    })
  },
}

const argsConstruir = {
  caso: casoArg,
  paquete: paqueteArg,
  derivados: DerivadosSchema.optional().describe("Opcional; no hace falta enviarlo: se recalculan desde los maestros"),
}
export const construir_payload = {
  description:
    "Construye la orden de compra exactamente como quedaría en SAP y guarda la trazabilidad de cada campo en out/<caso>/trazabilidad.json.",
  args: argsConstruir,
  async execute(args: { caso: string; paquete?: Paquete; derivados?: Derivados }, ctx: Ctx): Promise<string> {
    return envolver(async () => {
      const { caso, paquete: recibido, derivados } = validarArgs(argsConstruir, args)
      const { paquete, advertencias } = await resolverPaquete(ctx, caso, recibido)
      const { resultado, orden, trazabilidad } = await preparar(ctx, caso, paquete)
      if (!orden || !trazabilidad) return fallo("La solicitud tiene bloqueos; no se construye la OC.", { bloqueos: resultado.bloqueos })
      const diferencias = derivados ? compararDerivados(derivados, resultado.derivados) : []
      if (diferencias.length > 0) advertencias.push(`Los derivados enviados no coinciden con los maestros; se usaron los calculados (${diferencias.join("; ")}).`)
      const ruta = rutaOut(ctx, caso, "trazabilidad.json")
      await escribirArchivo(ruta, JSON.stringify(trazabilidad, null, 2))
      return ok(conAdvertencias({ orden, ruta_trazabilidad: relativa(ctx, ruta) }, advertencias))
    })
  },
}

export const generar_evidencia = {
  description:
    "Genera out/<caso>/aprobacion.txt con los encabezados y el cuerpo del correo de aprobación, y devuelve su ruta y sha256.",
  args: argsLeer,
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return envolver(async () => {
      const { caso } = validarArgs(argsLeer, args)
      const evidencia = await calcularEvidencia(ctx, caso)
      const ruta = rutaOut(ctx, caso, "aprobacion.txt")
      await escribirArchivo(ruta, evidencia.archivo)
      return ok({ ruta: relativa(ctx, ruta), sha256: evidencia.sha256 })
    })
  },
}

const argsCrear = {
  caso: casoArg,
  payload: OrdenCompraSchema.optional().describe(
    "Orden de compra tal como la devolvió oc_construir_payload; puede omitirse solo si la solicitud está bloqueada",
  ),
  confirmado: z
    .boolean()
    .optional()
    .describe("true solo si la analista confirmó explícitamente las confirmaciones pendientes en este turno"),
}

function fila(paquete: Paquete, r: ResultadoValidacion, resultado: FilaControl["resultado"], numero_oc: string | null): FilaControl {
  return {
    solicitud_id: paquete.solicitud.solicitud_id,
    resultado,
    numero_oc,
    retroactiva: r.retroactiva,
    bloqueos: r.bloqueos,
    confirmaciones: r.confirmaciones,
  }
}

/** HU-5: un intento bloqueado también deja fila en control.csv, se haya enviado payload o no. */
async function rechazarBloqueada(ctx: Ctx, paquete: Paquete, r: ResultadoValidacion): Promise<string> {
  await registrarControl(ctx, fila(paquete, r, "bloqueada", null))
  const motivos = r.bloqueos.map((b) => `${b.regla}: ${b.detalle}`).join(" ")
  return fallo(`La OC no se crea porque la solicitud tiene bloqueos. ${motivos}`, { bloqueos: r.bloqueos })
}

function verificarPayload(payload: OrdenCompra | undefined, orden: OrdenCompra): string | null {
  if (!payload) return "Falta el payload: llame primero a oc_construir_payload y envíe la orden que devolvió."
  const diferencias = diferenciasCriticas(payload, orden)
  if (diferencias.length === 0) return null
  return `El payload recibido no coincide con el validado; no se crea la OC. ${diferencias.join("; ")}`
}

async function ejecutarCrear(ctx: Ctx, caso: string, payload: OrdenCompra | undefined, confirmado: boolean): Promise<string> {
  const paquete = await cargarPaquete(ctx, caso)
  const { resultado: r, orden } = await preparar(ctx, caso, paquete)
  if (!orden) return rechazarBloqueada(ctx, paquete, r)
  const errorPayload = verificarPayload(payload, orden)
  if (errorPayload) return fallo(errorPayload)
  const sap = new SapMock(ctx.directory)
  const existente = await sap.buscarOrdenPorReferencia(paquete.solicitud.solicitud_id)
  if (existente) {
    await registrarControl(ctx, fila(paquete, r, "idempotente", existente.numero_oc))
    const fecha = await sap.fechaDeOrden(existente.numero_oc)
    return ok({ numero_oc: existente.numero_oc, fecha, idempotente: true, retroactiva: r.retroactiva })
  }
  if (r.confirmaciones.length > 0 && !confirmado) {
    await registrarControl(ctx, fila(paquete, r, "pendiente", null))
    return fallo("La OC requiere confirmación explícita de la analista antes de crearse.", {
      confirmaciones_pendientes: r.confirmaciones,
    })
  }
  const confirmada = { ...orden, excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: "analista" })) }
  const { numero_oc, fecha } = await sap.crearOrden(confirmada)
  await registrarControl(ctx, fila(paquete, r, "creada", numero_oc))
  return ok({ numero_oc, fecha, idempotente: false, retroactiva: r.retroactiva })
}

export const crear = {
  description:
    "Crea la orden de compra en SAP (simulado) si no hay bloqueos y las confirmaciones fueron aceptadas; es idempotente por solicitud_id y registra cada intento, incluso bloqueado, en out/control.csv.",
  args: argsCrear,
  async execute(args: { caso: string; payload?: OrdenCompra; confirmado?: boolean }, ctx: Ctx): Promise<string> {
    return envolver(async () => {
      const { caso, payload, confirmado } = validarArgs(argsCrear, args)
      return ejecutarCrear(ctx, caso, payload, confirmado === true)
    })
  },
}
