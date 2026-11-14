import * as db from './db.js';

/* ---------- 常數 ---------- */

const TYPES = {
  recipe:  { label: '食譜', placeholder: '例如：番茄炒蛋' },
  formula: { label: '配方', placeholder: '例如：萬用照燒醬' },
  note:    { label: '筆記', placeholder: '標題' },
};
const SCALES = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const LAST_EXPORT_KEY = 'janna:lastExport';
const DAY = 24 * 60 * 60 * 1000;

const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
};

const $top = document.getElementById('topbar');
const $view = document.getElementById('view');
const $tabs = document.getElementById('tabbar');

const state = {
  q: {},          // 每個分頁的搜尋字
  tag: {},        // 每個分頁選取的標籤
  dirty: false,   // 編輯中有未儲存的變更
  wakeLock: null,
  persistAsked: false,
};

/* ---------- 小工具 ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const $ = (sel, root = $view) => root.querySelector(sel);
const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));
const parseTags = (s) => [...new Set(String(s || '').split(/[\s,，、#]+/).filter(Boolean))];
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('zh-TW') : '—');
const fmtNum = (n) => String(Math.round(n * 100) / 100);

function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } }

let objectURLs = [];
function blobURL(blob) {
  const u = URL.createObjectURL(blob);
  objectURLs.push(u);
  return u;
}
function releaseURLs() {
  objectURLs.forEach((u) => URL.revokeObjectURL(u));
  objectURLs = [];
}

let toastTimer;
function toast(msg, actionLabel, onAction) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (actionLabel) {
    el.querySelector('button').onclick = () => { el.classList.remove('show'); onAction(); };
  } else {
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
}

function setTop({ back, title, right = '' }) {
  $top.innerHTML = `
    <div class="tb-side">${back ? `<a class="tb-btn" href="${back}" aria-label="返回">${ICON.back}</a>` : ''}</div>
    <h1 class="tb-title">${esc(title)}</h1>
    <div class="tb-side right">${right}</div>`;
}

function requestPersist() {
  if (state.persistAsked || !navigator.storage?.persist) return;
  state.persistAsked = true;
  navigator.storage.persist().catch(() => {});
}

/* ---------- 份量換算 ---------- */

