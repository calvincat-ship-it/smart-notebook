# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-07-30（記錄累積變動）
- 機器：桌機

## 做到哪（本次 session，v11.00 → v12.00，皆已 commit+push、preview 實測通過、無 console error）
- **暫存功能 v11.00**：輸入先存本機 `state.drafts`（不呼叫 Claude），整理時批次成單一 callClaude 省用量；drafts 只存本機、不進雲端 bundle。
- **暫存附件綁定 v11.01**：檔案綁進所屬暫存（blob 存 IDB key＝ref），整理時每檔帶 context＝該則文字讓 Claude 逐則對應不配錯；純附件不呼叫 Claude。
- **任務緊急程度手動變更 v11.02**：優先度標籤改可點選膠囊 select（緊急/普通/可暫緩/依日期自動），存 `priorityOverride`。
- **任務卡片附加檔案 v11.03**：每卡「📎 附加檔案」鈕，`addTaskAttachments` 連到任務第一個 bullet，無則 ensureHomeBullet；chip 可就地刪。
- **附件說明 v11.04**：共用 `#attachHelpModal`，輸入區與任務卡片皆有 ℹ️ 入口。
- **設定機密欄位摺疊＋變更確認 v11.05**：中繼站/金鑰摺進 `<details>`，變更已設定值才 confirm，新增不擾。
- **緊急程度保護規則 v11.06**：緊急為地板——不可手動調降（alert 擋）、日期到 `enforceUrgentOverrides()` 強制升級並清掉低階 override。
- **首頁改版 v12.00（大改，已確認）**：輸入卡片（含暫存區）移入標題列 ✏️ `#inputModal`，首頁只留待辦任務+分類整理；分類卡片預設摺疊（點展開、N 項計數、`expandedCats` WeakSet）；待辦「普通/可暫緩」預設摺疊、「緊急」永遠展開（`expandedTasks` Set）。

## 下一步
- （無待接續工作。）

## 待決 / 卡住的問題
- （無）

## 注意事項（給另一台的 Claude）
- 摺疊狀態（expandedCats/expandedTasks）是 session-only、不持久化、不同步——重開 App 會回到預設收合，這是刻意的。
- 暫存(drafts)只存本機、不上雲；附件 blob 暫存在 IDB(key＝ref)，整理後 createAttachment 另存新 id 並刪 temp ref blob。
- 緊急為地板：勿把 enforceUrgentOverrides 或「auto 緊急強制」邏輯移除。
- 📎附加檔案本來就能放 PDF（無 accept 限制），勿為此加限制；手機選不到 PDF 是系統選擇器預設開相簿。
- 版本 vNN.MM：小改直接 bump minor、大改先確認；APP_VERSION 與 sw CACHE_NAME 同步。目前 **v12.00**。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
