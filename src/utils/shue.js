// Shue et al. (1998) empirical magnetopause model.

// Standoff distance (Earth radii) from that day's real measured IMF Bz (nT)
// and dynamic pressure Pdyn (nPa).
export function magnetopauseR0(bz, pdyn) {
  const b = bz ?? 0, p = Math.max(0.1, pdyn ?? 2)
  return (10.22 + 1.29 * Math.tanh(0.184 * (b + 8.14))) * Math.pow(p, -1 / 6.6)
}

// Flaring parameter — how quickly the magnetopause opens out toward the
// flanks/tail. ln(Pdyn) needs the same epsilon floor as the standoff term.
export function flaringAlpha(bz, pdyn) {
  const p = Math.max(0.1, pdyn ?? 2)
  return (0.58 - 0.007 * (bz ?? 0)) * (1 + 0.024 * Math.log(p))
}

// Full angular magnetopause radius (Earth radii) at angle theta (radians,
// measured from the sunward direction): r(theta) = r0 * (2/(1+cos theta))^alpha.
export function shueRadius(theta, r0, alpha) {
  return r0 * Math.pow(2 / (1 + Math.cos(theta)), alpha)
}
