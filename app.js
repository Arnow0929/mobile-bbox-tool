'use strict';

const DB_NAME = 'bbox_tool_mobile_v1';
const DB_VERSION = 1;
const STORES = ['meta', 'images', 'annotations', 'marked'];
const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const state = {
  db: null, project: null, tasks: [], annotations: new Map(), currentId: null,
  image: null, imageUrl: null, start: null, bbox: null, dragging: false,
  exportFiles: null, busy: false
};

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', {keyPath: 'path'});
      if (!db.objectStoreNames.contains('annotations')) db.createObjectStore('annotations', {keyPath: 'queryId'});
      if (!db.objectStoreNames.contains('marked')) db.createObjectStore('marked', {keyPath: 'queryId'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(store, key) {
  return requestPromise(state.db.transaction(store, 'readonly').objectStore(store).get(key));
}

async function dbGetAll(store) {
  return requestPromise(state.db.transaction(store, 'readonly').objectStore(store).getAll());
}

async function dbPut(store, value, key) {
  const transaction = state.db.transaction(store, 'readwrite');
  const objectStore = transaction.objectStore(store);
  key === undefined ? objectStore.put(value) : objectStore.put(value, key);
  await transactionDone(transaction);
}

async function dbDelete(store, key) {
  const transaction = state.db.transaction(store, 'readwrite');
  transaction.objectStore(store).delete(key);
  await transactionDone(transaction);
}

async function clearDatabase() {
  const transaction = state.db.transaction(STORES, 'readwrite');
  STORES.forEach(store => transaction.objectStore(store).clear());
  await transactionDone(transaction);
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

function basename(value) {
  const parts = normalizePath(value).split('/');
  return parts[parts.length - 1];
}

function toast(message, error = false) {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.className = 'toast', 3500);
}

function setBusy(value) {
  state.busy = value;
  $('projectInput').disabled = value;
  $('folderInput').disabled = value;
  updateButtons();
}

function showProgress(kind, current, total, text) {
  const prefix = kind === 'import' ? 'import' : 'export';
  $(`${prefix}Progress`).classList.remove('hidden');
  $(`${prefix}Bar`).style.width = `${total ? current / total * 100 : 0}%`;
  $(`${prefix}Text`).textContent = text;
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

class ZipReader {
  constructor(file) { this.file = file; this.entries = []; }

  async init() {
    const tailSize = Math.min(this.file.size, 65557);
    const tailOffset = this.file.size - tailSize;
    const tail = new Uint8Array(await this.file.slice(tailOffset).arrayBuffer());
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件，或 ZIP 使用了不支持的 ZIP64 格式。');
    const entryCount = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    const bytes = new Uint8Array(await this.file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    const central = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8');
    let offset = 0;
    for (let index = 0; index < entryCount; index++) {
      if (central.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 中央目录损坏。');
      const method = central.getUint16(offset + 10, true);
      const compressedSize = central.getUint32(offset + 20, true);
      const size = central.getUint32(offset + 24, true);
      const nameLength = central.getUint16(offset + 28, true);
      const extraLength = central.getUint16(offset + 30, true);
      const commentLength = central.getUint16(offset + 32, true);
      const localOffset = central.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
      this.entries.push({name, method, compressedSize, size, localOffset});
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return this;
  }

  async extract(entry, mimeType = 'application/octet-stream') {
    const headerBytes = new Uint8Array(await this.file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    const header = new DataView(headerBytes.buffer);
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error(`ZIP 条目损坏：${entry.name}`);
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const compressed = this.file.slice(start, start + entry.compressedSize);
    if (entry.method === 0) return compressed.slice(0, compressed.size, mimeType);
    if (entry.method === 8 && typeof DecompressionStream !== 'undefined') {
      try {
        const stream = compressed.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const blob = await new Response(stream).blob();
        return blob.slice(0, blob.size, mimeType);
      } catch (error) {
        throw new Error(`浏览器无法解压 ${entry.name}。请更新浏览器，或在电脑上创建“仅存储/不压缩”的 ZIP。`);
      }
    }
    throw new Error(`ZIP 条目 ${entry.name} 使用了浏览器不支持的压缩方式 ${entry.method}。`);
  }
}

function imageMime(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function isQueryObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const items = Object.values(value);
  return items.length > 0 && items.some(item => item && typeof item === 'object' &&
    typeof item.visible === 'string' && (typeof item.query === 'string' || typeof item.query_zh === 'string'));
}

function findImageMatch(records, targetPath) {
  const target = normalizePath(targetPath);
  const exact = records.filter(record => record.path === target || record.path.endsWith(`/${target}`));
  if (exact.length) return exact.sort((a, b) => a.path.length - b.path.length)[0];
  const byName = records.filter(record => basename(record.path) === basename(target));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`图片文件名 ${basename(target)} 存在多个候选，请保留文件夹结构以便识别。`);
  return null;
}

async function saveImportedProject(queryObject, imageRecords, projectName, getBlob) {
  const queryEntries = Object.entries(queryObject).filter(([, value]) => value && typeof value === 'object');
  const needed = [...new Set(queryEntries.map(([, item]) => normalizePath(item.visible)).filter(Boolean))];
  const matches = new Map();
  for (const path of needed) {
    const match = findImageMatch(imageRecords, path);
    if (!match) throw new Error(`找不到 query 引用的图片：${path}`);
    matches.set(path, match);
  }

  await clearDatabase();
  let index = 0;
  for (const [path, record] of matches) {
    showProgress('import', index, matches.size, `正在导入图片：${index + 1} / ${matches.size}`);
    const blob = await getBlob(record, path);
    await dbPut('images', {path, name: basename(path), blob});
    index += 1;
    if (index % 3 === 0) await nextFrame();
  }
  const project = {
    name: projectName,
    importedAt: new Date().toISOString(),
    queries: queryEntries.map(([id, item]) => ({id, ...item})),
    completedIds: [], currentId: queryEntries[0][0]
  };
  await dbPut('meta', project, 'project');
  if (navigator.storage && navigator.storage.persist) await navigator.storage.persist().catch(() => false);
  state.exportFiles = null;
  $('shareArea').classList.add('hidden');
  showProgress('import', matches.size, matches.size, `导入完成：${matches.size} 张图片，${queryEntries.length} 个 query`);
  await loadProject();
  toast('项目已识别并保存到手机浏览器。');
}

async function importZip(file) {
  showProgress('import', 0, 1, '正在识别 ZIP 内容…');
  const zip = await new ZipReader(file).init();
  const jsonEntries = zip.entries.filter(entry => /\.json$/i.test(entry.name));
  let queryObject = null;
  for (const entry of jsonEntries) {
    try {
      const candidate = JSON.parse(await (await zip.extract(entry, 'application/json')).text());
      if (isQueryObject(candidate)) { queryObject = candidate; break; }
    } catch (_) { /* Try the next JSON file. */ }
  }
  if (!queryObject) throw new Error('ZIP 中没有识别到包含 visible/query 字段的 query JSON。');
  const imageRecords = zip.entries
    .filter(entry => /\.(png|jpe?g)$/i.test(entry.name))
    .map(entry => ({entry, path: normalizePath(entry.name)}));
  await saveImportedProject(queryObject, imageRecords, file.name,
    (record, path) => zip.extract(record.entry, imageMime(path)));
}

async function importLooseFiles(records) {
  const jsonRecords = records.filter(record => /\.json$/i.test(record.path) || record.file.type === 'application/json');
  let queryObject = null, queryName = '';
  for (const record of jsonRecords) {
    try {
      const candidate = JSON.parse(await record.file.text());
      if (isQueryObject(candidate)) { queryObject = candidate; queryName = record.file.name; break; }
    } catch (_) { /* Try the next JSON file. */ }
  }
  if (!queryObject) throw new Error('未识别到包含 visible/query 字段的 query JSON。请将 JSON 和图片一起选择或拖入。');
  const imageRecords = records.filter(record => /\.(png|jpe?g)$/i.test(record.path));
  await saveImportedProject(queryObject, imageRecords, queryName || '本地文件项目', record => record.file);
}

async function importRecords(records) {
  if (!records.length) return;
  if (state.project && !confirm('导入新项目会删除手机中当前项目的标注和进度，是否继续？')) {
    $('projectInput').value = '';
    $('folderInput').value = '';
    return;
  }
  setBusy(true);
  $('importProgress').classList.remove('hidden');
  try {
    const zipRecord = records.find(record => /\.zip$/i.test(record.path) || record.file.type === 'application/zip');
    if (zipRecord) await importZip(zipRecord.file);
    else await importLooseFiles(records);
  } catch (error) {
    toast(error.message, true);
    await loadProject().catch(() => {});
  } finally {
    setBusy(false);
    $('projectInput').value = '';
    $('folderInput').value = '';
  }
}

function fileRecords(fileList) {
  return [...fileList].map(file => ({file, path: normalizePath(file.webkitRelativePath || file.name)}));
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkEntry(entry, records) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    records.push({file, path: normalizePath(entry.fullPath || file.name)});
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    while (true) {
      const entries = await readDirectoryEntries(reader);
      if (!entries.length) break;
      for (const child of entries) await walkEntry(child, records);
    }
  }
}

async function droppedRecords(dataTransfer) {
  const entries = [...dataTransfer.items].map(item => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return fileRecords(dataTransfer.files);
  const records = [];
  for (const entry of entries) await walkEntry(entry, records);
  return records;
}

async function loadProject() {
  state.project = await dbGet('meta', 'project');
  const annotations = await dbGetAll('annotations');
  state.annotations = new Map(annotations.map(item => [item.queryId, item]));
  state.tasks = state.project ? state.project.queries : [];
  if (!state.project) {
    showEmpty('请拖入数据包，或选择 query JSON 和图片文件');
    renderTaskSelect(); updateProgress(); return;
  }
  // Reconcile completion state from the unique annotation keys. This also
  // repairs the state if a browser was closed between two IndexedDB writes.
  const validIds = new Set(state.tasks.map(task => task.id));
  state.project.completedIds = [...state.annotations.keys()].filter(id => validIds.has(id));
  await dbPut('meta', state.project, 'project');
  const pending = state.tasks.find(task => !state.annotations.has(task.id));
  const savedCurrent = state.tasks.find(task => task.id === state.project.currentId);
  state.currentId = savedCurrent && !state.annotations.has(savedCurrent.id) ? savedCurrent.id : (pending ? pending.id : state.tasks[0]?.id);
  $('projectStatus').textContent = `${state.project.name} · 数据保存在本机`;
  renderTaskSelect(); updateProgress();
  if (state.currentId) await loadCurrentTask(); else showEmpty('项目中没有 query。');
}

function renderTaskSelect() {
  const select = $('taskSelect');
  select.replaceChildren();
  if (!state.tasks.length) {
    const option = document.createElement('option'); option.textContent = '请先导入项目'; select.appendChild(option); select.disabled = true; return;
  }
  state.tasks.forEach((task, index) => {
    const option = document.createElement('option');
    option.value = task.id;
    option.textContent = `${index + 1}. ${task.id}${state.annotations.has(task.id) ? ' ✓' : ''}`;
    option.selected = task.id === state.currentId;
    select.appendChild(option);
  });
  select.disabled = state.busy;
}

async function getImageRecord(task) {
  const direct = await dbGet('images', normalizePath(task.visible));
  if (direct) return direct;
  const all = await dbGetAll('images');
  return all.find(item => item.name === basename(task.visible)) || null;
}

async function loadCurrentTask() {
  const task = state.tasks.find(item => item.id === state.currentId);
  if (!task) return showEmpty('没有可显示的 query。');
  state.start = null; state.dragging = false;
  const existing = state.annotations.get(task.id);
  state.bbox = existing ? [...existing.pixelBBox] : null;
  $('queryEn').textContent = task.query || '—';
  $('queryZh').textContent = task.query_zh || '—';
  $('taskSelect').value = task.id;
  const imageRecord = await getImageRecord(task);
  if (!imageRecord) return showEmpty(`找不到图片：${task.visible}`);
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = URL.createObjectURL(imageRecord.blob);
  const image = new Image();
  image.onload = () => {
    state.image = image; canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.classList.remove('hidden'); $('emptyState').classList.add('hidden');
    draw(); updateCoordinates(); updateButtons();
  };
  image.onerror = () => showEmpty(`图片无法解码：${task.visible}`);
  image.src = state.imageUrl;
  if (state.project.currentId !== task.id) {
    state.project.currentId = task.id;
    await dbPut('meta', state.project, 'project');
  }
}

function showEmpty(message) {
  state.image = null; canvas.classList.add('hidden');
  $('emptyState').textContent = message; $('emptyState').classList.remove('hidden');
  $('queryEn').textContent = '—'; $('queryZh').textContent = '—'; updateButtons();
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width - 1, (event.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height - 1, (event.clientY - rect.top) * canvas.height / rect.height))
  };
}

function normalizeBox(a, b) {
  return [Math.round(Math.min(a.x, b.x)), Math.round(Math.min(a.y, b.y)),
          Math.round(Math.max(a.x, b.x)), Math.round(Math.max(a.y, b.y))];
}

function draw(preview = null) {
  if (!state.image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.image, 0, 0);
  const bbox = preview && state.start ? normalizeBox(state.start, preview) : state.bbox;
  if (bbox) {
    ctx.save(); ctx.strokeStyle = '#ff2732';
    ctx.lineWidth = Math.max(3, Math.min(canvas.width, canvas.height) / 220);
    ctx.strokeRect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]); ctx.restore();
  }
}

canvas.addEventListener('pointerdown', event => {
  if (!state.image || state.busy) return;
  event.preventDefault(); canvas.setPointerCapture(event.pointerId);
  state.start = canvasPoint(event); state.bbox = null; state.dragging = true; draw(state.start); updateButtons();
});
canvas.addEventListener('pointermove', event => {
  if (!state.dragging) return; event.preventDefault(); draw(canvasPoint(event));
});
canvas.addEventListener('pointerup', event => {
  if (!state.dragging) return; event.preventDefault();
  state.bbox = normalizeBox(state.start, canvasPoint(event)); state.dragging = false;
  draw(); updateCoordinates(); updateButtons();
});
canvas.addEventListener('pointercancel', () => { state.dragging = false; draw(); });

function updateCoordinates() {
  $('coordinates').textContent = state.bbox ? `原图坐标：[${state.bbox.join(', ')}]` : '手指按住图片拖动以创建标注框';
}

function updateProgress() {
  const done = state.annotations.size;
  $('exportSummary').textContent = `已完成 ${done} / ${state.tasks.length}`;
  $('projectStatus').textContent = state.project ? `${state.project.name} · 已完成 ${done}/${state.tasks.length}` : '尚未导入项目';
  updateButtons();
}

function updateButtons() {
  const hasCurrent = Boolean(state.currentId && state.image);
  $('clearBtn').disabled = state.busy || !hasCurrent || !state.bbox;
  $('deleteBtn').disabled = state.busy || !state.annotations.has(state.currentId);
  $('saveBtn').disabled = state.busy || !hasCurrent || !state.bbox;
  $('exportBtn').disabled = state.busy || !state.annotations.size;
  $('taskSelect').disabled = state.busy || !state.tasks.length;
}

function invalidateExport() {
  if (state.exportFiles) {
    Object.values(state.exportFiles.urls || {}).forEach(url => URL.revokeObjectURL(url));
  }
  state.exportFiles = null;
  $('shareArea').classList.add('hidden');
}

async function saveCurrent() {
  const task = state.tasks.find(item => item.id === state.currentId);
  if (!task || !state.bbox || !state.image) return;
  const [x1, y1, x2, y2] = state.bbox;
  if (x1 === x2 || y1 === y2) return toast('标注框宽高必须大于 0。', true);
  setBusy(true);
  try {
    const annotation = {
      queryId: task.id,
      pixelBBox: [x1, y1, x2, y2],
      bbox: [x1 / state.image.naturalWidth, y1 / state.image.naturalHeight,
             x2 / state.image.naturalWidth, y2 / state.image.naturalHeight].map(value => Number(value.toFixed(6))),
      width: state.image.naturalWidth, height: state.image.naturalHeight, updatedAt: Date.now()
    };
    await dbPut('annotations', annotation);
    await dbDelete('marked', task.id);
    state.annotations.set(task.id, annotation);
    if (!state.project.completedIds.includes(task.id)) state.project.completedIds.push(task.id);
    const currentIndex = state.tasks.findIndex(item => item.id === task.id);
    const ordered = [...state.tasks.slice(currentIndex + 1), ...state.tasks.slice(0, currentIndex + 1)];
    const next = ordered.find(item => !state.annotations.has(item.id));
    state.currentId = next ? next.id : task.id;
    state.project.currentId = state.currentId;
    await dbPut('meta', state.project, 'project');
    invalidateExport(); renderTaskSelect(); updateProgress();
    await loadCurrentTask();
    toast(next ? '已保存，进入下一条。' : '全部 query 已完成。');
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
}

async function deleteCurrent() {
  if (!state.annotations.has(state.currentId)) return;
  if (!confirm(`确定删除 ${state.currentId} 的标注吗？`)) return;
  setBusy(true);
  try {
    await dbDelete('annotations', state.currentId);
    await dbDelete('marked', state.currentId);
    state.annotations.delete(state.currentId);
    state.project.completedIds = state.project.completedIds.filter(id => id !== state.currentId);
    state.project.currentId = state.currentId;
    await dbPut('meta', state.project, 'project');
    state.bbox = null; invalidateExport(); renderTaskSelect(); updateProgress(); draw(); updateCoordinates();
    toast('标注已删除，该 query 已恢复为待标注。');
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

async function createZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [], centralParts = [];
  let offset = 0, centralSize = 0;
  const stamp = dosDateTime();
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(bytes), size = bytes.length;
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, stamp.time, true); lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true); cv.setUint32(16, crc, true); cv.setUint32(20, size, true);
    cv.setUint32(24, size, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    localParts.push(local, entry.blob); centralParts.push(central);
    offset += local.length + size; centralSize += central.length;
  }
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], {type: 'application/zip'});
}

