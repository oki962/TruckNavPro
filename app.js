let map, currentUserLocation;
const tomtomKey = "";
const maptilerKey = "SBcreDqKo6myDrCeUBGs";

let restrictionMarkers = [];
let currentRoutesData = null; // Przechowuje trasy wektorowe
let routeTooltips = []; // Dymki dla tras
let poiMarkers = []; // Markery POI (parkingi, stacje, mop)
let myDriveMarker = null; // Marker naszej ciężarówki
let isUserPanning = false; // Flaga czy kierowca przesuwa mapę
let navWatchId = null; // ID śledzenia GPS
let wakeLock = null;

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

    map.on('dragstart', () => {
        isUserPanning = true;
        const centerBtn = document.getElementById('recenter-btn');
        if(centerBtn) centerBtn.style.display = 'block';
    });

    // ZMIANA: Czekamy 800ms po zakończeniu przesuwania mapy, żeby nie zaspamować serwera
    map.on('moveend', () => {
        clearTimeout(overpassTimeout);
        overpassTimeout = setTimeout(() => {
            fetchRestrictions();
            fetchPOIs();
        }, 1500);
    });

        // Odczytywanie zapisanej trasy z LocalStorage przy starcie
    let routeRestored = false;
    try {
        const savedRouteStr = localStorage.getItem('trucknav_last_route');
        if (savedRouteStr) {
            const savedRoute = JSON.parse(savedRouteStr);
            if (savedRoute && savedRoute.start && savedRoute.dest) {
                // Wypełnianie pól formularza
                document.getElementById('input-start').value = savedRoute.start.name;
                document.getElementById('lat-start').value = savedRoute.start.lat;
                document.getElementById('lng-start').value = savedRoute.start.lng;

                document.getElementById('input-dest').value = savedRoute.dest.name;
                document.getElementById('lat-dest').value = savedRoute.dest.lat;
                document.getElementById('lng-dest').value = savedRoute.dest.lng;

                // Otwieramy panel tras (który teraz nie ukrywa głównego paska wyszukiwarki)
                openFullPanel();
                setTimeout(() => { calculateRoute(); }, 500);

                routeRestored = true;
            }
        }
    } catch (e) {
        console.warn("Błąd odczytu z LocalStorage", e);
    }

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(position => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            currentUserLocation = { lat, lng };

            // Jeśli nie przywróciliśmy trasy, używamy GPS-u jako punkt startowy i centrum
            if (!routeRestored) {
                map.flyTo({ center: [lng, lat], zoom: 14.5 });
                document.getElementById('input-start').value = "📍 Twoja lokalizacja";
                document.getElementById('lat-start').value = lat;
                document.getElementById('lng-start').value = lng;
            }
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
    fetch(`/api/search?q=${encodeURIComponent(query)}`).then(res => res.json()).then(data => {
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
async function calculateRoute(isBackground = false) {
    const p = profiles[activeProfileIdx];
    if (!p.isConfigured) {
        if (!isBackground) alert("Skonfiguruj pojazd w ustawieniach!");
        return;
    }

    const routePointsElements = Array.from(document.querySelectorAll('#sortable-route-list .route-point'));
    const points = routePointsElements.map(pt => {
        const lat = pt.querySelector('.lat-val').value, lng = pt.querySelector('.lng-val').value;
        return (lat && lng) ? `${lat},${lng}` : null;
    }).filter(Boolean);

    if (points.length < 2) {
        if (!isBackground) alert("Wybierz poprawnie lokalizacje.");
        return;
    }

    // Zapisujemy trasę (Start i Cel) w pamięci urządzenia (LocalStorage)
    try {
        const startEl = routePointsElements[0];
        const destEl = routePointsElements[routePointsElements.length - 1];

        const startData = {
            name: startEl.querySelector('.place-input').value,
            lat: startEl.querySelector('.lat-val').value,
            lng: startEl.querySelector('.lng-val').value
        };
        const destData = {
            name: destEl.querySelector('.place-input').value,
            lat: destEl.querySelector('.lat-val').value,
            lng: destEl.querySelector('.lng-val').value
        };

        if (startData.lat && destData.lat) {
            localStorage.setItem('trucknav_last_route', JSON.stringify({ start: startData, dest: destData }));
        }
    } catch (e) {
        console.warn("Błąd zapisu do LocalStorage", e);
    }

    let travelMode = (p.type === "bus" || p.type === "van") ? p.type : "truck";
    let dims = `&vehicleWeight=${p.w*1000}&vehicleAxleWeight=${p.aw*1000}&vehicleLength=${p.l}&vehicleWidth=${p.wid}&vehicleHeight=${p.h}&vehicleMaxSpeed=${p.speed}`;
    dims += `&vehicleEngineType=${(p.fuel === 'electric' || p.euro === 'zev') ? 'electric' : 'combustion'}`;
    if(p.adrLoad) dims += `&vehicleLoadType=${p.adrLoad}`;
    if(p.adrTunnel) dims += `&vehicleAdrcTunnelRestrictionCode=${p.adrTunnel}`;

    try {
        if (!isBackground) document.getElementById('calc-btn-text').innerText = "Szukam trasy...";
        const response = await fetch('/api/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points: points.join(':'), travelMode, dims })
        });
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
            // Twarde czyszczenie błędnych/starych warstw aby zapobiec konfliktom dodawania addLayer
            if (map.getLayer('routes-line')) map.removeLayer('routes-line');
            if (map.getLayer('routes-click')) map.removeLayer('routes-click');
            if (map.getSource('routes')) map.removeSource('routes');

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
                    'line-width': ['case', ['boolean', ['get', 'isMain'], false], 10, 6],
                    'line-opacity': ['case', ['boolean', ['get', 'isMain'], false], 1.0, 0.6]
                }
            });

            // Obsługa kliknięcia w alternatywną trasę
            // Najpierw zdejmujemy stare ewentualne nasłuchiwania by nie dublować callów
            map.off('click', 'routes-click');
            map.on('click', 'routes-click', (e) => {
                const clickedIdx = e.features[0].properties.index;
                currentRoutesData.features.forEach(f => f.properties.isMain = (f.properties.index === clickedIdx));
                map.getSource('routes').setData(currentRoutesData);

                const p = currentRoutesData.features.find(f => f.properties.isMain).properties;
                updateTelemetryPanel(p);
                renderRouteTooltips();
            });

            if (!isBackground) {
                renderRouteTooltips();

                // Centrowanie mapy tylko, gdy nie jedziemy (nie w tle)
                const bounds = new maptilersdk.LngLatBounds();
                currentRoutesData.features[0].geometry.coordinates.forEach(c => bounds.extend(c));
                map.fitBounds(bounds, { padding: 50 });

                // Pokaż przycisk Start Nav oraz Powrót tylko gdy wyliczamy nową trasę jako użytkownik
                document.getElementById('start-drive-btn').style.display = 'block';
                document.getElementById('exit-routing-btn').style.display = 'block';
            } else {
                // Gdy jesteśmy w tle usuwamy stare dymki z poprzedniej trasy jeśli były
                routeTooltips.forEach(t => t.remove());
                routeTooltips = [];
            }

            // Ale telemetrię odświeżamy zawsze
            updateTelemetryPanel(currentRoutesData.features[0].properties);
        }
    } catch (err) {
        if (!isBackground) alert('CRASH TRASY: ' + err.message + ' | ' + err.stack);
        console.error(err);
    }
    finally { if (!isBackground) document.getElementById('calc-btn-text').innerText = "Wyznacz trasę"; }
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
                const tomtomUrl = `/api/search?q=${encodeURIComponent(query)}&lat=${center.lat}&lon=${center.lng}`;

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
    // Ukrywamy tylko dolny pasek "Prowadź" (jeśli był widoczny) i okno wyszukiwarki pozostawiamy ZAWSZE widoczne dopóki nie zacznie się jazda
    document.getElementById('bottom-action-bar').style.display = 'none';

    // Otwieramy główny panel (wybór pojazdu/trasowanie) pod wyszukiwarką
    document.getElementById('full-search-panel').style.display = 'block';

    // Zamykamy dymek adresowy z mapy
    if (destinationMarker) destinationMarker.togglePopup();
}

