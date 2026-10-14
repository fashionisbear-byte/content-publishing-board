import { publicationProduct, cycleProductRows, originalCycleProduct, dayProducts, dayAt, planAt, executionDates, cycleDays, cycleSummary, accountCycleSummary, cycleAccounts, stats, counts, people, effectivePublication, delegatedPublication, hasRegistration, today } from './model.js';

const field = (key, name, type = 'Text', extra = {}) => ({ key, name, type, ...extra });
const technical = [field('key', '汇总键', 'Text', { hidden: true }), field('revision', '数据版本', 'Text', { hidden: true }), field('syncState', '汇总状态', 'Text', { hidden: true })];
const identity = [field('shop', '店铺'), field('ownerId', '负责人', 'User'), field('product', '产品')];
const cycleIdentity = [field('cycleName', '周期名称'), field('cycleStart', '周期开始', 'DateTime'), field('cycleEnd', '周期结束', 'DateTime')];
export const BUSINESS_TABLES = [
  { key: 'cycles', name: '计划进度', fields: [field('name','计划名称'), ...cycleIdentity, field('state','计划状态','SingleSelect',{options:['未开始','执行中','已结束','待设置周期']}), field('days','周期天数','Number'), field('targetVideo','周期视频目标','Number'), field('targetPhoto','周期图文目标','Number'),field('total','周期总目标','Number'),field('video','已发视频','Number'),field('photo','已发图文','Number'),field('missingVideo','还缺视频','Number'),field('missingPhoto','还缺图文','Number'),field('progress','完成率','Number',{progress:true}),...technical] },
  { key: 'plans', name: '发布计划', fields: [field('name', '账号名称'), field('date', '周期开始', 'DateTime'), field('cycleName', '周期名称'), field('cycleEnd', '周期结束', 'DateTime'), field('cycleLength', '周期天数', 'Number'), field('cycleState', '周期状态'), ...identity, field('targetVideo', '周期视频目标', 'Number'), field('targetPhoto', '周期图文目标', 'Number'), field('total', '周期总目标', 'Number'),field('video','已发视频','Number'),field('photo','已发图文','Number'),field('missingVideo','还缺视频','Number'),field('missingPhoto','还缺图文','Number'),field('progress','完成率','Number',{progress:true}),field('completion','完成状态','SingleSelect',{options:['未达标','已达标','无任务']}), field('status', '方案状态', 'SingleSelect', { options: ['当前版本', '历史版本'] }), field('note', '备注'), ...technical] },
  { key: 'daily', name: '每日进度', fields: [field('title', '日期 / 账号'), field('date', '执行日期', 'DateTime'), ...cycleIdentity, field('registration', '登记情况'), field('name', '账号名称'), ...identity, field('video', '已发视频', 'Number'), field('targetVideo', '视频目标', 'Number'), field('photo', '已发图文', 'Number'), field('targetPhoto', '图文目标', 'Number'), field('missingVideo', '还缺视频', 'Number'), field('missingPhoto', '还缺图文', 'Number'), field('progress', '完成率', 'Number', { progress: true }), field('status', '完成状态', 'SingleSelect', { options: ['未达标', '已达标', '无任务'] }), field('contribution', '实际贡献'), field('note', '当天备注'), ...technical] },
  { key: 'entries', name: '发布明细', fields: [field('title', '发布记录'), field('date', '执行日期', 'DateTime'), ...cycleIdentity, field('name', '账号名称'), ...identity, field('video', '有效视频', 'Number'), field('photo', '有效图文', 'Number'), field('status', '登记状态', 'SingleSelect', { options: ['正常', '已更正', '已撤销'] }), field('at', '登记时间', 'DateTime', { time: true }), field('note', '登记备注'), field('originalVideo', '原登记视频', 'Number'), field('originalPhoto', '原登记图文', 'Number'), ...technical] }
];
export function cliFields(def) {
  return def.fields.map(f => ({ name: f.name, type: { Text: 'text', Number: 'number', DateTime: 'datetime', SingleSelect: 'select', User: 'user' }[f.type], description: '由内容发布看板自动整理，请在看板中登记和修改。', ...(f.type === 'User' ? { multiple: false } : {}), ...(f.type === 'Number' ? { style: f.progress ? { type: 'progress', percentage: true, color: 'Green' } : { type: 'plain', precision: 0, percentage: false, thousands_separator: false } } : {}), ...(f.type === 'DateTime' ? { style: { format: f.time ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd' } } : {}), ...(f.options ? { multiple: false, options: f.options.map(name => ({ name, hue: /已达标|正常|当前版本/.test(name) ? 'Green' : /撤销|历史/.test(name) ? 'Gray' : 'Orange' })) } : {}) }));
}
export function boardRevision(board) {
  let h1 = 2166136261, h2 = 5381;
  for (const a of board.actions) for (const c of a.id + ':' + a.seq + ':' + Number(board.accepted.has(a.id)) + ';') { h1 = Math.imul(h1 ^ c.charCodeAt(0), 16777619); h2 = Math.imul(h2, 33) ^ c.charCodeAt(0); }
  return board.actions.length + ':' + (h1 >>> 0).toString(16) + ':' + (h2 >>> 0).toString(16);
}
export function businessRows(board, at = today()) {
  const revision = boardRevision(board), stamp = r => ({ ...r, revision, syncState: '有效' }), timestamp = d => Date.parse(d + 'T00:00:00+08:00');
  const cycle = p => ({ cycleName: p?.payload.title || (p?.payload.endDate ? p.date + ' — ' + p.payload.endDate : ''), cycleStart: p ? timestamp(p.date) : null, cycleEnd: p?.payload.endDate ? timestamp(p.payload.endDate) : null });
  const cycles=[...board.plans.values()].map(p=>{const s=cycleSummary(board,p);return stamp({key:'cycle/'+p.date,name:p.payload.title||'周期计划',...cycle(p),state:!s?'待设置周期':at<p.date?'未开始':at>p.payload.endDate?'已结束':'执行中',days:s?.days??0,targetVideo:s?.targetVideo??0,targetPhoto:s?.targetPhoto??0,total:s?.target??0,video:s?.video??0,photo:s?.photo??0,missingVideo:s?.missingVideo??0,missingPhoto:s?.missingPhoto??0,progress:s?.target?s.pct/100:0});});
  const plans = board.actions.filter(a => a.kind === 'plan' && board.accepted.has(a.id)).flatMap(a => (board.plans.get(a.date)?.id===a.id?cycleAccounts(board,a):a.payload.accounts).filter(r=>!board.deletedPlanKeys.has(a.id+'/'+r.id)).map(r => {
    const s=accountCycleSummary(board,a,r);
    return stamp({ key:a.id+'/'+r.id,date:timestamp(a.date),...r,...cycle(a),cycleLength:s?.days??0,cycleState:board.plans.get(a.date)?.id!==a.id?'已替换':!a.payload.endDate?'待设置周期':at<a.date?'未开始':at>a.payload.endDate?'已结束':'执行中',targetVideo:s?.targetVideo??0,targetPhoto:s?.targetPhoto??0,total:s?.target??0,video:s?.video??0,photo:s?.photo??0,missingVideo:s?.missingVideo??0,missingPhoto:s?.missingPhoto??0,progress:s?.target?s.pct/100:0,completion:!s?.target?'无任务':s.missingVideo+s.missingPhoto===0?'已达标':'未达标',status:board.plans.get(a.date)?.id===a.id?'当前版本':'历史版本', note:[r.note,'周期原定产品：'+(originalCycleProduct(board,a,r.id).product||'归属未确定'),...cycleProductRows(board,a,r.id).map(p=>(p.product||'归属未确定')+' 视频'+p.video+' / 图文'+p.photo)].filter(Boolean).join('；')});
  }));
  const dates = new Set(executionDates(board, at));
  const daily = [...dates].sort().flatMap(d => dayAt(board, d).map(r => {
    const s = stats([r]), c = counts(r);
    return stamp({ key: d + '/' + r.id, title: d + ' · ' + r.name, date: timestamp(d), ...cycle(planAt(board, d).plan), registration: hasRegistration(board,d,r.id) ? '已登记' : '未登记', name: r.name, shop: r.shop, ownerId: r.ownerId ?? '', product: r.product, video: c.video, photo: c.photo, targetVideo: r.video, targetPhoto: r.photo, missingVideo: s.missingVideo, missingPhoto: s.missingPhoto, progress: s.target ? s.pct / 100 : 0, status: !s.active ? '无任务' : s.complete ? '已达标' : '未达标', contribution: people([r]).map(p => p.person + ' 视频' + p.video + ' / 图文' + p.photo).join('；'), note: [r.note,board.productDays.has(d+'/'+r.id)?'当天产品安排：'+(dayProducts(board,d,r.id).map(p=>p.product||'未确定').join('、')||'暂无'):''].filter(Boolean).join('；') });
  }));
  const entries = [...board.publications.values()].filter(e=>!board.deletedEntries.has(e.id)).map(e => {
    const c = effectivePublication(board, e), r = c.account, voided = board.voids.has(e.id);
    const corrections = board.actions.filter(a => board.accepted.has(a.id) && ['reduce', 'void'].includes(a.kind) && a.payload.target === e.id).map(a => a.kind === 'void' ? '撤销：' + a.payload.reason : (a.payload.content === 'video' ? '视频' : '图文') + '减1：' + a.payload.reason);
    return stamp({ key: e.id, title: e.date + ' · ' + (r?.name ?? e.accountId), date: timestamp(e.date), ...cycle(e.cycle ?? planAt(board, e.date).plan), name: r?.name ?? e.accountId, shop: r?.shop ?? '', ownerId: r?.ownerId ?? '', product: publicationProduct(board,e).product || '归属未确定', video: voided ? 0 : c.video, photo: voided ? 0 : c.photo, originalVideo: e.video, originalPhoto: e.photo, status: voided ? '已撤销' : board.reductions.has(e.id) || board.edits.has(e.id) ? '已更正' : '正常', at: Date.parse(e.at), note: [!r?'历史安排缺失，未回填当前计划':'',delegatedPublication(c) ? `代做：${c.person} · 视频${voided ? 0 : c.video} / 图文${voided ? 0 : c.photo}` : '', c.note, ...corrections].filter(Boolean).join('；') });
  });
  if ([cycles, plans, daily, entries].some(rows => rows.length > 20000)) throw Error('周期业务表超过20,000行，已暂停整理；请缩短周期或减少账号，原始登记保留');
  return { cycles, plans, daily, entries };
}

const string = v => Array.isArray(v) ? v.map(s => s.text ?? '').join('') : String(v ?? '');
async function allRecords(table) {
  const result = [], tokens = new Set(); let pageToken;
  for (let i = 0; i < 101; i++) {
    const p = await table.getRecordsByPage({ pageSize: 200, stringValue: false, ...(pageToken !== undefined ? { pageToken } : {}) });
    if (!Array.isArray(p.records)) throw Error('业务表分页无效'); result.push(...p.records);
    if (result.length > 20000) throw Error('业务表超过20,000条，暂不自动整理');
    if (!p.hasMore) return result;
    if (!p.records.length || p.pageToken == null || tokens.has(p.pageToken)) throw Error('业务表分页不完整'); tokens.add(p.pageToken); pageToken = p.pageToken;
  }
  throw Error('业务表分页超限');
}
export function createBusinessStore(sdk) {
  const { bitable, FieldType } = sdk;
  let tables = null;
  async function connect() {
    const meta = await bitable.base.getTableMetaList(), next = {};
    for (const def of BUSINESS_TABLES) {
      const matches = meta.filter(t => t.name === def.name);
      if (matches.length !== 1) throw Error('请管理员先配置「' + def.name + '」业务表');
      const table = await bitable.base.getTableById(matches[0].id), fields = {}, fm = await table.getFieldMetaList();
      for (const f of def.fields) {
        const m = fm.filter(m => m.name === f.name);
        if (m.length !== 1 || (m[0].type !== FieldType[f.type] && !(f.progress && m[0].type === FieldType.Progress))) throw Error('业务表「' + def.name + '」字段「' + f.name + '」需要管理员核对');
        fields[f.key] = { ...f, id: m[0].id, options: m[0].property?.options ?? [] };
      }
      next[def.key] = { table, fields, def };
    }
    tables = next;
  }
  function cells(row, fields) {
    return Object.fromEntries(Object.entries(fields).map(([key, f]) => {
      let value = row[key] ?? '';
      if (f.type === 'Text') value = [{ type: 'text', text: String(value) }];
      if (f.type === 'User') value = value ? [{ id: value }] : null;
      if (f.type === 'DateTime' && value === '') value = null;
      if (f.type === 'SingleSelect') { const option = f.options.find(o => o.name === value); if (!option) throw Error('业务表缺少状态选项「' + value + '」'); value = { id: option.id, text: option.name }; }
      return [f.id, value];
    }));
  }
  function equal(record, row, fields) {
    return Object.entries(fields).every(([key, f]) => {
      const actual = record.fields[f.id], value = row[key] ?? '';
      if (f.type === 'Text') return string(actual) === String(value);
      if (f.type === 'User') return value ? Array.isArray(actual) && actual.length === 1 && actual[0].id === value : actual == null || Array.isArray(actual) && actual.length === 0;
      if (f.type === 'DateTime' && value === '') return actual == null || actual === '';
      if (f.type === 'SingleSelect') return actual != null && typeof actual === 'object' && actual.id === f.options.find(o => o.name === value)?.id;
      return actual === value;
    });
  }
  async function upsert(info, rows, deletedKeys) {
    const { table, fields } = info, current = await allRecords(table), byKey = new Map(), desired = new Map(rows.map(r => [r.key, r]));
    for (const r of current.sort((a, b) => a.recordId.localeCompare(b.recordId))) {
      const key = string(r.fields[fields.key.id]);
      if (!key) continue;
      const list = byKey.get(key) ?? []; list.push(r); byKey.set(key, list);
    }
    const adds = [], updates = [], deletes=[];
    for (const row of rows) {
      const old = byKey.get(row.key)?.[0];
      if (!old) adds.push({ fields: cells(row, fields) });
      else if (!equal(old, row, fields)) updates.push({ recordId: old.recordId, fields: cells(row, fields) });
    }
    // Keep duplicate / obsolete summaries as recoverable rows; never delete user records.
    for (const [key, list] of byKey) for (let i = desired.has(key) ? 1 : 0; i < list.length; i++) {
      if(deletedKeys.has(key)&&!desired.has(key)){
        deletes.push(list[i].recordId);
        const patch={[fields.syncState.id]:[{type:'text',text:'已删除待清理'}]};
        for(const name of ['video','photo','targetVideo','targetPhoto','missingVideo','missingPhoto','progress','total'])if(fields[name])patch[fields[name].id]=0;
        if(Object.entries(patch).some(([id,value])=>JSON.stringify(list[i].fields[id])!==JSON.stringify(value)))updates.push({recordId:list[i].recordId,fields:patch});
        continue;
      }
      const status = desired.has(key) ? '重复汇总' : '已归档';
      if (string(list[i].fields[fields.syncState.id]) !== status) updates.push({ recordId: list[i].recordId, fields: { [fields.syncState.id]: [{ type: 'text', text: status }] } });
    }
    for (let i = 0; i < adds.length; i += 200) await table.addRecords(adds.slice(i, i + 200));
    for (let i = 0; i < updates.length; i += 200) await table.setRecords(updates.slice(i, i + 200));
    if(deletes.length){
      if(bitable.base.getPermission && sdk.PermissionEntity && sdk.OperationType){for(const recordId of deletes)if(!await bitable.base.getPermission({entity:sdk.PermissionEntity.Record,param:{tableId:table.id,recordId},type:sdk.OperationType.Deletable}))throw Error('错误记录已停止计数，但没有删除「'+info.def.name+'」记录的权限，请管理员删除或授予权限后刷新');}
      for(let i=0;i<deletes.length;i+=200)if(await table.deleteRecords(deletes.slice(i,i+200))!==true)throw Error('飞书删除尚未确认，请刷新核对；错误记录不会重新计数');
    }
    return adds.length + updates.length + deletes.length;
  }
  return {
    async sync(board, at) { if (!tables) await connect(); const rows = businessRows(board, at),deleted={cycles:new Set([...board.cancelledPlans.keys()].map(date=>'cycle/'+date)),plans:board.deletedPlanKeys,daily:board.deletedDailyKeys,entries:board.deletedEntries}; let changed = 0; for (const def of BUSINESS_TABLES) changed += await upsert(tables[def.key], rows[def.key],deleted[def.key]); return changed; },
    async open(key) { if (!tables) await connect(); await bitable.ui.switchToTable(tables[key].table.id); },
    invalidate() { tables = null; }
  };
}
