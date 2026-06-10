# BigCMS 生产镜像(需要 Node ≥ 22.5,使用内置 node:sqlite)
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
# browse_webpage 本地无头浏览器(Debian chromium 包)
ENV BROWSER_EXECUTABLE=/usr/bin/chromium
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# 数据库与上传文件务必挂载持久卷
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
