# Reto 03 – Agente OC SAP. Lee PRD.md antes de cualquier cambio.
- TypeScript estricto con Bun. Prohibido `any`. Funciones cortas.
- Herramientas en src/tools/oc.ts: objeto { description, args (zod con .describe), execute(args, ctx) }.
  execute devuelve SIEMPRE string JSON { ok:true, data } | { ok:false, error }. Nunca lanza.
- Rutas relativas a ctx.directory. Nunca rutas absolutas ni comandos de shell.
- fixtures/ es solo lectura. Todo lo generado va a out/.
- Comportamiento en agent/prompt.md, conocimiento en src/knowledge/, ejecución en src/tools/.
- La API key solo desde variable de entorno; nunca en logs, front ni respuestas.
- Antes de implementar, propone un plan y espera aprobación.