function exitRouting() {
    // Zatrzymaj jeśli jedziemy
    stopNavigation();

    // Usuwanie warstw na mapie
    if (map.getSource('routes')) {
        if (map.getLayer('routes-line')) map.removeLayer('routes-line');
        if (map.getLayer('routes-click')) map.removeLayer('routes-click');
        map.removeSource('routes');
    }

    currentRoutesData = null;
    routeTooltips.forEach(t => t.remove());
    routeTooltips = [];

    // Zresetuj UI
    document.getElementById('full-search-panel').style.display = 'none';
    document.getElementById('exit-routing-btn').style.display = 'none';
    document.getElementById('telemetry-panel').style.display = 'none';
    document.getElementById('start-drive-btn').style.display = 'none';

    // Przywróć wyszukiwarki
    document.getElementById('simple-search-bar').style.display = 'block';
    document.getElementById('poi-panel-container').style.display = 'flex';

    // Wyśrodkuj na GPS
    if (currentUserLocation) {
        map.flyTo({ center: [currentUserLocation.lng, currentUserLocation.lat], zoom: 14.5, pitch: 45, duration: 1500 });
    }
}

window.onload = initMap;

// =========================================================================
// 8. OBSŁUGA POI Z OVERPASS API
// =========================================================================

function togglePoiMenu() {
    document.getElementById('poi-menu').classList.toggle('show');
}

