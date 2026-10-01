//! Small PostgreSQL lexer shared by batching and query routing. Literals and
//! comments are opaque: never classify a keyword inside a function body.

#[derive(Debug)]
pub(crate) struct Statement<'a> {
    pub text: &'a str,
    /// PostgreSQL error positions count Unicode characters, not UTF-8 bytes.
    pub start_chars: u32,
}

#[derive(Debug, Clone)]
enum Token {
    Word(String),
    Literal(String),
    Other(char),
}

fn identifier_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || !c.is_ascii()
}
fn identifier_part(c: char) -> bool {
    identifier_start(c) || c.is_ascii_digit() || c == '$'
}

fn token(sql: &str, at: usize, standard_strings: bool) -> (usize, Option<Token>) {
    let bytes = sql.as_bytes();
    let tail = &sql[at..];
    let c = tail.chars().next().unwrap();
    if c.is_whitespace() {
        return (at + c.len_utf8(), None);
    }
    if tail.starts_with("--") {
        return (tail.find('\n').map_or(sql.len(), |end| at + end), None);
    }
    if tail.starts_with("/*") {
        let mut depth = 1;
        let mut i = at + 2;
        while i < bytes.len() && depth > 0 {
            if bytes[i..].starts_with(b"/*") {
                depth += 1;
                i += 2;
            } else if bytes[i..].starts_with(b"*/") {
                depth -= 1;
                i += 2;
            } else {
                i += 1;
            }
        }
        return (i, None);
    }
    if c == '\'' || c == '"' {
        let previous = sql[..at].chars().rev().take(3).collect::<Vec<_>>();
        let e_string = previous
            .first()
            .is_some_and(|c| c.eq_ignore_ascii_case(&'e'))
            && !previous.get(1).is_some_and(|c| identifier_part(*c));
        let u_string = previous.first() == Some(&'&')
            && previous
                .get(1)
                .is_some_and(|c| c.eq_ignore_ascii_case(&'u'))
            && !previous.get(2).is_some_and(|c| identifier_part(*c));
        let escapes = c == '\'' && (!standard_strings || e_string || u_string);
        let mut i = at + 1;
        let mut end = sql.len();
        while i < bytes.len() {
            if bytes[i] == c as u8 {
                if bytes.get(i + 1) == Some(&(c as u8)) {
                    i += 2;
                } else {
                    end = i;
                    i += 1;
                    break;
                }
            } else if escapes && bytes[i] == b'\\' && i + 1 < bytes.len() {
                i += 2;
            } else {
                i += 1;
            }
        }
        return (
            i,
            Some(if c == '\'' {
                Token::Literal(sql[at + 1..end].to_owned())
            } else {
                Token::Other('"')
            }),
        );
    }
    if c == '$' && !sql[..at].chars().next_back().is_some_and(identifier_part) {
        let mut i = at + 1;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
            i += 1;
        }
        if bytes.get(i) == Some(&b'$')
            && (i == at + 1 || bytes[at + 1].is_ascii_alphabetic() || bytes[at + 1] == b'_')
        {
            let delimiter = &sql[at..=i];
            let body = i + 1;
            let end = sql[body..]
                .find(delimiter)
                .map_or(sql.len(), |end| body + end + delimiter.len());
            return (end, Some(Token::Other('$')));
        }
    }
    if identifier_start(c) {
        let end = tail
            .char_indices()
            .find(|(_, c)| !identifier_part(*c))
            .map_or(sql.len(), |(i, _)| at + i);
        return (end, Some(Token::Word(sql[at..end].to_ascii_uppercase())));
    }
    (at + c.len_utf8(), Some(Token::Other(c)))
}

