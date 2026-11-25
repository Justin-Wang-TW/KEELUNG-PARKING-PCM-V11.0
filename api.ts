import { APP_CONFIG } from './constants';
import { fetchJsonSafe } from './utils';
import { User } from './types';

/**
 * 後端 API 呼叫集中於此：
 *  - 一律使用 POST，Session Token 放在 body，不出現在網址
 *  - Token 存在 sessionStorage（關閉分頁即失效）
 *  - 後端回傳 AUTH_EXPIRED 時廣播事件，由 App 統一登出
 */

const SESSION_KEY = 'pcmSession';
export const SESSION_EXPIRED_EVENT = 'pcm:session-expired';

interface StoredSession {
  token: string;
  user: User;
}

let currentToken: string | null = null;

export function saveSession(token: string, user: User) {
  currentToken = token;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, user } as StoredSession));
  // 清掉舊版（V10 以前）把密碼雜湊存在 sessionStorage 的資料
  sessionStorage.removeItem('currentUser');
}

export function updateStoredUser(user: User) {
  if (!currentToken) return;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: currentToken, user } as StoredSession));
}

export function loadSession(): StoredSession | null {
  sessionStorage.removeItem('currentUser');
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StoredSession;
    if (!s.token || !s.user) return null;
    currentToken = s.token;
    return s;
  } catch {
    return null;
  }
}

export function clearSession() {
  currentToken = null;
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem('currentUser');
}

export interface ApiResult<T = any> {
  ok: boolean;          // 後端 success === true
  data?: T;             // 後端完整回應
  error?: string;       // 給使用者看的錯誤訊息
  code?: string;        // AUTH_EXPIRED / FORBIDDEN / BUSY ...
}

export async function api<T = any>(action: string, payload: Record<string, any> = {}): Promise<ApiResult<T>> {
  const { ok, data, error } = await fetchJsonSafe<any>(APP_CONFIG.SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, action, token: currentToken || undefined })
  });
  if (!ok || !data) return { ok: false, error: error || '連線失敗，請檢查網路' };
  if (data.code === 'AUTH_EXPIRED') {
    if (currentToken) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    return { ok: false, data, code: data.code, error: data.msg || '登入已逾時，請重新登入' };
  }
  if (!data.success) return { ok: false, data, code: data.code, error: data.msg || '操作失敗' };
  return { ok: true, data };
}

export type FilePayload = { name: string; type: string; content: string };

export function fileToPayload(file: File): Promise<FilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve({ name: file.name, type: file.type, content: reader.result as string });
    reader.onerror = err => reject(err);
  });
}
