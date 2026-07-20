import { useEffect, useState } from 'react';
import { desktop } from '../desktop';

// Landing page: the app is two tools in one — design tracks, and train the AI
// driver on them. Each card opens its own full-screen section.
export function Home({ onBuild, onTrain }: { onBuild: () => void; onTrain: () => void }) {
  const [version, setVersion] = useState('');

  useEffect(() => {
    desktop?.getVersion().then(setVersion);
  }, []);

  return (
    <div className="home">
      <div className="home-hero">
        <div className="home-title">🏁 AC BAPTOU</div>
        <div className="home-sub">Build Assetto Corsa tracks. Train an AI to race them.</div>
      </div>
      <div className="home-cards">
        <button className="home-card" onClick={onBuild}>
          <div className="home-card-icon">🛠️</div>
          <div className="home-card-title">Track Builder</div>
          <div className="home-card-desc">
            Draw a circuit, shape kerbs and run-off, place pits and buildings, then
            export a drivable AC track — with its AI racing line.
          </div>
        </button>
        <button className="home-card" onClick={onTrain} disabled={!desktop}>
          <div className="home-card-icon">🤖</div>
          <div className="home-card-title">AI Training</div>
          <div className="home-card-desc">
            {desktop
              ? 'Pick a track, launch AC on it, and start the reinforcement-learning driver with one click. Live telemetry, logs and checkpoints, all in here.'
              : 'Available in the desktop app.'}
          </div>
        </button>
      </div>
      <div className="home-foot">{version && `v${version}`}</div>
    </div>
  );
}
