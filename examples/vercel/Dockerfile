FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY schema.sql ./schema.sql
USER node
CMD ["node", "src/worker-main.mjs"]
