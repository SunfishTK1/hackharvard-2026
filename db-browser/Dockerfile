FROM node:24-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.ts ./
COPY public ./public
USER node
# Node 24 runs TypeScript directly, so there is no build step.
CMD ["node", "server.ts"]
