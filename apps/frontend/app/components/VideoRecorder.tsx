'use client'

import React, { useRef, useState, useEffect } from 'react';
import RecordRTC from 'recordrtc';

interface VideoRecorderProps {
  onRecordingComplete: (blob: Blob) => void;
  onError: (error: any) => void;
  maxLength?: number;
  width?: number;
  height?: number;
  minLength?: number;
}

export const VideoRecorder: React.FC<VideoRecorderProps> = ({
  onRecordingComplete,
  onError,
  maxLength = 30,
  width = 640,
  height = 480,
  minLength = 1500
}) => {
  console.log('VideoRecorder component rendering');

  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<RecordRTC | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);
  const canStopRef = useRef<boolean>(false);
  const isStoppingRef = useRef<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);

  useEffect(() => {
    console.log('VideoRecorder useEffect running');
    async function initCamera() {
      console.log('Initializing camera...');
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: width },
            height: { ideal: height },
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
        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          console.log('Video element source set');
        }
      } catch (err) {
        console.error('Error accessing media devices:', err);
        setError('Failed to access camera. Please ensure you have granted camera permissions.');
        onError && onError(err);
      }
    }
    initCamera();

    return () => {
      console.log('Component unmounting, cleaning up...');
      cleanup();
    };
  }, [width, height, onError]);

  const cleanup = () => {
    console.log('Cleanup called, current state:', {
      hasStream: !!stream,
      isRecording,
      hasRecorder: !!recorderRef.current,
      hasTimeout: !!timeoutRef.current
    });

    if (stream) {
      stream.getTracks().forEach(t => {
        console.log('Stopping track:', { kind: t.kind, readyState: t.readyState });
        t.stop();
      });
    }
    if (timeoutRef.current) {
      console.log('Clearing timeout');
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (recorderRef.current) {
      console.log('Cleaning up recorder');
      if (isRecording) {
        recorderRef.current.stopRecording();
      }
      recorderRef.current = null;
    }
    setIsRecording(false);
    canStopRef.current = false;
    isStoppingRef.current = false;
    setRecordingDuration(0);
  };

  const startRecording = () => {
    console.log('startRecording called, current state:', {
      hasStream: !!stream,
      isRecording,
      isStopping: isStoppingRef.current,
      hasRecorder: !!recorderRef.current
    });

    if (!stream) {
      console.error('No stream available');
      setError('Camera not initialized');
      return;
    }
    if (isRecording) {
      console.error('Already recording');
      return;
    }
    if (isStoppingRef.current) {
      console.error('Currently stopping previous recording');
      return;
    }

    try {
      console.log('Creating new recorder');
      recorderRef.current = new RecordRTC(stream, {
        type: 'video',
        mimeType: 'video/webm;codecs=h264',
        videoBitsPerSecond: 1000000,
        audioBitsPerSecond: 128000,
        frameRate: 30,
        disableLogs: false,
        timeSlice: 1000,
        ondataavailable: (blob) => {
          console.log('Recording data available:', {
            size: blob.size,
            type: blob.type
          });
        }
      });

      startTimeRef.current = Date.now();
      canStopRef.current = false;
      isStoppingRef.current = false;

      console.log('Starting recording...');
      recorderRef.current.startRecording();
      setIsRecording(true);
      console.log('Recording started successfully');

      // Update recording duration every second
      const durationInterval = setInterval(() => {
        if (isRecording) {
          const duration = Date.now() - startTimeRef.current;
          setRecordingDuration(duration);
        } else {
          clearInterval(durationInterval);
        }
      }, 1000);

      // Set timeout for minimum recording length
      setTimeout(() => {
        console.log('Minimum recording length reached');
        canStopRef.current = true;
      }, minLength);

      // Set timeout for maximum recording length
      timeoutRef.current = setTimeout(() => {
        console.log('Maximum recording length reached');
        if (isRecording && !isStoppingRef.current) {
          stopRecording();
        }
      }, maxLength * 1000);
    } catch (err) {
      console.error('Error starting recording:', err);
      setError('Failed to start recording');
      onError && onError(err);
    }
  };

  const stopRecording = async () => {
    console.log('stopRecording called, current state:', {
      hasRecorder: !!recorderRef.current,
      isRecording,
      isStopping: isStoppingRef.current,
      duration: Date.now() - startTimeRef.current
    });

    if (!recorderRef.current || !isRecording || isStoppingRef.current) {
      console.error('Cannot stop recording:', {
        hasRecorder: !!recorderRef.current,
        isRecording,
        isStopping: isStoppingRef.current
      });
      return;
    }

    const duration = Date.now() - startTimeRef.current;
    if (duration < minLength) {
      console.error('Recording too short:', { duration, minLength });
      setError(`Recording must be at least ${minLength / 1000} seconds long`);
      return;
    }

    isStoppingRef.current = true;
    setIsRecording(false);

    return new Promise<void>((resolve) => {
      console.log('Stopping recorder...');
      recorderRef.current!.stopRecording(() => {
        const blob = recorderRef.current!.getBlob();
        console.log('Recording stopped, blob details:', {
          size: blob.size,
          type: blob.type,
          duration
        });

        if (blob.size === 0) {
          console.error('Empty recording blob');
          setError('No media was recorded. Please try again.');
          cleanup();
          resolve();
          return;
        }

        onRecordingComplete && onRecordingComplete(blob);
        cleanup();
        resolve();
      });
    });
  };

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  console.log('VideoRecorder render state:', { isRecording, hasStream: !!stream });

  return (
    <div className="video-recorder" style={{ width, height }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: 'black',
          objectFit: 'cover'
        }}
      />
      {error && (
        <div className="error-message text-red-500 mt-2 text-center">
          {error}
        </div>
      )}
      {isRecording && (
        <div className="recording-duration text-white mt-2 text-center">
          {formatDuration(recordingDuration)}
        </div>
      )}
      <div className="video-controls" style={{ marginTop: '10px', textAlign: 'center' }}>
        {!isRecording ? (
          <button
            onClick={() => {
              console.log('Start button clicked');
              startRecording();
            }}
            disabled={isStoppingRef.current}
            className={`px-4 py-2 text-white rounded transition-colors ${
              isStoppingRef.current
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-blue-500 hover:bg-blue-600'
            }`}
          >
            Start Recording
          </button>
        ) : (
          <button
            onClick={() => {
              console.log('Stop button clicked');
              stopRecording();
            }}
            disabled={!canStopRef.current || isStoppingRef.current}
            className={`px-4 py-2 text-white rounded transition-colors ${
              canStopRef.current && !isStoppingRef.current
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-gray-400 cursor-not-allowed'
            }`}
          >
            {isStoppingRef.current ? 'Stopping...' : canStopRef.current ? 'Stop Recording' : 'Recording...'}
          </button>
        )}
      </div>
    </div>
  );
};

export default VideoRecorder; 