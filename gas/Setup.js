/**
 * V11.0 一次性設定與資料遷移
 *
 * 使用方式（在 Apps Script 編輯器上方選擇函式後按「執行」）：
 *   1. previewMigrationV11()      只列出會修改哪些資料，不寫入（建議先跑）
 *   2. setupV11()                 正式升級：備份 → 欄位/資料整理 → 建立留言表 → 更新系統說明 → 安裝排程
 *   3. redactPlaintextPasswords() 把 Messages 分頁舊訊息中的明文預設密碼遮蔽（確認後再執行）
 *   4. previewDailyReminders()    預覽明天提醒信會寄給誰（不寄信）
 *
 * 可在「專案設定 → 指令碼屬性」調整：
 *   SYSTEM_URL         信件中的系統網址（預設 https://keelung-parking.vercel.app/）
 *   REMINDERS_ENABLED  設為 false 可暫停所有自動寄信
 *   PASSWORD_PEPPER    系統自動產生，請勿修改或刪除（刪除會導致所有人無法登入）
 */

function previewMigrationV11() {
  const report = migrateTaskSheet_(true);
  Logger.log(report.join('\n'));
  return report;
}

function setupV11() {
  const log = [];
  const backup = backupSpreadsheet_('V11升級前備份');
  log.push('1. 已備份試算表：' + backup);

  pepper_();
  log.push('2. 密碼 Pepper 已就緒');

  log.push('3. 任務表整理：');
  migrateTaskSheet_(false).forEach(function (l) { log.push('   ' + l); });

  log.push('4. ' + fixChecklistHeader_());

  commentsSheet_();
  log.push('5. 「' + SHEETS.COMMENTS + '」分頁已就緒');

  log.push('6. ' + rebuildSystemDocSheet_());

  if (!props_().getProperty('SYSTEM_URL')) props_().setProperty('SYSTEM_URL', DEFAULT_SYSTEM_URL);
  log.push('7. SYSTEM_URL = ' + systemUrl_());

  installTriggers();
  log.push('8. 已安裝排程：每日 00:10 逾期檢查、每日 08:30 到期提醒、每週一 08:30 週報');

  const overdue = markOverdueTasks_();
  log.push('9. 立即標記逾期：' + overdue + ' 筆');

  writeLog('系統升級', '', 'setupV11 完成', Session.getEffectiveUser().getEmail());
  Logger.log(log.join('\n'));
  return log;
}

function backupSpreadsheet_(label) {
  const file = DriveApp.getFileById(ss_().getId());
  const name = file.getName() + '_' + label + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmm');
  file.makeCopy(name);
  return name;
}

/**
 * 1_任務執行表：
 *  - 標題列補齊到 17 欄（新增 任務類型、來源關聯、提送審查時間、審查人、審查時間、審查意見）
 *  - 場站欄統一為代碼（BAIFU / CHENG / XINYI / SHELIAO / CONTRACT_TEAM）
 *  - 截止日期統一為 yyyy-MM-dd（修正 2026-08-24T16:00:00.000Z 這類時區偏移資料）
 *  - 任務類型預設「一般」
 */
