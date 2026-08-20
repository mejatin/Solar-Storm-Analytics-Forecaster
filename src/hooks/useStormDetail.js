import { useState, useEffect } from 'react'
import { fetchWindow } from '../utils/fetchWindow'

const DISPLAY_BEFORE = 12   // hours shown before the detected shock
const DISPLAY_AFTER  = 72   // hours shown after
const SHOCK_LOOKBACK  = 48  // how far back to search for the steepest Pdyn rise

// /api/data and /api/orbital/storms use different timezone suffixes for the
// same instants — compare as plain strings, not via new Date().
const stripZ = s => (s.endsWith('Z') ? s.slice(0, -1) : s)

function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Steepest positive hourly ΔPdyn before peakIdx (the SYM-H minimum)
function findShockIndex(series, peakIdx, lookback) {
  let best = -Infinity, idx = null
  const from = Math.max(1, peakIdx - lookback)
  for (let i = from; i <= peakIdx; i++) {
    const a = series[i - 1].pdyn_computed_nPa, b = series[i].pdyn_computed_nPa
    if (a == null || b == null) continue
    if (b - a > best) { best = b - a; idx = i }
  }
  return idx ?? peakIdx
}

// Fetch a storm's window, detect its shock arrival, and re-index so `i` is
// hours from shock.
async function loadStormDetail(storm) {
  const startPad = addDaysISO(stripZ(storm.start).slice(0, 10), -1)
  const endPad = addDaysISO(stripZ(storm.end).slice(0, 10), 5)
  const rows = await fetchWindow(startPad, endPad)
  const series = rows.map((r, i) => ({ ...r, i, t: new Date(r.datetime) }))
  if (!series.length) return null

  const peakRaw = stripZ(storm.peak_time)
  let peakIdx = series.findIndex(r => r.datetime === peakRaw)
  if (peakIdx === -1) {
    const peakDate = new Date(peakRaw)
    let best = 0, bestDiff = Infinity
    series.forEach((r, i) => { const diff = Math.abs(r.t - peakDate); if (diff < bestDiff) { bestDiff = diff; best = i } })
    peakIdx = best
  }

  const shockIdx = findShockIndex(series, peakIdx, SHOCK_LOOKBACK)
  const from = Math.max(0, shockIdx - DISPLAY_BEFORE)
  const to = Math.min(series.length - 1, shockIdx + DISPLAY_AFTER)
  const windowed = series.slice(from, to + 1).map((r, k) => ({ ...r, i: from + k - shockIdx }))

  return { storm, series: windowed }
}

// Fetches and shock-aligns a storm's detail window
export function useStormDetail(storm) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!storm) { setData(null); setError(null); return }
    let cancelled = false
    setError(null)
    loadStormDetail(storm)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) { setData(null); setError(String(e)) } })
    return () => { cancelled = true }
  }, [storm])

  return { data, error }
}
