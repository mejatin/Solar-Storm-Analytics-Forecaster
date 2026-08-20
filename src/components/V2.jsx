import { useRef, useEffect, useState, useMemo } from 'react'
import * as d3 from 'd3'
import FullscreenFrame from './FullscreenFrame'
import FullscreenButton from './FullscreenButton'

// Marginal histograms: density along the top, speed along the side
const TOP_HIST_H = 54
const RIGHT_HIST_W = 54
const HIST_GAP = 6
const OUTER_PAD = 16

const MARGIN = { top: OUTER_PAD + TOP_HIST_H + HIST_GAP, right: OUTER_PAD + RIGHT_HIST_W + HIST_GAP, bottom: 40, left: 60 }

// Bz uses a diverging (signed) scale; |B| and Kp use sequential viridis.
const CHANNELS = [
  { key: 'imf_mag_scalar_nT', short: '|B|', label: '|B| (nT)', kind: 'seq' },
  { key: 'bz_gsm_nT',         short: 'Bz',  label: 'Bz (nT)',  kind: 'div' },
  { key: 'kp',                short: 'Kp',  label: 'Kp',       kind: 'seq' },
]

// /api/data and /api/orbital/storms use the same instants but different
// timezone suffixes — compare as plain strings, not via new Date().
const stripZ = s => (s.endsWith('Z') ? s.slice(0, -1) : s)

