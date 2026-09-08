# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-09-08
- 機器：Desktop\claude code
- 版本：**main = v15.02（已 push；GH Pages 依常規部署）**。localStorage schema 未變、向下相容。

## v15.02＝修「手機上超長附件檔名把條列按鈕擠出畫面、無法刪除/編輯」（實機回報）
- 真因：`.bullet-text` 為 `flex:1` 但**缺 `min-width:0`**，長且無空白的字串（尤其附件自動建立的筆記條列＝檔名）不換行→撐寬整列→把 ✒/🔄/✕ 推出畫面右側；手機無法左右捲→該筆無法刪除/編輯。
- 修（純 CSS）：`.bullet-text` 加 `min-width:0`＋`overflow-wrap:anywhere`；`.bullet-edit/.bullet-move/.bullet-del` 補 `flex:0 0 auto`（永不被壓縮）；`.task-text` 也補 `overflow-wrap:anywhere`。mobile 375 實測：長檔名換行、三顆鈕與附件 chip 的 ✕ 皆在畫面內、`scrollWidth==375` 無橫向溢出。commit c7c02f9。
- 備忘：附件 chip 本身早有 `.attach-open{max-width:60vw;ellipsis}`＝chip 端 OK，本次是「條列文字」端的問題。日後任何 flex 列放長字串都記得 `min-width:0`＋`overflow-wrap`。

## v15.01＝修「雲端附件下載失敗（數字）」（實機回報：已連結雲端、附件有備份，但電腦＋Android 都開不了）
- 真因：附件一律信任 bundle 內 `driveFileId`、從不重新解析；該 id 過期（還原舊備份／重新連結／更換帳號後）→ 目前帳號 appDataFolder 內該 id 失效 → `alt=media` 回 404/403，每台裝置皆掛。與血壓／課務 App 同類 bug（解法皆「一律以檔名重新解析」）。
- 修：新增 `downloadAttachmentBlobHealing(att)`——先試記錄 id；404/403 才以穩定檔名 `att_<id>` 在目前帳號 appDataFolder `driveFindFile` 重新解析，找到就更新 driveFileId（saveStateQuiet）再下載＝自癒、跨裝置皆可；真的找不到→明確提示；非 404/403 照報 HTTP 狀態。`openAttachment` 改用它並把離線/無備份訊息講清楚。移除死碼 `driveDownloadBlob`。preview 以 stub 驗證三分支（404→自癒成功／找不到→明確訊息／500→照報）皆過。commit ab66df5。
- ⚠ 侷限：若附件檔案其實是用**另一個 Google 帳號**上傳（現帳號 appDataFolder 真的沒有），自癒也找不到，只能回原帳號開或重新上傳——這時會顯示「目前帳號找不到」而非再靜默失敗。

## v15.00（已 commit+push、preview 實測通過、無 console error）＝待辦／筆記拆頁＋整理規則互斥＋雙向更換鈕
- **拆成兩個子頁**：「🗂 分類整理」更名「📓 筆記本」，與「📌 待辦任務」拆為兩個子頁，頂端 `#tabBar`（`.tab-bar`/`.tab-btn`）切換，**待辦任務為預設首頁**。`currentPage`（session-only，開啟一律回 tasks）＋`setPage()`＋`applyPageVisibility(hasContent)`（只切 section 顯示，兩份 list 都照建）。全空→顯示 emptyHint、藏 tabBar；各頁自己的空狀態 `.page-empty`。移除 renderTasks/renderCategories 內各自的 `section.hidden` 設定，改由 applyPageVisibility 統管。
- **AI 整理規則改「互斥不重複」**：改寫 SYSTEM_PROMPT——有明確需辦理事項→只進 tasks；無→只進 categories（筆記本）；同一件事不可兩邊並存；expenses 仍獨立。schema 與 appendTasks **移除 tasks 的 linkedBullets**（任務不再產生對應筆記條列）；linkedItemIds 現只用於「使用者從任務卡片直接附加的檔案」（綁任務自身 id）。
- **雙向「更換」鈕**（修正 AI 誤判）：任務卡片 metaRow 加「🔄 改為筆記」`convertTaskToNote()`（固定落到 `📥 未分類`＝`ensureUncategorized()`／`UNCAT_TITLE`；帶走已附加檔案；legacy 任務若其筆記條列還在則只刪任務不重複建）；筆記每一條 bullet 加「🔄」`convertBulletToTask()`（→ 新任務、無日期、importance medium、sourceCategory 取分類名；帶走該條附件；刪空 sub/分類自動清除）。互轉都不用 removeBulletsByIds（改用搬移連結，避免誤刪附件）。
- **附件模型調整**：`addTaskAttachments` 改綁任務自身 id（不再 ensureHomeBullet 產生筆記條列）；`orphanAttachments` 把 task id 也算 live owner；新增 `bulletExists()`；`deleteTask` 依「done 清全部 / 未 done 只清自身附件」重寫確認文案與清除範圍。其餘 attachment 輸入流程（PDF/vision/📎）仍用 ensureHomeBullet 進「📎 附件」分類，不動。
- 版本 APP_VERSION + sw CACHE_NAME 同步 v15.00。commit 2c25331。

