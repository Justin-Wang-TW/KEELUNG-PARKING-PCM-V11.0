/**
 * 基隆市停車場履約管理系統 - 後端 API (Google Apps Script)
 * 版本：V11.0
 *
 * V11.0 重點變更
 *  - 登入改為 Session Token（存在 CacheService，6 小時滑動過期），不再以密碼雜湊當通行證
 *  - 密碼改為「加鹽 + 伺服器端 Pepper」的 HMAC-SHA256 迭代雜湊；舊帳號登入時自動升級
 *  - 所有 API 一律走 POST，網址不再帶任何身分資訊
 *  - 每個動作都做角色與場站權限檢查（修正：任何人可改他人權限/密碼的漏洞）
 *  - 工項審查流程：業者提送 → 審核中 → 三維核准(已完成) / 退回補正
 *  - 每月場館檢核「異常」項目自動開立缺失改善單（預設 14 日曆天）
 *  - 補上任務留言板 API（getComments / addComment）
 *  - 每日排程：逾期狀態寫回、到期提醒信；每週一：三維團隊總表
 *
 * 一次性設定與資料遷移請見 Setup.js（setupV11）。
 */

// ==========================================
// 0. 系統設定
// ==========================================

const APP_VERSION = 'V11.0';
const TZ = 'Asia/Taipei';
const DEFAULT_FOLDER_NAME = '停車場系統_附件備份';
// 所有上傳檔案的 Google Drive 資料夾（前端傳來的 folderId 一律忽略，避免寫入任意資料夾）
const UPLOAD_FOLDER_ID = '14Q298fPOjV17lx215IbmKD63AGJ3PYoS';
const DEFAULT_SYSTEM_URL = 'https://keelung-parking.vercel.app/';
const SESSION_TTL_SECONDS = 21600; // 6 小時（CacheService 上限）
const PASSWORD_ITERATIONS = 64;
const DEFECT_DEFAULT_DAYS = 14;
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_SECONDS = 900;

const SHEETS = {
  TASKS: '1_任務執行表',
  CHECKLIST: '2_每月場館檢核紀錄',
  MEETINGS: '2_會議與現勘紀錄',
  USERS: '3_使用者權限表',
  LOGS: '4_操作歷程紀錄',
  CONTACTS: '5_通訊錄',
  TEMPLATE: '6_檢核項目範本',
  ASSETS: '7_財產清單表',
  ASSET_CHECKS: '7_1_財產單項檢核紀錄',
  ASSET_BATCHES: '8_財產批次檢核紀錄',
  DOCS: '9_系統說明與參數',
  COMMENTS: '10_任務留言',
  MESSAGES: 'Messages',
  SYSLOG: 'SystemLogs'
};

const STATUS = {
  PENDING: '待處理',
  IN_PROGRESS: '執行中',
  UNDER_REVIEW: '審核中',
  RETURNED: '退回補正',
  COMPLETED: '已完成',
  OVERDUE: '逾期'
};
const ALL_STATUSES = [STATUS.PENDING, STATUS.IN_PROGRESS, STATUS.UNDER_REVIEW, STATUS.RETURNED, STATUS.COMPLETED, STATUS.OVERDUE];
// 仍需業者/執行人採取行動的狀態（提醒信對象）
const ACTIONABLE_STATUSES = [STATUS.PENDING, STATUS.IN_PROGRESS, STATUS.OVERDUE, STATUS.RETURNED];

const TASK_TYPE = { NORMAL: '一般', DEFECT: '缺失改善' };

const ROLE = { ADMIN: 'ADMIN', MANAGER_3D: 'MANAGER_3D', MANAGER_DEPT: 'MANAGER_DEPT', OPERATOR: 'OPERATOR', PENDING: 'PENDING' };
const ANY_ROLE = [ROLE.ADMIN, ROLE.MANAGER_3D, ROLE.MANAGER_DEPT, ROLE.OPERATOR];
const REVIEWER_ROLES = [ROLE.ADMIN, ROLE.MANAGER_3D];
const TASK_MANAGER_ROLES = [ROLE.ADMIN, ROLE.MANAGER_3D, ROLE.MANAGER_DEPT];
const ADMIN_ONLY = [ROLE.ADMIN];

const STATIONS = [
  { code: 'BAIFU', name: '百福立體停車場', prefix: '百福' },
  { code: 'CHENG', name: '成功立體停車場', prefix: '成功' },
  { code: 'XINYI', name: '信義國小地下停車場', prefix: '信義' },
  { code: 'SHELIAO', name: '社寮橋平面停車場', prefix: '社寮' },
  { code: 'CONTRACT_TEAM', name: '履約管理團隊', prefix: 'CO' }
];
const OPERATING_STATION_CODES = ['BAIFU', 'CHENG', 'XINYI', 'SHELIAO'];

// 1_任務執行表 欄位（0-based index）
const TASK_HEADERS = [
  '任務序號 (UID)', '場站代碼', '工項編號', '項目名稱', '截止日期', '目前狀態', '執行人', '最後更新時間', '附件連結',
  '週期類型', '週期群組ID', '任務類型', '來源關聯', '提送審查時間', '審查人', '審查時間', '審查意見'
];
const TC = {
  UID: 0, STATION: 1, ITEM_CODE: 2, ITEM_NAME: 3, DEADLINE: 4, STATUS: 5, EXECUTOR: 6, UPDATED: 7, ATTACH: 8,
  RECURRENCE: 9, GROUP: 10, TYPE: 11, SOURCE: 12, SUBMITTED: 13, REVIEWER: 14, REVIEWED: 15, REVIEW_NOTE: 16
};

// 3_使用者權限表 欄位
const UC = { NAME: 0, EMAIL: 1, ROLE: 2, STATION: 3, STATUS: 4, PWD: 5, FORCE: 6, ORG: 7 };

const CHECKLIST_HEADERS = ['提交ID', '場站代碼', '檢核月份', '提交時間', '提交人', '項目ID', '類別', '檢查內容', '檢查結果', '備註說明', '照片連結', '已改善警示ID'];
const COMMENT_HEADERS = ['ID', '任務序號 (UID)', '使用者', '姓名', '留言內容', '時間'];

// ==========================================
// 1. 共用工具
// ==========================================

function ss_() {
  if (!ss_.cache) ss_.cache = SpreadsheetApp.getActiveSpreadsheet();
  return ss_.cache;
}

function sheet_(name) {
  return ss_().getSheetByName(name);
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function pad2_(n) {
  return ('0' + String(n)).slice(-2);
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function todayStr_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/** 將各種日期格式統一為 yyyy-MM-dd（台北時區） */
function toDateStr_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (isDate_(v)) {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  const s = String(v).trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (m) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  const d = parseDateTime_(s);
  if (d) return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  return s;
}

/** 解析日期時間（支援 Date、ISO 字串、「2026/4/14 下午 6:12:35」格式） */
function parseDateTime_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (isDate_(v)) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(上午|下午)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    let h = Number(m[5]);
    if (m[4] === '下午' && h < 12) h += 12;
    if (m[4] === '上午' && h === 12) h = 0;
    // 台北 = UTC+8
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h - 8, Number(m[6]), Number(m[7] || 0)));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toIso_(v) {
  const d = parseDateTime_(v);
  return d ? d.toISOString() : (v ? String(v) : '');
}

/** 兩個 yyyy-MM-dd 的天數差（to - from） */
function daysBetween_(fromStr, toStr) {
  const a = String(fromStr).split('-').map(Number);
  const b = String(toStr).split('-').map(Number);
  if (a.length !== 3 || b.length !== 3 || a.some(isNaN) || b.some(isNaN)) return NaN;
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

function addDays_(dateStr, n) {
  const p = String(dateStr).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function isValidDateStr_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(daysBetween_('2000-01-01', s));
}

function htmlEscape_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function systemUrl_() {
  return props_().getProperty('SYSTEM_URL') || DEFAULT_SYSTEM_URL;
}

function emailsEnabled_() {
  return props_().getProperty('REMINDERS_ENABLED') !== 'false';
}

/** 防止公式注入 (CSV Injection) */
function sanitizeInput(input) {
  if (typeof input === 'string') {
    if (/^[\=\+\-\@]/.test(input)) return "'" + input;
    return input;
  } else if (Array.isArray(input)) {
    return input.map(function (item) { return sanitizeInput(item); });
  } else if (typeof input === 'object' && input !== null) {
    const sanitized = {};
    for (const key in input) {
      // 檔案內容 (base64) 不需處理
      sanitized[key] = (key === 'content' && typeof input[key] === 'string' && input[key].indexOf('data:') === 0)
        ? input[key]
        : sanitizeInput(input[key]);
    }
    return sanitized;
  }
  return input;
}

/** API 流量限制：每人每分鐘 90 次 */
function checkRateLimit(userEmail) {
  if (!userEmail) return true;
  const cache = CacheService.getScriptCache();
  const key = 'rate_limit_' + String(userEmail).toLowerCase();
  const count = Number(cache.get(key) || 0);
  if (count > 90) return false;
  cache.put(key, String(count + 1), 60);
  return true;
}

// ----- 場站 -----

function stationCode_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';
  const up = s.toUpperCase();
  if (up === 'ALL' || s === '全部') return 'ALL';
  if (up === 'PCM_TEAM') return 'CONTRACT_TEAM';
  for (let i = 0; i < STATIONS.length; i++) {
    const st = STATIONS[i];
    if (up === st.code || s === st.name) return st.code;
  }
  for (let i = 0; i < STATIONS.length; i++) {
    const st = STATIONS[i];
    if (st.code !== 'CONTRACT_TEAM' && s.indexOf(st.prefix) === 0) return st.code;
  }
  if (s.indexOf('履約管理') >= 0) return 'CONTRACT_TEAM';
  return s;
}

function stationName_(code) {
  const st = STATIONS.filter(function (x) { return x.code === code; })[0];
  return st ? st.name : String(code || '');
}

function stationPrefix_(code) {
  const st = STATIONS.filter(function (x) { return x.code === code; })[0];
  return st ? st.prefix : String(code || 'TK').substring(0, 2);
}

// ==========================================
// 2. 帳號、密碼與 Session
// ==========================================

function mapRole(roleStr) {
  const s = String(roleStr || '').trim();
  if (s === '待審核' || s.toUpperCase() === 'PENDING') return ROLE.PENDING;
  if (s === '管理員' || s.toUpperCase() === 'ADMIN' || s.indexOf('系統管理員') >= 0) return ROLE.ADMIN;
  if (s === '經理' || s.indexOf('三維') >= 0 || s.toUpperCase() === 'MANAGER' || s.toUpperCase() === 'MANAGER_3D') return ROLE.MANAGER_3D;
  if (s.indexOf('交通處') >= 0 || s.indexOf('GOV') >= 0 || s.toUpperCase() === 'MANAGER_DEPT') return ROLE.MANAGER_DEPT;
  return ROLE.OPERATOR;
}

const ROLE_SHEET_LABEL = {
  ADMIN: '系統管理員(ADMIN)',
  MANAGER_3D: '三維團隊(MANAGER_3D)',
  MANAGER_DEPT: '交通處(MANAGER_DEPT)',
  OPERATOR: '經營業者(OPERATOR)',
  PENDING: '待審核'
};

