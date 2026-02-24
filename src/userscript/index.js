import { WatermarkEngine } from '../core/watermarkEngine.js';

let engine = null;
const processingQueue = new Set();

const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

const canvasToBlob = (canvas, type = 'image/png') =>
  new Promise(resolve => canvas.toBlob(resolve, type));

const isValidGeminiImage = (img) =>
  /=s\d+\-rj/.test(img.src) || (img.naturalWidth >= 256 && img.naturalHeight >= 256);

const findGeminiImages = () =>
  [...document.querySelectorAll('img[src*="googleusercontent.com"]')].filter(isValidGeminiImage);

const fetchBlob = (url) => new Promise((resolve, reject) => {
  // use GM_xmlhttpRequest to fetch image blob to avoid cross-origin issue
  GM_xmlhttpRequest({
    method: 'GET',
    url,
    responseType: 'blob',
    onload: (response) => resolve(response.response),
    onerror: reject
  });
});

const replaceWithNormalSize = (src) => {
  // use normal size image to fit watermark
  return src.replace(/=s\d+(?=[-?#]|$)/, '=s0');
}

async function processImage(imgElement) {
  if (!engine || processingQueue.has(imgElement)) return;

  processingQueue.add(imgElement);
  imgElement.dataset.watermarkProcessed = 'processing';

  try {
    if (!isValidGeminiImage(imgElement)) {
      imgElement.dataset.watermarkProcessed = 'skipped';
      return;
    }

    const originalSrc = imgElement.src;
    imgElement.src = '';
    imgElement.dataset.src = originalSrc;

    const blob = await fetchBlob(replaceWithNormalSize(originalSrc));
    const blobUrl = URL.createObjectURL(blob);
    const img = await loadImage(blobUrl);
    const canvas = await engine.removeWatermarkFromImage(img);
    const processedBlob = await canvasToBlob(canvas);

    URL.revokeObjectURL(blobUrl);
    imgElement.src = URL.createObjectURL(processedBlob);
    imgElement.dataset.watermarkProcessed = 'true';

    console.log('[Gemini Watermark Remover] Processed image');
  } catch (error) {
    console.warn('[Gemini Watermark Remover] Failed to process image:', error);
    imgElement.dataset.watermarkProcessed = 'failed';
  } finally {
    processingQueue.delete(imgElement);
  }
}

const processAllImages = () => {
  const images = findGeminiImages();
  console.log(`[Gemini Watermark Remover] Found ${images.length} images to process`);
  images.forEach(processImage);
};

const setupMutationObserver = () => {
  new MutationObserver(debounce(processAllImages, 100))
    .observe(document.body, { childList: true, subtree: true });
  console.log('[Gemini Watermark Remover] MutationObserver active');
};

async function processImageBlob(blob) {
  const blobUrl = URL.createObjectURL(blob);
  const img = await loadImage(blobUrl);
  const canvas = await engine.removeWatermarkFromImage(img);
  URL.revokeObjectURL(blobUrl);
  return canvasToBlob(canvas);
}

const GEMINI_URL_PATTERN = /^https:\/\/lh3\.googleusercontent\.com\/rd-gg(-dl)?\//; // downloadable image url pattern

// Intercept fetch requests to replace downloadable image with the watermark removed image
const { fetch: origFetch } = unsafeWindow;
unsafeWindow.fetch = async (...args) => {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (GEMINI_URL_PATTERN.test(url)) {
    console.log('[Gemini Watermark Remover] Intercepting:', url);

    const origUrl = replaceWithNormalSize(url);
    if (typeof args[0] === 'string') args[0] = origUrl;
    else if (args[0]?.url) args[0].url = origUrl;

    const response = await origFetch(...args);
    if (!engine || !response.ok) return response;

    try {
      const processedBlob = await processImageBlob(await response.blob());
      return new Response(processedBlob, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      console.warn('[Gemini Watermark Remover] Processing failed:', error);
      return response;
    }
  }

  return origFetch(...args);
};

(async function init() {
  try {
    console.log('[Gemini Watermark Remover] Initializing...');
    engine = await WatermarkEngine.create();

    processAllImages();
    setupMutationObserver();

    console.log('[Gemini Watermark Remover] Ready');
  } catch (error) {
    console.error('[Gemini Watermark Remover] Initialization failed:', error);
  }
})();