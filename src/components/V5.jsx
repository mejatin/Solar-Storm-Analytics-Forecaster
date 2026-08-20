import { useEffect, useRef, useState, useMemo } from 'react'
import * as d3 from 'd3'
import { fetchDay } from '../utils/fetchWindow'
import { magnetopauseR0, flaringAlpha, shueRadius } from '../utils/shue'
import FullscreenFrame from './FullscreenFrame'
import FullscreenButton from './FullscreenButton'

// Orbital Exposure Simulator — Earth-centric date+hour snapshot. Canvas +
// requestAnimationFrame. Orbital shells at true Earth-radii scale:
//   LEO 400 km ≈ 1.06 Re, Polar 850 km ≈ 1.13 Re, MEO 20,200 km ≈ 4.17 Re,
//   GEO 35,786 km ≈ 6.61 Re
//
// Magnetopause: Shue et al. (1998) — r(θ) = r0 · (2 / (1 + cosθ))^α
//
// Exposure score per shell (weighted *_norm columns, thresholds:
// safe < 0.34 ≤ elevated < 0.62 ≤ danger):
//   GEO   0.55·mpFactor + 0.30·ae_n + 0.15·imf_n
//   MEO   0.45·clamp(−Dst/250) + 0.35·ae_n + 0.20·speed_n
//   LEO   0.45·ae_n + 0.35·Kp/9 + 0.20·density_n
//   Polar 0.50·ae_n + 0.30·(1−bz_n) + 0.20·speed_n
//
// Stars/corona/streamlines/satellite motion are decorative only — the
// actual scene is driven by simDate/simHour.

const RE = { LEO: 1.0627, Polar: 1.1334, MEO: 4.1683, GEO: 6.6107 }
const ORBITS = ['LEO', 'Polar', 'MEO', 'GEO']
const N_SATS = { LEO: 5, Polar: 3, MEO: 4, GEO: 4 }
const OMEGA = { LEO: 0.55, Polar: 0.50, MEO: 0.18, GEO: 0.08 }   // cosmetic angular speed, rad/s
const T_SAFE = 0.34, T_DANGER = 0.62

const COL = {
  text: '#E7EAF0', dim: '#7C8496', faint: '#4B5265', hairline: '#252B3A',
  calm: '#4F8CFF', danger: '#FF5B54', fast: '#43D9C8', slow: '#E8A33D',
}
const LEVEL_COLOR = { safe: COL.fast, warn: COL.slow, danger: COL.danger }
const LEVEL_TEXT  = { safe: 'Safe', warn: 'Elevated', danger: 'Danger' }

const ok = v => v != null && Number.isFinite(v)
const clamp01 = v => Math.max(0, Math.min(1, v))
const level = v => (v < T_SAFE ? 'safe' : v < T_DANGER ? 'warn' : 'danger')

function rowValid(r) {
  return !!r && ok(r.bz_gsm_nT) && ok(r.pdyn_computed_nPa) && r.pdyn_computed_nPa > 0 && ok(r.ae_norm)
}