// 把一行文字中的數字乘上倍數；支援 1.5、1/2、1 1/2，溫度（180°C、180度）不換算。
function scaleLine(line, f) {
  if (f === 1) return line;
  const re = /(\d+)\s+(\d+)\s*\/\s*(\d+)|(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/g;
  return line.replace(re, (m, w, n, d, a, b, offset, str) => {
    if (/^\s*(°|度|℃|℉)/.test(str.slice(offset + m.length))) return m;
    let v;
    if (w !== undefined) v = +w + n / d;
    else v = b !== undefined ? a / b : +a;
    if (!isFinite(v)) return m;
    return fmtNum(v * f);
  });
}

const isGroup = (l) => l.startsWith('#');
const groupText = (l) => l.replace(/^#+\s*/, '');

function renderIngredients(text, f, checked) {
  return lines(text).map((l, k) => (isGroup(l)
    ? `<li class="group">${esc(groupText(l))}</li>`
    : `<li class="check${checked.has('i' + k) ? ' done' : ''}" data-k="i${k}"><span>${esc(scaleLine(l, f))}</span></li>`
  )).join('');
}

function renderSteps(text, checked) {
  let n = 0;
  return lines(text).map((l, k) => {
    if (isGroup(l)) return `<li class="group">${esc(groupText(l))}</li>`;
    const body = l.replace(/^\d+\s*[.、)）]\s*/, '');
    return `<li class="check${checked.has('s' + k) ? ' done' : ''}" data-k="s${k}"><span class="num">${++n}</span><span>${linkify(body)}</span></li>`;
  }).join('');
}

/* ---------- 列表 ---------- */

function haystack(i) {
  return [i.title, (i.tags || []).join(' '), i.ingredients, i.steps, i.body, i.source]
    .join('\n').toLowerCase();
}

function card(i) {
  const thumb = i.photo
    ? `<img class="thumb" src="${blobURL(i.photo)}" alt="">`
    : (i.type === 'note' ? '' : `<div class="thumb ph">${esc((i.title || '？').slice(0, 1))}</div>`);
  const sub = i.type === 'note'
    ? (lines(i.body)[0] || '')
    : [i.time, i.servings].filter(Boolean).join(' · ');
  const tags = (i.tags || []).map((t) => '#' + t).join(' ');
  return `<li><a class="card" href="#/item/${encodeURIComponent(i.id)}">${thumb}
    <div class="card-body">
      <div class="card-title">${i.fav ? '<span class="star">★</span>' : ''}${esc(i.title || '（未命名）')}</div>
      ${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}
      ${tags ? `<div class="card-tags">${esc(tags)}</div>` : ''}
    </div></a></li>`;
}

function backupBanner(allItems) {
  if (!allItems.length) return '';
  const last = Number(lsGet(LAST_EXPORT_KEY)) || 0;
  const oldest = Math.min(...allItems.map((i) => i.createdAt || Date.now()));
  if (last && Date.now() - last < 30 * DAY) return '';
  if (!last && Date.now() - oldest < 7 * DAY) return '';
  const msg = last ? '已超過 30 天沒有備份，點這裡匯出' : '資料只存在這支手機上，建議定期匯出備份';
  return `<a class="banner" href="#/settings">${msg}</a>`;
}

async function renderList(type) {
  const allItems = await db.all();
  const items = allItems.filter((i) => i.type === type);
  setTop({
    title: TYPES[type].label,
    right: `<a class="tb-btn" href="#/new/${type}" aria-label="新增${TYPES[type].label}">${ICON.plus}</a>`,
  });

  const tags = [...new Set(items.flatMap((i) => i.tags || []))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  if (state.tag[type] && !tags.includes(state.tag[type])) state.tag[type] = null;

  $view.innerHTML = `
    ${backupBanner(allItems)}
    <div class="searchbar"><input type="search" id="q" placeholder="搜尋${TYPES[type].label}…"
      value="${esc(state.q[type] || '')}" autocomplete="off" enterkeyhint="search"></div>
    ${tags.length ? `<div class="chips" id="chips">${tags.map((t) =>
      `<button type="button" class="chip${state.tag[type] === t ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    <ul class="cards" id="cards"></ul>`;

  const $cards = $('#cards');
  const draw = () => {
    releaseURLs();
    const words = (state.q[type] || '').toLowerCase().split(/\s+/).filter(Boolean);
    const tag = state.tag[type];
    const list = items
      .filter((i) => (!tag || (i.tags || []).includes(tag)) && words.every((w) => haystack(i).includes(w)))
      .sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || b.updatedAt - a.updatedAt);
    $cards.innerHTML = list.length
      ? list.map(card).join('')
      : `<li class="empty">${items.length ? '找不到符合的項目' : `還沒有${TYPES[type].label}<br>按右上角 ＋ 新增`}</li>`;
  };
  draw();

  $('#q').addEventListener('input', (e) => { state.q[type] = e.target.value; draw(); });
  $('#chips')?.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.tag[type] = state.tag[type] === b.dataset.tag ? null : b.dataset.tag;
    $view.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.tag === state.tag[type]));
    draw();
  });
  return type;
}

/* ---------- 檢視 ---------- */

function notFound() {
  setTop({ back: '#/recipe', title: '找不到' });
  $view.innerHTML = '<p class="empty">這筆資料不存在或已被刪除。</p>';
  return 'recipe';
}

