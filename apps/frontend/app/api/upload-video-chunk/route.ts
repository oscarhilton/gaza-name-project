import { NextRequest, NextResponse } from 'next/server';

// Configure the API route to handle raw binary data
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes
export const runtime = 'nodejs';

// Store for temporary upload chunks
const uploadChunks = new Map<string, {
  chunks: Buffer[],
  totalChunks: number,
  lastActivity: number,
  selectedNameId: number,
  fileName: string
}>();

// Cleanup old chunks periodically
setInterval(() => {
  const now = Date.now();
  Array.from(uploadChunks.entries()).forEach(([uploadId, data]) => {
    if (now - data.lastActivity > 3600000) { // 1 hour
      console.log(`Cleaning up stale upload: ${uploadId}`);
      uploadChunks.delete(uploadId);
    }
  });
}, 300000); // Check every 5 minutes

export async function POST(req: NextRequest) {
  try {
    // Parse form data
    const formData = await req.formData();
    const chunk = formData.get('chunk') as Blob;
    const uploadId = formData.get('uploadId') as string;
    const chunkIndex = parseInt(formData.get('chunkIndex') as string);
    const totalChunks = parseInt(formData.get('totalChunks') as string);
    const selectedNameId = parseInt(formData.get('selectedNameId') as string);
    const fileName = formData.get('fileName') as string;

    // Validate required fields
    if (!chunk || !uploadId || isNaN(chunkIndex) || isNaN(totalChunks) || isNaN(selectedNameId) || !fileName) {
      console.error('Missing required fields:', { chunk, uploadId, chunkIndex, totalChunks, selectedNameId, fileName });
      return NextResponse.json(
        { message: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Validate chunk size
    if (chunk.size > 1024 * 1024) { // 1MB limit
      return NextResponse.json(
        { message: 'Chunk size exceeds 1MB limit' },
        { status: 413 }
      );
    }

    // Convert chunk to buffer
    const chunkBuffer = Buffer.from(await chunk.arrayBuffer());

    // Initialize or get existing chunks
    if (!uploadChunks.has(uploadId)) {
      uploadChunks.set(uploadId, {
        chunks: new Array(totalChunks).fill(null),
        totalChunks,
        lastActivity: Date.now(),
        selectedNameId,
        fileName
      });
    }

    const upload = uploadChunks.get(uploadId)!;
    upload.lastActivity = Date.now();
    upload.chunks[chunkIndex] = chunkBuffer;

    // Check if all chunks are received
    const isComplete = upload.chunks.every(chunk => chunk !== null);
    const receivedChunks = upload.chunks.filter(chunk => chunk !== null).length;

    // If all chunks are received, send to backend
    if (isComplete) {
      try {
        // Combine chunks
        const completeBuffer = Buffer.concat(upload.chunks.filter(Boolean));
        const fileBlob = new Blob([completeBuffer], { type: 'video/x-matroska;codecs=avc1,opus' });

        // Send to backend
        const backendFormData = new FormData();
        backendFormData.append('video', fileBlob, fileName);
        backendFormData.append('selectedNameId', selectedNameId.toString());
        backendFormData.append('uploadId', uploadId);

        const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://backend:3001';
        console.log('Sending complete file to backend:', {
          url: `${backendUrl}/api/upload-video`,
          fileName,
          selectedNameId,
          fileSize: fileBlob.size,
          uploadId,
          mimeType: fileBlob.type
        });

        const response = await fetch(`${backendUrl}/api/upload-video`, {
          method: 'POST',
          body: backendFormData,
          headers: {
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(300000) // 5 minutes
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `Backend processing failed: ${response.statusText}`);
        }

        // Clean up chunks from memory
        uploadChunks.delete(uploadId);

        const result = await response.json();
        return NextResponse.json({
          message: 'Upload complete',
          isComplete: true,
          receivedChunks,
          totalChunks,
          data: result
        });
      } catch (error) {
        console.error('Error sending file to backend:', error);
        // Clean up chunks on error
        uploadChunks.delete(uploadId);
        return NextResponse.json(
          { message: 'Error processing file', error: (error as Error).message },
          { status: 500 }
        );
      }
    }

    // Return progress for incomplete uploads
    return NextResponse.json({
      message: 'Chunk uploaded successfully',
      isComplete,
      receivedChunks,
      totalChunks
    });

  } catch (error) {
    console.error('Upload handler error:', error);
    return NextResponse.json(
      { message: 'Upload failed', error: (error as Error).message },
      { status: 500 }
    );
  }
} 