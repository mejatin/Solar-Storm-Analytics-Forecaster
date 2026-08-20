// /api/data's `end` filter only matches midnight of that date, so to get
// the whole end day we request one day past it and filter back down.
function nextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Every hourly row from startDate through endDate inclusive
export async function fetchWindow(startDate, endDate) {
  const res = await fetch(`/api/data?start=${startDate}&end=${nextDay(endDate)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const rows = await res.json()
  const cutoff = endDate + 'T23:59:59'
  return rows.filter(r => r.datetime <= cutoff)
}

// One day's hourly rows
export function fetchDay(dateStr) {
  return fetchWindow(dateStr, dateStr)
}
