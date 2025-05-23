import { useState, useRef, useCallback, useEffect } from 'react';

// Custom error types for better error handling
type MediaRecorderError = 
  | { type: 'STREAM_ERROR'; message: string; originalError?: Error }
  | { type: 'RECORDER_ERROR'; message: string; originalError?: Error }
  | { type: 'PERMISSION_ERROR'; message: string; originalError?: Error }
  | { type: 'UNKNOWN_ERROR'; message: string; originalError?: Error }
  | { type: 'UPLOAD_ERROR'; message: string; originalError?: Error }
  | { type: 'COMPATIBILITY_ERROR'; message: string; originalError?: Error };

interface MediaRecorderOptions {
  mimeType?: string;
  timeSlice?: number;
  video?: boolean;
  onDataAvailable?: (blob: Blob) => void;
  onError?: (error: MediaRecorderError) => void;
  onStart?: () => void;
  onStop?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onProgress?: (progress: number) => void;
  autoUpload?: boolean;
  uploadUrl?: string;
}

// Check for MediaRecorder support with fallbacks
const getSupportedMimeType = (video: boolean): string => {
  const types = video 
    ? [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=h264,opus',
        'video/webm'
      ]
    : [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4'
      ];

  return types.find(type => MediaRecorder.isTypeSupported(type)) || '';
};

// Check browser compatibility
const checkBrowserCompatibility = (): MediaRecorderError | null => {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      type: 'COMPATIBILITY_ERROR',
      message: 'MediaDevices API not supported in this browser'
    };
  }

  if (!MediaRecorder) {
    return {
      type: 'COMPATIBILITY_ERROR',
      message: 'MediaRecorder not supported in this browser'
    };
  }

  return null;
};

// Throttle function for start/stop operations
const throttle = (fn: Function, delay: number) => {
  let lastCall = 0;
  return (...args: any[]) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      return fn(...args);
    }
  };
};

