/**
 * --- AeroTrack Pro Light-UX Telemetry Dashboard ---
 * Compatible with local filesystem execution (bypasses module CORS locks)
 */

const droneRegistry = new Map();
let map = null;
let ws = null;

const STALE_TIMEOUT_MS = 12000;

// --- Firebase Project Configurations ---
// Set USE_CUSTOM_FIREBASE to true to use your credentials below:
const USE_CUSTOM_FIREBASE = true;

const firebaseConfig = {
  apiKey: "AIzaSyBWaNvDC47AyTKmK3icsYxuFSs_YKTdYP4",
  authDomain: "droneremoteid-f924a.firebaseapp.com",
  databaseURL: "https://droneremoteid-f924a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "droneremoteid-f924a",
  storageBucket: "droneremoteid-f924a.firebasestorage.app",
  messagingSenderId: "142286084198",
  appId: "1:142286084198:web:c3474290f549ba9c1235a7",
  measurementId: "G-PDEZRL77MV"
};

// Target database reference name (Firestore collection or Realtime Database path)
const DATABASE_REF_NAME = "drones";

// Dual-Database handling layers (Standard Compat Objects)
let db = null;   // Firestore instance
let rtdb = null; // Realtime Database instance
let auth = null;
let isFirebaseActive = false;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Local Fallback Database in-memory array (retains session persistence for direct previews)
let localArchiveLogs = [];
const databaseWriteThrottleTimes = new Map();

// Local active status toggles for receiver hardware
const receiverStatus = {
  'BLE_ADV': true,
  'WIFI_BEACON': true
};

document.addEventListener("DOMContentLoaded", async () => {
  initMapCanvas();

  await initDatabasePipeline();

  initWebSocketConnection();

  document.getElementById("btn-clear-stale").addEventListener("click", purgeStaleDrones);
  setInterval(verifyActiveLifespans, 4000);
});

/**
 * Toggles a virtual hardware receiver on or off.
 */
window.toggleReceiverInterface = function (protocolType) {
  const isChecked = document.getElementById(protocolType === 'BLE_ADV' ? 'radio-toggle-ble' : 'radio-toggle-wifi').checked;
  receiverStatus[protocolType] = isChecked;

  // If we just toggled a protocol off, clear active live tracks of that type immediately
  if (!isChecked) {
    droneRegistry.forEach((node, id) => {
      const rowElement = document.getElementById(node.domElementId);
      if (rowElement) {
        const protocolText = rowElement.querySelector('.protocol-badge').innerText;
        if ((protocolType === 'BLE_ADV' && protocolText === 'BLE ADV') ||
          (protocolType === 'WIFI_BEACON' && protocolText === 'WIFI BEACON')) {
          map.removeLayer(node.marker);
          map.removeLayer(node.pathLine);
          map.removeLayer(node.destMarker);
          rowElement.remove();
          droneRegistry.delete(id);
        }
      }
    });
    updateGlobalTelemetryCounters();
  }
};

function updateFirebaseStatus(statusText, color) {
  const element = document.getElementById("firebase-status-val");
  if (element) {
    element.innerText = statusText;
    element.style.color = color;
  }
}

/**
 * Secures a connection to the persistence database, with a dynamic local fallback.
 */
async function initDatabasePipeline() {
  let configToUse = null;

  updateFirebaseStatus("CONNECTING", "var(--state-warning)");

  if (USE_CUSTOM_FIREBASE && firebaseConfig.apiKey !== "YOUR_API_KEY") {
    configToUse = firebaseConfig;
  } else if (typeof __firebase_config !== 'undefined') {
    try {
      configToUse = JSON.parse(__firebase_config);
    } catch (e) {
      console.warn("Failed to parse system __firebase_config", e);
    }
  }

  if (!configToUse) {
    console.log("No custom or system Firebase config detected. Falling back to local memory DB.");
    updateFirebaseStatus("LOCAL FALLBACK", "var(--state-warning)");
    loadCachedLocalLogs();
    return;
  }

  try {
    // Initialize using the Compat SDK globally available on window
    const app = firebase.initializeApp(configToUse);
    
    if (USE_CUSTOM_FIREBASE && firebaseConfig.apiKey !== "YOUR_API_KEY") {
      rtdb = firebase.database(app);
    } else {
      db = firebase.firestore(app);
    }
    
    auth = firebase.auth(app);

    // Authenticate anonymously or via custom token
    try {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        await auth.signInWithCustomToken(__initial_auth_token);
      } else {
        await auth.signInAnonymously();
      }
      console.log("Database secured. Secure session active.");
    } catch (authError) {
      console.warn("Authentication failed, proceeding with unauthenticated database context:", authError);
    }

    isFirebaseActive = true;
    initDatabaseTelemetryListener();
  } catch (error) {
    console.warn("Database connection failure. Activating local memory session fallback: ", error);
    updateFirebaseStatus("CONNECTION ERROR", "var(--state-offline)");
    loadCachedLocalLogs();
  }
}

