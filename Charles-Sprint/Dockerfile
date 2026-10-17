FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
# The slim image has no fonts; the card and meme renderers (resvg) need them for text. Spectrum
# converts voice notes to m4a with ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
# Holds leaderboard.json; mounted as a volume so times survive redeploys.
RUN mkdir -p .data && chown node:node .data

USER node
# Node 24 runs TypeScript directly, so there is no build step.
CMD ["node", "src/index.ts"]
