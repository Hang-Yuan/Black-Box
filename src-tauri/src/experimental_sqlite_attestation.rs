//! Exact SQLite control-schema attestation for disabled experimental slices.
//!
//! The source SQL hash alone cannot prove that CHECK constraints or trigger
//! bodies in an existing database still match the reviewed schema.  This
//! module materializes the reviewed SQL in an in-memory database and compares
//! its complete user-owned `sqlite_master` manifest with the live database.

use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExactSchemaAttestation {
    pub(crate) object_count: u64,
    pub(crate) expected_manifest_sha256: String,
    pub(crate) actual_manifest_sha256: String,
    pub(crate) verified: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaObject {
    object_type: String,
    name: String,
    table_name: String,
    sql: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn schema_manifest(connection: &Connection, label: &str) -> Result<Vec<SchemaObject>, String> {
    let mut statement = connection
        .prepare(
            "SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
             ORDER BY type ASC, name ASC, tbl_name ASC, sql ASC",
        )
        .map_err(|error| format!("Failed to prepare {label} exact-schema query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SchemaObject {
                object_type: row.get(0)?,
                name: row.get(1)?,
                table_name: row.get(2)?,
                sql: row.get(3)?,
            })
        })
        .map_err(|error| format!("Failed to query {label} exact schema: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode {label} exact schema: {error}"))
}

fn manifest_sha256(manifest: &[SchemaObject], label: &str) -> Result<String, String> {
    serde_json::to_vec(manifest)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|error| format!("Failed to canonicalize {label} exact schema: {error}"))
}

pub(crate) fn attest_exact_schema(
    actual: &Connection,
    reviewed_schema_sql: &str,
    label: &str,
) -> Result<ExactSchemaAttestation, String> {
    let expected = Connection::open_in_memory()
        .map_err(|error| format!("Failed to create {label} schema reference: {error}"))?;
    expected
        .execute_batch(reviewed_schema_sql)
        .map_err(|error| format!("Failed to materialize {label} reviewed schema: {error}"))?;
    let expected_manifest = schema_manifest(&expected, label)?;
    let actual_manifest = schema_manifest(actual, label)?;
    let expected_manifest_sha256 = manifest_sha256(&expected_manifest, label)?;
    let actual_manifest_sha256 = manifest_sha256(&actual_manifest, label)?;
    if actual_manifest != expected_manifest {
        return Err(format!(
            "{label} exact control-schema DDL mismatch (expected {expected_manifest_sha256}, observed {actual_manifest_sha256})"
        ));
    }
    Ok(ExactSchemaAttestation {
        object_count: expected_manifest.len() as u64,
        expected_manifest_sha256,
        actual_manifest_sha256,
        verified: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str = "
        CREATE TABLE gate(id INTEGER PRIMARY KEY CHECK(id > 0), value TEXT NOT NULL);
        CREATE TRIGGER gate_immutable BEFORE UPDATE ON gate BEGIN
          SELECT RAISE(ABORT, 'immutable');
        END;
    ";

    #[test]
    fn exact_schema_attestation_accepts_identical_ddl() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        let receipt = attest_exact_schema(&connection, SCHEMA, "fixture").unwrap();
        assert!(receipt.verified);
        assert_eq!(receipt.object_count, 2);
        assert_eq!(
            receipt.expected_manifest_sha256,
            receipt.actual_manifest_sha256
        );
    }

    #[test]
    fn exact_schema_attestation_rejects_trigger_body_drift() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE gate(id INTEGER PRIMARY KEY CHECK(id > 0), value TEXT NOT NULL);
                 CREATE TRIGGER gate_immutable BEFORE UPDATE ON gate BEGIN
                   SELECT RAISE(ABORT, 'changed');
                 END;",
            )
            .unwrap();
        let error = attest_exact_schema(&connection, SCHEMA, "fixture").unwrap_err();
        assert!(error.contains("exact control-schema DDL mismatch"));
    }

    #[test]
    fn exact_schema_attestation_rejects_extra_user_objects() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        connection
            .execute_batch("CREATE TABLE injected(value TEXT);")
            .unwrap();
        let error = attest_exact_schema(&connection, SCHEMA, "fixture").unwrap_err();
        assert!(error.contains("exact control-schema DDL mismatch"));
    }
}
