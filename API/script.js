'use strict';

(() => {
    const CONFIG = {
        API_SEARCH: 'https://api.sketchfab.com/v3/search?type=models',
        API_BASE: 'https://api.sketchfab.com/v3/models',
        VIEWER_SRC: 'https://static.sketchfab.com/api/sketchfab-viewer-1.12.1.js',
        QUERIES: ['sony alpha', 'sony alpha camera', 'sony a7', 'sony a7 iii', 'sony a7 iv', 'sony a7r', 'sony a7r iv', 'sony a7r v', 'sony a7s', 'sony a7c', 'sony a6000', 'sony a6400', 'sony a6600', 'sony a6700', 'sony a1', 'sony a9', 'sony ilce'],
        SCAN: /photogrammetry|3d ?scan|\bscan(ned)?\b|reality ?capture|polycam|luma|nerf|gaussian/i,
        EXCLUDE: /\b(mdr|wh-?1000|headphones?|earbuds?|box|playstation|ps[2345]|bravia|walkman|xperia|controller|tv)\b/i,
        HIDE: /^camera a7s iii$/i,
        PREFER: [/sony alpha 3\b/i, /ilce-?\s?7rm3|a7r\s?(iii|3|m3)\b/i],
        TIMEOUT_MS: 20000,
        VIEWER_TIMEOUT_MS: 25000,
        MAX_COMPARE: 3,
        GALLERY_PAGE: 9999,
        MAX_EXPLODE_PARTS: 80
    };
    const NA = 'Not Available';
    const SERIES_ORDER = ['Alpha 1', 'Alpha 7', 'Alpha 7R', 'Alpha 7S', 'Alpha 7C', 'Alpha 9', 'Alpha 6000 Series', 'Other Alpha'];

    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const storage = {
        get(key, fallback) { try { const v = localStorage.getItem('alphaform.' + key) || localStorage.getItem('sonova.' + key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
        set(key, value) { try { localStorage.setItem('alphaform.' + key, JSON.stringify(value)); } catch (e) { } }
    };
    const clean = (v) => {
        if (v === null || v === undefined || typeof v === 'object') return null;
        const s = String(v).replace(/\s+/g, ' ').trim();
        return s || null;
    };
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const fmtNum = (v) => (num(v) === null ? null : v.toLocaleString('en-US'));
    const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
    const fmtDate = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null; };
    const cell = (v) => (v ? esc(v) : `<span class="na" title="Not provided by the data source">${NA}</span>`);
    const cellHTML = (html) => html || `<span class="na" title="Not provided by the data source">${NA}</span>`;
    let toastTimer = 0;
    function toast(msg) {
        const t = $('#toast'); if (!t) return;
        t.textContent = msg; t.classList.add('show');
        clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
    }

    const Api = {
        async getJSON(url) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);
            try {
                const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
                if (!res.ok) { const he = new Error(`Sketchfab responded with HTTP ${res.status}.`); he.status = res.status; throw he; }
                try { return await res.json(); } catch (e) { throw new Error('Sketchfab returned something that is not valid JSON.'); }
            } catch (err) {
                if (err && err.name === 'AbortError') throw new Error('Sketchfab took too long to respond.');
                if (err instanceof TypeError) throw new Error('Could not reach Sketchfab (network or browser restriction).');
                throw err;
            } finally { clearTimeout(timer); }
        },
        async searchModels(q) {
            const enc = encodeURIComponent(q);
            const urls = [
                `${CONFIG.API_SEARCH}&q=${enc}&count=24&sort_by=-likeCount`,
                `${CONFIG.API_BASE}?q=${enc}&count=24&sort_by=-likeCount`
            ];
            let lastErr;
            for (const url of urls) {
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        const data = await Api.getJSON(url);
                        if (!data || !Array.isArray(data.results)) throw new Error('Unexpected response: a list of models was expected.');
                        return data.results.filter((r) => r && typeof r === 'object' && typeof r.uid === 'string' && typeof r.name === 'string');
                    } catch (e) {
                        lastErr = e;
                        if (e && e.status === 429) { await sleep(1200 * (attempt + 1)); continue; }
                        break;
                    }
                }
            }
            throw lastErr;
        },
        async fetchCameras() {
            const rows = []; let okCount = 0; let firstErr = null;
            const queries = Array.from(new Set(CONFIG.QUERIES.concat(SPECS.map((sp) => 'sony ' + sp.name.replace(/ \(.*$/, '').toLowerCase()))));
            for (let i = 0; i < queries.length; i += 5) {
                const batch = queries.slice(i, i + 5);
                const settled = await Promise.allSettled(batch.map(Api.searchModels));
                settled.forEach((r) => { if (r.status === 'fulfilled') { okCount++; rows.push(...r.value); } else if (!firstErr) firstErr = r.reason; });
                if (i + 5 < queries.length) await sleep(120);
            }
            if (!okCount) throw firstErr || new Error('No response from Sketchfab.');
            return rows;
        },
        _viewer: null,
        loadViewerScript() {
            if (window.Sketchfab) return Promise.resolve();
            if (!Api._viewer) {
                Api._viewer = new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = CONFIG.VIEWER_SRC; s.async = true;
                    s.onload = () => (window.Sketchfab ? resolve() : reject(new Error('The Sketchfab viewer script loaded but did not start.')));
                    s.onerror = () => { Api._viewer = null; reject(new Error('The Sketchfab viewer script could not be loaded.')); };
                    document.head.appendChild(s);
                });
            }
            return Api._viewer;
        }
    };

    const FF = 'Full frame'; const AP = 'APS-C';
    const L = (t, n, u) => ({ t, n, u });
    const AP_ = (p) => L('Camera database', 'Apotelyt', 'https://apotelyt.com/compare-camera/' + p);
    const SONY_A7IV = { t: 'Official Sony product page', n: 'Sony (Australia): ILCE-7M4 specifications', u: 'https://www.sony.com.au/interchangeable-lens-cameras/products/ilce-7m4/spec', off: true };
    const SONY_7R3 = { t: 'Official Sony product page', n: 'Sony (Philippines): ILCE-7RM3 specifications', u: 'https://www.sony.com.ph/electronics/interchangeable-lens-cameras/ilce-7rm3/specifications', off: true };
    const U = {
        a1_a9iii: AP_('sony-a7-iv-vs-sony-a9-iii'), a7ii: AP_('sony-a7r-v-vs-sony-a9-iii'), a7rv: AP_('sony-a7r-iv-vs-sony-a9-iii'),
        a1ii: AP_('sony-a1-ii-vs-sony-a7s-iii'), a7c: AP_('sony-a7-iii-vs-sony-a7r-v'), a64: AP_('sony-a6400-vs-sony-a6600'),
        a63: AP_('sony-a6500-vs-sony-a6300'), a63b: AP_('sony-a6300-vs-sony-a6700'), a6700: AP_('sony-a6600-vs-sony-a6700'),
        a7riii: L('Camera database', 'Apotelyt', 'https://apotelyt.com/camera-specs/sony-a7s-iii-sensor-resolution'),
        wex: L('Retailer guide', 'Wex Photo Video', 'https://repair.wexphotovideo.com/tag/e-mount/'),
        dcw: L('Magazine guide', 'Digital Camera World', 'https://www.digitalcameraworld.com/uk/buying-guides/sony-a6000-vs-a6100-vs-a6300-vs-a6400-vs-a6500-vs-a6600-how-do-you-choose'),
        dcw6100: L('Magazine', 'Digital Camera World', 'https://www.digitalcameraworld.com/uk/news/new-sony-a6100-and-a6600-breathe-new-life-into-sonys-aps-c-mirrorless-range'),
        dcw6700: L('Magazine', 'Digital Camera World', 'https://www.digitalcameraworld.com/news/sony-unveils-its-latest-hybrid-champion-the-sony-a6700'),
        shop: L('Retailer listing', 'Cameramall', 'https://cameramall.com/collections/sony-full-frame-cameras-flyer'),
        cr: L('Camera database', 'Peter Walkenhorst', 'https://peterwalkenhorst.com/compare-camera/sony-a1-ii-vs-sony-a7-iv'),
        s3: L('Review site', 'Alpha Shooters', 'https://www.alphashooters.com/web-stories/sony-a7siii-vs-a7iv-ws'),
        wiki: L('Encyclopedia', 'Wikipedia (via Wikiwand)', 'https://wikiwand.com/en/Sony_%CE%B17'),
        gear: L('Reference', 'Gearframe', 'https://gearframe.net/cameras/series/sony-a6x00-series/'),
        ir4: L('Camera database', 'Imaging Resource', 'https://www.imaging-resource.com/PRODS/sony-a7-iv/sony-a7-ivDAT.HTM'),
        pr4: L('Press release (Sony Electronics, 21 Oct 2021, mirrored)', 'Sony A7 IV press release', 'https://cameradecision.com/blog/Sony-A7-Mark-IV-Official-Press-Release')
    };
    const SPECS = [

        ['a7', 'Alpha 7', 1, null, 'Full frame (35.8 × 23.9 mm)', '24', '6000 × 4000', null, null, null, null, null, [U.wiki]],
        ['a7r', 'Alpha 7R', 2, null, null, null, null, null, null, null, null, null, []],
        ['a7s', 'Alpha 7S', 3, null, null, null, null, null, null, null, null, null, []],
        ['a6000', 'Alpha 6000', 4, 2014, AP, '24.0', '6000 × 4000', null, '1080/60p', null, null, null, [U.a63, U.gear]],
        ['a7ii', 'Alpha 7 II', 5, null, FF, '24.0', '6000 × 4000', null, '1080/60p', null, null, null, [U.a7ii]],
        ['a7rii', 'Alpha 7R II', 6, null, FF, '42.2', '7952 × 5304', null, '4K/30p', null, null, null, [U.a7ii]],
        ['a7sii', 'Alpha 7S II', 7, null, FF, '12.0', '4240 × 2832', '100–102,400 (ext. 50–409,600)', '4K/30p', 5, null, null, [U.a1_a9iii, U.wex]],
        ['a6300', 'Alpha 6300', 8, 2016, AP, '24.0', '6000 × 4000', '100–25,600 (ext. 100–51,200)', '4K/30p', null, null, null, [U.a63b, U.dcw]],
        ['a6500', 'Alpha 6500', 9, 2016, AP, '24.0', '6000 × 4000', null, '4K/30p', null, null, null, [U.a63, U.gear]],
        ['a9', 'Alpha 9', 10, null, FF, '24.0', '6000 × 4000', null, '4K/30p', null, null, null, [U.a7ii]],
        ['a7riii', 'Alpha 7R III', 11, null, FF, '42.2', '7952 × 5304', '100–32,000 (ext. 50–102,400)', '4K/30p', 10, null, null, [U.a7riii, U.wex]],
        ['a7iii', 'Alpha 7 III', 12, 2018, FF, '24.0', '6000 × 4000', null, '4K/30p', null, null, null, [U.a7c]],
        ['a6400', 'Alpha 6400', 13, 2019, AP, '24.0', '6000 × 4000', '100–32,000 (ext. 100–102,400)', '4K/30p', null, null, null, [U.a64, U.dcw]],
        ['a7riv', 'Alpha 7R IV', 14, null, FF, '60.2', '9504 × 6336', null, '4K/30p', null, null, null, [U.a1_a9iii]],
        ['a6100', 'Alpha 6100', 15, 2019, AP, '24.2', '6000 × 4000', '100–32,000 (ext. 51,200 for stills)', '4K', null, null, '425 phase-detection + 425 contrast-detection points', [U.dcw6100, U.dcw]],
        ['a6600', 'Alpha 6600', 16, 2019, AP, '24.0', '6000 × 4000', '100–32,000 (ext. 100–102,400)', '4K/30p', null, null, '425 phase-detection + 425 contrast-detection points', [U.a64, U.dcw6100]],
        ['a9ii', 'Alpha 9 II', 17, null, FF, '24.0', '6000 × 4000', null, '4K/30p', null, null, null, [U.a7ii]],
        ['a7siii', 'Alpha 7S III', 18, 2020, FF, '12.0', '4240 × 2832', 'Movie 80–102,400 (ext. 409,600)', '4K/120p', null, null, null, [U.a1ii, U.s3]],
        ['a7c', 'Alpha 7C', 19, null, FF, '24.0', '6000 × 4000', null, '4K/30p', null, null, null, [U.a7c]],
        ['a1', 'Alpha 1', 20, null, FF, '49.8', '8640 × 5760', null, '8K/30p', null, null, null, [U.a1_a9iii]],
        ['a7iv', 'Alpha 7 IV (ILCE-7M4)', 21, 2021, 'Full frame (35.9 × 23.9 mm), back-illuminated Exmor R CMOS', '33 (effective)', '7008 × 4672', '100–51,200 (ext. 50–204,800)', '4K/60p', 10, '5-axis sensor-shift, up to 5.5 stops', '759 phase-detection + 425 contrast-detection points', [SONY_A7IV, U.pr4, U.ir4, U.a1_a9iii]],
        ['a7rv', 'Alpha 7R V', 22, 2022, FF, '60.2', '9504 × 6336', null, '8K/24p', null, null, null, [U.a7ii, U.a7rv]],
        ['a6700', 'Alpha 6700', 23, 2023, 'APS-C (BSI CMOS)', '26', '6192 × 4128', '100–32,000 (ext. 50–102,400)', '4K/120p', null, '5-axis in-body', null, [U.dcw6700, U.a6700]],
        ['a9iii', 'Alpha 9 III', 24, 2023, FF, '24.0', '6000 × 4000', '250–25,600 (ext. 125–51,200)', '4K/120p', null, null, null, [U.a1_a9iii, U.a7ii]],
        ['a7cii', 'Alpha 7C II', 25, null, FF, '33', null, 'up to 204,800', '4K/30p (10-bit)', 10, null, null, [U.shop]],
        ['a7cr', 'Alpha 7CR', 26, null, FF, '60.2', '9504 × 6336', null, '4K/60p', null, null, null, [U.cr]],
        ['a1ii', 'Alpha 1 II', 27, 2024, FF, '49.8', '8640 × 5760', 'up to 102,400', '8K/30p, 4K/120p', 30, '5-axis', null, [U.a1ii, U.shop]],
        ['a7v', 'Alpha 7 V', 28, null, FF, '33', null, '100–51,200 (ext. up to 204,800)', '4K/60p, up to 4K/120p', 30, null, null, [U.shop]]
    ].map(([key, name, o, year, sensor, mp, px, iso, video, fps, stab, af, src]) => ({ key, name, o, year, sensor, mp, px, iso, video, fps, stab, af, src }));
    const NC = '<span class="na" title="Not confirmed by the cited sources">Not confirmed</span>';
    const specCell = (v) => (v ? esc(String(v)) : NC);
    const dash = (v) => (v ? esc(String(v)) : '<span class="dash" title="Not stated by the cited sources">—</span>');
    const specList = (sp) => [['Release year', sp.year], ['Lens mount', 'Sony E-mount'], ['Sensor', sp.sensor], ['Megapixels', sp.mp && sp.mp + ' MP'], ['Max photo size', sp.px], ['Image processor', sp.proc], ['ISO range', sp.iso],
    ['Autofocus', sp.af], ['Image stabilization', sp.stab], ['Continuous shooting', sp.fps && 'up to ' + sp.fps + ' fps'], ['Max video', sp.video],
    ['Viewfinder', sp.evf], ['LCD screen', sp.lcd], ['Memory cards', sp.cards], ['Connectivity', sp.conn], ['Battery', sp.batt], ['Dimensions', sp.dim], ['Weight', sp.wt], ['Weather sealing', sp.seal]];
    const TAB_FIELDS = {
        overview: ['Release year', 'Lens mount', 'Dimensions', 'Weight', 'Weather sealing'],
        sensor: ['Sensor', 'Megapixels', 'Max photo size', 'Image processor', 'ISO range'],
        af: ['Autofocus', 'Image stabilization', 'Continuous shooting'],
        video: ['Max video'],
        body: ['Viewfinder', 'LCD screen', 'Memory cards', 'Connectivity', 'Battery']
    };
    const srcLinks = (sp) => sp.src.length
        ? '<ul class="sources__list">' + sp.src.map((x) => `<li><a class="src" href="${esc(x.u)}" target="_blank" rel="noopener noreferrer"><span class="src__n">${esc(x.n)}</span><span class="src__t">${esc(x.t)}</span><span class="sr-only"> (opens in a new tab)</span></a></li>`).join('') + '</ul>'
        : '<span class="na">No source found yet</span>';
    const SAMPLES = {
        a7riii: [
            { n: 'The Digital Picture', t: 'Sample photos from the Sony α7R III, with camera and lens settings', u: 'https://www.the-digital-picture.com/Reviews/Sample-Pictures.aspx?Equipment=1175' },
            { n: 'Mirrorless Comparison', t: 'Twenty α7R III sample images with lens and exposure data', u: 'https://mirrorlesscomparison.com/galleries/sony-a7riii-sample-images/' },
            { n: 'Imaging Resource', t: 'Real-world α7R III gallery shot in New York', u: 'https://www.imaging-resource.com/news/2017/10/26/sony-a7r-iii-gallery-images-real-world-photos-straight-from-nyc' },
            { n: 'Sony Photo Gallery', t: 'Official Sony gallery for the ILCE-7RM3', u: 'https://www.sony.co.jp/en/Products/di_photo-gallery/camera/ILCE-7RM3/' }],
        a7iii: [
            { n: 'The Digital Picture', t: 'Sample photos from the Sony Alpha 7 III', u: 'https://www.the-digital-picture.com/Reviews/Sample-Pictures.aspx?Equipment=1194' },
            { n: 'Mirrorless Comparison', t: 'Nine α7 III sample images with lens and settings', u: 'https://mirrorlesscomparison.com/galleries/sony-a7iii-sample-shots/' },
            { n: 'Alpha Shooters', t: 'α7 III sample images with full-resolution downloads', u: 'https://www.alphashooters.com/cameras/a7iii/sample-images/' }]
    };
    const sampleHTML = (cam) => { const l = cam.spec && SAMPLES[cam.spec.key]; return l ? `<section class="samples"><h4>Sample photos</h4><ul class="sources__list">${l.map((x) => `<li><a class="src" href="${esc(x.u)}" target="_blank" rel="noopener noreferrer"><span class="src__n">${esc(x.n)}</span><span class="src__t">${esc(x.t)}</span><span class="sr-only"> (opens in a new tab)</span></a></li>`).join('')}</ul></section>` : ''; };
    const W = (o) => o;
    const OVR = {
        a7: W({ year: 2013, mp: '24.3', px: '6000 × 4000', iso: '100–25,600', af: '25 contrast + 117 phase-detection points', stab: 'None', wt: '474 g with battery and card', fps: 5, video: '1080p' }),
        a7r: W({ year: 2013, sensor: 'Full frame', mp: '36.4', px: '7360 × 4912', iso: '100–25,600', af: '25 contrast-detection points', stab: 'None', wt: '465 g with battery and card', fps: 4, video: '1080p' }),
        a7s: W({ year: 2014, sensor: 'Full frame', mp: '12.2', px: '4240 × 2832', iso: '100–102,400 (ext. 50–409,600)', af: '25 contrast-detection points', stab: 'None', wt: '489 g with battery and card' }),
        a7ii: W({ year: 2014, mp: '24.3', iso: '100–25,600', af: '25 contrast + 117 phase-detection points', stab: '5-axis in-body', wt: '599 g with battery and card' }),
        a7rii: W({ year: 2015, mp: '42.4', iso: '100–25,600 (ext. 50–102,400)', af: '25 contrast + 399 phase-detection points', stab: '5-axis in-body', wt: '625 g with battery and card' }),
        a7sii: W({ year: 2015, mp: '12.2', af: '169 contrast-detection points', stab: '5-axis in-body', wt: '627 g with battery and card' }),
        a7riii: W({ year: 2017, sensor: 'Full frame (35.9 × 24.0 mm) Exmor R CMOS', mp: '42.4', px: '7952 × 5304', proc: 'BIONZ X with front-end LSI', iso: '100–32,000 (ext. 50–102,400)', af: '399 phase-detection + 425 contrast-detection points (about 47% coverage)', stab: '5-axis in-body', fps: 10, video: '4K/30p (XAVC S); Full HD up to 120p', evf: '3.69 million-dot Quad-VGA OLED, 0.78x', batt: 'NP-FZ100', wt: '657 g with battery and card' }),
        a7iii: W({ mp: '24.2', iso: '100–51,200 (ext. 50–204,800)', af: '425 contrast + 693 phase-detection points', stab: '5-axis in-body', wt: '650 g with battery and card' }),
        a7riv: W({ year: 2019, mp: '61.0', iso: '100–32,000 (ext. 50–102,400)', af: '425 contrast + 567 phase-detection points', stab: '5-axis in-body', wt: '665 g with battery and card' }),
        a7siii: W({ mp: '12.1', iso: '80–102,400 (ext. 40–409,600)', af: '425 contrast + 759 phase-detection points', stab: '5-axis in-body', wt: '699 g with battery and card' }),
        a7c: W({ year: 2020, mp: '24.2', iso: '100–51,200 (ext. 50–204,800)', af: '425 contrast + 693 phase-detection points', stab: '5-axis in-body', wt: '509 g with battery and card' }),
        a7iv: W({ af: '759 phase-detection + 425 contrast-detection points', wt: '658 g with battery and card', proc: 'BIONZ XR', evf: '3.68 million-dot OLED', lcd: '3.0-inch vari-angle touchscreen', cards: 'Two slots: CFexpress Type A / SD (UHS-I, UHS-II)', conn: 'USB-C, HDMI, 3.5 mm headphone jack, Wi-Fi, Bluetooth', batt: 'NP-FZ100', dim: '131.3 × 96.4 × 79.8 mm', seal: 'Weather-sealed magnesium-alloy body' }),
        a7rv: W({ mp: '61.0', iso: '100–32,000 (ext. 50–102,400)', af: '425 contrast + 693 phase-detection points', stab: '5-axis in-body', wt: '723 g with battery and card' }),
        a7cii: W({ year: 2023, mp: '33.0', px: '7008 × 4672', iso: '100–51,200 (ext. 50–204,800 stills)', af: '759 hybrid points (stills), 627 (video)', stab: '5-axis in-body', wt: '514 g with battery and card' }),
        a7cr: W({ year: 2023, mp: '61.0', iso: '100–32,000 (ext. 50–102,400 stills)', af: '693 hybrid points (stills and video)', stab: '5-axis in-body', fps: 8, wt: '515 g with battery and card' })
    };
    SPECS.forEach((sp) => { const o = OVR[sp.key]; if (o) Object.assign(sp, o); });
    const mentions = (u, k) => { const t = u.toLowerCase().split(/[^a-z0-9]+/); return t.some((_, i) => { let s = ''; for (let n = i; n < t.length && s.length < k.length; n++) { s += t[n]; if (s === k) return !/^(i{1,3}|iv|v|r|s|c)$/.test(t[n + 1] || ''); } return false; }); };
    SPECS.forEach((sp) => { if (sp.key === 'a7riii') sp.src.unshift(SONY_7R3); });
    SPECS.forEach((sp) => { sp.src = sp.src.filter((x) => x.off || mentions(x.u, sp.key) || (sp.key === 'a7' && x === U.wiki)); });
    const SPEC_BY_LEN = SPECS.slice().sort((a, b) => b.key.length - a.key.length);
    function matchSpec(name) {
        let n = name.toLowerCase().replace(/α|alpha/g, 'a').replace(/mark|mk|camera|body/g, '').replace(/[^a-z0-9]/g, '');
        n = n.replace(/(?:ilce|a)7([rsc]?)m([2-5])(?!\d)/, (m, l, d) => 'a7' + l + ['', '', 'ii', 'iii', 'iv', 'v'][d]);
        n = n.replace(/(a7[rsc]?|a9|a1)([2-5])(?!\d)/, (m, a, d) => a + ['', '', 'ii', 'iii', 'iv', 'v'][d]);
        return SPEC_BY_LEN.find((s) => new RegExp('(?:^|[^a-z0-9])?' + s.key + '(?![0-9])').test(n) && !(s.key === 'a1' && /a1\d/.test(n))) || null;
    }

    function detectSeries(name) {
        const m = name.toLowerCase().replace(/α/g, 'alpha ');
        const t = m.match(/(?:^|[^a-z0-9])(?:alpha|ilce|a)[\s-]*(\d{1,4})([rsc]?)/);
        if (t) {
            const n = t[1]; const l = t[2];
            if (n === '1') return 'Alpha 1';
            if (n === '7') return l === 'r' ? 'Alpha 7R' : l === 's' ? 'Alpha 7S' : l === 'c' ? 'Alpha 7C' : 'Alpha 7';
            if (n === '9') return 'Alpha 9';
            if (/^6\d{3}$/.test(n)) return 'Alpha 6000 Series';
        }
        return /alpha|ilce/.test(m) ? 'Other Alpha' : null;
    }

    function thumbList(rec) {
        const imgs = rec.thumbnails && Array.isArray(rec.thumbnails.images) ? rec.thumbnails.images : [];
        return imgs.map((i) => ({ url: safeUrl(i && i.url), w: num(i && i.width) || 0 })).filter((i) => i.url).sort((a, b) => a.w - b.w);
    }
    const THUMB_FALLBACK = new Map();
    const pickThumb = (list, minW) => { if (!list.length) return null; return (list.find((i) => i.w >= minW) || list[list.length - 1]).url; };

    function cleanDescription(d, name) {
        let t = clean(d); if (!t) return null;
        const rest = t.split(name).join('').replace(/[\s,.;:|/-]+/g, '');
        if (rest.length < 8) return null;
        return t.length > 600 ? t.slice(0, 600).trim() + '…' : t;
    }
    function normalize(rec) {
        const user = rec.user && typeof rec.user === 'object' ? rec.user : {};
        const lic = rec.license && typeof rec.license === 'object' ? rec.license : {};
        const tags = Array.isArray(rec.tags) ? rec.tags.map((t) => clean(t && t.name)).filter(Boolean) : [];
        const thumbs = thumbList(rec);
        const chain = thumbs.map((t) => t.url).reverse();
        chain.forEach((u, i) => { if (chain[i + 1] && !THUMB_FALLBACK.has(u)) THUMB_FALLBACK.set(u, chain[i + 1]); });
        const name = clean(rec.name) || 'Untitled model';
        const series = detectSeries(name);
        const cam = {
            id: rec.uid, name, series, tags,
            author: clean(user.displayName) || clean(user.username),
            authorUrl: safeUrl(user.profileUrl),
            license: clean(lic.label), licenseUrl: safeUrl(lic.uri),
            viewerUrl: safeUrl(rec.viewerUrl), description: cleanDescription(rec.description, name),
            faces: num(rec.faceCount), vertices: num(rec.vertexCount), animations: num(rec.animationCount),
            likes: num(rec.likeCount), views: num(rec.viewCount), comments: num(rec.commentCount),
            published: clean(rec.publishedAt), publishedMs: Date.parse(rec.publishedAt) || null,
            downloadable: typeof rec.isDownloadable === 'boolean' ? rec.isDownloadable : null,
            thumb: pickThumb(thumbs, 640), thumbHero: pickThumb(thumbs, 1024), thumbLarge: pickThumb(thumbs, 1600)
        };
        cam.spec = matchSpec(name);
        cam.hasSony = /sony/i.test(name) || tags.some((t) => /sony/i.test(t));
        return cam;
    }

    function buildCatalog(rows) {
        const seen = new Set(); const out = [];
        rows.forEach((rec) => {
            if (seen.has(rec.uid)) return; seen.add(rec.uid);
            const cam = normalize(rec);
            if (cam.series && cam.hasSony && !CONFIG.HIDE.test(cam.name) && !CONFIG.EXCLUDE.test(cam.name) && !CONFIG.SCAN.test(cam.name + ' ' + cam.tags.join(' '))) out.push(cam);
        });
        return out;
    }

    const state = {
        cameras: [], byId: new Map(), filtered: [], loading: false,
        favs: new Set(storage.get('favs', [])),
        compare: storage.get('compare', []),
        prefs: Object.assign({ q: '', series: 'all', license: 'all', sort: 'old' }, storage.get('prefs', {})),
        galleryShown: CONFIG.GALLERY_PAGE
    };
    const byId = (id) => state.byId.get(id);

    const SERIES_BLURB = {
        'Alpha 1': 'Sony’s flagship full-frame body, built for speed and resolution together.',
        'Alpha 7': 'The all-round full-frame line, balanced for photo and video.',
        'Alpha 7R': 'The high-resolution full-frame line, made for detail.',
        'Alpha 7S': 'The low-light and video full-frame line, with a lower-resolution sensor for clean high ISO.',
        'Alpha 7C': 'The compact full-frame line, in a smaller body.',
        'Alpha 9': 'The speed-focused full-frame line, made for sports and action.',
        'Alpha 6000 Series': 'Compact APS-C cameras with fast autofocus.',
        'Other Alpha': 'A Sony Alpha mirrorless camera.'
    };
    const sensorClass = (series) => (series === 'Alpha 6000 Series' ? 'APS-C' : series === 'Other Alpha' ? null : 'Full frame');
    function describeCam(cam) {
        const base = SERIES_BLURB[cam.series] || SERIES_BLURB['Other Alpha'];
        const sp = cam.spec; if (!sp) return base;
        const feats = [];
        if (sp.mp) feats.push(sp.mp.replace(/ \(.*$/, '') + ' MP sensor');
        if (sp.stab && sp.stab !== 'None') feats.push('in-body stabilization');
        if (sp.video) feats.push('video up to ' + sp.video.split(',')[0].trim());
        let t = base;
        if (feats.length) t += ` The ${sp.name.replace(/ \(.*$/, '')} has ${feats.length > 1 ? feats.slice(0, -1).join(', ') + ' and ' + feats[feats.length - 1] : feats[0]}.`;
        if (sp.year) t += ` Released in ${sp.year}.`;
        return t;
    }

    const noImgHTML = () => '<div class="noimg" role="img" aria-label="Image not available"><span>Image Not Available</span></div>';
    const altFor = (cam) => `Preview image of the 3D model “${cam.name}”${cam.author ? ' by ' + cam.author : ''}, from Sketchfab`;
    const imgHTML = (cam, cls, large, eager) => {
        const src = large ? (cam.thumbLarge || cam.thumb) : cam.thumb;
        return src ? `<img class="${cls}" data-cam-img src="${esc(src)}" alt="${esc(altFor(cam))}" loading="${eager ? 'eager' : 'lazy'}" decoding="async">` : noImgHTML();
    };
    const linkOrText = (text, url) => (text ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text)) : null);

    function tileHTML(cam, i) {
        const sp = cam.spec;
        const real = sp ? [['Year', sp.year], ['Megapixels', sp.mp && sp.mp + ' MP'], ['ISO', sp.iso && sp.iso.replace(/ \(.*$/, '')], ['Video', sp.video], ['Sensor', sp.sensor && sp.sensor.replace(/ \(.*$/, '')], ['Stabilization', sp.stab]].filter(([, v]) => v).slice(0, 4) : [];
        const specs = real.length ? real : [['Series', cam.series], ['Sensor', sensorClass(cam.series)]];
        return `<article class="tile reveal" style="--d:${(i % 6) * 60}ms" data-id="${cam.id}" data-series="${esc(cam.series)}">
      <button type="button" class="tile__media" data-action="details" data-id="${cam.id}" aria-label="View details for ${esc(cam.name)}">${imgHTML(cam, 'tile__img', false, i < 3)}</button>
      <div class="tile__body">
        <p class="eyebrow" data-series="${esc(cam.series)}">${esc(cam.series)}</p>
        <h3 class="tile__title">${esc(cam.name)}</h3>
        <p class="tile__desc">${esc(SERIES_BLURB[cam.series] || SERIES_BLURB['Other Alpha'])}</p>
        <dl class="mini">${specs.map(([k, v]) => `<div><dt>${k}</dt><dd>${cell(v)}</dd></div>`).join('')}</dl>
        <div class="tile__actions">
          <button class="btn btn--primary btn--sm" type="button" data-action="details" data-id="${cam.id}">View Details</button>
          <button class="btn btn--ghost btn--sm" type="button" data-action="compare" data-id="${cam.id}" aria-pressed="false">Add to Compare</button>
          <button class="btn btn--ghost btn--sm" type="button" data-action="fav" data-id="${cam.id}" aria-pressed="false">Add to Favorites</button>
        </div>
      </div>
    </article>`;
    }

    function stateBox(title, text, retry) {
        return `<div class="state"><h3>${esc(title)}</h3><p>${esc(text)}</p>${retry ? '<button class="btn btn--primary" type="button" data-action="retry">Try again</button>' : ''}</div>`;
    }

    function renderSkeletons() {
        const grid = $('#cameraGrid');
        grid.setAttribute('aria-busy', 'true');
        grid.innerHTML = Array.from({ length: 6 }, () => '<div class="tile tile--skeleton skeleton" aria-hidden="true"></div>').join('');
        $('#resultCount').textContent = 'Loading cameras…';
        $('#cameraStatus').innerHTML = '';
    }

    const compact = (t) => t.replace(/[^a-z0-9]/g, '');
    function matchQuery(c, query) {
        const hay = (c.name + ' ' + c.series + ' ' + (c.author || '') + ' ' + (c.spec ? c.spec.name + ' ' + (c.spec.year || '') + ' ' + (c.spec.sensor || '') : '')).toLowerCase();
        const hc = compact(hay);
        return query.split(/\s+/).filter(Boolean).every((tk) => hay.includes(tk) || hc.includes(compact(tk)));
    }
    function applyFilters() {
        const { q, series, sort } = state.prefs;
        const query = q.trim().toLowerCase();
        const nullsLast = (a, b, dir) => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : dir * (a - b));
        const cmp = {
            likes: (a, b) => nullsLast(a.likes, b.likes, -1) || a.name.localeCompare(b.name),
            name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
            newest: (a, b) => nullsLast(a.publishedMs, b.publishedMs, -1) || a.name.localeCompare(b.name),
            views: (a, b) => nullsLast(a.views, b.views, -1) || a.name.localeCompare(b.name),
            faces: (a, b) => nullsLast(a.faces, b.faces, -1) || a.name.localeCompare(b.name),
            old: (a, b) => nullsLast(a.spec && a.spec.o, b.spec && b.spec.o, 1) || a.name.localeCompare(b.name),
            new: (a, b) => nullsLast(a.spec && a.spec.o, b.spec && b.spec.o, -1) || a.name.localeCompare(b.name)
        }[sort] || ((a, b) => a.name.localeCompare(b.name));
        state.filtered = state.cameras.filter((c) =>
            (!query || matchQuery(c, query)) &&
            (series === 'all' || c.series === series)).sort(cmp);
        storage.set('prefs', state.prefs);
    }

    function renderCameras() {
        applyFilters();
        const grid = $('#cameraGrid'); grid.setAttribute('aria-busy', 'false');
        const total = state.cameras.length;
        if (!state.filtered.length) {
            grid.innerHTML = '';
            $('#cameraStatus').innerHTML = stateBox('No cameras match', 'Try a different search term or clear the filters.', false) +
                '<div class="center"><button class="btn btn--ghost" type="button" data-action="clear-filters">Clear Filters</button></div>';
            $('#resultCount').textContent = `0 of ${total} models`;
            return;
        }
        $('#cameraStatus').innerHTML = '';
        grid.innerHTML = state.filtered.map(tileHTML).join('');
        $('#resultCount').textContent = `Showing ${state.filtered.length} of ${total} Sony Alpha 3D models`;
        observeReveal(grid); syncToggles();
    }

    function populateFilters() {
        const counts = {};
        state.cameras.forEach((c) => { counts[c.series] = (counts[c.series] || 0) + 1; });
        $('#fSeries').innerHTML = `<option value="all">All series (${state.cameras.length})</option>` +
            SERIES_ORDER.filter((s) => counts[s]).map((s) => `<option value="${s}">${s} (${counts[s]})</option>`).join('');
        if (!counts[state.prefs.series]) state.prefs.series = 'all';
        if (!['likes', 'name', 'old', 'new'].includes(state.prefs.sort)) state.prefs.sort = 'old';
        $('#fQuery').value = state.prefs.q; $('#fSeries').value = state.prefs.series; $('#fSort').value = state.prefs.sort;
    }

    let lineupSeries = 'all'; let lineupOpen = false; const LINEUP_LIMIT = 6;
    const specSeries = (k) => (/^a1/.test(k) ? 'Alpha 1' : /^a9/.test(k) ? 'Alpha 9' : /^a7r/.test(k) ? 'Alpha 7R' : /^a7s/.test(k) ? 'Alpha 7S' : /^a7c/.test(k) ? 'Alpha 7C' : /^a7/.test(k) ? 'Alpha 7' : 'Alpha 6000 Series');
    function renderLineup() {
        const out = $('#lineupOut'); if (!out) return;
        const chips = $('#lineupFilter');
        const byKey = new Map(); state.cameras.forEach((c) => { if (c.spec && !byKey.has(c.spec.key)) byKey.set(c.spec.key, c); });
        const counts = {}; let total = 0; SPECS.forEach((sp) => { if (!byKey.has(sp.key)) return; total++; const k = specSeries(sp.key); counts[k] = (counts[k] || 0) + 1; });
        if (chips) {
            chips.innerHTML = [['all', `All (${total})`]].concat(SERIES_ORDER.filter((n) => counts[n]).map((n) => [n, `${n.replace(' Series', '')} (${counts[n]})`]))
                .map(([k, l]) => `<button type="button" data-lseries="${esc(k)}" aria-pressed="${k === lineupSeries}">${esc(l)}</button>`).join('');
            chips.onclick = (e) => {
                const b = e.target.closest('button[data-lseries]'); if (!b) return;
                lineupSeries = b.dataset.lseries; lineupOpen = false; renderLineup();
                const on = $('#lineupFilter button[aria-pressed="true"]'); if (on) on.focus();
            };
        }
        const rows = SPECS.map((sp, i) => ({ sp, i })).filter(({ sp }) => byKey.has(sp.key) && (lineupSeries === 'all' || specSeries(sp.key) === lineupSeries));
        const shown = lineupOpen ? rows : rows.slice(0, LINEUP_LIMIT);
        const body = shown.map(({ sp: s, i }) => {
            const c = byKey.get(s.key);
            const sensor = s.sensor ? s.sensor.replace(/ \(.*$/, '').replace(/, back-illuminated.*$/, '') : null;
            const full = specList(s).filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('') || '<div><dt>Status</dt><dd>No verified specifications yet.</dd></div>';
            return `<tr class="lineup-row" data-series="${esc(specSeries(s.key))}"><th scope="row">${esc(s.name)}</th>` +
                `<td class="c num" data-label="Year">${dash(s.year)}</td><td data-label="Sensor">${dash(sensor)}</td><td class="c num" data-label="Resolution">${dash(s.mp ? s.mp.replace(/ \(.*$/, '') + ' MP' : null)}</td><td data-label="Video">${dash(s.video)}</td>` +
                `<td class="cell-act"><button class="btn btn--ghost btn--sm btn--chev" type="button" data-lineup="${i}" aria-expanded="false" aria-controls="lm${i}">Details</button></td></tr>` +
                `<tr class="lineup-more" id="lm${i}" hidden><td colspan="6"><div class="more"><dl class="spec">${full}</dl>` +
                `<div class="sources"><p class="sources__h">Sources</p>${srcLinks(s)}</div>` +
                `<div class="more__actions">${c ? `<button class="btn btn--primary btn--sm" type="button" data-action="details" data-id="${c.id}">View 3D model</button>` : '<p class="m-cap">No 3D model of this camera was found.</p>'}</div></div></td></tr>`;
        }).join('');
        out.innerHTML = '<div class="compare"><table class="cmp cmp--lineup"><caption class="sr-only">Sony Alpha lineup, oldest to newest</caption><thead><tr><th scope="col">Model</th><th scope="col" class="c">Year</th><th scope="col">Sensor</th><th scope="col" class="c">Resolution</th><th scope="col">Video</th><th scope="col" class="c">More</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
            '<p class="cmp__legend">Release order, oldest first. A dash means the sources do not state that value.</p>' +
            (rows.length > LINEUP_LIMIT ? `<div class="center"><button class="btn btn--ghost" type="button" data-lineup-more>${lineupOpen ? 'Show fewer' : 'Show all ' + rows.length + ' models'}</button></div>` : '');
        out.onclick = (e) => { if (e.target.closest('button[data-lineup-more]')) { lineupOpen = !lineupOpen; renderLineup(); return; } const b = e.target.closest('button[data-lineup]'); if (!b) return; const r = $('#lm' + b.dataset.lineup); r.hidden = !r.hidden; b.setAttribute('aria-expanded', String(!r.hidden)); };
    }
    function pickHero(list) {
        const pool = list.filter((c) => c.thumbLarge || c.thumb).sort((a, b) => (b.likes || 0) - (a.likes || 0));
        const preferred = CONFIG.PREFER.map((re) => pool.find((c) => re.test(c.name))).find(Boolean);
        return { preferred, cam: preferred || pool.find((c) => c.spec && c.spec.o >= 12 && !/eyescloud/i.test(c.author || '')) || pool[0] };
    }
    function showHero(cam) {
        const media = $('#heroMedia');
        if (media.dataset.cam === cam.id && $('.hero__img', media)) return;
        $('.skeleton', media)?.remove();
        $('.hero__img', media)?.remove();
        const img = document.createElement('img');
        img.className = 'hero__img'; img.setAttribute('data-cam-img', '');
        img.src = cam.thumbHero || cam.thumbLarge || cam.thumb;
        img.alt = altFor(cam); img.decoding = 'async'; img.loading = 'eager'; img.fetchPriority = 'high';
        media.dataset.cam = cam.id;
        media.appendChild(img);
    }
    function renderHero() {
        const media = $('#heroMedia');
        const { cam } = pickHero(state.cameras);
        if (!cam) { $('.skeleton', media)?.remove(); media.insertAdjacentHTML('afterbegin', noImgHTML()); return; }
        showHero(cam);
    }
    async function earlyHero() {
        try {
            const [a, b] = await Promise.all([Api.searchModels('sony alpha 3'), Api.searchModels('sony alpha')]);
            if (state.cameras.length) return;
            const { preferred } = pickHero(buildCatalog(a.concat(b)));
            if (preferred) showHero(preferred);
        } catch (e) { }
    }

    const galleryEntries = () => {
        const withImg = state.cameras.filter((c) => c.thumb || c.thumbLarge).sort((a, b) => (b.likes || 0) - (a.likes || 0));
        const used = new Set(); const out = [];
        SPECS.forEach((sp) => { const c = withImg.find((x) => x.spec && x.spec.key === sp.key); if (c) used.add(c.id); out.push({ sp, cam: c || null }); });
        withImg.forEach((c) => { if (!used.has(c.id)) out.push({ sp: c.spec || null, cam: c }); });
        return out;
    };
    const galleryItems = () => galleryEntries().filter((e) => e.cam).map((e) => e.cam);
    function renderGallery() {
        const grid = $('#galleryGrid'); const entries = galleryEntries().filter((e) => e.cam); let n = 0;
        grid.innerHTML = entries.map((e, i) => {
            const c = e.cam; const sp = c.spec;
            const line = sp ? [sp.year, sp.mp && sp.mp + ' MP', sp.video && sp.video.split(/[,;]/)[0].trim()].filter(Boolean).join(' · ') : '';
            return `<button type="button" class="gallery__item flipin" style="--d:${(i % 4) * 90}ms" data-action="gallery-open" data-index="${n++}" aria-label="Open image of ${esc(c.name)} in full screen">
      <i class="flip"><i class="flip__f"><img src="${esc(c.thumb || c.thumbLarge)}" alt="${esc(altFor(c))}" data-cam-img loading="lazy" decoding="async"><i class="flip__cap">${esc(c.name)}</i></i>
      <i class="flip__b"><i class="fb__n">${esc(c.name)}</i><i class="fb__s">${esc(c.series)}</i>${line ? `<i class="fb__l">${esc(line)}</i>` : ''}</i></i></button>`;
        }).join('');
        $('#galleryMore').hidden = true;
        observeFlip(grid);
    }

    function syncToggles() {
        $$('[data-action="fav"]').forEach((b) => {
            const on = state.favs.has(b.dataset.id);
            b.setAttribute('aria-pressed', String(on));
            b.textContent = on ? '♥ Saved' : 'Add to Favorites';
        });
        $$('[data-action="compare"]').forEach((b) => {
            const on = state.compare.includes(b.dataset.id);
            b.setAttribute('aria-pressed', String(on));
            b.textContent = on ? '✓ Added' : 'Add to Compare';
        });
        const fb = $('#favBadge'); fb.textContent = state.favs.size; fb.hidden = !state.favs.size;
        const cb = $('#compareBadge'); cb.textContent = state.compare.length; cb.hidden = !state.compare.length;
    }

    const SPEC_FIELDS = [
        ['Sensor & Image Quality', ['Sensor Type', 'Sensor Size', 'Effective Megapixels', 'Image Resolution', 'ISO Range', 'Image Processor']],
        ['Autofocus & Performance', ['Autofocus System', 'Focus Points', 'Subject Recognition', 'Continuous Shooting Speed', 'Image Stabilization']],
        ['Video', ['Maximum Video Resolution', 'Supported Frame Rates', 'Video Formats', 'Recording Features']],
        ['Physical Design', ['Dimensions', 'Weight', 'Body Material', 'Weather Sealing', 'LCD Screen', 'Electronic Viewfinder']],
        ['Connectivity & Storage', ['Memory Card Slots', 'Wi-Fi', 'Bluetooth', 'USB', 'HDMI']],
        ['Power', ['Battery Model', 'Battery Life', 'Charging Features']]
    ];
    const TABS = [
        { id: 'overview', title: 'Overview' }, { id: 'sensor', title: 'Sensor & Image' }, { id: 'af', title: 'Autofocus & Speed' },
        { id: 'video', title: 'Video' }, { id: 'body', title: 'Viewfinder, Cards & Power' }, { id: 'credit', title: 'Credit & Licence' }
    ];
    const tabsFor = (cam) => { const sp = cam.spec; const vals = sp ? specList(sp).filter(([, v]) => v) : []; return TABS.filter((t) => t.id === 'credit' || (sp && vals.some(([k]) => (TAB_FIELDS[t.id] || []).includes(k)))); };
    const specRows = (rows) => `<dl class="spec tabpanel">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

    const Modal = {
        cam: null, items: [], idx: 0, tab: 0, tabList: [], opener: null,
        open(cam, opener) {
            if (!cam) return;
            if ($('#modal').hidden) this.opener = opener || document.activeElement;
            this.cam = cam; this.tab = 0; this.tabList = tabsFor(cam);
            const more = state.cameras.filter((c) => c.series === cam.series && c.id !== cam.id && (c.thumb || c.thumbLarge)).slice(0, 7);
            this.items = [cam, ...more]; this.idx = 0;
            this.render();
            $('#modal').hidden = false;
            document.documentElement.classList.add('lock');
            $('#modalSheet').scrollTop = 0;
            $('.modal__close').focus();
        },
        close() {
            if ($('#modal').hidden) return;
            $('#modal').hidden = true;
            document.documentElement.classList.remove('lock');
            if (this.opener && document.contains(this.opener)) this.opener.focus();
        },
        render() {
            const cam = this.cam; const cur = this.items[this.idx];
            $('#modalBody').innerHTML = `
        <div class="m-gallery">
          <button class="zoom" type="button" data-action="modal-zoom" aria-label="Open ${esc(cur.name)} image in full screen">${cur.thumbLarge || cur.thumb ? `<img id="mainImg" data-cam-img src="${esc(cur.thumbLarge || cur.thumb)}" alt="${esc(altFor(cur))}" decoding="async">` : noImgHTML()}</button>
          <div class="m-cap"><span>${esc(this.idx === 0 ? cam.name : 'More from ' + cam.series + ': ' + cur.name)}</span>
            ${this.idx !== 0 ? `<button class="btn btn--ghost btn--sm" type="button" data-action="details" data-id="${cur.id}">View details</button>` : '<span>Hover to zoom · click for full screen</span>'}</div>
          <div class="thumbs" role="group" aria-label="Image gallery">${this.items.map((c, i) => `<button class="thumb" type="button" data-action="modal-thumb" data-index="${i}" aria-label="${i === 0 ? 'Main image' : 'Show ' + esc(c.name)}" aria-current="${i === this.idx}">${c.thumb || c.thumbLarge ? `<img src="${esc(c.thumb || c.thumbLarge)}" alt="" loading="lazy" decoding="async" data-cam-img>` : noImgHTML()}</button>`).join('')}</div>
          ${this.items.length === 1 ? '<p class="m-cap">No other models from this series are available.</p>' : ''}
        </div>
        <div class="m-info">
          <p class="eyebrow" data-series="${esc(cam.series)}">${esc(cam.series)}</p>
          <h2 id="modalTitle">${esc(cam.name)}</h2>
          <p class="tile__desc">${esc(describeCam(cam))}</p>
          <div class="m-actions">
            <button class="btn btn--primary" type="button" data-action="open-3d" data-id="${cam.id}">Explore in 3D</button>
            <button class="btn btn--ghost" type="button" data-action="fav" data-id="${cam.id}" aria-pressed="false">Add to Favorites</button>
            <button class="btn btn--ghost" type="button" data-action="compare" data-id="${cam.id}" aria-pressed="false">Add to Compare</button>
          </div>
          <div class="tabs" role="tablist" aria-label="Detail categories">
            ${this.tabList.map((t, i) => `<button class="tab" type="button" role="tab" id="tab-${t.id}" aria-controls="tabpanel" aria-selected="${i === this.tab}" tabindex="${i === this.tab ? 0 : -1}" data-action="tab" data-index="${i}">${t.title}</button>`).join('')}
          </div>
          <div id="tabpanel" role="tabpanel" tabindex="0"></div>
          ${sampleHTML(cam)}
        </div>`;
            this.renderTab(); syncToggles();
        },
        renderTab() {
            const t = this.tabList[this.tab]; const c = this.cam; const panel = $('#tabpanel');
            panel.setAttribute('aria-labelledby', 'tab-' + t.id);
            if (t.id === 'credit') {
                panel.innerHTML = specRows([
                    ['3D model author', cellHTML(linkOrText(c.author, c.authorUrl))], ['Licence', cellHTML(linkOrText(c.license, c.licenseUrl))],
                    ['Source', cellHTML(linkOrText(c.viewerUrl ? 'View on Sketchfab' : null, c.viewerUrl))]]) +
                    '<p class="m-cap">Community-made 3D model, not an official Sony asset.</p>';
            } else {
                const sp = c.spec; const want = TAB_FIELDS[t.id] || [];
                const rows = sp ? specList(sp).filter(([k, v]) => v && want.includes(k)).map(([k, v]) => [k, esc(String(v))]) : [];
                if (sp && sp.src.length) rows.push(['Sources', srcLinks(sp)]);
                panel.innerHTML = rows.length ? specRows(rows) : '';
            }
            $$('.tab').forEach((tb, i) => { tb.setAttribute('aria-selected', String(i === this.tab)); tb.tabIndex = i === this.tab ? 0 : -1; });
        },
        setTab(i, focus) { this.tab = (i + this.tabList.length) % this.tabList.length; this.renderTab(); if (focus) $$('.tab')[this.tab].focus(); },
        setImage(i) {
            if (i === this.idx || !this.items[i]) return;
            const img = $('#mainImg'); this.idx = i;
            if (img && !reduceMotion()) { img.classList.add('is-swap'); setTimeout(() => this.render(), 180); } else this.render();
        }
    };

    const Lightbox = {
        items: [], i: 0, opener: null,
        open(items, i, opener) {
            if (!items.length) return;
            this.items = items; this.i = Math.max(0, Math.min(i, items.length - 1)); this.opener = opener || document.activeElement;
            $('#lightbox').hidden = false; document.documentElement.classList.add('lock');
            this.show(); $('.lightbox__close').focus();
        },
        close() {
            if ($('#lightbox').hidden) return;
            $('#lightbox').hidden = true;
            if ($('#modal').hidden) document.documentElement.classList.remove('lock');
            if (this.opener && document.contains(this.opener)) this.opener.focus();
        },
        step(d) { if (this.items.length < 2) return; this.i = (this.i + d + this.items.length) % this.items.length; this.show(); },
        show() {
            const cam = this.items[this.i]; const img = $('#lbImg');
            img.classList.remove('in');
            img.onload = () => img.classList.add('in');
            img.onerror = () => { img.removeAttribute('src'); img.alt = 'Image not available'; img.classList.add('in'); };
            img.alt = altFor(cam); img.src = cam.thumbLarge || cam.thumb || '';
            $('#lbCap').textContent = cam.name;
            $('#lbCount').textContent = `${this.i + 1} / ${this.items.length}`;
            $$('.lightbox__nav').forEach((b) => { b.hidden = this.items.length < 2; });
        }
    };

    const PART_INFO = [
        { key: 'ibis', re: /ibis|stabili[sz]|steady ?shot/i, name: 'SteadyShot (in-body stabilization)', what: 'A sensor unit that floats on magnets inside the body.', does: 'Shifts the sensor to cancel camera shake, so you can shoot handheld at slower shutter speeds and get steadier video. Alpha 7 II and later full-frame bodies have it. The original Alpha 7, 7R, 7S and the Alpha 6000, 6300 and 6400 do not and rely on stabilised lenses.' },
        { key: 'shutter', re: /shutter|\brelease\b/i, name: 'Shutter button', what: 'The release button on top of the hand grip, and the shutter unit it triggers.', does: 'Half-press to lock focus and exposure, full-press to take the photo. Most Alpha bodies pair a mechanical shutter with a silent electronic mode, and the Alpha 9 III uses a global-shutter sensor.' },
        { key: 'lensrelease', re: /lens[_ -]?(release|lock|unlock)|unlock/i, name: 'Lens release button', what: 'A small button beside the E-mount.', does: 'Hold it while turning the lens to unlock and remove it. Alpha cameras are mirrorless, so the sensor is exposed when the lens is off. Change lenses with the camera switched off and the body facing down.' },
        { key: 'mount', re: /mount|bayonet/i, name: 'E-mount', what: 'The metal bayonet on the front of the body.', does: 'Every Alpha mirrorless camera uses Sony’s E-mount, shared by full-frame and APS-C bodies. It holds the lens at the right distance from the sensor and carries the contacts for autofocus, aperture and stabilization. Full-frame lenses fit APS-C bodies with a crop; APS-C lenses on full-frame bodies work in a cropped mode.' },
        { key: 'expcomp', re: /exposure[_ -]?comp|comp(ensation)?[_ -]?dial/i, name: 'Exposure compensation dial', what: 'A dial on top of many Alpha bodies.', does: 'Brightens or darkens the exposure in the priority modes, typically by ±3 EV, and ±5 EV on some newer bodies.' },
        { key: 'wheel', re: /wheel|scroll|rotary|(front|rear|control|command)[_ -]?dial/i, name: 'Control wheel and dials', what: 'The rear control wheel and the front and rear dials.', does: 'Change aperture, shutter speed or ISO and move through menus. Their roles are assignable in the Alpha menu.' },
        { key: 'modedial', re: /mode|dial/i, name: 'Mode dial', what: 'A dial on top of the body.', does: 'Selects Auto, P, A, S, M and Movie modes. Many Alpha bodies add recall positions (1, 2, 3) that store your own camera setups.' },
        { key: 'afon', re: /af[_ -]?on|back[_ -]?button/i, name: 'AF-ON button', what: 'A button on the rear right of the body.', does: 'Starts autofocus without pressing the shutter, which allows back-button focus. Real-time Tracking and Eye AF can be started from it.' },
        { key: 'joystick', re: /joystick|multi[_ -]?selector|focus[_ -]?stick/i, name: 'Multi-selector (joystick)', what: 'Sony’s small joystick on the back of many newer Alpha bodies.', does: 'Moves the focus area quickly across the frame and navigates menus.' },
        { key: 'focusswitch', re: /(focus|af)[_ -]?(mode|switch|lever|selector)|af[_ -]?mf/i, name: 'Focus mode switch', what: 'A lever or switch near the lens mount on bodies that have one.', does: 'Switches between autofocus modes and manual focus.' },
        { key: 'focus', re: /focus|selector/i, name: 'Focus control', what: 'A control that sets or moves focus.', does: 'Chooses how the camera focuses and where in the frame it focuses.' },
        { key: 'fn', re: /(?:^|[^a-z])(fn|c[1-4])(?:[^a-z0-9]|$)|function|custom/i, name: 'Fn and custom buttons', what: 'The Fn button and the C1 to C4 custom keys.', does: 'Fn opens the quick Function menu. Custom keys can be assigned to features such as Eye AF, focus magnifier or white balance.' },
        { key: 'movie', re: /movie|record|(?:^|[^a-z])rec(?:[^a-z]|$)|video/i, name: 'Movie (REC) button', what: 'A button, usually on the top right or rear.', does: 'Starts and stops video recording. On most Alpha bodies it works in any shooting mode.' },
        { key: 'evf', re: /evf|viewfinder|eyepiece|finder|eye[_ -]?cup|eye[_ -]?sensor/i, name: 'Electronic viewfinder (EVF)', what: 'The display you look into at the back of the body.', does: 'Because Alpha cameras are mirrorless, it shows the live sensor image with exposure preview and shooting data. An eye sensor switches automatically between the EVF and the rear monitor.' },
        { key: 'lcd', re: /lcd|screen|monitor|display|touch/i, name: 'Rear LCD monitor', what: 'The rear screen.', does: 'Used to compose, review and navigate menus. It tilts on many Alpha bodies and is fully articulating on others, such as the Alpha 7 IV, 7S III and 7C. Newer models add touch focus.' },
        { key: 'sensor', re: /sensor|cmos|imager/i, name: 'Image sensor', what: 'An Exmor-family CMOS sensor behind the E-mount opening.', does: 'Turns light into the image. Alpha 1, 7, 7R, 7S, 7C and 9 bodies use a full-frame sensor; the Alpha 6000 series uses APS-C. Sensor size changes the field of view of the same lens.' },
        { key: 'card', re: /card|sd[_ -]?slot|slot|media/i, name: 'Memory card slot', what: 'A slot behind a door on the side of the grip.', does: 'Holds SD cards, and on models such as the Alpha 1, 7S III, 7 IV and 7R V a slot that also takes CFexpress Type A. Many bodies have two slots; the earliest Alpha 7 and 6000 bodies also accept Memory Stick.' },
        { key: 'battery', re: /batter/i, name: 'Battery (NP-FW50 or NP-FZ100)', what: 'The rechargeable pack and its compartment in the grip.', does: 'Older and compact bodies (original Alpha 7, 7R, 7S, the Alpha 7 II series and Alpha 6000 to 6500) use the NP-FW50. Alpha 7 III-generation and newer full-frame bodies, plus the Alpha 6600 and 6700, use the larger NP-FZ100.' },
        { key: 'hotshoe', re: /hot[_ -]?shoe|\bshoe\b|flash|mi[_ -]?shoe/i, name: 'Multi Interface Shoe', what: 'Sony’s accessory shoe on top of the body.', does: 'Mounts flashes, microphones and other accessories. Its extra contacts carry power and data, and newer bodies support digital audio. Not every Alpha has a built-in flash.' },
        { key: 'tripod', re: /tripod|thread|\bsocket\b/i, name: 'Tripod socket', what: 'A 1/4-inch thread on the base.', does: 'Attaches the camera to a tripod, plate or cage.' },
        { key: 'ports', re: /usb|hdmi|\bport\b|jack|terminal/i, name: 'Ports (USB, HDMI, audio)', what: 'Connectors on the side of the body.', does: 'USB (Micro-USB on older bodies, USB-C on newer ones) charges and transfers files. HDMI outputs video, micro or full size depending on the model. Many bodies add 3.5 mm microphone and headphone jacks.' },
        { key: 'mic', re: /(?:^|[^a-z])mic(?:[^a-z]|$)|microphone|speaker/i, name: 'Microphone and speaker', what: 'Small openings on the body.', does: 'The microphone records sound with video; the speaker plays it back. For better audio, use a microphone on the Multi Interface Shoe or the mic jack.' },
        { key: 'grip', re: /grip/i, name: 'Grip', what: 'The moulded handhold on the right of the body.', does: 'Gives a secure hold and houses the battery and the shutter button.' },
        { key: 'strap', re: /strap|lug|eyelet/i, name: 'Strap eyelets', what: 'The attachment points on each side of the body.', does: 'Hold the neck or wrist strap.' },
        { key: 'logo', re: /logo|badge|emblem/i, name: 'Alpha badge', what: 'The α mark and Sony name on the body.', does: 'Identifies the Alpha line, Sony’s interchangeable-lens cameras.' },
        { key: 'lens', re: /lens|glass|optic|element|barrel/i, name: 'E-mount lens', what: 'The optical assembly on the front of the camera.', does: 'Gathers light and focuses it on the sensor. Focal length and maximum aperture define how it behaves.' },
        { key: 'button', re: /button|btn|key|switch|lever/i, name: 'Button or switch', what: 'A physical control on the body.', does: 'Triggers a camera function. Most Alpha buttons can be reassigned in the menu.' },
        { key: 'body', re: /body|chassis|shell|cover|housing|frame/i, name: 'Camera body', what: 'The main housing of the camera.', does: 'Holds and protects the sensor, electronics, controls and battery. Many Alpha bodies use a magnesium-alloy frame, and weather sealing varies by model.' }
    ];

    const normTxt = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const nameHit = (name, q, key) => {
        const n = normTxt(name); const k = normTxt(q); if (!k) return 1;
        if (n.startsWith(k)) return 1;
        if ((' ' + n).includes(' ' + k)) return 2;
        if (key && normTxt(key).startsWith(k)) return 3;
        return 0;
    };

    const WHERE = {
        ibis: { t: 'Inside the body, directly behind the lens mount. You cannot see it from outside; it is the sensor unit itself.', z: { front: [44, 23, 28, 28] } },
        shutter: { t: 'On top of the hand grip, on the right side of the camera as you hold it.', z: { top: [10, 20, 12, 12], front: [10, 8, 12, 6] } },
        lensrelease: { t: 'On the front, right next to the lens mount.', z: { front: [80, 26, 9, 9] } },
        mount: { t: 'The metal ring in the middle of the front of the body, where the lens attaches.', z: { front: [41, 20, 34, 34] } },
        expcomp: { t: 'On top of the body, to the right of the viewfinder, on bodies that have this dial.', z: { top: [58, 16, 12, 14] } },
        wheel: { t: 'On the back, under your thumb. Front and rear dials sit on top near the shutter button.', z: { back: [74, 36, 18, 18], top: [10, 20, 12, 12] } },
        modedial: { t: 'On top of the body, on the right side.', z: { top: [72, 16, 16, 14] } },
        afon: { t: 'On the back, at the top right where your thumb rests.', z: { back: [78, 18, 8, 8] } },
        joystick: { t: 'On the back, near the thumb, just above the control wheel.', z: { back: [66, 26, 8, 8] } },
        focusswitch: { t: 'On the front or the side near the lens mount, depending on the model.', z: { front: [80, 40, 10, 8] } },
        focus: { t: 'On the back or near the lens mount, depending on the model.', z: { back: [66, 26, 8, 8] } },
        fn: { t: 'On the back, near the top. Custom keys (C1 to C4) are on top or at the back.', z: { back: [58, 16, 10, 6] } },
        movie: { t: 'On top or at the back near your thumb, depending on the model.', z: { top: [28, 20, 10, 8], back: [88, 10, 8, 6] } },
        evf: { t: 'On the back, at the top centre. This is the part you put your eye to.', z: { back: [36, 2, 28, 14], front: [38, 4, 30, 10] } },
        lcd: { t: 'Takes up most of the back of the body.', z: { back: [10, 20, 54, 34] } },
        sensor: { t: 'Inside the body, directly behind the lens mount. Take the lens off and you see it.', z: { front: [44, 23, 28, 28] } },
        card: { t: 'Behind a small door on the side of the grip, or on the underside next to the battery on some models.', z: { back: [82, 14, 12, 14] } },
        battery: { t: 'Inside the grip. The cover is on the underside of the camera.', z: { back: [80, 32, 14, 24] } },
        hotshoe: { t: 'On top of the body, in the middle, above the viewfinder hump.', z: { top: [44, 18, 16, 12], front: [42, 2, 26, 6] } },
        tripod: { t: 'On the underside of the body (not shown in these views).', z: {} },
        ports: { t: 'On the side of the body under a small cover (not shown in these views).', z: {} },
        mic: { t: 'Small openings on top of the body. The speaker is on the side or the grip.', z: { top: [22, 16, 8, 6] } },
        grip: { t: 'The raised handhold on the right side of the body as you hold it.', z: { front: [4, 14, 24, 46], top: [4, 12, 24, 40] } },
        strap: { t: 'Small metal loops on the left and right sides of the body.', z: { front: [0, 18, 8, 10] } },
        logo: { t: 'On the front of the body, above the lens mount.', z: { front: [30, 16, 14, 6] } },
        lens: { t: 'The large barrel attached to the front of the camera.', z: { front: [38, 19, 40, 36] } },
        button: { t: 'Spread around the top and back of the body.', z: {} },
        body: { t: 'The whole outer shell of the camera.', z: { front: [4, 14, 92, 46], top: [4, 12, 92, 40], back: [4, 14, 92, 46] } }
    };
    const whereHTML = (key) => {
        const w = WHERE[key]; if (!w) return '';
        const zone = (view) => w.z[view] ? `<rect class="wh-zone" x="${w.z[view][0]}" y="${w.z[view][1]}" width="${w.z[view][2]}" height="${w.z[view][3]}" rx="3"/>` : '';
        const labelled = (x, name, base, view) => `<g transform="translate(${x},0)">${base}${zone(view)}<text class="wh-lab" x="50" y="77">${name}</text></g>`;
        const front = '<rect class="wh-body" x="4" y="14" width="92" height="46" rx="6"/><rect class="wh-detail" x="4" y="14" width="22" height="46" rx="6"/><rect class="wh-detail" x="38" y="4" width="30" height="10" rx="2"/><circle class="wh-detail" cx="58" cy="37" r="16"/><circle class="wh-detail" cx="58" cy="37" r="10"/>';
        const top = '<rect class="wh-body" x="4" y="12" width="92" height="40" rx="5"/><rect class="wh-detail" x="4" y="12" width="24" height="40" rx="5"/><rect class="wh-detail" x="44" y="18" width="16" height="12"/><circle class="wh-detail" cx="80" cy="23" r="7"/><circle class="wh-detail" cx="16" cy="26" r="4"/>';
        const back = '<rect class="wh-body" x="4" y="14" width="92" height="46" rx="6"/><rect class="wh-detail" x="72" y="14" width="24" height="46" rx="6"/><rect class="wh-detail" x="10" y="20" width="54" height="34" rx="2"/><rect class="wh-detail" x="38" y="4" width="24" height="10" rx="2"/><circle class="wh-detail" cx="83" cy="45" r="8"/>';
        const svg = Object.keys(w.z).length
            ? `<svg class="wh-svg" viewBox="0 0 330 82" role="img" aria-label="Diagram showing where this part is on a typical Alpha body">${labelled(0, 'FRONT', front, 'front')}${labelled(115, 'TOP', top, 'top')}${labelled(230, 'BACK', back, 'back')}</svg>` : '';
        return `<h4>Where to find it</h4><p>${esc(w.t)}</p>${svg}<p class="panel__hint">Generic Alpha layout. The exact position varies a little between models.</p>`;
    };
    const matchInfo = (name) => PART_INFO.find((p) => p.re.test(name)) || null;
    const prettyName = (s) => String(s).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const call = (api, fn, ...args) => new Promise((res) => {
        try { api[fn](...args, (err, val) => res({ err, val })); } catch (e) { res({ err: e, val: null }); }
    });

    const namedParts = (nodes) => {
        const seen = new Set();
        return nodes.filter((n) => {
            const name = clean(n.name); if (!name || /^(root|scene|sketchfab_model)$/i.test(name)) return false;
            const key = name.toLowerCase() + '|' + n.type; if (seen.has(key)) return false; seen.add(key); return true;
        }).map((n) => ({ id: String(n.instanceID), name: prettyName(n.name), type: clean(n.type) }));
    };

    const Viewer = {
        cam: null, api: null, ready: false, token: 0, nodes: [], byInst: new Map(), parts: [], selected: null,
        info: storage.get('parts', {}), guide: null, pending: null,
        hidden: new Set(), home: null, orig: new Map(), exploded: false, annotations: [],

        init() {
            this.wrap = $('#viewerFrameWrap'); this.poster = $('#viewerPoster'); this.status = $('#viewerStatus');
            $('#viewerLoad').addEventListener('click', () => this.load());
            $('#vModel').addEventListener('change', (e) => { storage.set('vModel', e.target.value); this.setModel(e.target.value); });
            $('#vExplode').addEventListener('click', () => this.explode());
            $('#vReset').addEventListener('click', () => this.reset());
            $('#partFilter').addEventListener('input', () => { this.renderParts(); this.renderGuide(); });
            $('#partsList').addEventListener('click', (e) => { const b = e.target.closest('button[data-part]'); if (b) this.select(b.dataset.part, { fromList: true }); });
            $('#annoList').addEventListener('click', (e) => { const b = e.target.closest('button[data-anno]'); if (b) this.gotoAnnotation(Number(b.dataset.anno)); });
            $('#partInfo').addEventListener('click', (e) => {
                const b = e.target.closest('[data-vaction]'); if (!b) return;
                if (b.dataset.vaction === 'flash') this.flash(this.selected);
                if (b.dataset.vaction === 'toggle') this.toggleHide(this.selected);
                if (b.dataset.vaction === 'showall') this.showAll();
            });
            $('#guideList').addEventListener('click', (e) => { const b = e.target.closest('button[data-guide]'); if (b) this.pickGuide(Number(b.dataset.guide)); });
            this.hoverEl = $('#viewerHover');
            this.renderInfo();
        },
        label(c) {
            const n = this.info[c.id];
            const same = state.cameras.filter((x) => x.name === c.name);
            const dup = same.length > 1 ? ` (${same.findIndex((x) => x.id === c.id) + 1})` : '';
            return `${c.name}${dup}${n >= 2 ? ` · ✓ ${n} parts` : ''}`;
        },
        refreshLabels() { $$('#vModel option').forEach((o) => { const c = byId(o.value); if (c) o.textContent = this.label(c); }); },
        renderGuide() {
            const withParts = this.ready && this.parts.length > 0;
            const q = $('#partFilter').value.trim().toLowerCase();
            const sp = this.cam && this.cam.spec;
            let items = PART_INFO.map((p, i) => ({ p, i, n: withParts ? this.parts.filter((pt) => matchInfo(pt.name) === p).length : 0 }));
            if (withParts) items = items.filter((x) => x.n > 0);
            if (sp && sp.stab === 'None') items = items.filter((x) => x.p.key !== 'ibis');
            if (q) items = items.map((x) => ({ ...x, r: nameHit(x.p.name, q, x.p.key) })).filter((x) => x.r).sort((a, b) => a.r - b.r || a.i - b.i);
            $('#guideH').textContent = withParts ? 'Sony Alpha parts in this model' : 'Sony Alpha parts guide';
            $('#guideList').innerHTML = items.length
                ? items.map(({ p, i, n }) => `<li><button type="button" data-guide="${i}" class="${this.guide === i ? 'is-selected' : ''}">${esc(p.name)}${n ? ` <small>${n} ${n === 1 ? 'part' : 'parts'}</small>` : ''}</button></li>`).join('')
                : '<li class="parts__empty">No Sony Alpha part matches that search.</li>';
        },
        pickGuide(i) {
            const p = PART_INFO[i]; if (!p) return;
            if (this.ready && this.parts.length) {
                const hits = this.parts.filter((pt) => matchInfo(pt.name) === p);
                if (hits.length) { this.select(hits[0].id); this.flash(hits.map((h) => h.id)); return; }
            }
            this.guide = i; this.selected = null; this.renderInfo(); this.renderGuide();
        },
        setHover(text) { if (!this.hoverEl) return; this.hoverEl.hidden = !text; this.hoverEl.innerHTML = text ? `${esc(text)}<small>Click for details</small>` : ''; },
        onHover(info) {
            if (!info || info.instanceID === undefined || info.instanceID === null) { this.setHover(''); return; }
            const id = this.resolve(info.instanceID); const n = id !== null ? this.byInst.get(id) : null;
            if (!n) { this.setHover(''); return; }
            const nm = prettyName(n.name); const m = matchInfo(nm);
            this.setHover(m ? m.name + ' · ' + nm : nm);
        },
        populate() {
            const sel = $('#vModel');
            const list = this.sorted();
            sel.innerHTML = list.map((c) => `<option value="${c.id}">${esc(this.label(c))}</option>`).join('');
            const saved = storage.get('vModel', '');
            const id = byId(saved) ? saved : (list[0] && list[0].id);
            if (id) { sel.value = id; this.setModel(id); }
        },
        sorted() { const good = (c) => ((this.info[c.id] || 0) >= 2 ? 1 : 0); return state.cameras.slice().sort((a, b) => good(b) - good(a) || (b.likes || 0) - (a.likes || 0) || a.name.localeCompare(b.name)); },
        setStatus(msg, ms) {
            clearTimeout(this._statusTimer);
            this.status.textContent = msg || ''; this.status.hidden = !msg;
            if (msg && ms) this._statusTimer = setTimeout(() => this.setStatus(''), ms);
        },
        destroy() {
            this.token++; this.api = null; this.ready = false; this.nodes = []; this.byInst = new Map(); this.parts = [];
            this.selected = null; this.hidden = new Set(); this.home = null; this.orig = new Map(); this.exploded = false; this.annotations = []; this.guide = null; this.pending = null;
            this.setHover('');
            this.wrap.innerHTML = '';
        },
        setModel(id) {
            const cam = byId(id); if (!cam) return;
            this.destroy(); this.cam = cam;
            this.poster.hidden = false;
            $('#viewerPosterImg').innerHTML = cam.thumbLarge || cam.thumb ? `<img src="${esc(cam.thumbLarge || cam.thumb)}" alt="${esc(altFor(cam))}" data-cam-img>` : noImgHTML();
            this.setStatus('');
            $('#viewerCredit').innerHTML = `3D model “${esc(cam.name)}”${cam.author ? ' by ' + (linkOrText(cam.author, cam.authorUrl)) : ''}${cam.license ? ' · ' + (linkOrText(cam.license, cam.licenseUrl)) : ''}${cam.viewerUrl ? ' · <a href="' + esc(cam.viewerUrl) + '" target="_blank" rel="noopener noreferrer">View on Sketchfab</a>' : ''}. Community-made, not an official Sony asset.`;
            this.renderParts(); this.renderInfo(); this.renderAnnotations(); this.renderGuide();
        },
        async load() {
            if (!this.cam || this.api) return;
            const token = ++this.token; const cam = this.cam;
            this.poster.hidden = true;
            this.setStatus('Loading 3D model…');
            this.wrap.innerHTML = '<div class="skeleton viewer__skel" aria-hidden="true"></div>';
            try { await Api.loadViewerScript(); } catch (e) { return this.fail(token, e.message); }
            if (token !== this.token) return;
            const iframe = document.createElement('iframe');
            iframe.title = `Interactive 3D model: ${cam.name}`;
            iframe.setAttribute('allow', 'autoplay; fullscreen; xr-spatial-tracking');
            iframe.setAttribute('allowfullscreen', '');
            this.wrap.appendChild(iframe);
            const timer = setTimeout(() => { if (token === this.token && !this.ready) this.fail(token, 'The 3D model took too long to start.'); }, CONFIG.VIEWER_TIMEOUT_MS);
            try {
                const client = new window.Sketchfab(iframe);
                client.init(cam.id, {
                    success: (api) => {
                        if (token !== this.token) return;
                        this.api = api; api.start();
                        api.addEventListener('viewerready', () => { clearTimeout(timer); if (token === this.token) this.onReady(token); });
                    },
                    error: () => { clearTimeout(timer); this.fail(token, 'Sketchfab could not start this model.'); }
                });
            } catch (e) { clearTimeout(timer); this.fail(token, 'Sketchfab could not start this model.'); }
        },
        fail(token, msg) {
            if (token !== this.token) return;
            this.api = null; this.wrap.innerHTML = '';
            this.poster.hidden = false;
            this.setStatus(msg + ' Press “Load interactive 3D model” to try again.');
        },
        async onReady(token) {
            const api = this.api; const cam0 = this.cam; this.ready = true; this.setStatus('');
            $('.viewer__skel', this.wrap)?.remove();
            const [map, look, annos] = await Promise.all([call(api, 'getNodeMap'), call(api, 'getCameraLookAt'), call(api, 'getAnnotationList')]);
            if (token !== this.token) return;
            if (look.val && Array.isArray(look.val.position) && Array.isArray(look.val.target)) this.home = { position: look.val.position.slice(), target: look.val.target.slice() };
            this.nodes = !map.err && Array.isArray(map.val) ? map.val.filter((n) => n && typeof n === 'object' && n.instanceID !== undefined) : [];
            this.byInst = new Map(this.nodes.map((n) => [String(n.instanceID), n]));
            this.parts = namedParts(this.nodes);
            this.info[cam0.id] = this.parts.length; storage.set('parts', this.info); this.refreshLabels();
            this.annotations = !annos.err && Array.isArray(annos.val) ? annos.val : [];
            api.addEventListener('click', (info) => this.onClick(info), { pick: 'fast' });
            try { api.addEventListener('nodeMouseEnter', (info) => this.onHover(info), { pick: 'fast' }); api.addEventListener('nodeMouseLeave', () => this.setHover(''), { pick: 'fast' }); } catch (e) { }
            api.addEventListener('annotationSelect', (i) => { if (typeof i === 'number') this.highlightAnno(i); });
            this.renderParts(); this.renderAnnotations(); this.renderInfo(); this.renderGuide();
            if (this.pending) { const p = this.pending; this.pending = null; setTimeout(p, 500); }
            if (!this.parts.length) this.setStatus('This model is one solid piece, so its parts can’t be picked. Use the parts guide, or choose a model marked ✓.');
        },
        needReady(retry) {
            if (this.ready) return true;
            if (retry && this.cam) { this.pending = retry; toast('Loading the 3D model…'); this.load(); } else toast('Load the 3D model first.');
            return false;
        },
        syncOptions() {
            const sel = $('#vModel'); const cur = sel.value;
            const list = this.sorted();
            sel.innerHTML = list.map((c) => `<option value="${c.id}">${esc(this.label(c))}</option>`).join(''); sel.value = cur;
        },
        resolve(id) {
            let n = this.byInst.get(String(id)); let guard = 0;
            while (n && !clean(n.name) && n.parentInstanceID !== undefined && n.parentInstanceID !== null && guard++ < 30) n = this.byInst.get(String(n.parentInstanceID));
            return n && clean(n.name) ? String(n.instanceID) : null;
        },
        onClick(info) {
            if (!info || info.instanceID === undefined || info.instanceID === null) return;
            const id = this.resolve(info.instanceID);
            if (id === null) { this.selected = null; this.guide = null; this.renderGuide(); this.renderInfo(this.parts.length ? 'This part has no name. Pick another part or choose one from the guide.' : 'This model is one solid piece, so its parts can’t be picked. Choose a part from the guide instead.'); this.renderParts(); return; }
            this.select(id, { point: info.position3D });
        },
        select(id, opts = {}) {
            const node = this.byInst.get(String(id)); if (!node) return;
            this.selected = String(id); { const m = matchInfo(prettyName(node.name)); this.guide = m ? PART_INFO.indexOf(m) : null; }
            this.renderParts(); this.renderInfo(); this.renderGuide();
            if (opts.fromList || opts.point) this.flash(this.selected);
            if (opts.point && Array.isArray(opts.point) && this.api) this.focusPoint(opts.point);
            const li = $(`#partsList [data-part="${CSS.escape(this.selected)}"]`); if (li && opts.point) li.scrollIntoView({ block: 'nearest' });
        },
        async focusPoint(pt) {
            const cur = await call(this.api, 'getCameraLookAt');
            if (!cur.val || !Array.isArray(cur.val.position)) return;
            const p = cur.val.position;
            const pos = pt.map((v, i) => v + (p[i] - v) * 0.6);
            this.api.setCameraLookAt(pos, pt, reduceMotion() ? 0 : 0.9);
        },
        async flash(ids) {
            if (!this.ready || reduceMotion()) return;
            const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id !== null && id !== undefined && !this.hidden.has(id));
            if (!list.length) return;
            const n = (this.flashToken = (this.flashToken || 0) + 1);
            for (let i = 0; i < 3 && this.flashToken === n; i++) {
                list.forEach((id) => this.api.hide(this.rawId(id))); await sleep(170);
                list.forEach((id) => this.api.show(this.rawId(id))); await sleep(170);
            }
            list.forEach((id) => { if (!this.hidden.has(id)) this.api.show(this.rawId(id)); });
        },
        rawId(id) { const n = this.byInst.get(String(id)); return n ? n.instanceID : id; },
        toggleHide(id) {
            if (!this.needReady() || id === null) return;
            if (this.hidden.has(id)) { this.api.show(this.rawId(id)); this.hidden.delete(id); } else { this.api.hide(this.rawId(id)); this.hidden.add(id); }
            this.renderInfo();
        },
        showAll() {
            if (!this.ready) return;
            this.hidden.forEach((id) => this.api.show(this.rawId(id)));
            this.hidden.clear(); this.renderInfo();
        },
        renderInfo(msg) {
            const box = $('#partInfo');
            const node = this.selected !== null ? this.byInst.get(this.selected) : null;
            if (!node && this.guide !== null && PART_INFO[this.guide]) {
                const g = PART_INFO[this.guide];
                box.innerHTML = `<div class="panel__in"><span class="tag">Sony Alpha guide · not from the 3D model</span><h3>${esc(g.name)}</h3><h4>What it is</h4><p>${esc(g.what)}</p><h4>Function</h4><p>${esc(g.does)}</p>${whereHTML(g.key)}<p class="panel__hint">This 3D model is one solid piece, so it cannot highlight the part. Use the diagram above to find it.</p></div>`;
                return;
            }
            if (!node) {
                box.innerHTML = `<div class="panel__in"><span class="tag">3D model</span><h3>Select a component</h3><p class="panel__hint">${esc(msg || (this.ready ? 'Hover a part to see its name and click it to see what it does, or pick one from the lists below.' : 'Load the 3D model, then click any part of it to see its name and what it does on a Sony Alpha camera.'))}</p></div>`;
                return;
            }
            const name = prettyName(node.name); const info = matchInfo(name); const hidden = this.hidden.has(this.selected);
            box.innerHTML = `<div class="panel__in"><span class="tag">Part in this 3D model</span><h3>${esc(name)}</h3>
        ${info ? `<h4>What it is — ${esc(info.name)}</h4><p>${esc(info.what)}</p><h4>Function</h4><p>${esc(info.does)}</p>
          ${whereHTML(info.key)}<p class="panel__hint">Sony Alpha description matched from the part’s name. Exact layout and features vary by model.</p>`
                    : `<h4>Description</h4><p>${cell(null)}</p><p class="panel__hint">The part’s name does not match a known Sony Alpha component.</p>`}
        <dl class="panel__data"><div><dt>Node type</dt><dd>${cell(clean(node.type))}</dd></div><div><dt>Visibility</dt><dd>${hidden ? 'Hidden' : 'Visible'}</dd></div></dl>
        <div class="panel__btns"><button class="btn btn--ghost btn--sm" type="button" data-vaction="flash">Highlight</button>
        <button class="btn btn--ghost btn--sm" type="button" data-vaction="toggle">${hidden ? 'Show part' : 'Hide part'}</button>
        <button class="btn btn--ghost btn--sm" type="button" data-vaction="showall"${this.hidden.size ? '' : ' disabled'}>Show all</button></div></div>`;
        },
        renderParts() {
            const ul = $('#partsList'); const q = $('#partFilter').value.trim().toLowerCase();
            if (!this.ready) { ul.innerHTML = '<li class="parts__empty">Load the 3D model to list its parts.</li>'; return; }
            const list = this.parts.map((p) => ({ p, r: nameHit(p.name, q) })).filter((x) => x.r).sort((a, b) => (q ? a.r - b.r : 0)).map((x) => x.p);
            if (!list.length) { ul.innerHTML = `<li class="parts__empty">${this.parts.length ? 'No parts match.' : 'This model is one solid piece, so it has no separate parts. Use the guide above.'}</li>`; return; }
            ul.innerHTML = list.slice(0, 250).map((p) => `<li><button type="button" data-part="${esc(p.id)}" aria-pressed="${p.id === this.selected}" class="${p.id === this.selected ? 'is-selected' : ''}">${esc(p.name)}${p.type ? ` <small>${esc(p.type)}</small>` : ''}</button></li>`).join('') +
                (list.length > 250 ? '<li class="parts__empty">Showing the first 250. Use the filter to narrow the list.</li>' : '');
        },
        renderAnnotations() {
            const has = this.annotations.length > 0;
            $('#annoH').hidden = !has; $('#annoList').hidden = !has;
            $('#annoList').innerHTML = this.annotations.map((a, i) => `<li><button type="button" data-anno="${i}">${esc(clean(a && (a.name || a.title)) || 'Annotation ' + (i + 1))}</button></li>`).join('');
        },
        gotoAnnotation(i) { if (!this.needReady()) return; this.api.gotoAnnotation(i, { preventCameraAnimation: reduceMotion() }, () => { }); this.highlightAnno(i); },
        highlightAnno(i) { $$('#annoList button').forEach((b) => b.classList.toggle('is-selected', Number(b.dataset.anno) === i)); },

        setView(v) {
            if (!this.needReady(() => this.setView(v))) return;
            if (!this.home) { toast('Camera angles are not available for this model.'); return; }
            const { position: p, target: t } = this.home;
            const o = [p[0] - t[0], p[1] - t[1], p[2] - t[2]]; const d = Math.hypot(o[0], o[1], o[2]) || 1;
            let pos;
            if (v === 'top') pos = [t[0], t[1] + d, t[2] + d * 0.001];
            else {
                const a = (Number(v) || 0) * Math.PI / 180; const c = Math.cos(a); const s = Math.sin(a);
                pos = [t[0] + o[0] * c + o[2] * s, t[1] + o[1], t[2] - o[0] * s + o[2] * c];
            }
            this.api.setCameraLookAt(pos, t, reduceMotion() ? 0 : 1.2, () => { });
            $$('#vViews button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vview === v)));
        },

        async explode() {
            if (!this.needReady(() => this.explode())) return;
            if (this.exploded) { toast('Already exploded. Use Reset View to put the parts back.'); return; }
            const idx = new Set(this.nodes.map((n) => String(n.instanceID)));
            let cands = this.nodes.filter((n) => n.type === 'MatrixTransform' && clean(n.name));
            const hasParents = this.nodes.some((n) => n.parentInstanceID !== undefined && n.parentInstanceID !== null);
            if (hasParents) {
                const nonLeaf = new Set(); const isCand = new Set(cands.map((n) => String(n.instanceID)));
                cands.forEach((n) => {
                    let p = n.parentInstanceID; let g = 0;
                    while (p !== undefined && p !== null && g++ < 40) { if (isCand.has(String(p))) nonLeaf.add(String(p)); const pn = this.byInst.get(String(p)); p = pn ? pn.parentInstanceID : null; }
                });
                cands = cands.filter((n) => !nonLeaf.has(String(n.instanceID)));
            }
            cands = cands.filter((n) => idx.has(String(n.instanceID))).slice(0, CONFIG.MAX_EXPLODE_PARTS);
            if (cands.length < 2) { this.setStatus('This model’s parts cannot be separated (it has too few movable, named parts).'); return; }
            this.setStatus('Separating parts…');
            const mats = await Promise.all(cands.map((n) => call(this.api, 'getMatrix', n.instanceID)));
            const items = cands.map((n, i) => ({ n, m: mats[i].val })).filter((x) => Array.isArray(x.m) && x.m.length === 16);
            if (items.length < 2) { this.setStatus('This model’s parts cannot be separated.'); return; }
            const pos = items.map((x) => [x.m[12], x.m[13], x.m[14]]);
            const c = [0, 1, 2].map((k) => pos.reduce((s, p) => s + p[k], 0) / pos.length);
            const spread = Math.max(...pos.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
            if (!(spread > 1e-9)) { this.setStatus('All parts of this model share one pivot point, so they cannot be pulled apart.'); return; }
            const dur = reduceMotion() ? 0 : 1.2;
            items.forEach((x, i) => {
                const p = pos[i]; let dir = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; const len = Math.hypot(...dir);
                dir = len > 1e-9 ? dir.map((v) => v / len) : [Math.cos(i), 0, Math.sin(i)];
                const to = [p[0] + dir[0] * spread * 0.9, p[1] + dir[1] * spread * 0.9, p[2] + dir[2] * spread * 0.9];
                this.orig.set(String(x.n.instanceID), { id: x.n.instanceID, pos: p });
                this.api.translate(x.n.instanceID, to, { duration: dur, easing: 'easeOutQuad' }, () => { });
            });
            this.exploded = true;
            this.setStatus(`Exploded ${items.length} parts. Click a part to inspect it. Reset View puts everything back.`);
        },
        async reset() {
            if (!this.needReady()) return;
            const dur = reduceMotion() ? 0 : 0.8;
            this.orig.forEach((o) => this.api.translate(o.id, o.pos, { duration: dur, easing: 'easeOutQuad' }, () => { }));
            this.orig = new Map(); this.exploded = false;
            this.showAll(); this.selected = null; this.guide = null; this.renderGuide();
            if (this.home) this.api.setCameraLookAt(this.home.position, this.home.target, reduceMotion() ? 0 : 1, () => { });
            $$('#vViews button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
            this.setStatus(''); this.renderParts(); this.renderInfo();
            toast('View reset');
        }
    };

    const LENS_PARTS = {
        hood: { name: 'Lens Hood', what: 'A shade fitted at the front of the lens.', does: 'Blocks stray light that would cause flare and lost contrast, and offers some protection to the front element.', notes: 'Shape differs between lenses.' },
        optics: { name: 'Optical Elements', what: 'Groups of glass elements inside the barrel.', does: 'Bend and focus light so that a sharp image forms on the sensor. Special glass and aspherical shapes control aberrations.', notes: 'Element count and arrangement vary by lens.' },
        aperture: { name: 'Aperture', what: 'An adjustable iris of overlapping blades.', does: 'Sets the size of the opening, expressed as an f-number. It controls how much light reaches the sensor and how much of the scene is in focus.', notes: 'The maximum aperture is a key lens specification.' },
        zoom: { name: 'Zoom Ring', what: 'A grip ring present on zoom lenses.', does: 'Moves optical groups to change the focal length, widening or narrowing the field of view. Prime lenses have no zoom ring.', notes: 'Some lenses use a switch or motor drive instead.' },
        focus: { name: 'Focus Ring', what: 'A ring used for manual focus.', does: 'On many mirrorless lenses it is electronic: the camera reads the ring and moves the focus group with a motor, which also performs autofocus.', notes: 'Ring placement differs between lenses.' },
        mount: { name: 'Lens Mount', what: 'The rear bayonet and electrical contacts.', does: 'Locks the lens to the camera at the correct distance from the sensor and lets lens and body communicate. Sony Alpha mirrorless cameras use the E-mount.', notes: 'Adapters can allow other mounts.' }
    };
    const hot = (x, y, n) => `<g class="hot" transform="translate(${x} ${y})"><circle class="hot__ring" r="15"/><circle class="hot__dot" r="9"/><text class="hot__n" text-anchor="middle" dy="3.8">${n}</text></g>`;
    const partGroup = (id, name, svg, hx, hy, n) => `<g class="part" data-part="${id}" tabindex="0" role="button" aria-pressed="false" aria-label="${esc(name)}">${svg}${hot(hx, hy, n)}</g>`;
    const LENS_SVG = `<svg class="ana-svg" viewBox="0 0 900 360" role="group" aria-label="Cross-section of a generic interchangeable lens (illustration)">
    <rect class="body" x="190" y="90" width="520" height="180" rx="14"/>
    ${partGroup('hood', 'Lens Hood', '<path class="shape" d="M70 40 L200 92 L200 268 L70 320 Z"/>', 130, 180, 1)}
    ${partGroup('optics', 'Optical Elements', '<path class="lens-glass" d="M235 110 Q268 180 235 250 Q202 180 235 110 Z"/><path class="lens-glass" d="M300 108 Q340 180 300 252 Q260 180 300 108 Z"/><path class="lens-glass" d="M560 115 Q590 180 560 245 Q530 180 560 115 Z"/>', 300, 180, 2)}
    ${partGroup('zoom', 'Zoom Ring', '<rect class="shape" x="352" y="76" width="96" height="208" rx="10"/><path class="detail" d="M368 82v196M384 82v196M400 82v196M416 82v196M432 82v196"/>', 400, 60, 3)}
    ${partGroup('aperture', 'Aperture', '<path class="shape" d="M486 108 L514 160 M514 200 L486 252 M520 120 L500 170 M500 190 L520 240"/><rect class="shape" x="482" y="100" width="40" height="160" rx="6" fill-opacity=".2"/>', 502, 180, 4)}
    ${partGroup('focus', 'Focus Ring', '<rect class="shape" x="596" y="80" width="84" height="200" rx="10"/><path class="detail" d="M610 86v188M624 86v188M638 86v188M652 86v188M666 86v188"/>', 638, 60, 5)}
    ${partGroup('mount', 'Lens Mount', '<rect class="shape" x="710" y="108" width="36" height="144" rx="6"/><circle class="detail" cx="728" cy="180" r="44"/>', 728, 76, 6)}
  </svg>`;
    const lensPanel = (def) => `<div class="panel__in"><span class="tag">Component</span><h3>${esc(def.name)}</h3><p>${esc(def.what)}</p>
    <h4>Function</h4><p>${esc(def.does)}</p><h4>Technical notes</h4><p>${esc(def.notes)}</p></div>`;
    const Lens = {
        selected: null,
        init() {
            this.stage = $('#lensStage'); this.panel = $('#lensPanel');
            this.stage.innerHTML = LENS_SVG;
            this.stage.addEventListener('click', (e) => { const p = e.target.closest('.part'); if (p) this.select(p.dataset.part); });
            this.stage.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('part')) { e.preventDefault(); this.select(e.target.dataset.part); }
            });
            this.render();
        },
        select(id) {
            if (!LENS_PARTS[id]) return; this.selected = id;
            $$('.part', this.stage).forEach((p) => { const on = p.dataset.part === id; p.classList.toggle('is-selected', on); p.setAttribute('aria-pressed', String(on)); });
            this.render();
        },
        render() {
            this.panel.innerHTML = this.selected ? lensPanel(LENS_PARTS[this.selected])
                : '<div class="panel__in"><span class="tag">Illustration</span><h3>Select a component</h3><p class="panel__hint">Click a numbered hotspot to learn what that part of a lens does.</p></div>';
        }
    };

    const CMP_ROWS = [
        { label: 'Series', get: (c) => c.series },
        { label: 'Release year', get: (c) => c.spec && c.spec.year && String(c.spec.year) },
        { label: 'Sensor', get: (c) => c.spec && c.spec.sensor },
        { label: 'Resolution', get: (c) => c.spec && c.spec.mp && c.spec.mp + ' MP', num: (c) => c.spec && c.spec.mp ? Number(String(c.spec.mp).replace(/[^0-9.]/g, '')) : null, best: 'high' },
        { label: 'ISO range', get: (c) => c.spec && c.spec.iso },
        { label: 'Autofocus', get: (c) => c.spec && c.spec.af },
        { label: 'Image stabilization', get: (c) => c.spec && c.spec.stab },
        { label: 'Max video', get: (c) => c.spec && c.spec.video },
        { label: 'Burst speed', get: (c) => c.spec && c.spec.fps && c.spec.fps + ' fps', num: (c) => c.spec && c.spec.fps, best: 'high' },
        { label: 'Weight', get: (c) => c.spec && c.spec.wt && c.spec.wt.replace(/ with battery and card$/, '') }
    ];
    function renderCompare() {
        const out = $('#compareOut');
        const cams = state.compare.map(byId).filter(Boolean);
        const sel = $('#compareAdd');
        const available = state.cameras.filter((c) => !state.compare.includes(c.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        sel.innerHTML = available.length ? available.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') : '<option value="">No more cameras to add</option>';
        $('#compareAddBtn').disabled = !available.length || cams.length >= CONFIG.MAX_COMPARE;
        $('#compareClear').disabled = !cams.length;
        if (!cams.length) {
            out.innerHTML = '<div class="cmp__empty"><h3>Nothing to compare yet</h3><p>Pick a camera above, or use “Add to Compare” on any camera. You can compare up to three.</p></div>';
            syncToggles(); return;
        }
        const head = cams.map((c) => `<th scope="col"><div class="cmp__head">${c.thumb ? `<img src="${esc(c.thumb)}" alt="${esc(altFor(c))}" data-cam-img loading="lazy">` : ''}<strong>${esc(c.name)}</strong><button class="btn btn--ghost btn--sm" type="button" data-action="remove-compare" data-id="${c.id}">Remove Camera</button></div></th>`).join('');
        const body = CMP_ROWS.map((row) => {
            const vals = cams.map((c) => row.get(c));
            const differs = cams.length > 1 && vals.some(Boolean) && new Set(vals.map((v) => v || NA)).size > 1;
            let bestIdx = -1;
            if (row.num && cams.length > 1) {
                const nums = cams.map(row.num); const valid = nums.filter((n) => n !== null);
                if (valid.length > 1 && new Set(valid).size > 1) bestIdx = nums.indexOf(Math.max(...valid));
            }
            return `<tr class="${differs ? 'diff' : ''}"><th scope="row">${esc(row.label)}</th>${vals.map((v, i) => `<td class="${i === bestIdx ? 'best' : ''}">${cell(v)}</td>`).join('')}</tr>`;
        }).join('');
        out.innerHTML = `<table class="cmp"><caption class="sr-only">Camera comparison</caption><thead><tr><th scope="col"><span class="sr-only">Property</span></th>${head}</tr></thead><tbody>${body}</tbody></table>
      <p class="cmp__legend">Shaded rows differ between models. ▲ marks the highest value. “${NA}” means the sources do not state it.</p>`;
        syncToggles();
    }
    function toggleCompare(id) {
        if (!byId(id)) return;
        const i = state.compare.indexOf(id);
        if (i >= 0) { state.compare.splice(i, 1); toast('Removed from comparison'); }
        else if (state.compare.length >= CONFIG.MAX_COMPARE) { toast(`You can compare up to ${CONFIG.MAX_COMPARE} cameras. Remove one first.`); return; }
        else { state.compare.push(id); toast('Added to comparison'); }
        storage.set('compare', state.compare); renderCompare();
    }

    function renderFavorites() {
        const grid = $('#favGrid');
        const cams = Array.from(state.favs).map(byId).filter(Boolean);
        if (!cams.length) {
            grid.innerHTML = '<div class="state"><h3>No saved cameras yet</h3><p>Tap “Add to Favorites” on any camera to keep it here. Favorites are stored in this browser only.</p><a class="btn btn--primary" href="#cameras">Browse cameras</a></div>';
        } else {
            grid.innerHTML = cams.map((c, i) => tileHTML(c, i)
                .replace('tile reveal', 'tile reveal is-in')
                .replace(`data-action="fav" data-id="${c.id}" aria-pressed="false">Add to Favorites<`, `data-action="unfav" data-id="${c.id}">Remove Favorite<`)).join('');
        }
        syncToggles();
    }
    function toggleFav(id, forceRemove) {
        if (!byId(id)) return;
        if (state.favs.has(id) || forceRemove) { state.favs.delete(id); toast('Removed from favorites'); }
        else { state.favs.add(id); toast('Saved to favorites'); }
        storage.set('favs', Array.from(state.favs)); renderFavorites();
    }

    let revealObserver = null;
    function observeReveal(root) {
        const els = $$('.reveal:not(.is-in)', root);
        if (!('IntersectionObserver' in window) || reduceMotion()) { els.forEach((e) => e.classList.add('is-in')); return; }
        if (!revealObserver) {
            revealObserver = new IntersectionObserver((entries) => {
                entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); revealObserver.unobserve(en.target); } });
            }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
        }
        els.forEach((e) => revealObserver.observe(e));
    }

    let flipObserver = null;
    function observeFlip(root) {
        const els = $$('.flipin:not(.is-in)', root);
        if (!('IntersectionObserver' in window) || reduceMotion()) { els.forEach((e) => e.classList.add('is-in')); return; }
        if (!flipObserver) {
            flipObserver = new IntersectionObserver((entries) => {
                entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); flipObserver.unobserve(en.target); } });
            }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
        }
        els.forEach((e) => flipObserver.observe(e));
    }

    function setupNav() {
        const nav = $('#nav'); const toggle = $('#navToggle'); const links = $('#navLinks');
        const onScroll = () => nav.classList.toggle('is-solid', window.scrollY > 24);
        onScroll(); let ticking = false;
        window.addEventListener('scroll', () => {
            if (ticking) return; ticking = true;
            requestAnimationFrame(() => {
                onScroll();
                const pg = $('#progress'); if (pg) { const m = document.documentElement.scrollHeight - window.innerHeight; pg.style.transform = 'scaleX(' + (m > 0 ? Math.min(1, window.scrollY / m) : 0).toFixed(3) + ')'; }
                const hero = $('#heroMedia');
                if (hero && !reduceMotion() && window.scrollY < window.innerHeight) hero.style.setProperty('--py', `${Math.round(window.scrollY * 0.12)}px`);
                ticking = false;
            });
        }, { passive: true });
        let openY = 0;
        const closeMenu = () => { toggle.setAttribute('aria-expanded', 'false'); links.classList.remove('is-open'); };
        toggle.addEventListener('click', () => {
            const open = toggle.getAttribute('aria-expanded') !== 'true';
            toggle.setAttribute('aria-expanded', String(open)); links.classList.toggle('is-open', open);
            openY = window.scrollY;
        });
        window.addEventListener('scroll', () => {
            if (links.classList.contains('is-open') && Math.abs(window.scrollY - openY) > 10) closeMenu();
        }, { passive: true });
        document.addEventListener('click', (e) => {
            const a = e.target.closest('a[href^="#"]');
            if (!a || a.getAttribute('href') === '#') return;
            const target = document.getElementById(a.getAttribute('href').slice(1)); if (!target) return;
            e.preventDefault();
            target.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
            history.replaceState(null, '', a.getAttribute('href'));
            toggle.setAttribute('aria-expanded', 'false'); links.classList.remove('is-open');
        });
        if ('IntersectionObserver' in window) {
            const io = new IntersectionObserver((entries) => {
                entries.forEach((en) => { if (en.isIntersecting) $$('.nav__links a').forEach((a) => a.setAttribute('aria-current', String(a.dataset.nav === en.target.id))); });
            }, { rootMargin: '-45% 0px -50% 0px' });
            $$('[data-section]').forEach((s) => io.observe(s));
        }
    }

    function clearFilters() {
        state.prefs = { q: '', series: 'all', license: 'all', sort: 'old' };
        $('#fQuery').value = ''; $('#fSeries').value = 'all'; $('#fSort').value = 'old';
        renderCameras();
    }
    async function liveSearch(q) {
        try {
            const rows = await Api.searchModels(/sony/i.test(q) ? q : 'sony ' + q);
            const fresh = buildCatalog(rows).filter((c) => !state.byId.has(c.id));
            if (!fresh.length) return;
            fresh.forEach((c) => { state.cameras.push(c); state.byId.set(c.id, c); });
            populateFilters(); $('#fQuery').value = state.prefs.q; renderCameras(); renderGallery();
            Viewer.syncOptions(); renderCompare(); renderLineup();
            toast(`${fresh.length} more model${fresh.length > 1 ? 's' : ''} found on Sketchfab`);
        } catch (e) { }
    }
    function setupFilters() {
        let t = 0;
        let lt = 0;
        $('#fQuery').addEventListener('input', (e) => {
            clearTimeout(t); t = setTimeout(() => { state.prefs.q = e.target.value; renderCameras(); }, 160);
            clearTimeout(lt); const q = e.target.value.trim();
            if (q.length >= 2) lt = setTimeout(() => liveSearch(q), 700);
        });
        $('#fSeries').addEventListener('change', (e) => { state.prefs.series = e.target.value; renderCameras(); });
        $('#fSort').addEventListener('change', (e) => { state.prefs.sort = e.target.value; renderCameras(); });
        $('#clearFilters').addEventListener('click', clearFilters);
        $('#galleryMore').addEventListener('click', () => { state.galleryShown += CONFIG.GALLERY_PAGE; renderGallery(); });
        $('#compareAddBtn').addEventListener('click', () => { const id = $('#compareAdd').value; if (id) toggleCompare(id); });
        $('#compareClear').addEventListener('click', () => { state.compare = []; storage.set('compare', []); renderCompare(); toast('Comparison cleared'); });
    }

    function focusables(root) {
        return $$('a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])', root).filter((el) => !el.hidden && el.offsetParent !== null);
    }
    function trapTab(e, root) {
        const f = focusables(root); if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function setupGlobalEvents() {
        document.addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]'); if (!el) return;
            const id = el.dataset.id;
            switch (el.dataset.action) {
                case 'details': Modal.open(byId(id), el); break;
                case 'fav': toggleFav(id); break;
                case 'unfav': toggleFav(id, true); break;
                case 'compare': case 'remove-compare': toggleCompare(id); break;
                case 'clear-filters': clearFilters(); break;
                case 'retry': loadData(); break;
                case 'open-3d': {
                    if (!byId(id)) break;
                    Modal.close(); $('#vModel').value = id; storage.set('vModel', id); Viewer.setModel(id);
                    $('#inside').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
                    break;
                }
                case 'modal-close': Modal.close(); break;
                case 'tab': Modal.setTab(Number(el.dataset.index)); break;
                case 'modal-thumb': Modal.setImage(Number(el.dataset.index)); break;
                case 'modal-zoom': {
                    const list = Modal.items.filter((c) => c.thumbLarge || c.thumb);
                    Lightbox.open(list, Math.max(0, list.indexOf(Modal.items[Modal.idx])), el); break;
                }
                case 'gallery-open': Lightbox.open(galleryItems(), Number(el.dataset.index), el); break;
                case 'lb-close': Lightbox.close(); break;
                case 'lb-prev': Lightbox.step(-1); break;
                case 'lb-next': Lightbox.step(1); break;
                default: break;
            }
        });
        document.addEventListener('keydown', (e) => {
            const lbOpen = !$('#lightbox').hidden; const mdOpen = !$('#modal').hidden;
            if (lbOpen) {
                if (e.key === 'Escape') { e.preventDefault(); Lightbox.close(); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); Lightbox.step(-1); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); Lightbox.step(1); }
                else if (e.key === 'Tab') trapTab(e, $('#lightbox'));
                return;
            }
            if (mdOpen) {
                if (e.key === 'Escape') { e.preventDefault(); Modal.close(); return; }
                if (e.target.classList && e.target.classList.contains('tab') && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault();
                    Modal.setTab(e.key === 'ArrowRight' ? Modal.tab + 1 : e.key === 'ArrowLeft' ? Modal.tab - 1 : e.key === 'Home' ? 0 : Modal.tabList.length - 1, true); return;
                }
                if (e.key === 'Tab') trapTab(e, $('#modalSheet'));
            }
        });
        document.addEventListener('mousemove', (e) => {
            const z = e.target.closest && e.target.closest('.zoom'); if (!z) return;
            const r = z.getBoundingClientRect();
            z.style.setProperty('--zx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
            z.style.setProperty('--zy', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
        });
        let spot = 0;
        document.addEventListener('mousemove', (e) => {
            const t = e.target.closest && e.target.closest('.tile'); if (!t || spot) return;
            spot = requestAnimationFrame(() => { const r = t.getBoundingClientRect(); t.style.setProperty('--mx', (e.clientX - r.left) + 'px'); t.style.setProperty('--my', (e.clientY - r.top) + 'px'); spot = 0; });
        }, { passive: true });
        document.addEventListener('error', (e) => {
            const t = e.target;
            if (t && t.tagName === 'IMG' && t.hasAttribute('data-cam-img')) {
                const next = THUMB_FALLBACK.get(t.getAttribute('src'));
                if (next) { t.src = next; return; }
                t.insertAdjacentHTML('afterend', noImgHTML()); t.remove();
            }
        }, true);
    }

    const Sparks = {
        init() {
            const cv = $('#sparks'); const ctx = cv && cv.getContext && cv.getContext('2d'); if (!ctx) return;
            const rand = (a, b) => a + Math.random() * (b - a);
            const COLORS = ['243,240,233', '243,240,233', '243,240,233', '185,205,255', '224,138,79', '110,214,205', '240,195,110', '150,160,255', '232,127,168'];
            let w = 0; let h = 0; let list = []; let raf = 0; let last = 0;
            const make = () => { const r = rand(0.5, 1.6); return { x: rand(0, w), y: rand(0, h), r, vx: rand(-0.006, 0.006), vy: -rand(0.004, 0.02), ph: rand(0, 6.28), sp: rand(0.0006, 0.0022), base: rand(0.25, 0.85), glint: r > 1.15 && Math.random() < 0.55, c: COLORS[(Math.random() * COLORS.length) | 0] }; };
            const size = () => {
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                w = window.innerWidth; h = window.innerHeight;
                cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                list = Array.from({ length: Math.round(Math.max(36, Math.min(100, w * h / 18000))) }, make);
            };
            const draw = (t, dt) => {
                ctx.clearRect(0, 0, w, h);
                list.forEach((p) => {
                    p.x += p.vx * dt; p.y += p.vy * dt;
                    if (p.y < -10) { p.y = h + 10; p.x = rand(0, w); }
                    if (p.x < -10) p.x = w + 10; else if (p.x > w + 10) p.x = -10;
                    const tw = 0.5 + 0.5 * Math.sin(t * p.sp + p.ph);
                    const cu = window.__afCur; let near = 0; if (cu) { const dx = p.x - cu.x; const dy = p.y - cu.y; const d2 = dx * dx + dy * dy; if (d2 < 36100) near = 1 - Math.sqrt(d2) / 190; }
                    const a = Math.min(1, p.base * (0.25 + 0.75 * tw) + near * 0.8); const col = 'rgb(' + p.c + ')';
                    ctx.globalAlpha = a; ctx.fillStyle = col;
                    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + near * 1.3), 0, 6.2832); ctx.fill();
                    if (p.glint || near > 0.45) {
                        const L = p.r * 7 * (a / p.base); ctx.strokeStyle = col; ctx.lineWidth = 0.6;
                        ctx.beginPath(); ctx.moveTo(p.x - L, p.y); ctx.lineTo(p.x + L, p.y); ctx.moveTo(p.x, p.y - L); ctx.lineTo(p.x, p.y + L); ctx.stroke();
                    }
                });
                ctx.globalAlpha = 1;
            };
            const frame = (t) => { const dt = Math.min(64, t - (last || t)); last = t; draw(t, dt); raf = requestAnimationFrame(frame); };
            const start = () => { if (!raf && !reduceMotion()) { last = 0; raf = requestAnimationFrame(frame); } };
            const stop = () => { cancelAnimationFrame(raf); raf = 0; };
            document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
            let rt = 0;
            window.addEventListener('resize', () => {
                clearTimeout(rt);
                rt = setTimeout(() => { if (Math.abs(window.innerWidth - w) < 2 && Math.abs(window.innerHeight - h) < 140) return; size(); if (reduceMotion()) draw(0, 0); }, 150);
            });
            size();
            if (reduceMotion()) draw(0, 0); else start();
        }
    };

    const Cut = {
        cache: new Map(), q: [], busy: false,
        scan(root) {
            $$('img[data-cam-img]', root).forEach((img) => {
                if (img.dataset.cut || !img.closest('.hero__media')) return;
                img.dataset.cut = '1'; this.q.push(img);
            });
            this.pump();
        },
        async pump() {
            if (this.busy) return; this.busy = true;
            while (this.q.length) {
                const img = this.q.shift(); const src = img.getAttribute('src'); if (!src || !img.isConnected) continue;
                let out = this.cache.get(src);
                if (out === undefined) { out = await this.make(src); this.cache.set(src, out); }
                if (out && img.isConnected) { img.src = out; img.classList.add('is-cut'); img.parentElement.classList.add('has-cut'); }
            }
            this.busy = false;
        },
        make(src) {
            return new Promise((res) => {
                const im = new Image(); im.crossOrigin = 'anonymous';
                im.onerror = () => res(false);
                im.onload = () => {
                    try {
                        const s = Math.min(1, 1400 / im.naturalWidth); const W = Math.round(im.naturalWidth * s); const H = Math.round(im.naturalHeight * s);
                        const c = document.createElement('canvas'); c.width = W; c.height = H;
                        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, W, H);
                        const d = x.getImageData(0, 0, W, H); const p = d.data;
                        const lum = (i) => (p[i] * 3 + p[i + 1] * 6 + p[i + 2]) / 10;
                        let lo = 255; let hi = 0; const edge = [];
                        for (let k = 0; k < W; k++) edge.push(k, (H - 1) * W + k);
                        for (let k = 0; k < H; k++) edge.push(k * W, k * W + W - 1);
                        edge.forEach((n) => { const l = lum(n * 4); lo = Math.min(lo, l); hi = Math.max(hi, l); });
                        if (hi - lo > 150) return res(false);
                        lo -= 45; hi += 14;
                        const seen = new Uint8Array(W * H); const st = new Int32Array(W * H); let sp = 0;
                        edge.forEach((n) => { if (!seen[n]) { seen[n] = 1; st[sp++] = n; } });
                        const dist = (a, b) => Math.abs(p[a] - p[b]) + Math.abs(p[a + 1] - p[b + 1]) + Math.abs(p[a + 2] - p[b + 2]);
                        while (sp) {
                            const n = st[--sp]; const px = n % W; const py = (n / W) | 0;
                            [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]].forEach(([qx, qy]) => {
                                if (qx < 0 || qy < 0 || qx >= W || qy >= H) return;
                                const m = qy * W + qx; if (seen[m]) return;
                                const l = lum(m * 4);
                                if (l >= lo && l <= hi && dist(m * 4, n * 4) < 24) { seen[m] = 1; st[sp++] = m; }
                            });
                        }
                        let x0 = W; let y0 = H; let x1 = 0; let y1 = 0; let kept = 0;
                        for (let n = 0; n < W * H; n++) {
                            if (seen[n]) { p[n * 4 + 3] = 0; continue; }
                            kept++; const px = n % W; const py = (n / W) | 0;
                            if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
                            if (seen[n - 1] || seen[n + 1] || seen[n - W] || seen[n + W]) p[n * 4 + 3] = 150;
                        }
                        if (kept < W * H * 0.04 || kept > W * H * 0.8) return res(false);
                        x.putImageData(d, 0, 0);
                        const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.05);
                        x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
                        const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
                        o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
                        res(o.toDataURL('image/png'));
                    } catch (e) { res(false); }
                };
                im.src = src;
            });
        }
    };

    function showLoadFailure(title, text, retry) {
        $('#cameraGrid').innerHTML = ''; $('#cameraGrid').setAttribute('aria-busy', 'false');
        $('#resultCount').textContent = '';
        $('#cameraStatus').innerHTML = stateBox(title, text, retry);
        $('.skeleton', $('#heroMedia'))?.remove();
        if (!$('.noimg', $('#heroMedia'))) $('#heroMedia').insertAdjacentHTML('afterbegin', noImgHTML());
        $('#viewerPosterImg').innerHTML = noImgHTML();
        $('#viewerLoad').disabled = true;
    }

    async function loadData() {
        if (state.loading) return; state.loading = true;
        renderSkeletons();
        earlyHero();
        try {
            const rows = await Api.fetchCameras();
            state.cameras = buildCatalog(rows);
            state.byId = new Map(state.cameras.map((c) => [c.id, c]));
            state.favs = new Set(Array.from(state.favs).filter((id) => state.byId.has(id)));
            state.compare = state.compare.filter((id) => state.byId.has(id)).slice(0, CONFIG.MAX_COMPARE);
            if (!state.cameras.length) {
                showLoadFailure('No Sony Alpha models found', 'Sketchfab responded, but none of the results could be identified as Sony Alpha camera models. Nothing has been invented to fill the gap.', true);
            } else {
                $('#viewerLoad').disabled = false;
                populateFilters(); renderCameras(); renderHero(); renderGallery(); renderLineup();
                Viewer.populate(); renderCompare(); renderFavorites();
            }
        } catch (err) {
            showLoadFailure('Camera models could not be loaded', (err && err.message ? err.message : 'Unknown error') + ' Check your connection and try again.', true);
        } finally { state.loading = false; }
    }

    function init() {
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
        window.scrollTo(0, 0);
        window.addEventListener('pageshow', (e) => { if (e.persisted) window.scrollTo(0, 0); });
        Sparks.init(); setupNav(); setupFilters(); setupGlobalEvents();
        Viewer.init(); Lens.init();
        observeReveal(document);
        let cutT = 0; new MutationObserver(() => { clearTimeout(cutT); cutT = setTimeout(() => Cut.scan(document), 120); }).observe(document.body, { childList: true, subtree: true });
        renderCompare(); renderFavorites();
        loadData();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

(() => {
    'use strict';
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const LIT = '.tile,.toolbar,.guide details,.state,.btn,.seg button,.tab,a.src,.gallery__item';
    let pend = 0, lastT = null, lx = 0, ly = 0;
    document.addEventListener('mousemove', (e) => {
        lastT = e.target; lx = e.clientX; ly = e.clientY;
        if (pend) return;
        pend = requestAnimationFrame(() => {
            pend = 0;
            const lit = lastT && lastT.closest && lastT.closest(LIT);
            if (lit) { const r = lit.getBoundingClientRect(); lit.style.setProperty('--mx', (lx - r.left).toFixed(0) + 'px'); lit.style.setProperty('--my', (ly - r.top).toFixed(0) + 'px'); }
            const hero = document.getElementById('home');
            if (hero && window.scrollY < window.innerHeight) {
                hero.style.setProperty('--cx', ((lx / window.innerWidth - 0.5) * 2).toFixed(3));
                hero.style.setProperty('--cy', ((ly / window.innerHeight - 0.5) * 2).toFixed(3));
            }
        });
    }, { passive: true });
})();