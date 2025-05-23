import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { uploadId, selectedNameId, fileName } = await req.json();

    if (!uploadId || !selectedNameId || !fileName) {
      return NextResponse.json(
        { message: 'Missing required fields' },
        { status: 400 }
      );
    }

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://backend:3001';
    console.log('Finalizing upload with backend:', {
      url: `${backendUrl}/api/finalize-upload`,
      uploadId,
      selectedNameId,
      fileName,
      timestamp: new Date().toISOString()
    });

    // First, check if the upload is ready for finalization
    const checkResponse = await fetch(`${backendUrl}/api/check-upload-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ uploadId }),
      signal: AbortSignal.timeout(30000) // 30 seconds
    });

    if (!checkResponse.ok) {
      throw new Error('Upload not ready for finalization');
    }

    // Proceed with finalization
    const response = await fetch(`${backendUrl}/api/finalize-upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        uploadId,
        selectedNameId,
        fileName,
        timestamp: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(300000) // 5 minutes
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Backend finalization failed:', {
        status: response.status,
        statusText: response.statusText,
        error: errorData
      });
      throw new Error(errorData.message || `Backend finalization failed: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('Upload finalized successfully:', {
      uploadId,
      selectedNameId,
      fileName,
      result
    });

    return NextResponse.json({
      message: 'Upload finalized successfully',
      data: result
    });

  } catch (error) {
    console.error('Finalize handler error:', error);
    return NextResponse.json(
      { message: 'Finalize failed', error: (error as Error).message },
      { status: 500 }
    );
  }
} 