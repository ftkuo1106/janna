# Janna

私人用的食譜、配方與筆記 PWA，設計給 iPhone 從主畫面使用。

- **食譜**：材料、步驟、照片、來源
- **配方**：醬料、麵團等比例配方
- **筆記**：私人筆記
- 搜尋、標籤、收藏；材料數量可依倍數自動換算；做菜時可點選劃掉材料與步驟
- 可離線使用；所有資料只存在手機瀏覽器（IndexedDB），不會上傳
- 設定頁可匯出／匯入 JSON 備份
- **營養**：查詢食材營養成分；食譜的材料對應到食品後，自動估算整道菜與每份的營養

## 營養資料

來源是衛福部食藥署的[食品營養成分資料集](https://data.gov.tw/dataset/8543)，依政府資料開放授權條款第 1 版使用（App 內已標註出處）。

[tools/build_nutrition.py](tools/build_nutrition.py) 會下載原始資料，只留下需要的營養素，轉成 [data/nutrition.json](data/nutrition.json)，跟著 App 一起部署並快取，離線也能查。資料大約每 3 個月更新一次，要更新時：

```bash
python3 tools/build_nutrition.py
```

然後照「發佈新版」的步驟把 `sw.js` 的 `VERSION` 加一再 push。

材料與食品的對應、每單位重量會存在手機上，也包含在匯出的備份檔裡。同名的材料（例如「雞蛋」）在所有食譜共用同一個對應。

純 HTML / CSS / JavaScript，沒有 build 步驟。

## 本機測試

```bash
python3 -m http.server 8000
```

然後開啟 <http://localhost:8000/>。

## 部署到 GitHub Pages

1. push 到 GitHub 的 `main` 分支。
2. 到 repo 的 **Settings → Pages**，Source 選 **Deploy from a branch**，分支選 `main`、資料夾選 `/ (root)`。
3. 一兩分鐘後網址會是 `https://ftkuo1106.github.io/janna/`。

## 安裝到 iPhone

用 **Safari** 開啟網址 → 點「分享」→「加入主畫面」。之後都從主畫面圖示開啟；主畫面版和 Safari 分頁的資料是分開的。

## 發佈新版

修改程式後，**一定要把 [sw.js](sw.js) 裡的 `VERSION` 加一**（例如 `1.0.0` → `1.0.1`），否則手機會一直使用快取裡的舊版。手機開啟 App 時會出現「有新版本」提示，點「更新」即可。

如果新增了檔案，也要把它加進 `sw.js` 的 `ASSETS` 清單。

## 資料與備份

- 資料綁定網址（`ftkuo1106.github.io`）。日後若換託管或網域，舊資料不會自動帶過去，請先匯出再到新網址匯入。
- 刪除主畫面 App、清除 Safari 網站資料或換手機，資料都會消失，請定期到「設定 → 匯出備份」存到「檔案」或 iCloud Drive。
- 匯入會與現有資料合併，同一筆資料保留較新的版本。

## 檔案結構

```
index.html             主頁面
manifest.webmanifest   PWA 設定（名稱、圖示、啟動方式）
sw.js                  Service Worker：離線快取與更新
css/styles.css         樣式（含深色模式）
js/app.js              畫面與功能
js/db.js               IndexedDB 存取
js/nutrition.js        營養資料搜尋與計算
data/nutrition.json    營養資料（由 tools/build_nutrition.py 產生）
tools/                 資料轉換腳本
icons/                 App 圖示
```