function normalizeAssigned_(v) {
  const s = String(v || '').trim();
  if (!s || s === '待分配') return '';
  if (s === '全部' || s.toUpperCase() === 'ALL') return 'ALL';
  return s.split(',').map(function (x) { return stationCode_(x); }).filter(function (x) { return !!x; }).join(',');
}

function readUsers_() {
  const sh = sheet_(SHEETS.USERS);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
  const users = [];
  values.forEach(function (r, i) {
    const email = String(r[UC.EMAIL] || '').trim();
    if (!email) return;
    users.push({
      row: i + 2,
      name: String(r[UC.NAME] || ''),
      email: email,
      emailKey: email.toLowerCase(),
      role: mapRole(r[UC.ROLE]),
      assignedStation: normalizeAssigned_(r[UC.STATION]),
      isActive: String(r[UC.STATUS]).trim() === '啟用',
      pwd: String(r[UC.PWD] || '').trim(),
      forceChangePassword: String(r[UC.FORCE]).toUpperCase() === 'TRUE',
      organization: String(r[UC.ORG] || '')
    });
  });
  return users;
}

function findUser_(email) {
  const key = String(email || '').trim().toLowerCase();
  return readUsers_().filter(function (u) { return u.emailKey === key; })[0] || null;
}

function publicUser_(u) {
  return {
    name: u.name,
    email: u.email,
    role: u.role,
    assignedStation: u.assignedStation,
    isActive: u.isActive,
    forceChangePassword: u.forceChangePassword,
    organization: u.organization
  };
}

function isHex64_(s) {
  return /^[0-9a-f]{64}$/i.test(String(s || ''));
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function randomHex32_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

/** 伺服器端 Pepper（存在 Script Properties；遺失會導致所有密碼失效，請勿刪除） */
function pepper_() {
  const p = props_();
  let v = p.getProperty('PASSWORD_PEPPER');
  if (!v) {
    v = randomHex32_();
    p.setProperty('PASSWORD_PEPPER', v);
  }
  return v;
}

function hashPassword_(clientHash, salt, iterations) {
  const key = pepper_();
  let h = String(clientHash).toLowerCase();
  for (let i = 0; i < iterations; i++) {
    h = bytesToHex_(Utilities.computeHmacSha256Signature(salt + ':' + h, key));
  }
  return h;
}

/** clientHash = 前端 SHA-256(明文密碼) */
function makePasswordRecord_(clientHash) {
  const salt = Utilities.getUuid().replace(/-/g, '');
  return 'pbk$' + PASSWORD_ITERATIONS + '$' + salt + '$' + hashPassword_(clientHash, salt, PASSWORD_ITERATIONS);
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function verifyPassword_(clientHash, stored) {
  stored = String(stored || '').trim();
  if (!stored || !isHex64_(clientHash)) return { ok: false, upgrade: false };
  if (stored.indexOf('pbk$') === 0) {
    const parts = stored.split('$');
    if (parts.length !== 4) return { ok: false, upgrade: false };
    return { ok: safeEqual_(hashPassword_(clientHash, parts[2], Number(parts[1])), parts[3]), upgrade: false };
  }
  // 舊格式：直接存前端 SHA-256
  return { ok: isHex64_(stored) && safeEqual_(stored.toLowerCase(), String(clientHash).toLowerCase()), upgrade: true };
}

function createSession_(u, minIat) {
  const token = randomHex32_();
  const revoked = Number(props_().getProperty('revoked_' + String(u.email).toLowerCase()) || 0);
  const session = {
    email: u.email,
    name: u.name,
    role: u.role,
    assignedStation: u.assignedStation,
    iat: Math.max(Date.now(), (minIat || 0) + 1, revoked + 1)
  };
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(session), SESSION_TTL_SECONDS);
  return token;
}

function getSession_(token) {
  if (!token || !isHex64_(token)) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) return null;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return null; }
  const revoked = props_().getProperty('revoked_' + String(s.email).toLowerCase());
  if (revoked && Number(revoked) >= Number(s.iat)) {
    cache.remove('sess_' + token);
    return null;
  }
  cache.put('sess_' + token, raw, SESSION_TTL_SECONDS); // 滑動延長
  s.token = token;
  return s;
}

/** 讓某使用者既有的所有 Session 失效（改權限、停用、改密碼時） */
function revokeUserSessions_(email) {
  const ts = Date.now();
  props_().setProperty('revoked_' + String(email).toLowerCase(), String(ts));
  return ts;
}

function isReviewer_(s) {
  return REVIEWER_ROLES.indexOf(s.role) >= 0;
}

function canAccessStation_(s, code) {
  code = stationCode_(code);
  if (s.role === ROLE.OPERATOR && code === 'CONTRACT_TEAM') return false;
  if (s.assignedStation === 'ALL') return true;
  if (!code) return false;
  return String(s.assignedStation || '').split(',').indexOf(code) >= 0;
}

function login_(p) {
  const email = String(p.email || p.userEmail || '').trim().toLowerCase();
  const clientHash = String(p.password || '').trim().toLowerCase();
  if (!email || !isHex64_(clientHash)) return { success: false, msg: '請輸入帳號與密碼' };

  const cache = CacheService.getScriptCache();
  const failKey = 'login_fail_' + email;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= LOGIN_MAX_FAILS) return { success: false, msg: '密碼錯誤次數過多，請 15 分鐘後再試' };
  const fail = function (msg) {
    cache.put(failKey, String(fails + 1), LOGIN_LOCK_SECONDS);
    return { success: false, msg: msg };
  };

  const u = findUser_(email);
  if (!u) return fail('帳號或密碼錯誤');
  const v = verifyPassword_(clientHash, u.pwd);
  if (!v.ok) return fail('帳號或密碼錯誤');
  if (!u.isActive) return { success: false, msg: '帳號審核中或已停用，請洽系統管理員' };

  if (v.upgrade) {
    sheet_(SHEETS.USERS).getRange(u.row, UC.PWD + 1).setValue(makePasswordRecord_(clientHash));
  }
  cache.remove(failKey);
  const token = createSession_(u);
  writeLog('登入', '', '', u.email);
  return { success: true, token: token, user: publicUser_(u) };
}

function me_(s) {
  const u = findUser_(s.email);
  if (!u || !u.isActive) return { success: false, code: 'AUTH_EXPIRED', msg: '帳號已停用' };
  return { success: true, user: publicUser_(u) };
}

function changePassword_(p, s) {
  const newHash = String(p.newPassword || '').trim().toLowerCase();
  if (!isHex64_(newHash)) return { success: false, msg: '密碼格式錯誤' };
  const u = findUser_(s.email);
  if (!u) return { success: false, msg: '找不到帳號' };
  if (p.currentPassword) {
    if (!verifyPassword_(String(p.currentPassword).toLowerCase(), u.pwd).ok) return { success: false, msg: '目前密碼不正確' };
  }
  if (verifyPassword_(newHash, u.pwd).ok) return { success: false, msg: '新密碼不可與舊密碼相同' };
  const sh = sheet_(SHEETS.USERS);
  sh.getRange(u.row, UC.PWD + 1).setValue(makePasswordRecord_(newHash));
  sh.getRange(u.row, UC.FORCE + 1).setValue(false);
  const ts = revokeUserSessions_(u.email);
  u.forceChangePassword = false;
  const token = createSession_(u, ts);
  writeLog('修改密碼', '', '使用者自行修改密碼', u.email);
  return { success: true, token: token, user: publicUser_(u) };
}

function getUsers_(s) {
  return { success: true, users: readUsers_().map(publicUser_) };
}

