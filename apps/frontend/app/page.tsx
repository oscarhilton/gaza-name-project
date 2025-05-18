'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';

interface UnrecordedName {
  db_id: number;
  en_name: string;
  name: string; 
  age: number | null;
  sex: string | null;
}

interface RecordedSegment {
  db_id: number;
  en_name: string;
  name: string; 
  age: number | null;
  sex: string | null;
  processed_audio_path: string;
}

export default function Page() {
  // --- State for Recording Section ---
  const [isRecording, setIsRecording] = useState(false);
  const [audioURL, setAudioURL] = useState<string | null>(null); 
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [availableNames, setAvailableNames] = useState<UnrecordedName[]>([]);
  const [selectedNameId, setSelectedNameId] = useState<number | null>(null);
  const [isLoadingNames, setIsLoadingNames] = useState(false);
  const [fetchNamesError, setFetchNamesError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  // --- State for Dynamic Playlist Section ---
  const [playlist, setPlaylist] = useState<RecordedSegment[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [isPlayingPlaylist, setIsPlayingPlaylist] = useState(false);
  const [isLoadingPlaylistUI, setIsLoadingPlaylist_UI] = useState(false); 
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const [currentPlayingInfo, setCurrentPlayingInfo] = useState<RecordedSegment | null>(null);
  const isLoadingPlaylistRef = useRef(false);

  // --- Function Definitions (Order Matters for useCallback dependencies) ---

  const fetchUnrecordedNames = useCallback(async () => {
    setIsLoadingNames(true);
    setFetchNamesError(null);
    try {
      const response = await fetch('/api/get-unrecorded-names?limit=200');
      if (!response.ok) throw new Error(`Failed to fetch unrecorded names: ${response.status} ${response.statusText}`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid data for unrecorded names.');
      setAvailableNames(data as UnrecordedName[]);
    } catch (err: any) { 
      console.error("Error fetching unrecorded names:", err);
      setFetchNamesError(err.message || 'Could not fetch names.'); 
      setAvailableNames([]); 
    }
    setIsLoadingNames(false);
  }, []);

  const loadPlaylistSegments = useCallback(async (pageToLoad: number) => {
    if (isLoadingPlaylistRef.current && pageToLoad !== 1) return;
    isLoadingPlaylistRef.current = true;
    setIsLoadingPlaylist_UI(true); 
    setPlaylistError(null);
    try {
      const response = await fetch(`/api/recorded-segments?page=${pageToLoad}&limit=10`);
      if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`);
      const data = await response.json();
      if (!data.segments || !Array.isArray(data.segments)) throw new Error('Invalid playlist data.');
      setPlaylist(prev => pageToLoad === 1 ? data.segments : [...prev, ...data.segments]);
      setCurrentPage(pageToLoad);
      setTotalPages(data.totalPages);
    } catch (err: any) {
      console.error("Error fetching playlist segments:", err);
      setPlaylistError(err.message);
      if (pageToLoad === 1) setPlaylist([]);
    } finally {
      isLoadingPlaylistRef.current = false;
      setIsLoadingPlaylist_UI(false);
    }
  }, []);

  const requestMicrophonePermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return stream;
    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Microphone access denied. Please allow microphone access in your browser settings.");
      return null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!selectedNameId) {
      alert('Please select a name to record first.');
      return;
    }
    const stream = await requestMicrophonePermission();
    if (!stream) return;
    setAudioURL(null);
    audioChunksRef.current = [];
    try {
      // Prefer webm for broader compatibility if available, then fallback or let browser decide
      let mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        console.warn("audio/webm not supported, trying audio/ogg");
        mimeType = 'audio/ogg; codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          console.warn("audio/ogg not supported, letting browser pick default (likely wav or mp4 audio)");
          mimeType = ''; // Let browser pick default
        }
      }
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) audioChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blobType = mediaRecorderRef.current?.mimeType || 'audio/wav'; // Use actual mimeType if available
        const audioBlob = new Blob(audioChunksRef.current, { type: blobType });
        const url = URL.createObjectURL(audioBlob);
        setAudioURL(url);
        stream.getTracks().forEach(track => track.stop());
      };
      recorder.start();
      setIsRecording(true);
      setUploadStatus(null);
    } catch (e) {
      console.error("Error creating MediaRecorder:", e);
      alert("Could not start recorder. Your browser might not support the recording format, or an error occurred.");
    }
  }, [selectedNameId, requestMicrophonePermission]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  const uploadAudio = useCallback(async () => {
    if (!audioURL || audioChunksRef.current.length === 0 || !selectedNameId) {
        alert('No audio recorded or name selected to upload.');
        return;
    }
    setIsUploading(true); setUploadStatus('Uploading...');
    
    const blobType = mediaRecorderRef.current?.mimeType || 'audio/webm'; // Default to webm for filename if unknown
    let fileExtension = '.webm';
    if (blobType.includes('ogg')) fileExtension = '.ogg';
    if (blobType.includes('wav')) fileExtension = '.wav';
    // Add more specific extensions if needed, or let backend ffmpeg handle conversion based on general audio input

    const audioBlob = new Blob(audioChunksRef.current, { type: blobType });
    const formData = new FormData();
    // Backend's FFmpeg is robust, so sending with original extension is fine.
    // The backend `outputFileName` logic determines the *processed* format as .wav.
    formData.append('audio', audioBlob, `rec_name_${selectedNameId}${fileExtension}`); 
    formData.append('selectedNameId', selectedNameId.toString());
    try {
      const response = await fetch('/api/upload-audio', { method: 'POST', body: formData });
      const result = await response.json(); 
      if (!response.ok) throw new Error(result.message || `Upload failed: ${response.status}`);
      setUploadStatus(`Success: ${result.message} (DB: ${result.dbMarkUpdate?.message || 'N/A'})`);
      setAudioURL(null); audioChunksRef.current = [];
      alert('Upload successful! Thank you for your contribution.');
      setSelectedNameId(null);
      fetchUnrecordedNames(); 
      await loadPlaylistSegments(1); // Refresh playlist from page 1
      setCurrentTrackIndex(0);     
      setIsPlayingPlaylist(false); // Stop playlist and let user decide to play again
    } catch (err: any) { 
      console.error("Upload error:", err);
      setUploadStatus(`Error: ${err.message || 'An unknown error occurred during upload.'}`); 
      alert(`Upload failed: ${err.message || 'An unknown error occurred.'}`); 
    }
    setIsUploading(false);
  }, [audioURL, selectedNameId, fetchUnrecordedNames, loadPlaylistSegments]);

  // --- useEffect Hooks ---
  useEffect(() => { fetchUnrecordedNames(); }, [fetchUnrecordedNames]);
  useEffect(() => { loadPlaylistSegments(1); }, [loadPlaylistSegments]); // Initial playlist load
  
  useEffect(() => { // Playback logic
    const audioEl = audioPlayerRef.current;
    if (!audioEl) return;
    if (playlist.length > 0 && currentTrackIndex < playlist.length) {
      const track = playlist[currentTrackIndex];
      setCurrentPlayingInfo(track);
      const newSrc = `/api/audio/${track.processed_audio_path}`;
      const currentFullSrc = audioEl.currentSrc;
      const newFullSrcExpected = new URL(newSrc, window.location.origin).href;
      if (currentFullSrc !== newFullSrcExpected) { audioEl.src = newSrc; audioEl.load();}
      const handleCanPlay = () => { if (isPlayingPlaylist) audioEl.play().catch(e => console.error("Play err [canplay]:", e)); };
      if (isPlayingPlaylist) {
        if (audioEl.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) audioEl.play().catch(e => console.error("Play err [readyState]:", e));
        else audioEl.addEventListener('canplaythrough', handleCanPlay, { once: true });
      } else audioEl.pause();
      return () => audioEl.removeEventListener('canplaythrough', handleCanPlay);
    } else if (playlist.length === 0 && audioEl.src !== '') { audioEl.src = ''; setCurrentPlayingInfo(null); }
  }, [currentTrackIndex, playlist, isPlayingPlaylist]);

  const handleAudioEnded = useCallback(async () => {
    const nextTrackWouldBe = currentTrackIndex + 1;
    if (nextTrackWouldBe < playlist.length) {
      setCurrentTrackIndex(nextTrackWouldBe);
    } else if (currentPage < totalPages) {
      await loadPlaylistSegments(currentPage + 1);
      // After new segments are appended, nextTrackWouldBe is the correct index for the new items
      setCurrentTrackIndex(nextTrackWouldBe);
    } else {
      // True full loop: Re-fetch the first page
      await loadPlaylistSegments(1);
      setCurrentTrackIndex(0); 
    }
  }, [currentTrackIndex, playlist.length, currentPage, totalPages, loadPlaylistSegments]);
  
  const togglePlaylistPlay = useCallback(() => {
    setIsPlayingPlaylist(prevIsPlaying => {
      const newIsPlaying = !prevIsPlaying;
      if (newIsPlaying && audioPlayerRef.current && playlist.length > 0 && currentTrackIndex < playlist.length) {
        if (!audioPlayerRef.current.src || audioPlayerRef.current.src !== `/api/audio/${playlist[currentTrackIndex].processed_audio_path}`) {
          audioPlayerRef.current.src = `/api/audio/${playlist[currentTrackIndex].processed_audio_path}`;
          audioPlayerRef.current.load(); // Important if src was empty or changed
        }
        // Playback useEffect will handle audioEl.play() based on isPlayingPlaylist state
      } else if (!newIsPlaying && audioPlayerRef.current) {
        audioPlayerRef.current.pause();
      }
      return newIsPlaying;
    });
  }, [playlist, currentTrackIndex]);

  // Tailwind common button styles
  const twButtonBase = "px-6 py-3 rounded-xl text-base font-semibold shadow-lg transition-all duration-150 focus:outline-none focus:ring-4 focus:ring-opacity-50 active:transform active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed";
  const twPrimaryButton = `${twButtonBase} bg-sky-500 text-white hover:bg-sky-600 focus:ring-sky-400`;
  const twSecondaryButton = `${twButtonBase} bg-slate-600 text-slate-100 hover:bg-slate-700 focus:ring-slate-500`;
  const twSuccessButton = `${twButtonBase} bg-emerald-500 text-white hover:bg-emerald-600 focus:ring-emerald-400`;
  // Removed twDisabledButton as Tailwind v3+ handles disabled: states directly in class string

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-8 font-sans selection:bg-teal-500 selection:text-white">
      <div className="w-full max-w-3xl mx-auto space-y-16">
        <header className="text-center py-8">
          <h1 className="text-5xl md:text-6xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-rose-400 to-lime-400">
            Voice for Palestine
          </h1>
          <p className="mt-4 text-lg text-slate-400 max-w-2xl mx-auto">
            Record a name, contribute your voice. Each recording becomes part of a continuous audio piece, honoring those we've lost.
          </p>
        </header>

        {/* --- Recording Section --- */}
        <section className="bg-slate-800 shadow-2xl rounded-2xl p-6 md:p-10 space-y-8 ring-1 ring-slate-700">
          <h2 className="text-3xl font-bold text-slate-200 border-b-2 border-teal-500 pb-4 mb-8">Contribute Your Voice</h2>
          
          <div className="space-y-4">
            <label htmlFor="name-select" className="block text-lg font-medium text-slate-300 mb-1">1. Select a Name to Record:</label>
            {isLoadingNames && 
              <div className="animate-pulse h-14 bg-slate-700 rounded-xl w-full"></div>
            }
            {fetchNamesError && 
              <p className="text-red-400 bg-red-900/30 p-3 rounded-md text-sm">Error loading names: {fetchNamesError}. Please try refreshing the page.</p>
            }
            {!isLoadingNames && !fetchNamesError && availableNames.length === 0 && (
              <p className="text-slate-500 p-4 bg-slate-700/50 rounded-xl">No names currently available for recording. All names may have been recorded, or there was an issue fetching them. Try refreshing.</p>
            )}
            {!isLoadingNames && availableNames.length > 0 && (
              <div className="relative">
                <select 
                  id="name-select"
                  value={selectedNameId || ''} 
                  onChange={(e) => setSelectedNameId(Number(e.target.value) || null)}
                  className={`w-full p-4 pr-10 bg-slate-700 border border-slate-600 rounded-xl text-slate-200 text-base focus:ring-2 focus:ring-teal-500 focus:border-teal-500 appearance-none ${isRecording ? 'opacity-60 cursor-not-allowed' : ''}`}
                  disabled={isRecording}
                >
                  <option value="" className="text-slate-500 bg-slate-700">-- Select a Name --</option>
                  {availableNames.map((name) => (
                    <option key={name.db_id} value={name.db_id} className="text-slate-200 bg-slate-700 py-1">
                      {name.en_name} ({name.name}) - Age: {name.age ?? 'N/A'}, Sex: {name.sex ?? 'N/A'}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-400">
                  <svg className="fill-current h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4 pt-4">
            <label className="block text-lg font-medium text-slate-300 mb-1">2. Record Audio:</label>
            <div className="flex flex-col sm:flex-row gap-4">
              {!isRecording ? (
                <button onClick={startRecording} className={`${twPrimaryButton} flex-1`} disabled={!selectedNameId || isLoadingNames}>
                  Start Recording
                </button>
              ) : (
                <button onClick={stopRecording} className={`${twSecondaryButton} flex-1`} disabled={!isRecording}>
                  Stop Recording
                </button>
              )}
            </div>
          </div>

          {audioURL && (
            <div className="mt-8 p-6 bg-slate-700/50 rounded-xl space-y-4 ring-1 ring-slate-600">
              <h3 className="text-lg font-semibold text-slate-300">3. Review & Upload Your Recording:</h3>
              <audio src={audioURL} controls className="w-full rounded-md h-12" />
              <button onClick={uploadAudio} className={`${twSuccessButton} w-full sm:w-auto`} disabled={isUploading || !selectedNameId || !audioURL}>
                {isUploading ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    Uploading...
                  </span>
                ) : 'Confirm & Upload Recording'}
              </button>
              {uploadStatus && <p className={`mt-2 text-sm p-3 rounded-md ${uploadStatus.startsWith('Error') ? 'text-red-400 bg-red-900/40' : 'text-green-400 bg-green-900/40'}`}>{uploadStatus}</p>}
            </div>
          )}
        </section>

        {/* --- Dynamic Playlist Section (Re-introducing with Tailwind) --- */}
        <section className="bg-slate-800 shadow-2xl rounded-2xl p-6 md:p-10 space-y-8 ring-1 ring-slate-700">
          <h2 className="text-3xl font-bold text-slate-200 border-b-2 border-green-500 pb-4 mb-8">The Collective Voice: Continuous Loop</h2>
          
          {playlistError && <p className="text-red-400 bg-red-900/30 p-3 rounded-md">Error loading playlist: {playlistError}</p>}
          
          {currentPlayingInfo && (
            <div className="my-6 p-6 bg-slate-700/50 rounded-xl text-center ring-1 ring-slate-600">
              <p className="text-sm text-teal-400 font-medium uppercase tracking-wider">Now Playing</p>
              <p className="text-3xl font-bold text-slate-100 mt-2">{currentPlayingInfo.en_name}</p>
              <p className="text-xl text-slate-300 mt-1">({currentPlayingInfo.name})</p>
              <p className="text-base text-slate-400 mt-2">
                Age: {currentPlayingInfo.age ?? 'Unknown'} &bull; Sex: {currentPlayingInfo.sex === 'm' ? 'Male' : currentPlayingInfo.sex === 'f' ? 'Female' : 'Unknown'}
              </p>
            </div>
          )}

          <audio 
            ref={audioPlayerRef} 
            onEnded={handleAudioEnded}
            onPlay={() => setIsPlayingPlaylist(true)}
            onPause={() => setIsPlayingPlaylist(false)}
            className="w-full rounded-lg custom-audio-controls" // We can add custom styling to controls later if needed
            controls 
          >
            Your browser does not support the audio element.
          </audio>
          
          <div className="mt-6 flex flex-col sm:flex-row justify-center items-center gap-4">
            <button onClick={togglePlaylistPlay} className={`${twSuccessButton} w-full sm:w-auto`} disabled={playlist.length === 0 && !isLoadingPlaylistUI}>
              {isPlayingPlaylist ? 'Pause Loop' : 'Play Loop'}
            </button>
          </div>

          {isLoadingPlaylistUI && 
            <div className="flex justify-center items-center mt-4 space-x-2 text-slate-400">
                <svg className="animate-spin h-5 w-5 text-teal-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                <span>Loading more contributions...</span>
            </div>
          }
          {playlist.length === 0 && !isLoadingPlaylistUI && !playlistError && 
            <p className="text-slate-500 text-center mt-4 p-3 bg-slate-700/50 rounded-md">No recordings in the playlist yet. Be the first to contribute, or check back soon!</p>
          }
        </section>

        <footer className="text-center py-10 mt-12 border-t border-slate-700 w-full">
          <p className="text-slate-500 text-sm">
            This project is a personal initiative for remembrance and human rights advocacy.
          </p>
          <p className="text-slate-600 text-xs mt-2">
            Data on names sourced from <a href="https://data.techforpalestine.org/docs/killed-in-gaza/" target="_blank" rel="noopener noreferrer" className="hover:text-teal-400 underline">Tech For Palestine</a>.
          </p>
        </footer>
      </div>
    </div>
  );
} 