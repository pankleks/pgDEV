//! Conservative single-table SELECT gate. Never infer row identity from an
//! expression's output name, even when it matches the table's primary key.
use crate::sql::{token, Token};

fn word(token: Option<&Token>, value: &str) -> bool {
    matches!(token, Some(Token::Word(name)) if name == value)
}
fn name(token: Option<&Token>) -> Option<String> {
    match token? {
        Token::Word(value) => Some(value.to_lowercase()),
        Token::Ident(value) => Some(value.clone()),
        _ => None,
    }
}
fn punct(token: Option<&Token>, value: char) -> bool {
    matches!(token, Some(Token::Other(c)) if *c == value)
}
fn clause(token: Option<&Token>) -> bool {
    matches!(token, Some(Token::Word(w)) if matches!(w.as_str(), "WHERE" | "ORDER" | "LIMIT" | "OFFSET" | "FETCH"))
}
fn rejected(token: &Token) -> bool {
    matches!(token, Token::Word(w) if matches!(w.as_str(), "GROUP" | "HAVING" | "UNION" | "INTERSECT" | "EXCEPT" | "WINDOW" | "INTO" | "FOR" | "JOIN"))
}
fn reserved(token: &Token) -> bool {
    rejected(token)
        || clause(Some(token))
        || matches!(token, Token::Word(w) if matches!(w.as_str(), "ONLY" | "VALUES" | "SELECT" | "FROM" | "ON" | "USING" | "AS" | "TABLESAMPLE" | "OUTER" | "LEFT" | "RIGHT" | "FULL" | "INNER" | "CROSS" | "NATURAL" | "LATERAL" | "BY"))
}

/// Outer Option is eligibility; inner None means a wildcard select list.
pub(crate) fn plain_columns(sql: &str, standard_strings: bool) -> Option<Option<Vec<String>>> {
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < sql.len() {
        let (next, item) = token(sql, at, standard_strings);
        at = next;
        if let Some(item) = item {
            tokens.push(item);
        }
    }
    if !word(tokens.first(), "SELECT") {
        return None;
    }
    let start = if word(tokens.get(1), "ALL") { 2 } else { 1 };
    if word(tokens.get(start), "DISTINCT") {
        return None;
    }
    let from = tokens.iter().position(|t| word(Some(t), "FROM"))?;
    let mut columns = Vec::new();
    let mut stars = false;
    for item in tokens.get(start..from)?.split(|t| punct(Some(t), ',')) {
        match item {
            [Token::Other('*')] => stars = true,
            [a, Token::Other('.'), Token::Other('*')] if name(Some(a)).is_some() => stars = true,
            [a] if name(Some(a)).is_some() => columns.push(name(Some(a))?),
            [a, Token::Other('.'), b] if name(Some(a)).is_some() => columns.push(name(Some(b))?),
            [a, Token::Other('.'), b, Token::Other('.'), c]
                if name(Some(a)).is_some() && name(Some(b)).is_some() =>
            {
                columns.push(name(Some(c))?)
            }
            _ => return None,
        }
    }
    let mut p = from + 1;
    let table = tokens.get(p)?;
    if name(Some(table)).is_none() || reserved(table) {
        return None;
    }
    p += 1;
    if punct(tokens.get(p), '.') {
        let table = tokens.get(p + 1)?;
        if name(Some(table)).is_none() || reserved(table) {
            return None;
        }
        p += 2;
    }
    if word(tokens.get(p), "AS") {
        name(tokens.get(p + 1))?;
        p += 2;
    } else if tokens
        .get(p)
        .is_some_and(|t| name(Some(t)).is_some() && !reserved(t))
    {
        p += 1;
    }
    if tokens.get(p).is_some() && !punct(tokens.get(p), ';') && !clause(tokens.get(p)) {
        return None;
    }
    let mut depth = 0usize;
    for t in &tokens[p..] {
        match t {
            Token::Other('(') => depth += 1,
            Token::Other(')') => depth = depth.checked_sub(1)?,
            _ if depth == 0 && rejected(t) => return None,
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    Some(if stars { None } else { Some(columns) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_plain_column_identity_is_accepted() {
        assert_eq!(plain_columns("SELECT t.id, t.\"Some Name\" FROM public.items AS t WHERE id IN (SELECT id FROM other) ORDER BY id", true), Some(Some(vec!["id".into(), "Some Name".into()])));
        assert_eq!(
            plain_columns(
                "/* nested /* hi */ */ SELECT t.* FROM public.items t WHERE note = $$join group$$",
                true
            ),
            Some(None)
        );
        for sql in [
            "SELECT id+1 AS id FROM items",
            "SELECT id AS id FROM items",
            "SELECT DISTINCT * FROM items",
            "SELECT * FROM items JOIN other USING(id)",
            "SELECT * FROM items, other",
            "SELECT * FROM items FOR UPDATE",
            "SELECT * FROM items UNION SELECT * FROM items",
            "WITH x AS (SELECT * FROM items) SELECT * FROM x",
            "SELECT * FROM items()",
            "SELECT count(*) FROM items",
            "SELECT * FROM ONLY items",
            "SELECT * FROM items TABLESAMPLE SYSTEM(1)",
        ] {
            assert!(plain_columns(sql, true).is_none(), "{sql}");
        }
    }
}
