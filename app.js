let map, currentUserLocation;
const tomtomKey = "";
const maptilerKey = "";

let restrictionMarkers = [];
let currentRoutesData = null; // Przechowuje trasy wektorowe
let routeTooltips = []; // Dymki dla tras

// =========================================================================
// 1. PROFILE POJAZDÓW
// =========================================================================
let profiles = [
    { name: "Pojazd 1", type: "articulated", h: 4.0, wid: 2.55, l: 16.5, w: 40, aw: 11.5, axles: 5, speed: 85, year: 2022, euro: "6", fuel: "diesel", adrLoad: "", adrTunnel: "", isConfigured: true },
    { name: "Pojazd 2", type: "unconfigured", h: 4.0, wid: 2.55, l: 16.5, w: 40, aw: 11.5, axles: 5, speed: 85, year: 2022, euro: "6", fuel: "diesel", adrLoad: "", adrTunnel: "", isConfigured: false },
    { name: "Pojazd 3", type: "unconfigured", h: 4.0, wid: 2.55, l: 16.5, w: 40, aw: 11.5, axles: 5, speed: 85, year: 2022, euro: "6", fuel: "diesel", adrLoad: "", adrTunnel: "", isConfigured: false }
];
let activeProfileIdx = 0;
const typeIcons = { articulated: "🚛", rigid: "🚚", roadtrain: "🚛➕🛞", tractor: "🚜", van: "🚐", bus: "🚌", unconfigured: "⚪" };

// =========================================================================
// 2. INICJALIZACJA NOWOCZESNEJ MAPY (MapTiler 360 + Języki)
// =========================================================================
let overpassTimeout; // Hamulec dla zapytań do Overpass API

function initMap() {
    maptilersdk.config.apiKey = maptilerKey;
    maptilersdk.config.primaryLanguage = maptilersdk.Language.POLISH;

    map = new maptilersdk.Map({
        container: 'map',
        style: maptilersdk.MapStyle.STREETS,
        center: [19.0238, 50.2649],
        zoom: 14,
        pitch: 45,
        bearing: 0
    });

    map.on('load', () => {
        setupAutocomplete('input-start');
        setupAutocomplete('input-dest');
        setupSimpleSearch('input-simple-search');
        renderProfileMenu();
        fetchRestrictions(); // Pobierz znaki na start
    });

    // ZMIANA: Czekamy 800ms po zakończeniu przesuwania mapy, żeby nie zaspamować serwera
    map.on('moveend', () => {
        clearTimeout(overpassTimeout);
        overpassTimeout = setTimeout(fetchRestrictions, 1500);
    });

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(position => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            currentUserLocation = { lat, lng };
            map.flyTo({ center: [lng, lat], zoom: 14.5 });
            document.getElementById('input-start').value = "📍 Twoja lokalizacja";
            document.getElementById('lat-start').value = lat;
            document.getElementById('lng-start').value = lng;
        }, () => console.log("Brak GPS."));
    }
}