export default function V2({ data, loading, selectedPoints, onSelectPoints, selectedStorm, playhead, isFullscreen, onToggleFullscreen }) {
  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  // Playback cursor, updated without a full redraw
  const playRef = useRef(null)

  const [channel, setChannel] = useState('bz_gsm_nT')
  const [emptyData, setEmptyData] = useState(false)

  // Summary stats for the lassoed points, shown as a small card
  const selStats = useMemo(() => {
    if (!selectedPoints?.length || !data?.length) return null
    const sel = new Set(selectedPoints)
    const rows = data.filter(d => sel.has(d.datetime))
    if (!rows.length) return null
    const nums = k => rows.map(r => r[k]).filter(v => v != null)
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
    const bz = nums('bz_gsm_nT')
    const times = rows.map(r => r.datetime).sort()
    return {
      n: rows.length,
      speed: mean(nums('flow_speed_kms')),
      density: mean(nums('proton_density_ncc')),
      bzMean: mean(bz),
      bzMin: bz.length ? Math.min(...bz) : null,
      kp: mean(nums('kp')),
      stormPct: Math.round((100 * rows.filter(r => r.storm_flag).length) / rows.length),
      t0: times[0],
      t1: times[times.length - 1],
    }
  }, [data, selectedPoints])

  const [sizeTick, setSizeTick] = useState(0)
  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(() => setSizeTick(t => t + 1))
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!data?.length || !wrapRef.current) return

    const totalWidth  = wrapRef.current.clientWidth
    const totalHeight = wrapRef.current.clientHeight || 450
    const width  = totalWidth - MARGIN.left - MARGIN.right
    const height = totalHeight - MARGIN.top - MARGIN.bottom

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    d3.select(wrapRef.current).selectAll('div').remove()
    svg.attr('width', totalWidth).attr('height', totalHeight)

    const defs = svg.append('defs')
    defs.append('clipPath').attr('id', 'scatterClip')
      .append('rect').attr('width', width).attr('height', height)

    const plot = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`)
    const gridGroup   = plot.append('g')
    const axisGroup   = plot.append('g')
    const pointsGroup = plot.append('g').attr('clip-path', 'url(#scatterClip)')
    const cursorGroup = plot.append('g').attr('clip-path', 'url(#scatterClip)')
    const lassoGroup  = plot.append('g')

    // Data: density (x, log) vs speed (y, linear)
    const parsed = data.filter(d =>
      d.flow_speed_kms != null && d.proton_density_ncc != null && d.proton_density_ncc > 0
    ).map(d => ({ ...d, t: new Date(d.datetime) }))
    setEmptyData(parsed.length === 0)

    const densityExt = d3.extent(parsed, d => d.proton_density_ncc)
    const x = d3.scaleLog()
      .domain([Math.max(0.05, densityExt[0] ?? 0.1), Math.max(1, densityExt[1] ?? 50)])
      .range([0, width]).nice()

    const speedExt = d3.extent(parsed, d => d.flow_speed_kms)
    const y = d3.scaleLinear()
      .domain([Math.max(150, (speedExt[0] ?? 250) - 30), (speedExt[1] ?? 900) + 30])
      .range([height, 0]).nice()

    // Marginal histograms: density binned in log-space, speed in linear space
    const [dLo, dHi] = x.domain()
    const logLo = Math.log10(dLo), logHi = Math.log10(dHi)
    const nBinsX = 22
    const densityThresholds = d3.range(nBinsX + 1).map(i => Math.pow(10, logLo + (i * (logHi - logLo)) / nBinsX))
    const densityBins = d3.bin().domain(x.domain()).thresholds(densityThresholds)(parsed.map(d => d.proton_density_ncc))
    const densityCount = d3.scaleLinear().domain([0, d3.max(densityBins, b => b.length) || 1]).range([TOP_HIST_H, 0])

    const speedBins = d3.bin().domain(y.domain()).thresholds(y.ticks(20))(parsed.map(d => d.flow_speed_kms))
    const speedCount = d3.scaleLinear().domain([0, d3.max(speedBins, b => b.length) || 1]).range([0, RIGHT_HIST_W])

    const topHistG = svg.append('g').attr('transform', `translate(${MARGIN.left},${OUTER_PAD})`)
    topHistG.append('line')
      .attr('x1', 0).attr('x2', width).attr('y1', TOP_HIST_H).attr('y2', TOP_HIST_H)
      .attr('stroke', '#1E2330')
    topHistG.selectAll('rect').data(densityBins.filter(b => b.x1 > b.x0)).join('rect')
      .attr('x', b => x(b.x0) + 1)
      .attr('width', b => Math.max(0, x(b.x1) - x(b.x0) - 1))
      .attr('y', b => densityCount(b.length))
      .attr('height', b => TOP_HIST_H - densityCount(b.length))
      .attr('fill', '#60a5fa').attr('fill-opacity', 0.6)

    const rightHistG = svg.append('g').attr('transform', `translate(${MARGIN.left + width + HIST_GAP},${MARGIN.top})`)
    rightHistG.append('line')
      .attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', height)
      .attr('stroke', '#1E2330')
    rightHistG.selectAll('rect').data(speedBins.filter(b => b.x1 > b.x0)).join('rect')
      .attr('y', b => y(b.x1) + 1)
      .attr('height', b => Math.max(0, y(b.x0) - y(b.x1) - 1))
      .attr('x', 0)
      .attr('width', b => speedCount(b.length))
      .attr('fill', '#4ade80').attr('fill-opacity', 0.6)

    // Grid + axes
    gridGroup.append('g')
      .call(d3.axisLeft(y).tickSize(-width).tickFormat(''))
      .call(g => g.select('.domain').remove())
      .call(g => g.selectAll('.tick line').attr('stroke', '#1E2330').attr('stroke-opacity', 0.45))

    gridGroup.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(6, '~g').tickSize(-height).tickFormat(''))
      .call(g => g.select('.domain').remove())
      .call(g => g.selectAll('.tick line').attr('stroke', '#1E2330').attr('stroke-opacity', 0.45))

    axisGroup.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(6, '~g'))
      .call(g => g.selectAll('text').attr('fill', '#7C8496').attr('font-family', "'JetBrains Mono', monospace"))
      .call(g => g.selectAll('line,path').attr('stroke', '#252B3A'))

    axisGroup.append('g')
      .call(d3.axisLeft(y).ticks(6))
      .call(g => g.selectAll('text').attr('fill', '#7C8496').attr('font-family', "'JetBrains Mono', monospace"))
      .call(g => g.selectAll('line,path').attr('stroke', '#252B3A'))

    // Color scale for the active channel
    const ch = CHANNELS.find(c => c.key === channel)
    let colorScale
    if (ch.kind === 'div') {
      const ext = d3.extent(parsed, d => d[ch.key])
      const maxAbs = Math.max(Math.abs(ext[0] || 0), Math.abs(ext[1] || 0)) || 15
      // Negative Bz (southward) -> red, positive (northward) -> blue
      colorScale = d3.scaleSequential().domain([-maxAbs, maxAbs]).interpolator(d3.interpolateRdBu)
    } else if (ch.key === 'kp') {
      colorScale = d3.scaleSequential().domain([0, 9]).interpolator(d3.interpolateViridis)
    } else {
      const ext = d3.extent(parsed, d => d[ch.key])
      colorScale = d3.scaleSequential().domain([ext[0] ?? 0, ext[1] ?? 1]).interpolator(d3.interpolateViridis)
    }

    // Tooltip
    const tooltip = d3.select(wrapRef.current).append('div')
      .style('position', 'absolute')
      .style('pointer-events', 'none')
      .style('background', '#12151C')
      .style('border', '1px solid #252B3A')
      .style('border-radius', '6px')
      .style('padding', '8px')
      .style('font-family', "'JetBrains Mono', monospace")
      .style('font-size', '11px')
      .style('color', '#E7EAF0')
      .style('opacity', 0)

    // Scatter
    const selSet = new Set(selectedPoints ?? [])
    const hasSel = selSet.size > 0

    // Selected-storm hours get a green ring; lasso selection (white) wins if both apply.
    const storm0 = selectedStorm ? stripZ(selectedStorm.start) : null
    const storm1 = selectedStorm ? stripZ(selectedStorm.end) : null
    const inStorm = d => storm0 != null && storm0 <= d.datetime && d.datetime <= storm1
    const strokeFor = d => {
      if (hasSel && selSet.has(d.datetime)) return '#E7EAF0'
      if (inStorm(d)) return '#5CF2A0'
      return 'none'
    }

    const dots = pointsGroup.selectAll('circle').data(parsed).enter().append('circle')
      .attr('cx', d => x(d.proton_density_ncc))
      .attr('cy', d => y(d.flow_speed_kms))
      .attr('r', 3.5)
      .attr('fill', d => d[ch.key] == null ? '#4B5265' : colorScale(d[ch.key]))
      .attr('fill-opacity', d => hasSel ? (selSet.has(d.datetime) ? 0.95 : 0.2) : 0.75)
      .attr('stroke', strokeFor)
      .attr('stroke-width', d => (hasSel && selSet.has(d.datetime)) ? 1.5 : 1)

    function positionTooltip(event) {
      const wrapEl = wrapRef.current
      const node = tooltip.node()
      const tw = node.offsetWidth, th = node.offsetHeight
      let left = event.offsetX + 15
      let top = event.offsetY - th - 12
      if (left + tw > wrapEl.clientWidth) left = event.offsetX - tw - 15
      if (left < 4) left = 4
      if (top < 4) top = event.offsetY + 15
      if (top + th > wrapEl.clientHeight) top = wrapEl.clientHeight - th - 4
      tooltip.style('left', `${left}px`).style('top', `${top}px`)
    }

    // "Now" cursor: glowing ring + center dot on the current hour's point
    const byTime = new Map(parsed.map(d => [d.datetime, [x(d.proton_density_ncc), y(d.flow_speed_kms)]]))
    const playG = cursorGroup.append('g').style('display', 'none')
    playG.append('circle')
      .attr('r', 13).attr('fill', 'none')
      .attr('stroke', '#E8A33D').attr('stroke-width', 6).attr('stroke-opacity', 0.25)
    playG.append('circle')
      .attr('r', 9).attr('fill', 'none')
      .attr('stroke', '#E8A33D').attr('stroke-width', 2.5)
    playG.append('circle')
      .attr('r', 2.5).attr('fill', '#E8A33D')
    // "Now" badge — stays visible even on a data-gap hour with no dot to ring
    const playBadge = svg.append('text')
      .attr('x', MARGIN.left + 8).attr('y', MARGIN.top + 16)
      .attr('fill', '#E8A33D').attr('font-size', 10).attr('font-weight', 600)
      .attr('font-family', "'JetBrains Mono', monospace")
    playRef.current = { byTime, playG, playBadge }

    dots.on('mouseover', function (event, d) {
      d3.select(this).transition().duration(100).attr('r', 6).attr('stroke', '#E7EAF0').attr('stroke-width', 1.5)
      tooltip.style('opacity', 1).html(`
        <b>${d.t.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}</b>
        <hr style="border-color:#252B3A">
        Speed : ${d.flow_speed_kms.toFixed(1)} km/s<br>
        Density : ${d.proton_density_ncc.toFixed(2)} n/cc<br>
        ${ch.label} : ${d[ch.key] != null ? d[ch.key].toFixed(2) : '--'}<br>
        Kp : ${d.kp ?? '--'}
      `)
      positionTooltip(event)
    })
      .on('mousemove', (event) => positionTooltip(event))
      .on('mouseout', function () {
        d3.select(this).transition().duration(100).attr('r', 3.5)
          .attr('stroke', strokeFor)
          .attr('stroke-width', d => (hasSel && selSet.has(d.datetime)) ? 1.5 : 1)
        tooltip.style('opacity', 0)
      })

    // Axis labels
    svg.append('text')
      .attr('x', MARGIN.left + width / 2).attr('y', totalHeight - 8)
      .attr('text-anchor', 'middle').attr('fill', '#7C8496').attr('font-size', 11).attr('font-family', "'JetBrains Mono', monospace")
      .text('Proton Density (n/cc, log scale)')

    svg.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -(MARGIN.top + height / 2)).attr('y', 16)
      .attr('text-anchor', 'middle').attr('fill', '#7C8496').attr('font-size', 11).attr('font-family', "'JetBrains Mono', monospace")
      .text('Solar Wind Speed (km/s)')

    // Freehand lasso — one hit-test at mouseup, not per frame
    let lassoPts = null
    let lassoPath = null

    svg.on('pointerdown', (event) => {
      if (event.button !== 0) return
      svg.node().setPointerCapture(event.pointerId)
      const [mx, my] = d3.pointer(event, plot.node())
      lassoPts = [[mx, my]]
      lassoPath = lassoGroup.append('path')
        .attr('fill', '#8b5cf6').attr('fill-opacity', 0.06)
        .attr('stroke', '#8b5cf6').attr('stroke-width', 1).attr('stroke-dasharray', '3,3')
      event.preventDefault()
    })

    svg.on('pointermove', (event) => {
      if (!lassoPts) return
      const last = lassoPts[lassoPts.length - 1]
      const [mx, my] = d3.pointer(event, plot.node())
      if (Math.hypot(mx - last[0], my - last[1]) < 3) return   // cap vertex density
      if (lassoPts.length >= 150) return                       // cap total vertices
      lassoPts.push([mx, my])
      lassoPath.attr('d', 'M' + lassoPts.map(p => p.join(',')).join('L'))
    })

    svg.on('pointerup pointercancel', () => {
      if (!lassoPts) return
      const pts = lassoPts
      lassoPts = null
      lassoPath?.remove()
      lassoPath = null

      const [minX, maxX] = d3.extent(pts, p => p[0])
      const [minY, maxY] = d3.extent(pts, p => p[1])
      const tooSmall = pts.length < 5 || (maxX - minX) * (maxY - minY) < 60
      if (tooSmall) {
        // A plain click, not a lasso: if it landed on (or next to) a dot,
        // select just that point; clicking empty space clears the selection.
        const [px, py] = pts[0]
        let best = null, bestD = 8
        for (const d of parsed) {
          const dist = Math.hypot(x(d.proton_density_ncc) - px, y(d.flow_speed_kms) - py)
          if (dist < bestD) { bestD = dist; best = d }
        }
        if (onSelectPoints) onSelectPoints(best ? [best.datetime] : [])
        return
      }
      const inside = parsed
        .filter(d => d3.polygonContains(pts, [x(d.proton_density_ncc), y(d.flow_speed_kms)]))
        .map(d => d.datetime)
      if (onSelectPoints) onSelectPoints(inside)
    })

  }, [data, sizeTick, channel, selectedPoints, onSelectPoints, selectedStorm])

  // Move the "now" ring without re-running the draw effect
  useEffect(() => {
    const r = playRef.current
    if (!r) return
    let pos = null
    if (playhead) {
      pos = r.byTime.get(playhead)
      if (!pos) {
        const day = playhead.slice(0, 10)
        const hour = Number(playhead.slice(11, 13))
        for (let d = 1; d <= 3 && !pos; d++) {
          for (const h of [hour - d, hour + d]) {
            if (h < 0 || h > 23) continue
            pos = r.byTime.get(`${day}T${String(h).padStart(2, '0')}:00:00`)
            if (pos) break
          }
        }
        if (!pos) pos = r.byTime.get(day + 'T00:00:00')
      }
    }
    if (playhead) {
      const label = d3.timeFormat('%d %b %H:00')(new Date(playhead))
      r.playBadge.text(pos ? `now: ${label}` : `now: ${label} — no sample this hour (data gap)`)
    } else {
      r.playBadge.text('')
    }
    if (!pos) { r.playG.style('display', 'none'); return }
    r.playG.style('display', null).attr('transform', `translate(${pos[0]},${pos[1]})`)
  }, [playhead, sizeTick, data])

  return (
    <FullscreenFrame isFullscreen={isFullscreen} onClose={() => onToggleFullscreen(false)}>
      <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-space-hairline bg-space-panel-2/60">
        <span className="text-sm font-semibold text-space-text truncate" title="Density vs speed · drag a lasso to select points · color channel toggle on the right">
          Phase Space
        </span>

        <div className="ml-auto flex items-center gap-2 font-mono">
          <div className="flex items-center rounded-md border border-space-hairline overflow-hidden">
            {CHANNELS.map(c => (
              <button
                key={c.key}
                onClick={() => setChannel(c.key)}
                aria-label={`Color points by ${c.label}`}
                title={`Color points by ${c.label}`}
                className={`px-2 py-0.5 text-[10px] transition-colors ${
                  channel === c.key ? 'bg-space-violet text-white' : 'bg-space-panel-2 text-space-dim hover:text-space-text'
                }`}
              >
                {c.short}
              </button>
            ))}
          </div>

          <FullscreenButton active={isFullscreen} onClick={() => onToggleFullscreen(!isFullscreen)} />
        </div>
      </div>

      <div className="relative w-full flex-1 min-h-0 overflow-hidden">
        <div ref={wrapRef} className="absolute inset-0" style={{ cursor: 'crosshair' }}>
          {!data?.length
            ? <div className="flex items-center justify-center h-full text-space-faint text-sm font-mono">
                {loading ? 'Loading…' : 'No records in this date range — adjust Date Range above.'}
              </div>
            : <svg ref={svgRef} style={{ display: 'block' }} />
          }
        </div>
        {data?.length > 0 && emptyData && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-space-faint text-sm font-mono text-center px-6">
              No data matches the current filters in this range.
            </span>
          </div>
        )}
        {selStats && (
          <div className="absolute top-24 left-20 pointer-events-none bg-space-panel/95 border border-space-violet/60 rounded-lg px-3 py-2 font-mono text-[10px] text-space-dim leading-relaxed shadow-lg">
            <div className="text-violet-300 font-semibold mb-0.5">◈ {selStats.n} points selected</div>
            <div>Speed mean <b className="text-space-text">{selStats.speed != null ? selStats.speed.toFixed(0) : '—'}</b> km/s</div>
            <div>Density mean <b className="text-space-text">{selStats.density != null ? selStats.density.toFixed(1) : '—'}</b> n/cc</div>
            <div>Bz mean <b className="text-space-text">{selStats.bzMean != null ? selStats.bzMean.toFixed(1) : '—'}</b> · min <b className="text-space-text">{selStats.bzMin != null ? selStats.bzMin.toFixed(1) : '—'}</b> nT</div>
            <div>Kp mean <b className="text-space-text">{selStats.kp != null ? selStats.kp.toFixed(1) : '—'}</b> · storm hours <b className="text-space-text">{selStats.stormPct}%</b></div>
            <div className="text-space-faint">{selStats.t0.slice(0, 16).replace('T', ' ')} → {selStats.t1.slice(0, 16).replace('T', ' ')}</div>
          </div>
        )}
      </div>
    </FullscreenFrame>
  )
}
