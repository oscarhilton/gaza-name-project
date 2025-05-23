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

interface SegmentationResults {
  image: HTMLCanvasElement;
  segmentationMask: HTMLCanvasElement;
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
  ...props
}, ref) => {
  const [facePosition, setFacePosition] = useState<FacePosition | null>(null);
  const [isSegmentationReady, setIsSegmentationReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const faceMeshRef = useRef<facemesh.FaceMesh | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const videoElementRef = useRef<HTMLVideoElement>(null);
  useImperativeHandle(ref, () => {
    return {
      video: videoElementRef.current,
      canvas: canvasRef.current,
    };
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const segmentationRef = useRef<selfieSegmentation.SelfieSegmentation | null>(null);
  const animationFrameRef = useRef<number>();

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

  // Cleanup function for segmentation
  const cleanupSegmentation = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = undefined;
    }
    if (segmentationRef.current) {
      segmentationRef.current.close();
      segmentationRef.current = null;
    }
    if (cameraRef.current) {
      cameraRef.current.stop();
      cameraRef.current = null;
    }
    setIsSegmentationReady(false);
    setError(null);
  }, []);

  // Initialize segmentation function
  const initializeSegmentation = useCallback(async () => {
    if (!videoElementRef.current) return;
    if (!enableSegmentation || !srcObject || !videoElementRef.current || !canvasRef.current) {
      cleanupSegmentation();
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      
      // Cleanup any existing segmentation
      cleanupSegmentation();

      const segmentation = new selfieSegmentation.SelfieSegmentation({
        locateFile: (file: string) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
        }
      });

      segmentation.setOptions({
        modelSelection: 1, // 0 for general, 1 for landscape
      });

      segmentation.onResults((results) => {
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
      });

      segmentationRef.current = segmentation;

      // Initialize camera
      if (videoElementRef.current) {
        const camera = new Camera(videoElementRef.current, {
          onFrame: async () => {
            if (videoElementRef.current && segmentationRef.current) {
              await segmentationRef.current.send({ image: videoElementRef.current });
            }
          },
          width: 1280,
          height: 720
        });

        cameraRef.current = camera;
        await camera.start();
        setIsSegmentationReady(true);
        setIsLoading(false);
      }

      // Start processing frames
      const processFrame = async () => {
        if (videoElementRef.current && segmentationRef.current) {
          await segmentationRef.current.send({ image: videoElementRef.current });
          animationFrameRef.current = requestAnimationFrame(processFrame);
        }
      };

      processFrame();
    } catch (error) {
      console.error('Error initializing segmentation:', error);
      setError('Failed to initialize segmentation');
      setIsLoading(false);
      cleanupSegmentation();
    }
  }, [enableSegmentation, srcObject, segmentationBackground, segmentationColor, backgroundImage, cleanupSegmentation]);

  // Initialize segmentation effect
  useEffect(() => {
    initializeSegmentation();
    return cleanupSegmentation;
  }, [initializeSegmentation, cleanupSegmentation]);

  useEffect(() => {
    const video = videoElementRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
  
    const handleLoadedMetadata = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    };
  
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    return () => video.removeEventListener('loadedmetadata', handleLoadedMetadata);
  }, []);

  // Initialize FaceMesh
  useEffect(() => {
    if (!videoElementRef.current) return;
    if (!showHeadGuide || !srcObject || !videoElementRef.current) return;

    const initializeFaceMesh = async () => {
      const faceMesh = new facemesh.FaceMesh({
        locateFile: (file: string) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
        }
      });

      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      faceMesh.onResults((results: FaceMeshResults) => {
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
      });

      faceMeshRef.current = faceMesh;

      // Initialize camera
      if (videoElementRef.current) {
        const camera = new Camera(videoElementRef.current, {
          onFrame: async () => {
            if (videoElementRef.current) {
              await faceMesh.send({ image: videoElementRef.current });
            }
          },
          width: 1280,
          height: 720
        });

        cameraRef.current = camera;
        camera.start();
      }
    };

    initializeFaceMesh();

    return () => {
      if (cameraRef.current) {
        cameraRef.current.stop();
      }
      if (faceMeshRef.current) {
        faceMeshRef.current.close();
      }
    };
  }, [showHeadGuide, srcObject, videoElementRef]);

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

  // Set srcObject directly on the video element
  useEffect(() => {
    if (!videoElementRef.current) return;
    if (videoElementRef.current) {
      videoElementRef.current.srcObject = srcObject || null;
    }
  }, [srcObject]);

  const getOverlayColor = () => {
    if (!facePosition) return 'border-white/50';
    return facePosition.isAligned ? 'border-green-500' : 'border-red-500';
  };

  useEffect(() => {
    console.log('canvasRef after mount', canvasRef.current);
  }, []);

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
            className={`w-[60%] h-[80%] border-2 border-dashed ${getOverlayColor()} rounded-[45%] opacity-75 transition-colors duration-300`}
            style={facePosition ? {
              transform: `translate(${facePosition.x - 50}%, ${facePosition.y - 50}%)`,
              width: `${facePosition.width * 1.5}%`,
              height: `${facePosition.height * 1.5}%`
            } : undefined}
          />
        </div>
      )}
      {/* Loading Overlay */}
      {isLoading && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-4 border-white/30 border-t-white rounded-full animate-spin" />
            <p className="text-white text-sm">Initializing segmentation...</p>
          </div>
        </div>
      )}
      {/* Error Overlay */}
      {error && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
          <div className="bg-red-500/90 text-white px-4 py-2 rounded-lg shadow-lg">
            <p className="text-sm font-medium">{error}</p>
            <button
              onClick={() => {
                setError(null);
                setIsLoading(true);
                // Re-initialize segmentation
                if (videoElementRef.current && canvasRef.current) {
                  initializeSegmentation();
                }
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