// Split viridis's hex output into RGB channels so the aurora glow can vary alpha per stop
function viridisRgb(t) {
  const hex = d3.interpolateViridis(clamp01(t))
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Seeded RNG for a deterministic starfield
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const STAR_FIELD_W = 1400, STAR_FIELD_H = 900
const STARS = (() => {
  const rnd = mulberry32(1337)
  return Array.from({ length: 220 }, () => ({
    x: rnd() * STAR_FIELD_W, y: rnd() * STAR_FIELD_H,
    r: rnd() * 1.3 + 0.25, tw: rnd() * Math.PI * 2, sp: 0.6 + rnd() * 1.4,
  }))
})()
const EARTH_SPECKLE = (() => {
  const rnd = mulberry32(42)
  return Array.from({ length: 14 }, () => ({
    a: rnd() * Math.PI * 2, d: rnd(), rw: 0.14 + rnd() * 0.16, rh: 0.08 + rnd() * 0.1,
  }))
})()

export default function V5({ simDate, simHour, setSimDate, setSimHour, isFullscreen, onToggleFullscreen }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)

  const [day, setDay] = useState([])
  const [dayError, setDayError] = useState(null)

  const [visibleOrbits, setVisibleOrbits] = useState(() => new Set(ORBITS))

  // Fetch the sim day's hourly rows
  useEffect(() => {
    let cancelled = false
    setDayError(null)
    fetchDay(simDate)
      .then(rows => { if (!cancelled) setDay(rows) })
      .catch(e => { if (!cancelled) { setDay([]); setDayError(String(e)) } })
    return () => { cancelled = true }
  }, [simDate])

  // The row for simHour, falling back to the nearest valid hour within ±6h,
  // plus the magnetopause and per-shell exposure scores.
  const frame = useMemo(() => {
    if (!day.length) return null
    let row = day[simHour], usedHour = simHour, fallback = false
    if (!rowValid(row)) {
      for (let d = 1; d <= 6 && !rowValid(row); d++) {
        if (rowValid(day[simHour - d])) { row = day[simHour - d]; usedHour = simHour - d; fallback = true }
        else if (rowValid(day[simHour + d])) { row = day[simHour + d]; usedHour = simHour + d; fallback = true }
      }
    }
    if (!rowValid(row)) {
      const r0 = magnetopauseR0(0, 2), alpha = flaringAlpha(0, 2)
      return { row: null, usedHour: null, fallback: false, mp: { r0, alpha }, scores: null, noData: true }
    }
    const r0 = magnetopauseR0(row.bz_gsm_nT, row.pdyn_computed_nPa)
    const alpha = flaringAlpha(row.bz_gsm_nT, row.pdyn_computed_nPa)
    const mpFactor = clamp01((9 - r0) / 2.4)
    const scores = {
      GEO:   0.55 * mpFactor + 0.30 * row.ae_norm + 0.15 * (row.imf_norm ?? 0),
      MEO:   0.45 * clamp01(-(row.dst_omni ?? 0) / 250) + 0.35 * row.ae_norm + 0.20 * (row.speed_norm ?? 0),
      LEO:   0.45 * row.ae_norm + 0.35 * (row.kp ?? 0) / 9 + 0.20 * (row.density_norm ?? 0),
      Polar: 0.50 * row.ae_norm + 0.30 * (1 - (row.bz_norm ?? 0.5)) + 0.20 * (row.speed_norm ?? 0),
    }
    return { row, usedHour, fallback, mp: { r0, alpha }, scores, noData: false }
  }, [day, simHour])

  // Read by the rAF loop without re-triggering the mount-once effect
  const frameRef = useRef(frame)
  useEffect(() => { frameRef.current = frame }, [frame])
  const visibleOrbitsRef = useRef(visibleOrbits)
  useEffect(() => { visibleOrbitsRef.current = visibleOrbits }, [visibleOrbits])

  // On-screen satellite positions, for the hover tooltip's hit-test
  const satsRef = useRef([])
  const [hoverSat, setHoverSat] = useState(null)

  // Canvas sizing + the continuous rAF draw loop
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')

    let disposed = false
    let raf = 0
    let t0 = performance.now()
    let clock = 0
    let shockRings = []
    let lastShockClock = -999

    const phases = {}
    for (const o of ORBITS) phases[o] = Array.from({ length: N_SATS[o] }, (_, i) => (i / N_SATS[o]) * 2 * Math.PI)

    function loop(now) {
      if (disposed) return
      const dt = Math.min(0.1, (now - t0) / 1000); t0 = now
      clock += dt
      for (const o of ORBITS) phases[o] = phases[o].map(p => p + OMEGA[o] * dt)
      draw(dt)
      raf = requestAnimationFrame(loop)
    }

    function draw(dt) {
      const W = wrap.clientWidth || 700, H = wrap.clientHeight || 460
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = W * dpr; canvas.height = H * dpr
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      ctx.font = "11px 'JetBrains Mono', monospace"
      ctx.textBaseline = 'alphabetic'

      drawStars(ctx, W, H, clock)

      const F = frameRef.current
      if (!F) return

      const cx = W * 0.58, cy = H / 2
      // Scale factor keeps Earth+shells smaller than the Sun (real ratio ~109:1, undrawable)
      const pxRe = 0.82 * Math.min(H / 2 - 34, W * 0.30) / RE.GEO
      const sunX = 128, sunR = Math.min(84, H * 0.11)
      const aeN = F.noData ? 0 : (F.row.ae_norm ?? 0)

      drawSun(ctx, sunX, cy, sunR, clock)
      drawSolarWindStreamlines(ctx, sunX, sunR, cx, cy, pxRe, W, H, F, clock)

      // aurora — soft AE-driven glow ringing the poles
      if (aeN > 0.02) {
        const [r, g, b] = viridisRgb(0.42 + 0.4 * aeN)
        const rg = ctx.createRadialGradient(cx, cy, pxRe * 0.6, cx, cy, pxRe * 2.3)
        rg.addColorStop(0, `rgba(${r},${g},${b},${(0.4 * aeN).toFixed(3)})`)
        rg.addColorStop(1, `rgba(${r},${g},${b},0)`)
        ctx.fillStyle = rg
        ctx.beginPath(); ctx.arc(cx, cy, pxRe * 2.3, 0, 2 * Math.PI); ctx.fill()
      }

      // magnetopause — full Shue r(θ), θ from the sunward axis; Sun is left,
      // so screen-x is flipped (sunward = −x)
      const mpPath = new Path2D()
      let first = true
      for (let deg = -124; deg <= 124; deg += 2) {
        const th = deg * Math.PI / 180
        const r = shueRadius(th, F.mp.r0, F.mp.alpha) * pxRe
        const px = cx - r * Math.cos(th)
        const py = cy + r * Math.sin(th)
        first ? mpPath.moveTo(px, py) : mpPath.lineTo(px, py)
        first = false
      }
      ctx.save()
      ctx.strokeStyle = COL.fast
      ctx.lineWidth = 1.6
      ctx.shadowColor = COL.fast
      ctx.shadowBlur = F.noData ? 0 : 10
      ctx.setLineDash(F.noData ? [6, 5] : [])
      ctx.stroke(mpPath)
      ctx.restore()
      ctx.setLineDash([])
      ctx.fillStyle = COL.dim
      ctx.fillText(`magnetopause r₀ = ${F.mp.r0.toFixed(1)} Re`, Math.max(sunX + 40, cx - F.mp.r0 * pxRe - 168), 22)

      drawDipoleFieldLines(ctx, cx, cy, pxRe, aeN)
      drawEarth(ctx, cx, cy, Math.max(6, pxRe), sunX)

      // impact shockwave — pulses out when any shell crosses into danger
      const impact = F.noData ? 0 : Math.max(F.scores.GEO, F.scores.MEO, F.scores.LEO, F.scores.Polar)
      if (impact > T_SAFE) {
        const t = Math.min(1, (impact - T_SAFE) / (1 - T_SAFE))
        const interval = 2.4 - 1.7 * t
        if (clock - lastShockClock > interval) {
          shockRings.push({
            r: pxRe * 1.05, speed: pxRe * (1.1 + 2.0 * t), maxR: pxRe * (2.6 + 2.6 * t),
            alpha: 0.85, lv: level(impact),
          })
          lastShockClock = clock
        }
      }
      for (let i = shockRings.length - 1; i >= 0; i--) {
        const s = shockRings[i]
        s.r += s.speed * dt
        s.alpha -= dt * (0.9 * s.speed / s.maxR + 0.15)
        if (s.alpha <= 0 || s.r > s.maxR) shockRings.splice(i, 1)
      }
      drawShockRings(ctx, cx, cy, shockRings)

      // orbital shells + satellites
      const frameSats = []
      for (const o of ORBITS) {
        if (!visibleOrbitsRef.current.has(o)) continue
        const R = RE[o] * pxRe
        ctx.save()
        ctx.strokeStyle = 'rgba(148,168,210,0.30)'
        ctx.lineWidth = 0.85
        ctx.setLineDash([1, 3])
        ctx.beginPath()
        if (o === 'Polar') ctx.ellipse(cx, cy, R * 0.35, R, 0, 0, 2 * Math.PI)
        else ctx.arc(cx, cy, R, 0, 2 * Math.PI)
        ctx.stroke()
        ctx.restore()

        ctx.fillStyle = COL.faint
        // Polar's label goes on top (its radius is close to LEO's, avoids overlap)
        if (o === 'Polar') ctx.fillText(o, cx - 12, cy - R - 6)
        else ctx.fillText(o, cx + R * 0.72 + 4, cy + R * 0.72)

        const shellLv = F.noData ? 'safe' : level(F.scores[o])
        for (const p of phases[o]) {
          let sx, sy
          if (o === 'Polar') { sx = cx + R * 0.35 * Math.cos(p); sy = cy + R * Math.sin(p) }
          else { sx = cx + R * Math.cos(p); sy = cy + R * Math.sin(p) }
          const theta = Math.atan2(sy - cy, -(sx - cx))
          const inside = F.noData || Math.hypot(sx - cx, sy - cy) / pxRe < shueRadius(theta, F.mp.r0, F.mp.alpha)
          const lv = !inside ? 'danger' : shellLv
          const col = LEVEL_COLOR[lv]
          ctx.save()
          ctx.shadowColor = col; ctx.shadowBlur = 8
          ctx.fillStyle = col
          ctx.beginPath(); ctx.arc(sx, sy, 3.2, 0, 2 * Math.PI); ctx.fill()
          ctx.restore()
          if (!inside) {
            ctx.strokeStyle = COL.danger; ctx.lineWidth = 1.2
            ctx.beginPath(); ctx.arc(sx, sy, 6.5, 0, 2 * Math.PI); ctx.stroke()
          }
          frameSats.push({ x: sx, y: sy, orbit: o, lv, inside, score: F.noData ? null : F.scores[o] })
        }
      }
      satsRef.current = frameSats

      legendChip(ctx, 12, H - 14, LEVEL_COLOR.safe, 'Safe')
      legendChip(ctx, 78, H - 14, LEVEL_COLOR.warn, 'Elevated')
      legendChip(ctx, 168, H - 14, LEVEL_COLOR.danger, 'Danger / outside magnetopause')
    }

    raf = requestAnimationFrame(loop)

    // Satellite hover tooltip, hit-testing against satsRef
    const HIT_R = 9
    function handleMove(e) {
      const rect = wrap.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      let nearest = null, bestD = HIT_R
      for (const s of satsRef.current) {
        const d = Math.hypot(s.x - mx, s.y - my)
        if (d < bestD) { bestD = d; nearest = s }
      }
      setHoverSat(nearest ? { ...nearest, mx, my } : null)
    }
    function handleLeave() { setHoverSat(null) }
    wrap.addEventListener('mousemove', handleMove)
    wrap.addEventListener('mouseleave', handleLeave)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      wrap.removeEventListener('mousemove', handleMove)
      wrap.removeEventListener('mouseleave', handleLeave)
    }
  }, [])

  return (
    <FullscreenFrame isFullscreen={isFullscreen} onClose={() => onToggleFullscreen(false)}>
      <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-space-hairline bg-space-panel-2/60">
        <span
          className="text-sm font-semibold text-space-text truncate"
          title="True-scale LEO/Polar/MEO/GEO shells · full Shue magnetopause · a storm click elsewhere jumps this snapshot"
        >
          Orbital Exposure Simulator
        </span>

        <div className="ml-auto">
          <FullscreenButton active={isFullscreen} onClick={() => onToggleFullscreen(!isFullscreen)} />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <V5TopBar
          simDate={simDate} simHour={simHour} setSimDate={setSimDate} setSimHour={setSimHour}
          frame={frame}
          visibleOrbits={visibleOrbits} setVisibleOrbits={setVisibleOrbits}
        />

        <div ref={wrapRef} className="relative flex-1 min-h-0 rounded-lg overflow-hidden"
          style={{ background: 'radial-gradient(ellipse at 50% 40%, #0d1118 0%, #060810 70%, #030405 100%)' }}>
          <canvas ref={canvasRef} className="block w-full h-full" />
          {dayError && (
            <div className="absolute inset-0 flex items-center justify-center text-space-danger text-xs font-mono text-center px-6">
              Could not load {simDate}: {dayError}
            </div>
          )}
          {hoverSat && (
            <div
              className="absolute z-10 pointer-events-none bg-space-panel border border-space-hairline rounded-md px-2 py-1 text-[10px] font-mono text-space-text shadow-lg whitespace-nowrap"
              style={{ left: hoverSat.mx + 10, top: hoverSat.my - 10 }}
            >
              <b>{hoverSat.orbit}</b> satellite — <span style={{ color: LEVEL_COLOR[hoverSat.lv] }}>{LEVEL_TEXT[hoverSat.lv]}</span>
              {hoverSat.score != null && <span className="text-space-faint"> · {hoverSat.score.toFixed(2)}</span>}
              {!hoverSat.inside && <div className="text-space-danger">outside magnetopause</div>}
            </div>
          )}
        </div>
      </div>
    </FullscreenFrame>
  )
}

