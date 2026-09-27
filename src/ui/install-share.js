/**
 * Role screen extras: the "Install App to Home Screen" button and a QR
 * that shares this page's URL. The QR library loads lazily from the same
 * CDN the host screen uses.
 */

const QR_SRC = 'https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs@master/qrcode.min.js';

function loadQrLibrary() {
  return new Promise((resolve, reject) => {
    if (globalThis.QRCode) {
      resolve(globalThis.QRCode);
      return;
    }
    const script = document.createElement('script');
    script.src = QR_SRC;
    script.async = true;
    script.onload = () => resolve(globalThis.QRCode);
    script.onerror = () => reject(new Error('QR library failed to load'));
    document.head.append(script);
  });
}

function isAppleTouch() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function renderShareQr(box) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  try {
    const QRCode = await loadQrLibrary();
    box.replaceChildren();
    const qr = new QRCode(box, {
      text: url.toString(),
      width: 132,
      height: 132,
      colorDark: '#1c140c',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
    qr.makeCode(url.toString());
  } catch {
    box.textContent = url.toString();
  }
}

export function initRoleExtras() {
  const installBtn = document.getElementById('btn-install');
  const installHint = document.getElementById('install-hint');
  const qrBox = document.getElementById('role-qr');
  if (!installBtn || !qrBox) return;

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installBtn.textContent = 'Installed';
  });

  if (isInstalled()) {
    installBtn.textContent = 'Installed';
  } else if (isAppleTouch()) {
    installHint.textContent = 'On iPhone/iPad: Share → Add to Home Screen.';
    installHint.hidden = false;
  }

  installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt = null;
      return;
    }
    installHint.textContent = isAppleTouch()
      ? 'On iPhone/iPad: Share → Add to Home Screen.'
      : 'Open the browser menu and choose «Install app» / «Add to Home Screen».';
    installHint.hidden = false;
  });

  renderShareQr(qrBox);
}
