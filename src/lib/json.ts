// Comparación de valores JSON sin depender del orden de las claves.

function canonico(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonico)
  if (typeof valor !== "object" || valor === null) return valor
  const entradas = Object.entries(valor).filter(([, v]) => v !== undefined)
  return Object.fromEntries(entradas.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonico(v)]))
}

export function igualesJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonico(a)) === JSON.stringify(canonico(b))
}
