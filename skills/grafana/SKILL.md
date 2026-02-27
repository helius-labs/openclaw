---
name: grafana
description: "Manage Grafana dashboards via the HTTP API: create, update, deploy, verify, and organize dashboards in folders. Use when: (1) creating or updating Grafana dashboards, (2) deploying dashboard JSON from a repo to Grafana, (3) verifying dashboard queries render correctly, (4) organizing dashboards into folders, (5) fixing datasource references or template variables. NOT for: Grafana alerting rules, user/org management, or plugin installation."
---

# Grafana Dashboard Management

## Prerequisites

Required credentials (check workspace CREDENTIALS.md or environment):

- **Grafana URL** — e.g. `https://org.grafana.net`
- **Service Account Token** — `glsa_...` (Bearer token for API)
- **ClickHouse Datasource UID** — the `uid` of the ClickHouse datasource in Grafana

## API Reference

See [references/api.md](references/api.md) for endpoint details: folders, dashboards, search, datasource queries.

## Deploying Dashboards from Repo JSON

1. Load the dashboard JSON from file
2. Set `dashboard.title`, remove `id` and `uid` (let Grafana assign new ones)
3. Fix datasource references (see Gotchas below)
4. POST to `/api/dashboards/db` with `folderUid`

```python
import json, requests

with open("dashboard.json") as f:
    dashboard = json.load(f)

dashboard.pop("id", None)
dashboard.pop("uid", None)

payload = {
    "dashboard": dashboard,
    "folderUid": FOLDER_UID,  # omit for General folder
    "overwrite": True,
}
resp = requests.post(f"{GRAFANA_URL}/api/dashboards/db",
    headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    json=payload)
```

## Verifying Dashboard Queries

Grafana panels can silently error. Verify by extracting SQL from each panel and testing against ClickHouse directly. Use `scripts/verify_dashboards.py`:

```bash
python3 scripts/verify_dashboards.py \
  --grafana-url https://org.grafana.net \
  --grafana-token glsa_... \
  --ch-url http://host:8123 \
  --ch-user default \
  --ch-password pass \
  --ch-database clickhouse_logs \
  --query "[Bert]"  # search query to find dashboards
```

The script handles Grafana macro substitution (`$__timeFilter`, `$__timeInterval`, template variables) and reports pass/fail per panel.

## Gotchas (Critical)

### 1. Datasource Template Variable

Repo dashboards often use a `${datasource}` template variable. When deploying standalone copies, this variable has no value → all panels break silently.

**Fix:** Recursively replace all datasource references with the hardcoded UID:

```python
CORRECT_DS = {"type": "grafana-clickhouse-datasource", "uid": "YOUR_UID"}

def fix_datasource(obj):
    if isinstance(obj, dict):
        if 'datasource' in obj:
            ds = obj['datasource']
            if isinstance(ds, dict) and (ds.get('uid', '').startswith('${') or
                ds.get('type') == 'grafana-clickhouse-datasource'):
                obj['datasource'] = CORRECT_DS.copy()
            elif isinstance(ds, str) and ds.startswith('${'):
                obj['datasource'] = CORRECT_DS.copy()
        for v in obj.values():
            fix_datasource(v)
    elif isinstance(obj, list):
        for item in obj:
            fix_datasource(item)
```

Also remove the `datasource` entry from `dashboard.templating.list`.

### 2. Bare Column References After Table Migration

When queries are migrated from a table with top-level columns (e.g. `metrics` with `signature`) to per-metric tables with only `timestamp` + `data` (JSON), bare column references like `WHERE signature = '...'` break.

**Fix:** Replace bare `signature` with `toString(data.signature)` in WHERE clauses. Be surgical — only fix column references, not template variable names or aliases:

```python
# Only fix: signature = '${signature}' → toString(data.signature) = '${signature}'
sql = re.sub(
    r"\bsignature\s*=\s*'\$\{signature",
    "toString(data.signature) = '${signature",
    sql
)
```

### 3. Folder Permissions

The service account needs `folders:create` permission to make folders. Dashboard CRUD works without it. If folder creation fails, deploy to General and move later.

### 4. Corrupted SQL from Find-and-Replace

Watch for mangled Grafana macros in repo dashboards (e.g. `$__ton_loop_total_time_ns'` instead of `$__timeFilter(m.timestamp)`). These are invisible in the UI until the panel errors. The verify script catches these.

### 5. ClickHouse JSON Column Access

Per-metric tables use `JSON` type for the `data` column. Access fields as `data.field_name`. For typed access use `data.field.:Type` (e.g. `data.client_id.:String`).
