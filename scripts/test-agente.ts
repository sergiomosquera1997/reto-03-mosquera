// Pruebas automáticas del ciclo del agente con el LLM simulado (sin clave ni red).
// Reproduce el guion de sol-004 y la regla CA3: la confirmación la controla el servidor.
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { autorizarCreacion, clasificarMensaje, type EstadoConfirmacion } from "../src/agent/confirmacion.ts"
import { procesarTurno, type Dependencias } from "../src/agent/loop.ts"
import { AlmacenSesiones } from "../src/agent/sesiones.ts"
import { ErrorLlm, type LlmAdapter } from "../src/llm/adapter.ts"
import { MockAdapter } from "../src/llm/mock.ts"

const directory = join(import.meta.dirname, "..")
const base: Dependencias = { llm: new MockAdapter("mock-temerario", { temerario: true }), directory, sistema: "prueba", maxIter: 25, maxTokensSesion: 1_000_000 }
let fallos = 0

async function prueba(nombre: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`✔ ${nombre}`)
  } catch (e) {
    fallos++
    console.log(`✘ ${nombre}\n  ${e instanceof Error ? e.message : String(e)}`)
  }
}

function nombres(r: { toolCalls: Array<{ nombre: string; ok: boolean }> }): string[] {
  return r.toolCalls.map((t) => `${t.nombre}:${t.ok ? "ok" : "err"}`)
}

await rm(join(directory, "out"), { recursive: true, force: true })

await prueba("clasificación de mensajes", () => {
  const intencion = (t: string) => clasificarMensaje(t).intencion
  for (const t of ["confirmo", "Confirmo.", "¡Sí!", "si", "SÍ, CONFIRMO", "adelante", "procede"]) assert.equal(intencion(t), "confirmar", t)
  for (const t of ["No", "cancela", "no, cancelar"]) assert.equal(intencion(t), "cancelar", t)
  for (const t of ["sí pero cambia el IVA", "ok, dale", "", "procesa sol-001", "sol-004", "confirmo sol-004 y sol-005"]) assert.equal(intencion(t), "otro", t)
  assert.deepEqual(clasificarMensaje("Confirmo sol-004."), { intencion: "confirmar", caso: "sol-004" })
  assert.deepEqual(clasificarMensaje("no, cancela sol-006"), { intencion: "cancelar", caso: "sol-006" })
  assert.deepEqual(clasificarMensaje("cualquier cosa", { caso: "sol-005", valor: true }), { intencion: "confirmar", caso: "sol-005" })
  assert.deepEqual(clasificarMensaje("sí", { caso: "sol-005", valor: false }), { intencion: "cancelar", caso: "sol-005" })
})

await prueba("autorizarCreacion: la confirmación solo habilita el caso confirmado", () => {
  const pendiente = (caso: string) => ({ caso, confirmaciones: [], mensajeUsuario: 1 })
  const pendientes = new Map([["sol-005", pendiente("sol-005")], ["sol-006", pendiente("sol-006")]])
  const conCaso: EstadoConfirmacion = { pendientes, mensajesUsuario: 2, ultimaDecision: { intencion: "confirmar", caso: "sol-006" } }
  assert.equal(autorizarCreacion(conCaso, "sol-006", true), null)
  assert.match(autorizarCreacion(conCaso, "sol-005", true) ?? "", /confirmó sol-006, no sol-005/)
  const sinCaso: EstadoConfirmacion = { ...conCaso, ultimaDecision: { intencion: "confirmar", caso: null } }
  assert.match(autorizarCreacion(sinCaso, "sol-006", true) ?? "", /varias OC pendientes/)
  assert.equal(autorizarCreacion(sinCaso, "sol-006", false), null)
})

const sesion = new AlmacenSesiones().obtener("sol-004")

await prueba("sol-004 turno 1: valida, pide confirmación y el servidor rechaza confirmar en el mismo turno", async () => {
  const r = await procesarTurno(sesion, { message: "Procesa la solicitud sol-004 y no la crees hasta que confirme" }, base)
  assert.deepEqual(nombres(r), [
    "oc_leer_paquete:ok", "oc_validar:ok", "oc_construir_payload:ok", "oc_generar_evidencia:ok", "oc_crear:err",
  ])
  assert.match(r.toolCalls[4]?.resumen ?? "", /Rechazado por el servidor: no hay confirmaciones pendientes/)
  assert.equal(r.needsConfirmation, true)
  assert.deepEqual(r.pendientes.map((p) => [p.caso, p.confirmaciones.map((c) => c.regla)]), [["sol-004", ["RC5"]]])
})

await prueba("sol-004 turno 2: 'ok, dale' no es confirmación explícita", async () => {
  const r = await procesarTurno(sesion, { message: "ok, dale" }, base)
  assert.deepEqual(nombres(r), ["oc_crear:err"])
  assert.match(r.toolCalls[0]?.resumen ?? "", /no ha confirmado explícitamente/)
  assert.equal(r.needsConfirmation, true)
})

