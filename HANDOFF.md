# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-07-30 收工
- 機器：桌機

## 做到哪（本次 session）
- **暫存功能 v11.00**：輸入卡片加「📥 暫存」，把 textarea 內容存進本機 `state.drafts`（不呼叫 Claude）；暫存區可重新編輯（改空即刪）、🗑 刪除、隨時新增；按「整理」時把所有暫存＋目前輸入＋PDF 文字合併成**單一 API 呼叫**、成功後清空 → 省用量。drafts 為**裝置本機 scratch，刻意不進雲端 bundle**；normalizeState/loadState 向後相容。
- **暫存附件綁定 v11.01**：暫存時把當下待整理檔案一起收進**那一則**暫存（blob 存 IndexedDB、key＝file ref；draft 只留 metadata）→ 重整不遺失、且與該則綁定。整理時每個檔案帶 `context`＝所屬暫存文字，prompt 要 Claude 依「隨附內容」對應到該段的 bullet、不跨則配錯；純附件無文字→不呼叫 Claude 直接歸 📎 附件；暫存 PDF 的抽取文字併入該則送出。刪則/移除單檔會連帶清 IDB blob。
- **任務緊急程度手動變更 v11.02**：任務卡片優先度標籤改成可點選膠囊 select（緊急/普通/可暫緩/🔄依日期自動）。手動選級→存 `task.priorityOverride`、即時重排+換色+顯示「✎ 手動」、之後不再隨截止日升級；選「依日期自動」清除 override。`priorityOf` 回傳 `{tier(有效),total,auto,overridden}`；normalizeState 遷移 priorityOverride（僅 urgent/normal/low）。
- 三項皆 commit+push、preview 實測通過、無 console error。目前線上 **v11.02**。
- **釐清（非 bug、不要「修」）**：`📎 附加檔案` 沒有 `accept` 限制，PDF 本來就能附加（實測確認）。兩顆按鈕差別是**用途**：附加檔案＝純保留檔案、Claude 不讀內容；上傳 PDF＝抽文字給 Claude。手機上點附加檔案可能預設開相簿，PDF 要切到「檔案／瀏覽」分頁。

## 下一步
- （無待接續工作，可開始新的功能開發。）

## 待決 / 卡住的問題
- （無）

## 注意事項（給另一台的 Claude）
- 暫存(drafts)只存本機、不上雲；附件 blob 暫存在 IDB(key＝ref)，整理後 createAttachment 會另存新 id 並刪掉 temp ref blob。
- 版本規則 vNN.MM：小改直接 bump minor、大改先確認；APP_VERSION 與 sw CACHE_NAME 同步。目前 **v11.02**。
- 記帳：既有已被分到首頁「財務紀錄」的舊自由文字不會自動搬進記帳，只有新輸入才歸集。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
