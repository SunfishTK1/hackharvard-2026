FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY dist ./dist
COPY server.ts ./server.ts

USER node
CMD ["node", "server.ts"]
