import { useState } from "react";
import type { Clip } from "../lib/domain";

export function ClipPlayer({ clip }: { clip: Clip }) {
  const [error, setError] = useState(false);
  const source = clip.assetUrl ?? clip.previewUrl;

  if (!source) return <p className="clip-player__message">No audio file attached. Upload a WAV or MP3 to preview it.</p>;

  return (
    <div className="clip-player">
      <audio
        key={source}
        className="clip-audio"
        aria-label={`Preview ${clip.name}`}
        controls
        preload="metadata"
        src={source}
        onLoadedMetadata={() => setError(false)}
        onError={() => setError(true)}
        onPlay={(event) => {
          document.querySelectorAll("audio").forEach((audio) => {
            if (audio !== event.currentTarget) audio.pause();
          });
        }}
      />
      {error && <p className="clip-player__message form-error" role="alert">This clip could not be played. Check that the file is available and is a supported WAV or MP3.</p>}
    </div>
  );
}
