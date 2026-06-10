import { Router, type Request } from 'express';
import { articleSearchCondition, db } from '../db.js';
import { renderMarkdown } from '../markdown.js';
import {
  absoluteUrl,
  articleJsonLd,
  breadcrumbJsonLd,
  isoDateTime,
  jsonLdScript,
  organizationJsonLd,
  seoDescription,
  seoImageUrl,
  siteBaseUrl,
  websiteJsonLd,
} from '../seo.js';
import { homeValueItems, parseValueItem, siteCopy, siteHref, sitePageTitle } from '../site-copy.js';

export const siteRouter = Router();

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function getSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '');

/** 内页面包屑(末项为当前页) */
function crumbs(items: { label: string; href?: string }[]): string {
  return `<nav class="crumbs" aria-label="面包屑">${items
    .map((it, i) =>
      it.href && i < items.length - 1
        ? `<a href="${esc(it.href)}">${esc(it.label)}</a>`
        : `<span aria-current="page">${esc(it.label)}</span>`
    )
    .join('<span class="sep">/</span>')}</nav>`;
}

const PRODUCTS_CATEGORY_SLUG = 'products';
const BRAND_LOGO = '/brand/logo.png';

function brandLogo(settings: Record<string, string>): string {
  return siteCopy(settings, 'site_logo').trim() || BRAND_LOGO;
}

function renderHeroAside(settings: Record<string, string>, notices: ArticleRow[]): string {
  if (notices.length) {
    return `<aside class="hero-panel">
      <div class="panel-head"><span>${esc(siteCopy(settings, 'hero_notices_title'))}</span><a href="/news">更多 →</a></div>
      ${notices
        .map(
          (a) => `
      <a class="panel-row" href="/news/${esc(a.slug)}">
        <span class="panel-date">${fmtDate(a.published_at)}</span>
        <span class="panel-title">${esc(a.title)}</span>
      </a>`
        )
        .join('')}
    </aside>`;
  }
  const heroImage = siteCopy(settings, 'hero_image').trim();
  if (heroImage) {
    return `<aside class="hero-panel hero-visual"><img src="${esc(heroImage)}" alt="" class="hero-visual-img" loading="eager"></aside>`;
  }
  const logo = brandLogo(settings);
  const siteName = siteCopy(settings, 'site_name');
  return `<aside class="hero-panel hero-logo-panel">
    <img src="${esc(logo)}" alt="${esc(siteName)}" class="hero-panel-logo" loading="eager">
  </aside>`;
}

function renderBrandShowcase(): string {
  const items = [
    ['/brand/tshirt_mockup.png', '品牌 T 恤应用'],
    ['/brand/notebook_mockup.png', '品牌笔记本应用'],
    ['/brand/totebag_mockup.png', '品牌帆布袋应用'],
  ];
  return `<section class="brand-showcase" aria-label="品牌应用展示">
  <div class="section">
    <div class="section-head">
      <div>
        <p class="section-tag">Brand Applications</p>
        <h2 class="section-title">品牌应用展示</h2>
      </div>
    </div>
    <div class="brand-mockup-grid">
      ${items
        .map(
          ([src, alt]) => `
      <figure class="brand-mockup-card">
        <img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" width="640" height="640">
      </figure>`
        )
        .join('')}
    </div>
  </div>
</section>`;
}