// =========================================================================
// 3. MAGIA ZNAKÓW (Zabezpieczenie przed 429 i 504)
// =========================================================================
async function fetchRestrictions() {
    // ZMIANA: Wymagamy jeszcze większego przybliżenia (14.5), żeby chronić serwer
    if (map.getZoom() < 14.5) {
        restrictionMarkers.forEach(m => m.remove());
        restrictionMarkers = [];
        return;
    }

    const bounds = map.getBounds();
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    // ZMIANA: Dodajemy timeout:5, żeby serwer szybko ucinał zapytanie jeśli jest za duże, zamiast wisieć
    const query = `[out:json][timeout:5];(way["maxheight"](${bbox});node["maxheight"](${bbox});way["maxweight"](${bbox});node["maxweight"](${bbox}););out center;`;

    // ZMIANA: Używamy szybszego klastra (lz4)
    const url = `https://lz4.overpass-api.de/api/interpreter`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `data=${encodeURIComponent(query)}`
        });

        // Cicha obsługa limitów - jeśli przesadzimy, apka po prostu ignoruje próbę
        if (res.status === 429) {
            console.warn("Overpass: Limit zapytań. Przesuwaj mapę wolniej.");
            return;
        }

        if (!res.ok) throw new Error(`HTTP status: ${res.status}`);
        const data = await res.json();

        restrictionMarkers.forEach(m => m.remove());
        restrictionMarkers = [];

        data.elements.forEach(el => {
            const lat = el.lat || (el.center && el.center.lat);
            const lon = el.lon || (el.center && el.center.lon);
            if(!lat || !lon) return;

            let text = "";
            let cssClass = "restriction-marker";

            // Pobieramy surowe wartości z bazy
            let h = el.tags.maxheight;
            let w = el.tags.maxweight;

            // Tworzymy filtr: sprawdzamy, czy w wartości znajduje się jakakolwiek cyfra (0-9)
            const hasNumber = (val) => /\d/.test(val);

            // Rysujemy znak TYLKO jeśli ma konkretną wartość liczbową (omijamy "default", "none", "unsigned")
            if(h && hasNumber(h)) {
                // Czasami w OSM ktoś wpisze "3,5" zamiast "3.5" - ujednolicamy to dla estetyki
                text = `↕ ${h.replace(',', '.')}`;
            }
            else if(w && hasNumber(w)) {
                text = `⚖ ${w.replace(',', '.')}`;
                cssClass += " weight";
            }

            if(text) {
                const elDiv = document.createElement('div');
                elDiv.className = cssClass;
                elDiv.innerHTML = text;
                const marker = new maptilersdk.Marker({element: elDiv}).setLngLat([lon, lat]).addTo(map);
                restrictionMarkers.push(marker);
            }
        });
    } catch(e) {
        console.log("Overpass: Zbyt duży obszar lub serwer zajęty. Zrób zoom.", e.message);
    }
}

// =========================================================================
// 4. INTELIGENTNA WYSZUKIWARKA (Kaskada + GPS)
// =========================================================================
let searchTimeout;
const searchCache = {};

function setupAutocomplete(inputId) {
    const inputEl = document.getElementById(inputId);
    const wrapper = inputEl.parentElement;
    const dropdown = document.createElement('div');
    dropdown.className = 'autocomplete-dropdown';
    wrapper.appendChild(dropdown);

    inputEl.addEventListener('input', function() {
        clearTimeout(searchTimeout);
        const query = this.value.trim();
        if (query.length < 3) { dropdown.style.display = 'none'; return; }

        // Wykrywanie GPS
        const cleanQuery = query.replace(/\s+/g, ' ').trim();
        const isGpsPattern = /^[+-]?\d+(?:[\.,]\d+)?(?:\s*[\s,;]\s*)[+-]?\d+(?:[\.,]\d+)?$/.test(cleanQuery);

        if (isGpsPattern) {
            const matches = cleanQuery.match(/[+-]?\d+(?:[\.,]\d+)?/g);
            if (matches && matches.length === 2) {
                const lat = parseFloat(matches[0].replace(',', '.'));
                const lng = parseFloat(matches[1].replace(',', '.'));
                if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                    wrapper.querySelector('.lat-val').value = lat;
                    wrapper.querySelector('.lng-val').value = lng;
                    dropdown.innerHTML = `<div class="autocomplete-item" id="gps-direct-click" style="background: #e8f0fe; color: #1a73e8; font-weight: 600;"><strong>📍 Wykryto współrzędne GPS</strong><br><small>Kliknij, aby zatwierdzić.</small></div>`;
                    dropdown.style.display = 'block';
                    dropdown.querySelector('#gps-direct-click').onclick = () => { inputEl.value = `${lat}, ${lng}`; dropdown.style.display = 'none'; };
                    return;
                }
            }
        }

        searchTimeout = setTimeout(() => {
            let locationBias = currentUserLocation ? `&lat=${currentUserLocation.lat}&lon=${currentUserLocation.lng}&zoom=10` : '';
            const europeBbox = "&bbox=-10.0,35.0,40.0,70.0";
            const photonLocalUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lang=pl${locationBias}${europeBbox}`;
            const photonGlobalUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lang=pl${locationBias}`;

            const processResults = (features) => {
                const formattedResults = features.map(f => {
                    const p = f.properties;
                    return { name: p.name || p.city || p.street || "Brak nazwy", context: [p.city, p.state, p.country].filter(Boolean).join(', '), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
                });
                renderDropdown(formattedResults, dropdown, inputEl, wrapper);
            };

            fetch(photonLocalUrl).then(res => res.json()).then(dataLocal => {
                if (dataLocal.features && dataLocal.features.length > 0) processResults(dataLocal.features);
                else fetch(photonGlobalUrl).then(res => res.json()).then(dataGlobal => {
                    if (dataGlobal.features && dataGlobal.features.length > 0) processResults(dataGlobal.features);
                    else fallbackToTomTom(query, dropdown, inputEl, wrapper);
                }).catch(() => fallbackToTomTom(query, dropdown, inputEl, wrapper));
            }).catch(() => fallbackToTomTom(query, dropdown, inputEl, wrapper));
        }, 600);
    });

    document.getElementsByTagName('body')[0].addEventListener('click', (e) => { if (!wrapper.contains(e.target)) dropdown.style.display = 'none'; });
}

