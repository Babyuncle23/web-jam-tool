/**
 * Shared CDN script loader. Injects one <script> tag per URL and caches the
 * promise, so every caller shares a single download and re-entry is a no-op.
 * A failed URL is evicted from the cache so the next call can retry.
 */

const requests = new Map();

/**
 * Resolves once the script at `src` has loaded and executed. With
 * `timeoutMs`, a stalled download is evicted and rejected so the caller can
 * show a retryable error instead of spinning forever.
 */
export function loadScript(src, timeoutMs = 0) {
  if (!requests.has(src)) {
    requests.set(
      src,
      new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        let timer = 0;
        const fail = (reason) => {
          requests.delete(src);
          script.remove();
          reject(new Error(`${reason}: ${src}`));
        };
        if (timeoutMs > 0) timer = setTimeout(() => fail('Script timed out'), timeoutMs);
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); fail('Script failed to load'); };
        document.head.append(script);
      }),
    );
  }
  return requests.get(src);
}
