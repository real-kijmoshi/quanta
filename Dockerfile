FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 QUANTA_DATA=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.mjs index.html *.css ./
COPY --chown=node:node src ./src
COPY --chown=node:node lib ./lib
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