function fallbackToTomTom(query, dropdown, inputEl, wrapper) {
    fetch(`https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?key=${tomtomKey}&language=pl-PL&limit=5`).then(res => res.json()).then(data => {
        if (data.results && data.results.length > 0) {
            const formattedResults = data.results.map(r => ({ name: r.poi ? r.poi.name : (r.address.localName || r.address.freeformAddress), context: r.address.freeformAddress + (r.address.country ? `, ${r.address.country}` : ''), lat: r.position.lat, lng: r.position.lon }));
            renderDropdown(formattedResults, dropdown, inputEl, wrapper);
        } else { dropdown.innerHTML = `<div class="autocomplete-item" style="color:red;">Brak wyników</div>`; dropdown.style.display = 'block'; }
    });
}

function renderDropdown(results, dropdown, inputEl, wrapper) {
    dropdown.innerHTML = '';
    results.forEach(res => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.innerHTML = `<strong>${res.name}</strong><br><small>${res.context}</small>`;
        item.onclick = () => { inputEl.value = `${res.name}, ${res.context}`; dropdown.style.display = 'none'; wrapper.querySelector('.lat-val').value = res.lat; wrapper.querySelector('.lng-val').value = res.lng; };
        dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
}

// =========================================================================
// 5. OBSŁUGA INTERFEJSU I PROFILI (Z zachowaniem starych funkcji)
// =========================================================================
const routeList = document.getElementById('sortable-route-list');
new Sortable(routeList, { handle: '.drag-handle', animation: 150, onEnd: function () { updatePlaceholders(); } });

function renderProfileMenu() {
    const container = document.getElementById('profile-options');
    container.innerHTML = '';
    profiles.forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = 'profile-list-item';
        const btn = document.createElement('button');
        btn.className = `profile-option-btn ${idx === activeProfileIdx ? 'active' : ''}`;
        btn.onclick = () => selectProfile(idx);
        btn.innerText = p.isConfigured ? `${typeIcons[p.type] || "🚛"} ${p.name} (${p.w}t)` : `⚪ ${p.name} (Pusty slot)`;
        const editBtn = document.createElement('button');
        editBtn.className = 'profile-edit-btn'; editBtn.innerHTML = '⚙️'; editBtn.onclick = (e) => { e.stopPropagation(); openSettingsModal(idx); };
        row.appendChild(btn); row.appendChild(editBtn); container.appendChild(row);
    });
    const activeP = profiles[activeProfileIdx];
    document.getElementById('active-profile-name').innerText = activeP.isConfigured ? `${typeIcons[activeP.type] || "🚛"} ${activeP.name} (${activeP.w}t)` : `Wymaga konfiguracji: ${activeP.name}`;
}

