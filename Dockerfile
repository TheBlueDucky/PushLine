# Small and boring on purpose: this is a Node process serving files and one
# WebSocket. No build step, no bundler, no native modules.
FROM node:20-alpine

WORKDIR /app

# Dependencies first so a code change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY server ./server
COPY web ./web
COPY legacy ./legacy

# Profiles and cached puzzles live here. Mount a volume on it or every
# deploy wipes everyone's progress.
ENV PUSHLINE_DATA=/data/pushline.json
RUN mkdir -p /data

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "node server/server.js --port $PORT --data $PUSHLINE_DATA"]