// Top bar: date/hour controls, shell toggles, exposure readout
function V5TopBar({ simDate, simHour, setSimDate, setSimHour, frame, visibleOrbits, setVisibleOrbits }) {
  return (
    <div className="flex-none rounded-lg bg-space-panel-2 border border-space-hairline px-3 py-2 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px]">
      <label className="flex items-center gap-2 text-space-dim">
        Date
        <input type="date" value={simDate} min="1995-01-01" max="2025-12-31"
          onChange={e => setSimDate(e.target.value)}
          className="bg-space-panel border border-space-hairline rounded px-1.5 py-0.5 text-space-text text-[10px]" />
      </label>

      <label className="flex items-center gap-2 text-space-dim">
        Hour <b className="text-space-text">{String(simHour).padStart(2, '0')}:00 UT</b>
        <input type="range" min="0" max="23" step="1" value={simHour}
          onChange={e => setSimHour(Number(e.target.value))}
          className="w-28 accent-space-violet" />
      </label>

      <div className="flex items-center gap-2.5">
        <span className="text-space-faint uppercase tracking-wider text-[9px]">Shells</span>
        {ORBITS.map(o => (
          <label key={o} className="flex items-center gap-1 text-space-dim cursor-pointer whitespace-nowrap">
            <input
              type="checkbox" checked={visibleOrbits.has(o)}
              onChange={() => setVisibleOrbits(prev => {
                const next = new Set(prev)
                next.has(o) ? next.delete(o) : next.add(o)
                return next
              })}
              className="accent-space-fast"
            />
            {o}
          </label>
        ))}
      </div>

      <div className="h-4 w-px bg-space-hairline" />

      <ReadoutStrip frame={frame} />
    </div>
  )
}

