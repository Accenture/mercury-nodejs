import { mdiAtom } from '@mdi/js';

/** The brand mark: the Material Design "atom" icon the engine docs use as their logo (Pictogrammers, Apache-2.0). */
export function AtomIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d={mdiAtom} />
    </svg>
  );
}
