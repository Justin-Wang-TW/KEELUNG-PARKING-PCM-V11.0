import React from 'react';
import { Task, TaskStatus } from '../types';
import { STATUS_COLORS } from '../constants';
import { getDisplayStatus, STATUS_PRIORITY, taskAttachments, attachmentLabel } from '../taskStatus';
import { X, ListTodo, ExternalLink, Calendar, AlertCircle } from 'lucide-react';

interface StationHistoryModalProps {
  stationName: string;
  tasks: Task[];
  isOpen: boolean;
  onClose: () => void;
}

const StationHistoryModal: React.FC<StationHistoryModalProps> = ({ stationName, tasks, isOpen, onClose }) => {
  if (!isOpen) return null;

  // Helper function to format date correctly (YYYY-MM-DD)
  const formatDeadline = (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Sort tasks: Overdue first, then by deadline ascending
  const displayTasks = [...tasks].sort((a, b) => {
    const statusA = getDisplayStatus(a);
    const statusB = getDisplayStatus(b);
    
    // Priority for sorting: Overdue > In Progress > Pending > Completed
    const priority = STATUS_PRIORITY;

    const pA = priority[statusA] || 99;
    const pB = priority[statusB] || 99;

    if (pA !== pB) return pA - pB;
    
    // If priority is same, sort by deadline (closest first)
    return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col animate-fade-in">
        <div className="flex justify-between items-center p-5 border-b bg-gray-50 rounded-t-xl">
          <div>
            <h3 className="text-xl font-bold text-gray-800 flex items-center">
              <ListTodo className="w-6 h-6 mr-2 text-blue-600" />
              {stationName} - 履約任務總覽
            </h3>
            <p className="text-sm text-gray-500 mt-1">顯示該場站所有工作項目及其目前狀態</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
            <X className="w-6 h-6 text-gray-500" />
          </button>
        </div>
        
        <div className="p-0 overflow-y-auto flex-1">
          {displayTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-400">
              <ListTodo className="w-16 h-16 mb-4 opacity-20" />
              <p>目前該場站尚無任何指派任務</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse table-fixed">
              <thead className="bg-gray-50 sticky top-0 shadow-sm z-10">
                <tr>
                  <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider w-1/5">狀態</th>
                  <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider w-1/5">截止日期</th>
                  <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider w-1/5">工項名稱</th>
                  <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider w-1/5">執行人員</th>
                  <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-right w-1/5">佐證</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {displayTasks.map((task) => {
                  const displayStatus = getDisplayStatus(task);
                  const isOverdue = displayStatus === TaskStatus.OVERDUE;
                  
                  return (
                    <tr key={task.uid} className={`hover:bg-blue-50 transition-colors ${isOverdue ? 'bg-red-50/20' : ''}`}>
                      <td className="px-4 py-4 align-top">
                         <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${STATUS_COLORS[displayStatus]}`}>
                            {isOverdue && <AlertCircle className="w-3 h-3 mr-1" />}
                            {displayStatus}
                         </span>
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-600 align-top">
                        <div className={`flex items-center ${isOverdue ? 'text-red-600 font-bold' : ''}`}>
                           <Calendar className="w-4 h-4 mr-2 opacity-70" />
                           {formatDeadline(task.deadline)}
                        </div>
                      </td>
                      <td className={`px-4 py-4 text-sm font-semibold align-top ${isOverdue ? 'text-red-700' : 'text-gray-800'}`}>
                        {task.itemName}
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-600 break-all align-top">
                        {task.executorEmail || '-'}
                      </td>
                      <td className="px-4 py-4 text-right align-top">
                        {taskAttachments(task).length > 0 ? (
                          <div className="flex flex-col items-end gap-1">
                            {taskAttachments(task).map((att, i) => (
                              <a 
                                key={i}
                                href={att.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                title={attachmentLabel(att, i)}
                                className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors max-w-[14rem]"
                              >
                                <span className="truncate">{attachmentLabel(att, i)}</span> <ExternalLink className="w-3 h-3 ml-1 shrink-0" />
                              </a>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-300 text-xs">未上傳</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        
        <div className="p-4 border-t bg-gray-50 rounded-b-xl flex justify-between items-center">
           <div className="text-xs text-gray-500 flex gap-4">
              <span className="flex items-center"><div className="w-2 h-2 rounded-full bg-red-500 mr-1"></div> 逾期: {displayTasks.filter(t => getDisplayStatus(t) === TaskStatus.OVERDUE).length}</span>
              <span className="flex items-center"><div className="w-2 h-2 rounded-full bg-blue-500 mr-1"></div> 執行中: {displayTasks.filter(t => getDisplayStatus(t) === TaskStatus.IN_PROGRESS).length}</span>
              <span className="flex items-center"><div className="w-2 h-2 rounded-full bg-green-500 mr-1"></div> 已完成: {displayTasks.filter(t => getDisplayStatus(t) === TaskStatus.COMPLETED).length}</span>
           </div>
           <span className="text-sm font-bold text-gray-700">
             共 {displayTasks.length} 筆任務
           </span>
        </div>
      </div>
    </div>
  );
};

export default StationHistoryModal;