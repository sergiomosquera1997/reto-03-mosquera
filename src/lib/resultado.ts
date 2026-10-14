// Contrato 6.2: execute devuelve SIEMPRE un string JSON y nunca lanza.

export class ErrorNegocio extends Error {}

export function ok<T>(data: T): string {
  return JSON.stringify({ ok: true, data })
}

export function fallo(error: string, data?: unknown): string {
  return JSON.stringify(data === undefined ? { ok: false, error } : { ok: false, error, data })
}

export function mensajeDeError(e: unknown): string {
  if (e instanceof ErrorNegocio) return e.message
  if (e instanceof Error) return `Error inesperado: ${e.message}`
  return "Error inesperado sin detalle."
}

export async function envolver(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    return fallo(mensajeDeError(e))
  }
}