function updatePoiVisibility() {
    const parkingEnabled = document.getElementById('poi-parking').checked;
    const fuelEnabled = document.getElementById('poi-fuel').checked;
    const mopEnabled = document.getElementById('poi-mop').checked;
    const laybyEnabled = document.getElementById('poi-layby').checked;

    poiMarkers.forEach(markerObj => {
        const type = markerObj.poiType;
        const el = markerObj.marker.getElement();

        let isVisible = false;
        if (type === 'parking' && parkingEnabled) isVisible = true;
        if (type === 'fuel' && fuelEnabled) isVisible = true;
        if (type === 'mop' && mopEnabled) isVisible = true;
        if (type === 'layby' && laybyEnabled) isVisible = true;

        el.style.display = isVisible ? 'flex' : 'none';
    });
}

async function fetchPOIs() {
    if (map.getZoom() < 13) {
        poiMarkers.forEach(m => m.marker.remove());
        poiMarkers = [];
        return;
    }

    const parkingEnabled = document.getElementById('poi-parking').checked;
    const fuelEnabled = document.getElementById('poi-fuel').checked;
    const mopEnabled = document.getElementById('poi-mop').checked;
    const laybyEnabled = document.getElementById('poi-layby').checked;

    if (!parkingEnabled && !fuelEnabled && !mopEnabled && !laybyEnabled) {
        // Jeśli wszystko jest odznaczone, ukrywamy je po stronie klienta (nie ma potrzeby ubijać zapytań zupełnie)
        // Ale możemy zaoszczędzić request:
        poiMarkers.forEach(m => m.marker.remove());
        poiMarkers = [];
        return;
    }

    const bounds = map.getBounds();
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    let filters = [];
    if (parkingEnabled) filters.push(`node["amenity"="parking"](${bbox});way["amenity"="parking"](${bbox});`);
    if (fuelEnabled) filters.push(`node["amenity"="fuel"](${bbox});way["amenity"="fuel"](${bbox});`);
    if (mopEnabled) filters.push(`node["highway"~"rest_area|services"](${bbox});way["highway"~"rest_area|services"](${bbox});`);
    if (laybyEnabled) filters.push(`node["highway"="layby"](${bbox});way["highway"="layby"](${bbox});`);

    const query = `[out:json][timeout:5];(${filters.join('')});out center;`;
    const url = `https://lz4.overpass-api.de/api/interpreter`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(query)}`
        });

        if (res.status === 429) return;
        if (!res.ok) throw new Error("HTTP status: " + res.status);

        const data = await res.json();

        // Czyszczenie poprzednich
        poiMarkers.forEach(m => m.marker.remove());
        poiMarkers = [];

        data.elements.forEach(el => {
            const lat = el.lat || (el.center && el.center.lat);
            const lon = el.lon || (el.center && el.center.lon);
            if (!lat || !lon) return;

            let icon = "📍";
            const tags = el.tags || {};

            if (tags.amenity === "parking") icon = "🅿️";
            else if (tags.amenity === "fuel") icon = "⛽";
            else if (tags.highway === "rest_area" || tags.highway === "services") icon = "☕";
            else if (tags.highway === "layby") icon = "🛣️";

            const elDiv = document.createElement('div');
            elDiv.className = 'osm-poi-marker';
            elDiv.innerHTML = icon;
            elDiv.onclick = (e) => {
                e.stopPropagation();
                dropPinAndShowAction(lat, lon, tags.name || "Brak nazwy (POI)", (tags.amenity || tags.highway));
            };

            const marker = new maptilersdk.Marker({ element: elDiv }).setLngLat([lon, lat]).addTo(map);

            // Określenie typu dla client-side filteringu
            let poiType = "";
            if (tags.amenity === "parking") poiType = "parking";
            else if (tags.amenity === "fuel") poiType = "fuel";
            else if (tags.highway === "rest_area" || tags.highway === "services") poiType = "mop";
            else if (tags.highway === "layby") poiType = "layby";

            poiMarkers.push({ marker: marker, poiType: poiType });
        });

        // Po załadowaniu nowych markerów od razu stosujemy na nich obecny stan filtrów
        updatePoiVisibility();

    } catch (e) {
        console.warn("Błąd pobierania POI z Overpass:", e);
    }
}

// =========================================================================
// 9. TRYB JAZDY NA ŻYWO (GPS WATCH, OBRÓT, PITCH)
// =========================================================================
let lastRouteCalcTime = 0;

function recenterMap() {
    isUserPanning = false;
    document.getElementById('recenter-btn').style.display = 'none';
    if (currentUserLocation) {
        map.flyTo({ center: [currentUserLocation.lng, currentUserLocation.lat], zoom: 14.5, pitch: 55, duration: 800 });
    }
}

function hideSearchPanels() {
    document.getElementById('full-search-panel').style.display = 'none';
    document.getElementById('simple-search-bar').style.display = 'none';
    document.getElementById('poi-panel-container').style.display = 'none';
    document.getElementById('start-drive-btn').style.display = 'none';
    document.getElementById('stop-drive-btn').style.display = 'block';

    // Upewniamy się ze ukrylismy smieci z poprzedniej wersji UI jezeli są
    const extBtn = document.getElementById('exit-routing-btn');
    if (extBtn) extBtn.style.display = 'none';
}

function startNavigation() {
    // Blokada ekranu (Screen Wake Lock API)
    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').then(wl => {
            wakeLock = wl;
        }).catch(err => console.warn('Błąd Wake Lock:', err));
    }

    // 1. Ukryj paski i alternatywne trasy
    hideSearchPanels();

    if (currentRoutesData) {
        const mainRoute = currentRoutesData.features.find(f => f.properties.isMain);
        if (mainRoute) {
            map.getSource('routes').setData({
                type: 'FeatureCollection',
                features: [mainRoute]
            });
        }
    }
    routeTooltips.forEach(t => t.remove());
    routeTooltips = [];

    // 2. FIZYCZNIE przełącz mapę w tryb jazdy 3D (pochylenie i delikatny zoom)
    map.setPitch(55);
    map.setZoom(14.5);
    isUserPanning = false;

    // 3. FIZYCZNIE odpal śledzenie GPS na żywo
    if (navigator.geolocation) {
        // Jeśli marker jeszcze nie istnieje, stwórzmy go (np. jako niebieskie kółko)
        if (!myDriveMarker) {
            const el = document.createElement('div');
            el.style.width = '24px';
            el.style.height = '24px';
            el.style.background = '#1a73e8';
            el.style.border = '3px solid white';
            el.style.borderRadius = '50%';
            el.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
            el.style.pointerEvents = 'none'; // Odpinamy wszelkie zjawiska touch & hover

            myDriveMarker = new maptilersdk.Marker({ element: el, pitchAlignment: 'map', interactive: false }).setLngLat([0,0]).addTo(map);
        }

        navWatchId = navigator.geolocation.watchPosition(function(position) {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            currentUserLocation = { lat, lng };

            let markerLng = lng;
            let markerLat = lat;

            // Jeśli mamy wyznaczoną trasę, przyciągamy znacznik do najbliższego punktu na linii
            if (currentRoutesData && currentRoutesData.features.length > 0) {
                const routeCoords = currentRoutesData.features.find(f => f.properties.isMain).geometry.coordinates;
                let minDist = Infinity;
                let closestCoord = null;

                // Szukamy najbliższego punktu trasy w promieniu kilku kilometrów
                for (let i = 0; i < Math.min(100, routeCoords.length); i++) {
                    const dist = Math.pow(routeCoords[i][0] - lng, 2) + Math.pow(routeCoords[i][1] - lat, 2);
                    if (dist < minDist) {
                        minDist = dist;
                        closestCoord = routeCoords[i];
                    }
                }

                // Jeśli jesteśmy w akceptowalnym korytarzu błędu (np. ok 100-200m), snapuj do trasy
                if (minDist < 0.00005 && closestCoord) {
                    markerLng = closestCoord[0];
                    markerLat = closestCoord[1];
                }
            }

            myDriveMarker.setLngLat([markerLng, markerLat]);

            // WAŻNE: Aktualizuj centrowanie mapy również na podstawie przyciągniętych współrzędnych!
            if (!isUserPanning) {
                map.easeTo({ center: [markerLng, markerLat], bearing: position.coords.heading || map.getBearing(), duration: 1000, easing: t => t });
            }

            // Route Trimming: Obcinanie przejechanych punktów za ciężarówką
            if (currentRoutesData && currentRoutesData.features && currentRoutesData.features.length > 0) {
                // Bezpieczne wymuszenie ukrycia szarych, odrzuconych tras by nie wracały przy trimowaniu
                currentRoutesData.features = currentRoutesData.features.filter(f => f.properties.isMain);

                let coords = currentRoutesData.features[0].geometry.coordinates;
                let minDist = Infinity;
                let closestIdx = 0;
                // Szukaj najbliższego punktu tylko w promieniu kilkudziesięciu najbliższych, żeby nie zawracać
                for (let i = 0; i < Math.min(50, coords.length); i++) {
                    const dist = Math.pow(coords[i][0] - lng, 2) + Math.pow(coords[i][1] - lat, 2);
                    if (dist < minDist) { minDist = dist; closestIdx = i; }
                }
                if (closestIdx > 0) {
                    currentRoutesData.features[0].geometry.coordinates = coords.slice(closestIdx);
                    if (map.getSource('routes')) map.getSource('routes').setData(currentRoutesData);
                }
            }
        }, function(error) {
            console.error('Błąd GPS: ' + error.message);
        }, { enableHighAccuracy: true });
    } else {
        alert('Twoja przeglądarka nie obsługuje GPS!');
    }
}

function stopNavigation() {
    if (wakeLock) {
        wakeLock.release().then(() => wakeLock = null);
    }

    if (navWatchId) {
        navigator.geolocation.clearWatch(navWatchId);
        navWatchId = null;
    }
    map.setPitch(0); // Zgodnie z wczesniejsza wola user (nie zostawiamy 45 pochylonego bo user narzekal na to kiedys)
    map.setBearing(0);

    if(myDriveMarker) { myDriveMarker.remove(); myDriveMarker = null; }

    // Przywróć wyszukiwarkę bazową
    document.getElementById('full-search-panel').style.display = 'none';
    document.getElementById('stop-drive-btn').style.display = 'none';
    document.getElementById('simple-search-bar').style.display = 'block';
    document.getElementById('poi-panel-container').style.display = 'flex';
    document.getElementById('recenter-btn').style.display = 'none';

    if(map.getSource('routes')) map.getSource('routes').setData({ type: 'FeatureCollection', features: [] });
}