function registerUser(user) {
  user = user || {};
  const email = String(user.email || '').trim().toLowerCase();
  const name = String(user.name || '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) return { success: false, msg: '請填寫正確的姓名與 Email' };
  const sh = sheet_(SHEETS.USERS);
  if (!sh) return { success: false, msg: '找不到權限表' };
  if (findUser_(email)) return { success: false, msg: '此 Email 已註冊過' };
  sh.appendRow([name, email, '待審核', '待分配', '待審核', '', true, String(user.organization || '')]);
  writeLog('註冊申請', '', name + ' (' + (user.organization || '') + ')', email);

  // 通知系統管理員（站內訊息 + Email）
  readUsers_().filter(function (u) { return u.role === ROLE.ADMIN && u.isActive; }).forEach(function (admin) {
    createMessage('SYSTEM', admin.email, '【帳號申請】' + name + '（' + (user.organization || '未填單位') + '，' + email + '）申請使用系統，請至「後台管理」審核。', 'system', '');
    if (emailsEnabled_()) {
      try {
        MailApp.sendEmail({
          to: admin.email,
          subject: '【履約管理系統】新帳號申請：' + name,
          body: name + '（' + (user.organization || '未填單位') + '，' + email + '）申請使用系統。\n\n請登入後至「後台管理」審核：\n' + systemUrl_(),
          name: '基隆市停車場履約管理系統'
        });
      } catch (e) { Logger.log('通知管理員失敗: ' + e); }
    }
  });
  return { success: true };
}

function updateUser_(p, s) {
  const target = findUser_(p.targetEmail);
  if (!target) return { success: false, msg: '找不到該使用者' };
  const updates = p.updates || {};
  const isSelf = target.emailKey === String(s.email).toLowerCase();
  if (isSelf && ((updates.role && updates.role !== ROLE.ADMIN) || updates.isActive === false)) {
    return { success: false, msg: '不可移除自己的管理員權限或停用自己的帳號' };
  }
  const sh = sheet_(SHEETS.USERS);
  const row = target.row;
  const changes = [];
  if (updates.role) {
    if (!ROLE_SHEET_LABEL[updates.role]) return { success: false, msg: '角色不正確' };
    sh.getRange(row, UC.ROLE + 1).setValue(ROLE_SHEET_LABEL[updates.role]);
    changes.push('角色=' + updates.role);
  }
  if (updates.assignedStation !== undefined && updates.assignedStation !== null) {
    const st = normalizeAssigned_(updates.assignedStation);
    sh.getRange(row, UC.STATION + 1).setValue(st === 'ALL' ? '全部' : st);
    changes.push('場站=' + (st || '未分配'));
  }
  if (updates.isActive !== undefined) {
    sh.getRange(row, UC.STATUS + 1).setValue(updates.isActive ? '啟用' : '停用');
    changes.push(updates.isActive ? '啟用' : '停用');
  }
  if (updates.password) {
    if (!isHex64_(updates.password)) return { success: false, msg: '密碼格式錯誤' };
    sh.getRange(row, UC.PWD + 1).setValue(makePasswordRecord_(String(updates.password).toLowerCase()));
    changes.push('重設密碼');
  }
  if (updates.forceChangePassword !== undefined) {
    sh.getRange(row, UC.FORCE + 1).setValue(!!updates.forceChangePassword);
  }
  if (updates.organization !== undefined) {
    sh.getRange(row, UC.ORG + 1).setValue(String(updates.organization || ''));
  }
  if (!isSelf) revokeUserSessions_(target.email);
  writeLog('核准用戶', '', target.email + '：' + changes.join('、'), s.email);
  return { success: true };
}

function deleteUser_(p, s) {
  const target = findUser_(p.targetEmail);
  if (!target) return { success: false, msg: '找不到該使用者 Email' };
  if (target.emailKey === String(s.email).toLowerCase()) return { success: false, msg: '不可刪除自己的帳號' };
  sheet_(SHEETS.USERS).deleteRow(target.row);
  revokeUserSessions_(target.email);
  writeLog('刪除帳號', '', '刪除目標: ' + target.email, s.email);
  return { success: true };
}

// ==========================================
// 3. Web App 進入點
// ==========================================

/**
 * 路由表
 *  public: 不需登入
 *  roles : 允許的角色
 *  write : 會寫入資料（加上鎖定）
 */
const ROUTES = {
  ping: { public: true, fn: function () { return { success: true, msg: 'API ' + APP_VERSION + ' 運作中' }; } },
  login: { public: true, write: true, fn: function (p) { return login_(p); } },
  registerUser: { public: true, write: true, fn: function (p) { return registerUser(p.user); } },
  logError: { public: true, write: true, fn: function (p) { return logErrorToSheet(p.data || {}); } },

  logout: { roles: ANY_ROLE, fn: function (p, s) { CacheService.getScriptCache().remove('sess_' + s.token); return { success: true }; } },
  me: { roles: ANY_ROLE, fn: function (p, s) { return me_(s); } },
  changePassword: { roles: ANY_ROLE, write: true, fn: function (p, s) { return changePassword_(p, s); } },

  // 讀取
  getUsers: { roles: ANY_ROLE, fn: function (p, s) { return getUsers_(s); } },
  getTasks: { roles: ANY_ROLE, fn: function (p, s) { return getTasks_(s); } },
  getTaskLogs: { roles: ANY_ROLE, fn: function (p, s) { return getTaskLogs_(p, s); } },
  getComments: { roles: ANY_ROLE, fn: function (p, s) { return getComments_(p, s); } },
  getChecklistSubmissions: { roles: ANY_ROLE, fn: function (p, s) { return getChecklistSubmissions_(s); } },
  getChecklistTemplate: { roles: ANY_ROLE, fn: function () { return getChecklistTemplate(); } },
  getLogs: { roles: REVIEWER_ROLES, fn: function () { return getLogs(); } },
  getMeetings: { roles: ANY_ROLE, fn: function () { return getMeetings(); } },
  getContacts: { roles: ANY_ROLE, fn: function () { return getContacts(); } },
  getAssets: { roles: ANY_ROLE, fn: function () { return getAssets(); } },
  getAssetCheckRecords: { roles: ANY_ROLE, fn: function () { return getAssetCheckRecords(); } },
  getAssetCheckBatches: { roles: ANY_ROLE, fn: function () { return getAssetCheckBatches(); } },
  getMessages: { roles: ANY_ROLE, fn: function (p, s) { return getMessages(s.email); } },
  getEmailTemplate: { roles: REVIEWER_ROLES, fn: function () { return getEmailTemplate(); } },

  // 訊息
  sendMessage: { roles: ANY_ROLE, write: true, fn: function (p, s) { return sendMessage_(p, s); } },
  markAsRead: { roles: ANY_ROLE, write: true, fn: function (p, s) { return markAsRead_(p, s); } },

  // 工項
  createTask: { roles: TASK_MANAGER_ROLES, write: true, fn: function (p, s) { return createTask_(p, s); } },
  updateTask: { roles: ANY_ROLE, write: true, fn: function (p, s) { return updateTaskProgress_(p, s); } },
  reviewTask: { roles: REVIEWER_ROLES, write: true, fn: function (p, s) { return reviewTask_(p, s); } },
  updateTaskMetadata: { roles: TASK_MANAGER_ROLES, write: true, fn: function (p, s) { return updateTaskMetadata_(p, s); } },
  deleteTask: { roles: TASK_MANAGER_ROLES, write: true, fn: function (p, s) { return deleteTask_(p, s); } },
  addComment: { roles: ANY_ROLE, write: true, fn: function (p, s) { return addComment_(p, s); } },

  // 場館檢核
  submitChecklist: { roles: REVIEWER_ROLES, write: true, fn: function (p, s) { return submitChecklist_(p.data, s); } },
  resolveAlert: { roles: REVIEWER_ROLES, write: true, fn: function (p, s) { return resolveAlert_(p, s); } },
  saveChecklistTemplate: { roles: REVIEWER_ROLES, write: true, fn: function (p, s) { return saveChecklistTemplate(p.items, s.email); } },

  // 使用者與行政
  updateUser: { roles: ADMIN_ONLY, write: true, fn: function (p, s) { return updateUser_(p, s); } },
  deleteUser: { roles: ADMIN_ONLY, write: true, fn: function (p, s) { return deleteUser_(p, s); } },
  saveMeeting: { roles: ANY_ROLE, write: true, fn: function (p, s) { return saveMeeting(p.data, p.files || p.file, s.email); } },
  saveContact: { roles: REVIEWER_ROLES, write: true, fn: function (p, s) { return saveContact(p.data, s.email); } },
  saveEmailTemplate: { roles: ADMIN_ONLY, write: true, fn: function (p) { return saveEmailTemplate(p.template); } },
  sendWelcomeEmail: { roles: ADMIN_ONLY, write: true, fn: function (p, s) { return sendWelcomeEmail_(p, s); } },

  // 財產
  saveAsset: { roles: ANY_ROLE, write: true, fn: function (p, s) { return saveAsset_(p.data, p.files || p.file, s); } },
  updateAsset: { roles: ANY_ROLE, write: true, fn: function (p, s) { return updateAsset_(p.data, p.files || p.file, s); } },
  deleteAsset: { roles: ANY_ROLE, write: true, fn: function (p, s) { return deleteAsset_(p.id, s); } },
  submitAssetCheck: { roles: ANY_ROLE, write: true, fn: function (p, s) { return submitAssetCheck_(p.data, p.files || p.file, s); } },
  saveAssetCheckBatch: { roles: ANY_ROLE, write: true, fn: function (p, s) { return saveAssetCheckBatch_(p.data, p.files, s); } },
  saveAssetsBatch: { roles: ANY_ROLE, write: true, fn: function (p, s) { return saveAssetsBatch_(p.items, s); } }
};

const SANITIZE_KEYS = ['data', 'taskData', 'updates', 'items', 'user', 'content', 'comment'];

function doGet(e) {
  return json_({ success: true, msg: '基隆市停車場履約管理系統 API ' + APP_VERSION + '（所有功能請使用 POST）' });
}

function doPost(e) {
  let params;
  try {
    params = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ success: false, code: 'BAD_REQUEST', msg: '請求格式錯誤' });
  }
  const route = ROUTES[params.action];
  if (!route) return json_({ success: false, msg: '未知指令: ' + params.action });

  let session = null;
  if (!route.public) {
    session = getSession_(params.token);
    if (!session) return json_({ success: false, code: 'AUTH_EXPIRED', msg: '登入已逾時，請重新登入' });
    if (route.roles.indexOf(session.role) < 0) return json_({ success: false, code: 'FORBIDDEN', msg: '權限不足' });
    if (!checkRateLimit(session.email)) return json_({ success: false, code: 'RATE_LIMIT', msg: '請求過於頻繁，請稍後再試' });
  }

  if (route.write) {
    SANITIZE_KEYS.forEach(function (k) {
      if (params[k] !== undefined) params[k] = sanitizeInput(params[k]);
    });
  }

  let lock = null;
  if (route.write) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return json_({ success: false, code: 'BUSY', msg: '系統忙碌中，請稍後再試' });
  }
  try {
    return json_(route.fn(params, session));
  } catch (err) {
    Logger.log(err && err.stack ? err.stack : err);
    return json_({ success: false, msg: '系統錯誤: ' + err });
  } finally {
    if (lock) lock.releaseLock();
  }
}

// ==========================================
// 4. 錯誤紀錄、操作日誌、站內訊息
// ==========================================

function logErrorToSheet(data) {
  let sheet = sheet_(SHEETS.SYSLOG);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.SYSLOG);
    sheet.appendRow(['Timestamp', 'Level', 'Message', 'User', 'Stack Trace', 'URL', 'User Agent']);
  }
  sheet.appendRow([
    new Date(), 'ERROR',
    String(data.message || 'Unknown Error').slice(0, 1000),
    String(data.user || 'Anonymous').slice(0, 200),
    String(data.stack || '').slice(0, 3000),
    String(data.url || '').slice(0, 500),
    String(data.userAgent || '').slice(0, 300)
  ]);
  return { success: true };
}

function writeLog(action, taskUid, detail, userEmail) {
  const sheet = sheet_(SHEETS.LOGS);
  if (sheet) sheet.appendRow([new Date(), userEmail || 'SYSTEM', action, taskUid || '', detail || '']);
}

function logRowToObj_(row, i) {
  const d = parseDateTime_(row[0]);
  return {
    id: String(i),
    timestamp: d ? d.toISOString() : '',
    userEmail: String(row[1] || ''),
    action: String(row[2] || ''),
    taskUid: String(row[3] || ''),
    details: String(row[4] || '')
  };
}

function getLogs() {
  const sheet = sheet_(SHEETS.LOGS);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, logs: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  return { success: true, logs: rows.map(logRowToObj_).reverse() };
}

function getTaskLogs_(p, s) {
  const t = findTask_(p.uid);
  if (!t) return { success: true, logs: [] };
  if (!canAccessStation_(s, t.task.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '權限不足' };
  const sheet = sheet_(SHEETS.LOGS);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, logs: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  const target = t.task.uid;
  const logs = rows.map(logRowToObj_).filter(function (l) { return l.taskUid.trim() === target; })
    .sort(function (a, b) { return a.timestamp < b.timestamp ? 1 : -1; });
  return { success: true, logs: logs };
}

function getMessages(userEmail) {
  const sheet = sheet_(SHEETS.MESSAGES);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, messages: [] };
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues();
  const me = String(userEmail).toLowerCase();
  const userMap = {};
  readUsers_().forEach(function (u) { userMap[u.emailKey] = u.name; });
  const messages = [];
  data.forEach(function (row) {
    const from = String(row[1] || '');
    const to = String(row[2] || '');
    if (to.toLowerCase() !== me && from.toLowerCase() !== me) return;
    messages.push({
      id: row[0],
      senderEmail: from,
      senderName: from === 'SYSTEM' ? '系統通知' : (userMap[from.toLowerCase()] || from),
      receiverEmail: to,
      receiverName: userMap[to.toLowerCase()] || to,
      content: row[3],
      type: row[4],
      relatedId: row[5],
      isRead: row[6] === true || String(row[6]).toUpperCase() === 'TRUE',
      timestamp: toIso_(row[7])
    });
  });
  return { success: true, messages: messages };
}

function sendMessage_(p, s) {
  const content = String(p.content || '').trim();
  if (!content) return { success: false, msg: '訊息內容不可空白' };
  if (p.type === 'broadcast') {
    if (TASK_MANAGER_ROLES.indexOf(s.role) < 0) return { success: false, code: 'FORBIDDEN', msg: '權限不足' };
    readUsers_().forEach(function (u) {
      if (u.isActive && u.emailKey !== String(s.email).toLowerCase()) createMessage(s.email, u.email, content, 'broadcast', p.relatedId || '');
    });
  } else {
    const to = findUser_(p.receiverEmail);
    if (!to) return { success: false, msg: '找不到收件者' };
    createMessage(s.email, to.email, content, 'private', p.relatedId || '');
  }
  return { success: true };
}

