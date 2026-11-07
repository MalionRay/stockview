# StockView Plugin

美股持股儀表板（像 Seeking Alpha 的持股清單）：即時報價含盤前盤後、損益、估值區間、華爾街評級、價格警示。
從之前的 Dataview 儀表板（Portfolio 筆記＋dataviewjs）改寫成正式外掛：不用 Dataview、BRAT 自動更新、iPad 可用；和 Language Learning 是兩個獨立外掛。

## 硬性限制
- 必須能在 iOS 執行：manifest isDesktopOnly=false，禁用 Node API (fs, path, process)
- 檔案操作只用 Vault API；網路只用 requestUrl()，不用 fetch
- 金鑰（Finnhub）只放 app.secretStorage（id "stockview-finnhub"），不得寫入 data.json、不得寫進筆記（Vault 會同步到 Dropbox）
- 只用免費資料；不要加 Seeking Alpha Quant Rating（使用者說沒用）
- 不要用假的 User-Agent 或其他方式繞過網站的機器人檢查

## 資料
- 持股：設定的資料夾（預設 Portfolio）每檔一篇筆記，frontmatter：ticker、shares、cost（每股平均成本）、low、fair、high（估值下限／合理價位／上限；上下限是警示線，fair 只顯示不警示，v0.5.0）；格式和舊 Dataview 儀表板相同（舊筆記沒有 fair 照常）
- 合理價位 fair：合併時取第一個有填的；checkInput 要求 low ≤ fair ≤ high；估值區間欄在色條上畫一條主題色細線（fairPos），下面寫「合理 $x，現價高／低 y%」（vsFair，用警示價格；差不到 0.5% 寫接近合理價）；只填 fair 沒有上下限時只顯示那行字；加到其他清單也預填
- 多個清單（v0.2.0）：清單＝資料夾底下第一層子資料夾（更深的算在第一層）；直接放在資料夾裡的是「主清單」（MAIN_LIST ""，不能改名刪除；沒有股票又有其他清單時不顯示，visibleLists）；空的子資料夾也是清單（readLists 讀 TFolder.children）
- 同一檔可以在好幾個清單，各有自己的股數、成本、上下限；清單內同一檔分好幾篇才合併（mergeHoldings，key＝清單|代號）：股數相加、成本加權平均、上下限用路徑排序第一篇有填的；「全部」（ALL_LISTS "*"）跨清單合併成一列（mergeAcrossLists），lists 記在哪些清單
- 畫面目前的清單存 localStorage stockview:list（每台裝置各自；不存在就回到全部，只有一個清單就是那個）；新增股票預設放目前的清單（看全部時放第一個）
- 清單名稱 checkListName：不能空白、最多 30 字、不能有 \ / : * ? " < > | # ^ [ ]、不能 . 開頭、不能叫「主清單」「全部」、不分大小寫不能重複
- shares 空白＝只追蹤（觀察，不算損益）
- 新增／編輯／刪除也可以在儀表板做（HoldingModal、DeleteHoldingModal）：新增建立筆記（含買進理由、估值想法、紀錄三段）；編輯只改 frontmatter；刪除用 fileManager.trashFile（照 Obsidian 的刪除設定）；同一清單分在多篇的不能在視窗改
- 移到其他清單（MoveHoldingModal，fileManager.renameFile 搬筆記；目的地已有這檔就不行）；加到其他清單（HoldingModal 預填代號與上下限）；清單新增／改名（ListModal，renameFile 搬資料夾）／刪除（DeleteListModal，整個資料夾 trashFile）
- 報價（src/quote.ts）：Yahoo chart API（query1…/v8/finance/chart/<代號>?interval=1m&range=1d&includePrePost=true），每檔一次請求，同時最多 4 個（feed.pool）；session 依 meta.currentTradingPeriod；盤前／盤後價＝最後一根有價格的 1 分 K 落在 pre／post 區間
- 匯率：TWD=X，只在總計用台幣或有台股（.TW／.TWO）時抓，10 分鐘一次；沒抓到暫用 32 並標示
- 華爾街評級（src/ratings.ts）：Finnhub /stock/recommendation 最新一期，分數 1＝強力買進…5＝強力賣出（≤1.5／≤2.5／≤3.5／≤4.5）；只有美股代號（isUsTicker）；快取在 localStorage stockview:ratings，12 小時一次；依序抓、間隔 1.1 秒（免費版每分鐘 60 次）；401／403 後 1 小時不再試；只在儀表板開著時更新
- 設定在 data.json（src/config.ts，sanitizeSettings 只留認得的欄位）；排序、評級快取、警示狀態與紀錄在 localStorage（每台裝置各自）