async function renderItem(id) {
  const it = await db.get(id);
  if (!it) return notFound();

  let f = 1;
  const checked = new Set();
  const hasIng = lines(it.ingredients).length > 0;
  const hasSteps = lines(it.steps).length > 0;
  const canWake = 'wakeLock' in navigator && it.type !== 'note';

  setTop({
    back: `#/${it.type}`,
    title: TYPES[it.type].label,
    right: `<a class="tb-btn" href="#/edit/${encodeURIComponent(it.id)}" aria-label="編輯">${ICON.edit}</a>`,
  });

  $view.innerHTML = `<article class="detail">
    ${it.photo ? `<img class="hero" src="${blobURL(it.photo)}" alt="">` : ''}
    <h2 class="d-title">${esc(it.title || '（未命名）')}</h2>
    <div class="d-meta" id="meta"></div>
    ${it.source ? `<div class="d-source">來源：${linkify(it.source)}</div>` : ''}
    ${(it.tags || []).length ? `<div class="d-tags">${it.tags.map((t) =>
      `<a class="chip" href="#/${it.type}?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
    <div class="d-actions">
      <button type="button" class="btn small" id="fav">${it.fav ? '★ 已收藏' : '☆ 收藏'}</button>
      ${canWake ? '<button type="button" class="btn small" id="wake">保持螢幕亮著</button>' : ''}
    </div>
    ${hasIng ? `<section>
      <div class="sec-head"><h3>材料</h3>
        <div class="scale" role="group" aria-label="份量倍數">
          <button type="button" id="sDown" aria-label="減少倍數">−</button>
          <output id="sOut">1×</output>
          <button type="button" id="sUp" aria-label="增加倍數">＋</button>
        </div>
      </div>
      <ul class="ing" id="ing"></ul></section>` : ''}
    ${hasSteps ? `<section><h3>步驟</h3><ol class="steps" id="steps">${renderSteps(it.steps, checked)}</ol></section>` : ''}
    ${it.body ? `<section>${it.type === 'note' ? '' : '<h3>備註</h3>'}<div class="body">${linkify(it.body)}</div></section>` : ''}
    <p class="d-time">建立 ${fmtDate(it.createdAt)} · 更新 ${fmtDate(it.updatedAt)}</p>
  </article>`;

  const drawScaled = () => {
    const meta = [];
    if (it.servings) meta.push(`${it.type === 'formula' ? '產量' : '份量'}：${scaleLine(it.servings, f)}`);
    if (it.time) meta.push(`時間：${it.time}`);
    $('#meta').innerHTML = meta.map((m) => `<span>${esc(m)}</span>`).join('');
    if (hasIng) {
      $('#ing').innerHTML = renderIngredients(it.ingredients, f, checked);
      $('#sOut').textContent = fmtNum(f) + '×';
      $('#sOut').classList.toggle('changed', f !== 1);
    }
  };
  drawScaled();

  const step = (dir) => {
    const idx = SCALES.indexOf(f);
    f = SCALES[Math.min(SCALES.length - 1, Math.max(0, idx + dir))];
    drawScaled();
  };
  $('#sDown')?.addEventListener('click', () => step(-1));
  $('#sUp')?.addEventListener('click', () => step(1));

  // 點一下材料或步驟可劃掉，做菜時追蹤進度
  $view.querySelectorAll('#ing, #steps').forEach((list) => list.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const li = e.target.closest('li.check');
    if (!li) return;
    const k = li.dataset.k;
    if (checked.has(k)) checked.delete(k); else checked.add(k);
    li.classList.toggle('done', checked.has(k));
  }));

  $('#fav').addEventListener('click', async (e) => {
    it.fav = !it.fav;
    await db.put(it);
    e.currentTarget.textContent = it.fav ? '★ 已收藏' : '☆ 收藏';
  });

  if (canWake) {
    const btn = $('#wake');
    const sync = () => {
      btn.textContent = state.wakeLock ? '☀︎ 螢幕保持亮著' : '保持螢幕亮著';
      btn.classList.toggle('on', !!state.wakeLock);
    };
    btn.addEventListener('click', async () => {
      if (state.wakeLock) { await releaseWake(); sync(); return; }
      try {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; sync(); });
      } catch {
        toast('這台裝置目前無法保持螢幕常亮');
      }
      sync();
    });
  }
  return it.type;
}

async function releaseWake() {
  if (!state.wakeLock) return;
  const lock = state.wakeLock;
  state.wakeLock = null;
  try { await lock.release(); } catch { /* 忽略 */ }
}

/* ---------- 編輯 ---------- */

async function resizeImage(file, max = 1600, quality = 0.82) {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('無法讀取這張圖片'));
      im.src = src;
    });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * s);
    canvas.height = Math.round(img.naturalHeight * s);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('圖片轉換失敗'))), 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(src);
  }
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

