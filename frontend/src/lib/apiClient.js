import axios from 'axios';
import { supabase } from './supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 120000, // 2 minutes for large audio uploads and AI pipelines
});

// Request interceptor: Attach Supabase JWT Bearer token to every request
apiClient.interceptors.request.use(
  async (config) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        config.headers.Authorization = `Bearer ${session.access_token}`;
      }
    } catch (err) {
      console.error('Error fetching Supabase session for API request:', err);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor: Extract clean error messages without leaking internal tracebacks
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    let message = 'An unexpected network error occurred.';
    if (error.response?.data?.detail) {
      message = typeof error.response.data.detail === 'string'
        ? error.response.data.detail
        : JSON.stringify(error.response.data.detail);
    } else if (error.message) {
      message = error.message;
    }
    
    // Attach clean formatted message
    error.userMessage = message;
    return Promise.reject(error);
  }
);

// -------------------------------------------------------
// WebSocket URL Helpers
// -------------------------------------------------------

/**
 * WebSocket URL for Google Meet browser-tab audio capture.
 * Authenticates via Supabase JWT in ?token= query param.
 */
export const getGoogleMeetWebSocketUrl = (sessionId, token) => {
  const base = API_BASE_URL.replace(/^http/, 'ws').replace(/\/+$/, '');
  return `${base}/api/google-meet/ws/${sessionId}?token=${encodeURIComponent(token || '')}`;
};

// Aliased helper for general live meeting streaming
export const getWebSocketUrl = getGoogleMeetWebSocketUrl;

// -------------------------------------------------------
// Convenience API methods
// -------------------------------------------------------
export const api = {
  // Health
  checkHealth: () => apiClient.get('/health'),

  // Dashboard
  getDashboardStats: () => apiClient.get('/meetings/dashboard'),

  // Meetings (Audio/Video File Uploads)
  getMeetings: (params) => apiClient.get('/meetings', { params }),
  getMeeting: (id) => apiClient.get(`/meetings/${id}`),
  uploadMeeting: (formData, onUploadProgress) =>
    apiClient.post('/meetings/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress,
    }),
  updateMeeting: (id, data) => apiClient.put(`/meetings/${id}`, data),
  deleteMeeting: (id) => apiClient.delete(`/meetings/${id}`),
  downloadPdf: (id) =>
    apiClient.post(`/meetings/${id}/pdf`, null, {
      responseType: 'blob',
    }),

  // Action Items
  getActionItems: (params) => apiClient.get('/action-items', { params }),
  updateActionItem: (id, data) => apiClient.put(`/action-items/${id}`, data),

  // Zoom Integration (OAuth & Cloud Recordings)
  getZoomStatus: () => apiClient.get('/api/zoom/status'),
  getZoomConnectUrl: () => apiClient.get('/api/zoom/connect'),
  disconnectZoom: () => apiClient.post('/api/zoom/disconnect'),
  getZoomRecordings: (params) => apiClient.get('/api/zoom/recordings', { params }),
  summarizeZoomRecording: (meetingUuid) =>
    apiClient.post(`/api/zoom/recordings/${encodeURIComponent(meetingUuid)}/summarize`),

  // Google Meet Live Capture (browser tab audio capture)
  getActiveGoogleMeetSession: () => apiClient.get('/api/google-meet/active'),
  createGoogleMeetSession: (data) => apiClient.post('/api/google-meet/session', data || {}),
  getGoogleMeetSession: (sessionId) => apiClient.get(`/api/google-meet/sessions/${sessionId}`),
  getGoogleMeetTranscript: (sessionId) => apiClient.get(`/api/google-meet/sessions/${sessionId}/transcript`),
  stopGoogleMeetSession: (sessionId) => apiClient.post(`/api/google-meet/sessions/${sessionId}/stop`),

  // Live aliases pointing to Google Meet Live
  getActiveLiveSession: () => apiClient.get('/api/google-meet/active'),
  createLiveSession: (data) => apiClient.post('/api/google-meet/session', data || {}),
  getLiveSession: (sessionId) => apiClient.get(`/api/google-meet/sessions/${sessionId}`),
  getLiveTranscript: (sessionId) => apiClient.get(`/api/google-meet/sessions/${sessionId}/transcript`),
  stopLiveSession: (sessionId) => apiClient.post(`/api/google-meet/sessions/${sessionId}/stop`),
};
