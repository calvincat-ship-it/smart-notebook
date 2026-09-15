# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-09-15 收工
- 機器：筆電（C:\Users\user）

## 做到哪（本次 session，v17.05 → v18.01，皆已 commit+push、preview 實測通過、無 console error）
> 完整索引見記憶 [[project-smart-notebook-architecture]]「2026-09-15 v18.00–v18.01」段（READ FIRST）。
- **v18.00 待辦任務時間改為「起始時間(選填)＋結束時間」**（新功能，使用者確認：日期＋時分、起始選填結束為主）：
  - 任務加 `startAt`(選填)/`endAt`(結束)，值 `''`｜`YYYY-MM-DD`(全天)｜`YYYY-MM-DDTHH:mm`(有時分)。
  - **相容關鍵**：`dueDate` 保留為 `endAt` 日期部分鏡像(`syncDueMirror`)→緊急度/排序/同日衝突零改動；`taskEndAt` 遷移舊 dueDate、normalizeState 載入自癒。三個建立任務點都設好三欄。
  - 編輯器改「起始時間(選填)＋結束時間」各為 **date+time(選填) 兩欄組合**（⚠datetime-local 無法表達純日期故用兩框）。
  - 卡片徽章 `taskWhenText`(同日收合 14:00–16:00／跨日展開 →／suffix 依結束日)。
  - 行事曆 `calEventBody`/`gcalLink` 有時分→有時段事件(CAL_TZ)、否則全天可跨日；AI schema/prompt 加 startAt/endAt。
- **v18.01 使用說明更新**成起訖時間說法(總覽／✏️編輯段／行事曆說明頁＋設定欄註記；有時段 vs 全天)。

## 下一步
- （無待接續工作。功能已完整、已上線。）

## 待決 / 卡住的問題
- （無。）Google 行事曆有時段事件本次以 stub/單元測驗過 body 正確；真實 Calendar API 寫入有時段事件未真機測（Calendar API 早前已在 Cloud 專案啟用，全天事件實機正常，時段事件走同一路徑理應可用，可待使用者實測回報）。

## 注意事項（給另一台的 Claude）
- localStorage state key 是 **`smart_notebook_v1`**（不是 smartNotebookState）；預覽測試植入資料要用這個 key，且改 localStorage 後需 reload 才生效。
- 任務時間**唯一真實來源是 startAt/endAt**，`dueDate` 只是 endAt 日期部分的鏡像，勿直接寫 dueDate（要改時間走 startAt/endAt 再 `syncDueMirror`）。
- `datetime-local` 不能表示「只有日期無時分」→時間欄一律 date+time 兩個 input，勿改回單一 datetime-local。
- 版本規則比照血壓 App vNN.MM，APP_VERSION 與 sw.js CACHE_NAME 必須同步。
