# Grafana HTTP API Reference

All requests require `Authorization: Bearer <service_account_token>`.

## Folders

```
GET  /api/folders                              # List all folders
POST /api/folders  {"title": "my-folder"}      # Create folder → returns {uid, id, title}
```

Requires `folders:create` permission.

## Dashboard CRUD

```
# Search dashboards
GET /api/search?query=<text>&type=dash-db
GET /api/search?folderIds=<id>&type=dash-db
GET /api/search?tag=<tag>&type=dash-db

# Get dashboard by UID
GET /api/dashboards/uid/<uid>
# Returns: {dashboard: {...}, meta: {folderId, folderUid, ...}}

# Create or update dashboard
POST /api/dashboards/db
{
  "dashboard": { ... },     # Full dashboard model
  "folderUid": "abc123",    # Target folder (omit for General)
  "overwrite": true          # Overwrite if exists
}
# For new dashboards: omit id and uid
# For updates: include id from GET response

# Delete dashboard
DELETE /api/dashboards/uid/<uid>
```

## Moving Dashboards to a Folder

1. GET the dashboard
2. POST it back with `folderUid` set and `overwrite: true`

## Datasource Proxy (Query)

```
POST /api/ds/query
{
  "queries": [{
    "datasource": {"uid": "<datasource_uid>"},
    "rawSql": "SELECT ...",
    "refId": "A",
    "format": 1
  }],
  "from": "now-1h",
  "to": "now"
}
```

## Dashboard JSON Structure

Key fields in a dashboard model:

- `title` — Dashboard title
- `uid` — Unique identifier (auto-generated if omitted)
- `panels[]` — Array of panels
  - `type` — "timeseries", "stat", "table", "row", etc.
  - `title` — Panel title
  - `gridPos` — {h, w, x, y} position and size
  - `datasource` — {type, uid}
  - `targets[]` — Array of queries
    - `rawSql` — SQL query string
    - `datasource` — {type, uid}
    - `refId` — "A", "B", etc.
    - `format` — 1 (table), 2 (time series)
  - `fieldConfig` — Field display configuration
- `templating.list[]` — Template variables
  - `name`, `label`, `type`, `query`, `datasource`, `multi`, `includeAll`
- `time` — {from, to} default time range
- `refresh` — Auto-refresh interval
- `tags[]` — Dashboard tags for organization

## Grafana Macros (ClickHouse Plugin)

These macros are resolved by the Grafana ClickHouse plugin at query time:

| Macro                  | Resolves to                           |
| ---------------------- | ------------------------------------- |
| `$__timeFilter(col)`   | `col >= fromTime AND col <= toTime`   |
| `$__timeInterval(col)` | `toStartOfInterval(col, INTERVAL Xs)` |
| `$__fromTime`          | Start of selected time range          |
| `$__toTime`            | End of selected time range            |
| `$__interval`          | Auto-calculated interval string       |
| `$__interval_s`        | Auto-calculated interval in seconds   |

## Template Variable Formats

| Format               | Example               | Output                           |
| -------------------- | --------------------- | -------------------------------- |
| `${var}`             | `${host}`             | `value`                          |
| `${var:regex}`       | `${host:regex}`       | `value1\|value2` (for `match()`) |
| `${var:csv}`         | `${host:csv}`         | `value1,value2`                  |
| `${var:singlequote}` | `${host:singlequote}` | `'value1','value2'`              |