/**
 * Loads cached simulation logs in local fallback database to ensure search functions work right away.
 */
function loadCachedLocalLogs() {
  const seedDrones = ["UAS-LOCAL-01", "UAS-LOCAL-02", "UAS-LOCAL-03", "UAS-LOCAL-04", "UAS-LOCAL-05"];
  const now = Date.now();

  for (let i = 0; i < 20; i++) {
    const dId = seedDrones[i % seedDrones.length];
    localArchiveLogs.push({
      drone_id: dId,
      mac_address: `FE:DC:BA:98:76:0${(i % seedDrones.length) + 1}`,
      protocol: i % 2 === 0 ? "BLE_ADV" : "WIFI_BEACON",
      rssi: -50 - (i * 2),
      latitude: 12.9716 + (Math.random() * 0.004 - 0.002),
      longitude: 77.5946 + (Math.random() * 0.004 - 0.002),
      altitude_feet: 100 + (i * 5),
      speed_mph: 15 + (i % 5),
      heading: (i * 35) % 360,
      payload_hex: "0201061bff4c00" + Math.floor(Math.random() * 100000),
      timestamp: now - (i * 10000)
    });
  }
  updateDroneFilterDropdown();
  executeArchiveQuery();
}

/**
 * Fetches log history from Firestore
 */
let firestoreTelemetryListener = null;
let realtimeDatabaseListener = null;

/**
 * Listens to the active database in real-time to stream telemetry.
 */
