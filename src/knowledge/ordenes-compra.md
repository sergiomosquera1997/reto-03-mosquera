# Proceso de órdenes de compra (OC)

## Cómo llega una compra
Cada compra llega a administración por correo con tres piezas: la **solicitud** (Excel), la **cotización** del proveedor y el **correo de aprobación** del líder. A veces llega también la **factura**. La analista crea la OC en SAP y adjunta el correo de aprobación como evidencia.

## Datos de una OC
- **Proveedor**: debe existir en el maestro de proveedores de SAP (código SAP, NIT) y estar activo.
- **Centro de costo y subárea**: a quién se carga el gasto. Cada centro tiene sus subáreas y sus aprobadores con un tope de monto.
- **Indicador de IVA**: C0 excluido, C1 IVA 19 %, C2 IVA 5 %.
- **Condiciones de pago**: Z000 inmediato, Z015/Z030/Z060 a 15/30/60 días de la fecha de factura.
- **Evidencia**: el correo de aprobación del líder, con su huella sha256.

## Reglas de control

| Regla | Qué verifica | Si no se cumple | Acción sugerida |
|---|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT o, si no hay NIT, por nombre) y está activo. | **Bloqueo** | Pedir a Compras que cree o reactive el proveedor en SAP, o al solicitante que corrija el NIT. |
| RC2 | Hay correo de aprobación, dice "Aprobado" y lo envía un aprobador **del centro de costo** de la solicitud. | **Bloqueo** | Pedir la aprobación a un aprobador válido de ese centro de costo. |
| RC3 | El valor total no supera el tope del aprobador **en ese centro de costo**. | **Bloqueo** | Escalar a un aprobador con tope suficiente en ese centro. |
| RC4 | La subárea pertenece al centro de costo. | **Bloqueo** | Pedir al solicitante que corrija centro de costo o subárea. |
| RC5 | El total de la cotización no difiere más de 2 % del valor de la solicitud. Sin cotización también se pregunta. | **Confirmación** (con ambos valores) | Confirmar que la OC se crea por el valor de la solicitud, o pedir una solicitud corregida. |
| RC6 | La solicitud informa el indicador de IVA. Si falta, se toma el del proveedor. | **Confirmación** + derivado | Confirmar el IVA derivado. |
| RC7 | La solicitud informa las condiciones de pago. Si faltan, se toman las del proveedor. | Solo se informa | — |
| RC8 | Si hay factura con fecha anterior a la solicitud, la OC es **retroactiva** (se compró antes de pedir). | **Confirmación**; queda marcada en el log de control | Confirmar y reportar el desvío de proceso. |
| RC9 | La aprobación es de la misma fecha de la solicitud o posterior. | **Confirmación** | Confirmar que la aprobación aplica a esta solicitud. |
| RC10 | Cantidad × valor unitario = valor total (±1). | **Bloqueo** | Pedir al solicitante que corrija la solicitud. |

## Qué significa cada resultado
- **Bloqueo**: la OC no se puede crear. Se informa la razón y la acción sugerida; el intento queda en el log de control.
- **Confirmación**: la OC se puede crear solo si la analista lo confirma explícitamente.
- **Derivado**: dato que el agente completó desde los maestros y que se informa.
- **Retroactiva**: OC creada después de la factura. La dirección quiere medir cuántas hay; no se rechaza, se marca.

## Log de control
Cada intento (creada, bloqueada, pendiente, idempotente) queda en `out/control.csv` para Contabilidad y Auditoría. Crear dos veces la misma solicitud devuelve la OC existente; no se duplica.
