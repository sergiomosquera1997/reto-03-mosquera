# SOLUCIÓN — Reto 03 · Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

La analista administrativa digita a mano en SAP cada OC a partir de un correo con la solicitud, la cotización y la aprobación del líder. Valida de memoria que el aprobador puede aprobar ese monto en ese centro de costo, y nadie mide cuántas OC se crean después de la factura. **Les duele a** la analista (tiempo y errores), a Contabilidad (correcciones en cierre) y a la dirección (no ve el desvío de proceso).

## 2. Arquitectura

```
┌─────────────── web/ (HTML + JS, sin build) ───────────────┐
│ historial · tool calls (nombre, args, resumen) · botones  │
│ Confirmar / Cancelar por caso · indicador "pensando"      │
└──────────────────────────┬────────────────────────────────┘
                           │ POST /api/chat · GET /api/sessions/:id · GET /api/health
┌──────────────────────────▼────────────────────────────────┐
│ src/server.ts (Bun.serve)                                 │
│  └─ src/agent/loop.ts        ciclo modelo → herramientas  │
│      ├─ src/agent/confirmacion.ts  CA3 en el servidor     │
│      ├─ src/agent/sesiones.ts      sesiones en memoria    │
│      └─ src/llm/adapter.ts    LlmAdapter                  │
│          ├─ anthropic.ts  ├─ gemini.ts  └─ mock.ts        │
└──────────────────────────┬────────────────────────────────┘
                           │ execute(args, ctx) → JSON { ok, data | error }
┌──────────────────────────▼────────────────────────────────┐
│ src/tools/oc.ts   oc_leer_paquete · oc_validar ·          │
│                   oc_construir_payload ·                  │
│                   oc_generar_evidencia · oc_crear         │
│  └─ src/lib/ (reglas RC1–RC10, parsers, payload, control) │
│  └─ src/sap/  SapAdapter + mock sobre archivos            │
└───────────┬───────────────────────────────┬───────────────┘
            ▼                               ▼
   fixtures/ (solo lectura)       out/ (paquete.json por caso, evidencia,
                                        sap/ordenes.jsonl, control.csv, log.jsonl)
```

| Qué | Dónde |
|---|---|
| Comportamiento (flujo, estilo, regla de oro) | `agent/prompt.md` |
| Conocimiento (proceso, RC1–RC10 en lenguaje de negocio, acciones sugeridas) | `src/knowledge/ordenes-compra.md` |
| Ejecución (herramientas tipadas con zod, funciones puras) | `src/tools/oc.ts` + `src/lib/` |

El servidor concatena prompt y conocimiento al arrancar. Un cambio en las reglas de negocio toca `src/lib/reglas.ts` y el Markdown de conocimiento, no el servidor.

## 3. Ciclo del agente

- **Bucle** (`src/agent/loop.ts`): envía el historial al `LlmAdapter`. Si la respuesta trae llamadas a herramientas, valida los argumentos con zod, las ejecuta, añade los resultados y repite. Termina cuando el modelo responde solo con texto.
- **Topes:** `MAX_ITER` (25 por turno) y `MAX_TOKENS_SESION` (200 000). Si se alcanza el de iteraciones, el servidor hace una última llamada **sin herramientas** para que el modelo resuma qué tiene y qué falta. Si se alcanza el de tokens, o esa llamada falla, el servidor arma un resumen determinista con los resultados de las herramientas.
- **Trazabilidad (CA4):** cada llamada se devuelve en `toolCalls` (args abreviados y resumen) y se registra en `out/log.jsonl`.
- **Errores (CA5):** errores de herramienta vuelven al modelo como `{ ok:false, error }`. Errores del proveedor (timeout de 60 s, 429, 5xx tras reintentos) se muestran como texto claro y la sesión sigue viva.
- **Confirmación humana (CA3), controlada por el servidor** (`src/agent/confirmacion.ts`), no por el prompt:
  - Cuando `oc_validar` devuelve confirmaciones, el servidor registra un **pendiente por caso** con el número del mensaje del usuario.
  - `oc_crear` con `confirmado: true` **se rechaza en el servidor** si no hay pendiente para ese caso, o si el mensaje del usuario posterior al pendiente no es una confirmación explícita para ese caso.
  - Confirmación explícita: el botón (`confirm: { caso, valor }`) o un texto en que **todas** las palabras son afirmativas ("Sí, confirmo", "confirmo sol-004"). "Sí, pero cambia el IVA" no confirma.
  - "no"/"cancelar" lo resuelve el servidor **sin llamar al modelo** (0 tokens). "confirmo" con varios pendientes y sin caso: el servidor pregunta cuál.
  - El front resalta el estado con `needsConfirmation` y `pendientes[]`.
  - `scripts/test-agente.ts` incluye un mock "desobediente" que intenta crear sin permiso; el servidor lo bloquea.

