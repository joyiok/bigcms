/* BigCMS 管理后台(原生 JS 单页应用) */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const state = { token: localStorage.getItem('bigcms_token') || '', user: null };

// ---------- 基础工具 ----------
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(`/api${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout(false);
    throw new Error(data.error || '登录已过期');
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast-item${isError ? ' error' : ''}`;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(s) {
  return s ? s.replace('T', ' ').slice(0, 16) : '-';
}

/** SQLite UTC 时间(YYYY-MM-DD HH:MM:SS)→ datetime-local 输入框的本地时间值 */
function utcToLocalInput(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** SQLite UTC 时间 → 本地可读时间 */
function utcToLocalText(s) {
  if (!s) return '-';
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', { hour12: false }).slice(0, 16);
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function openModal(html) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  $('#modal-root').appendChild(mask);
  return mask;
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    const mask = openModal(`
      <h3>确认操作</h3>
      <p style="margin-bottom:18px">${esc(message)}</p>
      <div class="form-actions">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn danger" data-act="ok">确认</button>
      </div>`);
    mask.querySelector('[data-act=ok]').onclick = () => { mask.remove(); resolve(true); };
    mask.querySelector('[data-act=cancel]').onclick = () => { mask.remove(); resolve(false); };
  });
}

const STATUS_TEXT = { draft: '草稿', published: '已发布', archived: '已归档' };
const ROLE_TEXT = { admin: '管理员', editor: '编辑', viewer: '只读' };

// ---------- 登录 / 登出 ----------
function logout(callApi = true) {
  state.token = '';
  state.user = null;
  localStorage.removeItem('bigcms_token');
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  void callApi;
}

async function boot() {
  if (state.token) {
    try {
      const { user } = await api('/auth/me');
      state.user = user;
      showApp();
      return;
    } catch { /* token 失效,落到登录页 */ }
  }
  $('#login-view').classList.remove('hidden');
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#me-name').textContent = `${state.user.display_name || state.user.username}(${ROLE_TEXT[state.user.role]})`;
  document.querySelectorAll('#nav a[data-role=admin]').forEach((a) => {
    a.classList.toggle('hidden', state.user.role !== 'admin');
  });
  document.querySelectorAll('#nav a[data-role=editor]').forEach((a) => {
    a.classList.toggle('hidden', !['admin', 'editor'].includes(state.user.role));
  });
  route();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: { username: $('#login-username').value.trim(), password: $('#login-password').value },
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('bigcms_token', data.token);
    location.hash = '#/dashboard';
    showApp();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-logout').addEventListener('click', () => logout());
$('#btn-password').addEventListener('click', () => {
  const mask = openModal(`
    <h3>修改密码</h3>
    <form class="form-grid" id="pw-form">
      <div class="form-row"><label>原密码</label><input type="password" name="old_password" required></div>
      <div class="form-row"><label>新密码(至少 6 位)</label><input type="password" name="new_password" minlength="6" required></div>
      <div class="form-actions">
        <button type="button" class="btn" data-act="cancel">取消</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`);
  mask.querySelector('[data-act=cancel]').onclick = () => mask.remove();
  mask.querySelector('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/auth/password', { method: 'PUT', body: Object.fromEntries(fd) });
      toast('密码已修改');
      mask.remove();
    } catch (err) { toast(err.message, true); }
  };
});

// ---------- 路由 ----------
const pages = {};

function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  const page = pages[name] || pages.dashboard;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#main').innerHTML = '<p class="muted">加载中…</p>';
  page().catch((err) => { $('#main').innerHTML = `<p class="muted">${esc(err.message)}</p>`; });
}
window.addEventListener('hashchange', route);

function pagination(total, page, pageSize, onPage) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const div = document.createElement('div');
  div.className = 'pagination';
  div.innerHTML = `
    <button class="btn small" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="muted">第 ${page} / ${totalPages} 页,共 ${total} 条</span>
    <button class="btn small" data-p="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>`;
  div.querySelectorAll('button').forEach((b) => (b.onclick = () => onPage(Number(b.dataset.p))));
  return div;
}

const canEdit = () => ['admin', 'editor'].includes(state.user.role);

