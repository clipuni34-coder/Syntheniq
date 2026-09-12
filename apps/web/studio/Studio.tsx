'use client';

// Syntheniq studio — Home → Project (Upload → Analyzing → Clips) →
// Clip preview → Export → Download. Hash-routed, fully client-side.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, FormEvent } from 'react';
import { Play, Upload, Film, Download, MoveRight, ArrowLeft } from 'lucide-react';
import {
  api,
  followJob,
  fmtBytes,
  fmtClock,
  fmtDate,
  mediaUrl,
  uploadVideo,
} from './api';
import type { Clip, ClipsData, Job, Project, Scores, Segment } from './api';
import { notify, subscribeToasts } from './toast';
import type { Toast } from './toast';

/* ---------- routing ---------------------------------------------------- */

type Route =
  | { name: 'home' }
  | { name: 'projects' }
  | { name: 'project'; projectId: string }
  | { name: 'preview'; projectId: string; clipId: string }
  | { name: 'export'; projectId: string; clipId: string };

function parseHash(): Route {
  if (typeof window === 'undefined') return { name: 'home' };
  const hash = window.location.hash || '#/';
  let m: RegExpMatchArray | null;
  if ((m = hash.match(/^#\/p\/([A-Za-z0-9-]+)\/clip\/([A-Za-z0-9-]+)\/export$/))) {
    return { name: 'export', projectId: m[1], clipId: m[2] };
  }
  if ((m = hash.match(/^#\/p\/([A-Za-z0-9-]+)\/clip\/([A-Za-z0-9-]+)$/))) {
    return { name: 'preview', projectId: m[1], clipId: m[2] };
  }
  if ((m = hash.match(/^#\/p\/([A-Za-z0-9-]+)$/))) return { name: 'project', projectId: m[1] };
  if (hash === '#/projects') return { name: 'projects' };
  return { name: 'home' };
}

function go(hash: string): void {
  window.location.hash = hash;
}

/* ---------- shared widgets ---------------------------------------------- */

const SCORE_LABELS: [keyof Scores, string][] = [
  ['hook', 'Hook 25%'],
  ['curiosity', 'Curiosity 20%'],
  ['payoff', 'Payoff 20%'],
  ['standalone', 'Standalone 15%'],
  ['emotion', 'Emotion 10%'],
  ['visual', 'Visual 10%'],
];

function ScoreRing({ total }: { total: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, total)));
  return (
    <svg className="ring" width="64" height="64" viewBox="0 0 64 64">
      <circle className="bg" cx="32" cy="32" r={r} fill="none" strokeWidth="5" />
      <circle
        className="fg"
        cx="32"
        cy="32"
        r={r}
        fill="none"
        strokeWidth="5"
        strokeDasharray={c.toFixed(1)}
        strokeDashoffset={off.toFixed(1)}
      />
    </svg>
  );
}

function ScoreBars({ scores }: { scores: Scores }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setOn(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);
  return (
    <div className="score-bars">
      {SCORE_LABELS.map(([key, label]) => (
        <div className="score-row" key={key}>
          <label>{label}</label>
          <span className="track">
            <i style={{ width: on ? `${Math.round((scores[key] || 0) * 100)}%` : '0%' }} />
          </span>
          <b>{(scores[key] || 0).toFixed(2)}</b>
        </div>
      ))}
    </div>
  );
}

function Steps({ active }: { active: 'upload' | 'analyzing' | 'clips' | 'preview' | 'export' | 'download' }) {
  const steps = ['Upload', 'Analyzing', 'Clips found', 'Preview', 'Export', 'Download'];
  const order = { upload: 0, analyzing: 1, clips: 2, preview: 3, export: 4, download: 5 };
  const idx = order[active];
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <span key={s} style={{ display: 'contents' }}>
          <span className={`step ${i < idx ? 'done' : i === idx ? 'now' : ''}`}>
            <span className="n">{i < idx ? '✓' : String(i + 1)}</span>
            {s}
          </span>
          {i < steps.length - 1 && <span className="step-sep" />}
        </span>
      ))}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const status = (project.status || 'created').replace('-', ' ');
  const sub: string[] = [];
  if (project.media?.probe) sub.push(fmtClock(project.media.probe.duration));
  if (project.analysis) sub.push(`${project.analysis.clipCount} clip${project.analysis.clipCount === 1 ? '' : 's'}`);
  sub.push(fmtDate(project.updatedAt));
  return (
    <a className="project-card" href={`#/p/${project.id}`}>
      <span className={`status-pill ${project.status || 'created'}`}>{status}</span>
      <h3>{project.name}</h3>
      <div className="meta">
        {sub.map((s, i) => (
          <span key={i}>{s}</span>
        ))}
      </div>
    </a>
  );
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const project = await api<Project>('/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() || 'Untitled project' }),
      });
      onClose();
      go(`#/p/${project.id}`);
    } catch (err) {
      setBusy(false);
      notify(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <p className="eyebrow">New project</p>
        <h2>
          Name your <em>story</em>
        </h2>
        <p>Give the project a working title — you will upload the footage next.</p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="np-name">Project name</label>
            <input
              id="np-name"
              maxLength={120}
              placeholder="e.g. Founder interview — ep. 4"
              autoComplete="off"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              <MoveRight size={17} /> Create &amp; upload
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---------- home + projects ---------------------------------------------- */

function HomeView({ onNew }: { onNew: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ projects: Project[] }>('/v1/projects')
      .then((d) => {
        if (live) setProjects(d.projects || []);
      })
      .catch((err) => notify('Could not reach the Syntheniq engine: ' + (err as Error).message));
    return () => {
      live = false;
    };
  }, []);
  const recent = (projects || []).slice(0, 6);
  return (
    <div className="view">
      <section className="hero">
        <p className="eyebrow">Syntheniq · AI editing room</p>
        <h1>
          Long video in. <em>Stories</em> out.
        </h1>
        <p className="lede">
          Syntheniq watches your footage the way an editor does — it listens to every second, finds the
          moments with a real hook, a real payoff and a real pulse, then cuts them into vertical shorts
          with clean captions, ready for the phone.
        </p>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={onNew}>
            <Play size={17} /> New project
          </button>
          <a className="btn btn-ghost" href="#/projects">
            <Film size={17} /> Open the studio
          </a>
        </div>
        <div className="hero-meta">
          <span>
            <i /> True 9:16 · 1080×1920
          </span>
          <span>
            <i /> Burned-in captions
          </span>
          <span>
            <i /> iPhone-ready H.264 + AAC
          </span>
        </div>
      </section>

      <section className="process">
        <div className="process-step">
          <b>
            <span>01</span>Upload
          </b>
          <p>Drop in the long video. Syntheniq probes every stream and keeps your file safe.</p>
        </div>
        <div className="process-step">
          <b>
            <span>02</span>Understand
          </b>
          <p>Full transcription, checked against the real runtime — nothing at the tail goes missing.</p>
        </div>
        <div className="process-step">
          <b>
            <span>03</span>Find the story
          </b>
          <p>Moments ranked on hook, curiosity, payoff, standalone value, emotion and visuals.</p>
        </div>
        <div className="process-step">
          <b>
            <span>04</span>Export
          </b>
          <p>Vertical renders with captions, verified spec-by-spec before you download.</p>
        </div>
      </section>

      <div className="section-head">
        <h2>
          Recent <em>projects</em>
        </h2>
        <a href="#/projects">View all →</a>
      </div>
      {projects === null ? (
        <div className="empty">
          <p>Loading projects…</p>
        </div>
      ) : recent.length ? (
        <div className="project-grid">
          {recent.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <h2 style={{ fontSize: 26 }}>No projects yet</h2>
          <p>Your first short is one upload away.</p>
          <button className="btn btn-primary" onClick={onNew}>
            <Play size={17} /> New project
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectsView({ onNew }: { onNew: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ projects: Project[] }>('/v1/projects')
      .then((d) => {
        if (live) setProjects(d.projects || []);
      })
      .catch((err) => notify((err as Error).message));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="view">
      <p className="eyebrow">Studio</p>
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>
          All <em>projects</em>
        </h2>
        <button className="btn btn-primary btn-sm" onClick={onNew}>
          <Play size={17} /> New project
        </button>
      </div>
      {projects === null ? (
        <div className="empty">
          <p>Loading projects…</p>
        </div>
      ) : projects.length ? (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <p>No projects yet. Create one to get cutting.</p>
          <button className="btn btn-primary" onClick={onNew}>
            <Play size={17} /> New project
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- project hub --------------------------------------------------- */

function ProjectHead({
  project,
  active,
  onDeleted,
}: {
  project: Project;
  active: 'upload' | 'analyzing' | 'clips' | 'preview' | 'export' | 'download';
  onDeleted: () => void;
}) {
  const remove = async () => {
    if (!confirm(`Delete “${project.name}” and all of its media?`)) return;
    try {
      await api(`/v1/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      onDeleted();
    } catch (err) {
      notify((err as Error).message);
    }
  };
  return (
    <>
      <p className="eyebrow">
        <a href="#/projects" style={{ color: 'inherit', textDecoration: 'none' }}>
          Studio
        </a>{' '}
        · {project.name}
      </p>
      <Steps active={active} />
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>{project.name}</h2>
        <button className="btn btn-ghost btn-sm" onClick={remove}>
          Delete project
        </button>
      </div>
    </>
  );
}

function ProjectHub({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  const refetch = useCallback(async () => {
    try {
      const p = await api<Project>(`/v1/projects/${encodeURIComponent(projectId)}`);
      setProject(p);
    } catch (err) {
      setMissing(true);
      notify((err as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  if (missing || project === null) {
    return (
      <div className="view">
        <div className="empty">
          <p>{missing ? 'Project not found.' : 'Loading project…'}</p>
          <a className="btn btn-ghost" href="#/">
            Back home
          </a>
        </div>
      </div>
    );
  }
  if (project.status === 'analyzing' && project.activeJob) {
    return (
      <AnalyzingView
        project={project}
        jobId={project.activeJob.id}
        exportClipId={project.activeJob.type === 'export' ? project.activeJob.clipId || null : null}
        onSettled={refetch}
        onDeleted={() => go('#/projects')}
      />
    );
  }
  if (project.status === 'analyzing') {
    return (
      <InterruptedView project={project} onChanged={refetch} onDeleted={() => go('#/projects')} />
    );
  }
  if (project.status === 'clips-ready') {
    return <ClipsView project={project} onDeleted={() => go('#/projects')} />;
  }
  if (project.status === 'error') {
    return <ErrorView project={project} onChanged={refetch} onDeleted={() => go('#/projects')} />;
  }
  return <UploadView project={project} onChanged={refetch} onDeleted={() => go('#/projects')} />;
}

async function startAnalysis(project: Project, onStarted: () => void): Promise<void> {
  try {
    await api(`/v1/projects/${encodeURIComponent(project.id)}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ maxClips: 5 }),
    });
    onStarted();
  } catch (err) {
    notify((err as Error).message);
  }
}

function UploadView({
  project,
  onChanged,
  onDeleted,
}: {
  project: Project;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const media = project.media;
  const probe = media?.probe;

  const upload = async (file: File) => {
    if (busy) return;
    setBusy(true);
    setProgress({ loaded: 0, total: file.size, name: file.name });
    try {
      await uploadVideo(project.id, file, (loaded, total) =>
        setProgress({ loaded, total, name: file.name })
      );
      notify('Video uploaded — ready to analyze.', 'ok');
      onChanged();
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void upload(f);
  };

  return (
    <div className="view">
      <ProjectHead project={project} active="upload" onDeleted={onDeleted} />
      <div
        className={`dropzone${dragging ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Upload a video"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div className="ring-icon">
          <Upload size={28} />
        </div>
        <h2>
          Drop your <em>long video</em> here
        </h2>
        <p>or click to browse your files</p>
        <p className="fine">MP4 · MOV · MKV · WEBM — up to 2 GB</p>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,.mkv,.mov,.mp4,.webm,.m4v,.avi,.mpg,.mpeg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </div>

      {progress && (
        <>
          <div className="file-row">
            <div className="file-icon">
              <Upload size={22} />
            </div>
            <div className="grow">
              <div className="name">{progress.name}</div>
              <div className="sub">
                Uploading… {Math.round((progress.loaded / Math.max(1, progress.total)) * 100)}% (
                {fmtBytes(progress.loaded)} of {fmtBytes(progress.total)})
              </div>
            </div>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${(progress.loaded / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
        </>
      )}

      {media && !progress && (
        <>
          <div className="file-row">
            <div className="file-icon">
              <Film size={22} />
            </div>
            <div className="grow">
              <div className="name">{media.originalName || media.filename}</div>
              <div className="sub">
                {fmtBytes(media.bytes)} · uploaded {fmtDate(media.uploadedAt || project.updatedAt)}
              </div>
            </div>
          </div>
          {probe && (
            <>
              <div className="media-facts">
                <span className="fact">
                  Duration<b>{fmtClock(probe.duration)}</b>
                </span>
                <span className="fact">
                  Picture<b>
                    {probe.width}×{probe.height}
                  </b>
                </span>
                <span className="fact">
                  Audio<b>{probe.hasAudio ? 'Yes' : 'None'}</b>
                </span>
              </div>
              <video
                className="stage"
                controls
                playsInline
                preload="metadata"
                src={mediaUrl(`/v1/projects/${encodeURIComponent(project.id)}/source`)}
              />
            </>
          )}
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={() => void startAnalysis(project, onChanged)}>
              <Play size={17} /> Analyze this video
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AnalyzingView({
  project,
  jobId,
  exportClipId,
  onSettled,
  onDeleted,
}: {
  project: Project;
  jobId: string;
  exportClipId: string | null;
  onSettled: () => void;
  onDeleted: () => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState<{ t: string; msg: string }[]>([]);
  const [elapsed, setElapsed] = useState('0:00');
  const startedRef = useRef(Date.now());
  const lastMsgRef = useRef('');
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - startedRef.current) / 1000);
      setElapsed(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Self-heal: a stale job id (engine restarted) drops back to the hub,
    // which shows the honest "interrupted" state with a retry button.
    let live = true;
    api<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`)
      .then(() => {
        if (!live) return;
        const stop = followJob(jobId, {
          onUpdate: (j) => {
            setJob(j);
            if (j.message && j.message !== lastMsgRef.current) {
              lastMsgRef.current = j.message;
              const s = Math.floor((Date.now() - startedRef.current) / 1000);
              const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
              setLog((prev) => [{ t, msg: j.message }, ...prev]);
            }
          },
          onDone: () => settledRef.current(),
          onError: (err) => {
            notify(err.message);
            settledRef.current();
          },
        });
        cleanupRef.current = stop;
      })
      .catch(() => {
        if (live) settledRef.current();
      });
    const cleanupRef: { current: (() => void) | null } = { current: null };
    return () => {
      live = false;
      if (cleanupRef.current) cleanupRef.current();
    };
  }, [jobId]);

  return (
    <div className="view">
      <ProjectHead project={project} active={exportClipId ? 'export' : 'analyzing'} onDeleted={onDeleted} />
      <div className="analyze-stage">
        <p className="eyebrow">
          {exportClipId ? 'Exporting' : 'Analyzing'} · {project.name}
        </p>
        <div className="status-line">
          <span>{job?.message || 'Understanding your video'}</span>
          <span className="caret">_</span>
        </div>
        <div className="analyze-sub">
          <span>{Math.round(job?.progress || 0)}%</span>
          <span>·</span>
          <span>{elapsed} elapsed</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${job?.progress || 0}%` }} />
        </div>
        <div className="progress-meta">
          <span>{job?.label || 'Warming up the engine…'}</span>
          <span>Do not close this tab</span>
        </div>
        <div className="job-log">
          {log.length === 0 && <div>Connecting to the engine…</div>}
          {log.map((entry, i) => (
            <div key={i}>
              <span className="t">{entry.t}</span>
              {entry.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InterruptedView({
  project,
  onChanged,
  onDeleted,
}: {
  project: Project;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  return (
    <div className="view">
      <ProjectHead project={project} active="analyzing" onDeleted={onDeleted} />
      <div className="empty">
        <h2 style={{ fontSize: 26 }}>
          Analysis was <em>interrupted</em>
        </h2>
        <p>The engine restarted mid-analysis. Your upload is safe — run it again.</p>
        <button className="btn btn-primary" onClick={() => void startAnalysis(project, onChanged)}>
          <Play size={17} /> Retry analysis
        </button>
      </div>
    </div>
  );
}

function ErrorView({
  project,
  onChanged,
  onDeleted,
}: {
  project: Project;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const notes = project.notes || [];
  return (
    <div className="view">
      <ProjectHead project={project} active="upload" onDeleted={onDeleted} />
      <div className="empty">
        <h2 style={{ fontSize: 26 }}>
          Something <em>failed</em>
        </h2>
        <p>{notes[notes.length - 1] || 'The last run failed.'}</p>
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={() => void startAnalysis(project, onChanged)}>
            <Play size={17} /> Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- clips ---------------------------------------------------------- */

function Waveform({ data }: { data: ClipsData }) {
  const { waveform, duration } = data.timeline;
  if (!waveform?.length || !duration) {
    return (
      <div style={{ color: 'var(--dim)', fontSize: 13, paddingTop: 20 }}>
        Waveform unavailable for this project.
      </div>
    );
  }
  const W = 1000;
  const H = 64;
  const max = Math.max(0.01, ...waveform.map((p) => p.rms || 0));
  const bw = W / waveform.length;
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {waveform.map((p, i) => {
          const h = Math.max(2, ((p.rms || 0) / max) * (H - 8));
          return (
            <rect
              key={i}
              x={i * bw}
              y={(H - h) / 2}
              width={Math.max(0.6, bw * 0.62)}
              height={h}
              rx="1"
              fill="rgba(242,237,226,0.28)"
            />
          );
        })}
      </svg>
      {data.clips.map((c) => (
        <div
          key={c.id}
          className="clip-range"
          style={{
            left: `${(c.start / duration) * 100}%`,
            width: `${Math.max(1.5, ((c.end - c.start) / duration) * 100)}%`,
          }}
          title={c.title}
          onClick={() => {
            document.getElementById(`card-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
        >
          <span>{c.rank}</span>
        </div>
      ))}
    </>
  );
}

function ClipCard({ projectId, clip }: { projectId: string; clip: Clip }) {
  return (
    <article className="clip-card" id={`card-${clip.id}`}>
      {clip.poster ? (
        <img
          className="clip-poster"
          src={mediaUrl(`/v1/projects/${encodeURIComponent(projectId)}/poster/${encodeURIComponent(clip.id)}`)}
          alt={`Poster for ${clip.title}`}
          loading="lazy"
          onClick={() => go(`#/p/${projectId}/clip/${clip.id}`)}
        />
      ) : (
        <div className="clip-poster-fallback" onClick={() => go(`#/p/${projectId}/clip/${clip.id}`)}>
          {clip.rank}
        </div>
      )}
      <div className="clip-main">
        <div className="clip-top">
          <span className="clip-rank">No. {clip.rank}</span>
          <h3>{clip.title}</h3>
        </div>
        <div className="clip-time">
          {fmtClock(clip.start)} → {fmtClock(clip.end)} · {Math.round(clip.duration)}s ·{' '}
          {clip.captions?.events ? `${clip.captions.events} captions` : 'no captions'}
        </div>
        {clip.excerpt && <p className="clip-excerpt">“{clip.excerpt}”</p>}
        <div className="clip-reasons">
          {clip.reasons.map((r, i) => (
            <span className="reason" key={i}>
              {r}
            </span>
          ))}
          {clip.exported && <span className="reason">✓ Exported · {fmtBytes(clip.exported.bytes)}</span>}
        </div>
      </div>
      <div className="clip-side">
        <div className="score-total">
          <ScoreRing total={clip.total} />
          <div className="num">
            {clip.total.toFixed(2)}
            <small> / 1</small>
          </div>
        </div>
        <ScoreBars scores={clip.scores} />
        <div className="clip-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => go(`#/p/${projectId}/clip/${clip.id}`)}>
            <Play size={17} /> Preview
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => go(`#/p/${projectId}/clip/${clip.id}/export`)}
          >
            {clip.exported ? 'Download' : 'Export'}
          </button>
        </div>
      </div>
    </article>
  );
}

function ClipsView({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const [data, setData] = useState<ClipsData | null>(null);
  useEffect(() => {
    let live = true;
    api<ClipsData>(`/v1/projects/${encodeURIComponent(project.id)}/clips`)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((err) => notify((err as Error).message));
    return () => {
      live = false;
    };
  }, [project.id]);

  if (!data) {
    return (
      <div className="view">
        <ProjectHead project={project} active="clips" onDeleted={onDeleted} />
        <div className="empty">
          <p>Loading clips…</p>
        </div>
      </div>
    );
  }
  const cov = data.coverage;
  return (
    <div className="view">
      <ProjectHead project={project} active="clips" onDeleted={onDeleted} />
      <div className="timeline-card">
        <div className="head">
          <b>
            {data.clips.length} clip{data.clips.length === 1 ? '' : 's'} found
          </b>
          <span className="coverage-line" style={{ margin: 0 }}>
            <span>
              Engine <b>{data.provider || '—'}</b>
            </span>
            {cov ? (
              <span>
                Transcript covers <b>{Math.round(cov.ratio * 100)}%</b> of {fmtClock(cov.durationSeconds)}
              </span>
            ) : (
              <span>Visual + audio analysis</span>
            )}
          </span>
        </div>
        <div className="timeline">
          <Waveform data={data} />
        </div>
      </div>
      <div className="clip-list">
        {data.clips.map((c) => (
          <ClipCard key={c.id} projectId={project.id} clip={c} />
        ))}
      </div>
    </div>
  );
}

/* ---------- preview --------------------------------------------------------- */

function PreviewView({ projectId, clipId }: { projectId: string; clipId: string }) {
  const [snap, setSnap] = useState<{ project: Project; clip: Clip; transcript: Segment[] } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const project = await api<Project>(`/v1/projects/${encodeURIComponent(projectId)}`);
        const detail = await api<{ clip: Clip; transcript: Segment[] }>(
          `/v1/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}`
        );
        if (live) setSnap({ project, clip: detail.clip, transcript: detail.transcript });
      } catch (err) {
        notify((err as Error).message);
        go(`#/p/${projectId}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId, clipId]);

  const clip = snap?.clip;
  const playRange = useCallback(() => {
    const v = videoRef.current;
    if (!v || !clip) return;
    try {
      v.currentTime = Math.max(0, clip.start + 0.05);
      void v.play().catch(() => {});
    } catch {
      // ignore
    }
  }, [clip]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !clip) return;
    const onTime = () => {
      if (v.currentTime >= clip.end) v.pause();
    };
    v.addEventListener('loadedmetadata', playRange);
    v.addEventListener('timeupdate', onTime);
    if (v.readyState >= 1) playRange();
    return () => {
      v.removeEventListener('loadedmetadata', playRange);
      v.removeEventListener('timeupdate', onTime);
    };
  }, [clip, playRange]);

  if (!snap || !clip) {
    return (
      <div className="view">
        <div className="empty">
          <p>Loading clip…</p>
        </div>
      </div>
    );
  }
  const { project, transcript } = snap;
  return (
    <div className="view">
      <p className="eyebrow">
        <a href={`#/p/${project.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
          ← Clips
        </a>{' '}
        · {project.name}
      </p>
      <Steps active="preview" />
      <div className="preview-grid">
        <div>
          <div className="phone-frame">
            <video
              ref={videoRef}
              controls
              playsInline
              preload="auto"
              src={mediaUrl(`/v1/projects/${encodeURIComponent(project.id)}/source`)}
              poster={
                clip.poster
                  ? mediaUrl(`/v1/projects/${encodeURIComponent(project.id)}/poster/${encodeURIComponent(clip.id)}`)
                  : undefined
              }
            />
          </div>
          <div className="btn-row">
            <button className="btn btn-ghost btn-sm" onClick={playRange}>
              <Play size={17} /> Replay {fmtClock(clip.start)}–{fmtClock(clip.end)}
            </button>
          </div>
        </div>
        <div>
          <p className="eyebrow">Clip no. {clip.rank}</p>
          <h2 style={{ fontSize: 'clamp(30px,4vw,46px)' }}>{clip.title}</h2>
          <div className="clip-time" style={{ marginTop: 10 }}>
            {fmtClock(clip.start)} → {fmtClock(clip.end)} · {Math.round(clip.duration)} seconds
          </div>
          <div style={{ marginTop: 22, maxWidth: 420 }}>
            <div className="score-total">
              <ScoreRing total={clip.total} />
              <div className="num">
                {clip.total.toFixed(2)}
                <small> / 1</small>
              </div>
            </div>
            <ScoreBars scores={clip.scores} />
          </div>
          <div className="clip-reasons" style={{ marginTop: 18 }}>
            {clip.reasons.map((r, i) => (
              <span className="reason" key={i}>
                {r}
              </span>
            ))}
          </div>
          {transcript?.length ? (
            <div className="transcript-box">
              {transcript.map((s, i) => (
                <div className="seg" key={i}>
                  <b>{fmtClock(s.start)}</b>
                  {s.text}
                </div>
              ))}
            </div>
          ) : (
            <div className="transcript-box">
              No transcribed speech in this range — the pick came from the picture and sound.
            </div>
          )}
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => go(`#/p/${project.id}/clip/${clip.id}/export`)}>
              <Download size={17} /> {clip.exported ? 'Download MP4' : 'Export vertical MP4'}
            </button>
            <a className="btn btn-ghost" href={`#/p/${project.id}`}>
              All clips
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- export + download ------------------------------------------------ */

function ExportView({ projectId, clipId }: { projectId: string; clipId: string }) {
  const [snap, setSnap] = useState<{ project: Project; clip: Clip } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const project = await api<Project>(`/v1/projects/${encodeURIComponent(projectId)}`);
        const detail = await api<{ clip: Clip }>(
          `/v1/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}`
        );
        if (!live) return;
        setSnap({ project, clip: detail.clip });
        const aj = project.activeJob;
        if (aj?.type === 'export' && aj.clipId === clipId) setJobId(aj.id);
      } catch (err) {
        notify((err as Error).message);
        go(`#/p/${projectId}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId, clipId, nonce]);

  useEffect(() => {
    if (!snap || snap.clip.exported || jobId || startedRef.current) return;
    startedRef.current = true;
    api<{ jobId: string; job: Job }>(
      `/v1/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}/export`,
      { method: 'POST' }
    )
      .then(({ jobId: id, job: j }) => {
        if (j?.status === 'done') {
          startedRef.current = false;
          setNonce((n) => n + 1);
        } else {
          setJobId(id);
        }
      })
      .catch((err) => {
        notify((err as Error).message);
        go(`#/p/${projectId}/clip/${clipId}`);
      });
  }, [snap, jobId, projectId, clipId]);

  useEffect(() => {
    if (!jobId) return;
    return followJob(jobId, {
      onUpdate: setJob,
      onDone: () => {
        startedRef.current = false;
        setJobId(null);
        setJob(null);
        setNonce((n) => n + 1);
      },
      onError: (err) => {
        notify(err.message);
        go(`#/p/${projectId}/clip/${clipId}`);
      },
    });
  }, [jobId, projectId, clipId]);

  if (!snap) {
    return (
      <div className="view">
        <div className="empty">
          <p>Loading…</p>
        </div>
      </div>
    );
  }
  const { project, clip } = snap;
  if (clip.exported && !jobId) {
    const v = (clip.exported.verified || {}) as Record<string, string | number>;
    const fileUrl = mediaUrl(`/v1/projects/${encodeURIComponent(project.id)}/clips/${encodeURIComponent(clip.id)}/file`);
    return (
      <div className="view">
        <p className="eyebrow">
          <a href={`#/p/${project.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
            ← Clips
          </a>{' '}
          · {project.name}
        </p>
        <Steps active="download" />
        <div className="preview-grid">
          <div className="phone-frame tall">
            <video controls playsInline preload="metadata" src={fileUrl} />
          </div>
          <div>
            <p className="eyebrow">Ready to post</p>
            <h2 style={{ fontSize: 'clamp(30px,4vw,46px)' }}>{clip.title}</h2>
            <div className="clip-time" style={{ marginTop: 10 }}>
              {fmtClock(clip.start)} → {fmtClock(clip.end)} · {fmtBytes(clip.exported.bytes)}
            </div>
            <div className="spec-chips">
              <span className="spec">✓ Verified export</span>
              <span className="spec dim">
                {v.width || 1080}×{v.height || 1920}
              </span>
              <span className="spec dim">
                {String(v.videoCodec || 'h264').toUpperCase()} · {String(v.audioCodec || 'aac').toUpperCase()}
              </span>
              <span className="spec dim">{v.fps || 30} fps</span>
            </div>
            {clip.captions?.events ? (
              <p className="lede" style={{ marginTop: 20, fontSize: 15 }}>
                {clip.captions.events} captions burned in — readable with the sound off.
              </p>
            ) : null}
            <div className="btn-row">
              <a className="btn btn-primary" href={`${fileUrl}?download=1`}>
                <Download size={17} /> Download MP4
              </a>
              <a className="btn btn-ghost" href={`#/p/${project.id}`}>
                More clips
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="view">
      <p className="eyebrow">
        <a
          href={`#/p/${project.id}/clip/${clip.id}`}
          style={{ color: 'inherit', textDecoration: 'none' }}
        >
          <ArrowLeft size={13} style={{ verticalAlign: '-2px' }} /> Preview
        </a>{' '}
        · {project.name}
      </p>
      <Steps active="export" />
      <div className="analyze-stage">
        <p className="eyebrow">
          Clip no. {clip.rank} · {clip.title}
        </p>
        <div className="status-line">
          <span>{job?.message || 'Building your clips'}</span>
          <span className="caret">_</span>
        </div>
        <div className="analyze-sub">
          <span>{Math.round(job?.progress || 0)}%</span>
          <span>·</span>
          <span>1080×1920 · H.264 · AAC · 30 fps</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${job?.progress || 0}%` }} />
        </div>
        <div className="progress-meta">
          <span>Rendering…</span>
          <span>{clip.captions?.events ? `${clip.captions.events} captions` : 'No captions'}</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- studio shell ----------------------------------------------------- */

export function Studio() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [health, setHealth] = useState<{ cls: string; label: string; title: string }>({
    cls: '',
    label: 'Engine…',
    title: 'Processing engine',
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    setRoute(parseHash());
    const onHash = () => {
      setRoute(parseHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => subscribeToasts(setToasts), []);

  useEffect(() => {
    let live = true;
    api<{
      ok: boolean;
      storage: string;
      ffmpeg: boolean;
      transcription: { openaiApi: boolean; localWhisper: boolean; fallback: boolean };
    }>('/v1/health')
      .then((h) => {
        if (!live) return;
        const ready = h.ffmpeg && (h.transcription.openaiApi || h.transcription.localWhisper || h.transcription.fallback);
        setHealth({
          cls: ready ? 'ready' : 'down',
          label: h.ffmpeg ? 'Engine ready' : 'FFmpeg missing',
          title: `storage=${h.storage} · whisper=${
            h.transcription.openaiApi ? 'api' : h.transcription.localWhisper ? 'local' : 'fallback'
          }`,
        });
      })
      .catch(() => {
        if (live) setHealth({ cls: 'down', label: 'Engine offline', title: 'Processing engine' });
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <div className="ambient" aria-hidden="true">
        <div className="glow glow-a" />
        <div className="glow glow-b" />
        <div className="grain" />
      </div>

      <header className="site-header">
        <a className="brand" href="#/">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="none" stroke="#d9a441" strokeWidth="1.5" />
            <path d="M12.5 10.5l10 5.5-10 5.5z" fill="#d9a441" />
          </svg>
          <span className="brand-word">Syntheniq</span>
        </a>
        <nav className="site-nav">
          <a href="#/" className={route.name === 'home' ? 'active' : ''}>
            Studio
          </a>
          <a href="#/projects" className={route.name === 'projects' ? 'active' : ''}>
            Projects
          </a>
        </nav>
        <div className={`engine-status ${health.cls}`} title={health.title}>
          <span className="dot" />
          <span className="label">{health.label}</span>
        </div>
      </header>

      <main className="app-shell">
        {route.name === 'home' && <HomeView onNew={() => setModalOpen(true)} />}
        {route.name === 'projects' && <ProjectsView onNew={() => setModalOpen(true)} />}
        {route.name === 'project' && <ProjectHub key={route.projectId} projectId={route.projectId} />}
        {route.name === 'preview' && (
          <PreviewView key={`${route.projectId}-${route.clipId}`} projectId={route.projectId} clipId={route.clipId} />
        )}
        {route.name === 'export' && (
          <ExportView key={`${route.projectId}-${route.clipId}`} projectId={route.projectId} clipId={route.clipId} />
        )}
      </main>

      <footer className="site-footer">
        <div className="footer-inner">
          <span>Syntheniq — cut with intelligence.</span>
          <span className="footer-spec">1080×1920 · H.264 · AAC · 30 fps</span>
        </div>
      </footer>

      {modalOpen && <NewProjectModal onClose={() => setModalOpen(false)} />}
      <div className="toast-root" aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'ok' ? ' ok' : ''}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}
