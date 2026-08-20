import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

// ML tab — storm risk forecaster. Two parts:
//   1. Pick a moment in the dataset, get P(storm) at 1h/3h/6h ahead from the
//      current solar wind state (RandomForestClassifier per horizon, see
//      server/train_storm_model.py).
//   2. A validation chart: run one horizon's model across a date range and
//      plot predicted risk against the actual cataloged storms, so you can
//      visually sanity-check the model against e.g. the Halloween 2003 storm.

const RISK_COLOR = {
  low: '#5CF2A0',
  elevated: '#E8A33D',
  high: '#FF5B54',
}
const RISK_LABEL = {
  low: 'Low',
  elevated: 'Elevated',
  high: 'High',
}

const DEFAULT_DATETIME = '2003-10-29T06:00:00'
const DEFAULT_RANGE_START = '2003-10-25'
const DEFAULT_RANGE_END = '2003-11-10'
const HORIZONS = [1, 3, 6]

function RiskCard({ h, pred }) {
  const color = pred ? RISK_COLOR[pred.risk] : '#4B5265'
  const pct = pred ? Math.round(pred.probability * 100) : null
  return (
    <div className="flex-1 min-w-0 rounded-lg border border-space-hairline bg-space-panel-2/60 px-4 py-3 flex flex-col items-center gap-1">
      <span className="text-[11px] font-mono text-space-faint uppercase tracking-wide">+{h}h horizon</span>
      <span className="text-3xl font-bold font-mono tabular-nums" style={{ color }}>
        {pct !== null ? `${pct}%` : '—'}
      </span>
      <span
        className="text-[11px] font-mono px-2 py-0.5 rounded-full border"
        style={{ color, borderColor: color + '80', backgroundColor: color + '1a' }}
      >
        {pred ? RISK_LABEL[pred.risk] : 'n/a'}
      </span>
    </div>
  )
}