// ---------- 仪表盘 ----------
pages.dashboard = async () => {
  const s = await api('/dashboard/stats');
  $('#main').innerHTML = `
    <div class="page-header"><h2>仪表盘</h2></div>
    <div class="stats-grid">
      ${[
        ['文章总数', s.articles_total], ['已发布', s.articles_published], ['草稿', s.articles_draft],
        ['总浏览量', s.total_views], ['分类', s.categories], ['标签', s.tags], ['媒体文件', s.media], ['用户', s.users],
        ['销售线索', s.contacts], ['新留言', s.contacts_new],
      ].map(([label, num]) => `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`).join('')}
    </div>
    <div class="card">
      <h3 style="margin-bottom:12px">最近更新的文章</h3>
      <table><thead><tr><th>标题</th><th>状态</th><th>更新时间</th></tr></thead><tbody>
        ${s.recent_articles.map((a) => `<tr><td><a href="#/articles" style="color:var(--primary);text-decoration:none">${esc(a.title)}</a></td><td><span class="badge ${a.status}">${STATUS_TEXT[a.status]}</span></td><td>${fmtDate(a.updated_at)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">暂无</td></tr>'}
      </tbody></table>
    </div>
    <div class="card">
      <h3 style="margin-bottom:12px">最近操作</h3>
      <table><thead><tr><th>用户</th><th>操作</th><th>对象</th><th>时间</th></tr></thead><tbody>
        ${s.recent_logs.map((l) => `<tr><td>${esc(l.username)}</td><td>${esc(l.action)}</td><td>${esc(l.target)}</td><td>${fmtDate(l.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无</td></tr>'}
      </tbody></table>
    </div>`;
};

// ---------- 文章 ----------
pages.articles = async (query = { page: 1 }) => {
  const params = new URLSearchParams({ page: query.page || 1, page_size: 10 });
  if (query.status) params.set('status', query.status);
  if (query.q) params.set('q', query.q);
  if (query.category_id) params.set('category_id', query.category_id);
  const [data, cats] = await Promise.all([api(`/articles?${params}`), api('/categories')]);

  $('#main').innerHTML = `
    <div class="page-header">
      <h2>文章管理</h2>
      ${canEdit() ? '<button class="btn primary" id="btn-new">+ 新建文章</button>' : ''}
    </div>
    <div class="toolbar">
      <input type="search" id="f-q" placeholder="搜索标题…" value="${esc(query.q || '')}">
      <select id="f-status">
        <option value="">全部状态</option>
        ${Object.entries(STATUS_TEXT).map(([v, t]) => `<option value="${v}" ${query.status === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <select id="f-cat">
        <option value="">全部分类</option>
        ${cats.items.map((c) => `<option value="${c.id}" ${Number(query.category_id) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <button class="btn" id="btn-filter">筛选</button>
    </div>
    <table><thead><tr><th>标题</th><th>分类</th><th>标签</th><th>状态</th><th>作者</th><th>浏览</th><th>更新时间</th><th>操作</th></tr></thead>
    <tbody>
      ${data.items.map((a) => `<tr>
        <td>${esc(a.title)}<div class="muted small">/${esc(a.slug)}</div></td>
        <td>${esc(a.category_name || '-')}</td>
        <td>${a.tags.map((t) => esc(t.name)).join(', ') || '-'}</td>
        <td><span class="badge ${a.status}">${STATUS_TEXT[a.status]}</span>${a.scheduled_at && a.status === 'draft' ? `<span class="badge scheduled" title="定时发布:${esc(utcToLocalText(a.scheduled_at))}">定时</span>` : ''}</td>
        <td>${esc(a.author_name || '-')}</td>
        <td>${a.views}</td>
        <td>${fmtDate(a.updated_at)}</td>
        <td>${canEdit() ? `<button class="btn small" data-edit="${a.id}">编辑</button> <button class="btn small danger" data-del="${a.id}">删除</button>` : '-'}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无文章</td></tr>'}
    </tbody></table>
    <div id="pager"></div>`;

  $('#pager').appendChild(pagination(data.total, data.page, data.page_size, (p) => pages.articles({ ...query, page: p })));
  $('#btn-filter').onclick = () => pages.articles({ page: 1, q: $('#f-q').value.trim(), status: $('#f-status').value, category_id: $('#f-cat').value });
  $('#f-q').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-filter').click(); };
  if (canEdit()) {
    $('#btn-new').onclick = () => articleEditor(null, cats.items, query);
    document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => {
      articleEditor(await api(`/articles/${b.dataset.edit}`), cats.items, query);
    }));
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('确定删除这篇文章吗?此操作不可恢复。'))) return;
      try { await api(`/articles/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除'); pages.articles(query); }
      catch (err) { toast(err.message, true); }
    }));
  }
};

/** 媒体库图片选择器,选中后回调图片 URL */
async function mediaPicker(onSelect) {
  const data = await api('/media?page=1&page_size=100');
  const images = data.items.filter((m) => m.mime_type.startsWith('image/'));
  const mask = openModal(`
    <h3>从媒体库选择图片</h3>
    ${images.length ? `<div class="media-grid picker">
      ${images.map((m) => `<button type="button" class="media-item" data-url="${esc(m.url)}" title="${esc(m.original_name)}">
        <div class="thumb"><img src="${esc(m.thumb_url || m.url)}" alt="" loading="lazy"></div>
        <div class="info"><div class="name">${esc(m.original_name)}</div></div>
      </button>`).join('')}
    </div>` : '<p class="muted">媒体库中还没有图片,请先在「媒体库」上传。</p>'}
    <div class="form-actions"><button type="button" class="btn" data-act="cancel">取消</button></div>`);
  mask.querySelector('[data-act=cancel]').onclick = () => mask.remove();
  mask.querySelectorAll('[data-url]').forEach((b) => (b.onclick = () => { mask.remove(); onSelect(b.dataset.url); }));
}

async function articleEditor(article, categories, backQuery) {
  const allTags = (await api('/tags')).items;
  const selectedTagIds = new Set((article?.tags || []).map((t) => t.id));
  const mask = openModal(`
    <h3>${article ? '编辑文章' : '新建文章'}</h3>
    <form class="form-grid" id="article-form">
      <div class="form-row"><label>标题 *</label><input name="title" required value="${esc(article?.title || '')}"></div>
      <div class="form-cols">
        <div class="form-row"><label>Slug(URL 标识,留空自动生成)</label><input name="slug" value="${esc(article?.slug || '')}"></div>
        <div class="form-row"><label>状态</label>
          <select name="status">${Object.entries(STATUS_TEXT).map(([v, t]) => `<option value="${v}" ${article?.status === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
      </div>
      <div class="form-cols">
        <div class="form-row"><label>分类</label>
          <select name="category_id">
            <option value="">无分类</option>
            ${categories.map((c) => `<option value="${c.id}" ${article?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row"><label>封面图 URL</label>
          <div class="input-with-btn">
            <input name="cover_image" value="${esc(article?.cover_image || '')}">
            <button type="button" class="btn" id="btn-pick-cover">媒体库</button>
          </div>
        </div>
      </div>
      <div class="form-row"><label>定时发布(仅草稿生效,到点自动发布;留空不定时)</label>
        <input type="datetime-local" name="scheduled_at" value="${esc(utcToLocalInput(article?.scheduled_at))}">
      </div>
      <div class="form-row"><label>标签</label>
        <div>${allTags.map((t) => `<label class="chip" style="cursor:pointer"><input type="checkbox" name="tag" value="${t.id}" ${selectedTagIds.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('') || '<span class="muted">暂无标签,可在「标签管理」中创建</span>'}</div>
      </div>
      <div class="form-row"><label>摘要</label><textarea name="summary" rows="2">${esc(article?.summary || '')}</textarea></div>
      <div class="form-row">
        <div class="editor-toolbar">
          <label>正文(支持 Markdown)</label>
          <div class="editor-tools">
            <button type="button" class="btn small" id="btn-insert-img">插入图片</button>
            <div class="tab-group" role="tablist">
              <button type="button" class="tab active" id="tab-edit">编辑</button>
              <button type="button" class="tab" id="tab-preview">预览</button>
            </div>
          </div>
        </div>
        <textarea name="content" rows="12">${esc(article?.content || '')}</textarea>
        <div class="md-preview prose hidden"></div>
      </div>
      <div class="form-actions">
        ${article ? '<button type="button" class="btn" id="btn-revisions" style="margin-right:auto">历史版本</button>' : ''}
        <button type="button" class="btn" data-act="cancel">取消</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`);
  mask.querySelector('[data-act=cancel]').onclick = () => mask.remove();
  if (article) {
    mask.querySelector('#btn-revisions').onclick = async () => {
      const { items } = await api(`/articles/${article.id}/revisions`);
      const revMask = openModal(`
        <h3>历史版本(每次保存前自动快照,最多 20 版)</h3>
        ${items.length ? `<table><thead><tr><th>#</th><th>标题</th><th>状态</th><th>正文长度</th><th>保存者</th><th>时间</th><th></th></tr></thead><tbody>
          ${items.map((r) => `<tr>
            <td class="muted">${r.id}</td><td>${esc(r.title)}</td><td><span class="badge ${r.status}">${STATUS_TEXT[r.status] || r.status}</span></td>
            <td>${r.content_length} 字符</td><td>${esc(r.saved_by || '-')}</td><td>${utcToLocalText(r.created_at)}</td>
            <td><button class="btn small" data-restore="${r.id}">恢复</button></td>
          </tr>`).join('')}
        </tbody></table>` : '<p class="muted">还没有修订记录,保存一次后就会生成。</p>'}
        <div class="form-actions"><button type="button" class="btn" data-act="cancel">关闭</button></div>`);
      revMask.querySelector('[data-act=cancel]').onclick = () => revMask.remove();
      revMask.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => {
        if (!(await confirmDialog('恢复到该版本?将覆盖当前的标题/摘要/正文/封面(当前版会先自动快照)。'))) return;
        try {
          await api(`/articles/${article.id}/revisions/${b.dataset.restore}/restore`, { method: 'POST' });
          toast('已恢复');
          revMask.remove();
          mask.remove();
          pages.articles(backQuery);
        } catch (err) { toast(err.message, true); }
      }));
    };
  }

  const contentEl = mask.querySelector('textarea[name=content]');
  const previewEl = mask.querySelector('.md-preview');
  const tabEdit = mask.querySelector('#tab-edit');
  const tabPreview = mask.querySelector('#tab-preview');
  tabEdit.onclick = () => {
    tabEdit.classList.add('active'); tabPreview.classList.remove('active');
    contentEl.classList.remove('hidden'); previewEl.classList.add('hidden');
  };
  tabPreview.onclick = async () => {
    tabPreview.classList.add('active'); tabEdit.classList.remove('active');
    contentEl.classList.add('hidden'); previewEl.classList.remove('hidden');
    previewEl.innerHTML = '<p class="muted">渲染中…</p>';
    try {
      const { html } = await api('/articles/preview', { method: 'POST', body: { content: contentEl.value } });
      previewEl.innerHTML = html || '<p class="muted">(正文为空)</p>';
    } catch (err) { previewEl.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  };
  mask.querySelector('#btn-pick-cover').onclick = () => mediaPicker((url) => {
    mask.querySelector('input[name=cover_image]').value = url;
  });
  mask.querySelector('#btn-insert-img').onclick = () => mediaPicker((url) => {
    tabEdit.onclick();
    const pos = contentEl.selectionStart ?? contentEl.value.length;
    const md = `![图片](${url})`;
    contentEl.value = contentEl.value.slice(0, pos) + md + contentEl.value.slice(contentEl.selectionEnd ?? pos);
    contentEl.focus();
    contentEl.selectionStart = contentEl.selectionEnd = pos + md.length;
  });
  mask.querySelector('#article-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      title: fd.get('title'),
      slug: fd.get('slug') || undefined,
      status: fd.get('status'),
      category_id: fd.get('category_id') ? Number(fd.get('category_id')) : null,
      cover_image: fd.get('cover_image'),
      summary: fd.get('summary'),
      content: fd.get('content'),
      scheduled_at: fd.get('scheduled_at') ? new Date(fd.get('scheduled_at')).toISOString() : null,
      tag_ids: [...e.target.querySelectorAll('input[name=tag]:checked')].map((i) => Number(i.value)),
    };
    try {
      if (article) await api(`/articles/${article.id}`, { method: 'PUT', body });
      else await api('/articles', { method: 'POST', body });
      toast('已保存');
      mask.remove();
      pages.articles(backQuery);
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- 分类 ----------
pages.categories = async () => {
  const data = await api('/categories');
  $('#main').innerHTML = `
    <div class="page-header"><h2>分类管理</h2>${canEdit() ? '<button class="btn primary" id="btn-new">+ 新建分类</button>' : ''}</div>
    <table><thead><tr><th>名称</th><th>Slug</th><th>描述</th><th>文章数</th><th>操作</th></tr></thead><tbody>
      ${data.items.map((c) => `<tr>
        <td>${esc(c.name)}</td><td class="muted">${esc(c.slug)}</td><td>${esc(c.description || '-')}</td><td>${c.article_count}</td>
        <td>${canEdit() ? `<button class="btn small" data-edit="${c.id}">编辑</button> <button class="btn small danger" data-del="${c.id}">删除</button>` : '-'}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无分类</td></tr>'}
    </tbody></table>`;

  const editor = (cat) => {
    const mask = openModal(`
      <h3>${cat ? '编辑分类' : '新建分类'}</h3>
      <form class="form-grid" id="cat-form">
        <div class="form-row"><label>名称 *</label><input name="name" required value="${esc(cat?.name || '')}"></div>
        <div class="form-row"><label>Slug(留空自动生成)</label><input name="slug" value="${esc(cat?.slug || '')}"></div>
        <div class="form-row"><label>描述</label><input name="description" value="${esc(cat?.description || '')}"></div>
        <div class="form-actions">
          <button type="button" class="btn" data-act="cancel">取消</button>
          <button type="submit" class="btn primary">保存</button>
        </div>
      </form>`);
    mask.querySelector('[data-act=cancel]').onclick = () => mask.remove();
    mask.querySelector('#cat-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (!body.slug) delete body.slug;
      try {
        if (cat) await api(`/categories/${cat.id}`, { method: 'PUT', body });
        else await api('/categories', { method: 'POST', body });
        toast('已保存'); mask.remove(); pages.categories();
      } catch (err) { toast(err.message, true); }
    };
  };

  if (canEdit()) {
    $('#btn-new').onclick = () => editor(null);
    document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editor(data.items.find((c) => c.id === Number(b.dataset.edit)))));
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('确定删除该分类吗?'))) return;
      try { await api(`/categories/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除'); pages.categories(); }
      catch (err) { toast(err.message, true); }
    }));
  }
};

// ---------- 标签 ----------
pages.tags = async () => {
  const data = await api('/tags');
  $('#main').innerHTML = `
    <div class="page-header"><h2>标签管理</h2></div>
    ${canEdit() ? `<div class="toolbar"><input id="tag-name" placeholder="输入标签名,回车创建"><button class="btn primary" id="btn-add">添加</button></div>` : ''}
    <div class="card">
      ${data.items.map((t) => `<span class="chip">${esc(t.name)} <span class="muted small">(${t.article_count})</span>${canEdit() ? `<button data-del="${t.id}" title="删除">×</button>` : ''}</span>`).join('') || '<span class="muted">暂无标签</span>'}
    </div>`;
  if (canEdit()) {
    const add = async () => {
      const name = $('#tag-name').value.trim();
      if (!name) return;
      try { await api('/tags', { method: 'POST', body: { name } }); toast('已添加'); pages.tags(); }
      catch (err) { toast(err.message, true); }
    };
    $('#btn-add').onclick = add;
    $('#tag-name').onkeydown = (e) => { if (e.key === 'Enter') add(); };
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('确定删除该标签吗?'))) return;
      try { await api(`/tags/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除'); pages.tags(); }
      catch (err) { toast(err.message, true); }
    }));
  }
};

// ---------- 媒体库 ----------
pages.media = async (page = 1) => {
  const data = await api(`/media?page=${page}&page_size=24`);
  $('#main').innerHTML = `
    <div class="page-header">
      <h2>媒体库</h2>
      ${canEdit() ? '<label class="btn primary">+ 上传文件<input type="file" id="file-input" multiple hidden></label>' : ''}
    </div>
    <div class="media-grid">
      ${data.items.map((m) => `<div class="media-item">
        <div class="thumb">${m.mime_type.startsWith('image/') ? `<img src="${esc(m.thumb_url || m.url)}" alt="" loading="lazy">` : '📄'}</div>
        <div class="info">
          <div class="name" title="${esc(m.original_name)}">${esc(m.original_name)}</div>
          <div class="muted">${fmtSize(m.size)} · ${esc(m.uploader_name || '')}</div>
          <div style="margin-top:6px;display:flex;gap:6px">
            <button class="btn small" data-copy="${esc(m.url)}">复制链接</button>
            ${canEdit() ? `<button class="btn small danger" data-del="${m.id}">删除</button>` : ''}
          </div>
        </div>
      </div>`).join('') || '<p class="muted">暂无文件</p>'}
    </div>
    <div id="pager"></div>`;
  $('#pager').appendChild(pagination(data.total, data.page, data.page_size, (p) => pages.media(p)));

  document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => {
    navigator.clipboard.writeText(location.origin + b.dataset.copy).then(() => toast('链接已复制'));
  }));
  if (canEdit()) {
    $('#file-input').onchange = async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      let ok = 0;
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        try { await api('/media', { method: 'POST', body: fd }); ok++; }
        catch (err) { toast(`${file.name}:${err.message}`, true); }
      }
      if (ok) toast(`已上传 ${ok} 个文件`);
      pages.media(page);
    };
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('确定删除该文件吗?'))) return;
      try { await api(`/media/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除'); pages.media(page); }
      catch (err) { toast(err.message, true); }
    }));
  }
};

// ---------- 用户 ----------
pages.users = async () => {
  const data = await api('/users');
  $('#main').innerHTML = `
    <div class="page-header"><h2>用户管理</h2><button class="btn primary" id="btn-new">+ 新建用户</button></div>
    <table><thead><tr><th>用户名</th><th>姓名</th><th>邮箱</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
      ${data.items.map((u) => `<tr>
        <td>${esc(u.username)}</td><td>${esc(u.display_name || '-')}</td><td>${esc(u.email)}</td>
        <td><span class="badge ${u.role}">${ROLE_TEXT[u.role]}</span></td>
        <td><span class="badge ${u.status}">${u.status === 'active' ? '正常' : '已禁用'}</span></td>
        <td>${fmtDate(u.created_at)}</td>
        <td><button class="btn small" data-edit="${u.id}">编辑</button> <button class="btn small danger" data-del="${u.id}">删除</button></td>
      </tr>`).join('')}
    </tbody></table>`;

  const editor = (user) => {
    const mask = openModal(`
      <h3>${user ? `编辑用户:${esc(user.username)}` : '新建用户'}</h3>
      <form class="form-grid" id="user-form">
        ${user ? '' : '<div class="form-row"><label>用户名 *</label><input name="username" required></div>'}
        <div class="form-row"><label>邮箱 *</label><input type="email" name="email" required value="${esc(user?.email || '')}"></div>
        <div class="form-row"><label>姓名</label><input name="display_name" value="${esc(user?.display_name || '')}"></div>
        <div class="form-cols">
          <div class="form-row"><label>角色</label>
            <select name="role">${Object.entries(ROLE_TEXT).map(([v, t]) => `<option value="${v}" ${user?.role === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          </div>
          <div class="form-row"><label>状态</label>
            <select name="status"><option value="active" ${user?.status === 'active' ? 'selected' : ''}>正常</option><option value="disabled" ${user?.status === 'disabled' ? 'selected' : ''}>禁用</option></select>
          </div>
        </div>
        <div class="form-row"><label>${user ? '重置密码(留空不修改)' : '密码 *(至少 6 位)'}</label><input type="password" name="password" minlength="6" ${user ? '' : 'required'}></div>
        <div class="form-actions">
          <button type="button" class="btn" data-act="cancel">取消</button>
          <button type="submit" class="btn primary">保存</button>
        </div>
      </form>`);
    mask.querySelector('[data-act=cancel]').onclick = () => mask.remove();
    mask.querySelector('#user-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (user && !body.password) delete body.password;
      try {
        if (user) await api(`/users/${user.id}`, { method: 'PUT', body });
        else await api('/users', { method: 'POST', body });
        toast('已保存'); mask.remove(); pages.users();
      } catch (err) { toast(err.message, true); }
    };
  };

  $('#btn-new').onclick = () => editor(null);
  document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editor(data.items.find((u) => u.id === Number(b.dataset.edit)))));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('确定删除该用户吗?'))) return;
    try { await api(`/users/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除'); pages.users(); }
    catch (err) { toast(err.message, true); }
  }));
};

const SETTINGS_SECRET_FIELDS = ['ai_api_key', 'brightdata_api_key', 'qcc_secret_key'];

function wireSettingsSecretFields(form) {
  for (const name of SETTINGS_SECRET_FIELDS) {
    const el = form.elements[name];
    if (!el) continue;
    el.autocomplete = 'new-password';
    el.dataset.secretField = '1';
    el.addEventListener('input', () => { el.dataset.touched = '1'; });
  }
}

function settingsFieldRow(key, label, s, opts = {}) {
  const val = s[key] || '';
  const ph = esc(opts.placeholder || '');
  if (opts.type === 'textarea') {
    return `<div class="form-row"><label>${label}</label><textarea name="${key}" rows="${opts.rows || 3}" placeholder="${ph}">${esc(val)}</textarea></div>`;
  }
  const inputType = opts.inputType ? ` type="${opts.inputType}"` : '';
  const ac = opts.secret ? ' autocomplete="new-password" data-secret-field="1"' : (opts.autocomplete ? ` autocomplete="${opts.autocomplete}"` : '');
  return `<div class="form-row"><label>${label}</label><input name="${key}" value="${esc(val)}" placeholder="${ph}"${inputType}${ac}></div>`;
}

function settingsGroupCard(title, desc, fieldsHtml) {
  return `<section class="card settings-group">
    <header class="settings-group-head"><h3>${title}</h3>${desc ? `<p class="settings-group-desc">${desc}</p>` : ''}</header>
    <div class="form-grid">${fieldsHtml}</div>
  </section>`;
}

// ---------- 站点设置 ----------
pages.settings = async () => {
  const s = await api('/settings');
  const SITE_GROUPS = [
    {
      title: '基础信息',
      desc: '站点名称、SEO 与备案',
      fields: [
        ['site_name', '站点名称'],
        ['site_description', '站点描述', { type: 'textarea', rows: 2 }],
        ['site_keywords', '关键词', { placeholder: '逗号分隔' }],
        ['site_url', '站点 URL', { placeholder: 'https://www.example.com（canonical / sitemap）' }],
        ['site_logo', 'Logo URL', { placeholder: '分享图与结构化数据用' }],
        ['icp_number', 'ICP 备案号'],
        ['site_footer_credit', '页脚署名'],
      ],
    },
    {
      title: '导航',
      fields: [
        ['nav_home', '「首页」'],
        ['nav_news', '「新闻中心」'],
        ['nav_products', '「商品」'],
        ['nav_contact', '「联系我们」'],
      ],
    },
    {
      title: '首页 Hero',
      desc: '首屏文案、按钮与主图',
      fields: [
        ['hero_title', '主标题', { placeholder: '留空则用站点名称;填写后页眉仍显示站点名称' }],
        ['hero_cta', '主按钮文案'],
        ['hero_secondary_cta', '次按钮文案', { placeholder: '留空则显示「联系我们」' }],
        ['hero_secondary_href', '次按钮链接'],
        ['hero_quick_title', '快速入口标题'],
        ['hero_image', '右侧主图 URL'],
        ['home_value_1', '能力点 1'],
        ['home_value_2', '能力点 2'],
        ['home_value_3', '能力点 3'],
      ],
    },
    {
      title: '首页区块',
      desc: '要闻、洞察、产品与栏目',
      fields: [
        ['hero_notices_title', '要闻侧栏标题'],
        ['home_news_title', '「前沿洞察」标题'],
        ['home_products_title', '「产品」标题'],
        ['home_products_more_link', '「查看全部产品」链接'],
        ['home_categories_title', '「栏目」标题'],
        ['home_more_link', '「全部动态」链接'],
        ['home_about_title', '关于区块标题'],
        ['home_about_text', '关于区块正文', { type: 'textarea', rows: 4 }],
      ],
    },
    {
      title: '底部 CTA',
      fields: [
        ['cta_title', '标题'],
        ['cta_text', '描述', { type: 'textarea', rows: 2 }],
        ['cta_button', '按钮文案'],
        ['cta_href', '按钮链接'],
        ['footer_categories_title', '页脚栏目标题'],
        ['footer_links_title', '页脚快速入口标题'],
      ],
    },
    {
      title: '联系页',
      fields: [
        ['contact_title', '页面标题'],
        ['contact_intro', '页面简介', { type: 'textarea', rows: 2 }],
        ['contact_name_label', '表单「姓名」'],
        ['contact_phone_label', '表单「电话」'],
        ['contact_email_label', '表单「邮箱」'],
        ['contact_company_label', '表单「公司」'],
        ['contact_message_label', '表单「留言」'],
        ['contact_submit', '提交按钮'],
        ['contact_success', '成功提示'],
        ['contact_reply_hint', '回复说明'],
      ],
    },
  ];
  const AI_PROVIDERS = [
    ['', '自动检测'],
    ['deepseek', 'DeepSeek'],
    ['openai', 'OpenAI'],
    ['anthropic', 'Anthropic'],
  ];
  const AI_THINKING = [
    ['', '默认'],
    ['off', '关闭'],
    ['minimal', 'Minimal'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Max'],
  ];
  const siteGroupsHtml = SITE_GROUPS.map((g) => settingsGroupCard(
    g.title,
    g.desc,
    g.fields.map(([key, label, opts]) => settingsFieldRow(key, label, s, opts || {})).join('')
  )).join('');
  $('#main').innerHTML = `
    <div class="page-header settings-page-head">
      <div>
        <h2>站点设置</h2>
        <p class="page-sub">前台文案与 AI 数据服务，保存后立即生效</p>
      </div>
    </div>
    <form class="settings-page" id="settings-form">
      <div class="settings-autofill-trap" aria-hidden="true">
        <input type="text" tabindex="-1" autocomplete="username">
        <input type="password" tabindex="-1" autocomplete="current-password">
      </div>
      <div class="settings-layout">
        <div class="settings-main">
          <p class="settings-column-label">站点内容</p>
          <div class="settings-stack">${siteGroupsHtml}</div>
        </div>
        <aside class="settings-aside">
          <p class="settings-column-label">数据服务</p>
          <div class="settings-stack">
            <section class="card settings-group integration-card">
              <header class="settings-group-head settings-group-head-row">
                <div>
                  <h3>AI 助手</h3>
                  <p class="settings-group-desc">对话式内容运营与站点管理</p>
                </div>
                <span class="badge ${s.ai_api_key_set === '1' ? 'active' : 'disabled'}">${s.ai_api_key_set === '1' ? '已配置' : '未配置'}</span>
              </header>
              <div class="form-grid">
                <div class="form-cols">
                  <div class="form-row"><label>提供商</label>
                    <select name="ai_provider">${AI_PROVIDERS.map(([value, label]) => `<option value="${value}" ${s.ai_provider === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
                  </div>
                  <div class="form-row"><label>思考强度</label>
                    <select name="ai_thinking">${AI_THINKING.map(([value, label]) => `<option value="${value}" ${s.ai_thinking === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
                  </div>
                </div>
                <div class="form-row"><label>模型 ID</label><input name="ai_model" value="${esc(s.ai_model || '')}" placeholder="deepseek-v4-flash"></div>
                <div class="form-row">
                  <label>API Key</label>
                  <input type="password" name="ai_api_key" autocomplete="new-password" data-secret-field="1" placeholder="${s.ai_api_key_set === '1' ? '已保存，留空不修改' : '所选提供商的 API Key'}">
                  <p class="field-help">留空表示不修改。请勿让浏览器把登录密码自动填进此栏。</p>
                </div>
                ${s.ai_api_key_set === '1' ? '<label class="check-row"><input type="checkbox" name="ai_api_key_clear" value="1"> 清除已保存的 API Key</label>' : ''}
              </div>
            </section>
            <section class="card settings-group integration-card">
              <header class="settings-group-head settings-group-head-row">
                <div>
                  <h3>网页抓取</h3>
                  <p class="settings-group-desc"><code>browse_webpage</code> · Puppeteer 无头浏览器</p>
                </div>
                <span class="badge active">${s.browser_executable_path ? '自定义路径' : '内置 Chromium'}</span>
              </header>
              <div class="form-grid">
                <div class="form-row"><label>浏览器路径</label>
                  <input name="browser_executable_path" value="${esc(s.browser_executable_path || '')}" placeholder="/usr/bin/chromium" autocomplete="off">
                  <p class="field-help">留空即用 puppeteer 内置 Chromium,无需配置。如需指定其他浏览器,填可执行文件路径,macOS 示例 <code>/Applications/Google Chrome.app/Contents/MacOS/Google Chrome</code>。</p>
                </div>
              </div>
            </section>
            <section class="card settings-group integration-card">
              <header class="settings-group-head settings-group-head-row">
                <div>
                  <h3>Bright Data</h3>
                  <p class="settings-group-desc"><code>web_search</code> · SERP API</p>
                </div>
                <span class="badge ${s.brightdata_api_key_set === '1' ? 'active' : 'disabled'}">${s.brightdata_api_key_set === '1' ? '已配置' : '未配置'}</span>
              </header>
              <div class="form-grid">
                <div class="form-row"><label>SERP API Key</label>
                  <input type="password" name="brightdata_api_key" autocomplete="new-password" data-secret-field="1" placeholder="${s.brightdata_api_key_set === '1' ? '已保存，留空不修改' : 'Bearer Token'}">
                </div>
                <div class="form-row"><label>SERP Zone</label>
                  <input name="brightdata_serp_zone" value="${esc(s.brightdata_serp_zone || '')}" placeholder="zone 名称">
                </div>
                ${s.brightdata_api_key_set === '1' ? '<label class="check-row"><input type="checkbox" name="brightdata_api_key_clear" value="1"> 清除 SERP Key</label>' : ''}
              </div>
            </section>
            <section class="card settings-group integration-card">
              <header class="settings-group-head settings-group-head-row">
                <div>
                  <h3>企查查</h3>
                  <p class="settings-group-desc"><code>search_companies</code> · <a href="https://openapi.qcc.com/dataApi/886" target="_blank" rel="noopener">API 886</a></p>
                </div>
                <span class="badge ${s.qcc_secret_key_set === '1' && s.qcc_app_key ? 'active' : 'disabled'}">${s.qcc_secret_key_set === '1' && s.qcc_app_key ? '已配置' : '未配置'}</span>
              </header>
              <div class="form-grid">
                <div class="form-row"><label>AppKey</label>
                  <input name="qcc_app_key" value="${esc(s.qcc_app_key || '')}" placeholder="开放平台 AppKey" autocomplete="off">
                </div>
                <div class="form-row"><label>SecretKey</label>
                  <input type="password" name="qcc_secret_key" autocomplete="new-password" data-secret-field="1" placeholder="${s.qcc_secret_key_set === '1' ? '已保存，留空不修改' : '应用 SecretKey'}">
                </div>
                ${s.qcc_secret_key_set === '1' ? '<label class="check-row"><input type="checkbox" name="qcc_secret_key_clear" value="1"> 清除 SecretKey</label>' : ''}
              </div>
            </section>
          </div>
        </aside>
      </div>
      <div class="settings-toolbar">
        <button type="submit" class="btn primary">保存设置</button>
      </div>
    </form>`;
  const form = $('#settings-form');
  wireSettingsSecretFields(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(e.target));
      for (const name of SETTINGS_SECRET_FIELDS) {
        const el = e.target.elements[name];
        if (el && el.dataset.touched !== '1') delete body[name];
      }
      await api('/settings', { method: 'PUT', body });
      toast('设置已保存');
      pages.settings();
    } catch (err) { toast(err.message, true); }
  };
};

// ---------- AI 助手 ----------
const AI_TOOL_LABELS = {
  get_stats: '站点统计', list_articles: '查询文章', get_article: '读取文章', create_article: '新建文章',
  update_article: '更新文章', delete_article: '删除文章', bulk_update_articles: '批量更新文章',
  list_categories: '查询分类', create_category: '新建分类',
  update_category: '更新分类', delete_category: '删除分类', list_tags: '查询标签', create_tag: '新建标签',
  delete_tag: '删除标签', list_media: '查询媒体库', delete_media: '删除媒体文件', get_settings: '查看设置', update_settings: '修改设置',
  list_users: '查询用户', create_user: '新建用户', update_user: '更新用户', delete_user: '删除用户',
  list_audit_logs: '查询审计日志', list_article_revisions: '查询修订历史', restore_article_revision: '恢复修订版本',
  list_contacts: '查询销售线索', get_contact: '查看线索详情', lead_stats: '线索漏斗统计', create_lead: '创建销售线索',
  update_contact: '更新线索', add_contact_note: '添加跟进记录', delete_contact: '删除线索',
  web_search: '搜索引擎检索', browse_webpage: '浏览器抓取网页', search_companies: '企查查企业搜索',
};

const AI_SUGGESTIONS = [
  '今天该跟进哪些销售线索?',
  '线索漏斗统计,指出瓶颈',
  '写一篇产品更新公告(先存草稿)',
  '今天的站点数据概览',
];

/** 轻量 Markdown 渲染:标题/列表/链接/粗体/代码,输入先转义,不引第三方库 */
function mdLite(text) {
  const blocks = [];
  let s = esc(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre>${code}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of s.split('\n')) {
    const ph = line.trim().match(/^\u0000(\d+)\u0000$/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.、)]\s+(.*)/);
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${ul[1]}</li>`); }
    else if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${ol[1]}</li>`); }
    else {
      closeList();
      if (ph) out.push(blocks[Number(ph[1])]);
      else if (h) out.push(`<h4>${h[2]}</h4>`);
      else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) out.push('<hr>');
      else if (line.trim() !== '') out.push(`<p>${line}</p>`);
    }
  }
  closeList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

let aiBusy = false;

function aiRenderParts(el, parts, typing = false) {
  el.innerHTML = parts.map((p) => {
    if (p.type === 'tool') return `<span class="ai-tool${p.error ? ' error' : ''}${p.done ? '' : ' running'}" ${p.args ? `title="${esc(p.args)}"` : ''}>${esc(AI_TOOL_LABELS[p.name] || p.name)}</span>`;
    if (p.type === 'compact') return `<span class="ai-tool${p.done ? '' : ' running'}" title="对话较长,自动总结早期内容以释放上下文">压缩上下文</span>`;
    if (p.type === 'usage') {
      const ctx = p.context && p.window ? ` · 上下文 ${Math.round((p.context / p.window) * 100)}%` : '';
      return `<div class="ai-usage">${p.tokens ? `${p.tokens.toLocaleString()} tokens` : ''}${p.cost ? ` · $${p.cost.toFixed(4)}` : ''}${ctx}</div>`;
    }
    return `<div class="ai-md">${mdLite(p.text)}</div>`;
  }).join('') + (typing ? '<span class="ai-typing"><i></i><i></i><i></i></span>' : '');
}

pages.assistant = async () => {
  const status = await api('/assistant/status');
  $('#main').innerHTML = `
    <div class="page-header">
      <h2>AI 助手</h2>
      <div class="ai-header-right">
        ${status.ready ? `<span class="muted small">模型:${esc(status.model.provider)} · ${esc(status.model.name)}</span>` : ''}
        <button class="btn small" id="ai-new" ${status.ready ? '' : 'disabled'}>新对话</button>
        <button class="btn small" id="ai-history-btn" ${status.ready ? '' : 'disabled'}>历史记录</button>
      </div>
    </div>
    <div class="card ai-history" id="ai-history" hidden></div>
    ${status.ready ? '' : `<div class="card ai-offline"><strong>AI 助手未就绪</strong><p class="muted" style="margin-top:6px">${esc(status.error || '')}</p>${state.user.role === 'admin' ? '<p style="margin-top:12px"><a class="btn small" href="#/settings">配置 AI 助手</a></p>' : ''}</div>`}
    <div class="ai-chat">
      <div class="ai-messages" id="ai-messages">
        <div class="ai-msg assistant"><div class="ai-bubble"><div class="ai-md">你好,我是 BigCMS 的 AI 助手,可以帮你管理官网内容(写文章、发布、调设置),也能做销售运营:跟进销售线索、统计漏斗、主动开发潜在客户。需要查网页时我会用服务器本地的无头浏览器打开链接。</div></div></div>
        ${status.ready ? `<div class="ai-suggestions" id="ai-suggestions">${AI_SUGGESTIONS.map((s) => `<button type="button" class="ai-chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
      </div>
      <form class="ai-input" id="ai-form">
        <textarea id="ai-text" rows="2" placeholder="输入指令,点击发送…" ${status.ready ? '' : 'disabled'}></textarea>
        <button class="btn primary" type="submit" id="ai-send" ${status.ready ? '' : 'disabled'}>发送</button>
      </form>
    </div>`;

  const box = $('#ai-messages');
  // 用户上翻阅读历史时不抢滚动;贴近底部才自动跟随
  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const scroll = (force) => { if (force || nearBottom()) box.scrollTop = box.scrollHeight; };

  const addMsg = (role) => {
    const div = document.createElement('div');
    div.className = `ai-msg ${role}`;
    div.innerHTML = '<div class="ai-bubble"></div>';
    box.appendChild(div);
    return div.querySelector('.ai-bubble');
  };

  if (status.ready) {
    try {
      const h = await api('/assistant/history');
      if (h.messages.length) $('#ai-suggestions')?.remove();
      for (const m of h.messages) {
        const bubble = addMsg(m.role);
        const parts = [];
        for (const t of m.tools || []) parts.push({ type: 'tool', name: t.name ?? t, args: t.args || '', done: true });
        if (m.text) parts.push({ type: 'text', text: m.text });
        aiRenderParts(bubble, parts);
      }
      scroll(true);
    } catch { /* 历史加载失败不阻塞聊天 */ }
    document.querySelectorAll('#ai-suggestions .ai-chip').forEach((b) => (b.onclick = () => {
      $('#ai-text').value = b.dataset.q;
      send();
    }));
  }

  $('#ai-new').onclick = async () => {
    if (aiBusy) { toast('AI 正在回复,请稍候', true); return; }
    await api('/assistant/sessions/new', { method: 'POST' });
    pages.assistant();
  };

  const historyPanel = $('#ai-history');
  const renderHistory = async () => {
    const { sessions } = await api('/assistant/sessions');
    historyPanel.innerHTML = sessions.length
      ? sessions.map((s) => `
        <div class="ai-history-item${s.current ? ' current' : ''}" data-id="${esc(s.id)}">
          <div class="ai-history-main">
            <div class="ai-history-preview">${esc(s.preview)}</div>
            <div class="muted small">${new Date(s.modified).toLocaleString()} · ${s.messageCount} 条${s.current ? ' · 当前' : ''}</div>
          </div>
          <button class="btn small" data-rename="${esc(s.id)}">重命名</button>
          <button class="btn small danger" data-del="${esc(s.id)}">删除</button>
        </div>`).join('')
      : '<p class="muted small" style="margin:8px">暂无历史对话</p>';
    historyPanel.querySelectorAll('[data-rename]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const name = prompt('会话名称:');
      if (!name || !name.trim()) return;
      await api('/assistant/sessions/rename', { method: 'POST', body: { id: b.dataset.rename, name: name.trim() } });
      renderHistory();
    }));
    historyPanel.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      if (aiBusy) { toast('AI 正在回复,请稍候', true); return; }
      if (!(await confirmDialog('确定删除该对话吗?'))) return;
      await api(`/assistant/sessions/${b.dataset.del}`, { method: 'DELETE' });
      toast('对话已删除');
      renderHistory();
    }));
    historyPanel.querySelectorAll('.ai-history-item').forEach((item) => (item.onclick = async () => {
      if (aiBusy) { toast('AI 正在回复,请稍候', true); return; }
      if (item.classList.contains('current')) { historyPanel.hidden = true; return; }
      await api('/assistant/sessions/open', { method: 'POST', body: { id: item.dataset.id } });
      pages.assistant();
    }));
  };
  $('#ai-history-btn').onclick = async () => {
    historyPanel.hidden = !historyPanel.hidden;
    if (!historyPanel.hidden) await renderHistory();
  };

  const send = async () => {
    const text = $('#ai-text').value.trim();
    if (!text || aiBusy) return;
    aiBusy = true;
    $('#ai-text').value = '';
    $('#ai-text').style.height = '';
    $('#ai-suggestions')?.remove();
    const sendBtn0 = $('#ai-send');
    sendBtn0.textContent = '停止';
    sendBtn0.classList.add('stop');
    aiRenderParts(addMsg('user'), [{ type: 'text', text }]);

    const bubble = addMsg('assistant');
    bubble.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
    const parts = [];
    let streamDone = false;
    scroll(true);

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `请求失败 (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handle = (ev, data) => {
        if (ev === 'delta') {
          const last = parts[parts.length - 1];
          if (last && last.type === 'text') last.text += data.text;
          else parts.push({ type: 'text', text: data.text });
        } else if (ev === 'tool_start') {
          parts.push({ type: 'tool', name: data.name, args: data.args || '', done: false });
        } else if (ev === 'tool_end') {
          const t = [...parts].reverse().find((p) => p.type === 'tool' && p.name === data.name && !p.done);
          if (t) { t.done = true; t.error = data.isError; }
        } else if (ev === 'compact_start') {
          parts.push({ type: 'compact', done: false });
        } else if (ev === 'compact_end') {
          const c = [...parts].reverse().find((p) => p.type === 'compact' && !p.done);
          if (c) c.done = true;
        } else if (ev === 'done') {
          streamDone = true;
          if (data.tokens || data.context) parts.push({ type: 'usage', tokens: data.tokens || 0, cost: data.cost || 0, context: data.context, window: data.window });
        } else if (ev === 'error') {
          streamDone = true;
          parts.push({ type: 'text', text: `⚠️ ${data.message}` });
        } else if (ev === 'ping') {
          return;
        }
        // 流式过程中保留打字指示,工具间隙也能看出"还在干活"
        aiRenderParts(bubble, parts, !streamDone);
        scroll();
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message', data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          handle(ev, data ? JSON.parse(data) : {});
        }
      }
      if (parts.length === 0) aiRenderParts(bubble, [{ type: 'text', text: '(无回复)' }]);
      else aiRenderParts(bubble, parts);
    } catch (err) {
      // 流式中途断线(锁屏/网络抖动):稍候后重载页面,从落盘历史恢复已生成的部分
      if (!streamDone && parts.length) {
        aiRenderParts(bubble, [...parts, { type: 'text', text: '⚠️ 连接中断,正在从历史恢复…' }]);
        await new Promise((r) => setTimeout(r, 1500));
        aiBusy = false;
        pages.assistant();
        return;
      }
      aiRenderParts(bubble, [...parts, { type: 'text', text: `⚠️ ${err.message}` }]);
    } finally {
      aiBusy = false;
      const sendBtn = $('#ai-send');
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
        sendBtn.classList.remove('stop');
      }
      $('#ai-text')?.focus();
      scroll();
    }
  };

  $('#ai-form').onsubmit = (e) => {
    e.preventDefault();
    if (aiBusy) { api('/assistant/abort', { method: 'POST' }).catch(() => {}); return; }
    send();
  };
  // 输入框随内容自动增高(上限约 6 行)
  $('#ai-text').oninput = (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
  };
};

