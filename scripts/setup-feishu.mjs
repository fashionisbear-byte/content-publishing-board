import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { BUSINESS_TABLES, cliFields } from '../src/business.js';
import { MEMBER_TABLE, MEMBER_FIELDS } from '../src/members.js';
import { TABLE_NAME, ORDER_FIELD, SCHEMA } from '../src/storage.js';

const token = process.argv[2], cliEntry = process.env.LARK_CLI_ENTRY;
if (!token || !cliEntry) throw Error('传入 Base token，并设置 LARK_CLI_ENTRY 为已安装 lark-cli 的 scripts/run.js 路径');
function cli(args) {
  const r = spawnSync(process.execPath, [cliEntry, 'base', ...args, '--as', 'user'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw Error(r.stderr || r.stdout || 'CLI失败');
  const body = JSON.parse(r.stdout); if (!body.ok) throw Error(JSON.stringify(body)); return body;
}
const existing = cli(['+table-list', '--base-token', token, '--limit', '100']).data.tables;
if (existing.length >= 100) throw Error('需要先确认表格分页');
const shared = existing.filter(t => t.name === TABLE_NAME);
if (shared.length !== 1) throw Error('请先在插件创建唯一共享表；此脚本不重建原始表或业务行');
const sharedFields = cli(['+field-list', '--base-token', token, '--table-id', shared[0].id, '--limit', '200']).data.fields;
if (sharedFields.length >= 200) throw Error('共享字段分页需要管理员核对');
for (const [, name, type] of SCHEMA) {
  const found = sharedFields.filter(f => f.name === name);
  if (found.length !== 1 || found[0].type !== ({ Text: 'text', Number: 'number' })[type]) throw Error('原始字段缺失或类型不符：' + name + '；保留已有表，不自动重建');
}
const ordinal = sharedFields.filter(f => f.name === ORDER_FIELD);
if (ordinal.length > 1) throw Error('提交序号字段重名，请管理员核对');
const rules = [{ type: 'incremental_number', length: 9 }];
if (ordinal.length) {
  const configured = ordinal[0].style?.rules;
  if (ordinal[0].type !== 'auto_number' || !Array.isArray(configured) || configured.length !== 1 || configured[0].type !== 'incremental_number' || configured[0].length !== 9) throw Error('提交序号必须仅有9位递增数字规则；不要删除重建字段，请管理员核对');
  console.log('保留已配置的只读提交序号');
} else {
  cli(['+field-create', '--base-token', token, '--table-id', shared[0].id, '--json', JSON.stringify({ name: ORDER_FIELD, type: 'auto_number', style: { rules }, description: '只读服务器提交序号；不修改规则，不删除或重建字段' })]);
  console.log('已请求添加提交序号；请核验字段可见和9位递增数字规则后重连，结果不确定时不要立即重复创建');
}
const result = [];
for (const def of [...BUSINESS_TABLES, { name: MEMBER_TABLE, fields: MEMBER_FIELDS }]) {
  const matches = existing.filter(t => t.name === def.name);
  if (matches.length > 1) throw Error('重名表：' + def.name);
  if (matches.length) {
    if (def.key) {
      const tableId = matches[0].id;
      const current = cli(['+field-list', '--base-token', token, '--table-id', tableId, '--limit', '200']).data.fields;
      if (current.length >= 200) throw Error('字段分页需要先核对');
      for (const desired of cliFields(def)) {
        const found = current.filter(f => f.name === desired.name);
        if (found.length > 1) throw Error('业务字段重名：' + desired.name);
        if (found.length === 1) {
          if (found[0].type !== desired.type) throw Error('已有业务字段类型不符：' + desired.name);
        } else {
          cli(['+field-create', '--base-token', token, '--table-id', tableId, '--json', JSON.stringify(desired)]);
          console.log('补充业务字段：' + def.name + ' / ' + desired.name);
        }
      }
    }
    console.log('保留已有表：' + def.name); result.push(matches[0]); continue;
  }
  console.log('创建业务表：' + def.name);
  const created = cli(['+table-create', '--base-token', token, '--name', def.name, '--fields', JSON.stringify(def.name === MEMBER_TABLE ? MEMBER_FIELDS : cliFields(def))]);
  result.push(created.data); console.log('已创建：' + def.name);
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2), 'utf8');
console.log('业务表结构完成；打开看板后会从现有记录整理数据。');
