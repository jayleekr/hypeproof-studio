// Canonical admin base URL derived from a proxyUrl.
// proxyUrl typically ends with "/v1" or "/v1/" (the OpenAI-compatible prefix);
// admin endpoints live at the root, not under /v1.
export function adminBaseFrom(proxyUrl: string): string {
  return proxyUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}
