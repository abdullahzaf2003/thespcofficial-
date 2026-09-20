import { useEffect, useRef } from 'react';
import type { RemotePeer } from '../lib/useCallSession';

type VideoTileProps = {
  stream: MediaStream | null;
  label: string;
  sublabel?: string;
  muted?: boolean;
  mirrored?: boolean;
  compact?: boolean;
};

export function VideoTile({ stream, label, sublabel, muted, mirrored, compact }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    // srcObject cannot be set through JSX, so it is assigned imperatively.
    element.srcObject = stream;
    if (stream) void element.play().catch(() => {});
  }, [stream]);

  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-slate-800 ${
        compact ? 'aspect-video w-44' : 'aspect-video w-full'
      }`}
    >
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          className={`h-full w-full object-cover ${mirrored ? 'scale-x-[-1]' : ''}`}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-slate-500">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-800 text-lg font-bold text-slate-400">
            {label.slice(0, 1).toUpperCase()}
          </div>
          <span className="text-xs">Waiting for video…</span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{label}</div>
          {sublabel && <div className="truncate text-[11px] text-slate-300">{sublabel}</div>}
        </div>
      </div>
    </div>
  );
}

type ControlsProps = {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onEnd?: () => void;
  endLabel?: string;
  disabled?: boolean;
};

export function CallControls({ micOn, camOn, onToggleMic, onToggleCam, onEnd, endLabel, disabled }: ControlsProps) {
  const base = 'rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-40';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onToggleMic}
        disabled={disabled}
        aria-pressed={micOn}
        className={`${base} ${micOn ? 'bg-slate-200 text-slate-800' : 'bg-red-100 text-red-700'}`}
      >
        {micOn ? 'Mute' : 'Unmute'}
      </button>
      <button
        type="button"
        onClick={onToggleCam}
        disabled={disabled}
        aria-pressed={camOn}
        className={`${base} ${camOn ? 'bg-slate-200 text-slate-800' : 'bg-red-100 text-red-700'}`}
      >
        {camOn ? 'Stop video' : 'Start video'}
      </button>
      {onEnd && (
        <button type="button" onClick={onEnd} className={`${base} bg-red-600 text-white hover:bg-red-700`}>
          {endLabel || 'End call'}
        </button>
      )}
    </div>
  );
}

export function ConnectionBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    idle: { label: 'Idle', className: 'bg-slate-100 text-slate-600' },
    connecting: { label: 'Connecting…', className: 'bg-amber-100 text-amber-700' },
    connected: { label: 'Live', className: 'bg-green-100 text-green-700' },
    reconnecting: { label: 'Reconnecting…', className: 'bg-amber-100 text-amber-700' },
    ended: { label: 'Ended', className: 'bg-slate-200 text-slate-600' },
    error: { label: 'Connection problem', className: 'bg-red-100 text-red-700' },
  };
  const tone = map[status] || map.idle;

  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${tone.className}`}>
      <span className={`h-2 w-2 rounded-full ${status === 'connected' ? 'bg-green-500' : 'bg-current opacity-60'}`} />
      {tone.label}
    </span>
  );
}

type StageProps = {
  peers: RemotePeer[];
  remotes: Record<string, MediaStream>;
  localStream: MediaStream | null;
  localLabel: string;
  emptyMessage: string;
};

export function VideoStage({ peers, remotes, localStream, localLabel, emptyMessage }: StageProps) {
  return (
    <div className="relative">
      {peers.length === 0 ? (
        <div className="flex aspect-video w-full items-center justify-center rounded-2xl bg-slate-900 text-center text-sm text-slate-400 ring-1 ring-slate-800">
          <span className="max-w-xs px-6">{emptyMessage}</span>
        </div>
      ) : (
        <div className={`grid gap-3 ${peers.length > 1 ? 'sm:grid-cols-2' : ''}`}>
          {peers.map((peer) => (
            <VideoTile
              key={peer.id}
              stream={remotes[peer.id] || null}
              label={peer.name}
              sublabel={peer.role === 'patient' ? 'Patient' : peer.role === 'doctor' ? 'Doctor' : 'Reception'}
            />
          ))}
        </div>
      )}

      <div className="absolute bottom-3 right-3">
        <VideoTile stream={localStream} label={localLabel} sublabel="You" muted mirrored compact />
      </div>
    </div>
  );
}