function initDatabaseTelemetryListener() {
  if (!isFirebaseActive) return;

  // Detach previous listeners
  if (firestoreTelemetryListener) {
    firestoreTelemetryListener();
    firestoreTelemetryListener = null;
  }
  if (realtimeDatabaseListener && rtdb) {
    rtdb.ref(DATABASE_REF_NAME).off('value', realtimeDatabaseListener);
    realtimeDatabaseListener = null;
  }

  const isCustomDb = USE_CUSTOM_FIREBASE && firebaseConfig.apiKey !== "YOUR_API_KEY";

  console.log("Initializing real-time telemetry stream listener...");
  let loadedInitially = false;

  if (isCustomDb && rtdb) {
    // --- Realtime Database (RTDB) Ingestion Path ---
    // Read from the root of "drones" node directly in RTDB
    const queryRef = rtdb.ref(DATABASE_REF_NAME);

    realtimeDatabaseListener = queryRef.on('value', (snapshot) => {
      // Update Firebase connection status to ONLINE
      updateFirebaseStatus("ONLINE", "var(--state-online)");
      
      // Clear local archive log cache to populate fresh snapshot data (prevents duplicates)
      localArchiveLogs = [];

      // Read query results (snapshot.forEach iterates over each drone node)
      snapshot.forEach((childSnapshot) => {
        const rawData = childSnapshot.val();
        if (!rawData) return;

        // If the data has a 'current' telemetry field (like /drones/RID001/current), extract it.
        // Otherwise, fall back to the root of the drone node.
        const telemetryPacket = rawData.current ? rawData.current : rawData;
        
        // Ensure we have a drone ID, defaulting to path key (e.g. "RID001") if missing
        const droneId = telemetryPacket.droneId || telemetryPacket.drone_id || childSnapshot.key;
        
        // Extract coordinates supporting both lat/lng and latitude/longitude
        let lat = typeof telemetryPacket.latitude === 'number' ? telemetryPacket.latitude : Number(telemetryPacket.lat);
        let lng = typeof telemetryPacket.longitude === 'number' ? telemetryPacket.longitude : Number(telemetryPacket.lng);
        
        // Check outer rawData for coordinates if missing in 'current'
        if (isNaN(lat) || isNaN(lng)) {
          lat = typeof rawData.latitude === 'number' ? rawData.latitude : Number(rawData.lat);
          lng = typeof rawData.longitude === 'number' ? rawData.longitude : Number(rawData.lng);
        }

        // Default location fallback (near Bengaluru anchor) if coordinates are missing
        if (isNaN(lat) || isNaN(lng)) {
          lat = 12.9716;
          lng = 77.5946;
        }

        // Normalize timestamp
        const ts = telemetryPacket.timestamp || telemetryPacket.last_seen_epoch || rawData.timestamp || Date.now();
        const parsedTimestamp = (ts && typeof ts.toMillis === 'function') 
          ? ts.toMillis() 
          : (ts && typeof ts.toDate === 'function' ? ts.toDate().getTime() : (Number(ts) || Date.now()));

        const normalizedPacket = {
          drone_id: droneId,
          mac_address: telemetryPacket.mac_address || telemetryPacket.mac || "00:00:00:00:00:00",
          protocol: telemetryPacket.protocol || "BLE_ADV",
          rssi: telemetryPacket.rssi !== undefined ? Number(telemetryPacket.rssi) : -70,
          latitude: lat,
          longitude: lng,
          altitude_feet: telemetryPacket.altitude !== undefined ? Number(telemetryPacket.altitude) : (telemetryPacket.altitude_feet !== undefined ? Number(telemetryPacket.altitude_feet) : 0),
          speed_mph: telemetryPacket.speed !== undefined ? Number(telemetryPacket.speed) : (telemetryPacket.speed_mph !== undefined ? Number(telemetryPacket.speed_mph) : 0),
          heading: telemetryPacket.heading !== undefined ? Number(telemetryPacket.heading) : 0,
          payload_hex: telemetryPacket.payload_hex || telemetryPacket.payload || "NO PAYLOAD",
          timestamp: parsedTimestamp
        };

        if (receiverStatus[normalizedPacket.protocol]) {
          processTargetTelemetry(normalizedPacket);
          // Add current packet to the list of log history
          localArchiveLogs.push(normalizedPacket);
        }

        // Also extract and add all points from 'logs' node if present
        // Schema: /drones/{droneId}/logs/{pushKey} -> { altitude, droneId, heading, latitude, longitude, pitch, roll, satellites, speed, status, timestamp }
        if (rawData.logs) {
          Object.keys(rawData.logs).forEach((pushKey) => {
            const histPacket = rawData.logs[pushKey];
            if (!histPacket) return;

            // logs entries may have a numeric timestamp or be missing one
            const histTs = histPacket.timestamp || histPacket.last_seen_epoch || Date.now();
            const parsedHistTimestamp = (histTs && typeof histTs.toMillis === 'function')
              ? histTs.toMillis()
              : (histTs && typeof histTs.toDate === 'function' ? histTs.toDate().getTime() : (Number(histTs) || Date.now()));

            // logs entries use 'altitude' (not altitude_feet) and 'speed' (not speed_mph)
            const histLat = typeof histPacket.latitude === 'number' ? histPacket.latitude : Number(histPacket.lat || 0);
            const histLng = typeof histPacket.longitude === 'number' ? histPacket.longitude : Number(histPacket.lng || 0);

            // Skip entries with no valid GPS fix
            if (histPacket.status === "NO_GPS" || (histLat === 0 && histLng === 0)) return;

            const normalizedHist = {
              drone_id: histPacket.droneId || droneId,
              mac_address: histPacket.mac_address || histPacket.mac || "00:00:00:00:00:00",
              protocol: histPacket.protocol || normalizedPacket.protocol || "BLE_ADV",
              rssi: histPacket.rssi !== undefined ? Number(histPacket.rssi) : -70,
              latitude: histLat,
              longitude: histLng,
              altitude_feet: histPacket.altitude !== undefined ? Number(histPacket.altitude) : (histPacket.altitude_feet !== undefined ? Number(histPacket.altitude_feet) : 0),
              speed_mph: histPacket.speed !== undefined ? Number(histPacket.speed) : (histPacket.speed_mph !== undefined ? Number(histPacket.speed_mph) : 0),
              heading: histPacket.heading !== undefined ? Number(histPacket.heading) : 0,
              // Extra fields from the real schema
              pitch: histPacket.pitch !== undefined ? Number(histPacket.pitch) : null,
              roll: histPacket.roll !== undefined ? Number(histPacket.roll) : null,
              satellites: histPacket.satellites !== undefined ? Number(histPacket.satellites) : null,
              status: histPacket.status || null,
              payload_hex: histPacket.payload_hex || histPacket.payload || "NO PAYLOAD",
              timestamp: parsedHistTimestamp
            };

            localArchiveLogs.push(normalizedHist);
          });
        }
      });

      // Sort all archive logs (newest first)
      localArchiveLogs.sort((a, b) => b.timestamp - a.timestamp);

      loadedInitially = true;
      updateDroneFilterDropdown();
      executeArchiveQuery();
    }, (error) => {
      console.error("Error in Realtime Database telemetry stream listener:", error);
      if (!loadedInitially) {
        updateFirebaseStatus("ACCESS DENIED", "var(--state-offline)");
        loadCachedLocalLogs();
      } else {
        updateFirebaseStatus("STREAM OFFLINE", "var(--state-warning)");
      }
    });
  } else if (db) {
    // --- Firestore Ingestion Path ---
    const collectionRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('uas_telemetry_logs');

    firestoreTelemetryListener = collectionRef
      .orderBy('timestamp', 'desc')
      .limit(100)
      .onSnapshot((snapshot) => {
        // Update Firebase connection status to ONLINE
        updateFirebaseStatus("ONLINE", "var(--state-online)");

        // Clear local archive log cache to populate fresh snapshot data (prevents duplicates)
        localArchiveLogs = [];

        const packets = [];
        snapshot.forEach((doc) => {
          packets.push(doc.data());
        });

        packets.reverse().forEach((telemetryPacket) => {
          const ts = telemetryPacket.timestamp;
          telemetryPacket.timestamp = (ts && typeof ts.toMillis === 'function') 
            ? ts.toMillis() 
            : (ts && typeof ts.toDate === 'function' ? ts.toDate().getTime() : (Number(ts) || Date.now()));

          telemetryPacket.protocol = telemetryPacket.protocol || "BLE_ADV";

          if (!receiverStatus[telemetryPacket.protocol]) {
            return;
          }

          processTargetTelemetry(telemetryPacket);
          localArchiveLogs.unshift(telemetryPacket);
        });

        loadedInitially = true;
        updateDroneFilterDropdown();
        executeArchiveQuery();
      }, (error) => {
        console.error("Error in Firestore telemetry stream listener:", error);
        if (!loadedInitially) {
          updateFirebaseStatus("ACCESS DENIED", "var(--state-offline)");
          loadCachedLocalLogs();
        } else {
          updateFirebaseStatus("STREAM OFFLINE", "var(--state-warning)");
        }
      });
  }
}