function renderProductSection(settings: Record<string, string>, products: ArticleRow[]): string {
  if (!products.length) return '';
  const title = siteCopy(settings, 'home_products_title');
  const more = siteCopy(settings, 'home_products_more_link');
  return `<section class="band-soft home-products">
  <div class="section">
    <div class="section-head">
      <h2 class="section-title">${esc(title)}</h2>
      <a class="section-link" href="/products">${esc(more)}</a>
    </div>
    <div class="product-grid">
      ${products
        .map(
          (a) => `
      <a class="product-card" href="/news/${esc(a.slug)}">
        <div class="product-card-media">${cover(a, 200)}</div>
        <div class="product-card-body">
          <h3>${esc(a.title)}</h3>
          ${a.summary ? `<p>${esc(a.summary)}</p>` : ''}
          <span class="product-card-cta" aria-hidden="true">了解详情 →</span>
        </div>
      </a>`
        )
        .join('')}
    </div>
  </div>
</section>`;
}

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
    const stroke = l === 0 ? '#0C73DF' : '#46C25F';
    lines.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${l === 0 ? 2 : 1.2}" opacity="${opacity}"/>`);
  }
  return `<svg viewBox="0 0 800 ${height}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="装饰图形">
    <rect width="800" height="${height}" fill="#0B1120"/>
    <g stroke="rgba(12,115,223,0.08)" stroke-width="1">${[1, 2, 3].map((i) => `<line x1="0" y1="${(height / 4) * i}" x2="800" y2="${(height / 4) * i}"/>`).join('')}</g>
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
  req: Request;
  title: string;
  settings: Record<string, string>;
  body: string;
  active: 'home' | 'news' | 'products' | 'contact';
  canonicalPath: string;
  description?: string;
  ogImage?: string;
  ogType?: 'website' | 'article';
  noindex?: boolean;
  jsonLd?: Record<string, unknown>[];
  articlePublished?: string | null;
  articleModified?: string | null;
  prevUrl?: string;
  nextUrl?: string;
}): string {
  const { title, settings, body, active, req } = opts;
  const siteName = siteCopy(settings, 'site_name');
  const baseUrl = siteBaseUrl(req, settings);
  const canonical = absoluteUrl(baseUrl, opts.canonicalPath);
  const description = seoDescription(opts.description || siteCopy(settings, 'site_description'));
  const keywords = siteCopy(settings, 'site_keywords').trim();
  const ogType = opts.ogType || (opts.articlePublished ? 'article' : 'website');
  const defaultOgImage = seoImageUrl(
    baseUrl,
    siteCopy(settings, 'site_logo').trim() || siteCopy(settings, 'hero_image').trim()
  );
  const ogImage = seoImageUrl(baseUrl, opts.ogImage) || defaultOgImage;
  const publishedIso = isoDateTime(opts.articlePublished);
  const modifiedIso = isoDateTime(opts.articleModified) || publishedIso;
  const categories = publishedCategories();
  const headExtra = [
    opts.noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow">',
    `<link rel="canonical" href="${esc(canonical)}">`,
    keywords ? `<meta name="keywords" content="${esc(keywords)}">` : '',
    '<meta property="og:locale" content="zh_CN">',
    `<meta property="og:type" content="${ogType}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:site_name" content="${esc(siteName)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : '',
    publishedIso ? `<meta property="article:published_time" content="${publishedIso}">` : '',
    modifiedIso && ogType === 'article' ? `<meta property="article:modified_time" content="${modifiedIso}">` : '',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">` : '',
    opts.prevUrl ? `<link rel="prev" href="${esc(absoluteUrl(baseUrl, opts.prevUrl))}">` : '',
    opts.nextUrl ? `<link rel="next" href="${esc(absoluteUrl(baseUrl, opts.nextUrl))}">` : '',
    ...(opts.jsonLd || []).map((block) => jsonLdScript(block)),
  ]
    .filter(Boolean)
    .join('\n');
  const logoUrl = brandLogo(settings);
  const wordmarkLogo = `<img src="${esc(logoUrl)}" alt="" class="wordmark-logo" width="36" height="36">`;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${headExtra}
