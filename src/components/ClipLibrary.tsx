import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AudioLines, Clock3, LoaderCircle, Plus, UploadCloud, Waves } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Clip } from "../lib/domain";
import { formatDuration } from "../lib/domain";
import { ClipPlayer } from "./ClipPlayer";

type Props = { clips: Clip[]; onCreated: (clip: Clip) => void };

export function ClipLibrary({ clips, onCreated }: Props) {
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("8");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!file) return;
    const source = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(String(Math.ceil(audio.duration)));
      }
    };
    audio.src = source;
    return () => {
      audio.onloadedmetadata = null;
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(source);
    };
  }, [file]);

  const addClip = async () => {
    if (!name.trim()) return;
    if (!Number.isInteger(Number(duration)) || Number(duration) < 1 || Number(duration) > 180) {
      setError("Clip duration must be between 1 and 180 seconds.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!file) {
        setError("Select a WAV or MP3 file.");
        return;
      }
      const clip = await api.uploadClip(file, name.trim(), Number(duration));
      onCreated(clip);
      setName("");
      setDuration("8");
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = "";
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not add clip.");
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = (selected?: File) => {
    if (!selected || busy) return;
    setError("");
    if (!/\.(wav|mp3)$/i.test(selected.name)) {
      setFile(undefined);
      setError("Only WAV and MP3 audio clips are supported.");
      return;
    }
    if (selected.size > 10 * 1024 * 1024) {
      setFile(undefined);
      setError("Audio clips must be 10 MB or smaller.");
      return;
    }
    setFile(selected);
    setName((current) => current.trim() ? current : selected.name.replace(/\.(wav|mp3)$/i, "").slice(0, 80));
  };

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    chooseFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    if (event.dataTransfer.files.length !== 1) {
      setError("Drop one audio file at a time.");
      return;
    }
    chooseFile(event.dataTransfer.files[0]);
  };

  return (
    <div
      className={`library-view ${dragging ? "is-dragging-file" : ""}`}
      onDragEnter={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        if (!busy) setDragging(true);
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!isFileDrag(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={dropFile}
    >
      <section className="library-header">
        <div>
          <span className="eyebrow"><AudioLines size={14} /> Audio library</span>
          <h1>Approved voice clips</h1>
          <p>Only ready clips can be attached to a published call flow.</p>
        </div>
        <label className="library-upload">
          <UploadCloud size={18} />
          <div>
            <strong>{dragging ? "Drop your audio file here" : file ? file.name : "Drop audio here or choose a file"}</strong>
            <span>WAV or MP3 · Up to 10 MB</span>
          </div>
          <input ref={fileInput} type="file" aria-label="Choose audio file" accept="audio/wav,.wav,audio/mpeg,.mp3" onChange={selectFile} disabled={busy} />
        </label>
      </section>
      <section className="clip-create" aria-label="Create audio clip">
        <label className="field-label">Clip name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Appointment reminder" disabled={busy} /></label>
        <label className="field-label">Duration (seconds)<input type="number" min="1" max="180" value={duration} onChange={(event) => setDuration(event.target.value)} disabled={busy} /></label>
        <button className="primary-button" onClick={addClip} disabled={busy || !name.trim() || !file}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} Upload clip</button>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="clip-grid">
        {clips.map((clip) => (
          <article className={`clip-card clip-card--${clip.color}`} key={clip.id}>
            <div className="clip-card__top"><span className="clip-wave"><Waves size={18} /></span><span className={`clip-status clip-status--${clip.status}`}>{clip.previewUrl && !clip.assetUrl ? "Sample" : clip.status}</span></div>
            <h2>{clip.name}</h2>
            <ClipPlayer clip={clip} />
            <footer><span><Clock3 size={13} /> {formatDuration(clip.durationSeconds)}</span><span>{clip.usedBy} flow{clip.usedBy === 1 ? "" : "s"}</span></footer>
          </article>
        ))}
      </section>
    </div>
  );
}
