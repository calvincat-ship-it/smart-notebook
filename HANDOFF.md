# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-07-30 收工
- 機器：桌機

## 做到哪（本次 session，v12.01 → v13.00，皆已 commit+push、preview stub 實測通過、無 console error）
- **雲端自動同步 + 手動同步鈕 v12.01（核心修復）**：修使用者回報「兩端不自動同步」。`cloudAutoSync()` 取代被動確認式——Drive `modifiedTime` 偵測變動、latest-wins 自動決定上傳/下載（不再 confirm、`lastEditAt` 比對）、自己上傳的不重下載（防迴圈）、編輯中延後套用；開 App/回前景/輪詢皆呼叫；標題列 🔄 `#syncBtn`（連線後才顯示）。
- **輪詢改 5 分鐘 v12.02**：`CLOUD_POLL_MS` 20s→300000（回前景即時+🔄 手動，夠用）。
- **手動同步授權修復 v12.03**：電腦端 🔄 顯示「Google 授權未完成」→ manual 路徑改「先 silent、失敗才 interactive('') 彈窗授權」；auto 維持純 silent。
- **分類標題改按鈕啟動編輯 v12.04**：標題預設 span（點=展開），編輯改由標題列 ✏️ 鈕（editingCats WeakSet + pendingEditCat）；blur/Enter 提交、空→未命名。
- **圖片輸入 OCR v13.00（新功能，確認升 v13）**：🖼 圖片輸入鈕交給 Claude 視覺辨識圖中文字；`callClaude` 加 visionImages、有圖時 content 改區塊陣列（image base64 在前+text）；僅 jpeg/png/gif/webp、10MB；整理後 confirm 保留原圖（連新 bullets）；OCR 圖屬當前輸入暫存不進 drafts/雲端。

## 下一步
- （無待接續工作。）

## 待決 / 卡住的問題
- （無）圖片 OCR 的真實視覺呼叫未實機測（stub 過），使用者可用真金鑰拍收據測。

## 注意事項（給另一台的 Claude）
- 雲端同步狀態欄位：`lastSeenModifiedTime`(已處理的 Drive modifiedTime)、`lastEditAt`(本機最後編輯)——勿刪，是 latest-wins/防迴圈的依據。
- 手動同步務必用「silent 失敗→interactive('') fallback」：桌機 session 過期/擋第三方 cookie 時純 silent 會失敗。
- 摺疊/編輯狀態（expandedCats/expandedTasks/editingCats）是 session-only、不持久化、不同步。
- OCR 圖只吃 image/jpeg|png|gif|webp；圖片會用較多用量。callClaude 有圖時 content 一定是「image 區塊在前、text 在後」。
- 版本 vNN.MM：小改/修 bug 直接 bump minor；新功能大改先確認。目前 **v13.00**（APP_VERSION 與 sw CACHE_NAME 同步）。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