function canvasToBlob(target, type = 'image/png') {
  return new Promise((resolve, reject) => target.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败。')), type));
}

async function markedImage(task, annotation) {
  const cached = await dbGet('marked', task.id);
  if (cached && cached.updatedAt === annotation.updatedAt) return cached.blob;
  const record = await getImageRecord(task);
  if (!record) throw new Error(`找不到图片：${task.visible}`);
  const bitmap = await createImageBitmap(record.blob);
  const target = document.createElement('canvas'); target.width = bitmap.width; target.height = bitmap.height;
  const targetContext = target.getContext('2d'); targetContext.drawImage(bitmap, 0, 0);
  const bbox = annotation.pixelBBox;
  targetContext.strokeStyle = '#ff0000'; targetContext.lineWidth = Math.max(2, Math.round(Math.min(bitmap.width, bitmap.height) / 300));
  targetContext.strokeRect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
  if (bitmap.close) bitmap.close();
  const blob = await canvasToBlob(target);
  await dbPut('marked', {queryId: task.id, updatedAt: annotation.updatedAt, blob});
  return blob;
}

async function exportResults() {
  if (!state.annotations.size) return;
  setBusy(true); $('exportProgress').classList.remove('hidden'); invalidateExport();
  try {
    const annotatedTasks = state.tasks.filter(task => state.annotations.has(task.id));
    const result = {}, zipEntries = [];
    for (let index = 0; index < annotatedTasks.length; index++) {
      const task = annotatedTasks[index], annotation = state.annotations.get(task.id);
      showProgress('export', index, annotatedTasks.length, `正在生成：${index + 1} / ${annotatedTasks.length}`);
      result[task.id] = {visible: task.visible || '', infrared: task.infrared || '', depth: task.depth || '',
                         query: task.query || '', bbox: annotation.bbox};
      const blob = await markedImage(task, annotation);
      const safeId = task.id.replace(/[^A-Za-z0-9_.-]+/g, '_');
      zipEntries.push({name: `marked_images/${safeId}_bbox.png`, blob});
      await nextFrame();
    }
    const jsonBlob = new Blob([JSON.stringify(result, null, 2)], {type: 'application/json'});
    const imagesBlob = await createZip(zipEntries);
    state.exportFiles = {
      json: new File([jsonBlob], 'queries_result.json', {type: 'application/json'}),
      images: new File([imagesBlob], 'marked_images.zip', {type: 'application/zip'}),
      urls: {json: URL.createObjectURL(jsonBlob), images: URL.createObjectURL(imagesBlob)}
    };
    showProgress('export', annotatedTasks.length, annotatedTasks.length, `生成完成：${annotatedTasks.length} / ${annotatedTasks.length}`);
    $('shareArea').classList.remove('hidden'); toast('导出文件已生成。');
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
}

function downloadFile(kind) {
  if (!state.exportFiles) return toast('请先一键导出。', true);
  const anchor = document.createElement('a');
  anchor.href = state.exportFiles.urls[kind]; anchor.download = state.exportFiles[kind].name;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
}

async function shareFiles(kind) {
  if (!state.exportFiles) return toast('请先一键导出。', true);
  const files = kind === 'all' ? [state.exportFiles.json, state.exportFiles.images] : [state.exportFiles[kind]];
  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare({files}))) {
      await navigator.share({title: 'BBox 标注结果', files});
    } else {
      if (kind === 'all') { downloadFile('json'); setTimeout(() => downloadFile('images'), 300); }
      else downloadFile(kind);
      toast('浏览器不支持文件分享，已改为下载。');
    }
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message, true);
  }
}