## 4. Elección del modelo y costo por caso

- **Proveedor y modelo:** Anthropic, `claude-sonnet-5-5`, `effort: "medium"`.
- **Por qué:**
  - Empecé con **Gemini** en el plan gratuito. En las pruebas en vivo respondía con **503 UNAVAILABLE y 429 RESOURCE_EXHAUSTED** de forma intermitente; ni con reintentos (respetando `retryDelay`) se podía completar un caso de forma fiable para una demo.
  - Sonnet 5.5 hace bien el uso de herramientas en varios pasos, sigue la regla de no afirmar valores y permite **caché de prompt** explícita, lo que baja el costo.
  - Gracias al adaptador, el cambio no tocó el ciclo: `LLM_PROVIDER=anthropic|gemini|mock`.
- **Costo medido** (precios USD/MTok: entrada 2,00 · salida 10,00 · escritura caché 2,50 · lectura caché 0,20; fuente: `usage` de cada respuesta, que coincide con `tokens` de `GET /api/sessions/:id`):

| Escenario | v1 | v2 | Variación |
|---|---:|---:|---:|
| sol-004 procesar + "confirmo" (6 llamadas, caché fría) | 66 665 tok · **USD 0,077** | 58 378 tok · **USD 0,053** | −32 % |
| sol-006 procesar + "no" (caché caliente) | 41 010 tok · **USD 0,062** | 36 229 tok · **USD 0,020** | −69 % |

- **Qué cambió de v1 a v2:**
  1. **Paquete opcional:** el modelo pasa solo `caso`; las herramientas leen `out/<caso>/paquete.json`. Así dejó de reenviar el paquete como argumento, que eran tokens de salida (los más caros): −55 % de salida en sol-004.
  2. **Caché fija** sobre herramientas + sistema (reutilizable entre sesiones), además de la caché móvil del historial.
  3. **Sin `fallbacks`**, para que el modelo y el costo sean predecibles.
- **Estimado:** **≈ USD 0,05 por caso en frío** y **≈ USD 0,035 con caché caliente**. Este último es un cálculo, no una medición. Con el tope de 200 K tokens caben unos 3 casos por sesión.

## 5. Matriz de controles

Las reglas son funciones puras `(paquete, maestros) → hallazgos[]` en `src/lib/reglas.ts`. `evaluarReglas` las agrega en `{ apta, bloqueos, confirmaciones, derivados, retroactiva }`.

| Regla | Implementación | Tipo |
|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni DV); si no hay NIT, por nombre normalizado (sin tildes, sin S.A.S./S.A.). Exige `activo`. | Bloqueo |
| RC2 | Exige aprobación con "aprobado" como palabra completa, no negada ni acompañada de "rechazado" (`esAprobado` en `src/tools/oc.ts`), y remitente listado **en el centro de costo de la solicitud**. | Bloqueo |
| RC3 | Compara `valor_total` con el tope del aprobador **en ese centro**. Solo se evalúa si RC2 encontró al aprobador allí. | Bloqueo |
| RC4 | `subarea ∈ centro.subareas`. | Bloqueo |
| RC5 | `abs(cot − sol) / sol ≤ 2 %`; devuelve ambos valores y el %. Sin cotización: confirmación. | Confirmación |
| RC6 | IVA ausente → `indicador_iva_default` del proveedor, validado contra el maestro de IVA. | Derivado + confirmación |
| RC7 | Condiciones ausentes → default del proveedor. | Derivado |
| RC8 | `factura.fecha < fecha_solicitud` → `retroactiva: true`; queda en `out/control.csv`. | Confirmación |
| RC9 | Fecha de aprobación ≥ solicitud, comparando el **día calendario escrito** (ignora hora y zona). | Confirmación |
| RC10 | `abs(cantidad × valor_unitario − valor_total) ≤ 1`. | Bloqueo |

