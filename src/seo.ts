import type { Request } from 'express';

/** 站点对外 URL(后台 site_url 优先,否则用当前请求) */
export function siteBaseUrl(req: Request, settings: Record<string, string>): string {
  const configured = settings.site_url?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  const host = req.get('host');
  if (!host) return '';
  return `${req.protocol}://${host}`;
}

export function absoluteUrl(base: string, pathname: string): string {
  if (!pathname) return base;
  if (/^https?:\/\//i.test(pathname)) return pathname;
  return `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

/** meta description 建议 ≤160 字 */
export function seoDescription(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

export function seoImageUrl(base: string, image?: string): string | undefined {
  const src = image?.trim();
  if (!src) return undefined;
  return absoluteUrl(base, src);
}

export function isoDateTime(sqliteUtc: string | null | undefined): string | undefined {
  if (!sqliteUtc) return undefined;
  const normalized = sqliteUtc.includes('T') ? sqliteUtc : sqliteUtc.replace(' ', 'T');
  const d = new Date(`${normalized}Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function jsonLdScript(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function organizationJsonLd(opts: {
  baseUrl: string;
  name: string;
  description: string;
  logo?: string;
}): Record<string, unknown> {
  const org: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: opts.name,
    url: opts.baseUrl,
    description: seoDescription(opts.description, 300),
  };
  if (opts.logo) org.logo = opts.logo;
  return org;
}

export function websiteJsonLd(opts: { baseUrl: string; name: string; description: string }): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: opts.name,
    url: opts.baseUrl,
    description: seoDescription(opts.description, 300),
    inLanguage: 'zh-CN',
    potentialAction: {
      '@type': 'SearchAction',
      target: `${opts.baseUrl}/news?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

export function articleJsonLd(opts: {
  baseUrl: string;
  canonicalPath: string;
  headline: string;
  description: string;
  image?: string;
  datePublished?: string;
  dateModified?: string;
  authorName?: string;
  publisherName: string;
  publisherLogo?: string;
}): Record<string, unknown> {
  const publisher: Record<string, unknown> = { '@type': 'Organization', name: opts.publisherName };
  if (opts.publisherLogo) publisher.logo = { '@type': 'ImageObject', url: opts.publisherLogo };

  const article: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: opts.headline,
    description: seoDescription(opts.description, 300),
    mainEntityOfPage: absoluteUrl(opts.baseUrl, opts.canonicalPath),
    url: absoluteUrl(opts.baseUrl, opts.canonicalPath),
    inLanguage: 'zh-CN',
    publisher,
  };
  if (opts.image) article.image = [opts.image];
  if (opts.datePublished) article.datePublished = opts.datePublished;
  if (opts.dateModified) article.dateModified = opts.dateModified;
  if (opts.authorName) article.author = { '@type': 'Person', name: opts.authorName };
  return article;
}

export function breadcrumbJsonLd(
  baseUrl: string,
  items: { name: string; path?: string }[]
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.path ? { item: absoluteUrl(baseUrl, item.path) } : {}),
    })),
  };
}