export default function MLPrediction() {
  const [modelInfo, setModelInfo] = useState(null)
  useEffect(() => {
    fetch('/api/model/info').then(r => r.json()).then(setModelInfo).catch(() => setModelInfo({ trained: false }))
  }, [])

  // --- Single-point prediction ---
  const [datetime, setDatetime] = useState(DEFAULT_DATETIME)
  const [predResult, setPredResult] = useState(null)
  const [predError, setPredError] = useState(null)
  const [predLoading, setPredLoading] = useState(false)

  const runPredict = () => {
    setPredLoading(true)
    setPredError(null)
    // datetime-local gives "YYYY-MM-DDTHH:mm"; the API expects seconds too.
    const dtParam = datetime.length === 16 ? `${datetime}:00` : datetime
    fetch(`/api/predict?datetime=${dtParam}`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e.error || `HTTP ${r.status}`)))
      .then(d => { setPredResult(d); setPredLoading(false) })
      .catch(e => { setPredError(String(e)); setPredLoading(false); setPredResult(null) })
  }

  // --- Range validation chart ---
  const [rangeStart, setRangeStart] = useState(DEFAULT_RANGE_START)
  const [rangeEnd, setRangeEnd] = useState(DEFAULT_RANGE_END)
  const [horizon, setHorizon] = useState(3)
  const [rangeData, setRangeData] = useState(null)
  const [rangeError, setRangeError] = useState(null)

  const loadRange = () => {
    setRangeError(null)
    fetch(`/api/predict/range?start=${rangeStart}&end=${rangeEnd}&horizon=${horizon}`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e.error || `HTTP ${r.status}`)))
      .then(setRangeData)
      .catch(e => { setRangeError(String(e)); setRangeData(null) })
  }

  useEffect(() => {
    if (modelInfo?.trained) { runPredict(); loadRange() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelInfo?.trained])

  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  useEffect(() => {
    if (!rangeData || !rangeData.length || !wrapRef.current) return
    const W = wrapRef.current.clientWidth
    const H = 240
    const margin = { top: 12, right: 16, bottom: 24, left: 40 }

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    svg.attr('width', W).attr('height', H)

    const parsed = rangeData.map(d => ({ ...d, t: new Date(d.datetime) }))
    const x = d3.scaleTime().domain(d3.extent(parsed, d => d.t)).range([margin.left, W - margin.right])
    const y = d3.scaleLinear().domain([0, 1]).range([H - margin.bottom, margin.top])

    // Shaded bands for actual storm hours
    const g = svg.append('g')
    let bandStart = null
    parsed.forEach((d, i) => {
      if (d.storm_flag && bandStart === null) bandStart = d.t
      const ending = !d.storm_flag || i === parsed.length - 1
      if (bandStart !== null && ending) {
        const bandEnd = d.storm_flag ? d.t : parsed[i - 1].t
        g.append('rect')
          .attr('x', x(bandStart)).attr('width', Math.max(1, x(bandEnd) - x(bandStart)))
          .attr('y', margin.top).attr('height', H - margin.top - margin.bottom)
          .attr('fill', '#FF5B54').attr('fill-opacity', 0.12)
        bandStart = null
      }
    })

    // Axes
    svg.append('g').attr('transform', `translate(0,${H - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(6).tickSizeOuter(0))
      .call(sel => sel.selectAll('text').attr('fill', '#7C8496').attr('font-size', 10).attr('font-family', 'monospace'))
      .call(sel => sel.selectAll('path,line').attr('stroke', '#252B3A'))
    svg.append('g').attr('transform', `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('.0%')).tickSizeOuter(0))
      .call(sel => sel.selectAll('text').attr('fill', '#7C8496').attr('font-size', 10).attr('font-family', 'monospace'))
      .call(sel => sel.selectAll('path,line').attr('stroke', '#252B3A'))

    // Predicted risk line
    const line = d3.line().x(d => x(d.t)).y(d => y(d.risk)).curve(d3.curveMonotoneX)
    svg.append('path').datum(parsed).attr('d', line)
      .attr('fill', 'none').attr('stroke', '#8B5CF6').attr('stroke-width', 1.75)

    svg.append('text').attr('x', margin.left).attr('y', margin.top - 2)
      .attr('fill', '#7C8496').attr('font-size', 10).attr('font-family', 'monospace')
      .text(`predicted P(storm within ${horizon}h)  ·  red band = actual storm hours`)
  }, [rangeData, horizon])

  if (modelInfo === null) {
    return <div className="p-6 text-space-dim font-mono text-sm">Loading model status…</div>
  }

  if (!modelInfo.trained) {
    return (
      <div className="max-w-xl mx-auto mt-10 rounded-lg border border-space-hairline bg-space-panel-2/60 p-6 text-center">
        <div className="text-space-text font-semibold mb-2">Model not trained yet</div>
        <p className="text-space-dim text-sm mb-3">
          Run the training script once, then reload this tab:
        </p>
        <code className="block bg-space-bg border border-space-hairline rounded px-3 py-2 text-xs text-space-fast font-mono">
          cd server &amp;&amp; python train_storm_model.py
        </code>
      </div>
    )
  }

  const metrics = modelInfo.metrics || {}

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 pt-3 flex flex-col gap-3">
      {/* Model summary */}
      <div className="flex-none rounded-lg border border-space-hairline bg-space-panel px-4 py-3">
        <div className="text-sm font-semibold text-space-text mb-2">
          Storm Risk Forecaster
          <span className="ml-2 text-[11px] font-mono font-normal text-space-faint">
            RandomForest · trained on solar wind lags &amp; rolling means
          </span>
        </div>
        <div className="flex gap-4 flex-wrap font-mono text-[11px] text-space-dim">
          {HORIZONS.map(h => {
            const m = metrics[`${h}h`]
            if (!m) return null
            return (
              <span key={h}>
                +{h}h — AUC <b className="text-space-text">{m.roc_auc}</b>,
                {' '}precision <b className="text-space-text">{m['precision_at_0.5']}</b>,
                {' '}recall <b className="text-space-text">{m['recall_at_0.5']}</b>
              </span>
            )
          })}
        </div>
      </div>

      {/* Single-point prediction */}
      <div className="flex-none rounded-lg border border-space-hairline bg-space-panel px-4 py-3">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-sm font-semibold text-space-text">Predict at a moment</span>
          <input
            type="datetime-local"
            value={datetime}
            onChange={e => setDatetime(e.target.value)}
            step={3600}
            className="ml-2 bg-space-panel-2 border border-space-hairline rounded px-2 py-1 text-xs font-mono text-space-text"
          />
          <button
            onClick={runPredict}
            disabled={predLoading}
            className="px-3 py-1 rounded bg-space-violet hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {predLoading ? 'Predicting…' : 'Predict'}
          </button>
          {predResult && (
            <span className="text-[11px] font-mono text-space-faint">
              inputs — Bz {predResult.inputs.bz_gsm_nT} nT, speed {predResult.inputs.flow_speed_kms} km/s,
              {' '}density {predResult.inputs.proton_density_ncc} /cc, Pdyn {predResult.inputs.pdyn_computed_nPa} nPa,
              {' '}SYM-H now {predResult.inputs.sym_h_now} nT
            </span>
          )}
        </div>
        {predError && <div className="text-space-danger text-xs font-mono mb-2">{predError}</div>}
        <div className="flex gap-3">
          {HORIZONS.map(h => (
            <RiskCard key={h} h={h} pred={predResult?.predictions?.[`${h}h`]} />
          ))}
        </div>
      </div>

      {/* Validation chart */}
      <div className="flex-1 min-h-0 rounded-lg border border-space-hairline bg-space-panel px-4 py-3 flex flex-col">
        <div className="flex items-center gap-2 mb-2 flex-wrap flex-none">
          <span className="text-sm font-semibold text-space-text">Risk over time vs. actual storms</span>
          <input type="date" value={rangeStart} onChange={e => setRangeStart(e.target.value)}
            className="ml-2 bg-space-panel-2 border border-space-hairline rounded px-2 py-1 text-xs font-mono text-space-text" />
          <span className="text-space-faint text-xs">→</span>
          <input type="date" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)}
            className="bg-space-panel-2 border border-space-hairline rounded px-2 py-1 text-xs font-mono text-space-text" />
          <div className="flex items-center rounded-md border border-space-hairline overflow-hidden font-mono ml-1">
            {HORIZONS.map(h => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`px-2.5 py-1 text-[11px] transition-colors ${
                  horizon === h ? 'bg-space-violet text-white' : 'bg-space-panel-2 text-space-dim hover:text-space-text'
                }`}
              >
                +{h}h
              </button>
            ))}
          </div>
          <button
            onClick={loadRange}
            className="px-3 py-1 rounded bg-space-violet hover:bg-violet-500 text-white text-xs font-medium transition-colors"
          >
            Load
          </button>
          {rangeError && <span className="text-space-danger text-xs font-mono">{rangeError}</span>}
        </div>
        <div ref={wrapRef} className="flex-1 min-h-0">
          <svg ref={svgRef} className="w-full h-full" />
        </div>
      </div>
    </div>
  )
}
