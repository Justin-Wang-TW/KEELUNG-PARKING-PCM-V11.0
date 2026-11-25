import React, { useState, useEffect, useCallback } from 'react';
import { User, Task, AuditLog, UserRole, Meeting, Contact, TaskStatus, ChecklistItem, ChecklistSubmission, Asset, AssetCheckRecord, AssetCheckBatch, Message, EmailTemplate, RecurrenceType, ReviewDecision } from './types';
import { STATIONS, APP_CONFIG } from './constants';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import TaskList from './components/TaskList';
import CalendarView from './components/CalendarView';
import AdminPanel from './components/AdminPanel';
import Login from './components/Login';
import ChangePasswordModal from './components/ChangePasswordModal';
import MeetingRecords from './components/MeetingRecords';
import EditTaskModal from './components/EditTaskModal';
import ModifyTaskModal from './components/ModifyTaskModal';
import TaskDetailModal from './components/TaskDetailModal';
import DueSoonModal from './components/DueSoonModal';
import ChecklistDashboard from './components/ChecklistDashboard';
import AssetManagement from './components/AssetManagement';
import MessageCenter from './components/MessageCenter';
import MonthlyReport from './components/MonthlyReport';
import { sha256 } from './utils';
import { api, saveSession, loadSession, clearSession, updateStoredUser, SESSION_EXPIRED_EVENT, FilePayload } from './api';
import { canAccessStation, canViewReports, daysUntil, isReviewer } from './taskStatus';
import ErrorBoundary from './components/ErrorBoundary';
import { DeleteRecurrenceMode } from './components/DeleteRecurrenceModal';
import './index.css';

import SessionTimeoutModal from './components/SessionTimeoutModal';

