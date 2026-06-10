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
      <button class="btn" id="btn-filter">筛选</button>
    </div>
    <table><thead><tr><th>标题</th><th>分类</th><th>标签</th><th>状态</th><th>作者</th><th>浏览</th><th>更新时间</th><th>操作</th></tr></thead>
    <tbody>
      ${data.items.map((a) => `<tr>
        <td>${esc(a.title)}<div class="muted small">/${esc(a.slug)}</div></td>
        <td>${esc(a.category_name || '-')}</td>
        <td>${a.tags.map((t) => esc(t.name)).join(', ') || '-'}</td>
        <td><span class="badge ${a.status}">${STATUS_TEXT[a.status]}</span></td>
        <td>${esc(a.author_name || '-')}</td>
        <td>${a.views}</td>
        <td>${fmtDate(a.updated_at)}</td>
        <td>${canEdit() ? `<button class="btn small" data-edit="${a.id}">编辑</button> <button class="btn small danger" data-del="${a.id}">删除</button>` : '-'}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无文章</td></tr>'}
    </tbody></table>
    <div id="pager"></div>`;

  $('#pager').appendChild(pagination(data.total, data.page, data.page_size, (p) => pages.articles({ ...query, page: p })));
  $('#btn-filter').onclick = () => pages.articles({ page: 1, q: $('#f-q').value.trim(), status: $('#f-status').value });
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
        <div class="form-row"><label>封面图 URL</label><input name="cover_image" value="${esc(article?.cover_image || '')}"></div>
      </div>
      <div class="form-row"><label>标签</label>
        <div>${allTags.map((t) => `<label class="chip" style="cursor:pointer"><input type="checkbox" name="tag" value="${t.id}" ${selectedTagIds.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('') || '<span class="muted">暂无标签,可在「标签管理」中创建</span>'}</div>
      </div>
      <div class="form-row"><label>摘要</label><textarea name="summary" rows="2">${esc(article?.summary || '')}</textarea></div>
      <div class="form-row"><label>正文(支持 Markdown)</label><textarea name="content" rows="12">${esc(article?.content || '')}</textarea></div>
      <div class="form-actions">
        <button type="button" class="btn" data-act="cancel">取消</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`);
  mask.querySelector('[data-act=cancel]').onclick = () => mask.remove();
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
      ${canEdit() ? '<label class="btn primary">+ 上传文件<input type="file" id="file-input" hidden></label>' : ''}
    </div>
    <div class="media-grid">
      ${data.items.map((m) => `<div class="media-item">
        <div class="thumb">${m.mime_type.startsWith('image/') ? `<img src="${esc(m.url)}" alt="" loading="lazy">` : '📄'}</div>
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
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try { await api('/media', { method: 'POST', body: fd }); toast('上传成功'); pages.media(page); }
      catch (err) { toast(err.message, true); }
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

// ---------- 站点设置 ----------
pages.settings = async () => {
  const s = await api('/settings');
  const FIELDS = [
    ['site_name', '站点名称'],
    ['site_description', '站点描述'],
    ['site_keywords', '关键词(逗号分隔)'],
    ['icp_number', 'ICP 备案号'],
  ];
  $('#main').innerHTML = `
    <div class="page-header"><h2>站点设置</h2></div>
    <div class="card" style="max-width:640px">
      <form class="form-grid" id="settings-form">
        ${FIELDS.map(([key, label]) => `<div class="form-row"><label>${label}</label><input name="${key}" value="${esc(s[key] || '')}"></div>`).join('')}
        <div class="form-actions"><button type="submit" class="btn primary">保存设置</button></div>
      </form>
    </div>`;
  $('#settings-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      toast('设置已保存');
    } catch (err) { toast(err.message, true); }
  };
};

// ---------- AI 助手 ----------
const AI_TOOL_LABELS = {
  get_stats: '站点统计', list_articles: '查询文章', get_article: '读取文章', create_article: '新建文章',
  update_article: '更新文章', delete_article: '删除文章', list_categories: '查询分类', create_category: '新建分类',
  update_category: '更新分类', delete_category: '删除分类', list_tags: '查询标签', create_tag: '新建标签',
  delete_tag: '删除标签', list_media: '查询媒体库', get_settings: '查看设置', update_settings: '修改设置',
  list_users: '查询用户', create_user: '新建用户', update_user: '更新用户', delete_user: '删除用户',
  list_audit_logs: '查询审计日志',
};

/** 极简 Markdown 渲染(仅粗体/行内代码/代码块/换行,输入先转义) */
function mdLite(text) {
  let s = esc(text);
  s = s.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => `<pre>${code}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\n/g, '<br>');
}

let aiBusy = false;

function aiRenderParts(el, parts) {
  el.innerHTML = parts.map((p) => {
    if (p.type === 'tool') return `<span class="ai-tool${p.error ? ' error' : ''}${p.done ? '' : ' running'}">${esc(AI_TOOL_LABELS[p.name] || p.name)}</span>`;
    return `<div class="ai-md">${mdLite(p.text)}</div>`;
  }).join('');
}

pages.assistant = async () => {
  const status = await api('/assistant/status');
  $('#main').innerHTML = `
    <div class="page-header">
      <h2>AI 助手</h2>
      <div class="ai-header-right">
        ${status.ready ? `<span class="muted small">模型:${esc(status.model.name)}</span>` : ''}
        <button class="btn small" id="ai-reset" ${status.ready ? '' : 'disabled'}>清空会话</button>
      </div>
    </div>
    ${status.ready ? '' : `<div class="card ai-offline"><strong>AI 助手未就绪</strong><p class="muted" style="margin-top:6px">${esc(status.error || '')}</p></div>`}
    <div class="ai-chat">
      <div class="ai-messages" id="ai-messages">
        <div class="ai-msg assistant"><div class="ai-bubble"><div class="ai-md">你好,我是 BigCMS 的 AI 助手,可以帮你管理官网的全部内容:写文章、发布、改分类标签、调站点设置等。试试对我说:「把最新的草稿发布」或「写一篇产品更新公告」。</div></div></div>
      </div>
      <form class="ai-input" id="ai-form">
        <textarea id="ai-text" rows="2" placeholder="输入指令,Enter 发送,Shift+Enter 换行…" ${status.ready ? '' : 'disabled'}></textarea>
        <button class="btn primary" type="submit" id="ai-send" ${status.ready ? '' : 'disabled'}>发送</button>
      </form>
    </div>`;

  const box = $('#ai-messages');
  const scroll = () => { box.scrollTop = box.scrollHeight; };

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
      for (const m of h.messages) {
        const bubble = addMsg(m.role);
        const parts = [];
        for (const t of m.tools || []) parts.push({ type: 'tool', name: t, done: true });
        if (m.text) parts.push({ type: 'text', text: m.text });
        aiRenderParts(bubble, parts);
      }
      scroll();
    } catch { /* 历史加载失败不阻塞聊天 */ }
  }

  $('#ai-reset').onclick = async () => {
    if (aiBusy) { toast('AI 正在回复,请稍候', true); return; }
    if (!(await confirmDialog('确定清空当前会话吗?对话历史将丢失。'))) return;
    await api('/assistant/reset', { method: 'POST' });
    toast('会话已清空');
    pages.assistant();
  };

  const send = async () => {
    const text = $('#ai-text').value.trim();
    if (!text || aiBusy) return;
    aiBusy = true;
    $('#ai-text').value = '';
    $('#ai-send').disabled = true;
    aiRenderParts(addMsg('user'), [{ type: 'text', text }]);

    const bubble = addMsg('assistant');
    bubble.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
    const parts = [];
    scroll();

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
          parts.push({ type: 'tool', name: data.name, done: false });
        } else if (ev === 'tool_end') {
          const t = [...parts].reverse().find((p) => p.type === 'tool' && p.name === data.name && !p.done);
          if (t) { t.done = true; t.error = data.isError; }
        } else if (ev === 'error') {
          parts.push({ type: 'text', text: `⚠️ ${data.message}` });
        }
        aiRenderParts(bubble, parts);
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
    } catch (err) {
      aiRenderParts(bubble, [...parts, { type: 'text', text: `⚠️ ${err.message}` }]);
    } finally {
      aiBusy = false;
      const sendBtn = $('#ai-send');
      if (sendBtn) sendBtn.disabled = false;
      scroll();
    }
  };

  $('#ai-form').onsubmit = (e) => { e.preventDefault(); send(); };
  $('#ai-text').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
};

// ---------- 审计日志 ----------
pages.audit = async (page = 1) => {
  const data = await api(`/audit-logs?page=${page}`);
  $('#main').innerHTML = `
    <div class="page-header"><h2>审计日志</h2></div>
    <table><thead><tr><th>#</th><th>用户</th><th>操作</th><th>对象</th><th>详情</th><th>时间</th></tr></thead><tbody>
      ${data.items.map((l) => `<tr><td class="muted">${l.id}</td><td>${esc(l.username)}</td><td>${esc(l.action)}</td><td>${esc(l.target || '-')}</td><td>${esc(l.detail || '-')}</td><td>${fmtDate(l.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">暂无日志</td></tr>'}
    </tbody></table>
    <div id="pager"></div>`;
  $('#pager').appendChild(pagination(data.total, data.page, data.page_size, (p) => pages.audit(p)));
};

boot();