/**
 * Instantiates the Light-Themed Map Canvas Layer, then requests user geolocation.
 */
function initMapCanvas() {
  const localReceiverCenter = [12.9716, 77.5946];

  map = L.map('map-canvas', {
    zoomControl: true,
    attributionControl: false
  }).setView(localReceiverCenter, 15.5);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20
  }).addTo(map);

  // Clean, static 500m local transceiver coverage boundary
  L.circle(localReceiverCenter, {
    radius: 500,
    color: 'rgba(71, 85, 105, 0.25)',
    fillColor: 'rgba(71, 85, 105, 0.02)',
    fillOpacity: 1,
    weight: 1.2,
    dashArray: "3, 5"
  }).addTo(map);

  // Request user location, pan map to it and show a pulsing blue dot
  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const userLat = position.coords.latitude;
        const userLng = position.coords.longitude;

        map.setView([userLat, userLng], 15.5);

        const userIcon = L.divIcon({
          className: '',
          html: `
            <div style="position:relative;width:20px;height:20px;display:flex;align-items:center;justify-content:center;">
              <div style="position:absolute;width:20px;height:20px;background:rgba(37,99,235,0.2);border-radius:50%;animation:user-ping 1.6s ease-out infinite;"></div>
              <div style="position:absolute;width:10px;height:10px;background:#2563eb;border-radius:50%;border:2px solid #ffffff;box-shadow:0 0 0 2px rgba(37,99,235,0.4);z-index:2;"></div>
            </div>
            <style>@keyframes user-ping{0%{transform:scale(0.8);opacity:0.8}100%{transform:scale(2.4);opacity:0}}</style>
          `,
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        });

        L.marker([userLat, userLng], { icon: userIcon, zIndexOffset: 9999 })
          .addTo(map)
          .bindPopup('<b>Your Location</b><br>GCS Observer Position')
          .openPopup();

        console.log("User location acquired:", userLat.toFixed(5), userLng.toFixed(5));
      },
      (err) => {
        console.warn("Geolocation denied or unavailable:", err.message);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  }
}

/**
 * Manages WebSocket data ingestion loops
 */
function initWebSocketConnection() {
  const statusBadge = document.getElementById("conn-status-badge");
  const contextField = document.getElementById("backend-context-val");

  ws = new WebSocket("wss://drone-telemetry-backend.onrender.com");

  ws.onopen = () => {
    statusBadge.innerText = "Link Online";
    statusBadge.className = "status-badge status-online";
  };

  ws.onclose = () => {
    statusBadge.innerText = "Link Offline";
    statusBadge.className = "status-badge status-offline";
    contextField.innerText = "DISCONNECTED";
    contextField.className = "value text-muted";
    setTimeout(initWebSocketConnection, 4000);
  };

  ws.onmessage = (event) => {
    try {
      const telemetryPacket = JSON.parse(event.data);
      contextField.innerText = telemetryPacket.execution_context || "RUNNING";
      contextField.className = "value text-dark";

      // If custom Firebase is active, ignore simulated/fake packets from local WebSocket
      if (isFirebaseActive && telemetryPacket.execution_context === "TEST") {
        return;
      }

      // If corresponding hardware receiver toggle is disabled, discard packet
      if (!receiverStatus[telemetryPacket.protocol]) {
        return;
      }

      processTargetTelemetry(telemetryPacket);
      throttleAndPersistLog(telemetryPacket);
    } catch (err) {
      console.error("Packet extraction fault: ", err);
    }
  };
}

/**
 * Throttles telemetry inputs and writes them to the database once every 5 seconds per drone.
 */