<link rel="alternate" type="application/rss+xml" title="${esc(siteName)}" href="${esc(absoluteUrl(baseUrl, '/feed.xml'))}">
<link rel="sitemap" type="application/xml" title="Sitemap" href="${esc(absoluteUrl(baseUrl, '/sitemap.xml'))}">
<link rel="stylesheet" href="/site.css">
<link rel="icon" href="${esc(logoUrl)}" type="image/png">
</head>
<body>
<header class="site-header">
  <a class="wordmark" href="/">${wordmarkLogo}<span class="wordmark-text">${esc(siteName)}</span></a>
  <nav class="site-nav" aria-label="主导航">
    <a href="/" ${active === 'home' ? 'aria-current="page"' : ''}>${esc(siteCopy(settings, 'nav_home'))}</a>
    <a href="/news" ${active === 'news' ? 'aria-current="page"' : ''}>${esc(siteCopy(settings, 'nav_news'))}</a>
    <a href="/products" ${active === 'products' ? 'aria-current="page"' : ''}>${esc(siteCopy(settings, 'nav_products'))}</a>
    <a href="/contact" ${active === 'contact' ? 'aria-current="page"' : ''}>${esc(siteCopy(settings, 'nav_contact'))}</a>
  </nav>
  <div class="header-actions">
    <a class="btn-header" href="/contact">${esc(siteCopy(settings, 'nav_contact'))}</a>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="切换主题" title="切换主题">
      <svg class="icon-sun" hidden xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      <svg class="icon-moon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
    </button>
  </div>
</header>
<main>${body}</main>
<footer class="site-footer">
  <div class="foot-grid">
    <div class="foot-about">
      <div class="foot-brand">${esc(siteName)}</div>
      <p>${esc(siteCopy(settings, 'site_description'))}</p>
    </div>
    <nav class="foot-col" aria-label="栏目">
      <h3>${esc(siteCopy(settings, 'footer_categories_title'))}</h3>
      ${categories.map((c) => `<a href="/news?category=${esc(c.slug)}">${esc(c.name)}</a>`).join('') || '<span class="foot-dim">暂无栏目</span>'}
    </nav>
    <nav class="foot-col" aria-label="快速入口">
      <h3>${esc(siteCopy(settings, 'footer_links_title'))}</h3>
      <a href="/">${esc(siteCopy(settings, 'nav_home'))}</a>
      <a href="/news">${esc(siteCopy(settings, 'nav_news'))}</a>
      <a href="/products">${esc(siteCopy(settings, 'nav_products'))}</a>
      <a href="/contact">${esc(siteCopy(settings, 'nav_contact'))}</a>
    </nav>
  </div>
  <div class="foot-bottom">
    <span>© ${new Date().getFullYear()} ${esc(siteName)}</span>
    ${siteCopy(settings, 'icp_number') ? `<span>${esc(siteCopy(settings, 'icp_number'))}</span>` : ''}
    ${siteCopy(settings, 'site_footer_credit') ? `<span>${esc(siteCopy(settings, 'site_footer_credit'))}</span>` : ''}
  </div>
</footer>
<script src="/site.js" defer></script>
</body>
</html>`;
}

// ---- 首页 ----
siteRouter.get('/', (req, res) => {
  const settings = getSettings();
  const baseUrl = siteBaseUrl(req, settings);
  const siteName = siteCopy(settings, 'site_name');
  const siteDescription = siteCopy(settings, 'site_description');
  const logo = seoImageUrl(baseUrl, siteCopy(settings, 'site_logo').trim());
  const excludeProducts = ` AND (c.slug IS NULL OR c.slug != ?)`;
  const latest = db
    .prepare(`${PUBLISHED_SQL}${excludeProducts} ORDER BY a.published_at DESC LIMIT 5`)
    .all(PRODUCTS_CATEGORY_SLUG) as unknown as ArticleRow[];
  const notices = db
    .prepare(`${PUBLISHED_SQL}${excludeProducts} ORDER BY a.published_at DESC LIMIT 4`)
    .all(PRODUCTS_CATEGORY_SLUG) as unknown as ArticleRow[];
  const products = db
    .prepare(`${PUBLISHED_SQL} AND c.slug = ? ORDER BY a.published_at DESC LIMIT 4`)
    .all(PRODUCTS_CATEGORY_SLUG) as unknown as ArticleRow[];
  const categories = publishedCategories();

  const [featured, ...rest] = latest;
  const values = homeValueItems(settings);
  const heroTitle = siteCopy(settings, 'hero_title').trim();
  const heroHeadline = heroTitle || siteName;
  const showHeroBrand = Boolean(heroTitle);
  const secondaryCta = siteCopy(settings, 'hero_secondary_cta').trim() || siteCopy(settings, 'nav_contact');
  const secondaryHref = siteHref(settings, 'hero_secondary_href', '/contact');
  const aboutTitle = siteCopy(settings, 'home_about_title').trim();
  const aboutText = siteCopy(settings, 'home_about_text').trim();
  const showCategories = categories.length >= 2;

  const capabilityBand = values.length
    ? `<section class="capability-band" aria-label="核心能力">
  <div class="capability-inner">
    ${values
      .map((v) => {
        const { title, desc } = parseValueItem(v);
        return `<article class="capability-item">
      <h3>${esc(title)}</h3>
      ${desc ? `<p>${esc(desc)}</p>` : ''}
    </article>`;
      })
      .join('')}
  </div>
