//! Framework-independent PostgreSQL core. Shared by desktop commands and,
//! later, the MCP service; neither transport should own database sessions.
mod catalog;
mod contracts;
mod csvexport;
mod files;
pub mod mcp;
mod notices;
mod postgres;
mod query;
mod rowedit;
mod selectshape;
mod sql;
pub use contracts::*;
pub use csvexport::CsvExports;
pub use files::SqlFiles;
pub use postgres::*;