function markAsRead_(p, s) {
  const sheet = sheet_(SHEETS.MESSAGES);
  if (!sheet || sheet.getLastRow() < 2) return { success: true };
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const me = String(s.email).toLowerCase();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === String(p.messageId) && String(data[i][2]).toLowerCase() === me) {
      sheet.getRange(i + 2, 7).setValue(true);
      break;
    }
  }
  return { success: true };
}

function createMessage(senderEmail, receiverEmail, content, type, relatedId) {
  let sheet = sheet_(SHEETS.MESSAGES);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.MESSAGES);
    sheet.appendRow(['id', 'senderEmail', 'receiverEmail', 'content', 'type', 'relatedId', 'isRead', 'timestamp']);
  }
  sheet.appendRow([Utilities.getUuid(), senderEmail, receiverEmail, content, type, relatedId || '', false, new Date().toISOString()]);
}

/** 檢查內容是否 @提及 其他使用者並發送通知 */
function checkForMentions(content, relatedId, senderEmail) {
  if (!content) return;
  readUsers_().forEach(function (u) {
    if (!u.isActive || u.emailKey === String(senderEmail).toLowerCase()) return;
    if (content.indexOf('@' + u.email) >= 0 || (u.name && content.indexOf('@' + u.name) >= 0)) {
      createMessage('SYSTEM', u.email, senderEmail + ' 在工項 ' + relatedId + ' 的留言中提及了您', 'mention', relatedId);
    }
  });
}

function notifyReviewers_(content, relatedId, exceptEmail) {
  const except = String(exceptEmail || '').toLowerCase();
  readUsers_().forEach(function (u) {
    if (u.isActive && REVIEWER_ROLES.indexOf(u.role) >= 0 && u.emailKey !== except) {
      createMessage('SYSTEM', u.email, content, 'system', relatedId);
    }
  });
}

function getEmailTemplate() {
  const props = props_();
  const subject = props.getProperty('WELCOME_EMAIL_SUBJECT') || '歡迎加入基隆市停車場履約管理系統';
  const body = props.getProperty('WELCOME_EMAIL_BODY') ||
    '親愛的 {{name}} 您好，\n\n您的帳號已核准啟用。\n\n登入帳號：{{email}}\n預設密碼：{{password}}\n\n請點擊下方連結登入系統，並於首次登入後修改密碼：\n' + systemUrl_() + '\n\n祝您工作順利！';
  return { success: true, data: { subject: subject, body: body } };
}

function saveEmailTemplate(template) {
  template = template || {};
  const props = props_();
  props.setProperty('WELCOME_EMAIL_SUBJECT', String(template.subject || ''));
  props.setProperty('WELCOME_EMAIL_BODY', String(template.body || ''));
  return { success: true };
}

function sendWelcomeEmail_(p, s) {
  try {
    const target = findUser_(p.targetEmail);
    if (!target) return { success: false, msg: '找不到該使用者' };
    const tpl = p.template && p.template.body ? p.template : getEmailTemplate().data;
    const fill = function (text, pwd) {
      return String(text || '')
        .replace(/\{\{name\}\}/g, target.name || p.name || '')
        .replace(/\{\{email\}\}/g, target.email)
        .replace(/\{\{password\}\}/g, pwd);
    };
    MailApp.sendEmail({
      to: target.email,
      subject: fill(tpl.subject, ''),
      body: fill(tpl.body, String(p.tempPassword || '')),
      name: '基隆市停車場履約管理系統'
    });
    // 站內訊息不包含密碼
    createMessage('SYSTEM', target.email, fill(tpl.body, '（已寄送至您的電子郵件信箱）'), 'system', '');
    return { success: true };
  } catch (e) {
    return { success: false, msg: e.toString() };
  }
}

// ==========================================
// 5. 工項（任務）
// ==========================================

function tasksSheet_() {
  return sheet_(SHEETS.TASKS);
}

function normalizeStatus_(v) {
  const s = String(v || '').trim();
  if (!s) return STATUS.PENDING;
  return s;
}

function rowToTask_(r) {
  const code = stationCode_(r[TC.STATION]);
  return {
    uid: String(r[TC.UID]).trim(),
    stationCode: code,
    stationName: stationName_(code),
    itemCode: String(r[TC.ITEM_CODE] || ''),
    itemName: String(r[TC.ITEM_NAME] || ''),
    deadline: toDateStr_(r[TC.DEADLINE]),
    status: normalizeStatus_(r[TC.STATUS]),
    executorEmail: String(r[TC.EXECUTOR] || ''),
    lastUpdated: toIso_(r[TC.UPDATED]),
    attachmentUrl: String(r[TC.ATTACH] || ''),
    recurrence: String(r[TC.RECURRENCE] || ''),
    recurrenceGroupId: String(r[TC.GROUP] || ''),
    taskType: String(r[TC.TYPE] || '').trim() || (String(r[TC.ITEM_CODE]).trim() === 'DEFECT' ? TASK_TYPE.DEFECT : TASK_TYPE.NORMAL),
    sourceRef: String(r[TC.SOURCE] || ''),
    submittedAt: toIso_(r[TC.SUBMITTED]),
    reviewer: String(r[TC.REVIEWER] || ''),
    reviewedAt: toIso_(r[TC.REVIEWED]),
    reviewComment: String(r[TC.REVIEW_NOTE] || '')
  };
}

function readTasks_() {
  const sh = tasksSheet_();
  if (!sh) throw new Error('找不到任務執行表');
  const last = sh.getLastRow();
  const rows = [];
  if (last < 2) return { sh: sh, rows: rows };
  const vals = sh.getRange(2, 1, last - 1, TASK_HEADERS.length).getValues();
  vals.forEach(function (r, i) {
    if (!String(r[TC.UID]).trim()) return;
    rows.push({ rowNum: i + 2, raw: r, task: rowToTask_(r) });
  });
  return { sh: sh, rows: rows };
}

function findTask_(uid) {
  const id = String(uid || '').trim();
  if (!id) return null;
  const data = readTasks_();
  const row = data.rows.filter(function (r) { return r.task.uid === id; })[0];
  return row ? { sh: data.sh, rowNum: row.rowNum, task: row.task, all: data.rows } : null;
}

function setTaskCells_(sh, rowNum, values) {
  // values: { colIndex: value }
  Object.keys(values).forEach(function (k) {
    sh.getRange(rowNum, Number(k) + 1).setValue(values[k]);
  });
}

function getTasks_(s) {
  const tasks = readTasks_().rows.map(function (r) { return r.task; })
    .filter(function (t) { return canAccessStation_(s, t.stationCode); });
  return { success: true, tasks: tasks };
}

function generateUid_(stationCode, existing) {
  const prefix = stationPrefix_(stationCode);
  const ym = Utilities.formatDate(new Date(), TZ, 'yyyyMM');
  for (let i = 0; i < 60; i++) {
    const digits = i < 40 ? Math.floor(Math.random() * 900 + 100) : Math.floor(Math.random() * 9000 + 1000);
    const uid = prefix + '-' + ym + '-' + digits;
    if (!existing[uid]) {
      existing[uid] = true;
      return uid;
    }
  }
  const uid = prefix + '-' + ym + '-' + Date.now();
  existing[uid] = true;
  return uid;
}

function blankTaskRow_() {
  const r = [];
  for (let i = 0; i < TASK_HEADERS.length; i++) r.push('');
  return r;
}

function appendTaskRows_(sh, rows) {
  if (!rows.length) return;
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, TASK_HEADERS.length).setValues(rows);
}

function createTask_(p, s) {
  const list = Array.isArray(p.taskData) ? p.taskData : [p.taskData];
  const data = readTasks_();
  const existing = {};
  data.rows.forEach(function (r) { existing[r.task.uid] = true; });
  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const td = list[i] || {};
    const name = String(td.itemName || td.name || td.title || '').trim();
    const deadline = toDateStr_(td.deadline);
    if (!name) return { success: false, msg: '請填寫工項名稱' };
    if (!isValidDateStr_(deadline)) return { success: false, msg: '截止日期格式錯誤：' + td.deadline };
    let codes = td.isCommon ? OPERATING_STATION_CODES.slice() : (td.stationCodes || td.targetStations || []).map(stationCode_);
    codes = codes.filter(function (c, idx) { return c && c !== 'ALL' && codes.indexOf(c) === idx; });
    if (!codes.length) return { success: false, msg: '請選擇場站' };
    for (let j = 0; j < codes.length; j++) {
      if (!canAccessStation_(s, codes[j])) return { success: false, code: 'FORBIDDEN', msg: '無權限發佈 ' + stationName_(codes[j]) + ' 的工項' };
      const row = blankTaskRow_();
      row[TC.UID] = generateUid_(codes[j], existing);
      row[TC.STATION] = codes[j];
      row[TC.ITEM_CODE] = td.templateId || 'MANUAL';
      row[TC.ITEM_NAME] = name;
      row[TC.DEADLINE] = deadline;
      row[TC.STATUS] = deadline < todayStr_() ? STATUS.OVERDUE : STATUS.PENDING;
      row[TC.UPDATED] = new Date();
      row[TC.RECURRENCE] = td.recurrence && td.recurrence !== 'NONE' ? td.recurrence : '';
      row[TC.GROUP] = td.recurrenceGroupId || '';
      row[TC.TYPE] = TASK_TYPE.NORMAL;
      rows.push(row);
    }
  }
  appendTaskRows_(data.sh, rows);
  writeLog('新增工項', rows.length === 1 ? rows[0][TC.UID] : '', '發佈 ' + rows.length + ' 筆：' + rows[0][TC.ITEM_NAME], s.email);
  return { success: true, created: rows.length, uids: rows.map(function (r) { return r[TC.UID]; }) };
}

/**
 * 進度匯報
 *  - 業者 / 交通處：可設「執行中」或「審核中（提送審查）」，選「已完成」會自動改為「審核中」
 *  - 三維 / 管理員：可直接結案為「已完成」
 *  - 「逾期」由系統判斷，期限已過的待處理/執行中會維持逾期
 */
