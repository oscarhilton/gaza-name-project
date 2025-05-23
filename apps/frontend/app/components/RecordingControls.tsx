import React, { useState, useRef, useEffect } from 'react';
import type { Options as RecordRTCOptions } from 'recordrtc';

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
  const [isClient, setIsClient] = useState(false);
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

  // Initialize camera when component mounts
  useEffect(() => {
    console.log('Initializing camera...');
    async function initCamera() {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          },
          audio: true
        });
        console.log('Camera initialized successfully:', {
          tracks: mediaStream.getTracks().map(t => ({
            kind: t.kind,
            enabled: t.enabled,
            readyState: t.readyState
          }))
        });
        streamRef.current = mediaStream;
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          console.log('Video element source set');
        }
      } catch (err) {
        console.error('Error accessing media devices:', err);
        setLocalError('Failed to access camera. Please ensure you have granted camera permissions.');
      }
    }

    if (isClient) {
      initCamera();
    }

    return () => {
      console.log('Cleaning up camera...');
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          console.log('Stopping track:', { kind: track.kind, readyState: track.readyState });
          track.stop();
        });
      }
    };
  }, [isClient]);

  // Set isClient to true when component mounts
  useEffect(() => {
    console.log('Setting isClient to true');
    setIsClient(true);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('Component unmounting, cleaning up...');
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const startRecording = async () => {
    console.log('Start recording called, current state:', {
      isClient,
      hasStream: !!streamRef.current,
      isRecording
    });

    if (!isClient) {
      console.error('Not in client context');
      return;
    }
    if (!streamRef.current) {
      console.error('No stream available');
      setLocalError('Camera not initialized');
      return;
    }
    if (isRecording) {
      console.error('Already recording');
      return;
    }

    try {
      console.log('Importing RecordRTC...');
      const RecordRTC = (await import('recordrtc')).default;
      
      // Get video and audio tracks separately
      const videoTrack = streamRef.current.getVideoTracks()[0];
      const audioTrack = streamRef.current.getAudioTracks()[0];
      
      if (!videoTrack) {
        throw new Error('No video track available');
      }

      const options: RecordRTCOptions = {
        type: 'video' as const,
        mimeType: 'video/webm',
        videoBitsPerSecond: 1000000,
        audioBitsPerSecond: 128000,
        frameRate: 30,
        disableLogs: false,
        // Add additional options for better compatibility
        recorderType: RecordRTC.MediaStreamRecorder,
        numberOfAudioChannels: 1,
        desiredSampRate: 48000,
        ondataavailable: (blob: Blob) => {
          console.log('Recording data available:', {
            size: blob.size,
            type: blob.type
          });
          // Only set the blob when recording is complete
          if (!isRecording && blob.size > 0) {
            setRecordedBlob(blob);
          }
        }
      };

      console.log('Creating recorder with options:', options);
      recorderRef.current = new RecordRTC(streamRef.current, options);
      recorderRef.current.startRecording();
      setIsRecording(true);
      setLocalError(null);
      console.log('Recording started successfully');

      // Timer
      const interval = setInterval(() => {
        setRecordingTime(prev => {
          const newTime = prev + 1;
          // Stop recording after 30 seconds
          if (newTime >= 30) {
            stopRecording();
          }
          return newTime;
        });
      }, 1000);
      recordingIntervalRef.current = interval;
    } catch (err) {
      console.error('Error starting recording:', err);
      setLocalError('Failed to start recording. Please try again.');
    }
  };

  const stopRecording = async () => {
    console.log('Stop recording called, current state:', {
      hasRecorder: !!recorderRef.current,
      isRecording
    });

    if (!recorderRef.current) {
      console.error('No recorder available');
      return;
    }

    return new Promise<void>((resolve) => {
      recorderRef.current.stopRecording(() => {
        const blob = recorderRef.current!.getBlob();
        console.log('Recording stopped, final blob details:', {
          size: blob.size,
          type: blob.type,
          lastModified: blob.lastModified
        });

        // Stop the stream
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;

        // Clear timers
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
        setRecordingTime(0);
        setIsRecording(false);

        // Create preview URL
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setRecordedBlob(blob);
        resolve();
      });
    });
  };

  const handleUpload = async () => {
    if (!recordedBlob) {
      console.error('No recorded blob available for upload');
      return;
    }

    try {
      console.log('Starting upload of blob:', {
        size: recordedBlob.size,
        type: recordedBlob.type
      });
      await onUpload(recordedBlob);
      console.log('Upload completed successfully');
    } catch (error) {
      console.error('Upload failed:', error);
      setLocalError(error instanceof Error ? error.message : 'Upload failed');
    }
  };

  const handleRecordAgain = () => {
    console.log('Recording again...');
    setRecordedBlob(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    // Reinitialize camera
    if (isClient) {
      navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: true
      }).then(mediaStream => {
        streamRef.current = mediaStream;
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }
      }).catch(err => {
        console.error('Error reinitializing camera:', err);
        setLocalError('Failed to reinitialize camera');
      });
    }
  };

  // Don't render anything during SSR
  if (!isClient) {
    return null;
  }

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
        <>
          <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
            <video
              ref={videoRef}
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
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-end">
              <button
                onClick={isRecording ? stopRecording : startRecording}
                disabled={!selectedNameId || isLoadingNames}
                className={`px-6 py-3 rounded-xl text-base font-semibold shadow-lg transition-all duration-150 ${
                  isRecording
                    ? 'bg-red-500 hover:bg-red-600'
                    : 'bg-teal-500 hover:bg-teal-600'
                } text-white ${
                  !selectedNameId || isLoadingNames
                    ? 'opacity-50 cursor-not-allowed'
                    : ''
                }`}
              >
                {isRecording ? 'Stop Recording' : 'Start Recording'}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
            <video
              ref={previewVideoRef}
              src={previewUrl || undefined}
              controls
              className="w-full h-full object-cover"
            />
          </div>
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
    </div>
  );
}; 