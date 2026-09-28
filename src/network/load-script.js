/**
 * Shared CDN script loader. Injects one <script> tag per URL and caches the
 * promise, so every caller shares a single download and re-entry is a no-op.
 * A failed URL is evicted from the cache so the next call can retry.
 */

const requests = new Map();

/** Resolves once the script at `src` has loaded and executed. */
export function loadScript(src) {
  if (!requests.has(src)) {
    requests.set(
      src,
      new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
          requests.delete(src);
          reject(new Error(`Script failed to load: ${src}`));
        };
        document.head.append(script);
      }),
    );
  }
  return requests.get(src);
}
