/**
 * 全站统一的 Markdown 渲染(前台文章页与后台预览共用)。
 * 安全策略:正文中的原始 HTML 一律转义输出,链接/图片仅放行
 * http(s)/mailto 与相对路径,防止编辑或 AI 写入内容造成存储型 XSS。
 */
import { Marked } from 'marked';

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 危险协议(javascript:、data:、vbscript: 等)与协议相对地址一律拒绝 */
function safeUrl(href: string | null | undefined): string | null {
  const url = String(href ?? '').trim();
  if (!url) return null;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null;
  return url;
}

const md = new Marked();
md.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return inner;
      return `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${inner}</a>`;
    },
    image({ href, title, text }) {
      const url = safeUrl(href);
      if (!url) return escapeHtml(text);
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
    },
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src ?? '', { async: false }) as string;
}
