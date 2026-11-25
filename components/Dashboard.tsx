import React, { useMemo, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { Task, TaskStats, TaskStatus, StationCode, User, UserRole } from '../types';
import { STATIONS } from '../constants';
import StationHistoryModal from './StationHistoryModal';
import { ChevronRight, AlertCircle, CheckCircle2, Clock, PlayCircle, ClipboardList, ShieldCheck, Undo2 } from 'lucide-react';
import { getDisplayStatus, isReviewer, isDefect, formatDateTime, daysUntil } from '../taskStatus';

interface DashboardProps {
  tasks: Task[];
  currentUser: User;
  onViewDetail?: (task: Task) => void;
}

// 圓餅圖顏色依狀態對應
const STATUS_CHART_COLOR: Record<string, string> = {
  [TaskStatus.COMPLETED]: '#10B981',
  [TaskStatus.PENDING]: '#D1D5DB',
  [TaskStatus.IN_PROGRESS]: '#3B82F6',
  [TaskStatus.UNDER_REVIEW]: '#F59E0B',
  [TaskStatus.RETURNED]: '#8B5CF6',
  [TaskStatus.OVERDUE]: '#EF4444',
};

const Dashboard: React.FC<DashboardProps> = ({ tasks = [], currentUser, onViewDetail }) => {
  const [selectedStationCode, setSelectedStationCode] = useState<string | null>(null);

  // Helper function to format date correctly (YYYY-MM-DD)
  // Handles timezone conversion from UTC (e.g. 2026-01-29T16:00:00Z -> 2026-01-30)
  const formatDeadline = (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const visibleTasks = useMemo(() => {
    return (tasks || []).filter(t => {
      const assignedStations = currentUser.assignedStation ? currentUser.assignedStation.split(',') : [];
      if (!assignedStations.includes('ALL') && !assignedStations.includes(t.stationCode)) {
        return false;
      }
      if (t.stationCode === StationCode.CONTRACT_TEAM && currentUser.role === UserRole.OPERATOR) {
        return false;
      }
      return true;
    });
  }, [tasks, currentUser]);

  const stats = useMemo(() => {
    const visibleStations = STATIONS.filter(s => {
      const assignedStations = currentUser.assignedStation ? currentUser.assignedStation.split(',') : [];
      if (!assignedStations.includes('ALL') && !assignedStations.includes(s.code)) {
        return false;
      }
      if (s.code === StationCode.CONTRACT_TEAM && currentUser.role === UserRole.OPERATOR) {
        return false;
      }
      return true;
    });

    return visibleStations.map(station => {
      const stationTasks = visibleTasks.filter(t => t.stationCode === station.code);
      const total = stationTasks.length;

      const counts: Record<string, number> = {};
      stationTasks.forEach(t => {
        const ds = getDisplayStatus(t);
        counts[ds] = (counts[ds] || 0) + 1;
      });
      const pending = counts[TaskStatus.PENDING] || 0;
      const inProgress = counts[TaskStatus.IN_PROGRESS] || 0;
      const completed = counts[TaskStatus.COMPLETED] || 0;
      const overdue = counts[TaskStatus.OVERDUE] || 0;
      const underReview = counts[TaskStatus.UNDER_REVIEW] || 0;
      const returned = counts[TaskStatus.RETURNED] || 0;
      
      return {
        stationName: station.name,
        stationCode: station.code,
        total,
        pending,
        inProgress,
        completed,
        overdue,
        underReview,
        returned,
        rate: total > 0 ? Math.round((completed / total) * 100) : 0,
      };
    });
  }, [visibleTasks, currentUser]);

  const globalStats = useMemo(() => {
    const order = [TaskStatus.COMPLETED, TaskStatus.PENDING, TaskStatus.IN_PROGRESS, TaskStatus.UNDER_REVIEW, TaskStatus.RETURNED, TaskStatus.OVERDUE];
    const counts: Record<string, number> = {};
    visibleTasks.forEach(t => { const ds = getDisplayStatus(t); counts[ds] = (counts[ds] || 0) + 1; });
    return order.map(name => ({ name, value: counts[name] || 0 })).filter(d => d.value > 0);
  }, [visibleTasks]);

  const reviewer = isReviewer(currentUser);
  const pendingReview = useMemo(() => visibleTasks
    .filter(t => t.status === TaskStatus.UNDER_REVIEW)
    .sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || ''))), [visibleTasks]);
  const returnedTasks = useMemo(() => visibleTasks
    .filter(t => t.status === TaskStatus.RETURNED)
    .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline))), [visibleTasks]);
  const overdueTasks = useMemo(() => visibleTasks
    .filter(t => getDisplayStatus(t) === TaskStatus.OVERDUE)
    .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline))), [visibleTasks]);

  const selectedStationName = STATIONS.find(s => s.code === selectedStationCode)?.name || '';
  const selectedStationTasks = visibleTasks.filter(t => t.stationCode === selectedStationCode);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center">
        <div>
           <h2 className="text-2xl font-bold text-gray-800">戰情儀表板</h2>
           <p className="text-gray-500 mt-1">即時監控各場站履約狀況</p>
        </div>
        <div className="mt-4 md:mt-0 bg-white p-3 rounded-lg shadow-sm border flex items-center">
          <ClipboardList className="w-5 h-5 text-gray-500 mr-2" />
          <span className="text-sm text-gray-500 mr-2">總任務數:</span>
          <span className="text-xl font-bold text-gray-800">{(tasks || []).length}</span>
        </div>
      </div>

      {/* Station Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
         {stats.map((stat) => (
           <div 
             key={stat.stationCode} 
             onClick={() => setSelectedStationCode(stat.stationCode)}
             className={`bg-white p-5 rounded-xl shadow-sm border cursor-pointer hover:shadow-md transition-all group relative overflow-hidden ${
               stat.overdue > 0 ? 'border-red-200 ring-1 ring-red-100' : 'border-gray-100 hover:border-blue-200'
             }`}
           >
             {/* Progress Bar Background (Subtle) */}
             <div className="absolute top-0 left-0 h-1 bg-gray-100 w-full">
               <div 
                  className={`h-full transition-all duration-500 ${stat.rate === 100 ? 'bg-green-500' : 'bg-blue-500'}`} 
                  style={{ width: `${stat.rate}%` }}
               />
             </div>

             <div className="flex justify-between items-start mb-4 mt-2">
               <h3 className="font-bold text-lg text-gray-800 group-hover:text-blue-600 transition-colors truncate pr-2">
                 {stat.stationName.replace('停車場', '')}
               </h3>
               <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${stat.rate >= 90 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                 {stat.rate}%
               </span>
             </div>

             {/* Detailed Stats Grid */}
             <div className="grid grid-cols-2 gap-y-3 gap-x-2 text-sm">
                <div className="flex items-center text-gray-600">
                   <Clock className="w-3.5 h-3.5 mr-1.5 text-gray-400" />
                   <span>待處理: <span className="font-semibold text-gray-800">{stat.pending}</span></span>
                </div>
                <div className="flex items-center text-blue-700">
                   <PlayCircle className="w-3.5 h-3.5 mr-1.5 text-blue-500" />
                   <span>執行中: <span className="font-semibold text-blue-800">{stat.inProgress}</span></span>
                </div>
                <div className="flex items-center text-green-700">
                   <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-green-500" />
                   <span>已完成: <span className="font-semibold text-green-800">{stat.completed}</span></span>
                </div>
                <div className={`flex items-center ${stat.overdue > 0 ? 'text-red-700 font-bold' : 'text-gray-400'}`}>
                   <AlertCircle className={`w-3.5 h-3.5 mr-1.5 ${stat.overdue > 0 ? 'text-red-600' : 'text-gray-300'}`} />
                   <span>逾期: <span className={`${stat.overdue > 0 ? 'text-red-700' : 'text-gray-400'}`}>{stat.overdue}</span></span>
                </div>
             </div>

             {(stat.underReview > 0 || stat.returned > 0) && (
               <div className="mt-3 flex flex-wrap gap-2 text-xs">
                 {stat.underReview > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">審核中 {stat.underReview}</span>}
                 {stat.returned > 0 && <span className="px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">退回補正 {stat.returned}</span>}
               </div>
             )}

             <div className="mt-4 pt-3 border-t border-gray-50 flex justify-between items-center text-xs text-gray-400">
                <span>總計 {stat.total} 項任務</span>
                <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-blue-400" />
             </div>
           </div>
         ))}
      </div>

      {reviewer && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-amber-200">
          <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center">
            <ShieldCheck className="w-5 h-5 mr-2 text-amber-500" />
            待我審查
            <span className="ml-2 text-sm font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{pendingReview.length}</span>
          </h3>
          {pendingReview.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center bg-gray-50 rounded-lg border border-dashed">目前沒有待審查的工項</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {pendingReview.map(task => (
                <button key={task.uid} onClick={() => onViewDetail?.(task)} className="w-full text-left py-3 px-2 flex items-center justify-between hover:bg-amber-50 rounded-lg transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-gray-600 bg-gray-100 px-1.5 rounded">{STATIONS.find(s => s.code === task.stationCode)?.name || task.stationName}</span>
                      {isDefect(task) && <span className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-1.5 rounded">缺失改善</span>}
                      <span className="text-sm font-bold text-gray-900 truncate">{task.itemName}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">提送 {formatDateTime(task.submittedAt)}・{task.executorEmail}・截止 {formatDeadline(task.deadline)}</p>
                  </div>
                  <span className="text-xs font-bold text-amber-700 whitespace-nowrap ml-3 flex items-center">前往審查 <ChevronRight className="w-4 h-4" /></span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!reviewer && returnedTasks.length > 0 && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-purple-200">
          <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center">
            <Undo2 className="w-5 h-5 mr-2 text-purple-500" />
            被退回待補正
            <span className="ml-2 text-sm font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-800">{returnedTasks.length}</span>
          </h3>
          <div className="divide-y divide-gray-100">
            {returnedTasks.map(task => (
              <button key={task.uid} onClick={() => onViewDetail?.(task)} className="w-full text-left py-3 px-2 hover:bg-purple-50 rounded-lg transition-colors">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-gray-600 bg-gray-100 px-1.5 rounded">{STATIONS.find(s => s.code === task.stationCode)?.name || task.stationName}</span>
                  <span className="text-sm font-bold text-gray-900 truncate">{task.itemName}</span>
                </div>
                {task.reviewComment && <p className="text-xs text-purple-700 mt-1 line-clamp-2">審查意見：{task.reviewComment}</p>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 min-h-[400px]">
          <h3 className="text-lg font-bold text-gray-800 mb-6">全區任務狀態分佈</h3>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={globalStats}
                  cx="50%"
                  cy="50%"
                  innerRadius={80}
                  outerRadius={120}
                  fill="#8884d8"
                  paddingAngle={5}
                  dataKey="value"
                >
                  {globalStats.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={STATUS_CHART_COLOR[entry.name] || '#9CA3AF'} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend verticalAlign="bottom" height={36}/>
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
           <h3 className="text-lg font-bold text-gray-800 mb-6 flex items-center">
             <AlertCircle className="w-5 h-5 mr-2 text-red-500" />
             逾期未完成項目
           </h3>
           <div className="space-y-3">
             {overdueTasks.slice(0, 8).map(task => (
                <button key={task.uid} onClick={() => onViewDetail?.(task)} className="w-full text-left flex items-center justify-between p-3 bg-red-50 rounded-lg border border-red-100 hover:bg-red-100 transition-colors">
                  <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-red-600 bg-white border border-red-200 px-1.5 rounded">{STATIONS.find(s => s.code === task.stationCode)?.name || task.stationName || task.stationCode}</span>
                        <h4 className="text-sm font-bold text-gray-900 line-clamp-1">{task.itemName}</h4>
                      </div>
                      <p className="text-xs text-red-600 mt-1 font-medium flex items-center">
                        <Clock className="w-3 h-3 mr-1" />
                        截止日期: {formatDeadline(task.deadline)}
                      </p>
                  </div>
                  <span className="text-xs font-bold px-2 py-1 bg-white text-red-600 rounded border border-red-200 whitespace-nowrap ml-2">
                      逾期 {Math.max(1, -daysUntil(task.deadline))} 天
                  </span>
                </button>
              ))}
             {overdueTasks.length > 8 && <p className="text-xs text-gray-400 text-center">還有 {overdueTasks.length - 8} 項，請至「進度匯報」篩選「逾期」查看</p>}
             {overdueTasks.length === 0 && (
               <div className="flex flex-col items-center justify-center h-48 text-gray-400 bg-gray-50 rounded-lg border border-dashed">
                  <CheckCircle2 className="w-10 h-10 mb-2 text-green-500 opacity-50" />
                  <p>太棒了！目前無逾期項目</p>
               </div>
             )}
           </div>
        </div>
      </div>

      <StationHistoryModal 
        isOpen={!!selectedStationCode}
        onClose={() => setSelectedStationCode(null)}
        stationName={selectedStationName}
        tasks={selectedStationTasks}
      />
    </div>
  );
};

export default Dashboard;