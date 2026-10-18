FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
# The slim image has no fonts; the card renderer (resvg) needs them for text. ffmpeg converts
# iMessage voice notes (CAF) for transcription, and Spectrum uses it to send Sage's voice notes.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY db ./db

USER node
# Node 24 runs TypeScript directly, so there is no build step.
CMD ["node", "src/index.ts"]
