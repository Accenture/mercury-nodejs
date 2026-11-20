import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../api';
import { shortTime } from '../model';
import { ACTUATOR, type ActuatorPath, type ActuatorResult } from '../types';

/** The body shown: JSON pretty-printed when it parses, else the text as it came (the liveness probe's OK). */
export function pretty(result: ActuatorResult): string {
  if (result.contentType.startsWith('application/json')) {
    try {
      return JSON.stringify(JSON.parse(result.body), null, 2);
    } catch {
      return result.body;
    }
  }
  return result.body;
}

export interface ActuatorProps {
  api: Api;
}

/**
 * The host's actuator endpoints as a menu - the engines' /info, /info/routes, /health, /env and /livenessprobe, which
 * the backend keeps at their paths beside the UI's bundle, so a person reads from the UI what a container manager
 * (Kubernetes) reads from the probes; the Playground web app has the same menu over the engine's actuator.
 */
export function Actuator({ api }: ActuatorProps) {
  const [path, setPath] = useState<ActuatorPath>('/info');
  const [result, setResult] = useState<ActuatorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async (target: ActuatorPath) => {
    setLoading(true);
    setProblem(null);
    try {
      setResult(await api.actuator(target));
    } catch (error) {
      setResult(null);
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const entry = ACTUATOR.find((e) => e.path === path)!;
  return (
    <div className="actuator">
      <div className="menu" role="group" aria-label="actuator endpoints">
        {ACTUATOR.map((e) => (
          <button key={e.path} type="button" className={e.path === path ? 'active' : ''} onClick={() => setPath(e.path)} aria-pressed={e.path === path}>
            {e.label}
          </button>
        ))}
        <button type="button" onClick={() => void load(path)} disabled={loading}>Refresh</button>
      </div>
      <div className="meta about"><code>GET {entry.path}</code> - {entry.about}</div>
      {problem && <div className="notice error" role="alert">{problem}</div>}
      {loading && !result && <div className="loading">Loading...</div>}
      {result && (
        <div className="result" data-testid="actuator-result">
          <div className="head">
            <code>GET {result.path}</code>
            <span className={result.status < 400 ? 'status-ok' : 'status-bad'}>{result.status}</span>
            <span className="meta">{result.contentType || 'no content type'} · {shortTime(result.at)}</span>
          </div>
          <pre>{pretty(result)}</pre>
        </div>
      )}
    </div>
  );
}
