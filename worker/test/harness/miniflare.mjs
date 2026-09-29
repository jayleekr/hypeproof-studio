// Miniflare 5 takes a `workers` array of wrangler-shaped configs. The D1 tests keep
// their single-worker options and go through the library's own converter, so the
// local runtime stays the one Cloudflare ships rather than a shape we guessed.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const createMiniflare = (options) => new Miniflare(convertV4MiniflareOptions(options));
