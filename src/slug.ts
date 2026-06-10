/** 由标题生成 URL slug;纯中文等无法转写时回退为时间戳。 */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/[一-龥]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || `post-${Date.now()}`;
}
