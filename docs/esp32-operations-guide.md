# ESP32-S3 CSI 节点操作手册

本手册覆盖 ESP32-S3 CSI 节点的完整操作流程：环境检查、固件编译、烧录、WiFi 配置、版本验证、串口调试、sensing-server 启动、多节点部署、数据流验证、人体成像验证、常见问题排查。

**适用平台：** macOS (Apple Silicon)
**固件版本：** v0.6.2
**ESP-IDF 版本：** v5.4（本地安装 `~/esp/esp-idf-v5.4` 或 Docker `espressif/idf:v5.4`）
**设备：** ESP32-S3 DevKitC-1 (16MB flash, 8MB PSRAM) × 5
**最后验证：** 2026-04-22，5 节点 mesh 全部在线，位置已配置

---

## 目录

1. [环境检查](#1-环境检查)
2. [设备识别与端口映射](#2-设备识别与端口映射)
3. [固件编译](#3-固件编译)
4. [烧录固件](#4-烧录固件)
5. [WiFi 配置（Provision）](#5-wifi-配置provision)
6. [串口监控与调试](#6-串口监控与调试)
7. [版本验证](#7-版本验证)
8. [启动 Sensing Server](#8-启动-sensing-server)
9. [多节点部署](#9-多节点部署)
10. [验证数据流](#10-验证数据流)
11. [人体成像验证](#11-人体成像验证)
12. [OTA 远程更新](#12-ota-远程更新)
13. [常见问题排查](#13-常见问题排查)
14. [NVS 参数速查表](#14-nvs-参数速查表)
15. [部署记录：2026-04-22 五节点首次配置](#15-部署记录2026-04-22-五节点首次配置)
16. [进阶参考](#16-进阶参考)

---

## 1. 环境检查

在开始之前，确认以下工具已安装：

```bash
# Docker（用于编译固件）
docker --version
# 预期: Docker version 27.x+

# esptool（用于烧录）
python3 -m esptool version
# 预期: esptool.py v5.x

# pyserial（用于串口监控）
python3 -c "import serial; print('pyserial OK')"

# nvs partition gen（用于 provision）
python3 -c "import esp_idf_nvs_partition_gen; print('nvs-gen OK')"
```

如果缺少依赖，安装：

```bash
# Python 依赖
pip3 install esptool pyserial esp-idf-nvs-partition-gen

# OpenBLAS（macOS，sensing-server 编译需要）
brew install openblas

# Rust 工具链（编译 sensing-server）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

> **环境变量提示：** 建议在 `~/.zshrc` 中添加 `export OPENBLAS_DIR=/opt/homebrew/opt/openblas`，否则每次编译 sensing-server 都需要手动指定。

---

## 2. 设备识别与端口映射

### 查看连接的设备

```bash
ls /dev/cu.usbmodem*
```

输出示例（5 台设备）：

```
/dev/cu.usbmodem11101
/dev/cu.usbmodem11201
/dev/cu.usbmodem5B8F0637011
/dev/cu.usbmodem5B8F0637931
/dev/cu.usbmodem5B8F0658271
```

### 当前设备映射表

| Node ID | MAC 地址 | 串口端口 | WiFi IP | 位置 (x, y, z) 米 | CSI 速率 |
|---------|----------|----------|---------|--------------------|----------|
| 1 | ac:a7:04:14:74:68 | /dev/cu.usbmodem1101 | 172.16.20.247 | (4.2, 0.5, 3.0) | ~338 pps |
| 2 | ac:a7:04:14:ff:10 | /dev/cu.usbmodem1201 | 172.16.20.230 | (7.7, 2.2, 0.0) | ~297 pps |
| 3 | a0:f2:62:e0:42:48 | /dev/cu.usbmodem5B8F0637011 | (DHCP) | (5.9, 5.5, 0.0) | ~310 pps |
| 4 | a0:f2:62:e0:44:a8 | /dev/cu.usbmodem5B8F0637931 | (DHCP) | (2.1, 5.4, 0.0) | ~310 pps |
| 5 | ac:a7:04:f4:75:18 | /dev/cu.usbmodem5B8F0658271 | (DHCP) | (0.7, 2.4, 0.0) | ~331 pps |

> **硬件型号：** 5 台均为 ESP32-S3 DevKitC-1（16MB Flash, 8MB PSRAM），非 SuperMini。
> **位置说明：** Node 1 的 z=3.0 表示高处安装，其余 4 台 z=0.0 为桌面/地面水平放置。位置通过 Web UI 设备配置页面写入。

> **提示：** USB 端口名称与物理 USB 口绑定，拔插后可能变化。每次操作前用 `ls /dev/cu.usbmodem*` 确认。

### 识别哪根线对应哪台设备

拔掉一根 USB 线，再运行 `ls /dev/cu.usbmodem*`，消失的那个端口就是刚拔掉的设备。

---

## 3. 固件编译

支持两种编译方式：本地 ESP-IDF 安装（推荐，速度更快）和 Docker 容器。

### 3.1 编译 8MB 版本 — 本地 ESP-IDF（推荐）

```bash
cd ~/AiProject/RuView

# 确保使用 8MB 默认配置
cp firmware/esp32-csi-node/sdkconfig.defaults.template \
   firmware/esp32-csi-node/sdkconfig.defaults 2>/dev/null || true

# 加载 ESP-IDF 环境
source ~/esp/esp-idf-v5.4/export.sh

# 编译
cd firmware/esp32-csi-node
rm -rf build sdkconfig
idf.py set-target esp32s3
idf.py build
cd ~/AiProject/RuView
```

### 3.2 编译 8MB 版本 — Docker

```bash
cd ~/AiProject/RuView

cp firmware/esp32-csi-node/sdkconfig.defaults.template \
   firmware/esp32-csi-node/sdkconfig.defaults 2>/dev/null || true

docker run --rm \
  -v "$(pwd)/firmware/esp32-csi-node:/project" -w /project \
  espressif/idf:v5.4 bash -c \
  "rm -rf build sdkconfig && idf.py set-target esp32s3 && idf.py build"
```

编译约 2-5 分钟（首次编译 ~1421 个文件）。成功后输出：

```
Project build complete. To flash, run this command:
...
```

> **v0.6.2 编译参考：** 1421 个源文件，固件大小约 1.06MB，OTA 分区 48% 空闲。

编译产物在 `firmware/esp32-csi-node/build/` 下：

| 文件 | 烧录地址 | 说明 |
|------|----------|------|
| `build/bootloader/bootloader.bin` | 0x0 | 二级引导加载器 |
| `build/partition_table/partition-table.bin` | 0x8000 | 分区表 |
| `build/esp32-csi-node.bin` | 0x10000 | 主固件 |

### 3.3 编译 4MB 版本（SuperMini）

```bash
# 切换到 4MB 分区配置
cp firmware/esp32-csi-node/sdkconfig.defaults.4mb \
   firmware/esp32-csi-node/sdkconfig.defaults

# 然后按 3.1 或 3.2 的步骤编译
```

> **注意：** 编译完 4MB 版本后，如要回到 8MB，记得恢复 `sdkconfig.defaults`。

### 3.4 使用预编译固件（跳过编译）

如果不需要修改固件代码，可以直接使用 `release_bins/` 下的预编译二进制：

```
firmware/esp32-csi-node/release_bins/
├── bootloader.bin          # 8MB 引导
├── partition-table.bin     # 8MB 分区表
├── esp32-csi-node.bin      # 8MB 主固件
├── ota_data_initial.bin    # OTA 数据
├── esp32-csi-node-4mb.bin  # 4MB 主固件
└── partition-table-4mb.bin # 4MB 分区表
```

---

## 4. 烧录固件

### 4.1 烧录单台设备（8MB 版本，使用编译产物）

```bash
PORT=/dev/cu.usbmodem11101  # 替换为目标设备端口

python3 -m esptool --chip esp32s3 --port $PORT --baud 460800 \
  write_flash --flash_mode dio --flash_size 8MB \
  0x0     firmware/esp32-csi-node/build/bootloader/bootloader.bin \
  0x8000  firmware/esp32-csi-node/build/partition_table/partition-table.bin \
  0x10000 firmware/esp32-csi-node/build/esp32-csi-node.bin
```

### 4.2 烧录单台设备（8MB 版本，使用预编译）

```bash
PORT=/dev/cu.usbmodem11101

python3 -m esptool --chip esp32s3 --port $PORT --baud 460800 \
  write_flash --flash_mode dio --flash_size 8MB \
  0x0     firmware/esp32-csi-node/release_bins/bootloader.bin \
  0x8000  firmware/esp32-csi-node/release_bins/partition-table.bin \
  0x10000 firmware/esp32-csi-node/release_bins/esp32-csi-node.bin
```

### 4.3 烧录 4MB 设备（SuperMini）

```bash
PORT=/dev/cu.usbmodem11101

python3 -m esptool --chip esp32s3 --port $PORT --baud 460800 \
  write_flash --flash_mode dio --flash_size 4MB \
  0x0     firmware/esp32-csi-node/release_bins/bootloader.bin \
  0x8000  firmware/esp32-csi-node/release_bins/partition-table-4mb.bin \
  0x10000 firmware/esp32-csi-node/release_bins/esp32-csi-node-4mb.bin
```

### 4.4 批量烧录所有设备

```bash
# 8MB 版本，烧录所有连接的设备
for PORT in /dev/cu.usbmodem*; do
  echo "=== 烧录 $PORT ==="
  python3 -m esptool --chip esp32s3 --port "$PORT" --baud 460800 \
    write_flash --flash_mode dio --flash_size 8MB \
    0x0     firmware/esp32-csi-node/release_bins/bootloader.bin \
    0x8000  firmware/esp32-csi-node/release_bins/partition-table.bin \
    0x10000 firmware/esp32-csi-node/release_bins/esp32-csi-node.bin
  echo ""
done
```

### 4.5 烧录失败时的处理

如果烧录卡住或报错 `Failed to connect`：

1. **按住 BOOT 按钮**，同时按一下 RESET 按钮，再松开 BOOT — 进入下载模式
2. 重新运行烧录命令
3. 如果端口被占用，先关闭串口监控窗口

```bash
# 强制擦除整个 Flash（最后手段）
python3 -m esptool --chip esp32s3 --port $PORT erase_flash
# 然后重新烧录
```

---

## 5. WiFi 配置（Provision）

烧录完成后，需要写入 WiFi 和网络配置。Provision 通过 NVS（非易失性存储）写入，无需重新编译固件。

### 5.1 配置单台设备

```bash
PORT=/dev/cu.usbmodem11101
NODE_ID=1
WIFI_SSID="LF-office"
WIFI_PASS="你的WiFi密码"
SERVER_IP="172.16.21.87"    # 运行 sensing-server 的电脑 IP

python3 firmware/esp32-csi-node/provision.py \
  --port "$PORT" \
  --ssid "$WIFI_SSID" \
  --password "$WIFI_PASS" \
  --target-ip "$SERVER_IP" \
  --node-id "$NODE_ID"
```

### 5.2 批量配置所有设备

```bash
WIFI_SSID="LF-office"
WIFI_PASS="你的WiFi密码"
SERVER_IP="172.16.21.87"

# 设备列表：端口 -> node_id
declare -A NODES=(
  ["/dev/cu.usbmodem11101"]=1
  ["/dev/cu.usbmodem11201"]=2
  ["/dev/cu.usbmodem5B8F0637011"]=3
  ["/dev/cu.usbmodem5B8F0637931"]=4
  ["/dev/cu.usbmodem5B8F0658271"]=5
)

for PORT in "${!NODES[@]}"; do
  NID=${NODES[$PORT]}
  echo "=== Provision Node $NID on $PORT ==="
  python3 firmware/esp32-csi-node/provision.py \
    --port "$PORT" \
    --ssid "$WIFI_SSID" \
    --password "$WIFI_PASS" \
    --target-ip "$SERVER_IP" \
    --node-id "$NID"
  echo ""
done
```

### 5.3 Provision 重要注意事项

- **每次 provision 会替换整个 NVS 命名空间**，未传入的参数会被清除
- 必须同时传入 `--ssid`、`--password`、`--target-ip`（或加 `--force-partial`）
- Provision 后设备会自动重启并连接 WiFi

### 5.4 查看本机 IP

```bash
# 查看 WiFi 接口 IP（用于 --target-ip）
ifconfig en0 | grep "inet "
```

---

## 6. 串口监控与调试

### 6.1 监控单台设备

```bash
python3 -m serial.tools.miniterm /dev/cu.usbmodem11101 115200
```

退出：按 `Ctrl+]`

### 6.2 正常启动日志示例

```
I (321) main: ESP32-S3 CSI Node (ADR-018) -- Node ID: 1
I (345) main: WiFi STA initialized, connecting to SSID: LF-office
I (1023) main: Connected to WiFi
I (1025) csi_collector: node_id=1 (NVS-verified, fix for #390)
I (1030) main: CSI streaming active -> 172.16.21.87:5005 (edge_tier=2, OTA=ready)
I (1100) display: SH8601 AMOLED initialized (368x448)
I (1200) edge_dsp: Adaptive controller online, tier=2
I (1500) ota: HTTP server ready on port 8032
```

### 6.3 同时监控多台设备

在多个终端窗口中分别运行：

```bash
# 终端 1
python3 -m serial.tools.miniterm /dev/cu.usbmodem11101 115200

# 终端 2
python3 -m serial.tools.miniterm /dev/cu.usbmodem11201 115200

# 终端 3 ...
```

### 6.4 将串口日志保存到文件

```bash
python3 -m serial.tools.miniterm /dev/cu.usbmodem11101 115200 \
  | tee node1_log_$(date +%Y%m%d_%H%M%S).txt
```

### 6.5 关键日志标记

| 日志关键词 | 含义 | 是否正常 |
|-----------|------|---------|
| `Connected to WiFi` | WiFi 连接成功 | 正常 |
| `CSI streaming active` | CSI 数据流已启动 | 正常 |
| `wifi:sta disconnect` | WiFi 断连 | 需要排查 |
| `Guru Meditation Error` | 固件崩溃 | 严重错误 |
| `node_id=X (NVS-verified` | NVS 验证后的节点 ID (#390 修复) | 检查是否与预期一致 |
| `Adaptive controller online` | Edge DSP 自适应控制器启动 | 正常 |
| `SH8601 AMOLED initialized` | AMOLED 显示屏初始化 | 正常（仅带屏设备） |
| `ENOMEM` / `sendto failed` | UDP 发送失败 | server 未启动时正常，启动后应消失 |
| `presence=1` | 检测到有人 | 正常 |
| `fall=1` | 检测到跌倒 | 验证是否误报 |

---

## 7. 版本验证

烧录并 Provision 完成后，确认固件版本与预期一致。有两种方式：

### 7.1 通过串口日志确认

打开串口监控，查看启动日志第一行：

```bash
python3 -m serial.tools.miniterm /dev/cu.usbmodem11101 115200
```

找到如下输出：

```
I (321) main: ESP32-S3 CSI Node (ADR-018) -- Node ID: 1
```

`app_desc->version` 字段包含在编译时嵌入的版本号。在 v0.6.2 中会显示：

```
I (321) main: ESP32-S3 CSI Node (ADR-018) -- Node ID: 1
```

> **判断标准：** 如果你刚烧录了 v0.6.2 固件，但日志中显示其他版本号，说明烧录未生效——检查是否烧录了正确的 bin 文件。

### 7.2 通过 OTA 接口查询（推荐，无需串口线）

设备连上 WiFi 后，在端口 8032 上提供版本查询接口：

```bash
DEVICE_IP=172.16.20.247  # 替换为目标设备 IP

curl -s http://$DEVICE_IP:8032/ota/status | python3 -m json.tool
```

正常返回：

```json
{
    "version": "0.6.2",
    "date": "Apr 22 2026",
    "time": "01:30:00",
    "running_partition": "ota_0",
    "next_partition": "ota_1",
    "max_size": 2097152
}
```

> **判断标准：**
> - `version` 应与 `firmware/esp32-csi-node/version.txt` 中的值一致（当前为 `0.6.2`）
> - `running_partition` 为 `ota_0`（首次烧录）或 `ota_1`（OTA 更新后）

### 7.3 批量版本检查

```bash
for IP in 172.16.20.247 172.16.20.230; do
  echo "=== $IP ==="
  curl -s --connect-timeout 3 http://$IP:8032/ota/status | python3 -m json.tool
done
```

如果设备未响应，可能原因：
- 设备未连上 WiFi（检查串口日志）
- IP 地址已变（通过路由器 DHCP 表或串口日志确认）
- 防火墙阻止了 8032 端口

---

## 8. 启动 Sensing Server

Sensing server 接收 ESP32 发送的 CSI/Vitals UDP 数据并提供 Web UI。

### 8.1 默认端口

| 服务 | 端口 | 用途 |
|------|------|------|
| HTTP | 8080 | Web UI 和 REST API |
| UDP | 5005 | 接收 ESP32 CSI 帧 |
| WebSocket | 8765 | 实时感知数据推送 |

### 8.2 编译并运行

```bash
cd ~/AiProject/RuView

# 使用默认端口（HTTP:8080, UDP:5005, WS:8765）
cargo run -p wifi-densepose-sensing-server

# 或者指定参数
cargo run -p wifi-densepose-sensing-server -- \
  --http-port 8080 \
  --udp-port 5005 \
  --ws-port 8765 \
  --source auto
```

如需局域网内其他设备访问 Web UI：

```bash
cargo run -p wifi-densepose-sensing-server -- --bind-addr 0.0.0.0
```

**macOS ARM64 编译故障排查：** 如果出现 `openblas-src` 编译失败（常见于 Apple Silicon），需要安装系统 OpenBLAS 并设置环境变量：

```bash
# 安装 OpenBLAS
brew install openblas

# 设置环境变量后编译
OPENBLAS_DIR=/opt/homebrew/opt/openblas cargo run -p wifi-densepose-sensing-server
```

> **Pass 标准：** 编译成功，无 `openblas-build` 相关错误。如果仍然失败，检查 `Cargo.toml` 中 `ndarray-linalg` 的 feature 是否为 `openblas-system`（不是 `openblas-static`）。

### 8.3 验证服务运行

```bash
# 检查 API 状态
curl -s http://localhost:8080/api/status | python3 -m json.tool
```

正常返回：

```json
{
  "tick": 12345,
  "connected_nodes": 5,
  "ws_clients": 1,
  "presence": true,
  "estimated_persons": 1,
  "motion_level": "present_moving"
}
```

### 8.4 打开 Web UI

浏览器访问 http://localhost:8080

### 8.5 macOS 防火墙

如果设备连不上 server，检查防火墙是否允许 UDP 5005 入站：

**系统设置 > 网络 > 防火墙** — 确保允许传入连接，或关闭防火墙。

> **提示：** ESP32 向服务器 IP 的 UDP 5005 发送数据。如果串口日志出现 `ENOMEM` 或 `sendto failed`，通常是 server 尚未启动或防火墙阻止。启动 server 后这些警告会消失。

---

## 9. 多节点部署

### 9.1 部署拓扑建议

```
          [Node 1]          [Node 2]
           ↙ CSI              ↘ CSI
     ┌──────────────────────────┐
     │         WiFi AP          │
     │       (LF-office)        │
     └──────────────────────────┘
           ↗ CSI              ↖ CSI
          [Node 3]          [Node 4]
                  ↑ CSI
               [Node 5]

   所有节点 → UDP → sensing-server (172.16.21.87:5005)
```

- 建议每个房间 3-6 个节点
- 节点分散放置，覆盖不同角度
- 所有节点连同一个 WiFi 网络

### 9.2 TDM 模式（高级）

当多节点在同一信道工作时，可启用 TDM（时分复用）避免干扰：

```bash
# 节点 1（5 个节点中的第 0 号槽位）
python3 firmware/esp32-csi-node/provision.py \
  --port /dev/cu.usbmodem11101 \
  --ssid "LF-office" --password "密码" --target-ip "172.16.21.87" \
  --node-id 1 --tdm-slot 0 --tdm-total 5

# 节点 2（第 1 号槽位）
python3 firmware/esp32-csi-node/provision.py \
  --port /dev/cu.usbmodem11201 \
  --ssid "LF-office" --password "密码" --target-ip "172.16.21.87" \
  --node-id 2 --tdm-slot 1 --tdm-total 5

# 以此类推... tdm-slot 从 0 到 4
```

### 9.3 多信道跳频（高级）

让节点在多个信道之间轮转采集：

```bash
python3 firmware/esp32-csi-node/provision.py \
  --port /dev/cu.usbmodem11101 \
  --ssid "LF-office" --password "密码" --target-ip "172.16.21.87" \
  --node-id 1 \
  --hop-channels "1,6,11" --hop-dwell 200
```

---

## 10. 验证数据流

### 10.1 检查 UDP 数据是否到达

```bash
# 用 nc 监听 UDP 5005，看是否有数据进来
nc -u -l 5005 | xxd | head -20
```

如果看到 `c511 0001` 开头的十六进制数据，说明 CSI 帧正常到达。

### 10.2 通过 sensing-server API 检查

```bash
# 查看连接状态
curl -s http://localhost:8080/api/status

# 持续监控（每 2 秒刷新）
watch -n 2 'curl -s http://localhost:8080/api/status | python3 -m json.tool'
```

### 10.3 检查各节点是否在线

在串口日志中确认每台设备都有 `CSI streaming active` 输出。在 sensing-server 的 `/api/status` 中检查 `connected_nodes` 数量。

### 10.4 CSI 帧参考数据

| 参数 | 典型值 |
|------|--------|
| CSI 帧大小 | 128 / 256 / 384 bytes |
| 帧率 | ~68-200 pps/node |
| WiFi 信道 | 6（LF-office 所在信道） |
| Edge DSP 等级 | Tier 2（生命体征提取） |
| 检测能力 | 存在、运动、呼吸频带、频谱功率 |

---

## 11. 人体成像验证

数据流正常后，按以下步骤验证从 CSI 数据到人体骨骼成像的完整链路。

> **前置条件：** Sensing Server 已启动且 `connected_nodes >= 1`（§8.3）。以下所有 URL 中 `localhost:8080` 为默认端口，如果你修改过 `--http-port` 请替换。

### 11.1 验证 Pose API 返回关键点

```bash
curl -s http://localhost:8080/api/v1/pose/current | python3 -m json.tool
```

**预期返回（有人在 CSI 覆盖区域内）：**

```json
{
    "persons": [
        {
            "id": 0,
            "keypoints": [
                {"name": "nose", "x": 0.52, "y": 0.31, "z": 0.0, "confidence": 0.91},
                {"name": "left_eye", "x": 0.54, "y": 0.29, "z": 0.0, "confidence": 0.88},
                {"name": "right_eye", "x": 0.50, "y": 0.29, "z": 0.0, "confidence": 0.87}
            ]
        }
    ],
    "frame_id": 1024,
    "timestamp_ms": 1709312400000
}
```

**判断标准：**
- `persons` 数组非空 → 检测到人体
- 每个 person 有 17 个 COCO 关键点（nose, left_eye, right_eye, left_ear, right_ear, left_shoulder, right_shoulder, left_elbow, right_elbow, left_wrist, right_wrist, left_hip, right_hip, left_knee, right_knee, left_ankle, right_ankle）
- `confidence > 0` 表示该关键点有效
- 如果 `persons` 为空数组 `[]`，确认有人站在 CSI 节点覆盖范围内

> **注意：** 当前 pose 输出基于启发式算法（`heuristic_pose_from_amplitude`），不是训练后的 WiFlow 模型推理。这意味着关键点位置是从 CSI 振幅近似推导的，精度有限。要获得更高精度（可达 92.9% PCK@20），需要加载训练好的 RVF 模型（见 §11.5）。

### 11.2 验证生命体征数据

```bash
curl -s http://localhost:8080/api/v1/vital-signs | python3 -m json.tool
```

**预期返回：**

```json
{
    "breathing_bpm": 16.2,
    "heart_bpm": 72.1,
    "breathing_confidence": 0.87,
    "heart_confidence": 0.63,
    "motion_level": 0.12,
    "timestamp_ms": 1709312400000
}
```

**判断标准：**
- `breathing_bpm` 在 10-30 范围内 → 正常呼吸频率
- `heart_bpm` 在 50-120 范围内 → 正常心率
- `confidence > 0.5` → 信号质量可用
- 目标人员需保持相对静止约 10 秒，生命体征检测需要稳定的相位信号

### 11.3 验证 Web UI 3D 骨骼可视化

1. 打开浏览器访问 Dashboard：

```bash
open http://localhost:8080/ui/index.html
```

2. 检查以下面板：

| 面板 | 预期表现 | 异常处理 |
|------|---------|---------|
| **3D Body View** | 可旋转的线框骨骼，17 个关键点随人体移动更新 | 如果骨骼不动：检查 WebSocket 连接（浏览器控制台无报错） |
| **Signal Heatmap** | 56 个子载波的振幅热图，颜色随时间变化 | 全黑：无 CSI 数据，检查 §10 |
| **Vital Signs** | 实时呼吸频率和心率数值 | 显示 0 或 N/A：被测人员需保持静止 |
| **Doppler Bars** | 运动频带功率指示条 | 无变化：确认有人在区域内移动 |

3. 让测试人员在 CSI 覆盖区域内做以下动作，观察 3D Body View 响应：
   - **站立不动** → 骨骼基本静止，Vital Signs 面板显示呼吸和心率
   - **举手** → 骨骼的手腕/肘部关键点位置变化
   - **走动** → 骨骼整体位置移动，Doppler Bars 活跃

### 11.4 验证 Observatory 沉浸式可视化

```bash
open http://localhost:8080/ui/observatory.html
```

**检查项：**

| 检查项 | 预期 | 说明 |
|--------|------|------|
| 页面左上角 badge | 显示 `LIVE`（绿色） | 如果显示 `DEMO`，说明未连接到 sensing server |
| HUD 数据 | 心率、呼吸频率、RSSI、运动等级均有数值 | 数值应实时更新 |
| 3D 人体线框 | 有人形线框在场景中，关节有呼吸同步脉动 | 最多显示 4 个人体 |
| WiFi 信号动画 | 可见体积式 WiFi 波浪效果 | 纯视觉效果 |

**键盘快捷键测试：**

| 按键 | 预期动作 |
|------|---------|
| `1`-`6` | 切换 6 个预设场景 |
| `A` | 开启/关闭自动场景轮换 |
| `P` | 暂停/恢复动画 |
| `R` | 重置摄像机位置 |

> **"DEMO vs LIVE" 排查：** Observatory 通过探测 `/health` 接口自动检测是否有 sensing server。如果显示 DEMO：确认是通过 `http://localhost:8080/ui/observatory.html` 访问（不能用 `file://` 协议打开本地文件）。

### 11.5 验证 WebSocket 实时推送

使用 `wscat` 确认 WebSocket 数据流正常：

```bash
# 安装 wscat（如未安装）
npm install -g wscat

# 连接并查看实时数据
wscat -c ws://localhost:8080/ws/sensing
```

**预期输出（每帧一条 JSON）：**

```json
{"persons":[{"id":0,"keypoints":[...]}],"vital_signs":{"breathing_bpm":16.2,"heart_bpm":72.1},...}
```

按 `Ctrl+C` 退出。如果连不上，检查 sensing-server 是否在运行。

### 11.6 加载训练模型提升精度（可选）

默认的启发式 pose 推导精度有限。如果有训练好的 RVF 模型文件，可以加载以提升精度：

```bash
# 查看可用模型
curl -s http://localhost:8080/api/v1/models | python3 -m json.tool

# 加载模型（替换 MODEL_ID）
curl -X POST http://localhost:8080/api/v1/models/load \
  -H "Content-Type: application/json" \
  -d '{"model_id": "your-model-id"}'

# 确认模型已加载
curl -s http://localhost:8080/api/v1/models/active | python3 -m json.tool
```

如果还没有训练过模型，可以使用自适应分类器快速训练一个环境特定模型：

```bash
# 1. 录制空房间数据（离开房间 30 秒）
curl -X POST http://localhost:8080/api/v1/recording/start \
  -H "Content-Type: application/json" -d '{"id":"train_empty_room"}'
# ... 等待 30 秒 ...
curl -X POST http://localhost:8080/api/v1/recording/stop

# 2. 录制静坐数据（靠近 ESP32 坐 30 秒）
curl -X POST http://localhost:8080/api/v1/recording/start \
  -H "Content-Type: application/json" -d '{"id":"train_sitting_still"}'
# ... 等待 30 秒 ...
curl -X POST http://localhost:8080/api/v1/recording/stop

# 3. 录制走动数据（在房间内走动 30 秒）
curl -X POST http://localhost:8080/api/v1/recording/start \
  -H "Content-Type: application/json" -d '{"id":"train_walking"}'
# ... 等待 30 秒 ...
curl -X POST http://localhost:8080/api/v1/recording/stop

# 4. 训练
curl -X POST http://localhost:8080/api/v1/adaptive/train

# 5. 检查训练结果
curl -s http://localhost:8080/api/v1/adaptive/status | python3 -m json.tool
# 预期: {"loaded":true,"accuracy":0.85,...}
```

> **详细的模型训练和高级功能** 请参阅 [User Guide — Adaptive Classifier](user-guide.md#adaptive-classifier) 和 [User Guide — Training a Model](user-guide.md#training-a-model)。

### 11.7 人体成像验证检查表

测试人员逐项执行并记录结果：

| # | 检查项 | 命令/操作 | Pass 标准 | 结果 |
|---|--------|----------|----------|------|
| 1 | Pose API 有数据 | `curl .../api/v1/pose/current` | `persons` 非空，有 17 个关键点 | ☐ |
| 2 | 生命体征有数据 | `curl .../api/v1/vital-signs` | breathing_bpm 10-30, heart_bpm 50-120 | ☐ |
| 3 | Dashboard 3D 骨骼 | 浏览器打开 `/ui/index.html` | 可见线框骨骼，随人移动 | ☐ |
| 4 | Signal Heatmap 有变化 | Dashboard 页面 | 热图颜色随时间变化 | ☐ |
| 5 | Observatory LIVE 模式 | 浏览器打开 `/ui/observatory.html` | badge 显示 LIVE，HUD 有数值 | ☐ |
| 6 | WebSocket 数据流 | `wscat -c ws://.../ws/sensing` | 持续收到 JSON 帧 | ☐ |
| 7 | 举手动作响应 | 在覆盖区域内举手 | 3D 骨骼手臂位置变化 | ☐ |
| 8 | 走动响应 | 在覆盖区域内走动 | 骨骼位置移动 + Doppler 活跃 | ☐ |

---

## 12. OTA 远程更新

设备启动后在端口 8032 运行 HTTP 服务器，支持 OTA 更新（无需 USB 线）。串口日志中会显示 `HTTP server ready on port 8032`。

### 12.1 获取设备 IP

```bash
# 方法 1：在串口日志中查看（WiFi 连接后会打印 IP）
python3 -m serial.tools.miniterm /dev/cu.usbmodem11101 115200
# 查找: "sta ip: 172.16.20.xxx"

# 方法 2：通过路由器管理页面查看 DHCP 分配
# 已知 IP：Node 1 = 172.16.20.247, Node 2 = 172.16.20.230
```

### 12.2 推送新固件

```bash
DEVICE_IP=172.16.20.247  # 替换为目标设备 IP

curl -X POST http://$DEVICE_IP:8032/ota \
  --data-binary @firmware/esp32-csi-node/build/esp32-csi-node.bin
```

### 12.3 批量 OTA 更新

```bash
for IP in 172.16.20.247 172.16.20.230; do
  echo "=== OTA -> $IP ==="
  curl -X POST http://$IP:8032/ota \
    --data-binary @firmware/esp32-csi-node/build/esp32-csi-node.bin
done
```

> **注意：**
> - OTA 仅更新应用固件，不更新 bootloader 和分区表
> - v0.6.2 固件约 1.06MB（48% 分区空闲），在 OTA 大小限制内
> - 更新后设备自动重启

---

## 13. 常见问题排查

### 设备无法烧录

| 症状 | 原因 | 解决 |
|------|------|------|
| `Failed to connect` | 未进入下载模式 | 按住 BOOT + 按 RESET，松开 BOOT 后重试 |
| `Port not found` | USB 线松动或不支持数据传输 | 换一根数据线（非充电线） |
| `Permission denied` | macOS 串口权限 | 检查终端是否有串口访问权限 |

### WiFi 连接失败

| 症状 | 原因 | 解决 |
|------|------|------|
| `sta disconnect, reason:201` | SSID 不存在 | 检查 SSID 拼写，注意大小写 |
| `sta disconnect, reason:15` | 密码错误 | 重新 provision 正确密码 |
| 反复连接断开 | WiFi 信号弱 | 将设备移近路由器 |

### CSI 数据未到达 Server

| 症状 | 原因 | 解决 |
|------|------|------|
| 串口有 `CSI streaming active` 但 server 无数据 | target_ip 错误 | 重新 provision 正确的服务器 IP |
| server 显示 `connected_nodes: 0` | 防火墙阻止 | 关闭 macOS 防火墙或允许 UDP 5005 |
| 部分节点无数据 | 设备重启后 WiFi 未连接 | 检查串口日志确认 WiFi 状态 |

### 设备重启后 node_id 变为 1

这是已知 bug（#390）：`wifi_init_sta()` 可能覆盖 `g_nvs_config.node_id` 为 Kconfig 默认值 1。

**v0.6.2 已修复：** 固件在 WiFi 初始化后会从 NVS 重新读取 `node_id`，串口日志中会出现 `node_id=X (NVS-verified, fix for #390)` 确认修复生效。

如果使用旧版固件遇到此问题：

1. 升级到 v0.6.2 固件（推荐）
2. 或重新 provision 该设备（临时方案，重启后可能复发）

### Sensing Server 编译失败（OpenBLAS）

| 症状 | 原因 | 解决 |
|------|------|------|
| `error: failed to run custom build command for openblas-src` | macOS ARM64 无法从源码编译 OpenBLAS | 安装系统 OpenBLAS（见下方） |
| `ld: library 'openblas' not found` | 系统无 OpenBLAS 库 | `brew install openblas` |

```bash
# 1. 安装系统 OpenBLAS
brew install openblas

# 2. 确认 Cargo.toml 使用 openblas-system（不是 openblas-static）
grep 'ndarray-linalg' rust-port/wifi-densepose-rs/Cargo.toml
# 预期: features = ["openblas-system"]

# 3. 设置环境变量后编译
OPENBLAS_DIR=/opt/homebrew/opt/openblas cargo run -p wifi-densepose-sensing-server
```

> **提示：** 建议将 `export OPENBLAS_DIR=/opt/homebrew/opt/openblas` 加入 `~/.zshrc` 以避免每次编译都手动设置。

### Python 验证脚本失败（NumPy/SciPy）

| 症状 | 原因 | 解决 |
|------|------|------|
| `numpy.core.multiarray failed to import` | SciPy 编译时的 NumPy 版本与当前不兼容 | 升级 SciPy |
| `A module that was compiled using NumPy 1.x cannot be run in NumPy 2.x` | Anaconda 预装的 SciPy 是 NumPy 1.x 编译的 | 见下方 |
| `VERDICT: FAIL` + hash mismatch | NumPy/SciPy 版本变更导致浮点结果微变 | 重新生成 hash |

```bash
# 1. 升级 SciPy 到与当前 NumPy 兼容的版本
pip3 install --upgrade scipy

# 2. 验证兼容性
python3 -c "import numpy; import scipy; print(f'numpy {numpy.__version__}, scipy {scipy.__version__}')"
# 预期: numpy 2.x + scipy 1.17+（无 warning）

# 3. 如果 hash 不匹配，重新生成（仅在确认是版本变更导致时）
python3 v1/data/proof/verify.py --generate-hash
python3 v1/data/proof/verify.py
# 预期: VERDICT: PASS
```

### Rust 测试 field_model 失败

| 症状 | 原因 | 解决 |
|------|------|------|
| `test_estimate_occupancy_noise_only` 断言 occupancy=4 ≠ 0 | Marcenko-Pastur 阈值在小样本窗口下误报 | 已在 v0.6.2+ 修复（2x safety margin） |

如遇到此错误，确认 `field_model.rs` 的 `estimate_occupancy` 中 MP threshold 有 `2.0 *` 安全系数。

---

## 14. NVS 参数速查表

| 参数 | 类型 | 默认值 | provision 参数 | 说明 |
|------|------|--------|---------------|------|
| ssid | string | wifi-densepose | `--ssid` | WiFi SSID |
| password | string | (空) | `--password` | WiFi 密码 |
| target_ip | string | 192.168.1.100 | `--target-ip` | 服务器 IP |
| target_port | u16 | 5005 | `--target-port` | UDP 端口 |
| node_id | u8 | 1 | `--node-id` | 节点 ID (0-255) |
| edge_tier | u8 | 2 | `--edge-tier` | 0=原始 1=统计 2=生命体征 |
| tdm_slot | u8 | 0 | `--tdm-slot` | TDM 槽位 (0-based) |
| tdm_nodes | u8 | 1 | `--tdm-total` | TDM 总节点数 |
| csi_channel | u8 | (auto) | `--channel` | CSI 信道 |
| pres_thresh | u16 | (auto) | `--pres-thresh` | 存在检测阈值 |
| fall_thresh | u16 | 2000 | `--fall-thresh` | 跌倒检测阈值 |
| vital_win | u16 | 256 | `--vital-win` | 相位历史窗口帧数 |
| vital_int | u16 | 1000 | `--vital-int` | 生命体征包间隔 (ms) |
| subk_count | u8 | 8 | `--subk-count` | Top-K 子载波数 |

---

## 快速参考：完整操作流程

```bash
# === 0. 进入项目目录 ===
cd ~/AiProject/RuView

# === 1. 编译固件（如需修改代码）===
docker run --rm \
  -v "$(pwd)/firmware/esp32-csi-node:/project" -w /project \
  espressif/idf:v5.4 bash -c \
  "rm -rf build sdkconfig && idf.py set-target esp32s3 && idf.py build"

# === 2. 查看设备端口 ===
ls /dev/cu.usbmodem*

# === 3. 烧录（替换 PORT）===
PORT=/dev/cu.usbmodem11101
python3 -m esptool --chip esp32s3 --port $PORT --baud 460800 \
  write_flash --flash_mode dio --flash_size 8MB \
  0x0     firmware/esp32-csi-node/release_bins/bootloader.bin \
  0x8000  firmware/esp32-csi-node/release_bins/partition-table.bin \
  0x10000 firmware/esp32-csi-node/release_bins/esp32-csi-node.bin

# === 4. 配置 WiFi（替换参数）===
python3 firmware/esp32-csi-node/provision.py \
  --port $PORT \
  --ssid "LF-office" \
  --password "你的密码" \
  --target-ip "$(ifconfig en0 | awk '/inet /{print $2}')" \
  --node-id 1

# === 5. 验证（打开串口，确认 WiFi 连接和版本）===
python3 -m serial.tools.miniterm $PORT 115200
# 确认日志中有: Connected to WiFi + CSI streaming active

# === 6. 版本检查（设备连上 WiFi 后）===
DEVICE_IP=172.16.20.247  # 替换为设备 IP
curl -s http://$DEVICE_IP:8032/ota/status | python3 -m json.tool

# === 7. 启动服务端（默认 HTTP:8080, UDP:5005, WS:8765）===
OPENBLAS_DIR=/opt/homebrew/opt/openblas cargo run -p wifi-densepose-sensing-server

# === 8. 验证数据流 ===
curl -s http://localhost:8080/api/status | python3 -m json.tool
# 确认 connected_nodes >= 1

# === 9. 打开 Dashboard（3D 骨骼 + 信号热图）===
open http://localhost:8080/ui/index.html

# === 10. 打开 Observatory（沉浸式人体可视化）===
open http://localhost:8080/ui/observatory.html

# === 11. 验证 Pose API ===
curl -s http://localhost:8080/api/v1/pose/current | python3 -m json.tool
# 确认 persons 非空，keypoints 有 17 个

# === 12. 验证生命体征 ===
curl -s http://localhost:8080/api/v1/vital-signs | python3 -m json.tool
# 确认 breathing_bpm 和 heart_bpm 有合理数值
```

---

## 15. 部署记录：2026-04-22 五节点首次配置

记录首次在 macOS (Apple Silicon) 上完成 5 台 ESP32-S3 DevKitC 的完整配置过程，供后续复现参考。

### 15.1 环境与硬件

| 项目 | 详情 |
|------|------|
| 主机 | macOS Darwin 25.0.0, Apple Silicon (aarch64) |
| ESP-IDF | v5.4，本地安装于 `~/esp/esp-idf-v5.4`（非 Docker 编译） |
| Docker | 27.5.1 (已安装，备用编译方式) |
| esptool | v5.2.0 (`pip3 install esptool`) |
| 设备 | ESP32-S3 DevKitC-1 × 5，16MB Flash / 8MB PSRAM |
| 固件 | v0.6.2, 8MB flash 配置, ~1.06MB 二进制 |

### 15.2 操作步骤

**步骤 1：安装 ESP-IDF v5.4**

```bash
mkdir -p ~/esp && cd ~/esp
git clone --branch v5.4 --depth 1 https://github.com/espressif/esp-idf.git esp-idf-v5.4
cd esp-idf-v5.4
git submodule update --init --recursive
./install.sh esp32s3
```

> 安装耗时约 5-10 分钟，包含工具链下载。

**步骤 2：编译固件（本地 ESP-IDF）**

```bash
cd ~/AiProject/RuView
source ~/esp/esp-idf-v5.4/export.sh
cd firmware/esp32-csi-node
rm -rf build sdkconfig
idf.py set-target esp32s3
idf.py build
```

编译结果：1421 个源文件，固件 1,106,768 bytes (~1.06MB)。

**步骤 3：识别设备端口**

```bash
ls /dev/cu.usbmodem*
```

5 台设备分别挂载在：
- `/dev/cu.usbmodem1101`
- `/dev/cu.usbmodem1201`
- `/dev/cu.usbmodem5B8F0637011`
- `/dev/cu.usbmodem5B8F0637931`
- `/dev/cu.usbmodem5B8F0658271`

**步骤 4：批量烧录**

```bash
for PORT in /dev/cu.usbmodem*; do
  echo "=== 烧录 $PORT ==="
  python3 -m esptool --chip esp32s3 --port "$PORT" --baud 460800 \
    write_flash --flash_mode dio --flash_size 8MB \
    0x0     firmware/esp32-csi-node/build/bootloader/bootloader.bin \
    0x8000  firmware/esp32-csi-node/build/partition_table/partition-table.bin \
    0x10000 firmware/esp32-csi-node/build/esp32-csi-node.bin
done
```

5 台均成功烧录，无需手动进入下载模式。

**步骤 5：批量 WiFi Provision**

```bash
WIFI_SSID="LF-office"
WIFI_PASS="<密码>"
SERVER_IP="172.16.21.87"

declare -A NODES=(
  ["/dev/cu.usbmodem1101"]=1
  ["/dev/cu.usbmodem1201"]=2
  ["/dev/cu.usbmodem5B8F0637011"]=3
  ["/dev/cu.usbmodem5B8F0637931"]=4
  ["/dev/cu.usbmodem5B8F0658271"]=5
)

for PORT in "${!NODES[@]}"; do
  NID=${NODES[$PORT]}
  python3 firmware/esp32-csi-node/provision.py \
    --port "$PORT" \
    --ssid "$WIFI_SSID" \
    --password "$WIFI_PASS" \
    --target-ip "$SERVER_IP" \
    --node-id "$NID"
done
```

**步骤 6：串口验证**

逐台检查串口日志，确认输出 `Connected to WiFi` + `CSI streaming active` + `node_id=X (NVS-verified, fix for #390)`。

**步骤 7：启动 Sensing Server**

```bash
cd ~/AiProject/RuView
OPENBLAS_DIR=/opt/homebrew/opt/openblas cargo run -p wifi-densepose-sensing-server
```

确认 `connected_nodes: 5`，所有节点数据到达。

**步骤 8：通过闪灯定位设备**

在 Web UI (http://localhost:8080) 的设备管理页面，逐台触发蓝色 LED 闪烁（3 秒），确认物理位置与 Node ID 对应关系。

**步骤 9：通过 Web UI 配置设备位置**

在设备配置页面写入各节点的三维坐标（米）：

| Node | 位置 (x, y, z) | 安装方式 |
|------|----------------|---------|
| 1 | (4.2, 0.5, 3.0) | 高处安装 |
| 2 | (7.7, 2.2, 0.0) | 桌面水平 |
| 3 | (5.9, 5.5, 0.0) | 桌面水平 |
| 4 | (2.1, 5.4, 0.0) | 桌面水平 |
| 5 | (0.7, 2.4, 0.0) | 桌面水平 |

通过 `/api/nodes` 确认位置参数已写入，所有节点延迟 4-21ms。

### 15.3 验证结果

| 检查项 | 结果 |
|--------|------|
| 5 台设备识别 | PASS |
| 固件编译 (v0.6.2, 8MB) | PASS — 1.06MB |
| 批量烧录 | PASS — 5/5 |
| WiFi 连接 | PASS — 5/5 |
| CSI 数据流 | PASS — 297-338 pps/node |
| NVS node_id 验证 (#390) | PASS — 串口日志确认 |
| 设备闪灯定位 | PASS — 5/5 物理位置确认 |
| Web UI 位置配置 | PASS — 坐标已写入 |
| Sensing Server 连接 | PASS — connected_nodes=5 |
| 运动检测 | PASS — 所有节点检测到人员移动 |

### 15.4 注意事项

1. **编译方式**：本次使用本地 ESP-IDF v5.4 编译，未使用 Docker。Docker 方式同样可用，见 §3.2。
2. **设备型号**：5 台均为 DevKitC-1 (16MB Flash / 8MB PSRAM)，非 SuperMini (4MB)。使用 8MB flash 配置 (`sdkconfig.defaults.template`)。
3. **端口名称变化**：USB 端口名称 (`cu.usbmodem*`) 与物理 USB 口绑定，拔插后可能变化。每次操作前用 `ls /dev/cu.usbmodem*` 确认。
4. **#390 Bug**：v0.6.2 已修复 node_id 被 Kconfig 默认值覆盖的问题，串口日志会输出 `NVS-verified` 确认。

---

## 16. 进阶参考

本操作手册覆盖了从硬件连接到人体成像的完整测试流程。以下文档提供更深入的功能说明：

| 文档 | 路径 | 内容 |
|------|------|------|
| **User Guide** | `docs/user-guide.md` | REST API 完整参考、WebSocket 协议、模型训练流程、自适应分类器、RVF 容器、Docker 部署 |
| **Build Guide** | `docs/build-guide.md` | 从源码编译的详细步骤 |
| **Troubleshooting** | `docs/TROUBLESHOOTING.md` | 更多问题排查场景 |
| **WiFi MAT Guide** | `docs/wifi-mat-user-guide.md` | 大规模伤亡评估工具（MAT）使用指南 |
| **ADR-018** | `docs/adr/ADR-018-*.md` | CSI 二进制帧协议规范 |
| **ADR-028** | `docs/adr/ADR-028-*.md` | ESP32 能力审计与见证验证 |
