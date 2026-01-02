/* script.js
   مدمج: Map picker (Leaflet + Nominatim) + Numeric filters (int/float) + Tag-input
   - registerMapInputs([{ selector:'#mapField1' }, ...])
   - registerNumericInputs([{ selector:'#intField1', type:'int' }, ...])
   - registerTagInputs([{ selector:'#tagField', allowDuplicates:false }])
   - لا يحتاج Google API Key (يستخدم OSM + Nominatim)
*/

/* ================== Common helpers ================== */
function ensureSelector(selector) {
  if (!selector) return null;
  if ((selector.startsWith('#') || selector.startsWith('.') || selector.includes('[')) ) return selector;
  if (document.getElementById(selector)) return '#' + selector;
  return selector;
}

/* ================== Leaflet loader (fallback) ================== */
let _leafletLoadPromise = null;
function injectLeafletAndReturnPromise() {
  if (_leafletLoadPromise) return _leafletLoadPromise;

  _leafletLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    if (window.L && window.L.map) { resolve(); return; }

    function addScript(src, onload, onerror) {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = onload;
      s.onerror = onerror;
      document.head.appendChild(s);
    }

    addScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', () => {
      if (window.L && window.L.map) resolve();
      else {
        addScript('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js', () => {
          if (window.L && window.L.map) resolve();
          else reject(new Error('Leaflet loaded but not ready'));
        }, () => reject(new Error('Failed to load Leaflet from both CDNs')));
      }
    }, () => {
      addScript('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js', () => {
        if (window.L && window.L.map) resolve();
        else reject(new Error('Leaflet loaded from fallback but not ready'));
      }, () => {
        reject(new Error('Failed to load Leaflet from both CDNs. Check your network or CDN block.'));
      });
    });
  });

  return _leafletLoadPromise;
}

/* ================== Map styles ================== */
(function injectMapStyles() {
  const css = `
    .amdev-loc-wrap { display:flex; gap:8px; align-items:center; margin:10px 0; direction:rtl; font-family:Tahoma, Arial, sans-serif; }
    .amdev-pick-btn { padding:8px 10px; border-radius:6px; border:0; cursor:pointer; font-weight:600; background:#1e88ff; color:white; }
    .amdev-modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.45); justify-content:center; align-items:center; z-index:9999; }
    .amdev-modal { width:92%; max-width:900px; height:70vh; background:white; border-radius:10px; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 8px 30px rgba(2,6,23,0.25); }
    #amdev-map { flex:1; min-height:200px; position:relative; }
    .amdev-footer { display:flex; gap:8px; padding:10px; justify-content:flex-end; background:#fafafa; border-top:1px solid #eee; }
    .amdev-btn-secondary { padding:8px 12px; border-radius:6px; border:0; cursor:pointer; background:#e6f0ff; color:#064a9b; }
    .amdev-search-input { position:absolute; left:10px; top:10px; width:60%; z-index:520; padding:8px; border-radius:6px; border:1px solid rgba(0,0,0,0.2); background:white; }
    .amdev-results { position:absolute; left:10px; top:46px; z-index:520; background:white; max-height:200px; overflow:auto; width:60%; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.12); }
    .amdev-result-item { padding:8px; cursor:pointer; border-bottom:1px solid #eee; font-size:14px; }
    .amdev-result-item:hover { background:#f3f7ff; }
    @media (max-width:600px) { .amdev-search-input, .amdev-results { width:88%; left:6%; } }
  `;
  const s = document.createElement('style');
  s.appendChild(document.createTextNode(css));
  document.head.appendChild(s);
})();

/* ================== Map picker implementation ================== */
let mapModalOverlay = null;
let mapModalEl = null;
let mapDiv = null;
let mapInstance = null;
let mapMarker = null;
let mapSearchInput = null;
let mapResultsBox = null;
let mapSelectedLatLng = null;
let currentMapTargetInput = null;
let debounceTimerMap = null;

