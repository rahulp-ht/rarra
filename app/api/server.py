import os
from time import monotonic

import psycopg
from flask import Flask, Response, jsonify, request
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from psycopg.rows import dict_row

app = Flask(__name__)
requests = Counter("taskboard_http_requests_total", "API responses", ["method", "route", "status"])
latency = Histogram("taskboard_http_request_duration_seconds", "API response duration", ["method", "route"])


def database():
    return psycopg.connect(
        host=os.environ.get("DB_HOST", "postgres"),
        dbname=os.environ["POSTGRES_DB"],
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        connect_timeout=3,
        row_factory=dict_row,
    )


@app.before_request
def start_timer():
    request.started = monotonic()


@app.after_request
def measure(response):
    if request.path.startswith("/api/"):
        route = request.url_rule.rule if request.url_rule else "unknown"
        requests.labels(request.method, route, response.status_code).inc()
        latency.labels(request.method, route).observe(monotonic() - request.started)
    return response


@app.errorhandler(psycopg.Error)
def database_error(error):
    app.logger.error("Database request failed: %s", type(error).__name__)
    return jsonify(error="Database unavailable. Try again shortly."), 503


@app.get("/live")
def live():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    with database() as conn:
        conn.execute("SELECT id FROM tasks LIMIT 1")
    return {"status": "ok"}


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), content_type=CONTENT_TYPE_LATEST)


@app.get("/api/tasks")
def list_tasks():
    with database() as conn:
        return jsonify(conn.execute("SELECT id, title, done FROM tasks ORDER BY id DESC").fetchall())


def payload():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


@app.post("/api/tasks")
def create_task():
    title = payload().get("title")
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120 or "\x00" in title:
        return jsonify(error="Enter a title between 1 and 120 characters."), 400
    with database() as conn:
        task = conn.execute(
            "INSERT INTO tasks (title) VALUES (%s) RETURNING id, title, done",
            (title.strip(),),
        ).fetchone()
    return jsonify(task), 201


@app.patch("/api/tasks/<int:task_id>")
def update_task(task_id):
    done = payload().get("done")
    if not isinstance(done, bool):
        return jsonify(error="Provide a boolean completion status."), 400
    if not 1 <= task_id <= 2147483647:
        return jsonify(error="Task not found."), 404
    with database() as conn:
        task = conn.execute(
            "UPDATE tasks SET done = %s WHERE id = %s RETURNING id, title, done",
            (done, task_id),
        ).fetchone()
    if task is None:
        return jsonify(error="Task not found."), 404
    return jsonify(task)


@app.delete("/api/tasks/<int:task_id>")
def delete_task(task_id):
    if not 1 <= task_id <= 2147483647:
        return jsonify(error="Task not found."), 404
    with database() as conn:
        deleted = conn.execute("DELETE FROM tasks WHERE id = %s", (task_id,)).rowcount
    if not deleted:
        return jsonify(error="Task not found."), 404
    return "", 204