await prueba("sol-004 turno 3: 'confirmo' crea la OC", async () => {
  const r = await procesarTurno(sesion, { message: "confirmo" }, base)
  assert.deepEqual(nombres(r), ["oc_crear:ok"])
  assert.match(r.reply, /OC 4500000001 creada para sol-004/)
  assert.equal(r.needsConfirmation, false)
})

await prueba("botón Cancelar de un caso descarta solo ese pendiente, sin llamar al modelo", async () => {
  const s = new AlmacenSesiones().obtener("cancelar")
  await procesarTurno(s, { message: "procesa sol-006" }, { ...base, llm: new MockAdapter() })
  assert.equal(s.pendientes.has("sol-006"), true)
  const r = await procesarTurno(s, { confirm: { caso: "sol-006", valor: false } }, base)
  assert.deepEqual(r.toolCalls, [])
  assert.match(r.reply, /Cancelado\. No se creó la OC de sol-006/)
  assert.equal(r.needsConfirmation, false)
})

await prueba("dos pendientes: 'confirmo' sin caso pregunta cuál; con caso o botón crea solo ese", async () => {
  const s = new AlmacenSesiones().obtener("dos-casos")
  const deps = { ...base, llm: new MockAdapter() }
  await procesarTurno(s, { message: "procesa sol-005" }, deps)
  await procesarTurno(s, { message: "procesa sol-006" }, deps)
  assert.deepEqual([...s.pendientes.keys()].sort(), ["sol-005", "sol-006"])

  const ambiguo = await procesarTurno(s, { message: "confirmo" }, deps)
  assert.deepEqual(ambiguo.toolCalls, [])
  assert.match(ambiguo.reply, /varias OC pendientes.*sol-005.*sol-006.*¿Cuál confirmas\?/s)
  assert.equal(ambiguo.needsConfirmation, true)

  const texto = await procesarTurno(s, { message: "Confirmo sol-005" }, deps)
  assert.deepEqual(nombres(texto), ["oc_crear:ok"])
  assert.match(texto.reply, /creada para sol-005/)
  assert.deepEqual([...s.pendientes.keys()], ["sol-006"])

  const boton = await procesarTurno(s, { confirm: { caso: "sol-006", valor: true } }, deps)
  assert.deepEqual(nombres(boton), ["oc_crear:ok"])
  assert.match(boton.reply, /creada para sol-006/)
  assert.equal(boton.needsConfirmation, false)
})

await prueba("botón Confirmar de un caso sin pendiente: el servidor lo indica sin crear nada", async () => {
  const s = new AlmacenSesiones().obtener("sin-pendiente")
  await procesarTurno(s, { message: "procesa sol-006" }, { ...base, llm: new MockAdapter() })
  const r = await procesarTurno(s, { confirm: { caso: "sol-004", valor: true } }, base)
  assert.deepEqual(r.toolCalls, [])
  assert.match(r.reply, /No hay una OC pendiente de confirmación para sol-004/)
  assert.deepEqual([...s.pendientes.keys()], ["sol-006"])
})

await prueba("caso bloqueado: registra el intento sin payload", async () => {
  const r = await procesarTurno(new AlmacenSesiones().obtener("bloq"), { message: "procesa sol-002" }, { ...base, llm: new MockAdapter() })
  assert.deepEqual(nombres(r), ["oc_leer_paquete:ok", "oc_validar:ok", "oc_crear:err"])
  assert.match(r.reply, /RC1/)
  assert.equal(r.needsConfirmation, false)
})

await prueba("tope de iteraciones: responde con lo que tiene y lo que falta", async () => {
  const r = await procesarTurno(new AlmacenSesiones().obtener("tope"), { message: "procesa sol-001" }, { ...base, llm: new MockAdapter(), maxIter: 2 })
  assert.match(r.reply, /Se alcanzó el tope de 2 pasos/)
  assert.equal(r.toolCalls.length, 2)
})

await prueba("error del proveedor: mensaje claro y la sesión sigue viva", async () => {
  const roto: LlmAdapter = { proveedor: "x", modelo: "x", enviar: () => Promise.reject(new ErrorLlm("Límite del modelo alcanzado, intenta en un minuto.")) }
  const s = new AlmacenSesiones().obtener("error")
  assert.equal((await procesarTurno(s, { message: "hola" }, { ...base, llm: roto })).reply, "Límite del modelo alcanzado, intenta en un minuto.")
  const r = await procesarTurno(s, { message: "procesa sol-001" }, { ...base, llm: new MockAdapter() })
  assert.match(r.reply, /OC \d+ creada para sol-001/)
})

await rm(join(directory, "out"), { recursive: true, force: true })
console.log(fallos === 0 ? "\nTodas las pruebas pasaron." : `\n${fallos} prueba(s) fallaron.`)
process.exit(fallos === 0 ? 0 : 1)
