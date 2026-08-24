import { useCallback, useRef, useState } from 'react';

// Project state with an undo/redo history.
//
// Edits that land close together are COALESCED into one history entry —
// dragging a width slider fires a change per pixel, and without this a single
// drag would need fifty presses of Ctrl+Z to walk back. The first edit after a
// pause starts a new entry, so each deliberate action is one step.
export function useUndoable<T>(initial: () => T, coalesceMs = 450) {
  const [state, setStateRaw] = useState<T>(initial);
  const current = useRef<T>(state);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastEdit = useRef(0);

  const LIMIT = 100; // plenty to walk back through, bounded so memory can't run away

  const set = useCallback((next: T | ((prev: T) => T)) => {
    const prev = current.current;
    const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
    if (Object.is(value, prev)) return;
    const now = Date.now();
    if (now - lastEdit.current > coalesceMs || past.current.length === 0) {
      past.current.push(prev);
      if (past.current.length > LIMIT) past.current.shift();
    }
    lastEdit.current = now;
    future.current = [];
    current.current = value;
    setStateRaw(value);
  }, [coalesceMs]);

  // Replace the project outright without recording a step — loading a track or
  // starting a new one should not be something Ctrl+Z walks back INTO.
  const reset = useCallback((value: T) => {
    past.current = [];
    future.current = [];
    lastEdit.current = 0;
    current.current = value;
    setStateRaw(value);
  }, []);

  const undo = useCallback(() => {
    const p = past.current.pop();
    if (p === undefined) return false;
    future.current.push(current.current);
    lastEdit.current = 0;
    current.current = p;
    setStateRaw(p);
    return true;
  }, []);

  const redo = useCallback(() => {
    const f = future.current.pop();
    if (f === undefined) return false;
    past.current.push(current.current);
    lastEdit.current = 0;
    current.current = f;
    setStateRaw(f);
    return true;
  }, []);

  return { state, set, reset, undo, redo } as const;
}
