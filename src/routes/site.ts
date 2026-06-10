import { Router } from 'express';
import { articleSearchCondition, db } from '../db.js';
import { renderMarkdown } from '../markdown.js';

export const siteRouter = Router();

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function getSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '');

/** 无封面文章的等高线插图(由文章 id 决定形态,确定性生成) */
function waveSvg(seed: number, height = 220): string {
  const rand = (n: number) => {
    const x = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const lines: string[] = [];
  for (let l = 0; l < 3; l++) {
    const amp = 18 + rand(l) * 30;
    const freq = 0.008 + rand(l + 10) * 0.012;
    const phase = rand(l + 20) * Math.PI * 2;
    const baseY = height * (0.35 + l * 0.15);
    let d = `M 0 ${baseY.toFixed(1)}`;
    for (let x = 0; x <= 800; x += 16) {
      const y = baseY + Math.sin(x * freq + phase) * amp * Math.sin(x * 0.002 + phase);
      d += ` L ${x} ${y.toFixed(1)}`;
    }
    const opacity = l === 0 ? 0.55 : 0.25 - l * 0.06;
    lines.push(`<path d="${d}" fill="none" stroke="oklch(0.5 0.08 195)" stroke-width="${l === 0 ? 2 : 1.2}" opacity="${opacity}"/>`);
  }
  return `<svg viewBox="0 0 800 ${height}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="装饰图形">
    <rect width="800" height="${height}" fill="oklch(0.97 0.005 195)"/>
    <g stroke="oklch(0.92 0.005 195)" stroke-width="1">${[1, 2, 3].map((i) => `<line x1="0" y1="${(height / 4) * i}" x2="800" y2="${(height / 4) * i}"/>`).join('')}</g>
    ${lines.join('')}
  </svg>`;
}

function cover(article: { id: number; cover_image: string; title: string }, height = 220): string {
  if (article.cover_image) {
    return `<img src="${esc(article.cover_image)}" alt="${esc(article.title)}" loading="lazy">`;
  }
  return waveSvg(article.id, height);
}

interface ArticleRow {
  id: number;
  title: string;
  slug: string;
  summary: string;
  cover_image: string;
  views: number;
  published_at: string | null;
  category_name: string | null;
  category_slug: string | null;
  author_name: string | null;
}

const PUBLISHED_SQL = `
  SELECT a.id, a.title, a.slug, a.summary, a.cover_image, a.views, a.published_at,
         c.name AS category_name, c.slug AS category_slug, u.display_name AS author_name
  FROM articles a
  LEFT JOIN categories c ON c.id = a.category_id
  LEFT JOIN users u ON u.id = a.author_id
  WHERE a.status = 'published'`;

function publishedCategories(): { name: string; slug: string; description: string; n: number }[] {
  return db
    .prepare(
      `SELECT c.name, c.slug, c.description, COUNT(a.id) AS n
       FROM categories c JOIN articles a ON a.category_id = c.id AND a.status = 'published'
       GROUP BY c.id ORDER BY c.sort_order, c.id`
    )
    .all() as unknown as { name: string; slug: string; description: string; n: number }[];
}

function layout(opts: {
  title: string;
  settings: Record<string, string>;
  body: string;
  active: 'home' | 'news';
  description?: string;
  ogImage?: string;
}): string {
  const { title, settings, body, active } = opts;
  const siteName = settings.site_name || 'BigCMS';
  const description = opts.description || settings.site_description || '';
  const categories = publishedCategories();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="keywords" content="${esc(settings.site_keywords || '')}">
<meta property="og:type" content="${active === 'news' ? 'article' : 'website'}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:site_name" content="${esc(siteName)}">
${opts.ogImage ? `<meta property="og:image" content="${esc(opts.ogImage)}">` : ''}
<link rel="alternate" type="application/rss+xml" title="${esc(siteName)}" href="/feed.xml">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<header class="site-header">
  <a class="wordmark" href="/">BigCMS</a>
  <nav class="site-nav">
    <a href="/" ${active === 'home' ? 'aria-current="page"' : ''}>首页</a>
    <a href="/news" ${active === 'news' ? 'aria-current="page"' : ''}>新闻中心</a>
    ${categories.slice(0, 3).map((c) => `<a class="nav-cat" href="/news?category=${esc(c.slug)}">${esc(c.name)}</a>`).join('')}
  </nav>
  <a class="admin-link" href="/admin/">管理后台</a>
</header>
<main>${body}</main>
<footer class="site-footer">
  <div class="foot-grid">
    <div class="foot-about">
      <div class="foot-brand">BigCMS</div>
      <p>${esc(settings.site_description || '企业内容,清晰可见。')}</p>
    </div>
    <nav class="foot-col" aria-label="栏目">
      <h3>栏目</h3>
      ${categories.map((c) => `<a href="/news?category=${esc(c.slug)}">${esc(c.name)}</a>`).join('') || '<span class="foot-dim">暂无栏目</span>'}
    </nav>
    <nav class="foot-col" aria-label="快速入口">
      <h3>快速入口</h3>
      <a href="/">首页</a>
      <a href="/news">新闻中心</a>
      <a href="/admin/">管理后台</a>
    </nav>
  </div>
  <div class="foot-bottom">
    <span>© ${new Date().getFullYear()} ${esc(siteName)}</span>
    ${settings.icp_number ? `<span>${esc(settings.icp_number)}</span>` : ''}
    <span>Powered by BigCMS</span>
  </div>
</footer>
</body>
</html>`;
}

// ---- 首页 ----
siteRouter.get('/', (_req, res) => {
  const settings = getSettings();
  const latest = db.prepare(`${PUBLISHED_SQL} ORDER BY a.published_at DESC LIMIT 5`).all() as unknown as ArticleRow[];
  const notices = db.prepare(`${PUBLISHED_SQL} ORDER BY a.published_at DESC LIMIT 4`).all() as unknown as ArticleRow[];
  const categories = publishedCategories();

  const [featured, ...rest] = latest;

  const body = `
<section class="hero">
  <canvas id="scope" aria-hidden="true"></canvas>
  <div class="hero-inner">
    <div class="hero-copy">
      <h1>${esc(settings.site_name || 'BigCMS')}</h1>
      <p class="hero-sub">${esc(settings.site_description || '企业内容,清晰可见。')}</p>
      <div class="hero-actions">
        <a class="btn-primary" href="/news">浏览最新动态</a>
        <a class="btn-outline" href="/admin/">进入管理后台</a>
      </div>
    </div>
    ${notices.length ? `
    <aside class="hero-panel">
      <div class="panel-head"><span>公司要闻</span><a href="/news">更多 →</a></div>
      ${notices.map((a) => `
      <a class="panel-row" href="/news/${esc(a.slug)}">
        <span class="panel-date">${fmtDate(a.published_at)}</span>
        <span class="panel-title">${esc(a.title)}</span>
      </a>`).join('')}
    </aside>` : ''}
  </div>
</section>

${featured ? `
<section class="section">
  <h2 class="section-title">最新动态</h2>
  <div class="news-spread">
    <a class="featured" href="/news/${esc(featured.slug)}">
      <div class="featured-media">${cover(featured, 320)}</div>
      <div class="featured-text">
        <div class="meta-line">${esc(featured.category_name || '动态')} · ${fmtDate(featured.published_at)}</div>
        <h3>${esc(featured.title)}</h3>
        <p>${esc(featured.summary)}</p>
      </div>
    </a>
    <div class="news-side">
      ${rest.map((a) => `
      <a class="news-row" href="/news/${esc(a.slug)}">
        <span class="news-date">${fmtDate(a.published_at)}</span>
        <span class="news-title">${esc(a.title)}</span>
        <span class="news-arrow">→</span>
      </a>`).join('') || '<p class="empty">更多内容筹备中。</p>'}
      <a class="more-link" href="/news">全部动态 →</a>
    </div>
  </div>
</section>` : `
<section class="section"><h2 class="section-title">最新动态</h2><p class="empty">内容筹备中,敬请期待。</p></section>`}

${categories.length ? `
<section class="band-soft">
  <div class="section">
    <h2 class="section-title">栏目</h2>
    <div class="cat-list">
      ${categories.map((c) => `
      <a class="cat-item" href="/news?category=${esc(c.slug)}">
        <span class="cat-top"><span class="cat-name">${esc(c.name)}</span><span class="cat-arrow">↗</span></span>
        <span class="cat-desc">${esc(c.description)}</span>
        <span class="cat-count">${c.n} 篇内容</span>
      </a>`).join('')}
    </div>
  </div>
</section>` : ''}

<section class="cta-band">
  <h2>把下一条动态,交给 BigCMS 发布</h2>
  <p>文章、栏目、媒体库、权限与审计,一套后台全部就绪。</p>
  <a class="btn-light" href="/admin/">进入管理后台</a>
</section>
<script src="/scope.js" defer></script>`;

  res.send(layout({ title: settings.site_name || 'BigCMS', settings, body, active: 'home' }));
});

// ---- 新闻中心 ----
siteRouter.get('/news', (req, res) => {
  const settings = getSettings();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 10;
  const categorySlug = typeof req.query.category === 'string' ? req.query.category : '';
  const tagSlug = typeof req.query.tag === 'string' ? req.query.tag : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';

  const categories = publishedCategories();

  const conditions: string[] = [];
  const params: string[] = [];
  if (categorySlug) {
    conditions.push('c.slug = ?');
    params.push(categorySlug);
  }
  if (tagSlug) {
    conditions.push('EXISTS (SELECT 1 FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id AND t.slug = ?)');
    params.push(tagSlug);
  }
  if (q) {
    const search = articleSearchCondition(q);
    conditions.push(search.sql);
    params.push(...search.params);
  }
  const where = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM articles a LEFT JOIN categories c ON c.id = a.category_id WHERE a.status = 'published'${where}`).get(...params) as { n: number }
  ).n;
  const items = db
    .prepare(`${PUBLISHED_SQL}${where} ORDER BY a.published_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as ArticleRow[];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const keep = { ...(categorySlug && { category: categorySlug }), ...(tagSlug && { tag: tagSlug }), ...(q && { q }) };
  const pageLink = (p: number) => `/news?${new URLSearchParams({ ...keep, ...(p > 1 && { page: String(p) }) })}`.replace(/\?$/, '');
  const tagName = tagSlug
    ? ((db.prepare(`SELECT name FROM tags WHERE slug = ?`).get(tagSlug) as { name: string } | undefined)?.name ?? tagSlug)
    : '';

  const body = `
<section class="page-head">
  <h1>新闻中心</h1>
  <form class="site-search" action="/news" method="get" role="search">
    ${categorySlug ? `<input type="hidden" name="category" value="${esc(categorySlug)}">` : ''}
    <input type="search" name="q" value="${esc(q)}" placeholder="搜索新闻…" aria-label="搜索新闻">
    <button type="submit">搜索</button>
  </form>
  <nav class="filter-pills" aria-label="按栏目筛选">
    <a href="/news" ${!categorySlug && !tagSlug ? 'aria-current="true"' : ''}>全部</a>
    ${categories.map((c) => `<a href="/news?category=${esc(c.slug)}" ${categorySlug === c.slug ? 'aria-current="true"' : ''}>${esc(c.name)} <small>${c.n}</small></a>`).join('')}
  </nav>
  ${q || tagSlug ? `<p class="filter-state">${q ? `「${esc(q)}」的搜索结果` : `标签「#${esc(tagName)}」下的内容`},共 ${total} 篇 <a href="/news">清除筛选</a></p>` : ''}
</section>
<section class="section">
  ${items.length ? `<div class="article-list">
    ${items.map((a) => `
    <a class="article-row" href="/news/${esc(a.slug)}">
      <div class="row-date">
        <span class="d">${fmtDate(a.published_at)?.slice(5) || ''}</span>
        <span class="y">${fmtDate(a.published_at)?.slice(0, 4) || ''}</span>
      </div>
      <div class="row-main">
        <h2>${esc(a.title)}</h2>
        ${a.summary ? `<p>${esc(a.summary)}</p>` : ''}
        <div class="meta-line">${esc(a.category_name || '动态')}${a.author_name ? ` · ${esc(a.author_name)}` : ''} · ${a.views} 次浏览</div>
      </div>
      <div class="row-thumb">${cover(a, 140)}</div>
    </a>`).join('')}
  </div>` : `<p class="empty">${q ? '没有找到相关内容,换个关键词试试。' : '该栏目暂时没有内容。'}</p>`}
  ${totalPages > 1 ? `<nav class="pager" aria-label="分页">
    ${page > 1 ? `<a href="${pageLink(page - 1)}">← 上一页</a>` : '<span></span>'}
    <span class="pager-info">${page} / ${totalPages}</span>
    ${page < totalPages ? `<a href="${pageLink(page + 1)}">下一页 →</a>` : '<span></span>'}
  </nav>` : ''}
</section>`;

  res.send(layout({ title: `新闻中心 · ${settings.site_name || 'BigCMS'}`, settings, body, active: 'news' }));
});

// ---- 文章详情 ----
siteRouter.get('/news/:slug', (req, res) => {
  const settings = getSettings();
  const article = db
    .prepare(`${PUBLISHED_SQL.replace('\n  FROM articles', ', a.content\n  FROM articles')} AND a.slug = ?`)
    .get(req.params.slug) as (ArticleRow & { content: string }) | undefined;

  if (!article) {
    res.status(404).send(
      layout({
        title: `页面不存在 · ${settings.site_name || 'BigCMS'}`,
        settings,
        active: 'news',
        body: `<section class="page-head"><h1>404</h1><p class="empty">这篇文章不存在,或尚未发布。</p><p style="margin-top:24px"><a class="btn-primary" href="/news">返回新闻中心</a></p></section>`,
      })
    );
    return;
  }

  db.prepare(`UPDATE articles SET views = views + 1 WHERE id = ?`).run(article.id);
  const tags = db
    .prepare(`SELECT t.name, t.slug FROM tags t JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ?`)
    .all(article.id) as { name: string; slug: string }[];
  const html = renderMarkdown(article.content);

  const prev = db
    .prepare(`SELECT title, slug FROM articles WHERE status = 'published' AND published_at < ? ORDER BY published_at DESC LIMIT 1`)
    .get(article.published_at) as { title: string; slug: string } | undefined;
  const next = db
    .prepare(`SELECT title, slug FROM articles WHERE status = 'published' AND published_at > ? ORDER BY published_at ASC LIMIT 1`)
    .get(article.published_at) as { title: string; slug: string } | undefined;
  const related = (
    article.category_slug
      ? db
          .prepare(`${PUBLISHED_SQL} AND c.slug = ? AND a.id != ? ORDER BY a.published_at DESC LIMIT 4`)
          .all(article.category_slug, article.id)
      : db.prepare(`${PUBLISHED_SQL} AND a.id != ? ORDER BY a.published_at DESC LIMIT 4`).all(article.id)
  ) as unknown as ArticleRow[];

  const body = `
<article class="article-page">
  <header class="article-head">
    <div class="meta-line">
      ${article.category_slug ? `<a href="/news?category=${esc(article.category_slug)}">${esc(article.category_name)}</a>` : esc(article.category_name || '动态')}
      · ${fmtDate(article.published_at)}${article.author_name ? ` · ${esc(article.author_name)}` : ''} · ${article.views + 1} 次浏览
    </div>
    <h1>${esc(article.title)}</h1>
    ${article.summary ? `<p class="article-summary">${esc(article.summary)}</p>` : ''}
  </header>
  ${article.cover_image ? `<div class="article-cover"><img src="${esc(article.cover_image)}" alt="${esc(article.title)}"></div>` : ''}
  <div class="prose">${html}</div>
  ${tags.length ? `<div class="article-tags">${tags.map((t) => `<a href="/news?tag=${esc(t.slug)}">#${esc(t.name)}</a>`).join('')}</div>` : ''}
  <nav class="article-siblings" aria-label="相邻文章">
    ${next ? `<a class="sib prev" href="/news/${esc(next.slug)}"><span class="sib-label">← 较新一篇</span><span class="sib-title">${esc(next.title)}</span></a>` : '<span></span>'}
    ${prev ? `<a class="sib next" href="/news/${esc(prev.slug)}"><span class="sib-label">较早一篇 →</span><span class="sib-title">${esc(prev.title)}</span></a>` : '<span></span>'}
  </nav>
  <nav class="article-back"><a href="/news">← 返回新闻中心</a></nav>
</article>
${related.length ? `
<section class="section related-section">
  <h2 class="section-title">相关阅读</h2>
  <div class="related-list">
    ${related.map((a) => `
    <a class="related-item" href="/news/${esc(a.slug)}">
      <span class="meta-line">${esc(a.category_name || '动态')} · ${fmtDate(a.published_at)}</span>
      <span class="related-title">${esc(a.title)}</span>
    </a>`).join('')}
  </div>
</section>` : ''}`;

  res.send(
    layout({
      title: `${article.title} · ${settings.site_name || 'BigCMS'}`,
      settings,
      body,
      active: 'news',
      description: article.summary || undefined,
      ogImage: article.cover_image || undefined,
    })
  );
});

// ---- RSS 订阅 ----
siteRouter.get('/feed.xml', (req, res) => {
  const settings = getSettings();
  const base = `${req.protocol}://${req.get('host')}`;
  const items = db
    .prepare(`${PUBLISHED_SQL} ORDER BY a.published_at DESC LIMIT 20`)
    .all() as unknown as ArticleRow[];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(settings.site_name || 'BigCMS')}</title>
  <link>${base}/</link>
  <description>${esc(settings.site_description || '')}</description>
  <language>zh-CN</language>
  ${items
    .map(
      (a) => `<item>
    <title>${esc(a.title)}</title>
    <link>${base}/news/${esc(a.slug)}</link>
    <guid>${base}/news/${esc(a.slug)}</guid>
    <description>${esc(a.summary)}</description>
    ${a.published_at ? `<pubDate>${new Date(a.published_at.replace(' ', 'T') + 'Z').toUTCString()}</pubDate>` : ''}
    ${a.category_name ? `<category>${esc(a.category_name)}</category>` : ''}
  </item>`
    )
    .join('\n  ')}
</channel>
</rss>`;
  res.type('application/rss+xml').send(xml);
});

// ---- sitemap.xml ----
siteRouter.get('/sitemap.xml', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const articles = db
    .prepare(`SELECT slug, updated_at FROM articles WHERE status = 'published' ORDER BY published_at DESC`)
    .all() as { slug: string; updated_at: string }[];
  const urls = [
    { loc: `${base}/`, priority: '1.0' },
    { loc: `${base}/news`, priority: '0.8' },
    ...publishedCategories().map((c) => ({ loc: `${base}/news?category=${encodeURIComponent(c.slug)}`, priority: '0.6' })),
    ...articles.map((a) => ({ loc: `${base}/news/${encodeURIComponent(a.slug)}`, priority: '0.7', lastmod: a.updated_at.slice(0, 10) })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${'lastmod' in u && u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;
  res.type('application/xml').send(xml);
});

// ---- robots.txt ----
siteRouter.get('/robots.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`);
});

// ---- 404 兜底 ----
siteRouter.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }
  const settings = getSettings();
  res.status(404).send(
    layout({
      title: `页面不存在 · ${settings.site_name || 'BigCMS'}`,
      settings,
      active: 'news',
      body: `<section class="page-head"><h1>404</h1><p class="empty">您访问的页面不存在。</p><p style="margin-top:24px"><a class="btn-primary" href="/">返回首页</a></p></section>`,
    })
  );
});
