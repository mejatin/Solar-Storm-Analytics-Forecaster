// Shared outer container for every panel. Normally just the panel's own
// card box; when isFullscreen, the SAME content re-parents into a fixed
// overlay covering the viewport (an in-app "maximize", not the browser's
// real Fullscreen API — see FullscreenButton). Backdrop click also closes it.
//
// The two branches must return the SAME element shape (a fragment with a
// [maybe-backdrop, content-div] pair) — swapping between a bare <div> and a
// <>...</> fragment root would change the returned element's TYPE, which
// makes React unmount and remount the whole subtree on every toggle. That
// silently orphans each chart's ResizeObserver/rAF draw loop (still bound to
// the old, now-detached node) and leaves the freshly mounted node blank.
export default function FullscreenFrame({ isFullscreen, onClose, children }) {
  return (
    <>
      {isFullscreen && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      )}
      <div
        className={
          isFullscreen
            ? 'fixed inset-4 md:inset-10 z-50 flex flex-col bg-space-panel border border-space-hairline rounded-xl overflow-hidden shadow-2xl'
            : 'h-full flex flex-col bg-space-panel border border-space-hairline rounded-xl overflow-hidden'
        }
      >
        {children}
      </div>
    </>
  )
}
