'use client'

import React, { useState, useCallback } from 'react';
import { UnrecordedName } from './types';
import { NameSelector } from './NameSelector';
import dynamic from 'next/dynamic';
import { v4 as uuidv4 } from 'uuid';

// Dynamically import RecordingControls to ensure browser APIs are only used on client
const RecordingControls = dynamic(() => import('./RecordingControls').then(mod => mod.RecordingControls), {
  ssr: false,
});

interface RecordingSectionProps {
  availableNames: UnrecordedName[];
  isLoadingNames: boolean;
  fetchNamesError: string | null;
  onNameSelect: (id: number | null) => void;
  selectedNameId: number | null;
  onUploadComplete: () => void;
}

export const RecordingSection: React.FC<RecordingSectionProps> = ({
  availableNames,
  isLoadingNames,
  fetchNamesError,
  onNameSelect,
  selectedNameId,
  onUploadComplete
}) => {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const uploadMedia = useCallback(async (blob: Blob) => {
    if (!selectedNameId) {
      throw new Error('No name selected');
    }

    const CHUNK_SIZE = 512 * 1024; // 512KB chunks
    const totalSize = blob.size;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    const uploadId = uuidv4();

    console.log('Starting chunked upload:', {
      totalSize,
      totalChunks,
      uploadId,
      selectedNameId
    });

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalSize);
        const chunk = blob.slice(start, end);

        console.log(`Processing chunk ${chunkIndex + 1}/${totalChunks}:`, {
          chunkSize: chunk.size,
          start,
          end,
          totalSize
        });

        if (chunk.size > CHUNK_SIZE) {
          throw new Error(`Chunk ${chunkIndex + 1} is too large (${chunk.size} bytes)`);
        }

        const formData = new FormData();
        formData.append('chunk', chunk);
        formData.append('chunkIndex', chunkIndex.toString());
        formData.append('totalChunks', totalChunks.toString());
        formData.append('uploadId', uploadId);
        formData.append('selectedNameId', selectedNameId.toString());
        formData.append('fileName', `rec_name_${selectedNameId}.webm`);

        const progress = Math.round(((chunkIndex + 1) / totalChunks) * 90); // Max 90% for chunk upload
        setUploadProgress(progress);
        setUploadStatus(`Uploading chunk ${chunkIndex + 1}/${totalChunks} (${progress}%)`);

        // Retry logic for chunk upload
        let retryCount = 0;
        const maxRetries = 3;
        let lastError: Error | null = null;

        while (retryCount < maxRetries) {
          try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/upload-video-chunk`, {
              method: 'POST',
              body: formData,
            });

            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.message || `Upload failed: ${response.statusText}`);
            }

            const result = await response.json();
            console.log(`Chunk ${chunkIndex + 1} upload result:`, result);
            
            // If this was the last chunk and backend indicates completion
            if (result.isComplete || (chunkIndex === totalChunks - 1)) {
              setUploadStatus('Processing upload...');
              setUploadProgress(90);
              
              console.log('Starting finalization process...');
              // Wait for backend processing to complete with streaming updates
              const finalizeResponse = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/finalize-video-upload`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  uploadId,
                  selectedNameId,
                  fileName: `rec_name_${selectedNameId}.webm`
                }),
              });

              if (!finalizeResponse.ok) {
                const errorData = await finalizeResponse.json().catch(() => ({}));
                throw new Error(errorData.message || 'Failed to finalize upload');
              }

              console.log('Starting to read streaming response...');
              // Handle streaming response
              const reader = finalizeResponse.body?.getReader();
              if (!reader) {
                throw new Error('Failed to get response reader');
              }

              let buffer = '';
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Convert the chunk to text and add to buffer
                const chunk = new TextDecoder().decode(value);
                buffer += chunk;

                // Process complete lines
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                  const line = buffer.slice(0, newlineIndex).trim();
                  buffer = buffer.slice(newlineIndex + 1);

                  if (line) {
                    try {
                      const data = JSON.parse(line);
                      console.log('Received update:', data);

                      switch (data.status) {
                        case 'processing':
                          if (data.progress) {
                            const percent = data.progress.percent || 0;
                            setUploadProgress(Math.min(95, 90 + (percent * 0.05))); // Scale 0-100% to 90-95%
                            setUploadStatus(`Processing video: ${percent.toFixed(1)}%`);
                          } else {
                            setUploadStatus(data.message);
                          }
                          break;
                        case 'uploading':
                          setUploadStatus(data.message);
                          setUploadProgress(95);
                          break;
                        case 'updating':
                          setUploadStatus(data.message);
                          setUploadProgress(98);
                          break;
                        case 'complete':
                          setUploadStatus('Upload complete!');
                          setUploadProgress(100);
                          onUploadComplete();
                          break;
                        case 'error':
                          throw new Error(data.error || 'Unknown error during processing');
                      }
                    } catch (parseError) {
                      console.error('Error parsing update:', parseError, 'Line:', line);
                    }
                  }
                }
              }

              // Process any remaining data in the buffer
              if (buffer.trim()) {
                try {
                  const data = JSON.parse(buffer);
                  console.log('Processing final update:', data);
                  if (data.status === 'complete') {
                    setUploadStatus('Upload complete!');
                    setUploadProgress(100);
                    onUploadComplete();
                  }
                } catch (parseError) {
                  console.error('Error parsing final update:', parseError);
                }
              }
            }
            break; // Success, exit retry loop
          } catch (error) {
            lastError = error as Error;
            retryCount++;
            if (retryCount < maxRetries) {
              console.warn(`Retrying chunk ${chunkIndex + 1} (attempt ${retryCount + 1}/${maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
            }
          }
        }

        if (retryCount === maxRetries && lastError) {
          throw new Error(`Failed to upload chunk ${chunkIndex + 1} after ${maxRetries} attempts: ${lastError.message}`);
        }
      }
    } catch (error) {
      console.error('Upload failed:', error);
      setUploadStatus(`Upload failed: ${(error as Error).message}`);
      setUploadProgress(0);
      throw error;
    }
  }, [selectedNameId, onUploadComplete]);

  return (
    <section className="bg-slate-800 shadow-2xl rounded-2xl p-6 md:p-10 space-y-8 ring-1 ring-slate-700">
      <h2 className="text-3xl font-bold text-slate-200 border-b-2 border-teal-500 pb-4 mb-8">Contribute Your Voice</h2>
      
      <NameSelector
        availableNames={availableNames}
        isLoadingNames={isLoadingNames}
        fetchNamesError={fetchNamesError}
        onNameSelect={onNameSelect}
        selectedNameId={selectedNameId}
        isRecording={false}
      />

      <RecordingControls
        selectedNameId={selectedNameId}
        isLoadingNames={isLoadingNames}
        error={error}
        isUploading={isUploading}
        uploadProgress={uploadProgress}
        uploadStatus={uploadStatus}
        onUpload={uploadMedia}
      />
    </section>
  );
}; 