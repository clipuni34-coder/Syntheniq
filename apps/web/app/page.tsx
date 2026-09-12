'use client';
import { useState } from 'react';
import { Upload, Sparkles, Film, ArrowUpRight } from 'lucide-react';

export default function Home() {
  const [dragging, setDragging] = useState(false);
  return <main className="shell">
    <nav className="nav"><div className="brand"><span className="mark">S</span><span>SYNTHENIQ</span></div><div className="navRight"><span className="status"><i/>Local MVP</span></div></nav>
    <section className="hero">
      <div className="eyebrow"><Sparkles size={14}/> AI VIDEO EDITING THAT UNDERSTANDS THE STORY</div>
      <h1>Turn long videos into<br/><em>shorts worth watching.</em></h1>
      <p className="sub">Syntheniq finds the moments that matter, builds the edit, and prepares every clip for short-form.</p>
      <div className={`drop ${dragging ? 'drag' : ''}`} onDragEnter={()=>setDragging(true)} onDragLeave={()=>setDragging(false)} onDragOver={e=>e.preventDefault()} onDrop={()=>setDragging(false)}>
        <div className="dropIcon"><Upload size={24}/></div>
        <h2>Drop a video here</h2><p>or choose a file · up to 512 MB</p>
        <button><Upload size={17}/> Upload video</button>
      </div>
      <div className="trust"><span><Film size={15}/> 9:16 exports</span><span><Sparkles size={15}/> Story-first selection</span><span>H.264 + AAC</span></div>
    </section>
    <section className="workflow"><div><span>01</span><b>UNDERSTAND</b><p>Transcribe and inspect the entire video.</p></div><div><span>02</span><b>DECIDE</b><p>Rank moments by hook, payoff and retention.</p></div><div><span>03</span><b>CREATE</b><p>Render polished clips, thumbnails and metadata.</p></div></section>
    <footer><span>© 2026 Syntheniq</span><span>Built for creators who care about the story <ArrowUpRight size={14}/></span></footer>
  </main>
}
