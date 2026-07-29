# 智慧記事本 PWA — 專案規則

## 自動推送
每次「驗證通過」的變更後，立即 `git add -A && git commit && git push`，不需再次確認。

## 版本規則
- 比照血壓 App：版本號 `vNN.MM`。小改直接 bump minor；大改先與使用者確認。
- 改版時 `APP_VERSION` 與 service worker 版本必須同步更新。

## 跨裝置交接 (HANDOFF)
本專案在兩台機器（筆電 / 桌機，同帳號）之間接續開發。
- **開工**：先讀根目錄 `HANDOFF.md`，掌握上一台做到哪、下一步、待決問題。
- **收工**：更新 `HANDOFF.md`（最後更新時間/機器、做到哪、下一步、待決問題），
  連同程式碼一起 commit + push。
