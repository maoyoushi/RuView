#!/bin/bash
# Build ESP32-S3 CSI firmware with #390 fix and flash to all 5 devices
# Requires: ESP-IDF v5.4 environment sourced

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Device ports (all 5 ESP32-S3 nodes)
PORTS=(
    "/dev/cu.usbmodem11101"
    "/dev/cu.usbmodem11201"
    "/dev/cu.usbmodem5B8F0637011"
    "/dev/cu.usbmodem5B8F0637931"
    "/dev/cu.usbmodem5B8F0658271"
)

echo "=== Step 1: Build firmware ==="
if [ ! -f build/esp32-csi-node.bin ] || [ "$1" = "--rebuild" ]; then
    echo "Building firmware with ESP-IDF..."
    idf.py set-target esp32s3
    idf.py build
    echo "Build complete."
else
    echo "Firmware already built. Use --rebuild to force."
fi

echo ""
echo "=== Build artifacts ==="
ls -lh build/bootloader/bootloader.bin build/partition_table/partition-table.bin \
       build/ota_data_initial/ota_data_initial.bin build/esp32-csi-node.bin 2>/dev/null

echo ""
echo "=== Step 2: Flash all devices ==="
echo "Flash offsets: bootloader@0x0, partition-table@0x8000, ota_data@0xd000, app@0x20000"
echo ""

for i in "${!PORTS[@]}"; do
    PORT="${PORTS[$i]}"
    NODE_ID=$((i + 1))

    if [ ! -e "$PORT" ]; then
        echo "SKIP: $PORT not connected (node $NODE_ID)"
        continue
    fi

    echo "--- Flashing node $NODE_ID on $PORT ---"
    python3 -m esptool --chip esp32s3 --port "$PORT" --baud 460800 \
        write_flash --flash-mode dio --flash-size 8MB \
        0x0 build/bootloader/bootloader.bin \
        0x8000 build/partition_table/partition-table.bin \
        0xd000 build/ota_data_initial/ota_data_initial.bin \
        0x20000 build/esp32-csi-node.bin

    echo "Node $NODE_ID flashed OK"
    echo ""
done

echo "=== All devices flashed ==="
echo "NVS configs preserved — devices will boot with existing node_id/WiFi settings."
echo "The #390 fix re-reads node_id from NVS, bypassing the g_nvs_config clobber."