</section>`
    : '';

  const body = `
<section class="hero">
  <div class="hero-glow-1" aria-hidden="true"></div>
  <div class="hero-glow-2" aria-hidden="true"></div>
  <canvas id="scope" aria-hidden="true"></canvas>
  <div class="hero-inner">
    <div class="hero-copy">
      <div class="hero-logo-wrap">
        <img src="${esc(brandLogo(settings))}" alt="" class="hero-mark" width="120" height="120" loading="eager">
      </div>
      ${showHeroBrand ? `<p class="hero-brand">${esc(siteName)}</p>` : ''}
      <h1>${esc(heroHeadline)}</h1>
      <p class="hero-sub">${esc(siteCopy(settings, 'site_description'))}</p>
      <div class="hero-actions">
        <a class="btn-primary" href="/news">${esc(siteCopy(settings, 'hero_cta'))}</a>
        <a class="btn-secondary" href="${esc(secondaryHref)}">${esc(secondaryCta)}</a>
      </div>
    </div>
    ${renderHeroAside(settings, notices)}
  </div>
</section>
${capabilityBand}

${featured ? `
<section class="section home-insights">
  <div class="section-head">
    <h2 class="section-title">${esc(siteCopy(settings, 'home_news_title'))}</h2>
    <a class="section-link" href="/news">${esc(siteCopy(settings, 'home_more_link'))}</a>
  </div>
  <div class="news-spread${rest.length ? '' : ' news-spread-single'}">
    <a class="featured" href="/news/${esc(featured.slug)}">
      <div class="featured-media">${cover(featured, 320)}</div>
      <div class="featured-text">
        <div class="meta-line">${esc(featured.category_name || '动态')} · ${fmtDate(featured.published_at)}</div>
        <h3>${esc(featured.title)}</h3>
        <p>${esc(featured.summary)}</p>
      </div>
    </a>
    <div class="news-side">
      ${rest
        .map(
          (a) => `
      <a class="news-row" href="/news/${esc(a.slug)}">
        <span class="news-date">${fmtDate(a.published_at)}</span>
        <span class="news-title">${esc(a.title)}</span>
      </a>`
        )
        .join('')}
    </div>
  </div>
</section>` : ''}

${renderProductSection(settings, products)}

${aboutTitle || aboutText ? `
<section class="home-about">
  <div class="section home-about-split">
    <div class="home-about-lead">
      ${aboutTitle ? `<h2>${esc(aboutTitle)}</h2>` : ''}
      <a class="btn-primary" href="/contact">${esc(siteCopy(settings, 'nav_contact'))}</a>
    </div>
    ${aboutText ? `<div class="home-about-body"><p>${esc(aboutText)}</p></div>` : ''}
    <div class="home-about-visual">
      <img src="/brand/card_front_dark.svg" alt="QIpeak 品牌名片" loading="lazy" width="1134" height="709">
    </div>
  </div>
</section>` : ''}

${renderBrandShowcase()}

${showCategories ? `
<section class="band-soft home-categories">
  <div class="section">
    <div class="section-head">
      <h2 class="section-title">${esc(siteCopy(settings, 'home_categories_title'))}</h2>
    </div>
    <div class="cat-list">
      ${categories
        .map(
          (c) => `
      <a class="cat-item" href="/news?category=${esc(c.slug)}">
        <span class="cat-name">${esc(c.name)}</span>
        <span class="cat-desc">${esc(c.description)}</span>
        <span class="cat-count">${c.n} 篇</span>
      </a>`
        )
        .join('')}
    </div>
  </div>
</section>` : ''}