async function throttleAndPersistLog(data) {
  const now = Date.now();
  const droneId = data.drone_id;
  const lastWriteTime = databaseWriteThrottleTimes.get(droneId) || 0;

  // Throttled writes to prevent database quota exhaust or performance lag
  if (now - lastWriteTime < 5000) return;

  databaseWriteThrottleTimes.set(droneId, now);

  const telemetryRecord = {
    drone_id: data.drone_id,
    mac_address: data.mac_address,
    protocol: data.protocol,
    rssi: Number(data.rssi),
    latitude: Number(data.latitude),
    longitude: Number(data.longitude),
    altitude_feet: Number(data.altitude_feet),
    speed_mph: Number(data.speed_mph),
    heading: Number(data.heading),
    payload_hex: data.payload_hex,
    timestamp: now
  };

  // Push to local list for immediate visual update
  localArchiveLogs.unshift(telemetryRecord);

  // Cap local memory registry list at 100 entries for lightweight memory tracking
  if (localArchiveLogs.length > 100) localArchiveLogs.pop();

  updateDroneFilterDropdown();
  executeArchiveQuery();

  if (isFirebaseActive) {
    try {
      if (USE_CUSTOM_FIREBASE && firebaseConfig.apiKey !== "YOUR_API_KEY" && rtdb) {
        // Update the current state of the drone
        await rtdb.ref(`${DATABASE_REF_NAME}/${droneId}/current`).set(telemetryRecord);
        // Append the record to the logs collection of that drone (matches schema: /drones/{id}/logs)
        await rtdb.ref(`${DATABASE_REF_NAME}/${droneId}/logs`).push(telemetryRecord);
      } else if (db) {
        // Firestore write
        const collectionRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('uas_telemetry_logs');
        await collectionRef.add(telemetryRecord);
      }
    } catch (err) {
      console.warn("Database storage failed: ", err);
    }
  }
}

/**
 * Updates coordinates dynamically and renders visual routes (without blinking effects)
 */
function processTargetTelemetry(data) {
  const droneId = data.drone_id || "UNKNOWN-DRONE";
  
  // Guard against missing/invalid coordinates
  if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number' || isNaN(data.latitude) || isNaN(data.longitude)) {
    console.warn("Invalid coordinate data for drone:", droneId, data);
    return;
  }
  
  const positionVector = [data.latitude, data.longitude];
  const hasDestination = typeof data.dest_latitude === 'number' && typeof data.dest_longitude === 'number' && !isNaN(data.dest_latitude) && !isNaN(data.dest_longitude);
  const destinationVector = hasDestination ? [data.dest_latitude, data.dest_longitude] : null;
  const markerColor = data.hex_color || "#475569";

  let targetNode = droneRegistry.get(droneId);

  if (!targetNode) {
    // Discovery: Generate clean, solid, non-pulsing map markers (small, high-precision dot with static wrapper ring)
    const customSolidIcon = L.divIcon({
      className: `marker-ctx-${droneId}`,
      html: `
        <div style="position: relative; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;">
          <!-- Static outer translucent boundary ring -->
          <div style="position: absolute; width: 22px; height: 22px; background-color: ${markerColor}; border-radius: 50%; opacity: 0.25;"></div>
          <!-- Solid high-contrast inner dot pointer -->
          <div style="position: absolute; width: 8px; height: 8px; background-color: ${markerColor}; border-radius: 50%; border: 1.5px solid #ffffff; z-index: 2;"></div>
        </div>
      `,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });

    const mapMarkerInstance = L.marker(positionVector, { icon: customSolidIcon }).addTo(map);

    let flightPathLine = null;
    let destinationNodeMarker = null;

    if (hasDestination) {
      // Projectile route trajectory line mapping current spot -> final local destination
      flightPathLine = L.polyline([positionVector, destinationVector], {
        color: markerColor,
        weight: 1.5,
        dashArray: "4, 5",
        opacity: 0.45
      }).addTo(map);

      // Circle marker indicating destination point
      destinationNodeMarker = L.circleMarker(destinationVector, {
        radius: 3,
        color: markerColor,
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 1.5
      }).addTo(map).bindPopup(`<b>${droneId} Destination Hub</b>`);
    }

    targetNode = {
      id: droneId,
      mac: data.mac_address || "00:00:00:00:00:00",
      marker: mapMarkerInstance,
      pathLine: flightPathLine,
      destMarker: destinationNodeMarker,
      domElementId: `drone-row-${droneId.replace(/[^A-Z0-9]/ig, "")}`,
      isExpanded: false
    };

    droneRegistry.set(droneId, targetNode);
    injectAccordionRowDOM(targetNode, data);
  } else {
    // Updates: Reposition marker, lines, and destination marker dynamically (provides smooth animated drift)
    targetNode.marker.setLatLng(positionVector);
    
    if (hasDestination) {
      if (targetNode.pathLine) {
        targetNode.pathLine.setLatLngs([positionVector, destinationVector]);
      } else {
        targetNode.pathLine = L.polyline([positionVector, destinationVector], {
          color: markerColor,
          weight: 1.5,
          dashArray: "4, 5",
          opacity: 0.45
        }).addTo(map);
      }
      
      if (targetNode.destMarker) {
        targetNode.destMarker.setLatLng(destinationVector);
      } else {
        targetNode.destMarker = L.circleMarker(destinationVector, {
          radius: 3,
          color: markerColor,
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).addTo(map).bindPopup(`<b>${droneId} Destination Hub</b>`);
      }
    } else {
      // Clean up destination layers if they were removed
      if (targetNode.pathLine) {
        map.removeLayer(targetNode.pathLine);
        targetNode.pathLine = null;
      }
      if (targetNode.destMarker) {
        map.removeLayer(targetNode.destMarker);
        targetNode.destMarker = null;
      }
    }
    
    updateAccordionRowDOM(targetNode, data);
  }

  targetNode.lastSeen = Date.now();
  targetNode.marker.bindPopup(`<h3>${droneId}</h3><p>Alt: ${data.altitude_feet !== undefined ? data.altitude_feet : 0} ft<br>Speed: ${data.speed_mph !== undefined ? data.speed_mph : 0} mph<br>Course: ${data.heading !== undefined ? data.heading : 0}°</p>`);

  updateGlobalTelemetryCounters();
}

