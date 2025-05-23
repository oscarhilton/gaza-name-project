'use client';

import React, { useState } from 'react';
import { UnrecordedName } from './components/types';
import { RecordingSection } from './components/RecordingSection';
import { PlaylistSection } from './components/PlaylistSection';
import { NameFetcher } from './components/NameFetcher';

export default function Page() {
  const [availableNames, setAvailableNames] = useState<UnrecordedName[]>([]);
  const [selectedNameId, setSelectedNameId] = useState<number | null>(null);
  const [isLoadingNames, setIsLoadingNames] = useState(false);
  const [fetchNamesError, setFetchNamesError] = useState<string | null>(null);
  const [recordingType, setRecordingType] = useState<'audio' | 'video'>('audio');

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

        {/* Recording Type Selection */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setRecordingType('audio')}
            className={`px-4 py-2 rounded-lg ${
              recordingType === 'audio'
                ? 'bg-sky-500 text-white'
                : 'bg-slate-700 text-slate-300'
            }`}
          >
            Audio Recording
          </button>
          <button
            onClick={() => setRecordingType('video')}
            className={`px-4 py-2 rounded-lg ${
              recordingType === 'video'
                ? 'bg-sky-500 text-white'
                : 'bg-slate-700 text-slate-300'
            }`}
          >
            Video Recording
          </button>
        </div>

        {/* Name Fetcher (invisible component that handles data fetching) */}
        <NameFetcher
          onNamesLoaded={setAvailableNames}
          onError={setFetchNamesError}
          onLoadingChange={setIsLoadingNames}
        />

        {/* Recording Section */}
        <RecordingSection
          availableNames={availableNames}
          isLoadingNames={isLoadingNames}
          fetchNamesError={fetchNamesError}
          onNameSelect={setSelectedNameId}
          selectedNameId={selectedNameId}
          onUploadComplete={() => {
            // Refresh names after upload
            setIsLoadingNames(true);
            setFetchNamesError(null);
          }}
        />

        {/* Playlist Section */}
        <PlaylistSection />

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