function updateTaskProgress_(p, s) {
  const found = findTask_(p.uid);
  if (!found) return { success: false, msg: '找不到任務 UID: ' + p.uid };
  const t = found.task;
  const sh = found.sh;
  if (!canAccessStation_(s, t.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '無權限操作此場站的工項' };
  const reviewer = isReviewer_(s);
  if (t.status === STATUS.COMPLETED && !reviewer) return { success: false, msg: '此工項已結案，如需修改請聯繫三維團隊' };

  let status = String(p.status || '').trim();
  if ([STATUS.PENDING, STATUS.IN_PROGRESS, STATUS.UNDER_REVIEW, STATUS.COMPLETED, STATUS.OVERDUE, STATUS.RETURNED].indexOf(status) < 0) {
    return { success: false, msg: '狀態不正確：' + status };
  }
  if (status === STATUS.COMPLETED && !reviewer) status = STATUS.UNDER_REVIEW;
  if (status === STATUS.RETURNED) status = t.status === STATUS.RETURNED ? STATUS.RETURNED : STATUS.IN_PROGRESS; // 退回只能由審查動作產生
  if (status === STATUS.OVERDUE) status = STATUS.IN_PROGRESS;
  if ((status === STATUS.PENDING || status === STATUS.IN_PROGRESS) && t.deadline && t.deadline < todayStr_()) status = STATUS.OVERDUE;

  // 附件：以 Sheet 目前內容為準再串接新檔案
  const fileData = p.files || p.file;
  let finalUrl = t.attachmentUrl || '';
  let uploadedCount = 0;
  if (fileData) {
    const uploadUrl = saveFileToDrive(fileData, 'Task_' + t.uid);
    if (uploadUrl) {
      uploadedCount = uploadUrl.split('\n').length;
      finalUrl = finalUrl ? finalUrl + '\n' + uploadUrl : uploadUrl;
    }
  }

  const now = new Date();
  const cells = {};
  cells[TC.STATUS] = status;
  cells[TC.EXECUTOR] = s.email;
  cells[TC.UPDATED] = now;
  cells[TC.ATTACH] = finalUrl;
  if (status === STATUS.UNDER_REVIEW && t.status !== STATUS.UNDER_REVIEW) cells[TC.SUBMITTED] = now;
  if (status === STATUS.COMPLETED && t.status !== STATUS.COMPLETED) {
    cells[TC.REVIEWER] = s.email;
    cells[TC.REVIEWED] = now;
    if (!t.submittedAt) cells[TC.SUBMITTED] = now;
  }
  setTaskCells_(sh, found.rowNum, cells);

  const prevExecutor = t.executorEmail;
  if (prevExecutor && prevExecutor.toLowerCase() !== String(s.email).toLowerCase()) {
    createMessage('SYSTEM', prevExecutor, '任務進度已更新：' + t.itemName + ' → ' + status, 'system', t.uid);
  }
  if (status === STATUS.UNDER_REVIEW && t.status !== STATUS.UNDER_REVIEW) {
    notifyReviewers_('【待審查】' + t.stationName + '：' + t.itemName + '（提送人 ' + (s.name || s.email) + '）', t.uid, s.email);
  }
  writeLog('進度匯報', t.uid, '更新狀態: ' + status + (uploadedCount ? '，上傳 ' + uploadedCount + ' 個檔案' : ''), s.email);

  if (status === STATUS.COMPLETED && t.taskType === TASK_TYPE.DEFECT) handleDefectClosed_(t.sourceRef);
  return { success: true, url: finalUrl, status: status };
}

/** 三維審查：核准 → 已完成；退回 → 退回補正（必填意見） */
function reviewTask_(p, s) {
  const found = findTask_(p.uid);
  if (!found) return { success: false, msg: '找不到任務 UID: ' + p.uid };
  const t = found.task;
  if (!canAccessStation_(s, t.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '無權限審查此場站的工項' };
  if (t.status !== STATUS.UNDER_REVIEW) return { success: false, msg: '此工項目前狀態為「' + t.status + '」，不是審核中' };
  const decision = String(p.decision || '');
  const comment = String(p.comment || '').trim().slice(0, 2000);
  if (decision !== 'approve' && decision !== 'return') return { success: false, msg: '審查結果不正確' };
  if (decision === 'return' && !comment) return { success: false, msg: '退回補正時請填寫審查意見' };

  const now = new Date();
  const newStatus = decision === 'approve' ? STATUS.COMPLETED : STATUS.RETURNED;
  const cells = {};
  cells[TC.STATUS] = newStatus;
  cells[TC.UPDATED] = now;
  cells[TC.REVIEWER] = s.email;
  cells[TC.REVIEWED] = now;
  cells[TC.REVIEW_NOTE] = comment;
  setTaskCells_(found.sh, found.rowNum, cells);

  const label = decision === 'approve' ? '審查核准' : '審查退回';
  writeLog(label, t.uid, comment || '（無意見）', s.email);
  addCommentRow_(t.uid, s.email, s.name, '【' + label + '】' + (comment || '核准結案'));

  const recipients = t.executorEmail ? [t.executorEmail] : stationContacts_(t.stationCode, readUsers_().filter(function (u) { return u.isActive; })).map(function (u) { return u.email; });
  recipients.forEach(function (to) {
    createMessage('SYSTEM', to, '【' + label + '】' + t.stationName + '：' + t.itemName + (comment ? '\n審查意見：' + comment : ''), 'system', t.uid);
  });
  if (decision === 'return' && emailsEnabled_() && recipients.length) {
    try {
      MailApp.sendEmail({
        to: recipients.join(','),
        subject: '【履約管理系統】工項退回補正：' + t.itemName,
        htmlBody: '<p>您提送的工項已被退回，請依審查意見補正後重新提送。</p>' +
          '<table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">' +
          '<tr><th align="left">場站</th><td>' + htmlEscape_(t.stationName) + '</td></tr>' +
          '<tr><th align="left">工項</th><td>' + htmlEscape_(t.itemName) + '</td></tr>' +
          '<tr><th align="left">截止日期</th><td>' + htmlEscape_(t.deadline) + '</td></tr>' +
          '<tr><th align="left">審查意見</th><td>' + htmlEscape_(comment).replace(/\n/g, '<br>') + '</td></tr>' +
          '<tr><th align="left">審查人</th><td>' + htmlEscape_(s.name || s.email) + '</td></tr></table>' +
          '<p><a href="' + htmlEscape_(systemUrl_()) + '">登入系統</a></p>',
        name: '基隆市停車場履約管理系統'
      });
    } catch (e) { Logger.log('退回通知信寄送失敗: ' + e); }
  }

  if (decision === 'approve' && t.taskType === TASK_TYPE.DEFECT) handleDefectClosed_(t.sourceRef);
  return { success: true, status: newStatus };
}

function updateTaskMetadata_(p, s) {
  const found = findTask_(p.uid);
  if (!found) return { success: false, msg: '找不到該工項 (UID: ' + p.uid + ')' };
  const t = found.task;
  if (!canAccessStation_(s, t.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '權限不足' };
  const updates = p.updates || {};
  const cells = {};
  const changes = [];
  if (updates.itemName && String(updates.itemName).trim() !== t.itemName) {
    cells[TC.ITEM_NAME] = String(updates.itemName).trim();
    changes.push('名稱：' + t.itemName + ' → ' + cells[TC.ITEM_NAME]);
  }
  if (updates.deadline) {
    const d = toDateStr_(updates.deadline);
    if (!isValidDateStr_(d)) return { success: false, msg: '截止日期格式錯誤' };
    if (d !== t.deadline) {
      cells[TC.DEADLINE] = d;
      changes.push('期限：' + t.deadline + ' → ' + d);
      if (t.status === STATUS.OVERDUE && d >= todayStr_()) {
        cells[TC.STATUS] = t.executorEmail ? STATUS.IN_PROGRESS : STATUS.PENDING;
        changes.push('解除逾期');
      }
      if ((t.status === STATUS.PENDING || t.status === STATUS.IN_PROGRESS) && d < todayStr_()) {
        cells[TC.STATUS] = STATUS.OVERDUE;
      }
    }
  }
  if (!changes.length) return { success: true };
  cells[TC.UPDATED] = new Date();
  setTaskCells_(found.sh, found.rowNum, cells);
  writeLog('修改工項', t.uid, changes.join('；'), s.email);
  return { success: true };
}

function deleteTask_(p, s) {
  const found = findTask_(p.uid);
  if (!found) return { success: false, msg: '找不到該工項 (UID: ' + p.uid + ')' };
  const t = found.task;
  if (!canAccessStation_(s, t.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '權限不足' };
  const mode = p.mode || 'THIS';
  const rowsToDelete = [];
  if (mode === 'THIS' || !t.recurrenceGroupId) {
    rowsToDelete.push(found.rowNum);
  } else {
    found.all.forEach(function (r) {
      if (r.task.recurrenceGroupId !== t.recurrenceGroupId) return;
      if (mode === 'ALL' || (mode === 'THIS_AND_FOLLOWING' && r.task.deadline >= t.deadline)) rowsToDelete.push(r.rowNum);
    });
  }
  rowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (row) { found.sh.deleteRow(row); });
  writeLog('刪除工項', t.uid, '已從系統移除 (模式: ' + mode + ', 共 ' + rowsToDelete.length + ' 筆)', s.email);
  return { success: true, deleted: rowsToDelete.length };
}

// ----- 留言 -----

function commentsSheet_() {
  let sh = sheet_(SHEETS.COMMENTS);
  if (!sh) {
    sh = ss_().insertSheet(SHEETS.COMMENTS);
    sh.appendRow(COMMENT_HEADERS);
  }
  return sh;
}

function addCommentRow_(uid, email, name, content) {
  commentsSheet_().appendRow([Utilities.getUuid(), uid, email, name || email, content, new Date()]);
}

function getComments_(p, s) {
  const found = findTask_(p.taskUid || p.uid);
  if (!found) return { success: true, comments: [] };
  if (!canAccessStation_(s, found.task.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '權限不足' };
  const sh = sheet_(SHEETS.COMMENTS);
  if (!sh || sh.getLastRow() < 2) return { success: true, comments: [] };
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, COMMENT_HEADERS.length).getValues();
  const comments = rows.filter(function (r) { return String(r[1]).trim() === found.task.uid; }).map(function (r) {
    return { id: String(r[0]), taskUid: String(r[1]), userEmail: String(r[2]), userName: String(r[3]), content: String(r[4]), timestamp: toIso_(r[5]) };
  });
  return { success: true, comments: comments };
}

function addComment_(p, s) {
  const found = findTask_(p.taskUid || p.uid);
  if (!found) return { success: false, msg: '找不到工項' };
  if (!canAccessStation_(s, found.task.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '權限不足' };
  const content = String(p.content || '').trim().slice(0, 2000);
  if (!content) return { success: false, msg: '留言內容不可空白' };
  addCommentRow_(found.task.uid, s.email, s.name, content);
  checkForMentions(content, found.task.uid, s.email);
  writeLog('新增留言', found.task.uid, content.slice(0, 100), s.email);
  return { success: true };
}

// ==========================================
// 6. 每月場館檢核與缺失改善
// ==========================================

function checklistSheet_() {
  let sh = sheet_(SHEETS.CHECKLIST);
  if (!sh) {
    sh = ss_().insertSheet(SHEETS.CHECKLIST);
    sh.appendRow(CHECKLIST_HEADERS);
  }
  return sh;
}

function submitChecklist_(data, s) {
  try {
    data = data || {};
    const stationCode = stationCode_(data.stationCode);
    if (!canAccessStation_(s, stationCode)) return { success: false, code: 'FORBIDDEN', msg: '無權限提交此場站的檢核' };
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return { success: false, msg: '沒有檢核項目' };
    const yearMonth = String(data.yearMonth || '').slice(0, 7);
    const sheet = checklistSheet_();
    const submissionId = Utilities.getUuid();
    const timestamp = new Date();
    const rowsToAdd = [];
    const photoByItem = {};

    results.forEach(function (item) {
      let photoUrl = '';
      const itemFiles = item.files && item.files.length ? item.files : (item.file ? [item.file] : null);
      if (itemFiles) photoUrl = saveFileToDrive(itemFiles, yearMonth + '_' + stationCode + '_' + item.itemId);
      photoByItem[item.itemId] = photoUrl;
      rowsToAdd.push([
        submissionId, stationCode, yearMonth, timestamp, s.email,
        item.itemId || '', item.category || '', item.content || '', item.status || '', item.note || '', photoUrl, ''
      ]);
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, CHECKLIST_HEADERS.length).setValues(rowsToAdd);
    writeLog('提交場館檢核', submissionId, '場站: ' + stationName_(stationCode) + '，月份: ' + yearMonth, s.email);

    // 異常項目 → 缺失改善單
    const issues = results.filter(function (r) { return r.status === '異常'; });
    const defects = createDefectTasks_(stationCode, yearMonth, submissionId, issues, photoByItem, s);
    return { success: true, msg: '提交成功', submissionId: submissionId, defects: defects };
  } catch (e) {
    return { success: false, msg: '系統錯誤: ' + e.toString() };
  }
}

function createDefectTasks_(stationCode, yearMonth, submissionId, issues, photoByItem, s) {
  if (!issues.length) return [];
  const data = readTasks_();
  const existing = {};
  data.rows.forEach(function (r) { existing[r.task.uid] = true; });
  const today = todayStr_();
  const rows = [];
  const created = [];
  issues.forEach(function (item) {
    let deadline = toDateStr_(item.defectDeadline);
    if (!isValidDateStr_(deadline)) deadline = addDays_(today, DEFECT_DEFAULT_DAYS);
    const row = blankTaskRow_();
    row[TC.UID] = generateUid_(stationCode, existing);
    row[TC.STATION] = stationCode;
    row[TC.ITEM_CODE] = 'DEFECT';
    row[TC.ITEM_NAME] = '【缺失改善】' + (item.category ? item.category + '－' : '') + (item.content || '檢核異常');
    row[TC.DEADLINE] = deadline;
    row[TC.STATUS] = STATUS.PENDING;
    row[TC.UPDATED] = new Date();
    row[TC.ATTACH] = photoByItem[item.itemId] || '';
    row[TC.TYPE] = TASK_TYPE.DEFECT;
    row[TC.SOURCE] = 'CHK:' + submissionId + ':' + item.itemId;
    rows.push(row);
    created.push({ uid: row[TC.UID], itemName: row[TC.ITEM_NAME], deadline: deadline, note: item.note || '' });
  });
  appendTaskRows_(data.sh, rows);
  created.forEach(function (d) {
    addCommentRow_(d.uid, s.email, s.name, '檢核異常說明（' + yearMonth + ' 月檢核）：' + (d.note || '（未填）') + '\n改善期限：' + d.deadline + '。改善完成後請上傳改善後照片並提送審查。');
    writeLog('開立缺失改善單', d.uid, d.itemName + '，期限 ' + d.deadline, s.email);
  });
  notifyDefectsCreated_(stationCode, created);
  return created;
}

function notifyDefectsCreated_(stationCode, defects) {
  if (!defects.length) return;
  const contacts = stationContacts_(stationCode, readUsers_().filter(function (u) { return u.isActive; }));
  const stName = stationName_(stationCode);
  contacts.forEach(function (u) {
    createMessage('SYSTEM', u.email, '【缺失改善】' + stName + ' 本次檢核開立 ' + defects.length + ' 項改善單，請於期限內完成並提送審查。', 'system', defects[0].uid);
  });
  if (!emailsEnabled_() || !contacts.length) return;
  const rowsHtml = defects.map(function (d) {
    return '<tr><td>' + htmlEscape_(d.uid) + '</td><td>' + htmlEscape_(d.itemName) + '</td><td>' + htmlEscape_(d.note) + '</td><td>' + htmlEscape_(d.deadline) + '</td></tr>';
  }).join('');
  try {
    MailApp.sendEmail({
      to: contacts.map(function (u) { return u.email; }).join(','),
      subject: '【履約管理系統】' + stName + ' 缺失改善通知（' + defects.length + ' 項）',
      htmlBody: '<p>' + htmlEscape_(stName) + ' 本次場館檢核發現以下異常，已開立缺失改善單：</p>' +
        '<table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px"><tr style="background:#fee2e2"><th>單號</th><th>項目</th><th>異常說明</th><th>改善期限</th></tr>' + rowsHtml + '</table>' +
        '<p>改善完成後請登入系統，於該工項上傳改善後照片並「提送審查」。</p><p><a href="' + htmlEscape_(systemUrl_()) + '">登入系統</a></p>',
      name: '基隆市停車場履約管理系統'
    });
  } catch (e) { Logger.log('缺失通知信寄送失敗: ' + e); }
}

/** 缺失改善單結案時：同一次檢核的所有改善單都完成，就自動把該次檢核的異常警示標記為已改善 */
function handleDefectClosed_(sourceRef) {
  const m = String(sourceRef || '').match(/^CHK:([^:]+):/);
  if (!m) return;
  const submissionId = m[1];
  const prefix = 'CHK:' + submissionId + ':';
  const related = readTasks_().rows.filter(function (r) { return r.task.sourceRef.indexOf(prefix) === 0; });
  const allDone = related.length > 0 && related.every(function (r) { return r.task.status === STATUS.COMPLETED; });
  if (allDone) resolveAlertInternal_(submissionId, null, 'SYSTEM');
}

function resolveAlertInternal_(submissionId, alertId, userEmail) {
  const sheet = sheet_(SHEETS.CHECKLIST);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, CHECKLIST_HEADERS.length).getValues();
  let updated = 0;
  data.forEach(function (row, i) {
    if (String(row[0]) !== String(submissionId)) return;
    let ym = row[2];
    if (isDate_(ym)) ym = Utilities.formatDate(ym, TZ, 'yyyy-MM');
    const id = alertId || (stationCode_(row[1]) + '-' + String(ym));
    const resolved = String(row[11] || '') ? String(row[11]).split(',') : [];
    if (resolved.indexOf(id) < 0) {
      resolved.push(id);
      sheet.getRange(i + 2, 12).setValue(resolved.join(','));
      updated++;
    }
  });
  if (updated > 0) writeLog('標記改善', submissionId, '警示ID: ' + (alertId || '（缺失改善單全數結案）'), userEmail);
  return updated;
}

function resolveAlert_(p, s) {
  const n = resolveAlertInternal_(p.submissionId, p.alertId, s.email);
  return n > 0 ? { success: true } : { success: false, msg: '找不到對應紀錄或已標記過' };
}

function getChecklistSubmissions_(s) {
  const sheet = sheet_(SHEETS.CHECKLIST);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, data: [] };
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, CHECKLIST_HEADERS.length).getValues();
  const map = {};
  const order = [];
  data.forEach(function (row) {
    const subId = String(row[0] || '');
    if (!subId) return;
    const code = stationCode_(row[1]);
    if (!canAccessStation_(s, code)) return;
    if (!map[subId]) {
      let ym = row[2];
      if (isDate_(ym)) ym = Utilities.formatDate(ym, TZ, 'yyyy-MM');
      const resolvedStr = String(row[11] || '');
      map[subId] = {
        id: subId, stationCode: code, stationName: stationName_(code), yearMonth: String(ym),
        submittedAt: toIso_(row[3]), submittedBy: String(row[4] || ''), results: [],
        resolvedAlerts: resolvedStr ? resolvedStr.split(',') : []
      };
      order.push(subId);
    }
    map[subId].results.push({ itemId: String(row[5]), category: row[6], content: row[7], status: row[8], note: row[9], photoUrl: row[10] || '' });
  });
  return { success: true, data: order.map(function (id) { return map[id]; }) };
}

function getChecklistTemplate() {
  let sheet = sheet_(SHEETS.TEMPLATE);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.TEMPLATE);
    sheet.appendRow(['ID', '分類', '檢查項目內容', '更新時間']);
    return { success: true, data: [] };
  }
  if (sheet.getLastRow() < 2) return { success: true, data: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  const data = rows.filter(function (row) { return row[0] && row[2]; }).map(function (row) {
    return { id: String(row[0]), category: String(row[1] || '未分類'), content: String(row[2]) };
  });
  return { success: true, data: data };
}

function saveChecklistTemplate(items, userEmail) {
  try {
    items = Array.isArray(items) ? items : [];
    let sheet = sheet_(SHEETS.TEMPLATE);
    if (!sheet) sheet = ss_().insertSheet(SHEETS.TEMPLATE);
    sheet.clear();
    sheet.appendRow(['ID', '分類', '檢查項目內容', '更新時間']);
    const now = new Date();
    const rows = items.map(function (item) { return [item.id, item.category, item.content, now]; });
    if (rows.length > 0) sheet.getRange(2, 1, rows.length, 4).setValues(rows);
    writeLog('更新檢核範本', '', '共 ' + rows.length + ' 項', userEmail);
    return { success: true };
  } catch (e) { return { success: false, msg: e.toString() }; }
}

// ==========================================
// 7. 會議紀錄、通訊錄
// ==========================================

function getContacts() {
  const sheet = sheet_(SHEETS.CONTACTS);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, data: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  const data = rows.map(function (row, i) {
    return {
      id: String(i), organization: String(row[0] || ''), project: String(row[1] || ''), name: String(row[2] || ''),
      phone: String(row[3] || ''), email: String(row[4] || ''), station: String(row[5] || ''), note: String(row[6] || '')
    };
  }).reverse();
  return { success: true, data: data };
}

function saveContact(data, userEmail) {
  const sheet = sheet_(SHEETS.CONTACTS);
  if (!sheet) return { success: false, msg: '找不到通訊錄表' };
  data = data || {};
  sheet.appendRow([data.organization || '', data.project || '', data.name || '', data.phone || '', data.email || '', data.station || '', data.note || '']);
  writeLog('新增通訊錄', '', data.name || '', userEmail);
  return { success: true };
}

function getMeetings() {
  const sheet = sheet_(SHEETS.MEETINGS);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, data: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  const data = rows.filter(function (r) { return r[1] && String(r[1]).trim() !== ''; }).map(function (row, i) {
    return {
      id: i,
      date: toDateStr_(row[0]),
      subject: row[1],
      summary: row[2],
      attachmentUrl: row[3],
      createdBy: row[4],
      stationCode: row[5] ? stationCode_(row[5]) : 'ALL'
    };
  }).reverse();
  return { success: true, data: data };
}

function saveMeeting(data, fileData, userEmail) {
  data = data || {};
  const sheet = sheet_(SHEETS.MEETINGS);
  if (!sheet) return { success: false, msg: '找不到會議紀錄表' };
  const url = fileData ? saveFileToDrive(fileData, 'Meeting') : '';
  sheet.appendRow([toDateStr_(data.date) || todayStr_(), data.subject || '', data.summary || '', url, userEmail, data.stationCode || 'ALL']);
  writeLog('新增會議紀錄', '', data.subject || '', userEmail);
  return { success: true, url: url };
}

// ==========================================
// 8. 財產管理
// ==========================================

const ASSET_HEADERS = ['ID', '場站代碼', '場站名稱', '財產名稱', '單位', '設備商', '所在位置', '狀態', '日期', '數量', '備註', '照片連結', '最後更新者'];

function assetsSheet_() {
  let sheet = sheet_(SHEETS.ASSETS);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.ASSETS);
    sheet.appendRow(ASSET_HEADERS);
  }
  return sheet;
}

