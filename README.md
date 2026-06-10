# BigCMS — 企业内容管理系统

基于 **TypeScript + Express 5 + SQLite(Node 内置)** 的企业级 CMS,零外部数据库依赖,开箱即用。

## 功能

- **前台站点**(`/`):企业官网 + 新闻中心,服务端渲染(SEO 友好),含首页、文章列表(分类筛选/分页)、文章详情(Markdown 渲染)
- **文章管理**:Markdown 正文、草稿/发布/归档状态、分类、多标签、封面图、搜索与分页
- **分类 / 标签**:层级分类、文章计数、防误删保护
- **媒体库**:文件上传(图片/PDF/视频等,20MB 上限)、类型白名单、链接复制
- **用户与权限(RBAC)**:管理员 / 编辑 / 只读三种角色,账号禁用,密码 scrypt 加盐哈希
- **站点设置**:站点名称、描述、关键词、ICP 备案号
- **审计日志**:登录与全部增删改操作留痕
- **仪表盘**:内容统计、最近更新、最近操作
- **公开内容 API**:无需登录,供前台站点拉取已发布文章(自动浏览量统计)
- **管理后台**(`/admin/`):内置中文 Web 管理界面(原生 JS,无前端构建步骤)
- **AI 助手**:基于 [Pi](https://pi.dev/) SDK 的对话式运营助手,自然语言管理全站信息(写稿/发布/分类标签/设置/用户),操作全部留痕审计

设计系统见 `DESIGN.md`(示波器荧光绿 + 哑光黑,OKLCH 色彩)。

## 快速开始

要求 Node.js ≥ 22.5(使用内置 `node:sqlite`)。

```bash
npm install
npm run dev        # 开发模式(热重载)
# 或
npm run build && npm start   # 生产模式
```

- 前台站点:<http://localhost:3000>
- 管理后台:<http://localhost:3000/admin/>

| 默认账号 | 密码 | 角色 |
|---|---|---|
| admin | admin123 | 管理员 |
| editor | editor123 | 编辑 |

> ⚠️ 生产环境请务必:修改默认密码,并通过环境变量 `JWT_SECRET` 设置签名密钥。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `JWT_SECRET` | 开发用默认值 | JWT 签名密钥(生产必改) |
| `DATA_DIR` | `./data` | SQLite 数据库目录 |
| `UPLOAD_DIR` | `./uploads` | 上传文件目录 |
| `ANTHROPIC_API_KEY` 等 | - | AI 助手模型凭证(任一 Pi 支持的提供商;也可复用 pi CLI 登录的 `~/.pi/agent/auth.json`) |
| `AI_PROVIDER` / `AI_MODEL` | 自动选择 | 指定 AI 助手使用的模型,如 `anthropic` + `claude-opus-4-5` |

## AI 助手

管理后台「AI 助手」页面内置一个由 [Pi](https://pi.dev/) 驱动的对话式 agent,可用自然语言完成全部内容运营:

- “写一篇产品 2.0 发布公告,放进产品发布分类,打上技术标签,直接发布”
- “把最近的草稿都列出来” / “把 ID 为 3 的文章转回草稿”
- “站点描述改成 ××”(管理员)/ “新建一个编辑账号给小王”(管理员)

说明:

- 凭证:设置任一模型提供商的环境变量(如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`),或在本机用 pi CLI 登录过即可;可用 `AI_PROVIDER`/`AI_MODEL` 锁定具体模型
- 权限:编辑及以上可用;站点设置、用户管理等工具仅管理员会话可见;只读账号不可用
- 安全:agent 只能调用内置的 CMS 工具(无 shell/文件访问);删除类操作会先向你确认;所有写操作以 `ai:` 前缀写入审计日志

## API 概览

所有管理接口需要 `Authorization: Bearer <token>` 请求头。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 公开 | 登录,返回 JWT |
| GET | `/api/auth/me` | 登录 | 当前用户信息 |
| PUT | `/api/auth/password` | 登录 | 修改自己的密码 |
| GET/POST/PUT/DELETE | `/api/articles` | 登录 / 编辑 | 文章 CRUD(支持 `?page&status&q&category_id`) |
| GET/POST/PUT/DELETE | `/api/categories` | 登录 / 编辑 | 分类 CRUD |
| GET/POST/DELETE | `/api/tags` | 登录 / 编辑 | 标签管理 |
| GET/POST/DELETE | `/api/media` | 登录 / 编辑 | 媒体库(`multipart/form-data`,字段名 `file`) |
| GET/POST/PUT/DELETE | `/api/users` | 管理员 | 用户管理 |
| GET/PUT | `/api/settings` | 登录 / 管理员 | 站点设置 |
| GET | `/api/dashboard/stats` | 登录 | 仪表盘统计 |
| GET | `/api/audit-logs` | 管理员 | 审计日志 |
| GET | `/api/assistant/status` | 编辑 | AI 助手可用性与当前模型 |
| POST | `/api/assistant/chat` | 编辑 | 发送消息,SSE 流式返回 |
| GET | `/api/assistant/history` | 编辑 | 当前会话历史 |
| POST | `/api/assistant/reset` | 编辑 | 清空当前会话 |
| GET | `/api/public/articles` | 公开 | 已发布文章列表(`?page&category`) |
| GET | `/api/public/articles/:slug` | 公开 | 文章详情(含标签,自动 +1 浏览量) |
| GET | `/api/public/site` | 公开 | 站点公开设置 |

## 目录结构

```
src/
  index.ts        # 服务入口与中间件装配
  config.ts       # 配置(端口、密钥、目录)
  db.ts           # SQLite 建表与初始数据
  auth.ts         # JWT 认证、角色门槛、审计写入
  password.ts     # scrypt 密码哈希
  slug.ts         # slug 生成
  assistant/
    manager.ts    # Pi agent 会话管理(每用户一个会话)
    tools.ts      # AI 助手的 CMS 管理工具
  routes/
    auth.ts       # 登录 / 个人信息 / 改密
    articles.ts   # 文章 CRUD
    taxonomy.ts   # 分类与标签
    media.ts      # 媒体上传
    users.ts      # 用户管理
    misc.ts       # 设置 / 仪表盘 / 审计 / 公开 API
    assistant.ts  # AI 助手(SSE 流式聊天)
    site.ts       # 前台站点(SSR:首页 / 新闻中心 / 文章详情)
public/
  site.css        # 前台样式
  scope.js        # 首页 hero 波形动画
  admin/          # 管理后台(原生 JS SPA)
scripts/
  screenshot.mjs  # 视觉验证截图(开发辅助)
data/             # SQLite 数据库(自动创建,已 gitignore)
uploads/          # 上传文件(自动创建,已 gitignore)
```
