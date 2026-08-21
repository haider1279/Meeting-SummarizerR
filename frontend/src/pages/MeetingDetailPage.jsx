import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  Calendar, 
  Users, 
  FileDown, 
  Trash2, 
  Save, 
  Edit3, 
  Sparkles, 
  ListChecks, 
  HelpCircle, 
  Tag, 
  FileText, 
  ChevronDown, 
  ChevronUp, 
  Plus, 
  X,
  Clock,
  ArrowLeft,
  Check,
  Video
} from 'lucide-react';
import { api } from '../lib/apiClient';
import { Button } from '../components/Button';
import { StatusBadge } from '../components/Badge';
import { LoadingState } from '../components/LoadingState';
import { ErrorMessage } from '../components/ErrorMessage';
import { ConfirmModal } from '../components/Modal';
import { ActionItemCard } from '../components/ActionItemCard';
import { useToast } from '../components/Toast';

export const MeetingDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const [meeting, setMeeting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('summary');
  
  // Editable fields state
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [meetingDate, setMeetingDate] = useState('');
  const [participants, setParticipants] = useState('');
  const [summary, setSummary] = useState('');
  const [keyPoints, setKeyPoints] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [unresolvedIssues, setUnresolvedIssues] = useState([]);
  const [importantTopics, setImportantTopics] = useState([]);

  // Action items local state
  const [actionItems, setActionItems] = useState([]);

  // UI state
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchMeeting = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.getMeeting(id);
      const data = response.data;
      setMeeting(data);
      setTitle(data.title || '');
      setMeetingDate(data.meeting_date || '');
      setParticipants(data.participants || '');
      setSummary(data.summary || '');
      setKeyPoints(Array.isArray(data.key_points) ? data.key_points : []);
      setDecisions(Array.isArray(data.decisions) ? data.decisions : []);
      setUnresolvedIssues(Array.isArray(data.unresolved_issues) ? data.unresolved_issues : []);
      setImportantTopics(Array.isArray(data.important_topics) ? data.important_topics : []);
      setActionItems(data.action_items || []);
    } catch (err) {
      console.error('Failed to load meeting:', err);
      setError(err.userMessage || 'Could not load meeting details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMeeting();
  }, [id]);

  // Handle saving edits back to backend
  const handleSaveMeeting = async () => {
    setIsSaving(true);
    try {
      const payload = {
        title,
        meeting_date: meetingDate || null,
        participants: participants || null,
        summary,
        key_points: keyPoints,
        decisions,
        unresolved_issues: unresolvedIssues,
        important_topics: importantTopics,
      };
      const response = await api.updateMeeting(id, payload);
      setMeeting((prev) => ({ ...prev, ...response.data }));
      setIsEditing(false);
      showSuccess('Changes saved successfully!', 'Saved');
    } catch (err) {
      console.error('Failed to save meeting:', err);
      showError(err.userMessage || 'Failed to save changes.');
    } finally {
      setIsSaving(false);
    }
  };

  // Toggle action item status
  const handleToggleActionItemStatus = async (itemId, newStatus) => {
    try {
      await api.updateActionItem(itemId, { status: newStatus });
      setActionItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, status: newStatus } : item))
      );
      showSuccess(`Action item marked as ${newStatus}.`);
    } catch (err) {
      showError(err.userMessage || 'Failed to update action item status.');
    }
  };

  // Update action item content
  const handleUpdateActionItem = async (itemId, updatedFields) => {
    try {
      const res = await api.updateActionItem(itemId, updatedFields);
      setActionItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, ...res.data } : item))
      );
      showSuccess('Action item updated.');
    } catch (err) {
      showError(err.userMessage || 'Failed to update action item.');
    }
  };

  // PDF download
  const handleDownloadPdf = async () => {
    setIsDownloadingPdf(true);
    try {
      const response = await api.downloadPdf(id);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `meeting_report_${id.substring(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
      showSuccess('PDF downloaded successfully!');
    } catch (err) {
      console.error('PDF download error:', err);
      showError(err.userMessage || 'Failed to generate PDF. Make sure meeting status is completed.');
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  // Delete meeting
  const handleDeleteMeeting = async () => {
    setIsDeleting(true);
    try {
      await api.deleteMeeting(id);
      showSuccess('Meeting and associated audio deleted.', 'Deleted');
      navigate('/history');
    } catch (err) {
      console.error('Delete meeting error:', err);
      showError(err.userMessage || 'Failed to delete meeting.');
      setIsDeleting(false);
    }
  };

  if (loading) {
    return <LoadingState message="Loading meeting insights..." />;
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <ErrorMessage title="Error" message={error} onRetry={fetchMeeting} />
      </div>
    );
  }

  const tabs = [
    { id: 'summary', label: 'Summary & Overview', icon: Sparkles },
    { id: 'keyPoints', label: 'Key Points', icon: ListChecks, count: keyPoints.length },
    { id: 'decisions', label: 'Decisions', icon: Check, count: decisions.length },
    { id: 'actionItems', label: 'Action Items', icon: Clock, count: actionItems.length },
    { id: 'unresolved', label: 'Unresolved Issues', icon: HelpCircle, count: unresolvedIssues.length },
    { id: 'topics', label: 'Important Topics', icon: Tag, count: importantTopics.length },
  ];

  // Helper for list editing (Key points, decisions, unresolved, topics)
  const renderListEditor = (items, setItems, placeholder) => {
    return (
      <div className="space-y-3">
        {items.map((item, index) => (
          <div key={index} className="flex items-start gap-2 group">
            <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center text-xs font-bold shrink-0 mt-1">
              {index + 1}
            </span>
            {isEditing ? (
              <div className="flex-1 flex items-center gap-2">
                <input
                  type="text"
                  value={item}
                  onChange={(e) => {
                    const next = [...items];
                    next[index] = e.target.value;
                    setItems(next);
                  }}
                  className="w-full text-sm font-medium border border-slate-200 rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none bg-white"
                />
                <button
                  type="button"
                  onClick={() => setItems(items.filter((_, i) => i !== index))}
                  className="text-slate-400 hover:text-rose-600 p-1.5 rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <p className="flex-1 text-sm text-slate-700 leading-relaxed pt-0.5">
                {item}
              </p>
            )}
          </div>
        ))}

        {isEditing && (
          <button
            type="button"
            onClick={() => setItems([...items, ''])}
            className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 py-1.5 px-3 rounded-lg hover:bg-indigo-50"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Item</span>
          </button>
        )}

        {items.length === 0 && !isEditing && (
          <p className="text-xs text-slate-400 italic">None identified in this meeting.</p>
        )}
      </div>
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      {/* Top Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <button
          onClick={() => navigate('/history')}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Past Meetings</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {isEditing ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setIsEditing(false);
                  fetchMeeting(); // Reset local state
                }}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Save}
                onClick={handleSaveMeeting}
                loading={isSaving}
              >
                Save Changes
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={Edit3}
                onClick={() => setIsEditing(true)}
              >
                Edit Insights
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={FileDown}
                onClick={handleDownloadPdf}
                loading={isDownloadingPdf}
              >
                Export PDF
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={Trash2}
                onClick={() => setDeleteModalOpen(true)}
                className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Meeting Title & Metadata Card */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {isEditing ? (
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="text-xl sm:text-2xl font-extrabold text-slate-900 border border-slate-200 rounded-xl px-3 py-1.5 w-full focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
          ) : (
            <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">
              {meeting?.title}
            </h1>
          )}
          <div className="flex items-center gap-2">
            {meeting?.source === 'zoom' && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
                <Video className="w-3.5 h-3.5 text-blue-600" />
                Zoom Recording
              </span>
            )}
            <StatusBadge status={meeting?.status} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-y-2 gap-x-6 text-xs text-slate-500 pt-2 border-t border-slate-100">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            {isEditing ? (
              <input
                type="date"
                value={meetingDate}
                onChange={(e) => setMeetingDate(e.target.value)}
                className="border border-slate-200 rounded-lg px-2 py-1 text-xs"
              />
            ) : (
              <span>{meeting?.meeting_date || 'No date specified'}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-400" />
            {isEditing ? (
              <input
                type="text"
                value={participants}
                onChange={(e) => setParticipants(e.target.value)}
                placeholder="Participants (comma-separated)"
                className="border border-slate-200 rounded-lg px-2 py-1 text-xs w-60"
              />
            ) : (
              <span>{meeting?.participants || 'No participants listed'}</span>
            )}
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none border-b border-slate-200">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-xs font-bold rounded-t-2xl border-b-2 transition-all whitespace-nowrap cursor-pointer ${
                isActive
                  ? 'border-indigo-600 text-indigo-600 bg-indigo-50/50'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
              {tab.count !== undefined && (
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    isActive ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active Tab Content Panel */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs min-h-[300px]">
        {activeTab === 'summary' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-600" />
                Executive Summary
              </h2>
            </div>
            {isEditing ? (
              <textarea
                rows={6}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                className="w-full text-sm leading-relaxed border border-slate-200 rounded-2xl p-4 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                placeholder="Write or edit the executive summary..."
              />
            ) : (
              <p className="text-sm text-slate-700 leading-relaxed bg-slate-50/60 p-5 rounded-2xl border border-slate-100">
                {summary || 'No summary available.'}
              </p>
            )}
          </div>
        )}

        {activeTab === 'keyPoints' && (
          <div className="space-y-4">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <ListChecks className="w-5 h-5 text-indigo-600" />
              Key Discussion Points
            </h2>
            {renderListEditor(keyPoints, setKeyPoints, 'Enter key point')}
          </div>
        )}

        {activeTab === 'decisions' && (
          <div className="space-y-4">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Check className="w-5 h-5 text-emerald-600" />
              Decisions Made
            </h2>
            {renderListEditor(decisions, setDecisions, 'Enter decision made')}
          </div>
        )}

        {activeTab === 'actionItems' && (
          <div className="space-y-4">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Clock className="w-5 h-5 text-amber-600" />
              Action Items & Assigned Deadlines
            </h2>
            {actionItems.length > 0 ? (
              <div className="space-y-3">
                {actionItems.map((item) => (
                  <ActionItemCard
                    key={item.id}
                    item={item}
                    onToggleStatus={handleToggleActionItemStatus}
                    onUpdate={handleUpdateActionItem}
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400 italic">No action items found for this meeting.</p>
            )}
          </div>
        )}

        {activeTab === 'unresolved' && (
          <div className="space-y-4">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <HelpCircle className="w-5 h-5 text-rose-600" />
              Unresolved Issues & Open Questions
            </h2>
            {renderListEditor(unresolvedIssues, setUnresolvedIssues, 'Enter unresolved issue')}
          </div>
        )}

        {activeTab === 'topics' && (
          <div className="space-y-4">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Tag className="w-5 h-5 text-purple-600" />
              Important Topics & Themes
            </h2>
            {renderListEditor(importantTopics, setImportantTopics, 'Enter topic')}
          </div>
        )}
      </div>

      {/* Collapsible Transcript Section */}
      <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs overflow-hidden">
        <button
          type="button"
          onClick={() => setIsTranscriptOpen(!isTranscriptOpen)}
          className="w-full p-6 flex items-center justify-between hover:bg-slate-50 transition-colors text-left"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Full Audio Transcript</h3>
              <p className="text-xs text-slate-500">View verbatim transcription generated from recording</p>
            </div>
          </div>
          {isTranscriptOpen ? <ChevronUp className="w-5 h-5 text-slate-400" /> : <ChevronDown className="w-5 h-5 text-slate-400" />}
        </button>

        {isTranscriptOpen && (
          <div className="p-6 pt-0 border-t border-slate-100 bg-slate-50/50">
            <div className="max-h-96 overflow-y-auto p-4 rounded-2xl bg-white border border-slate-200 text-xs font-mono text-slate-700 leading-relaxed whitespace-pre-wrap">
              {meeting?.transcript || 'No transcript generated.'}
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDeleteMeeting}
        title="Delete Meeting Recording"
        message="Are you sure you want to delete this meeting? This will permanently delete the AI summary, transcript, action items, and stored audio file."
        confirmLabel="Delete Meeting"
        loading={isDeleting}
      />
    </div>
  );
};
