// LLM simulado y determinista (LLM_PROVIDER=mock) para pruebas automáticas y demos sin clave.
// No tiene estado propio: deduce el siguiente paso del historial, como lo haría un modelo real.
// Solo afirma valores que salen de resultados de herramientas.
import type { DefinicionHerramienta, LlamadaHerramienta, LlmAdapter, Mensaje, RespuestaLlm } from "./adapter.ts"

type Evento = { nombre: string; args: Record<string, unknown>; ok: boolean; data: unknown; error: string; turno: number }

type Opciones = {
  /** Simula un modelo desobediente: intenta crear con confirmado: true sin permiso de la analista. */
  temerario?: boolean
}

function campo(valor: unknown, clave: string): unknown {
  return typeof valor === "object" && valor !== null ? (valor as Record<string, unknown>)[clave] : undefined
}

function reglas(lista: unknown): string[] {
  return Array.isArray(lista) ? lista.map((h) => `${String(campo(h, "regla"))}: ${String(campo(h, "detalle"))}`) : []
}

/** Reconstruye llamadas y resultados del historial, numerando los turnos del usuario. */
function eventos(mensajes: Mensaje[]): Evento[] {
  const llamadas = new Map<string, LlamadaHerramienta>()
  const lista: Evento[] = []
  let turno = 0
  for (const m of mensajes) {
    if (m.rol === "usuario") turno++
    if (m.rol === "modelo") for (const l of m.llamadas) llamadas.set(l.id, l)
    if (m.rol !== "herramienta") continue
    for (const r of m.resultados) {
      const respuesta: unknown = JSON.parse(r.contenido)
      const args = llamadas.get(r.id)?.args ?? {}
      lista.push({ nombre: r.nombre, args, ok: campo(respuesta, "ok") === true, data: campo(respuesta, "data"), error: String(campo(respuesta, "error") ?? ""), turno })
    }
  }
  return lista
}

function ultimoUsuario(mensajes: Mensaje[]): string {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i]
    if (m?.rol === "usuario") return m.texto
  }
  return ""
}

function turnoActual(mensajes: Mensaje[]): number {
  return mensajes.filter((m) => m.rol === "usuario").length
}

/** Caso con confirmaciones pendientes en la conversación (validado con confirmaciones y sin OC creada después). */
function casoPendiente(lista: Evento[]): string | null {
  let pendiente: string | null = null
  for (const e of lista) {
    const caso = typeof e.args["caso"] === "string" ? e.args["caso"] : null
    if (e.nombre === "oc_validar" && e.ok && reglas(campo(e.data, "confirmaciones")).length > 0) pendiente = caso
    if (e.nombre === "oc_crear" && e.ok && caso === pendiente) pendiente = null
  }
  return pendiente
}

function ultimo(lista: Evento[], nombre: string, caso?: string): Evento | undefined {
  return [...lista].reverse().find((e) => e.nombre === nombre && (caso === undefined || e.args["caso"] === caso))
}

let contador = 0
function llamada(nombre: string, args: Record<string, unknown>): LlamadaHerramienta {
  return { id: `mock-${++contador}`, nombre, args }
}

function texto(t: string): RespuestaLlm {
  return { texto: t, llamadas: [], uso_tokens: Math.ceil(t.length / 4) }
}

function herramientas(...llamadas: LlamadaHerramienta[]): RespuestaLlm {
  return { texto: "", llamadas, uso_tokens: 50 }
}

function presentar(caso: string, validacion: Evento, construida: Evento): string {
  const orden = campo(construida.data, "orden")
  const proveedor = campo(orden, "proveedor")
  const posicion = (campo(orden, "posiciones") as unknown[] | undefined)?.[0]
  const filas = [
    ["Proveedor", `${String(campo(proveedor, "nombre"))} (${String(campo(proveedor, "codigo_sap"))})`],
    ["Descripción", String(campo(posicion, "descripcion"))],
    ["Cantidad", `${String(campo(posicion, "cantidad"))} ${String(campo(posicion, "unidad"))}`],
    ["Precio unitario", `${String(campo(orden, "moneda"))} ${String(campo(posicion, "precio_unitario"))}`],
    ["Centro / subárea", `${String(campo(posicion, "centro_costo"))} / ${String(campo(posicion, "subarea"))}`],
    ["IVA / pago", `${String(campo(posicion, "indicador_iva"))} / ${String(campo(orden, "condiciones_pago"))}`],
  ]
  const tabla = ["| Campo | Valor |", "|---|---|", ...filas.map(([k, v]) => `| ${k} | ${v} |`)].join("\n")
  const confirmaciones = reglas(campo(validacion.data, "confirmaciones")).map((c) => `- ${c}`).join("\n")
  return `OC para ${caso}:\n\n${tabla}\n\n**Confirmaciones:**\n${confirmaciones}\n\n¿Confirmas la creación de la OC para ${caso}? Responde *confirmo* o *cancelar*.`
}

