import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Search, 
  ArrowUpDown, 
  Trash2, 
  PlusCircle, 
  Calendar, 
  CheckSquare, 
  Layers,
  ArrowRight,
  Video,
  Radio,
} from 'lucide-react';
import { api } from '../lib/apiClient';
import { Button } from '../components/Button';
import { StatusBadge } from '../components/Badge';
import { LoadingState } from '../components/LoadingState';
import { ErrorMessage } from '../components/ErrorMessage';
import { EmptyState } from '../components/EmptyState';
import { ConfirmModal } from '../components/Modal';
import { useToast } from '../components/Toast';

export const HistoryPage = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest'); // newest | oldest

  // Delete modal state
  const [selectedMeetingId, setSelectedMeetingId] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchMeetings = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.getMeetings({ search: search.trim() || undefined, sort });
      setMeetings(response.data);
    } catch (err) {
      console.error('Error fetching meetings:', err);
      setError(err.userMessage || 'Could not load meeting history.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchMeetings();
    }, 300);
    return () => clearTimeout(timer);
  }, [search, sort]);

  const handleDelete = async () => {
    if (!selectedMeetingId) return;
    setIsDeleting(true);
    try {
      await api.deleteMeeting(selectedMeetingId);
      setMeetings((prev) => prev.filter((m) => m.id !== selectedMeetingId));
      setDeleteModalOpen(false);
      setSelectedMeetingId(null);
      showSuccess('Meeting deleted successfully.');
    } catch (err) {
      showError(err.userMessage || 'Failed to delete meeting.');
    } finally {
      setIsDeleting(false);
    }
  };

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
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">Past Meetings</h1>
          <p className="text-sm text-slate-600 mt-1">Browse, search, and manage all your meeting summaries and recordings</p>
        </div>
        <Button
          variant="primary"
          icon={PlusCircle}
          onClick={() => navigate('/upload')}
        >
          New Meeting
        </Button>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
            <Search className="w-4 h-4" />
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by meeting title..."
            className="w-full pl-10 pr-4 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
            <span>Sort:</span>
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="text-xs font-semibold text-slate-700 border border-slate-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>

      {/* Content Area */}
      {loading ? (
        <LoadingState message="Loading your meetings..." />
      ) : error ? (
        <ErrorMessage title="Error" message={error} onRetry={fetchMeetings} />
      ) : meetings.length > 0 ? (
        <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs overflow-hidden divide-y divide-slate-100">
          {meetings.map((meeting) => (
            <div
              key={meeting.id}
              className="p-5 sm:p-6 hover:bg-slate-50/70 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2.5 mb-1.5">
                  <h3
                    onClick={() => navigate(`/meetings/${meeting.id}`)}
                    className="text-base font-bold text-slate-900 hover:text-indigo-600 cursor-pointer transition-colors truncate"
                  >
                    {meeting.title}
                  </h3>
                  {meeting.source === 'zoom' && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                      <Video className="w-3 h-3 text-blue-600" />
                      Zoom Cloud
                    </span>
                  )}
                  {meeting.source === 'google_meet' && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <Radio className="w-3 h-3 text-emerald-600" />
                      Google Meet
                    </span>
                  )}
                  <StatusBadge status={meeting.status} />
                </div>

                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-500">
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    <span>{formatDate(meeting.meeting_date || meeting.created_at)}</span>
                  </div>

                  {meeting.action_item_count !== undefined && (
                    <div className="flex items-center gap-1 text-slate-600 font-medium">
                      <CheckSquare className="w-3.5 h-3.5 text-indigo-500" />
                      <span>{meeting.action_item_count} action items</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ArrowRight}
                  onClick={() => navigate(`/meetings/${meeting.id}`)}
                >
                  View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  onClick={() => {
                    setSelectedMeetingId(meeting.id);
                    setDeleteModalOpen(true);
                  }}
                  className="text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Layers}
          title={search ? 'No matching meetings' : 'No meetings yet'}
          description={
            search
              ? `No meetings found matching "${search}". Try searching for another term.`
              : 'You have not uploaded any meeting audio recordings yet.'
          }
          actionLabel={search ? 'Clear Search' : 'Upload Meeting'}
          onAction={search ? () => setSearch('') : () => navigate('/upload')}
        />
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => {
          setDeleteModalOpen(false);
          setSelectedMeetingId(null);
        }}
        onConfirm={handleDelete}
        title="Delete Meeting"
        message="Are you sure you want to delete this meeting? All transcripts, AI summaries, action items, and audio files will be permanently removed."
        confirmLabel="Delete"
        loading={isDeleting}
      />
    </div>
  );
};
