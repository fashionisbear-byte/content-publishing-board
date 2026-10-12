export const FORMAT = 'tiktok-board-feishu-v1';
export const clone = v => structuredClone(v);
export function today(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '2000-01-01' || v > '2100-12-31') return false;
  const d = new Date(v + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function addDays(date, count) {
  if (!validDate(date) || !Number.isInteger(count)) throw Error('周期日期无效');
  return new Date(Date.parse(date + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10);
}
export function cycleDays(from, until) {
  if (!validDate(from) || !validDate(until) || until < from) throw Error('结束日期不能早于开始日期');
  const days = Math.round((Date.parse(until + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000) + 1;
  if (days > 366) throw Error('一个周期最多366天，请拆分计划');
  return days;
}
function text(v, label, max = 80, optional = false) {
  if (typeof v !== 'string' || v.length > max || (!optional && !v.trim())) throw Error(label + '不能为空且最多' + max + '字');
  return v.trim();
}
function integer(v, label, max = 1000000) {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) throw Error(label + '须为0至' + max + '的整数');
  return v;
}
function id(v) {
  if (typeof v !== 'string' || !/^[\w:/.-]{1,180}$/.test(v)) throw Error('记录标识无效');
  return v;
}
export function config(raw) {
  if (!Array.isArray(raw) || raw.length > 100) throw Error('最多支持100个账号');
  const seen = new Set(), catalogIds = new Set();
  return raw.map(r => {
    const key = id(r.id);
    if (key.length > 80) throw Error('账号标识过长');
    if (seen.has(key)) throw Error('账号标识重复');
    seen.add(key);
    if (r.accountRef) { if (catalogIds.has(r.accountRef)) throw Error('同一账号不能重复加入计划'); catalogIds.add(r.accountRef); }
    const refs = Object.fromEntries(['accountRef','shopRef','productRef'].filter(k => r[k]).map(k => [k,id(r[k])]));
    return { id: key, ...refs, name: text(r.name, '账号名称'), shop: text(r.shop ?? '', '店铺', 80, true), owner: text(r.owner, '负责人'), ...(r.ownerId ? { ownerId: id(r.ownerId) } : {}), product: text(r.product ?? '', '产品', 80, true), video: integer(r.video, '视频目标', 10000), photo: integer(r.photo, '图文目标', 10000), note: text(r.note ?? '', '备注', 2000, true) };
  });
}
function execution(e) {
  return { person: text(e.person, '实际完成人'), ...(e.personId == null ? {} : { personId: id(e.personId) }), video: integer(e.video, '视频数量'), photo: integer(e.photo, '图文数量'), note: text(e.note ?? '', '登记备注', 2000, true) };
}
export const personKey = e => e.personId ? 'member:' + e.personId : 'name:' + e.person;
export function validateAction(raw) {
  if (!raw || ![1, 2, 3, 4, 5, 6, 7].includes(raw.v) || !['protocol', 'plan', 'publish', 'batch', 'day', 'void', 'seed', 'reduce', 'stop', 'delete', 'edit'].includes(raw.kind)) throw Error('共享记录格式或版本无效，请刷新到新版看板');
  const a = { v: raw.v, id: id(raw.id), seq: integer(raw.seq, '顺序', Number.MAX_SAFE_INTEGER), at: text(raw.at, '登记时间', 40), actor: text(raw.actor, '操作者', 180), kind: raw.kind, date: raw.date };
  if (a.id.length > 80) throw Error('操作标识过长');
  if (a.seq < 1 || !validDate(a.date) || !Number.isFinite(Date.parse(a.at))) throw Error('记录日期或顺序无效');
  const p = raw.payload;
  if (!p || typeof p !== 'object') throw Error('记录内容缺失');
  if(a.kind==='protocol'){if(a.v!==7||p.minimumVersion!==7)throw Error('版本启用记录无效');a.payload={minimumVersion:7};}
  if (a.kind === 'plan') {
    a.payload = { accounts: config(p.accounts), expected: p.expected === null ? null : id(p.expected) };
    if (a.v >= 7) {
      if (!p.endDate) throw Error('请填写计划的开始日期和结束日期');
      cycleDays(a.date,p.endDate);
      const effectiveDate = p.effectiveDate ?? p.applyDate ?? a.date;
      if (!validDate(effectiveDate) || effectiveDate < a.date || effectiveDate > p.endDate) throw Error('计划生效日期不在周期内');
      a.payload.effectiveDate = effectiveDate;
    }
    if(p.cleanupRemoved!=null){if(a.v<4||typeof p.cleanupRemoved!=='boolean')throw Error('账号删除标记无效');a.payload.cleanupRemoved=p.cleanupRemoved;}
    if (p.endDate != null) {
      cycleDays(a.date, p.endDate);
      a.payload.endDate = p.endDate;
      a.payload.title = text(p.title ?? '', '周期名称', 80, true);
    } else if (a.v >= 3 && !raw.restore) throw Error('请填写计划的开始日期和结束日期');
    if (p.applyDate != null) {
      if (a.v < 4 || !validDate(p.applyDate) || p.applyDate < a.date || p.applyDate > p.endDate && (!Array.isArray(p.applyAccounts)||p.applyAccounts.length!==0)) throw Error('当天同步日期不在计划周期内');
      a.payload.applyDate = p.applyDate;
      a.payload.applyHeads = validateHeads(p.applyHeads);
      if(p.applyAccounts){const applied=config(p.applyAccounts);if(p.applyDate<=p.endDate&&(a.v<5&&applied.length!==a.payload.accounts.length||applied.some(r=>!a.payload.accounts.some(x=>x.id===r.id))))throw Error('同步当天的账号与周期计划不符');a.payload.applyAccounts=applied;}
    }
  }
  if (a.kind === 'publish' || a.kind === 'day') {
    const snapshot = config(p.snapshot), accountId = id(p.accountId);
    if (!snapshot.some(r => r.id === accountId)) throw Error('登记账号不在当天计划内');
    if (a.kind === 'publish') {
      const e = execution(p);
      if (e.video + e.photo < 1) throw Error('请至少登记1条发布');
      a.payload = { snapshot, accountId, ...e };
    } else {
      const account = config([p.account])[0];
      if (account.id !== accountId) throw Error('调整账号不匹配');
      a.payload = { snapshot, accountId, account, expected: id(p.expected) };
    }
  }
  if(a.kind==='batch'){
    if(a.v<5)throw Error('请刷新新版后统一保存登记');
    if(!Array.isArray(p.changes)||!p.changes.length||p.changes.length>100)throw Error('待保存登记数量无效');
    const snapshot=config(p.snapshot),seen=new Set();
    a.payload={snapshot,expectedHeads:validateHeads(p.expectedHeads),expectedEntries:validateEntries(p.expectedEntries),changes:p.changes.map(c=>{
      const accountId=id(c.accountId);if(seen.has(accountId)||!snapshot.some(r=>r.id===accountId))throw Error('待保存账号重复或不在当天任务中');seen.add(accountId);
      for(const key of ['video','photo'])if(!Number.isSafeInteger(c[key])||Math.abs(c[key])>1000000)throw Error('待保存数量须为整数');
      if(!c.video&&!c.photo)throw Error('没有待保存数量');
      return {accountId,video:c.video,photo:c.photo,person:text(c.person,'负责人'),...(c.personId?{personId:id(c.personId)}:{})};
    })};
    if (a.v >= 7) {
      if (!Array.isArray(p.reductions) || p.reductions.length > 20000) throw Error('减少数量需要绑定原登记');
      const targets = new Set();
      a.payload.reductions = p.reductions.map(r => {
        const target = id(r.target), accountId = id(r.accountId), expected = execution(r.expected);
        if (targets.has(target)) throw Error('减少登记重复'); targets.add(target);
        return {target, accountId, expected, ...(r.expectedAccount?{expectedAccount:config([r.expectedAccount])[0]}:{}), video:integer(r.video,'减少视频'), photo:integer(r.photo,'减少图文')};
      });
      for (const c of a.payload.changes) for (const k of ['video','photo']) if (a.payload.reductions.filter(r=>r.accountId===c.accountId).reduce((s,r)=>s+r[k],0)!==Math.max(0,-c[k])) throw Error('减少登记与待保存数量不符');
      if (a.payload.reductions.some(r=>!a.payload.changes.some(c=>c.accountId===r.accountId)||!r.video&&!r.photo||r.video>r.expected.video||r.photo>r.expected.photo)) throw Error('减少登记范围无效');
    }
  }
  if (a.v >= 7 && ['publish','batch'].includes(a.kind)) a.payload.cycleId = p.cycleId == null ? null : id(p.cycleId);
  if (a.kind === 'void') a.payload = { target: id(p.target), reason: text(p.reason, '撤销原因', 500) };
  if (a.kind === 'edit') {
    if (a.v < 6) throw Error('请刷新新版后修改登记');
    const e = execution(p);
    if (e.video + e.photo < 1) throw Error('请至少保留1条发布；整次有误请删除记录');
    a.payload = { target: id(p.target), expected: execution(p.expected), ...e };
    if (a.v>=7) {
      if (p.expectedAccount) a.payload.expectedAccount=config([p.expectedAccount])[0];
      if (p.account) a.payload.account=config([p.account])[0];
    }
  }
  if (a.kind === 'delete') {
    if (a.v < 4 || !['publication','plan','day-account','restore-day-account'].includes(p.type) || a.v < 5 && p.type.includes('day-account')) throw Error('删除记录类型无效');
    a.payload = { type:p.type, target:id(p.target), reason:text(p.reason ?? '用户确认删除', '删除说明',500) };
    if (p.type === 'publication' && p.expected != null) {
      if (a.v < 6) throw Error('请刷新新版后确认删除');
      a.payload.expected = execution(p.expected);
      if(a.v>=7&&p.expectedAccount)a.payload.expectedAccount=config([p.expectedAccount])[0];
    }
    if (p.type === 'plan') {
      a.payload.expected = id(p.expected);
      if (!validDate(p.applyDate)) throw Error('删除生效日期无效');
      a.payload.applyDate = p.applyDate; a.payload.applyHeads = validateHeads(p.applyHeads);
      if(p.cascade===true){if(a.v<5)throw Error('周期清理需要刷新新版');a.payload.cascade=true;}
    }
    if(p.type.includes('day-account'))a.payload.expectedHeads=validateHeads(p.expectedHeads);
    if(p.entries!=null){if(!Array.isArray(p.entries)||p.entries.length>20000)throw Error('登记清理范围无效');a.payload.entries=[...new Set(p.entries.map(id))].sort();}
  }
  if (a.kind === 'stop') {
    if (a.v < 2 || p.target === a.id) throw Error('停止请求标识无效');
    a.payload = { target: id(p.target) };
  }
  if (a.kind === 'reduce') {
    if (!['video', 'photo'].includes(p.content)) throw Error('更正内容类型无效');
    a.payload = { target: id(p.target), content: p.content, person: text(p.person, '实际完成人'), ...(p.personId == null ? {} : { personId: id(p.personId) }), reason: text(p.reason, '更正原因', 500) };
  }
  if (a.kind === 'seed') {
    const accounts = config(p.rows);
    a.payload = { rows: accounts.map((r, i) => {
      const list = p.rows[i].executions;
      if (!Array.isArray(list) || list.length > 200) throw Error('历史登记列表无效');
      return { ...r, executions: list.map(execution).filter(e => e.video + e.photo > 0) };
    }), source: text(p.source, '导入来源', 200) };
  }
  if (raw.restore) {
    if (a.v < 2) throw Error('恢复请求必须使用新版本');
    const sourceIds = raw.restore.sourceIds ?? [raw.restore.sourceId];
    if (!Array.isArray(sourceIds) || sourceIds.length > 100) throw Error('恢复来源标识数量无效');
    const uniqueSourceIds = [...new Set([id(raw.restore.sourceId), ...sourceIds.map(id)])];
    if (uniqueSourceIds.length > 100) throw Error('恢复来源链超过本版容量，请管理员核对');
    a.restore = { jobId: id(raw.restore.jobId), sourceId: id(raw.restore.sourceId), sourceIds: uniqueSourceIds, after: integer(raw.restore.after, '恢复前置服务器序号', Number.MAX_SAFE_INTEGER), auditOnly: raw.restore.auditOnly === true, reason: text(raw.restore.reason ?? '', '恢复审计说明', 500, true) };
  }
  if (JSON.stringify(a).length > 50000) throw Error('单条共享记录超过50,000字，请减少账号或备注');
  return a;
}
export function makeAction(board, kind, date, payload, actor = 'demo', key = crypto.randomUUID()) {
  if (kind === 'batch' && payload.reductions == null) payload = batchPayload(board,date,payload.changes,payload);
  if (['batch','publish'].includes(kind) && payload.cycleId === undefined) payload = {...payload,cycleId:cycleIdentity(board,date)};
  if ((kind==='edit'||kind==='delete'&&payload.type==='publication')&&payload.expectedAccount===undefined) {
    const entry=board.publications.get(payload.target);if(entry)payload={...payload,expectedAccount:effectivePublication(board,entry).account};
  }
  return validateAction({ v: 7, id: key, seq: board.seq + 1, at: new Date().toISOString(), actor, kind, date, payload });
}
function validateHeads(raw) {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 100) throw Error('当天计划版本无效');
  const seen=new Set(); return raw.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||seen.has(pair[0]))throw Error('当天计划版本无效');seen.add(pair[0]);return [id(pair[0]),id(pair[1])];}).sort((a,b)=>a[0].localeCompare(b[0]));
}
export const dayHeads = (board,date) => board.days.has(date) ? [...board.days.get(date).heads].sort((a,b)=>a[0].localeCompare(b[0])) : null;
function validateEntries(raw){if(!Array.isArray(raw)||raw.length>20000)throw Error('当天登记版本无效');return raw.map(r=>{if(!Array.isArray(r)||r.length!==4)throw Error('当天登记版本无效');return [id(r[0]),id(r[1]),integer(r[2],'视频数量'),integer(r[3],'图文数量')];}).sort((a,b)=>a[0].localeCompare(b[0]));}
export const dayEntries=(board,date)=>[...board.publications.values()].filter(e=>e.date===date&&!board.voids.has(e.id)).map(e=>{const c=effectivePublication(board,e);return [e.id,c.accountId,c.video,c.photo];}).sort((a,b)=>a[0].localeCompare(b[0]));
export const cycleIdentity = (board,date) => {
  const plan = planAt(board,date).plan;
  return plan ? (board.planVersions.get(plan.date)?.[0]?.id ?? plan.id) : null;
};
// Display labels may change while a referenced account / member remains the same entity.
const reference = (row,key,ref) => row[ref] ? 'id:'+row[ref] : 'text:'+(row[key]??'');
export const taskIdentity = row => row ? JSON.stringify([row.id,reference(row,'name','accountRef'),reference(row,'shop','shopRef'),reference(row,'owner','ownerId'),reference(row,'product','productRef'),row.video,row.photo,row.note]) : null;
export const batchBasis = (board,date) => [...board.publications.values()].filter(e=>e.date===date&&!board.voids.has(e.id)&&!board.deletedEntries.has(e.id)).map(e=>{const c=effectivePublication(board,e);return {target:e.id,accountId:c.accountId,expected:publicationState(board,e),expectedAccount:c.account};});
export function batchPayload(board,date,changes,base={}) {
  const basis=base.basis??batchBasis(board,date), reductions=[];
  for (const c of changes) {
    const left={video:Math.max(0,-c.video),photo:Math.max(0,-c.photo)};
    for (const r of [...basis].reverse().filter(r=>r.accountId===c.accountId)) {
      const video=Math.min(left.video,r.expected.video),photo=Math.min(left.photo,r.expected.photo);
      if(video||photo)reductions.push({...clone(r),video,photo});left.video-=video;left.photo-=photo;
      if(!left.video&&!left.photo)break;
    }
    if(left.video||left.photo)throw Error('减少数量超过暂存时已保存量，请在明细中核对');
  }
  return {snapshot:base.snapshot??config(dayAt(board,date)),expectedHeads:base.expectedHeads??dayHeads(board,date),expectedEntries:base.expectedEntries??dayEntries(board,date),cycleId:base.cycleId===undefined?cycleIdentity(board,date):base.cycleId,changes:clone(changes),reductions};
}
export function batchConflicts(board,date,payload) {
  const rows=dayAt(board,date), issues=[];
  if(payload.cycleId!==cycleIdentity(board,date))issues.push('计划周期已变化');
  for(const c of payload.changes) {
    const before=payload.snapshot.find(r=>r.id===c.accountId),current=rows.find(r=>r.id===c.accountId);
    if(!current||(c.video>0||c.photo>0)&&taskIdentity(before)!==taskIdentity(current))issues.push((before?.name??c.accountId)+'的账号、安排或负责人已变化');
    else if((c.video>0||c.photo>0)&&personKey({person:before.owner,personId:before.ownerId})!==personKey(c))issues.push(before.name+'的完成归属与负责人不符');
  }
  for(const r of payload.reductions) {
    const current=board.publications.get(r.target);
    if(!current||current.date!==date||effectivePublication(board,current).accountId!==r.accountId||board.voids.has(r.target)||board.deletedEntries.has(r.target)||JSON.stringify(publicationState(board,current))!==JSON.stringify(r.expected)||JSON.stringify(effectivePublication(board,current).account)!==JSON.stringify(r.expectedAccount))issues.push((payload.snapshot.find(x=>x.id===r.accountId)?.name??r.accountId)+'的待减少登记已修改或删除（'+r.target+'）');
  }
  return [...new Set(issues)];
}
function scheduledPlan(board,plan,date) {
  const versions=board.planVersions.get(plan.date)??[plan];
  if(!versions.some(p=>p.v>=7))return plan; // Legacy history keeps its prior interpretation.
  const first=versions.findIndex(p=>p.v>=7), baseline=first>0?versions[first-1]:null;
  return versions.slice(first).filter(p=>p.payload.effectiveDate<=date).at(-1)??baseline;
}
export function legacyPlanRisks(board,plan,effectiveDate) {
  if(!plan||plan.v>=7)return [];
  const versions=board.planVersions.get(plan.date)??[plan],risks=[];
  for(let i=1;i<versions.length;i++)if(JSON.stringify(versions[i-1].payload.accounts)!==JSON.stringify(versions[i].payload.accounts)&&(versions[i].payload.applyDate??today(new Date(versions[i].at)))>plan.date)risks.push('旧计划版本 '+versions[i].id);
  for(const [d,saved] of board.days)if(d>=plan.date&&d<effectiveDate&&d<=plan.payload.endDate&&saved.rows.some(r=>{const a=plan.payload.accounts.find(a=>a.id===r.id);return a&&(a.video!==r.video||a.photo!==r.photo);} ))risks.push(d+'的旧单日目标');
  return risks;
}
export function cycleAccounts(board,plan) {
  if(!plan)return [];
  if(plan.v<7)return clone(plan.payload.accounts);
  const byId=new Map();
  for(let d=plan.date;d<=plan.payload.endDate;d=addDays(d,1))for(const r of scheduledPlan(board,plan,d)?.payload.accounts??[])byId.set(r.id,clone(r));
  // A same-day replacement can leave a valid saved contribution on a retired account.
  // Keep that quantity visible without letting it fulfill the replacement account's target.
  for(const entry of board.publications.values())if(entry.date>=plan.date&&entry.date<=plan.payload.endDate&&!board.voids.has(entry.id)&&!board.deletedEntries.has(entry.id)){
    const c=effectivePublication(board,entry);if(c.account&&!byId.has(c.accountId))byId.set(c.accountId,clone(c.account));
  }
  return [...byId.values()];
}
// Receipt numbers are read from the host's read-only AutoNumber field, never from action JSON.
export const actionIdentity = a => JSON.stringify(validateAction(a));
export function planAt(board, date, readLegacy = false) {
  const p = [...board.plans.values(), ...board.cancelledPlans.values()].filter(p => p.date <= date).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const next = [...board.plans.values()].filter(p => p.date > date).sort((a, b) => a.date.localeCompare(b.date))[0];
  const until = p?.payload.endDate ?? null;
  const state = !p ? next ? 'upcoming' : 'empty' : board.cancelledPlans.has(p.date) ? 'deleted' : !until ? 'needs-period' : date > until ? 'ended' : 'active';
  const stage=p?scheduledPlan(board,p,date):null;
  return { accounts: clone(stage && (state === 'active' || readLegacy && !until && state!=='deleted') ? stage.payload.accounts : []), token: stage ? 'plan:' + stage.id : 'plan:empty', from: p?.date ?? null, until, title: p?.payload.title ?? '', state, plan: p ?? null, next: next ?? null };
}
export function dayAt(board, date, readLegacy = false) {
  const saved = board.days.get(date);
  if (saved) {
    const byAccount = new Map();
    for (const entry of board.publications.values()) if (entry.date === date && !board.voids.has(entry.id)) {
      const e = effectivePublication(board, entry);
      if (e.video + e.photo > 0) { const list = byAccount.get(e.accountId) ?? []; list.push(e); byAccount.set(e.accountId, list); }
    }
    return saved.rows.filter(r=>!board.deletedDayAccounts.has(date+'/'+r.id)).map(r => ({ ...clone(r), executions: byAccount.get(r.id) ?? [], head: saved.heads.get(r.id) }));
  }
  const p = planAt(board, date, readLegacy);
  return p.accounts.filter(r=>!board.deletedDayAccounts.has(date+'/'+r.id)).map(r => ({ ...r, executions: [], head: p.token }));
}
export function executionDates(board, at = today()) {
  const dates = new Set(board.days.keys());
  for (const p of board.plans.values()) {
    if (!p.payload.endDate || p.date > at) continue;
    const last = p.payload.endDate < at ? p.payload.endDate : at;
    for (let d = p.date; d <= last; d = addDays(d, 1)) dates.add(d);
  }
  return [...dates].sort();
}
export function accountCycleSummary(board, plan, account) {
  if (!plan?.payload.endDate || board.cancelledPlans.has(plan.date)) return null;
  const days=cycleDays(plan.date,plan.payload.endDate);
  let targetVideo=account.video*days,targetPhoto=account.photo*days;
  if(plan.v>=7){
    targetVideo=0;targetPhoto=0;
    for(let d=plan.date;d<=plan.payload.endDate;d=addDays(d,1)){
      const stage=scheduledPlan(board,plan,d),saved=board.days.get(d);
      const r=(saved&&stage&&saved.planId===stage.id?saved.rows:[]).find(r=>r.id===account.id)??stage?.payload.accounts.find(r=>r.id===account.id);
      targetVideo+=r?.video??0;targetPhoto+=r?.photo??0;
    }
  }
  let video=0,photo=0;
  for (const entry of board.publications.values()) {
    if(entry.date<plan.date||entry.date>plan.payload.endDate||board.voids.has(entry.id)||board.deletedEntries.has(entry.id))continue;
    const effective=effectivePublication(board,entry);if(effective.accountId!==account.id)continue;video+=effective.video;photo+=effective.photo;
  }
  const target=targetVideo+targetPhoto,fulfilled=Math.min(video,targetVideo)+Math.min(photo,targetPhoto);
  return {days,video,photo,targetVideo,targetPhoto,target,fulfilled,missingVideo:Math.max(0,targetVideo-video),missingPhoto:Math.max(0,targetPhoto-photo),pct:target?Math.round(fulfilled/target*100):100};
}
export function cycleSummary(board, plan) {
  if (!plan?.payload.endDate || board.cancelledPlans.has(plan.date)) return null;
  const sum={days:cycleDays(plan.date,plan.payload.endDate),recordedDays:0,video:0,photo:0,targetVideo:0,targetPhoto:0,fulfilled:0,missingVideo:0,missingPhoto:0};
  const accounts=cycleAccounts(board,plan);
  for(const account of accounts){const s=accountCycleSummary(board,plan,account);for(const key of ['video','photo','targetVideo','targetPhoto','fulfilled','missingVideo','missingPhoto'])sum[key]+=s[key];}
  const ids=new Set(accounts.map(r=>r.id)),dates=new Set();
  for(const entry of board.publications.values())if(entry.date>=plan.date&&entry.date<=plan.payload.endDate&&!board.voids.has(entry.id)&&!board.deletedEntries.has(entry.id)){const effective=effectivePublication(board,entry);if(ids.has(effective.accountId)&&effective.video+effective.photo>0)dates.add(entry.date);}
  sum.recordedDays=dates.size;sum.target=sum.targetVideo+sum.targetPhoto;sum.pct=sum.target?Math.round(sum.fulfilled/sum.target*100):100;return sum;
}
export function hasRegistration(board,date,accountId=null){const ids=new Set((board.days.get(date)?.rows??planAt(board,date).accounts).map(r=>r.id));return [...board.publications.values()].some(e=>{const c=effectivePublication(board,e);return e.date===date&&ids.has(c.accountId)&&(!accountId||c.accountId===accountId)&&!board.voids.has(e.id)&&c.video+c.photo>0;});}
export function effectivePublication(board, e) {
  const updated = board.edits.get(e.id) ?? e;
  const reduced = board.reductions.get(e.id) ?? { video: 0, photo: 0 };
  const account=updated.account??e.account;
  return { ...clone(e), account,accountId:account?.id??e.accountId,personId: updated.personId, ...execution(updated), video: updated.video - reduced.video, photo: updated.photo - reduced.photo };
}
export const publicationState = (board, e) => execution(effectivePublication(board, e));
export const delegatedPublication = e => e.personId && e.account?.ownerId ? e.personId !== e.account.ownerId : !!e.account && e.person !== e.account.owner;
export function project(rawActions) {
  const board = { seq: 0, actions: [], plans: new Map(), planVersions:new Map(), cancelledPlans:new Map(), deletedDayAccounts:new Set(), deletedEntries:new Set(), deletedPlanKeys:new Set(), deletedDailyKeys:new Set(), planHead: null, days: new Map(), publications: new Map(), edits: new Map(), voids: new Set(), reductions: new Map(), stops: new Map(), restored: new Map(), restoreFailures: new Set(), accepted: new Set(), conflicts: [] };
  const unique = new Map();
  for (const raw of rawActions) {
    const a = validateAction(raw), old = unique.get(a.id);
    if (old && actionIdentity(old) !== actionIdentity(a)) throw Error('同一操作ID出现不同内容，停止读写以保护数据');
    if (raw.serverOrder !== undefined) a.serverOrder = integer(raw.serverOrder, '服务器提交序号', Number.MAX_SAFE_INTEGER);
    if (a.serverOrder === 0) throw Error('服务器提交序号无效');
    if (!old || (a.serverOrder ?? Infinity) < (old.serverOrder ?? Infinity)) unique.set(a.id, a);
  }
  const all = [...unique.values()], committed = all.filter(a => a.serverOrder !== undefined);
  const boundary = Math.min(...committed.filter(a => a.v >= 2).map(a => a.serverOrder));
  const periodBoundary = Math.min(...committed.filter(a => a.v >= 3).map(a => a.serverOrder));
  const updateBoundary = Math.min(...committed.filter(a=>a.v>=4).map(a=>a.serverOrder));
  const dailyBoundary = Math.min(...committed.filter(a=>a.v>=5).map(a=>a.serverOrder));
  const correctionBoundary = Math.min(...committed.filter(a=>a.v>=6).map(a=>a.serverOrder));
  const scopedBoundary = Math.min(...committed.filter(a=>a.v>=7).map(a=>a.serverOrder));
  const legacy = a => a.v === 1 && (a.serverOrder === undefined || a.serverOrder < boundary);
  const lastOrder = Math.max(0, ...committed.map(a => a.serverOrder));
  const sorted = all.sort((a, b) => {
    if (legacy(a) !== legacy(b)) return legacy(a) ? -1 : 1;
    if (legacy(a) || !committed.length) return a.seq - b.seq || a.id.localeCompare(b.id);
    return (a.serverOrder ?? lastOrder + a.seq + 1) - (b.serverOrder ?? lastOrder + b.seq + 1) || a.id.localeCompare(b.id);
  });
  for (const a of sorted) {
    board.seq = Math.max(board.seq, a.seq);
    board.actions.push(a);
    const p = a.payload;
    const conflict = reason => board.conflicts.push({ ...a, reason });
    if (board.stops.has(a.id)) { conflict('该请求已停止重试，迟到记录未生效'); continue; }
    if (board.restored.has(a.id)) { conflict('该操作已随备份恢复，迟到的原请求未重复生效'); continue; }
    if (a.restore && a.serverOrder !== undefined && a.serverOrder !== a.restore.after + 1) {
      board.restoreFailures.add(a.id); conflict('恢复期间出现其他服务器记录，此恢复请求未生效；任务已暂停'); continue;
    }
    if (a.restore) for (const sourceId of a.restore.sourceIds) if (!board.restored.has(sourceId)) board.restored.set(sourceId, a.id);
    if (a.restore?.auditOnly) { conflict('备份未生效审计：' + a.restore.reason); continue; }
    if (a.v === 1 && a.serverOrder !== undefined && a.serverOrder >= boundary) {
      conflict('旧版本请求在升级后到达，未生效；请刷新页面并核对最新记录'); continue;
    }
    if (a.v < 3 && a.serverOrder !== undefined && a.serverOrder >= periodBoundary) {
      conflict('旧版请求在周期版启用后到达，未生效；请刷新到新版看板'); continue;
    }
    if(a.v<4 && a.serverOrder!==undefined && a.serverOrder>=updateBoundary){conflict('旧版请求在新版启用后到达，未生效；请刷新后重新保存');continue;}
    if(a.v<5 && a.serverOrder!==undefined && a.serverOrder>=dailyBoundary){conflict('旧版请求在当天删除版启用后到达，未生效；请刷新后重新保存');continue;}
    if(a.v<6 && a.serverOrder!==undefined && a.serverOrder>=correctionBoundary){conflict('旧版请求在登记纠错版启用后到达，未生效；请刷新后重新保存');continue;}
    if(a.v<7 && !a.restore && a.serverOrder!==undefined && a.serverOrder>=scopedBoundary){conflict('旧版请求在协作规则升级后到达，未生效；保留原输入，请刷新新版并核对明细');continue;}
    const freeze = rows => {
      if (!board.days.has(a.date)) board.days.set(a.date, { rows: clone(rows), planId:planAt(board,a.date,true).plan?.id??null, heads: new Map(rows.map(r => [r.id, 'snapshot:' + a.id + '/' + r.id])) });
      return board.days.get(a.date);
    };
    if (a.kind === 'stop') {
      const prior = board.actions.find(old => old.id === p.target);
      if (prior && prior.actor !== a.actor) { conflict('只能停止自己提交的请求'); continue; }
      board.stops.set(p.target, a.id); // Earlier accepted events remain effective.
    } else if (a.kind === 'plan') {
      if (p.expected !== board.planHead) { conflict('另一位同事已修改发布计划，请核对后重新保存'); continue; }
      if(p.applyDate && JSON.stringify(dayHeads(board,p.applyDate))!==JSON.stringify(p.applyHeads)){conflict('另一位同事已调整当天计划，请刷新核对后重新保存');continue;}
      if(p.applyDate&&planAt(board,p.applyDate).from>a.date){conflict('这份计划不属于今天，不能覆盖另一周期的当天任务');continue;}
      if (p.endDate) {
        const overlaps = [...board.plans.values()].some(other => other.date !== a.date && other.payload.endDate && other.date <= p.endDate && a.date <= other.payload.endDate);
        if (overlaps) { conflict('计划周期与另一份计划重叠，请调整开始或结束日期'); continue; }
      }
      const previous=board.plans.get(a.date), remaining=new Set(p.accounts.map(r=>r.id));
      if(a.v>=7&&previous){
        const risks=legacyPlanRisks(board,previous,p.effectiveDate);if(risks.length){conflict('旧周期目标需要先核对迁移：'+risks.join('；')+'。原周期和输入保留，未重造过去目标');continue;}
        const versions=board.planVersions.get(a.date)??[previous],latest=versions.at(-1);
        if(p.effectiveDate<(latest.payload.effectiveDate??a.date)){conflict('计划调整不能改写此前已生效的阶段');continue;}
        if(p.effectiveDate>a.date&&p.endDate!==previous.payload.endDate){conflict('周期已经开始，日常调整保留原结束日期；请建立新周期');continue;}
        if(p.accounts.some(r=>{const old=versions.flatMap(v=>v.payload.accounts).find(x=>x.id===r.id);return old&&reference(old,'name','accountRef')!==reference(r,'name','accountRef')&&(old.accountRef||r.accountRef);})){conflict('更换真实账号必须使用新账号标识，旧账号数量保留');continue;}
      }
      if(a.v>=7&&!previous&&p.effectiveDate!==a.date){conflict('新周期从开始日期生效，不能补造开始前的安排');continue;}
      if(a.v<7&&previous&&p.cleanupRemoved)for(const prior of board.actions.filter(x=>x.kind==='plan'&&x.date===a.date&&board.accepted.has(x.id)))for(const r of prior.payload.accounts)if(!remaining.has(r.id))board.deletedPlanKeys.add(prior.id+'/'+r.id);
      board.cancelledPlans.delete(a.date);board.plans.set(a.date, a);
      const versions=board.planVersions.get(a.date)??[];versions.push(a);board.planVersions.set(a.date,versions);
      board.planHead = a.id;
      if(a.v>=7){
        for(const [d,saved] of board.days)if(d>=p.effectiveDate&&d<=p.endDate&&d>=a.date){
          saved.rows=clone(p.accounts).filter(r=>!board.deletedDayAccounts.has(d+'/'+r.id));saved.planId=a.id;saved.heads=new Map(saved.rows.map(r=>[r.id,'plan:'+a.id+'/'+r.id]));
        }
      }
      if(p.applyDate){
        const old=board.days.get(p.applyDate),applied=(p.applyAccounts??p.accounts).filter(r=>!board.deletedDayAccounts.has(p.applyDate+'/'+r.id)),activeIds=new Set(applied.map(r=>r.id));
        if(old)for(const r of old.rows)if(!activeIds.has(r.id))board.deletedDailyKeys.add(p.applyDate+'/'+r.id);
        for(const r of applied)board.deletedDailyKeys.delete(p.applyDate+'/'+r.id);
        board.days.set(p.applyDate,{rows:clone(applied),planId:a.id,heads:new Map(applied.map(r=>[r.id,'plan:'+a.id+'/'+r.id]))});
      }
    } else if (a.kind === 'seed') {
      if (board.days.has(a.date)) { conflict('该日期已有共享记录，导入被跳过'); continue; }
      freeze(config(p.rows));
      p.rows.forEach(r => r.executions.forEach((e, i) => {
        const key = a.id + '/' + r.id + '/' + i;
        board.publications.set(key, { id: key, date: a.date, accountId: r.id, account:config([r])[0], ...e, at: a.at, actor: a.actor, imported: true });
      }));
    } else if (a.kind === 'publish') {
      if(a.v>=7&&!a.restore&&(p.cycleId!==cycleIdentity(board,a.date)||taskIdentity(p.snapshot.find(r=>r.id===p.accountId))!==taskIdentity(dayAt(board,a.date).find(r=>r.id===p.accountId)))){conflict('该账号的计划或负责人已变化，代做输入保留，请核对安排');continue;}
      if (a.v >= 2 && a.v < 7 && !a.restore && !board.days.has(a.date) && JSON.stringify(p.snapshot) !== JSON.stringify(config(dayAt(board, a.date, a.v < 3)))) {
        conflict('首次登记的计划快照已过期，请刷新后重新登记'); continue;
      }
      const d = freeze(a.v>=7?config(dayAt(board,a.date)):p.snapshot);
      if (!d.rows.some(r => r.id === p.accountId)) { conflict('该账号不在已保存的当天计划内'); continue; }
      const cycle=planAt(board,a.date).plan;
      board.publications.set(a.id, { id: a.id, date: a.date, accountId: p.accountId, account:clone(p.snapshot.find(r=>r.id===p.accountId)), ...(a.v>=7&&cycle?{cycle:{date:cycle.date,payload:{endDate:cycle.payload.endDate,title:cycle.payload.title}}}:{}), ...execution(p), at: a.at, actor: a.actor });
    } else if(a.kind==='batch'){
      const rows=dayAt(board,a.date);
      if(a.v>=7){const issues=batchConflicts(board,a.date,p);if(issues.length){conflict(issues.join('；')+'。本次未生效，原输入保留');continue;}}
      else if(JSON.stringify(config(rows))!==JSON.stringify(p.snapshot)||JSON.stringify(dayHeads(board,a.date))!==JSON.stringify(p.expectedHeads)||JSON.stringify(dayEntries(board,a.date))!==JSON.stringify(p.expectedEntries)){conflict('当天任务或登记已被其他人修改，本次待保存登记未生效，请核对后重新登记');continue;}
      if(p.changes.some(c=>{const row=rows.find(r=>r.id===c.accountId),n=row&&counts(row);return !row||n.video+c.video<0||n.photo+c.photo<0;})){conflict('减少数量超过已登记数量，整批未生效');continue;}
      freeze(a.v>=7?config(rows):p.snapshot);
      if(a.v>=7)for(const r of p.reductions){const reduced=board.reductions.get(r.target)??{video:0,photo:0};board.reductions.set(r.target,{video:reduced.video+r.video,photo:reduced.photo+r.photo});const n=effectivePublication(board,board.publications.get(r.target));if(!n.video&&!n.photo){board.voids.add(r.target);board.deletedEntries.add(r.target);}}
      for(const change of p.changes){
        for(const content of ['video','photo'])if(a.v<7&&change[content]<0){
          let remaining=-change[content];
          for(const entry of [...board.publications.values()].reverse().filter(e=>e.date===a.date&&e.accountId===change.accountId&&!board.voids.has(e.id))){
            const amount=Math.min(remaining,effectivePublication(board,entry)[content]);if(!amount)continue;
            const reduction=board.reductions.get(entry.id)??{video:0,photo:0};board.reductions.set(entry.id,{...reduction,[content]:reduction[content]+amount});remaining-=amount;
            const n=effectivePublication(board,entry);if(!n.video&&!n.photo){board.voids.add(entry.id);board.deletedEntries.add(entry.id);}
            if(!remaining)break;
          }
        }
        if(change.video>0||change.photo>0){const key=a.id+'/'+change.accountId,cycle=planAt(board,a.date).plan;board.publications.set(key,{id:key,date:a.date,accountId:change.accountId,account:clone(p.snapshot.find(r=>r.id===change.accountId)),...(a.v>=7&&cycle?{cycle:{date:cycle.date,payload:{endDate:cycle.payload.endDate,title:cycle.payload.title}}}:{}),person:change.person,...(change.personId?{personId:change.personId}:{}),video:Math.max(0,change.video),photo:Math.max(0,change.photo),note:'',at:a.at,actor:a.actor});}
      }
    } else if (a.kind === 'edit') {
      const target = board.publications.get(p.target);
      if (!target || target.date !== a.date || board.voids.has(p.target) || board.deletedEntries.has(p.target) || JSON.stringify(publicationState(board,target)) !== JSON.stringify(p.expected) || a.v>=7&&JSON.stringify(effectivePublication(board,target).account)!==JSON.stringify(p.expectedAccount)) {
        conflict('这条登记已被修改或删除，请重新打开明细后核对'); continue;
      }
      if(p.account){const current=effectivePublication(board,target);if(p.account.id!==current.accountId&&!dayAt(board,a.date).some(r=>r.id===p.account.id&&reference(r,'name','accountRef')===reference(p.account,'name','accountRef'))){conflict('纠错账号不在该日期的任务内，请核对历史归属');continue;}}
      board.edits.set(p.target, {...execution(p),account:clone(p.account??effectivePublication(board,target).account)});
      board.reductions.delete(p.target);
    } else if (a.kind === 'day') {
      const row = dayAt(board, a.date, a.v < 3 || !!a.restore).find(r => r.id === p.accountId);
      if (!row || row.head !== p.expected) { conflict('当天计划已变化，请核对后重新调整'); continue; }
      const d = freeze(p.snapshot);
      d.rows = d.rows.map(r => r.id === p.accountId ? clone(p.account) : r);
      d.heads.set(p.accountId, a.id);
    } else if (a.kind === 'void') {
      const target = board.publications.get(p.target);
      if (!target || target.date !== a.date) { conflict('撤销对象不存在或日期不符'); continue; }
      board.voids.add(p.target);
    } else if(a.kind==='delete'){
      const removeEntries=entries=>{for(const entry of entries){board.voids.add(entry.id);board.deletedEntries.add(entry.id);}};
      if(p.type==='publication'){
        const target=board.publications.get(p.target);if(!target||target.date!==a.date){conflict('删除对象不存在或日期不符');continue;}
        if(p.expected&&!board.deletedEntries.has(p.target)&&(JSON.stringify(publicationState(board,target))!==JSON.stringify(p.expected)||a.v>=7&&JSON.stringify(effectivePublication(board,target).account)!==JSON.stringify(p.expectedAccount))){conflict('这条登记已被修改，请重新打开明细后确认删除');continue;}
        board.voids.add(p.target);board.deletedEntries.add(p.target);
      }else if(p.type==='day-account'||p.type==='restore-day-account'){
        const key=a.date+'/'+p.target,restoring=p.type==='restore-day-account',rows=dayAt(board,a.date),cycleRow=planAt(board,a.date).accounts.find(r=>r.id===p.target);
        const entries=[...board.publications.values()].filter(e=>e.date===a.date&&effectivePublication(board,e).accountId===p.target&&!board.deletedEntries.has(e.id));
        if(JSON.stringify(dayHeads(board,a.date))!==JSON.stringify(p.expectedHeads)||(restoring?(!board.deletedDayAccounts.has(key)||!cycleRow):(!rows.some(r=>r.id===p.target)||p.entries&&JSON.stringify(entries.map(e=>e.id).sort())!==JSON.stringify(p.entries)))){conflict('当天任务或登记已变化，请刷新后重新确认');continue;}
        const d=freeze(config(rows));
        if(restoring){board.deletedDayAccounts.delete(key);board.deletedDailyKeys.delete(key);d.rows.push(clone(cycleRow));d.heads.set(p.target,a.id);}
        else{removeEntries(entries);board.deletedDayAccounts.add(key);board.deletedDailyKeys.add(key);d.rows=d.rows.filter(r=>r.id!==p.target);d.heads.delete(p.target);}
      }else{
        const target=board.plans.get(a.date);
        if(!target||target.id!==p.target||p.expected!==board.planHead||JSON.stringify(dayHeads(board,p.applyDate))!==JSON.stringify(p.applyHeads)){conflict('计划或当天任务已变化，请刷新后重新确认删除');continue;}
        const scopedEntries=[...board.publications.values()].filter(e=>e.date>=target.date&&e.date<=(target.payload.endDate??target.date)&&!board.deletedEntries.has(e.id));
        if(p.cascade&&p.entries&&JSON.stringify(scopedEntries.map(e=>e.id).sort())!==JSON.stringify(p.entries)){conflict('周期登记已变化，请重新确认删除范围');continue;}
        for(const prior of board.actions.filter(x=>x.kind==='plan'&&x.date===a.date&&board.accepted.has(x.id)))for(const r of prior.payload.accounts)board.deletedPlanKeys.add(prior.id+'/'+r.id);
        board.plans.delete(a.date);board.cancelledPlans.set(a.date,target);board.planHead=a.id;
        if(p.cascade){
          const end=target.payload.endDate??target.date,entries=[...board.publications.values()].filter(e=>e.date>=target.date&&e.date<=end&&!board.deletedEntries.has(e.id));
          removeEntries(entries);
          for(let d=target.date;d<=end;d=addDays(d,1)){const rows=board.days.get(d)?.rows??target.payload.accounts;for(const r of rows)board.deletedDailyKeys.add(d+'/'+r.id);board.days.set(d,{rows:[],planId:a.id,heads:new Map()});}
        }
        if(p.applyDate>=target.date&&(!target.payload.endDate||p.applyDate<=target.payload.endDate)){const old=board.days.get(p.applyDate);for(const r of old?.rows??[])board.deletedDailyKeys.add(p.applyDate+'/'+r.id);board.days.set(p.applyDate,{rows:[],planId:a.id,heads:new Map()});}
      }
    } else if (a.kind === 'reduce') {
      const target = board.publications.get(p.target);
      if (!target || target.date !== a.date || personKey(effectivePublication(board,target)) !== personKey(p) || board.voids.has(p.target)) { conflict('这条登记已变化，请刷新后重新减1'); continue; }
      if (effectivePublication(board, target)[p.content] < 1) { conflict('这条登记已减到0，请核对最新数量'); continue; }
      const reduced = board.reductions.get(p.target) ?? { video: 0, photo: 0 };
      board.reductions.set(p.target, { ...reduced, [p.content]: reduced[p.content] + 1 });
    }
    board.accepted.add(a.id);
  }
  return board;
}
export function counts(r) {
  return r.executions.reduce((s, e) => ({ video: s.video + e.video, photo: s.photo + e.photo }), { video: 0, photo: 0 });
}
export function stats(rows) {
  const s = { video: 0, photo: 0, targetVideo: 0, targetPhoto: 0, missingVideo: 0, missingPhoto: 0, fulfilled: 0, complete: 0, active: 0 };
  for (const r of rows) {
    const c = counts(r);
    s.video += c.video; s.photo += c.photo; s.targetVideo += r.video; s.targetPhoto += r.photo;
    s.missingVideo += Math.max(0, r.video - c.video); s.missingPhoto += Math.max(0, r.photo - c.photo);
    s.fulfilled += Math.min(c.video, r.video) + Math.min(c.photo, r.photo);
    if (r.video + r.photo > 0) { s.active++; if (c.video >= r.video && c.photo >= r.photo) s.complete++; }
  }
  s.target = s.targetVideo + s.targetPhoto;
  s.pct = s.target ? Math.round(s.fulfilled / s.target * 100) : 100;
  return s;
}
export function people(rows) {
  const map = new Map();
  for (const r of rows) for (const e of r.executions) {
    const key = personKey(e), person = map.get(key) ?? { person: e.person, ...(e.personId ? { personId: e.personId } : {}), video: 0, photo: 0, support: 0 };
    person.video += e.video; person.photo += e.photo;
    if (delegatedPublication(e)) person.support += e.video + e.photo;
    map.set(key, person);
  }
  return [...map.values()].filter(p => p.video + p.photo > 0);
}
export function csvCell(v) {
  let t = String(v ?? '');
  if (/^[\s]*[=+@-]/.test(t)) t = "'" + t;
  return '"' + t.replaceAll('"', '""') + '"';
}
export function report(board, date, rows = dayAt(board, date)) {
  const s = stats(rows);
  return `${date} 内容发布日报\n视频 ${s.video}/${s.targetVideo}，图文 ${s.photo}/${s.targetPhoto}\n达标 ${s.complete}/${s.active} 个账号，缺视频 ${s.missingVideo}、缺图文 ${s.missingPhoto}\n\n` + rows.map(r => {
    const c = counts(r);
    return `${r.name}（${r.owner}）｜${r.product || '待确定'}\n视频 ${c.video}/${r.video}，图文 ${c.photo}/${r.photo}` + (r.note ? `｜${r.note}` : '');
  }).join('\n') + '\n\n实际贡献\n' + people(rows).map(p => `${p.person}：视频 ${p.video}，图文 ${p.photo}，协助 ${p.support}`).join('\n');
}
// Migration is additive: existing days and existing plans are never replaced.
export function migration(raw) {
  if (raw?.format === FORMAT) {
    if (!Array.isArray(raw.actions) || raw.actions.length > 20000) throw Error('备份操作列表无效');
    const native = project(raw.actions).actions;
    return { native };
  }
  let plans = [], days = [];
  if (raw && [1, 2].includes(raw.version) && raw.days && Array.isArray(raw.config)) {
    plans = [{ date: '2000-01-01', accounts: config(raw.config) }, ...(raw.plans ?? []).map(p => ({ date: p.from, accounts: config(p.config) }))];
    days = Object.entries(raw.days).map(([date, day]) => ({ date, rows: config(day.rows).map((r, i) => ({ ...r, executions: day.rows[i].executions.map(execution) })) }));
  } else if (Array.isArray(raw?.accounts) && raw.dailyRecords && !Array.isArray(raw.dailyRecords)) {
    const account = r => ({ id: String(r.id ?? r.accountId), name: r.account ?? r.accountName, shop: r.shop ?? '', owner: r.owner ?? r.planOwner, product: r.defaultSku ?? r.mainSku ?? '', video: r.videoTarget, photo: r.imageTarget ?? r.photoTarget, note: r.note ?? r.notes ?? '' });
    plans = [{ date: '2000-01-01', accounts: config(raw.accounts.map(account)) }];
    days = Object.entries(raw.dailyRecords).map(([date, rows]) => {
      const cfg = config(rows.map(account));
      return { date, rows: cfg.map((r, i) => ({ ...r, executions: [execution({ person: rows[i].actualPerson || r.owner, video: rows[i].videoDone, photo: rows[i].imageDone ?? rows[i].photoDone, note: '从原网页导入；原记录按汇总完成人保存' })].filter(e => e.video + e.photo > 0) })) };
    });
  } else throw Error('不支持此备份。请选择原 Sites 导出的JSON、原 GitHub 看板JSON或本版备份');
  if (days.length > 10000 || plans.length > 10000 || days.some(d => !validDate(d.date)) || plans.some(p => !validDate(p.date))) throw Error('备份日期无效或数量过多');
  if (new Set(plans.map(p => p.date)).size !== plans.length) throw Error('备份计划日期重复');
  for (const d of days) validateAction({ v: 1, id: 'migration-validation', seq: 1, kind: 'seed', date: d.date, at: new Date().toISOString(), actor: 'validation', payload: { rows: d.rows, source: '旧版JSON备份' } });
  return { plans: plans.sort((a, b) => a.date.localeCompare(b.date)), days: days.sort((a, b) => a.date.localeCompare(b.date)) };
}
export function restoreId(jobId, index, after) { return 'restore:' + jobId + '/' + index + '/' + after; }
const restoreSources = new WeakMap();
export function makeRestoreAction(incoming, index, after, current = project([])) {
  if (!restoreSources.has(incoming)) {
    const source = project(incoming.native);
    restoreSources.set(incoming, source);
  }
  const source = restoreSources.get(incoming), original = source.actions[index];
  const ids = current.restoredIds ?? new Map(), requestId = restoreId(incoming.jobId, index, after);
  if (!current.restoredIds) for (const a of current.actions) if (a.restore?.jobId === incoming.jobId && current.accepted.has(a.id)) ids.set(a.restore.sourceId, a.id);
  const mapped = value => {
    if (value === null || typeof value !== 'string') return value;
    if (value === original.id) return requestId;
    if (ids.has(value)) return ids.get(value);
    for (let slash = value.lastIndexOf('/'); slash > 0; slash = value.lastIndexOf('/', slash - 1)) if (ids.has(value.slice(0, slash))) return ids.get(value.slice(0, slash)) + value.slice(slash);
    if (value.startsWith('snapshot:')) return 'snapshot:' + mapped(value.slice(9));
    if (value.startsWith('plan:')) return 'plan:' + mapped(value.slice(5));
    return value;
  };
  const payload = clone(original.payload);
  for (const key of ['expected', 'target']) if (key in payload && typeof payload[key] === 'string' && !(key==='target'&&payload.type?.includes('day-account'))) payload[key] = mapped(payload[key]);
  const priorSources = source.restoreFailures.has(original.id) ? [] : original.restore?.sourceIds ?? [];
  if(payload.applyHeads)payload.applyHeads=payload.applyHeads.map(([account,head])=>[account,mapped(head)]);
  if(payload.expectedHeads)payload.expectedHeads=payload.expectedHeads.map(([account,head])=>[account,mapped(head)]);
  if(payload.expectedEntries)payload.expectedEntries=payload.expectedEntries.map(([entry,...rest])=>[mapped(entry),...rest]).sort((a,b)=>a[0].localeCompare(b[0]));
  if(payload.cycleId)payload.cycleId=mapped(payload.cycleId);
  if(payload.reductions)payload.reductions=payload.reductions.map(r=>({...r,target:mapped(r.target)}));
  if(payload.entries)payload.entries=payload.entries.map(mapped).sort();
  return validateAction({ ...original, v: Math.max(5, original.v), id: requestId, payload, restore: { jobId: incoming.jobId, sourceId: original.id, sourceIds: [original.id, ...priorSources], after, auditOnly: !source.accepted.has(original.id), reason: source.conflicts.find(c => c.id === original.id)?.reason ?? '' } });
}
export function importPreview(board, incoming) {
  if (incoming.native) {
    if (incoming.native.length > 20000) throw Error('恢复后超过20,000条，请先升级容量');
    if (board.actions.length && (!incoming.jobId || board.actions.some((a, i) => !a.restore || a.id !== restoreId(incoming.jobId, i, a.restore.after) || a.restore.sourceId !== incoming.native[i]?.id || a.restore.jobId !== incoming.jobId))) throw Error('原生备份只能在空白共享表恢复，或继续同一任务的连续前缀；有其他操作时任务暂停，不能合并现有历史');
    if (board.restoreFailures.size) throw Error('恢复前置链不匹配，任务已暂停；请核对已恢复记录和团队新操作，不能强行继续');
    const restoredIds = new Map();
    for (let i = 0; i < board.actions.length; i++) {
      const a = board.actions[i];
      if (actionIdentity(a) !== actionIdentity(makeRestoreAction(incoming, i, a.restore.after, { restoredIds }))) throw Error('恢复任务内容与已保存前缀不匹配，任务暂停');
      if (board.accepted.has(a.id)) restoredIds.set(a.restore.sourceId, a.id);
    }
    for (const a of board.actions) if (!board.accepted.has(a.id) && !a.restore?.auditOnly) throw Error('恢复请求未生效，任务已暂停；请核对冲突后放弃剩余导入');
    return { operations: incoming.native.slice(board.actions.length), skipped: 0, plans: 0 };
  }
  const days = incoming.days.filter(d => !board.days.has(d.date));
  if (board.actions.length + days.length + (board.plans.size ? 0 : incoming.plans.length) > 20000) throw Error('导入后超过20,000条，请分批或升级容量');
  return { days, skipped: incoming.days.length - days.length, plans: board.plans.size ? 0 : incoming.plans.length };
}
