import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  FileText, 
  CheckCircle2, 
  Clock, 
  PlusCircle, 
  ArrowRight, 
  Sparkles,
  Calendar,
  Layers
} from 'lucide-react';
import { api } from '../lib/apiClient';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/Button';
import { MeetingCard } from '../components/MeetingCard';
import { LoadingState } from '../components/LoadingState';
import { ErrorMessage } from '../components/ErrorMessage';
import { EmptyState } from '../components/EmptyState';

export const DashboardPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchDashboardData = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.getDashboardStats();
      setStats(response.data);
    } catch (err) {
      console.error('Failed to fetch dashboard stats:', err);
      setError(err.userMessage || 'Could not load dashboard statistics. Please ensure the backend is running.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  if (loading) {
    return <LoadingState message="Loading your workspace..." />;
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <ErrorMessage
          title="Could not connect to backend"
          message={error}
          onRetry={fetchDashboardData}
        />
      </div>
    );
  }

  const statCards = [
    {
      label: 'Total Meetings',
      value: stats?.total_meetings ?? 0,
      icon: FileText,
      color: 'indigo',
      bg: 'bg-indigo-50 text-indigo-600',
    },
    {
      label: 'Pending Action Items',
      value: stats?.pending_action_items ?? 0,
      icon: Clock,
      color: 'amber',
      bg: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Completed Action Items',
      value: stats?.completed_action_items ?? 0,
      icon: CheckCircle2,
      color: 'emerald',
      bg: 'bg-emerald-50 text-emerald-600',
    },
  ];

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Welcome Banner */}
      <div className="relative overflow-hidden rounded-3xl bg-linear-to-r from-indigo-900 via-indigo-800 to-slate-900 text-white p-8 sm:p-10 shadow-xl shadow-indigo-950/20">
        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md text-xs font-semibold text-indigo-200 mb-4 border border-white/10">
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Meeting Intelligence</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            Welcome back, {user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'there'}!
          </h1>
          <p className="mt-2 text-sm text-indigo-100/80 leading-relaxed">
            Upload your meeting audio to generate structured summaries, extract key decisions, and track action items automatically.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="md"
              icon={PlusCircle}
              onClick={() => navigate('/upload')}
              className="bg-white text-indigo-900 hover:bg-indigo-50 shadow-none border-none font-bold"
            >
              Upload New Meeting
            </Button>
            <Button
              variant="ghost"
              size="md"
              onClick={() => navigate('/action-items')}
              className="text-white hover:bg-white/10 hover:text-white"
            >
              View Action Items
            </Button>
          </div>
        </div>

        {/* Decorative background glow */}
        <div className="absolute top-0 right-0 -mr-16 -mt-16 w-80 h-80 rounded-full bg-indigo-500/20 blur-3xl pointer-events-none"></div>
      </div>

      {/* Real Statistics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        {statCards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div
              key={i}
              className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-xs flex items-center justify-between"
            >
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {card.label}
                </p>
                <p className="text-3xl font-extrabold text-slate-900 mt-2">
                  {card.value}
                </p>
              </div>
              <div className={`p-4 rounded-2xl ${card.bg}`}>
                <Icon className="w-6 h-6" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent Meetings Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Recent Meetings</h2>
            <p className="text-xs text-slate-500">Your latest uploaded discussions and analyses</p>
          </div>
          {stats?.recent_meetings?.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              icon={ArrowRight}
              onClick={() => navigate('/history')}
            >
              View all history
            </Button>
          )}
        </div>

        {stats?.recent_meetings && stats.recent_meetings.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {stats.recent_meetings.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                onView={(id) => navigate(`/meetings/${id}`)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Layers}
            title="No meetings yet"
            description="You haven't uploaded any meetings. Upload your first audio recording to see AI summaries and action items here."
            actionLabel="Upload First Meeting"
            actionIcon={PlusCircle}
            onAction={() => navigate('/upload')}
          />
        )}
      </div>
    </div>
  );
};
