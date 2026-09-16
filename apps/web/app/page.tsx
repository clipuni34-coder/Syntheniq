'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Clock, Lock, Sparkles, Upload, Film, ArrowUpRight } from 'lucide-react';
import {
  createProject,
  fetchConfig,
  listProjects,
  submitPasscode,
  uploadVideo,
  type ProjectSummary,
} from '@/lib/api';

const STAGE_LABELS: Record<string, string> = {
  'media-check': 'Media check',
  audio: 'Audio',
  transcribe: 'Transcribe',
  analyze: 'Analyze',
  plan: 'Clip plan',
  'prep-media': 'Prep media',
  render: 'Render',
  package: 'Package',
  qc: 'QC',
  complete: 'Complete',
};

export default function Home() {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<{ phase: 'upload' | 'processing'; pct?: number; msg?: string } | null>(null);
  const [error, setError] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [auth, setAuth] = useState<{ required: boolean; authorized: boolean } | null>(null);
  const [passcode, setPasscode] = useState('');
  const [authErr, setAuthErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshProjects = useCallback(async () => {
    setProjects((await listProjects()).slice(0, 6));
  }, []);

  useEffect(() => {
    (async () => {
      const c = await fetchConfig();
      if (!c) return;
      setAuth({ required: c.authRequired, authorized: c.authorized });
      if (!c.authRequired || c.authorized) refreshProjects();
    })();
  }, [refreshProjects]);

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submitPasscode(passcode);
    if (ok) {
      setAuth({ required: true, authorized: true });
      setPasscode('');
      setAuthErr('');
      refreshProjects();
    } else setAuthErr('Wrong passcode');
  }

  async function startUpload(file: File) {
    if (busy) return;
    if (auth?.required && !auth?.authorized) {
      setAuthErr('Enter the passcode first');
      return;
    }
    setError('');
    setBusy({ phase: 'upload', pct: 0 });
    try {
      const id = await createProject();
      if (!id) throw new Error('could not create project');
      await uploadVideo(id, file, (pct) => setBusy({ phase: 'upload', pct }));
      router.push(`/project?id=${id}`);
    } catch (e) {
      setBusy(null);
      setError((e as Error).message);
    }
  }

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand"><span className="mark">S</span><span>SYNTHENIQ</span></div>
        <div className="navRight">
          {auth?.authorized && (
            <span className="status"><i />Personal workstation</span>
          )}
        </div>
      </nav>

      <section className="hero">
        <div className="eyebrow"><Sparkles size={14} /> AI VIDEO EDITING THAT UNDERSTANDS THE STORY</div>
        <h1>Turn long videos into<br /><em>shorts worth watching.</em></h1>
        <p className="sub">
          Syntheniq transcribes your video, finds the strongest moments, writes the edit decisions,
          and renders finished 9:16 clips with kinetic captions, punch-ins and B-roll.
        </p>

        {auth?.required && !auth.authorized ? (
          <form className="passcode" onSubmit={submitAuth}>
            <div className="passIcon"><Lock size={20} /></div>
            <h2>Private interface</h2>
            <p>Enter your passcode to continue</p>
            <input
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Passcode"
              autoFocus
            />
            <button type="submit">Unlock</button>
            {authErr && <span className="err">{authErr}</span>}
          </form>
        ) : (
          <div
            className={`drop ${dragging ? 'drag' : ''} ${busy ? 'busy' : ''}`}
            onDragEnter={() => setDragging(true)}
            onDragLeave={() => setDragging(false)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) startUpload(f);
            }}
          >
            <input ref={fileRef} type="file" accept="video/*" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) startUpload(f);
            }} />
            {busy ? (
              <>
                <div className="dropIcon spin"><Upload size={24} /></div>
                <h2>{busy.phase === 'upload' ? `Uploading… ${busy.pct ?? 0}%` : 'Starting analysis…'}</h2>
                <div className="bar"><i style={{ width: `${busy.phase === 'upload' ? busy.pct ?? 0 : 100}%` }} /></div>
              </>
            ) : (
              <>
                <div className="dropIcon"><Upload size={24} /></div>
                <h2>Drop a video here</h2>
                <p>or choose a file · up to 512 MB · MP4/MOV</p>
                <button onClick={() => fileRef.current?.click()}><Upload size={17} /> Upload video</button>
              </>
            )}
          </div>
        )}
        {error && <div className="errBanner"><AlertTriangle size={15} /> {error}</div>}
        <div className="trust">
          <span><Film size={15} /> 9:16 · 1080×1920</span>
          <span><Sparkles size={15} /> Story-first clip selection</span>
          <span>H.264 + AAC · captions · B-roll · SFX</span>
        </div>
      </section>

      {projects.length > 0 && (
        <section className="recent">
          <div className="recentHead">RECENT</div>
          {projects.map((p) => (
            <button key={p.id} className="recentItem" onClick={() => router.push(`/project?id=${p.id}`)}>
              <span className={`dot ${p.status}`} />
              <span className="recentTitle">{p.title || 'Untitled project'}</span>
              <span className="recentMeta">
                {p.status === 'done'
                  ? `${p.clipCount} clips`
                  : p.status === 'error'
                    ? 'error'
                    : p.status === 'queued'
                      ? 'queued'
                      : `${STAGE_LABELS[p.stage || ''] || p.stage || ''} ${Math.round(p.progress * 100)}%`}
              </span>
              <span className="recentDate">{new Date(p.createdAt).toLocaleDateString()}</span>
            </button>
          ))}
        </section>
      )}

      <section className="workflow">
        <div><span>01</span><b>UNDERSTAND</b><p>Transcribe the entire video and inspect the story.</p></div>
        <div><span>02</span><b>DECIDE</b><p>AI ranks moments and decides how many clips to cut.</p></div>
        <div><span>03</span><b>CREATE</b><p>HyperFrames renders clips, captions, thumbnails and metadata.</p></div>
      </section>
      <footer>
        <span>© 2026 Syntheniq</span>
        <span>Built for creators who care about the story <ArrowUpRight size={14} /></span>
      </footer>
    </main>
  );
}