function getAssets() {
  const sheet = sheet_(SHEETS.ASSETS);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, assets: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ASSET_HEADERS.length).getValues();
  const data = rows.filter(function (r) { return String(r[0]).trim(); }).map(function (row) {
    return {
      id: String(row[0]), stationCode: stationCode_(row[1]), stationName: row[2], name: row[3],
      unit: row[4] || '', supplier: row[5] || '', location: row[6] || '', status: row[7],
      statusDate: toDateStr_(row[8]), quantity: Number(row[9]), note: row[10], photoUrl: row[11], lastUpdatedBy: row[12]
    };
  });
  return { success: true, assets: data };
}

function assetRow_(id, a, photoUrl, email) {
  const code = stationCode_(a.stationCode);
  return [id, code, a.stationName || stationName_(code), a.name || '', a.unit || '', a.supplier || '', a.location || '',
    a.status || '', toDateStr_(a.statusDate), a.quantity, a.note || '', photoUrl, email];
}

function saveAsset_(assetData, fileData, s) {
  assetData = assetData || {};
  if (!canAccessStation_(s, assetData.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '無權限操作此場站的財產' };
  const sheet = assetsSheet_();
  let photoUrl = assetData.photoUrl || '';
  if (fileData) {
    const up = saveFileToDrive(fileData, 'Asset_' + (assetData.name || 'item'));
    if (up) photoUrl = up;
  }
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  if (assetData.id) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(assetData.id)) { rowIndex = i + 1; break; }
    }
  }
  const id = assetData.id || ('AST-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd') + '-' + Math.floor(Math.random() * 1000));
  const newRow = assetRow_(id, assetData, photoUrl, s.email);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, newRow.length).setValues([newRow]);
  else sheet.appendRow(newRow);
  writeLog('財產異動', id, '名稱: ' + assetData.name + ', 狀態: ' + assetData.status, s.email);
  return { success: true, id: id };
}

