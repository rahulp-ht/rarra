const form = document.querySelector("form");
const title = document.querySelector("#title");
const list = document.querySelector("ul");
const status = document.querySelector("#status");
const summary = document.querySelector("#summary");
const retry = document.querySelector("#retry");
const add = form.querySelector("button");
let tasks = [];

async function api(path = "", method = "GET", body) {
  const response = await fetch("/api/tasks" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || "Could not reach the task service.");
  }
  return response.status === 204 ? null : response.json();
}

function render() {
  const complete = tasks.filter(task => task.done).length;
  summary.textContent = tasks.length ? `${complete} of ${tasks.length} completed` : "";
  status.textContent = tasks.length ? "" : "No tasks yet.";
  list.replaceChildren(...tasks.map(task => {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const check = document.createElement("input");
    const name = document.createElement("span");
    const remove = document.createElement("button");
    check.type = "checkbox";
    check.checked = task.done;
    name.textContent = task.title;
    remove.type = "button";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${task.title}`);
    async function change(method, body) {
      check.disabled = remove.disabled = true;
      try {
        const updated = await api(`/${task.id}`, method, body);
        tasks = updated
          ? tasks.map(item => item.id === task.id ? updated : item)
          : tasks.filter(item => item.id !== task.id);
        render();
      } catch (error) {
        check.checked = task.done;
        status.textContent = error.message;
      } finally {
        check.disabled = remove.disabled = false;
      }
    }
    check.addEventListener("change", () => change("PATCH", { done: check.checked }));
    remove.addEventListener("click", () => change("DELETE"));
    label.append(check, name);
    row.append(label, remove);
    return row;
  }));
}

async function load() {
  add.disabled = retry.disabled = true;
  try {
    tasks = await api();
    retry.hidden = true;
    render();
    add.disabled = false;
  } catch (error) {
    status.textContent = error.message;
    retry.hidden = false;
  } finally {
    retry.disabled = false;
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  add.disabled = true;
  try {
    const task = await api("", "POST", { title: title.value.trim() });
    tasks.unshift(task);
    form.reset();
    render();
    title.focus();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    add.disabled = false;
  }
});
retry.addEventListener("click", load);
load();
