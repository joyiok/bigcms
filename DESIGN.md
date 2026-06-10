# Design

视觉基调:**白底 + 深青绿(teal)**,目标是企业信任感:干净、稳重、专业。前台 `/` 走品牌向(Restrained,深青绿做唯一品牌色),后台 `/admin` 走产品向(深青侧栏 + 浅色工作区的经典企业后台),共用同一色相(hue 195-215)。

历史:v1 为荧光绿黑底(phosphor-on-black),用户反馈 web3 味太重、缺信任感,2026-06-10 整体转向浅色。

## Color (OKLCH)

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `oklch(1 0 0)` 前台 / `oklch(0.975 0.003 195)` 后台 | 页面底色(纯白/浅灰青) |
| `--bg-soft` / `--card` | `oklch(0.975 0.004 195)` / 纯白 | 浅色区带 / 卡片 |
| `--border` | `oklch(0.91 0.006 195)` | 描边 |
| `--ink` | `oklch(0.25 0.015 215)` | 正文(近黑,微冷) |
| `--muted` | `oklch(0.49-0.5 0.02 215)` | 次要文字(≥4.5:1) |
| `--teal` / `--primary` | `oklch(0.45 0.08 195)` | 品牌色:主按钮、链接、当前态;上面用白字 |
| `--teal-strong` | `oklch(0.38 0.075 200)` | hover 加深 |
| `--teal-deep` | `oklch(0.3 0.05 210)` | CTA 色带、前台页脚、后台侧栏(0.28) |
| `--teal-tint` | `oklch(0.95 0.018 195)` | 选中态浅底、标签底 |
| 语义色(后台) | success `0.5 0.12 155` / amber `0.55 0.11 75` / danger `0.55 0.18 25` | 已发布 / 草稿 / 删除,均配同色浅底 |

规则:深青绿是唯一品牌色;大面积深色只出现在 CTA 色带、页脚、后台侧栏三处。禁止霓虹、发光、玻璃拟态。

## Typography

- 全站系统字体栈(-apple-system, PingFang SC…),不加载 webfont。
- 层次靠字重:标题 700-800,正文 400,关键 meta 500-600。
- 前台标题 `clamp()` 流式(hero 至 4.6rem),后台固定 rem。
- h1-h3 `text-wrap: balance`;长文 `text-wrap: pretty`,行宽 ≤ 70ch;数字 `tabular-nums`。

## Components

- **按钮**:主操作 = 深青绿底白字;次要 = 白底描边;危险 = 红字,hover 红浅底。圆角 8px。
- **公司要闻卡**(hero 右侧):白卡 + 浅投影,标题行下 2px 青绿下划线,行 = 日期 + 标题。
- **徽章**(后台):彩色浅底药丸 — 已发布绿、草稿琥珀、归档灰、管理员青绿实底。
- **栏目卡**:白卡描边,hover 升起 2px + 浅投影 + 箭头位移。
- **CTA 色带**:深青绿整幅,白字白底按钮,全页唯一大面积深色块(页脚同色系)。
- **插图**:无封面文章用确定性 SVG 等高线(seed = 文章 id,浅底青线);hero 背景为低对比 canvas 等高线动画(`scope.js`)。

## Motion

- 后台:150-250ms 状态反馈;弹窗 180ms 上浮。
- 前台:hero 文字 600ms 上浮入场(交错 70ms);箭头/卡片 hover 位移;canvas 慢速低对比。
- 所有动效均有 `prefers-reduced-motion: reduce` 降级(canvas 渲染静态一帧)。

## Files

- 前台样式:`public/site.css`,hero 动画:`public/scope.js`,SSR 模板:`src/routes/site.ts`
- 后台样式:`public/admin/style.css`