## 更新與警示
- src/feed.ts：儀表板開著時開盤（含盤前盤後）每 refreshSec（預設 5 秒）、收盤每 closedRefreshSec（預設 60 秒）；沒開而且有警示線、開了「儀表板沒開也檢查」時背景 30 秒／收盤 5 分鐘；還沒有報價時當作開盤
- Yahoo 429：間隔加倍（從 30 秒起）最多 5 分鐘，成功就恢復；全部連不到時顯示離線
- 警示（src/alarm.ts 純函式＋src/alarms.ts 狀態）：每個清單的每一檔各自判斷（key＝清單|代號），同一輪同一檔同一條線在好幾個清單都響時只通知一次（其他清單也記成已響）；非主清單的通知後面加（清單名）；價格 ≥ 上限或 ≤ 下限響一次；之後要回到界線內 bufferPct%（預設 1%）才重新待命；同一檔 cooldownMin（預設 30 分鐘）內不再響，冷卻中沒響的仍待命；改了界線就重新待命；last=null 表示還沒響過
- 警示價格：alarmUseExtended（預設開）且不是盤中時用盤前／盤後價（calc.effectivePrice）；估值區間的位置也用同一個價格
- 警示狀態與紀錄（最近 50 筆）存 localStorage，重開不重響；不在清單上的狀態不刪（啟動時筆記快取可能還沒好）
- 通知：Notice（點一下才關）＋提示音（src/sound.ts Web Audio，iOS 要在點擊時 unlockAudio，儀表板任何點擊都會呼叫）＋桌機系統 Notification

## 同步（src/sync.ts，v0.1.1）
- 持股筆記靠 Remotely Save 同步（使用者設定每 5 分鐘自動同步、不同步 .obsidian）；為了讓別台裝置快一點看到，外掛主動觸發 app.commands.executeCommandById('remotely-save:start-sync')（非正式內部 API，失效時只靠它的定時同步）
- 新增／編輯／刪除股票後 2 秒（soon，連續改只同步一次）；打開儀表板（60 秒內不重複）；按重新整理（15 秒內不重複）
- Remotely Save 正在同步（內部 isSyncing）時先等它結束（最多 60 秒）再觸發；離線、沒裝 Remotely Save、設定 autoSync 關閉時不做事
- 不在筆記被改（metadataCache changed）時觸發：同步下載的檔案也會觸發，會多同步一次

## 市場行情（src/markets.ts、src/chart.ts、src/marketview.ts，v0.3.0）
- 另一個畫面（MARKET_VIEW "stockview-markets"；左側地球圖示、指令「打開市場行情」、儀表板「市場」按鈕；畫面上「持股」回儀表板）
- 分頁：美股（^GSPC、^DJI、^IXIC、^SOX）、台股（^TWII；櫃買 ^TWOII 使用者實測拿不到，v0.4.1 拿掉）、日股（^N225、TOPIX 用 ETF 1306.T 代替）、陸股（000001.SS、399001.SZ、000300.SS）、韓股（^KS11、^KQ11）、歐股（^STOXX50E、^GDAXI、^FTSE、^FCHI）、匯率（美元、100 日圓、人民幣、1000 韓元、歐元、英鎊、瑞士法郎、澳幣對台幣；英鎊、澳幣備援用 GBPUSD=X／AUDUSD=X × TWD=X，瑞士法郎用 TWD=X ÷ CHF=X）；使用者 2026-11-07 選的：只要指數走勢圖和匯率（不要個股圖、不要這些市場的持股）
- 期間 RANGES：1日（5m）、5日（15m）、1月（60m）、6月、今年、1年（1d）、5年（1wk）；整頁共用；分頁與期間存 localStorage stockview:market-tab／stockview:market-range
- 資料：Yahoo chart API（range＋interval），parseSeries；基準＝chartPreviousClose（1日＝昨收，其他＝區間開始前），沒有就用第一點；1日 x 軸用交易時段（domain），其他依點的順序（跳過休市）
- 交叉匯率代號（JPYTWD=X 等）拿不到時用美元匯率換算（fallback mul／div，combineSeries 取當時或之前最近的值）；429 不換算；顯示倍數 scale（日圓 100、韓元 1000）
- 快取 MarketData：1日 1 分鐘、5日 5 分鐘、1月 15 分鐘、其他 30～60 分鐘；1日每分鐘自動更新；重新整理清快取；換期間時舊圖變淡保留不閃爍，換市場才清掉
- 走勢圖 drawChart：2px 線（non-scaling-stroke）、10% 面積、基準線（1px 實線）、最後一點圓點、右側最高／最低、下方起訖時間（交易所當地時間，gmtoffset）；十字線＋提示框（時間、數值、比基準 %），pointer 事件，觸控 touch-action: pan-y；顏色跟漲跌（colorStyle）
- 代號是依常識選的，開發環境連不到 Yahoo 沒實測；拿不到的卡片顯示原因，其他照常
- 台股頁另有（v0.4.0）：台指期近月（src/taifex.ts）、台積電 ADR（TSM）、MSCI 台灣 ETF（EWT）；使用者 2026-11-07 要台股夜盤，選「兩個都加」
- 台指期資料：期交所行情網頁用的公開資料 POST https://mis.taifex.com.tw/futures/api/getQuoteList（JSON：MarketType 0＝日盤／1＝夜盤、SymbolType F、KindID 1、CID TXF、RowSize 全部…），回 RtData.QuoteList；挑第一個名稱沒有「/」（跨月價差）且有價格的＝近月；CLastPrice、CRefPrice（參考價）、CHighPrice、CLowPrice、CTime（235958 → 23:59:58）；非正式介面，可能改格式或被擋（別人遇過 520），不加偽裝標頭
- 哪一盤（台北 UTC+8）：日盤 08:45～13:45、夜盤 15:00～隔天 05:00（週一～五下午開始）；平日 08:45～15:00 查日盤、其他時間查夜盤；國定假日不知道
- 期交所沒有歷史走勢：TxfTape 把這頁開著時收到的價格存 localStorage stockview:txf-points（每盤一份，sessionKey；價格或時間變才加點，最多 1500 點），圖畫這些點；不受期間切換影響；台股頁每 30 秒只更新台指期（不打斷整頁更新）

