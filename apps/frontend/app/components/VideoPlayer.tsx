import React, { forwardRef, useEffect } from 'react';

interface VideoPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  srcObject?: MediaStream | null;
}

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(({
  src,
  srcObject,
  autoPlay = true,
  muted = true,
  controls = false,
  className = '',
  onError,
  ...props
}, ref) => {
  useEffect(() => {
    const videoElement = ref as React.RefObject<HTMLVideoElement>;
    if (!videoElement?.current) return;

    const handleError = (error: any) => {
      console.error('Video playback error:', error);
      onError?.(error);
    };

    videoElement.current.addEventListener('error', handleError);
    return () => {
      videoElement.current?.removeEventListener('error', handleError);
    };
  }, [onError, ref]);

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

  return (
    <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
      <video {...videoProps} />
    </div>
  );
});

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer; 