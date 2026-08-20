import React from 'react';
import { Calendar, Users, ArrowRight, CheckSquare, Sparkles } from 'lucide-react';
import { StatusBadge } from './Badge';

export const MeetingCard = ({ meeting, onView }) => {
  const formatDate = (dateString) => {
    if (!dateString) return 'No date set';
    try {
      const d = new Date(dateString);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return dateString;
    }
  };

  return (
    <div
      onClick={() => onView(meeting.id)}
      className="group relative bg-white border border-slate-200/80 rounded-2xl p-5 hover:shadow-xl hover:shadow-indigo-50/50 hover:border-indigo-300 transition-all duration-200 cursor-pointer flex flex-col justify-between"
    >
      <div>
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="text-base font-bold text-slate-900 group-hover:text-indigo-600 transition-colors line-clamp-1">
            {meeting.title}
          </h3>
          <StatusBadge status={meeting.status} />
        </div>

        <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-xs text-slate-500 mb-4">
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            <span>{formatDate(meeting.meeting_date || meeting.created_at)}</span>
          </div>

          {meeting.participants && (
            <div className="flex items-center gap-1.5 truncate max-w-[180px]">
              <Users className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="truncate">{meeting.participants}</span>
            </div>
          )}

          {meeting.action_item_count !== undefined && (
            <div className="flex items-center gap-1 text-slate-600 font-medium">
              <CheckSquare className="w-3.5 h-3.5 text-indigo-500" />
              <span>{meeting.action_item_count} action items</span>
            </div>
          )}
        </div>

        {meeting.summary && (
          <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed bg-slate-50 p-2.5 rounded-xl border border-slate-100 mb-2">
            {meeting.summary}
          </p>
        )}
      </div>

      <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs font-semibold text-indigo-600 group-hover:translate-x-0.5 transition-transform">
        <span>View full insights</span>
        <ArrowRight className="w-4 h-4" />
      </div>
    </div>
  );
};