function selectProfile(idx) { activeProfileIdx = idx; document.getElementById('profile-options').style.display = 'none'; renderProfileMenu(); }
function toggleProfileMenu() { const m = document.getElementById('profile-options'); m.style.display = m.style.display === 'flex' ? 'none' : 'flex'; }
function updatePlaceholders() { const i = document.querySelectorAll('#sortable-route-list .place-input'); i.forEach((inp, idx) => { inp.placeholder = idx === 0 ? "Punkt Startowy..." : (idx === i.length - 1 ? "Cel docelowy..." : "Przystanek pośredni..."); }); document.querySelectorAll('#sortable-route-list .remove-btn').forEach(btn => btn.style.display = i.length <= 2 ? 'none' : 'block'); }
function addWaypoint() { const id = 'wp-' + Date.now(); const c = document.getElementById("sortable-route-list"); const w = document.createElement("div"); w.className = "input-wrapper autocomplete-container route-point"; w.style.marginTop = "6px"; w.innerHTML = `<div class="drag-handle">⋮⋮</div><input type="text" class="place-input" id="input-${id}" placeholder="Przystanek..."><input type="hidden" class="lat-val" id="lat-${id}"><input type="hidden" class="lng-val" id="lng-${id}"><button class="icon-btn remove-btn" onclick="removePoint(this)">✖</button>`; c.insertBefore(w, c.lastElementChild); setupAutocomplete(`input-${id}`); updatePlaceholders(); }
function removePoint(btn) { btn.parentElement.remove(); updatePlaceholders(); }
function openSettingsModal(idx) { if(idx !== undefined) activeProfileIdx = idx; const p = profiles[activeProfileIdx]; document.getElementById('v-name').value = p.name; document.getElementById('v-type').value = p.type === "unconfigured" ? "articulated" : p.type; ['h','wid','l','w','aw','speed','axles','year'].forEach(k => document.getElementById(`v-${k}`).value = p[k] || ''); document.getElementById('v-euro').value = p.euro || '6'; document.getElementById('v-fuel').value = p.fuel || 'diesel'; document.getElementById('v-adr-load').value = p.adrLoad || ''; document.getElementById('v-adr-tunnel').value = p.adrTunnel || ''; document.getElementById('profile-options').style.display = 'none'; document.getElementById('settings-modal').style.display = 'flex'; }
function closeSettingsModal() { document.getElementById('settings-modal').style.display = 'none'; }
function saveSettings() { const p = profiles[activeProfileIdx]; p.name = document.getElementById('v-name').value || `Pojazd ${activeProfileIdx + 1}`; p.type = document.getElementById('v-type').value; ['h','wid','l','w','aw','speed','axles','year'].forEach(k => p[k] = parseFloat(document.getElementById(`v-${k}`).value)); p.euro = document.getElementById('v-euro').value; p.fuel = document.getElementById('v-fuel').value; p.adrLoad = document.getElementById('v-adr-load').value; p.adrTunnel = document.getElementById('v-adr-tunnel').value; p.isConfigured = true; closeSettingsModal(); renderProfileMenu(); }
function resetSettings() { if (confirm("Zresetować profil?")) { profiles[activeProfileIdx] = { name: `Pojazd ${activeProfileIdx + 1}`, type: "unconfigured", h: 4.0, wid: 2.55, l: 16.5, w: 40, aw: 11.5, axles: 5, speed: 85, year: 2022, euro: "6", fuel: "diesel", adrLoad: "", adrTunnel: "", isConfigured: false }; closeSettingsModal(); renderProfileMenu(); } }
const defaultSpecs = { articulated: { h: 4.0, wid: 2.55, l: 16.5, w: 40, aw: 11.5, speed: 85, axles: 5 }, rigid: { h: 3.8, wid: 2.55, l: 10.0, w: 26, aw: 11.5, speed: 80, axles: 3 }, roadtrain: { h: 4.0, wid: 2.55, l: 18.75,w: 40, aw: 11.5, speed: 85, axles: 5 }, tractor: { h: 3.2, wid: 2.55, l: 6.0, w: 8, aw: 11.5, speed: 85, axles: 2 }, van: { h: 2.6, wid: 2.20, l: 6.5, w: 3.5, aw: 2.0, speed: 110,axles: 2 }, bus: { h: 3.8, wid: 2.55, l: 12.0, w: 24, aw: 11.5, speed: 100,axles: 2 } };
function autoFillSpecs() { const s = defaultSpecs[document.getElementById('v-type').value]; if(s) { ['h','wid','l','w','aw','axles','speed'].forEach(k => document.getElementById(`v-${k}`).value = s[k]); document.getElementById('v-adr-load').value = ""; document.getElementById('v-adr-tunnel').value = ""; } }