Resultado de `bun run demo.ts`: sol-001 se crea (y es idempotente en la segunda ejecución), sol-002 queda bloqueada por RC1, sol-003 por RC2, sol-004 se crea tras confirmar RC5, sol-005 tras confirmar RC8 (retroactiva) y sol-006 tras confirmar RC6.

**La más difícil: RC2/RC3 en sol-003.** El correo de `fvargas@` dice "Aprobado" y el monto (74 M) está por debajo de su tope (80 M), así que una búsqueda global del aprobador lo **aprobaría**. Pero ese tope es en **CC-3030 (Comercial)** y la solicitud es de **CC-2020 (Administración)**, donde el único aprobador es `rtorres@` con tope de 30 M. La trampa es aplicar el tope de otro centro de costo. Por eso la búsqueda del aprobador se hace siempre dentro del centro de la solicitud. RC2 bloquea e indica los aprobadores válidos, y RC3 no se evalúa con un tope ajeno.

## 6. Diseño del adaptador SAP real

- **Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV`** (S/4HANA), expuesto a través de **SAP Integration Suite / API Management** si la empresa ya lo tiene.
  - Es la API estándar y publicada para crear OC, usa REST/JSON (encaja con TypeScript sin conectores nativos) y deja la validación final en SAP.
  - **Alternativa:** `BAPI_PO_CREATE1` por RFC si el sistema es ECC. Requiere SAP NW RFC SDK y un middleware, por eso queda en segundo lugar.
- **Mapeo del payload 7.4:**
  - `sociedad` → `CompanyCode`
  - `organizacion_compras` → `PurchasingOrganization` (más `PurchasingGroup` por configuración)
  - `proveedor.codigo_sap` → `Supplier`
  - `moneda` → `DocumentCurrency`
  - `condiciones_pago` → `PaymentTerms`
  - `posiciones[]` → `to_PurchaseOrderItem`: `numero` → `PurchaseOrderItem`, `descripcion` → `PurchaseOrderItemText`, `cantidad` → `OrderQuantity`, `unidad` → `PurchaseOrderQuantityUnit`, `precio_unitario` → `NetPriceAmount`, `indicador_iva` → `TaxCode`
  - Centro de costo y subárea → `to_AccountAssignment` (`CostCenter`; la subárea, según configuración, como `WBSElement` o campo Z)
  - `referencia.solicitud_id` → texto de cabecera o campo de referencia del cliente
  - La evidencia de aprobación se adjunta con `API_CV_ATTACHMENT_SRV`.
- **Autenticación:** OAuth 2.0 *client credentials* (o certificado X.509) hacia un **usuario técnico** con rol limitado a crear OC. Las credenciales viven en un gestor de secretos (Azure Key Vault o equivalente), se inyectan solo en el adaptador del backend y **nunca** llegan al agente, al prompt ni al front.
- **Idempotencia:**
  - Antes de crear: `buscarOrdenPorReferencia(solicitud_id)`, igual que el mock.
  - Clave de idempotencia por `solicitud_id` en una tabla propia.
  - Ante un timeout, **no se reintenta a ciegas**: primero se consulta por referencia.
- **Error parcial** (cabecera creada sin posiciones, o OC creada sin adjunto): se registra el estado en `control.csv`, no se crea otra OC y se reintenta solo el paso faltante (adjunto o posición). Si SAP devuelve mensajes de negocio (por ejemplo, el período está cerrado), se devuelven a la analista como bloqueo.
- **Plan B si no hay conexión:** el agente sigue ahorrando el 100 % de la validación y la preparación.
  1. Una OC "lista para pegar" (tabla en el orden de los campos de ME21N).
  2. Un **archivo de carga masiva** (CSV para LSMW o *Migration Cockpit*) con las OC aprobadas del día.
  3. La evidencia y su sha256 para adjuntar.

  El mock (`SapAdapter` sobre `out/sap/`) ya modela ese contrato.

## 7. Lectura del proceso (para la dirección)

Con el agente, cada OC retroactiva queda marcada (`retroactiva: true` en `out/control.csv`, con número y fecha de factura). Por primera vez se puede **medir** el porcentaje de OC creadas después de la factura, por centro de costo y por proveedor. En los fixtures, 1 de 6 casos (sol-005: factura del 10/08, solicitud del 27/08).

Una OC retroactiva significa que se compró sin cotización comparada ni aprobación previa. El control de gasto existe en el papel pero no en la práctica: se aprueba algo que ya se compró.

**Propuesta:**
1. Publicar mensualmente el indicador de retroactividad por centro de costo y por aprobador.
2. Definir una política explícita: tolerarla con justificación obligatoria por debajo de un umbral, y por encima exigir aprobación del nivel superior.
3. Mover la solicitud al inicio: que el agente reciba la solicitud **antes** de la compra y entregue la OC al proveedor como condición para facturar ("sin OC no hay pago"). Así la factura deja de ser el disparador.

La decisión de tolerar o rechazar es de la dirección; el agente ya entrega el dato.

## 8. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| **Confirmación CA3 en el servidor** (pendiente por caso, `oc_crear` rechazado sin confirmación explícita posterior) | Confiar en que el prompt haga preguntar al modelo | Un prompt no es un control. El servidor garantiza que un modelo que "se adelante" no crea la OC; el mock desobediente lo prueba. |
| **Paquete opcional en `oc_validar` y `oc_construir_payload`** (se lee de `out/<caso>/paquete.json`; si el modelo envía otro, se ignora con `advertencias`) | Contrato literal 6.2: el modelo reenvía el paquete | El reenvío costaba tokens de salida (−32 % de costo al quitarlo) y permitía que el modelo transcribiera mal un monto. Los valores nunca salen del modelo. Se respeta la firma: el argumento sigue existiendo. |
| **`oc_crear` reconstruye y compara el payload**; si un campo protegido difiere, se niega | Aceptar el payload que envía el modelo | Mitiga el riesgo de que el modelo "arregle" un monto. |
| **Adaptador LLM neutro con esquemas en zod** convertidos por cada proveedor | Acoplar el ciclo al SDK de un proveedor | Permitió pasar de Gemini a Anthropic sin tocar el ciclo, y tener `mock` para pruebas y demo sin clave. |
| **Sin `fallbacks` de Anthropic** | Reintentar automáticamente en otro modelo ante un rechazo de seguridad | Costo y comportamiento predecibles; un `refusal` se muestra como error claro. |
| **Front HTML plano servido por Bun**, sin build | React/Vite | Un solo comando y un solo proceso; con CSP estricta. |
| **Evidencia en `.txt` con sha256** | PDF (P1) | El P0 es txt. El hash se calcula sobre el contenido y se usa en el payload. |

## 9. Supuestos

1. **Valor de la OC:** el de la solicitud, no el de la cotización. La diferencia se confirma (RC5), no se corrige.
2. **Fechas:** se compara el **día calendario escrito** en el documento (se ignoran hora y zona). Así, una aprobación del mismo día no parece anterior por el desfase horario.
3. **NIT:** se compara sin puntos ni dígito de verificación (`900.555.111-2` ≡ `900555111`). La búsqueda por nombre normalizado aplica solo si la solicitud no trae NIT.
4. **RC2/RC3:** un aprobador solo es válido en el centro de costo donde aparece listado; su tope en otro centro no cuenta.
5. **"Aprobado":** la aprobación es válida si el cuerpo contiene "aprobado" como palabra completa (sin distinguir mayúsculas ni tildes). No vale si está negada ("no aprobado", "no se aprueba", "no queda aprobado": "no" seguido de hasta dos palabras y "aprob…") ni si el cuerpo dice "rechazado".
6. **Unidad:** `UN` por defecto; `H` si la descripción menciona horas; `MES` solo con "mensual" o "por mes". "Vigencia 12 meses" es la duración de una licencia, no la unidad.
7. **Descripción:** se recorta a 40 caracteres en el último espacio, sin partir palabras.
8. **Fuentes de trazabilidad:** además de las del PRD, se añaden `aprobacion` y `correo`, porque el email, la fecha de aprobación y `correo_id` salen de ahí.
9. **Intentos bloqueados:** también se registran en `control.csv` (`oc_crear` sin payload), para medir rechazos.
10. **Idempotencia:** por `solicitud_id`. Crear dos veces devuelve la OC existente con `idempotente: true`.
11. **Sesiones en memoria:** se pierden al reiniciar; las OC creadas y el control persisten en `out/`.

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Leer `.xlsx` y PDF reales (`oc_leer_excel` P1 no hecho). |
| HU-2 Validar RC1–RC10 | Hecho | Maestros consultados en SAP en tiempo real. |
| HU-3 Construir payload + trazabilidad | Hecho | Mapeo OData real (sección 6). |
| HU-4 Evidencia de aprobación | Parcial: `.txt` + sha256 | PDF (P1) y, si Auditoría lo exige, firma digital. |
| HU-5 Crear OC en SAP simulado, idempotente, con log de control | Hecho | Adaptador OData real. |
| HU-6 Manejo de errores | Hecho | Alertas y monitoreo. |
| Front, API, CA1–CA5 | Hecho | Autenticación de usuarios, sesiones persistentes. |
| `demo.ts` sin modelo | Hecho | — |
| Despliegue público | **Pendiente** | Ver README. |
| Bonus `modulo/` | No hecho | — |

Verificación: `bun run demo.ts` (6 casos, idempotencia, confirmación), `bun run test` (13 escenarios: agente con el mock y detección de la aprobación) y `bun run typecheck`.

## 11. Uso de IA

| Asistente | Para qué |
|---|---|
| **Claude Code** (Opus 5.5, en VS Code) | Plan de implementación a partir del PRD (con `CLAUDE.md` exigiendo plan y aprobación antes de cada paso); generación del núcleo (schemas zod, reglas, parsers, herramientas, SAP mock), `demo.ts`, ciclo del agente, adaptadores Gemini/Anthropic/mock, servidor, front y pruebas; mediciones de costo y mensajes de commit. |
| **Claude** (chat) | Revisar el PRD y redactar las instrucciones que le pasaba a Claude Code; revisar sus propuestas; decidir trade-offs (paquete opcional, CA3 en servidor, cambio de proveedor). |

**Qué se corrigió o descartó:**
- **Regex rota:** en `src/llm/gemini.ts`, una regex para leer el error del proveedor se generó con `s*` en lugar de `\s*` (se había perdido la barra invertida), así que no coincidía con el JSON real del error. Lo detecté, pedí verificar las tres regex del archivo y se corrigieron.
- **Filtro de confirmación:** la primera versión de CA3 solo exigía *un mensaje nuevo* del usuario, sin mirar qué decía: un "no" dejaba la decisión al modelo. Luego se propuso una lista cerrada de frases exactas, con la que "SÍ, CONFIRMO" no confirmaba. Quedó así: se normaliza el texto y confirma solo si **todas** las palabras son afirmativas (más un caso opcional). "Sí, pero cambia el IVA" no confirma, y la cancelación la resuelve el servidor.
- **Descartado:**
  - El reenvío del paquete completo por el modelo (contrato literal), por costo y fragilidad.
  - `fallbacks: "default"` de Anthropic, que se había incluido al principio, por imprevisibilidad.
  - Insistir con Gemini gratis, por su inestabilidad.

Cada línea entregada fue revisada y puedo explicarla.

## 12. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| La conexión a SAP no es viable a corto plazo | Plan B (sección 6): OC lista para pegar y archivo de carga masiva. |
| El modelo altera un monto o crea sin permiso | Los valores salen de las herramientas, `oc_crear` reconstruye y compara el payload, y CA3 está en el servidor. |
| Aprobación en texto libre mal interpretada | **Corregido:** la detección ingenua (`/aprobado/i`) aceptaba "No aprobado". Ahora exige la palabra completa, rechaza negaciones y "rechazado", con pruebas en `scripts/test-agente.ts`. Queda el riesgo de redacciones no previstas ("aprobado con reparos"); en producción, un flujo de aprobación formal (botón o firma) en lugar de texto libre. |
| Maestros desactualizados (fixtures estáticos) | Consultar proveedor y aprobadores en SAP en línea (`consultarProveedor`). |
| Clave de API expuesta | La clave solo vive en variables del backend y los errores se filtran antes de responder. El filtro `sinSecretos` de `server.ts` hoy cubre `GEMINI_API_KEY`; hay que extenderlo a `ANTHROPIC_API_KEY`. |
| Gasto descontrolado | `MAX_ITER`, `MAX_TOKENS_SESION`, una sesión ocupada no acepta mensajes concurrentes (409). Falta: límite por IP o usuario y autenticación del link. |
| Sesiones en memoria y un solo proceso | Persistir sesiones (Redis o archivo) para escalar horizontalmente. |
| Disponibilidad del proveedor LLM | Reintentos con *backoff* y timeout de 60 s; adaptador intercambiable (Gemini como respaldo). |
| Evidencia insuficiente para Auditoría | PDF con firma o sello de tiempo; conservar el `.eml` original. |