<section class="cta-band">
  <div class="cta-band-inner">
    <h2>${esc(siteCopy(settings, 'cta_title'))}</h2>
    <div class="cta-band-side">
      <p>${esc(siteCopy(settings, 'cta_text'))}</p>
      <a class="btn-light" href="${esc(siteHref(settings, 'cta_href', '/news'))}">${esc(siteCopy(settings, 'cta_button'))}</a>
    </div>
  </div>
</section>
<script src="/scope.js" defer></script>`;

  res.send(
    layout({
      req,
      title: sitePageTitle(settings),
      settings,
      body,
      active: 'home',
      canonicalPath: '/',
      jsonLd: [
        organizationJsonLd({ baseUrl, name: siteName, description: siteDescription, logo }),
        websiteJsonLd({ baseUrl, name: siteName, description: siteDescription }),
      ],
    })
  );
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
<div class="page-head-band">
<section class="page-head">
  ${crumbs([{ label: siteCopy(settings, 'nav_home'), href: '/' }, { label: siteCopy(settings, 'nav_news') }])}
  <h1>${esc(siteCopy(settings, 'nav_news'))}</h1>
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
</div>
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

  const listParams = new URLSearchParams();
  if (categorySlug) listParams.set('category', categorySlug);
  if (tagSlug) listParams.set('tag', tagSlug);
  if (page > 1) listParams.set('page', String(page));
  const listQs = listParams.toString();
  const canonicalPath = `/news${listQs ? `?${listQs}` : ''}`;
  res.send(
    layout({
      req,
      title: sitePageTitle(settings, siteCopy(settings, 'nav_news')),
      settings,
      body,
      active: 'news',
      canonicalPath,
      noindex: Boolean(q || tagSlug),
      prevUrl: page > 1 ? pageLink(page - 1) : undefined,
      nextUrl: page < totalPages ? pageLink(page + 1) : undefined,
    })
  );
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
        req,
        title: sitePageTitle(settings, '页面不存在'),
        settings,
        active: 'news',
        canonicalPath: req.path,
        noindex: true,
        body: `<section class="page-head"><h1>404</h1><p class="empty">这篇文章不存在,或尚未发布。</p><p style="margin-top:24px"><a class="btn-primary" href="/news">返回${esc(siteCopy(settings, 'nav_news'))}</a></p></section>`,
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
    ${crumbs([
      { label: siteCopy(settings, 'nav_home'), href: '/' },
      { label: siteCopy(settings, 'nav_news'), href: '/news' },
      ...(article.category_name && article.category_slug
        ? [{ label: article.category_name, href: `/news?category=${article.category_slug}` }]
        : []),
      { label: article.title },
    ])}
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

  const baseUrl = siteBaseUrl(req, settings);
  const siteName = siteCopy(settings, 'site_name');
  const canonicalPath = `/news/${article.slug}`;
  const publisherLogo = seoImageUrl(baseUrl, siteCopy(settings, 'site_logo').trim());
  const articleImage = seoImageUrl(baseUrl, article.cover_image);
  const breadcrumbItems = [
    { name: siteCopy(settings, 'nav_home'), path: '/' },
    { name: siteCopy(settings, 'nav_news'), path: '/news' },
    ...(article.category_name && article.category_slug
      ? [{ name: article.category_name, path: `/news?category=${article.category_slug}` }]
      : []),
    { name: article.title },
  ];

  res.send(
    layout({
      req,
      title: sitePageTitle(settings, article.title),
      settings,
      body,
      active: 'news',
      canonicalPath,
      description: article.summary || undefined,
      ogImage: article.cover_image || undefined,
      ogType: 'article',
      articlePublished: article.published_at,
      articleModified: article.published_at,
      jsonLd: [
        articleJsonLd({
          baseUrl,
          canonicalPath,
          headline: article.title,
          description: article.summary || siteCopy(settings, 'site_description'),
          image: articleImage,
          datePublished: isoDateTime(article.published_at),
          dateModified: isoDateTime(article.published_at),
          authorName: article.author_name || undefined,
          publisherName: siteName,
          publisherLogo,
        }),
        breadcrumbJsonLd(baseUrl, breadcrumbItems),
      ],
    })
  );
});

// ---- 商品 ----
siteRouter.get('/products', (req, res) => {
  const settings = getSettings();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 10;
  const categorySlug = 'products';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';

  const conditions = ['c.slug = ?'];
  const params: string[] = [categorySlug];
  if (q) {
    const search = articleSearchCondition(q);
    conditions.push(search.sql);
    params.push(...search.params);
  }
  const where = ` AND ${conditions.join(' AND ')}`;
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM articles a LEFT JOIN categories c ON c.id = a.category_id WHERE a.status = 'published'${where}`).get(...params) as { n: number }
  ).n;
  const items = db
    .prepare(`${PUBLISHED_SQL}${where} ORDER BY a.published_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as ArticleRow[];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const keep = { ...(q && { q }) };
  const pageLink = (p: number) => `/products?${new URLSearchParams({ ...keep, ...(p > 1 && { page: String(p) }) })}`.replace(/\?$/, '');
  const pageTitle = siteCopy(settings, 'nav_products');

  const body = `
<div class="page-head-band">
<section class="page-head">
  ${crumbs([{ label: siteCopy(settings, 'nav_home'), href: '/' }, { label: pageTitle }])}
  <h1>${esc(pageTitle)}</h1>
  <form class="site-search" action="/products" method="get" role="search">
    <input type="search" name="q" value="${esc(q)}" placeholder="搜索商品…" aria-label="搜索商品">
    <button type="submit">搜索</button>
  </form>
  ${q ? `<p class="filter-state">「${esc(q)}」的搜索结果,共 ${total} 篇 <a href="/products">清除筛选</a></p>` : ''}
</section>
</div>
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
        <div class="meta-line">${esc(a.category_name || pageTitle)}${a.author_name ? ` · ${esc(a.author_name)}` : ''} · ${a.views} 次浏览</div>
      </div>
      <div class="row-thumb">${cover(a, 140)}</div>
    </a>`).join('')}
  </div>` : `<div class="empty-panel">
    <p class="empty">${q ? '没有找到相关内容,换个关键词试试。' : '暂无已发布的产品介绍。'}</p>
    ${q ? '' : `<a class="btn-primary" href="/contact">${esc(siteCopy(settings, 'nav_contact'))}</a>`}
  </div>`}
  ${totalPages > 1 ? `<nav class="pager" aria-label="分页">
    ${page > 1 ? `<a href="${pageLink(page - 1)}">← 上一页</a>` : '<span></span>'}
    <span class="pager-info">${page} / ${totalPages}</span>
    ${page < totalPages ? `<a href="${pageLink(page + 1)}">下一页 →</a>` : '<span></span>'}
  </nav>` : ''}