function buildMapModalIfNeeded() {
  if (mapModalOverlay) return;

  mapModalOverlay = document.createElement('div');
  mapModalOverlay.className = 'amdev-modal-overlay';
  mapModalOverlay.setAttribute('role', 'dialog');
  mapModalOverlay.setAttribute('aria-hidden', 'true');

  mapModalEl = document.createElement('div');
  mapModalEl.className = 'amdev-modal';

  mapDiv = document.createElement('div');
  mapDiv.id = 'amdev-map';

  mapSearchInput = document.createElement('input');
  mapSearchInput.className = 'amdev-search-input';
  mapSearchInput.placeholder = 'ابحث عن مكان...';
  mapDiv.appendChild(mapSearchInput);

  mapResultsBox = document.createElement('div');
  mapResultsBox.className = 'amdev-results';
  mapResultsBox.style.display = 'none';
  mapDiv.appendChild(mapResultsBox);

  const footer = document.createElement('div');
  footer.className = 'amdev-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'amdev-btn-secondary';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'إلغاء';
  cancelBtn.addEventListener('click', closeMapModal);

  const okBtn = document.createElement('button');
  okBtn.className = 'amdev-pick-btn';
  okBtn.type = 'button';
  okBtn.textContent = 'OK';
  okBtn.addEventListener('click', confirmMapSelection);

  footer.appendChild(cancelBtn);
  footer.appendChild(okBtn);

  mapModalEl.appendChild(mapDiv);
  mapModalEl.appendChild(footer);
  mapModalOverlay.appendChild(mapModalEl);
  document.body.appendChild(mapModalOverlay);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mapModalOverlay.style.display === 'flex') closeMapModal();
  });

  mapSearchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(debounceTimerMap);
    if (!q) { mapResultsBox.style.display = 'none'; mapResultsBox.innerHTML = ''; return; }
    debounceTimerMap = setTimeout(() => { doNominatimSearch(q); }, 300);
  });

  document.addEventListener('click', (ev) => {
    if (!mapModalOverlay || mapModalOverlay.style.display !== 'flex') return;
    const path = ev.composedPath ? ev.composedPath() : (ev.path || []);
    if (!path.includes(mapResultsBox) && !path.includes(mapSearchInput)) {
      mapResultsBox.style.display = 'none';
    }
  });
}

function openMapModalForInput(inputEl) {
  currentMapTargetInput = inputEl;
  buildMapModalIfNeeded();
  mapModalOverlay.style.display = 'flex';
  mapModalOverlay.setAttribute('aria-hidden', 'false');

  injectLeafletAndReturnPromise()
    .then(() => {
      initOrUpdateMap();
      setTimeout(() => { if (mapInstance && mapInstance.invalidateSize) mapInstance.invalidateSize(); }, 150);
    })
    .catch(err => {
      console.error('Leaflet load error:', err);
      alert('فشل تحميل مكتبة الخرائط. تأكد من اتصال الإنترنت أو أن CDN غير محجوبة.');
      closeMapModal();
    });
}

function closeMapModal() {
  if (mapModalOverlay) { mapModalOverlay.style.display = 'none'; mapModalOverlay.setAttribute('aria-hidden', 'true'); }
}

