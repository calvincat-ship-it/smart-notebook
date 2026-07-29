# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-07-29 收工
- 機器：桌機

## 做到哪（本次 session）
- **圖示重設計 v9.03–v9.04**：SVG 換「疊卡清單」設計；新增 PNG 192/512 + maskable-512（PIL 依同設計重繪，腳本在 scratchpad）；manifest/apple-touch-icon/sw 都接上。補建了桌機缺的 root `.claude/launch.json`。
- **記帳功能 v10.00（大改，已確認）**：Claude schema/prompt 加 `expenses`，消費內容自動歸集、不放首頁分類；header「💰 記帳」視窗＝起始日期篩選(預設全部)+總支出/筆數+分類佔比+每月趨勢+可修正/刪除的明細；納入 Google Drive 雲端同步。
- **空分類刪光自動移除 v10.01**：分類 bullets 全刪光→自動移除卡片，精準刪除不誤刪新建的空拖曳目標。
- 三項皆已 commit + push、preview 實測通過、無 console error。目前線上 **v10.01**。
- 全域新規則：[[feedback_usage_limit_checkpoint]]（額度中斷 checkpoint 續跑）已寫入並同步。

## 下一步
- （無待接續工作，可開始新的功能開發。）

## 待決 / 卡住的問題
- （無）

## 注意事項（給另一台的 Claude）
- 記帳：既有已被分到首頁「財務紀錄」的舊自由文字不會自動搬進記帳（無法可靠反推金額），只有新輸入才歸集。
- 版本規則 vNN.MM：小改直接 bump minor、大改先確認；APP_VERSION 與 sw CACHE_NAME 同步。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
