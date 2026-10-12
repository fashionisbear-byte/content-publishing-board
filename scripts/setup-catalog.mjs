import { spawnSync } from 'node:child_process';
const token = process.argv[2], cliEntry = process.env.LARK_CLI_ENTRY;
if (!token || !cliEntry) throw Error('传入 Base token，并设置 LARK_CLI_ENTRY 为已安装 lark-cli 的 scripts/run.js 路径');
function cli(args) {
  const result = spawnSync(process.execPath,[cliEntry,'base',...args,'--as','user'],{encoding:'utf8',windowsHide:true,maxBuffer:8000000});
  if(result.status!==0)throw Error('飞书命令未成功：'+args[0]+'；核对已创建的表后再继续，避免重复创建');
  const json=JSON.parse(result.stdout);if(!json.ok)throw Error('飞书未确认操作');return json.data;
}
const tables=cli(['+table-list','--base-token',token,'--limit','100']);
if(tables.has_more||tables.tables.length>=100)throw Error('表格分页不完整');
const definitions=[
  {name:'店铺资料',fields:[{name:'店铺名称',type:'text',description:'唯一名称，最多80字；看板读取为店铺选项'}]},
  {name:'产品资料',fields:[{name:'产品名称',type:'text',description:'唯一名称，最多80字；可包含型号，作为看板产品选项'}]},
  {name:'账号资料',fields:[{name:'账号名称',type:'text',description:'唯一名称，最多80字；作为看板账号选项'},{name:'店铺',type:'link',link_table:'',description:'关联店铺资料；每个账号选择一家店铺'},{name:'负责人',type:'user',multiple:false,description:'使用飞书成员选择器；作为新计划默认负责人，可在计划中调整'}]}
];
let shopId;
for(const definition of definitions) {
  if(definition.name==='账号资料')definition.fields.find(f=>f.name==='店铺').link_table=shopId;
  const matches=tables.tables.filter(t=>t.name===definition.name);
  if(matches.length>1)throw Error('资料表重名：'+definition.name);
  const table=matches[0]??cli(['+table-create','--base-token',token,'--name',definition.name,'--fields',JSON.stringify(definition.fields)]).table;
  if(!table?.id)throw Error('表格创建结果不完整；先核对，勿重复创建');
  let fields;
  for(let attempt=0;attempt<5;attempt++){
    fields=cli(['+field-list','--base-token',token,'--table-id',table.id,'--limit','200']);
    if(definition.fields.every(d=>fields.fields.some(f=>f.name===d.name)))break;
  }
  if(fields.has_more||fields.fields.length>=200)throw Error('字段分页不完整');
  for(const desired of definition.fields) {
    const found=fields.fields.filter(f=>f.name===desired.name);
    if(found.length!==1||found[0].type!==desired.type)throw Error('保留现有资料；请核对字段：'+definition.name+' / '+desired.name);
    if(desired.link_table&&found[0].link_table!==desired.link_table)throw Error('账号店铺字段关联目标不符，请管理员核对');
  }
  if(definition.name==='店铺资料')shopId=table.id;
  console.log(JSON.stringify({name:definition.name,id:table.id,existing:!!matches.length,fieldsVerified:true}));
}
console.log('资料表结构完成；没有导入或生成任何账号、店铺、产品记录。');
