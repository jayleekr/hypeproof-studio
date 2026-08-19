// Seeded PRNG — think-times and guest picks must be reproducible across runs,
// otherwise two runs are not comparable and a regression cannot be told apart
// from a different dice roll.

/** mulberry32 — 32-bit, fast, good enough for jitter. Deterministic per seed. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng, min, max) {
  return Math.floor(min + rng() * (max - min + 1));
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}
