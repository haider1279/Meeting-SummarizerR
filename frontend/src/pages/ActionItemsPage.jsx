import React, { useEffect, useState } from 'react';
import { 
  CheckSquare, 
  Filter, 
  Clock, 
  CheckCircle2, 
  ListOrdered
} from 'lucide-react';
import { api } from '../lib/apiClient';
import { Button } from '../components/Button';
import { ActionItemCard } from '../components/ActionItemCard';
import { LoadingState } from '../components/LoadingState';
import { ErrorMessage } from '../components/ErrorMessage';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

export const ActionItemsPage = () => {
  const { showSuccess, showError } = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | pending | completed

  const fetchActionItems = async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (statusFilter !== 'all') {
        params.status = statusFilter;
      }
      const response = await api.getActionItems(params);
      setItems(response.data);
    } catch (err) {
      console.error('Error fetching action items:', err);
      setError(err.userMessage || 'Could not load action items.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchActionItems();
  }, [statusFilter]);

  const handleToggleStatus = async (itemId, newStatus) => {
    try {
      await api.updateActionItem(itemId, { status: newStatus });
      setItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, status: newStatus } : item))
      );
      showSuccess(`Action item marked as ${newStatus}.`);
    } catch (err) {
      showError(err.userMessage || 'Failed to update action item status.');
    }
  };

  const handleUpdate = async (itemId, updatedFields) => {
    try {
      const res = await api.updateActionItem(itemId, updatedFields);
      setItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, ...res.data } : item))
      );
      showSuccess('Action item updated.');
    } catch (err) {
      showError(err.userMessage || 'Failed to update action item.');
    }
  };

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const completedCount = items.filter((i) => i.status === 'completed').length;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Action Items & Tasks
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Track and complete tasks assigned during your recorded meetings
          </p>
        </div>

        {/* Filter buttons */}
        <div className="flex items-center gap-1.5 bg-white p-1 rounded-2xl border border-slate-200 shadow-2xs self-start">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3.5 py-1.5 text-xs font-bold rounded-xl transition-all ${
              statusFilter === 'all'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            All ({items.length})
          </button>
          <button
            onClick={() => setStatusFilter('pending')}
            className={`px-3.5 py-1.5 text-xs font-bold rounded-xl transition-all ${
              statusFilter === 'pending'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            Pending ({pendingCount})
          </button>
          <button
            onClick={() => setStatusFilter('completed')}
            className={`px-3.5 py-1.5 text-xs font-bold rounded-xl transition-all ${
              statusFilter === 'completed'
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            Completed ({completedCount})
          </button>
        </div>
      </div>

      {/* List Content */}
      {loading ? (
        <LoadingState message="Loading action items..." />
      ) : error ? (
        <ErrorMessage title="Error" message={error} onRetry={fetchActionItems} />
      ) : items.length > 0 ? (
        <div className="space-y-3">
          {items.map((item) => (
            <ActionItemCard
              key={item.id}
              item={item}
              onToggleStatus={handleToggleStatus}
              onUpdate={handleUpdate}
              showMeetingTitle={true}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={CheckSquare}
          title={
            statusFilter === 'pending'
              ? 'No pending action items'
              : statusFilter === 'completed'
              ? 'No completed action items'
              : 'No action items yet'
          }
          description={
            statusFilter !== 'all'
              ? `You do not have any ${statusFilter} action items.`
              : 'Action items will automatically appear here once you upload and analyze meetings.'
          }
        />
      )}
    </div>
  );
};