fn setting(tokens: &[Token]) -> Option<bool> {
    let mut i = 0;
    let word = |i| match tokens.get(i) {
        Some(Token::Word(word)) => Some(word.as_str()),
        _ => None,
    };
    if word(i) != Some("SET") {
        return None;
    }
    i += 1;
    if matches!(word(i), Some("LOCAL" | "SESSION")) {
        i += 1;
    }
    if word(i) != Some("STANDARD_CONFORMING_STRINGS") {
        return None;
    }
    i += 1;
    if word(i) != Some("TO") && !matches!(tokens.get(i), Some(Token::Other('='))) {
        return None;
    }
    match tokens.get(i + 1) {
        Some(Token::Word(value) | Token::Literal(value)) if value.eq_ignore_ascii_case("on") => {
            Some(true)
        }
        Some(Token::Word(value) | Token::Literal(value)) if value.eq_ignore_ascii_case("off") => {
            Some(false)
        }
        _ => None,
    }
}

pub(crate) fn split(sql: &str, mut standard_strings: bool) -> Vec<Statement<'_>> {
    let mut statements = Vec::new();
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < sql.len() {
        let (end, next) = token(sql, i, standard_strings);
        if matches!(next, Some(Token::Other(';'))) {
            finish(sql, start, i, &tokens, &mut statements);
            if let Some(value) = setting(&tokens) {
                standard_strings = value;
            }
            tokens.clear();
            start = end;
        } else if let Some(next) = next {
            // Only a leading SET can change the string mode. Keep the same
            // bounded token window as the existing TypeScript splitter.
            if tokens.len() < 10 {
                tokens.push(next);
            }
        }
        i = end;
    }
    finish(sql, start, sql.len(), &tokens, &mut statements);
    statements
}

fn finish<'a>(
    sql: &'a str,
    start: usize,
    end: usize,
    tokens: &[Token],
    statements: &mut Vec<Statement<'a>>,
) {
    if tokens.is_empty() {
        return;
    }
    let segment = &sql[start..end];
    let text = segment.trim();
    let trimmed_start = start + segment.len() - segment.trim_start().len();
    statements.push(Statement {
        text,
        start_chars: sql[..trimmed_start].chars().count() as u32,
    });
}

pub(crate) fn leading_words(sql: &str, limit: usize) -> Vec<String> {
    let mut words = Vec::new();
    let mut i = 0;
    while i < sql.len() && words.len() < limit {
        let (end, next) = token(sql, i, true);
        match next {
            Some(Token::Word(word)) => words.push(word),
            Some(_) => break,
            None => {}
        }
        i = end;
    }
    words
}

#[derive(Debug, PartialEq)]
pub(crate) enum TransactionControl {
    Unchanged,
    Start,
    End,
    Chain,
}

pub(crate) fn transaction_control(sql: &str) -> TransactionControl {
    let words = leading_words(sql, 6);
    let words = words.iter().map(String::as_str).collect::<Vec<_>>();
    if matches!(words.first(), Some(&"BEGIN")) || words.starts_with(&["START", "TRANSACTION"]) {
        return TransactionControl::Start;
    }
    let Some(first @ ("COMMIT" | "ROLLBACK" | "END" | "ABORT")) = words.first().copied() else {
        return TransactionControl::Unchanged;
    };
    let mut rest = &words[1..];
    if matches!(rest.first(), Some(&"WORK" | &"TRANSACTION")) {
        rest = &rest[1..];
    }
    if (first == "ROLLBACK" && rest.first() == Some(&"TO"))
        || matches!(rest.first(), Some(&"PREPARED"))
    {
        return TransactionControl::Unchanged;
    }
    if rest.starts_with(&["AND", "CHAIN"]) {
        TransactionControl::Chain
    } else {
        TransactionControl::End
    }
}

