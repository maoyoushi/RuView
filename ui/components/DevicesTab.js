/**
 * DevicesTab — 设备连接状态与位置配置
 *
 * 显示所有已连接的 ESP32 节点状态、RSSI、运动等级，
 * 支持拖拽设置节点在房间内的位置，点击可闪烁设备 LED 以便识别。
 */

import { apiService } from '../services/api.service.js';

const NODE_COLORS = ['#00ccff', '#ff6600', '#00ff88', '#ff00cc', '#ffcc00', '#8800ff', '#00ffcc', '#ff0044'];
const ROOM_DEFAULT = { width: 8, height: 6 };
const POLL_INTERVAL_MS = 2000;

export class DevicesTab {
  constructor(container) {
    this.container = container;
    this.nodes = [];
    this.positions = {};
    this.roomSize = { ...ROOM_DEFAULT };
    this._pollTimer = null;
    this._dragging = null;
    this._initialized = false;
    this._identifyingNode = null;
  }

  async init() {
    if (this._initialized) {
      await this._refresh();
      return;
    }
    this._buildDOM();
    await this._loadData();
    this._connectLive();
    this._setupCanvas();
    this._initialized = true;
  }

  _buildDOM() {
    this.container.innerHTML = `
      <h2>设备管理</h2>
      <div class="devices-layout">
        <div class="devices-list-panel">
          <div class="devices-card">
            <div class="devices-card-title">已连接设备</div>
            <div id="devicesNodeList" class="devices-node-list">
              <div class="devices-empty">加载中...</div>
            </div>
          </div>
          <div class="devices-card">
            <div class="devices-card-title">房间尺寸（米）</div>
            <div class="devices-room-size">
              <label>宽度 <input type="number" id="roomWidth" value="${this.roomSize.width}" min="1" max="50" step="0.5"></label>
              <label>高度 <input type="number" id="roomHeight" value="${this.roomSize.height}" min="1" max="50" step="0.5"></label>
            </div>
          </div>
          <div class="devices-card">
            <div class="devices-card-title">节点位置</div>
            <div id="devicesPositionInputs" class="devices-position-inputs"></div>
            <button id="devicesSaveBtn" class="devices-save-btn">保存位置</button>
            <div id="devicesSaveStatus" class="devices-save-status"></div>
          </div>
        </div>
        <div class="devices-map-panel">
          <div class="devices-card">
            <div class="devices-card-title">房间布局</div>
            <div class="devices-map-hint">拖拽节点调整位置，点击节点闪烁指示灯识别设备</div>
            <canvas id="devicesCanvas" width="600" height="450"></canvas>
            <div class="devices-map-legend">
              <span class="devices-legend-item"><span class="devices-legend-dot" style="background:#4ade80"></span> 路由器 (AP)</span>
              <span class="devices-legend-item"><span class="devices-legend-dot" style="background:#00ccff"></span> ESP32 节点</span>
            </div>
          </div>
        </div>
      </div>
    `;

    this.container.querySelector('#roomWidth').addEventListener('change', () => this._onRoomSizeChange());
    this.container.querySelector('#roomHeight').addEventListener('change', () => this._onRoomSizeChange());
    this.container.querySelector('#devicesSaveBtn').addEventListener('click', () => this._savePositions());
  }

  async _loadData() {
    try {
      const [nodesResp, posResp] = await Promise.all([
        apiService.get('/api/v1/nodes'),
        apiService.get('/api/v1/nodes/positions'),
      ]);
      this.nodes = (nodesResp?.nodes || []).sort((a, b) => a.node_id - b.node_id);
      this.positions = posResp?.positions || {};
      this._renderAll();
    } catch (e) {
      console.error('[DevicesTab] 加载数据失败:', e);
      this._renderAll();
    }
  }

  async _refresh() {
    try {
      const resp = await apiService.get('/api/v1/nodes');
      this.nodes = (resp?.nodes || []).sort((a, b) => a.node_id - b.node_id);
      this._renderNodeList();
      this._drawCanvas();
    } catch (_) {}
  }

  _connectLive() {
    this._pollTimer = setInterval(() => this._refresh(), POLL_INTERVAL_MS);
  }