function ReadoutStrip({ frame }) {
  if (!frame) {
    return <span className="text-space-faint">loading…</span>
  }
  if (frame.noData) {
    return (
      <span className="text-space-faint">
        No usable measurements within ±6 h of the chosen hour (instrument saturation) — showing a dashed default magnetopause (Bz 0 nT, Pdyn 2 nPa).
      </span>
    )
  }

  const r = frame.row
  const rows = [
    ['Bz', r.bz_gsm_nT?.toFixed(1), 'nT'],
    ['Speed', r.flow_speed_kms?.toFixed(0), 'km/s'],
    ['Density', r.proton_density_ncc?.toFixed(1), 'n/cc'],
    ['AE', r.ae_index_nT?.toFixed(0), 'nT'],
    ['Dst', r.dst_omni?.toFixed(0), 'nT'],
    ['Kp', r.kp, ''],
  ]

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {frame.fallback && (
        <span className="text-space-slow">⚠ gap — showing {String(frame.usedHour).padStart(2, '0')}:00 UT</span>
      )}

      {rows.map(([k, v, u]) => (
        <span key={k} className="text-space-faint whitespace-nowrap">
          {k} <b className="text-space-text">{v ?? '—'}</b>{u && <span className="text-space-faint ml-0.5">{u}</span>}
        </span>
      ))}

      <div className="h-4 w-px bg-space-hairline" />

      <div className="flex items-center gap-1.5">
        {ORBITS.map(o => {
          const lv = level(frame.scores[o])
          return (
            <span key={o} className="px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap" style={{ color: LEVEL_COLOR[lv], background: `${LEVEL_COLOR[lv]}1a`, border: `1px solid ${LEVEL_COLOR[lv]}` }}>
              {o} {LEVEL_TEXT[lv]} · {frame.scores[o].toFixed(2)}
            </span>
          )
        })}
      </div>

      {frame.mp.r0 < RE.GEO && (
        <span className="text-space-slow whitespace-nowrap">⚠ magnetopause inside GEO</span>
      )}
    </div>
  )
}

