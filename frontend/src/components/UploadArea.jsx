import React, { useRef, useState } from 'react';
import { UploadCloud, Music, X, AlertCircle } from 'lucide-react';

export const UploadArea = ({ file, onFileSelect, onFileRemove, error }) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0];
      validateAndSelect(droppedFile);
    }
  };

  const handleInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndSelect(e.target.files[0]);
    }
  };

  const validateAndSelect = (selectedFile) => {
    const validExtensions = ['.mp3', '.wav', '.m4a'];
    const extension = '.' + selectedFile.name.split('.').pop().toLowerCase();
    if (!validExtensions.includes(extension)) {
      alert('Please select an MP3, WAV, or M4A audio file.');
      return;
    }
    if (selectedFile.size > 100 * 1024 * 1024) {
      alert('File is too large. Maximum supported audio file size is 100 MB.');
      return;
    }
    onFileSelect(selectedFile);
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.wav,.m4a,audio/mp3,audio/wav,audio/x-m4a,audio/mp4"
        onChange={handleInputChange}
        className="hidden"
      />

      {!file ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex flex-col items-center justify-center p-8 sm:p-12 border-2 border-dashed rounded-3xl cursor-pointer transition-all duration-200 ${
            isDragging
              ? 'border-indigo-500 bg-indigo-50/70 scale-[0.99]'
              : error
              ? 'border-rose-300 bg-rose-50/40 hover:bg-rose-50/70'
              : 'border-slate-300 bg-slate-50/60 hover:bg-slate-50 hover:border-indigo-400'
          }`}
        >
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-4 shadow-sm group-hover:scale-110 transition-transform">
            <UploadCloud className="w-8 h-8" />
          </div>
          <p className="text-base font-semibold text-slate-800 text-center">
            Click to upload or drag & drop meeting audio
          </p>
          <p className="text-xs text-slate-500 mt-1.5 text-center">
            Supported audio formats: MP3, WAV, M4A (Max: 100 MB)
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-between p-4 bg-indigo-50/60 border border-indigo-200 rounded-2xl">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="p-3 bg-indigo-600 text-white rounded-xl shrink-0 shadow-sm">
              <Music className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 truncate">{file.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">{formatFileSize(file.size)}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onFileRemove}
            className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-colors shrink-0 ml-2"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1.5 mt-2 text-rose-600 text-xs font-medium">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};
