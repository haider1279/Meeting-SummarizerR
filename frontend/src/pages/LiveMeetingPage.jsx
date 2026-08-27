import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  Mic,
  MonitorSpeaker,
  ExternalLink,
  Search,
  ArrowDown,
  ShieldCheck,
  Tag,
  Globe,
  Info,
} from 'lucide-react';
import { api, getWebSocketUrl, getGoogleMeetWebSocketUrl } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';
import { Button } from '../components/Button';
import { LoadingState } from '../components/LoadingState';
import { ErrorMessage } from '../components/ErrorMessage';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';

// ─── Source identifier constants ────────────────────────────────────────────
const SOURCE_ZOOM = 'zoom_rtms';
const SOURCE_GOOGLE_MEET = 'google_meet';

// ─── Check browser support for getDisplayMedia tab-audio capture ────────────
const isTabCaptureSupported = () =>
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export const LiveMeetingPage = () => {
  const { sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const { showSuccess, showError, showInfo } = useToast();

  // ── Source selection ──────────────────────────────────────────────────────
  const [source, setSource] = useState(SOURCE_GOOGLE_MEET);

  // ── Session & Connection State ────────────────────────────────────────────
  const [zoomStatus, setZoomStatus] = useState({ configured: true, connected: false, email: null });
  const [zoomChecking, setZoomChecking] = useState(false);
  const [session, setSession] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('idle');
  // idle | connecting | waiting | capturing | live | processing | reconnecting | completed | error
  const [statusMessage, setStatusMessage] = useState('');

  // ── Live Data State ───────────────────────────────────────────────────────
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

  // ── UI State ──────────────────────────────────────────────────────────────
  const [meetingDuration, setMeetingDuration] = useState(0);
  const [activeTab, setActiveTab] = useState('insights');
  const [autoScroll, setAutoScroll] = useState(true);
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [showStopModal, setShowStopModal] = useState(false);
  const [sttConfigured, setSttConfigured] = useState(true);

  // ── Browser capture state ─────────────────────────────────────────────────
  const [isCaptureActive, setIsCaptureActive] = useState(false);
  const [captureError, setCaptureError] = useState(null);

  // ── References ────────────────────────────────────────────────────────────
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const isMountedRef = useRef(true);
  const durationTimerRef = useRef(null);
  const transcriptEndRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  // Google Meet capture refs
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const isIntentionalStopRef = useRef(false); // prevents reconnect on deliberate stop

  // ============================================================
  // Lifecycle: mount / unmount
  // ============================================================
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanupWebSocket();
      stopBrowserCapture(true);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================================================
  // Auto-scroll transcript
  // ============================================================
  useEffect(() => {
    if (autoScroll && transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcriptChunks, autoScroll]);

  // ============================================================
  // Duration timer when capturing / live
  // ============================================================
  useEffect(() => {
    if (connectionStatus === 'live' || connectionStatus === 'capturing') {
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

  // ============================================================
  // Route: if a sessionId is given, load it and connect WS
  // ============================================================
  useEffect(() => {
    if (routeSessionId) {
      loadExistingSession(routeSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSessionId]);

  const loadExistingSession = async (sessionId) => {
    if (!isMountedRef.current) return;
    setConnectionStatus('connecting');
    setStatusMessage('Loading session...');
    try {
      // Try Google Meet first, then Zoom RTMS
      let sessRes;
      let detectedSource = SOURCE_GOOGLE_MEET;
      try {
        sessRes = await api.getGoogleMeetSession(sessionId);
      } catch {
        sessRes = await api.getLiveSession(sessionId);
        detectedSource = SOURCE_ZOOM;
      }
      if (!isMountedRef.current) return;
      const sess = sessRes.data;
      setSession(sess);
      setSource(detectedSource);
      if (sess.current_insights) setInsights(sess.current_insights);
      if (sess.status === 'completed' && sess.final_meeting_id) {
        navigate(`/meetings/${sess.final_meeting_id}`);
        return;
      }
      // Load transcript
      try {
        const tRes = detectedSource === SOURCE_GOOGLE_MEET
          ? await api.getGoogleMeetTranscript(sessionId)
          : await api.getLiveTranscript(sessionId);
        if (tRes.data?.chunks && isMountedRef.current) {
          setTranscriptChunks(tRes.data.chunks);
        }
      } catch (e) {
        console.warn('Could not preload transcript:', e);
      }
      connectWebSocket(sessionId, detectedSource);
    } catch (err) {
      if (isMountedRef.current) {
        setConnectionStatus('error');
        setStatusMessage(err.userMessage || 'Session not found.');
      }
    }
  };

  // ============================================================
  // WebSocket helpers (shared by both sources)
  // ============================================================
  const connectWebSocket = useCallback(async (sessionId, sessionSource) => {
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

      const wsUrl = sessionSource === SOURCE_GOOGLE_MEET
        ? getGoogleMeetWebSocketUrl(sessionId, token)
        : getWebSocketUrl(sessionId, token);

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMountedRef.current) { try { ws.close(); } catch (e) {} return; }
        console.log(`[Live WS] Connected to ${sessionSource} session:`, sessionId);
        reconnectAttemptsRef.current = 0;

        if (sessionSource === SOURCE_GOOGLE_MEET) {
          setConnectionStatus('capturing');
          setStatusMessage('Connected. Browser audio is streaming to backend...');
        } else {
          setConnectionStatus((prev) => (prev === 'live' ? 'live' : 'waiting'));
          setStatusMessage('Connected to live meeting stream.');
        }

        // 15-second heartbeat to keep proxies alive
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setInterval(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            try { wsRef.current.send(JSON.stringify({ action: 'ping' })); } catch (e) {}
          }
        }, 15000);
      };

      ws.onmessage = (event) => {
        if (!isMountedRef.current) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'pong') return;
          handleWebSocketMessage(payload);
        } catch (e) {
          console.error('[Live WS] Failed to parse message:', e);
        }
      };

      ws.onclose = (event) => {
        console.log('[Live WS] Connection closed:', event.code, event.reason);
        if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
        // Don't reconnect if it was an intentional stop or already completed
        if (isMountedRef.current && !isIntentionalStopRef.current && !isFinalizing && connectionStatus !== 'completed') {
          handleWebSocketReconnect(sessionId, sessionSource);
        }
      };

      ws.onerror = (error) => {
        console.error('[Live WS] Error:', error);
      };
    } catch (err) {
      console.error('[Live WS] Setup failed:', err);
      if (isMountedRef.current) {
        handleWebSocketReconnect(sessionId, sessionSource);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFinalizing, connectionStatus]);

  const handleWebSocketMessage = (payload) => {
    const { type, data } = payload;

    if (type === 'init') {
      if (data.status) setConnectionStatus(source === SOURCE_GOOGLE_MEET ? 'capturing' : data.status);
      if (data.insights) setInsights(data.insights);
      if (data.chunks) setTranscriptChunks(data.chunks);
      if (data.stt_configured !== undefined) setSttConfigured(data.stt_configured);
      if (data.final_meeting_id) {
        navigate(`/meetings/${data.final_meeting_id}`);
      }
    } else if (type === 'status') {
      const s = data.status;
      setConnectionStatus(source === SOURCE_GOOGLE_MEET && s === 'live' ? 'capturing' : s);
      if (s === 'live' || s === 'capturing') {
        setStatusMessage('Live — receiving audio and generating transcript...');
      } else if (s === 'processing') {
        setStatusMessage('Finalizing AI summary...');
      } else if (s === 'disconnected') {
        setStatusMessage('Audio stream paused.');
      }
    } else if (type === 'transcript') {
      if (data.chunk) {
        setTranscriptChunks((prev) => {
          const exists = prev.some((c) => c.chunk_hash && c.chunk_hash === data.chunk.chunk_hash);
          if (exists) return prev;
          return [...prev, data.chunk];
        });
        if (connectionStatus !== 'live' && connectionStatus !== 'capturing') {
          setConnectionStatus(source === SOURCE_GOOGLE_MEET ? 'capturing' : 'live');
        }
      }
    } else if (type === 'insights') {
      if (data.insights) setInsights(data.insights);
    } else if (type === 'meeting_ended') {
      setConnectionStatus('completed');
      setIsFinalizing(false);
      showSuccess('Meeting ended — summary saved to History!', 'Meeting Complete');
      if (data.final_meeting_id) {
        setTimeout(() => navigate(`/meetings/${data.final_meeting_id}`), 1200);
      }
    } else if (type === 'error') {
      showError(data.message || 'An error occurred during live meeting processing.');
    }
  };

  const handleWebSocketReconnect = (sessionId, sessionSource) => {
    if (!isMountedRef.current) return;
    if (reconnectAttemptsRef.current >= 8) {
      setConnectionStatus('error');
      setStatusMessage('Connection lost. Please refresh the page.');
      return;
    }
    setConnectionStatus('reconnecting');
    setStatusMessage('Connection interrupted. Reconnecting...');
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttemptsRef.current), 10000);
    reconnectAttemptsRef.current += 1;
    reconnectTimeoutRef.current = setTimeout(async () => {
      if (!isMountedRef.current) return;
      connectWebSocket(sessionId, sessionSource);
    }, delay);
  };

  const cleanupWebSocket = () => {
    if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
    if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(); } catch (e) {}
    }
  };

  // ============================================================
  // Google Meet — Browser Tab Audio Capture
  // ============================================================

  /**
   * Send a base64-encoded audio blob over the WebSocket to the backend.
   * This is the core of the Google Meet audio pipeline.
   */
  const sendAudioChunkOverWebSocket = useCallback((blob) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      try {
        const base64 = reader.result.split(',')[1]; // strip data:... prefix
        wsRef.current.send(JSON.stringify({
          action: 'audio_chunk',
          data: base64,
          mime_type: blob.type || 'audio/webm',
        }));
      } catch (e) {
        console.warn('[GM Capture] Failed to send audio chunk:', e);
      }
    };
    reader.readAsDataURL(blob);
  }, []);

  /**
   * Start browser tab audio capture via getDisplayMedia().
   * Called when user clicks "Start Google Meet Capture".
   */
  const startGoogleMeetCapture = async () => {
    setCaptureError(null);
    isIntentionalStopRef.current = false;

    // 1. Browser support check
    if (!isTabCaptureSupported()) {
      setCaptureError(
        'Your browser does not support the required tab-audio capture. ' +
        'Please use Google Chrome or Microsoft Edge (Chromium-based).'
      );
      return;
    }

    // 2. Request tab audio via getDisplayMedia
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 48000,
        },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCaptureError(
          'Permission denied. Please click "Start Google Meet Capture" again and ' +
          'select your Google Meet browser tab, then enable "Share tab audio".'
        );
      } else if (err.name === 'NotFoundError') {
        setCaptureError(
          'No audio source found. Make sure to select a browser tab with audio enabled.'
        );
      } else {
        setCaptureError(`Could not start capture: ${err.message}`);
      }
      return;
    }

    // 3. Verify the stream has an audio track
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      setCaptureError(
        'No audio track received. Please select the Google Meet tab and ensure ' +
        '"Share tab audio" is checked in the sharing dialog.'
      );
      return;
    }

    mediaStreamRef.current = stream;
    setIsCaptureActive(true);

    // 4. Create a backend session
    let sessionId;
    let sess;
    try {
      setConnectionStatus('connecting');
      setStatusMessage('Creating live session...');
      const res = await api.createGoogleMeetSession({ title: 'Google Meet — Live Session' });
      sess = res.data;
      sessionId = sess.id;
      setSession(sess);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setIsCaptureActive(false);
      setConnectionStatus('error');
      setStatusMessage(err.userMessage || 'Failed to create session.');
      return;
    }

    // 5. Open WebSocket BEFORE starting MediaRecorder
    await connectWebSocket(sessionId, SOURCE_GOOGLE_MEET);

    // Give WS time to open before first chunk arrives
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 6. Start MediaRecorder — 5-second chunks, WebM/Opus
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = ''; // browser default
    }

    let recorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    } catch (e) {
      recorder = new MediaRecorder(stream);
    }
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        sendAudioChunkOverWebSocket(event.data);
      }
    };

    recorder.onstop = () => {
      console.log('[GM Capture] MediaRecorder stopped.');
    };

    recorder.onerror = (e) => {
      console.error('[GM Capture] MediaRecorder error:', e);
      setCaptureError('Recording error. Please try again.');
    };

    // 7. Detect when user stops sharing from Chrome's share bar
    audioTracks[0].onended = () => {
      console.log('[GM Capture] Audio track ended (user stopped sharing).');
      if (isMountedRef.current && !isIntentionalStopRef.current) {
        showInfo('Tab sharing stopped. Finalizing meeting...');
        handleStopGoogleMeetCapture();
      }
    };

    // 8. Start recording with 5-second timeslice
    recorder.start(5000);
    setConnectionStatus('capturing');
    setStatusMessage('Capturing Google Meet audio. Speak now!');
    console.log('[GM Capture] MediaRecorder started. MIME:', recorder.mimeType);
  };

  /**
   * Stop audio capture (either user-triggered or auto on track end).
   */
  const stopBrowserCapture = useCallback((silent = false) => {
    isIntentionalStopRef.current = true;

    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch (e) {}
      mediaRecorderRef.current = null;
    }

    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch (e) {}
      audioContextRef.current = null;
    }

    setIsCaptureActive(false);
  }, []);

  const handleStopGoogleMeetCapture = async () => {
    if (!session?.id) return;
    setIsFinalizing(true);
    setShowStopModal(false);
    setConnectionStatus('processing');
    setStatusMessage('Finalizing summary and saving meeting to history...');

    // 1. Stop the browser audio stream
    stopBrowserCapture();

    // 2. Give the backend a moment to process any in-flight chunks
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 3. Send stop signal over WebSocket so backend finalizes
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ action: 'stop' }));
      } catch (e) {}
    }

    // 4. Also call REST stop as a fallback
    try {
      await api.stopGoogleMeetSession(session.id);
      showInfo('Generating final AI summary...');
    } catch (err) {
      console.error('REST stop fallback error:', err);
      showError(err.userMessage || 'Failed to stop session.');
      setIsFinalizing(false);
    }
  };

  // ============================================================
  // Zoom RTMS — existing handlers (unchanged logic)
  // ============================================================
  const handleConnectZoom = async () => {
    try {
      const res = await api.getZoomConnectUrl();
      if (res.data?.url) window.location.href = res.data.url;
    } catch (err) {
      showError(err.userMessage || 'Failed to obtain Zoom connect URL.');
    }
  };

  const checkZoomAndInitRtms = async () => {
    setZoomChecking(true);
    setConnectionStatus('connecting');
    setStatusMessage('Checking Zoom connection...');
    try {
      const statusRes = await api.getZoomStatus();
      if (!isMountedRef.current) return;
      setZoomStatus(statusRes.data);

      if (!statusRes.data?.connected) {
        setConnectionStatus('error');
        setStatusMessage('Zoom is not connected.');
        setZoomChecking(false);
        return;
      }

      // Find or create RTMS session
      let targetSession = null;
      if (routeSessionId) {
        const sessRes = await api.getLiveSession(routeSessionId);
        targetSession = sessRes.data;
      } else {
        const activeRes = await api.getActiveLiveSession();
        if (activeRes.data?.is_active && activeRes.data?.session) {
          targetSession = activeRes.data.session;
        } else {
          const createRes = await api.createLiveSession({ title: 'Live Zoom Meeting', zoom_meeting_id: 'live_stream' });
          targetSession = createRes.data;
        }
      }

      if (targetSession && isMountedRef.current) {
        setSession(targetSession);
        if (targetSession.current_insights) setInsights(targetSession.current_insights);
        if (targetSession.status === 'completed' && targetSession.final_meeting_id) {
          navigate(`/meetings/${targetSession.final_meeting_id}`);
          return;
        }
        try {
          const tRes = await api.getLiveTranscript(targetSession.id);
          if (tRes.data?.chunks && isMountedRef.current) setTranscriptChunks(tRes.data.chunks);
        } catch (e) { console.warn('Transcript preload:', e); }

        connectWebSocket(targetSession.id, SOURCE_ZOOM);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setConnectionStatus('error');
        setStatusMessage(err.userMessage || 'Could not load live meeting session.');
      }
    } finally {
      if (isMountedRef.current) setZoomChecking(false);
    }
  };

  const handleStopZoomMeeting = async () => {
    if (!session?.id) return;
    setIsFinalizing(true);
    setShowStopModal(false);
    setConnectionStatus('processing');
    setStatusMessage('Finalizing summary and saving meeting to history...');
    try {
      const res = await api.stopLiveSession(session.id);
      showInfo(res.data?.message || 'Finalizing meeting summary with Gemini...');
    } catch (err) {
      showError(err.userMessage || 'Failed to stop live session.');
      setIsFinalizing(false);
    }
  };

  // ============================================================
  // Utility helpers
  // ============================================================
  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const filteredChunks = transcriptChunks.filter((chunk) => {
    if (!transcriptSearch.trim()) return true;
    const q = transcriptSearch.toLowerCase();
    return (
      (chunk.speaker_name && chunk.speaker_name.toLowerCase().includes(q)) ||
      (chunk.text && chunk.text.toLowerCase().includes(q))
    );
  });

  const uniqueSpeakers = Array.from(new Set(transcriptChunks.map((c) => c.speaker_name || 'Speaker')));
  const isActivelyRunning = ['capturing', 'live', 'waiting'].includes(connectionStatus);

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <div className="max-w-7xl mx-auto space-y-6">

      {/* ── Source Selector (only show when no session is active yet) ─── */}
      {!session && connectionStatus === 'idle' && (
        <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs">
          <h1 className="text-lg font-bold text-slate-900 mb-4">Live Meeting Summarization</h1>
          <p className="text-xs text-slate-500 mb-4">
            Choose your meeting source. Google Meet uses browser tab audio capture. Zoom uses the RTMS webhook pipeline.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setSource(SOURCE_GOOGLE_MEET)}
              className={`p-4 rounded-2xl border-2 text-left transition-all ${
                source === SOURCE_GOOGLE_MEET
                  ? 'border-indigo-500 bg-indigo-50'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-green-500 flex items-center justify-center">
                  <MonitorSpeaker className="w-4 h-4 text-white" />
                </div>
                <span className="font-bold text-slate-900 text-sm">Google Meet</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">$0 FREE</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Browser tab audio capture. Works with any personal Gmail account. Requires Chrome or Edge.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setSource(SOURCE_ZOOM)}
              className={`p-4 rounded-2xl border-2 text-left transition-all ${
                source === SOURCE_ZOOM
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center">
                  <Video className="w-4 h-4 text-white" />
                </div>
                <span className="font-bold text-slate-900 text-sm">Zoom</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">RTMS</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Zoom RTMS webhook pipeline. Requires Zoom OAuth connection and RTMS-enabled app.
              </p>
            </button>
          </div>

          {/* ── Google Meet: setup panel ─────────────────────────────── */}
          {source === SOURCE_GOOGLE_MEET && (
            <div className="mt-5 space-y-4">
              {/* Browser support warning */}
              {!isTabCaptureSupported() && (
                <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800">
                  <div className="flex items-center gap-2 font-bold mb-1">
                    <AlertTriangle className="w-4 h-4" />
                    Unsupported Browser
                  </div>
                  Your browser does not support tab audio capture. Please use Google Chrome or Microsoft Edge (Chromium-based).
                </div>
              )}

              {/* STT not configured notice */}
              {!sttConfigured && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-xs text-amber-800">
                  <div className="flex items-center gap-2 font-bold mb-1">
                    <Info className="w-4 h-4" />
                    Speech-to-Text Not Configured
                  </div>
                  <p>
                    <code className="bg-amber-100 px-1 rounded">GOOGLE_SPEECH_API_KEY</code> is not set on the server.
                    Audio will be captured and sent, but transcription will not produce text.
                    The session, WebSocket, and Gemini analysis still work once STT is configured.
                  </p>
                </div>
              )}

              {/* Instructions */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
                <p className="text-xs font-bold text-slate-800 flex items-center gap-2">
                  <Chrome className="w-4 h-4 text-indigo-600" /> How to capture Google Meet audio
                </p>
                <ol className="list-decimal list-inside space-y-1.5 text-xs text-slate-600 leading-relaxed">
                  <li>Open your Google Meet in <strong>Chrome or Edge</strong> and join the meeting.</li>
                  <li>Come back to this tab and click <strong>"Start Google Meet Capture"</strong> below.</li>
                  <li>In the browser dialog, select the <strong>Google Meet browser tab</strong>.</li>
                  <li className="font-semibold text-slate-800">✅ Enable "Share tab audio" — this is required!</li>
                  <li>Click <strong>Share</strong>. Keep the Google Meet tab open while recording.</li>
                  <li>Transcript and AI insights will appear below in real time.</li>
                </ol>
              </div>

              {captureError && (
                <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800">
                  <div className="flex items-center gap-2 font-bold mb-1">
                    <AlertTriangle className="w-4 h-4" /> Capture Error
                  </div>
                  {captureError}
                </div>
              )}

              <Button
                variant="primary"
                size="lg"
                icon={MonitorSpeaker}
                onClick={startGoogleMeetCapture}
                disabled={!isTabCaptureSupported()}
                className="w-full sm:w-auto bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700"
              >
                Start Google Meet Capture
              </Button>
            </div>
          )}

          {/* ── Zoom RTMS: connect panel ─────────────────────────────── */}
          {source === SOURCE_ZOOM && (
            <div className="mt-5">
              <Button
                variant="primary"
                size="lg"
                icon={Video}
                onClick={checkZoomAndInitRtms}
                loading={zoomChecking}
                className="w-full sm:w-auto"
              >
                {zoomChecking ? 'Checking Zoom...' : 'Connect to Zoom RTMS'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Top Banner & Status (shown once session is active) ────────── */}
      {(session || connectionStatus !== 'idle') && (
        <div className="bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
                {session?.title || (source === SOURCE_GOOGLE_MEET ? 'Google Meet — Live Session' : 'Live Zoom Meeting')}
              </h1>

              {/* Source badge */}
              {source === SOURCE_GOOGLE_MEET && (
                <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-gradient-to-r from-blue-100 to-green-100 text-indigo-700 border border-indigo-200">
                  Google Meet
                </span>
              )}
              {source === SOURCE_ZOOM && (
                <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200">
                  Zoom RTMS
                </span>
              )}

              {/* Status badges */}
              {connectionStatus === 'live' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" /> LIVE
                </span>
              )}
              {connectionStatus === 'capturing' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" /> CAPTURING
                </span>
              )}
              {connectionStatus === 'waiting' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
                  {source === SOURCE_ZOOM ? 'WAITING FOR ZOOM' : 'WAITING'}
                </span>
              )}
              {connectionStatus === 'processing' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-600" /> FINALIZING AI SUMMARY
                </span>
              )}
              {connectionStatus === 'reconnecting' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> RECONNECTING
                </span>
              )}
              {connectionStatus === 'connecting' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600 border border-slate-200">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> CONNECTING
                </span>
              )}
              {connectionStatus === 'error' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">
                  <AlertTriangle className="w-3.5 h-3.5" /> ERROR
                </span>
              )}
            </div>

            <p className="text-xs text-slate-500">{statusMessage}</p>
          </div>

          {/* Live Metrics & Action buttons */}
          <div className="flex flex-wrap items-center gap-3">
            {(connectionStatus === 'live' || connectionStatus === 'capturing') && (
              <div className="flex items-center gap-4 bg-slate-50 px-4 py-2 rounded-2xl border border-slate-200/80 text-xs font-semibold text-slate-700">
                <div className="flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-slate-400" />
                  <span className="font-mono text-sm text-slate-900">{formatDuration(meetingDuration)}</span>
                </div>
                <div className="h-4 w-px bg-slate-200" />
                <div className="flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-slate-400" />
                  <span>{uniqueSpeakers.length || 1} Speaker{uniqueSpeakers.length > 1 ? 's' : ''}</span>
                </div>
              </div>
            )}

            {isActivelyRunning && (
              <Button
                variant="danger"
                size="sm"
                icon={StopCircle}
                onClick={() => setShowStopModal(true)}
                loading={isFinalizing}
              >
                End &amp; Finalize
              </Button>
            )}

            {connectionStatus === 'waiting' && source === SOURCE_ZOOM && (
              <Button variant="secondary" size="sm" icon={RefreshCw} onClick={checkZoomAndInitRtms}>
                Refresh Status
              </Button>
            )}

            {/* Back to source selector */}
            {!isActivelyRunning && connectionStatus !== 'processing' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  cleanupWebSocket();
                  stopBrowserCapture();
                  setSession(null);
                  setTranscriptChunks([]);
                  setInsights({ summary: '', key_points: [], decisions: [], action_items: [], open_questions: [], topics: [], risks: [] });
                  setConnectionStatus('idle');
                  setStatusMessage('');
                  setMeetingDuration(0);
                  setCaptureError(null);
                  isIntentionalStopRef.current = false;
                }}
              >
                ← Back
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Zoom-specific: not connected prompt ──────────────────────── */}
      {source === SOURCE_ZOOM && session && !zoomStatus.connected && (
        <div className="bg-white p-8 sm:p-12 rounded-3xl border border-slate-200/80 shadow-xs text-center space-y-6 max-w-xl mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
            <Video className="w-8 h-8" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-slate-900">Connect Zoom to Start Live Summaries</h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Zoom RTMS requires your Zoom account to be connected.
            </p>
          </div>
          <Button variant="primary" size="lg" icon={Video} onClick={handleConnectZoom}>
            Connect Zoom Account
          </Button>
        </div>
      )}

      {/* ── Zoom Waiting state ────────────────────────────────────────── */}
      {source === SOURCE_ZOOM && session && zoomStatus.connected && connectionStatus === 'waiting' && transcriptChunks.length === 0 && (
        <div className="bg-white p-8 sm:p-12 rounded-3xl border border-slate-200/80 shadow-xs text-center space-y-6 max-w-2xl mx-auto">
          <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-indigo-100 animate-ping opacity-60" />
            <div className="relative w-16 h-16 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg">
              <Radio className="w-8 h-8 animate-pulse" />
            </div>
          </div>
          <div className="space-y-2 max-w-md mx-auto">
            <h2 className="text-xl font-bold text-slate-900">Waiting for Live Zoom Meeting...</h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Your Zoom account (<span className="font-semibold text-slate-700">{zoomStatus.email || 'Connected'}</span>) is ready.
              Start or join a Zoom meeting with RTMS/Captions enabled.
            </p>
          </div>
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 max-w-md mx-auto text-left space-y-2 text-xs text-slate-600">
            <div className="flex items-center gap-2 font-bold text-slate-800">
              <Sparkles className="w-4 h-4 text-indigo-600" /> <span>How it works:</span>
            </div>
            <ol className="list-decimal list-inside space-y-1 text-slate-500">
              <li>Open Zoom and start or join your meeting.</li>
              <li>Zoom RTMS streams live transcript data to your backend.</li>
              <li>Gemini analyzes spoken dialogue incrementally in real time.</li>
              <li>Live summary, decisions, and action items appear on this screen.</li>
            </ol>
          </div>
        </div>
      )}

      {/* ── Main Live Dual-Panel Interface ───────────────────────────── */}
      {session && (connectionStatus === 'live' || connectionStatus === 'capturing' || transcriptChunks.length > 0 || insights.summary) && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

          {/* Left: Live Transcript Panel */}
          <div className="lg:col-span-5 bg-white rounded-3xl border border-slate-200/80 shadow-xs flex flex-col h-[650px] overflow-hidden">
            <div className="p-4 sm:px-5 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-600" />
                <h2 className="text-sm font-bold text-slate-900">Live Transcript</h2>
                <span className="text-[11px] font-semibold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                  {transcriptChunks.length} chunks
                </span>
              </div>
              <button
                type="button"
                onClick={() => setAutoScroll(!autoScroll)}
                className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border transition-all cursor-pointer flex items-center gap-1 ${
                  autoScroll
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                    : 'bg-white border-slate-200 text-slate-500'
                }`}
              >
                <ArrowDown className="w-3 h-3" />
                Auto-scroll
              </button>
            </div>

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

            <div className="flex-1 p-4 sm:p-5 overflow-y-auto space-y-4 font-sans">
              {filteredChunks.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-2">
                  {(connectionStatus === 'capturing' || connectionStatus === 'live') ? (
                    <>
                      <Radio className="w-6 h-6 animate-pulse text-indigo-400" />
                      <p className="text-xs">
                        {source === SOURCE_GOOGLE_MEET
                          ? 'Listening for speech in Google Meet audio...'
                          : 'Listening for spoken dialogue...'}
                      </p>
                      {source === SOURCE_GOOGLE_MEET && !sttConfigured && (
                        <p className="text-[11px] text-amber-600 bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-200">
                          STT not configured — transcription inactive
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <FileText className="w-6 h-6 text-slate-300" />
                      <p className="text-xs">No transcript yet.</p>
                    </>
                  )}
                </div>
              ) : (
                filteredChunks.map((chunk, idx) => (
                  <div key={chunk.chunk_hash || idx} className="space-y-1 animate-fadeIn">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-slate-900 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-indigo-500" />
                        {chunk.speaker_name || 'Speaker'}
                      </span>
                      <span className="text-slate-400 font-mono">{chunk.start_time || ''}</span>
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

          {/* Right: Live AI Intelligence Panel */}
          <div className="lg:col-span-7 space-y-5">
            {/* Live Summary */}
            <div className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">Live Executive Summary</h2>
                  <p className="text-[11px] text-slate-400">Incrementally updated by Gemini AI</p>
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

            {/* Decisions & Key Points */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
                <div className="flex items-center gap-2 text-slate-900">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Key Decisions</h3>
                </div>
                {insights.decisions?.length > 0 ? (
                  <ul className="space-y-2">
                    {insights.decisions.map((d, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-slate-700 leading-normal">
                        <span className="text-emerald-500 font-bold">✓</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-400 italic">No formal decisions detected yet.</p>
                )}
              </div>

              <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
                <div className="flex items-center gap-2 text-slate-900">
                  <Lightbulb className="w-4 h-4 text-amber-500" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Key Takeaways</h3>
                </div>
                {insights.key_points?.length > 0 ? (
                  <ul className="space-y-2">
                    {insights.key_points.map((p, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-slate-700 leading-normal">
                        <span className="text-amber-500 font-bold">•</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-400 italic">Key points will appear here.</p>
                )}
              </div>
            </div>

            {/* Action Items */}
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
                  {insights.action_items.map((item, i) => (
                    <div key={i} className="p-3.5 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                      <div className="space-y-1">
                        <span className="font-bold text-slate-900 block">{item.task}</span>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                          {item.owner && item.owner !== 'Not specified' && (
                            <span className="font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md">👤 {item.owner}</span>
                          )}
                          {item.deadline && item.deadline !== 'No deadline specified' && (
                            <span className="font-semibold text-slate-700 bg-slate-200/70 px-2 py-0.5 rounded-md">⏰ {item.deadline}</span>
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

            {/* Topics & Open Questions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
                <div className="flex items-center gap-2 text-slate-900">
                  <Tag className="w-4 h-4 text-indigo-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Discussion Topics</h3>
                </div>
                {insights.topics?.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {insights.topics.map((t, i) => (
                      <span key={i} className="text-xs font-semibold px-2.5 py-1 rounded-xl bg-slate-100 text-slate-800 border border-slate-200/60">{t}</span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 italic">Topics will appear here.</p>
                )}
              </div>

              <div className="bg-white p-5 rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
                <div className="flex items-center gap-2 text-slate-900">
                  <HelpCircle className="w-4 h-4 text-purple-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider">Open Questions</h3>
                </div>
                {insights.open_questions?.length > 0 ? (
                  <ul className="space-y-1.5">
                    {insights.open_questions.map((q, i) => (
                      <li key={i} className="text-xs text-purple-900 bg-purple-50 p-2 rounded-xl border border-purple-100">❓ {q}</li>
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

      {/* ── Stop Confirmation Modal ───────────────────────────────────── */}
      {showStopModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fadeIn">
          <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl border border-slate-100 space-y-5">
            <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
              <StopCircle className="w-6 h-6" />
            </div>
            <div className="text-center space-y-1.5">
              <h3 className="text-lg font-bold text-slate-900">End &amp; Finalize Meeting?</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                {source === SOURCE_GOOGLE_MEET
                  ? 'This will stop tab audio capture, run the final Gemini summary, and save the meeting to your History.'
                  : 'This will finalize the live stream, generate the consolidated Gemini summary, and save the meeting permanently to your History.'}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setShowStopModal(false)}>Cancel</Button>
              <Button
                variant="danger"
                size="sm"
                icon={StopCircle}
                loading={isFinalizing}
                onClick={source === SOURCE_GOOGLE_MEET ? handleStopGoogleMeetCapture : handleStopZoomMeeting}
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
