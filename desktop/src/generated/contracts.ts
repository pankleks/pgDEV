// Generated from pgdev-core. Do not edit by hand.
// Regenerate with npm run generate:desktop:types

export type QueryRequest = { id: string, tabKey: string, sql: string, transactionId: string | null, maxRows: number, };
export type QueryResponse = { results: Array<QueryResult>, durationMs: number, transactionOpen: boolean, transactionId: string | null, notices: Array<DatabaseNotice>, noticesTruncated: boolean, };
export type QueryResult = { "kind": "command" } & CommandResult | { "kind": "data" } & DataResult;
export type CommandResult = { command: string, rowCount: number, };
export type DataResult = { columns: Array<string>, columnTypes: Array<string>, columnTypeOids: Array<number>, columnTypeLengths: Array<number | null>, editable: EditableGrid | null, rows: unknown[][], rowCount: number, truncated: boolean, limited: boolean, totalRowCount: number | null, };
export type FetchMoreResponse = { rows: unknown[][], rowCount: number, truncated: boolean, notices: Array<DatabaseNotice>, noticesTruncated: boolean, };
export type SchemaData = { tables: Array<TableInfo>, views: Array<ViewInfo>, functions: Array<FunctionInfo>, types: Array<TypeInfo>, sequences: Array<SequenceInfo>, builtins: Array<FunctionInfo>, };
export type TableInfo = { schema: string, name: string, oid: string, columns: Array<ColumnInfo>, indexes: Array<IndexInfo>, constraints: Array<ConstraintInfo>, triggers: Array<TriggerInfo>, isPartition: boolean, isPartitioned: boolean, parents: string, relkind: 'r' | 'p' | 'f', };
export type ViewInfo = { schema: string, name: string, oid: string, materialized: boolean, columns: Array<ColumnInfo>, };
export type ColumnInfo = { name: string, type: string, nullable: boolean, defaultValue: string | null, };
export type IndexInfo = { name: string, type: 'primary' | 'unique' | 'exclusion' | 'normal', method: string, };
export type ConstraintInfo = { name: string, type: string, definition: string, };
export type TriggerInfo = { name: string, definition: string, };
export type FunctionInfo = { schema: string, name: string, args: string, returns: string, typeSig: string, kind: 'function' | 'procedure' | 'window' | 'trigger' | 'aggregate', oid: string, arguments?: string, comment: string | null, };
export type TypeInfo = { schema: string, name: string, oid: string, kind: 'enum' | 'composite' | 'domain' | 'range', detail: string, };
export type SequenceInfo = { schema: string, name: string, oid: string, dataType: string, detail: string, };
export type DdlKind = "table" | "view" | "function" | "index" | "constraint" | "trigger" | "type" | "sequence";
export type DdlTarget = { type: DdlKind, schema: string, name: string, oid: string | null, parent: string | null, };
export type DdlResponse = { ddl: string, readOnly: boolean, };
export type EditableGrid = { schema: string, table: string, pk: Array<string>, columns: Array<EditableGridColumn>, };
export type EditableGridColumn = { name: string, pk: boolean, generated: boolean, nullable: boolean, };
export type RowUpdateRequest = { id: string, tabKey: string, transactionId: string | null, schema: string, table: string, key: Record<string, unknown>, set: Record<string, unknown>, };
export type RowUpdateResponse = { row: Record<string, unknown>, transactionOpen: boolean, transactionId: string | null, notices: Array<DatabaseNotice>, noticesTruncated: boolean, };
export type TableEditKeyRef = { label: string, name: string, definition: string, };
export type TableEditLockKind = "identity" | "generated" | "serial";
export type TableEditColumnState = { id: string, name: string, type: string, nullable: boolean, defaultValue: string | null, description: string | null, pk: boolean, fks?: Array<TableEditKeyRef>, uks?: Array<TableEditKeyRef>, locked: boolean, lockKind?: TableEditLockKind, };
export type TableEditState = { oid: string, schema: string, name: string, relkind: 'r' | 'p', description: string | null, columns: Array<TableEditColumnState>, fingerprint: string, };
export type TableEditColumnInput = { id: string, added?: boolean, name: string, type: string, nullable: boolean, defaultValue: string | null, description: string | null, };
export type TableEditRequest = { description: string | null, fingerprint: string, columns: Array<TableEditColumnInput>, };
export type TableEditResponse = { ddl: string | null, };
export type DatabaseNotice = { severity: string, code: string, message: string, detail: string | null, hint: string | null, context: string | null, };