  _renderAll() {
    this._renderNodeList();
    this._renderPositionInputs();
    this._drawCanvas();
  }

  _renderNodeList() {
    const list = this.container.querySelector('#devicesNodeList');
    if (!list) return;

    if (this.nodes.length === 0) {
      list.innerHTML = '<div class="devices-empty">未检测到设备</div>';
      return;
    }

    list.innerHTML = this.nodes.map(n => {
      const color = NODE_COLORS[n.node_id % NODE_COLORS.length];
      const isActive = n.status === 'active';
      const statusDot = isActive ? '#4ade80' : '#888';
      const statusText = isActive ? '在线' : '离线';
      const statusClass = isActive ? 'devices-status-online' : 'devices-status-offline';
      const lastSeen = n.last_seen_ms < 1000
        ? `${n.last_seen_ms}ms 前`
        : n.last_seen_ms < 60000
          ? `${(n.last_seen_ms / 1000).toFixed(1)}s 前`
          : '已离线';
      const motionMap = {
        'absent': '无人', 'present_still': '静止', 'present_moving': '活动中',
      };
      const motion = motionMap[n.motion_level] || n.motion_level || '未知';
      const pos = this.positions[String(n.node_id)];
      const posStr = pos ? `[${pos.map(v => v.toFixed(1)).join(', ')}]` : '未设置';
      const isIdentifying = this._identifyingNode === n.node_id;

      return `
        <div class="devices-node-row ${isIdentifying ? 'devices-node-identifying' : ''}" data-node-id="${n.node_id}">
          <div class="devices-node-id" style="border-left: 3px solid ${color}">
            <span class="devices-node-dot" style="background:${statusDot}"></span>
            <strong style="color:${color}">节点 ${n.node_id}</strong>
            <span class="devices-node-status ${statusClass}">${statusText}</span>
          </div>
          <div class="devices-node-meta">
            <span>${n.rssi_dbm.toFixed(0)} dBm</span>
            <span class="devices-node-motion">${motion}</span>
            <span>${n.person_count} 人</span>
          </div>
          <div class="devices-node-actions">
            <span class="devices-node-seen">${lastSeen}</span>
            <button class="devices-identify-btn" data-node="${n.node_id}" title="闪烁设备指示灯"
              ${!isActive || isIdentifying ? 'disabled' : ''}>
              ${isIdentifying ? '闪烁中...' : '识别'}
            </button>
          </div>
          <div class="devices-node-detail">
            <span class="devices-node-pos">${posStr}</span>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.devices-identify-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._identifyNode(parseInt(btn.dataset.node));
      });
    });
  }

  _renderPositionInputs() {
    const container = this.container.querySelector('#devicesPositionInputs');
    if (!container) return;

    const allIds = new Set([
      ...this.nodes.map(n => n.node_id),
      ...Object.keys(this.positions).map(Number),
    ]);
    const sortedIds = [...allIds].sort((a, b) => a - b);

    if (sortedIds.length === 0) {
      container.innerHTML = '<div class="devices-empty">暂无设备可配置</div>';
      return;
    }

    container.innerHTML = sortedIds.map(id => {
      const pos = this.positions[String(id)] || [0, 0, 0];
      const color = NODE_COLORS[id % NODE_COLORS.length];
      return `
        <div class="devices-pos-row">
          <span class="devices-pos-label" style="color:${color}">节点 ${id}</span>
          <input type="number" class="devices-pos-input" data-node="${id}" data-axis="0" value="${pos[0]}" step="0.1" placeholder="X">
          <input type="number" class="devices-pos-input" data-node="${id}" data-axis="1" value="${pos[1]}" step="0.1" placeholder="Y">
          <input type="number" class="devices-pos-input" data-node="${id}" data-axis="2" value="${pos[2]}" step="0.1" placeholder="Z">
          <span class="devices-pos-unit">米</span>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.devices-pos-input').forEach(input => {
      input.addEventListener('change', () => this._onPositionInputChange(input));
    });
  }

  // ── Canvas 2D room map ───────────────────────────────────────────────────

