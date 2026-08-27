import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { 
  Radio, 
  Sparkles, 
  CheckCircle2, 
  Clock, 
  Users, 
  FileText, 
  CheckSquare, 
  Lightbulb, 
  AlertTriangle, 
  HelpCircle, 
  StopCircle, 
  RefreshCw, 
  Video, 
  ExternalLink,
  Search,
  ArrowDown,
  ShieldCheck,
  Tag
} from 'lucide-react';
import { api, getWebSocketUrl } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';
import { Button } from '../components/Button';
import { LoadingState } from '../components/LoadingState';
import { ErrorMessage } from '../components/ErrorMessage';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

export const LiveMeetingPage = () => {
  const { sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const { showSuccess, showError, showInfo } = useToast();

  // Session & Connection State
  const [zoomStatus, setZoomStatus] = useState({ configured: true, connected: false, email: null });
  const [zoomChecking, setZoomChecking] = useState(true);
  const [session, setSession] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // connecting | waiting | live | processing | reconnecting | completed | error
  const [statusMessage, setStatusMessage] = useState('Connecting to live meeting service...');

  // Live Data State
  const [transcriptChunks, setTranscriptChunks] = useState([]);
  const [insights, setInsights] = useState({
    summary: '',
    key_points: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    topics: [],
    risks: [],
  });

  // UI State
  const [meetingDuration, setMeetingDuration] = useState(0);
  const [activeTab, setActiveTab] = useState('insights'); // 'insights' | 'transcript' | 'action_items'
  const [autoScroll, setAutoScroll] = useState(true);
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [showStopModal, setShowStopModal] = useState(false);

  // References
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const isMountedRef = useRef(true);
  const durationTimerRef = useRef(null);
  const transcriptEndRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  // 1. Initial Zoom check and active session resolution
  useEffect(() => {
    isMountedRef.current = true;
    initLiveSession();
    return () => {
      isMountedRef.current = false;
      cleanupWebSocket();
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    };
  }, [routeSessionId]);

  const initLiveSession = async () => {
    setZoomChecking(true);
    try {
      // Check Zoom connection status
      const statusRes = await api.getZoomStatus();
      if (!isMountedRef.current) return;
      setZoomStatus(statusRes.data);

      if (!statusRes.data?.connected) {
        setConnectionStatus('error');
        setStatusMessage('Zoom is not connected. Please connect your Zoom account first.');
        setZoomChecking(false);
        return;
      }

      // Check if session ID was given or retrieve/create active live session
      let targetSession = null;
      if (routeSessionId) {
        const sessRes = await api.getLiveSession(routeSessionId);
        targetSession = sessRes.data;
      } else {
        const activeRes = await api.getActiveLiveSession();
        if (activeRes.data?.is_active && activeRes.data?.session) {
          targetSession = activeRes.data.session;
        } else {
          // Initialize a waiting live session
          const createRes = await api.createLiveSession({
            title: 'Live Zoom Meeting',
            zoom_meeting_id: 'live_stream',
          });
          targetSession = createRes.data;
        }
      }

      if (targetSession && isMountedRef.current) {
        setSession(targetSession);
        if (targetSession.current_insights) {
          setInsights(targetSession.current_insights);
        }
        if (targetSession.status === 'completed' && targetSession.final_meeting_id) {
          navigate(`/meetings/${targetSession.final_meeting_id}`);
          return;
        }
        
        // Fetch existing transcript chunks
        try {
          const tRes = await api.getLiveTranscript(targetSession.id);
          if (tRes.data?.chunks && isMountedRef.current) {
            setTranscriptChunks(tRes.data.chunks);
          }
        } catch (e) {
          console.warn('Could not preload transcript chunks:', e);
        }

        // Establish real-time WebSocket connection
        connectWebSocket(targetSession.id);
      }
    } catch (err) {
      if (isMountedRef.current) {
        console.error('Error initializing live session:', err);
        setConnectionStatus('error');
        setStatusMessage(err.userMessage || 'Could not load live meeting session.');
      }
    } finally {
      if (isMountedRef.current) {
        setZoomChecking(false);
      }
    }
  };

  // 2. Real-Time WebSocket Connection & Message Dispatcher
  const connectWebSocket = async (sessionId) => {
    cleanupWebSocket();
    if (!isMountedRef.current) return;

    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      const token = authSession?.access_token;
      if (!token) {
        if (isMountedRef.current) {
          setConnectionStatus('error');
          setStatusMessage('Authentication session expired. Please log in again.');
        }
        return;
      }

      const wsUrl = getWebSocketUrl(sessionId, token);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMountedRef.current) {
          try { ws.close(); } catch (e) {}
          return;
        }
        console.log('[Live WS] Connected to live session stream:', sessionId);
        reconnectAttemptsRef.current = 0;
        setConnectionStatus((prev) => (prev === 'live' ? 'live' : 'waiting'));
        setStatusMessage('Connected to live meeting stream.');

        // Start heartbeat ping every 15s to keep WebSocket alive through proxies (Render/Cloudflare)
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setInterval(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(JSON.stringify({ action: 'ping' }));
            } catch (e) {
              console.warn('[Live WS] Ping send error:', e);
            }
          }
        }, 15000);
      };

      ws.onmessage = (event) => {
        if (!isMountedRef.current) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'pong') {
            // Heartbeat response from server
            return;
          }
          handleWebSocketMessage(payload);
        } catch (e) {
          console.error('[Live WS] Failed to parse message:', e);
        }
      };

      ws.onclose = (event) => {
        console.log('[Live WS] Connection closed:', event.code, event.reason);
        if (heartbeatTimerRef.current) {
          clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }
        if (isMountedRef.current && !isFinalizing && connectionStatus !== 'completed') {
          handleWebSocketReconnect(sessionId);
        }
      };

      ws.onerror = (error) => {
        console.error('[Live WS] Error encountered:', error);
      };
    } catch (err) {
      console.error('[Live WS] Connection setup failed:', err);
      if (isMountedRef.current) {
        handleWebSocketReconnect(sessionId);
      }
    }
  };

  const handleWebSocketMessage = (payload) => {
    const { type, data } = payload;

    if (type === 'init') {
      if (data.status) {
        setConnectionStatus(data.status);
      }
      if (data.insights) {
        setInsights(data.insights);
      }
      if (data.chunks) {
        setTranscriptChunks(data.chunks);
      }
      if (data.final_meeting_id) {
        showSuccess('Meeting complete! Redirecting to summary...');
        navigate(`/meetings/${data.final_meeting_id}`);
      }
    } else if (type === 'status') {
      setConnectionStatus(data.status);
      if (data.status === 'live') {
        setStatusMessage('Live stream active. Receiving meeting data...');
      } else if (data.status === 'processing') {
        setStatusMessage('Meeting ended. Generating final AI summary...');
      } else if (data.status === 'disconnected') {
        setStatusMessage('Zoom RTMS stream paused or disconnected.');
      }
    } else if (type === 'transcript') {
      if (data.chunk) {
        setTranscriptChunks((prev) => {
          // Avoid duplicate chunk insertion
          const exists = prev.some((c) => c.chunk_hash && c.chunk_hash === data.chunk.chunk_hash);
          if (exists) return prev;
          return [...prev, data.chunk];
        });
        if (connectionStatus !== 'live') {
          setConnectionStatus('live');
        }
      }
    } else if (type === 'insights') {
      if (data.insights) {
        setInsights(data.insights);
      }
    } else if (type === 'meeting_ended') {
      setConnectionStatus('completed');
      showSuccess('Meeting ended and summary saved to History!', 'Meeting Complete');
      if (data.final_meeting_id) {
        setTimeout(() => {
          navigate(`/meetings/${data.final_meeting_id}`);
        }, 1200);
      }
    } else if (type === 'error') {
      showError(data.message || 'An error occurred during live meeting processing.');
    }
  };

  const handleWebSocketReconnect = (sessionId) => {
    if (!isMountedRef.current) return;

    if (reconnectAttemptsRef.current >= 8) {
      setConnectionStatus('error');
      setStatusMessage('Connection lost. Please refresh the page to reconnect.');
      return;
    }

    setConnectionStatus('reconnecting');
    setStatusMessage('Connection interrupted. Reconnecting...');

    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttemptsRef.current), 10000);
    reconnectAttemptsRef.current += 1;

    reconnectTimeoutRef.current = setTimeout(async () => {
      if (!isMountedRef.current) return;
      // Re-fetch latest session state from REST before reconnecting WebSocket
      try {
        const res = await api.getLiveSession(sessionId);
        if (res.data?.current_insights && isMountedRef.current) {
          setInsights(res.data.current_insights);
        }
        const tRes = await api.getLiveTranscript(sessionId);
        if (tRes.data?.chunks && isMountedRef.current) {
          setTranscriptChunks(tRes.data.chunks);
        }
      } catch (e) {
        console.warn('State sync during reconnect:', e);
      }
      connectWebSocket(sessionId);
    }, delay);
  };

  const cleanupWebSocket = () => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null; // Suppress onclose trigger during cleanup
      try {
        ws.close();
      } catch (e) {
        // ignore
      }
    }
  };

  // 3. Duration Timer when LIVE
  useEffect(() => {
    if (connectionStatus === 'live') {
      durationTimerRef.current = setInterval(() => {
        setMeetingDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    }

    return () => {
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, [connectionStatus]);

  // 4. Auto-scroll transcript
  useEffect(() => {
    if (autoScroll && transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcriptChunks, autoScroll]);

  // 5. Connect Zoom Handler
  const handleConnectZoom = async () => {
    try {
      const res = await api.getZoomConnectUrl();
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (err) {
      showError(err.userMessage || 'Failed to obtain Zoom connect URL.');
    }
  };

  // 6. Stop & Finalize Meeting
  const handleStopMeeting = async () => {
    if (!session?.id) return;
    setIsFinalizing(true);
    setShowStopModal(false);
    setConnectionStatus('processing');
    setStatusMessage('Finalizing summary and saving meeting to history...');

    try {
      const res = await api.stopLiveSession(session.id);
      showInfo(res.data?.message || 'Finalizing meeting summary with Gemini...');
    } catch (err) {
      console.error('Error stopping live session:', err);
      showError(err.userMessage || 'Failed to stop live session.');
      setIsFinalizing(false);
    }
  };

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const filteredChunks = transcriptChunks.filter((chunk) => {
    if (!transcriptSearch.trim()) return true;
    const query = transcriptSearch.toLowerCase();
    return (
      (chunk.speaker_name && chunk.speaker_name.toLowerCase().includes(query)) ||
      (chunk.text && chunk.text.toLowerCase().includes(query))
    );
  });

  // Calculate unique speakers
  const uniqueSpeakers = Array.from(new Set(transcriptChunks.map((c) => c.speaker_name || 'Speaker')));

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Top Banner & Status Controls */}
      <div className="bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2.5">
              <span>{session?.title || 'Live Zoom Meeting'}</span>
            </h1>

            {/* Pulsing Status Badge */}
            {connectionStatus === 'live' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 animate-pulse">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                LIVE
              </span>
            )}
            {connectionStatus === 'waiting' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping"></span>
                WAITING FOR ZOOM
              </span>
            )}
            {connectionStatus === 'processing' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-600" />
                FINALIZING AI SUMMARY
              </span>
            )}
            {connectionStatus === 'reconnecting' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                RECONNECTING
              </span>
            )}
          </div>

          <p className="text-xs text-slate-500">
            {statusMessage}
          </p>
        </div>

        {/* Live Metrics & Actions */}
        <div className="flex flex-wrap items-center gap-3">
          {connectionStatus === 'live' && (
            <div className="flex items-center gap-4 bg-slate-50 px-4 py-2 rounded-2xl border border-slate-200/80 text-xs font-semibold text-slate-700">
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-slate-400" />
                <span className="font-mono text-sm text-slate-900">{formatDuration(meetingDuration)}</span>
              </div>
              <div className="h-4 w-px bg-slate-200"></div>
              <div className="flex items-center gap-1.5">
                <Users className="w-4 h-4 text-slate-400" />
                <span>{uniqueSpeakers.length || 1} Speaker{uniqueSpeakers.length > 1 ? 's' : ''}</span>
              </div>
            </div>
          )}

          {connectionStatus === 'live' && (
            <Button
              variant="danger"
              size="sm"
              icon={StopCircle}
              onClick={() => setShowStopModal(true)}
              loading={isFinalizing}
            >
              End & Finalize Meeting
            </Button>
          )}

          {connectionStatus === 'waiting' && (
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              onClick={() => initLiveSession()}
            >
              Refresh Status
            </Button>
          )}
        </div>
      </div>

      {/* Disconnected / Zoom Not Configured State */}
      {zoomChecking ? (
        <LoadingState message="Checking Zoom authorization..." />
      ) : !zoomStatus.connected ? (
        <div className="bg-white p-8 sm:p-12 rounded-3xl border border-slate-200/80 shadow-xs text-center space-y-6 max-w-xl mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto shadow-sm">
            <Video className="w-8 h-8" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-slate-900">
              Connect Zoom to Start Live Summaries
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Live Zoom Meeting Summarization requires your Zoom account to be connected. Once connected, start or join any Zoom meeting and live AI intelligence will stream here in real time.
            </p>
          </div>
          <Button
            variant="primary"
            size="lg"
            icon={Video}
            onClick={handleConnectZoom}
            className="bg-blue-600 hover:bg-blue-700 focus:ring-blue-500 shadow-blue-200"
          >
            Connect Zoom Account
          </Button>
        </div>
      ) : connectionStatus === 'waiting' && transcriptChunks.length === 0 ? (
        /* Waiting for Zoom RTMS stream to start */
        <div className="bg-white p-8 sm:p-12 rounded-3xl border border-slate-200/80 shadow-xs text-center space-y-6 max-w-2xl mx-auto">
          <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-indigo-100 animate-ping opacity-60"></div>
            <div className="relative w-16 h-16 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-200">
              <Radio className="w-8 h-8 animate-pulse" />
            </div>
          </div>

          <div className="space-y-2 max-w-md mx-auto">
            <h2 className="text-xl font-bold text-slate-900">
              Waiting for Live Zoom Meeting...
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Your Zoom account (<span className="font-semibold text-slate-700">{zoomStatus.email || 'Connected'}</span>) is ready. Start or join a meeting in Zoom with RTMS/Captions enabled.
            </p>
          </div>

          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 max-w-md mx-auto text-left space-y-2 text-xs text-slate-600">
            <div className="flex items-center gap-2 font-bold text-slate-800">
              <Sparkles className="w-4 h-4 text-indigo-600" />
              <span>How it works:</span>
            </div>
            <ol className="list-decimal list-inside space-y-1 text-slate-500">
              <li>Open Zoom and start or join your meeting.</li>
              <li>Zoom RTMS streams live transcript data to your backend.</li>
              <li>Gemini analyzes spoken dialogue incrementally in real time.</li>
              <li>Live summary, decisions, and action items appear on this screen.</li>
            </ol>
          </div>
        </div>
      ) : (
        /* Main Live Dual-Panel Interface */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Live Transcript Stream (5 cols) */}
          <div className="lg:col-span-5 bg-white rounded-3xl border border-slate-200/80 shadow-xs flex flex-col h-[650px] overflow-hidden">
            {/* Transcript Header */}
            <div className="p-4 sm:px-5 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-600" />
                <h2 className="text-sm font-bold text-slate-900">Live Transcript</h2>
                <span className="text-[11px] font-semibold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                  {transcriptChunks.length} chunks
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAutoScroll(!autoScroll)}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border transition-all cursor-pointer flex items-center gap-1 ${
                    autoScroll
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                      : 'bg-white border-slate-200 text-slate-500'
                  }`}
                  title="Auto-scroll as new speech arrives"
                >
                  <ArrowDown className="w-3 h-3" />
                  <span>Auto-scroll</span>
                </button>
              </div>
            </div>

            {/* Search within transcript */}
            {transcriptChunks.length > 5 && (
              <div className="p-2.5 border-b border-slate-100 bg-white">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={transcriptSearch}
                    onChange={(e) => setTranscriptSearch(e.target.value)}
                    placeholder="Search spoken transcript..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>
            )}

            {/* Spoken Dialogues List */}
            <div className="flex-1 p-4 sm:p-5 overflow-y-auto space-y-4 font-sans">
              {filteredChunks.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-2">
                  <Radio className="w-6 h-6 animate-pulse text-indigo-400" />
                  <p className="text-xs">Listening for spoken dialogue...</p>
                </div>
              ) : (
                filteredChunks.map((chunk, idx) => (
                  <div key={chunk.chunk_hash || idx} className="space-y-1 animate-fadeIn">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-slate-900 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                        {chunk.speaker_name || 'Speaker'}
                      </span>
                      <span className="text-slate-400 font-mono">
                        {chunk.start_time || ''}
                      </span>
                    </div>
                    <div className="p-3 bg-slate-50 rounded-2xl border border-slate-100/80 text-xs text-slate-800 leading-relaxed">
                      {chunk.text}
                    </div>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Right Column: Live AI Intelligence (7 cols) */}
          <div className="lg:col-span-7 space-y-5">
            {/* Live Summary Card */}
            <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">Live Executive Summary</h2>
                    <p className="text-[11px] text-slate-400">Incrementally updated by Gemini AI</p>
                  </div>
                </div>
              </div>

              <div className="p-4 bg-indigo-50/40 rounded-2xl border border-indigo-100/70 text-xs text-slate-800 leading-relaxed">
                {insights.summary ? (
                  <p>{insights.summary}</p>
                ) : (
                  <span className="text-slate-400 italic">
                    AI summary will formulate as the meeting progresses...
                  </span>
                )}
              </div>
            </div>

            {/* Key Decisions & Key Points */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {/* Decisions */}
              <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
                <div className="flex items-center gap-2 text-slate-900">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Key Decisions</h3>
                </div>
                {insights.decisions?.length > 0 ? (
                  <ul className="space-y-2">
                    {insights.decisions.map((decision, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-xs text-slate-700 leading-normal">
                        <span className="text-emerald-500 font-bold">✓</span>
                        <span>{decision}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-400 italic">No formal decisions detected yet.</p>
                )}
              </div>

              {/* Key Discussion Points */}
              <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
                <div className="flex items-center gap-2 text-slate-900">
                  <Lightbulb className="w-4 h-4 text-amber-500" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Key Takeaways</h3>
                </div>
                {insights.key_points?.length > 0 ? (
                  <ul className="space-y-2">
                    {insights.key_points.map((point, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-xs text-slate-700 leading-normal">
                        <span className="text-amber-500 font-bold">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-400 italic">Key points will appear here.</p>
                )}
              </div>
            </div>

            {/* Live Action Items */}
            <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-xs space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
                    <CheckSquare className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">Extracted Action Items</h2>
                    <p className="text-[11px] text-slate-400">Assigned tasks and deadlines</p>
                  </div>
                </div>
                <span className="text-xs font-bold bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full">
                  {insights.action_items?.length || 0}
                </span>
              </div>

              {insights.action_items?.length > 0 ? (
                <div className="space-y-2.5">
                  {insights.action_items.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-3.5 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-1">
                        <span className="font-bold text-slate-900 block">{item.task}</span>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                          {item.owner && item.owner !== 'Not specified' && (
                            <span className="font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md">
                              👤 {item.owner}
                            </span>
                          )}
                          {item.deadline && item.deadline !== 'No deadline specified' && (
                            <span className="font-semibold text-slate-700 bg-slate-200/70 px-2 py-0.5 rounded-md">
                              ⏰ {item.deadline}
                            </span>
                          )}
                        </div>
                      </div>

                      {item.priority && item.priority !== 'Not specified' && (
                        <span className={`self-start sm:self-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                          item.priority.toLowerCase() === 'high'
                            ? 'bg-rose-50 text-rose-700 border border-rose-200'
                            : 'bg-slate-100 text-slate-700'
                        }`}>
                          {item.priority}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400 italic">No action items detected yet.</p>
              )}
            </div>

            {/* Topics, Questions & Risks */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {/* Topics */}
              <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
                <div className="flex items-center gap-2 text-slate-900">
                  <Tag className="w-4 h-4 text-indigo-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Discussion Topics</h3>
                </div>
                {insights.topics?.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {insights.topics.map((topic, idx) => (
                      <span
                        key={idx}
                        className="text-xs font-semibold px-2.5 py-1 rounded-xl bg-slate-100 text-slate-800 border border-slate-200/60"
                      >
                        {topic}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 italic">Topics will appear here.</p>
                )}
              </div>

              {/* Open Questions or Risks */}
              <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
                <div className="flex items-center gap-2 text-slate-900">
                  <HelpCircle className="w-4 h-4 text-purple-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Open Questions</h3>
                </div>
                {insights.open_questions?.length > 0 ? (
                  <ul className="space-y-1.5">
                    {insights.open_questions.map((q, idx) => (
                      <li key={idx} className="text-xs text-purple-900 bg-purple-50 p-2 rounded-xl border border-purple-100">
                        ❓ {q}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-400 italic">No unresolved questions open.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal to Stop Live Meeting */}
      {showStopModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl border border-slate-100 space-y-5">
            <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
              <StopCircle className="w-6 h-6" />
            </div>

            <div className="text-center space-y-1.5">
              <h3 className="text-lg font-bold text-slate-900">
                End & Finalize Meeting Summary?
              </h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                This will finalize the live stream, generate the consolidated Gemini summary and action items, and save the meeting permanently to your History.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowStopModal(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={StopCircle}
                onClick={handleStopMeeting}
                loading={isFinalizing}
              >
                End Meeting
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
