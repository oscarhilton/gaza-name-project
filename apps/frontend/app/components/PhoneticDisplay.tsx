interface PhoneticDisplayProps {
  ipa: string | null;
  syllables: string | null;
}

export const PhoneticDisplay = ({ ipa, syllables }: PhoneticDisplayProps) => {
  if (!ipa && !syllables) return null;
  
  return (
    <div className="mt-2 text-sm text-slate-400">
      {ipa && (
        <div className="mb-1">
          <span className="font-mono">IPA: </span>
          <span className="italic">{ipa}</span>
        </div>
      )}
      {syllables && (
        <div>
          <span className="font-mono">Syllables: </span>
          <span className="italic">{syllables}</span>
        </div>
      )}
    </div>
  );
}; 