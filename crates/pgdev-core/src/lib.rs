//! Framework-independent PostgreSQL core. Shared by desktop commands and,
//! later, the MCP service; neither transport should own database sessions.
mod catalog;
mod contracts;
mod postgres;
mod query;
mod rowedit;
mod selectshape;
mod sql;
pub use contracts::*;
pub use postgres::*;
