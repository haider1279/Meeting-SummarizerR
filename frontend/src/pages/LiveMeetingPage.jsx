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
  Search,
  ArrowDown,
  MonitorSpeaker,
  Info,
  Globe,
} from 'lucide-react';
import { api, getGoogleMeetWebSocketUrl } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';
import { Button } from '../components/Button';
import { useToast } from '../components/Toast';

// Browser support check for getDisplayMedia tab-audio capture
const isTabCaptureSupported = () =>
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');

// Dynamic MIME type resolution for MediaRecorder
const getSupportedAudioMimeType = () => {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  const candidateTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/aac',
  ];
  for (const type of candidateTypes) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
};

export const LiveMeetingPage = () => {
  const { sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const { showSuccess, showError, showInfo } = useToast();

  // ── Session & Connection State ────────────────────────────────────────────
  const [session, setSession] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('idle');
  // idle | connecting | capturing | live | processing | reconnecting | completed | error
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
  const [autoScroll, setAutoScroll] = useState(true);
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [showStopModal, setShowStopModal] = useState(false);
  const [sttConfigured, setSttConfigured] = useState(true);
  const [captureError, setCaptureError] = useState(null);

  // ── References ────────────────────────────────────────────────────────────
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const isMountedRef = useRef(true);
  const durationTimerRef = useRef(null);
  const transcriptEndRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  // Media capture refs
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const isIntentionalStopRef = useRef(false);

  // ============================================================
  // Lifecycle: mount / unmount cleanup
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
  // Auto-scroll transcript feed
  // ============================================================
  useEffect(() => {
    if (autoScroll && transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcriptChunks, autoScroll]);

  // ============================================================
  // Meeting Duration Timer
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
  // Route Session Loading (if /live/:sessionId visited)
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
    setStatusMessage('Loading Google Meet session...');
    try {
      const sessRes = await api.getGoogleMeetSession(sessionId);
      if (!isMountedRef.current) return;
      const sess = sessRes.data;
      setSession(sess);
      if (sess.current_insights) setInsights(sess.current_insights);
      if (sess.status === 'completed' && sess.final_meeting_id) {
        navigate(`/meetings/${sess.final_meeting_id}`);
        return;
      }
      // Preload transcript chunks
      try {
        const tRes = await api.getGoogleMeetTranscript(sessionId);
        if (tRes.data?.chunks && isMountedRef.current) {
          setTranscriptChunks(tRes.data.chunks);
        }
      } catch (e) {
        console.warn('Could not preload transcript chunks:', e);
      }
      connectWebSocket(sessionId);
    } catch (err) {
      if (isMountedRef.current) {
        setConnectionStatus('error');
        setStatusMessage(err.userMessage || 'Google Meet session not found.');
      }
    }
  };

  // ============================================================
  // Real-Time WebSocket Connection & Message Dispatcher
  // ============================================================
  const connectWebSocket = useCallback(async (sessionId) => {
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

      const wsUrl = getGoogleMeetWebSocketUrl(sessionId, token);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMountedRef.current) {
          try { ws.close(); } catch (e) {}
          return;
        }
        console.log('[Google Meet WS] Connected to live session stream:', sessionId);
        reconnectAttemptsRef.current = 0;
        setConnectionStatus('capturing');
        setStatusMessage('Connected. Streaming Google Meet tab audio to backend...');

        // Start 15s heartbeat keep-alive
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setInterval(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(JSON.stringify({ action: 'ping' }));
            } catch (e) {
              console.warn('[Google Meet WS] Ping error:', e);
            }
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
          console.error('[Google Meet WS] Failed to parse message:', e);
        }
      };

      ws.onclose = (event) => {
        console.log('[Google Meet WS] Connection closed:', event.code, event.reason);
        if (heartbeatTimerRef.current) {
          clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }
        if (isMountedRef.current && !isIntentionalStopRef.current && !isFinalizing && connectionStatus !== 'completed') {
          handleWebSocketReconnect(sessionId);
        }
      };

      ws.onerror = (error) => {
        console.error('[Google Meet WS] Error encountered:', error);
      };
    } catch (err) {
      console.error('[Google Meet WS] Setup failed:', err);
      if (isMountedRef.current) {
        handleWebSocketReconnect(sessionId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFinalizing, connectionStatus]);

  const handleWebSocketMessage = (payload) => {
    const { type, data } = payload;

    if (type === 'init') {
      if (data.status) setConnectionStatus(data.status === 'waiting' ? 'capturing' : data.status);
      if (data.insights) setInsights(data.insights);
      if (data.chunks) setTranscriptChunks(data.chunks);
      if (data.stt_configured !== undefined) setSttConfigured(data.stt_configured);
      if (data.final_meeting_id) {
        navigate(`/meetings/${data.final_meeting_id}`);
      }
    } else if (type === 'status') {
      const s = data.status;
      setConnectionStatus(s === 'live' ? 'capturing' : s);
      if (s === 'live' || s === 'capturing') {
        setStatusMessage('Live stream active. Receiving audio and generating transcript...');
      } else if (s === 'processing') {
        setStatusMessage('Meeting ended. Generating final AI summary...');
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
          setConnectionStatus('capturing');
        }
      }
    } else if (type === 'insights') {
      if (data.insights) setInsights(data.insights);
    } else if (type === 'meeting_ended') {
      setConnectionStatus('completed');
      setIsFinalizing(false);
      showSuccess('Google Meet live session ended and summary saved to History!', 'Meeting Complete');
      if (data.final_meeting_id) {
        setTimeout(() => navigate(`/meetings/${data.final_meeting_id}`), 1200);
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
      ws.onclose = null;
      try { ws.close(); } catch (e) {}
    }
  };

  // ============================================================
  // Google Meet Browser Tab Audio Capture
  // ============================================================

  const sendAudioChunkOverWebSocket = useCallback((blob) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      try {
        const base64 = reader.result.split(',')[1];
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

  const startGoogleMeetCapture = async () => {
    setCaptureError(null);
    isIntentionalStopRef.current = false;

    // 1. Browser capability verification
    if (!isTabCaptureSupported()) {
      setCaptureError(
        'Your browser does not support tab audio capture. ' +
        'Please open Meeting Summarizer in Google Chrome or Microsoft Edge.'
      );
      return;
    }

    // 2. Request browser tab audio stream (video: true is required by Chromium getDisplayMedia spec)
    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser',
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (err) {
      console.warn('[GM Capture] getDisplayMedia error:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCaptureError(
          'Screen/tab sharing was cancelled or permission was denied. Please click "Start Google Meet Capture" again and select the Google Meet tab.'
        );
      } else if (err.name === 'NotFoundError') {
        setCaptureError('No capturable display surface was available.');
      } else if (err.name === 'NotSupportedError' || err.name === 'TypeError') {
        setCaptureError(
          'Your browser/environment does not support Google Meet tab audio capture. Please use the latest Google Chrome or Microsoft Edge on HTTPS.'
        );
      } else if (err.name === 'SecurityError') {
        setCaptureError(
          'Browser security prevented tab capture. Make sure you are using the HTTPS website and browser permissions are granted.'
        );
      } else {
        setCaptureError(`Could not start tab capture (${err.name || 'Error'}): ${err.message || 'Unknown error'}`);
      }
      return;
    }

    // 3. Ensure audio track is present
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((t) => t.stop());
      setCaptureError(
        'No tab audio was shared. In the browser sharing popup, you must select the ' +
        'Google Meet tab and tick the "Share tab audio" checkbox.'
      );
      return;
    }

    // 4. Immediately stop all video tracks — only audio is processed and streamed
    displayStream.getVideoTracks().forEach((track) => {
      try {
        track.stop();
      } catch (e) {}
    });

    // 5. Construct audio-only stream for MediaRecorder
    const audioStream = new MediaStream(audioTracks);
    mediaStreamRef.current = audioStream;

    // 6. Create a Google Meet session in database
    let sessionId;
    try {
      setConnectionStatus('connecting');
      setStatusMessage('Initializing Google Meet live session...');
      const res = await api.createGoogleMeetSession({ title: 'Google Meet — Live Session' });
      const sess = res.data;
      sessionId = sess.id;
      setSession(sess);
    } catch (err) {
      audioStream.getTracks().forEach((t) => t.stop());
      setConnectionStatus('error');
      setStatusMessage(err.userMessage || 'Failed to create live session.');
      return;
    }

    // 7. Open authenticated WebSocket
    await connectWebSocket(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 8. Start MediaRecorder with dynamically supported audio format
    const mimeType = getSupportedAudioMimeType();
    let recorder;
    try {
      recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : {});
    } catch (e) {
      recorder = new MediaRecorder(audioStream);
    }
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        sendAudioChunkOverWebSocket(event.data);
      }
    };

    recorder.onerror = (e) => {
      console.error('[GM Capture] MediaRecorder error:', e);
      setCaptureError('Recording stream error encountered. Please try restarting capture.');
    };

    // 9. Handle user clicking Chrome's "Stop sharing" bar
    audioTracks[0].onended = () => {
      console.log('[GM Capture] Audio track ended by user.');
      if (isMountedRef.current && !isIntentionalStopRef.current) {
        showInfo('Tab sharing stopped. Finalizing meeting...');
        handleStopGoogleMeetCapture();
      }
    };

    // 10. Stream 5-second audio chunks continuously
    recorder.start(5000);
    setConnectionStatus('capturing');
    setStatusMessage('Capturing Google Meet audio in real time. Speak in the Meet call!');
  };

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
  }, []);

  const handleStopGoogleMeetCapture = async () => {
    if (!session?.id) return;
    setIsFinalizing(true);
    setShowStopModal(false);
    setConnectionStatus('processing');
    setStatusMessage('Finalizing summary and saving meeting to history...');

    // 1. Stop audio capture tracks
    stopBrowserCapture();

    // 2. Allow in-flight audio chunks to flush
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 3. Send stop action over WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ action: 'stop' }));
      } catch (e) {}
    }

    // 4. REST stop fallback
    try {
      await api.stopGoogleMeetSession(session.id);
      showInfo('Consolidating final AI summary with Gemini...');
    } catch (err) {
      console.error('REST stop fallback error:', err);
      showError(err.userMessage || 'Failed to stop session.');
      setIsFinalizing(false);
    }
  };

  // ============================================================
  // Helpers
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
  const isActivelyRunning = ['capturing', 'live'].includes(connectionStatus);

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <div className="max-w-7xl mx-auto space-y-6">

      {/* ── Main Setup Panel (when no session is running yet) ────────── */}
      {!session && connectionStatus === 'idle' && (
        <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-5">
            <div>
              <div className="flex items-center gap-2.5 mb-1.5">
                <div className="w-9 h-9 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-200">
                  <MonitorSpeaker className="w-5 h-5" />
                </div>
                <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
                  Google Meet Live
                </h1>
                <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  $0 FREE
                </span>
              </div>
              <p className="text-xs text-slate-500 max-w-xl leading-relaxed">
                Capture your Google Meet tab audio directly from your browser and receive real-time speech transcription and live Gemini AI summaries.
              </p>
            </div>

            <Button
              variant="primary"
              size="lg"
              icon={MonitorSpeaker}
              onClick={startGoogleMeetCapture}
              disabled={!isTabCaptureSupported()}
              className="bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200 self-start sm:self-center"
            >
              Start Google Meet Capture
            </Button>
          </div>

          {/* Browser Support Warning */}
          {!isTabCaptureSupported() && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-rose-600" />
              <div>
                <span className="font-bold block mb-0.5">Browser Not Supported</span>
                Your browser does not support tab audio capture. Please open Meeting Summarizer in <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong>.
              </div>
            </div>
          )}

          {/* Error Message */}
          {captureError && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800 flex items-start gap-3 animate-fadeIn">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-rose-600" />
              <div>
                <span className="font-bold block mb-0.5">Capture Error</span>
                {captureError}
              </div>
            </div>
          )}

          {/* Step-by-Step Instructions */}
          <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100 space-y-3">
            <div className="flex items-center gap-2 font-bold text-xs text-slate-900">
              <Globe className="w-4 h-4 text-indigo-600" />
              <span>How to capture Google Meet live audio:</span>
            </div>
            <ol className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-600">
              <li className="p-3 bg-white rounded-xl border border-slate-200/70 flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-indigo-50 text-indigo-600 font-bold flex items-center justify-center shrink-0 mt-0.5 text-[11px]">1</span>
                <span>Open your <strong>Google Meet</strong> call in another Chrome or Edge tab and join the meeting.</span>
              </li>
              <li className="p-3 bg-white rounded-xl border border-slate-200/70 flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-indigo-50 text-indigo-600 font-bold flex items-center justify-center shrink-0 mt-0.5 text-[11px]">2</span>
                <span>Return here and click <strong>"Start Google Meet Capture"</strong>.</span>
              </li>
              <li className="p-3 bg-white rounded-xl border border-slate-200/70 flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-indigo-50 text-indigo-600 font-bold flex items-center justify-center shrink-0 mt-0.5 text-[11px]">3</span>
                <span>In the browser sharing popup, select your <strong>Google Meet tab</strong>.</span>
              </li>
              <li className="p-3 bg-white rounded-xl border border-emerald-200 bg-emerald-50/30 flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-emerald-600 text-white font-bold flex items-center justify-center shrink-0 mt-0.5 text-[11px]">4</span>
                <span className="font-semibold text-slate-800">✅ Check the "Share tab audio" toggle (Required).</span>
              </li>
            </ol>
          </div>
        </div>
      )}

      {/* ── Top Status Banner (when session is active or processing) ──── */}
      {(session || connectionStatus !== 'idle') && (
        <div className="bg-white p-5 sm:p-6 rounded-3xl border border-slate-200/80 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
                {session?.title || 'Google Meet — Live Session'}
              </h1>

              {/* Status badges */}
              {connectionStatus === 'capturing' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" /> CAPTURING
                </span>
              )}
              {connectionStatus === 'live' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" /> LIVE
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

          {/* Metrics & Action Buttons */}
          <div className="flex flex-wrap items-center gap-3">
            {isActivelyRunning && (
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

      {/* ── Main Live Dual-Panel Interface ───────────────────────────── */}
      {session && (connectionStatus === 'live' || connectionStatus === 'capturing' || transcriptChunks.length > 0 || insights.summary) && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

          {/* Left Column: Real-Time Transcript Stream */}
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
                  <Radio className="w-6 h-6 animate-pulse text-indigo-400" />
                  <p className="text-xs">Listening for speech in Google Meet audio...</p>
                  {!sttConfigured && (
                    <p className="text-[11px] text-amber-600 bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-200">
                      STT API key not set on server — transcription inactive
                    </p>
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

          {/* Right Column: Live AI Intelligence */}
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
                  <Info className="w-4 h-4 text-indigo-600" />
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
                This will stop audio capture, run the final Gemini AI consolidation, and save the complete summary and action items to your Meeting History.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setShowStopModal(false)}>Cancel</Button>
              <Button
                variant="danger"
                size="sm"
                icon={StopCircle}
                loading={isFinalizing}
                onClick={handleStopGoogleMeetCapture}
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
