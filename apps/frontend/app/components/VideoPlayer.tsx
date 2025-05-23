'use client';

import React, { forwardRef, useEffect, useState, useRef, useCallback, useImperativeHandle } from 'react';
import * as facemesh from '@mediapipe/face_mesh';
import { Camera } from '@mediapipe/camera_utils';
import * as selfieSegmentation from '@mediapipe/selfie_segmentation';

interface VideoPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  srcObject?: MediaStream | null;
  showHeadGuide?: boolean;
  enableSegmentation?: boolean;
  segmentationBackground?: 'transparent' | 'color' | 'blur' | 'image';
  segmentationColor?: string;
  backgroundImage?: string;
  onReadyToRecord?: () => void;
  onCanvasRef?: (canvas: HTMLCanvasElement | null) => void;
}

interface FacePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  isAligned: boolean;
}

interface FaceMeshResults {
  multiFaceLandmarks?: Array<Array<{ x: number; y: number; z: number }>>;
}

// Define a type for the ref object
export interface VideoPlayerHandle {
  video: HTMLVideoElement | null;
  canvas: HTMLCanvasElement | null;
}

console.log('VideoPlayer component function running');

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(({
  src,
  srcObject,
  autoPlay = true,
  muted = true,
  controls = false,
  className = '',
  onError,
  showHeadGuide = true,
  enableSegmentation = true,
  segmentationBackground = 'transparent',
  segmentationColor = '#000000',
  backgroundImage,
  onReadyToRecord,
  onCanvasRef,
  ...props
}, ref) => {
  const [facePosition, setFacePosition] = useState<FacePosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const videoElementRef = useRef<HTMLVideoElement>(null);
  const [isStreamActive, setIsStreamActive] = useState(false);

  useImperativeHandle(ref, () => {
    return {
      video: videoElementRef.current,
      canvas: canvasRef.current,
    };
  });
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const segmentationInstance = useRef<selfieSegmentation.SelfieSegmentation | null>(null);
  const faceMeshInstance = useRef<facemesh.FaceMesh | null>(null);

  // Add a ref to track if segmentation/facemesh are initialized
  const isSegmentationInitialized = useRef(false);

  // Notify parent when ready to record
  const hasNotifiedReadyRef = useRef(false);
  useEffect(() => {
    if (
      !hasNotifiedReadyRef.current &&
      onReadyToRecord &&
      videoElementRef.current &&
      canvasRef.current &&
      !videoElementRef.current.paused &&
      videoElementRef.current.readyState >= 2 // HAVE_CURRENT_DATA
    ) {
      hasNotifiedReadyRef.current = true;
      onReadyToRecord();
    }
  }, [onReadyToRecord, videoElementRef.current, canvasRef.current]);

  useEffect(() => {
    if (!videoElementRef.current) return;
    const videoElement = videoElementRef.current;
    const handleError = (error: any) => {
      console.error('Video playback error:', error);
      onError?.(error);
    };
    videoElement.addEventListener('error', handleError);
    return () => {
      videoElement.removeEventListener('error', handleError);
    };
  }, [onError]);

  // Segmentation results handler
  const handleSegmentationResults = (results: any) => {
    if (!canvasRef.current || !videoElementRef.current) return;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(results.segmentationMask, 0, 0, canvasRef.current.width, canvasRef.current.height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(results.image, 0, 0, canvasRef.current.width, canvasRef.current.height);

    ctx.globalCompositeOperation = 'source-over';

    const centerX = canvasRef.current.width / 2;
    const centerY = canvasRef.current.height / 2;
    const radius = Math.min(canvasRef.current.width, canvasRef.current.height) / 2;

    // Create radial gradient
    const gradient = ctx.createRadialGradient(centerX, centerY, radius * 0.8, centerX, centerY, radius);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.95)');

    // Draw gradient vignette
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    
    ctx.globalCompositeOperation = 'destination-over';
    ctx.filter = 'blur(100px)';
    ctx.drawImage(results.image, 0, 0, canvasRef.current.width, canvasRef.current.height);
    ctx.filter = 'none';

    // Reset composite operation
    ctx.globalCompositeOperation = 'source-over';
  };

  const handleFaceMeshResults = (results: FaceMeshResults) => {
      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        // Calculate face bounds
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        landmarks.forEach((landmark: { x: number; y: number }) => {
          minX = Math.min(minX, landmark.x);
          minY = Math.min(minY, landmark.y);
          maxX = Math.max(maxX, landmark.x);
          maxY = Math.max(maxY, landmark.y);
        });

        const width = maxX - minX;
        const height = maxY - minY;
        const centerX = minX + width / 2;
        const centerY = minY + height / 2;

        // Check if face is aligned (within 20% of center)
        const isAligned = 
          Math.abs(centerX - 0.5) < 0.2 && 
          Math.abs(centerY - 0.5) < 0.2 &&
          width > 0.2 && width < 0.8 && // Face size constraints
          height > 0.2 && height < 0.8;

        setFacePosition({
          x: centerX * 100,
          y: centerY * 100,
          width: width * 100,
          height: height * 100,
          isAligned
        });
      } else {
        setFacePosition(null);
      }
  }

  // Remove segmentation/facemesh setup from onActive
  const onActive = () => {
    console.log('[MediaStream] active event');
    // No longer initialize segmentation/facemesh here
  };

  // Setup segmentation/facemesh only after video is ready
  useEffect(() => {
    if (!videoElementRef.current) return;
    const video = videoElementRef.current;

    const handleReady = () => {
      if (!isSegmentationInitialized.current && isStreamActive && enableSegmentation) {
        console.log('[Video] ready, initializing segmentation/facemesh');
        if (!segmentationInstance.current) {
          segmentationInstance.current = new selfieSegmentation.SelfieSegmentation({
            locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
          });
          segmentationInstance.current.setOptions({ modelSelection: 1 });
          segmentationInstance.current.onResults(handleSegmentationResults);
        }
        if (!faceMeshInstance.current) {
          console.log('[FaceMesh] Creating new instance');
          faceMeshInstance.current = new facemesh.FaceMesh({
            locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
          });
          faceMeshInstance.current.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
          });
          faceMeshInstance.current.onResults(handleFaceMeshResults);
        }

        isSegmentationInitialized.current = true;

        if (video && faceMeshInstance.current && segmentationInstance.current) {
          cameraRef.current = new Camera(videoElementRef.current, {
            onFrame: async () => {
              if (faceMeshInstance.current) {
                await faceMeshInstance.current.send({ image: video });
              }
              if (segmentationInstance.current) {
                await segmentationInstance.current.send({ image: video });
              }
            }
          });
          cameraRef.current.start();
        }
      }
    };

    video.addEventListener('loadedmetadata', handleReady);
    video.addEventListener('canplay', handleReady);

    return () => {
      video.removeEventListener('loadedmetadata', handleReady);
      video.removeEventListener('canplay', handleReady);
      // Teardown segmentation/facemesh on cleanup
      if (segmentationInstance.current) {
        segmentationInstance.current.close();
        segmentationInstance.current = null;
      }
      if (faceMeshInstance.current) {
        faceMeshInstance.current.close();
        faceMeshInstance.current = null;
      }
      if (cameraRef.current) {
        cameraRef.current.stop();
        cameraRef.current = null;
      }
      isSegmentationInitialized.current = false;
    };
  }, [isStreamActive, enableSegmentation]);

  // Camera initialization on mount
  useEffect(() => {
    let localStream: MediaStream | null = null;

    (async () => {
      if (videoElementRef.current) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
            audio: true
          });
          videoElementRef.current.srcObject = localStream;
          await videoElementRef.current.play().catch(e => console.warn('Video play error:', e));
          setIsStreamActive(true); // Set stream as active
        } catch (err) {
          setError('Failed to access camera');
          console.error('Camera init failed:', err);
        }
      }
    })();

    return () => {
      if (localStream) {
        localStream.getTracks().forEach(track => {
          if (track.readyState === 'live') {
            track.stop();
          }
        });
        setIsStreamActive(false); // Set stream as inactive
      }
      if (segmentationInstance.current) {
        segmentationInstance.current.close();
        segmentationInstance.current = null;
      }
      if (faceMeshInstance.current) {
        faceMeshInstance.current.close();
        faceMeshInstance.current = null;
      }
    };
  }, []);

  // Use isStreamActive to trigger actions
  useEffect(() => {
    if (isStreamActive) {
      onActive();
    }
  }, [isStreamActive]);

  useEffect(() => {
    if (onCanvasRef) onCanvasRef(canvasRef.current);
  }, [canvasRef.current, onCanvasRef]);

  const videoProps = {
    ref: videoElementRef,
    src,
    autoPlay,
    playsInline: true,
    muted,
    controls,
    className: `w-full h-full object-cover ${className}`,
    ...props
  } as React.VideoHTMLAttributes<HTMLVideoElement>;

  const getOverlayColor = () => {
    if (!facePosition) return 'border-white/50';
    return facePosition.isAligned ? 'border-green-500' : 'border-red-500';
  };

  return (
    <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
      <video
        {...videoProps}
        style={{
          visibility: enableSegmentation ? 'hidden' : 'visible',
          // Optionally: opacity: enableSegmentation ? 0 : 1,
        }}
        />
      {enableSegmentation && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          width={1280}
          height={720}
        />
      )}
      {showHeadGuide && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div
            className={`border-2 border-dashed ${getOverlayColor()} rounded-[45%] opacity-75 transition-all duration-300`}
            style={
              facePosition
              ? {
                position: 'absolute',
                left: `${facePosition.x}%`,
                top: `${facePosition.y}%`,
                width: `${facePosition.width}%`,
                height: `${facePosition.height}%`,
                transform: 'translate(-50%, -50%)',
              }
              : {
                width: '60%',
                height: '80%',
              }
            }
            />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
          <div className="bg-red-500/90 text-white px-4 py-2 rounded-lg shadow-lg">
            <p className="text-sm font-medium">{error}</p>
            <button
              onClick={() => {
                setError(null);
                setIsStreamActive(true); // This will trigger onActive via useEffect
              }}
              className="mt-2 text-xs underline hover:text-white/80"
            >
              Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer; 