#!/usr/bin/env python3
"""把食藥署「食品營養成分資料集」轉成 App 用的精簡 JSON（data/nutrition.json）。

資料來源：https://data.gov.tw/dataset/8543 （政府資料開放授權條款第 1 版）

用法（在專案根目錄執行）：
    python3 tools/build_nutrition.py            # 從食藥署下載最新資料
    python3 tools/build_nutrition.py 20.zip     # 改用已下載的 ZIP 或 CSV

只用 Python 標準函式庫。資料大約每 3 個月更新一次。
"""
import csv
import datetime
import io
import json
import os
import sys
import urllib.request
import zipfile

URL = 'https://data.fda.gov.tw/data/opendata/export/20/csv'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'nutrition.json')

# (App 內代號, 資料集裡的分析項名稱, 顯示名稱, 顯示單位, 換算倍數)
NUTRIENTS = [
    ('kcal',    '熱量',         '熱量',       'kcal', 1),
    ('protein', '粗蛋白',       '蛋白質',     'g',    1),
    ('fat',     '粗脂肪',       '脂肪',       'g',    1),
    ('satfat',  '飽和脂肪',     '飽和脂肪',   'g',    1),
    ('trans',   '反式脂肪',     '反式脂肪',   'g',    0.001),  # 原始單位 mg
    ('carb',    '總碳水化合物', '碳水化合物', 'g',    1),
    ('sugar',   '糖質總量',     '糖',         'g',    1),
    ('fiber',   '膳食纖維',     '膳食纖維',   'g',    1),
    ('sodium',  '鈉',           '鈉',         'mg',   1),
    ('calcium', '鈣',           '鈣',         'mg',   1),
    ('iron',    '鐵',           '鐵',         'mg',   1),
]


def read_rows(src):
    if src is None:
        req = urllib.request.Request(URL, headers={'User-Agent': 'janna-nutrition-builder'})
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read()
    else:
        with open(src, 'rb') as f:
            raw = f.read()
    if raw[:2] == b'PK':
        z = zipfile.ZipFile(io.BytesIO(raw))
        raw = z.read(next(n for n in z.namelist() if n.lower().endswith('.csv')))
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))


def num(s):
    s = (s or '').strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def short_desc(s):
    # 「樣品狀態:生; 前處理描述:去殼,混合均質」→「生；去殼,混合均質」
    parts = []
    for p in (s or '').split(';'):
        p = p.strip()
        if ':' in p:
            p = p.split(':', 1)[1].strip()
        if p:
            parts.append(p)
    return '；'.join(parts)


def main():
    rows = read_rows(sys.argv[1] if len(sys.argv) > 1 else None)
    wanted = {n[1]: i for i, n in enumerate(NUTRIENTS)}
    foods = {}
    categories = []
    for r in rows:
        fid = r['整合編號'].strip()
        if not fid:
            continue
        f = foods.get(fid)
        if f is None:
            cat = r['食品分類'].strip()
            if cat not in categories:
                categories.append(cat)
            unit_w = num(r['每單位重'].replace('克', ''))
            f = foods[fid] = {
                'id': fid,
                'name': r['樣品名稱'].strip(),
                'alias': r['俗名'].strip(),
                'cat': categories.index(cat),
                'desc': short_desc(r['內容物描述']),
                'unit': unit_w if unit_w else None,
                'v': [None] * len(NUTRIENTS),
            }
        i = wanted.get(r['分析項'].strip())
        if i is not None:
            v = num(r['每100克含量'])
            if v is not None:
                f['v'][i] = round(v * NUTRIENTS[i][4], 4)

    out = {
        'source': '衛生福利部食品藥物管理署「食品營養成分資料集」',
        'url': 'https://data.gov.tw/dataset/8543',
        'license': '政府資料開放授權條款第 1 版',
        'fetched': datetime.date.today().isoformat(),
        'nutrients': [[n[0], n[2], n[3]] for n in NUTRIENTS],
        'categories': categories,
        # 每筆：[整合編號, 名稱, 俗名, 分類索引, 內容描述, 每單位重(克), 每 100 克的各營養素...]
        'foods': [[f['id'], f['name'], f['alias'], f['cat'], f['desc'], f['unit'], *f['v']]
                  for f in sorted(foods.values(), key=lambda x: x['id'])],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(foods)} 種食品、{len(categories)} 個分類 → {os.path.relpath(OUT)} '
          f'({os.path.getsize(OUT) / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
