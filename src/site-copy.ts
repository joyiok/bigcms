/** 前台官网文案设置(默认值仅用于数据库初始化/补全,模板不硬编码) */
export const SITE_COPY_DEFAULTS: Record<string, string> = {
  site_name: '苏州栖岭信息技术有限公司',
  site_description: '让信息互联 · 与自然共生',
  site_keywords: 'QIpeak,栖岭,信息技术,云计算,物联网',
  site_url: '',
  site_logo: '/brand/logo.png',
  icp_number: '',
  site_footer_credit: 'Powered by BigCMS',
  nav_home: '首页',
  nav_news: '新闻中心',
  hero_title: '',
  hero_cta: '浏览最新动态',
  hero_secondary_cta: '联系我们',
  hero_secondary_href: '/contact',
  hero_quick_title: '快速入口',
  hero_image: '',
  home_value_1: '栖岭峰顶 · 追求行业顶尖技术与卓越质量的高度',
  home_value_2: '信息互联 · 将零散的信息节点高效率连接成有机整体',
  home_value_3: '与自然共生 · 以绿色计算与数据洞察助力生态和谐共融',
  home_about_title: '关于栖岭',
  home_about_text:
    '苏州栖岭信息技术有限公司 (QIpeak) 致力于将先进的云计算与物联感知技术融为一体,通过绿色计算与数据洞察,辅助企业与社会环境达成和谐共融的生态闭环。',
  hero_notices_title: '公司要闻',
  home_news_title: '前沿洞察',
  home_products_title: '产品',
  home_products_more_link: '查看全部产品 →',
  home_categories_title: '栏目',
  home_more_link: '全部动态 →',
  cta_title: '继续关注最新动态',
  cta_text: '公司新闻、产品发布与技术文章,都沉淀在同一个新闻中心。',
  cta_button: '查看新闻中心',
  cta_href: '/news',
  contact_reply_hint: '',
  footer_categories_title: '栏目',
  footer_links_title: '快速入口',
  nav_products: '商品',
  nav_contact: '联系我们',
  contact_title: '联系我们',
  contact_intro: '如有合作或咨询需求,请填写以下表单,我们会尽快与您联系。',
  contact_name_label: '姓名',
  contact_phone_label: '电话',
  contact_email_label: '邮箱',
  contact_company_label: '公司',
  contact_message_label: '留言',
  contact_submit: '提交',
  contact_success: '提交成功,我们会尽快与您联系。',
};

export const SITE_COPY_LABELS: Record<string, string> = {
  site_name: '站点名称(页眉 wordmark、页脚品牌、首页标题)',
  site_description: '站点描述(首页副标题、页脚简介)',
  site_keywords: 'SEO 关键词,逗号分隔',
  site_url: '站点 URL(如 https://www.example.com,用于 canonical、sitemap、分享图绝对地址)',
  site_logo: '站点 Logo URL(用于 Open Graph 默认图与 Organization 结构化数据)',
  icp_number: 'ICP 备案号',
  site_footer_credit: '页脚署名(如 Powered by …)',
  nav_home: '导航「首页」文案',
  nav_news: '导航「新闻中心」文案',
  hero_title: '首页主标题(留空则用站点名称;填写后页眉仍显示站点名称)',
  hero_cta: '首页主按钮文案',
  hero_secondary_cta: '首页次按钮文案(留空则用「联系我们」)',
  hero_secondary_href: '首页次按钮链接',
  hero_quick_title: '无要闻时右侧快速入口标题',
  hero_image: '首页右侧主图 URL(媒体库地址,优先于快速入口)',
  home_value_1: '首页能力点 1(留空不显示)',
  home_value_2: '首页能力点 2',
  home_value_3: '首页能力点 3',
  home_about_title: '首页「关于」标题(留空不显示区块)',
  home_about_text: '首页「关于」正文',
  hero_notices_title: '首页要闻侧栏标题',
  home_news_title: '首页「前沿洞察」区块标题',
  home_products_title: '首页「产品」区块标题',
  home_products_more_link: '首页「查看全部产品」链接',
  home_categories_title: '首页「栏目」区块标题',
  home_more_link: '首页「全部动态」链接文案',
  cta_title: '首页底部 CTA 标题',
  cta_text: '首页底部 CTA 描述',
  cta_button: '首页底部 CTA 按钮文案',
  cta_href: '首页底部 CTA 按钮链接',
  contact_reply_hint: '联系页回复时效说明(留空不显示)',
  footer_categories_title: '页脚栏目区标题',
  footer_links_title: '页脚快速入口区标题',
  nav_products: '导航「商品」文案',
  nav_contact: '导航「联系我们」文案',
  contact_title: '联系页标题',
  contact_intro: '联系页简介',
  contact_name_label: '表单「姓名」标签',
  contact_phone_label: '表单「电话」标签',
  contact_email_label: '表单「邮箱」标签',
  contact_company_label: '表单「公司」标签',
  contact_message_label: '表单「留言」标签',
  contact_submit: '联系表单提交按钮',
  contact_success: '联系表单提交成功提示',
};

export function siteCopy(settings: Record<string, string>, key: keyof typeof SITE_COPY_DEFAULTS | string): string {
  return settings[key] ?? '';
}

export function homeValueItems(settings: Record<string, string>): string[] {
  return (['home_value_1', 'home_value_2', 'home_value_3'] as const)
    .map((k) => siteCopy(settings, k).trim())
    .filter(Boolean);
}

/** 能力点文案支持「标题 · 描述」格式 */
export function parseValueItem(raw: string): { title: string; desc: string } {
  const sep = raw.indexOf(' · ');
  if (sep === -1) return { title: raw, desc: '' };
  return { title: raw.slice(0, sep).trim(), desc: raw.slice(sep + 3).trim() };
}

export function siteHref(settings: Record<string, string>, key: string, fallback: string): string {
  const href = siteCopy(settings, key).trim();
  if (!href) return fallback;
  if (href.startsWith('/') || href.startsWith('http://') || href.startsWith('https://')) return href;
  return fallback;
}

export function sitePageTitle(settings: Record<string, string>, pageTitle?: string): string {
  const name = siteCopy(settings, 'site_name');
  if (pageTitle && name) return `${pageTitle} · ${name}`;
  return pageTitle || name;
}

/** 为既有数据库补全缺失的站点文案设置 */
export function ensureSiteCopySettings(db: { prepare: (sql: string) => { get: (key: string) => unknown; run: (...args: string[]) => void } }): void {
  const get = db.prepare(`SELECT 1 FROM settings WHERE key = ?`);
  const insert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(SITE_COPY_DEFAULTS)) {
    if (!get.get(key)) insert.run(key, value);
  }
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'home_news_title' AND value = '最新动态'`).run('前沿洞察');
  for (const key of ['home_value_1', 'home_value_2', 'home_value_3'] as const) {
    db.prepare(`UPDATE settings SET value = ? WHERE key = ? AND value = ''`).run(SITE_COPY_DEFAULTS[key], key);
  }
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'site_logo' AND (value = '' OR value IS NULL)`).run(
    SITE_COPY_DEFAULTS.site_logo
  );
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'home_about_title' AND value = ''`).run(
    SITE_COPY_DEFAULTS.home_about_title
  );
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'home_about_text' AND value = ''`).run(
    SITE_COPY_DEFAULTS.home_about_text
  );
}
