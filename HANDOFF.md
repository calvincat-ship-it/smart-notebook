# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-09-08
- 機器：Desktop\claude code
- 版本：**main = v16.03（已 push；GH Pages 依常規部署）**。新增 `cat.id`、`smart_notebook_cache_v1`；attachment `kind:'link'` 型；**DRIVE_SCOPE 含 `drive.file`**。向下相容。

## v16.03＝修「大檔上傳授權彈窗 popup_failed_to_open」（實機回報＋已驗證可用）
- 真因：drive.file 同意彈窗若從「選檔 change 事件」觸發，使用者手勢已被檔案選擇器用掉→GIS 回 `popup_failed_to_open`。**彈窗只能由「直接點按鈕」這種新鮮手勢開啟。**（使用者實測：進「設定」子頁時因讀雲端狀態順勢跳出授權、拿到後就能上傳——旁證此結論。）
- 修：**授權搬到「☁️ 大檔上傳」按鈕點擊當下**。已有 drive.file→直接開檔案選擇器（同一手勢、click 前不 await）；沒有→在此按鈕手勢內 `ensureDriveFileScope()` 彈同意畫面，成功後提示「請再按一次選檔」（手勢已用於彈窗）。**第一次授權＝兩步、之後單步**。`ensureDriveFileScope` 先靜默 `getAccessToken('none')`（已授權者/開機同步後免彈窗）再互動；新增 `hasDriveFileScope()`；`addCategoryBigFiles` 改非彈窗 guard。preview 兩案驗證通過。
- 待：**另一台（桌機/筆電）第一次大檔上傳仍需按兩步完成 drive.file 授權**（正常、只一次）。

## v16.02＝修「大檔上傳沒跳授權就失敗」（被 v16.03 接續；此版仍會在 change 事件彈窗→popup_failed_to_open）
- 真因：已連雲端者手上是**只含 drive.appdata 的舊 access token**；大檔上傳沿用它、從不主動要 drive.file → Google 不跳同意畫面，寫入一般 Drive 被擋（權限不足，非 401 故 driveFetch 不重試）→ 失敗。
- 修：追蹤 GIS 回傳 granted scope（`grantedScopes`，取自 token 回應 `scope`）；新增 `ensureDriveFileScope()`＝若未含 drive.file 就清權杖、發**互動式** token 請求（prompt=''）觸發同意畫面，拒絕則拋清楚訊息；`addCategoryBigFiles` 在最貼近點擊處（早於分享 confirm/任何 Drive 動作）先呼叫它，確保同意視窗能在使用者手勢內彈出。preview 三案驗證通過。**真機仍待測**（要看實際同意畫面＋上傳成功）。
- ⚠ 若真機仍不跳：可能是 GIS token 彈窗被手勢逾時擋掉（改在 change handler 更前面呼叫）、或帳號屬管理限制。屆時看 console/error_callback type。

## v16.01＝大檔混合策略（使用者定案：≤10MB→App 私有雲端；>10MB→App 傳到你自己 Drive 存連結、可選分享）
- **App 內附件上限降回 10MB**（`MAX_ATTACH_BYTES`）＝走 appDataFolder、自動同步、隨 App 備份。分類 📎 上傳遇 >10MB 擋下並引導改用「☁️ 大檔上傳」。
- **新 scope `drive.file`**（只能存取 App 自己建立/開啟的檔）→ 讓 App 把大檔傳進使用者「看得見的」My Drive。**不用 Picker**（本 App 無 GOOGLE_API_KEY，且 PWA Picker referrer 金鑰雷）。
- **筆記本分類「☁️ 大檔上傳」**（≤100MB `MAX_BIGFILE_BYTES`）：`addCategoryBigFiles`→`ensureUploadFolder`（My Drive 建/找「智慧記事本附件」資料夾、id 存 `cloudState.uploadFolderId`、失效自動重建、失敗退 root）→`driveResumableUpload`（泛化：parents/fields/onProgress；進度顯示於 loading 遮罩 `setLoadingText`）→取 `webViewLink`→**使用者選擇是否分享**（confirm→`driveShareAnyone` 設 anyone-with-link reader，否則私人）→存「連結型附件」`{kind:'link',url,shared,driveFileId,linkedItemIds:[cat.id]}`。**不佔本機快取、不進 appDataFolder。**
- **連結型附件處理**：`makeAttachChip` 顯示 🔗／🔗🌐(分享)、點擊 `window.open(url)`；`.link-chip` 藍色系。移除時 confirm「一併刪 Drive 檔／只移連結(保留檔案)」；`purgeAttachment` 對 link 一律不刪雲端；`deleteAttachmentById` 特案處理；`normalizeState` 保留 kind/url/shared。`uploadPendingAttachments` 不碰 link（已有 driveFileId、無 blob）。
- 重構：`driveResumableUpload(name,blob,{parents,fields,onProgress})` 為核心，`driveUploadBlob(fileId,name,blob)` 沿用之走 appDataFolder。新增 `driveFileMeta/driveShareAnyone/driveDeleteFile`。
- preview 驗證(stub)：scope 含 drive.file；大檔上傳建 link 附件(url/shared/driveFileId·不快取·顯示 link-chip·不 orphan·有建資料夾)、>10MB 小檔路徑擋下並提示、移除連結預設保留 Drive 檔、mobile 375 四鈕＋兩種 chip 不爆版。**真實 Drive 往返/重新授權/實際分享權限未真機測**（preview 無帳號）。

