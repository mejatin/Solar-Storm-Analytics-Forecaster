// Small icon-only toggle, dropped into a panel's own header row (not
// absolutely positioned — headers already lay out their own trailing
// controls, so this just joins that flex row as the last item).
export default function FullscreenButton({ active, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label={active ? 'Exit full screen' : 'Full screen'}
      title={active ? 'Exit full screen (Esc)' : 'Full screen'}
      className="flex-none flex items-center justify-center w-5 h-5 rounded border border-space-hairline text-space-dim hover:text-space-text hover:border-space-fast transition-colors"
    >
      {active ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3v4a2 2 0 0 1-2 2H3M21 9h-4a2 2 0 0 1-2-2V3M3 15h4a2 2 0 0 1 2 2v4M15 21v-4a2 2 0 0 1 2-2h4" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      )}
    </button>
  )
}
