//! Transport-independent, read-only MCP foundation. Only the native application
//! binds active connections. No connection credentials or arbitrary SQL tools.
//! A future authenticated transport must create one McpSession per client.
use crate::{Database, DdlTarget, SchemaData};
use serde_json::{json, Map, Value};
use std::sync::{Arc, RwLock};
use std::time::Duration;

const PROTOCOL: &str = "2025-06-18";
const MAX_REQUEST: usize = 64 * 1024;
const MAX_RESULT: usize = 1024 * 1024;
const NOT_CONNECTED: &str =
    "pgDEV is not connected to a database. Open a connection in pgDEV, then ask again.";

#[derive(Clone, Default)]
struct Context {
    id: Option<String>,
    revision: u64,
}

#[derive(Clone)]
pub struct McpService {
    database: Database,
    active: Arc<RwLock<Context>>,
}

impl McpService {
    pub fn new(database: Database) -> Self {
        Self {
            database,
            active: Arc::new(RwLock::new(Context::default())),
        }
    }

    /// Called only by native connection lifecycle code, never by an MCP client.
    pub fn activate(&self, id: String) {
        let mut active = self.active.write().unwrap_or_else(|p| p.into_inner());
        active.id = Some(id);
        active.revision = active.revision.wrapping_add(1);
    }

    pub fn disconnected(&self, id: &str) {
        let mut active = self.active.write().unwrap_or_else(|p| p.into_inner());
        if active.id.as_deref() == Some(id) {
            active.id = None;
            active.revision = active.revision.wrapping_add(1);
        }
    }

    pub fn session(&self) -> McpSession {
        McpSession {
            service: self.clone(),
            initialized: false,
        }
    }

    async fn tool(&self, name: &str, args: &Map<String, Value>) -> Value {
        let context = self
            .active
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let Some(id) = context.id.as_deref() else {
            return tool_error(NOT_CONNECTED);
        };
        let outcome = tokio::time::timeout(Duration::from_secs(30), async {
            match name {
                "get_schema" => self
                    .database
                    .schema(id)
                    .await
                    .map(|data| schema_result(data, args)),
                "get_ddl" => {
                    // Arguments were validated before any database access.
                    let target: DdlTarget = serde_json::from_value(Value::Object(args.clone()))
                        .expect("validated DDL target");
                    self.database
                        .ddl(id, target)
                        .await
                        .map(|result| json!({"ddl": result.ddl}))
                }
                _ => unreachable!("validated tool name"),
            }
        })
        .await;
        let active = self.active.read().unwrap_or_else(|p| p.into_inner());
        if active.revision != context.revision || active.id != context.id {
            return tool_error("The active pgDEV connection changed during this request. Retry against the current connection.");
        }
        match outcome {
            Ok(Ok(result)) => tool_result(result),
            Ok(Err(error)) => tool_error(&error.message),
            Err(_) => {
                tool_error("Catalog request timed out; narrow the object/schema filter and retry.")
            }
        }
    }
}

pub struct McpSession {
    service: McpService,
    initialized: bool,
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}
fn tool_error(message: &str) -> Value {
    // Never include request parameters, connection IDs or credentials.
    let text = if message.len() > MAX_REQUEST {
        "Catalog operation failed"
    } else {
        message
    };
    json!({"content": [{"type": "text", "text": text}], "isError": true})
}
fn tool_result(result: Value) -> Value {
    let text = result.to_string();
    if text.len() > MAX_RESULT {
        return tool_error("Catalog result exceeds 1 MiB. Use a narrower schema/table filter or request one DDL object.");
    }
    json!({"content": [{"type": "text", "text": text}], "isError": false})
}

