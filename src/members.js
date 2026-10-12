export const MEMBER_TABLE = '协作成员';
export const MEMBER_FIELDS = [{ name: '成员名称', type: 'text' }, { name: '飞书成员', type: 'user', multiple: false, description: '使用飞书人员选择器选择成员；看板从此表读取可登记的完成人。' }];
export function createMemberStore({ bitable, FieldType }) {
  let table, fields, viewId;
  async function connect() {
    const matches = (await bitable.base.getTableMetaList()).filter(t => t.name === MEMBER_TABLE);
    if (matches.length !== 1) throw Error('请管理员先配置「协作成员」表');
    table = await bitable.base.getTableById(matches[0].id);
    const meta = await table.getFieldMetaList();
    fields = {};
    for (const [key, name, type] of [['name', '成员名称', 'Text'], ['user', '飞书成员', 'User']]) {
      const found = meta.filter(f => f.name === name && f.type === FieldType[type]);
      if (found.length !== 1) throw Error('协作成员表字段「' + name + '」需要管理员核对');
      fields[key] = found[0].id;
    }
    viewId = (await table.getViewMetaList())[0]?.id;
    if (!viewId) throw Error('协作成员表缺少视图');
  }
  async function records() {
    if (!table) await connect();
    const all = [], tokens = new Set(); let pageToken;
    for (let page = 0; page < 11; page++) {
      const result = await table.getRecordsByPage({ pageSize: 200, stringValue: false, ...(pageToken == null ? {} : { pageToken }) });
      if (!Array.isArray(result.records)) throw Error('协作成员读取失败');
      all.push(...result.records);
      if (all.length > 2000) throw Error('协作成员超过2,000行，请管理员整理');
      if (!result.hasMore) return all;
      if (!result.records.length || result.pageToken == null || tokens.has(result.pageToken)) throw Error('协作成员分页不完整');
      tokens.add(result.pageToken); pageToken = result.pageToken;
    }
    throw Error('协作成员分页超限');
  }
  return {
    async list() {
      const users = new Map();
      for (const row of await records()) for (const user of row.fields[fields.user] ?? []) {
        if (typeof user.id !== 'string' || !/^[\w:/.-]{1,180}$/.test(user.id) || typeof user.name !== 'string' || !user.name.trim() || user.name.length > 80) throw Error('飞书成员信息不完整，请重新选择该成员');
        users.set(user.id, { personId: user.id, person: user.name.trim() });
      }
      return [...users.values()].sort((a, b) => a.person.localeCompare(b.person, 'zh-CN'));
    },
    async choose() {
      const rows = await records();
      const empty = rows.find(r => !r.fields[fields.user]?.length);
      const recordId = empty?.recordId ?? await table.addRecord({ fields: { [fields.name]: [{ type: 'text', text: '选择飞书成员' }] } });
      // The host owns the personnel picker and its permissions. No contacts are sent to another server.
      const cell = { tableId: table.id, viewId, recordId, fieldId: fields.user };
      for (let attempt = 0; ; attempt++) {
        try { await bitable.ui.showFieldValueEditor(cell); break; }
        catch (error) {
          // Newly added rows can reach the SDK before the host grid has rendered the cell.
          if (attempt >= 2 || !/cell not found/i.test(error?.message ?? String(error))) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    },
    async open() { if (!table) await connect(); await bitable.ui.switchToTable(table.id); }
  };
}
