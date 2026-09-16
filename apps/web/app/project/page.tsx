'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Lock,
  Loader2,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import {
  API,
  fetchClipMeta,
  fetchConfig,
  fetchJob,
  fileUrl,
  requestVariant,
  retryJob,
  submitPasscode,
  type ClipMeta,
  type JobState,
} from '@/lib/api';

const STAGES: { id: string; label: string }[] = [
  { id: 'media-check', label: 'Media check' },
  { id: 'audio', label: 'Audio extract' },
  { id: 'transcribe', label: 'Transcription' },
  { id: 'analyze', label: 'Story analysis' },
  { id: 'plan', label: 'Clip plan' },
  { id: 'prep-media', label: 'Cut & mix media' },
  { id: 'render', label: 'HyperFrames render' },
  { id: 'package', label: 'Metadata & thumbnails' },
  { id: 'qc', label: 'QC' },
  { id: 'complete', label: 'Complete' },
];

function StageRow({ s, st }: { s: (typeof STAGES)[number]; st?: { status: string; detail?: string } }) {
  const status = st?.status || 'pending';
  return (
    <div className={`stage ${status}`}>
      <span className="stageIcon">
        {status === 'done' ? <Check size={13} /> : status === 'running' ? <Loader2 size={13} className="spin" /> : status === 'error' ? <XCircle size={13} /> : <span className="dot" />}
      </span>
      <div className="stageBody">
        <b>{s.label}</b>
        {st?.detail && status === 'running' && <p>{st.detail}</p>}
      </div>
    </div>
  );
}

function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="copyBtn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setOk(true);
        setTimeout(() => setOk(false), 1400);
      }}
    >
      {ok ? <Check size={13} /> : <Copy size={13} />} {ok ? 'Copied' : label}
    </button>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'clip';
}