## 畫面（src/view.ts）
- 清單分頁（全部＋各清單與股票數＋「＋ 新清單」；選了主清單以外的清單時有 ⋯ 改名／刪除）；全部裡每列標出在哪些清單；點代號的選單：同一檔在多個清單時每個清單各一項「編輯（清單）」「打開筆記（清單）」，否則編輯／打開筆記／移到其他清單／加到其他清單／從「清單」刪除
- 狀態列（盤前／盤中／盤後／收盤、更新時間、間隔）、提示（429、匯率暫用、Finnhub 金鑰）、四張卡片（總市值、總損益、今日損益、總成本）、表格、警示紀錄（details）
- 表格欄：股票（點代號 → 選單：編輯／打開筆記／刪除）、現價、今日漲跌、盤前／盤後（相對現價的 %）、股數／成本、市值、未實現損益、估值區間（色條＋位置＋合理價位細線與「現價高／低 x%」＋「突破上限／跌破下限／區間內 xx%」，已響過加 🔕）、華爾街評級
- 排序：點表頭（存 localStorage stockview:sort），持股在前、觀察名單在後；預設市值由大到小
- 漲跌顏色 colorStyle：tw 紅漲綠跌（預設）／us 綠漲紅跌
- 每次更新只重畫內容不換外框（表格左右捲動位置留著）；第一欄 sticky；窄螢幕按鈕只留圖示、卡片兩欄
- 設定頁不放 SecretComponent：一列摘要＋「設定…」開 FinnhubKeyModal（金鑰欄不用 type=password；只留英數字）；也有指令「設定 Finnhub 金鑰」

## 專案慣例
- 原始碼在 src/；`npm run build` 先跑 tsc 再用 esbuild 輸出 main.js
- `npm run check` 掃描是否違反上面的硬性限制；每次改完都要跑
- `npm test`：test/*.test.ts 用 esbuild 打包（obsidian 換成 test/mocks/obsidian.cjs，DOM 用 jsdom）後由 node --test 執行；每次改完都要跑，新功能要加測試
- 測試資料只用編的數字和代號（repo 是公開的）
- 實機測試狀態記在 TESTING.md；新功能完成要加進「未實機測試」
- GitHub Action 每次推送都跑 build、check、test；推到 main 且測試通過、該版本還沒有 release 才發布（main.js、manifest.json、styles.css）
- 發布：同時改 manifest.json 與 versions.json 的版本號，推到 main；iPad 用 BRAT 追蹤 MalionRay/stockview
- 部署到電腦：把 main.js、manifest.json、styles.css 複製到 `<vault>/.obsidian/plugins/stockview/`
- 回覆使用者用繁體中文（台灣用語）
