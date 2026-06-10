# BigCMS — 企业内容管理系统

基于 **TypeScript + Express 5 + SQLite(Node 内置)** 的企业级 CMS,零外部数据库依赖,开箱即用。

## 功能

- **前台站点**(`/`):企业官网 + 新闻中心,服务端渲染(SEO 友好),含首页、文章列表(分类/标签筛选、关键词搜索、分页)、文章详情(Markdown 渲染、上一篇/下一篇、相关阅读、可点击标签)
- **SEO 配套**:RSS 订阅(`/feed.xml`)、站点地图(`/sitemap.xml`)、`robots.txt`、Open Graph 元标签、自定义 404 页
- **文章管理**:Markdown 正文(实时预览)、草稿/发布/归档状态、**定时发布**(到点自动上线)、分类、多标签、封面图(可从媒体库选取)、搜索与状态/分类筛选、分页
- **全文检索**:SQLite FTS5(trigram 分词)索引标题/摘要/正文,前后台与公开 API 共用;环境不支持时自动回退 LIKE
- **修订历史**:文章每次保存前自动快照(每篇保留 20 版),后台与 AI 助手均可一键恢复
- **分类 / 标签**:层级分类、文章计数、防误删保护
- **媒体库**:文件上传(图片/PDF/视频等,20MB 上限,支持多选)、自动生成 WebP 缩略图(sharp,不可用时自动降级)、类型白名单、链接复制、编辑器内一键插图
- **用户与权限(RBAC)**:管理员 / 编辑 / 只读三种角色,账号禁用,密码 scrypt 加盐哈希
- **站点设置**:站点名称、描述、关键词、ICP 备案号
- **审计日志**:登录(含失败)与全部增删改操作留痕,支持按用户/操作类型/关键词筛选
- **仪表盘**:内容统计、最近更新、最近操作
- **公开内容 API**:无需登录,供前台站点拉取已发布文章(支持分类/标签/搜索参数,自动浏览量统计)
- **管理后台**(`/admin/`):内置中文 Web 管理界面(原生 JS,无前端构建步骤)
- **AI 助手**:基于 [Pi](https://pi.dev/) SDK 的对话式运营助手,自然语言管理全站信息(写稿/定时发布/分类标签/设置/用户/恢复修订),会话落盘跨重启恢复,操作全部留痕审计
- **安全**:Markdown 渲染消毒(原始 HTML 转义、危险协议拦截)、登录限速(15 分钟 10 次失败)、CSP 等安全响应头、上传文件沙箱化伺服、JWT 过期与账号状态校验
- **工程化**:API 集成测试(`npm test`)、热备份脚本(`npm run backup`)、Dockerfile

设计系统见 `DESIGN.md`(白底 + 深青绿,OKLCH 色彩)。

## 快速开始

要求 Node.js ≥ 22.5(使用内置 `node:sqlite`)。

```bash
npm install
npm run dev        # 开发模式(热重载)
# 或
npm run build && npm start   # 生产模式

npm test           # API 集成测试(独立临时数据库,不碰本地数据)
npm run backup     # 热备份数据库到 data/backups/(uploads/ 请一并备份)
```

Docker 部署:

```bash
docker build -t bigcms .
docker run -d -p 3000:3000 \
  -e JWT_SECRET=请改成随机长串 -e DEEPSEEK_API_KEY=sk-xxx \
  -v bigcms-data:/app/data -v bigcms-uploads:/app/uploads \
  bigcms
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
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `3000` | 服务端口 |
| `JWT_SECRET` | 开发用默认值 | JWT 签名密钥(生产必改) |
| `DATA_DIR` | `./data` | SQLite 数据库目录 |
| `UPLOAD_DIR` | `./uploads` | 上传文件目录 |
| `DEEPSEEK_API_KEY` | - | **推荐**:DeepSeek 官方 API 密钥(`api.deepseek.com`),也可在后台「站点设置 → AI 助手」填写;设置后自动选用 `deepseek-v4-flash` |
| `ANTHROPIC_API_KEY` 等 | - | 其他模型提供商凭证(任一 Pi 支持的提供商;也可复用 pi CLI 登录的 `~/.pi/agent/auth.json`) |
| `AI_PROVIDER` / `AI_MODEL` | 自动选择 | 指定 AI 助手使用的模型,如 `deepseek` + `deepseek-v4-pro`;只设 `AI_MODEL` 时自动在可用提供商中匹配 |
| `AI_THINKING` | `off` | AI 助手思考强度:`off` / `minimal` / `low` / `medium` / `high` / `xhigh`(DeepSeek 上有效档位为 `high` / `xhigh`,对应官方 thinking high / max) |

## AI 助手

管理后台「AI 助手」页面内置一个由 [Pi](https://pi.dev/) 驱动的对话式 agent,可用自然语言完成全部内容运营:

- “写一篇产品 2.0 发布公告,放进产品发布分类,打上技术标签,直接发布”
- “把最近的草稿都列出来” / “把所有草稿都发布”(批量操作,执行前会让你确认)
- “站点描述改成 ××”(管理员)/ “新建一个编辑账号给小王”(管理员)

### DeepSeek 官方 API(推荐)

按 [DeepSeek API 文档](https://api-docs.deepseek.com/zh-cn/) 做了重点适配:

- 在后台「站点设置 → AI 助手」填写 DeepSeek API Key,或设置 `DEEPSEEK_API_KEY`,即可直连 `api.deepseek.com`,默认选用 `deepseek-v4-flash`(1M 上下文,支持 Tool Calls / JSON Output,并发高、成本低);需要更强推理可在后台模型 ID 填 `deepseek-v4-pro`,或设 `AI_MODEL=deepseek-v4-pro`
- 兼容旧模型名:`AI_MODEL` 填 `deepseek-chat` / `deepseek-reasoner`(官方 2026/07/24 弃用)会自动映射到 `deepseek-v4-flash`,其中 `deepseek-reasoner` 自动开启思考模式,启动日志会提示迁移
- 思考模式:`AI_THINKING=high` / `xhigh` 分别对应 DeepSeek 官方 thinking 的 high / max 档
- 多个提供商同时可用时,优先选择 DeepSeek 官方 API

其他说明:

- 凭证:也可设置其他提供商的环境变量(如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`),或在本机用 pi CLI 登录过即可;可用 `AI_PROVIDER`/`AI_MODEL` 锁定具体模型,`AI_THINKING` 调思考强度
- 权限:编辑及以上可用;站点设置、用户管理、审计日志等工具仅管理员会话可见;只读账号不可用
- 安全:agent 只能调用内置的 CMS 工具(无 shell/文件访问);删除与批量操作会先向你确认;所有写操作以 `ai:` 前缀写入审计日志
- 体验:工具调用实时显示(悬停可看参数);回复过程中可随时点「停止」;每轮回复后显示 token 用量与成本;会话上下文带有当天日期与站点信息

