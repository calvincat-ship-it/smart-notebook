# 智慧記事本 — Anthropic 中繼站（Cloudflare Worker）部署說明

這個 Worker 把 Anthropic API 金鑰保管在後端，讓你和同事**不必各自貼自己的 API 金鑰**，
只要拿到「中繼站網址」和「存取碼」就能用；花費集中在你這把金鑰、由你控管。

App 會把要給 Claude 的內容 POST 到這個 Worker，Worker 驗證存取碼後，帶著金鑰轉發到
Anthropic，再把回應原樣送回 App。金鑰不會出現在任何人的瀏覽器裡。

---

## 方式 A：Cloudflare 儀表板（推薦，不用安裝任何東西）

1. 到 https://dash.cloudflare.com 註冊一個**免費** Cloudflare 帳號並登入。
2. 左側 **Workers & Pages** → **Create** → **Create Worker**。
3. 取個名字（例如 `smart-notebook-relay`）→ **Deploy**（先建一個預設的 hello world）。
4. 進入這個 Worker → **Edit code**（右上 `</>`）→ 把編輯器內容**全部刪掉**，貼上本資料夾
   `worker.js` 的完整內容 → 右上 **Deploy**。
5. 回到 Worker 頁 → **Settings** → **Variables and Secrets** → **Add**，新增兩個 **Secret**
   （型別選 Secret / Encrypted）：
   - `ANTHROPIC_API_KEY`：你的 Anthropic API 金鑰（`sk-ant-...`）
   - `APP_ACCESS_CODE`：自己想一組存取碼（像密碼，例如 `ttct-2026-記事本`）
   存檔後如提示要 **Deploy** 就再 Deploy 一次。
6. 複製這個 Worker 的網址，長得像
   `https://smart-notebook-relay.你的子網域.workers.dev`。
7. 打開 App → 右上 ⚙ 設定：
   - **共用中繼站網址**：貼上上面的 Worker 網址
   - **中繼站存取碼**：填你在第 5 步設的 `APP_ACCESS_CODE`
   - （此時可以不用填自己的 Anthropic API 金鑰）
   - 按**儲存**，回去按「整理」測試。
8. **同事端**：把 Worker 網址 + 存取碼給他們，各自填進 App 的設定即可，不必有自己的金鑰。

## 方式 B：wrangler 指令（適合開發者）

```bash
cd worker
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # 貼上 sk-ant-...
npx wrangler secret put APP_ACCESS_CODE      # 貼上自訂存取碼
npx wrangler deploy
```

部署後終端機會印出 `https://smart-notebook-relay.<子網域>.workers.dev`，照方式 A 第 7、8 步填進 App。

---

## 常見設定與維運

- **允許的網域（CORS）**：`worker.js` 最上方的 `ALLOWED_ORIGINS` 預設已包含
  `https://calvincat-ship-it.github.io`（線上版）與本機 `localhost`。若 App 換網址，改這裡再重新部署。
- **換存取碼 / 停用某人**：改 `APP_ACCESS_CODE` 這個 Secret 的值再 Deploy，然後把新碼給要保留的人；
  舊碼立刻失效。要全部停用就刪掉這個 Worker。
- **花費保護**：Worker 只放行 `MODEL_ALLOWLIST` 裡的模型，並把 `max_tokens` 上限壓在
  `MAX_TOKENS_CAP`（預設 8192），避免存取碼外洩時被灌爆。可自行調整。
- **費用**：Cloudflare Workers 免費方案每天有相當額度（一般個人/小團隊用量綽綽有餘）；
  真正的 Claude 用量仍計入你的 Anthropic API 帳單。
- **安全性**：存取碼是「共用密碼」，會存在每個人 App 的 localStorage 並隨請求送出。
  對「本人 + 幾位同事」足夠；若外流，照上面換碼即可。
