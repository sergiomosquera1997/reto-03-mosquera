// Único helper de evidencia: lo usan generar_evidencia y construir_payload,
// así el sha256 del payload no depende del orden en que se llamen.
import { createHash } from "node:crypto"
import type { AprobacionRaw } from "../schemas.ts"

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

/** El sha256 se calcula sobre `texto` (encabezados + cuerpo); el archivo añade la línea del hash al final. */
export function renderizarEvidencia(a: AprobacionRaw): { texto: string; sha256: string; archivo: string } {
  const texto = [
    `De: ${a.de}`,
    `Para: ${a.para}`,
    ...(a.cc && a.cc.length > 0 ? [`CC: ${a.cc.join(", ")}`] : []),
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
    "",
  ].join("\n")
  const hash = sha256(texto)
  return { texto, sha256: hash, archivo: `${texto}\n---\nSHA-256 (contenido anterior): ${hash}\n` }
}