## （上個 session，v13.00 → v14.06）
- **掃描電子發票 QR 記帳 v14.00（新功能，確認升 v14）**：記帳視窗頂部 `📷 掃描發票 QR`。原生 `BarcodeDetector` 本地解析（零 API/零金鑰/不上傳）。`parseEinvoiceQR(left,right)`：前 77 碼 ASCII header（發票號碼/民國日期→西元/總計額16進位/賣方統編）一定可靠；品目段 `left[77:]+right去**` 冒號分隔、前 3 token 丟棄後每 3 個一組；中文 UTF-8 直用或 `TextDecoder('big5')` 還原；`**`/品目太多→退「整張記一筆」。scanned expense 帶 `inv` 防重掃。iOS 無 BarcodeDetector→整區隱藏。相機路徑未真機測（解析頁內單元測過）。
- **任務卡片連結化 v14.01**：`linkifyInto` 用 DOM node 把 URL/電話/email/UNC 變 `<a>`；URL/file 字元類僅 ASCII 遇中文斷開；`tel:`/`mailto:`/`file:`；外部 `target=_blank`+`stopPropagation`。
- **分類條列筆記也連結化＋bullet 改 ✒ 鈕編輯 v14.02**：bullet 唯讀連結 span / ✒ 啟動純文字 contenteditable 雙模式（比照 v12.04）；`editingBullets` Set + `pendingEditBullet`；`addItem` 改走此流程；移除舊 `pendingFocus`。
- **整理同日活動衝突警告 v14.03**：`processInput` 套用前 `confirmBusyDayConflicts(result)`——新增有日期任務 vs 現有任務同日→confirm 列每日(含星期)新增/當天已有；確認才建立、取消整批不建立且保留輸入。
- **可暫緩＋已完成任務堆疊 v14.04–06**：`buildTaskCard` 抽出；`buildTaskStack(items,kind,label,expanded,toggle)` 通用（low/done 共用）；`.card-stack` CSS 基底＋顏色修飾。疊紙：三張同尺寸、`translate(-5,-5)/(-10,-10)` 往右下、露左上角；`.low-stack` 全藍、`.done-stack` 前藍(可暫緩)/中黃(普通)/後紅(緊急)。`lowStackExpanded`/`doneStackExpanded` session-only 預設收合。

## 下一步
- （無待接續工作。）v15.00 拆頁＋互斥規則已上線；可觀察實際使用 AI 分類是否夠準，不準時使用者用 🔄 更換鈕手動修正即可。

## 待決 / 卡住的問題
- v15.00 preview 以注入 state 驗證（分頁切換、bullet↔task 互轉、各空狀態、全空 emptyHint/tabBar）皆通過、無 console error；**尚未實跑一次真實「整理」驗證新 SYSTEM_PROMPT 的互斥效果**（需 API 金鑰／中繼站，preview 未設）。使用者實際整理後若發現仍有兩邊重複或分錯，回報再微調 prompt。
- 電子發票 QR **相機掃描路徑未真機測**（in-app Browser 無 BarcodeDetector；解析函式已頁內單元測通過）。使用者可拿紙本電子發票在 Android 手機實測；若品名亂碼或金額不符再回報調整編碼處理。

## 注意事項（給另一台的 Claude）
- 疊紙堆疊 class 已從 `low-stack-*` 改為共用 `card-stack-*`；顏色由 `.low-stack`/`.done-stack` 修飾。改樣式勿再用舊 class 名。
- QR 解析：前 77 碼固定 ASCII 可靠、品目段防禦式解析、失敗退整張；expense `inv` 欄位（防重掃）勿刪、`normalizeState` 已保留。
- 摺疊/編輯/堆疊狀態（expandedCats/expandedTasks/editingCats/editingBullets/lowStackExpanded/doneStackExpanded/**currentPage**）皆 session-only、不持久化、不同步。currentPage 每次開啟一律回 'tasks'（待辦任務為首頁）。
- **兩頁互斥模型（v15.00）**：新內容 AI 只會放一邊（task 或 note）。任務不再有對應筆記條列；`tasks[].linkedItemIds` 現只裝「從任務卡片直接附加的檔案」的 owner id（＝任務自身 id）。改附件/刪除相關邏輯勿再假設 task 一定有筆記條列。舊資料（含 linkedItemIds 指向真 bullet 的 legacy 任務）仍相容：normalizeState 遷移、deleteTask 用 bulletExists() 區分。
- 測試踩雷（詳見 memory `feedback_pwa_testing_approach`）：in-app Browser 無 BarcodeDetector；改 CSS 要替 stylesheet 加 query 強制刷新；背景分頁 `.blur()` 不觸發（測提交改 `dispatchEvent(new Event('blur'))`）；screenshot 常因 pane 未顯示無法合成→改 computed style + 傳同 CSS 預覽 HTML。
- 版本 vNN.MM：小改/修 bug 直接 bump minor；新功能大改先確認。目前 **v15.02**（APP_VERSION 與 sw CACHE_NAME 同步）。
- **附件雲端 id 勿再盲信**：跨裝置/換帳號/還原後 `driveFileId` 會過期；下載一律走 `downloadAttachmentBlobHealing`（以檔名 `att_<id>` 重新解析自癒）。主 JSON 也是以檔名解析（同一原則）。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