## v16.00＝筆記本分類可上傳附件＋拍照｜附件改「雲端為主＋本機 LRU 快取」｜單檔 100MB＋resumable 上傳（本段的 100MB 上限已於 v16.01 改為：App 內 10MB、大檔走連結 100MB）

## v16.00＝筆記本分類可上傳附件＋拍照｜附件改「雲端為主＋本機 LRU 快取」｜單檔 100MB＋resumable 上傳（使用者確認：拉 100MB＋改快取制）
- **筆記本分類上傳/拍照**：每個分類 body 加 `.cat-actions`＝「＋新增項目 / 📎上傳附件 / 📷拍照」。`addCategoryAttachments(cat,files)` 綁 `cat.id`（拍照用 `<input capture=environment>`）。分類取得穩定 `cat.id`：`addCategory/ensureUncategorized/ensureHomeBullet` 建時給、`normalizeState` 遷移、**`mergeCategories` 依標題保留 id**（Claude 不見 id）。`orphanAttachments`＋`categoryIsEmpty`（有附件不算空、避免自動刪分類）＋分類計數顯示 `📎N`。
- **儲存架構（支撐 ~10GB 大總量）**：附件本體以 Drive 為主，本機 IndexedDB 改 **有上限 LRU 快取**。核心 `cachePut/cacheGet/cacheDelete/enforceCacheBudget/clearCloudBackedCache`＋索引 `cacheMeta`（localStorage `smart_notebook_cache_v1`，{size,at}）。**pin 規則：`driveFileId` 為空(尚未上傳)一律不驅逐**，只清已在雲端的最舊者；即使 pin 超量也保留（寧可暫時超過也不丟未備份檔）。所有「附件 id」blob 讀寫改走 cache*（**草稿 ref blob 不列入、永不驅逐**）。`clearAllLocalData`／筆記本「清空」一併清 cacheMeta（+Drive 檔）。
- **設定→雲端區**（僅連線後顯示）：本機快取上限下拉（200MB/500MB/1GB/2GB/4GB/不限，預設 500MB＝`settings.cacheBudgetMB`）、目前快取用量、「🧹 清空本機附件快取」、「☁ Drive 空間」配額（`about.get?fields=storageQuota`；appdata scope 若被擋則靜默不顯示）。
- **上傳可靠度**：`MAX_ATTACH_BYTES` 10MB→**100MB**（`MAX_ATTACH_MB` 動態文案）；OCR 影像另立 `MAX_OCR_BYTES=10MB`（vision API 限制）。**`driveUploadBlob` 由 multipart 單發改 RESUMABLE 分段**（8MB/chunk、`Content-Range`、308 續傳、401 刷 token、5xx 退避重試；session URI 的 PUT 不帶 Authorization）。`fmtSize` 補 GB 級。
- preview 驗證（stub）：分類上傳綁 cat.id/顯示/不 orphan、LRU 驅逐(雲端最舊先清·未上傳 pin)、resumable(20MB→8/8/4·308→續·200→取 id)、mobile 375 三鈕不爆版、用量/配額文字。**真實 Drive 大檔往返未真機測**（preview 無帳號）。
- ✅ 大檔策略已定案並於 **v16.01 實作**（混合制：≤10MB→App 私有雲端；>10MB→App 傳使用者自己 Drive 存連結、可選分享）。

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
- 版本 vNN.MM：小改/修 bug 直接 bump minor；新功能大改先確認。目前 **v16.03**（APP_VERSION 與 sw CACHE_NAME 同步）。
- **大檔＝連結型附件（v16.01）**：`kind:'link'` 指向使用者一般 Drive；點擊開 url、不下載/不快取；移除只移連結(除非使用者選擇一併刪 Drive 檔)。改附件邏輯時要一併考慮 link 型（多處已 guard：purge/open/normalize/upload）。`drive.file` scope 已加。
- **附件儲存新模型（v16.00）**：Drive 為本體、本機是 LRU 快取；改附件相關邏輯時記得「無 driveFileId＝未備份＝不可驅逐」；blob 讀寫走 cache*，草稿 ref blob 走原始 idb*。上傳走 resumable。
- **附件雲端 id 勿再盲信**：跨裝置/換帳號/還原後 `driveFileId` 會過期；下載一律走 `downloadAttachmentBlobHealing`（以檔名 `att_<id>` 重新解析自癒）。主 JSON 也是以檔名解析（同一原則）。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
