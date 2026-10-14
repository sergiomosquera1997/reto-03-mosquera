# Imagen para Render (o cualquier host con Docker). Las variables de entorno
# (LLM_PROVIDER, LLM_MODEL, ANTHROPIC_API_KEY…) se configuran en el host, nunca aquí.
FROM oven/bun:1

WORKDIR /app

# Dependencias primero, para aprovechar la caché de capas.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Código, fixtures (solo lectura), prompt, conocimiento y front.
COPY . .

# out/ es lo único que la app escribe; el resto queda de solo lectura para el usuario sin privilegios.
RUN mkdir -p out && chown -R bun:bun out
USER bun

ENV NODE_ENV=production
EXPOSE 3000

# El servidor escucha en 0.0.0.0 y en process.env.PORT (Render lo inyecta).
CMD ["bun", "src/server.ts"]
