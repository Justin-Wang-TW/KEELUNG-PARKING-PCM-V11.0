import { Task, TaskStatus, TaskType, User, UserRole, StationCode } from './types';

/** 今天（使用者電腦時區）的 yyyy-MM-dd */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** 統一顯示 yyyy-MM-dd（後端 V11 已回傳此格式；保留對舊格式的相容） */
export function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${formatDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 距離截止日剩幾天（負數代表已逾期） */
export function daysUntil(deadline?: string): number {
  const d = formatDate(deadline);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return NaN;
  const [y, m, dd] = d.split('-').map(Number);
  const [ty, tm, td] = todayStr().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

/** 仍需業者處理的狀態 */
export const ACTIONABLE_STATUSES: TaskStatus[] = [TaskStatus.PENDING, TaskStatus.IN_PROGRESS, TaskStatus.OVERDUE, TaskStatus.RETURNED];

/**
 * 畫面上顯示的狀態：
 *  - 已完成 / 審核中 / 退回補正 照原狀態顯示
 *  - 待處理、執行中 若已過截止日 → 逾期
 */
export function getDisplayStatus(task: Task): TaskStatus {
  const s = task.status as TaskStatus;
  if (s === TaskStatus.COMPLETED || s === TaskStatus.UNDER_REVIEW || s === TaskStatus.RETURNED || s === TaskStatus.OVERDUE) return s;
  const left = daysUntil(task.deadline);
  if (!isNaN(left) && left < 0) return TaskStatus.OVERDUE;
  return s || TaskStatus.PENDING;
}

export function isOverdue(task: Task): boolean {
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.UNDER_REVIEW) return false;
  const left = daysUntil(task.deadline);
  return !isNaN(left) && left < 0;
}

/** 排序優先順序（數字小的排前面） */
export const STATUS_PRIORITY: Record<TaskStatus, number> = {
  [TaskStatus.OVERDUE]: 1,
  [TaskStatus.RETURNED]: 2,
  [TaskStatus.IN_PROGRESS]: 3,
  [TaskStatus.PENDING]: 4,
  [TaskStatus.UNDER_REVIEW]: 5,
  [TaskStatus.COMPLETED]: 6,
};

export const STATUS_DOT: Record<TaskStatus, string> = {
  [TaskStatus.PENDING]: 'bg-gray-400',
  [TaskStatus.IN_PROGRESS]: 'bg-blue-500',
  [TaskStatus.UNDER_REVIEW]: 'bg-amber-500',
  [TaskStatus.RETURNED]: 'bg-purple-500',
  [TaskStatus.COMPLETED]: 'bg-green-500',
  [TaskStatus.OVERDUE]: 'bg-red-500',
};

export const isReviewer = (user: User | null) => !!user && (user.role === UserRole.ADMIN || user.role === UserRole.MANAGER_3D);
export const canManageTasks = (user: User | null) => !!user && [UserRole.ADMIN, UserRole.MANAGER_3D, UserRole.MANAGER_DEPT].includes(user.role);
export const canViewReports = canManageTasks;

export function canAccessStation(user: User, code: string): boolean {
  if (user.role === UserRole.OPERATOR && code === StationCode.CONTRACT_TEAM) return false;
  const assigned = user.assignedStation ? user.assignedStation.split(',') : [];
  return assigned.includes('ALL') || assigned.includes(code);
}

export const isDefect = (task: Task) => task.taskType === TaskType.DEFECT;

/** 進度匯報時可選擇的狀態 */
export function selectableStatuses(user: User | null, task: Task): { value: TaskStatus; label: string }[] {
  if (isReviewer(user)) {
    return [
      { value: TaskStatus.PENDING, label: TaskStatus.PENDING },
      { value: TaskStatus.IN_PROGRESS, label: TaskStatus.IN_PROGRESS },
      { value: TaskStatus.COMPLETED, label: '已完成（直接結案）' },
    ];
  }
  const opts = [
    { value: TaskStatus.IN_PROGRESS, label: TaskStatus.IN_PROGRESS },
    { value: TaskStatus.UNDER_REVIEW, label: '提送審查（審核中）' },
  ];
  if (task.status === TaskStatus.PENDING || task.status === TaskStatus.OVERDUE) {
    opts.unshift({ value: task.status as TaskStatus, label: task.status as string });
  }
  return opts;
}

/** 打開進度匯報視窗時的預設狀態 */
export function defaultSelectedStatus(user: User | null, task: Task): TaskStatus {
  const options = selectableStatuses(user, task).map(o => o.value);
  if (options.includes(task.status as TaskStatus)) return task.status as TaskStatus;
  if (task.status === TaskStatus.RETURNED) return TaskStatus.UNDER_REVIEW;
  return options[0];
}
