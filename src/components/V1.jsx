import { useRef, useEffect, useMemo, useState } from 'react'
import * as d3 from 'd3'
import { useStormDetail } from '../hooks/useStormDetail'
import FullscreenFrame from './FullscreenFrame'
import FullscreenButton from './FullscreenButton'

// Two stacked mini-charts, each showing a user-selectable parameter.
// Defaults to Speed / Dst.
const PARAM_OPTIONS = [
  { key: 'flow_speed_kms',     label: 'Speed',   unit: 'km/s', color: '#4ade80' },
  { key: 'proton_density_ncc', label: 'Density', unit: 'n/cc', color: '#22d3ee' },
  { key: 'bz_gsm_nT',          label: 'Bz',      unit: 'nT',   color: '#f87171', zeroline: true },
  { key: 'pdyn_computed_nPa',  label: 'Pdyn',    unit: 'nPa',  color: '#fbbf24' },
  { key: 'dst_omni',           label: 'Dst',     unit: 'nT',   color: '#38bdf8', zeroline: true },
  { key: 'kp',                 label: 'Kp',      unit: '',     color: '#a3e635', curve: d3.curveStepAfter },
  { key: 'ae_index_nT',        label: 'AE',      unit: 'nT',   color: '#e879f9' },
  { key: 'proton_temp_K',      label: 'Temp',    unit: 'K',    color: '#94a3b8' },
  { key: 'imf_mag_scalar_nT',  label: '|B|',     unit: 'nT',   color: '#facc15' },
]
const paramByKey = key => PARAM_OPTIONS.find(p => p.key === key) ?? PARAM_OPTIONS[0]

const MARGIN = { top: 10, right: 20, bottom: 36, left: 60 }
const ROW_GAP = 30

