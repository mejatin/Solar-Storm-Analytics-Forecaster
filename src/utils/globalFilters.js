// Wide enough to pass every real value in the 1995-2025 dataset through untouched
export const DEFAULT_FILTERS = {
  severity: { quiet: true, moderate: true, intense: true, severe: true },
  speed:    [0, 2000],
  density:  [0, 200],
  bz:       [-100, 100],
  kp:       [0, 9],
  dst:      [-700, 200],
  resolution: 'daily',
}

// /api/data and /api/orbital/storms use different timezone suffixes for the
// same instants — compare as plain strings, not via new Date().
const stripZ = s => (s.endsWith('Z') ? s.slice(0, -1) : s)

// Which cataloged storm (if any) a timestamp falls inside
export function rowSeverity(datetime, stormCatalog) {
  for (const s of stormCatalog || []) {
    if (stripZ(s.start) <= datetime && datetime <= stripZ(s.end)) return s.intensity
  }
  return 'quiet'
}

const RANGE_FIELDS = [
  ['flow_speed_kms',     'speed'],
  ['proton_density_ncc', 'density'],
  ['bz_gsm_nT',          'bz'],
  ['kp',                 'kp'],
  ['dst_omni',           'dst'],
]

// Every plotted field, nulled when a row's severity is unchecked
const PLOTTED_FIELDS = [
  'flow_speed_kms', 'proton_density_ncc', 'bz_gsm_nT', 'kp', 'dst_omni',
  'pdyn_computed_nPa', 'proton_temp_K', 'imf_mag_scalar_nT', 'sw_type',
]

// Nulls out-of-range fields in place, keeping every row (so chart gaps stay correct)
export function applyGlobalFilters(data, filters, stormCatalog) {
  if (!data?.length) return data
  return data.map(row => {
    const sev = rowSeverity(row.datetime, stormCatalog)
    const sevOk = filters.severity[sev] !== false
    const out = { ...row }
    if (!sevOk) {
      for (const field of PLOTTED_FIELDS) out[field] = null
      // Clear storm_flag too, so storm shading doesn't outlive the nulled data
      out.storm_flag = 0
      return out
    }
    for (const [field, key] of RANGE_FIELDS) {
      // Normalize reversed bounds (min > max)
      const lo = Math.min(filters[key][0], filters[key][1])
      const hi = Math.max(filters[key][0], filters[key][1])
      const v = out[field]
      if (v == null || v < lo || v > hi) out[field] = null
    }
    return out
  })
}

const MEAN_FIELDS = ['flow_speed_kms', 'proton_density_ncc', 'pdyn_computed_nPa', 'bz_gsm_nT', 'imf_mag_scalar_nT', 'proton_temp_K', 'ae_index_nT', 'sym_h_nT']

function mean(vals) {
  const v = vals.filter(x => x != null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
function maxSkipNull(vals) {
  const v = vals.filter(x => x != null)
  return v.length ? Math.max(...v) : null
}
function minSkipNull(vals) {
  const v = vals.filter(x => x != null)
  return v.length ? Math.min(...v) : null
}

// Groups hourly rows into one row per day, skipping nulls per field
export function aggregateDaily(rows) {
  if (!rows?.length) return rows
  const byDay = new Map()
  for (const r of rows) {
    const day = r.datetime.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(r)
  }
  return [...byDay.entries()].map(([day, group]) => {
    const out = { datetime: `${day}T00:00:00`, storm_flag: maxSkipNull(group.map(r => r.storm_flag)) ?? 0 }
    for (const f of MEAN_FIELDS) out[f] = mean(group.map(r => r[f]))
    out.kp = maxSkipNull(group.map(r => r.kp))
    out.dst_omni = minSkipNull(group.map(r => r.dst_omni))
    return out
  })
}
