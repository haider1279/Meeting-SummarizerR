import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  User, 
  Mail, 
  Lock, 
  LogOut, 
  ShieldCheck, 
  KeyRound, 
  CheckCircle2, 
  AlertCircle,
  Video,
  ExternalLink,
  Unlink,
  Radio,
  RefreshCw
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/apiClient';
import { Button } from '../components/Button';
import { useToast } from '../components/Toast';

export const SettingsPage = () => {
  const { user, signOut, updatePassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { showSuccess, showError } = useToast();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  // Zoom Integration State
  const [zoomStatus, setZoomStatus] = useState({
    configured: true,
    connected: false,
    email: null,
    status: 'loading',
  });
  const [zoomLoading, setZoomLoading] = useState(true);
  const [zoomActionLoading, setZoomActionLoading] = useState(false);

  // Fetch Zoom Status
  const fetchZoomStatus = async () => {
    try {
      setZoomLoading(true);
      const res = await api.getZoomStatus();
      setZoomStatus(res.data);
    } catch (err) {
      console.error('Error checking Zoom connection status:', err);
    } finally {
      setZoomLoading(false);
    }
  };

  // Check URL params from OAuth callback (?zoom=connected or ?zoom=error)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const zoomParam = params.get('zoom');
    const reasonParam = params.get('reason');

    if (zoomParam === 'connected') {
      showSuccess('Your Zoom account has been connected successfully!', 'Zoom Connected');
      fetchZoomStatus();
      // Remove query parameters from URL without reloading
      navigate(location.pathname, { replace: true });
    } else if (zoomParam === 'error') {
      const reasonText = reasonParam ? reasonParam.replace(/_/g, ' ') : 'Authorization was canceled or failed.';
      showError(`Could not connect Zoom account: ${reasonText}`, 'Zoom Error');
      fetchZoomStatus();
      navigate(location.pathname, { replace: true });
    } else {
      fetchZoomStatus();
    }
  }, [location.search]);

  // Connect Zoom Handler
  const handleConnectZoom = async () => {
    setZoomActionLoading(true);
    try {
      const res = await api.getZoomConnectUrl();
      if (res.data?.url) {
        window.location.href = res.data.url;
      } else {
        showError('Could not obtain Zoom authorization URL.');
        setZoomActionLoading(false);
      }
    } catch (err) {
      console.error('Connect Zoom error:', err);
      showError(err.userMessage || 'Failed to start Zoom connection.');
      setZoomActionLoading(false);
    }
  };

  // Disconnect Zoom Handler
  const handleDisconnectZoom = async () => {
    setZoomActionLoading(true);
    try {
      await api.disconnectZoom();
      showSuccess('Zoom account disconnected successfully.');
      await fetchZoomStatus();
    } catch (err) {
      console.error('Disconnect Zoom error:', err);
      showError(err.userMessage || 'Failed to disconnect Zoom account.');
    } finally {
      setZoomActionLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }

    setPasswordLoading(true);
    try {
      await updatePassword(newPassword);
      setPasswordSuccess('Password updated successfully!');
      setNewPassword('');
      setConfirmPassword('');
      showSuccess('Password updated successfully.');
    } catch (err) {
      setPasswordError(err.message || 'Failed to update password.');
      showError(err.message || 'Failed to update password.');
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
      navigate('/login');
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">Account & Settings</h1>
        <p className="text-sm text-slate-600 mt-1">Manage your account profile and security credentials</p>
      </div>

      {/* Profile Card */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs space-y-6">
        <div className="flex items-center gap-4 pb-6 border-b border-slate-100">
          <div className="w-16 h-16 rounded-2xl bg-indigo-600 text-white flex items-center justify-center font-extrabold text-2xl uppercase shadow-md shadow-indigo-200">
            {user?.email?.[0] || 'U'}
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {user?.user_metadata?.full_name || 'Meeting Summarizer User'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">{user?.email}</p>
            <div className="flex items-center gap-1.5 mt-2 text-[11px] text-emerald-600 font-semibold bg-emerald-50 px-2.5 py-0.5 rounded-full inline-flex border border-emerald-200">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Supabase Authenticated</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1">
              Account Email
            </span>
            <span className="text-sm font-medium text-slate-900">{user?.email}</span>
          </div>

          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1">
              User ID
            </span>
            <span className="text-xs font-mono text-slate-600 break-all">{user?.id}</span>
          </div>
        </div>
      </div>

      {/* Zoom Integration Card */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl">
              <Video className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-900">Zoom Integration</h3>
                {zoomStatus.connected && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    Connected
                  </span>
                )}
                {!zoomStatus.connected && !zoomLoading && (
                  <span className="inline-flex items-center text-[11px] font-medium text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full">
                    Not Connected
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Authorize your Zoom account to import and summarize cloud recordings
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-center">
            {zoomLoading ? (
              <span className="text-xs text-slate-400">Checking status...</span>
            ) : zoomStatus.connected ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ExternalLink}
                  onClick={() => navigate('/upload?tab=zoom')}
                >
                  View Zoom Recordings
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon={Unlink}
                  onClick={handleDisconnectZoom}
                  loading={zoomActionLoading}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={Video}
                onClick={handleConnectZoom}
                loading={zoomActionLoading}
                className="bg-blue-600 hover:bg-blue-700 focus:ring-blue-500 shadow-blue-200"
              >
                Connect Zoom
              </Button>
            )}
          </div>
        </div>

        {zoomStatus.connected && (
          <div className="p-4 rounded-2xl bg-blue-50/50 border border-blue-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="space-y-1">
              <span className="text-slate-500 font-medium block">Authorized Zoom Account:</span>
              <span className="text-slate-900 font-semibold">{zoomStatus.email || 'Zoom User'}</span>
            </div>
            <div className="text-slate-500">
              <span>Ready to import recordings from your Zoom Cloud.</span>
            </div>
          </div>
        )}

        {!zoomStatus.connected && !zoomLoading && (
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-100 text-xs text-slate-600 leading-relaxed">
            <p>
              Connecting Zoom will allow Meeting Summarizer to retrieve your cloud meeting transcripts and audio files for AI analysis. You can disconnect at any time.
            </p>
          </div>
        )}
      </div>

      {/* Password Management */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900">Change Password</h3>
            <p className="text-xs text-slate-500">Update your account password</p>
          </div>
        </div>

        {passwordError && (
          <div className="flex items-start gap-2.5 p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{passwordError}</span>
          </div>
        )}

        {passwordSuccess && (
          <div className="flex items-start gap-2.5 p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
            <span>{passwordSuccess}</span>
          </div>
        )}

        <form onSubmit={handlePasswordChange} className="space-y-4 max-w-md">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              New Password (min 6 chars)
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                <Lock className="w-4 h-4" />
              </div>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                placeholder="••••••••"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Confirm New Password
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                <Lock className="w-4 h-4" />
              </div>
              <input
                type="password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                placeholder="••••••••"
              />
            </div>
          </div>

          <Button
            type="submit"
            variant="primary"
            loading={passwordLoading}
          >
            Update Password
          </Button>
        </form>
      </div>

      {/* Sign Out Card */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-slate-900">Sign Out</h3>
          <p className="text-xs text-slate-500">Sign out of your account on this device</p>
        </div>
        <Button
          variant="danger"
          icon={LogOut}
          onClick={handleLogout}
        >
          Sign Out
        </Button>
      </div>
    </div>
  );
};
