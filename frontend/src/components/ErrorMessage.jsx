import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from './Button';

export const ErrorMessage = ({
  title = 'Something went wrong',
  message = 'An unexpected error occurred. Please try again.',
  onRetry,
  className = '',
}) => {
  return (
    <div className={`rounded-2xl border border-rose-200 bg-rose-50/70 p-6 text-rose-900 ${className}`}>
      <div className="flex items-start gap-4">
        <div className="p-2.5 bg-rose-100 rounded-xl text-rose-600 shrink-0">
          <AlertCircle className="w-6 h-6" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-rose-950">{title}</h3>
          <p className="mt-1 text-sm text-rose-700 leading-relaxed">{message}</p>
          {onRetry && (
            <div className="mt-4">
              <Button
                variant="danger"
                size="sm"
                onClick={onRetry}
                icon={RefreshCw}
              >
                Try Again
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
