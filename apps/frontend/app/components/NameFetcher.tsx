import React, { useState, useCallback, useEffect } from 'react';
import { UnrecordedName } from './types';

interface NameFetcherProps {
  onNamesLoaded: (names: UnrecordedName[]) => void;
  onError: (error: string | null) => void;
  onLoadingChange: (isLoading: boolean) => void;
}

export const NameFetcher: React.FC<NameFetcherProps> = ({
  onNamesLoaded,
  onError,
  onLoadingChange
}) => {
  const fetchUnrecordedNames = useCallback(async () => {
    onLoadingChange(true);
    onError(null);
    try {
      const response = await fetch('/api/get-unrecorded-names?limit=200');
      if (!response.ok) throw new Error(`Failed to fetch unrecorded names: ${response.status} ${response.statusText}`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid data for unrecorded names.');
      onNamesLoaded(data as UnrecordedName[]);
    } catch (err: any) { 
      console.error("Error fetching unrecorded names:", err);
      onError(err.message || 'Could not fetch names.'); 
      onNamesLoaded([]); 
    }
    onLoadingChange(false);
  }, [onNamesLoaded, onError, onLoadingChange]);

  useEffect(() => {
    fetchUnrecordedNames();
  }, [fetchUnrecordedNames]);

  return null; // This is a logic-only component
}; 