async function renderEdit(id, newType) {
  let it = null;
  if (id) {
    it = await db.get(id);
    if (!it) return notFound();
  }
  const isNew = !it;
  it = it || {
    id: newId(), type: newType, title: '', tags: [], servings: '', time: '', source: '',
    ingredients: '', steps: '', body: '', photo: null, fav: false, createdAt: 0, updatedAt: 0,
  };
  let photo = it.photo || null;

  setTop({
    back: isNew ? `#/${it.type}` : `#/item/${encodeURIComponent(it.id)}`,
    title: isNew ? `新增${TYPES[it.type].label}` : '編輯',
    right: '<button type="button" class="tb-btn text" id="saveTop">儲存</button>',
  });

  const v = (k) => esc(it[k] || '');
  $view.innerHTML = `<form id="form" class="form" autocomplete="off" novalidate>
    <div class="seg" role="radiogroup" aria-label="類型">${Object.entries(TYPES).map(([k, t]) =>
      `<label><input type="radio" name="type" value="${k}"${k === it.type ? ' checked' : ''}><span>${t.label}</span></label>`).join('')}</div>

    <label class="field"><span>名稱</span>
      <input name="title" value="${v('title')}" enterkeyhint="next"></label>

    <div class="field"><span>照片</span><div class="photo" id="photo"></div>
      <input type="file" id="file" accept="image/*" hidden></div>

    <div class="row" data-for="recipe formula">
      <label class="field"><span id="lblServ">份量</span>
        <input name="servings" value="${v('servings')}" placeholder="例如：4 人份"></label>
      <label class="field"><span>時間</span>
        <input name="time" value="${v('time')}" placeholder="例如：30 分鐘"></label>
    </div>

    <label class="field" data-for="recipe formula"><span>材料</span>
      <textarea name="ingredients" rows="5" placeholder="一行一項，例如：&#10;雞蛋 3 顆&#10;番茄 2 顆&#10;# 調味&#10;鹽 1/2 小匙">${v('ingredients')}</textarea>
      <small>以 # 開頭的行是分組標題。數量會依倍數自動換算。</small></label>

    <label class="field" data-for="recipe formula"><span>步驟</span>
      <textarea name="steps" rows="5" placeholder="一行一個步驟">${v('steps')}</textarea>
      <small>一行一個步驟，會自動編號。</small></label>

    <label class="field"><span id="lblBody">備註</span>
      <textarea name="body" rows="4">${v('body')}</textarea></label>

    <label class="field" data-for="recipe formula"><span>來源</span>
      <input name="source" value="${v('source')}" placeholder="網址、書名，或是誰教的"></label>

    <label class="field"><span>標籤</span>
      <input name="tags" value="${esc((it.tags || []).join(' '))}" placeholder="用空白分隔，例如：家常 快速 雞肉"></label>

    <div class="form-actions">
      <button type="submit" class="btn primary">儲存</button>
      ${isNew ? '' : '<button type="button" class="btn danger" id="del">刪除</button>'}
    </div>
  </form>`;

  const form = $('#form');
  const field = (name) => form.elements.namedItem(name);

  const applyType = (t) => {
    form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(t); });
    $('#lblServ').textContent = t === 'formula' ? '產量' : '份量';
    $('#lblBody').textContent = t === 'note' ? '內容' : '備註';
    field('title').placeholder = TYPES[t].placeholder;
    field('body').rows = t === 'note' ? 12 : 4;
  };
  applyType(it.type);
  form.addEventListener('change', (e) => { if (e.target.name === 'type') applyType(e.target.value); });

  form.querySelectorAll('textarea').forEach((ta) => {
    autoGrow(ta);
    ta.addEventListener('input', () => autoGrow(ta));
  });
  form.addEventListener('input', () => { state.dirty = true; });

  // 照片
  const $photo = $('#photo');
  const $file = $('#file');
  const drawPhoto = () => {
    $photo.innerHTML = photo
      ? `<img src="${blobURL(photo)}" alt=""><div class="photo-actions">
           <button type="button" class="btn small" data-act="pick">更換</button>
           <button type="button" class="btn small danger" data-act="remove">移除</button></div>`
      : '<button type="button" class="btn small" data-act="pick">＋ 加入照片</button>';
  };
  drawPhoto();
  $photo.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'pick') $file.click();
    if (act === 'remove') { photo = null; state.dirty = true; drawPhoto(); }
  });
  $file.addEventListener('change', async () => {
    const file = $file.files[0];
    $file.value = '';
    if (!file) return;
    try {
      photo = await resizeImage(file);
      state.dirty = true;
      drawPhoto();
    } catch (err) {
      toast(err.message);
    }
  });

  const save = async () => {
    const fd = new FormData(form);
    const get = (k) => String(fd.get(k) || '').trim();
    const title = get('title');
    if (!title) { toast('請輸入名稱'); field('title').focus(); return; }
    const now = Date.now();
    const item = {
      ...it,
      type: TYPES[get('type')] ? get('type') : it.type,
      title,
      servings: get('servings'),
      time: get('time'),
      source: get('source'),
      ingredients: get('ingredients'),
      steps: get('steps'),
      body: get('body'),
      tags: parseTags(get('tags')),
      photo,
      createdAt: it.createdAt || now,
      updatedAt: now,
    };
    try {
      await db.put(item);
    } catch (err) {
      toast('儲存失敗：' + err.message);
      return;
    }
    state.dirty = false;
    requestPersist();
    history.replaceState(null, '', `#/item/${encodeURIComponent(item.id)}`);
    route();
    toast('已儲存');
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $top.querySelector('#saveTop').addEventListener('click', save);

  $('#del')?.addEventListener('click', async () => {
    if (!confirm(`確定要刪除「${it.title}」嗎？刪除後無法復原。`)) return;
    await db.remove(it.id);
    state.dirty = false;
    location.replace(`#/${it.type}`);
    toast('已刪除');
  });

  if (isNew) field('title').focus();
  return it.type;
}

