// Display rounding only (C-012): the engine keeps full precision everywhere else.

/** Round half-to-even to `dp` decimals: 188.125 → 188.12, 74.375 → 74.38. */
export function roundHalfEven(x: number, dp = 2): number {
  const f = 10 ** dp;
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const EPS = 1e-9;
  let r: number;
  if (Math.abs(diff - 0.5) < EPS) r = floor % 2 === 0 ? floor : floor + 1;
  else r = Math.round(scaled);
  return r / f;
}

export const round2 = (x: number) => roundHalfEven(x, 2);
