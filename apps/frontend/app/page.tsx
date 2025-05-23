'use client';

import React, { useState } from 'react';
import { UnrecordedName } from './components/types';
import dynamic from 'next/dynamic';
import { PlaylistSection } from './components/PlaylistSection';
import { NameFetcher } from './components/NameFetcher';

// Dynamically import components that use browser APIs
const RecordingSection = dynamic(() => import('./components/RecordingSection').then(mod => mod.RecordingSection), {
  ssr: false,
  loading: () => (
    <div className="bg-slate-800 shadow-2xl rounded-2xl p-6 md:p-10 space-y-8 ring-1 ring-slate-700">
      <div className="animate-pulse">
        <div className="h-8 bg-slate-700 rounded w-1/3 mb-8"></div>
        <div className="h-64 bg-slate-700 rounded"></div>
      </div>
    </div>
  ),
});

export default function Page() {
  const [availableNames, setAvailableNames] = useState<UnrecordedName[]>([]);
  const [selectedNameId, setSelectedNameId] = useState<number | null>(null);
  const [isLoadingNames, setIsLoadingNames] = useState(false);
  const [fetchNamesError, setFetchNamesError] = useState<string | null>(null);

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