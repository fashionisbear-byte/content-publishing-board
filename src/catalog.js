export const CATALOG_TABLES = [
  { key: 'shops', name: '店铺资料', fields: [['name', '店铺名称', 'Text']] },
  { key: 'products', name: '产品资料', fields: [['name', '产品名称', 'Text']] },
  { key: 'accounts', name: '账号资料', fields: [['name', '账号名称', 'Text'], ['shop', '店铺', 'SingleLink'], ['owner', '负责人', 'User']] }
];
const identity = value => typeof value === 'string' && /^[\w:/.-]{1,180}$/.test(value);
function label(value, table) {
  const result = value == null ? '' : typeof value === 'string' ? value : Array.isArray(value) && value.every(x => x.type === 'text' && typeof x.text === 'string') ? value.map(x => x.text).join('') : null;
  if (result === null || result.length > 80) throw Error(table + '的名称须为80字以内文本');
  return result.trim();
}
export function createCatalogStore({ bitable, FieldType }) {
  async function tableFor(def, metadata) {
    const matches = metadata.filter(t => t.name === def.name);
    if (matches.length !== 1) throw Error('请管理员配置唯一的「' + def.name + '」表');
    const table = await bitable.base.getTableById(matches[0].id), meta = await table.getFieldMetaList(), fields = {};
    for (const [key, name, type] of def.fields) {
      const matches = meta.filter(f => f.name === name && f.type === FieldType[type]);
      if (matches.length !== 1) throw Error(def.name + '字段「' + name + '」需要管理员核对');
      fields[key] = matches[0];
    }
    return { table, fields };
  }
  async function records(table, name) {
    const views = await table.getViewMetaList();
    const viewId = views[0]?.id;
    if (!identity(viewId)) throw Error(name + '缺少可读取的资料视图');
    const rows = [], tokens = new Set(); let pageToken;
    for (let page = 0; page < 26; page++) {
      const result = await table.getRecordsByPage({ pageSize: 200, viewId, stringValue: false, ...(pageToken == null ? {} : { pageToken }) });
      if (!Array.isArray(result.records)) throw Error(name + '读取失败');
      rows.push(...result.records);
      if (rows.length > 5000) throw Error(name + '超过5,000行，请管理员整理');
      if (!result.hasMore) return rows;
      if (!result.records.length || result.pageToken == null || tokens.has(result.pageToken)) throw Error(name + '分页不完整');
      tokens.add(result.pageToken); pageToken = result.pageToken;
    }
    throw Error(name + '分页超限');
  }
  return {
    async list() {
      const metadata = await bitable.base.getTableMetaList(), result = {};
      for (const def of CATALOG_TABLES) {
        const { table, fields } = await tableFor(def, metadata), seen = new Set(), names = new Set(), rows = [];
        if (def.key === 'accounts' && fields.shop.property?.tableId && fields.shop.property.tableId !== result.shopTableId) throw Error('账号资料的店铺字段必须关联「店铺资料」');
        for (const row of await records(table, def.name)) {
          const name = label(row.fields[fields.name.id], def.name);
          if (!name) continue; // Empty grid rows are drafts, not selectable business records.
          if (!identity(row.recordId) || seen.has(row.recordId)) throw Error(def.name + '记录标识重复或无效');
          if (def.key!=='products' && names.has(name)) throw Error(def.name + '存在同名记录，请在飞书区分名称后刷新');
          seen.add(row.recordId); names.add(name);
          const item = { id: row.recordId, name };
          if (def.key === 'accounts') {
            const link = row.fields[fields.shop.id], ids = link?.recordIds ?? [];
            if (link != null && (!Array.isArray(ids) || ids.length > 1 || ids.some(x => !identity(x)) || link.tableId !== result.shopTableId)) throw Error('每个账号最多选择一家店铺，且须关联「店铺资料」');
            if (ids.length) { const shop = result.shops.find(s => s.id === ids[0]); if (!shop) throw Error('账号关联的店铺不在店铺资料视图中，或名称未填写，请先修正资料'); item.shopRef = shop.id; item.shop = shop.name; }
            const owners = row.fields[fields.owner.id] ?? [];
            if (!Array.isArray(owners) || owners.length > 1) throw Error('每个账号最多选择一位负责人');
            if (owners.length) { const user = owners[0]; if (!identity(user.id) || typeof user.name !== 'string' || !user.name.trim() || user.name.length > 80) throw Error('账号负责人信息不完整，请重新选择飞书成员'); item.ownerId = user.id; item.owner = user.name.trim(); }
          }
          rows.push(item);
        }
        result[def.key] = rows;
        if (def.key === 'shops') result.shopTableId = table.id;
      }
      delete result.shopTableId;
      return result;
    },
    async open(key) {
      const def = CATALOG_TABLES.find(t => t.key === key);
      if (!def) throw Error('资料类型无效');
      const { table } = await tableFor(def, await bitable.base.getTableMetaList());
      await bitable.ui.switchToTable(table.id);
    }
  };
}