const DEFAULT_EMAIL_TEMPLATE: EmailTemplate = {
  subject: '歡迎加入基隆市停車場履約管理系統',
  body: `親愛的 {{name}} 您好，\n\n您的帳號已核准啟用。\n\n登入帳號：{{email}}\n預設密碼：{{password}}\n\n請點擊下方連結登入系統，並於首次登入後修改密碼：\n${APP_CONFIG.SYSTEM_URL}\n\n祝您工作順利！`
};

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isHighContrast, setIsHighContrast] = useState(false);

  // --- 閒置登出邏輯 ---
  const IDLE_TIMEOUT = 1500; // 25分鐘 = 1500秒
  const [timeLeft, setTimeLeft] = useState(IDLE_TIMEOUT);
  const lastActiveRef = React.useRef<number>(Date.now());

  useEffect(() => {
    if (isHighContrast) document.body.classList.add('high-contrast');
    else document.body.classList.remove('high-contrast');
  }, [isHighContrast]);

  const toggleHighContrast = () => setIsHighContrast(prev => !prev);

  // 監聽使用者活動
  useEffect(() => {
    const handleActivity = () => { lastActiveRef.current = Date.now(); };
    if (currentUser) {
      ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev => window.addEventListener(ev, handleActivity));
    }
    return () => {
      ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev => window.removeEventListener(ev, handleActivity));
    };
  }, [currentUser]);

  const handleLogout = useCallback((notifyServer: boolean = true) => {
    if (notifyServer) api('logout').catch(() => undefined);
    clearSession();
    setCurrentUser(null);
    setTimeLeft(IDLE_TIMEOUT);
  }, []);

  // 閒置倒數
  useEffect(() => {
    if (!currentUser) return;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastActiveRef.current) / 1000);
      const remaining = IDLE_TIMEOUT - elapsed;
      setTimeLeft(remaining);
      if (remaining <= 0) handleLogout();
    }, 1000);
    return () => clearInterval(interval);
  }, [currentUser, handleLogout]);

  // 後端回報 Session 過期 → 登出
  useEffect(() => {
    const onExpired = () => {
      if (sessionStorage.getItem('pcmSession')) alert('登入已逾時或權限已變更，請重新登入。');
      handleLogout(false);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [handleLogout]);

  // 初始化：恢復 Session
  useEffect(() => {
    const stored = loadSession();
    if (stored) setCurrentUser(stored.user);
  }, []);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetCheckRecords, setAssetCheckRecords] = useState<AssetCheckRecord[]>([]);
  const [assetCheckBatches, setAssetCheckBatches] = useState<AssetCheckBatch[]>([]);
  const [emailTemplate, setEmailTemplate] = useState<EmailTemplate>(DEFAULT_EMAIL_TEMPLATE);

  const [checklistTemplate, setChecklistTemplate] = useState<ChecklistItem[]>([]);
  const [checklistSubmissions, setChecklistSubmissions] = useState<ChecklistSubmission[]>([]);
  const [isChangePwdOpen, setIsChangePwdOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [modifyingTask, setModifyingTask] = useState<Task | null>(null);
  const [viewingTask, setViewingTask] = useState<Task | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [isMessageCenterOpen, setIsMessageCenterOpen] = useState(false);

  const [dueSoonTasks, setDueSoonTasks] = useState<Task[]>([]);
  const [isDueSoonModalOpen, setIsDueSoonModalOpen] = useState(false);
  const [hasShownWarning, setHasShownWarning] = useState(false);

  const isAdmin = (user: User | null) => !!user && user.role === UserRole.ADMIN;
  const canAccessAdminPanel = (user: User | null) => isReviewer(user);

  // --- 資料抓取 ---

  const fetchUsers = async () => {
    const { ok, data } = await api('getUsers');
    if (ok && Array.isArray(data?.users)) setUsers(data.users);
  };

  const fetchTasks = async () => {
    const { ok, data } = await api('getTasks');
    setTasks(ok && Array.isArray(data?.tasks) ? data.tasks : []);
  };

  const fetchMeetings = async () => {
    const { ok, data } = await api('getMeetings');
    setMeetings(ok && Array.isArray(data?.data) ? data.data : []);
  };

  const fetchLogs = async () => {
    const { ok, data } = await api('getLogs');
    setLogs(ok && Array.isArray(data?.logs) ? data.logs : []);
  };

  const fetchContacts = async () => {
    const { ok, data } = await api('getContacts');
    setContacts(ok && Array.isArray(data?.data) ? data.data : []);
  };

  const fetchAssets = async () => {
    const [assetsRes, recordsRes, batchesRes] = await Promise.all([
      api('getAssets'), api('getAssetCheckRecords'), api('getAssetCheckBatches')
    ]);
    setAssets(assetsRes.ok && Array.isArray(assetsRes.data?.assets) ? assetsRes.data.assets : []);
    setAssetCheckRecords(recordsRes.ok && Array.isArray(recordsRes.data?.records) ? recordsRes.data.records : []);
    setAssetCheckBatches(batchesRes.ok && Array.isArray(batchesRes.data?.batches) ? batchesRes.data.batches : []);
  };

  const fetchEmailTemplate = async () => {
    if (!canAccessAdminPanel(currentUser)) return;
    const { ok, data } = await api('getEmailTemplate');
    if (ok && data?.data) setEmailTemplate(data.data);
  };

  const fetchMessages = async () => {
    const { ok, data } = await api('getMessages');
    if (ok && Array.isArray(data?.messages)) setMessages(data.messages);
  };

  const fetchChecklistData = async () => {
    const [subRes, tmplRes] = await Promise.all([api('getChecklistSubmissions'), api('getChecklistTemplate')]);
    if (subRes.ok && Array.isArray(subRes.data?.data)) {
      setChecklistSubmissions(subRes.data.data.map((item: any) => ({
        ...item,
        stationName: item.stationName || STATIONS.find(s => s.code === item.stationCode)?.name || item.stationCode
      })));
    }
    if (tmplRes.ok && Array.isArray(tmplRes.data?.data)) setChecklistTemplate(tmplRes.data.data);
  };

  // 登入後載入使用者清單（訊息中心、後台使用）
  useEffect(() => {
    if (currentUser) fetchUsers();
  }, [currentUser?.email]);

  // 依分頁載入資料
  useEffect(() => {
    if (!currentUser) return;
    if (activeTab === 'meetings') fetchMeetings();
    if (activeTab === 'venue_check') { fetchChecklistData(); fetchTasks(); }
    if (activeTab === 'assets') fetchAssets();
    if (activeTab === 'report') { fetchTasks(); fetchChecklistData(); }
    if (activeTab === 'admin' && canAccessAdminPanel(currentUser)) {
      fetchLogs();
      fetchContacts();
      fetchEmailTemplate();
      fetchUsers();
      fetchTasks();
    }
    if (['dashboard', 'progress_report', 'calendar'].includes(activeTab)) fetchTasks();
  }, [activeTab, currentUser?.email]);

  // 強制修改密碼
  useEffect(() => {
    if (currentUser?.forceChangePassword) setIsChangePwdOpen(true);
  }, [currentUser]);

  // 登入後：7 天內到期 / 已逾期 / 被退回 的工項提醒
  useEffect(() => {
    if (currentUser && tasks.length > 0 && !hasShownWarning) {
      const warningTasks = tasks.filter(task => {
        if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.UNDER_REVIEW) return false;
        if (!canAccessStation(currentUser, task.stationCode)) return false;
        const left = daysUntil(task.deadline);
        return task.status === TaskStatus.RETURNED || (!isNaN(left) && left <= 7);
      });
      if (warningTasks.length > 0) {
        setDueSoonTasks(warningTasks);
        setIsDueSoonModalOpen(true);
      }
      setHasShownWarning(true);
    }
  }, [tasks, currentUser, hasShownWarning]);

  // 訊息輪詢
  useEffect(() => {
    if (!currentUser) return;
    fetchMessages();
    const interval = setInterval(fetchMessages, 60000);
    return () => clearInterval(interval);
  }, [currentUser?.email]);

  // --- 財產 ---

  const handleSaveBatchAssets = async (items: { asset: Partial<Asset>, file?: FilePayload, files?: FilePayload[] }[]) => {
    const { ok, error } = await api('saveAssetsBatch', { items });
    if (ok) { alert('批量新增財產成功'); fetchAssets(); }
    else alert('批量新增失敗: ' + error);
  };

  const handleEditAsset = async (asset: Partial<Asset>, file?: FilePayload, files?: FilePayload[]) => {
    const { ok, error } = await api('updateAsset', { data: asset, files: files || (file ? [file] : undefined) });
    if (ok) { alert('財產資料更新成功'); fetchAssets(); }
    else alert('更新失敗: ' + error);
  };

  const handleSubmitAssetCheck = async (record: Partial<AssetCheckRecord>, file?: FilePayload, files?: FilePayload[]) => {
    const { ok, error } = await api('submitAssetCheck', { data: record, files: files || (file ? [file] : undefined) });
    if (ok) { alert('檢核紀錄已提交' + ((files && files.length > 0) || file ? ' (含照片)' : '')); fetchAssets(); }
    else alert('提交失敗: ' + error);
  };

  const handleSaveAssetCheckBatch = async (batch: Partial<AssetCheckBatch>, files?: { [key: string]: FilePayload | FilePayload[] }) => {
    const { ok, error } = await api('saveAssetCheckBatch', { data: batch, files });
    if (ok) { alert('財產檢核批次已提交'); fetchAssets(); }
    else alert('提交失敗: ' + error);
  };

  const handleDeleteAsset = async (id: string) => {
    const { ok, error } = await api('deleteAsset', { id });
    if (ok) { alert('財產資料已刪除'); fetchAssets(); }
    else alert('刪除失敗: ' + error);
  };

  // --- 後台 ---

  const handleSaveContact = async (contact: Partial<Contact>) => {
    const { ok, error } = await api('saveContact', { data: contact });
    if (ok) { alert('聯絡人已儲存'); fetchContacts(); }
    else alert('儲存失敗: ' + error);
  };

  const handleSaveEmailTemplate = async (template: EmailTemplate) => {
    if (!isAdmin(currentUser)) return;
    const { ok, error } = await api('saveEmailTemplate', { template });
    if (ok) { setEmailTemplate(template); alert('郵件範本已儲存'); }
    else alert('儲存失敗: ' + error);
  };

  /** 寄送歡迎信：密碼只出現在 Email，站內訊息由後端產生且不含密碼 */
  const handleSendWelcomeEmail = async (targetEmail: string, name: string, tempPassword: string) => {
    if (!isAdmin(currentUser)) return;
    const { ok, error } = await api('sendWelcomeEmail', { targetEmail, name, tempPassword, template: emailTemplate });
    if (!ok) alert('帳號已核准，但歡迎信寄送失敗：' + error + '\n請自行將臨時密碼告知使用者。');
  };

  const handleUpdateUser = async (email: string, updates: Partial<User>): Promise<boolean> => {
    if (!isAdmin(currentUser)) return false;
    const { ok, error } = await api('updateUser', { targetEmail: email, updates });
    if (ok) { fetchUsers(); return true; }
    alert('更新失敗: ' + error);
    return false;
  };

  const handleDeleteUser = async (email: string): Promise<boolean> => {
    if (!isAdmin(currentUser)) return false;
    const { ok, error } = await api('deleteUser', { targetEmail: email });
    if (ok) { fetchUsers(); alert('使用者已刪除'); return true; }
    alert('刪除失敗: ' + error);
    return false;
  };

  // --- 工項 ---

  const handleCreateTask = async (taskData: any) => {
    if (!currentUser || ![UserRole.ADMIN, UserRole.MANAGER_3D, UserRole.MANAGER_DEPT].includes(currentUser.role)) return;
    const { recurrence, recurrenceCount, deadline, ...rest } = taskData;
    const tasksToCreate: any[] = [];
    if (recurrence && recurrence !== RecurrenceType.NONE) {
      const recurrenceGroupId = `REC_${Date.now()}`;
      const [y, m, d] = String(deadline).split('-').map(Number);
      for (let i = 0; i < (recurrenceCount || 1); i++) {
        const months = recurrence === RecurrenceType.MONTHLY ? i : recurrence === RecurrenceType.QUARTERLY ? i * 3
          : recurrence === RecurrenceType.SEMI_ANNUALLY ? i * 6 : i * 12;
        // 月底日期（例如 1/31）遇到小月時取當月最後一天
        const target = new Date(y, m - 1 + months, 1);
        const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
        target.setDate(Math.min(d, lastDay));
        const ds = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
        tasksToCreate.push({ ...rest, deadline: ds, recurrence, recurrenceGroupId });
      }
    } else {
      tasksToCreate.push({ ...rest, deadline });
    }
    const { ok, data, error } = await api('createTask', { taskData: tasksToCreate });
    if (ok) {
      alert(`已成功發佈 ${data?.created ?? tasksToCreate.length} 筆工項`);
      fetchTasks();
    } else {
      alert('發佈失敗: ' + error);
    }
  };

  const handleSaveTaskProgress = async (
    taskId: string,
    newStatus: TaskStatus,
    _currentAttachmentUrl?: string,
    newFile?: FilePayload,
    newFiles?: FilePayload[]
  ): Promise<boolean> => {
    const files = newFiles && newFiles.length ? newFiles : (newFile ? [newFile] : undefined);
    const { ok, data, error } = await api('updateTask', { uid: taskId, status: newStatus, files });
    if (ok) {
      const fileCount = files ? files.length : 0;
      const finalStatus = data?.status as TaskStatus | undefined;
      let msg = '進度更新成功！' + (fileCount > 0 ? `（已上傳 ${fileCount} 個檔案）` : '');
      if (finalStatus === TaskStatus.UNDER_REVIEW && newStatus !== TaskStatus.UNDER_REVIEW) msg += '\n已提送三維團隊審查，狀態為「審核中」。';
      if (finalStatus === TaskStatus.UNDER_REVIEW && newStatus === TaskStatus.UNDER_REVIEW) msg += '\n已提送三維團隊審查。';
      if (finalStatus === TaskStatus.OVERDUE) msg += '\n此工項已超過截止日期，狀態仍顯示為「逾期」。';
      alert(msg);
      fetchTasks();
      return true;
    }
    alert('更新失敗: ' + error);
    return false;
  };

  const handleReviewTask = async (taskId: string, decision: ReviewDecision, comment: string): Promise<boolean> => {
    const { ok, error } = await api('reviewTask', { uid: taskId, decision, comment });
    if (ok) {
      alert(decision === 'approve' ? '已核准，工項結案為「已完成」。' : '已退回補正，系統已通知業者。');
      fetchTasks();
      return true;
    }
    alert('審查失敗: ' + error);
    return false;
  };

  /** 把後端回傳的附件清單同步到畫面上的工項（列表、詳情、進度視窗） */
  const applyAttachments = (taskId: string, attachments: any[], attachmentUrl?: string) => {
    const patch = (t: Task): Task => t.uid === taskId
      ? { ...t, attachments, attachmentUrl: attachmentUrl ?? attachments.map(a => a.name ? `${a.name} | ${a.url}${a.uploader ? ' | ' + a.uploader : ''}` : a.url).join('\n') }
      : t;
    setTasks(prev => prev.map(patch));
    setEditingTask(prev => prev ? patch(prev) : prev);
    setViewingTask(prev => prev ? patch(prev) : prev);
  };

  /** 舊附件只有網址：開啟工項時向後端補回原始檔名 */
  const handleLoadAttachments = async (taskId: string) => {
    const { ok, data } = await api('getAttachments', { uid: taskId });
    if (ok && Array.isArray(data?.attachments)) applyAttachments(taskId, data.attachments);
  };

  const handleDeleteAttachment = async (taskId: string, url: string, name: string): Promise<boolean> => {
    if (!window.confirm(`確定要刪除「${name}」嗎？\n\n檔案會移到雲端硬碟的垃圾桶（30 天內可由管理員還原），並留下操作紀錄。`)) return false;
    const { ok, data, error } = await api('deleteAttachment', { uid: taskId, url });
    if (ok && Array.isArray(data?.attachments)) {
      applyAttachments(taskId, data.attachments, data.attachmentUrl);
      return true;
    }
    alert('刪除失敗: ' + error);
    return false;
  };

  const handleUpdateTaskMetadata = async (taskId: string, updates: Partial<Task>) => {
    const { ok, error } = await api('updateTaskMetadata', { uid: taskId, updates });
    if (ok) { alert('工項修改成功！'); fetchTasks(); }
    else alert('修改失敗: ' + error);
  };

  const handleDeleteTask = async (taskId: string, mode: DeleteRecurrenceMode = 'THIS') => {
    const { ok, data, error } = await api('deleteTask', { uid: taskId, mode });
    if (ok) { alert(mode === 'THIS' ? '工項已成功刪除' : `相關週期工項已刪除（共 ${data?.deleted ?? ''} 筆）`); fetchTasks(); }
    else alert('刪除失敗: ' + error);
  };

  // --- 訊息 ---

  const handleMarkAsRead = async (messageId: string) => {
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, isRead: true } : m));
    await api('markAsRead', { messageId });
  };

  const handleSendMessage = async (receiverEmail: string, content: string, type: string = 'private'): Promise<boolean> => {
    const { ok } = await api('sendMessage', { receiverEmail, content, type });
    if (ok) fetchMessages();
    return ok;
  };

  // --- 場館檢核 ---

  const handleSaveChecklistTemplate = async (items: ChecklistItem[]) => {
    const { ok, error } = await api('saveChecklistTemplate', { items });
    if (ok) { alert('檢核項目範本已更新'); fetchChecklistData(); }
    else alert('更新失敗: ' + error);
  };

  const handleSubmitChecklist = async (data: any): Promise<boolean> => {
    const { ok, data: result, error } = await api('submitChecklist', { data });
    if (ok) {
      const defects = Array.isArray(result?.defects) ? result.defects : [];
      alert('本月檢核表已成功提交' + (defects.length
        ? `\n\n共有 ${defects.length} 項異常，已自動開立缺失改善單並通知業者：\n` + defects.map((d: any) => `・${d.uid}（期限 ${d.deadline}）`).join('\n')
        : ''));
      fetchChecklistData();
      fetchTasks();
      return true;
    }
    alert('提交失敗: ' + error);
    return false;
  };

  const handleResolveAlert = async (submissionId: string, alertId: string) => {
    setChecklistSubmissions(prev => prev.map(sub => (sub.id === submissionId && !(sub.resolvedAlerts || []).includes(alertId))
      ? { ...sub, resolvedAlerts: [...(sub.resolvedAlerts || []), alertId] } : sub));
    const { ok, error } = await api('resolveAlert', { submissionId, alertId });
    if (!ok) { alert('更新失敗: ' + error); fetchChecklistData(); }
  };

  // --- 會議 ---

  const handleSaveMeeting = async (meeting: Partial<Meeting>, fileData?: FilePayload, filesData?: FilePayload[]) => {
    const { ok, error } = await api('saveMeeting', { data: meeting, files: filesData || (fileData ? [fileData] : undefined) });
    if (ok) { alert('會議紀錄已儲存'); fetchMeetings(); }
    else alert('儲存失敗: ' + error);
  };

  // --- 帳號 ---

  /** 回傳 true 代表成功；字串為錯誤訊息 */
  const handleRegister = async (name: string, email: string, organization: string): Promise<true | string> => {
    const { ok, error } = await api('registerUser', { user: { name, email, organization } });
    return ok ? true : (error || '申請失敗，請稍後再試');
  };

  const handleChangePassword = async (newPassword: string) => {
    if (!currentUser) return false;
    const hashedPassword = await sha256(newPassword);
    const { ok, data, error } = await api('changePassword', { newPassword: hashedPassword });
    if (ok && data?.token) {
      alert('密碼修改成功！請牢記您的新密碼。');
      const updatedUser = { ...currentUser, ...(data.user || {}), forceChangePassword: false };
      saveSession(data.token, updatedUser);
      setCurrentUser(updatedUser);
      setIsChangePwdOpen(false);
      return true;
    }
    alert('修改失敗: ' + error);
    return false;
  };

  const handleLogin = (user: User, token: string) => {
    saveSession(token, user);
    setCurrentUser(user);
    setActiveTab('dashboard');
    setHasShownWarning(false);
    lastActiveRef.current = Date.now();
  };

  // 讓使用者資料（例如被要求改密碼）與 sessionStorage 同步
  useEffect(() => { if (currentUser) updateStoredUser(currentUser); }, [currentUser]);

  if (!currentUser) {
    return (
      <ErrorBoundary>
        <Login onLogin={handleLogin} onRegister={handleRegister} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary currentUser={currentUser}>
      <Layout
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        currentUser={currentUser}
        onLogout={() => handleLogout()}
        timeLeft={timeLeft}
        unreadCount={messages.filter(m => !m.isRead && m.receiverEmail?.toLowerCase() === currentUser.email.toLowerCase()).length}
        onToggleMessages={() => setIsMessageCenterOpen(!isMessageCenterOpen)}
        isHighContrast={isHighContrast}
        toggleHighContrast={toggleHighContrast}
      >
      {activeTab === 'dashboard' && <Dashboard tasks={tasks} currentUser={currentUser} onViewDetail={setViewingTask} />}
      {activeTab === 'progress_report' && <TaskList tasks={tasks} currentUser={currentUser} onEditTask={setEditingTask} onModifyTask={setModifyingTask} onViewDetail={setViewingTask} />}
      {activeTab === 'venue_check' && (
        <ChecklistDashboard
          currentUser={currentUser}
          submissions={checklistSubmissions}
          template={checklistTemplate}
          tasks={tasks}
          onViewTask={setViewingTask}
          onSaveTemplate={handleSaveChecklistTemplate}
          onSubmitChecklist={handleSubmitChecklist}
          onResolveAlert={handleResolveAlert}
        />
      )}
      {activeTab === 'assets' && (
        <AssetManagement
          currentUser={currentUser}
          assets={assets}
          checkRecords={assetCheckRecords}
          checkBatches={assetCheckBatches}
          onDelete={handleDeleteAsset}
          onSubmitCheck={handleSubmitAssetCheck}
          onSaveBatch={handleSaveAssetCheckBatch}
          onSaveBatchAssets={handleSaveBatchAssets}
          onEdit={handleEditAsset}
        />
      )}
      {activeTab === 'calendar' && <CalendarView tasks={tasks} currentUser={currentUser} onEditTask={setEditingTask} />}
      {activeTab === 'meetings' && <MeetingRecords meetings={meetings} onSave={handleSaveMeeting} currentUser={currentUser} />}
      {activeTab === 'report' && canViewReports(currentUser) && (
        <MonthlyReport tasks={tasks} submissions={checklistSubmissions} currentUser={currentUser} onViewDetail={setViewingTask} />
      )}

      {activeTab === 'admin' && canAccessAdminPanel(currentUser) && (
        <AdminPanel
          users={users}
          logs={logs}
          onUpdateUser={handleUpdateUser}
          onDeleteUser={handleDeleteUser}
          currentUser={currentUser}
          tasks={tasks}
          onEditTask={setEditingTask}
          onModifyTask={setModifyingTask}
          onCreateTask={handleCreateTask}
          onViewDetail={setViewingTask}
          contacts={contacts}
          onSaveContact={handleSaveContact}
          emailTemplate={emailTemplate}
          onSaveEmailTemplate={handleSaveEmailTemplate}
          onSendWelcomeEmail={handleSendWelcomeEmail}
        />
      )}

      <SessionTimeoutModal
        isOpen={timeLeft <= 60}
        timeLeft={timeLeft}
        onContinue={() => {
          lastActiveRef.current = Date.now();
          setTimeLeft(IDLE_TIMEOUT);
        }}
        onLogout={() => handleLogout()}
      />

      <ChangePasswordModal
        isOpen={isChangePwdOpen}
        onClose={() => setIsChangePwdOpen(false)}
        onSubmit={handleChangePassword}
        isForced={!!currentUser?.forceChangePassword}
      />

      <DueSoonModal
        isOpen={isDueSoonModalOpen}
        onClose={() => setIsDueSoonModalOpen(false)}
        tasks={dueSoonTasks}
        currentUser={currentUser}
      />

      {editingTask && (
        <EditTaskModal
          isOpen={true}
          task={editingTask}
          currentUser={currentUser}
          onClose={() => setEditingTask(null)}
          onSave={handleSaveTaskProgress}
          onDeleteAttachment={handleDeleteAttachment}
          onLoadAttachments={handleLoadAttachments}
        />
      )}

      {modifyingTask && (
        <ModifyTaskModal
          isOpen={true}
          task={modifyingTask}
          onClose={() => setModifyingTask(null)}
          onUpdate={handleUpdateTaskMetadata}
          onDelete={handleDeleteTask}
        />
      )}

      {viewingTask && (
        <TaskDetailModal
          task={tasks.find(t => t.uid === viewingTask.uid) || viewingTask}
          isOpen={true}
          onClose={() => setViewingTask(null)}
          currentUser={currentUser}
          onSave={handleSaveTaskProgress}
          onReview={handleReviewTask}
          onDeleteAttachment={handleDeleteAttachment}
          onLoadAttachments={handleLoadAttachments}
        />
      )}

      <MessageCenter
        isOpen={isMessageCenterOpen}
        onClose={() => setIsMessageCenterOpen(false)}
        messages={messages}
        users={users}
        currentUser={currentUser}
        onMarkAsRead={handleMarkAsRead}
        onSendMessage={handleSendMessage}
      />
      </Layout>
    </ErrorBoundary>
  );
};

export default App;
