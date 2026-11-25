# 基隆市停車場履約管理系統（V11.0）

基隆市百福、成功、信義國小、社寮橋四座停車場的履約管理平台：工項發佈與進度匯報、三維審查、每月場館檢核與缺失改善、財產管理、會議紀錄、履約月報。

- 前端：React 19 + Vite + TypeScript（部署於 Vercel / GitHub Pages）
- 後端：Google Apps Script（綁定 Google 試算表），程式碼在 `gas/`
- 資料庫：Google 試算表；附件存放於 Google Drive

## 專案結構

```
App.tsx               主程式（狀態管理、所有 API 呼叫）
api.ts                後端呼叫與 Session Token 管理（一律 POST）
taskStatus.ts         工項狀態、逾期判斷、角色權限的共用邏輯
types.ts / constants.ts
components/           各頁面元件（MonthlyReport.tsx 為 V11 新增的履約月報）
gas/Code.js           後端 API（貼到 Apps Script 的 Code.gs）
gas/Setup.js          一次性升級與排程安裝（貼到 Apps Script 的 Setup.gs）
gas/appsscript.json   Apps Script 資訊清單（權限範圍）
docs/V11升級部署說明.md  升級步驟、測試清單、回復方式
```

## 本機開發

需求：Node.js 20 以上

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # 輸出到 dist/
npm run lint     # TypeScript 型別檢查
```

後端網址設定在 `constants.ts` 的 `APP_CONFIG.SCRIPT_URL`。開發時建議指向「測試用」的 Apps Script 部署（做法見升級說明）。

## 後端（Google Apps Script）

### 方式一：直接貼上（不需安裝工具）
1. 開啟試算表 →「擴充功能」→「Apps Script」
2. `Code.gs` 內容換成 `gas/Code.js`；新增檔案 `Setup.gs` 貼上 `gas/Setup.js`
3. 「專案設定」勾選「在編輯器中顯示 appsscript.json」，內容換成 `gas/appsscript.json`

### 方式二：使用 clasp 版本控管
```bash
npm i -g @google/clasp
clasp login
cp gas/.clasp.json.example .clasp.json   # 填入 scriptId（Apps Script「專案設定」可查）
npm run gas:pull                          # 先把線上版本拉下來比對
npm run gas:push                          # 推送 gas/ 內的程式
```

部署新版本：Apps Script「部署」→「管理部署作業」→ 編輯現有部署 →「新版本」。這樣網址不變，前端不用改 `SCRIPT_URL`。

## 角色與流程

| 角色 | 主要權限 |
|---|---|
| 系統管理員 ADMIN | 全部功能、帳號審核與管理、審查 |
| 三維團隊 MANAGER_3D | 審查工項、發佈工項、每月場館檢核、後台 |
| 交通處 MANAGER_DEPT | 檢視全區、發佈/修改工項、履約月報 |
| 經營業者 OPERATOR | 只看自己的場站；匯報進度並「提送審查」 |

工項狀態：`待處理 → 執行中 → 審核中 →（三維核准）已完成`；三維退回時為 `退回補正`，業者補件後再提送。期限已過的待處理/執行中由排程改為 `逾期`。

工項附件會保留原始檔名與上傳者。業者可勾選多個自己上傳的檔案一次刪除（審核中須先撤回為「執行中」，已完成則不可刪），三維與管理員可刪除任何附件；刪除的檔案移到雲端硬碟垃圾桶，30 天內可還原，並記錄於操作歷程。

每月場館檢核的「異常」項目會自動開立「缺失改善單」（預設 14 日曆天，可於填報時修改），全部改善單結案後該次檢核的異常警示自動標記為已改善。

## 自動排程（由 `setupV11()` 安裝）

| 函式 | 時間 | 內容 |
|---|---|---|
| `dailyMaintenance` | 每日 00:10 | 期限已過的待處理/執行中 → 逾期 |
| `dailyReminders` | 每日 08:30 | 寄給執行人與該場站業者：到期前 7 天、3 天、當天、逾期後每 7 天 |
| `weeklySummary` | 每週一 08:30 | 週報寄給三維團隊與系統管理員 |

指令碼屬性 `REMINDERS_ENABLED=false` 可暫停所有自動寄信。

## 版本紀錄

完整版本歷程見 `metadata.json`。V11.0 的升級步驟請務必閱讀 `docs/V11升級部署說明.md`。