</section>`;

  const listParams = new URLSearchParams();
  if (page > 1) listParams.set('page', String(page));
  const listQs = listParams.toString();
  const canonicalPath = `/products${listQs ? `?${listQs}` : ''}`;
  res.send(
    layout({
      req,
      title: sitePageTitle(settings, pageTitle),
      settings,
      body,
      active: 'products',
      canonicalPath,
      noindex: Boolean(q),
      prevUrl: page > 1 ? pageLink(page - 1) : undefined,
      nextUrl: page < totalPages ? pageLink(page + 1) : undefined,
    })
  );
});

// ---- 联系我们 ----
siteRouter.get('/contact', (req, res) => {
  const settings = getSettings();
  const pageTitle = siteCopy(settings, 'contact_title');
  const body = `
<div class="page-head-band">
<section class="page-head">
  ${crumbs([{ label: siteCopy(settings, 'nav_home'), href: '/' }, { label: pageTitle }])}
  <h1>${esc(pageTitle)}</h1>
  <p class="hero-sub" style="margin-bottom:0">${esc(siteCopy(settings, 'contact_intro'))}</p>
</section>
</div>
<section class="section contact-section">
  <form class="contact-form" id="contact-form" data-success="${esc(siteCopy(settings, 'contact_success'))}">
    <input type="text" name="website" class="contact-honeypot" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="contact-grid">
      <label class="contact-field">
        <span>${esc(siteCopy(settings, 'contact_name_label'))} *</span>
        <input type="text" name="name" required maxlength="80" autocomplete="name">
      </label>
      <label class="contact-field">
        <span>${esc(siteCopy(settings, 'contact_phone_label'))} *</span>
        <input type="tel" name="phone" required maxlength="40" autocomplete="tel">
      </label>
      <label class="contact-field">
        <span>${esc(siteCopy(settings, 'contact_email_label'))}</span>
        <input type="email" name="email" maxlength="120" autocomplete="email">
      </label>
      <label class="contact-field">
        <span>${esc(siteCopy(settings, 'contact_company_label'))}</span>
        <input type="text" name="company" maxlength="120" autocomplete="organization">
      </label>
    </div>
    <label class="contact-field">
      <span>${esc(siteCopy(settings, 'contact_message_label'))} *</span>
      <textarea name="message" required maxlength="2000" rows="6"></textarea>
    </label>
    ${siteCopy(settings, 'contact_reply_hint') ? `<p class="contact-hint">${esc(siteCopy(settings, 'contact_reply_hint'))}</p>` : ''}
    <p id="contact-msg" class="contact-msg" hidden></p>
    <button type="submit" class="btn-primary">${esc(siteCopy(settings, 'contact_submit'))}</button>
  </form>
