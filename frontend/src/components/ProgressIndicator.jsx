import React from 'react';
import { Check, Loader2, Circle, AlertCircle } from 'lucide-react';

export const ProgressIndicator = ({ currentStep = 1, status = 'processing', errorMessage = '' }) => {
  const steps = [
    { id: 1, label: 'Uploading audio', desc: 'Securely uploading file to cloud storage' },
    { id: 2, label: 'Transcribing speech', desc: 'Gemini listening to audio and transcribing dialogue' },
    { id: 3, label: 'Analyzing meeting', desc: 'Extracting key decisions, topics & action items' },
    { id: 4, label: 'Saving results', desc: 'Structuring and persisting data to database' },
  ];

  const isFailed = status === 'failed';

  return (
    <div className="w-full max-w-md mx-auto p-6 bg-white rounded-3xl border border-slate-100 shadow-xl">
      <div className="text-center mb-6">
        <div className="inline-flex p-3 rounded-2xl bg-indigo-50 text-indigo-600 mb-3">
          {isFailed ? (
            <AlertCircle className="w-8 h-8 text-rose-600 animate-bounce" />
          ) : (
            <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
          )}
        </div>
        <h3 className="text-lg font-bold text-slate-900">
          {isFailed ? 'Processing Failed' : 'Analyzing Meeting Audio'}
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          {isFailed
            ? errorMessage || 'An error occurred during AI analysis.'
            : 'Gemini AI is processing your recording. This may take 30-90 seconds.'}
        </p>
      </div>

      <div className="space-y-4 relative before:absolute before:inset-0 before:left-4 before:h-[calc(100%-2rem)] before:w-0.5 before:bg-slate-100 before:z-0">
        {steps.map((step) => {
          let stepStatus = 'upcoming';
          if (isFailed && step.id === currentStep) {
            stepStatus = 'failed';
          } else if (step.id < currentStep || (status === 'completed' && step.id <= 4)) {
            stepStatus = 'completed';
          } else if (step.id === currentStep) {
            stepStatus = 'current';
          }

          return (
            <div key={step.id} className="relative z-10 flex items-start gap-4">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-colors ${
                  stepStatus === 'completed'
                    ? 'bg-emerald-600 text-white'
                    : stepStatus === 'current'
                    ? 'bg-indigo-600 text-white ring-4 ring-indigo-100 animate-pulse'
                    : stepStatus === 'failed'
                    ? 'bg-rose-600 text-white ring-4 ring-rose-100'
                    : 'bg-slate-100 text-slate-400'
                }`}
              >
                {stepStatus === 'completed' ? (
                  <Check className="w-4 h-4" />
                ) : stepStatus === 'current' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : stepStatus === 'failed' ? (
                  <AlertCircle className="w-4 h-4" />
                ) : (
                  step.id
                )}
              </div>
              <div className="flex-1 pt-1">
                <p
                  className={`text-sm font-semibold ${
                    stepStatus === 'current'
                      ? 'text-indigo-900 font-bold'
                      : stepStatus === 'completed'
                      ? 'text-slate-800'
                      : stepStatus === 'failed'
                      ? 'text-rose-700'
                      : 'text-slate-400'
                  }`}
                >
                  {step.label}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">{step.desc}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