export class MockAdapter implements LlmAdapter {
  readonly proveedor = "mock"
  readonly modelo: string
  private readonly temerario: boolean

  constructor(modelo = "mock-reglas", opciones: Opciones = {}) {
    this.modelo = modelo
    this.temerario = opciones.temerario === true
  }

  async enviar(mensajes: Mensaje[], definiciones: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    if (definiciones.length === 0) return texto("Resumen: revisa las herramientas ejecutadas en este turno; falta completar el flujo.")
    const lista = eventos(mensajes)
    const turno = turnoActual(mensajes)
    const delTurno = lista.filter((e) => e.turno === turno)
    return delTurno.length === 0 ? this.iniciarTurno(mensajes, lista) : this.continuar(lista, delTurno)
  }

  private iniciarTurno(mensajes: Mensaje[], lista: Evento[]): RespuestaLlm {
    const textoUsuario = ultimoUsuario(mensajes)
    const caso = /sol-\d{3}/i.exec(textoUsuario)?.[0]?.toLowerCase()
    const confirma = /^\s*(confirmo|confirmar|s[ií]|procede|adelante)\b/i.test(textoUsuario)
    if (caso && !confirma) return herramientas(llamada("oc_leer_paquete", { caso }))
    const pendiente = confirma && caso ? caso : casoPendiente(lista)
    const orden = pendiente ? campo(ultimo(lista, "oc_construir_payload", pendiente)?.data, "orden") : undefined
    if (pendiente && orden) return herramientas(llamada("oc_crear", { caso: pendiente, payload: orden, confirmado: true }))
    return texto("Indica qué solicitud procesar, por ejemplo: procesa la solicitud sol-001.")
  }

  private continuar(lista: Evento[], delTurno: Evento[]): RespuestaLlm {
    const previo = delTurno.at(-1)
    if (!previo) return texto("Sin acciones.")
    const caso = String(previo.args["caso"])
    if (!previo.ok && previo.nombre !== "oc_crear") return texto(`No pude completar ${previo.nombre} para ${caso}: ${previo.error}`)
    switch (previo.nombre) {
      case "oc_leer_paquete":
        return herramientas(llamada("oc_validar", { caso }))
      case "oc_validar":
        return this.trasValidar(caso, previo)
      case "oc_construir_payload":
      case "oc_generar_evidencia":
        return this.trasConstruir(caso, lista, delTurno)
      case "oc_crear":
        return texto(this.trasCrear(caso, previo))
      default:
        return texto("Listo.")
    }
  }

  private trasValidar(caso: string, validacion: Evento): RespuestaLlm {
    if (campo(validacion.data, "apta") !== true) return herramientas(llamada("oc_crear", { caso }))
    return herramientas(
      llamada("oc_construir_payload", { caso }),
      llamada("oc_generar_evidencia", { caso }),
    )
  }

  private trasConstruir(caso: string, lista: Evento[], delTurno: Evento[]): RespuestaLlm {
    const validacion = ultimo(lista, "oc_validar", caso)
    const construida = ultimo(lista, "oc_construir_payload", caso)
    if (!validacion || !construida) return texto(`Faltan datos para presentar la OC de ${caso}.`)
    const orden = campo(construida.data, "orden")
    const hayConfirmaciones = reglas(campo(validacion.data, "confirmaciones")).length > 0
    if (!hayConfirmaciones) return herramientas(llamada("oc_crear", { caso, payload: orden }))
    const yaIntento = delTurno.some((e) => e.nombre === "oc_crear")
    if (this.temerario && !yaIntento) return herramientas(llamada("oc_crear", { caso, payload: orden, confirmado: true }))
    return texto(presentar(caso, validacion, construida))
  }

  private trasCrear(caso: string, e: Evento): string {
    if (e.ok) {
      const retro = campo(e.data, "retroactiva") === true ? " Quedó marcada como retroactiva." : ""
      const idem = campo(e.data, "idempotente") === true ? " (ya existía)" : ""
      return `OC ${String(campo(e.data, "numero_oc"))} creada para ${caso}${idem}.${retro}`
    }
    const bloqueos = reglas(campo(e.data, "bloqueos"))
    if (bloqueos.length > 0) return `No se puede crear la OC de ${caso}:\n${bloqueos.map((b) => `- ${b}`).join("\n")}`
    if (e.error.startsWith("Rechazado por el servidor")) {
      return `Necesito tu confirmación explícita para crear la OC de ${caso}. Responde *confirmo* o *cancelar*.`
    }
    return `No se creó la OC de ${caso}: ${e.error}`
  }
}