</section>
<script src="/contact.js" defer></script>`;

  res.send(
    layout({
      req,
      title: sitePageTitle(settings, pageTitle),
      settings,
      body,
      active: 'contact',
      canonicalPath: '/contact',
      description: siteCopy(settings, 'contact_intro'),
    })
  );
});

// ---- RSS 订阅 ----
siteRouter.get('/feed.xml', (req, res) => {
  const settings = getSettings();
  const base = siteBaseUrl(req, settings);
  const items = db
    .prepare(`${PUBLISHED_SQL} ORDER BY a.published_at DESC LIMIT 20`)
    .all() as unknown as ArticleRow[];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(siteCopy(settings, 'site_name'))}</title>
  <link>${base}/</link>
  <description>${esc(siteCopy(settings, 'site_description'))}</description>
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
  const settings = getSettings();
  const base = siteBaseUrl(req, settings);
  const today = new Date().toISOString().slice(0, 10);
  const articles = db
    .prepare(`SELECT slug, updated_at FROM articles WHERE status = 'published' ORDER BY published_at DESC`)
    .all() as { slug: string; updated_at: string }[];
  const urls: { loc: string; priority: string; changefreq: string; lastmod?: string }[] = [
    { loc: `${base}/`, priority: '1.0', changefreq: 'weekly', lastmod: today },
    { loc: `${base}/news`, priority: '0.9', changefreq: 'daily', lastmod: today },
    { loc: `${base}/products`, priority: '0.8', changefreq: 'weekly', lastmod: today },
    { loc: `${base}/contact`, priority: '0.6', changefreq: 'monthly' },
    ...publishedCategories().map((c) => ({
      loc: `${base}/news?category=${encodeURIComponent(c.slug)}`,
      priority: '0.7',
      changefreq: 'weekly',
      lastmod: today,
    })),
    ...articles.map((a) => ({
      loc: `${base}/news/${encodeURIComponent(a.slug)}`,
      priority: '0.8',
      changefreq: 'monthly',
      lastmod: a.updated_at.slice(0, 10),
    })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;
  res.type('application/xml').send(xml);
});

// ---- robots.txt ----
siteRouter.get('/robots.txt', (req, res) => {
  const base = siteBaseUrl(req, getSettings());
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
      req,
      title: sitePageTitle(settings, '页面不存在'),
      settings,
      active: 'news',
      canonicalPath: req.path,
      noindex: true,
      body: `<section class="page-head"><h1>404</h1><p class="empty">您访问的页面不存在。</p><p style="margin-top:24px"><a class="btn-primary" href="/">返回${esc(siteCopy(settings, 'nav_home'))}</a></p></section>`,
    })
  );
});
