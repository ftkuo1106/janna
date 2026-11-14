// 營養資料：載入食藥署資料、搜尋食品、解析材料、計算營養。
import * as db from './db.js';

/* ---------- 資料載入 ---------- */

let dataPromise = null;

export function loadFoods() {
  if (dataPromise) return dataPromise;
  dataPromise = fetch('./data/nutrition.json')
    .then((r) => {
      if (!r.ok) throw new Error('無法載入營養資料');
      return r.json();
    })
    .then((d) => {
      const foods = d.foods.map(([id, name, alias, cat, desc, unit, ...v]) => ({
        id, name, alias, cat: d.categories[cat], desc, unit, v,
        key: (name + ' ' + alias).toLowerCase(),
      }));
      return { ...d, foods, byId: new Map(foods.map((f) => [f.id, f])) };
    })
    .catch((err) => { dataPromise = null; throw err; });
  return dataPromise;
}

/* ---------- 搜尋 ---------- */

// 去掉括號內的補充說明與「少許、適量」等字，例如「雞蛋（室溫）」→「雞蛋」
export const cleanName = (s) => String(s || '')
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/\s*(少許|適量|少量|酌量|些許|一點|隨意)\s*$/, '')
  .replace(/[，,、:：]+$/, '').trim();

// 排序用的名稱：「雞蛋平均值」「雞蛋(白殼)」都視為「雞蛋」
const coreName = (name) => name.replace(/[（(][^）)]*[）)]/g, '').replace(/平均值$/, '').trim();

// 中文名詞的重點通常在最後（「土雞蛋」是蛋、「雞蛋麵」是麵），所以結尾相符的排前面
function rank(f, q) {
  const n = coreName(f.name);
  if (n === q) return 0;
  if (n.endsWith(q)) return 1;
  if (f.alias.split(/[,，]/).some((a) => a.trim() === q)) return 2;
  if (n.startsWith(q)) return 3;
  if (n.includes(q)) return 4;
  if (f.alias.includes(q)) return 5;
  return -1;
}

function searchExact(foods, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const f of foods) {
    if (!words.every((w) => f.key.includes(w))) continue;
    const r = rank(f, words[0]);
    out.push([r < 0 ? 6 : r, f]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length).map((x) => x[1]);
}

