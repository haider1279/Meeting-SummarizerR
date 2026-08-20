import React, { useState } from 'react';
import { CheckCircle2, Circle, User, Clock, Flag, FileText } from 'lucide-react';
import { PriorityBadge } from './Badge';

export const ActionItemCard = ({ item, onToggleStatus, onUpdate, showMeetingTitle = false }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [task, setTask] = useState(item.task);
  const [assignee, setAssignee] = useState(item.assignee || '');
  const [deadline, setDeadline] = useState(item.deadline || '');
  const [priority, setPriority] = useState(item.priority || 'Not specified');

  const isCompleted = item.status === 'completed';

  const handleSave = () => {
    onUpdate(item.id, {
      task,
      assignee: assignee || 'Not specified',
      deadline: deadline || 'No deadline specified',
      priority: priority || 'Not specified',
    });
    setIsEditing(false);
  };

  return (
    <div
      className={`p-4 rounded-2xl border transition-all duration-200 ${
        isCompleted
          ? 'bg-slate-50/80 border-slate-200 opacity-85'
          : 'bg-white border-slate-200/90 shadow-sm hover:border-slate-300'
      }`}
    >
      {!isEditing ? (
        <div className="flex items-start gap-3.5">
          <button
            type="button"
            onClick={() => onToggleStatus(item.id, isCompleted ? 'pending' : 'completed')}
            className={`mt-0.5 rounded-lg p-0.5 transition-colors cursor-pointer shrink-0 ${
              isCompleted ? 'text-emerald-600 hover:text-slate-400' : 'text-slate-300 hover:text-emerald-600'
            }`}
          >
            {isCompleted ? (
              <CheckCircle2 className="w-5 h-5 fill-emerald-50 text-emerald-600" />
            ) : (
              <Circle className="w-5 h-5" />
            )}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <p
                className={`text-sm font-medium leading-snug ${
                  isCompleted ? 'line-through text-slate-400 font-normal' : 'text-slate-800 font-semibold'
                }`}
              >
                {item.task}
              </p>
              <div className="flex items-center gap-1 shrink-0">
                <PriorityBadge priority={item.priority} />
                <button
                  onClick={() => setIsEditing(true)}
                  className="text-xs text-slate-400 hover:text-indigo-600 px-1.5 py-0.5 rounded"
                >
                  Edit
                </button>
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500">
              <div className="flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-slate-400" />
                <span>{item.assignee || 'Not specified'}</span>
              </div>

              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>{item.deadline || 'No deadline specified'}</span>
              </div>

              {showMeetingTitle && item.meeting_title && (
                <div className="flex items-center gap-1.5 text-indigo-600 font-medium">
                  <FileText className="w-3.5 h-3.5 text-indigo-400" />
                  <span className="truncate max-w-[200px]">{item.meeting_title}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <input
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            className="w-full text-sm font-medium border border-slate-200 rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            placeholder="Task description"
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              type="text"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="text-xs border border-slate-200 rounded-xl px-3 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              placeholder="Assignee"
            />
            <input
              type="text"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="text-xs border border-slate-200 rounded-xl px-3 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              placeholder="Deadline"
            />
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="text-xs border border-slate-200 rounded-xl px-3 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none bg-white"
            >
              <option value="Not specified">Priority: Not specified</option>
              <option value="High">High Priority</option>
              <option value="Medium">Medium Priority</option>
              <option value="Low">Low Priority</option>
            </select>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="px-3 py-1 text-xs text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-3 py-1 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
