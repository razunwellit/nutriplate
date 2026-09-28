# Portable image for any container host (Northflank, Koyeb, Cloud Run, Fly.io,
# Railway, Zeabur, ...). Render does not need this — render.yaml uses the native
# Node runtime.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first so this layer is cached between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The host sets PORT; the app falls back to 3000.
EXPOSE 3000
USER node
CMD ["node", "server.js"]
