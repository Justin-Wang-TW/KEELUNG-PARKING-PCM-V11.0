import React, { useMemo, useState } from 'react';
import { Task, TaskStatus, User, ChecklistSubmission, CheckStatus } from '../types';
import { STATIONS, STATUS_COLORS } from '../constants';
import { getDisplayStatus, isDefect, formatDate, formatDateTime, canAccessStation, todayStr } from '../taskStatus';
import { exportWorkbook } from '../utils';
import { BarChart3, Download, Printer, AlertCircle, ClipboardList, Wrench, Info } from 'lucide-react';

interface MonthlyReportProps {
  tasks: Task[];
  submissions: ChecklistSubmission[];
  currentUser: User;
  onViewDetail?: (task: Task) => void;
}

const previousMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-');
  return `${y} 年 ${Number(m)} 月`;
};

/** 實際提送（或結案）日期：用於判斷是否準時 */
const deliveredDate = (t: Task): string => {
  if (t.submittedAt) return formatDate(t.submittedAt);
  if (t.status === TaskStatus.COMPLETED) return formatDate(t.reviewedAt || t.lastUpdated);
  return '';
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const pctText = (v: number | null) => (v === null ? '—' : `${v}%`);

const MonthlyReport: React.FC<MonthlyReportProps> = ({ tasks = [], submissions = [], currentUser, onViewDetail }) => {
  const [month, setMonth] = useState(previousMonth());

  const stations = useMemo(() => STATIONS.filter(s => canAccessStation(currentUser, s.code)), [currentUser]);
  const stationName = (code: string) => STATIONS.find(s => s.code === code)?.name || code;
  const today = todayStr();

  const report = useMemo(() => {
    const visible = tasks.filter(t => canAccessStation(currentUser, t.stationCode));
    const due = visible.filter(t => formatDate(t.deadline).startsWith(month));
    const monthSubs = submissions.filter(s => s.yearMonth === month && canAccessStation(currentUser, s.stationCode));
    const subIds = new Set(monthSubs.map(s => s.id));
    const defects = visible.filter(t => isDefect(t) && t.sourceRef && subIds.has(String(t.sourceRef).split(':')[1]));
    let estimated = 0;

    const rows = stations.map(st => {
      const list = due.filter(t => t.stationCode === st.code);
      const completed = list.filter(t => t.status === TaskStatus.COMPLETED);
      const delivered = list.filter(t => deliveredDate(t));
      const onTime = delivered.filter(t => deliveredDate(t) <= formatDate(t.deadline));
      list.forEach(t => { if (!t.submittedAt && t.status === TaskStatus.COMPLETED) estimated++; });
      const subs = monthSubs.filter(s => s.stationCode === st.code);
      const issues = subs.reduce((acc, s) => acc + s.results.filter(r => r.status === CheckStatus.ISSUE).length, 0);
      const stDefects = defects.filter(t => t.stationCode === st.code);
      return {
        code: st.code,
        name: st.name,
        due: list.length,
        completed: completed.length,
        underReview: list.filter(t => t.status === TaskStatus.UNDER_REVIEW).length,
        returned: list.filter(t => t.status === TaskStatus.RETURNED).length,
        overdue: list.filter(t => getDisplayStatus(t) === TaskStatus.OVERDUE).length,
        onTime: onTime.length,
        completionRate: pct(completed.length, list.length),
        onTimeRate: pct(onTime.length, list.length),
        checklistSubmitted: subs.length > 0,
        checklistIssues: issues,
        defects: stDefects.length,
        defectsClosed: stDefects.filter(t => t.status === TaskStatus.COMPLETED).length,
      };
    });

    const total = rows.reduce((acc, r) => ({
      due: acc.due + r.due, completed: acc.completed + r.completed, onTime: acc.onTime + r.onTime,
      overdue: acc.overdue + r.overdue, underReview: acc.underReview + r.underReview, returned: acc.returned + r.returned,
      defects: acc.defects + r.defects, defectsClosed: acc.defectsClosed + r.defectsClosed, checklistIssues: acc.checklistIssues + r.checklistIssues,
    }), { due: 0, completed: 0, onTime: 0, overdue: 0, underReview: 0, returned: 0, defects: 0, defectsClosed: 0, checklistIssues: 0 });

    const sortByDeadline = (a: Task, b: Task) => formatDate(a.deadline).localeCompare(formatDate(b.deadline));
    const notDone = due.filter(t => t.status !== TaskStatus.COMPLETED).sort(sortByDeadline);
    const lateDelivered = due.filter(t => deliveredDate(t) && deliveredDate(t) > formatDate(t.deadline)).sort(sortByDeadline);

    return { due: due.sort(sortByDeadline), rows, total, notDone, lateDelivered, defects: defects.sort(sortByDeadline), monthSubs, estimated };
  }, [tasks, submissions, month, stations, currentUser]);

  const handleExport = () => {
    const summary = report.rows.map(r => ({
      '場站': r.name, '應辦工項': r.due, '已完成': r.completed, '完成率': pctText(r.completionRate),
      '準時提送': r.onTime, '準時提送率': pctText(r.onTimeRate), '審核中': r.underReview, '退回補正': r.returned, '逾期未完成': r.overdue,
      '月檢核已提交': r.code === 'CONTRACT_TEAM' ? '不適用' : (r.checklistSubmitted ? '是' : '否'),
      '檢核異常項目': r.checklistIssues, '缺失改善單': r.defects, '缺失已結案': r.defectsClosed,
    }));
    const detail = report.due.map(t => ({
      '任務序號': t.uid, '場站': stationName(t.stationCode), '工項': t.itemName, '類型': t.taskType || '一般',
      '截止日期': formatDate(t.deadline), '目前狀態': getDisplayStatus(t), '提送/結案日': deliveredDate(t),
      '是否準時': deliveredDate(t) ? (deliveredDate(t) <= formatDate(t.deadline) ? '準時' : '逾期提送') : '未提送',
      '執行人': t.executorEmail || '', '審查人': t.reviewer || '', '審查意見': t.reviewComment || '',
    }));
    const checklist = report.monthSubs.flatMap(s => s.results.filter(r => r.status === CheckStatus.ISSUE).map(r => {
      const d = tasks.find(t => t.sourceRef === `CHK:${s.id}:${r.itemId}`);
      return {
        '場站': stationName(s.stationCode), '檢核月份': s.yearMonth, '類別': r.category || '', '檢查項目': r.content || '',
        '異常說明': r.note || '', '改善單號': d?.uid || '', '改善期限': d ? formatDate(d.deadline) : '', '改善狀態': d ? getDisplayStatus(d) : '',
      };
    }));
    exportWorkbook([
      { name: '摘要', rows: summary },
      { name: '工項明細', rows: detail },
      { name: '檢核異常與改善', rows: checklist },
    ], `履約月報_${month}`);
  };

  const KPI: React.FC<{ label: string; value: string | number; sub?: string; tone?: string }> = ({ label, value, sub, tone = 'text-gray-900' }) => (
    <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm print-avoid-break">
      <p className="text-xs font-bold text-gray-500">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tone}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );

  const TaskTable: React.FC<{ list: Task[]; empty: string; extra?: (t: Task) => string; extraLabel?: string }> = ({ list, empty, extra, extraLabel }) => (
    list.length === 0 ? (
      <p className="text-sm text-gray-400 py-4 text-center bg-gray-50 rounded-lg border border-dashed">{empty}</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-left">場站</th>
              <th className="px-3 py-2 text-left">工項</th>
              <th className="px-3 py-2 text-left whitespace-nowrap">截止日期</th>
              <th className="px-3 py-2 text-left">狀態</th>
              {extra && <th className="px-3 py-2 text-left whitespace-nowrap">{extraLabel}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {list.map(t => {
              const ds = getDisplayStatus(t);
              return (
                <tr key={t.uid} className="hover:bg-blue-50 cursor-pointer" onClick={() => onViewDetail?.(t)}>
                  <td className="px-3 py-2 whitespace-nowrap">{stationName(t.stationCode).replace('停車場', '')}</td>
                  <td className="px-3 py-2">{t.itemName}<span className="block text-[10px] text-gray-400 font-mono">{t.uid}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDate(t.deadline)}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs border ${STATUS_COLORS[ds]}`}>{ds}</span></td>
                  {extra && <td className="px-3 py-2 text-xs text-gray-600">{extra(t)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )
  );

  const t = report.total;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center">
            <BarChart3 className="w-6 h-6 mr-2 text-blue-600" />
            履約月報 <span className="hidden print:inline ml-2">— {monthLabel(month)}</span>
          </h2>
          <p className="text-gray-500 mt-1 no-print">以「截止日期落在該月份」的工項統計；可匯出 Excel 或列印成 PDF 附於工作月報。</p>
          <p className="text-gray-500 mt-1 hidden print:block">產出時間：{formatDateTime(new Date().toISOString())}・產出人：{currentUser.name}</p>
        </div>
        <div className="flex gap-2 no-print">
          <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} className="p-2 border rounded-lg bg-white" />
          <button onClick={handleExport} className="flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 shadow-sm">
            <Download className="w-4 h-4 mr-2" /> 匯出 Excel
          </button>
          <button onClick={() => window.print()} className="flex items-center px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-900 shadow-sm">
            <Printer className="w-4 h-4 mr-2" /> 列印 / PDF
          </button>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KPI label="應辦工項" value={t.due} sub={monthLabel(month)} />
        <KPI label="完成率" value={pctText(pct(t.completed, t.due))} sub={`已完成 ${t.completed} 項`} tone="text-green-700" />
        <KPI label="準時提送率" value={pctText(pct(t.onTime, t.due))} sub={`準時 ${t.onTime} 項`} tone="text-blue-700" />
        <KPI label="逾期未完成" value={t.overdue} tone={t.overdue ? 'text-red-600' : 'text-gray-900'} />
        <KPI label="審核中 / 退回補正" value={`${t.underReview} / ${t.returned}`} tone="text-amber-700" />
        <KPI label="缺失改善單" value={`${t.defectsClosed} / ${t.defects}`} sub="已結案 / 開立" tone="text-rose-700" />
      </div>

      {/* Station table */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 print-avoid-break">
        <h3 className="text-lg font-bold text-gray-800 mb-4">一、各場站履約概況</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-blue-50 text-blue-900 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">場站</th>
                <th className="px-3 py-2 text-right">應辦</th>
                <th className="px-3 py-2 text-right">已完成</th>
                <th className="px-3 py-2 text-right">完成率</th>
                <th className="px-3 py-2 text-right">準時提送率</th>
                <th className="px-3 py-2 text-right">審核中</th>
                <th className="px-3 py-2 text-right">退回補正</th>
                <th className="px-3 py-2 text-right">逾期未完成</th>
                <th className="px-3 py-2 text-center">月檢核</th>
                <th className="px-3 py-2 text-right">檢核異常</th>
                <th className="px-3 py-2 text-right">缺失結案/開立</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {report.rows.map(r => (
                <tr key={r.code}>
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{r.name}</td>
                  <td className="px-3 py-2 text-right">{r.due}</td>
                  <td className="px-3 py-2 text-right">{r.completed}</td>
                  <td className="px-3 py-2 text-right font-bold">{pctText(r.completionRate)}</td>
                  <td className="px-3 py-2 text-right">{pctText(r.onTimeRate)}</td>
                  <td className="px-3 py-2 text-right">{r.underReview}</td>
                  <td className="px-3 py-2 text-right">{r.returned}</td>
                  <td className={`px-3 py-2 text-right ${r.overdue ? 'text-red-600 font-bold' : ''}`}>{r.overdue}</td>
                  <td className="px-3 py-2 text-center">
                    {r.code === 'CONTRACT_TEAM' ? <span className="text-gray-300">—</span>
                      : r.checklistSubmitted ? <span className="text-green-700 font-bold">已提交</span>
                      : <span className="text-red-600 font-bold">未提交</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{r.checklistIssues}</td>
                  <td className="px-3 py-2 text-right">{r.defectsClosed} / {r.defects}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3 flex items-start">
          <Info className="w-3.5 h-3.5 mr-1 mt-0.5 shrink-0" />
          準時提送：於截止日（含）前提送審查或結案。{report.estimated > 0 && `其中 ${report.estimated} 筆為 V11 以前結案的舊資料，以「最後更新時間」估算。`}
          統計時點：{today}。
        </p>
      </div>

      {/* Not done */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center">
          <AlertCircle className="w-5 h-5 mr-2 text-red-500" />
          二、本月應辦但尚未完成（{report.notDone.length}）
        </h3>
        <TaskTable list={report.notDone} empty="本月應辦工項皆已完成" extra={t => t.reviewComment ? `審查意見：${t.reviewComment}` : (t.executorEmail || '')} extraLabel="備註" />
      </div>

      {report.lateDelivered.length > 0 && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-lg font-bold text-gray-800 mb-4">三、逾期提送（{report.lateDelivered.length}）</h3>
          <TaskTable list={report.lateDelivered} empty="" extra={t => `提送 ${deliveredDate(t)}`} extraLabel="提送日" />
        </div>
      )}

      {/* Checklist & defects */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 print-break">
        <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center">
          <ClipboardList className="w-5 h-5 mr-2 text-blue-500" />
          {report.lateDelivered.length > 0 ? '四' : '三'}、每月場館檢核異常與缺失改善
        </h3>
        {report.monthSubs.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center bg-gray-50 rounded-lg border border-dashed">{monthLabel(month)} 尚無場館檢核紀錄</p>
        ) : report.defects.length === 0 ? (
          <p className="text-sm text-green-700 py-4 text-center bg-green-50 rounded-lg border border-green-100">本月檢核無異常項目</p>
        ) : (
          <TaskTable
            list={report.defects}
            empty=""
            extra={t => t.status === TaskStatus.COMPLETED ? `結案 ${formatDate(t.reviewedAt)}` : ''}
            extraLabel="結案日"
          />
        )}
        <p className="text-xs text-gray-400 mt-3 flex items-center"><Wrench className="w-3.5 h-3.5 mr-1" />缺失改善單由檢核「異常」項目自動開立，預設改善期限 14 日曆天。</p>
      </div>
    </div>
  );
};

export default MonthlyReport;