/* ---------- 設定與備份 ---------- */

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function exportData() {
  const items = await db.all();
  const out = await Promise.all(items.map(async (i) => ({
    ...i, photo: i.photo ? await blobToDataURL(i.photo) : null,
  })));
  const json = JSON.stringify({ app: 'janna', format: 1, exportedAt: new Date().toISOString(), items: out });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const name = `janna-backup-${stamp}.json`;
  const file = new File([json], name, { type: 'application/json' });

  // iPhone 上用分享面板，可以選「儲存到檔案」或傳到其他 App
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      lsSet(LAST_EXPORT_KEY, String(Date.now()));
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  lsSet(LAST_EXPORT_KEY, String(Date.now()));
  return true;
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('這不是有效的備份檔');
  }
  if (!data || data.app !== 'janna' || !Array.isArray(data.items)) throw new Error('這不是 Janna 的備份檔');

  const existing = new Map((await db.all()).map((i) => [i.id, i]));
  const str = (x) => (typeof x === 'string' ? x : '');
  let added = 0; let updated = 0; let skipped = 0;
  const toWrite = [];
  for (const raw of data.items) {
    if (!raw || typeof raw.id !== 'string' || !TYPES[raw.type]) { skipped++; continue; }
    const cur = existing.get(raw.id);
    const updatedAt = Number(raw.updatedAt) || 0;
    if (cur && cur.updatedAt >= updatedAt) { skipped++; continue; }
    let photo = null;
    if (typeof raw.photo === 'string' && raw.photo.startsWith('data:image/')) {
      try { photo = await (await fetch(raw.photo)).blob(); } catch { photo = null; }
    }
    toWrite.push({
      id: raw.id, type: raw.type, title: str(raw.title), servings: str(raw.servings), time: str(raw.time),
      source: str(raw.source), ingredients: str(raw.ingredients), steps: str(raw.steps), body: str(raw.body),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
      fav: !!raw.fav, photo, createdAt: Number(raw.createdAt) || updatedAt, updatedAt,
    });
    if (cur) updated++; else added++;
  }
  if (toWrite.length) await db.putMany(toWrite);
  requestPersist();
  return { added, updated, skipped };
}

