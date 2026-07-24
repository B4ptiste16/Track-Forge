// Electron's packaged runtime does NOT implement window.prompt() — it just
// returns null, which silently aborted "Save & start new training", "Bank
// checkpoint", and layout naming. This is a drop-in async replacement: an
// in-app modal backed by a module-level singleton, so call sites just do
// `await textPrompt('Label:', 'default')`. Mount <PromptHost/> once at the app
// root. Resolves to the entered string, or null if cancelled.
import { useEffect, useState } from 'react';

type Req = { title: string; def: string; resolve: (v: string | null) => void };
let _push: ((r: Req) => void) | null = null;

export function textPrompt(title: string, def = ''): Promise<string | null> {
  return new Promise((resolve) => {
    if (_push) _push({ title, def, resolve });
    else resolve(null); // host not mounted — fail closed, don't hang
  });
}

export function PromptHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [val, setVal] = useState('');
  useEffect(() => {
    _push = (r) => { setReq(r); setVal(r.def); };
    return () => { _push = null; };
  }, []);
  if (!req) return null;
  const done = (v: string | null) => { req.resolve(v); setReq(null); };
  return (
    <div className="prompt-overlay" onMouseDown={() => done(null)}>
      <div className="prompt-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="prompt-title">{req.title}</div>
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') done(val);
            else if (e.key === 'Escape') done(null);
          }}
        />
        <div className="prompt-actions">
          <button onClick={() => done(null)}>Cancel</button>
          <button className="primary" onClick={() => done(val)}>OK</button>
        </div>
      </div>
    </div>
  );
}