function migrateTaskSheet_(dryRun) {
  const sh = tasksSheet_();
  const report = [];
  if (!sh) return ['找不到「' + SHEETS.TASKS + '」'];
  const width = TASK_HEADERS.length;
  const header = sh.getRange(1, 1, 1, width).getValues()[0];
  const headerDiff = [];
  TASK_HEADERS.forEach(function (h, i) { if (String(header[i]).trim() !== h) headerDiff.push(String.fromCharCode(65 + i) + '欄「' + (header[i] || '') + '」→「' + h + '」'); });
  if (headerDiff.length) report.push('標題列：' + headerDiff.join('、'));
  if (!dryRun) sh.getRange(1, 1, 1, width).setValues([TASK_HEADERS]);

  const last = sh.getLastRow();
  if (last < 2) { report.push('沒有資料列'); return report; }
  const n = last - 1;
  const vals = sh.getRange(2, 1, n, width).getValues();
  const colStation = [], colDeadline = [], colStatus = [], colType = [];
  let stationFix = 0, dateFix = 0, typeFix = 0, statusFix = 0;
  vals.forEach(function (r, i) {
    const rowNo = i + 2;
    const uid = String(r[TC.UID]).trim();
    let station = r[TC.STATION], deadline = r[TC.DEADLINE], status = r[TC.STATUS], type = r[TC.TYPE];
    if (uid) {
      const code = stationCode_(station);
      if (code !== String(station).trim()) { report.push('第 ' + rowNo + ' 列 ' + uid + '：場站「' + station + '」→「' + code + '」'); stationFix++; }
      station = code;
      const d = toDateStr_(deadline);
      if (!isDate_(deadline) && d !== String(deadline).trim()) { report.push('第 ' + rowNo + ' 列 ' + uid + '：截止日期「' + deadline + '」→「' + d + '」'); dateFix++; }
      deadline = d;
      const st = String(status).trim() || STATUS.PENDING;
      if (st !== status) statusFix++;
      status = st;
      if (!String(type).trim()) { type = String(r[TC.ITEM_CODE]).trim() === 'DEFECT' ? TASK_TYPE.DEFECT : TASK_TYPE.NORMAL; typeFix++; }
    }
    colStation.push([station]);
    colDeadline.push([deadline]);
    colStatus.push([status]);
    colType.push([type]);
  });
  report.push('合計：場站代碼 ' + stationFix + ' 筆、日期格式 ' + dateFix + ' 筆、狀態空白 ' + statusFix + ' 筆、任務類型補值 ' + typeFix + ' 筆');
  if (!dryRun) {
    // 只寫回有變動的欄位，避免影響其他欄（如最後更新時間）的原始格式
    sh.getRange(2, TC.STATION + 1, n, 1).setValues(colStation);
    sh.getRange(2, TC.DEADLINE + 1, n, 1).setValues(colDeadline);
    sh.getRange(2, TC.DEADLINE + 1, n, 1).setNumberFormat('yyyy-mm-dd');
    sh.getRange(2, TC.STATUS + 1, n, 1).setValues(colStatus);
    sh.getRange(2, TC.TYPE + 1, n, 1).setValues(colType);
    sh.getRange(2, TC.SUBMITTED + 1, n, 1).setNumberFormat('yyyy/mm/dd hh:mm');
    sh.getRange(2, TC.REVIEWED + 1, n, 1).setNumberFormat('yyyy/mm/dd hh:mm');
    sh.setFrozenRows(1);
  } else {
    report.unshift('【預覽模式】以下變更尚未寫入');
  }
  return report;
}

/** 2_每月場館檢核紀錄 的標題列與程式寫入順序不一致，修正標題列 */
function fixChecklistHeader_() {
  const sh = checklistSheet_();
  const current = sh.getRange(1, 1, 1, CHECKLIST_HEADERS.length).getValues()[0];
  const same = CHECKLIST_HEADERS.every(function (h, i) { return String(current[i]).trim() === h; });
  if (same) return '「' + SHEETS.CHECKLIST + '」標題列正確';
  sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), CHECKLIST_HEADERS.length)).clearContent();
  sh.getRange(1, 1, 1, CHECKLIST_HEADERS.length).setValues([CHECKLIST_HEADERS]);
  sh.setFrozenRows(1);
  return '「' + SHEETS.CHECKLIST + '」標題列已更新為程式實際寫入的 12 欄';
}