/**
 * Creates dynamic accordion log card rows
 */
function injectAccordionRowDOM(node, data) {
  const container = document.getElementById("drone-accordion-container");
  const placeholder = document.getElementById("empty-state-placeholder");

  if (placeholder) placeholder.remove();

  const cardRow = document.createElement("div");
  cardRow.id = node.domElementId;
  cardRow.className = "drone-card-row";

  const protocolText = (data.protocol || "BLE_ADV").replace('_', ' ');
  const altText = data.altitude_feet !== undefined ? `${data.altitude_feet} ft` : '--';
  const spdText = data.speed_mph !== undefined ? `${data.speed_mph} mph` : '--';
  const rssiText = data.rssi !== undefined ? `${data.rssi} dBm` : '--';
  const headingText = data.heading !== undefined ? `${data.heading}° N` : '--';
  const latText = typeof data.latitude === 'number' ? data.latitude.toFixed(5) : '--';
  const lngText = typeof data.longitude === 'number' ? data.longitude.toFixed(5) : '--';
  const payloadText = data.payload_hex || 'NO PAYLOAD';

  cardRow.innerHTML = `
    <div class="row-header-summary" onclick="toggleAccordionDrawer('${node.id}')">
      <div class="col-identity">
        <span class="id-tag" style="color: ${data.hex_color || '#475569'};">${node.id || 'UNKNOWN'}</span>
        <span class="mac-lbl">${node.mac}</span>
      </div>
      <div>
        <span class="protocol-badge">${protocolText}</span>
      </div>
      <div class="col-metric hide-on-mobile">
        <span class="metric-label">Altitude</span>
        <span class="metric-val row-alt-val">${altText}</span>
      </div>
      <div class="col-metric hide-on-mobile">
        <span class="metric-label">Groundspeed</span>
        <span class="metric-val row-spd-val">${spdText}</span>
      </div>
      <div class="col-metric">
        <span class="metric-label">Signal (RSSI)</span>
        <span class="metric-val col-rssi row-rssi-val">${rssiText}</span>
      </div>
      <div class="chevron-indicator">▼</div>
    </div>
    
    <div class="row-drawer-details">
      <div class="drawer-inner-grid">
        <div class="spec-table-block">
          <div class="spec-item"><span class="lbl">True Bearing</span><span class="val row-hdg-val">${headingText}</span></div>
          <div class="spec-item"><span class="lbl">Latitude (GCS)</span><span class="val row-lat-val">${latText}</span></div>
          <div class="spec-item"><span class="lbl">Longitude (GCS)</span><span class="val row-lng-val">${lngText}</span></div>
          <div class="spec-item"><span class="lbl">Last Refresh</span><span class="val row-time-val">0s ago</span></div>
          <div class="spec-item" style="border-bottom: none; margin-top: auto; padding-top: 0.5rem;">
            <button class="action-btn-primary" style="padding: 0.35rem 0.65rem; font-size: 0.75rem; width: 100%; cursor: pointer;" onclick="event.stopPropagation(); viewDroneHistory('${node.id}')">View Full History</button>
          </div>
        </div>
        <div class="payload-hex-block">
          <span class="payload-hex-title">UAS Remote ID Payload Dump (Hex)</span>
          <div class="hex-dump-container row-hex-val">${payloadText}</div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(cardRow);
  applySignalColorContext(cardRow.querySelector(".row-rssi-val"), data.rssi !== undefined ? data.rssi : -70);
}

function updateAccordionRowDOM(node, data) {
  const row = document.getElementById(node.domElementId);
  if (!row) return;

  row.querySelector(".row-alt-val").innerText = data.altitude_feet !== undefined ? `${data.altitude_feet} ft` : '--';
  row.querySelector(".row-spd-val").innerText = data.speed_mph !== undefined ? `${data.speed_mph} mph` : '--';

  const rssiField = row.querySelector(".row-rssi-val");
  if (rssiField) {
    rssiField.innerText = data.rssi !== undefined ? `${data.rssi} dBm` : '--';
    applySignalColorContext(rssiField, data.rssi !== undefined ? data.rssi : -70);
  }

  const hdgField = row.querySelector(".row-hdg-val");
  if (hdgField) hdgField.innerText = data.heading !== undefined ? `${data.heading}° N` : '--';

  const latField = row.querySelector(".row-lat-val");
  if (latField) latField.innerText = typeof data.latitude === 'number' ? data.latitude.toFixed(5) : '--';

  const lngField = row.querySelector(".row-lng-val");
  if (lngField) lngField.innerText = typeof data.longitude === 'number' ? data.longitude.toFixed(5) : '--';
}

/**
 * Queries database logs against custom search criteria and displays them inside the Archive tab.
 */
function executeArchiveQuery() {
  const searchStr = document.getElementById("query-search-input").value.toLowerCase().trim();
  const filterProtocol = document.getElementById("filter-protocol").value;
  const filterRssiLimit = Number(document.getElementById("filter-rssi").value);
  const filterDrone = document.getElementById("filter-drone").value;

  const tbody = document.getElementById("archive-table-body");
  tbody.innerHTML = "";

  // Perform advanced signature filter operations in JavaScript memory
  const filteredLogs = localArchiveLogs.filter(log => {
    const matchesSearch = !searchStr ||
      log.drone_id.toLowerCase().includes(searchStr) ||
      log.mac_address.toLowerCase().includes(searchStr) ||
      log.payload_hex.toLowerCase().includes(searchStr);

    const matchesProtocol = filterProtocol === "ALL" || log.protocol === filterProtocol;
    const matchesRssi = log.rssi >= filterRssiLimit;
    const matchesDrone = filterDrone === "ALL" || log.drone_id === filterDrone;

    return matchesSearch && matchesProtocol && matchesRssi && matchesDrone;
  });

  if (filteredLogs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="table-empty-row">No records match the current search filters.</td></tr>`;
    return;
  }

  filteredLogs.forEach(log => {
    const row = document.createElement("tr");
    const dateStr = new Date(log.timestamp).toLocaleString();

    // Status column cell
    const statusCell = log.status
      ? `<span style="font-size:0.65rem;padding:0.1rem 0.35rem;border-radius:3px;background:${log.status === 'NO_GPS' ? '#fce8e6' : '#e6f4ea'};color:${log.status === 'NO_GPS' ? '#dc2626' : '#16a34a'};border:1px solid ${log.status === 'NO_GPS' ? '#f5c2c2' : '#bbf7d0'};font-family:var(--font-data);font-weight:600;">${log.status}</span>`
      : '<span style="color:var(--text-dim);font-size:0.72rem;">—</span>';

    const pitchVal = (log.pitch !== null && log.pitch !== undefined) ? `${Number(log.pitch).toFixed(1)}°` : '—';
    const rollVal  = (log.roll  !== null && log.roll  !== undefined) ? `${Number(log.roll ).toFixed(1)}°` : '—';

    row.innerHTML = `
      <td class="mono-cell" style="font-size:0.72rem;">${dateStr}</td>
      <td class="mono-cell" style="font-weight:600;">${log.drone_id}</td>
      <td><span class="protocol-badge">${(log.protocol || 'BLE_ADV').replace('_', ' ')}</span></td>
      <td>${statusCell}</td>
      <td class="mono-cell">${log.rssi} dBm</td>
      <td class="hide-on-mobile">${log.altitude_feet} ft</td>
      <td class="hide-on-mobile">${log.speed_mph} mph</td>
      <td class="mono-cell hide-on-mobile">${pitchVal}</td>
      <td class="mono-cell hide-on-mobile">${rollVal}</td>
      <td class="mono-cell hide-on-mobile" style="font-size:0.72rem;">${log.latitude.toFixed(5)}, ${log.longitude.toFixed(5)}</td>
      <td><button class="btn-tele-jump" onclick="teleJumpToCoordinate(${log.latitude}, ${log.longitude}, '${log.drone_id}')">Track</button></td>
    `;
    tbody.appendChild(row);
  });
}