// Canvas drawing helpers

function drawStars(ctx, W, H, clock) {
  const tilesX = Math.ceil(W / STAR_FIELD_W) + 1
  const tilesY = Math.ceil(H / STAR_FIELD_H) + 1
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const ox = tx * STAR_FIELD_W, oy = ty * STAR_FIELD_H
      for (const s of STARS) {
        const x = ox + s.x, y = oy + s.y
        if (x > W || y > H) continue
        const tw = 0.55 + 0.45 * Math.sin(clock * s.sp + s.tw)
        ctx.fillStyle = `rgba(220,232,255,${(0.35 + 0.5 * tw).toFixed(2)})`
        ctx.beginPath(); ctx.arc(x, y, s.r, 0, 2 * Math.PI); ctx.fill()
      }
    }
  }
}

// Deterministic hash → [0,1), for sunspot placement
const frac = x => x - Math.floor(x)
const hash1 = i => frac(Math.sin(i * 12.9898) * 43758.5453)

function drawSun(ctx, sx, sy, r, clock) {
  const pulse = 1 + 0.02 * Math.sin(clock * 1.3)

  // Outer corona — kept tighter than before so a big Sun doesn't wash the scene
  const corona = ctx.createRadialGradient(sx, sy, r * 0.9, sx, sy, r * 3.0)
  corona.addColorStop(0, 'rgba(255,190,110,0.28)')
  corona.addColorStop(0.4, 'rgba(255,145,70,0.12)')
  corona.addColorStop(1, 'rgba(255,120,60,0)')
  ctx.fillStyle = corona
  ctx.beginPath(); ctx.arc(sx, sy, r * 3.0, 0, 2 * Math.PI); ctx.fill()

  const glow = ctx.createRadialGradient(sx, sy, r * 0.4, sx, sy, r * 1.6 * pulse)
  glow.addColorStop(0, 'rgba(255,235,190,0.85)')
  glow.addColorStop(0.6, 'rgba(255,170,80,0.30)')
  glow.addColorStop(1, 'rgba(255,120,60,0)')
  ctx.fillStyle = glow
  ctx.beginPath(); ctx.arc(sx, sy, r * 1.6 * pulse, 0, 2 * Math.PI); ctx.fill()

  // Photosphere with limb darkening
  const disc = ctx.createRadialGradient(sx, sy, r * 0.05, sx, sy, r)
  disc.addColorStop(0, '#fffbe9')
  disc.addColorStop(0.35, '#ffedad')
  disc.addColorStop(0.7, '#ffc25e')
  disc.addColorStop(0.92, '#f78a2e')
  disc.addColorStop(1, '#d96a1c')
  ctx.save()
  ctx.shadowColor = 'rgba(255,170,90,0.85)'
  ctx.shadowBlur = 30
  ctx.fillStyle = disc
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, 2 * Math.PI); ctx.fill()
  ctx.restore()

  // Granulation + sunspots, clipped to the disc
  ctx.save()
  ctx.beginPath(); ctx.arc(sx, sy, r * 0.985, 0, 2 * Math.PI); ctx.clip()
  for (let i = 0; i < 22; i++) {
    const a = hash1(i) * 2 * Math.PI + clock * 0.01
    const d = Math.sqrt(hash1(i + 40)) * 0.9
    const gx = sx + Math.cos(a) * d * r
    const gy = sy + Math.sin(a) * d * r
    const gr = r * (0.05 + 0.09 * hash1(i + 80))
    ctx.fillStyle = i % 6 === 0 ? 'rgba(150,70,20,0.20)' : 'rgba(220,130,50,0.10)'
    ctx.beginPath(); ctx.arc(gx, gy, gr, 0, 2 * Math.PI); ctx.fill()
  }
  ctx.restore()

  ctx.fillStyle = 'rgba(255,220,180,0.85)'
  ctx.fillText('Sun', sx - 10, sy + r + 18)
}

