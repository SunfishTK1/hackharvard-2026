FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# Holds the event replay cursor; mounted as a volume so restarts resume where they left off.
RUN mkdir -p .data && chown node:node .data

USER node
# Node 24 runs TypeScript directly, so there is no build step.
CMD ["node", "src/agent.ts"]