export const useMediaRecorder = ({
  mimeType,
  timeSlice = 1000,
  video = false,
  onDataAvailable,
  onError,
  onStart,
  onStop,
  onPause,
  onResume,
  onProgress,
  autoUpload = false,
  uploadUrl
}: MediaRecorderOptions) => {
  // Core state
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState<MediaRecorderError | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  
  // Refs for managing state across renders
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const isMountedRef = useRef(true);
  const startTimeRef = useRef<number | null>(null);
  const dataRequestTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const uploadQueueRef = useRef<Blob[]>([]);
  const isUploadingRef = useRef(false);

  // Constants
  const MIN_RECORDING_DURATION = 1500;
  const DEBOUNCE_DELAY = 200;
  const CHUNK_INTERVAL = 1000;
  const THROTTLE_DELAY = 500;
  const INITIALIZATION_DELAY = 100;
  const MIN_CHUNKS_REQUIRED = 1;
  const STOP_TIMEOUT = 1000; // Maximum time to wait for final chunk

  // Check browser compatibility on mount
  useEffect(() => {
    const compatibilityError = checkBrowserCompatibility();
    if (compatibilityError) {
      setError(compatibilityError);
      onError?.(compatibilityError);
    }
  }, [onError]);

  // Mount/unmount flag
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanup();
    };
  }, []);

  // Sanity check function to validate recording state
  const validateRecordingState = useCallback(() => {
    if (!mediaRecorder) return false;

    const state = mediaRecorder.state;
    const isValidState = state === 'recording' || state === 'paused' || state === 'inactive';
    
    if (!isValidState) {
      console.warn(`Invalid MediaRecorder state: ${state}`);
      return false;
    }

    if (state === 'recording' && !isRecording) {
      console.warn('State mismatch: MediaRecorder is recording but isRecording is false');
      return false;
    }

    if (state === 'paused' && !isPaused) {
      console.warn('State mismatch: MediaRecorder is paused but isPaused is false');
      return false;
    }

    return true;
  }, [mediaRecorder, isRecording, isPaused]);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (dataRequestTimeoutRef.current) {
      clearTimeout(dataRequestTimeoutRef.current);
      dataRequestTimeoutRef.current = null;
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    
    // Validate state before cleanup
    validateRecordingState();
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop();
      } catch (err) {
        console.warn('Error during cleanup stop:', err);
      }
    }
    
    streamRef.current?.getTracks().forEach(track => track.stop());
    
    // Only clear chunks if we're not in the process of stopping
    if (!isStopping) {
      chunksRef.current = [];
    }
    
    setIsRecording(false);
    setIsStopping(false);
    setIsPaused(false);
    setMediaRecorder(null);
  }, [mediaRecorder, validateRecordingState, isStopping]);

  // Initialize media stream
  const initializeStream = useCallback(async () => {
    try {
      // Stop existing tracks
      streamRef.current?.getTracks().forEach(t => t.stop());

      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16,
      };

      const videoConstraints = video ? {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: 'user',
      } : false;

      const constraints = { audio: audioConstraints, video: videoConstraints };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

    } catch (err) {
      const error: MediaRecorderError = {
        type: 'STREAM_ERROR',
        message: 'Failed to initialize media stream',
        originalError: err instanceof Error ? err : undefined,
      };
      if (isMountedRef.current) {
        setError(error);
        onError?.(error);
      }
    }
  }, [video, onError]);

  // Initialize stream on mount
  useEffect(() => {
    initializeStream();
    return cleanup;
  }, [initializeStream, cleanup]);

  // Upload handling
  const uploadChunk = useCallback(async (blob: Blob) => {
    if (!uploadUrl || isUploadingRef.current) {
      uploadQueueRef.current.push(blob);
      return;
    }

    try {
      isUploadingRef.current = true;
      const formData = new FormData();
      formData.append('file', blob);

      // Use XMLHttpRequest for upload progress tracking
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = (event.loaded / event.total) * 100;
            setUploadProgress(progress);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed: ${xhr.statusText}`));
          }
        };

        xhr.onerror = () => {
          reject(new Error('Upload failed: Network error'));
        };

        xhr.open('POST', uploadUrl);
        xhr.send(formData);
      });

      // Process queued chunks
      while (uploadQueueRef.current.length > 0) {
        const nextChunk = uploadQueueRef.current.shift();
        if (nextChunk) {
          await uploadChunk(nextChunk);
        }
      }
    } catch (err) {
      const error: MediaRecorderError = {
        type: 'UPLOAD_ERROR',
        message: 'Failed to upload recording chunk',
        originalError: err instanceof Error ? err : undefined
      };
      setError(error);
      onError?.(error);
    } finally {
      isUploadingRef.current = false;
    }
  }, [uploadUrl, onError]);

  // Throttled start function
  const start = useCallback(throttle(async () => {
    if (isRecording || isStopping || !streamRef.current) {
      console.warn('Cannot start - recording in progress or stream not ready');
      return;
    }

    try {
      const supportedMimeType = mimeType || getSupportedMimeType(video);
      if (!supportedMimeType) {
        throw new Error('No supported MIME type found');
      }

      const recorder = new MediaRecorder(streamRef.current, {
        mimeType: supportedMimeType,
        videoBitsPerSecond: video ? 1_000_000 : undefined,
        audioBitsPerSecond: 128_000
      });

      let isFirstDataAvailable = true;
      let hasReceivedData = false;
      let isInitialized = false;
      let dataRequestCount = 0;

      recorder.ondataavailable = (event) => {
        if (!isMountedRef.current) return;

        // Always process the first data chunk
        if (isFirstDataAvailable) {
          isFirstDataAvailable = false;
          if (event.data.size > 0) {
            hasReceivedData = true;
            chunksRef.current.push(event.data);
            onDataAvailable?.(event.data);
            if (autoUpload) {
              uploadChunk(event.data);
            }
          }
          return;
        }

        // Process subsequent chunks
        if (event.data.size > 0) {
          hasReceivedData = true;
          chunksRef.current.push(event.data);
          onDataAvailable?.(event.data);
          if (autoUpload) {
            uploadChunk(event.data);
          }
        }
      };

      recorder.onstart = () => {
        if (!isMountedRef.current) return;

        console.log('Recording started:', {
          timestamp: new Date().toISOString(),
          recordingType: video ? 'video' : 'audio',
          stream: streamRef.current?.getTracks().map(t => t.kind)
        });

        chunksRef.current = [];
        setIsRecording(true);
        setIsPaused(false);
        setMediaRecorder(recorder);
        startTimeRef.current = Date.now();
        onStart?.();

        // Set initialization flag after a short delay
        setTimeout(() => {
          isInitialized = true;
        }, INITIALIZATION_DELAY);

        // Request data more frequently at the start
        const requestData = () => {
          if (recorder.state === 'recording' && !isStopping) {
            recorder.requestData();
            dataRequestCount++;
            
            // Use shorter intervals for the first few chunks
            const nextInterval = dataRequestCount <= 2 ? 500 : CHUNK_INTERVAL;
            dataRequestTimeoutRef.current = setTimeout(requestData, nextInterval);
          }
        };
        
        // Request first chunk after a short delay
        setTimeout(() => {
          if (recorder.state === 'recording') {
            recorder.requestData();
            dataRequestCount++;
            dataRequestTimeoutRef.current = setTimeout(requestData, 500);
          }
        }, 100);

        progressIntervalRef.current = setInterval(() => {
          if (startTimeRef.current) {
            const elapsed = Date.now() - startTimeRef.current;
            onProgress?.(elapsed);
          }
        }, 100);
      };

      recorder.onstop = () => {
        if (!isMountedRef.current) return;

        console.log('Recording stopped:', {
          timestamp: new Date().toISOString(),
          chunks: chunksRef.current.length,
          totalSize: chunksRef.current.reduce((acc, chunk) => acc + chunk.size, 0),
          recordingType: video ? 'video' : 'audio',
          hasReceivedData,
          dataRequestCount
        });

        cleanup();
        onStop?.();
      };

      recorder.onerror = (event) => {
        if (!isMountedRef.current) return;

        const error: MediaRecorderError = {
          type: 'RECORDER_ERROR',
          message: 'MediaRecorder error occurred',
          originalError: event.error || undefined
        };
        setError(error);
        onError?.(error);
      };

      // Start recording with a small initial timeslice
      recorder.start(100); // Use a small timeslice to get data quickly

    } catch (err) {
      const error: MediaRecorderError = {
        type: 'RECORDER_ERROR',
        message: 'Failed to start recording',
        originalError: err instanceof Error ? err : undefined
      };
      setError(error);
      onError?.(error);
    }
  }, THROTTLE_DELAY), [mimeType, video, timeSlice, isRecording, isStopping, onDataAvailable, onStart, onStop, onError, onProgress, cleanup, autoUpload, uploadChunk]);

  const stop = useCallback(() => {
    if (!mediaRecorder || !isRecording || isStopping) {
      console.warn('Cannot stop - no active recording');
      return;
    }

    if (startTimeRef.current) {
      const elapsed = Date.now() - startTimeRef.current;
      if (elapsed < MIN_RECORDING_DURATION) {
        console.warn(`Recording too short to stop (${elapsed}ms < ${MIN_RECORDING_DURATION}ms)`);
        return;
      }
    }

    // Ensure we're in the recording state
    if (mediaRecorder.state !== 'recording') {
      console.warn(`Cannot stop - recorder in ${mediaRecorder.state} state`);
      return;
    }

    setIsStopping(true);

    // Create a promise to handle the final data chunk
    const finalChunkPromise = new Promise<void>((resolve) => {
      const originalOndataavailable = mediaRecorder.ondataavailable;
      let finalChunkReceived = false;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          onDataAvailable?.(event.data);
          if (autoUpload) {
            uploadChunk(event.data);
          }
          finalChunkReceived = true;
        }
        resolve();
      };

      // Request final chunk
      try {
        mediaRecorder.requestData();
      } catch (err) {
        console.warn('Error requesting final data chunk:', err);
        resolve();
      }

      // Set a timeout to ensure we don't wait forever
      setTimeout(() => {
        if (!finalChunkReceived) {
          console.warn('Timeout waiting for final chunk');
          resolve();
        }
      }, STOP_TIMEOUT);
    });

    // Wait for the final chunk before stopping
    finalChunkPromise.then(() => {
      if (mediaRecorder.state === 'recording') {
        try {
          mediaRecorder.stop();
        } catch (err) {
          console.warn('Error stopping recorder:', err);
          cleanup();
        }
      }
    });
  }, [mediaRecorder, isRecording, isStopping, onDataAvailable, autoUpload, uploadChunk, cleanup]);

  const pause = useCallback(() => {
    if (!mediaRecorder || !isRecording || isStopping) {
      console.warn('Cannot pause - no active recording');
      return;
    }

    try {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
        setIsPaused(true);
        onPause?.();
      } else {
        console.warn(`Cannot pause - recorder in ${mediaRecorder.state} state`);
      }
    } catch (err) {
      const error: MediaRecorderError = {
        type: 'RECORDER_ERROR',
        message: 'Failed to pause recording',
        originalError: err instanceof Error ? err : undefined
      };
      setError(error);
      onError?.(error);
    }
  }, [mediaRecorder, isRecording, isStopping, onPause, onError]);

  const resume = useCallback(() => {
    if (!mediaRecorder || !isPaused || isStopping) {
      console.warn('Cannot resume - recording is not paused or stopping');
      return;
    }

    try {
      if (mediaRecorder.state === 'paused') {
        mediaRecorder.resume();
        setIsPaused(false);
        onResume?.();
      } else {
        console.warn(`Cannot resume - recorder in ${mediaRecorder.state} state`);
      }
    } catch (err) {
      const error: MediaRecorderError = {
        type: 'RECORDER_ERROR',
        message: 'Failed to resume recording',
        originalError: err instanceof Error ? err : undefined
      };
      setError(error);
      onError?.(error);
    }
  }, [mediaRecorder, isPaused, isStopping, onResume, onError]);

  const getRecordingBlob = useCallback(() => {
    if (chunksRef.current.length === 0) {
      return null;
    }

    const mimeType = mediaRecorder?.mimeType || getSupportedMimeType(video);
    return new Blob(chunksRef.current, { type: mimeType });
  }, [mediaRecorder, video]);

  const reset = useCallback(() => {
    cleanup();
    chunksRef.current = [];
    setUploadProgress(0);
    uploadQueueRef.current = [];
    isUploadingRef.current = false;
  }, [cleanup]);

  // Add state validation to useEffect
  useEffect(() => {
    const interval = setInterval(() => {
      if (isRecording || isPaused) {
        validateRecordingState();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isRecording, isPaused, validateRecordingState]);

  return {
    // Core controls
    start,
    stop,
    pause,
    resume,
    reset,
    
    // State
    isRecording,
    isPaused,
    isStopping,
    error,
    
    // Media
    stream: streamRef.current,
    chunks: chunksRef.current,
    getRecordingBlob,
    
    // Upload
    uploadProgress,
    isUploading: isUploadingRef.current,
    
    // Utility
    clearChunks: () => { chunksRef.current = []; },
    initializeStream,
    validateRecordingState
  };
}; 