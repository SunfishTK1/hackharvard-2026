FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

COPY dist ./dist
COPY server.ts ./server.ts

USER node
CMD ["node", "server.ts"]