function saveAssetsBatch_(items, s) {
  items = Array.isArray(items) ? items : [];
  const sheet = assetsSheet_();
  const rowsToAdd = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i].asset || {};
    if (!canAccessStation_(s, a.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '無權限新增 ' + stationName_(stationCode_(a.stationCode)) + ' 的財產' };
    let photoUrl = '';
    const fileData = items[i].files || items[i].file;
    if (fileData) photoUrl = saveFileToDrive(fileData, 'Asset_' + (a.name || 'item'));
    rowsToAdd.push(assetRow_(Utilities.getUuid(), a, photoUrl, s.email));
  }
  if (rowsToAdd.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, rowsToAdd[0].length).setValues(rowsToAdd);
    writeLog('批次新增財產', '', '共新增 ' + rowsToAdd.length + ' 筆資料', s.email);
  }
  return { success: true };
}

function updateAsset_(assetData, fileData, s) {
  assetData = assetData || {};
  const sheet = sheet_(SHEETS.ASSETS);
  if (!sheet) return { success: false, msg: '找不到財產清單工作表' };
  const values = sheet.getDataRange().getValues();
  let targetRow = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(assetData.id)) { targetRow = i + 1; break; }
  }
  if (targetRow === -1) return { success: false, msg: '找不到該筆財產資料' };
  const existing = values[targetRow - 1];
  if (!canAccessStation_(s, existing[1]) || !canAccessStation_(s, assetData.stationCode || existing[1])) {
    return { success: false, code: 'FORBIDDEN', msg: '無權限操作此場站的財產' };
  }
  let photoUrl = assetData.photoUrl || existing[11] || '';
  if (fileData) {
    const up = saveFileToDrive(fileData, 'Asset_' + (assetData.name || 'item'));
    if (up) photoUrl = up;
  }
  const row = assetRow_(existing[0], {
    stationCode: assetData.stationCode || existing[1],
    stationName: assetData.stationName,
    name: assetData.name, unit: assetData.unit, supplier: assetData.supplier, location: assetData.location,
    status: assetData.status, statusDate: assetData.statusDate, quantity: assetData.quantity, note: assetData.note
  }, photoUrl, s.email);
  sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
  writeLog('編輯財產', assetData.id, '更新名稱: ' + assetData.name + ', 狀態: ' + assetData.status, s.email);
  return { success: true, msg: '更新成功' };
}

function deleteAsset_(id, s) {
  const sheet = sheet_(SHEETS.ASSETS);
  if (!sheet) return { success: false, msg: '找不到資料表' };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      if (!canAccessStation_(s, data[i][1])) return { success: false, code: 'FORBIDDEN', msg: '無權限刪除此場站的財產' };
      sheet.deleteRow(i + 1);
      writeLog('刪除財產', id, '移除財產紀錄：' + data[i][3], s.email);
      return { success: true };
    }
  }
  return { success: false, msg: '找不到該財產 ID' };
}

function getAssetCheckRecords() {
  const sheet = sheet_(SHEETS.ASSET_CHECKS);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, records: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  const records = rows.map(function (row) {
    return {
      id: row[0], assetId: row[1], assetName: row[2], stationCode: stationCode_(row[3]),
      checkDate: toDateStr_(row[4]), status: row[5], quantity: row[6], photoUrl: row[7], note: row[8],
      checkedBy: row[9], checkedAt: toIso_(row[10])
    };
  });
  return { success: true, records: records };
}

function submitAssetCheck_(data, fileData, s) {
  data = data || {};
  if (!canAccessStation_(s, data.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '無權限操作此場站' };
  let sheet = sheet_(SHEETS.ASSET_CHECKS);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.ASSET_CHECKS);
    sheet.appendRow(['ID', '資產ID', '資產名稱', '場站代碼', '檢核日期', '狀態', '盤點數量', '照片連結', '備註', '檢核人', '提交時間']);
  }
  const photoUrl = fileData ? saveFileToDrive(fileData, 'AssetCheck_' + data.assetId) : '';
  const id = 'CHK-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMddHHmm') + '-' + Math.floor(Math.random() * 100);
  sheet.appendRow([id, data.assetId, data.assetName, stationCode_(data.stationCode), toDateStr_(data.checkDate), data.status, data.quantity, photoUrl, data.note || '', s.email, new Date()]);
  writeLog('財產檢核', data.assetId, data.assetName + '：' + data.status, s.email);
  return { success: true };
}

function getAssetCheckBatches() {
  const sheet = sheet_(SHEETS.ASSET_BATCHES);
  if (!sheet || sheet.getLastRow() < 2) return { success: true, batches: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues();
  const batches = rows.map(function (row) {
    let results = [];
    try { results = JSON.parse(row[8] || '[]'); } catch (e) { results = []; }
    return {
      id: row[0], stationCode: stationCode_(row[1]), stationName: row[2], year: row[3], period: row[4],
      checkDate: toDateStr_(row[5]), submittedBy: row[6], submittedAt: toIso_(row[7]), results: results
    };
  });
  return { success: true, batches: batches };
}

function saveAssetCheckBatch_(batchData, files, s) {
  batchData = batchData || {};
  if (!canAccessStation_(s, batchData.stationCode)) return { success: false, code: 'FORBIDDEN', msg: '無權限操作此場站' };
  let sheet = sheet_(SHEETS.ASSET_BATCHES);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.ASSET_BATCHES);
    sheet.appendRow(['ID', '場站代碼', '場站名稱', '年度', '期別', '檢核日期', '提交人', '提交時間', '結果JSON']);
  }
  const photoUrls = {};
  if (files) {
    Object.keys(files).forEach(function (assetId) {
      const url = saveFileToDrive(files[assetId], 'Batch_' + assetId);
      if (url) photoUrls[assetId] = url;
    });
  }
  const finalResults = (batchData.results || []).map(function (r) {
    const o = {};
    Object.keys(r).forEach(function (k) { o[k] = r[k]; });
    o.photoUrl = photoUrls[r.assetId] || r.photoUrl || '';
    return o;
  });
  const id = 'BAT-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd') + '-' + Math.floor(Math.random() * 1000);
  sheet.appendRow([id, stationCode_(batchData.stationCode), batchData.stationName, batchData.year, batchData.period,
    toDateStr_(batchData.checkDate), s.email, new Date(), JSON.stringify(finalResults)]);
  writeLog('批次財產檢核', id, '場站: ' + batchData.stationName + ', 期別: ' + batchData.period, s.email);
  return { success: true };
}

// ==========================================
// 9. 檔案上傳
// ==========================================

/** 上傳一個或多個檔案（base64），回傳以換行分隔的檔案網址 */
function saveFileToDrive(fileOrFiles, prefix) {
  if (!fileOrFiles) return '';
  const fileList = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  if (!fileList.length) return '';
  let folder = null;
  // 指令碼屬性 UPLOAD_FOLDER_ID 可覆寫上傳資料夾（測試環境用）
  const folderId = props_().getProperty('UPLOAD_FOLDER_ID') || UPLOAD_FOLDER_ID;
  try { folder = DriveApp.getFolderById(folderId); } catch (e) { folder = null; }
  if (!folder) {
    const iter = DriveApp.getFoldersByName(DEFAULT_FOLDER_NAME);
    folder = iter.hasNext() ? iter.next() : DriveApp.createFolder(DEFAULT_FOLDER_NAME);
  }
  const urls = [];
  fileList.forEach(function (fileObj, i) {
    if (!fileObj || !fileObj.content) return;
    try {
      const base64Data = fileObj.content.indexOf(',') >= 0 ? fileObj.content.split(',')[1] : fileObj.content;
      const bytes = Utilities.base64Decode(base64Data);
      const fileName = String(fileObj.name || ('file_' + (i + 1))).replace(/[\\\/:*?"<>|]/g, '_');
      const blob = Utilities.newBlob(bytes, fileObj.type || 'application/octet-stream', prefix + '_' + new Date().getTime() + '_' + fileName);
      const file = folder.createFile(blob);
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) { /* Workspace 網域限制外部共用時略過 */ }
      const url = file.getUrl();
      if (url) urls.push(url);
    } catch (e) {
      Logger.log('上傳檔案失敗: ' + e.toString());
    }
  });
  return urls.join('\n');
}

// ==========================================
// 10. 排程：逾期、到期提醒、每週總表
// ==========================================

/** 每日 00:10：把期限已過的「待處理 / 執行中」寫回為「逾期」 */
function dailyMaintenance() {
  const n = markOverdueTasks_();
  if (n > 0) writeLog('系統排程', '', '自動標記逾期 ' + n + ' 筆', 'SYSTEM');
  return n;
}

function markOverdueTasks_() {
  const sh = tasksSheet_();
  if (!sh || sh.getLastRow() < 2) return 0;
  const n = sh.getLastRow() - 1;
  const deadlines = sh.getRange(2, TC.DEADLINE + 1, n, 1).getValues();
  const statusRange = sh.getRange(2, TC.STATUS + 1, n, 1);
  const statuses = statusRange.getValues();
  const uids = sh.getRange(2, 1, n, 1).getValues();
  const today = todayStr_();
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (!String(uids[i][0]).trim()) continue;
    const st = String(statuses[i][0]).trim() || STATUS.PENDING;
    const d = toDateStr_(deadlines[i][0]);
    if ((st === STATUS.PENDING || st === STATUS.IN_PROGRESS) && isValidDateStr_(d) && d < today) {
      statuses[i][0] = STATUS.OVERDUE;
      changed++;
    }
  }
  if (changed > 0) statusRange.setValues(statuses);
  return changed;
}

