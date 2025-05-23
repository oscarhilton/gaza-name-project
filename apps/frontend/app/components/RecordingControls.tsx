'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Options as RecordRTCOptions } from 'recordrtc';
import dynamic from 'next/dynamic';
import type { VideoPlayerHandle } from './VideoPlayer';

// Dynamically import VideoPlayer to ensure browser APIs are only used on client
const VideoPlayer = dynamic(() => import('./VideoPlayer').then(mod => mod.VideoPlayer), {
  ssr: false,
  loading: () => (
    <div className="bg-slate-800 shadow-2xl rounded-2xl p-6 md:p-10 space-y-8 ring-1 ring-slate-700">
      <div className="animate-pulse">
        <div className="h-8 bg-slate-700 rounded w-1/3 mb-8"></div>
        <div className="h-64 bg-slate-700 rounded"></div>
      </div>
    </div>
  ),
});

interface RecordingControlsProps {
  selectedNameId: number | null;
  isLoadingNames: boolean;
  error: string | null;
  isUploading: boolean;
  uploadProgress: number;
  uploadStatus: string | null;
  onUpload: (blob: Blob) => Promise<void>;
}

export const RecordingControls: React.FC<RecordingControlsProps> = ({
  selectedNameId,
  isLoadingNames,
  error,
  isUploading,
  uploadProgress,
  uploadStatus,
  onUpload
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<any>(null);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoPlayerRef = useRef<VideoPlayerHandle | null>(null);
  const [showToast, setShowToast] = useState(false);
  const lastRevokedUrlRef = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          if (track.readyState === 'live') {
            track.stop();
          }
        });
        streamRef.current = null;
      }
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        lastRevokedUrlRef.current = previewUrl;
      }
    };
  }, [previewUrl]);

  const startRecording = async () => {
    if (!videoPlayerRef.current?.canvas) {
      setLocalError('Video is not ready yet.');
      return;
    }
    if (isRecording) {
      return;
    }

    try {
      const RecordRTC = (await import('recordrtc')).default;
      const canvasStream = videoPlayerRef.current.canvas.captureStream(30); // 30 FPS
      const options: RecordRTCOptions = {
        type: 'video',
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: 10000000,
        recorderType: RecordRTC.MediaStreamRecorder,
        frameRate: 30,
        disableLogs: false,
        ondataavailable: (blob: Blob) => {
          if (!isRecording && blob.size > 0) {
            setRecordedBlob(blob);
          }
        }
      };
      recorderRef.current = new RecordRTC(canvasStream, options);
      recorderRef.current.startRecording();
      setIsRecording(true);
      setLocalError(null);
      // Timer
      const interval = setInterval(() => {
        setRecordingTime(prev => {
          const newTime = prev + 1;
          if (newTime >= 30) {
            stopRecording();
          }
          return newTime;
        });
      }, 1000);
      recordingIntervalRef.current = interval;
    } catch (err) {
      setLocalError('Failed to start recording. Please try again.');
    }
  };

  const stopRecording = async () => {
    if (!recorderRef.current) {
      return;
    }
    return new Promise<void>((resolve) => {
      recorderRef.current.stopRecording(() => {
        const blob = recorderRef.current!.getBlob();
        // Safe camera cleanup
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => {
            if (track.readyState === 'live') {
              track.stop();
            }
          });
          streamRef.current = null;
        }
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
        setRecordingTime(0);
        setIsRecording(false);
        const url = URL.createObjectURL(blob);
        console.log(url)
        setPreviewUrl(url);
        setRecordedBlob(blob);
        resolve();
      });
    });
  };

  const handleUpload = async () => {
    if (!recordedBlob) {
      return;
    }
    try {
      await onUpload(recordedBlob);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Upload failed');
    }
  };

  const handleRecordAgain = () => {
    setRecordedBlob(null);
    if (previewUrl) {
      if (lastRevokedUrlRef.current !== previewUrl) {
        URL.revokeObjectURL(previewUrl);
        lastRevokedUrlRef.current = previewUrl;
      }
      setPreviewUrl(null);
    }
  };

  console.log(videoPlayerRef.current)

  const canvasReady = !!videoPlayerRef.current?.canvas;

  // Toast auto-hide
  useEffect(() => {
    if (showToast) {
      const timer = setTimeout(() => setShowToast(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [showToast]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div 
      ref={containerRef}
      className="space-y-6 bg-slate-700/50 rounded-xl p-6 ring-1 ring-slate-600"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-300">Video Recording</h3>
      </div>

      {!recordedBlob ? (
        <div className="relative">
          <VideoPlayer
            ref={videoPlayerRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          {isRecording && (
            <div className="absolute top-4 right-4 bg-red-500 text-white px-3 py-1 rounded-full text-sm font-medium">
              {formatTime(recordingTime)}
            </div>
          )}
          {/* Show loading spinner/message until canvas is ready */}
          {!canvasReady && (
            <div className="flex items-center justify-center mt-4">
              <div className="w-6 h-6 border-4 border-white/30 border-t-white rounded-full animate-spin mr-2" />
              <span className="text-white text-sm">Loading video...</span>
            </div>
          )}
          {/* Record button, only show when canvas is ready */}
          {!isRecording ? (
            <button
              onClick={startRecording}
              disabled={!canvasReady}
              className={`mt-4 px-6 py-3 rounded-xl text-base font-semibold shadow-lg transition-all duration-150 ${!canvasReady ? 'bg-gray-500 cursor-not-allowed' : 'bg-teal-500 hover:bg-teal-600'} text-white`}
            >
              Start Recording
            </button>
          ) : (
            <button
              onClick={stopRecording}
              disabled={!canvasReady}
              className={`mt-4 px-6 py-3 rounded-xl text-base font-semibold shadow-lg transition-all duration-150 ${!canvasReady ? 'bg-gray-500 cursor-not-allowed' : 'bg-teal-500 hover:bg-teal-600'} text-white`}
            >
              Stop Recording
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <video
            src={previewUrl || undefined}
            controls
            className="w-full h-full object-cover"
          />
          <div className="flex gap-4">
            <button
              onClick={handleRecordAgain}
              className="px-6 py-3 rounded-xl text-base font-semibold shadow-lg transition-all duration-150 bg-slate-600 hover:bg-slate-700 text-white"
            >
              Record Again
            </button>
            <button
              onClick={handleUpload}
              disabled={isUploading || !selectedNameId}
              className={`flex-1 px-6 py-3 rounded-xl text-base font-semibold shadow-lg transition-all duration-150 ${
                isUploading || !selectedNameId
                  ? 'bg-gray-500 cursor-not-allowed'
                  : 'bg-teal-500 hover:bg-teal-600'
              } text-white`}
            >
              {isUploading ? (
                <span className="flex items-center justify-center">
                  <svg 
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" 
                    xmlns="http://www.w3.org/2000/svg" 
                    fill="none" 
                    viewBox="0 0 24 24"
                  >
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Uploading...
                </span>
              ) : 'Upload Recording'}
            </button>
          </div>
        </div>
      )}

      {(error || localError) && (
        <div className="text-red-400 bg-red-900/40 p-3 rounded-md text-sm">
          {error || localError}
        </div>
      )}

      {uploadStatus && (
        <div 
          className={`text-sm p-3 rounded-md ${
            uploadStatus.startsWith('Error') || uploadStatus.startsWith('Upload failed')
              ? 'text-red-400 bg-red-900/40'
              : 'text-green-400 bg-green-900/40'
          }`}
        >
          {uploadStatus}
        </div>
      )}

      {uploadProgress > 0 && uploadProgress < 100 && (
        <div className="w-full bg-slate-700 rounded-full h-2.5">
          <div
            className="bg-teal-500 h-2.5 rounded-full transition-all duration-300"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
      )}

      {/* Toast for localError */}
      {showToast && localError && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-fade-in">
          {localError}
        </div>
      )}
    </div>
  );
}; 