function initOrUpdateMap() {
  if (!mapDiv) return;
  if (mapInstance) {
    const parsed = parseLatLngFromString(currentMapTargetInput.value);
    if (parsed) {
      mapInstance.setView([parsed.lat, parsed.lng], 14);
      placeOrMoveMarker(parsed);
    }
    setTimeout(() => { mapInstance.invalidateSize(); }, 200);
    return;
  }
  const defaultCenter = [30.044420, 31.235712];
  mapInstance = L.map(mapDiv, { center: defaultCenter, zoom: 12 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(mapInstance);

  const parsed = parseLatLngFromString(currentMapTargetInput.value);
  if (parsed) { placeOrMoveMarker(parsed); mapInstance.setView([parsed.lat, parsed.lng], 14); }

  mapInstance.on('click', function(e) { placeOrMoveMarker({ lat: e.latlng.lat, lng: e.latlng.lng }); });
}

function placeOrMoveMarker(latlngObj) {
  const lat = latlngObj.lat, lng = latlngObj.lng;
  if (!mapMarker) {
    mapMarker = L.marker([lat, lng], { draggable: true }).addTo(mapInstance);
    mapMarker.on('dragend', function(e) {
      const p = e.target.getLatLng();
      mapSelectedLatLng = { lat: p.lat, lng: p.lng };
    });
  } else {
    mapMarker.setLatLng([lat, lng]);
  }
  mapSelectedLatLng = { lat, lng };
}

function confirmMapSelection() {
  if (!mapSelectedLatLng) { alert('لم تختَر أي موقع. اضغط على الخريطة أو استخدم البحث.'); return; }
  const lat = Number(mapSelectedLatLng.lat).toFixed(6);
  const lng = Number(mapSelectedLatLng.lng).toFixed(6);
  const out = `lat:${lat},lng:${lng}`;
  if (currentMapTargetInput) currentMapTargetInput.value = out;
  closeMapModal();
}

/* ================== Nominatim search ================== */
async function doNominatimSearch(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=' + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { 'Accept-Language': 'ar' } });
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();
    renderNominatimResults(data || []);
  } catch (err) {
    console.error('Nominatim error:', err);
    mapResultsBox.style.display = 'none';
    mapResultsBox.innerHTML = '';
  }
}

function renderNominatimResults(items) {
  mapResultsBox.innerHTML = '';
  if (!items || items.length === 0) { mapResultsBox.style.display = 'none'; return; }
  items.forEach(it => {
    const el = document.createElement('div');
    el.className = 'amdev-result-item';
    el.textContent = it.display_name;
    el.addEventListener('click', () => {
      const lat = parseFloat(it.lat), lon = parseFloat(it.lon);
      placeOrMoveMarker({ lat, lng: lon });
      if (mapInstance) mapInstance.setView([lat, lon], 16);
      mapResultsBox.style.display = 'none';
      mapResultsBox.innerHTML = '';
      mapSearchInput.value = it.display_name;
    });
    mapResultsBox.appendChild(el);
  });
  mapResultsBox.style.display = 'block';
}

/* ================== parse helper ================== */
function parseLatLngFromString(str) {
  if (!str) return null;
  str = str.trim();
  const m = str.match(/lat\s*[:=]\s*([-\d.]+)\s*,\s*lng\s*[:=]\s*([-\d.]+)/i);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  const parts = str.split(',').map(p => p.trim());
  if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return { lat: parseFloat(parts[0]), lng: parseFloat(parts[1]) };
  return null;
}

/* ================== registerMapInputs API ================== */
function registerMapInputs(configs) {
  if (!Array.isArray(configs)) return;
  configs.forEach(cfg => {
    if (!cfg || !cfg.selector) return;
    try {
      let sel = ensureSelector(cfg.selector);
      const nodes = document.querySelectorAll(sel);
      nodes.forEach(node => {
        if (node.parentNode && node.parentNode.classList && node.parentNode.classList.contains('amdev-loc-wrap')) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'amdev-loc-wrap';
        node.parentNode.insertBefore(wrapper, node);
        wrapper.appendChild(node);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'amdev-pick-btn';
        btn.textContent = 'فتح الخريطة';
        btn.addEventListener('click', () => openMapModalForInput(node));
        wrapper.appendChild(btn);
      });
    } catch (err) { console.warn('registerMapInputs error for', cfg, err); }
  });
}

/* ================== Numeric filters (createNumericAttacher) ================== */
function createNumericAttacher() {
  function sanitizeInt(val, allowNegative) {
    if (typeof val !== 'string') val = String(val);
    let negative = false;
    val = val.trim();
    if (allowNegative && val.startsWith('-')) { negative = true; val = val.slice(1); }
    val = val.replace(/\D+/g, '');
    if (negative && val.length > 0) val = '-' + val;
    else if (negative && val.length === 0) val = '-';
    return val;
  }

  function sanitizeFloat(val, allowNegative) {
    if (typeof val !== 'string') val = String(val);
    val = val.trim();
    val = val.replace(/,/g, '.');
    let negative = false;
    if (allowNegative && val.startsWith('-')) { negative = true; val = val.slice(1); }
    const originalEndsWithDot = val.endsWith('.');
    val = val.replace(/[^0-9.]/g, '');
    const firstDotIndex = val.indexOf('.');
    if (firstDotIndex !== -1) {
      val = val.slice(0, firstDotIndex + 1) + val.slice(firstDotIndex + 1).replace(/\./g, '');
    }
    if (val.startsWith('.')) val = '0' + val;
    if (negative && val === '') return '-';
    if (originalEndsWithDot && !val.endsWith('.')) val = val + '.';
    if (negative && val !== '') val = '-' + val;
    return val;
  }

  function attachNumericFilter(inputEl, options = {}) {
    const type = options.type || 'int';
    const allowNegative = options.allowNegative !== false;

    function sanitize(value) { return type === 'float' ? sanitizeFloat(value, allowNegative) : sanitizeInt(value, allowNegative); }

    inputEl.addEventListener('input', (e) => {
      const old = inputEl.value;
      const cleaned = sanitize(old);
      if (old !== cleaned) {
        const selStart = inputEl.selectionStart;
        inputEl.value = cleaned;
        try { const pos = Math.min(selStart, cleaned.length); inputEl.setSelectionRange(pos, pos); } catch (err) {}
      }
    });

    inputEl.addEventListener('keydown', (e) => {
      const controlKeys = ['Backspace','Tab','Enter','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete','Home','End'];
      if (controlKeys.includes(e.key) || (e.ctrlKey || e.metaKey)) return;
      if (/^[0-9]$/.test(e.key)) return;
      if (allowNegative && e.key === '-') {
        if (inputEl.selectionStart === 0 && !inputEl.value.includes('-')) return;
        e.preventDefault(); return;
      }
      if (type === 'float' && (e.key === '.' || e.key === ',' || e.key === 'Decimal' || e.key === 'Separator')) {
        const start = inputEl.selectionStart || 0;
        const end = inputEl.selectionEnd || 0;
        const before = inputEl.value.slice(0, start);
        const after = inputEl.value.slice(end);
        const prospective = before + '.' + after;
        const dots = (prospective.match(/\./g) || []).length;
        if (dots > 1) { e.preventDefault(); return; }
        return;
      }
      e.preventDefault();
    });

    inputEl.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text') || '';
      const cleaned = sanitize(text);
      const start = inputEl.selectionStart || 0;
      const end = inputEl.selectionEnd || 0;
      const before = inputEl.value.slice(0, start);
      const after = inputEl.value.slice(end);
      const newVal = before + cleaned + after;
      inputEl.value = sanitize(newVal);
      try { const pos = before.length + cleaned.length; inputEl.setSelectionRange(pos, pos); } catch (err) {}
    });
  }

  return { attachNumericFilter };
}

