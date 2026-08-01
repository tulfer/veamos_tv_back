# ============================================================
# Veamos TV Backend — Google Cloud Run
# Incluye Chromium de Playwright (necesario para los proveedores
# de scraping que requieren un navegador real: tvporinternet2,
# cablevisionhd, wsdeportes, cineby, etc.)
# ============================================================

FROM node:20-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
# Evita que Node escriba logs de deprecación/verborrea en stdout
ENV NO_COLOR=1

WORKDIR /app

# Instalar dependencias del proyecto (playwright + resto).
# NODE_ENV=production hace que npm ci omita devDependencies, así que se
# incluyen explícitamente para poder compilar (typescript es devDependency).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Instalar Chromium de Playwright + sus dependencias del sistema (apt)
RUN npx playwright install --with-deps chromium

# Compilar TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Limpieza: quitar fuentes TS, devDependencies (typescript, eslint, tsx...) y caché de npm
RUN rm -rf src tsconfig.json && npm prune --omit=dev && npm cache clean --force

EXPOSE 8080

CMD ["node", "dist/main.js"]
