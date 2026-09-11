FROM node:22-alpine

# dumb-init da un PID 1 correcto que reenvia SIGTERM, para que el apagado
# ordenado de server.js se ejecute de verdad al hacer docker compose down.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Capa de dependencias separada: solo se reconstruye si cambia el lockfile.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# La imagen de node ya trae el usuario `node` sin privilegios.
USER node

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
