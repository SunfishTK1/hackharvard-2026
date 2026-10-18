# Two stages: build the React app, then run server.ts on Node 24 (native TypeScript type stripping).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server.ts home.ts pages.ts redact.ts ./
COPY src/types.ts ./src/types.ts
USER node
CMD ["node", "server.ts"]