// ---------- 审计日志 ----------
const CONTACT_STATUS_TEXT = { new: '新留言', read: '已读', archived: '已归档' };
const LEAD_STAGE_TEXT = { pending: '待跟进', contacted: '已联系', qualified: '已确认意向', converted: '已成交', lost: '已流失' };
const LEAD_STAGE_BADGE = { pending: 'draft', contacted: 'active', qualified: 'active', converted: 'active', lost: 'disabled' };

pages.contacts = async (query = { page: 1 }) => {
  if (typeof query === 'number') query = { page: query };
  const params = new URLSearchParams({ page: query.page || 1 });
  if (query.status) params.set('status', query.status);
  if (query.stage) params.set('stage', query.stage);
  if (query.overdue) params.set('overdue', '1');
  if (query.q) params.set('q', query.q);
  const data = await api(`/contacts?${params}`);
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (c) => c.next_follow_up_at && c.next_follow_up_at < today && c.stage !== 'converted' && c.stage !== 'lost';
  $('#main').innerHTML = `
    <div class="page-header"><h2>销售线索</h2></div>
    <div class="toolbar">
      <select id="f-stage">
        <option value="">全部阶段</option>
        ${Object.entries(LEAD_STAGE_TEXT).map(([v, t]) => `<option value="${v}" ${query.stage === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <select id="f-status">
        <option value="">全部状态</option>
        ${Object.entries(CONTACT_STATUS_TEXT).map(([v, t]) => `<option value="${v}" ${query.status === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px">
        <input type="checkbox" id="f-overdue" ${query.overdue ? 'checked' : ''}>仅看逾期
      </label>
      <input type="search" id="f-q" placeholder="搜索姓名/电话/邮箱/留言…" value="${esc(query.q || '')}">
      <button class="btn" id="btn-filter">筛选</button>
    </div>
    <table><thead><tr><th>姓名</th><th>公司</th><th>电话</th><th>来源</th><th>阶段</th><th>下次回访</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>
      ${data.items.map((c) => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.company || '-')}</td><td>${esc(c.phone || '-')}</td>
        <td><span class="badge ${c.source === 'ai' ? 'active' : 'disabled'}">${c.source === 'ai' ? 'AI 开发' : '表单'}</span></td>
        <td><span class="badge ${LEAD_STAGE_BADGE[c.stage] || 'draft'}">${LEAD_STAGE_TEXT[c.stage] || c.stage}</span></td>
        <td>${c.next_follow_up_at ? `<span ${isOverdue(c) ? 'style="color:var(--danger,#c0392b);font-weight:600"' : ''}>${esc(c.next_follow_up_at)}${isOverdue(c) ? ' ⚠' : ''}</span>` : '<span class="muted">-</span>'}</td>
        <td><span class="badge ${c.status === 'new' ? 'draft' : c.status === 'read' ? 'active' : 'disabled'}">${CONTACT_STATUS_TEXT[c.status] || c.status}</span></td>
        <td>${fmtDate(c.created_at)}</td>
        <td><button class="btn small" data-view="${c.id}">查看</button>${canEdit() ? ` <button class="btn small danger" data-del="${c.id}">删除</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted">暂无线索</td></tr>'}
    </tbody></table>
    <div id="pager"></div>`;

  const show = async (id) => {
    const c = await api(`/contacts/${id}`);
    const mask = openModal(`
      <h3>线索:${esc(c.name)}</h3>
      <div class="form-grid">
        <div class="form-row"><label>电话</label><div>${esc(c.phone || '-')}</div></div>
        <div class="form-row"><label>邮箱</label><div>${esc(c.email || '-')}</div></div>
        <div class="form-row"><label>公司</label><div>${esc(c.company || '-')}</div></div>
        <div class="form-row"><label>来源</label><div>${c.source === 'ai' ? 'AI 主动开发' : '前台表单'}</div></div>
        <div class="form-row"><label>提交时间</label><div>${fmtDate(c.created_at)}</div></div>
        <div class="form-row"><label>IP</label><div class="muted">${esc(c.ip || '-')}</div></div>
        <div class="form-row"><label>留言</label><div style="white-space:pre-wrap">${esc(c.message)}</div></div>
        ${canEdit() ? `
        <div class="form-row"><label>线索阶段</label>
          <select id="contact-stage">
            ${Object.entries(LEAD_STAGE_TEXT).map(([v, t]) => `<option value="${v}" ${c.stage === v ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
        <div class="form-row"><label>下次回访</label><input type="date" id="contact-follow-up" value="${esc(c.next_follow_up_at || '')}"></div>
        <div class="form-row"><label>状态</label>
          <select id="contact-status">
            ${Object.entries(CONTACT_STATUS_TEXT).map(([v, t]) => `<option value="${v}" ${c.status === v ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>` : `
        <div class="form-row"><label>线索阶段</label><div>${LEAD_STAGE_TEXT[c.stage] || c.stage}</div></div>
        <div class="form-row"><label>下次回访</label><div>${esc(c.next_follow_up_at || '-')}</div></div>`}
        <div class="form-row"><label>跟进记录</label>
          <div id="contact-notes" style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto">
            ${(c.notes || []).map((n) => `<div style="border:1px solid var(--border,#ddd);border-radius:6px;padding:8px 10px">
              <div class="muted" style="font-size:12px;margin-bottom:2px">${esc(n.author || '-')} · ${fmtDate(n.created_at)}</div>
              <div style="white-space:pre-wrap;font-size:13px">${esc(n.note)}</div>
            </div>`).join('') || '<span class="muted">暂无跟进记录</span>'}
          </div>
          ${canEdit() ? `<div style="display:flex;gap:8px;margin-top:8px">
            <input type="text" id="contact-note-input" placeholder="记录这次沟通的要点与下一步…" style="flex:1" maxlength="2000">
            <button type="button" class="btn small" data-act="add-note">添加</button>
          </div>` : ''}
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-act="close">关闭</button>
          ${canEdit() ? '<button type="button" class="btn primary" data-act="save">保存</button>' : ''}
        </div>
      </div>`);
    mask.querySelector('[data-act=close]').onclick = () => mask.remove();
    mask.querySelector('[data-act=add-note]')?.addEventListener('click', async () => {
      const input = mask.querySelector('#contact-note-input');
      const note = input.value.trim();
      if (!note) return;
      try {
        await api(`/contacts/${id}/notes`, { method: 'POST', body: { note } });
        toast('已记录'); mask.remove(); show(id);
      } catch (err) { toast(err.message, true); }
    });
    mask.querySelector('[data-act=save]')?.addEventListener('click', async () => {
      try {
        await api(`/contacts/${id}`, {
          method: 'PUT',
          body: {
            status: mask.querySelector('#contact-status').value,
            stage: mask.querySelector('#contact-stage').value,
            next_follow_up_at: mask.querySelector('#contact-follow-up').value || '',
          },
        });
        toast('已保存'); mask.remove(); pages.contacts(query);
      } catch (err) { toast(err.message, true); }
    });
  };

  const filter = () => pages.contacts({
    page: 1,
    status: $('#f-status').value,
    stage: $('#f-stage').value,
    overdue: $('#f-overdue').checked ? 1 : '',
    q: $('#f-q').value.trim(),
  });
  $('#btn-filter').onclick = filter;
  $('#f-q').onkeydown = (e) => { if (e.key === 'Enter') filter(); };
  document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => show(Number(b.dataset.view))));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('确定删除该联系人记录吗?'))) return;
    try { await api(`/contacts/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除'); pages.contacts(query); }
    catch (err) { toast(err.message, true); }
  }));
  $('#pager').appendChild(pagination(data.total, data.page, data.page_size, (p) => pages.contacts({ ...query, page: p })));
};

pages.audit = async (query = { page: 1 }) => {
  if (typeof query === 'number') query = { page: query };
  const params = new URLSearchParams({ page: query.page || 1 });
  if (query.action) params.set('action', query.action);
  if (query.username) params.set('username', query.username);
  if (query.q) params.set('q', query.q);
  const data = await api(`/audit-logs?${params}`);
  $('#main').innerHTML = `
    <div class="page-header"><h2>审计日志</h2></div>
    <div class="toolbar">
      <select id="f-user">
        <option value="">全部用户</option>
        ${(data.usernames || []).map((u) => `<option value="${esc(u)}" ${query.username === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}
      </select>
      <select id="f-action">
        <option value="">全部操作</option>
        ${(data.actions || []).map((a) => `<option value="${esc(a)}" ${query.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select>
      <input type="search" id="f-q" placeholder="搜索对象/详情…" value="${esc(query.q || '')}">
      <button class="btn" id="btn-filter">筛选</button>
    </div>
    <table><thead><tr><th>#</th><th>用户</th><th>操作</th><th>对象</th><th>详情</th><th>时间</th></tr></thead><tbody>
      ${data.items.map((l) => `<tr><td class="muted">${l.id}</td><td>${esc(l.username)}</td><td>${esc(l.action)}</td><td>${esc(l.target || '-')}</td><td>${esc(l.detail || '-')}</td><td>${fmtDate(l.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">暂无日志</td></tr>'}
    </tbody></table>
    <div id="pager"></div>`;
  const filter = () => pages.audit({ page: 1, username: $('#f-user').value, action: $('#f-action').value, q: $('#f-q').value.trim() });
  $('#btn-filter').onclick = filter;
  $('#f-q').onkeydown = (e) => { if (e.key === 'Enter') filter(); };
  $('#pager').appendChild(pagination(data.total, data.page, data.page_size, (p) => pages.audit({ ...query, page: p })));
};

boot();
