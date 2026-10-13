# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-10-13 收工
- 機器：桌機（C:\Users\TTCT）

## 做到哪（本次 session，v18.01 → v18.03，皆已 commit+push、preview 實測通過、無 console error）
> 完整索引見記憶 [[project-smart-notebook-architecture]]「2026-10-13（v18.02 → v18.03）」段（READ FIRST）。
- **v18.02 待辦任務卡片排序改依「辦理日期」**（使用者要求）：
  - `renderTasks()` 排序順位改為：未完成先 → 緊急度 tier → **同 tier 內按辦理日期由早到晚** → **完全沒日期者排該 tier 最末** → 最後才用 `p.total` 做 tiebreak（原本 total 是第一順位、dueDate 只是 tiebreak）。
  - 新 helper `taskSortKey(t) = normDT(startAt) || normDT(endAt) || ''`（放在 `syncDueMirror` 旁）。**起始時間沒填就退回結束時間當辦理日期**（起始是選填，否則多數舊任務都會被丟到末位）；兩者皆空才算「沒日期」。
  - 字典序直接比：同一天「全天」排在「有時分」之前。**緊急度 `priorityOf` 仍依 `dueDate`（endAt 鏡像）不變，只改顯示順序。**
- **v18.03 可暫緩卡片在堆疊展開後仍維持摺疊**（使用者要求）：
  - `buildTaskCard` 的 `collapsible` 由 `p.tier === 'normal'` 改成 `p.tier === 'normal' || (p.tier === 'low' && !t.done)`。
  - 打開 🗂 可暫緩堆疊後，每張卡片只剩徽章＋標題＋▸，要各自點標題列才展開（沿用既有 `expandedTasks`，無新 state）。
  - **刻意排除已完成卡片**（`!t.done`）→ ✓ 已完成堆疊維持原行為。已向使用者說明，若要一致化只需拿掉該條件。
- 兩版的 index.html ❓使用說明都同步改寫；APP_VERSION 與 sw.js CACHE_NAME 同步 v18.03。

## 下一步
- （無待接續工作。功能已完整、已上線。）

## 待決 / 卡住的問題
- （無。）唯一待使用者回饋：已完成堆疊內的卡片要不要也改成各自摺疊（目前刻意保持原樣）。

## 注意事項（給另一台的 Claude）
- localStorage state key 是 **`smart_notebook_v1`**；**任務的標題欄位是 `task` 不是 title**（植測試資料常踩）；改 localStorage 後要 reload 才生效。
- 任務時間**唯一真實來源是 startAt/endAt**，`dueDate` 只是 endAt 日期部分的鏡像，勿直接寫 dueDate。
- 排序看 `taskSortKey`、緊急度看 `priorityOf`，兩者依據不同（起始 vs 結束），改動時勿混為一談。
- `datetime-local` 不能表示「只有日期無時分」→時間欄一律 date+time 兩個 input。
- 版本規則比照血壓 App vNN.MM，APP_VERSION 與 sw.js CACHE_NAME 必須同步。