/** 舊的 9_系統說明 改名保留為「_舊版」，重建一份符合 V11 的說明 */
function rebuildSystemDocSheet_() {
  const ss = ss_();
  const old = ss.getSheetByName(SHEETS.DOCS);
  let renamed = '';
  if (old) {
    let name = SHEETS.DOCS + '_舊版';
    if (ss.getSheetByName(name)) name += '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMddHHmm');
    old.setName(name);
    renamed = '（舊版已改名為「' + name + '」）';
  }
  const sh = ss.insertSheet(SHEETS.DOCS);
  const W = 4;
  const rows = [];
  const add = function (cells) { const r = cells.slice(0, W); while (r.length < W) r.push(''); rows.push(r); };
  const blank = function () { add([]); };

  add(['基隆市停車場履約管理系統 ' + APP_VERSION + ' 系統說明', '', '', '更新：' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd')]);
  blank();
  add(['一、分頁一覽', '用途', '寫入方式', '備註']);
  [
    [SHEETS.TASKS, '各場站工項、進度、審查紀錄（核心資料表）', '系統寫入', '欄位說明見下方'],
    [SHEETS.CHECKLIST, '每月場館檢核結果（每個檢查項目一列）', '系統寫入', '異常項目會自動開立缺失改善單'],
    [SHEETS.MEETINGS, '會議與現勘紀錄', '系統寫入', ''],
    [SHEETS.USERS, '帳號、角色、負責場站', '後台管理', '密碼欄為加鹽雜湊，請勿手動修改'],
    [SHEETS.LOGS, '操作歷程（稽核日誌）', '系統自動', '包含登入、匯報、審查、排程寄信'],
    [SHEETS.CONTACTS, '通訊錄', '後台管理', ''],
    [SHEETS.TEMPLATE, '每月場館檢核項目範本', '檢核頁「管理/編輯工項」', ''],
    [SHEETS.ASSETS, '財產清單', '財產管理頁', ''],
    [SHEETS.ASSET_CHECKS, '財產單項檢核紀錄', '財產管理頁', ''],
    [SHEETS.ASSET_BATCHES, '財產批次檢核紀錄', '財產管理頁', ''],
    [SHEETS.COMMENTS, '工項留言板、審查意見', '系統寫入', 'V11 新增'],
    ['Messages', '站內訊息', '系統寫入', ''],
    ['SystemLogs', '前端錯誤紀錄', '系統自動', ''],
    ['設定_場域列表', '場域代碼對照', '手動', '程式內建同一份對照表']
  ].forEach(add);
  blank();
  add(['二、' + SHEETS.TASKS + ' 欄位', '說明', '', '']);
  [
    ['任務序號 (UID)', '[場站縮寫]-[年月]-[亂數]，例：成功-202608-242'],
    ['場站代碼', 'BAIFU 百福、CHENG 成功、XINYI 信義、SHELIAO 社寮、CONTRACT_TEAM 履約管理團隊'],
    ['工項編號', 'MANUAL 手動發佈；DEFECT 缺失改善單'],
    ['項目名稱', '工項標題'],
    ['截止日期', 'yyyy-MM-dd'],
    ['目前狀態', '待處理 / 執行中 / 審核中 / 退回補正 / 已完成 / 逾期'],
    ['執行人', '最後一位匯報進度的人'],
    ['最後更新時間', '系統自動'],
    ['附件連結', '多個檔案以換行分隔'],
    ['週期類型 / 週期群組ID', '週期性工項（每月、每季…）同一批的群組代碼'],
    ['任務類型', '一般 / 缺失改善'],
    ['來源關聯', '缺失改善單對應的檢核：CHK:<提交ID>:<項目ID>'],
    ['提送審查時間', '業者按「提送審查」的時間，用於計算準時率'],
    ['審查人 / 審查時間 / 審查意見', '三維團隊審查結果']
  ].forEach(function (r) { add([r[0], r[1]]); });
  blank();
  add(['三、狀態流程', '', '', '']);
  [
    ['待處理 → 執行中', '業者開始辦理'],
    ['執行中 → 審核中', '業者上傳佐證並「提送審查」（業者選「已完成」也會自動改為審核中）'],
    ['審核中 → 已完成', '三維團隊核准'],
    ['審核中 → 退回補正', '三維團隊退回（必填審查意見），業者補正後再次提送'],
    ['待處理 / 執行中 → 逾期', '每日 00:10 排程自動判斷；延後截止日期會自動解除逾期'],
    ['三維 / 管理員', '可直接將工項結案為「已完成」（例如履約管理團隊自己的工項）']
  ].forEach(function (r) { add([r[0], r[1]]); });
  blank();
  add(['四、角色權限', '', '', '']);
  [
    ['系統管理員 (ADMIN)', '全部功能、帳號管理、審查'],
    ['三維團隊 (MANAGER_3D)', '審查工項、發佈工項、場館檢核、後台（不含帳號管理）'],
    ['交通處 (MANAGER_DEPT)', '檢視全部、發佈/修改工項、月報'],
    ['經營業者 (OPERATOR)', '只能看到並匯報自己負責的場站；完成後提送審查']
  ].forEach(function (r) { add([r[0], r[1]]); });
  blank();
  add(['五、自動排程', '', '', '']);
  [
    ['dailyMaintenance', '每日 00:10', '把期限已過的待處理/執行中改為逾期'],
    ['dailyReminders', '每日 08:30', '寄給執行人與該場站業者：到期前 7 天、3 天、當天，逾期第 1 天起每 7 天'],
    ['weeklySummary', '每週一 08:30', '寄週報給三維團隊與系統管理員']
  ].forEach(function (r) { add([r[0], r[1], r[2]]); });
  blank();
  add(['六、指令碼屬性', '', '', '']);
  [
    ['SYSTEM_URL', '信件中的系統網址'],
    ['REMINDERS_ENABLED', '設為 false 可暫停所有自動寄信'],
    ['PASSWORD_PEPPER', '系統自動產生，請勿修改或刪除'],
    ['WELCOME_EMAIL_SUBJECT / BODY', '歡迎信範本（後台可編輯）']
  ].forEach(function (r) { add([r[0], r[1]]); });

  sh.getRange(1, 1, rows.length, W).setValues(rows);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  rows.forEach(function (r, i) { if (/^[一二三四五六]、/.test(String(r[0]))) sh.getRange(i + 1, 1, 1, W).setFontWeight('bold').setBackground('#dbeafe'); });
  sh.setColumnWidth(1, 240);
  sh.setColumnWidth(2, 460);
  sh.setColumnWidth(3, 220);
  sh.setColumnWidth(4, 200);
  return '「' + SHEETS.DOCS + '」已重建' + renamed;
}

/** 安裝（或重新安裝）自動排程 */
function installTriggers() {
  const handlers = ['dailyMaintenance', 'dailyReminders', 'weeklySummary'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(0).nearMinute(10).inTimezone(TZ).create();
  ScriptApp.newTrigger('dailyReminders').timeBased().everyDays(1).atHour(8).nearMinute(30).inTimezone(TZ).create();
  ScriptApp.newTrigger('weeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).nearMinute(30).inTimezone(TZ).create();
}

/** 遮蔽 Messages 分頁中舊訊息的明文密碼（不刪除訊息本身） */
function redactPlaintextPasswords() {
  const sh = sheet_(SHEETS.MESSAGES);
  if (!sh || sh.getLastRow() < 2) return 0;
  const range = sh.getRange(2, 4, sh.getLastRow() - 1, 1);
  const vals = range.getValues();
  let count = 0;
  // 只比對「預設密碼：xxxx」這類標籤，避免誤改「修改密碼：(換行)網址」
  const re = /((?:預設|初始|臨時)密碼[ \t]*[:：][ \t]*)([^\s（(]+)/g;
  for (let i = 0; i < vals.length; i++) {
    const before = String(vals[i][0] || '');
    const after = before.replace(re, function (m, label, pwd) { return pwd === '（已移除）' ? m : label + '（已移除）'; });
    if (after !== before) { vals[i][0] = after; count++; }
  }
  if (count > 0) range.setValues(vals);
  writeLog('資安清理', '', '遮蔽 Messages 明文密碼 ' + count + ' 則', Session.getEffectiveUser().getEmail());
  Logger.log('已遮蔽 ' + count + ' 則訊息中的密碼');
  return count;
}
