mod ddl;
use crate::{CoreError, Database, DdlResponse, DdlTarget, SchemaData};
use tokio_postgres::{types::Type, Row};

pub(crate) fn optional(row: &Row, field: &str) -> Result<Option<String>, CoreError> {
    let column = row
        .columns()
        .iter()
        .find(|c| c.name() == field)
        .ok_or_else(|| CoreError::local(format!("Missing catalog field: {field}")))?;
    Ok(match *column.type_() {
        Type::CHAR => row.try_get::<_, Option<i8>>(field)?.map(|value| {
            if value == 0 {
                String::new()
            } else {
                (value as u8 as char).to_string()
            }
        }),
        Type::INT2 => row
            .try_get::<_, Option<i16>>(field)?
            .map(|value| value.to_string()),
        Type::INT4 => row
            .try_get::<_, Option<i32>>(field)?
            .map(|value| value.to_string()),
        Type::INT8 => row
            .try_get::<_, Option<i64>>(field)?
            .map(|value| value.to_string()),
        _ => row.try_get::<_, Option<String>>(field)?,
    })
}

pub(crate) fn text(row: &Row, field: &str) -> Result<String, CoreError> {
    optional(row, field)?
        .ok_or_else(|| CoreError::local(format!("Unexpected NULL catalog field: {field}")))
}

pub(crate) fn flag(row: &Row, field: &str) -> Result<bool, CoreError> {
    Ok(row.try_get::<_, Option<bool>>(field)?.unwrap_or(false))
}

pub(crate) fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
pub(crate) fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", ident(schema), ident(name))
}
pub(crate) fn not_found() -> CoreError {
    let mut error = CoreError::local("Object not found");
    error.code = Some("OBJECT_NOT_FOUND".to_owned());
    error
}

impl Database {
    pub async fn schema(&self, id: &str) -> Result<SchemaData, CoreError> {
        let lease = self.catalog_client(id).await?;
        let value: serde_json::Value = lease
            .client()
            .query_one(include_str!("schema.sql"), &[])
            .await?
            .get(0);
        serde_json::from_value(value)
            .map_err(|error| CoreError::local(format!("Invalid catalog response: {error}")))
    }

    pub async fn ddl(&self, id: &str, target: DdlTarget) -> Result<DdlResponse, CoreError> {
        let mut lease = self.catalog_client(id).await?;
        // Dropping an interrupted future must close the socket rather than
        // return an unfinished transaction to the pool.
        lease.set_reusable(false);
        // Several catalog reads must observe the same object version. Never
        // share a query-tab transaction or leave a failed transaction in pool.
        lease
            .client()
            .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .await?;
        let result = ddl::object(lease.client(), &target).await;
        let finish = lease
            .client()
            .batch_execute(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
            .await;
        if let Err(error) = finish {
            lease.discard();
            return Err(error.into());
        }
        lease.set_reusable(true);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_are_quoted_not_interpolated_as_sql() {
        assert_eq!(qualified("schema'--", "a\"b"), "\"schema'--\".\"a\"\"b\"");
    }
}
