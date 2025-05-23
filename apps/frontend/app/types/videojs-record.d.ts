declare module 'video.js' {
  interface VideoJS {
    VERSION: string;
    getPluginVersion(plugin: string): string;
    Player: any;
    (element: HTMLElement, options?: any, ready?: () => void): any;
  }

  const videojs: VideoJS;
  export default videojs;
}

declare module 'videojs-record/dist/videojs.record.js' {
  import videojs from 'video.js';

  interface RecordOptions {
    audio?: boolean;
    video?: boolean;
    maxLength?: number;
    debug?: boolean;
    videoMimeType?: string;
    videoBitsPerSecond?: number;
    audioBitsPerSecond?: number;
    frameRate?: number;
    frameSize?: number;
    controlBar?: {
      recordToggle?: boolean;
    };
  }

  interface RecordPlugin {
    start(): void;
    stop(): void;
    pause(): void;
    resume(): void;
    getDevice(): Promise<void>;
    destroy(): void;
  }

  interface Player extends videojs.Player {
    record(): RecordPlugin;
    recordedData?: Blob;
    deviceErrorCode?: string;
    isDisposed(): boolean;
  }

  const Record: (options?: RecordOptions) => void;
  export default Record;
} 