import React, { useEffect, useMemo, useState } from 'react';
import { Task, User } from '../types';
import { taskAttachments, attachmentLabel, canDeleteAttachment } from '../taskStatus';
import { Paperclip, FileText, Download, Trash2, Loader2 } from 'lucide-react';

interface AttachmentListProps {
  task: Task;
  currentUser: User | null;
  /** 一次刪除多個附件（只送出一次請求） */
  onDeleteAttachments?: (taskId: string, items: { url: string; name: string }[]) => Promise<boolean>;
  /** compact：更新進度視窗用的精簡清單；full：工項詳情用的卡片清單 */
  variant?: 'compact' | 'full';
  disabled?: boolean;
}

/**
 * 工項附件清單：顯示原始檔名，可勾選多個檔案一次刪除
 */
const AttachmentList: React.FC<AttachmentListProps> = ({ task, currentUser, onDeleteAttachments, variant = 'full', disabled = false }) => {
  const attachments = taskAttachments(task);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [isDeleting, setIsDeleting] = useState(false);

  // 附件清單變動（刪除、上傳、換工項）時清掉已不存在的勾選
  useEffect(() => {
    setSelected(prev => {
      const next: Record<string, boolean> = {};
      attachments.forEach(a => { if (prev[a.url]) next[a.url] = true; });
      return next;
    });
  }, [task.uid, task.attachmentUrl]);

  const deletableUrls = useMemo(
    () => attachments.filter(a => !a.url.startsWith('data:') && canDeleteAttachment(currentUser, task, a)).map(a => a.url),
    [task.attachmentUrl, task.status, currentUser?.email]
  );
  const canDelete = !!onDeleteAttachments && deletableUrls.length > 0;
  const selectedUrls = deletableUrls.filter(u => selected[u]);
  const allSelected = selectedUrls.length > 0 && selectedUrls.length === deletableUrls.length;

  const toggle = (url: string) => setSelected(prev => ({ ...prev, [url]: !prev[url] }));
  const toggleAll = () => {
    if (allSelected) setSelected({});
    else setSelected(Object.fromEntries(deletableUrls.map(u => [u, true])));
  };

  const handleDelete = async () => {
    if (!onDeleteAttachments || selectedUrls.length === 0) return;
    const items = attachments
      .map((a, i) => ({ url: a.url, name: attachmentLabel(a, i) }))
      .filter(it => selectedUrls.includes(it.url));
    setIsDeleting(true);
    try {
      const ok = await onDeleteAttachments(task.uid, items);
      if (ok) setSelected({});
    } finally {
      setIsDeleting(false);
    }
  };

  if (attachments.length === 0) return null;

  const toolbar = canDelete && (
    <div className={`flex items-center justify-between gap-2 ${variant === 'compact' ? 'mb-1.5 pb-1.5 border-b border-gray-200' : 'mb-2'}`}>
      <label className="flex items-center text-xs text-gray-600 cursor-pointer select-none">
        <input
          type="checkbox"
          className="mr-1.5 w-3.5 h-3.5 accent-red-600"
          checked={allSelected}
          onChange={toggleAll}
          disabled={isDeleting || disabled}
        />
        全選可刪除的檔案（{deletableUrls.length}）
      </label>
      <button
        type="button"
        onClick={handleDelete}
        disabled={selectedUrls.length === 0 || isDeleting || disabled}
        className="flex items-center px-2.5 py-1 text-xs font-bold rounded-lg border border-red-200 text-red-600 bg-white hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isDeleting ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 mr-1" />}
        刪除已勾選{selectedUrls.length > 0 ? `（${selectedUrls.length}）` : ''}
      </button>
    </div>
  );

  if (variant === 'compact') {
    return (
      <div>
        {toolbar}
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {attachments.map((att, i) => {
            const label = attachmentLabel(att, i);
            const deletable = canDelete && deletableUrls.includes(att.url);
            return (
              <div key={att.url} className={`flex items-center gap-2 p-1 rounded transition-colors ${selected[att.url] ? 'bg-red-50' : 'hover:bg-blue-50'}`}>
                {canDelete && (
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 shrink-0 accent-red-600"
                    checked={!!selected[att.url]}
                    onChange={() => toggle(att.url)}
                    disabled={!deletable || isDeleting || disabled}
                    title={deletable ? '勾選後可一次刪除' : '此檔案不能由你刪除'}
                    aria-label={`勾選 ${label}`}
                  />
                )}
                <a
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={label}
                  className="text-xs text-blue-600 hover:text-blue-800 hover:underline flex items-center min-w-0"
                >
                  <Paperclip className="w-3 h-3 mr-1 text-blue-500 shrink-0" />
                  <span className="truncate">{label}</span>
                </a>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      {toolbar}
      <div className="space-y-2">
        {attachments.map((att, i) => {
          const label = attachmentLabel(att, i);
          const isBase64 = att.url.startsWith('data:');
          const deletable = canDelete && deletableUrls.includes(att.url);
          return (
            <div
              key={att.url}
              className={`flex items-center justify-between p-3 border rounded-lg transition-colors ${selected[att.url] ? 'bg-red-50 border-red-200' : 'bg-white hover:bg-gray-50'}`}
            >
              <div className="flex items-center space-x-3 overflow-hidden">
                {canDelete && (
                  <input
                    type="checkbox"
                    className="w-4 h-4 shrink-0 accent-red-600"
                    checked={!!selected[att.url]}
                    onChange={() => toggle(att.url)}
                    disabled={!deletable || isDeleting || disabled}
                    title={deletable ? '勾選後可一次刪除' : '此檔案不能由你刪除'}
                    aria-label={`勾選 ${label}`}
                  />
                )}
                <div className="p-2 bg-gray-100 rounded shrink-0">
                  <FileText className="w-5 h-5 text-gray-500" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate" title={label}>{label}</p>
                  <p className="text-xs text-gray-400 truncate max-w-xs">
                    {att.uploader ? `上傳者 ${att.uploader}` : (att.name ? '' : '讀取檔名中…')}
                  </p>
                </div>
              </div>
              <a
                href={att.url}
                download={isBase64 ? `proof_${task.uid}_${i + 1}` : undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center px-3 py-1.5 bg-gray-100 text-gray-700 text-xs font-medium rounded-lg hover:bg-gray-200 transition-colors whitespace-nowrap shrink-0 ml-2"
              >
                <Download className="w-3.5 h-3.5 mr-1" />
                開啟檢視
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AttachmentList;