### 外部数据工具(可选)

- `browse_webpage` — 服务器无头浏览器打开 URL 并提取正文。默认使用 puppeteer 随 `npm install` 自带的 Chromium,开箱即用;如需指定其他浏览器,可在「站点设置 → 网页抓取」填路径或设环境变量 `BROWSER_EXECUTABLE`。
- `browser_*` — 交互式浏览器套件(共享落盘浏览器,Cookie/登录态存于 `data/browser-profile`,跨重启保留):`browser_open` 多标签页浏览、`browser_interact` 点击/填表单/模拟登录、`browser_evaluate` 执行自定义 JS 提取数据、`browser_screenshot` / `browser_pdf` 截图与 PDF 导出(自动存入媒体库)、`browser_tabs` 标签页管理、`browser_cookies` Cookie 管理。
- `web_search` — 在「站点设置 → Bright Data」配置 [SERP API](https://docs.brightdata.com/scraping-automation/serp-api/introduction) 后,获取 Google/Bing 等结构化搜索结果(`parsed_light` 默认返回前 10 条有机结果)。

示例:「打开这个链接总结正文」/「搜一下竞品最近的新闻」。

### 企查查企业搜索(可选)

在「站点设置 → 企查查」配置 AppKey 与 SecretKey 后,AI 助手可使用 `search_companies` 调用 [API 886 企业模糊搜索](https://openapi.qcc.com/dataApi/886),按关键词查询企业名称、统一社会信用代码、法人、登记状态、注册地址等。

示例:「查一下字节跳动工商信息」/「搜索名称包含科技的在业企业」。

## API 概览

所有管理接口需要 `Authorization: Bearer <token>` 请求头。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 公开 | 登录,返回 JWT |
| GET | `/api/auth/me` | 登录 | 当前用户信息 |
| PUT | `/api/auth/password` | 登录 | 修改自己的密码 |
| GET/POST/PUT/DELETE | `/api/articles` | 登录 / 编辑 | 文章 CRUD(支持 `?page&status&q&category_id`) |
| POST | `/api/articles/preview` | 编辑 | Markdown 渲染预览(与前台同一渲染器,含消毒) |
| GET | `/api/articles/:id/revisions` | 登录 | 修订历史列表 |
| POST | `/api/articles/:id/revisions/:revId/restore` | 编辑 | 恢复到指定修订版本 |
| GET/POST/PUT/DELETE | `/api/categories` | 登录 / 编辑 | 分类 CRUD |
| GET/POST/DELETE | `/api/tags` | 登录 / 编辑 | 标签管理 |
| GET/POST/DELETE | `/api/media` | 登录 / 编辑 | 媒体库(`multipart/form-data`,字段名 `file`) |
| GET/POST/PUT/DELETE | `/api/users` | 管理员 | 用户管理 |
| GET/PUT | `/api/settings` | 登录 / 管理员 | 站点设置 |
| GET | `/api/dashboard/stats` | 登录 | 仪表盘统计 |
| GET | `/api/audit-logs` | 管理员 | 审计日志(支持 `?action&username&q`) |
| GET | `/api/assistant/status` | 编辑 | AI 助手可用性与当前模型 |
| POST | `/api/assistant/chat` | 编辑 | 发送消息,SSE 流式返回 |
| GET | `/api/assistant/history` | 编辑 | 当前会话历史 |
| POST | `/api/assistant/reset` | 编辑 | 清空当前会话 |
| POST | `/api/assistant/abort` | 编辑 | 中止正在生成的回复 |
| GET | `/api/public/articles` | 公开 | 已发布文章列表(`?page&category&tag&q`) |
| GET | `/feed.xml` / `/sitemap.xml` / `/robots.txt` | 公开 | RSS 订阅 / 站点地图 / 爬虫规则 |
| GET | `/api/public/articles/:slug` | 公开 | 文章详情(含标签,自动 +1 浏览量) |
| GET | `/api/public/site` | 公开 | 站点公开设置 |

## 目录结构

```
src/
  index.ts        # 服务入口(监听 + 定时任务)
  app.ts          # Express 应用装配(路由、安全响应头;测试直接挂载)
  scheduler.ts    # 定时发布轮询
  markdown.ts     # Markdown 消毒渲染(前台与预览共用)
  config.ts       # 配置(端口、密钥、目录)
  db.ts           # SQLite 建表/迁移、FTS5 索引、修订快照、初始数据
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
tests/
  api.test.ts     # API 集成测试(node:test,独立临时库)
scripts/
  backup.mjs      # SQLite 热备份(VACUUM INTO)
  screenshot.mjs  # 视觉验证截图(开发辅助)
data/             # SQLite 数据库(自动创建,已 gitignore)
uploads/          # 上传文件(自动创建,已 gitignore)
```
