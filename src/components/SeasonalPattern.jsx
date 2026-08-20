import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import FullscreenFrame from './FullscreenFrame'
import FullscreenButton from './FullscreenButton'

// Seasonal Pattern — the Russell-McPherron effect: mean geomagnetic activity
// by calendar month, as a radial bar chart (Jan at 12 o'clock, clockwise).
// Equinox months bulge out past solstice months. Follows the global Date Range.

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const METRICS = [
  { key: 'meanKp', short: 'Kp', label: 'Mean Kp index', unit: '', domain: [0, 4] },
  { key: 'meanAE', short: 'AE', label: 'Mean AE index', unit: ' nT', domain: [0, 260] },
  { key: 'meanElectricField', short: 'Ey', label: 'Mean electric field', unit: ' mV/m', domain: [-0.05, 0.12] },
]
const EQUINOX = new Set([3, 9])
const SOLSTICE = new Set([6, 12])
const EQUINOX_COLOR = '#5CF2A0'
const SOLSTICE_COLOR = '#E8A33D'

// Viridis gradient CSS for the legend swatch
const VIRIDIS_GRADIENT = `linear-gradient(to right, ${d3.range(0, 1.0001, 0.1).map(t => d3.interpolateViridis(t)).join(',')})`

export default function SeasonalPattern({ start, end, isFullscreen, onToggleFullscreen }) {
  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const [seasonal, setSeasonal] = useState(null)
  const [error, setError] = useState(null)
  const [metricKey, setMetricKey] = useState('meanKp')
  // Mirrors the chart's color scale domain, for the legend
  const [colorDomain, setColorDomain] = useState([0, 1])

  useEffect(() => {
    let cancelled = false
    setSeasonal(null)
    fetch(`/api/seasonal?start=${start}&end=${end}`)
      .then(r => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then(d => { if (!cancelled) setSeasonal(d) })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [start, end])

  const [sizeTick, setSizeTick] = useState(0)
  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(() => setSizeTick(t => t + 1))
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!seasonal || !wrapRef.current) return
    const metric = METRICS.find(m => m.key === metricKey)
    const W = wrapRef.current.clientWidth
    const H = wrapRef.current.clientHeight || 500
    const cx = W / 2, cy = H / 2

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    d3.select(wrapRef.current).selectAll('div.season-tooltip').remove()
    svg.attr('width', W).attr('height', H)
    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`)

    const R0 = 40
    const Rmax = Math.max(60, Math.min(W, H) / 2 - 46)
    const vals = seasonal.map(s => s[metric.key]).filter(v => v != null)
    const maxV = Math.max(metric.domain[1], d3.max(vals) ?? metric.domain[1])
    const minV = Math.min(metric.domain[0], d3.min(vals) ?? metric.domain[0])
    const rScale = d3.scaleLinear().domain([Math.min(0, minV), maxV]).range([0, Rmax - R0])
    const colorScale = d3.scaleSequential().domain([minV, maxV]).interpolator(d3.interpolateViridis)
    const meanV = d3.mean(vals)
    setColorDomain([minV, maxV])

    // Reference circle at the overall mean, so wedges above/below it read instantly
    if (meanV != null) {
      g.append('circle').attr('r', R0 + rScale(meanV)).attr('fill', 'none')
        .attr('stroke', '#4B5265').attr('stroke-width', 1).attr('stroke-dasharray', '3,3')
    }

    const angle = m => ((m - 1) / 12) * 2 * Math.PI
    const arc = d3.arc().innerRadius(R0).outerRadius(d => R0 + rScale(d.value))
      .startAngle(d => angle(d.month) + 0.02).endAngle(d => angle(d.month + 1) - 0.02)
      .cornerRadius(2)

    const tooltip = d3.select(wrapRef.current).append('div')
      .attr('class', 'season-tooltip')
      .style('position', 'absolute').style('pointer-events', 'none')
      .style('background', '#12151C').style('border', '1px solid #252B3A').style('border-radius', '6px')
      .style('padding', '8px').style('font-family', "'JetBrains Mono', monospace").style('font-size', '11px')
      .style('color', '#E7EAF0').style('opacity', 0)

    g.selectAll('path.wedge').data(seasonal.map(s => ({ month: s.month, value: s[metric.key], n: s.n }))).enter()
      .append('path').attr('class', 'wedge')
      .attr('d', arc)
      .attr('fill', d => d.value != null ? colorScale(d.value) : '#252B3A')
      .attr('fill-opacity', 0.88)
      .attr('stroke', d => (EQUINOX.has(d.month) ? EQUINOX_COLOR : SOLSTICE.has(d.month) ? SOLSTICE_COLOR : '#0A0C10'))
      .attr('stroke-width', d => (EQUINOX.has(d.month) || SOLSTICE.has(d.month)) ? 2 : 1)
      .style('cursor', 'default')
      .on('mouseover', function (event, d) {
        d3.select(this).attr('fill-opacity', 1)
        const tag = EQUINOX.has(d.month) ? ' (equinox)' : SOLSTICE.has(d.month) ? ' (solstice)' : ''
        tooltip.style('opacity', 1).html(`
          <b>${MONTH_NAMES[d.month - 1]}${tag}</b><br/>
          ${metric.label}: <b>${d.value != null ? d.value.toFixed(3) : '—'}</b>${metric.unit}<br/>
          ${d.n.toLocaleString()} hours averaged
        `)
        const wrapEl = wrapRef.current
        const node = tooltip.node()
        let left = event.offsetX + 14, top = event.offsetY - node.offsetHeight - 10
        if (left + node.offsetWidth > wrapEl.clientWidth) left = event.offsetX - node.offsetWidth - 14
        if (top < 4) top = event.offsetY + 14
        tooltip.style('left', `${left}px`).style('top', `${top}px`)
      })
      .on('mouseout', function () { d3.select(this).attr('fill-opacity', 0.88); tooltip.style('opacity', 0) })

    // Month labels around the outside
    seasonal.forEach(s => {
      const mid = angle(s.month + 0.5)
      const lx = Math.sin(mid) * (Rmax + 16)
      const ly = -Math.cos(mid) * (Rmax + 16)
      g.append('text')
        .attr('x', lx).attr('y', ly)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('fill', EQUINOX.has(s.month) ? EQUINOX_COLOR : SOLSTICE.has(s.month) ? SOLSTICE_COLOR : '#7C8496')
        .attr('font-size', 11).attr('font-family', "'JetBrains Mono', monospace").attr('font-weight', EQUINOX.has(s.month) || SOLSTICE.has(s.month) ? 700 : 400)
        .text(MONTH_NAMES[s.month - 1])
    })

    // Center label
    g.append('text').attr('y', -6).attr('text-anchor', 'middle')
      .attr('fill', '#E7EAF0').attr('font-size', 13).attr('font-weight', 700).attr('font-family', "'JetBrains Mono', monospace")
      .text(metric.short)
    g.append('text').attr('y', 12).attr('text-anchor', 'middle')
      .attr('fill', '#7C8496').attr('font-size', 9).attr('font-family', "'JetBrains Mono', monospace")
      .text('by month')

  }, [seasonal, metricKey, sizeTick])

  return (
    <FullscreenFrame isFullscreen={isFullscreen} onClose={() => onToggleFullscreen(false)}>
      <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-space-hairline bg-space-panel-2/60">
        <span
          className="text-sm font-semibold text-space-text truncate"
          title="Mean activity by calendar month over the loaded Date Range — the Russell-McPherron semiannual variation: activity peaks near equinoxes (clearest with many years loaded)."
        >
          Seasonal Pattern
        </span>

        <div className="ml-auto flex items-center rounded-md border border-space-hairline overflow-hidden font-mono">
          {METRICS.map(m => (
            <button
              key={m.key}
              onClick={() => setMetricKey(m.key)}
              className={`px-2.5 py-0.5 text-[10px] transition-colors ${
                metricKey === m.key ? 'bg-space-violet text-white' : 'bg-space-panel-2 text-space-dim hover:text-space-text'
              }`}
            >
              {m.short}
            </button>
          ))}
        </div>

        <FullscreenButton active={isFullscreen} onClick={() => onToggleFullscreen(!isFullscreen)} />
      </div>

      <div ref={wrapRef} className="relative w-full flex-1 min-h-0 overflow-hidden">
        {!seasonal
          ? <div className="flex items-center justify-center h-full text-space-faint text-sm font-mono">
              {error ? `Could not load seasonal data: ${error}` : 'Loading seasonal averages…'}
            </div>
          : <svg ref={svgRef} style={{ display: 'block' }} />
        }
      </div>

      {/* Legend — its own strip below the chart (not overlaid on it, and not
          crammed into the header): the month labels ring the entire circle,
          so there's no corner of the chart itself safe from collision, and
          the header already carries the title + metric toggle. */}
      {seasonal && (
        <div className="flex-none flex items-center flex-wrap gap-x-3 gap-y-1 px-3 py-1.5 border-t border-space-hairline text-[10px] font-mono text-space-dim">
          <span className="flex items-center gap-1.5">
            <span className="text-space-faint whitespace-nowrap">{METRICS.find(m => m.key === metricKey)?.label} (wedge color)</span>
            <span className="h-2 w-16 rounded-full" style={{ background: VIRIDIS_GRADIENT }} />
            <span className="text-space-faint tabular-nums whitespace-nowrap">{colorDomain[0].toFixed(2)}–{colorDomain[1].toFixed(2)}</span>
          </span>
          <span className="flex items-center gap-1 whitespace-nowrap">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: EQUINOX_COLOR }} />
            equinox
          </span>
          <span className="flex items-center gap-1 whitespace-nowrap">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: SOLSTICE_COLOR }} />
            solstice
          </span>
        </div>
      )}
    </FullscreenFrame>
  )
}