function fmtT(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function ProjectPageInner() {
  const params = useSearchParams();
  const id = params.get('id') || '';
  const [job, setJob] = useState<JobState | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [auth, setAuth] = useState<{ required: boolean; authorized: boolean } | null>(null);
  const [passcode, setPasscode] = useState('');
  const [authErr, setAuthErr] = useState('');
  const [metas, setMetas] = useState<Record<string, ClipMeta | null>>({});
  const logRef = useRef<HTMLDivElement>(null);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    (async () => {
      const c = await fetchConfig();
      if (c) setAuth({ required: c.authRequired, authorized: c.authorized });
    })();
  }, []);

  const poll = useCallback(async () => {
    if (!id) return;
    const j = await fetchJob(id);
    if (!j) {
      setNotFound(true);
      return;
    }
    setJob(j);
    // fetch metadata for done clips
    setMetas((prev) => {
      const need = j.clips.filter((c) => c.status === 'done' && c.files.meta && prev[c.id] === undefined);
      if (!need.length) return prev;
      for (const c of need) {
        fetchClipMeta(id, c.files.meta!).then((m) =>
          setMetas((p) => ({ ...p, [c.id]: m })),
        );
      }
      return prev;
    });
  }, [id]);

  useEffect(() => {
    if (!id || (auth?.required && !auth?.authorized)) return;
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [id, poll, auth]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.logs.length]);

  if (!id) return <main className="shell"><p className="muted">Missing project id.</p></main>;
  if (auth?.required && !auth.authorized) {
    return (
      <main className="shell narrow">
        <form
          className="passcode"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await submitPasscode(passcode);
            if (ok) setAuth({ required: true, authorized: true });
            else setAuthErr('Wrong passcode');
          }}
        >
          <div className="passIcon"><Lock size={20} /></div>
          <h2>Private interface</h2>
          <p>Enter your passcode to continue</p>
          <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} placeholder="Passcode" autoFocus />
          <button type="submit">Unlock</button>
          {authErr && <span className="err">{authErr}</span>}
        </form>
      </main>
    );
  }
  if (notFound) return <main className="shell"><p className="muted">Project not found.</p></main>;
  if (!job) return <main className="shell narrow"><Loader2 className="spin" size={22} /> <span className="muted">Loading…</span></main>;

  const done = job.status === 'done';
  const interrupted = job.status === 'interrupted';
  const failed = job.status === 'error' || job.status === 'cancelled' || interrupted;
  const providerChips = Object.entries(job.providers)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand"><span className="mark">S</span><span>SYNTHENIQ</span></div>
        <div className="navRight">
          <button className="ghost" onClick={() => (window.location.href = '/')}>← All projects</button>
        </div>
      </nav>

      <section className="projHead">
        <div>
          <div className="eyebrow"><Sparkles size={13} /> PROJECT {job.id.slice(0, 8).toUpperCase()}</div>
          <h1>
            {done ? 'Your clips are ready' : failed ? (job.status === 'cancelled' ? 'Cancelled' : interrupted ? 'Paused — resume ready' : 'Processing failed') : `Editing… ${STAGES.find((s) => s.id === job.stage)?.label || ''}`}
          </h1>
          {job.media && (
            <p className="muted">
              {job.media.duration.toFixed(0)}s source · {job.media.fps}fps · {job.media.width}×{job.media.height}
              {job.transcript ? ` · ${job.transcript.words} words transcribed` : ''}
            </p>
          )}
        </div>
        <div className="overallBar" title={`${Math.round(job.progress * 100)}%`}>
          <i style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      </section>

      {failed && (
        <div className="errBanner big">
          <AlertTriangle size={17} />
          <div style={{ flex: 1 }}>
            <b>{job.status === 'cancelled' ? 'Cancelled by you' : interrupted ? 'Pipeline interrupted' : 'Error'}</b>
            <p>
              {job.status === 'cancelled'
                ? job.error
                : interrupted
                  ? 'The server restarted before this job finished. Finished stages are saved — retry resumes from where it stopped.'
                  : job.error}
            </p>
          </div>
          <button
            className="btn primary"
            onClick={async () => {
              if (await retryJob(job.id)) poll();
            }}
          >
            <RefreshCw size={15} /> Retry from failed stage
          </button>
        </div>
      )}

      <div className="projGrid">
        <section className="panel">
          <div className="panelHead">PIPELINE</div>
          {STAGES.map((s) => (
            <StageRow key={s.id} s={s} st={job.stages[s.id]} />
          ))}
          {job.status === 'running' && !job.cancelRequested && (
            <button
              className="ghost danger"
              onClick={async () => {
                try {
                  await fetch(`${API}/v1/projects/${job.id}/cancel`, { method: 'POST' });
                  poll();
                } catch {
                  /* ignore */
                }
              }}
            >
              Cancel pipeline
            </button>
          )}
          {providerChips.length > 0 && (
            <div className="chips">
              {providerChips.map((c) => (
                <span key={c} className="chip">{c}</span>
              ))}
            </div>
          )}
        </section>

        <section className="panel grow">
          <div className="panelHead">
            LIVE LOG
            <button className="ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? 'Hide' : 'Show'}</button>
          </div>
          {showLog ? (
            <div className="log" ref={logRef}>
              {job.logs.slice(-200).map((l, i) => (
                <div key={i} className={`logLine ${l.level}`}>
                  <span className="logT">{new Date(l.t).toLocaleTimeString()}</span> {l.msg}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Pipeline output appears here. {job.logs.length ? `${job.logs.length} lines captured.` : 'Waiting for first stage…'}</p>
          )}
        </section>
      </div>

      {done && (
        <section className="clips">
          <div className="clipsHead">
            <h2>Clips ({job.clips.filter((c) => c.status === 'done').length})</h2>
            {job.plan?.notes && <p className="muted">{job.plan.notes}</p>}
          </div>
          {job.clips.map((c, i) => {
            const meta = metas[c.id];
            return (
            <article key={c.id} className="clipCard">
              <div className="clipVideo">
                {c.status === 'done' && c.files.mp4 ? (
                  <video src={fileUrl(job.id, c.files.mp4)} controls playsInline preload="metadata" />
                ) : c.status === 'rendering' ? (
                  <div className="placeholder"><Loader2 className="spin" size={26} /><p>Rendering…</p></div>
                ) : (
                  <div className="placeholder"><AlertTriangle size={26} /><p>{c.error || 'Not rendered'}</p></div>
                )}
              </div>
              <div className="clipBody">
                <div className="clipTitleRow">
                  <h3>{meta?.title || c.title}</h3>
                  {c.duration && <span className="muted">{c.duration.toFixed(1)}s · {c.fps}fps</span>}
                </div>
                {c.status === 'done' && c.files.mp4 && (
                  <div className="clipActions">
                    <a className="btn primary" href={fileUrl(job.id, c.files.mp4)} download={`${slug(meta?.title || c.title)}.mp4`}>
                      <Download size={15} /> Download MP4
                    </a>
                    {c.files.thumb && (
                      <a className="btn" href={fileUrl(job.id, c.files.thumb)} download={`${slug(meta?.title || c.title)}_thumb.jpg`}>
                        <Download size={15} /> Thumbnail
                      </a>
                    )}
                  </div>
                )}
                {meta && (
                  <div className="metaGrid">
                    <div className="metaRow">
                      <label>TikTok</label>
                      <p>{meta.captions?.tiktok}</p>
                      <CopyBtn text={meta.captions?.tiktok || ''} />
                    </div>
                    <div className="metaRow">
                      <label>Instagram</label>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{meta.captions?.instagram}</p>
                      <CopyBtn text={meta.captions?.instagram || ''} />
                    </div>
                    <div className="metaRow">
                      <label>YouTube Shorts</label>
                      <p>{meta.captions?.youtube}</p>
                      <CopyBtn text={meta.captions?.youtube || ''} />
                    </div>
                    <div className="metaRow">
                      <label>Hashtags</label>
                      <p>{meta.hashtags.join(' ')}</p>
                      <CopyBtn text={meta.hashtags.join(' ')} />
                    </div>
                    <div className="metaRow">
                      <label>CTA</label>
                      <p>{meta.cta}</p>
                      <CopyBtn text={meta.cta} />
                    </div>
                    {meta.source && (
                      <div className="metaRow">
                        <label>Source</label>
                        <p>{fmtT(meta.source.start)} – {fmtT(meta.source.end)}</p>
                        <CopyBtn text={`${fmtT(meta.source.start)}-${fmtT(meta.source.end)}`} label="Copy range" />
                      </div>
                    )}
                    {meta.rationale && (
                      <details className="metaRationale">
                        <summary>Why this edit</summary>
                        <p>{meta.rationale}</p>
                      </details>
                    )}
                  </div>
                )}
                {meta?.variants?.length ? (
                  <div className="variants">
                    <div className="panelHead">VARIANTS</div>
                    {meta.variants.slice(0, 3).map((v, vi) => (
                      <div key={vi} className="variant">
                        <div className="variantText">
                          {v.title && <b>{v.title}</b>}
                          {v.hookText && <span className="muted"> hook: “{v.hookText}”</span>}
                          {v.note && <p className="muted small">{v.note}</p>}
                        </div>
                        {c.variant && c.variant.status === 'rendering' ? (
                          <span className="chip"><Loader2 className="spin" size={12} /> rendering…</span>
                        ) : c.variant && c.variant.status === 'done' && c.variant.mp4 ? (
                          <a className="btn" href={fileUrl(job.id, c.variant.mp4)} download={`${slug(v.title || c.title)}-v.mp4`}>
                            <Download size={14} /> {c.variant.hookText}
                          </a>
                        ) : v.hookText ? (
                          <button
                            className="btn"
                            onClick={async () => {
                              const ok = await requestVariant(job.id, c.id, v.hookText!);
                              if (ok) poll();
                            }}
                          >
                            <Sparkles size={14} /> Render variant
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          )}
          )}
        </section>
      )}
    </main>
  );
}

export default function ProjectPage() {
  return (
    <Suspense
      fallback={
        <main className="shell narrow">
          <Loader2 className="spin" size={22} /> <span className="muted">Loading…</span>
        </main>
      }
    >
      <ProjectPageInner />
    </Suspense>
  );
}