  _setupCanvas() {
    const canvas = this.container.querySelector('#devicesCanvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => this._onCanvasMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this._onCanvasMouseMove(e));
    canvas.addEventListener('mouseup', () => this._onCanvasMouseUp());
    canvas.addEventListener('mouseleave', () => this._onCanvasMouseUp());
  }

  _drawCanvas() {
    const canvas = this.container.querySelector('#devicesCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const pad = 40;

    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(0,0,0,0.03)';
    ctx.fillRect(pad, pad, W - 2 * pad, H - 2 * pad);
    ctx.strokeStyle = 'var(--color-border, #ccc)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);

    const rw = this.roomSize.width;
    const rh = this.roomSize.height;
    const scaleX = (W - 2 * pad) / rw;
    const scaleY = (H - 2 * pad) / rh;

    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 0.5;
    for (let x = 1; x < rw; x++) {
      const px = pad + x * scaleX;
      ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, H - pad); ctx.stroke();
    }
    for (let y = 1; y < rh; y++) {
      const py = pad + y * scaleY;
      ctx.beginPath(); ctx.moveTo(pad, py); ctx.lineTo(W - pad, py); ctx.stroke();
    }

    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let x = 0; x <= rw; x++) {
      ctx.fillText(`${x}m`, pad + x * scaleX, H - pad + 15);
    }
    ctx.textAlign = 'right';
    for (let y = 0; y <= rh; y++) {
      ctx.fillText(`${y}m`, pad - 5, pad + y * scaleY + 4);
    }

    // Router at origin
    const rx = pad;
    const ry = pad;
    ctx.beginPath();
    ctx.arc(rx, ry, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#4ade80';
    ctx.fill();
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#166534';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('AP', rx, ry + 3);

    // Nodes
    const allIds = new Set([
      ...this.nodes.map(n => n.node_id),
      ...Object.keys(this.positions).map(Number),
    ]);

    for (const id of allIds) {
      const pos = this.positions[String(id)] || [0, 0, 0];
      const nx = pad + pos[0] * scaleX;
      const ny = pad + pos[1] * scaleY;
      const color = NODE_COLORS[id % NODE_COLORS.length];
      const nodeData = this.nodes.find(n => n.node_id === id);
      const isActive = nodeData ? nodeData.status === 'active' : false;
      const isIdentifying = this._identifyingNode === id;

      // Connection line to router
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(nx, ny);
      ctx.strokeStyle = isActive ? `${color}44` : '#88888844';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Identify pulse ring
      if (isIdentifying) {
        ctx.beginPath();
        ctx.arc(nx, ny, 22, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4 + 0.4 * Math.sin(Date.now() / 200);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(nx, ny, 14, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? color : '#888';
      ctx.globalAlpha = isActive ? 1.0 : 0.5;
      ctx.fill();
      ctx.globalAlpha = 1.0;
      ctx.strokeStyle = isActive ? color : '#666';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Node label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(id), nx, ny + 4);

      // Status + RSSI below node
      if (nodeData) {
        ctx.fillStyle = isActive ? '#333' : '#999';
        ctx.font = '9px sans-serif';
        const statusLabel = isActive ? '在线' : '离线';
        ctx.fillText(`${statusLabel} ${nodeData.rssi_dbm.toFixed(0)}dBm`, nx, ny + 24);
      }
    }
  }

  // ── Canvas interaction ──────────────────────────────────────────────────

  _canvasToRoom(e) {
    const canvas = this.container.querySelector('#devicesCanvas');
    const rect = canvas.getBoundingClientRect();
    const pad = 40;
    const scaleX = (canvas.width - 2 * pad) / this.roomSize.width;
    const scaleY = (canvas.height - 2 * pad) / this.roomSize.height;
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    const rx = Math.max(0, Math.min(this.roomSize.width, (mx - pad) / scaleX));
    const ry = Math.max(0, Math.min(this.roomSize.height, (my - pad) / scaleY));
    return { rx, ry, mx, my };
  }

  _hitTest(mx, my) {
    const canvas = this.container.querySelector('#devicesCanvas');
    const pad = 40;
    const scaleX = (canvas.width - 2 * pad) / this.roomSize.width;
    const scaleY = (canvas.height - 2 * pad) / this.roomSize.height;

    const allIds = [...new Set([
      ...this.nodes.map(n => n.node_id),
      ...Object.keys(this.positions).map(Number),
    ])];

    for (const id of allIds) {
      const pos = this.positions[String(id)] || [0, 0, 0];
      const nx = pad + pos[0] * scaleX;
      const ny = pad + pos[1] * scaleY;
      const dist = Math.sqrt((mx - nx) ** 2 + (my - ny) ** 2);
      if (dist < 18) return id;
    }
    return null;
  }

  _onCanvasMouseDown(e) {
    const { mx, my } = this._canvasToRoom(e);
    const hitId = this._hitTest(mx, my);
    if (hitId !== null) {
      this._dragging = hitId;
      this.container.querySelector('#devicesCanvas').style.cursor = 'grabbing';
    }
  }

  _onCanvasMouseMove(e) {
    if (this._dragging === null) {
      const { mx, my } = this._canvasToRoom(e);
      const hitId = this._hitTest(mx, my);
      this.container.querySelector('#devicesCanvas').style.cursor = hitId !== null ? 'grab' : 'default';
      return;
    }
    const { rx, ry } = this._canvasToRoom(e);
    const id = this._dragging;
    const pos = this.positions[String(id)] || [0, 0, 0];
    pos[0] = Math.round(rx * 10) / 10;
    pos[1] = Math.round(ry * 10) / 10;
    this.positions[String(id)] = pos;
    this._drawCanvas();
    this._syncInputsFromPositions();
  }

  _onCanvasMouseUp() {
    if (this._dragging !== null) {
      this._dragging = null;
      this.container.querySelector('#devicesCanvas').style.cursor = 'default';
    }
  }

  // ── Input handling ───────────────────────────────────────────────────────

  _onPositionInputChange(input) {
    const nodeId = input.dataset.node;
    const axis = parseInt(input.dataset.axis);
    if (!this.positions[nodeId]) this.positions[nodeId] = [0, 0, 0];
    this.positions[nodeId][axis] = parseFloat(input.value) || 0;
    this._drawCanvas();
    this._renderNodeList();
  }

  _syncInputsFromPositions() {
    const inputs = this.container.querySelectorAll('.devices-pos-input');
    inputs.forEach(input => {
      const nodeId = input.dataset.node;
      const axis = parseInt(input.dataset.axis);
      const pos = this.positions[nodeId];
      if (pos) input.value = pos[axis];
    });
    this._renderNodeList();
  }

  _onRoomSizeChange() {
    this.roomSize.width = parseFloat(this.container.querySelector('#roomWidth').value) || ROOM_DEFAULT.width;
    this.roomSize.height = parseFloat(this.container.querySelector('#roomHeight').value) || ROOM_DEFAULT.height;
    this._drawCanvas();
  }

  // ── Identify (blink LED) ─────────────────────────────────────────────────

  async _identifyNode(nodeId) {
    if (this._identifyingNode !== null) return;
    this._identifyingNode = nodeId;
    this._renderNodeList();

    const pulseInterval = setInterval(() => this._drawCanvas(), 50);

    try {
      await apiService.post(`/api/v1/nodes/identify`, { node_id: nodeId });
    } catch (e) {
      console.warn('[DevicesTab] 识别命令发送失败:', e.message);
    }

    setTimeout(() => {
      this._identifyingNode = null;
      clearInterval(pulseInterval);
      this._renderNodeList();
      this._drawCanvas();
    }, 3000);
  }

  // ── Save positions ───────────────────────────────────────────────────────

  async _savePositions() {
    const btn = this.container.querySelector('#devicesSaveBtn');
    const status = this.container.querySelector('#devicesSaveStatus');
    btn.disabled = true;
    btn.textContent = '保存中...';
    status.textContent = '';

    try {
      const resp = await apiService.post('/api/v1/nodes/positions', {
        positions: this.positions,
      });
      status.textContent = `已保存 ${resp.updated} 个节点位置`;
      status.className = 'devices-save-status success';
    } catch (e) {
      status.textContent = '保存失败: ' + e.message;
      status.className = 'devices-save-status error';
    } finally {
      btn.disabled = false;
      btn.textContent = '保存位置';
      setTimeout(() => { if (status) status.textContent = ''; }, 4000);
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  dispose() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }
}
