use futures_util::FutureExt;
use pgdev_core::{ConnectionConfig, Database, DdlKind, DdlTarget, QueryRequest, QueryResult};
use serde_json::{json, Value};
use std::{
    future::Future,
    io::Write,
    panic::AssertUnwindSafe,
    process::{Command, Stdio},
    sync::Arc,
};
use uuid::Uuid;

async fn query_data(
    f: &Fixture,
    sql: &str,
    transaction_id: Option<String>,
    max_rows: u32,
) -> pgdev_core::QueryResponse {
    f.db.query(QueryRequest {
        id: f.id.clone(),
        tab_key: "editing".into(),
        sql: sql.into(),
        transaction_id,
        max_rows,
    })
    .await
    .unwrap()
}

fn row_request(
    f: &Fixture,
    table: &str,
    key: Value,
    set: Value,
    transaction_id: Option<String>,
) -> pgdev_core::RowUpdateRequest {
    serde_json::from_value(json!({"id": f.id, "tabKey":"editing", "schema":"public", "table":table, "key":key, "set":set, "transactionId": transaction_id})).unwrap()
}

#[tokio::test]
#[ignore = "requires PGDEV_TEST_URL and CREATEDB privileges"]
async fn editable_metadata_and_updates_preserve_paging_and_manual_transactions() {
    using(|f| async move {
        f.exec(r#"
CREATE TABLE public.editable (id bigint PRIMARY KEY, note varchar(20), fixed char(4), amount numeric, payload jsonb, computed integer GENERATED ALWAYS AS (length(note)) STORED, raw bytea, enabled boolean);
INSERT INTO public.editable(id,note) VALUES (9007199254740993,'first'), (9007199254740994,'second'), (9007199254740995,'third');
CREATE VIEW public.edit_view AS SELECT * FROM public.editable;
CREATE TABLE public.no_key (id integer, note text);
CREATE TABLE public.inherit_parent (id integer PRIMARY KEY);
CREATE TABLE public.inherit_child () INHERITS (public.inherit_parent);
CREATE TABLE public.composite (a integer, b text, note text, PRIMARY KEY(a,b));
INSERT INTO public.composite VALUES (1,'key','old');
"#).await;
        let response = query_data(&f,"SELECT * FROM public.editable ORDER BY id",None,1).await;
        let QueryResult::Data(data) = &response.results[0] else { panic!("Expected data") };
        assert!(data.truncated);
        assert_eq!(data.column_type_lengths[1],Some(20));
        assert_eq!(data.column_type_lengths[2],Some(4));
        assert_eq!(data.column_type_lengths[3],None);
        let grid = data.editable.as_ref().unwrap();
        assert_eq!(grid.pk,["id"]);
        assert!(grid.columns.iter().any(|c| c.name == "computed" && c.generated));
        let result = f.db.row_update(row_request(&f,"editable",json!({"id":"9007199254740993"}),json!({"note":"O'Reilly", "amount":"12345678901234567890.123456789", "payload":"{\"x\":12345678901234567890}", "enabled":true}),None)).await.unwrap();
        assert_eq!(result.row["id"],json!("9007199254740993"));
        assert_eq!(result.row["amount"],json!("12345678901234567890.123456789"));
        assert_eq!(result.row["computed"],json!(8));
        assert_eq!(result.row["enabled"],json!(true));
        let page = f.db.fetch_more(&f.id,"editing",1).await.unwrap();
        assert_eq!(page.rows[0][0],json!("9007199254740994"));
        for sql in ["SELECT id+1 AS id, note FROM public.editable", "SELECT id AS id, note FROM public.editable", "SELECT note FROM public.editable", "SELECT id, id FROM public.editable", "SELECT DISTINCT * FROM public.editable", "SELECT * FROM public.edit_view", "SELECT * FROM public.no_key", "SELECT * FROM public.inherit_parent", "SELECT a FROM public.composite"] {
            let response = query_data(&f,sql,None,500).await;
            let QueryResult::Data(data) = &response.results[0] else { panic!("Expected data: {sql}") };
            assert!(data.editable.is_none(),"Must not be editable: {sql}");
        }
        let response = query_data(&f,"SELECT a,b,note FROM public.composite",None,500).await;
        let QueryResult::Data(data) = &response.results[0] else { panic!("Expected data") };
        assert_eq!(data.editable.as_ref().unwrap().pk,["a","b"]);
        for set in [json!({"id":2}),json!({"computed":2}),json!({"raw":"\\x00"}),json!({"missing":1}),json!({"payload":{"x":1}})] {
            assert!(f.db.row_update(row_request(&f,"editable",json!({"id":"9007199254740993"}),set,None)).await.is_err());
        }
        assert!(f.db.row_update(row_request(&f,"composite",json!({"a":1}),json!({"note":"bad"}),None)).await.is_err());
        let missing = f.db.row_update(row_request(&f,"editable",json!({"id":0}),json!({"note":"missing"}),None)).await.err().unwrap();
        assert_eq!(missing.code.as_deref(),Some("ROW_NOT_FOUND"));
        let transaction = query_data(&f,"BEGIN",None,1).await.transaction_id.unwrap();
        let stale = f.db.row_update(row_request(&f,"editable",json!({"id":"9007199254740993"}),json!({"note":"stale"}),None)).await.err().unwrap();
        assert_eq!(stale.code.as_deref(),Some("TRANSACTION_CHANGED"));
        let result = f.db.row_update(row_request(&f,"editable",json!({"id":"9007199254740993"}),json!({"note":null}),Some(transaction.clone()))).await.unwrap();
        assert!(result.row["note"].is_null());
        assert_eq!(result.transaction_id.as_deref(),Some(transaction.as_str()));
        query_data(&f,"ROLLBACK",Some(transaction),1).await;
        let response = query_data(&f,"SELECT note FROM public.editable WHERE id=9007199254740993",None,500).await;
        let QueryResult::Data(data) = &response.results[0] else { panic!("Expected data") };
        assert_eq!(data.rows[0][0],json!("O'Reilly"));
        let transaction = query_data(&f,"BEGIN",None,1).await.transaction_id.unwrap();
        let error = f.db.row_update(row_request(&f,"editable",json!({"id":"9007199254740993"}),json!({"amount":"not numeric"}),Some(transaction.clone()))).await.err().unwrap();
        assert!(error.transaction_open.unwrap());
        query_data(&f,"ROLLBACK",Some(transaction),1).await;
        // Fresh catalog validation must reject edits after a table changes.
        f.exec("ALTER TABLE public.editable DROP COLUMN note CASCADE").await;
        assert!(f.db.row_update(row_request(&f,"editable",json!({"id":"9007199254740993"}),json!({"note":"stale metadata"}),None)).await.is_err());
    }).await;
}

struct Fixture {
    db: Database,
    root: String,
    id: String,
    name: String,
    uri: String,
}

fn table_request(state: &pgdev_core::TableEditState) -> pgdev_core::TableEditRequest {
    serde_json::from_value(json!({"description":state.description,"fingerprint":state.fingerprint,"columns":state.columns})).unwrap()
}

#[tokio::test]
#[ignore = "requires PGDEV_TEST_URL, CREATEDB privileges and npm dependencies"]
async fn table_editor_state_fingerprint_and_change_scripts_match_reference() {
    using(|f| async move {
        f.exec(r#"
CREATE TABLE public.parent (a integer, b integer, PRIMARY KEY(a,b));
CREATE TABLE public.structure (
  id bigint PRIMARY KEY, identity_n bigint GENERATED ALWAYS AS IDENTITY,
  serial_n serial, a integer, b integer, note text DEFAULT 'North  America',
  computed integer GENERATED ALWAYS AS (a + b) STORED, "new:1" text, spare text, dropped text,
  CONSTRAINT structure_unique UNIQUE(a,b),
  CONSTRAINT structure_fk FOREIGN KEY(a,b) REFERENCES public.parent(a,b)
);
ALTER TABLE public.structure DROP COLUMN dropped;
ALTER TABLE public.structure ADD COLUMN tail text;
CREATE UNIQUE INDEX structure_note_uk ON public.structure(note) INCLUDE(spare);
CREATE UNIQUE INDEX structure_expression_uk ON public.structure(lower(note));
COMMENT ON TABLE public.structure IS 'Original ą😀';
COMMENT ON COLUMN public.structure.note IS 'Original column';
CREATE TABLE public.partitioned (id integer PRIMARY KEY) PARTITION BY RANGE(id);
CREATE TABLE public.partition_one PARTITION OF public.partitioned FOR VALUES FROM(0) TO(10);
CREATE VIEW public.structure_view AS SELECT * FROM public.structure;
"#).await;
        let schema = f.db.schema(&f.id).await.unwrap();
        let oid = schema.tables.iter().find(|t| t.name == "structure").unwrap().oid.clone();
        let state = f.db.table_edit_state(&f.id,&oid).await.unwrap();
        assert_eq!(state.columns.iter().find(|c| c.name == "identity_n").unwrap().default_value,None);
        assert_eq!(state.columns.iter().find(|c| c.name == "serial_n").unwrap().lock_kind,Some(pgdev_core::TableEditLockKind::Serial));
        assert!(state.columns.iter().find(|c| c.name == "spare").unwrap().uks.is_none());
        assert_eq!(state.columns.iter().find(|c| c.name == "a").unwrap().fks.as_ref().unwrap()[0].label,"FK1");
        let partition_oid = schema.tables.iter().find(|t| t.name == "partitioned").unwrap().oid.clone();
        let partition = f.db.table_edit_state(&f.id,&partition_oid).await.unwrap();
        for rejected in [&schema.tables.iter().find(|t| t.name == "partition_one").unwrap().oid,&schema.views[0].oid] {
            assert!(f.db.table_edit_state(&f.id,rejected).await.is_err());
        }
        assert_eq!(f.db.table_edit_state(&f.id,"0").await.err().unwrap().code.as_deref(),Some("OBJECT_NOT_FOUND"));
        for rejected in ["garbage","1; DROP TABLE structure","-1","4294967296"] { assert!(f.db.table_edit_state(&f.id,rejected).await.is_err()); }
        let original = table_request(&state);
        let mut requests = vec![original.clone()];
        let mut change = original.clone();
        change.description = Some("Changed 'table' ą😀".into());
        for c in &mut change.columns {
            if c.name == "a" { c.name = "b".into(); }
            else if c.name == "b" { c.name = "a".into(); }
            else if c.name == "note" { c.data_type = "varchar(60)".into(); c.nullable = false; c.default_value = Some(" 'South  America' ".into()); c.description = Some("Changed 'column'".into()); }
        }
        change.columns.retain(|c| c.name != "spare");
        change.columns.push(serde_json::from_value(json!({"id":"added:1","added":true,"name":"extra\"column","type":"integer","nullable":false,"defaultValue":" 7 ","description":"New 'column'"})).unwrap());
        requests.push(change.clone());
        // Valid changes around serial nullability, comment clearing and quoted
        // literal differences. No user expressions are executed by planning.
        let mut serial = original.clone(); serial.columns.iter_mut().find(|c| c.name == "serial_n").unwrap().nullable = true; requests.push(serial);
        let mut literal = original.clone(); literal.columns.iter_mut().find(|c| c.name == "note").unwrap().default_value = Some("'North America'::text".into()); requests.push(literal);
        let mut comments = original.clone(); comments.description = Some("  ".into()); comments.columns.iter_mut().find(|c| c.name == "note").unwrap().description = None; requests.push(comments);
        for locked in ["identity_n","serial_n","computed"] {
            let mut request = original.clone(); request.columns.iter_mut().find(|c| c.name == locked).unwrap().data_type = "text".into(); requests.push(request);
        }
        let mut request = original.clone(); request.columns.retain(|c| c.name != "id"); requests.push(request);
        let mut request = original.clone(); request.columns[0].nullable = true; requests.push(request);
        let mut request = original.clone(); request.columns[0].id = "not_live".into(); requests.push(request);
        let mut request = original.clone(); request.columns[0].added = Some(true); requests.push(request);
        let mut request = original.clone(); request.columns[1].name = request.columns[0].name.clone(); requests.push(request);
        let mut request = original.clone(); request.columns[1].id = request.columns[0].id.clone(); requests.push(request);
        let mut request = original.clone(); request.columns[3].name = "  ".into(); requests.push(request);
        let mut request = original.clone(); request.columns[3].data_type = "  ".into(); requests.push(request);
        let mut request = original.clone(); request.fingerprint = "stale".into(); requests.push(request);
        let results = futures_util::future::join_all(requests.iter().map(|r| f.db.table_edit_ddl(&f.id,&oid,r.clone()))).await;
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut child = Command::new("node").args(["--import","tsx","test/native-tableedit-reference.mjs"]).current_dir(root)
            .env("PGDEV_MIGRATION_URL",&f.uri).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let edits = requests.iter().map(|request| json!({"oid":oid,"request":request})).collect::<Vec<_>>();
        child.stdin.take().unwrap().write_all(&serde_json::to_vec(&json!({"oids":[oid,partition_oid],"edits":edits})).unwrap()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(),"Node table editor oracle failed: {}",String::from_utf8_lossy(&output.stderr));
        let reference: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(serde_json::to_value(&state).unwrap(),reference["states"][0]);
        assert_eq!(serde_json::to_value(&partition).unwrap(),reference["states"][1]);
        for (index,result) in results.into_iter().enumerate() {
            let actual = match result { Ok(result) => json!({"ddl":result.ddl}), Err(error) => json!({"error":error.message}) };
            assert_eq!(actual,reference["results"][index],"Table editor drift for request {index}");
        }
        // Planning is read-only; even the complex edit leaves the table intact.
        assert_eq!(f.db.table_edit_state(&f.id,&oid).await.unwrap().fingerprint,state.fingerprint);
        let ddl = f.db.table_edit_ddl(&f.id,&oid,change).await.unwrap().ddl.unwrap();
        f.exec("DROP VIEW public.structure_view").await;
        f.exec(&ddl).await;
        let rebuilt = f.db.table_edit_state(&f.id,&oid).await.unwrap();
        assert_ne!(rebuilt.fingerprint,state.fingerprint);
        assert_eq!(rebuilt.columns.iter().find(|c| c.id == "4").unwrap().name,"b");
        assert!(rebuilt.columns.iter().any(|c| c.name == "extra\"column"));
        assert!(f.db.table_edit_ddl(&f.id,&oid,table_request(&rebuilt)).await.unwrap().ddl.is_none());
        let stale = f.db.table_edit_ddl(&f.id,&oid,original).await.err().unwrap();
        assert_eq!(stale.code.as_deref(),Some("TABLE_CHANGED"));
    }).await;
}

fn config(uri: &str) -> ConnectionConfig {
    serde_json::from_value(json!({"connectionString": uri})).unwrap()
}

async fn execute(db: &Database, id: &str, sql: &str) {
    db.query(QueryRequest {
        id: id.to_owned(),
        tab_key: "fixture".to_owned(),
        sql: sql.to_owned(),
        transaction_id: None,
        max_rows: 500,
    })
    .await
    .unwrap();
}

impl Fixture {
    async fn new() -> Self {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env");
        let uri = std::env::var("PGDEV_TEST_URL")
            .ok()
            .or_else(|| {
                dotenvy::from_path_iter(path)
                    .ok()?
                    .filter_map(Result::ok)
                    .find_map(|(name, value)| (name == "PGDEV_TEST_URL").then_some(value))
            })
            .expect("PGDEV_TEST_URL is required");
        let db = Database::default();
        let root = db.connect(config(&uri)).await.unwrap().id;
        let name = format!(
            "pgdev_native_{}_{}",
            Uuid::new_v4().simple(),
            std::process::id()
        );
        let mut url = url::Url::parse(&uri).expect("PGDEV_TEST_URL must be a PostgreSQL URI");
        url.set_path(&format!("/{name}"));
        execute(&db, &root, &format!("CREATE DATABASE \"{name}\"")).await;
        let uri = url.to_string();
        let id = match db.connect(config(&uri)).await {
            Ok(connection) => connection.id,
            Err(error) => {
                execute(
                    &db,
                    &root,
                    &format!("DROP DATABASE \"{name}\" WITH (FORCE)"),
                )
                .await;
                panic!("Scratch connection failed: {error:?}");
            }
        };
        Self {
            db,
            root,
            id,
            name,
            uri,
        }
    }
    async fn exec(&self, sql: &str) {
        execute(&self.db, &self.id, sql).await;
    }
    async fn cleanup(&self) {
        self.db.disconnect(&self.id).await.unwrap();
        execute(
            &self.db,
            &self.root,
            &format!("DROP DATABASE \"{}\" WITH (FORCE)", self.name),
        )
        .await;
        self.db.disconnect(&self.root).await.unwrap();
    }
    fn target(
        &self,
        kind: DdlKind,
        name: &str,
        oid: Option<String>,
        parent: Option<&str>,
    ) -> DdlTarget {
        DdlTarget {
            kind,
            schema: "public".to_owned(),
            name: name.to_owned(),
            oid,
            parent: parent.map(str::to_owned),
        }
    }
}

async fn using<F, Fut>(test: F)
where
    F: FnOnce(Arc<Fixture>) -> Fut,
    Fut: Future<Output = ()>,
{
    let fixture = Arc::new(Fixture::new().await);
    let outcome = AssertUnwindSafe(test(fixture.clone())).catch_unwind().await;
    // Always remove only the PID-suffixed database this fixture created,
    // including after an assertion panic. Never touch the source database.
    fixture.cleanup().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
#[ignore = "requires PGDEV_TEST_URL, CREATEDB privileges and npm dependencies"]
async fn catalog_and_all_ddl_kinds_match_existing_application() {
    using(|f| async move {
        f.exec(r#"
CREATE TYPE public.state AS ENUM ('first', 'O''Reilly');
CREATE DOMAIN public.label AS varchar(30) DEFAULT 'hello' NOT NULL CHECK (VALUE <> '');
CREATE TYPE public.pair AS (x integer, note text COLLATE "C");
CREATE TYPE public.span AS RANGE (subtype = integer);
CREATE TABLE public.items (
  id bigint GENERATED BY DEFAULT AS IDENTITY (START WITH 10 INCREMENT BY 2 CACHE 3) PRIMARY KEY,
  serial_id serial, label public.label, state public.state DEFAULT 'first',
  calculated integer GENERATED ALWAYS AS ((id % 100)::integer) STORED
);
ALTER SEQUENCE public.items_serial_id_seq RENAME TO "it's serial";
ALTER SEQUENCE public."it's serial" MAXVALUE 2147483000 CACHE 7;
ALTER SEQUENCE public.items_id_seq RENAME TO "renamed identity";
ALTER TABLE public.items ADD CONSTRAINT positive_id CHECK (id > 0) NOT VALID;
CREATE INDEX items_label_idx ON public.items (label);
COMMENT ON TABLE public.items IS 'A quoted ''table'' with Unicode ą😀';
COMMENT ON COLUMN public.items.label IS 'A label';
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items FORCE ROW LEVEL SECURITY;
CREATE POLICY select_items ON public.items AS RESTRICTIVE FOR SELECT TO PUBLIC USING (id > 0);
CREATE VIEW public.item_view WITH (security_barrier = true) AS SELECT id, label FROM public.items;
CREATE MATERIALIZED VIEW public.item_materialized AS SELECT id FROM public.items;
CREATE INDEX item_materialized_idx ON public.item_materialized(id);
CREATE TABLE public.events (id integer PRIMARY KEY, note text) PARTITION BY RANGE(id);
CREATE TABLE public.events_first PARTITION OF public.events FOR VALUES FROM (0) TO (10);
CREATE TABLE public.events_default PARTITION OF public.events DEFAULT;
CREATE INDEX event_note_idx ON public.events_first(note);
ALTER TABLE public.events_first ADD CONSTRAINT note_present CHECK (note IS NOT NULL);
CREATE TABLE public.base (n integer);
CREATE TABLE public.inherited (note text) INHERITS (public.base);
CREATE UNLOGGED TABLE public.unlogged (n integer);
CREATE SEQUENCE public.descending AS bigint INCREMENT BY -2 MINVALUE -9223372036854775808 MAXVALUE -1 START WITH -1 CACHE 3 CYCLE;
CREATE FUNCTION public.echo(x integer) RETURNS integer LANGUAGE sql AS $$ SELECT x $$;
CREATE FUNCTION public.echo(x text) RETURNS text LANGUAGE sql AS $$ SELECT x $$;
CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER touch_items BEFORE INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.touch();
CREATE PROCEDURE public.noop() LANGUAGE sql AS $$ SELECT 1 $$;
CREATE AGGREGATE public.total(integer) (SFUNC = pg_catalog.int4pl, STYPE = integer, INITCOND = '0', PARALLEL = SAFE);
CREATE TABLE public.standalone (id serial PRIMARY KEY, note varchar(20) DEFAULT 'test' NOT NULL);
ALTER TABLE public.standalone ADD CONSTRAINT note_length CHECK (length(note) > 0) NOT VALID;
COMMENT ON TABLE public.standalone IS 'Round trip';
"#).await;
        let schema = f.db.schema(&f.id).await.unwrap();
        assert_eq!(schema.tables.len(),8);
        assert_eq!(schema.views.len(),2);
        assert!(schema.builtins.iter().any(|function| function.name == "coalesce"));
        assert!(!schema.builtins.iter().any(|function| function.name.starts_with("pg_")));
        let mut targets = Vec::new();
        for table in &schema.tables {
            targets.push(f.target(DdlKind::Table,&table.name,Some(table.oid.clone()),None));
            for index in &table.indexes { targets.push(f.target(DdlKind::Index,&index.name,None,None)); }
            for constraint in &table.constraints { targets.push(f.target(DdlKind::Constraint,&constraint.name,None,Some(&table.name))); }
            for trigger in &table.triggers { targets.push(f.target(DdlKind::Trigger,&trigger.name,None,Some(&table.name))); }
        }
        for view in &schema.views { targets.push(f.target(DdlKind::View,&view.name,Some(view.oid.clone()),None)); }
        for function in &schema.functions { targets.push(f.target(DdlKind::Function,&function.name,Some(function.oid.clone()),None)); }
        for data_type in &schema.types { targets.push(f.target(DdlKind::Type,&data_type.name,Some(data_type.oid.clone()),None)); }
        for sequence in &schema.sequences { targets.push(f.target(DdlKind::Sequence,&sequence.name,Some(sequence.oid.clone()),None)); }
        let mut ddls = Vec::new();
        for target in &targets {
            let result = f.db.ddl(&f.id,target.clone()).await.unwrap();
            assert_eq!(result.read_only, matches!(target.kind,DdlKind::View) && target.name == "item_materialized");
            ddls.push(result.ddl);
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut child = Command::new("node").args(["--import","tsx","test/native-catalog-reference.mjs"]).current_dir(root)
            .env("PGDEV_MIGRATION_URL",&f.uri).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(&serde_json::to_vec(&json!({"targets": targets})).unwrap()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(),"Node catalog oracle failed: {}",String::from_utf8_lossy(&output.stderr));
        let reference: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(serde_json::to_value(schema).unwrap(),reference["schema"]);
        for (index, ddl) in ddls.iter().enumerate() { assert_eq!(json!(ddl),reference["ddls"][index],"DDL drift for {:?}",targets[index]); }
        let ddl = f.db.ddl(&f.id,f.target(DdlKind::Table,"standalone",None,None)).await.unwrap().ddl;
        f.exec("DROP TABLE public.standalone").await;
        f.exec(&ddl).await;
        let rebuilt = f.db.ddl(&f.id,f.target(DdlKind::Table,"standalone",None,None)).await.unwrap().ddl;
        assert_eq!(ddl,rebuilt);
    }).await;
}

#[tokio::test]
#[ignore = "requires PGDEV_TEST_URL and CREATEDB privileges"]
async fn catalog_capacity_and_missing_objects_do_not_disturb_transactions() {
    using(|f| async move {
        f.exec("CREATE TABLE public.probe (id integer)").await;
        let mut transactions = Vec::new();
        for tab in 0..5 {
            let tab_key = format!("pinned{tab}");
            let response =
                f.db.query(QueryRequest {
                    id: f.id.clone(),
                    tab_key: tab_key.clone(),
                    sql: "BEGIN".to_owned(),
                    transaction_id: None,
                    max_rows: 1,
                })
                .await
                .unwrap();
            transactions.push((tab_key, response.transaction_id));
        }
        assert_eq!(f.db.schema(&f.id).await.unwrap().tables.len(), 1);
        assert!(f
            .db
            .ddl(&f.id, f.target(DdlKind::Table, "probe", None, None))
            .await
            .unwrap()
            .ddl
            .contains("CREATE TABLE"));
        let error =
            f.db.ddl(&f.id, f.target(DdlKind::View, "probe", None, None))
                .await
                .err()
                .unwrap();
        assert_eq!(error.code.as_deref(), Some("OBJECT_NOT_FOUND"));
        let oid = f.db.schema(&f.id).await.unwrap().tables[0].oid.clone();
        let stale =
            f.db.ddl(
                &f.id,
                f.target(DdlKind::Table, "stale_name", Some(oid), None),
            )
            .await
            .unwrap();
        assert!(stale.ddl.contains("\"public\".\"probe\""));
        for (tab_key, transaction_id) in transactions {
            let result =
                f.db.query(QueryRequest {
                    id: f.id.clone(),
                    tab_key,
                    sql: "ROLLBACK".to_owned(),
                    transaction_id,
                    max_rows: 1,
                })
                .await
                .unwrap();
            assert!(matches!(result.results[0], QueryResult::Command(_)));
        }
    })
    .await;
}