pub(crate) fn manual_transaction(statements: &[Statement<'_>]) -> bool {
    let mut open = false;
    for statement in statements {
        match transaction_control(statement.text) {
            TransactionControl::Start | TransactionControl::Chain => open = true,
            TransactionControl::End => open = false,
            TransactionControl::Unchanged => {}
        }
    }
    open
}

pub(crate) fn cursor_candidate(sql: &str) -> bool {
    matches!(
        leading_words(sql, 1).first().map(String::as_str),
        Some(
            "SELECT"
                | "VALUES"
                | "WITH"
                | "TABLE"
                | "SHOW"
                | "EXPLAIN"
                | "SET"
                | "RESET"
                | "DISCARD"
                | "BEGIN"
                | "START"
                | "COMMIT"
                | "ROLLBACK"
                | "END"
                | "ABORT"
                | "SAVEPOINT"
                | "RELEASE"
                | "CLOSE"
                | "FETCH"
        )
    )
}

pub(crate) fn autocommit(sql: &str) -> bool {
    let words = leading_words(sql, 8);
    let words = words.iter().map(String::as_str).collect::<Vec<_>>();
    match words.first().copied() {
        Some("VACUUM" | "CLUSTER" | "CHECKPOINT") => true,
        Some("ALTER") => words.get(1) == Some(&"SYSTEM"),
        Some("CREATE" | "DROP") => {
            for (i, word) in words.iter().enumerate().skip(1) {
                if matches!(*word, "DATABASE" | "TABLESPACE" | "SUBSCRIPTION") {
                    return true;
                }
                if *word == "INDEX" {
                    return words[i + 1..].contains(&"CONCURRENTLY");
                }
                if !matches!(*word, "IF" | "NOT" | "EXISTS" | "UNIQUE" | "CONCURRENTLY") {
                    break;
                }
            }
            false
        }
        Some("REINDEX") => {
            let mut i = 0;
            while i < sql.len() {
                let (end, next) = token(sql, i, true);
                if matches!(next, Some(Token::Word(word)) if word == "CONCURRENTLY") {
                    return true;
                }
                i = end;
            }
            false
        }
        Some("REFRESH") => {
            words.starts_with(&["REFRESH", "MATERIALIZED", "VIEW"])
                && words.contains(&"CONCURRENTLY")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_bodies_comments_and_identifiers_are_opaque() {
        let sql = "/* outer /* inner ; */ */ SELECT ';', E'a\\\';b', \"semi;colon\"; DO $body$ BEGIN PERFORM 1; END; $body$; -- trailing ;\n";
        let statements = split(sql, true);
        assert_eq!(statements.len(), 2);
        assert!(statements[0].text.contains("semi;colon"));
        assert!(statements[1].text.starts_with("DO $body$"));
        assert!(split("-- only comment\n/* ; */", true).is_empty());
    }

    #[test]
    fn standard_conforming_strings_and_unicode_offsets() {
        assert_eq!(
            split(
                "SET standard_conforming_strings = off; SELECT 'a\\\';b'; SELECT 2",
                true
            )
            .len(),
            3
        );
        let sql = "SELECT 'ą😀';  SELECT broken";
        let parts = split(sql, true);
        assert_eq!(
            parts[1].start_chars,
            "SELECT 'ą😀';  ".chars().count() as u32
        );
        assert_eq!(split("SELECT $1, identifier$tag$; SELECT 2", true).len(), 2);
    }

    #[test]
    fn transaction_and_autocommit_routing_ignore_quoted_words() {
        assert_eq!(
            transaction_control("ROLLBACK TO \"AND CHAIN\""),
            TransactionControl::Unchanged
        );
        assert_eq!(
            transaction_control("COMMIT /* comment */ AND CHAIN"),
            TransactionControl::Chain
        );
        assert_eq!(
            transaction_control("COMMIT PREPARED 'x'"),
            TransactionControl::Unchanged
        );
        assert!(manual_transaction(&split("BEGIN; SELECT 1", true)));
        assert!(!manual_transaction(&split("BEGIN; COMMIT", true)));
        assert!(autocommit("CREATE UNIQUE INDEX CONCURRENTLY idx ON t (id)"));
        assert!(autocommit("REINDEX (CONCURRENTLY) INDEX idx"));
        assert!(!autocommit("SELECT 'VACUUM'"));
        assert!(!autocommit("REINDEX INDEX \"concurrently\""));
    }
}
