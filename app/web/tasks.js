const form = document.querySelector("#create-task");
const title = document.querySelector("#title");
const add = form.querySelector("button");
const list = document.querySelector("#tasks");
const feedback = document.querySelector("#status");
const empty = document.querySelector("#empty");
const refresh = document.querySelector("#refresh");
const filters = [...document.querySelectorAll("[data-filter]")];
const clearFilters = document.querySelector("#clear-filters");
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
let activeFilter = "all";

async function api(path = "", method = "GET", body) {
  let response;
  try {
    response = await fetch("/api/tasks" + path, {
      method,
      signal: AbortSignal.timeout(17000),
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("The task service timed out. Refresh before retrying.");
    throw new Error("Could not reach the task service. Try refreshing.");
  }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const requestId = response.headers.get("X-Request-ID");
    const message = details.error || `Task service returned HTTP ${response.status}.`;
    throw new Error(requestId ? `${message} Request ID: ${requestId}` : message);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => {
    throw new Error("The task service returned an unreadable response. Try refreshing.");
  });
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
    (activeFilter === "all" || task.done === (activeFilter === "completed")) &&
    task.title.toLowerCase().includes(query)
  );
  empty.hidden = !loaded || visible.length > 0;
  document.querySelector("#empty-title").textContent = tasks.length ? "No matching tasks" : "No tasks yet";
  document.querySelector("#empty-detail").textContent = tasks.length
    ? "Try another search or clear the filters."
    : "Add your first task using the field above.";
  clearFilters.hidden = !tasks.length;
  list.replaceChildren(...visible.map(taskRow));
}

function restoreFocus(id, action) {
  const control = list.querySelector(`li[data-id="${id}"] [data-action="${action}"]`);
  (control || filters.find(button => button.dataset.filter === activeFilter)).focus();
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
      feedback.textContent = updated.done ? "Task completed." : "Task reopened.";
    } else {
      check.checked = task.done;
    }
  });

  for (const action of ["Edit", "Delete"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary task-action";
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

async function changeTask(operation, message = feedback) {
  if (busy) return undefined;
  message.textContent = "";
  message.classList.remove("error");
  setBusy(true);
  try {
    return await operation();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
    return undefined;
  } finally {
    setBusy(false);
  }
}

async function load() {
  if (busy) return;
  const pending = changeTask(() => api());
  feedback.textContent = "Loading tasks…";
  const result = await pending;
  if (result) {
    tasks = result;
    loaded = true;
    add.disabled = false;
    render();
    feedback.textContent = "Tasks up to date.";
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
  confirmAction.classList.toggle("danger", !editing);
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
  feedback.classList.remove("error");
  feedback.textContent = action === "Edit" ? "Task updated." : "Task deleted.";
});

cancel.addEventListener("click", () => dialog.close());
dialog.addEventListener("cancel", event => {
  if (busy) event.preventDefault();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!loaded) return;
  const task = await changeTask(() => api("", "POST", { title: title.value.trim() }));
  if (!task) return;
  tasks.unshift(task);
  form.reset();
  search.value = "";
  setFilter("all");
  title.focus();
  feedback.textContent = "Task added.";
});

refresh.addEventListener("click", load);
function setFilter(value) {
  activeFilter = value;
  for (const button of filters) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === value));
  }
  render();
}

for (const button of filters) {
  button.addEventListener("click", () => setFilter(button.dataset.filter));
}
clearFilters.addEventListener("click", () => {
  search.value = "";
  setFilter("all");
  search.focus();
});
search.addEventListener("input", render);

const practice = document.querySelector("#status-practice");
const practiceButton = practice.querySelector("button");
const practiceResult = document.querySelector("#practice-result");
practice.addEventListener("submit", async event => {
  event.preventDefault();
  if (practiceButton.disabled) return;

  const code = new FormData(practice).get("code");
  const query = new URLSearchParams({ code });
  practiceButton.disabled = true;
  practiceResult.classList.remove("error");
  practiceResult.textContent = "Sending request…";
  try {
    const response = await fetch(`/api/practice/status?${query}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(17000),
    });
    const requestId = response.headers.get("X-Request-ID");
    const result = await response.json().catch(() => null);
    const simulated = result?.practice === true && result.status === response.status;
    practiceResult.classList.toggle("error", !simulated);
    const detail = simulated ? `${result.reason} (simulated)` : "unexpected response";
    practiceResult.textContent = `HTTP ${response.status} ${detail}${requestId ? ` · Request ID: ${requestId}` : ""}`;
  } catch {
    practiceResult.classList.add("error");
    practiceResult.textContent = "Could not reach the practice endpoint. Try again.";
  } finally {
    practiceButton.disabled = false;
  }
});

load();
