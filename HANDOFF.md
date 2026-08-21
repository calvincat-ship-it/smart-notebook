# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-21 收工
- 機器：桌機

## 做到哪（本次 session，v13.00 → v14.06，皆已 commit+push、preview 實測通過、無 console error）
- **掃描電子發票 QR 記帳 v14.00（新功能，確認升 v14）**：記帳視窗頂部 `📷 掃描發票 QR`。原生 `BarcodeDetector` 本地解析（零 API/零金鑰/不上傳）。`parseEinvoiceQR(left,right)`：前 77 碼 ASCII header（發票號碼/民國日期→西元/總計額16進位/賣方統編）一定可靠；品目段 `left[77:]+right去**` 冒號分隔、前 3 token 丟棄後每 3 個一組；中文 UTF-8 直用或 `TextDecoder('big5')` 還原；`**`/品目太多→退「整張記一筆」。scanned expense 帶 `inv` 防重掃。iOS 無 BarcodeDetector→整區隱藏。相機路徑未真機測（解析頁內單元測過）。
- **任務卡片連結化 v14.01**：`linkifyInto` 用 DOM node 把 URL/電話/email/UNC 變 `<a>`；URL/file 字元類僅 ASCII 遇中文斷開；`tel:`/`mailto:`/`file:`；外部 `target=_blank`+`stopPropagation`。
- **分類條列筆記也連結化＋bullet 改 ✒ 鈕編輯 v14.02**：bullet 唯讀連結 span / ✒ 啟動純文字 contenteditable 雙模式（比照 v12.04）；`editingBullets` Set + `pendingEditBullet`；`addItem` 改走此流程；移除舊 `pendingFocus`。
- **整理同日活動衝突警告 v14.03**：`processInput` 套用前 `confirmBusyDayConflicts(result)`——新增有日期任務 vs 現有任務同日→confirm 列每日(含星期)新增/當天已有；確認才建立、取消整批不建立且保留輸入。
- **可暫緩＋已完成任務堆疊 v14.04–06**：`buildTaskCard` 抽出；`buildTaskStack(items,kind,label,expanded,toggle)` 通用（low/done 共用）；`.card-stack` CSS 基底＋顏色修飾。疊紙：三張同尺寸、`translate(-5,-5)/(-10,-10)` 往右下、露左上角；`.low-stack` 全藍、`.done-stack` 前藍(可暫緩)/中黃(普通)/後紅(緊急)。`lowStackExpanded`/`doneStackExpanded` session-only 預設收合。

## 下一步
- （無待接續工作。）

## 待決 / 卡住的問題
- 電子發票 QR **相機掃描路徑未真機測**（in-app Browser 無 BarcodeDetector；解析函式已頁內單元測通過）。使用者可拿紙本電子發票在 Android 手機實測；若品名亂碼或金額不符再回報調整編碼處理。

## 注意事項（給另一台的 Claude）
- 疊紙堆疊 class 已從 `low-stack-*` 改為共用 `card-stack-*`；顏色由 `.low-stack`/`.done-stack` 修飾。改樣式勿再用舊 class 名。
- QR 解析：前 77 碼固定 ASCII 可靠、品目段防禦式解析、失敗退整張；expense `inv` 欄位（防重掃）勿刪、`normalizeState` 已保留。
- 摺疊/編輯/堆疊狀態（expandedCats/expandedTasks/editingCats/editingBullets/lowStackExpanded/doneStackExpanded）皆 session-only、不持久化、不同步。
- 測試踩雷（詳見 memory `feedback_pwa_testing_approach`）：in-app Browser 無 BarcodeDetector；改 CSS 要替 stylesheet 加 query 強制刷新；背景分頁 `.blur()` 不觸發（測提交改 `dispatchEvent(new Event('blur'))`）；screenshot 常因 pane 未顯示無法合成→改 computed style + 傳同 CSS 預覽 HTML。
- 版本 vNN.MM：小改/修 bug 直接 bump minor；新功能大改先確認。目前 **v14.06**（APP_VERSION 與 sw CACHE_NAME 同步）。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
