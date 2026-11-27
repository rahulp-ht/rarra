import json
import logging
import os
import re
import sys
from contextlib import contextmanager
from http import HTTPStatus
from time import monotonic
from uuid import uuid4

import psycopg
from flask import Flask, Response, jsonify, request
from prometheus_client import CONTENT_TYPE_LATEST, REGISTRY, Counter, Histogram, generate_latest
from prometheus_client.core import GaugeMetricFamily
from psycopg.rows import dict_row

app = Flask(__name__)
app.logger.handlers[:] = [logging.StreamHandler(sys.stdout)]
app.logger.propagate = False
app.logger.setLevel(logging.INFO)
app.config["MAX_CONTENT_LENGTH"] = 8192
requests = Counter("taskboard_http_requests_total", "API responses", ["method", "route", "status"])
latency = Histogram("taskboard_http_request_duration_seconds", "API response duration", ["method", "route"])
PRACTICE_ROUTE = "/api/practice/status"
PRACTICE_STATUSES = {str(code): HTTPStatus(code) for code in (200, 400, 404, 429, 500, 503)}
for code in PRACTICE_STATUSES:
    requests.labels("GET", PRACTICE_ROUTE, code)

actions = Counter("taskboard_task_actions_total", "Committed task actions", ["action"])
database_latency = Histogram(
    "taskboard_database_operation_duration_seconds",
    "Database operation duration including connection and commit",
    ["operation", "outcome"],
)

for action in ("created", "renamed", "completed", "reopened", "deleted"):
    actions.labels(action)


@contextmanager
def database(operation):
    started = monotonic()
    try:
        with psycopg.connect(
            host=os.environ.get("DB_HOST", "postgres"),
            dbname=os.environ["POSTGRES_DB"],
            user=os.environ["POSTGRES_USER"],
            password=os.environ["POSTGRES_PASSWORD"],
            connect_timeout=3,
            options="-c statement_timeout=2500",
            row_factory=dict_row,
        ) as conn:
            yield conn
    except psycopg.Error:
        database_latency.labels(operation, "error").observe(monotonic() - started)
        raise
    else:
        database_latency.labels(operation, "success").observe(monotonic() - started)


class TaskInventory:
    def describe(self):
        yield GaugeMetricFamily("taskboard_database_up", "Whether the database inventory query succeeded")
        yield GaugeMetricFamily("taskboard_tasks", "Tasks currently stored", labels=["state"])

    def collect(self):
        up, inventory = self.describe()
        try:
            with database("inventory") as conn:
                counts = conn.execute(
                    "SELECT done, count(*) AS total FROM tasks GROUP BY done"
                ).fetchall()
        except psycopg.Error:
            up.add_metric([], 0)
            yield up
            return
        totals = {row["done"]: row["total"] for row in counts}
        up.add_metric([], 1)
        inventory.add_metric(["open"], totals.get(False, 0))
        inventory.add_metric(["completed"], totals.get(True, 0))
        yield up
        yield inventory


REGISTRY.register(TaskInventory())


@app.before_request
def start_timer():
    request.started = monotonic()
    request_id = request.headers.get("X-Request-ID", "")
    request.request_id = request_id if re.fullmatch(r"[a-f0-9]{32}", request_id) else uuid4().hex


def log_event(event, level=logging.INFO, **fields):
    entry = {"event": event, "request_id": request.request_id, **fields}
    app.logger.log(level, "%s", json.dumps(entry, separators=(",", ":")))


@app.after_request
def measure(response):
    if request.path.startswith("/api/"):
        route = request.url_rule.rule if request.url_rule else "unknown"
        method = request.method if request.method in {"GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"} else "OTHER"
        elapsed = monotonic() - request.started
        requests.labels(method, route, response.status_code).inc()
        latency.labels(method, route).observe(elapsed)
        response.headers["X-Request-ID"] = request.request_id
        log_event(
            "api_request",
            method=method,
            route=route,
            status=response.status_code,
            duration_ms=round(elapsed * 1000, 2),
        )
    return response


@app.errorhandler(psycopg.Error)
def database_error(error):
    log_event("database_error", logging.ERROR, error_type=type(error).__name__)
    return jsonify(error="Database unavailable. Try again shortly."), 503


@app.get("/live")
def live():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    with database("readiness") as conn:
        conn.execute("SELECT id FROM tasks LIMIT 1")
    return {"status": "ok"}


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), content_type=CONTENT_TYPE_LATEST)


@app.get(PRACTICE_ROUTE)
def practice_status():
    status = PRACTICE_STATUSES.get(request.args.get("code"))
    if status is None:
        return jsonify(error="Choose one of the supported practice status codes."), 400
    response = jsonify(practice=True, status=status.value, reason=status.phrase)
    response.headers["Cache-Control"] = "no-store"
    return response, status.value


@app.get("/api/tasks")
def list_tasks():
    with database("list") as conn:
        return jsonify(conn.execute("SELECT id, title, done FROM tasks ORDER BY id DESC").fetchall())


def payload():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def valid_title(title):
    return isinstance(title, str) and 1 <= len(title.strip()) <= 120 and "\x00" not in title


def record_actions(task_id, *names):
    for name in names:
        actions.labels(name).inc()
        log_event("task_action", action=name, task_id=task_id)


@app.post("/api/tasks")
def create_task():
    title = payload().get("title")
    if not valid_title(title):
        return jsonify(error="Enter a title between 1 and 120 characters."), 400
    with database("create") as conn:
        task = conn.execute(
            "INSERT INTO tasks (title) VALUES (%s) RETURNING id, title, done",
            (title.strip(),),
        ).fetchone()
    record_actions(task["id"], "created")
    return jsonify(task), 201


@app.patch("/api/tasks/<int:task_id>")
def update_task(task_id):
    fields = payload()
    if not fields or fields.keys() - {"title", "done"}:
        return jsonify(error="Provide a title or completion status."), 400
    if "title" in fields and not valid_title(fields["title"]):
        return jsonify(error="Enter a title between 1 and 120 characters."), 400
    if "done" in fields and not isinstance(fields["done"], bool):
        return jsonify(error="Provide a boolean completion status."), 400
    if not 1 <= task_id <= 2147483647:
        return jsonify(error="Task not found."), 404

    with database("update") as conn:
        current = conn.execute(
            "SELECT title, done FROM tasks WHERE id = %s FOR UPDATE", (task_id,)
        ).fetchone()
        if current is None:
            return jsonify(error="Task not found."), 404
        title = fields["title"].strip() if "title" in fields else current["title"]
        done = fields.get("done", current["done"])
        task = conn.execute(
            "UPDATE tasks SET title = %s, done = %s WHERE id = %s RETURNING id, title, done",
            (title, done, task_id),
        ).fetchone()
    if title != current["title"]:
        record_actions(task_id, "renamed")
    if done != current["done"]:
        record_actions(task_id, "completed" if done else "reopened")
    return jsonify(task)


@app.delete("/api/tasks/<int:task_id>")
def delete_task(task_id):
    if not 1 <= task_id <= 2147483647:
        return jsonify(error="Task not found."), 404
    with database("delete") as conn:
        deleted = conn.execute("DELETE FROM tasks WHERE id = %s", (task_id,)).rowcount
    if not deleted:
        return jsonify(error="Task not found."), 404
    record_actions(task_id, "deleted")
    return "", 204
