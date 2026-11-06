# StockView

Obsidian 的美股持股儀表板，桌機和 iPad 都能用。不需要 Dataview。

- 即時報價（盤中每 5 秒），盤前／盤後價格
- 每檔市值、未實現損益、今日漲跌；總市值、總損益、今日損益、總成本（美元或台幣）
- 估值區間：自己設下限／上限，看現價落在哪裡
- 價格警示：突破上限、跌破下限時提醒；有緩衝區和冷卻時間，震盪時不會一直響
- 華爾街評級（分析師共識，僅供參考）
- 資料都免費：報價來自 Yahoo Finance，評級來自 Finnhub（要免費金鑰，不填也能用其他功能）

> 不構成投資建議。免費報價可能有延遲或中斷。

## 安裝

**iPad／iPhone／桌機（BRAT）**：安裝社群外掛 BRAT → Add Beta plugin → 填 `MalionRay/stockview` → 啟用 StockView。之後 BRAT 會自動更新。

**手動**：從 [Releases](https://github.com/MalionRay/stockview/releases) 下載 `main.js`、`manifest.json`、`styles.css`，放到 `<vault>/.obsidian/plugins/stockview/`。

## 使用

1. 左側的圖表圖示（或指令「StockView: 打開儀表板」）打開儀表板
2. 按「新增股票」：代號、股數、每股成本、估值下限／上限（股數空白＝只追蹤）
3. 每檔股票是 `Portfolio` 資料夾裡的一篇筆記，可以在筆記裡寫買進理由和紀錄：

```yaml
---
ticker: NVDA
shares: 50
cost: 120.5
low: 150
high: 220
---
```

之前 Dataview 儀表板的 Portfolio 筆記格式相同，可以直接用（儀表板那篇 dataviewjs 筆記可以刪掉）。

### 華爾街評級

到 [finnhub.io](https://finnhub.io) 免費註冊，把 API key 貼到 設定 → StockView → Finnhub 金鑰 →「設定…」。
金鑰只存在這台裝置的 Obsidian 安全儲存區，不會寫進 Vault、不會同步；每台裝置各貼一次。

### 警示

- 價格碰到上限或下限時跳出通知（點一下才關）並發出提示音；桌機另有系統通知
- 響過之後，價格要回到界線內 1%（緩衝區）才會再提醒；同一檔 30 分鐘內不重複（冷卻時間）
- 預設盤前、盤後也提醒；Obsidian 開著時儀表板沒開也會在背景檢查（iPad 切到別的 App 時會暫停）

## 開發

```
npm ci
npm run build   # tsc + esbuild → main.js
npm run check   # iOS 相容等硬性限制
npm test
```