async function renderSettings() {
  setTop({ title: '設定' });
  const items = await db.all();
  const count = (t) => items.filter((i) => i.type === t).length;
  const last = Number(lsGet(LAST_EXPORT_KEY)) || 0;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => null) : null;
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const keys = 'caches' in window ? await caches.keys().catch(() => []) : [];
  const version = keys.find((k) => k.startsWith('janna-'))?.slice(6) || '—';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

  $view.innerHTML = `
    <section class="panel">
      <h3>資料</h3>
      <p>食譜 ${count('recipe')} · 配方 ${count('formula')} · 筆記 ${count('note')}</p>
      <p class="muted">所有資料只存在這台裝置的瀏覽器中，不會上傳到任何地方。</p>
    </section>

    <section class="panel">
      <h3>備份</h3>
      <p>上次匯出：${last ? fmtDate(last) : '從未匯出'}</p>
      <div class="btns">
        <button type="button" class="btn primary" id="exp">匯出備份</button>
        <button type="button" class="btn" id="imp">匯入備份</button>
        <input type="file" id="impFile" accept=".json,application/json" hidden>
      </div>
      <p class="muted">匯出的檔案可以存到「檔案」App 或 iCloud Drive。匯入時會和現有資料合併，同一筆資料保留比較新的版本。</p>
    </section>

    <section class="panel">
      <h3>儲存狀態</h3>
      <p>${persisted === true ? '✓ 已設為永久保存' : '尚未設為永久保存（存入第一筆資料後會自動申請）'}</p>
      ${est ? `<p class="muted">已使用 ${mb(est.usage || 0)}</p>` : ''}
      ${standalone ? '' : `<p class="warn">目前不是從主畫面開啟。請在 Safari 點「分享」→「加入主畫面」，之後都從主畫面的圖示開啟。主畫面版和 Safari 分頁的資料是分開的。</p>`}
    </section>

    <section class="panel">
      <h3>關於</h3>
      <p class="muted">Janna · 版本 ${esc(version)}</p>
    </section>`;

  $('#exp').addEventListener('click', async () => {
    try {
      if (!items.length) { toast('目前沒有資料可以匯出'); return; }
      if (await exportData()) renderSettings();
    } catch (err) {
      toast('匯出失敗：' + err.message);
    }
  });
  const $impFile = $('#impFile');
  $('#imp').addEventListener('click', () => $impFile.click());
  $impFile.addEventListener('change', async () => {
    const file = $impFile.files[0];
    $impFile.value = '';
    if (!file) return;
    try {
      const r = await importData(file);
      toast(`匯入完成：新增 ${r.added}、更新 ${r.updated}、略過 ${r.skipped}`);
      renderSettings();
    } catch (err) {
      toast(err.message);
    }
  });
  return 'settings';
}

/* ---------- 路由 ---------- */

async function route() {
  state.dirty = false;
  await releaseWake();
  releaseURLs();

  const raw = location.hash.slice(1) || '/recipe';
  const [path, query = ''] = raw.split('?');
  const [, name = 'recipe', arg = ''] = path.split('/');
  const params = new URLSearchParams(query);

  let tab = name;
  try {
    if (TYPES[name]) {
      if (params.has('tag')) state.tag[name] = params.get('tag');
      tab = await renderList(name);
    } else if (name === 'item') {
      tab = await renderItem(decodeURIComponent(arg));
    } else if (name === 'edit') {
      tab = await renderEdit(decodeURIComponent(arg));
    } else if (name === 'new') {
      tab = await renderEdit(null, TYPES[arg] ? arg : 'recipe');
    } else if (name === 'settings') {
      tab = await renderSettings();
    } else {
      location.replace('#/recipe');
      return;
    }
  } catch (err) {
    console.error(err);
    $view.innerHTML = `<p class="empty">發生錯誤：${esc(err.message)}</p>`;
  }
  $tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  window.scrollTo(0, 0);
}

// 編輯中按返回或切換分頁時，提醒尚未儲存
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (a && state.dirty && !confirm('有尚未儲存的變更，確定要離開嗎？')) e.preventDefault();
}, true);

window.addEventListener('hashchange', route);
route();

/* ---------- Service Worker（離線與更新） ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      const offer = (worker) => toast('有新版本', '更新', () => worker.postMessage('SKIP_WAITING'));
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      // iPhone 上 App 常常只是從背景切回來，趁這時檢查更新
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch (err) {
      console.warn('Service worker 註冊失敗', err);
    }
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