// =========================================================================
// 6. ROUTING TOMTOM (Wersja wektorowa z klikalnymi alternatywami i dymkami)
// =========================================================================
async function calculateRoute() {
    const p = profiles[activeProfileIdx];
    if (!p.isConfigured) return alert("Skonfiguruj pojazd w ustawieniach!");

    const points = Array.from(document.querySelectorAll('#sortable-route-list .route-point')).map(pt => {
        const lat = pt.querySelector('.lat-val').value, lng = pt.querySelector('.lng-val').value;
        return (lat && lng) ? `${lat},${lng}` : null;
    }).filter(Boolean);

    if (points.length < 2) return alert("Wybierz poprawnie lokalizacje.");

    let travelMode = (p.type === "bus" || p.type === "van") ? p.type : "truck";
    let dims = `&vehicleWeight=${p.w*1000}&vehicleAxleWeight=${p.aw*1000}&vehicleLength=${p.l}&vehicleWidth=${p.wid}&vehicleHeight=${p.h}&vehicleMaxSpeed=${p.speed}`;
    dims += `&vehicleEngineType=${(p.fuel === 'electric' || p.euro === 'zev') ? 'electric' : 'combustion'}`;
    if(p.adrLoad) dims += `&vehicleLoadType=${p.adrLoad}`;
    if(p.adrTunnel) dims += `&vehicleAdrcTunnelRestrictionCode=${p.adrTunnel}`;

    // UWAGA: maxAlternatives=2 zwraca aż 3 trasy
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${points.join(':')}/json?key=${tomtomKey}&travelMode=${travelMode}&vehicleCommercial=true${dims}&traffic=true&maxAlternatives=2`;

    try {
        document.getElementById('calc-btn-text').innerText = "Szukam trasy...";
        const response = await fetch(url);
        const data = await response.json();

        currentRoutesData = { type: 'FeatureCollection', features: [] };

        if (data.routes && data.routes.length > 0) {
            data.routes.forEach((route, idx) => {
                const path = route.legs.flatMap(leg => leg.points.map(pt => [pt.longitude, pt.latitude]));
                const middlePt = path[Math.floor(path.length / 2)];
                const tHrs = Math.floor(route.summary.travelTimeInSeconds / 3600);
                const tMins = Math.floor((route.summary.travelTimeInSeconds % 3600) / 60);
                const distKm = (route.summary.lengthInMeters / 1000).toFixed(1);
                const delayMins = Math.round(route.summary.trafficDelayInSeconds / 60);

                currentRoutesData.features.push({
                    type: 'Feature',
                    properties: {
                        index: idx,
                        isMain: (idx === 0),
                        timeFormat: tHrs > 0 ? `${tHrs}h ${tMins}m` : `${tMins}m`,
                        distKm: distKm + ' km',
                        delayText: delayMins > 0 ? `+${delayMins}m` : '',
                        midPoint: middlePt
                    },
                    geometry: { type: 'LineString', coordinates: path }
                });
            });

            // Rysowanie na mapie
            if (map.getSource('routes')) {
                map.getSource('routes').setData(currentRoutesData);
            } else {
                map.addSource('routes', { type: 'geojson', data: currentRoutesData });

                // Szeroka, niewidzialna warstwa do ułatwienia klikania palcem na ekranie
                map.addLayer({
                    id: 'routes-click', type: 'line', source: 'routes',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-width': 30, 'line-opacity': 0 }
                });

                // Właściwa widoczna linia
                map.addLayer({
                    id: 'routes-line', type: 'line', source: 'routes',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: {
                        'line-color': ['case', ['boolean', ['get', 'isMain'], false], '#1a73e8', '#808080'],
                        'line-width': ['case', ['boolean', ['get', 'isMain'], false], 7, 5],
                        'line-opacity': ['case', ['boolean', ['get', 'isMain'], false], 1.0, 0.6]
                    }
                });

                // Obsługa kliknięcia w alternatywną trasę
                map.on('click', 'routes-click', (e) => {
                    const clickedIdx = e.features[0].properties.index;
                    currentRoutesData.features.forEach(f => f.properties.isMain = (f.properties.index === clickedIdx));
                    map.getSource('routes').setData(currentRoutesData);

                    const p = currentRoutesData.features.find(f => f.properties.isMain).properties;
                    updateTelemetryPanel(p);
                    renderRouteTooltips();
                });
            }

            renderRouteTooltips();
            updateTelemetryPanel(currentRoutesData.features[0].properties);

            // Centrowanie mapy
            const bounds = new maptilersdk.LngLatBounds();
            currentRoutesData.features[0].geometry.coordinates.forEach(c => bounds.extend(c));
            map.fitBounds(bounds, { padding: 50 });
        }
    } catch (e) { alert("Wystąpił problem z wyznaczeniem trasy."); }
    finally { document.getElementById('calc-btn-text').innerText = "Wyznacz trasę"; }
}

function renderRouteTooltips() {
    routeTooltips.forEach(t => t.remove());
    routeTooltips = [];

    // Sortujemy, żeby dymek głównej trasy (isMain=true) rysował się na wierzchu (jako ostatni)
    const sortedFeatures = [...currentRoutesData.features].sort((a, b) => a.properties.isMain ? 1 : -1);

    sortedFeatures.forEach(f => {
        const p = f.properties;
        const el = document.createElement('div');
        el.innerHTML = `
            <div style="text-align:center; font-family:sans-serif; line-height: 1.2;">
                <div style="font-size:15px; font-weight:800; color:${p.isMain ? '#1a73e8' : '#6b7280'};">${p.timeFormat}</div>
                <div style="font-size:13px; font-weight:600; color:#4b5563; margin-top:2px;">${p.distKm}</div>
                ${p.delayText ? `<div style="color:#ef4444; font-size:13px; font-weight:800; margin-top:2px;">${p.delayText}</div>` : ''}
            </div>
        `;
        Object.assign(el.style, {
            background: 'rgba(255, 255, 255, 0.95)', padding: '8px 12px', borderRadius: '20px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)', cursor: 'pointer',
            border: p.isMain ? '2px solid #1a73e8' : '1px solid #d1d5db',
            transform: p.isMain ? 'scale(1.1)' : 'scale(1.0)', transition: '0.2s'
        });

        el.onclick = (e) => {
            e.stopPropagation();
            currentRoutesData.features.forEach(feature => feature.properties.isMain = (feature.properties.index === p.index));
            map.getSource('routes').setData(currentRoutesData);
            updateTelemetryPanel(p);
            renderRouteTooltips();
        };

        const marker = new maptilersdk.Marker({ element: el, anchor: 'center' }).setLngLat(p.midPoint).addTo(map);
        routeTooltips.push(marker);
    });
}

function updateTelemetryPanel(p) {
    document.getElementById('telemetry-panel').style.display = 'flex';
    document.getElementById('t-time').innerText = p.timeFormat;
    document.getElementById('t-dist').innerText = p.distKm;
    const d = document.getElementById('t-delay');
    if (p.delayText) { d.innerText = p.delayText; d.style.color = '#ef4444'; }
    else { d.innerText = "Brak"; d.style.color = '#10b981'; }
}

// =========================================================================
// 7. CZYSTY INTERFEJS STARTOWY (Oszczędna Kaskada: OSM -> TomTom 1-strzałowy)
// =========================================================================
let destinationMarker = null; // <--- TEGO ZABRAKŁO W POPRZEDNIM KODZIE!

function setupSimpleSearch(inputId) {
    const inputEl = document.getElementById(inputId);
    if(!inputEl) return;
    const wrapper = inputEl.parentElement;

    let dropdown = wrapper.querySelector('.autocomplete-dropdown');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown';
        wrapper.appendChild(dropdown);
    }

    inputEl.addEventListener('input', function() {
        clearTimeout(searchTimeout);
        const query = this.value.trim();
        if (query.length < 3) { dropdown.style.display = 'none'; return; }

        searchTimeout = setTimeout(() => {
            const center = map.getCenter(); // Kotwica GPS

            // 1. DARMOWY PHOTON (Zasięg: Europa) - 0 PLN
            const europeBbox = "&bbox=-10.0,35.0,40.0,70.0";
            const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5${europeBbox}&lat=${center.lat}&lon=${center.lng}`;

            fetch(photonUrl)
            .then(res => {
                if (!res.ok) throw new Error("Błąd OSM");
                return res.json();
            })
            .then(data => {
                if (data.features && data.features.length > 0) {
                    renderSimpleDropdown(data.features.map(f => {
                        const p = f.properties;
                        const isPOI = (p.osm_key !== "highway" && p.osm_key !== "boundary" && p.osm_key !== "place");
                        return {
                            name: p.name || p.city || p.street || "Nieznane",
                            context: [p.city, p.state, p.country].filter(Boolean).join(', '),
                            lat: f.geometry.coordinates[1],
                            lng: f.geometry.coordinates[0],
                            source: "OSM",
                            isPOI: isPOI
                        };
                    }), dropdown, inputEl);
                } else {
                    throw new Error("Pusto w darmowej bazie");
                }
            })
            .catch(() => {
                // 2. KASKADA: TOMTOM (1 płatne zapytanie)
                const tomtomUrl = `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?key=${tomtomKey}&language=pl-PL&limit=5&typeahead=true&lat=${center.lat}&lon=${center.lng}`;

                fetch(tomtomUrl)
                .then(res => res.json())
                .then(data => {
                    if (data.results && data.results.length > 0) {
                        renderSimpleDropdown(data.results.map(r => ({
                            name: r.poi ? r.poi.name : (r.address.localName || r.address.freeformAddress),
                            context: r.address.freeformAddress + (r.address.country ? `, ${r.address.country}` : ''),
                            lat: r.position.lat,
                            lng: r.position.lon,
                            source: "TomTom",
                            isPOI: (r.type === "POI")
                        })), dropdown, inputEl);
                    } else {
                        dropdown.innerHTML = `<div class="autocomplete-item" style="color:red; text-align:center;">Brak wyników</div>`;
                        dropdown.style.display = 'block';
                    }
                })
                .catch(err => console.error("Błąd sieciowy TomTom:", err));
            });
        }, 500);
    });

    document.getElementsByTagName('body')[0].addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) dropdown.style.display = 'none';
    });
}

