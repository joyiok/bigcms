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
# puppeteer 自带 Chromium 存放位置(npm ci 时随依赖下载)
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
WORKDIR /app
COPY package.json package-lock.json ./
# npm 在容器里跑:每次构建都重新安装 puppeteer 及其内置 Chromium;--install-deps 装运行所需系统库
RUN npm ci --omit=dev \
  && npx puppeteer browsers install chrome --install-deps \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY public ./public
# 数据库与上传文件务必挂载持久卷
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
