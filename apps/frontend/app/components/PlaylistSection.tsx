import React, { useState, useRef, useEffect, useCallback } from 'react';
import { RecordedSegment } from './types';
import { PhoneticDisplay } from './PhoneticDisplay';

export const PlaylistSection: React.FC = () => {
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
      setCurrentTrackIndex(nextTrackWouldBe);
    } else {
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
          audioPlayerRef.current.load();
        }
      } else if (!newIsPlaying && audioPlayerRef.current) {
        audioPlayerRef.current.pause();
      }
      return newIsPlaying;
    });
  }, [playlist, currentTrackIndex]);

  const twButtonBase = "px-6 py-3 rounded-xl text-base font-semibold shadow-lg transition-all duration-150 focus:outline-none focus:ring-4 focus:ring-opacity-50 active:transform active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed";
  const twSuccessButton = `${twButtonBase} bg-emerald-500 text-white hover:bg-emerald-600 focus:ring-emerald-400`;

  return (
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
          <PhoneticDisplay ipa={currentPlayingInfo.phonetic_ipa} syllables={currentPlayingInfo.phonetic_syllables} />
        </div>
      )}

      <audio 
        ref={audioPlayerRef} 
        onEnded={handleAudioEnded}
        onPlay={() => setIsPlayingPlaylist(true)}
        onPause={() => setIsPlayingPlaylist(false)}
        className="w-full rounded-lg custom-audio-controls"
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
  );
}; 