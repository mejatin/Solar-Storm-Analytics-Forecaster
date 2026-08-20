import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  parseISO,
  format,
  differenceInDays,
  addDays,
  subDays
} from "date-fns";
import V1 from './components/V1'
import V2 from './components/V2'
import V5 from './components/V5'
import SeasonalPattern from './components/SeasonalPattern'
import ThreatEscalation from './components/ThreatEscalation'
import MenuBar from './components/MenuBar'
import MLPrediction from './components/MLPrediction'
import { DEFAULT_FILTERS, applyGlobalFilters, aggregateDaily } from './utils/globalFilters'

// Default range: full year 2003, so Seasonal Pattern / Threat Escalation
// have enough data to be meaningful on first load.
const DEFAULT_START = '2003-01-01'
const DEFAULT_END   = '2003-12-31'
const DATASET_START = parseISO("1995-01-01")
const DATASET_END   = parseISO("2025-12-31")

const MAX_RANGE_DAYS = 365 * 2
const MIN_RANGE_DAYS = 2

export default function App() {
  const [data, setData]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const [start, setStart]       = useState(DEFAULT_START)
  const [end, setEnd]           = useState(DEFAULT_END)
  const [draftStart, setDraftStart] = useState(DEFAULT_START)
  const [draftEnd, setDraftEnd] = useState(DEFAULT_END)

  // Storm catalog, fetched once and shared by the MenuBar and Time Series.
  const [stormCatalog, setStormCatalog] = useState([])
  useEffect(() => {
    fetch('/api/orbital/storms')
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setStormCatalog)
      .catch(e => console.error('Failed to load storm catalog:', e))
  }, [])

  // Shared state across panels.
  // selectedPoints: timestamps lassoed in Phase Space, shown as ticks in Time Series.
  const [selectedPoints, setSelectedPoints] = useState([])
  // selectedStorm: picked from the MenuBar; drives simDate/simHour so the
  // Orbital Simulator jumps to the same moment.
  const [selectedStorm, setSelectedStorm] = useState(null)
  const [simDate, setSimDate] = useState(DEFAULT_START)
  const [simHour, setSimHour] = useState(0)

  // Only Time Series / Phase Space use these filters (via filteredData).
  const [filters, setFilters] = useState(DEFAULT_FILTERS)

  // Which panel (if any) is currently blown up to full screen — 'v5' | 'v2' |
  // 'seasonal' | 'v1' | 'escalation' | null. Only one at a time.
  const [fullscreenPanel, setFullscreenPanel] = useState(null)

  // Top-level tab — 'dashboard' (the five linked panels) or 'ml' (the storm
  // risk forecaster). The ML tab doesn't use the global Date Range filters,
  // playback, or storm catalog, so it's a fully separate view rather than a
  // sixth panel dropped into the grid.
  const [activeTab, setActiveTab] = useState('dashboard')

  const filteredData = useMemo(() => {
    const filtered = applyGlobalFilters(data, filters, stormCatalog)
    return filters.resolution === 'daily' ? aggregateDaily(filtered) : filtered
  }, [data, filters, stormCatalog])

  // The storm catalog, narrowed to whichever severities are checked in the
  // Geomagnetic filter — every consumer (the MenuBar's jump-to-storm list,
  // its ◀/▶ stepper, and Time Series' "Compare vs" picker) used to always
  // see the full catalog regardless of the severity checkboxes, so turning
  // a severity off didn't actually narrow those lists the way every other
  // filtered view already does. A storm's own intensity is always
  // moderate/intense/severe (never "quiet" — that's what non-storm hours
  // are called), so checking only "Quiet" correctly empties this list.
  const visibleStormCatalog = useMemo(
    () => stormCatalog.filter(s => filters.severity[s.intensity] !== false),
    [stormCatalog, filters.severity],
  )


  // Switching resolution changes timestamp format, so drop any lasso selection.
  useEffect(() => { setSelectedPoints([]) }, [filters.resolution])

  // Playback: sweeps a time cursor through the loaded window, hour by hour.
  const [playing, setPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState(1)
  const [playIdx, setPlayIdx] = useState(0)
  const playIdxRef = useRef(0)
  useEffect(() => { playIdxRef.current = playIdx }, [playIdx])

  useEffect(() => {
    if (!playing || !data.length) return
    const id = setInterval(() => {
      const next = playIdxRef.current + 1
      if (next >= data.length) { setPlaying(false); return }
      setPlayIdx(next)
      const dt = data[next].datetime
      setSimDate(dt.slice(0, 10))
      setSimHour(Number(dt.slice(11, 13)))
    }, Math.max(40, 350 / playSpeed))
    return () => clearInterval(id)
  }, [playing, playSpeed, data])

  // Current moment shown as the time cursor in Time Series / Phase Space.
  const playhead = `${simDate}T${String(simHour).padStart(2, '0')}:00:00`

  function togglePlay() {
    if (!data.length) return
    if (!playing && playIdx >= data.length - 1) setPlayIdx(0)  // replay from start
    setPlaying(p => !p)
  }

  function resetFilters() {
    setFilters(DEFAULT_FILTERS)
    setSelectedStorm(null)
    setPlaying(false)
    setPlayIdx(0)
    applyRange(DEFAULT_START, DEFAULT_END)
  }

  // Picking a storm reframes the date window to cover it, so the charts
  // actually have something to highlight.
  const jumpToStorm = (storm) => {
    setSelectedStorm(storm)
    if (storm?.start) {
      // Anchor to the storm's start, not its peak — "jump to storm" should
      // land the cursor at the storm's onset (matching the labeled date and
      // the left edge of its shaded band), not somewhere mid-storm.
      setSimDate(storm.start.slice(0, 10))
      setSimHour(Number(storm.start.slice(11, 13)))

      const s0 = storm.start.slice(0, 10)
      const s1 = storm.end.slice(0, 10)
      if (s0 < start || s1 > end) {
        applyRange(
          format(subDays(parseISO(s0), 3), 'yyyy-MM-dd'),
          format(addDays(parseISO(s1), 4), 'yyyy-MM-dd'),
          { syncSim: false },
        )
      }
    }
  }

  // Step to the previous/next cataloged storm, chronologically — scoped to
  // visibleStormCatalog so stepping matches whatever's actually selectable
  // in the jump-to-storm list.
  const stepStorm = (dir) => {
    if (!visibleStormCatalog.length) return
    const anchor = selectedStorm ? selectedStorm.start.slice(0, 10) : start
    const target = dir > 0
      ? visibleStormCatalog.find(s => s.start.slice(0, 10) > anchor)
      : [...visibleStormCatalog].reverse().find(s => s.start.slice(0, 10) < anchor)
    if (target) jumpToStorm(target)
  }

  // Changes the loaded window: clears the lasso, stops playback, and syncs
  // simDate/simHour to the new start (unless the caller sets it separately,
  // like jumpToStorm does).
  const applyRange = (newStart, newEnd, { syncSim = true } = {}) => {
    setStart(newStart)
    setEnd(newEnd)
    setDraftStart(newStart)
    setDraftEnd(newEnd)
    setSelectedPoints([])
    setPlaying(false)
    setPlayIdx(0)
    if (syncSim) {
      setSimDate(newStart)
      setSimHour(0)
    }
  }

  // Esc closes a full-screen panel first; only once none is full-screen does
  // it fall through to clearing the lasso selection. selectedStorm is
  // deliberately NOT cleared here — it's set via the MenuBar dropdown/
  // stepper, not a selection made on the page, so it should only reset via
  // the explicit Reset button (same reasoning as the linked-selections
  // banner above only showing for the lasso, not the storm pick).
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return
      if (fullscreenPanel) { setFullscreenPanel(null); return }
      if (selectedPoints.length) setSelectedPoints([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreenPanel, selectedPoints.length])

  // True right after a V1 drag-to-select (or a manual edit in the Date
  // Range popover) until the user applies or discards it — drives the
  // pending-range banner below the top bar.
  const hasPendingRange = draftStart !== start || draftEnd !== end

  const zoomIn = () => {

  const s = parseISO(start)
  const e = parseISO(end)

  const days = differenceInDays(e, s)

  if (days <= MIN_RANGE_DAYS) return

  const newDays = Math.max(MIN_RANGE_DAYS, Math.floor(days / 2))

  const center = new Date((s.getTime() + e.getTime()) / 2)

  const newStart = subDays(center, Math.floor(newDays / 2))
  const newEnd = addDays(center, Math.ceil(newDays / 2))

  applyRange(format(newStart, "yyyy-MM-dd"), format(newEnd, "yyyy-MM-dd"))
}

const zoomOut = () => {

  const s = parseISO(start)
  const e = parseISO(end)

  const days = differenceInDays(e, s)

  if (days >= MAX_RANGE_DAYS) return

  const newDays = Math.min(MAX_RANGE_DAYS, days * 2)

  const center = new Date((s.getTime() + e.getTime()) / 2)

  let newStart = subDays(center, Math.floor(newDays / 2))
  let newEnd = addDays(center, Math.ceil(newDays / 2))

  if (newStart < DATASET_START)
      newStart = DATASET_START

  if (newEnd > DATASET_END)
      newEnd = DATASET_END

  applyRange(format(newStart, "yyyy-MM-dd"), format(newEnd, "yyyy-MM-dd"))
}

const panLeft = () => {

  const s = parseISO(start)
  const e = parseISO(end)

  const days = differenceInDays(e, s)

  let newStart = subDays(s, Math.max(1, Math.floor(days / 4)))
  let newEnd = subDays(e, Math.max(1, Math.floor(days / 4)))

  if (newStart < DATASET_START) {

    newStart = DATASET_START
    newEnd = addDays(DATASET_START, days)

  }

  applyRange(format(newStart, "yyyy-MM-dd"), format(newEnd, "yyyy-MM-dd"))
}

const panRight = () => {

  const s = parseISO(start)
  const e = parseISO(end)

  const days = differenceInDays(e, s)

  let newStart = addDays(s, Math.max(1, Math.floor(days / 4)))
  let newEnd = addDays(e, Math.max(1, Math.floor(days / 4)))

  if (newEnd > DATASET_END) {

      newEnd = DATASET_END
      newStart = subDays(DATASET_END, days)

  }

  applyRange(format(newStart, "yyyy-MM-dd"), format(newEnd, "yyyy-MM-dd"))
}

  const fetchData = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/data?start=${start}&end=${end}`)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [start, end])

  useEffect(() => { fetchData() }, [fetchData])

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-space-bg text-space-dim font-sans">
      {/* Header — title/branding + status only, its own row. */}
      <header className="flex-none border-b border-space-hairline bg-space-panel/90 px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-space-text tracking-tight whitespace-nowrap leading-none">
            Solar Wind &amp; Space Weather Analytics
            <span className="hidden xl:inline ml-3 text-xs font-mono font-normal text-space-faint tracking-normal">
              CS661 · Group 21 · NASA OMNI
            </span>
          </h1>

          {/* Tabs */}
          <div className="ml-4 flex items-center rounded-md border border-space-hairline overflow-hidden font-mono flex-none">
            {[
              { key: 'dashboard', label: 'Dashboard' },
              { key: 'ml', label: 'Storm Risk (ML)' },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`px-3 py-1 text-xs transition-colors ${
                  activeTab === t.key ? 'bg-space-violet text-white' : 'bg-space-panel-2 text-space-dim hover:text-space-text'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Status */}
          <div className="ml-auto flex items-center gap-2 font-mono">
            {loading && (
              <span className="flex items-center gap-1.5 text-xs text-violet-300">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-300 animate-pulse" />
                Fetching…
              </span>
            )}
            {error && (
              <span className="text-xs text-space-danger">
                API error: {error} — is Flask running on port 5000?
              </span>
            )}
            {!loading && !error && data.length > 0 && (
              <span className="text-xs text-space-faint tabular-nums">
                {data.length.toLocaleString()} records · {start} → {end}
              </span>
            )}
          </div>
        </div>
      </header>

      {activeTab === 'ml' ? (
        <MLPrediction />
      ) : (
      <>
      {/* Global filters */}
      <div className="flex-none border-b border-space-hairline bg-space-panel/60 px-3 py-2 flex justify-center">
        <MenuBar
          filters={filters}
          setFilters={setFilters}
          stormCatalog={visibleStormCatalog}
          selectedStorm={selectedStorm}
          onSelectStorm={jumpToStorm}
          playing={playing}
          onTogglePlay={togglePlay}
          playSpeed={playSpeed}
          setPlaySpeed={setPlaySpeed}
          onPrevStorm={() => stepStorm(-1)}
          onNextStorm={() => stepStorm(1)}
          start={start}
          end={end}
          draftStart={draftStart}
          draftEnd={draftEnd}
          setDraftStart={setDraftStart}
          setDraftEnd={setDraftEnd}
          onApplyRange={applyRange}
          loading={loading}
          onPanLeft={panLeft}
          onPanRight={panRight}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onPreset={applyRange}
          onReset={resetFilters}
        />
      </div>

      {/* Loading progress bar */}
      <div className="flex-none h-0.5 bg-transparent">
        {loading && <div className="h-full bg-space-violet animate-pulse" style={{ width: '60%' }} />}
      </div>

      {/* Shown after a chart drag or manual date edit, until applied */}
      {hasPendingRange && (
        <div className="flex-none flex items-center justify-center gap-3 px-4 py-1.5 bg-space-violet/10 border-b border-space-hairline text-xs font-mono">
          <span className="text-space-dim">
            Pending range from chart selection: <b className="text-space-text tabular-nums">{draftStart} → {draftEnd}</b>
          </span>
          <button
            onClick={() => applyRange(draftStart, draftEnd)}
            className="px-2.5 py-0.5 rounded bg-space-violet hover:bg-violet-500 text-white text-[11px] font-medium transition-colors"
          >
            Apply
          </button>
          <button
            onClick={() => { setDraftStart(start); setDraftEnd(end) }}
            className="px-2.5 py-0.5 rounded bg-space-panel-2 border border-space-hairline text-space-dim hover:text-space-text text-[11px] transition-colors"
          >
            Discard
          </button>
        </div>
      )}

      {/* Active cross-visual selections — only for interactions made directly
          on a chart (currently V2's lasso). Picking a storm from the MenuBar
          dropdown/stepper still drives selectedStorm and still highlights it
          elsewhere (V1's shading, V2's ring, V5's date) — it just isn't a
          "selection on the page," so it doesn't show in this banner. */}
      {selectedPoints.length > 0 && (
        <div className="flex-none flex items-center justify-center gap-2 px-4 py-1.5 border-b border-space-hairline text-[11px] font-mono">
          <span className="text-space-faint">Linked selections:</span>
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-space-violet/60 bg-space-violet/10 text-violet-300">
            ◈ {selectedPoints.length} pts lassoed in Phase Space
            <button
              onClick={() => setSelectedPoints([])}
              aria-label="Clear the lassoed points"
              title="Clear the lassoed points"
              className="hover:text-space-text leading-none"
            >
              ✕
            </button>
          </span>
          <span className="text-space-faint hidden lg:inline">(or press Esc)</span>
        </div>
      )}

      {/* All panels on one page: Orbital / Phase Space / Seasonal on top,
          Time Series / Threat Escalation below. */}
      <main className="flex-1 min-h-0 flex flex-col gap-3 px-3 pb-3 pt-3">
        <div className="flex-1 min-h-0 flex gap-3">
          <div className="flex-[2] min-w-0">
            <V5
              simDate={simDate} simHour={simHour} setSimDate={setSimDate} setSimHour={setSimHour}
              isFullscreen={fullscreenPanel === 'v5'}
              onToggleFullscreen={v => setFullscreenPanel(v ? 'v5' : null)}
            />
          </div>
          <div className="flex-1 min-w-0">
            <V2
              data={filteredData} loading={loading} selectedPoints={selectedPoints} onSelectPoints={setSelectedPoints} selectedStorm={selectedStorm} playhead={playhead}
              isFullscreen={fullscreenPanel === 'v2'}
              onToggleFullscreen={v => setFullscreenPanel(v ? 'v2' : null)}
            />
          </div>
          <div className="flex-1 min-w-0">
            <SeasonalPattern
              start={start} end={end}
              isFullscreen={fullscreenPanel === 'seasonal'}
              onToggleFullscreen={v => setFullscreenPanel(v ? 'seasonal' : null)}
            />
          </div>
        </div>

        <div className="flex-none h-72 flex gap-3">
          <div className="flex-1 min-w-0">
            <V1
              data={filteredData} loading={loading} setDraftStart={setDraftStart} setDraftEnd={setDraftEnd} selectedPoints={selectedPoints} selectedStorm={selectedStorm} playhead={playhead} stormCatalog={visibleStormCatalog}
              isFullscreen={fullscreenPanel === 'v1'}
              onToggleFullscreen={v => setFullscreenPanel(v ? 'v1' : null)}
            />
          </div>
          <div className="flex-1 min-w-0">
            <ThreatEscalation
              start={start} end={end}
              isFullscreen={fullscreenPanel === 'escalation'}
              onToggleFullscreen={v => setFullscreenPanel(v ? 'escalation' : null)}
            />
          </div>
        </div>
      </main>
      </>
      )}
    </div>
  )
}
