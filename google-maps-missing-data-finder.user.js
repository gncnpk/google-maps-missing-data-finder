// ==UserScript==
// @name         Google Maps Missing Data Finder
// @namespace    https://github.com/gncnpk/google-maps-missing-data-finder
// @author       Gavin Canon-Phratsachack (https://github.com/gncnpk)
// @version      0.0.3
// @description  Scan Google Maps using the Nearby Search API for places missing website, phone number, or hours.
// @match        https://*.google.com/maps/*@*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=google.com
// @run-at       document-start
// @license      MIT
// @grant        none
// ==/UserScript==

;
(function() {
    'use strict';

    // Avoid double-inject
    if (document.getElementById('md-panel')) return;

    const STORAGE_KEY = 'md_api_key';
    const STORAGE_WHITE = 'md_whitelist';
    const STORAGE_POS = 'md_panel_pos';
    const STORAGE_SIZE = 'md_panel_size';

    /**
     * Extracts the zoom level from a Google Maps URL of the form
     *    …@<lat>,<lng>,<zoom>z…
     * returns a Number or null if none found.
     */
    function getZoomFromUrl() {
        const m = window.location.href.match(
            /@[-\d.]+,[-\d.]+,([\d.]+)z/
        );
        return m ? parseFloat(m[1]) : null;
    }

    /**
     * Given a zoom level, returns a radius in meters.
     * At baseZoom=10 → baseRadius=50000.
     * Each zoom level ↑ halves the radius.
     * Clamped to [100, 50000].
     */
    function computeRadius(zoom) {
        const baseZoom = 10;
        const baseRadius = 50000;
        if (zoom === null) return baseRadius;
        const r = baseRadius * Math.pow(2, baseZoom - zoom);
        return Math.min(baseRadius, Math.max(100, Math.round(r)));
    }

    // Build panel
    const panel = document.createElement('div');
    panel.id = 'md-panel';
    Object.assign(panel.style, {
        position: 'fixed',
        top: '10px',
        left: '10px',
        width: '360px',
        minWidth: '200px',
        minHeight: '120px',
        background: '#fff',
        border: '1px solid #333',
        borderRadius: '4px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        zIndex: 999999,
        userSelect: 'none',
        fontFamily: 'sans-serif',
        fontSize: '14px',
        resize: 'both',
        overflow: 'auto'
    });
    panel.innerHTML = `
    <div id="md-header" style="
        background:#444;color:#fff;padding:6px 8px;
        display:flex;justify-content:space-between;
        align-items:center;border-radius:4px 4px 0 0;
        cursor:move;">
      <span>Places Missing Data</span>
      <button id="md-close-btn" style="
          background:transparent;border:none;
          color:#fff;font-size:16px;line-height:1;
          cursor:pointer;">×</button>
    </div>
    <div id="md-content" style="padding:8px;">
      <div id="md-key-section" style="margin-bottom:6px;">
        <input id="md-api-key" type="text"
          placeholder="Enter API Key"
          style="width:100%;box-sizing:border-box;
                 padding:4px;border:1px solid #ccc;
                 border-radius:2px;"/>
        <button id="md-set-btn" style="
          width:100%;margin-top:4px;padding:6px;
          background:#28a;color:#fff;border:none;
          border-radius:2px;cursor:pointer;
        ">Set API Key</button>
      </div>
      <div style="margin-bottom:6px;">
        <button id="md-scan-btn" disabled style="
          width:100%;padding:6px;
          background:#28a;color:#fff;border:none;
          border-radius:2px;cursor:pointer;
        ">Scan Nearby</button>
      </div>
      <div id="md-output" style="
          max-height:250px;
          overflow-x:auto;
          overflow-y:auto;
          background:#f9f9f9;padding:6px;
          border:1px solid #ccc;border-radius:2px;
          white-space:nowrap;
      "></div>
    </div>
  `;
    document.body.appendChild(panel);

    // Restore last position
    const rawPos = localStorage.getItem(STORAGE_POS);
    if (rawPos) {
        try {
            const pos = JSON.parse(rawPos);
            if (pos.top) panel.style.top = pos.top;
            if (pos.left) panel.style.left = pos.left;
        } catch {}
    }

    // Restore last size
    const rawSize = localStorage.getItem(STORAGE_SIZE);
    if (rawSize) {
        try {
            const sz = JSON.parse(rawSize);
            if (sz.width) panel.style.width = sz.width;
            if (sz.height) panel.style.height = sz.height;
        } catch {}
    }

    // Track resizes and persist
    const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
            const {
                width,
                height
            } = entry.contentRect;
            localStorage.setItem(
                STORAGE_SIZE,
                JSON.stringify({
                    width: Math.round(width) + 'px',
                    height: Math.round(height) + 'px'
                })
            );
        }
    });
    ro.observe(panel);

    // Drag support via Pointer Events
    const header = document.getElementById('md-header');
    let dragging = false,
        offsetX = 0,
        offsetY = 0;
    header.style.touchAction = 'none';

    header.addEventListener('pointerdown', e => {
        dragging = true;
        const r = panel.getBoundingClientRect();
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    document.addEventListener('pointermove', e => {
        if (!dragging) return;
        panel.style.left = (e.clientX - offsetX) + 'px';
        panel.style.top = (e.clientY - offsetY) + 'px';
    });

    document.addEventListener('pointerup', e => {
        if (!dragging) return;
        dragging = false;
        try {
            header.releasePointerCapture(e.pointerId);
        } catch {}
        // Persist position
        localStorage.setItem(
            STORAGE_POS,
            JSON.stringify({
                left: panel.style.left,
                top: panel.style.top
            })
        );
    });

    header.addEventListener('pointercancel', () => {
        dragging = false;
    });

    // Close button
    document.getElementById('md-close-btn')
        .addEventListener('click', () => panel.remove());

    // Controls
    const keySection = document.getElementById('md-key-section');
    const keyInput = document.getElementById('md-api-key');
    const setBtn = document.getElementById('md-set-btn');
    const scanBtn = document.getElementById('md-scan-btn');
    const output = document.getElementById('md-output');

    // Load API key
    if (localStorage.getItem(STORAGE_KEY)) {
        keySection.style.display = 'none';
        scanBtn.disabled = false;
    }

    // Whitelist
    let whitelist = [];
    try {
        const w = JSON.parse(localStorage.getItem(STORAGE_WHITE) || '[]');
        if (Array.isArray(w)) whitelist = w;
    } catch {}

    function persistWhitelist() {
        localStorage.setItem(STORAGE_WHITE, JSON.stringify(whitelist));
    }

    // Set API key
    setBtn.addEventListener('click', () => {
        const k = keyInput.value.trim();
        if (!k) return alert('Please enter a valid API key.');
        localStorage.setItem(STORAGE_KEY, k);
        keySection.style.display = 'none';
        scanBtn.disabled = false;
    });

    // Field labels
    const FIELD_LABELS = {
        websiteUri: 'Website',
        nationalPhoneNumber: 'Phone number',
        currentOpeningHours: 'Hours'
    };

    function getPlaceName(p) {
        const d = p.displayName;
        if (typeof d === 'string') return d;
        if (d && typeof d.text === 'string') return d.text;
        if (d && typeof d.name === 'string') return d.name;
        return p.id;
    }

    function findMissing(arr) {
        return arr.reduce((acc, p) => {
            const miss = [];
            if (!p.websiteUri ||
                !p.websiteUri.trim()) miss.push(
                FIELD_LABELS.websiteUri
            );
            if (!p.nationalPhoneNumber ||
                !p.nationalPhoneNumber.trim()) miss.push(
                FIELD_LABELS.nationalPhoneNumber
            );
            if (!p.currentOpeningHours ||
                typeof p.currentOpeningHours !== 'object') miss.push(
                FIELD_LABELS.currentOpeningHours
            );
            if (miss.length) {
                // capture primaryType if present
                const typeName = p.primaryTypeDisplayName?.text || ''
                acc.push({
                    id: p.id,
                    name: getPlaceName(p),
                    uri: p.googleMapsUri,
                    missing: miss,
                    primaryTypeDisplayName: typeName
                });
            }
            return acc;
        }, []);
    }

    // Scan action
    scanBtn.addEventListener('click', async () => {
        output.textContent = '';
        const key = localStorage.getItem(STORAGE_KEY);
        if (!key) {
            output.textContent = '❌ API key missing.';
            return;
        }

        // Parse coords
        let lat, lng;
        try {
            const part = window.location.href.split('@')[1].split('/')[0];
            [lat, lng] = part.split(',').map(n => parseFloat(n));
            if (isNaN(lat) || isNaN(lng)) throw 0;
        } catch {
            output.textContent =
                '❌ Could not parse "@lat,lng" from URL.';
            return;
        }

        const zoom = getZoomFromUrl();
        const radius = computeRadius(zoom);

        const body = {
            locationRestriction: {
                circle: {
                    center: {
                        latitude: lat,
                        longitude: lng
                    },
                    radius: radius
                }
            },
            rankPreference: "DISTANCE"
        };

        // Fetch
        let data;
        try {
            const res = await fetch(
                `https://places.googleapis.com/v1/places:searchNearby?key=` +
                `${encodeURIComponent(key)}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Goog-FieldMask': 'places.id,' +
                            'places.displayName,' +
                            'places.websiteUri,' +
                            'places.nationalPhoneNumber,' +
                            'places.currentOpeningHours,' +
                            'places.googleMapsUri,' +
                            'places.primaryTypeDisplayName'
                    },
                    body: JSON.stringify(body)
                }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = await res.json();
        } catch (err) {
            output.textContent = '❌ Fetch error: ' + err.message;
            return;
        }

        const arr = Array.isArray(data.places) ? data.places :
            Array.isArray(data.results) ? data.results : [];

        let missing = findMissing(arr)
            .filter(p => !whitelist.includes(p.id));

        if (!missing.length) {
            output.textContent =
                '✅ All places have website, Phone number & hours.';
            return;
        }

        // Render list
        const ul = document.createElement('ul');
        ul.style.listStyle = 'disc';
        ul.style.margin = '0';
        ul.style.padding = '0 0 0 1em';

        missing.forEach(p => {
            const li = document.createElement('li');
            li.style.whiteSpace = 'nowrap';
            li.style.marginBottom = '6px';

            const a = document.createElement('a');
            a.href = p.uri;
            a.textContent = p.name;
            a.target = '_blank';
            a.style.fontWeight = 'bold';
            li.appendChild(a);

            // show type next to the link
            if (p.primaryTypeDisplayName) {
                li.appendChild(
                    document.createTextNode(
                        ` (${p.primaryTypeDisplayName})`
                    )
                );
            }
            // then show missing fields
            li.appendChild(
                document.createTextNode(
                    ' – missing: ' + p.missing.join(', ')
                )
            );

            const btn = document.createElement('button');
            btn.textContent = 'Whitelist';
            btn.style.background = '#28a';
            btn.style.color = '#fff';
            btn.style.border = 'none';
            btn.style.borderRadius = '2px';
            btn.style.padding = '2px 8px';
            btn.style.cursor = 'pointer';
            btn.style.marginLeft = '8px';
            btn.addEventListener('click', () => {
                if (!whitelist.includes(p.id)) {
                    whitelist.push(p.id);
                    persistWhitelist();
                }
                li.remove();
                if (!ul.childElementCount) {
                    output.textContent =
                        '✅ All places have website, Phone number & hours.';
                }
            });
            li.appendChild(btn);

            ul.appendChild(li);
        });

        output.innerHTML = '';
        output.appendChild(ul);
    });
})();