export default function V1({ data, loading, setDraftStart, setDraftEnd, selectedPoints, selectedStorm, playhead, stormCatalog, isFullscreen, onToggleFullscreen }) {
  const svgRef  = useRef(null)
  const wrapRef = useRef(null)
  // Playback cursor, updated without a full redraw
  const playRef = useRef(null)

  const [sizeTick, setSizeTick] = useState(0)
  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(() => setSizeTick(t => t + 1))
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  const [emptyAll, setEmptyAll] = useState(false)

  // Top/Bottom row parameter pickers
  const [rowKeys, setRowKeys] = useState(['flow_speed_kms', 'dst_omni'])
  const ROWS = rowKeys.map(paramByKey)
  function setRowKey(i, key) {
    setRowKeys(rk => rk.map((k, idx) => (idx === i ? key : k)))
  }

  // Compare-vs storm: overlaid aligned to the main storm's shock time.
  const [cmpId, setCmpId] = useState('')
  const compareStorm = useMemo(
    () => (stormCatalog || []).find(s => String(s.id) === cmpId) || null,
    [stormCatalog, cmpId],
  )
  const sortedCatalog = useMemo(() => {
    const rank = { severe: 0, intense: 1, moderate: 2 }
    return [...(stormCatalog || [])].sort((a, b) =>
      (rank[a.intensity] ?? 3) - (rank[b.intensity] ?? 3) || a.peak_dst_nT - b.peak_dst_nT)
  }, [stormCatalog])
  // Only fetch shock alignment once a comparison is picked.
  const { data: mainAlignData } = useStormDetail(cmpId ? selectedStorm : null)
  const { data: cmpAlignData } = useStormDetail(cmpId ? compareStorm : null)

  useEffect(() => {
    if (!data?.length || !svgRef.current || !wrapRef.current) return

    const totalW = wrapRef.current.clientWidth
    const totalH = wrapRef.current.clientHeight || 600
    const W = totalW - MARGIN.left - MARGIN.right
    const availH = totalH - MARGIN.top - MARGIN.bottom
    const CH_H = Math.max(40, (availH - (ROWS.length - 1) * ROW_GAP) / ROWS.length)
    const H = ROWS.length * (CH_H + ROW_GAP) - ROW_GAP

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    svg.attr('width', totalW).attr('height', totalH)

    const parsed = data
      .filter(d => d.datetime)
      .map(d => ({ ...d, t: new Date(d.datetime) }))

    const bisectDate = d3.bisector(d => d.t).center

    // Anchor point for the comparison overlay: the main storm's shock time,
    // or the comparison storm's own shock time if no main storm is selected.
    const selfAnchor = cmpAlignData?.series.find(r => r.i === 0)?.t ?? null
    const mainAnchor = (selectedStorm ? mainAlignData?.series.find(r => r.i === 0)?.t : selfAnchor) ?? null

    // The main chart's own axis/zoom/data never change based on comparison
    // state — picking or clearing "Compare vs" only adds/removes the dashed
    // overlay line, projected onto whatever window is already showing.
    const xScale = d3.scaleTime()
      .domain(d3.extent(parsed, d => d.t))
      .range([0, W])

    // Contiguous storm_flag intervals, for shading
    const stormIntervals = []
    let inStorm = false, stormStart = null
    parsed.forEach((d, i) => {
      if (d.storm_flag && !inStorm) { inStorm = true; stormStart = d.t }
      if (!d.storm_flag && inStorm) {
        stormIntervals.push([stormStart, parsed[i - 1].t])
        inStorm = false
      }
    })
    if (inStorm) stormIntervals.push([stormStart, parsed[parsed.length - 1].t])

    const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`)

    const selSet = new Set(selectedPoints ?? [])

    const [domD0, domD1] = xScale.domain()

    let totalNonNull = 0
    const rowRenders = []

    ROWS.forEach((row, ri) => {
      const rowTop = ri * (CH_H + ROW_GAP)
      const rg = g.append('g').attr('transform', `translate(0,${rowTop})`)

      // Row background
      rg.append('rect')
        .attr('width', W).attr('height', CH_H)
        .attr('fill', '#0E1117').attr('rx', 4)
        .attr('stroke', '#1E2330').attr('stroke-width', 1)

      // Storm shading (red wash, low opacity)
      stormIntervals.forEach(([s, e]) => {
        rg.append('rect')
          .attr('x', xScale(s)).attr('y', 0)
          .attr('width', Math.max(1, xScale(e) - xScale(s))).attr('height', CH_H)
          .attr('fill', 'rgba(255,91,84,0.10)')
      })

      // Lasso-selection ticks (violet), per row.
      if (selSet.size) {
        parsed.forEach(d => {
          if (!selSet.has(d.datetime)) return
          const px = xScale(d.t)
          rg.append('line')
            .attr('x1', px).attr('x2', px)
            .attr('y1', 0).attr('y2', CH_H)
            .attr('stroke', '#8b5cf6').attr('stroke-width', 1).attr('stroke-opacity', 0.5)
        })
      }

      // The solid line is always the real loaded data for the current
      // window — comparison never swaps it out.
      const vals = parsed.map(d => d[row.key]).filter(v => v != null)
      totalNonNull += vals.length
      // Comparison values share this row's y-domain so magnitudes stay comparable.
      const cmpVals = cmpAlignData ? cmpAlignData.series.map(r => r[row.key]).filter(v => v != null) : []
      const allVals = vals.concat(cmpVals)
      const [yMin, yMax] = allVals.length ? d3.extent(allVals) : [0, 1]
      const pad = (yMax - yMin) * 0.08 || 1
      const yScale = d3.scaleLinear().domain([yMin - pad, yMax + pad]).range([CH_H, 0])

      // Zero line (Bz/Dst only)
      if (row.zeroline && yMin < 0 && yMax > 0) {
        const y0 = yScale(0)
        rg.append('line')
          .attr('x1', 0).attr('x2', W).attr('y1', y0).attr('y2', y0)
          .attr('stroke', '#252B3A').attr('stroke-dasharray', '4,3').attr('stroke-width', 1)
      }

      // Tick values that won't crowd this row's own top/bottom edge
      const EDGE_MARGIN = 6
      const rawTicks = yScale.ticks(CH_H < 90 ? 3 : 5)
      const yTicks = rawTicks.filter(v => {
        const py = yScale(v)
        return py > EDGE_MARGIN && py < CH_H - EDGE_MARGIN
      })
      if (!yTicks.length) yTicks.push(...rawTicks)

      // Comparison-storm overlay (dashed, drawn under the main line)
      if (cmpAlignData && mainAnchor) {
        const projT = d => new Date(mainAnchor.getTime() + d.i * 3600000)
        const cmpLine = d3.line()
          .defined(d => d[row.key] != null && projT(d) >= domD0 && projT(d) <= domD1)
          .x(d => xScale(projT(d)))
          .y(d => yScale(d[row.key]))
          .curve(row.curve || d3.curveLinear)

        rg.append('path')
          .datum(cmpAlignData.series)
          .attr('fill', 'none')
          .attr('stroke', '#94a3b8')
          .attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '6 4')
          .attr('d', cmpLine)
      }

      // Main line — gaps stay gaps
      const line = d3.line()
        .defined(d => d[row.key] != null)
        .x(d => xScale(d.t))
        .y(d => yScale(d[row.key]))
        .curve(row.curve || d3.curveLinear)

      rg.append('path')
        .datum(parsed)
        .attr('fill', 'none')
        .attr('stroke', row.color)
        .attr('stroke-width', 1.5)
        .attr('d', line)

      // Y axis ticks, compact SI-prefixed labels (e.g. "200k")
      rg.append('g')
        .call(d3.axisLeft(yScale).tickValues(yTicks).tickSize(4).tickFormat(d3.format('~s')))
        .call(ax => ax.select('.domain').remove())
        .call(ax => ax.selectAll('.tick line').attr('stroke', '#252B3A'))
        .call(ax => ax.selectAll('.tick text')
          .attr('fill', '#7C8496').attr('font-family', "'JetBrains Mono', monospace").attr('font-size', 9).attr('dx', -2))

      // Per-row empty state
      if (!vals.length) {
        rg.append('text')
          .attr('x', W / 2).attr('y', CH_H / 2)
          .attr('text-anchor', 'middle').attr('fill', '#4B5265').attr('font-size', 10).attr('font-family', "'JetBrains Mono', monospace")
          .text(`No ${row.label} data matches the current filters`)
      }

      const hoverCircle = rg.append('circle')
        .attr('r', 4)
        .attr('fill', row.color)
        .attr('stroke', '#E7EAF0')
        .attr('stroke-width', 1.2)
        .style('display', 'none')

      rowRenders.push({ key: row.key, yScale, hoverCircle })
    })

    setEmptyAll(totalNonNull === 0)

    // Shared X axis, drawn once below the whole stack
    svg.append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top + H})`)
      .call(d3.axisBottom(xScale).ticks(Math.max(3, Math.round(W / 110))))
      .call(ax => ax.select('.domain').attr('stroke', '#1E2330'))
      .call(ax => ax.selectAll('.tick line').attr('stroke', '#1E2330'))
      .call(ax => ax.selectAll('.tick text').attr('fill', '#7C8496').attr('font-family', "'JetBrains Mono', monospace").attr('font-size', 10))

    // Shared crosshair + tooltip + drag-to-set-range
    let selecting = false
    let startX = 0

    const selectionRect = svg.append('rect')
      .attr('display', 'none')
      .attr('fill', 'rgba(139,92,246,0.20)')
      .attr('stroke', '#8b5cf6')
      .attr('stroke-width', 2)

    const crosshair = g.append('line')
      .attr('y1', 0).attr('y2', H)
      .attr('stroke', '#4B5265').attr('stroke-width', 1)
      .style('display', 'none')

    // "Now" cursor (orange) — glow line + core line + time label
    const playG = g.append('g').style('display', 'none')
    playG.append('line')
      .attr('y1', 0).attr('y2', H)
      .attr('stroke', '#E8A33D').attr('stroke-width', 7).attr('stroke-opacity', 0.22)
    playG.append('line')
      .attr('y1', 0).attr('y2', H)
      .attr('stroke', '#E8A33D').attr('stroke-width', 2.5)
    const playLabelBg = playG.append('rect')
      .attr('y', -1).attr('height', 15).attr('rx', 3)
      .attr('fill', '#E8A33D')
    const playLabel = playG.append('text')
      .attr('y', 10.5)
      .attr('fill', '#0A0C10').attr('font-size', 10).attr('font-weight', 700)
      .attr('font-family', "'JetBrains Mono', monospace")
    playRef.current = { xScale, playG, playLabel, playLabelBg, W }

    // Remove any leftover tooltip from a previous render
    d3.select(wrapRef.current).selectAll('div.v1-tooltip').remove()
    const tooltip = d3.select(wrapRef.current)
      .append('div')
      .attr('class', 'v1-tooltip')
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

    svg.append('rect')
      .attr('x', MARGIN.left)
      .attr('y', MARGIN.top)
      .attr('width', W)
      .attr('height', H)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')

      .on('mousedown', function (event) {
        selecting = true
        startX = d3.pointer(event, this)[0]
        selectionRect
          .attr('display', null)
          .attr('x', startX).attr('y', MARGIN.top)
          .attr('width', 0).attr('height', H)
      })

      .on('mousemove', function (event) {
        const [mx] = d3.pointer(event, this)

        if (selecting) {
          selectionRect.attr('x', Math.min(startX, mx)).attr('width', Math.abs(mx - startX))
          return
        }

        const date = xScale.invert(mx - MARGIN.left)
        const d = parsed[bisectDate(parsed, date)]
        if (!d) return

        crosshair.style('display', null).attr('x1', xScale(d.t)).attr('x2', xScale(d.t))
        rowRenders.forEach(({ key, yScale, hoverCircle }) => {
          const v = d[key]
          if (v == null) hoverCircle.style('display', 'none')
          else hoverCircle.style('display', null).attr('cx', xScale(d.t)).attr('cy', yScale(v))
        })

        tooltip
          .style('opacity', 1)
          .html(`
            <div style="font-weight:600;margin-bottom:6px;">
              ${d.t.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}
            </div>
            <hr style="border-color:#252B3A;margin:4px 0"/>
            Speed : ${d.flow_speed_kms?.toFixed(1) ?? '--'} km/s<br/>
            Density : ${d.proton_density_ncc?.toFixed(2) ?? '--'} n/cc<br/>
            Bz : ${d.bz_gsm_nT?.toFixed(2) ?? '--'} nT<br/>
            Pdyn : ${d.pdyn_computed_nPa?.toFixed(2) ?? '--'} nPa<br/>
            Dst : ${d.dst_omni?.toFixed(0) ?? '--'} nT<br/>
            Temp : ${d.proton_temp_K != null ? Math.round(d.proton_temp_K).toLocaleString() : '--'} K<br/>
            Kp : ${d.kp ?? '--'}<br/>
            <b>Storm</b> : ${d.storm_flag ? '🔴 Yes' : '🟢 No'}
          `)

        // Clamp so the tooltip never gets cut off by the panel's own overflow-hidden
        const wrapEl = wrapRef.current
        const node = tooltip.node()
        const tw = node.offsetWidth, th = node.offsetHeight
        let left = event.offsetX + 18
        let top = event.offsetY - th - 16
        if (left + tw > wrapEl.clientWidth) left = event.offsetX - tw - 18
        if (left < 4) left = 4
        if (top < 4) top = event.offsetY + 16
        if (top + th > wrapEl.clientHeight) top = wrapEl.clientHeight - th - 4
        tooltip.style('left', `${left}px`).style('top', `${top}px`)
      })

      .on('mouseout', () => {
        crosshair.style('display', 'none')
        rowRenders.forEach(({ hoverCircle }) => hoverCircle.style('display', 'none'))
        tooltip.style('opacity', 0)
      })

    d3.select(window).on('mouseup.v1', () => {
      if (!selecting) return
      selecting = false

      const rx = +selectionRect.attr('x')
      const rw = +selectionRect.attr('width')

      if (rw > 5) {
        const startDate = xScale.invert(rx - MARGIN.left)
        const endDate = xScale.invert(rx + rw - MARGIN.left)
        setDraftStart(d3.timeFormat('%Y-%m-%d')(startDate))
        setDraftEnd(d3.timeFormat('%Y-%m-%d')(endDate))
      }

      selectionRect.attr('display', 'none')
    })

    return () => {
      d3.select(window).on('mouseup.v1', null)
    }

  }, [data, selectedPoints, selectedStorm, sizeTick, setDraftStart, setDraftEnd, rowKeys, mainAlignData, cmpAlignData])

  // Move the "dashboard now" cursor without re-running the draw effect.
  useEffect(() => {
    const r = playRef.current
    if (!r) return
    if (!playhead) { r.playG.style('display', 'none'); return }
    const t = new Date(playhead)
    const [d0, d1] = r.xScale.domain()
    if (t < d0 || t > d1) { r.playG.style('display', 'none'); return }
    const px = r.xScale(t)
    r.playG.style('display', null).attr('transform', `translate(${px},0)`)
    // Label sits to the right of the line, flipping to the left near the edge.
    const text = d3.timeFormat('%d %b %H:00')(t)
    r.playLabel.text(text)
    const tw = r.playLabel.node().getComputedTextLength()
    const flip = px + tw + 14 > r.W
    r.playLabel.attr('x', flip ? -(tw + 8) : 8)
    r.playLabelBg.attr('x', flip ? -(tw + 12) : 4).attr('width', tw + 8)
  }, [playhead, sizeTick, data])

  return (
    <FullscreenFrame isFullscreen={isFullscreen} onClose={() => onToggleFullscreen(false)}>
      {/* Panel header: row pickers, Compare-vs, color legend */}
      <div
        className="flex-none flex items-center gap-x-3 px-3 py-1.5 border-b border-space-hairline bg-space-panel-2/60"
        title="Drag to set Start/End · violet ticks = points lassoed in Phase Space · hover for all parameters"
      >
        <span className="flex-none text-sm font-semibold text-space-text">Time Series</span>

        <div className="ml-auto flex-none flex items-center gap-2 font-mono text-[10px]">
          {['Top', 'Bottom'].map((posLabel, i) => (
            <label key={posLabel} className="flex items-center gap-1 text-space-dim">
              {posLabel}
              <select
                value={rowKeys[i]}
                onChange={e => setRowKey(i, e.target.value)}
                style={{ color: paramByKey(rowKeys[i]).color }}
                className="h-5 bg-space-panel-2 border border-space-hairline rounded px-1.5 text-[10px] font-semibold"
              >
                {PARAM_OPTIONS.map(p => (
                  <option key={p.key} value={p.key} style={{ color: p.color, background: '#12151C' }}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className="flex-none h-4 w-px bg-space-hairline" />

        <div className="flex-none flex items-center gap-1.5 font-mono text-[10px]">
          <span className="text-space-dim whitespace-nowrap">Compare vs</span>
          <select
            value={cmpId}
            onChange={e => setCmpId(e.target.value)}
            title="Overlay another storm's curve — aligned to the main storm's shock if one is selected (⚠ jump control above), otherwise shown at its own real dates. The chart temporarily zooms to that comparison window while active."
            className="h-5 w-32 bg-space-panel-2 border border-space-hairline rounded px-1.5 text-space-dim text-[10px]"
          >
            <option value="">No comparison</option>
            {sortedCatalog.map(s => (
              <option key={s.id} value={s.id}>{s.start.slice(0, 10)} · {s.intensity} · Dst {Math.round(s.peak_dst_nT)} nT</option>
            ))}
          </select>
        </div>

        <span className="flex-none flex items-center gap-1 font-mono text-[9px] text-space-dim whitespace-nowrap">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'rgba(255,91,84,0.35)' }} />
          storm
        </span>

        <FullscreenButton active={isFullscreen} onClick={() => onToggleFullscreen(!isFullscreen)} />
      </div>

      {/* Chart area — no horizontal padding so clientWidth = coordinate space width */}
      <div ref={wrapRef} className="relative w-full flex-1 min-h-0 overflow-hidden">
        {!data?.length
          ? <div className="flex items-center justify-center h-full text-space-faint text-sm font-mono">
              {loading ? 'Loading…' : 'No records in this date range — adjust Date Range above.'}
            </div>
          : <>
              <svg ref={svgRef} style={{ display: 'block' }} />
              {emptyAll && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-space-faint text-sm font-mono text-center px-6">
                    No data matches the current filters in this range.
                  </span>
                </div>
              )}
            </>
        }
      </div>
    </FullscreenFrame>
  )
}
