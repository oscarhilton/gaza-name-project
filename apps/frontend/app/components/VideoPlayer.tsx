import React, { forwardRef, useEffect, useState, useRef } from 'react';
import * as facemesh from '@mediapipe/face_mesh';
import { Camera } from '@mediapipe/camera_utils';

interface VideoPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  srcObject?: MediaStream | null;
  showHeadGuide?: boolean;
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

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(({
  src,
  srcObject,
  autoPlay = true,
  muted = true,
  controls = false,
  className = '',
  onError,
  showHeadGuide = true,
  ...props
}, ref) => {
  const [facePosition, setFacePosition] = useState<FacePosition | null>(null);
  const faceMeshRef = useRef<facemesh.FaceMesh | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const videoRef = ref as React.RefObject<HTMLVideoElement>;

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleError = (error: any) => {
      console.error('Video playback error:', error);
      onError?.(error);
    };

    videoElement.addEventListener('error', handleError);
    return () => {
      videoElement.removeEventListener('error', handleError);
    };
  }, [onError, videoRef]);

  // Initialize FaceMesh
  useEffect(() => {
    if (!showHeadGuide || !srcObject || !videoRef.current) return;

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
        console.log('results', results);
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
      if (videoRef.current) {
        const camera = new Camera(videoRef.current, {
          onFrame: async () => {
            if (videoRef.current) {
              await faceMesh.send({ image: videoRef.current });
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
  }, [showHeadGuide, srcObject, videoRef]);

  const videoProps = {
    ref,
    src,
    srcObject,
    autoPlay,
    playsInline: true,
    muted,
    controls,
    className: `w-full h-full object-cover ${className}`,
    ...props
  } as React.VideoHTMLAttributes<HTMLVideoElement> & { srcObject?: MediaStream | null };

  const getOverlayColor = () => {
    if (!facePosition) return 'border-white/50';
    return facePosition.isAligned ? 'border-green-500' : 'border-red-500';
  };

  return (
    <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
      <video {...videoProps} />
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
    </div>
  );
});

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer; 