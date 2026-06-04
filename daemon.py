import asyncio
import json
import logging
import random
import time
import math

# Role configuration switch: Use "TEST" for the built-in simulator, "RUNNING" for physical radios
EXECUTION_MODE = "TEST"  # Options: "TEST" or "RUNNING"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

CONNECTED_CLIENTS = set()

# Central location anchor: Local GCS Ground Station Coordinates (Bengaluru Core Neighborhood)
BASE_LAT = 12.9716
BASE_LNG = 77.5946

# 5 localized UAS units executing close-range missions within standard signal boundaries (approx 500m grid)
LOCAL_SIMULATED_FLEET = [
    {"id": "UAS-LOCAL-01", "mac": "FE:DC:BA:98:76:01", "color": "#2563eb", "s_lat": 12.9716, "s_lng": 77.5946, "e_lat": 12.9735, "e_lng": 77.5970},  # Medical drone to neighborhood clinic
    {"id": "UAS-LOCAL-02", "mac": "FE:DC:BA:98:76:02", "color": "#16a34a", "s_lat": 12.9702, "s_lng": 77.5915, "e_lat": 12.9728, "e_lng": 77.5955},  # Mapping local layouts
    {"id": "UAS-LOCAL-03", "mac": "FE:DC:BA:98:76:03", "color": "#ea580c", "s_lat": 12.9738, "s_lng": 77.5930, "e_lat": 12.9695, "e_lng": 77.5958},  # Utility monitoring payload
    {"id": "UAS-LOCAL-04", "mac": "FE:DC:BA:98:76:04", "color": "#be185d", "s_lat": 12.9688, "s_lng": 77.5935, "e_lat": 12.9720, "e_lng": 77.5918},  # Commercial package delivery
    {"id": "UAS-LOCAL-05", "mac": "FE:DC:BA:98:76:05", "color": "#6d28d9", "s_lat": 12.9725, "s_lng": 77.5978, "e_lat": 12.9705, "e_lng": 77.5925}   # Security surveillance detail
]

def calculate_bearing(lat1, lon1, lat2, lon2):
    """Calculates compass course headings from current tracking points to final coordinates."""
    d_lon = math.radians(lon2 - lon1)
    r_lat1 = math.radians(lat1)
    r_lat2 = math.radians(lat2)
    y = math.sin(d_lon) * math.cos(r_lat2)
    x = math.cos(r_lat1) * math.sin(r_lat2) - math.sin(r_lat1) * math.cos(r_lat2) * math.cos(d_lon)
    return int((math.degrees(math.atan2(y, x)) + 360) % 360)

async def simulation_test_loop():
    logging.info("Starting 5-Target Short-Range Local Airspace Simulator...")
    
    # Initialize flight path state arrays tracking progress variables
    for idx, drone in enumerate(LOCAL_SIMULATED_FLEET):
        drone["progress"] = (idx * 0.18) # Spread out progression intervals
        drone["speed"] = random.randint(14, 32) # Muted local UAS speeds in residential blocks
        drone["alt"] = random.randint(80, 240)  # Lower local operating altitudes
        
    while True:
        if len(CONNECTED_CLIENTS) > 0:
            for drone in LOCAL_SIMULATED_FLEET:
                # Increment path progress
                drone["progress"] += 0.005 + random.uniform(-0.001, 0.002)
                
                # Turnaround vector check if drone arrives at end bounds
                if drone["progress"] >= 1.0:
                    drone["progress"] = 0.0
                    drone["s_lat"], drone["e_lat"] = drone["e_lat"], drone["s_lat"]
                    drone["s_lng"], drone["e_lng"] = drone["e_lng"], drone["s_lng"]
                
                # Geometrical coordinate interpolation
                curr_lat = drone["s_lat"] + (drone["e_lat"] - drone["s_lat"]) * drone["progress"]
                curr_lng = drone["s_lng"] + (drone["e_lng"] - drone["s_lng"]) * drone["progress"]
                
                heading = calculate_bearing(curr_lat, curr_lng, drone["e_lat"], drone["e_lng"])
                drone["alt"] = max(50, min(300, drone["alt"] + random.randint(-5, 5)))
                drone["speed"] = max(10, min(40, drone["speed"] + random.randint(-1, 1)))

                # Postfix byte structure for payload simulations
                hex_postfix = "".join(f"{random.randint(0, 255):02x}" for _ in range(3))

                packet = {
                    "drone_id": drone["id"],
                    "mac_address": drone["mac"],
                    "protocol": "BLE_ADV" if random.random() > 0.35 else "WIFI_BEACON",
                    "rssi": random.randint(-82, -45), # Stronger signals matching close proximity
                    "latitude": curr_lat,
                    "longitude": curr_lng,
                    "dest_latitude": drone["e_lat"],
                    "dest_longitude": drone["e_lng"],
                    "altitude_feet": drone["alt"],
                    "speed_mph": drone["speed"],
                    "heading": heading,
                    "hex_color": drone["color"],
                    "payload_hex": "0201061bff4c00" + hex_postfix,
                    "last_seen_epoch": int(time.time()),
                    "execution_context": EXECUTION_MODE
                }
                await broadcast_packet(packet)
                await asyncio.sleep(0.1) # Rapid interleaved local transmission bursts
        await asyncio.sleep(1.0)

async def hardware_running_loop():
    """RUNNING Mode fallback framework targeting local physical RF interfaces."""
    from bleak import BleakScanner
    logging.info("Hardware execution context active. Capturing physical RF frames...")
    try:
        scanner = BleakScanner()
        await scanner.start()
        while True:
            devices = await scanner.get_discovered_devices()
            for dev in devices:
                packet = {
                    "drone_id": f"UAS-RF-{dev.address[-5:].replace(':', '')}".upper(),
                    "mac_address": dev.address,
                    "protocol": "BLE_ADV",
                    "rssi": getattr(dev, 'rssi', -70),
                    "latitude": BASE_LAT + random.uniform(-0.002, 0.002),
                    "longitude": BASE_LNG + random.uniform(-0.002, 0.002),
                    "dest_latitude": BASE_LAT + 0.003,
                    "dest_longitude": BASE_LNG + 0.003,
                    "altitude_feet": 120,
                    "speed_mph": 18,
                    "heading": 90,
                    "hex_color": "#475569",
                    "payload_hex": "0201061bff4c00aabbcc",
                    "last_seen_epoch": int(time.time()),
                    "execution_context": EXECUTION_MODE
                }
                await broadcast_packet(packet)
            await asyncio.sleep(2.0)
    except Exception as e:
        logging.error(f"Hardware scanning interface issue: {e}")

async def broadcast_packet(packet_data):
    if CONNECTED_CLIENTS and packet_data:
        payload = json.dumps(packet_data)
        for client in list(CONNECTED_CLIENTS):
            try:
                await client.send(payload)
            except Exception:
                pass

async def socket_handler(websocket):
    CONNECTED_CLIENTS.add(websocket)
    try:
        async for message in websocket: pass
    except Exception: pass
    finally: CONNECTED_CLIENTS.remove(websocket)

async def main():
    from websockets.server import serve
    async with serve(socket_handler, "0.0.0.0", 8765):
        logging.info(f"Local Server operational in [{EXECUTION_MODE}] Mode. Broadcasting at ws://localhost:8765")
        if EXECUTION_MODE == "RUNNING":
            await hardware_running_loop()
        else:
            await simulation_test_loop()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Server manually stopped.")