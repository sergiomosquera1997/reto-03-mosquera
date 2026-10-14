// Red de seguridad: ningún texto que salga del servidor puede contener una clave de proveedor.

export const VARIABLES_SECRETAS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const

/** Las claves muy cortas se ignoran para no tapar texto legítimo por accidente. */
const LONGITUD_MINIMA = 8

export function ocultarSecretos(texto: string, env: Record<string, string | undefined> = process.env): string {
  return VARIABLES_SECRETAS.map((nombre) => env[nombre]?.trim() ?? "")
    .filter((clave) => clave.length >= LONGITUD_MINIMA)
    .reduce((acumulado, clave) => acumulado.replaceAll(clave, "***"), texto)
}