// 找不到時逐步去掉前面的字再找，例如「去骨雞腿」→「骨雞腿」→「雞腿」
export function searchFoods(data, query, category = null) {
  const pool = category ? data.foods.filter((f) => f.cat === category) : data.foods;
  const q = cleanName(query);
  if (!q) return { list: category ? [...pool].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')) : [], fuzzy: false };
  let list = searchExact(pool, q);
  if (list.length || category || /\s/.test(q)) return { list, fuzzy: false };
  for (let i = 1; i < q.length; i++) {
    list = searchExact(pool, q.slice(i));
    if (list.length) return { list, fuzzy: true, used: q.slice(i) };
  }
  return { list: [], fuzzy: false };
}

/* ---------- 材料解析與單位 ---------- */

const NUM_RE = /(\d+)\s+(\d+)\s*\/\s*(\d+)|(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/;

// 直接是重量的單位（換算成克）
const MASS = { g: 1, 克: 1, 公克: 1, kg: 1000, 公斤: 1000, 斤: 600, 台斤: 600, 兩: 37.5, mg: 0.001, 毫克: 0.001 };
// 體積與計數單位：預設的「每單位克數」，可在 App 裡修改
const DEFAULT_UNIT_G = {
  ml: 1, 毫升: 1, cc: 1, l: 1000, 公升: 1000,
  大匙: 15, 湯匙: 15, 小匙: 5, 茶匙: 5, 杯: 240,
};

// 「雞蛋 3 顆」→ { name: '雞蛋', qty: 3, unit: '顆' }；沒有數量時 qty 為 null
export function parseIngredient(line) {
  const m = NUM_RE.exec(line);
  if (!m) return { name: cleanName(line), qty: null, unit: '' };
  const qty = m[1] !== undefined ? +m[1] + m[2] / m[3]
    : (m[5] !== undefined ? m[4] / m[5] : +m[4]);
  const name = cleanName(line.slice(0, m.index));
  const rest = line.slice(m.index + m[0].length).trim();
  const unit = readUnit(rest);
  return { name: name || cleanName(rest.slice(unit.length)), qty: isFinite(qty) ? qty : null, unit };
}

const CJK_UNITS = ['大匙', '湯匙', '小匙', '茶匙', '公克', '公斤', '台斤', '毫升', '公升', '毫克',
  '克', '斤', '兩', '杯', '顆', '個', '片', '條', '根', '隻', '粒', '塊', '把', '瓣', '朵', '包',
  '罐', '碗', '盒', '匙', '支', '尾', '張', '球', '撮', '滴', '份', '段', '株', '束', '串', '袋', '瓶'];

function readUnit(rest) {
  const latin = rest.match(/^[a-z]+/i);
  if (latin) return latin[0].toLowerCase();
  return CJK_UNITS.find((u) => rest.startsWith(u)) || '';
}

export const isMassUnit = (unit) => unit in MASS;
export const unitLabel = (unit) => unit || '個';
export const weightKey = (foodId, unit) => `${foodId}|${unit}`;

// 一單位幾克：優先用使用者填的，其次是預設值或資料庫裡的「每單位重」
export function gramsPerUnit(food, unit, weights) {
  if (unit in MASS) return { g: MASS[unit], source: 'mass' };
  const saved = weights[weightKey(food.id, unit)];
  if (saved > 0) return { g: saved, source: 'saved' };
  if (unit in DEFAULT_UNIT_G) return { g: DEFAULT_UNIT_G[unit], source: 'default' };
  if (food.unit) return { g: food.unit, source: 'dataset' };
  return { g: null, source: 'none' };
}

/* ---------- 對應資料（存在 IndexedDB，跟著備份一起匯出） ---------- */

export const MAP_KEY = 'ingredientMap';   // { 材料名稱: 食品編號 | 'ignore' }
export const WEIGHT_KEY = 'unitWeights';  // { '食品編號|單位': 克 }
export const IGNORE = 'ignore';

export async function loadMappings() {
  const [map, weights] = await Promise.all([db.getKV(MAP_KEY, {}), db.getKV(WEIGHT_KEY, {})]);
  return { map, weights };
}

/* ---------- 計算 ---------- */

// 回傳每行材料的狀態與整道菜的營養總和（已乘上倍數 f）
export function computeNutrition(data, ingredientsText, f, { map, weights }) {
  const n = data.nutrients.length;
  const totals = new Array(n).fill(0);
  const rows = [];
  const lines = String(ingredientsText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  lines.forEach((line, k) => {
    if (line.startsWith('#')) return;
    const p = parseIngredient(line);
    const row = { k, line, ...p, food: null, grams: null, perUnit: null, status: 'unmatched' };
    rows.push(row);
    const target = map[p.name];
    if (target === IGNORE) { row.status = 'ignored'; return; }
    const food = target && data.byId.get(target);
    if (!food) return;
    row.food = food;
    if (p.qty === null) { row.status = 'noqty'; return; }
    const pu = gramsPerUnit(food, p.unit, weights);
    row.perUnit = pu;
    if (!pu.g) { row.status = 'needweight'; return; }
    row.grams = p.qty * pu.g * f;
    row.status = 'ok';
    food.v.forEach((v, i) => { if (v !== null) totals[i] += v * row.grams / 100; });
  });
  const counted = rows.filter((r) => r.status === 'ok').length;
  const ignored = rows.filter((r) => r.status === 'ignored').length;
  return { totals, rows, counted, pending: rows.length - counted - ignored };
}

export function fmtValue(v, unit) {
  if (v === null || v === undefined) return '—';
  if (unit === 'kcal') return String(Math.round(v));
  if (unit === 'mg') return v < 10 ? (Math.round(v * 10) / 10).toString() : String(Math.round(v));
  if (v > 0 && v < 0.05) return '<0.1';
  return (Math.round(v * 10) / 10).toString();
}

export function fmtGrams(g) {
  return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10);
}
