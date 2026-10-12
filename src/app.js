import { FORMAT, clone, today, config, validDate, addDays, cycleDays, cycleSummary, executionDates, hasRegistration, dayHeads, dayEntries, cycleIdentity, taskIdentity, batchBasis, batchPayload, batchConflicts, makeAction, project, planAt, dayAt, counts, stats, people, effectivePublication, publicationState, delegatedPublication, csvCell, report, migration, importPreview, makeRestoreAction } from './model.js';
import { Controller, TABLE_NAME, createFeishuStore, createDemoStore } from './storage.js';
import { boardRevision } from './business.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function createApp(doc, win, loadSDK) {
  const $ = id => doc.getElementById(id);
  let controller = null, store = null, tab = 'board', date = today(), followToday = true, planDirty = false, planExpected = null, planLoaded = false;
  let editing = null, entriesAccount = null, incoming = null, toastTimer, pollTimer, offStore, refreshTimer, connecting = false, importing = false, connectionEpoch = 0;
  let registrationDirty = false;
  let deleteTarget = null;
  let quickDraft = null, leaveQuick = null, quickReview = null;
  const quickKey=()=> 'tiktok-board-quick-draft:'+store.scope;
  const quickIssues=()=>{if(!quickDraft)return [];if(quickDraft.requiresReview)return ['旧版暂存需要人工核对，未自动提交'];if(quickDraft.actionId&&controller.board.actions.some(a=>a.id===quickDraft.actionId)&&!controller.board.accepted.has(quickDraft.actionId))return ['上次请求已确认未生效，请核对暂存后重新保存'];try{return batchConflicts(controller.board,quickDraft.date,batchPayload(controller.board,quickDraft.date,quickDraft.changes,quickDraft));}catch(e){return [e.message];}};
  const quickCurrent=()=>!quickIssues().length;
  function persistQuick(){win.sessionStorage.setItem(quickKey(),JSON.stringify(quickDraft));}
  function discardQuick(){win.sessionStorage.removeItem(quickKey());quickDraft=null;render();}
  function askQuick(next){if(!quickDraft)return false;leaveQuick=next;show($('quick-leave-dialog'));return true;}
  function stageQuantity(id,content,delta){
    writable();if(date>today())throw Error('未来日期仅查看');
    if(!quickCurrent())throw Error(quickIssues().join('；')+'。原输入保留，请点「核对暂存」');
    if(quickDraft&&quickDraft.date!==date)throw Error('请先保存另一日期的暂存登记');
    const r=row(id),selected=selectedPerson(r),member=selected.person?selected:{person:r.owner,...(r.ownerId?{personId:r.ownerId}:{})};if(delta>0&&!selected.person)throw Error('请先选择账号负责人');
    const draft=clone(quickDraft??{v:7,date,snapshot:snapshot(),expectedHeads:dayHeads(controller.board,date),expectedEntries:dayEntries(controller.board,date),cycleId:cycleIdentity(controller.board,date),basis:batchBasis(controller.board,date),changes:[]});
    let change=draft.changes.find(c=>c.accountId===id);
    if(!change){change={accountId:id,...member,video:0,photo:0};draft.changes.push(change);}
    if(counts(r)[content]+change[content]+delta<0)throw Error('不能减少到0以下');
    change[content]+=delta;draft.changes=draft.changes.filter(c=>c.video||c.photo);
    if(draft.changes.length){quickDraft=draft;persistQuick();}else{win.sessionStorage.removeItem(quickKey());quickDraft=null;}
    renderBoard();renderStatus();
  }
  async function saveQuick(){
    if(!quickDraft)return;
    writable();const pending=clone(quickDraft);await controller.refresh();
    if(quickDraft.actionId&&controller.board.accepted.has(quickDraft.actionId)){discardQuick();await finishBusiness();message('此暂存已保存，未重复登记');return;}
    if(!quickCurrent())throw Error(quickIssues().join('；')+'。原输入保留，请点「核对暂存」');
    if(!quickDraft.actionId){quickDraft.actionId=crypto.randomUUID();persistQuick();}
    await save('batch',pending.date,batchPayload(controller.board,pending.date,pending.changes,pending),quickDraft.actionId);
    discardQuick();await finishBusiness();message(store.mode==='feishu'&&!businessMessage.includes('已更新')?'登记已保存；'+businessMessage:'登记已统一保存，进度和明细已更新');
  }
  async function reviewQuick(){
    writable();if(!quickDraft)return;await controller.refresh();
    if(quickDraft.actionId&&controller.board.accepted.has(quickDraft.actionId)){discardQuick();await finishBusiness();return;}
    quickReview={date:quickDraft.date,snapshot:config(dayAt(controller.board,quickDraft.date)),basis:batchBasis(controller.board,quickDraft.date),cycleId:cycleIdentity(controller.board,quickDraft.date)};
    $('quick-review-rows').innerHTML=quickDraft.changes.map(c=>{const old=quickDraft.snapshot.find(r=>r.id===c.accountId),now=quickReview.snapshot.find(r=>r.id===c.accountId),n=now?counts(dayAt(controller.board,quickDraft.date).find(r=>r.id===c.accountId)):{video:0,photo:0};return `<div class="review-row" data-account="${esc(c.accountId)}"><strong>${esc(old?.name??c.accountId)}</strong><p class="muted">原安排：${esc(old?.owner)} / ${esc(old?.product||'未设产品')} / ${esc(old?.shop)}<br>当前：${now?esc(now.owner+' / '+(now.product||'未设产品')+' / '+now.shop):'账号已移出任务，请将该项调整为0'} · 已保存视频${n.video} / 图文${n.photo}</p><div class="two-col"><label>视频变化<input data-delta="video" type="number" step="1" min="-1000000" max="1000000" value="${c.video}" required></label><label>图文变化<input data-delta="photo" type="number" step="1" min="-1000000" max="1000000" value="${c.photo}" required></label></div></div>`;}).join('');
    show($('quick-review-dialog'));renderStatus();
  }
  let members = [], membersError = '', membersBusy = false;
  let memberRows = [], catalog = { accounts: [], shops: [], products: [] }, catalogError = '', catalogBusy = false;
  const catalogKeys = { name: ['accounts','accountRef','选择账号'], shop: ['shops','shopRef','选择店铺'], product: ['products','productRef','选择产品'] };
  function mergeMembers() {
    const users = new Map(memberRows.map(m => [m.personId,m]));
    for (const account of catalog.accounts) if (account.ownerId) users.set(account.ownerId,{personId:account.ownerId,person:account.owner});
    members = [...users.values()].sort((a,b)=>a.person.localeCompare(b.person,'zh-CN'));
  }
  function catalogControl(r,key,attrs) {
    if (store?.mode !== 'feishu') return `<input ${attrs} value="${esc(r[key]??'')}" maxlength="80" ${key==='name'?'required':''}>`;
    const [group,ref,prompt] = catalogKeys[key], items = catalog[group];
    const match = r[ref] ? items.find(x=>x.id===r[ref]) : items.find(x=>x.name===r[key]);
    const legacy = !match && !!r[key];
    return `<select ${attrs} ${key==='name'?'required':''} data-original-name="${esc(r[key]??'')}" data-original-ref="${esc(r[ref]??match?.id??'')}"><option value="">${prompt}</option>${legacy?`<option value="legacy" selected>${esc(r[key])}（原值，资料未建立或已移除）</option>`:''}${items.map(x=>`<option value="${esc(x.id)}" ${x.id===match?.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select>`;
  }
  function readCatalog(input,key) {
    const [,ref] = catalogKeys[key];
    if (input.tagName !== 'SELECT') return {[key]:input.value};
    if (input.value==='legacy') return {[key]:input.dataset.originalName,...(input.dataset.originalRef?{[ref]:input.dataset.originalRef}:{})};
    if (!input.value) return {[key]:''};
    const item=catalog[catalogKeys[key][0]].find(x=>x.id===input.value);
    if (!item) throw Error('资料选项已变化，请刷新资料后重新选择');
    return {[key]:item.name,[ref]:item.id};
  }
  function draftRow(tr,strict = false) {
    const r = { id:tr.dataset.id };
    tr.querySelectorAll('[data-field]').forEach(input=>{
      const key=input.dataset.field;
      if (key==='owner') {
        if (strict) Object.assign(r,readOwner(input));
        else { const member=members.find(m=>m.personId===input.value); Object.assign(r,input.tagName==='SELECT'?{owner:member?.person??input.dataset.ownerName??'',ownerId:member?.personId??input.dataset.ownerId??''}:{owner:input.value}); }
      } else if (catalogKeys[key]) Object.assign(r,readCatalog(input,key));
      else r[key]=Number(input.value);
    });
    return r;
  }
  function restoreRenderedChoices(root) {
    for (const input of root.querySelectorAll('select')) input.value=input.querySelector('option[selected]')?.value??'';
  }
  async function refreshCatalog() {
    if (!store?.listCatalog || catalogBusy) return;
    const target=store;catalogBusy=true;renderStatus();
    try {
      const result=await target.listCatalog();
      if (target!==store) return;
      const drafts=[...$('plan-rows').children].map(tr=>draftRow(tr));
      catalog=result;catalogError='';mergeMembers();
      $('plan-rows').innerHTML=drafts.map(planRow).join('');
      restoreRenderedChoices($('plan-rows'));
      if (planLoaded) planTotal();
    } catch(e) { if(target===store)catalogError=e.message; }
    finally {catalogBusy=false;renderStatus();}
  }
  const selectedPerson = r => {
    if (!r) return {person:''};
    if (store?.mode !== 'feishu') return {person:r.owner,...(r.ownerId?{personId:r.ownerId}:{})};
    const named=members.filter(m=>m.person===r.owner);
    return members.find(m=>m.personId===r.ownerId) ?? (!r.ownerId && named.length===1 ? named[0] : {person:'',personId:''});
  };
  function ownerOptions(r) {
    const selected=selectedPerson(r).personId;
    return (selected ? '<option value="">选择负责人</option>' : `<option value="" selected>${r.owner ? esc('原负责人：'+r.owner+'，请选择飞书成员') : '选择负责人'}</option>`) + members.map(m=>`<option value="${esc(m.personId)}" ${m.personId===selected?'selected':''}>${esc(m.person)}${members.filter(x=>x.person===m.person).length>1?' · '+esc(m.personId.slice(-6)):''}</option>`).join('');
  }
  function ownerControl(r,attrs) {return store?.mode==='feishu' ? `<select ${attrs} required data-owner-name="${esc(r.owner)}" data-owner-id="${esc(r.ownerId??'')}">${ownerOptions(r)}</select>` : `<input ${attrs} value="${esc(r.owner)}" maxlength="80" required>`;}
  function readOwner(input) {const person=publicationPerson(input.value);return {owner:person.person,...(person.personId?{ownerId:person.personId}:{})};}
  async function refreshMembers() {
    if (!store?.listMembers || membersBusy) return;
    const target = store; membersBusy = true;
    try { const result = await target.listMembers(); if (target === store) { memberRows = result; mergeMembers(); membersError = ''; } }
    catch (e) { if (target === store) { memberRows = []; mergeMembers(); membersError = e.message; } }
    finally { membersBusy = false; doc.querySelectorAll('#plan-rows select[data-field="owner"]').forEach(el=>{const selected=members.find(m=>m.personId===el.value);el.innerHTML=ownerOptions({owner:selected?.person??el.dataset.ownerName,ownerId:selected?.personId??el.dataset.ownerId});});render(); }
  }
  function publicationPerson(value) {
    if (store.mode !== 'feishu') return { person: value.trim() };
    if (membersError) throw Error(membersError);
    const member = members.find(m => m.personId === value);
    if (!member) throw Error('请先选择飞书成员；没有名单时点「添加飞书成员」');
    return { ...member };
  }
  let businessTimer, businessBusy = false, businessMessage = '', lastBusinessRevision = '', lastBusinessAt = 0, businessWaiters=[];
  async function syncBusiness(force = false) {
    if (!store?.syncBusiness || !store.editable || !controller?.ready || controller.busy || importing || quickDraft) return;
    if(businessBusy){await new Promise(resolve=>businessWaiters.push(resolve));return syncBusiness(force);}
    const revision = boardRevision(controller.board) + ':' + today();
    if (!force && revision === lastBusinessRevision && Date.now() - lastBusinessAt < 60000) return;
    const target = store; businessBusy = true; businessMessage = '飞书业务表正在整理…'; $('business-status').textContent = businessMessage;
    try { await target.syncBusiness(today()); if (target === store) { businessMessage = '飞书计划、进度、明细已更新'; lastBusinessRevision = revision; lastBusinessAt = Date.now(); } }
    catch (e) { if (target === store) businessMessage = '业务表待同步：' + e.message; }
    finally { businessBusy = false; $('business-status').textContent = businessMessage;const waiters=businessWaiters;businessWaiters=[];waiters.forEach(resolve=>resolve()); }
  }
  const pendingMigrationKey = () => 'tiktok-board-migration:' + store.scope;
  const message = t => { $('toast').textContent = t; $('toast').classList.remove('hidden'); win.clearTimeout(toastTimer); toastTimer = win.setTimeout(() => $('toast').classList.add('hidden'), 6500); };
  const run = fn => async (...args) => { try { await fn(...args); } catch (e) { message(e.message); renderStatus(); } };
  const close = dialog => { if (dialog.open) dialog.close(); };
  function cancelRegistration() {
    if (registrationDirty && !win.confirm('有尚未保存的登记修改。放弃这些修改？')) return false;
    registrationDirty = false; editing = null; close($('publish-dialog')); return true;
  }
  function show(dialog) { if (!dialog.open) dialog.showModal(); }
  function writable() {
    if (!controller?.ready) throw Error('共享记录尚未完整加载，请先刷新');
    if (controller.busy || importing) throw Error('正在保存，请稍等');
    if (!store.editable) throw Error('当前飞书账号只有查看权限');
    if (controller.pending) throw Error('上次保存尚未确认，请先核对');
  }
  function renderStatus() {
    if (incoming?.native && controller?.ready) {
      try { importPreview(controller.board, incoming); $('import-confirm').dataset.blocked = 'false'; }
      catch (e) { $('import-confirm').dataset.blocked = 'true'; $('import-summary').textContent = e.message; }
    }
    const parts = [];
    if (store?.mode === 'demo') parts.push('本地演示：从空白开始，记录只在当前浏览器，不能用于团队协作。请自行填写计划。');
    if (controller?.error) parts.push(controller.error + '。已暂停新的保存，刷新成功后恢复。');
    if (controller?.pending) parts.push('上次保存结果尚未确认，请核对后继续，避免重复登记。');
    if (controller?.board.conflicts.length) parts.push(`${controller.board.conflicts.length}条操作未生效（同时修改或导入日期重合）。请在执行记录中核对，并按最新内容重新保存。`);
    if (controller && !store.editable && controller.ready) parts.push('当前账号为只读，请由多维表格管理员授予添加记录权限后再登记。');
    if (controller?.board.actions.length > 15000) parts.push('共享记录接近本版容量上限20,000条，请在升级容量前保持备份。');
    $('notice').textContent = parts.join('\n'); $('notice').classList.toggle('hidden', !parts.length);
    $('retry').classList.toggle('hidden', !controller?.pending);
    $('stop-pending').classList.toggle('hidden', !controller?.pending);
    const mode = store?.mode === 'feishu' ? '飞书共享记录' : '本地演示';
    $('sync-status').textContent = controller ? (controller.busy ? `${mode} · 正在保存…` : controller.ready ? `${mode} · ${store.editable ? '可登记' : '只读'} · ${controller.lastSync.toLocaleTimeString('zh-CN', { hour12: false })}已同步` : `${mode} · ${controller.error || '等待完整数据'}`) : '尚未连接飞书共享数据';
    const disabled = !controller?.ready || !store?.editable || controller.busy || !!controller.pending || importing;
    doc.querySelectorAll('[data-write],#save-plan,#add-account,#plan-reset,#import-confirm,dialog form button[type=submit]').forEach(b => b.disabled = disabled || b.dataset.blocked === 'true');
    $('refresh').disabled = !!controller?.busy || importing || connecting;
    $('retry').disabled = !!controller?.busy || importing;
    $('stop-pending').disabled = !!controller?.busy || importing || !store?.editable;
    $('business-status').textContent = store?.mode === 'feishu' ? businessMessage : '';
    $('business-button').classList.toggle('hidden', store?.mode !== 'feishu');
    $('member-controls').classList.toggle('hidden', store?.mode !== 'feishu');
    $('member-status').textContent = membersError || (members.length ? '已读取' + members.length + '位飞书成员' : '先添加飞书成员，再选择负责人');
    $('plan-member-status').textContent=$('member-status').textContent;
    $('plan-member-controls').classList.toggle('hidden',store?.mode!=='feishu');
    $('plan-add-member').disabled=membersBusy||disabled; $('plan-refresh-members').disabled=membersBusy;
    $('add-member').disabled = membersBusy || disabled;
    $('refresh-members').disabled = membersBusy;
    $('quick-save-bar').classList.toggle('hidden',!quickDraft);
    $('quick-save-note').textContent=quickDraft?(quickCurrent()?`${quickDraft.date} · ${quickDraft.changes.length}个账号待保存；汇总按已保存数量统计`:quickIssues().join('；')+'。暂存保留，请核对后继续。'):'';
    $('quick-save').disabled=disabled||!quickCurrent();$('quick-discard').disabled=!!controller?.busy;
    $('quick-review').classList.toggle('hidden',!quickDraft||quickCurrent());$('quick-review').disabled=disabled;
    $('quick-leave-save').disabled=disabled||!quickCurrent();
    if(quickDraft)doc.querySelectorAll('[data-write]:not([data-step])').forEach(button=>button.disabled=true);
    if(quickDraft&&!quickCurrent())doc.querySelectorAll('[data-step]').forEach(button=>button.disabled=true);
    $('catalog-controls').classList.toggle('hidden',store?.mode!=='feishu');
    $('catalog-refresh').disabled=catalogBusy;
    $('catalog-status').textContent=catalogBusy?'正在读取飞书资料…':catalogError||`账号${catalog.accounts.length} · 店铺${catalog.shops.length} · 产品${catalog.products.length}`;
    if(catalogBusy)$('save-plan').disabled=true;
  }
  function options(el, values) {
    const previous = el.value, next = '<option value="">全部</option>' + [...new Set(values)].filter(Boolean).sort().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (el.innerHTML !== next) { el.innerHTML = next; el.value = values.includes(previous) ? previous : ''; }
  }
  function filtered(rows) {
    return rows.filter(r => {
      const s = stats([r]), state = !s.active ? 'paused' : s.complete ? 'complete' : 'pending';
      return (!$('owner-filter').value || r.owner === $('owner-filter').value) && (!$('shop-filter').value || r.shop === $('shop-filter').value) && (!$('status-filter').value || state === $('status-filter').value);
    });
  }
  function renderBoard() {
    const focus=doc.activeElement?.dataset?.step?{...doc.activeElement.dataset}:null;
    const b = controller.board, savedRows = dayAt(b, date), rows = savedRows, s = stats(savedRows), p = planAt(b, date);
    const delta=k=>quickDraft?.date===date?quickDraft.changes.reduce((n,c)=>n+c[k],0):0;
    const deltaLabel=k=>delta(k)?` · 待保存${delta(k)>0?'＋':'−'}${Math.abs(delta(k))}`:'';
    $('date').value = date;
    const period = p.plan, summary = cycleSummary(b, period);
    const stateLabel = { active: '执行中', ended: '已结束', deleted:'已删除', 'needs-period': '待设置周期', upcoming: '尚未开始', empty: '暂无计划' }[p.state];
    const periodTitle = p.title || (p.from ? p.from + ' 开始的计划' : '周期计划');
    $('cycle-overview').innerHTML = `<div class="section-header"><div><span class="eyebrow">周期计划</span><h2>${esc(periodTitle)} <span class="badge ${p.state === 'active' ? 'complete' : 'paused'}">${stateLabel}</span></h2><p class="muted">${p.until ? `${p.from} — ${p.until} · 共${summary?.days ?? cycleDays(p.from,p.until)}天` : p.state === 'needs-period' ? '请补充结束日期。' : p.next ? `已安排${p.next.date} — ${p.next.payload.endDate || '待设置结束日期'}` : ''}</p></div><div class="actions">${p.state === 'needs-period' ? `<button class="btn btn-primary" data-configure-cycle="${p.from}">补充计划周期</button>` : `<button class="btn" data-next-cycle="${p.state==='deleted'?'':(p.from ?? '')}">${p.until && p.state!=='deleted' ? '复制为下一周期' : '创建周期计划'}</button>`}</div></div>${summary ? `<div class="cycle-totals"><span>周期视频（已保存） <strong>${summary.video} / ${summary.targetVideo}</strong></span><span>周期图文（已保存） <strong>${summary.photo} / ${summary.targetPhoto}</strong></span><span>已登记 <strong>${summary.recordedDays} / ${summary?.days ?? cycleDays(p.from,p.until)} 天</strong></span><span>周期完成率（已保存） <strong>${summary.target ? summary.pct + '%' : '—'}</strong></span></div><div class="progress"><span style="width:${summary.target ? summary.pct : 0}%"></span></div>` : ''}`;
    const stale=date===today()&&p.state==='active'&&b.days.has(date)&&b.days.get(date).planId!==p.plan.id;
    $('day-plan-update').classList.toggle('hidden',!stale);
    const ids=new Set(rows.map(r=>r.id)),detached=[...b.publications.values()].filter(e=>e.date===date&&!b.voids.has(e.id)&&!ids.has(effectivePublication(b,e).accountId)&&effectivePublication(b,e).video+effectivePublication(b,e).photo>0);
    $('detached-note').textContent=detached.length?`${detached.length}条登记所属账号已移出当天计划，未计入下方任务完成量。可在「当天登记明细」查看或删除。`:'';
    $('detached-note').classList.toggle('hidden',!detached.length);
    const removed=p.accounts.filter(r=>b.deletedDayAccounts.has(date+'/'+r.id));
    $('removed-day').classList.toggle('hidden',!removed.length);
    $('removed-day').innerHTML=removed.length?`当天已删除${removed.length}个账号任务；周期计划保留。误删可恢复任务后重新登记：<div>${removed.map(r=>`<button class="btn btn-sm" data-write data-restore-day="${esc(r.id)}">恢复 ${esc(r.name)} 的当天任务</button>`).join('')}</div>`:'';
    options($('owner-filter'), rows.map(r => r.owner)); options($('shop-filter'), rows.map(r => r.shop));
    const v = filtered(rows);
    $('metrics').innerHTML = [
      [s.target ? `${s.pct}%` : '—', '已保存完成率', s.active ? `达标 ${s.complete}/${s.active} 个账号` : '当天暂无发布任务', `<div class="progress"><span style="width:${s.target ? s.pct : 0}%"></span></div>`],
      [`${s.video} <small>/ ${s.targetVideo}</small>`, '已保存视频', `尚缺 ${s.missingVideo} 条视频${deltaLabel('video')}`, ''],
      [`${s.photo} <small>/ ${s.targetPhoto}</small>`, '已保存图文', `尚缺 ${s.missingPhoto} 条图文${deltaLabel('photo')}`, ''],
      [String(s.missingVideo + s.missingPhoto), '待完成内容', `${rows.length}个账号 · 目标${s.target}条`, '']
    ].map(([value, title, sub, progress]) => `<div class="metric-card"><div class="metric-value">${value}</div><div class="metric-title">${title}</div><div class="metric-sub">${sub}</div>${progress}</div>`).join('');
    $('board-rows').innerHTML = v.map(r => {
      const c = counts(r), s = stats([r]), state = !s.active ? 'paused' : s.complete ? 'complete' : 'pending';
      const step = content => {
        const change=quickDraft?.date===date?quickDraft.changes.find(x=>x.accountId===r.id)?.[content]??0:0;
        const mine = c[content]+(quickCurrent()?change:0), label = content === 'video' ? '视频' : '图文';
        return `<div class="stepper"><button type="button" data-write data-step="-1" data-id="${esc(r.id)}" data-content="${content}" data-blocked="${mine < 1 || date > today()}" aria-label="${esc(r.name+' '+label+'减少1条')}">−</button><output aria-label="${esc(r.name+' '+label+(change&&quickCurrent()?'预计数量':'已保存数量'))}">${mine}</output><button type="button" data-write data-step="1" data-id="${esc(r.id)}" data-content="${content}" data-blocked="${!selectedPerson(r).person || date > today()}" aria-label="${esc(r.name+' '+label+'增加1条')}">＋</button><span class="target">/ ${r[content]}</span></div><small class="quantity-state">已保存 ${c[content]}${change?` · <strong>待保存${change>0?'＋':'−'}${Math.abs(change)}</strong>`:''}</small>`;
      };
      return `<tr><td data-label="账号 / 店铺" class="account-cell"><div class="account-name">${esc(r.name)}</div><div class="shop-name">${esc(r.shop || '未设店铺')}</div></td><td data-label="负责人">${store.mode==='feishu'?ownerControl(r,`data-blocked="${date>today()}" data-row-owner="${esc(r.id)}" aria-label="${esc(r.name)}负责人" data-write`):esc(r.owner)}</td><td data-label="产品">${esc(r.product || '待确定')}${r.note ? `<div class="row-note">${esc(r.note)}</div>` : ''}</td><td data-label="视频 / 每天目标" class="count count-cell">${step('video')}</td><td data-label="图文 / 每天目标" class="count count-cell">${step('photo')}</td><td data-label="当天状态"><span class="badge ${state}">${state === 'paused' ? '无任务' : state === 'complete' ? '已达标' : '未达标'}</span><div class="progress"><span style="width:${s.target ? s.pct : 0}%"></span></div></td><td data-label="操作" class="actions-cell"><div class="row-actions"><button class="btn btn-primary btn-sm" data-write data-publish="${esc(r.id)}" data-blocked="${date > today()}">代做</button><button class="btn btn-sm" data-entries="${esc(r.id)}">明细</button></div></td></tr>`;
    }).join('') || `<tr><td class="empty" colspan="7">${rows.length ? '没有符合筛选的账号' : p.state === 'needs-period' ? '请先补充计划的开始和结束日期。' : '当天没有任务。'}</td></tr>`;
    $('contributions').innerHTML = people(savedRows).map(p => `<div class="person-card"><strong>${esc(p.person)}</strong><span>视频 ${p.video} · 图文 ${p.photo}</span></div>`).join('') || '<p class="muted">当天还没有已保存的发布登记。</p>';
    const names = [...rows.map(r => r.owner), ...people(rows).map(p => p.person)];
    $('people-list').innerHTML = [...new Set(names)].map(p => `<option value="${esc(p)}">`).join('');
    if(focus)[...doc.querySelectorAll('[data-step]')].find(el=>el.dataset.step===focus.step&&el.dataset.id===focus.id&&el.dataset.content===focus.content)?.focus({preventScroll:true});
  }
  function planRow(r) {
    return `<tr data-id="${esc(r.id)}" data-original-id="${esc(r.id)}">${[['name','账号名称'],['shop','店铺'],['owner','负责人'],['product','发布产品'],['video','每天视频目标'],['photo','每天图文目标']].map(([key,label]) => `<td data-label="${label}">${key==='owner'?ownerControl(r,`data-field="owner" aria-label="负责人"`):catalogKeys[key]?catalogControl(r,key,`data-field="${key}" aria-label="${label}"`):`<input data-field="${key}" value="${esc(r[key])}" type="number" min="0" max="10000" step="1" required aria-label="${label}">`}</td>`).join('')}<td data-label="操作" class="actions-cell"><button type="button" class="text-button danger" data-remove="${esc(r.id)}" data-write>删除账号</button></td></tr>`;
  }
  function loadPlan(at = date) {
    const b = controller.board, p = planAt(b, at), exact = b.plans.get(at) ?? (p.state === 'active' || p.state === 'needs-period' ? p.plan : null);
    $('plan-date').value = exact?.date ?? at; $('plan-end').value = exact?.payload.endDate ?? addDays($('plan-date').value, 6); $('plan-title').value = exact?.payload.title ?? '';
    const n = cycleDays($('plan-date').value, $('plan-end').value); $('plan-duration').value = [7, 14, 30].includes(n) ? String(n) : 'custom';
    const started=!!exact&&exact.date<today();$('plan-date').disabled=started;$('plan-end').disabled=started;$('plan-duration').disabled=started;
    $('save-plan').dataset.blocked=String(!!exact?.payload.endDate&&exact.payload.endDate<today());
    planExpected = b.planHead; planDirty = false; planLoaded = true;
    $('plan-rows').innerHTML = (exact?.payload.accounts ?? []).map(planRow).join('');
    restoreRenderedChoices($('plan-rows'));
    planTotal(); renderStatus();
  }
  function newCycle(source = null) {
    if(askQuick(()=>newCycle(source)))return;
    if (planDirty && !win.confirm('有尚未保存的计划。放弃这些修改并新建周期？')) return;
    const start = source?.payload.endDate ? addDays(source.payload.endDate, 1) : today();
    const length = source?.payload.endDate ? cycleDays(source.date, source.payload.endDate) : 7;
    $('plan-date').value = start; $('plan-end').value = addDays(start, length - 1); $('plan-title').value = ''; $('plan-duration').value = [7,14,30].includes(length) ? String(length) : 'custom';
    for(const id of ['plan-date','plan-end','plan-duration'])$(id).disabled=false;$('save-plan').dataset.blocked='false';
    $('plan-rows').innerHTML = (source?.payload.accounts ?? []).map(planRow).join('');
    restoreRenderedChoices($('plan-rows'));
    planExpected = controller.board.planHead; planDirty = true; planLoaded = true;
    switchTab('plan'); planTotal(); renderStatus();
  }
  function readPlan() {
    if(store.mode==='feishu'&&catalogError)throw Error(catalogError);
    return config([...$('plan-rows').children].map(tr=>draftRow(tr,true)));
  }
  function planTotal() {
    let days;
    try { days = cycleDays($('plan-date').value, $('plan-end').value); $('cycle-form-note').textContent = `共${days}天`; } catch (e) { $('cycle-form-note').textContent = e.message; }
    try {
      const cfg=readPlan(),s=stats(cfg.map(r=>({...r,executions:[]}))),start=$('plan-date').value,end=$('plan-end').value,existing=controller.board.plans.get(start),effectiveDate=existing&&start<today()?today():start;
      let total=days?{targetVideo:days*s.targetVideo,targetPhoto:days*s.targetPhoto}:null;
      if(existing&&days&&effectiveDate<=end){const a=makeAction(controller.board,'plan',start,{accounts:cfg,expected:planExpected,endDate:end,title:$('plan-title').value,effectiveDate},store.actor,'preview-plan');const preview=project([...controller.board.actions,a]);if(preview.accepted.has(a.id))total=cycleSummary(preview,preview.plans.get(start));else throw Error(preview.conflicts.find(c=>c.id===a.id)?.reason);}
      $('plan-total').textContent=`${cfg.length}个账号 · 每天视频${s.targetVideo} / 图文${s.targetPhoto}${total?` · 周期累计目标：视频${total.targetVideo} / 图文${total.targetPhoto}`:''}`;
      if(days)$('cycle-form-note').textContent=`共${days}天${existing&&start<=today()?` · 调整从${today()}生效，过去日期保留`:''}`;
    } catch(e) { $('plan-total').textContent=e.message||'请补全账号名称、负责人和每天目标'; }
    $('plan-note').textContent = planDirty ? '有未保存的计划修改' : ''; $('plan-note').classList.toggle('hidden', !planDirty);
    $('delete-plan').classList.toggle('hidden',!controller.board.plans.has($('plan-date').value));
  }
  function renderHistory() {
    const b = controller.board, dates = executionDates(b).filter(d => d >= $('history-from').value && d <= $('history-to').value).reverse();
    $('history-rows').innerHTML = dates.map(d => {
      const s = stats(dayAt(b, d));
      const p = planAt(b, d);
      return `<tr><td data-label="日期 / 周期">${d}<small class="shop-name">${esc(p.title || (p.until ? p.from + ' — ' + p.until : '旧版登记'))}</small></td><td data-label="视频 / 目标">${s.video} / ${s.targetVideo}</td><td data-label="图文 / 目标">${s.photo} / ${s.targetPhoto}</td><td data-label="达标账号">${s.complete} / ${s.active}</td><td data-label="尚缺">视频${s.missingVideo} · 图文${s.missingPhoto}</td><td data-label="登记情况"><span class="badge ${hasRegistration(b,d) ? 'complete' : ''}">${hasRegistration(b,d) ? '已登记' : '未登记'}</span></td><td data-label="操作"><button class="text-button" data-date="${d}">查看当天</button></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">所选日期范围内没有计划或登记。</td></tr>';
    if (b.conflicts.length) $('history-rows').innerHTML += b.conflicts.map(c => `<tr><td>${c.date}</td><td colspan="5"><span class="badge">未生效操作</span> ${esc(c.reason)}<br><small>${esc(c.id)}</small></td></tr>`).join('');
  }
  function renderEntries() {
    const b = controller.board, r = dayAt(b, date).find(r => r.id === entriesAccount);
    $('entries-title').textContent = `${date} · ${r?.name??'当天登记明细'}`;
    const entries = [...b.publications.values()].filter(e => e.date === date && (!entriesAccount||effectivePublication(b,e).accountId===entriesAccount) && !b.deletedEntries.has(e.id)).reverse();
    $('entries').innerHTML = entries.map(e => {
      const voided = b.voids.has(e.id), why = b.actions.filter(a => a.kind === 'void' && a.payload.target === e.id && b.accepted.has(a.id)).map(a => a.payload.reason).join('；');
      const current = effectivePublication(b, e), reduced = b.reductions.get(e.id);
      return `<div class="entry ${voided ? 'voided' : ''}"><div><p><strong>${esc(current.account?.name??current.accountId)}</strong> · ${delegatedPublication(current)?'代做登记':'本人登记'} · 视频${voided ? 0 : current.video} · 图文${voided ? 0 : current.photo}${e.imported ? ' · 历史导入' : ''}</p><p class="muted">登记时安排：${current.account?esc((current.account.shop||'未记录店铺')+' · '+(current.account.product||'未记录计划产品')+' · 负责人 '+current.account.owner):'历史字段缺失，未回填当前计划'}<br>完成人：${esc(current.person)}</p><p class="muted">${esc(current.note)}</p>${reduced ? `<p class="muted">数量更正：视频${reduced.video}、图文${reduced.photo}</p>` : ''}${b.edits.has(e.id)?'<p class="muted">已修改登记</p>':''}<p class="muted">${new Date(e.at).toLocaleString('zh-CN')}${voided ? ' · 已撤销：' + esc(why) : ''}</p></div><div class="row-actions">${!voided?`<button class="btn btn-sm" data-write data-edit-entry="${esc(e.id)}">修改登记</button>`:''}<button class="btn btn-sm danger" data-write data-delete-entry="${esc(e.id)}">删除记录</button></div></div>`;
    }).join('') || '<p class="muted">还没有发布登记。</p>';
  }
  function render() {
    if (!controller) { renderStatus(); return; }
    if (followToday) date = today();
    $('onboarding').classList.add('hidden'); $('workspace').classList.remove('hidden');
    renderBoard(); renderHistory();
    $('versions').innerHTML = [...controller.board.plans.values()].sort((a, b) => b.date.localeCompare(a.date)).map(p => `<div class="version-card"><button class="btn" data-plan-date="${p.date}">${esc(p.payload.title || '周期计划')}<small>${p.date} — ${p.payload.endDate ?? '待设置结束日期'}<br>${p.payload.accounts.length}个账号 · ${!p.payload.endDate ? '待设置周期' : today() < p.date ? '未开始' : today() > p.payload.endDate ? '已结束' : '执行中'}</small></button><button class="text-button danger" data-write data-delete-plan="${p.date}">删除周期</button></div>`).join('') || '<p class="muted">尚未保存周期计划。</p>';
    if (tab === 'plan' && !planLoaded) loadPlan();
    if ($('entries-dialog').open) renderEntries();
    renderStatus();
    if (store?.syncBusiness && !businessBusy) { win.clearTimeout(businessTimer); businessTimer = win.setTimeout(syncBusiness, 700); }
  }
  function switchTab(next) {
    if(next!==tab&&askQuick(()=>switchTab(next)))return;
    tab = next;
    for (const t of ['board', 'plan', 'history']) { $('tab-' + t).classList.toggle('hidden', t !== tab); doc.querySelector(`[data-tab="${t}"]`).classList.toggle('active', t === tab); }
    if (controller) render();
  }
  function row(id) { const r = dayAt(controller.board, date).find(r => r.id === id); if (!r) throw Error('该账号不在当前日期'); return r; }
  function snapshot() { return config(dayAt(controller.board, date)); }
  function openPublish(id) {
    if(askQuick(()=>openPublish(id)))return;
    writable(); if (date > today()) throw Error('未来日期尚未开始，请到当天再登记'); const r = row(id);
    editing = { id, date, snapshot: snapshot(), head:r.head }; $('publish-form').reset(); registrationDirty=false;
    $('entry-arrangement').classList.add('hidden');$('correct-arrangement').checked=false;$('entry-details').querySelectorAll('input,select').forEach(input=>input.disabled=true);
    $('publish-title').textContent = `登记代做 · ${date} · ${r.name}`;
    $('publish-person-control').innerHTML=ownerControl({owner:'',ownerId:''},'name="person" aria-label="代做人"').replaceAll('选择负责人','选择代做人');
    $('publish-person-row').hidden=false;$('publish-person-label').textContent='代做人';$('publish-submit').textContent='保存代做登记';show($('publish-dialog'));
  }
  function openEntryEdit(id) {
    if(askQuick(()=>openEntryEdit(id)))return;
    writable();const entry=controller.board.publications.get(id);
    if(!entry||controller.board.voids.has(id)||controller.board.deletedEntries.has(id))throw Error('记录已被删除或撤销，请重新打开明细');
    const current=publicationState(controller.board,entry),effective=effectivePublication(controller.board,entry);editing={target:id,date:entry.date,expected:current,expectedAccount:clone(effective.account),delegate:delegatedPublication(effective)};registrationDirty=false;
    $('publish-form').reset();$('publish-title').textContent=`修改登记 · ${entry.date} · ${entry.account?.name??'账号'}`;
    $('publish-person-row').hidden=!editing.delegate;$('publish-person-label').textContent='代做人';$('publish-person-control').innerHTML=editing.delegate?ownerControl({owner:current.person,ownerId:current.personId},'name="person" aria-label="代做人"').replaceAll('选择负责人','选择代做人'):'';
    for(const key of ['video','photo','note'])$('publish-form').elements.namedItem(key).value=current[key];
    $('entry-arrangement').classList.remove('hidden');$('correct-arrangement').checked=false;$('entry-arrangement-fields').hidden=true;
    const choices=new Map(dayAt(controller.board,entry.date).map(r=>[r.id,config([r])[0]]));if(effective.account)choices.set(effective.accountId,effective.account);
    editing.accounts=[...choices.values()];$('entry-account').innerHTML=editing.accounts.map(r=>`<option value="${esc(r.id)}" ${r.id===effective.accountId?'selected':''}>${esc(r.name)}</option>`).join('');$('entry-account').value=effective.accountId;
    renderEntryArrangement(effective.account);
    $('publish-submit').textContent='保存修改';show($('publish-dialog'));
  }
  function renderEntryArrangement(account){
    if(!account){$('entry-details').textContent='历史安排缺失，请保留原归属，先核对来源';return;}
    $('entry-details').innerHTML=['shop','product'].map(key=>`<label>${key==='shop'?'店铺':'登记时计划产品'}${catalogControl(account,key,`data-entry-field="${key}" aria-label="纠错${key==='shop'?'店铺':'计划产品'}"`)}</label>`).join('')+`<label>登记时负责人${ownerControl(account,'data-entry-field="owner" aria-label="纠错负责人"')}</label>`;
    restoreRenderedChoices($('entry-details'));
    $('entry-details').querySelectorAll('input,select').forEach(input=>input.disabled=!$('correct-arrangement').checked);
  }
  async function save(kind, at, payload, key) {
    const action = makeAction(controller.board, kind, at, payload, store.actor, key);
    return controller.send(action);
  }
  function planPayload(accounts,source) {const at=today();return {accounts,expected:controller.board.planHead,endDate:source.payload.endDate,title:source.payload.title??'',effectiveDate:source.date>at?source.date:at,...(source.date<=at&&at<=source.payload.endDate?{applyDate:at,applyHeads:dayHeads(controller.board,at)}:{})};}
  function confirmDelete(target,title,detail) {writable();deleteTarget=target;$('delete-title').textContent=title;$('delete-detail').textContent=detail;show($('delete-dialog'));renderStatus();}
  async function finishBusiness(){await syncBusiness(true);if(store.mode==='feishu'&&!businessMessage.includes('已更新'))message('看板已保存，'+businessMessage);}
  async function connect() {
    if(askQuick(connect))return;
    if (connecting || controller?.busy || importing) return;
    if (controller?.pending) throw Error('请先核对当前模式的上次保存，再切换连接');
    if (planDirty && !win.confirm('有尚未保存的计划。放弃这些修改并重新连接飞书？')) return;
    connecting = true; $('connect').disabled = true;
    const epoch = ++connectionEpoch;
    let connectionTimer;
    try {
      if (win.self === win.top) throw Error('未在飞书多维表格插件中打开，普通网页不能读取团队共享记录');
      const attempt = (async () => { const next = createFeishuStore(await loadSDK()); return { next, result: await next.connect() }; })();
      const { next, result } = await Promise.race([attempt, new Promise((_, reject) => { connectionTimer = win.setTimeout(() => reject(Error('飞书连接超时。请确认从多维表格插件打开此页面')), 10000); })]);
      if (epoch !== connectionEpoch) return;
      if (result.needsSetup) {
        offStore?.(); win.clearInterval(pollTimer); controller = null; store = next;
        $('workspace').classList.add('hidden'); $('onboarding').classList.remove('hidden'); $('setup-table').classList.remove('hidden');
        $('onboarding-title').textContent = result.upgrade ? '现有共享表需要管理员升级' : '已连接飞书，等待创建共享数据表';
        $('setup-table').textContent = result.upgrade ? '管理员升级现有共享表' : '创建共享数据表';
        $('onboarding-copy').textContent = result.upgrade ? '请管理员在现有共享表添加「提交序号」自动编号字段，仅保留递增数字规则（9位），从1开始；不改已有字段或行。安装版SDK不能设置编号规则，请按接入说明配置后重连，并关闭旧版页面。' : `将在当前多维表格中创建「${TABLE_NAME}」，不导入预置数据。随后管理员需按接入说明配置「提交序号」自动编号字段。`;
      } else await activate(next);
    } catch (e) {
      if (epoch !== connectionEpoch) return;
      if (!controller) { $('onboarding-copy').textContent = e.message + '。可先体验演示或按照接入说明配置飞书插件。'; $('setup-table').classList.add('hidden'); }
      else message(e.message);
    } finally { win.clearTimeout(connectionTimer); connecting = false; $('connect').disabled = false; renderStatus(); }
  }
  async function activate(next) {
    const fresh = new Controller(next, win.localStorage, render);
    await fresh.refresh(); // Keep the previous mode intact if connecting or reading fails.
    offStore?.(); win.clearInterval(pollTimer); win.clearTimeout(refreshTimer);
    controller = fresh; store = next; planLoaded = false; planDirty = false; businessMessage = ''; lastBusinessRevision = ''; deleteTarget=null; members = []; memberRows=[];membersError = '';catalog={accounts:[],shops:[],products:[]};catalogError='';quickDraft=null;
    const cachedQuick=win.sessionStorage.getItem(quickKey())??(!win.sessionStorage.getItem(quickKey()+':legacy-seen')?win.localStorage.getItem(quickKey()):null);
    if(cachedQuick){const cached=JSON.parse(cachedQuick);if(!validDate(cached.date)||!Array.isArray(cached.changes)||!Array.isArray(cached.snapshot))throw Error('暂存登记格式无效，请核对本地草稿');quickDraft={...cached,...(cached.v!==7?{requiresReview:true}:{})};persistQuick();win.sessionStorage.setItem(quickKey()+':legacy-seen','true');date=cached.date;followToday=date===today();}
    offStore = store.subscribe(() => {
      win.clearTimeout(refreshTimer);
      refreshTimer = win.setTimeout(() => { if (!controller.busy && !importing) controller.refresh().catch(() => {}); }, 350);
    });
    pollTimer = win.setInterval(() => { if (doc.visibilityState !== 'hidden' && !controller.busy && !importing) { controller.refresh().catch(() => {}); refreshMembers(); } }, 15000);
    render();
    await refreshMembers();
    await refreshCatalog();
    const unfinished = win.localStorage.getItem(pendingMigrationKey());
    if (unfinished) {
      incoming = JSON.parse(unfinished); show($('data-dialog'));
      try { preview(); message('上次导入尚未完成，请核对后继续或放弃剩余导入'); }
      catch (e) { $('import-preview').classList.remove('hidden'); $('import-summary').textContent = e.message; $('import-confirm').dataset.blocked = 'true'; renderStatus(); message(e.message); }
    }
  }
  async function demo() {
    if(askQuick(demo))return;
    connectionEpoch++;
    connecting = false;
    const next = createDemoStore(win.localStorage);
    await activate(next);
    message('已进入本地演示，未接入团队共享数据');
  }
  function download(contents, filename, type) {
    const url = win.URL.createObjectURL(new win.Blob([contents], { type })), a = doc.createElement('a');
    a.href = url; a.download = filename; a.click(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  }
  function preview() {
    $('import-preview').classList.remove('hidden');
    let p;
    try { p = importPreview(controller.board, incoming); $('import-confirm').dataset.blocked = 'false'; }
    catch (e) { $('import-confirm').dataset.blocked = 'true'; $('import-summary').textContent = e.message; throw e; }
    if (!incoming.native && incoming.jobId && controller.board.planHead?.startsWith('migration:' + incoming.jobId + '/plan-')) p.plans = incoming.plans.filter(p => !controller.board.actions.some(a => a.id === 'migration:' + incoming.jobId + '/plan-' + p.date)).length;
    $('import-preview').classList.remove('hidden'); $('import-progress').textContent = '';
    $('import-summary').textContent = incoming.native ? `本版备份：${p.operations.length}条待恢复操作。仅空白共享表或同一任务连续前缀可恢复；任何其他服务器记录都会暂停任务。备份旧ID映射为本任务新ID，不插入原历史。` : `旧版备份：可追加${p.days.length}个日期，跳过${p.skipped}个已存在日期。可导入${p.plans}份计划。原网页旧记录不能恢复未保存过的多人分配。`;
    $('import-plan-option').classList.toggle('hidden', !!incoming.native);
    $('import-plans').disabled = true; $('import-plans').checked = false;
    if (!incoming.native && p.plans) $('import-summary').textContent += ' 旧计划没有结束日期，不自动沿用；历史登记导入后，请另建周期计划。';
    renderStatus();
  }
  async function doImport() {
    writable(); if (!incoming) return;
    const job = clone(incoming), includePlans = $('import-plans').checked;
    // Stable IDs also survive a partially completed import followed by a browser reload.
    if (!job.jobId) job.jobId = crypto.randomUUID();
    job.includePlans = includePlans;
    await controller.refresh();
    importPreview(controller.board, job); // Confirmation uses the latest complete chain.
    incoming = job; win.localStorage.setItem(pendingMigrationKey(), JSON.stringify(job));
    importing = true; renderStatus();
    let saved = 0;
    try {
      const sendOperation = async (kind, at, payload, suffix) => {
        await controller.refresh();
        const key = 'migration:' + job.jobId + '/' + suffix;
        if (controller.board.actions.some(a => a.id === key)) return;
        await save(kind, at, payload, key); saved++; $('import-progress').textContent = `已追加${saved}条，正在继续…`;
      };
      if (job.native) {
        while (true) {
          await controller.refresh();
          const p = importPreview(controller.board, job);
          if (!p.operations.length) break;
          const action = makeRestoreAction(job, controller.board.actions.length, controller.receiptEnd, controller.board);
          await controller.send(action, { restore: true, restoreJobKey: pendingMigrationKey() });
          saved++; $('import-progress').textContent = `已恢复${saved}条操作…`;
        }
      } else {
        const initialPlanWasEmpty = !controller.board.plans.size || controller.board.actions.some(a => a.id.startsWith('migration:' + job.jobId + '/plan-'));
        if (job.includePlans && initialPlanWasEmpty) for (const p of job.plans) {
          if (controller.board.planHead && !controller.board.planHead.startsWith('migration:' + job.jobId + '/plan-')) throw Error('共享计划已被其他同事修改。请重新预览，取消导入计划后继续导入历史');
          throw Error('旧计划缺少结束日期，请取消导入计划，只导入历史登记，再创建周期计划');
        }
        for (const d of job.days) {
          await controller.refresh();
          if (controller.board.days.has(d.date)) continue;
          await sendOperation('seed', d.date, { rows: d.rows, source: '旧版JSON备份' }, 'day-' + d.date);
        }
      }
      win.localStorage.removeItem(pendingMigrationKey()); incoming = null; $('import-preview').classList.add('hidden');
      planLoaded = false; message(`导入完成，新增${saved}条操作。请核对历史与实际贡献。`);
    } finally { importing = false; render(); }
  }

  $('date').value = date; $('history-from').value = date.slice(0, 8) + '01'; $('history-to').value = date;
  $('connect').onclick = run(connect); $('reconnect-data').onclick = run(async () => { close($('data-dialog')); await connect(); });
  $('demo').onclick = run(demo);
  $('expand').onclick = run(async () => {
    if (doc.fullscreenElement) { await doc.exitFullscreen(); return; }
    if (doc.fullscreenEnabled && doc.documentElement.requestFullscreen) { await doc.documentElement.requestFullscreen(); return; }
    if (store?.expand) { await store.expand(); message('已请求展开飞书插件'); return; }
    message('当前容器没有开放全屏；窄栏中的加减按钮仍可直接使用。');
  });
  doc.addEventListener('fullscreenchange', () => { $('expand').textContent = doc.fullscreenElement ? '退出全屏' : '展开看板'; });
  $('setup-table').onclick = run(async () => {
    $('setup-table').disabled = true;
    try { await store.initialize(); await activate(store); message('共享数据表已创建，请填写发布计划'); switchTab('plan'); }
    finally { $('setup-table').disabled = false; }
  });
  $('refresh').onclick = run(async () => { if (controller) { await controller.refresh(); await refreshMembers(); message('已读取最新完整记录'); } else await connect(); });
  $('add-member').onclick = run(async () => { writable(); if (doc.fullscreenElement) await doc.exitFullscreen(); await store.chooseMember(); await refreshMembers(); message('选好成员后，如名单尚未更新，点「刷新成员」'); });
  $('refresh-members').onclick = run(refreshMembers);
  $('manage-members').onclick = run(async () => { await store.openMembers(); });
  $('plan-add-member').onclick=$('add-member').onclick;$('plan-refresh-members').onclick=$('refresh-members').onclick;$('plan-manage-members').onclick=$('manage-members').onclick;
  $('all-entries').onclick=()=>{entriesAccount=null;renderEntries();show($('entries-dialog'));renderStatus();};
  $('apply-day-plan').onclick=run(async()=>{writable();const p=planAt(controller.board,today()).plan;if(!p?.payload.endDate)throw Error('请先保存周期计划');await save('plan',p.date,planPayload(p.payload.accounts,p));date=today();followToday=true;render();await finishBusiness();message('今天已同步最新计划，原有发布登记保留');});
  $('retry').onclick = run(async () => {
    const p = controller.pending; if (!p) return;
    const result = p.kind === 'stop' ? await controller.stopPending() : await controller.send(p);
    if(quickDraft?.actionId===(p.kind==='stop'?p.payload.target:p.id)){
      if(result==='stopped'){delete quickDraft.actionId;persistQuick();}
      else{discardQuick();await finishBusiness();}
    }
    registrationDirty=false;editing=null;close($('publish-dialog'));
    message(result === 'restored' ? '原操作已随备份恢复，恢复后的数量保留；旧请求迟到不会重复登记，请核对明细。' : result === 'saved' ? '原请求已在停止前生效，数量保留；请核对明细。' : result === 'stopped' ? '停止已确认，原请求未生效，迟到也不会生效。' : '上次保存已确认，请核对明细');
  });
  $('stop-pending').onclick = run(async () => {
    if (!controller?.pending) return;
    const original=controller.pending.kind==='stop'?controller.pending.payload.target:controller.pending.id;
    const result = await controller.stopPending();
    if(quickDraft?.actionId===original){if(result==='stopped'){delete quickDraft.actionId;persistQuick();}else{discardQuick();await finishBusiness();}}
    registrationDirty=false;editing=null;close($('publish-dialog'));
    message(result === 'restored' ? '原操作已随备份恢复，恢复后的数量保留；旧请求迟到不会重复登记，请核对明细。' : result === 'saved' ? '原请求已在停止前生效，记录和数量保留；请核对明细。如需更正，请另行调整或撤销。' : '停止请求已确认：原请求未生效，今后迟到也不会生效。可以重新登记。');
  });
  doc.addEventListener('click', run(async e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.hasAttribute('data-close')) { const dialog=b.closest('dialog'); if(dialog.id==='publish-dialog')cancelRegistration();else close(dialog); }
    if (b.dataset.tab) switchTab(b.dataset.tab);
    if (b.dataset.publish) openPublish(b.dataset.publish);
    if (b.dataset.step) {
      if (date > today()) throw Error('未来日期尚未开始，请到当天再登记');
      writable(); const r = row(b.dataset.id), selected = selectedPerson(r), person = selected.person, content = b.dataset.content;
      if(b.dataset.step==='1'&&!person)throw Error('请先从飞书成员中选择账号负责人');
      const member=selected;
      stageQuantity(r.id,content,Number(b.dataset.step));
    }
    if (b.dataset.editEntry) openEntryEdit(b.dataset.editEntry);
    if (b.dataset.business) { if (!store?.openBusiness) return; await store.openBusiness(b.dataset.business); close($('business-dialog')); }
    if (b.dataset.entries) { entriesAccount = b.dataset.entries; renderEntries(); show($('entries-dialog')); renderStatus(); }
    if(b.dataset.deleteEntry){const entry=controller.board.publications.get(b.dataset.deleteEntry);if(!entry)throw Error('记录已变化，请刷新');confirmDelete({type:'publication',entry,expected:publicationState(controller.board,entry),expectedAccount:clone(effectivePublication(controller.board,entry).account)},'删除这条登记？',`${entry.date} · ${effectivePublication(controller.board,entry).account?.name??'账号'} · 视频${effectivePublication(controller.board,entry).video} / 图文${effectivePublication(controller.board,entry).photo}。确认后从完成数量中扣除，并删除飞书发布明细中的对应行。操作审计保留，不参与统计。`);}
    if(b.dataset.deletePlan){const p=controller.board.plans.get(b.dataset.deletePlan);if(!p)throw Error('计划已变化');const entries=[...controller.board.publications.values()].filter(e=>e.date>=p.date&&e.date<=(p.payload.endDate??p.date)&&!controller.board.deletedEntries.has(e.id)).map(e=>e.id);confirmDelete({type:'plan',plan:p,expected:controller.board.planHead,heads:dayHeads(controller.board,today()),entries},'删除这个周期及其登记？',`${p.payload.title||'周期计划'} · ${p.date}至${p.payload.endDate??'未设结束日期'} · ${p.payload.accounts.length}个账号、${entries.length}条登记。确认后删除本周期的计划、周期进度、每日进度和发布明细；不影响其他周期。`);}
    if(b.dataset.restoreDay){await save('delete',date,{type:'restore-day-account',target:b.dataset.restoreDay,expectedHeads:dayHeads(controller.board,date)});render();await finishBusiness();message('当天任务已恢复，已删除的错误登记不会恢复，请重新登记实际数量');}
    if (b.dataset.remove) { writable(); b.closest('tr').remove(); planDirty = true; planTotal(); message('账号已从草稿移除；点击保存发布计划后同步飞书。已有发布登记保留。'); }
    if (b.dataset.date) { date = b.dataset.date; followToday = date === today(); switchTab('board'); }
    if (b.dataset.planDate) { if (planDirty && !win.confirm('有尚未保存的计划。放弃这些修改并查看其他版本？')) return; loadPlan(b.dataset.planDate); switchTab('plan'); }
    if (b.dataset.configureCycle) { loadPlan(b.dataset.configureCycle); switchTab('plan'); }
    if (b.hasAttribute('data-next-cycle')) newCycle(controller.board.plans.get(b.dataset.nextCycle));
  }));
  doc.addEventListener('change',run(async e=>{
    const input=e.target;if(!input.dataset.rowOwner)return;if(date>today())throw Error('未来日期仅查看计划，请在发布计划中设置负责人');writable();const r=row(input.dataset.rowOwner),owner=readOwner(input),p=planAt(controller.board,date).plan;
    if(p?.payload.accounts.some(x=>x.id===r.id)&&date===today()){
      const cfg=config(p.payload.accounts.map(x=>x.id===r.id?{...x,...owner}:x)),applied=config(dayAt(controller.board,date).map(x=>x.id===r.id?{...x,...owner}:x));
      if(applied.some(x=>!cfg.some(a=>a.id===x.id)))throw Error('请先同步最新计划，再选择负责人');
      await save('plan',p.date,{...planPayload(cfg,p),applyAccounts:applied});
    }else await save('day',date,{snapshot:snapshot(),accountId:r.id,account:{...config([r])[0],...owner},expected:r.head});
    message('负责人已保存，之后的登记直接按此人计入');
  }));
  $('date').onchange = () => { const next=$('date').value;if (validDate(next)) {const change=()=>{date=next;followToday=date===today();render();};if(askQuick(change))$('date').value=date;else change();} };
  $('today').onclick = () => { const change=()=>{followToday=true;date=today();render();};if(!askQuick(change))change(); };
  $('quick-save').onclick=run(saveQuick);
  $('quick-review').onclick=run(reviewQuick);
  $('quick-review-form').onsubmit=run(async e=>{
    e.preventDefault();writable();if(!quickReview||!quickDraft)throw Error('请重新核对暂存');
    const changes=[...$('quick-review-rows').children].map(el=>{const id=el.dataset.account,r=quickReview.snapshot.find(r=>r.id===id),values=Object.fromEntries([...el.querySelectorAll('[data-delta]')].map(input=>[input.dataset.delta,Number(input.value)]));return {accountId:id,person:r?.owner??'已移出',...(r?.ownerId?{personId:r.ownerId}:{}),...values};}).filter(c=>c.video||c.photo);
    await controller.refresh();
    const payload=batchPayload(controller.board,quickReview.date,changes,quickReview),issues=batchConflicts(controller.board,quickReview.date,payload);
    if(issues.length)throw Error(issues.join('；')+'。尚未替换原输入，请重新核对');
    if(changes.length){quickDraft={v:7,...quickReview,changes};persistQuick();}else discardQuick();
    quickReview=null;close($('quick-review-dialog'));render();message('核对后的变化已暂存，点击保存登记后生效');
  });
  $('quick-discard').onclick=()=>{if(win.confirm('放弃本次未保存的＋／−修改？飞书中的已保存登记保留。'))discardQuick();};
  $('quick-stay').onclick=()=>{leaveQuick=null;close($('quick-leave-dialog'));};
  $('quick-leave-discard').onclick=()=>{const next=leaveQuick;leaveQuick=null;discardQuick();close($('quick-leave-dialog'));next?.();};
  $('quick-leave-save').onclick=run(async()=>{await saveQuick();const next=leaveQuick;leaveQuick=null;close($('quick-leave-dialog'));await next?.();});
  for (const id of ['owner-filter', 'shop-filter', 'status-filter']) $(id).onchange = render;
  for (const id of ['history-from', 'history-to']) $(id).onchange = renderHistory;
  $('plan-form').addEventListener('input', () => { planDirty = true; planTotal(); });
  $('catalog-refresh').onclick=run(async()=>{await refreshMembers();await refreshCatalog();message(catalogError||'已刷新飞书资料选项，未保存的计划内容保留');});
  doc.querySelectorAll('[data-catalog-open]').forEach(button=>button.onclick=run(async()=>{if(doc.fullscreenElement)await doc.exitFullscreen();await store.openCatalog(button.dataset.catalogOpen);}));
  $('plan-form').addEventListener('change',e=>{
    const input=e.target;
    if(input.matches('select[data-field="name"]')) {
      const account=catalog.accounts.find(a=>a.id===input.value),tr=input.closest('tr');
      const shop=tr.querySelector('[data-field="shop"]'),owner=tr.querySelector('[data-field="owner"]');
      if(account) { tr.dataset.id=account.id===input.dataset.originalRef?tr.dataset.originalId:'catalog:'+account.id;shop.value=account.shopRef??'';owner.value=account.ownerId??''; }
      else { shop.value='';owner.value=''; }
    }
    planDirty=true;planTotal();
  });
  // A default zero is selected for replacement; typed leading zeros are normalized.
  const quantityInput=el=>el?.matches?.('input[type="number"][min="0"]');
  doc.addEventListener('focusin',e=>{if(quantityInput(e.target)&&e.target.value==='0')e.target.select();});
  doc.addEventListener('mouseup',e=>{if(quantityInput(e.target)&&e.target.value==='0'){e.preventDefault();e.target.select();}});
  doc.addEventListener('input',e=>{if(quantityInput(e.target)&&/^0+\d+$/.test(e.target.value))e.target.value=String(Number(e.target.value));},true);
  doc.addEventListener('focusout',e=>{if(quantityInput(e.target)&&e.target.value===''&&!e.target.validity.badInput)e.target.value='0';});
  $('new-cycle').onclick = run(() => { writable(); newCycle(); });
  $('plan-date').onchange = () => { if (validDate($('plan-date').value) && $('plan-duration').value !== 'custom') $('plan-end').value = addDays($('plan-date').value, Number($('plan-duration').value) - 1); planDirty = true; planTotal(); };
  $('plan-duration').onchange = () => { if ($('plan-duration').value !== 'custom' && validDate($('plan-date').value)) $('plan-end').value = addDays($('plan-date').value, Number($('plan-duration').value) - 1); planDirty = true; planTotal(); };
  $('plan-end').onchange = () => { $('plan-duration').value = 'custom'; planDirty = true; planTotal(); };
  $('add-account').onclick = run(() => { writable(); if ($('plan-rows').children.length >= 100) throw Error('最多100个账号'); const fragment=doc.createElement('tbody');fragment.innerHTML=planRow({ id: crypto.randomUUID(), name: '', shop: '', owner: '', product: '', video: 0, photo: 0 });$('plan-rows').append(fragment.firstElementChild); planDirty = true; planTotal(); $('plan-rows').lastElementChild.querySelector('[data-field="name"]').focus(); });
  $('plan-reset').onclick = () => { if (!planDirty || win.confirm('放弃尚未保存的计划修改，重新读取共享计划？')) loadPlan($('plan-date').value); };
  $('plan-form').onsubmit = run(async e => { e.preventDefault(); writable(); const cfg = readPlan(), at = $('plan-date').value, endDate = $('plan-end').value; cycleDays(at, endDate); const current=today(),existing=controller.board.plans.get(at);if(!existing&&at<current)throw Error('新周期从今天或未来日期开始，不补造过去安排');if(endDate<current)throw Error('该周期已结束，请建立新周期');if(!cfg.length&&!existing)throw Error('请至少添加一个账号，再保存周期计划');const payload={accounts:cfg,expected:planExpected,endDate,title:$('plan-title').value,effectiveDate:existing&&at<current?current:at,...(at<=current&&current<=endDate?{applyDate:current,applyHeads:dayHeads(controller.board,current)}:{})};await save('plan', at, payload);planDirty = false; loadPlan(at);date=at<=current&&current<=endDate?current:at;followToday=date===current;switchTab('board');await finishBusiness(); message(`计划已保存，${date===current?'从今天生效，过去安排保留':'已打开计划开始日期'}；已有发布登记保留`); });
  $('publish-form').addEventListener('input',()=>{registrationDirty=true;});
  $('correct-arrangement').onchange=()=>{$('entry-arrangement-fields').hidden=!$('correct-arrangement').checked;$('entry-details').querySelectorAll('input,select').forEach(input=>input.disabled=!$('correct-arrangement').checked);registrationDirty=true;};
  $('entry-account').onchange=()=>{renderEntryArrangement(editing?.accounts.find(r=>r.id===$('entry-account').value));registrationDirty=true;};
  $('publish-dialog').addEventListener('cancel',e=>{e.preventDefault();cancelRegistration();});
  $('publish-form').onsubmit = run(async e => {
    e.preventDefault(); writable(); const data=Object.fromEntries(new win.FormData($('publish-form')));
    if (!editing) throw Error('请重新打开登记');
    const person=editing.target&&!editing.delegate?{person:editing.expected.person,...(editing.expected.personId?{personId:editing.expected.personId}:{})}:publicationPerson(data.person),values={...person,video:Number(data.video),photo:Number(data.photo),note:data.note};
    await controller.refresh();
    if(editing.target){
      let account;
      if($('correct-arrangement').checked){account=clone(editing.accounts.find(r=>r.id===$('entry-account').value));if(!account)throw Error('请选择该日期的真实账号');for(const input of $('entry-details').querySelectorAll('[data-entry-field]'))Object.assign(account,input.dataset.entryField==='owner'?readOwner(input):readCatalog(input,input.dataset.entryField));account=config([account])[0];}
      await save('edit',editing.date,{target:editing.target,expected:editing.expected,expectedAccount:editing.expectedAccount,...(account?{account}:{}),...values});
    }
    else {
      if(editing.date>today())throw Error('未来日期尚未开始');
      const current=dayAt(controller.board,editing.date).find(r=>r.id===editing.id);
      if(!current||taskIdentity(current)!==taskIdentity(editing.snapshot.find(r=>r.id===editing.id)))throw Error('该账号安排已变化，代做输入保留，请核对安排后再登记');
      await save('publish',editing.date,{snapshot:editing.snapshot,accountId:editing.id,...values});
    }
    const updated=!!editing.target;registrationDirty=false;editing=null;close($('publish-dialog'));render();await finishBusiness();
    message(store.mode==='feishu'&&!businessMessage.includes('已更新')?'登记已保存；'+businessMessage:updated?'登记已修改，进度和明细已更新':'代做已登记，完成数量和明细已更新');
  });
  $('delete-plan').onclick=()=>{const button=doc.createElement('button');button.dataset.deletePlan=$('plan-date').value;doc.body.append(button);button.click();button.remove();};
  $('delete-confirm').onclick=run(async()=>{
    writable();const target=deleteTarget;if(!target)return;
    if(target.type==='publication')await save('delete',target.entry.date,{type:'publication',target:target.entry.id,expected:target.expected,expectedAccount:target.expectedAccount,reason:'用户确认删除错误登记'});
    else if(target.type==='plan')await save('delete',target.plan.date,{type:'plan',target:target.plan.id,expected:target.expected,applyDate:today(),applyHeads:target.heads,cascade:true,entries:target.entries});
    else{const payload=planPayload(config(target.plan.payload.accounts.filter(r=>r.id!==target.accountId)),target.plan);payload.expected=target.expected;payload.applyHeads=target.heads;await save('plan',target.plan.date,payload);}
    close($('delete-dialog'));deleteTarget=null;if(target.type!=='publication'){planLoaded=false;planDirty=false;}render();await finishBusiness();message(store.mode==='feishu'?`已删除并停止计数；${businessMessage}`:'已删除，错误登记不再计入');
  });
  $('data-button').onclick = () => {
    $('storage-detail').textContent = store?.mode === 'feishu' ? `业务数据保存在当前飞书多维表格。` : '尚未使用飞书正式数据。本地演示只供体验。';
    $('backup').disabled = !controller?.ready; $('import').disabled = !controller?.ready || !store?.editable;
    show($('data-dialog'));
  };
  $('backup').onclick = run(() => { if (!controller?.ready) throw Error('请先完整加载数据'); download(JSON.stringify({ format: FORMAT, exportedAt: new Date().toISOString(), actions: controller.board.actions }, null, 2), '内容发布看板-' + today() + '.json', 'application/json'); });
  $('business-button').onclick = () => {const open=()=>show($('business-dialog'));if(!askQuick(open))open();};
  $('business-sync').onclick = run(async () => { await syncBusiness(true); message(businessMessage); });
  $('import').onclick = () => $('import-file').click();
  $('import-file').onchange = run(async () => {
    const file = $('import-file').files[0]; if (!file) return;
    try { if (file.size > 20000000) throw Error('备份超过20MB，请分批处理'); incoming = migration(JSON.parse(await file.text())); preview(); }
    finally { $('import-file').value = ''; }
  });
  $('import-confirm').onclick = run(doImport);
  $('import-abandon').onclick = run(() => {
    if (importing || controller?.busy) throw Error('正在保存，请稍等');
    if (controller?.pending) throw Error('先核对或停止待确认请求，才能放弃剩余导入');
    win.localStorage.removeItem(pendingMigrationKey()); incoming = null; $('import-confirm').dataset.blocked = 'false'; $('import-preview').classList.add('hidden');
    message('已放弃剩余导入；已经保存的操作和团队记录保留');
  });
  $('csv').onclick = run(() => {
    if (!controller?.ready) throw Error('请先完整加载数据');
    const table = [['日期', '周期开始', '周期结束', '周期名称', '登记情况', '账号', '店铺', '账号负责人', '产品', '每天视频目标', '每天图文目标', '视频完成', '图文完成', '视频缺口', '图文缺口', '实际完成人及贡献', '备注']];
    for (const d of executionDates(controller.board)) if (d >= $('history-from').value && d <= $('history-to').value) for (const r of dayAt(controller.board, d)) {
      const c = counts(r), p = planAt(controller.board, d); table.push([d, p.from, p.until, p.title, hasRegistration(controller.board,d) ? '已登记' : '未登记', r.name, r.shop, r.owner, r.product, r.video, r.photo, c.video, c.photo, Math.max(0, r.video - c.video), Math.max(0, r.photo - c.photo), people([r]).map(p => `${p.person} 视频${p.video} 图文${p.photo}`).join('；'), r.note]);
    }
    download('\uFEFF' + table.map(r => r.map(csvCell).join(',')).join('\r\n'), `执行记录-${$('history-from').value}-${$('history-to').value}.csv`, 'text/csv;charset=utf-8');
  });
  $('report').onclick = () => { $('report-text').value = report(controller.board, date); show($('report-dialog')); };
  $('copy-report').onclick = run(async () => { try { await win.navigator.clipboard.writeText($('report-text').value); message('日报已复制'); } catch { $('report-text').select(); message('浏览器未允许自动复制，请复制已选中的日报文字'); } });
  win.addEventListener('beforeunload', e => { if (planDirty || quickDraft || registrationDirty || controller?.pending || importing) { e.preventDefault(); e.returnValue = ''; } });
  const storageChanged = e => { if (controller && (e.key?.startsWith(controller.pendingKey) || e.key === pendingMigrationKey())) renderStatus(); };
  win.addEventListener('storage', storageChanged);
  const ready = connect();
  return { ready, demo, connect, render, get controller() { return controller; }, destroy() { win.removeEventListener('storage', storageChanged); offStore?.(); win.clearInterval(pollTimer); win.clearTimeout(refreshTimer); win.clearTimeout(toastTimer); win.clearTimeout(businessTimer); } };
}