// Flowing solar-wind streamlines, bent around the magnetopause nose.
function drawSolarWindStreamlines(ctx, sunX, sunR, cx, cy, pxRe, W, H, F, clock) {
  const lanes = 7
  const spread = Math.min(H * 0.42, 190)
  for (let i = 0; i < lanes; i++) {
    const t = lanes === 1 ? 0.5 : i / (lanes - 1)
    const y0 = cy + (t - 0.5) * 2 * spread
    const bend = t - 0.5
    const pts = []
    const steps = 46
    for (let s = 0; s <= steps; s++) {
      const u = s / steps
      const x = sunX + sunR + u * (W - sunX - sunR - 10)
      const distToNose = x - (cx - F.mp.r0 * pxRe)
      let y = y0
      if (distToNose > -40) {
        const push = Math.max(0, 1 - Math.abs(distToNose) / 220)
        y = y0 + bend * push * 130
      }
      pts.push([x, y])
    }
    const grad = ctx.createLinearGradient(sunX, cy, W, cy)
    grad.addColorStop(0, 'rgba(255,180,84,0.55)')
    grad.addColorStop(0.55, 'rgba(255,150,80,0.30)')
    grad.addColorStop(1, 'rgba(255,150,80,0.05)')
    ctx.save()
    ctx.strokeStyle = grad
    ctx.lineWidth = 1
    ctx.setLineDash([10, 9])
    ctx.lineDashOffset = -clock * 40
    ctx.beginPath()
    pts.forEach((p, idx) => (idx ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])))
    ctx.stroke()
    ctx.restore()
  }
}

