export interface UnrecordedName {
  db_id: number;
  en_name: string;
  name: string; 
  age: number | null;
  sex: string | null;
  phonetic_ipa: string | null;
  phonetic_syllables: string | null;
}

export interface RecordedSegment {
  db_id: number;
  en_name: string;
  name: string; 
  age: number | null;
  sex: string | null;
  processed_audio_path: string;
  processed_video_path: string | null;
  phonetic_ipa: string | null;
  phonetic_syllables: string | null;
}

export type RecordRTCType = any; // Using any temporarily to resolve the type issue 