// Bind switch workspaces function globally
window.switchWorkspaceTab = function (tabName) {
  const liveBtn = document.getElementById("tab-live-btn");
  const archiveBtn = document.getElementById("tab-archive-btn");
  const livePanel = document.getElementById("workspace-tab-live");
  const archivePanel = document.getElementById("workspace-tab-archive");

  if (tabName === 'live') {
    liveBtn.classList.add("active");
    archiveBtn.classList.remove("active");
    livePanel.classList.remove("hidden");
    archivePanel.classList.add("hidden");
  } else {
    liveBtn.classList.remove("active");
    archiveBtn.classList.add("active");
    livePanel.classList.add("hidden");
    archivePanel.classList.remove("hidden");
    executeArchiveQuery();
  }
};

// Bind coordinate mapping jump function
window.teleJumpToCoordinate = function (lat, lng, label) {
  switchWorkspaceTab('live');
  map.setView([lat, lng], 18.5); // Zoom right onto the specific spot
  L.popup()
    .setLatLng([lat, lng])
    .setContent(`<b>${label}</b><br>Historical Log Point Location`)
    .openOn(map);
};

// Bind CSV exporter
window.exportQueryResultsCSV = function () {
  if (localArchiveLogs.length === 0) {
    alert("No logged events available for export.");
    return;
  }

  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Timestamp,Drone ID,MAC Address,Protocol,RSSI,Altitude (ft),Speed (mph),Heading,Latitude,Longitude,Payload (Hex)\n";

  localArchiveLogs.forEach(log => {
    const rowStr = [
      new Date(log.timestamp).toISOString(),
      log.drone_id,
      log.mac_address,
      log.protocol,
      log.rssi,
      log.altitude_feet,
      log.speed_mph,
      log.heading,
      log.latitude,
      log.longitude,
      log.payload_hex
    ].join(",");
    csvContent += rowStr + "\n";
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `uas_telemetry_query_export_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// Bind clearing archive database logic
window.clearLocalArchiveDb = function () {
  localArchiveLogs = [];
  updateDroneFilterDropdown();
  executeArchiveQuery();
  console.log("Telemetry session archives cleared.");
};

// Dynamic dropdown updates for unique drone IDs
function updateDroneFilterDropdown() {
  const dropdown = document.getElementById("filter-drone");
  if (!dropdown) return;

  const currentValue = dropdown.value;

  // Extract unique drone IDs and sort them
  const uniqueDrones = [...new Set(localArchiveLogs.map(log => log.drone_id))].sort();

  // Clear and rebuild options
  dropdown.innerHTML = '<option value="ALL">All Drones</option>';
  uniqueDrones.forEach(droneId => {
    const opt = document.createElement("option");
    opt.value = droneId;
    opt.innerText = droneId;
    dropdown.appendChild(opt);
  });

  // Restore value if still present
  if (uniqueDrones.includes(currentValue)) {
    dropdown.value = currentValue;
  } else {
    dropdown.value = "ALL";
  }
}

// Switches tab and filters the query table to show history for a specific drone
window.viewDroneHistory = function (droneId) {
  // Clear search box to prevent override
  const searchInput = document.getElementById("query-search-input");
  if (searchInput) searchInput.value = "";

  // Update dropdown value and re-run query
  const droneDropdown = document.getElementById("filter-drone");
  if (droneDropdown) {
    // Populate dropdown first in case it's not populated yet
    updateDroneFilterDropdown();
    droneDropdown.value = droneId;
  }

  // Switch to archive workspace
  window.switchWorkspaceTab('archive');
};

window.toggleAccordionDrawer = function (droneId) {
  const node = droneRegistry.get(droneId);
  if (!node) return;

  const elementRow = document.getElementById(node.domElementId);
  if (!elementRow) return;

  node.isExpanded = !node.isExpanded;
  if (node.isExpanded) {
    elementRow.classList.add("row-expanded");
    map.panTo(node.marker.getLatLng());
  } else {
    elementRow.classList.remove("row-expanded");
  }
};

function applySignalColorContext(element, rssi) {
  element.classList.remove("rssi-strong", "rssi-medium", "rssi-weak");
  if (rssi >= -60) element.classList.add("rssi-strong");
  else if (rssi >= -75) element.classList.add("rssi-medium");
  else element.classList.add("rssi-weak");
}

function updateGlobalTelemetryCounters() {
  document.getElementById("target-counter-val").innerText = droneRegistry.size;
}

function verifyActiveLifespans() {
  const now = Date.now();
  droneRegistry.forEach((node) => {
    const rowElement = document.getElementById(node.domElementId);
    if (rowElement) {
      const secondsSince = Math.round((now - node.lastSeen) / 1000);
      rowElement.querySelector(".row-time-val").innerText = `${secondsSince}s ago`;
    }
  });
}

function purgeStaleDrones() {
  const now = Date.now();
  droneRegistry.forEach((node, id) => {
    if (now - node.lastSeen > STALE_TIMEOUT_MS) {
      map.removeLayer(node.marker);
      map.removeLayer(node.pathLine);
      map.removeLayer(node.destMarker);

      const row = document.getElementById(node.domElementId);
      if (row) row.remove();
      droneRegistry.delete(id);
    }
  });

  updateGlobalTelemetryCounters();

  if (droneRegistry.size === 0) {
    const container = document.getElementById("drone-accordion-container");
    container.innerHTML = `
      <div id="empty-state-placeholder" class="directory-empty-state">
        <div class="pulse-loader"></div>
        <p>Awaiting local telemetry data stream from remote receiver stations...</p>
      </div>
    `;
  }
}
