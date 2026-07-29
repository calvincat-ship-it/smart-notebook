# 智慧記事本 PWA — 專案規則

## 自動推送
每次「驗證通過」的變更後，立即 `git add -A && git commit && git push`，不需再次確認。

## 版本規則
- 比照血壓 App：版本號 `vNN.MM`。小改直接 bump minor；大改先與使用者確認。
- 改版時 `APP_VERSION` 與 service worker 版本必須同步更新。

## 跨裝置交接 (HANDOFF)
本專案在兩台機器（筆電 / 桌機，同帳號）之間接續開發。
- **開工**（使用者說「開工」時）：先自動執行 `& "$env:USERPROFILE\claude-sync\_cross-device\sync-start.ps1"`（git pull 拉下另一台最新程式碼＋全域記憶），再讀根目錄 `HANDOFF.md`，掌握上一台做到哪、下一步、待決問題。
- **收工**（使用者說「收工」時）依序：
  1. **更新 memory**：把本次 session 學到的重要架構變動、決策、新版本、踩雷點寫入對應記憶檔（`~/.claude/.../memory/`，即 claude-sync repo），必要時更新 `MEMORY.md` 索引；沒有值得記的就明說「本次無新記憶」並跳過。
  2. **更新 `HANDOFF.md`**（最後更新時間/機器、做到哪、下一步、待決問題）。
  3. **自動執行** `& "$env:USERPROFILE\claude-sync\_cross-device\sync-end.ps1"`（commit + push 所有專案與全域記憶，含未完成 WIP）。

  此為使用者預先授權的固定流程，不需再逐次確認。