function drawDipoleFieldLines(ctx, cx, cy, pxRe, aeN) {
  const loops = [1.6, 2.3, 3.1, 4.0]
  ctx.save()
  ctx.shadowColor = 'rgba(79,216,255,0.55)'
  ctx.shadowBlur = 6
  loops.forEach((k, i) => {
    const rx = pxRe * k * 0.62, ry = pxRe * k
    ctx.strokeStyle = `rgba(120,190,255,${0.22 + 0.05 * aeN - i * 0.03})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.ellipse(cx, cy, Math.max(2, rx), Math.max(2, ry), Math.PI / 2, 0, 2 * Math.PI)
    ctx.stroke()
  })
  ctx.restore()
}

function drawEarth(ctx, cx, cy, r, sunX) {
  const lit = sunX < cx ? -1 : 1   // -1: sun to the left → left side lit

  // Atmosphere halo
  const rim = ctx.createRadialGradient(cx, cy, r * 0.85, cx, cy, r * 1.5)
  rim.addColorStop(0, 'rgba(90,170,255,0.0)')
  rim.addColorStop(0.75, 'rgba(110,185,255,0.22)')
  rim.addColorStop(1, 'rgba(90,170,255,0)')
  ctx.fillStyle = rim
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.5, 0, 2 * Math.PI); ctx.fill()

  // Ocean sphere, lit from the sunward side
  const sphere = ctx.createRadialGradient(cx + lit * r * 0.5, cy - r * 0.3, r * 0.1, cx, cy, r * 1.05)
  sphere.addColorStop(0, '#d6efff')
  sphere.addColorStop(0.3, '#5aa7ff')
  sphere.addColorStop(0.65, '#1d55b0')
  sphere.addColorStop(1, '#0a1c46')
  ctx.save()
  ctx.shadowColor = 'rgba(79,216,255,0.45)'
  ctx.shadowBlur = 12
  ctx.fillStyle = sphere
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.clip()

  // Landmasses
  ctx.fillStyle = 'rgba(96,178,110,0.65)'
  for (const p of EARTH_SPECKLE) {
    ctx.beginPath()
    ctx.ellipse(cx + Math.cos(p.a) * p.d * r * 0.9, cy + Math.sin(p.a) * p.d * r * 0.9,
      r * p.rw, r * p.rh, p.a, 0, 2 * Math.PI)
    ctx.fill()
  }

  // Polar caps
  ctx.fillStyle = 'rgba(235,245,255,0.55)'
  ctx.beginPath(); ctx.ellipse(cx, cy - r * 0.86, r * 0.34, r * 0.14, 0, 0, 2 * Math.PI); ctx.fill()
  ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.88, r * 0.30, r * 0.12, 0, 0, 2 * Math.PI); ctx.fill()

  // Cloud streaks
  ctx.fillStyle = 'rgba(255,255,255,0.16)'
  for (let i = 0; i < 5; i++) {
    const yOff = (hash1(i + 3) - 0.5) * 1.5 * r
    ctx.beginPath()
    ctx.ellipse(cx + (hash1(i + 11) - 0.5) * r, cy + yOff, r * (0.4 + 0.3 * hash1(i)), r * 0.08, hash1(i) * 0.6 - 0.3, 0, 2 * Math.PI)
    ctx.fill()
  }

  // Night side — dark terminator on the anti-sunward half
  const night = ctx.createLinearGradient(cx + lit * r, cy, cx - lit * r, cy)
  night.addColorStop(0, 'rgba(3,8,22,0)')
  night.addColorStop(0.52, 'rgba(3,8,22,0.05)')
  night.addColorStop(0.75, 'rgba(3,8,22,0.55)')
  night.addColorStop(1, 'rgba(3,8,22,0.85)')
  ctx.fillStyle = night
  ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r)

  ctx.restore()

  // Thin bright atmosphere arc on the lit rim
  ctx.strokeStyle = 'rgba(170,225,255,0.5)'
  ctx.lineWidth = Math.max(1, r * 0.05)
  ctx.beginPath()
  const mid = lit < 0 ? Math.PI : 0
  ctx.arc(cx, cy, r * 1.01, mid - 0.85, mid + 0.85)
  ctx.stroke()

  ctx.fillStyle = COL.dim
  ctx.fillText('Earth', cx - 14, cy + r + 16)
}

function drawShockRings(ctx, cx, cy, rings) {
  for (const s of rings) {
    const col = LEVEL_COLOR[s.lv] ?? COL.fast
    const a = Math.max(0, s.alpha)
    ctx.save()
    ctx.globalAlpha = a
    ctx.strokeStyle = col
    ctx.lineWidth = 1.6
    ctx.shadowColor = col
    ctx.shadowBlur = 14
    ctx.beginPath(); ctx.arc(cx, cy, s.r, 0, 2 * Math.PI); ctx.stroke()
    ctx.globalAlpha = a * 0.4
    ctx.lineWidth = 3.5
    ctx.beginPath(); ctx.arc(cx, cy, s.r * 0.94, 0, 2 * Math.PI); ctx.stroke()
    ctx.restore()
  }
}

function legendChip(ctx, x, y, col, label) {
  ctx.save()
  ctx.shadowColor = col; ctx.shadowBlur = 6
  ctx.fillStyle = col
  ctx.beginPath(); ctx.arc(x + 4, y - 4, 4, 0, 2 * Math.PI); ctx.fill()
  ctx.restore()
  ctx.fillStyle = COL.dim
  ctx.fillText(label, x + 13, y)
}
