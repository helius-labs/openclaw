#!/usr/bin/env python3
"""Verify all Grafana dashboard queries execute successfully against ClickHouse.

Usage:
    python3 verify_dashboards.py \
        --grafana-url https://org.grafana.net \
        --grafana-token glsa_... \
        --ch-url http://host:8123 \
        --ch-user default \
        --ch-password pass \
        --ch-database clickhouse_logs \
        --query "[Bert]"
"""

import argparse, json, re, requests, sys

def parse_args():
    p = argparse.ArgumentParser(description="Verify Grafana dashboard queries against ClickHouse")
    p.add_argument("--grafana-url", required=True)
    p.add_argument("--grafana-token", required=True)
    p.add_argument("--ch-url", required=True)
    p.add_argument("--ch-user", default="default")
    p.add_argument("--ch-password", default="")
    p.add_argument("--ch-database", default="default")
    p.add_argument("--query", default="", help="Search query to find dashboards")
    p.add_argument("--uid", default="", help="Test a single dashboard by UID")
    p.add_argument("--verbose", "-v", action="store_true")
    return p.parse_args()

# Default template variable values for testing
VAR_DEFAULTS = {
    'signature': 'testsig123', 'host': 'test-host', 'staked': 'true',
    'leader': 'testleader', 'is_relayed': 'false', 'is_recent_slot': 'true',
    'api_key': 'testkey', 'failed': 'false', 'priority': '0', 'interval': '1m',
    'result_limit': '50', 'protocol': 'rpc', 'is_retry': 'false', 'dropped': 'false',
    'env': 'prod', 'identity': 'testident', 'slot': '12345', 'datasource': '',
}

def grafana_to_ch(sql):
    """Replace Grafana macros and template variables with valid ClickHouse SQL."""
    s = sql
    s = re.sub(r'\$__timeFilter\((\w+(?:\.\w+)?)\)', r'\1 >= now() - INTERVAL 5 MINUTE', s)
    s = re.sub(r'\$__timeInterval\((\w+(?:\.\w+)?)\)', r'toStartOfMinute(\1)', s)
    s = re.sub(r'\$__fromTime', "toDateTime('2026-01-01 00:00:00')", s)
    s = re.sub(r'\$__toTime', "toDateTime('2026-01-02 00:00:00')", s)
    s = re.sub(r'\$__interval_s', '60', s)
    s = re.sub(r'\$__interval\b', '60', s)
    
    # Template variables: ${var:regex} → .*
    s = re.sub(r'\$\{\w+:regex\}', '.*', s)
    # ${var:csv}, ${var:singlequote}, ${var}
    s = re.sub(r'\$\{(\w+)(?::[^}]+)?\}', lambda m: VAR_DEFAULTS.get(m.group(1), 'test'), s)
    # Bare $var (not $__ macros)
    s = re.sub(r'\$(?!_)(\w+)', lambda m: VAR_DEFAULTS.get(m.group(1), 'test'), s)
    
    s = re.sub(r';\s*$', '', s.strip())
    if 'LIMIT' not in s.upper():
        s += ' LIMIT 1'
    return s

def extract_panel_queries(panels):
    """Extract (panel_title, sql) pairs from panels recursively."""
    results = []
    for p in panels:
        title = p.get('title', 'unnamed')
        for t in p.get('targets', []):
            sql = t.get('rawSql', '')
            if sql.strip():
                results.append((title, sql))
        if 'panels' in p:
            results.extend(extract_panel_queries(p['panels']))
    return results

def main():
    args = parse_args()
    gh = {"Authorization": f"Bearer {args.grafana_token}"}
    ch_params = {"user": args.ch_user, "password": args.ch_password, "database": args.ch_database}
    
    # Find dashboards
    if args.uid:
        dashboards = [{"uid": args.uid}]
    else:
        resp = requests.get(f"{args.grafana_url}/api/search",
            params={"query": args.query, "type": "dash-db"}, headers=gh)
        dashboards = resp.json()
    
    total_ok = total_fail = 0
    all_failures = []
    
    for d in dashboards:
        resp = requests.get(f"{args.grafana_url}/api/dashboards/uid/{d['uid']}", headers=gh)
        dash = resp.json()['dashboard']
        title = dash['title']
        
        queries = extract_panel_queries(dash.get('panels', []))
        for tmpl in dash.get('templating', {}).get('list', []):
            q = tmpl.get('query', '')
            if isinstance(q, str) and q.strip() and any(kw in q for kw in ['SELECT', 'FROM', 'clickhouse']):
                queries.append((f"template:{tmpl['name']}", q))
        
        ok = fail = 0
        for ptitle, sql in queries:
            test_sql = grafana_to_ch(sql)
            try:
                resp = requests.post(args.ch_url, params=ch_params, data=test_sql, timeout=15)
                if resp.status_code == 200:
                    ok += 1
                else:
                    fail += 1
                    err = resp.text.strip().split('\n')[0][:200]
                    all_failures.append((title, ptitle, err))
                    if args.verbose:
                        print(f"    FAIL: {ptitle}: {err}")
            except Exception as e:
                fail += 1
                all_failures.append((title, ptitle, str(e)[:100]))
        
        total_ok += ok
        total_fail += fail
        icon = '✅' if fail == 0 else '❌'
        print(f"{icon} {title}: {ok}/{ok+fail}")
    
    print(f"\nTotal: {total_ok} OK, {total_fail} FAILED")
    
    if all_failures:
        print(f"\nFailures:")
        for dash, panel, err in all_failures:
            print(f"  [{dash}] {panel}")
            print(f"    {err}")
    
    sys.exit(1 if total_fail > 0 else 0)

if __name__ == "__main__":
    main()