const _numericHelper = createNumericAttacher();
function registerNumericInputs(configs) {
  if (!Array.isArray(configs)) return;
  configs.forEach(cfg => {
    if (!cfg || !cfg.selector) return;
    try {
      let sel = ensureSelector(cfg.selector);
      const nodes = document.querySelectorAll(sel);
      nodes.forEach(node => {
        _numericHelper.attachNumericFilter(node, { type: cfg.type || 'int', allowNegative: cfg.allowNegative !== false });
      });
    } catch (err) { console.warn('registerNumericInputs error for', cfg, err); }
  });
}

/* ================== Tag-input implementation ================== */
/**
 * registerTagInputs(configs)
 * configs: [{ selector:'#tagField', allowDuplicates:false }]
 * - يخفي الحقل الأصلي ويضع واجهة التاجز مكانه، ويخزن القيمة النهائية في الحقل الأصلي مفصولة بفواصل.
 */
function registerTagInputs(configs) {
  if (!Array.isArray(configs)) return;
  configs.forEach(cfg => {
    if (!cfg || !cfg.selector) return;
    try {
      let sel = ensureSelector(cfg.selector);
      const nodes = document.querySelectorAll(sel);
      nodes.forEach(node => {
        // لا تعد التهيئة مرتين
        if (node._amdev_tag_initialized) return;
        node._amdev_tag_initialized = true;

        // options
        const allowDuplicates = cfg.allowDuplicates !== false;

        // hide original input but keep it for form submission
        node.style.display = 'none';
        node.setAttribute('aria-hidden', 'true');

        // create wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'amdev-tag-wrap';

        const tagsList = document.createElement('div');
        tagsList.className = 'amdev-tags-list';

        const visibleInput = document.createElement('input');
        visibleInput.type = 'text';
        visibleInput.className = 'amdev-tag-input';
        visibleInput.placeholder = node.placeholder || 'اكتب تاج واضغط فاصلة أو Enter';
        visibleInput.autocomplete = 'off';

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'amdev-tag-clear';
        clearBtn.textContent = 'مسح الكل';

        wrapper.appendChild(tagsList);
        wrapper.appendChild(visibleInput);
        wrapper.appendChild(clearBtn);

        // insert wrapper after the original input
        node.parentNode.insertBefore(wrapper, node.nextSibling);

        // internal tags array
        const tags = [];

        function updateOriginalInput() {
          node.value = tags.join(','); // comma separated
          // dispatch input event so any listeners get notified
          const ev = new Event('input', { bubbles: true });
          node.dispatchEvent(ev);
        }

        function createTagElement(tagText) {
          const span = document.createElement('span');
          span.className = 'amdev-tag';
          span.textContent = tagText;

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.textContent = '×';
          removeBtn.title = 'حذف';
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = tags.indexOf(tagText);
            if (idx !== -1) {
              tags.splice(idx, 1);
              tagsList.removeChild(span);
              updateOriginalInput();
            }
          });

          span.appendChild(removeBtn);
          return span;
        }

        function addTagRaw(text) {
          let t = String(text || '').trim();
          if (!t) return;
          // if user pasted comma separated values allow splitting
          // but this function handles single tag insertion (split handled elsewhere)
          if (!allowDuplicates && tags.indexOf(t) !== -1) return;
          tags.push(t);
          const el = createTagElement(t);
          tagsList.appendChild(el);
          updateOriginalInput();
        }

        function addTagsFromString(s) {
          if (!s) return;
          // split by comma, semicolon, newline
          const parts = s.split(/[\n,;]+/).map(p => p.trim()).filter(p => p.length > 0);
          parts.forEach(p => addTagRaw(p));
        }

        // input handlers
        visibleInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const val = visibleInput.value.trim();
            if (val) addTagsFromString(val);
            visibleInput.value = '';
            return;
          }
          if (e.key === 'Backspace' && visibleInput.value === '') {
            // remove last tag
            if (tags.length > 0) {
              tags.pop();
              // remove last child
              if (tagsList.lastChild) tagsList.removeChild(tagsList.lastChild);
              updateOriginalInput();
            }
          }
        });

        visibleInput.addEventListener('input', (e) => {
          // optional: prevent commas being typed in the input (we handle them on keydown)
          // but allow user to type normally; no extra action needed
        });

        visibleInput.addEventListener('paste', (e) => {
          e.preventDefault();
          const text = (e.clipboardData || window.clipboardData).getData('text') || '';
          addTagsFromString(text);
          visibleInput.value = '';
        });

        clearBtn.addEventListener('click', () => {
          tags.length = 0;
          tagsList.innerHTML = '';
          updateOriginalInput();
        });

        // Initialize from existing original value if present (comma separated)
        const initial = node.value || '';
        if (initial.trim()) addTagsFromString(initial);

        // focus visible input when wrapper clicked
        wrapper.addEventListener('click', () => visibleInput.focus());
      });
    } catch (err) { console.warn('registerTagInputs error for', cfg, err); }
  });
}

/* ================== auto-init from data attributes (optional) ================== */
document.addEventListener('DOMContentLoaded', () => {
  const autoNodes = document.querySelectorAll('input[data-numeric]');
  autoNodes.forEach(node => {
    const t = (node.getAttribute('data-numeric') || 'int').toLowerCase();
    const allowAttr = node.getAttribute('data-allow-negative');
    const allow = allowAttr === null ? true : (allowAttr === 'true');
    _numericHelper.attachNumericFilter(node, { type: t === 'float' ? 'float' : 'int', allowNegative: allow });
  });
});

/* ================ expose API globally ================ */
window.registerMapInputs = registerMapInputs;
window.registerNumericInputs = registerNumericInputs;
window.registerTagInputs = registerTagInputs;
