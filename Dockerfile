FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY examples/fixtures ./examples/fixtures
RUN mkdir /app/.state && chown node:node /app/.state
USER node
CMD ["node", "scripts/server.mjs"]
