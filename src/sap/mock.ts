// SAP simulado sobre archivos: out/sap/ordenes.jsonl (una OC por línea).
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { agregarLinea, leerTextoOpcional } from "../lib/archivos.ts"
import { normalizarNit } from "../lib/normalizar.ts"
import { OrdenCompraSchema, ProveedorSchema, type OrdenCompra } from "../schemas.ts"
import type { SapAdapter } from "./adapter.ts"

const PRIMER_NUMERO = 4500000001

const RegistroSchema = z.object({ numero_oc: z.string(), fecha: z.string(), orden: OrdenCompraSchema })
type Registro = z.infer<typeof RegistroSchema>

export class SapMock implements SapAdapter {
  private readonly rutaOrdenes: string
  private readonly rutaProveedores: string

  constructor(directory: string) {
    this.rutaOrdenes = join(directory, "out", "sap", "ordenes.jsonl")
    this.rutaProveedores = join(directory, "fixtures", "reto-03", "maestros", "proveedores.json")
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const proveedores = z.array(ProveedorSchema).parse(JSON.parse(await readFile(this.rutaProveedores, "utf8")))
    const encontrado = proveedores.find((p) => normalizarNit(p.nit) === normalizarNit(nit))
    return encontrado ? { codigo_sap: encontrado.codigo_sap, activo: encontrado.activo } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const registros = await this.leerRegistros()
    const ultimo = registros.at(-1)
    const numero_oc = String(ultimo ? Number(ultimo.numero_oc) + 1 : PRIMER_NUMERO)
    const fecha = new Date().toISOString()
    await agregarLinea(this.rutaOrdenes, JSON.stringify({ numero_oc, fecha, orden }))
    return { numero_oc, fecha }
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const registro = (await this.leerRegistros()).find((r) => r.orden.referencia.solicitud_id === solicitud_id)
    return registro ? { numero_oc: registro.numero_oc } : null
  }

  /** Extra del mock (no forma parte de la interfaz): fecha de una OC existente. */
  async fechaDeOrden(numero_oc: string): Promise<string | null> {
    return (await this.leerRegistros()).find((r) => r.numero_oc === numero_oc)?.fecha ?? null
  }

  private async leerRegistros(): Promise<Registro[]> {
    const texto = await leerTextoOpcional(this.rutaOrdenes)
    if (texto === null) return []
    return texto
      .split("\n")
      .filter((linea) => linea.trim() !== "")
      .map((linea) => RegistroSchema.parse(JSON.parse(linea)))
  }
}
