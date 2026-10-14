// API HTTP del agente (PRD 6.4). Uso: bun run dev
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { procesarTurno, type Dependencias } from "./agent/loop.ts"
import { AlmacenSesiones } from "./agent/sesiones.ts"
import { ocultarSecretos } from "./lib/secretos.ts"
import { crearAdaptador } from "./llm/index.ts"

const directory = join(import.meta.dirname, "..")

function entero(nombre: string, porDefecto: number): number {
  const valor = Number(process.env[nombre])
  return Number.isInteger(valor) && valor > 0 ? valor : porDefecto
}


function json(cuerpo: unknown, status = 200): Response {
  return new Response(ocultarSecretos(JSON.stringify(cuerpo)), { status, headers: { "content-type": "application/json; charset=utf-8" } })
}

async function cargarSistema(): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(join(directory, "agent", "prompt.md"), "utf8"),
    readFile(join(directory, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return `${prompt}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`
}

// ── Front estático (web/), sin build ────────────────────────────────────────
const ESTATICOS: Record<string, { archivo: string; tipo: string }> = {
  "/": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/app.js": { archivo: "app.js", tipo: "text/javascript; charset=utf-8" },
  "/markdown.js": { archivo: "markdown.js", tipo: "text/javascript; charset=utf-8" },
  "/styles.css": { archivo: "styles.css", tipo: "text/css; charset=utf-8" },
}

const CABECERAS_SEGURIDAD = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
}

function estatico(ruta: string): Response {
  const { archivo, tipo } = ESTATICOS[ruta] ?? { archivo: "index.html", tipo: "text/html; charset=utf-8" }
  return new Response(Bun.file(join(directory, "web", archivo)), {
    headers: { "content-type": tipo, "cache-control": "no-cache", ...CABECERAS_SEGURIDAD },
  })
}

const rutasEstaticas = Object.fromEntries(Object.keys(ESTATICOS).map((ruta) => [ruta, { GET: () => estatico(ruta) }]))

const ChatSchema = z
  .object({
    sessionId: z.string().regex(/^[\w-]{1,100}$/, "sessionId: solo letras, dígitos, _ y -, máx. 100"),
    message: z.string().max(4000).optional(),
    confirm: z
      .object({ caso: z.string().regex(/^[a-z0-9-]{1,40}$/, "confirm.caso inválido"), valor: z.boolean() })
      .optional(),
  })
  .refine((b) => (b.message?.trim() ?? "") !== "" || b.confirm !== undefined, "Envía message o confirm.")

const deps: Dependencias = {
  llm: crearAdaptador(),
  directory,
  sistema: await cargarSistema(),
  maxIter: entero("MAX_ITER", 25),
  maxTokensSesion: entero("MAX_TOKENS_SESION", 200_000),
}
const sesiones = new AlmacenSesiones()

async function chat(req: Request): Promise<Response> {
  const cuerpo = ChatSchema.safeParse(await req.json().catch(() => null))
  if (!cuerpo.success) return json({ error: cuerpo.error.issues.map((i) => i.message).join("; ") }, 400)
  const { sessionId, message, confirm } = cuerpo.data
  const sesion = sesiones.obtener(sessionId)
  if (sesion.ocupada) return json({ error: "La sesión está procesando otro mensaje; espera la respuesta." }, 409)
  sesion.ocupada = true
  try {
    return json(await procesarTurno(sesion, { ...(message ? { message } : {}), ...(confirm !== undefined ? { confirm } : {}) }, deps))
  } finally {
    sesion.ocupada = false
  }
}

function historial(id: string): Response {
  const sesion = sesiones.buscar(id)
  if (!sesion) return json({ error: `No existe la sesión ${id}.` }, 404)
  return json({ sessionId: sesion.id, tokens: sesion.tokens, pendientes: [...sesion.pendientes.values()], historial: sesion.historial })
}

const servidor = Bun.serve({
  // 0.0.0.0 para que el contenedor (Render, Docker) acepte conexiones externas.
  hostname: "0.0.0.0",
  port: entero("PORT", 3000),
  routes: {
    ...rutasEstaticas,
    "/api/health": { GET: () => json({ ok: true, provider: deps.llm.proveedor, model: deps.llm.modelo }) },
    "/api/chat": { POST: chat },
    "/api/sessions/:id": { GET: (req) => historial(req.params.id) },
  },
  fetch: () => json({ error: "Ruta no encontrada." }, 404),
  error: (e) => json({ error: ocultarSecretos(`Error interno: ${e.message}`) }, 500),
})

console.log(`Agente OC escuchando en http://localhost:${servidor.port} (${deps.llm.proveedor} · ${deps.llm.modelo})`)
