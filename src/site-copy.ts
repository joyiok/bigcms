/** 前台官网文案设置(默认值仅用于数据库初始化/补全,模板不硬编码) */
export const SITE_COPY_DEFAULTS: Record<string, string> = {
  site_name: 'BigCMS 企业站点',
  site_description: '基于 TypeScript 的企业级内容管理系统',
  site_keywords: 'CMS,企业,内容管理',
  icp_number: '',
  site_footer_credit: 'Powered by BigCMS',
  nav_home: '首页',
  nav_news: '新闻中心',
  hero_cta: '浏览最新动态',
  hero_notices_title: '公司要闻',
  home_news_title: '最新动态',
  home_categories_title: '栏目',
  home_more_link: '全部动态 →',
  cta_title: '继续关注最新动态',
  cta_text: '公司新闻、产品发布与技术文章,都沉淀在同一个新闻中心。',
  cta_button: '查看新闻中心',
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
  icp_number: 'ICP 备案号',
  site_footer_credit: '页脚署名(如 Powered by …)',
  nav_home: '导航「首页」文案',
  nav_news: '导航「新闻中心」文案',
  hero_cta: '首页主按钮文案',
  hero_notices_title: '首页要闻侧栏标题',
  home_news_title: '首页「最新动态」区块标题',
  home_categories_title: '首页「栏目」区块标题',
  home_more_link: '首页「全部动态」链接文案',
  cta_title: '首页底部 CTA 标题',
  cta_text: '首页底部 CTA 描述',
  cta_button: '首页底部 CTA 按钮文案',
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
}
