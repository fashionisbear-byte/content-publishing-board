import { validateAction, project, clone, actionIdentity, makeAction, importPreview } from './model.js';
import { createBusinessStore, boardRevision } from './business.js';
import { createMemberStore } from './members.js';
import { createCatalogStore } from './catalog.js';
export const TABLE_NAME = '内容发布_共享记录';
export const ORDER_FIELD = '提交序号';
export const SCHEMA = [
  ['id', '操作ID', 'Text'], ['kind', '操作类型', 'Text'], ['date', '业务日期', 'Text'],
  ['accountId', '账号ID', 'Text'], ['account', '账号名称', 'Text'], ['owner', '负责人', 'Text'],
  ['person', '实际完成人', 'Text'], ['video', '视频数量', 'Number'], ['photo', '图文数量', 'Number'],
  ['at', '登记时间', 'Text'], ['actor', '操作者ID', 'Text'], ['seq', '操作顺序', 'Number'], ['payload', '完整内容', 'Text']
];
const KIND_LABELS = { plan: '发布计划', publish: '发布登记', batch:'统一保存登记', day: '当天调整', void: '撤销登记', seed: '历史导入', reduce: '快捷减1', stop: '停止重试', delete:'确认删除', edit:'修改登记' };
export function actionColumns(action) {
  const a = validateAction(action), p = a.payload, row = p.account ?? p.snapshot?.find(r => r.id === p.accountId);
  return { id: a.id, kind: KIND_LABELS[a.kind], date: a.date, accountId: p.accountId ?? '', account: row?.name ?? (a.kind === 'plan' ? p.accounts.length + '个账号' : ''), owner: row?.owner ?? '', person: p.person ?? '', video: p.video ?? 0, photo: p.photo ?? 0, at: a.at, actor: a.actor, seq: a.seq, payload: JSON.stringify(a) };
}
export async function readPages(table, fields) {
  const records = [], seenTokens = new Set();
  let pageToken;
  for (let page = 0; page < 101; page++) {
    const result = await table.getRecordsByPage({ pageSize: 200, ...(pageToken !== undefined ? { pageToken } : {}), stringValue: false, sort: [{ fieldId: fields.serverOrder ?? fields.seq, desc: false }, { fieldId: fields.id, desc: false }] });
    if (!Array.isArray(result.records)) throw Error('飞书返回的分页数据无效');
    records.push(...result.records);
    if (records.length > 20000) throw Error('共享记录超过20,000条，需要先做容量升级');
    if (!result.hasMore) return records;
    if (!result.records.length || result.pageToken === undefined || result.pageToken === null || seenTokens.has(result.pageToken)) throw Error('飞书分页不完整，停止读取');
    seenTokens.add(result.pageToken); pageToken = result.pageToken;
  }
  throw Error('分页超出限制');
}
function cellString(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v) && v.every(s => s.type === 'text' && typeof s.text === 'string')) return v.map(s => s.text).join('');
  throw Error('共享表字段值格式无效');
}
export function serverOrderValue(value) {
  if (value && typeof value === 'object') {
    if (value.status !== 'completed') throw Error('服务器提交序号尚未计算完成，请刷新');
    value = value.value;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw Error('提交序号必须仅使用递增数字规则（9位），请管理员核对');
  return Number(value);
}
export function decodeRecords(records, fields) {
  const actions = [], orders = new Set();
  for (const r of records) {
    let serverOrder;
    if (fields.serverOrder) {
      serverOrder = serverOrderValue(r.fields[fields.serverOrder]);
      if (orders.has(serverOrder)) throw Error('服务器提交序号重复，已停止读写，请管理员核对');
      orders.add(serverOrder);
    }
    const body = cellString(r.fields[fields.payload]), key = cellString(r.fields[fields.id]);
    if (!body && !key && SCHEMA.every(([k]) => !cellString(r.fields[fields[k]]))) continue; // Feishu creates blank rows in a new table.
    if (!body || !key) throw Error('共享表有不完整记录，请核对表格；未使用残缺数据');
    let a;
    try { a = validateAction(JSON.parse(body)); } catch { throw Error('共享表有无法解析的记录，请核对表格；未使用残缺数据'); }
    if (a.id !== key) throw Error('操作ID与完整内容不匹配');
    const columns = actionColumns(a);
    for (const [k] of SCHEMA) if (k !== 'payload' && cellString(r.fields[fields[k]]) !== String(columns[k])) throw Error('共享表「' + SCHEMA.find(f => f[0] === k)[1] + '」与完整内容不匹配，请通过看板修改');
    if (fields.serverOrder) {
      a.serverOrder = serverOrder;
    } else if (a.v >= 2) throw Error('当前记录需要提交序号字段，请管理员升级现有共享表');
    actions.push(a);
  }
  // Count every physical row, including default blank rows and duplicate requests.
  // A missing lower receipt may be a delayed read or a permission filter, not a deletion.
  if (fields.serverOrder && orders.size !== Math.max(0, ...orders)) throw Error('服务器提交序号存在缺口，尚不能确认完整记录；请刷新，持续缺口由管理员核对，不能直接跳过');
  project(actions); // Duplicate IDs with different content must fail before returning data.
  return actions;
}
export function createFeishuStore(sdk) {
  const { bitable, FieldType, PermissionEntity, OperationType, HostContainerSize } = sdk;
  let table, fields, baseId, actor;
  const business = createBusinessStore(sdk);
  const members = createMemberStore(sdk);
  const catalog = createCatalogStore(sdk);
  const store = {
    listCatalog: () => catalog.list(),
    openCatalog: key => catalog.open(key),
    listMembers: () => members.list(),
    chooseMember: () => members.choose(),
    openMembers: () => members.open(),
    mode: 'feishu', editable: false, scope: '', actor: '', orderReady: false,
    async expand() { const ok = await bitable.ui.setHostContainerSize(HostContainerSize.Large); if (!ok) throw Error('飞书未允许扩大此插件容器，请使用卡片布局'); },
    async syncBusiness(at) {
      for (let i = 0; i < 3; i++) {
        const board = project(await store.read()), revision = boardRevision(board);
        await business.sync(board, at);
        const current = project(await store.read());
        if (revision === boardRevision(current)) {
          await business.sync(current, at);
          if (revision === boardRevision(project(await store.read()))) return;
        }
      }
      throw Error('团队正在更新，业务表将在下次刷新继续整理');
    },
    async openBusiness(key) { await business.open(key); },
    async connect() {
      const selection = await bitable.base.getSelection();
      if (!selection.baseId) throw Error('未获得飞书多维表格身份，请在多维表格插件中打开');
      baseId = selection.baseId;
      actor = await bitable.bridge.getBaseUserId();
      if (!actor) throw Error('无法识别当前飞书用户');
      store.actor = actor; store.scope = baseId + ':' + actor;
      const tables = await bitable.base.getTableMetaList(), matches = tables.filter(t => t.name === TABLE_NAME);
      if (matches.length > 1) throw Error('存在重名共享表，请先核对，不自动选择');
      if (!matches.length) return { needsSetup: true };
      table = await bitable.base.getTableById(matches[0].id);
      await store.checkSchema();
      return { needsSetup: !store.orderReady, upgrade: !store.orderReady };
    },
    async checkSchema() {
      const meta = await table.getFieldMetaList();
      fields = {};
      for (const [key, name, type] of SCHEMA) {
        const found = meta.filter(f => f.name === name);
        if (found.length !== 1 || found[0].type !== FieldType[type]) throw Error('共享表缺少或误改字段「' + name + '」。请由表格管理员恢复');
        fields[key] = found[0].id;
      }
      const order = meta.filter(f => f.name === ORDER_FIELD);
      if (order.length > 1 || order.length === 1 && order[0].type !== FieldType.AutoNumber) throw Error('提交序号字段必须是飞书自动编号，请管理员核对');
      if (order.length) fields.serverOrder = order[0].id;
      store.orderReady = order.length === 1;
      store.editable = store.orderReady && await bitable.base.getPermission({ entity: PermissionEntity.Record, param: { tableId: table.id }, type: OperationType.Addable });
    },
    async initialize() {
      // Called only by the explicit setup button. Never run schema writes on page load.
      const tables = await bitable.base.getTableMetaList();
      const matches = tables.filter(t => t.name === TABLE_NAME);
      if (matches.length > 1) throw Error('存在重名共享表，请先核对');
      if (matches.length) table = await bitable.base.getTableById(matches[0].id);
      else {
        const created = await bitable.base.addTable({ name: TABLE_NAME });
        table = await bitable.base.getTableById(created.tableId);
      }
      const meta = await table.getFieldMetaList();
      for (const [, name, type] of SCHEMA) {
        const found = meta.find(f => f.name === name);
        if (found && found.type !== FieldType[type]) throw Error('已有字段「' + name + '」类型不符，保留原表等待核对');
        if (matches.length && !found) throw Error('已有共享表字段缺失，请管理员核对；升级只补充提交序号，不重建字段');
        if (!found) await table.addField({ name, type: FieldType[type], description: { content: name === '完整内容' ? '看板用于恢复完整计划和历史的原始记录，请通过看板登记，不直接修改。' : '由内容发布看板自动填写，请通过看板登记。' } });
      }
      const order = meta.find(f => f.name === ORDER_FIELD);
      if (order && order.type !== FieldType.AutoNumber) throw Error('已有提交序号字段类型不符，保留原表等待管理员核对');
      if (!order) throw Error('请管理员在现有共享表添加「提交序号」自动编号：仅递增数字规则（9位），从1开始，然后重新连接；当前SDK不能配置编号规则，不会自动创建');
      await store.checkSchema();
    },
    async read() {
      if (!table) throw Error('尚未接入共享表');
      await store.checkSchema();
      // Two identical complete reads prevent reporting a partial snapshot during pagination.
      let previous;
      for (let attempt = 0; attempt < 3; attempt++) {
        const records = await readPages(table, fields), actions = decodeRecords(records, fields);
        const receipts = fields.serverOrder ? records.map(r => serverOrderValue(r.fields[fields.serverOrder])).sort((a, b) => a - b) : [];
        const signature = JSON.stringify({ actions: [...actions].sort((a, b) => a.id.localeCompare(b.id)), receipts });
        if (signature === previous) { store.receiptEnd = Math.max(0, ...receipts); return actions; }
        previous = signature;
      }
      throw Error('团队正在连续更新，暂未读到稳定快照，请稍后刷新');
    },
    async append(raw) {
      const action = validateAction(raw);
      await store.checkSchema();
      if (!store.editable) throw Error('当前飞书账号没有添加记录权限');
      const columns = actionColumns(action), cells = {};
      for (const [key, , type] of SCHEMA) cells[fields[key]] = type === 'Text' ? [{ type: 'text', text: String(columns[key]) }] : columns[key];
      await table.addRecord({ fields: cells });
    },
    subscribe(callback) {
      const offs = [table.onRecordAdd(callback), table.onRecordModify(callback), table.onRecordDelete(callback), table.onFieldModify(callback), table.onFieldDelete(callback)];
      return () => offs.forEach(off => off());
    },
    get tableId() { return table?.id; }
  };
  return store;
}
export function createDemoStore(storage) {
  const key = 'tiktok-board-explicit-demo-v2';
  return { mode: 'demo', scope: 'demo-v2', actor: 'demo', editable: true,
    async read() { const saved = storage.getItem(key); return saved ? JSON.parse(saved) : []; },
    async append(a) { const all = await this.read(); all.push({ ...validateAction(a), serverOrder: Math.max(0, ...all.map(a => a.serverOrder ?? 0)) + 1 }); project(all); storage.setItem(key, JSON.stringify(all)); },
    subscribe() { return () => {}; }
  };
}
export class Controller {
  constructor(store, storage, onChange = () => {}) {
    this.store = store; this.storage = storage; this.onChange = onChange;
    this.board = project([]); this.ready = false; this.busy = false; this.reading = null; this.error = ''; this.lastSync = null;
    this.pendingKey = 'tiktok-board-pending:' + store.scope;
    this.pendingPrefix = this.pendingKey + ':op:';
    this.pendingEntries();
  }
  pendingEntries() {
    const entries = new Map(), legacy = this.storage.getItem(this.pendingKey);
    if (legacy) {
      const action = validateAction(JSON.parse(legacy)), key = this.pendingPrefix + action.id;
      if (!this.storage.getItem(key)) this.storage.setItem(key, JSON.stringify({ action, restore: false, submitted: true }));
    }
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i); if (!key?.startsWith(this.pendingPrefix)) continue;
      const entry = JSON.parse(this.storage.getItem(key)), action = validateAction(entry.action);
      if (key !== this.pendingPrefix + action.id) throw Error('待确认队列标识不匹配，请保留本地记录等待核对');
      entries.set(action.id, { action, restore: entry.restore === true, submitted: entry.submitted !== false, ...(entry.restoreJobKey ? { restoreJobKey: entry.restoreJobKey } : {}) });
    }
    if (legacy) {
      const action = validateAction(JSON.parse(legacy)), entry = entries.get(action.id);
      if (!entry || actionIdentity(entry.action) !== actionIdentity(action)) throw Error('旧待确认请求与恢复队列冲突，请保留记录等待核对');
    }
    return [...entries.values()].sort((a, b) => Number(b.action.kind === 'stop') - Number(a.action.kind === 'stop') || a.action.at.localeCompare(b.action.at) || a.action.id.localeCompare(b.action.id));
  }
  get pending() { return this.pendingEntries()[0]?.action ?? null; }
  pendingEntry(id) { return this.pendingEntries().find(e => e.action.id === id); }
  get receiptEnd() { return this.store.receiptEnd ?? Math.max(0, ...this.board.actions.map(a => a.serverOrder ?? 0)); }
  savePending(entry) { this.storage.setItem(this.pendingPrefix + entry.action.id, JSON.stringify(entry)); }
  async refresh() {
    if (this.reading) return this.reading;
    this.reading = (async () => {
      try {
        const actions = await this.store.read(), next = project(actions);
        const currentById = new Map(next.actions.map(a => [a.id, a]));
        const priorOrder = Math.max(0, ...this.board.actions.map(a => a.serverOrder ?? 0));
        for (const a of actions) if (!this.board.actions.some(old => old.id === a.id) && a.serverOrder !== undefined && a.serverOrder <= priorOrder) throw Error('出现回退的服务器提交序号，已保留上次结果并暂停写入，请管理员核对自动编号');
        for (const prior of this.board.actions) {
          const current = currentById.get(prior.id);
          if (!current || actionIdentity(current) !== actionIdentity(prior) || current.serverOrder !== prior.serverOrder) throw Error('共享记录或服务器编号被直接修改或删除，已暂停写入，请由管理员核对备份');
        }
        for (const prior of this.board.accepted) if (!next.accepted.has(prior)) throw Error('迟到记录改变了已生效事件，已保留上次结果并暂停写入，请管理员核对服务器编号');
        this.board = next; this.ready = true; this.error = ''; this.lastSync = new Date();
        // Background refresh must not unlock a still-open form after an ambiguous save.
        // Only send/retry acknowledges and clears the pending request.
      } catch (e) { this.error = e.message; this.ready = false; throw e; }
      finally { this.onChange(); }
    })();
    try { return await this.reading; } finally { this.reading = null; }
  }
  clearPending(id) {
    this.storage.removeItem(this.pendingPrefix + id);
    const legacy = this.storage.getItem(this.pendingKey);
    if (legacy && validateAction(JSON.parse(legacy)).id === id) this.storage.removeItem(this.pendingKey);
  }
  async stopPending(id = this.pending?.id) {
    const entry = this.pendingEntry(id);
    if (!entry) return null;
    const target = entry.action.kind === 'stop' ? entry.action.payload.target : entry.action.id;
    const previous = this.pendingEntries().find(e => e.action.kind === 'stop' && e.action.payload.target === target);
    const original = this.pendingEntry(target)?.action;
    const action = previous?.action ?? makeAction(this.board, 'stop', original.date, { target }, original.actor);
    await this.send(action);
    if (this.board.accepted.has(this.board.restored.get(target))) return 'restored';
    return this.board.accepted.has(target) ? 'saved' : 'stopped';
  }
  async send(raw, { restore = false, restoreJobKey } = {}) {
    if (this.busy) throw Error('正在保存，请稍等');
    const priorPending = this.pendingEntry(raw.id);
    if (priorPending && actionIdentity(priorPending.action) !== actionIdentity(raw)) throw Error('待确认请求内容不能改变');
    const stopping = raw.kind === 'stop' && this.pendingEntry(raw.payload.target)?.action.actor === raw.actor;
    if (!priorPending && this.pending && !stopping) throw Error('上次保存结果未确认，请先点「核对上次保存」');
    if (priorPending) { restore = priorPending.restore; restoreJobKey = priorPending.restoreJobKey; }
    this.busy = true; this.onChange();
    try {
      await this.refresh();
      let action = validateAction(raw);
      const existing = this.board.actions.find(a => a.id === action.id);
      if (existing && actionIdentity(existing) !== actionIdentity(action)) throw Error('操作ID已存在且内容不同，保存已停止');
      if (!priorPending && !existing && !restore) action = validateAction({ ...action, seq: this.board.seq + 1 });
      if (!this.board.actions.some(a => a.id === action.id)) {
        if (restoreJobKey) {
          const job = JSON.parse(this.storage.getItem(restoreJobKey));
          if (!job || job.jobId !== action.restore?.jobId) throw Error('恢复任务信息缺失，停止重试后核对本地备份');
          importPreview(this.board, job);
        }
        const proposed = project([...this.board.actions, action.restore ? { ...action, serverOrder: this.receiptEnd + 1 } : action]);
        if (proposed.restoreFailures.has(action.id)) throw Error('恢复前置服务器序号已变化，任务暂停；可停止重试并放弃剩余导入');
        if (!restore && !proposed.accepted.has(action.id)) throw Error(proposed.conflicts.find(c => c.id === action.id)?.reason ?? '当前记录已变化');
        // Save the stable operation ID before the network request; retry uses the same ID.
        this.savePending({ action, restore, submitted: true, ...(restoreJobKey ? { restoreJobKey } : {}) });
        await this.store.append(action);
        await this.refresh();
      } else if (this.pendingEntry(action.id)) this.clearPending(action.id);
      if (this.pendingEntry(action.id) && this.board.actions.some(a => a.id === action.id)) this.clearPending(action.id);
      if (this.board.restoreFailures.has(action.id)) throw Error('恢复期间出现其他服务器记录，此请求未生效；任务已暂停，请核对后放弃剩余导入');
      if (action.restore && !action.restore.auditOnly && !this.board.accepted.has(action.id)) throw Error(this.board.conflicts.find(c => c.id === action.id)?.reason ?? '恢复未生效，任务暂停');
      if (!restore && !this.board.accepted.has(action.id)) throw Error(this.board.conflicts.find(c => c.id === action.id)?.reason ?? '保存未生效');
      if (action.kind === 'stop' && this.board.accepted.has(action.id)) this.clearPending(action.payload.target);
      return true;
    } catch (e) {
      if (this.pendingEntry(raw.id)) {
        const pendingId = raw.id;
        try {
          await this.refresh();
          if (this.board.actions.some(a => a.id === pendingId)) {
            this.clearPending(pendingId);
            if (this.board.restoreFailures.has(pendingId) || raw.restore && !raw.restore.auditOnly && !this.board.accepted.has(pendingId)) throw Error('恢复请求未生效，任务已暂停');
            if (this.board.accepted.has(pendingId) || restore) {
              if (raw.kind === 'stop' && this.board.accepted.has(pendingId)) this.clearPending(raw.payload.target);
              return true;
            }
          }
        } catch { /* Keep pending until a complete read succeeds. */ }
      }
      throw e;
    } finally { this.busy = false; this.onChange(); }
  }
}