$('projectInput').addEventListener('change', event => importRecords(fileRecords(event.target.files)));
$('folderInput').addEventListener('change', event => importRecords(fileRecords(event.target.files)));
const dropZone = $('dropZone');
['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, event => {
  event.preventDefault(); dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, event => {
  event.preventDefault(); dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', async event => {
  try { await importRecords(await droppedRecords(event.dataTransfer)); }
  catch (error) { toast(error.message, true); }
});
$('taskSelect').addEventListener('change', async event => {
  state.currentId = event.target.value;
  await loadCurrentTask();
});
$('clearBtn').addEventListener('click', () => { state.bbox = null; state.start = null; draw(); updateCoordinates(); updateButtons(); });
$('saveBtn').addEventListener('click', saveCurrent);
$('deleteBtn').addEventListener('click', deleteCurrent);
$('exportBtn').addEventListener('click', exportResults);
document.querySelectorAll('[data-share]').forEach(button => button.addEventListener('click', () => shareFiles(button.dataset.share)));
document.querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', () => downloadFile(button.dataset.download)));
window.addEventListener('resize', () => draw());
window.addEventListener('orientationchange', () => setTimeout(draw, 200));

(async () => {
  try {
    state.db = await openDatabase();
    await loadProject();
  } catch (error) {
    toast(`无法打开本地存储：${error.message}`, true);
  }
})();
