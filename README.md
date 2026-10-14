# reto-03-mosquera — Agente "Órdenes de Compra SAP"

Agente conversacional que lee el paquete de una compra, lo valida contra los maestros (RC1–RC10), construye el payload de la OC, genera la evidencia de aprobación y crea la OC en un SAP simulado, con confirmación humana controlada por el servidor. Planteamiento completo en [SOLUCION.md](SOLUCION.md).

## Link de prueba

**Pendiente de despliegue.** El link es público, sin clave de acceso.

## Requisitos

- [Bun](https://bun.sh) (probado con 1.4.3).

## Levantar en local (un comando)

```bash
bun install
cp .env.example .env   # y completa las variables
bun run dev            # front + backend en http://localhost:3000
```

Para probar sin clave de ningún proveedor, usa `LLM_PROVIDER=mock` en `.env`.

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `LLM_PROVIDER` | Sí | `anthropic` (recomendado) · `gemini` · `mock` (agente simulado, sin clave). |
| `LLM_MODEL` | Sí, salvo `mock` | Modelo; por ejemplo, `claude-sonnet-5-5`. No hay valor por defecto en el código. |
| `ANTHROPIC_API_KEY` | Si `LLM_PROVIDER=anthropic` | Clave de Anthropic. Solo en el backend. |
| `GEMINI_API_KEY` | Si `LLM_PROVIDER=gemini` | Clave de Google AI Studio. Solo en el backend. |
| `MAX_ITER` | No | Tope de iteraciones herramienta → modelo por turno (25). |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (200 000). |
| `PORT` | No | Puerto HTTP (3000). |

Las claves nunca se envían al front ni se escriben en logs o respuestas.

## Verificación sin modelo

```bash
bun run demo.ts
```

Limpia `out/` y procesa los 6 casos llamando directamente a las herramientas. Imprime, por caso, `apta`, bloqueos, confirmaciones, `retroactiva` y número de OC o motivo. También muestra la idempotencia (`sol-001` dos veces), la confirmación explícita de `sol-004` y el contenido de `out/control.csv`. No necesita clave.

Otros scripts:

| Comando | Qué hace |
|---|---|
| `bun run test` | Escenarios del agente con el LLM simulado: guion de sol-004, cancelación, varios pendientes, modelo que intenta crear sin permiso, topes y errores. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run start` | Servidor sin *watch*. |

## API

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message?, confirm?: { caso, valor } }` → `{ reply, toolCalls[], needsConfirmation, pendientes[] }`. `confirm` es el botón Confirmar/Cancelar de un caso. Devuelve 409 si la sesión ya está procesando un mensaje. |
| `GET` | `/api/sessions/:id` | `{ sessionId, tokens, pendientes, historial }` |
| `GET` | `/api/health` | `{ ok: true, provider, model }` |

## Prueba sugerida

En una sesión nueva:

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

Luego responde `confirmo` o pulsa **Confirmar**.

## Salidas (`out/`)

| Archivo | Contenido |
|---|---|
| `out/<caso>/paquete.json` | Paquete normalizado del caso. |
| `out/<caso>/aprobacion.txt` | Evidencia de aprobación con su sha256. |
| `out/sap/ordenes.jsonl` | OC creadas en el SAP simulado. |
| `out/control.csv` | Log de control: creadas, bloqueadas, pendientes, idempotentes y retroactivas. |
| `out/log.jsonl` | Todas las llamadas a herramientas. |