fn tool_definitions() -> Value {
    json!({"tools": [
        {"name": "get_schema", "description": "Read the active pgDEV connection's catalog. Optional exact schema/relation filters. No SQL is executed in editor tabs.",
         "inputSchema": {"type": "object", "properties": {"schema": {"type": "string", "maxLength": 1024}, "table": {"type": "string", "maxLength": 1024}}, "additionalProperties": false},
         "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true}},
        {"name": "get_ddl", "description": "Read generated DDL for an object on the active pgDEV connection. The SQL is returned as text, never executed.",
         "inputSchema": {"type": "object", "properties": {
             "type": {"type": "string", "enum": ["table", "view", "function", "index", "constraint", "trigger", "type", "sequence"]},
             "schema": {"type": "string", "minLength": 1, "maxLength": 1024}, "name": {"type": "string", "minLength": 1, "maxLength": 1024},
             "oid": {"type": "string", "pattern": "^[0-9]+$", "maxLength": 10}, "parent": {"type": "string", "maxLength": 1024}},
             "required": ["type", "schema", "name"], "additionalProperties": false},
         "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true}}
    ]})
}

fn valid_arguments(name: &str, args: &Map<String, Value>) -> bool {
    let allowed: &[&str] = if name == "get_schema" {
        &["schema", "table"]
    } else {
        &["type", "schema", "name", "oid", "parent"]
    };
    if args.iter().any(|(key, value)| {
        !allowed.contains(&key.as_str()) || !value.as_str().is_some_and(|s| s.len() <= 1024)
    }) {
        return false;
    }
    if name == "get_ddl" {
        if !["schema", "name"].iter().all(|key| {
            args.get(*key)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
        }) {
            return false;
        }
        if args.get("oid").is_some_and(|value| {
            !value.as_str().is_some_and(|s| {
                !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) && s.parse::<u32>().is_ok()
            })
        }) {
            return false;
        }
        return serde_json::from_value::<DdlTarget>(Value::Object(args.clone())).is_ok();
    }
    true
}

impl McpSession {
    /// Input is bounded before parsing; notifications never receive responses.
    /// JSON-RPC batching is intentionally unsupported (MCP 2025-06-18).
    pub async fn handle(&mut self, input: &str) -> Option<Value> {
        if input.len() > MAX_REQUEST {
            return Some(rpc_error(Value::Null, -32600, "Request exceeds 64 KiB"));
        }
        let value: Value = match serde_json::from_str(input) {
            Ok(value) => value,
            Err(_) => return Some(rpc_error(Value::Null, -32700, "Parse error")),
        };
        let Some(request) = value.as_object() else {
            return Some(rpc_error(Value::Null, -32600, "Invalid request"));
        };
        let id = request.get("id");
        if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || !request.get("method").is_some_and(Value::is_string)
            || id.is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        {
            return Some(rpc_error(Value::Null, -32600, "Invalid request"));
        }
        let method = request["method"].as_str().unwrap();
        // A notification must never trigger a tool call or a lifecycle change.
        let id = id?.clone();
        let empty = Map::new();
        let params = match request.get("params") {
            None => &empty,
            Some(Value::Object(params)) => params,
            _ => return Some(rpc_error(id, -32602, "Parameters must be an object")),
        };
        let result = match method {
            "ping" => json!({}),
            "initialize" => {
                if self.initialized {
                    return Some(rpc_error(id, -32600, "Session already initialized"));
                }
                if !params.get("protocolVersion").is_some_and(Value::is_string)
                    || !params.get("capabilities").is_some_and(Value::is_object)
                    || !params
                        .get("clientInfo")
                        .and_then(Value::as_object)
                        .is_some_and(|info| {
                            info.get("name").is_some_and(Value::is_string)
                                && info.get("version").is_some_and(Value::is_string)
                        })
                {
                    return Some(rpc_error(id, -32602, "Invalid initialize parameters"));
                }
                self.initialized = true;
                json!({"protocolVersion": PROTOCOL, "capabilities": {"tools": {}}, "serverInfo": {"name": "pgDEV", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": "Catalog-only prototype. Uses the active desktop connection. No query execution or editor mutation tools are exposed."})
            }
            _ if !self.initialized => {
                return Some(rpc_error(id, -32600, "Initialize this session first"))
            }
            "tools/list" => {
                if params.keys().any(|key| key != "_meta")
                    || params.get("_meta").is_some_and(|meta| !meta.is_object())
                {
                    return Some(rpc_error(id, -32602, "Tool pagination is not supported"));
                }
                tool_definitions()
            }
            "tools/call" => {
                if params
                    .keys()
                    .any(|key| !["name", "arguments", "_meta"].contains(&key.as_str()))
                    || params.get("_meta").is_some_and(|meta| !meta.is_object())
                {
                    return Some(rpc_error(id, -32602, "Invalid tool call parameters"));
                }
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return Some(rpc_error(id, -32602, "Tool name is required"));
                };
                if !["get_schema", "get_ddl"].contains(&name) {
                    return Some(rpc_error(id, -32602, "Unknown tool"));
                }
                let args = match params.get("arguments") {
                    None => &empty,
                    Some(Value::Object(args)) => args,
                    _ => return Some(rpc_error(id, -32602, "Tool arguments must be an object")),
                };
                if !valid_arguments(name, args) {
                    return Some(rpc_error(id, -32602, "Invalid tool arguments"));
                }
                self.service.tool(name, args).await
            }
            _ => return Some(rpc_error(id, -32601, "Method not found")),
        };
        Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }
}

fn schema_result(data: SchemaData, args: &Map<String, Value>) -> Value {
    let schema = args
        .get("schema")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let table = args
        .get("table")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let matches = |s: &str, name: &str| {
        schema.is_none_or(|filter| filter == s) && table.is_none_or(|filter| filter == name)
    };
    let tables = data
        .tables
        .into_iter()
        .filter(|t| matches(&t.schema, &t.name))
        .collect::<Vec<_>>();
    let views = data
        .views
        .into_iter()
        .filter(|t| matches(&t.schema, &t.name))
        .collect::<Vec<_>>();
    let truncated = tables.len() + views.len() > 200;
    json!({
        "tables": tables.into_iter().take(200).map(|t| json!({"schema": t.schema, "name": t.name, "columns": t.columns.into_iter().map(|c| json!({"name": c.name, "type": c.data_type, "nullable": c.nullable, "default": c.default_value})).collect::<Vec<_>>() })).collect::<Vec<_>>(),
        "views": views.into_iter().take(200).map(|t| json!({"schema": t.schema, "name": t.name, "materialized": t.materialized, "columns": t.columns.into_iter().map(|c| json!({"name": c.name, "type": c.data_type, "nullable": c.nullable})).collect::<Vec<_>>() })).collect::<Vec<_>>(),
        "functions": data.functions.into_iter().filter(|f| matches(&f.schema, &f.name)).map(|f| json!({"schema": f.schema, "name": f.name, "kind": f.kind, "arguments": f.arguments.filter(|s| !s.is_empty()).unwrap_or(f.args), "returns": f.returns, "comment": f.comment})).collect::<Vec<_>>(),
        "types": data.types.into_iter().filter(|t| matches(&t.schema, &t.name)).map(|t| json!({"schema": t.schema, "name": t.name, "kind": t.kind, "detail": t.detail})).collect::<Vec<_>>(),
        "sequences": data.sequences.into_iter().filter(|s| matches(&s.schema, &s.name)).map(|s| json!({"schema": s.schema, "name": s.name, "dataType": s.data_type, "detail": s.detail})).collect::<Vec<_>>(),
        "truncated": truncated
    })
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
