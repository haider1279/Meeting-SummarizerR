import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Sparkles, 
  Calendar, 
  Users, 
  Type, 
  ArrowRight,
  RefreshCw
} from 'lucide-react';
import { api } from '../lib/apiClient';
import { Button } from '../components/Button';
import { UploadArea } from '../components/UploadArea';
import { ProgressIndicator } from '../components/ProgressIndicator';
import { useToast } from '../components/Toast';

export const UploadPage = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const [title, setTitle] = useState('');
  const [meetingDate, setMeetingDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [participants, setParticipants] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [processingStatus, setProcessingStatus] = useState('idle'); // idle | uploading | processing | completed | failed
  const [errorMessage, setErrorMessage] = useState('');
  const [meetingId, setMeetingId] = useState(null);

  const pollIntervalRef = useRef(null);

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
          // Advance progress bar smoothly
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

    // Poll every 3.5 seconds
    pollIntervalRef.current = setInterval(checkStatus, 3500);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [meetingId, processingStatus, navigate, showSuccess, showError]);

  const handleSubmit = async (e) => {
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
      setCurrentStep(2); // Audio uploaded, now processing
      setProcessingStatus('processing');
    } catch (err) {
      console.error('Upload failed:', err);
      setIsProcessing(false);
      setProcessingStatus('idle');
      showError(err.userMessage || 'Failed to upload audio file. Please try again.');
    }
  };

  const handleReset = () => {
    setIsProcessing(false);
    setProcessingStatus('idle');
    setMeetingId(null);
    setCurrentStep(1);
    setErrorMessage('');
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
          Upload Meeting Recording
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Upload your audio file and let Gemini AI automatically generate a transcript, summary, and action items.
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
                Upload Another Recording
              </Button>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-xs space-y-6">
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
    </div>
  );
};