/** 場站的「業者帳號」；履約管理團隊的工項由三維團隊負責 */
function stationContacts_(code, activeUsers) {
  if (code === 'CONTRACT_TEAM') return activeUsers.filter(function (u) { return u.role === ROLE.MANAGER_3D; });
  return activeUsers.filter(function (u) {
    return u.role === ROLE.OPERATOR && (u.assignedStation === 'ALL' || u.assignedStation.split(',').indexOf(code) >= 0);
  });
}

/** 期限前 7 天、3 天、當天，以及逾期第 1 天起每 7 天提醒一次 */
function reminderStage_(daysLeft) {
  if (daysLeft === 7) return '7 天後到期';
  if (daysLeft === 3) return '3 天後到期';
  if (daysLeft === 0) return '今天到期';
  if (daysLeft < 0 && ((-daysLeft) % 7) === 1) return '已逾期 ' + (-daysLeft) + ' 天';
  return null;
}

function buildReminderList_() {
  const today = todayStr_();
  const users = readUsers_().filter(function (u) { return u.isActive; });
  const byEmail = {};
  users.forEach(function (u) { byEmail[u.emailKey] = u; });
  const buckets = {};
  readTasks_().rows.forEach(function (r) {
    const t = r.task;
    if (ACTIONABLE_STATUSES.indexOf(t.status) < 0 || !isValidDateStr_(t.deadline)) return;
    const daysLeft = daysBetween_(today, t.deadline);
    const stage = reminderStage_(daysLeft);
    if (!stage) return;
    const recips = {};
    const ex = byEmail[String(t.executorEmail).toLowerCase()];
    if (ex) recips[ex.emailKey] = ex;
    stationContacts_(t.stationCode, users).forEach(function (u) { recips[u.emailKey] = u; });
    Object.keys(recips).forEach(function (k) {
      if (!buckets[k]) buckets[k] = { user: recips[k], items: [] };
      buckets[k].items.push({ task: t, stage: stage, daysLeft: daysLeft });
    });
  });
  return buckets;
}

function reminderEmailHtml_(user, items) {
  items.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
  const rows = items.map(function (it) {
    const t = it.task;
    const color = it.daysLeft < 0 ? '#b91c1c' : (it.daysLeft === 0 ? '#c2410c' : '#1f2937');
    return '<tr><td style="color:' + color + ';font-weight:bold">' + htmlEscape_(it.stage) + '</td><td>' + htmlEscape_(t.stationName) +
      '</td><td>' + htmlEscape_(t.itemName) + (t.taskType === TASK_TYPE.DEFECT ? ' <span style="color:#b91c1c">[缺失改善]</span>' : '') +
      '</td><td>' + htmlEscape_(t.deadline) + '</td><td>' + htmlEscape_(t.status) + '</td></tr>';
  }).join('');
  return '<p>' + htmlEscape_(user.name || user.email) + ' 您好：</p>' +
    '<p>以下工項即將到期或已逾期，請於期限內完成並上傳佐證資料、提送審查。</p>' +
    '<table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">' +
    '<tr style="background:#dbeafe"><th>提醒</th><th>場站</th><th>工項</th><th>截止日期</th><th>目前狀態</th></tr>' + rows + '</table>' +
    '<p><a href="' + htmlEscape_(systemUrl_()) + '">登入基隆市停車場履約管理系統</a></p>' +
    '<p style="color:#6b7280;font-size:12px">此信由系統自動寄送，請勿直接回覆。</p>';
}

/** 每日 08:30：到期提醒信（每人每天最多一封彙整信） */
function dailyReminders() {
  return runDailyReminders_(false);
}

/** 手動測試用：只在執行記錄列出會寄給誰，不實際寄信 */
function previewDailyReminders() {
  return runDailyReminders_(true);
}

function runDailyReminders_(dryRun) {
  if (!dryRun && !emailsEnabled_()) { Logger.log('REMINDERS_ENABLED=false，略過寄信'); return 0; }
  const buckets = buildReminderList_();
  let sent = 0;
  let items = 0;
  Object.keys(buckets).forEach(function (k) {
    const b = buckets[k];
    items += b.items.length;
    const subject = '【履約管理系統】工項到期提醒（' + b.items.length + ' 項）';
    if (dryRun) {
      Logger.log(b.user.email + '：' + b.items.map(function (it) { return it.stage + ' ' + it.task.itemName; }).join('；'));
      return;
    }
    if (MailApp.getRemainingDailyQuota() < 1) { Logger.log('Email 配額不足，停止寄送'); return; }
    try {
      MailApp.sendEmail({ to: b.user.email, subject: subject, htmlBody: reminderEmailHtml_(b.user, b.items), name: '基隆市停車場履約管理系統' });
      sent++;
    } catch (e) { Logger.log('寄送失敗 ' + b.user.email + ': ' + e); }
  });
  if (!dryRun && sent > 0) writeLog('提醒信寄送', '', '寄出 ' + sent + ' 封，共 ' + items + ' 筆提醒', 'SYSTEM');
  Logger.log((dryRun ? '[預覽] ' : '') + '收件人 ' + Object.keys(buckets).length + ' 位，提醒 ' + items + ' 筆');
  return sent;
}

function buildWeeklySummary_() {
  const today = todayStr_();
  const tasks = readTasks_().rows.map(function (r) { return r.task; });
  const stats = STATIONS.map(function (st) {
    const list = tasks.filter(function (t) { return t.stationCode === st.code; });
    const open = list.filter(function (t) { return t.status !== STATUS.COMPLETED; });
    return {
      name: st.name,
      open: open.length,
      overdue: open.filter(function (t) { return t.status === STATUS.OVERDUE || (ACTIONABLE_STATUSES.indexOf(t.status) >= 0 && t.deadline && t.deadline < today); }).length,
      review: list.filter(function (t) { return t.status === STATUS.UNDER_REVIEW; }).length,
      returned: list.filter(function (t) { return t.status === STATUS.RETURNED; }).length,
      dueSoon: open.filter(function (t) { const d = daysBetween_(today, t.deadline); return d >= 0 && d <= 14 && t.status !== STATUS.UNDER_REVIEW; }).length,
      defects: open.filter(function (t) { return t.taskType === TASK_TYPE.DEFECT; }).length
    };
  });
  const overdue = tasks.filter(function (t) { return ACTIONABLE_STATUSES.indexOf(t.status) >= 0 && t.deadline && t.deadline < today; })
    .sort(function (a, b) { return a.deadline < b.deadline ? -1 : 1; });
  const review = tasks.filter(function (t) { return t.status === STATUS.UNDER_REVIEW; })
    .sort(function (a, b) { return a.submittedAt < b.submittedAt ? -1 : 1; });
  const dueSoon = tasks.filter(function (t) {
    if (ACTIONABLE_STATUSES.indexOf(t.status) < 0) return false;
    const d = daysBetween_(today, t.deadline);
    return d >= 0 && d <= 14;
  }).sort(function (a, b) { return a.deadline < b.deadline ? -1 : 1; });
  return { today: today, stats: stats, overdue: overdue, review: review, dueSoon: dueSoon };
}

function weeklySummaryHtml_(sum) {
  const th = function (cols) { return '<tr style="background:#dbeafe">' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>'; };
  const table = function (head, body) { return '<table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px">' + head + body + '</table>'; };
  const taskRows = function (list, extra) {
    if (!list.length) return '<tr><td colspan="5" style="color:#6b7280">（無）</td></tr>';
    return list.map(function (t) {
      return '<tr><td>' + htmlEscape_(t.stationName) + '</td><td>' + htmlEscape_(t.itemName) + '</td><td>' + htmlEscape_(t.deadline) +
        '</td><td>' + htmlEscape_(t.status) + '</td><td>' + htmlEscape_(extra(t)) + '</td></tr>';
    }).join('');
  };
  const statRows = sum.stats.map(function (s) {
    return '<tr><td>' + htmlEscape_(s.name) + '</td><td align="right">' + s.open + '</td><td align="right" style="color:' + (s.overdue ? '#b91c1c' : 'inherit') + '">' + s.overdue +
      '</td><td align="right">' + s.review + '</td><td align="right">' + s.returned + '</td><td align="right">' + s.dueSoon + '</td><td align="right">' + s.defects + '</td></tr>';
  }).join('');
  return '<h3>履約管理週報（' + sum.today + '）</h3>' +
    '<h4>一、各場站概況</h4>' + table(th(['場站', '未結案', '逾期', '待審查', '退回補正', '14 日內到期', '未結缺失']), statRows) +
    '<h4>二、待審查（' + sum.review.length + '）</h4>' + table(th(['場站', '工項', '截止日期', '狀態', '提送時間']), taskRows(sum.review, function (t) { return t.submittedAt ? Utilities.formatDate(new Date(t.submittedAt), TZ, 'yyyy-MM-dd HH:mm') : ''; })) +
    '<h4>三、逾期未完成（' + sum.overdue.length + '）</h4>' + table(th(['場站', '工項', '截止日期', '狀態', '逾期天數']), taskRows(sum.overdue, function (t) { return String(daysBetween_(t.deadline, sum.today)); })) +
    '<h4>四、14 日內到期（' + sum.dueSoon.length + '）</h4>' + table(th(['場站', '工項', '截止日期', '狀態', '剩餘天數']), taskRows(sum.dueSoon, function (t) { return String(daysBetween_(sum.today, t.deadline)); })) +
    '<p><a href="' + htmlEscape_(systemUrl_()) + '">登入系統</a></p>';
}

/** 每週一 08:30：寄總表給三維團隊（含系統管理員） */
function weeklySummary() {
  if (!emailsEnabled_()) return 0;
  const recipients = readUsers_().filter(function (u) { return u.isActive && (u.role === ROLE.MANAGER_3D || u.role === ROLE.ADMIN); })
    .map(function (u) { return u.email; });
  if (!recipients.length) return 0;
  const sum = buildWeeklySummary_();
  MailApp.sendEmail({
    to: recipients.join(','),
    subject: '【履約管理系統】週報 ' + sum.today + '（逾期 ' + sum.overdue.length + '、待審查 ' + sum.review.length + '）',
    htmlBody: weeklySummaryHtml_(sum),
    name: '基隆市停車場履約管理系統'
  });
  writeLog('週報寄送', '', '寄給 ' + recipients.length + ' 位', 'SYSTEM');
  return recipients.length;
}

/** 既有的自動備份（若已有觸發器會繼續運作） */
function autoBackupSheet() {
  const file = DriveApp.getFileById(ss_().getId());
  file.makeCopy(file.getName() + '_副本_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
}
