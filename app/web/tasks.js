const form = document.querySelector("#create-task");
const title = document.querySelector("#title");
const add = form.querySelector("button");
const list = document.querySelector("ul");
const status = document.querySelector("#status");
const empty = document.querySelector("#empty");
const refresh = document.querySelector("#refresh");
const filter = document.querySelector("#filter");
const search = document.querySelector("#search");
const dialog = document.querySelector("#task-dialog");
const editField = document.querySelector("#edit-field");
const editTitle = document.querySelector("#edit-title");
const deleteText = document.querySelector("#delete-text");
const dialogStatus = document.querySelector("#dialog-status");
const confirmAction = document.querySelector("#confirm");
const cancel = document.querySelector("#cancel");
let tasks = [];
let loaded = false;
let busy = false;
let selection;

async function api(path = "", method = "GET", body) {
  let response;
  try {
    response = await fetch("/api/tasks" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Could not reach the task service.");
  }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const requestId = response.headers.get("X-Request-ID");
    const message = details.error || `Task service returned HTTP ${response.status}.`;
    throw new Error(requestId ? `${message} Request ID: ${requestId}` : message);
  }
  return response.status === 204 ? null : response.json();
}

function setBusy(value) {
  busy = value;
  add.disabled = value || !loaded;
  refresh.disabled = value;
  confirmAction.disabled = value;
  cancel.disabled = value;
  editTitle.disabled = value;
  list.querySelectorAll("button, input").forEach(control => { control.disabled = value; });
}

function render() {
  const completed = tasks.filter(task => task.done).length;
  const percent = tasks.length ? Math.round(100 * completed / tasks.length) : 0;
  document.querySelector("#open-count").textContent = loaded ? tasks.length - completed : "—";
  document.querySelector("#done-count").textContent = loaded ? completed : "—";
  document.querySelector("#percent").textContent = loaded ? `${percent}%` : "—";
  document.querySelector("#progress").value = percent;
  const query = search.value.trim().toLowerCase();
  const visible = tasks.filter(task =>
    (filter.value === "all" || task.done === (filter.value === "completed")) &&
    task.title.toLowerCase().includes(query)
  );
  empty.hidden = !loaded || visible.length > 0;
  empty.textContent = tasks.length ? "No tasks match your filters." : "No tasks yet.";
  list.replaceChildren(...visible.map(taskRow));
}

function restoreFocus(id, action) {
  const control = list.querySelector(`li[data-id="${id}"] [data-action="${action}"]`);
  (control || filter).focus();
}

function taskRow(task) {
  const row = document.createElement("li");
  row.dataset.id = task.id;
  const label = document.createElement("label");
  const check = document.createElement("input");
  const name = document.createElement("span");
  const actions = document.createElement("div");
  actions.className = "actions";
  check.type = "checkbox";
  check.dataset.action = "toggle";
  check.checked = task.done;
  check.disabled = busy;
  name.textContent = task.title;
  label.append(check, name);

  check.addEventListener("change", async () => {
    const updated = await changeTask(() => api(`/${task.id}`, "PATCH", { done: check.checked }));
    if (updated) {
      tasks = tasks.map(item => item.id === task.id ? updated : item);
      render();
      restoreFocus(task.id, "toggle");
      status.textContent = updated.done ? "Task completed." : "Task reopened.";
    } else {
      check.checked = task.done;
    }
  });

  for (const action of ["Edit", "Delete"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.dataset.action = action;
    button.textContent = action;
    button.setAttribute("aria-label", `${action} ${task.title}`);
    button.disabled = busy;
    button.addEventListener("click", () => openDialog(task, action));
    actions.append(button);
  }
  row.append(label, actions);
  return row;
}

async function changeTask(operation, feedback = status) {
  if (busy) return undefined;
  feedback.textContent = "";
  setBusy(true);
  try {
    return await operation();
  } catch (error) {
    feedback.textContent = error.message;
    return undefined;
  } finally {
    setBusy(false);
  }
}

async function load() {
  if (busy) return;
  const pending = changeTask(() => api());
  status.textContent = "Loading tasks…";
  const result = await pending;
  if (result) {
    tasks = result;
    loaded = true;
    add.disabled = false;
    render();
    status.textContent = "Tasks up to date.";
  }
}

function openDialog(task, action) {
  selection = { task, action };
  const editing = action === "Edit";
  document.querySelector("#dialog-title").textContent = editing ? "Edit task" : "Delete task?";
  editField.hidden = !editing;
  editTitle.required = editing;
  editTitle.value = editing ? task.title : "";
  deleteText.hidden = editing;
  deleteText.textContent = editing ? "" : task.title;
  confirmAction.textContent = editing ? "Save changes" : "Delete task";
  dialogStatus.textContent = "";
  dialog.showModal();
  (editing ? editTitle : cancel).focus();
}

document.querySelector("#task-action").addEventListener("submit", async event => {
  event.preventDefault();
  const { task, action } = selection;
  const updated = await changeTask(
    () => action === "Edit"
      ? api(`/${task.id}`, "PATCH", { title: editTitle.value.trim() })
      : api(`/${task.id}`, "DELETE"),
    dialogStatus,
  );
  if (updated === undefined) return;
  tasks = updated
    ? tasks.map(item => item.id === task.id ? updated : item)
    : tasks.filter(item => item.id !== task.id);
  dialog.close();
  render();
  restoreFocus(task.id, action);
  status.textContent = action === "Edit" ? "Task updated." : "Task deleted.";
});

cancel.addEventListener("click", () => dialog.close());
dialog.addEventListener("cancel", event => {
  if (busy) event.preventDefault();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const task = await changeTask(() => api("", "POST", { title: title.value.trim() }));
  if (!task) return;
  tasks.unshift(task);
  form.reset();
  filter.value = "all";
  search.value = "";
  render();
  title.focus();
  status.textContent = "Task added.";
});

refresh.addEventListener("click", load);
filter.addEventListener("change", render);
search.addEventListener("input", render);
load();
