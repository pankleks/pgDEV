use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub id: String,
    pub tab_key: String,
    pub sql: String,
    pub transaction_id: Option<String>,
    #[serde(default = "default_max_rows")]
    pub max_rows: u32,
}

fn default_max_rows() -> u32 {
    500
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub results: Vec<QueryResult>,
    pub duration_ms: u64,
    pub transaction_open: bool,
    pub transaction_id: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum QueryResult {
    Command(CommandResult),
    Data(DataResult),
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub command: String,
    pub row_count: u64,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DataResult {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub column_type_oids: Vec<u32>,
    #[ts(type = "unknown[][]")]
    pub rows: Vec<Vec<Value>>,
    pub row_count: u64,
    pub truncated: bool,
    pub limited: bool,
    pub total_row_count: Option<u64>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FetchMoreResponse {
    #[ts(type = "unknown[][]")]
    pub rows: Vec<Vec<Value>>,
    pub row_count: u64,
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    #[test]
    fn frontend_contracts_match_rust() {
        let mut generated = String::from("// Generated from pgdev-core. Do not edit by hand.\n// Regenerate with npm run generate:desktop:types\n\n");
        for declaration in [
            QueryRequest::decl(),
            QueryResponse::decl(),
            QueryResult::decl(),
            CommandResult::decl(),
            DataResult::decl(),
            FetchMoreResponse::decl(),
            SchemaData::decl(),
            TableInfo::decl(),
            ViewInfo::decl(),
            ColumnInfo::decl(),
            IndexInfo::decl(),
            ConstraintInfo::decl(),
            TriggerInfo::decl(),
            FunctionInfo::decl(),
            TypeInfo::decl(),
            SequenceInfo::decl(),
            DdlKind::decl(),
            DdlTarget::decl(),
            DdlResponse::decl(),
        ] {
            generated.push_str("export ");
            generated.push_str(&declaration.replace("bigint", "number"));
            generated.push('\n');
        }
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop/src/generated/contracts.ts");
        if std::env::var_os("PGDEV_GENERATE_TYPES").is_some() {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, &generated).unwrap();
        }
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            generated,
            "Run the documented contract generation command after changing DTOs"
        );
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SchemaData {
    pub tables: Vec<TableInfo>,
    pub views: Vec<ViewInfo>,
    pub functions: Vec<FunctionInfo>,
    pub types: Vec<TypeInfo>,
    pub sequences: Vec<SequenceInfo>,
    pub builtins: Vec<FunctionInfo>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct IndexInfo {
    pub name: String,
    #[serde(rename = "type")]
    #[ts(type = "'primary' | 'unique' | 'exclusion' | 'normal'")]
    pub kind: String,
    pub method: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct ConstraintInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub definition: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct TriggerInfo {
    pub name: String,
    pub definition: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    pub oid: String,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub triggers: Vec<TriggerInfo>,
    pub is_partition: bool,
    pub is_partitioned: bool,
    pub parents: String,
    #[ts(type = "'r' | 'p' | 'f'")]
    pub relkind: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct ViewInfo {
    pub schema: String,
    pub name: String,
    pub oid: String,
    pub materialized: bool,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub schema: String,
    pub name: String,
    pub args: String,
    pub returns: String,
    pub type_sig: String,
    #[ts(type = "'function' | 'procedure' | 'window' | 'trigger' | 'aggregate'")]
    pub kind: String,
    pub oid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub arguments: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct TypeInfo {
    pub schema: String,
    pub name: String,
    pub oid: String,
    #[ts(type = "'enum' | 'composite' | 'domain' | 'range'")]
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SequenceInfo {
    pub schema: String,
    pub name: String,
    pub oid: String,
    pub data_type: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum DdlKind {
    Table,
    View,
    Function,
    Index,
    Constraint,
    Trigger,
    Type,
    Sequence,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DdlTarget {
    #[serde(rename = "type")]
    pub kind: DdlKind,
    pub schema: String,
    pub name: String,
    pub oid: Option<String>,
    pub parent: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DdlResponse {
    pub ddl: String,
    pub read_only: bool,
}
