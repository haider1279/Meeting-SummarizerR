import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  Sparkles, 
  Calendar, 
  Users, 
  Type, 
  ArrowRight,
  RefreshCw,
  UploadCloud,
  Video,
  Radio,
  FileText,

  Clock,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Volume2,
  HelpCircle
} from 'lucide-react';
import { api } from '../lib/apiClient';
import { Button } from '../components/Button';
import { UploadArea } from '../components/UploadArea';
import { ProgressIndicator } from '../components/ProgressIndicator';
import { LoadingState } from '../components/LoadingState';
import { ErrorMessage } from '../components/ErrorMessage';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

export const UploadPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { showSuccess, showError } = useToast();

  // Tab State: 'upload' | 'zoom'
  const [activeSourceTab, setActiveSourceTab] = useState('upload');

  // File Upload Form State
  const [title, setTitle] = useState('');
  const [meetingDate, setMeetingDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [participants, setParticipants] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  
  // Processing & Polling State
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [processingStatus, setProcessingStatus] = useState('idle'); // idle | uploading | processing | completed | failed
  const [errorMessage, setErrorMessage] = useState('');
  const [meetingId, setMeetingId] = useState(null);

  // Zoom Tab State
  const [zoomStatus, setZoomStatus] = useState({ configured: true, connected: false, email: null });
  const [zoomLoading, setZoomLoading] = useState(false);
  const [zoomRecordings, setZoomRecordings] = useState([]);
  const [zoomRecordingsLoading, setZoomRecordingsLoading] = useState(false);
  const [zoomRecordingsError, setZoomRecordingsError] = useState('');
  const [summarizingUuid, setSummarizingUuid] = useState(null);

  const pollIntervalRef = useRef(null);

  // Check URL query params for initial tab selection
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('tab') === 'zoom') {
      setActiveSourceTab('zoom');
    }
  }, [location.search]);

  // Load Zoom status & recordings when Zoom tab is selected
  useEffect(() => {
    if (activeSourceTab === 'zoom') {
      loadZoomData();
    }
  }, [activeSourceTab]);

  const loadZoomData = async () => {
    setZoomLoading(true);
    setZoomRecordingsError('');
    try {
      const statusRes = await api.getZoomStatus();
      setZoomStatus(statusRes.data);

      if (statusRes.data?.connected) {
        await fetchZoomRecordings();
      }
    } catch (err) {
      console.error('Error fetching Zoom data:', err);
      setZoomRecordingsError(err.userMessage || 'Failed to check Zoom status.');
    } finally {
      setZoomLoading(false);
    }
  };

  const fetchZoomRecordings = async () => {
    setZoomRecordingsLoading(true);
    setZoomRecordingsError('');
    try {
      const res = await api.getZoomRecordings();
      setZoomRecordings(res.data?.recordings || []);
    } catch (err) {
      console.error('Error loading Zoom recordings:', err);
      setZoomRecordingsError(err.userMessage || 'Could not load Zoom cloud recordings.');
    } finally {
      setZoomRecordingsLoading(false);
    }
  };

  // Poll meeting status when meetingId is set
  useEffect(() => {
    if (!meetingId || processingStatus === 'completed' || processingStatus === 'failed') {
      return;
    }

    const checkStatus = async () => {
      try {
        const res = await api.getMeeting(meetingId);
        const meeting = res.data;

        if (meeting.status === 'processing') {
          setProcessingStatus('processing');
          setCurrentStep((prev) => (prev < 3 ? prev + 1 : 3));
        } else if (meeting.status === 'completed') {
          setCurrentStep(4);
          setProcessingStatus('completed');
          clearInterval(pollIntervalRef.current);
          showSuccess('Meeting analysis completed!', 'Success');
          setTimeout(() => {
            navigate(`/meetings/${meetingId}`);
          }, 1200);
        } else if (meeting.status === 'failed') {
          setProcessingStatus('failed');
          setErrorMessage(meeting.error_message || 'AI processing encountered an error.');
          clearInterval(pollIntervalRef.current);
          showError(meeting.error_message || 'Meeting processing failed.', 'Processing Error');
        }
      } catch (err) {
        console.error('Error polling meeting status:', err);
      }
    };

    pollIntervalRef.current = setInterval(checkStatus, 3500);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [meetingId, processingStatus, navigate, showSuccess, showError]);

  // Standard File Upload Submit
  const handleFileUploadSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) {
      showError('Please enter a meeting title.');
      return;
    }
    if (!audioFile) {
      showError('Please select an audio file (MP3, WAV, or M4A).');
      return;
    }

    setIsProcessing(true);
    setProcessingStatus('uploading');
    setCurrentStep(1);
    setErrorMessage('');

    const formData = new FormData();
    formData.append('title', title.trim());
    if (meetingDate) formData.append('meeting_date', meetingDate);
    if (participants.trim()) formData.append('participants', participants.trim());
    formData.append('audio_file', audioFile);

    try {
      const response = await api.uploadMeeting(formData);
      const newMeetingId = response.data.id;
      setMeetingId(newMeetingId);
      setCurrentStep(2);
      setProcessingStatus('processing');
    } catch (err) {
      console.error('Upload failed:', err);
      setIsProcessing(false);
      setProcessingStatus('idle');
      showError(err.userMessage || 'Failed to upload audio file. Please try again.');
    }
  };

  // Zoom Recording Summarize Trigger
  const handleSummarizeZoomRecording = async (recording) => {
    if (recording.already_imported && recording.imported_meeting_id) {
      navigate(`/meetings/${recording.imported_meeting_id}`);
      return;
    }

    setSummarizingUuid(recording.uuid);
    setErrorMessage('');

    try {
      const res = await api.summarizeZoomRecording(recording.uuid);
      const newMeetingId = res.data.id;

      if (res.data.already_summarized) {
        showSuccess('Opening already summarized meeting...');
        navigate(`/meetings/${newMeetingId}`);
        return;
      }

      setIsProcessing(true);
      setMeetingId(newMeetingId);
      setCurrentStep(2);
      setProcessingStatus('processing');
    } catch (err) {
      console.error('Error initiating Zoom summarization:', err);
      showError(err.userMessage || 'Failed to start Zoom summarization.');
      setSummarizingUuid(null);
    }
  };

  // Connect Zoom Handler
  const handleConnectZoom = async () => {
    try {
      const res = await api.getZoomConnectUrl();
      if (res.data?.url) {
        window.location.href = res.data.url;
      } else {
        showError('Could not obtain Zoom authorization URL.');
      }
    } catch (err) {
      showError(err.userMessage || 'Failed to connect Zoom.');
    }
  };

  const handleReset = () => {
    setIsProcessing(false);
    setProcessingStatus('idle');
    setMeetingId(null);
    setCurrentStep(1);
    setErrorMessage('');
    setSummarizingUuid(null);
  };

  const formatStartTime = (dateStr) => {
    if (!dateStr) return 'Unknown date';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
          New Meeting Summary
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Upload an audio recording or import directly from your Zoom Cloud to generate AI summaries and action items.
        </p>
      </div>

      {isProcessing ? (
        <div className="py-8 space-y-6">
          <ProgressIndicator
            currentStep={currentStep}
            status={processingStatus}
            errorMessage={errorMessage}
          />

          {processingStatus === 'failed' && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                icon={RefreshCw}
                onClick={handleReset}
              >
                Try Again
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Source Tab Switcher */}
          <div className="flex flex-wrap items-center gap-2 p-1.5 bg-slate-200/60 rounded-2xl w-fit">
            <button
              type="button"
              onClick={() => setActiveSourceTab('upload')}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                activeSourceTab === 'upload'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <UploadCloud className="w-4 h-4 text-indigo-600" />
              <span>Upload Audio File</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSourceTab('zoom')}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                activeSourceTab === 'zoom'
                  ? 'bg-white text-blue-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Video className="w-4 h-4 text-blue-600" />
              <span>Zoom Cloud Recordings</span>
              {zoomStatus.connected && (
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              )}
            </button>

            <button
              type="button"
              onClick={() => navigate('/live')}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer text-slate-600 hover:text-slate-900"
            >
              <Radio className="w-4 h-4 text-emerald-600" />
              <span>Live Zoom Meeting</span>
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            </button>
          </div>


          {/* TAB 1: File Upload Form */}
          {activeSourceTab === 'upload' && (
            <form onSubmit={handleFileUploadSubmit} className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs space-y-6">
              {/* Title */}
              <div>
                <label className="block text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">
                  Meeting Title <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                    <Type className="w-4 h-4" />
                  </div>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Q3 Product Roadmap & Engineering Sync"
                    className="block w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                {/* Meeting Date */}
                <div>
                  <label className="block text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">
                    Meeting Date
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Calendar className="w-4 h-4" />
                    </div>
                    <input
                      type="date"
                      value={meetingDate}
                      onChange={(e) => setMeetingDate(e.target.value)}
                      className="block w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                  </div>
                </div>

                {/* Participants */}
                <div>
                  <label className="block text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">
                    Participants (Optional)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Users className="w-4 h-4" />
                    </div>
                    <input
                      type="text"
                      value={participants}
                      onChange={(e) => setParticipants(e.target.value)}
                      placeholder="e.g. Alice, Bob, Carlos"
                      className="block w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                    />
                  </div>
                </div>
              </div>

              {/* Audio Upload Area */}
              <div>
                <label className="block text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">
                  Audio File <span className="text-rose-500">*</span>
                </label>
                <UploadArea
                  file={audioFile}
                  onFileSelect={(file) => setAudioFile(file)}
                  onFileRemove={() => setAudioFile(null)}
                />
              </div>

              {/* Submit Button */}
              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  icon={Sparkles}
                  className="w-full sm:w-auto"
                >
                  Analyze Meeting with Gemini
                </Button>
              </div>
            </form>
          )}

          {/* TAB 2: Zoom Cloud Recordings */}
          {activeSourceTab === 'zoom' && (
            <div className="space-y-4">
              {zoomLoading ? (
                <LoadingState message="Checking Zoom authorization..." />
              ) : !zoomStatus.connected ? (
                /* Disconnected Prompt */
                <div className="bg-white p-8 sm:p-10 rounded-3xl border border-slate-200/80 shadow-xs text-center space-y-5">
                  <div className="w-16 h-16 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto shadow-sm">
                    <Video className="w-8 h-8" />
                  </div>
                  <div className="max-w-md mx-auto space-y-1">
                    <h2 className="text-lg font-bold text-slate-900">
                      Connect your Zoom Account
                    </h2>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Authorize your personal Zoom account to view and automatically summarize your cloud recordings and transcripts.
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    size="lg"
                    icon={Video}
                    onClick={handleConnectZoom}
                    className="bg-blue-600 hover:bg-blue-700 focus:ring-blue-500 shadow-blue-200"
                  >
                    Connect Zoom
                  </Button>
                </div>
              ) : (
                /* Connected: List Zoom Recordings */
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 sm:px-6 rounded-2xl border border-slate-200/80">
                    <div className="flex items-center gap-2.5">
                      <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                      <span className="text-xs font-semibold text-slate-700">
                        Connected as <span className="font-bold text-slate-900">{zoomStatus.email || 'Zoom User'}</span>
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={RefreshCw}
                      onClick={fetchZoomRecordings}
                      loading={zoomRecordingsLoading}
                    >
                      Refresh Recordings
                    </Button>
                  </div>

                  {zoomRecordingsError && (
                    <ErrorMessage
                      title="Could not load Zoom recordings"
                      message={zoomRecordingsError}
                      onRetry={fetchZoomRecordings}
                    />
                  )}

                  {zoomRecordingsLoading ? (
                    <LoadingState message="Fetching your Zoom cloud recordings..." />
                  ) : zoomRecordings.length > 0 ? (
                    <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs overflow-hidden divide-y divide-slate-100">
                      {zoomRecordings.map((rec) => (
                        <div
                          key={rec.uuid}
                          className="p-5 sm:p-6 hover:bg-slate-50/70 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                        >
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2.5">
                              <h3 className="text-base font-bold text-slate-900 truncate">
                                {rec.topic || 'Untitled Zoom Meeting'}
                              </h3>
                              {rec.already_imported && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                  Summarized
                                </span>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                              <div className="flex items-center gap-1.5">
                                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                                <span>{formatStartTime(rec.start_time)}</span>
                              </div>

                              {rec.duration > 0 && (
                                <div className="flex items-center gap-1.5">
                                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                                  <span>{rec.duration} mins</span>
                                </div>
                              )}

                              {rec.has_transcript ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md">
                                  <FileText className="w-3 h-3 text-indigo-600" />
                                  Transcript Available
                                </span>
                              ) : rec.has_audio ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">
                                  <Volume2 className="w-3 h-3 text-slate-500" />
                                  Audio Available
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">
                                  <HelpCircle className="w-3 h-3 text-amber-600" />
                                  No transcript or audio
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                            {rec.already_imported ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                icon={ExternalLink}
                                onClick={() => navigate(`/meetings/${rec.imported_meeting_id}`)}
                              >
                                View Summary
                              </Button>
                            ) : rec.can_summarize ? (
                              <Button
                                variant="primary"
                                size="sm"
                                icon={Sparkles}
                                onClick={() => handleSummarizeZoomRecording(rec)}
                                loading={summarizingUuid === rec.uuid}
                              >
                                Summarize
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled
                                className="text-xs text-slate-400"
                              >
                                Unavailable
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      icon={Video}
                      title="No cloud recordings found"
                      description="You do not have any cloud recordings in your connected Zoom account. Start a meeting in Zoom with Cloud Recording enabled, then click Refresh."
                      actionLabel="Refresh Recordings"
                      onAction={fetchZoomRecordings}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
