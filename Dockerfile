# Repo-root context. Builds the UI and serves it from the API process
# (FRONTEND_DIST). Local compose still publishes the API on host port 47196.
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

# tsx is a backend devDependency and is the start runtime.
RUN npm ci --include=dev

COPY . .

RUN npm run build -w frontend

ENV HOST=0.0.0.0 \
    PORT=4000 \
    NODE_ENV=production \
    FRONTEND_DIST=/app/frontend/dist

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

WORKDIR /app/backend
CMD ["npx", "tsx", "src/index.ts"]
