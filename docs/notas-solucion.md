# Notas para SOLUCION.md

Apuntes tomados durante el desarrollo. Se consolidan en `SOLUCION.md` (sección 4, *Elección del modelo y costo por caso*).

## Costo por caso: medición en vivo

- **Modelo:** `claude-sonnet-5-5` (Anthropic), con `effort: "medium"`.
- **Precios (USD por millón de tokens):** entrada 2,00 · salida 10,00 · escritura de caché (5 min) 2,50 · lectura de caché 0,20.
- **Escenario:** sesión nueva con "Procesa la solicitud sol-004 … no la crees hasta que lo confirme" y luego "confirmo". Son 6 llamadas al modelo y termina con la OC creada.
- **Fuente:** el desglose de `usage` de cada respuesta, registrado en el log del servidor. La suma coincide con `tokens` de `GET /api/sessions/:id`.

### sol-004: procesar y confirmar

| Medición | Entrada | Salida | Escritura caché | Lectura caché | **Total tokens** | **Costo USD** |
|---|---:|---:|---:|---:|---:|---:|
| v1 (2026-10-14, commit `8f2bf28`) | 16 | 3 478 | 12 908 | 50 263 | **66 665** | **≈ 0,077** |
| v2 (2026-10-14, este commit) | 16 | 1 571 | 11 043 | 45 748 | **58 378** | **≈ 0,053** |
| Variación | — | −55 % | −14 % | −9 % | −12 % | **−32 %** |

- **v1:** el modelo reenviaba el `paquete` completo (y los `derivados`) como argumento de `oc_validar` y `oc_construir_payload`. Esos son tokens de salida, los más caros. La configuración incluía `fallbacks: "default"`.
- **v2:**
  - El modelo pasa solo `caso`. Las herramientas leen el paquete de `out/<caso>/paquete.json`.
  - La caché es fija sobre el prompt de sistema y las herramientas.
  - Se quitó `fallbacks`.
  - Es una sesión **en frío**: el prompt y los esquemas cambiaron, así que la primera llamada tuvo que escribir de nuevo los ~7,9 K tokens del prefijo.

### sol-006: procesar y cancelar con "no"

Muestra la reutilización de la caché entre sesiones.

| Medición | Entrada | Salida | Escritura caché | Lectura caché | **Total tokens** | **Costo USD** |
|---|---:|---:|---:|---:|---:|---:|
| v1 | 10 | 2 726 | 11 889 | 26 385 | **41 010** | **≈ 0,062** |
| v2 | 10 | 748 | 2 139 | 33 332 | **36 229** | **≈ 0,020** |
| Variación | — | −73 % | −82 % | +26 % | −12 % | **−69 %** |

- **Primera llamada de la sesión v2:** escribió 84 tokens en caché y leyó 7 737. El prefijo de herramientas + sistema venía de la sesión anterior.
- **La cancelación ("no")** no consume tokens: la resuelve el servidor sin llamar al modelo.

### Lectura

- **Costo por caso:** un caso con confirmación cuesta **≈ USD 0,05** en frío. Con la caché caliente, es decir, con otra sesión en los últimos 5 minutos, el estimado es **≈ USD 0,035**. Este último valor no está medido: se obtiene restando a sol-004 v2 la escritura del prefijo (≈ 7,9 K × 2,50) y sumándole su lectura (× 0,20).
- **Dónde se va el costo:** la mayor parte está en la escritura de caché del historial que crece en cada iteración y en el texto final del modelo (la tabla de la OC). El resto es pequeño.
- **Topes:** `MAX_ITER` (25 por defecto) y `MAX_TOKENS_SESION` (200 000 por defecto) limitan el gasto por turno y por sesión. Con 200 K tokens caben unos 3 casos por sesión.

## Decisiones relacionadas con el costo

- **Paquete opcional:** el modelo solo pasa `caso`. Si envía un paquete o unos derivados distintos de los guardados, se usan los de disco y la herramienta devuelve `advertencias`. Así, los valores nunca salen del modelo.
- **`fallbacks` quitado:** sin él, el modelo y el costo son predecibles. Un rechazo de seguridad (`stop_reason: "refusal"`) se muestra a la analista como error claro, sin reintentar en otro modelo.
- **Caché en dos puntos:** fija sobre herramientas + sistema (se reutiliza entre sesiones) y móvil al final del historial (se reutiliza entre iteraciones del mismo turno).