// Funkcja rysująca listę wyników z dodanym podglądem źródła i ikonami
function renderSimpleDropdown(results, dropdown, inputEl) {
    dropdown.innerHTML = '';
    results.forEach(r => {
        const icon = r.isPOI ? "🏢" : "📍"; // Budynek dla firm, pinezka dla ulic i miast
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        // Wyświetlamy mały, szary tekst np. [OSM (Darmowe)] żebyś wiedział, kto odpowiedział
        item.innerHTML = `<strong>${icon} ${r.name}</strong> <span style="font-size: 10px; color: #888; margin-left: 5px;">[${r.source}]</span><br><small>${r.context}</small>`;

        item.onclick = () => {
            inputEl.value = r.name;
            dropdown.style.display = 'none';
            dropPinAndShowAction(r.lat, r.lng, r.name, r.context);
        };
        dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
}

function dropPinAndShowAction(lat, lng, name, context) {
    // 1. Zbliżenie i lot na miejsce
    map.flyTo({ center: [lng, lat], zoom: 15.5, pitch: 45 });

    // 2. Usuwamy starą pinezkę jeśli jest
    if (destinationMarker) destinationMarker.remove();

    // 3. Dodajemy czerwoną pinezkę z wyskakującym dymkiem
    destinationMarker = new maptilersdk.Marker({ color: "#ef4444" })
        .setLngLat([lng, lat])
        .setPopup(new maptilersdk.Popup({ closeOnClick: false }).setHTML(`
            <div style="text-align:center; padding: 4px;">
                <div style="font-weight: 800; font-size: 14px;">${name}</div>
                <div style="font-size: 12px; color: #666; margin-top:2px;">${context}</div>
            </div>
        `))
        .addTo(map);

    destinationMarker.togglePopup();

    // 4. Pokazujemy dolny przycisk "Prowadź"
    document.getElementById('bottom-action-bar').style.display = 'flex';
    document.getElementById('address-preview-text').innerText = name;

    // 5. Zapisujemy dane do ukrytego, głównego formularza, który użyjemy później
    document.getElementById('input-dest').value = `${name}, ${context}`;
    document.getElementById('lat-dest').value = lat;
    document.getElementById('lng-dest').value = lng;
}

function openFullPanel() {
    // Ukrywamy czysty interfejs
    document.getElementById('simple-search-bar').style.display = 'none';
    document.getElementById('bottom-action-bar').style.display = 'none';

    // Otwieramy główny panel (wypełniony już współrzędnymi GPS na starcie i wybranym celem)
    document.getElementById('full-search-panel').style.display = 'block';

    // Zamykamy dymek adresowy, żeby nie zasłaniał mapy podczas szukania trasy
    if (destinationMarker) destinationMarker.togglePopup();
}

window.onload = initMap;
