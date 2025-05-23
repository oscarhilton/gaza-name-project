import React from 'react';
import { UnrecordedName } from './types';
import { PhoneticDisplay } from './PhoneticDisplay';

interface NameSelectorProps {
  availableNames: UnrecordedName[];
  isLoadingNames: boolean;
  fetchNamesError: string | null;
  onNameSelect: (id: number | null) => void;
  selectedNameId: number | null;
  isRecording: boolean;
}

export const NameSelector: React.FC<NameSelectorProps> = ({
  availableNames,
  isLoadingNames,
  fetchNamesError,
  onNameSelect,
  selectedNameId,
  isRecording
}) => {
  return (
    <div className="space-y-4">
      <label htmlFor="name-select" className="block text-lg font-medium text-slate-300 mb-1">
        1. Select a Name to Record:
      </label>
      {isLoadingNames && 
        <div className="animate-pulse h-14 bg-slate-700 rounded-xl w-full"></div>
      }
      {fetchNamesError && 
        <p className="text-red-400 bg-red-900/30 p-3 rounded-md text-sm">
          Error loading names: {fetchNamesError}. Please try refreshing the page.
        </p>
      }
      {!isLoadingNames && !fetchNamesError && availableNames.length === 0 && (
        <p className="text-slate-500 p-4 bg-slate-700/50 rounded-xl">
          No names currently available for recording. All names may have been recorded, or there was an issue fetching them. Try refreshing.
        </p>
      )}
      {!isLoadingNames && availableNames.length > 0 && (
        <div className="relative">
          <select 
            id="name-select"
            value={selectedNameId || ''} 
            onChange={(e) => onNameSelect(Number(e.target.value) || null)}
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
            <svg className="fill-current h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
              <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/>
            </svg>
          </div>
        </div>
      )}

      {selectedNameId && (
        <div className="mt-4 p-4 bg-slate-700/50 rounded-xl">
          <h3 className="text-lg font-semibold text-slate-300 mb-2">Pronunciation Guide</h3>
          <PhoneticDisplay 
            ipa={availableNames.find(n => n.db_id === selectedNameId)?.phonetic_ipa ?? null} 
            syllables={availableNames.find(n => n.db_id === selectedNameId)?.phonetic_syllables ?? null} 
          />
        </div>
      )}
    </div>
  );
}; 