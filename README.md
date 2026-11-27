# Taskboard DevOps lab

Taskboard is a single-user task tracker. The browser can add, edit, search, filter, complete, reopen, and delete tasks. Nginx serves the frontend and proxies API requests to Flask. The API persists tasks in PostgreSQL.

Argo CD reconciles the application and monitoring manifests from Git. Prometheus scrapes the API and kubelet resource metrics, Alloy sends taskboard pod logs to Loki, and Grafana provisions both data sources and a dashboard. The services are exposed locally through port-forwarding.

| Directory | Contents |
| --- | --- |
| `app/web` | HTML, CSS, JavaScript, and Nginx image |
| `app/api` | Flask API, Prometheus instrumentation, and API image |
| `deploy/app` | Web, API, PostgreSQL, and SQL initialization |
| `deploy/monitoring` | Prometheus, Grafana, Loki, Alloy, and dashboard |
| `deploy/bootstrap` | Namespaces, pinned Argo CD installation, and Argo CD Applications |

## Run on Minikube

Use a single-node Minikube cluster named `lab` with the Docker driver, `kubectl`, Bash, and a Git repository reachable by Argo CD. Allow about 4 CPUs and 8 GB of RAM for the cluster. The manifests use Minikube's default dynamic storage. Argo CD 3.2 targets Kubernetes 1.31 through 1.34.

### 1. Prepare the Git source and local images

In `deploy/bootstrap/applications.yaml`, replace **both** example `repoURL` values and update `targetRevision` if your branch differs from `main`. Commit and push the project files to that branch so Argo CD can fetch them. For a private repository, configure its credentials in Argo CD before applying the Applications.

From the repository root:

```bash
minikube start -p lab --driver=docker --cpus=4 --memory=8192 --kubernetes-version=v1.34.0
minikube -p lab image build -t taskboard-api:v2 ./app/api
minikube -p lab image build -t taskboard-web:v3 ./app/web
```

The images are built directly into Minikube. Their tags match `deploy/app/kustomization.yaml`.

### 2. Install Argo CD and create local Secrets

```bash
kubectl --context=lab apply -f deploy/bootstrap/namespaces.yaml
kubectl --context=lab apply --server-side -k deploy/bootstrap/argocd
kubectl --context=lab wait --for=condition=Established crd/applications.argoproj.io --timeout=120s
kubectl --context=lab -n argocd rollout status deployment/argocd-server --timeout=300s
kubectl --context=lab -n argocd rollout status deployment/argocd-repo-server --timeout=300s
```

Run the following once for a fresh cluster. Use separate local passwords and keep them outside Git.

```bash
read -rsp 'PostgreSQL password: ' db_password
printf '\n'
kubectl --context=lab -n taskboard create secret generic taskboard-db \
  --from-literal=POSTGRES_DB=taskboard \
  --from-literal=POSTGRES_USER=taskboard \
  --from-literal=POSTGRES_PASSWORD="$db_password"
unset db_password

read -rsp 'Grafana admin password: ' grafana_password
printf '\n'
kubectl --context=lab -n monitoring create secret generic grafana-admin \
  --from-literal=admin-password="$grafana_password"
unset grafana_password
```

### 3. Let Argo CD deploy both Applications

```bash
kubectl --context=lab apply -f deploy/bootstrap/applications.yaml
kubectl --context=lab -n argocd get applications -w
```

Wait for both Applications to report `Synced` and `Healthy`. On the first sync, image downloads and PostgreSQL initialization can take a few minutes. Check pods and volume claims with `kubectl --context=lab -n taskboard get pods,pvc` and `kubectl --context=lab -n monitoring get pods,pvc`.

### 4. Open and verify the stack

Start all four port-forwards from the repo root after the services are healthy. Stop any manual forwards using ports 4080–4083 first.

```bash
./scripts/port-forwards.sh start
./scripts/port-forwards.sh status
./scripts/port-forwards.sh stop
```

The script uses your Linux systemd user session. The forwards survive closing the terminal and retry if the connection drops. Run `stop` when you want to release the ports. Run `start` again after a reboot or after your systemd user session ends. To investigate a forward, use `journalctl --user -u lab-forward-taskboard.service -n 30`.

The commands in the table are an alternative if you want to forward one service manually.

| Service | Command | URL |
| --- | --- | --- |
| Taskboard | `kubectl --context=lab -n taskboard port-forward svc/web 4080:8080` | http://localhost:4080 |
| Argo CD | `kubectl --context=lab -n argocd port-forward svc/argocd-server 4081:443` | https://localhost:4081 |
| Grafana | `kubectl --context=lab -n monitoring port-forward svc/grafana 4082:3000` | http://localhost:4082 |
| Prometheus | `kubectl --context=lab -n monitoring port-forward svc/prometheus 4083:9090` | http://localhost:4083/targets |

- **Taskboard.** Add a task, edit its title, mark it complete, and refresh to verify persistence. Use the status filter to find it, then reopen and delete it. `GET /api/tasks` returns the stored tasks as JSON.
- **Argo CD.** Sign in as `admin`. The initial password is in the `argocd-initial-admin-secret`: `kubectl --context=lab -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`. The local HTTPS endpoint uses a self-signed certificate.
- **Prometheus.** Confirm the `taskboard-api` target is up. Generate several task actions and allow at least two 15-second scrapes for rate queries.
- **Grafana.** Sign in as `admin` with the password you set. Open the **Taskboard** dashboard to see API and database health, task totals and actions, web traffic, API latency, database timing and errors, and pod logs.

## Check pod CPU and memory

The **Taskboard** dashboard includes **Pod CPU usage** and **Pod memory working set**. The panels show individual pods in the `taskboard` namespace, including the frontend, API, and PostgreSQL. CPU is measured in millicores, where 1000 mCPU is one core. Memory is the working set reported by kubelet.

After the monitoring Application syncs, open Prometheus at http://localhost:4083/targets and check that `kubelet-resource` is **UP**. Allow several 15-second scrapes for the CPU rate. The metrics come from kubelet’s HTTPS resource endpoint. The lab accepts Minikube’s self-signed kubelet certificate and authenticates with a dedicated service account.

## Follow a request in Grafana

Create, rename, and complete a task, then open the **Taskboard** dashboard. Allow a few 15-second Prometheus scrapes for rate panels. Task actions count committed changes. PostgreSQL task totals reflect the latest successful inventory query. Search and filters run in the browser.

In Grafana **Explore**, select **Loki** and run:

```logql
{namespace="taskboard", container="api"} | json | event="task_action"
```

Copy a `request_id` from an event, then search across the namespace to see its matching Nginx request and API response:

```logql
{namespace="taskboard"} | json | request_id="PASTE_REQUEST_ID"
```

The Nginx and API request logs omit task titles, request bodies, and query strings. The dashboard covers Taskboard traffic, application state, PostgreSQL operations as seen by the API, and logs in the Taskboard namespace.

## Upgrade an existing lab

Build the images listed above in `lab` before merging into `main`. If the API is already running `taskboard-api:v2`, build only `taskboard-web:v3`. Argo CD rolls out the frontend when it sees the new tag. Reload the page after the rollout to fetch the matching styles and script.

## Build and deploy through GitHub Actions

The workflow in `.github/workflows/taskboard.yml` checks PRs into `main` and builds both images. On pushes to `main` that change app code or the workflow, it publishes `taskboard-api` and `taskboard-web` to Docker Hub, tags each with the commit SHA, and opens or updates a promotion PR with both image digests.

1. Create two **public** Docker Hub repositories called `taskboard-api` and `taskboard-web` under your Docker Hub account. Public images let the lab pull both images without a registry secret. The existing local image references stay in effect until you merge the promotion PR.
2. In your GitHub repository, add the Actions variable `DOCKERHUB_USERNAME` and the Actions secret `DOCKERHUB_TOKEN`. The Docker Hub token needs Read & Write access.
3. Under **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**. The workflow creates or updates the PR. You review and merge it. The branch `automation/taskboard-images` is managed by the workflow.
4. Merge the workflow into `main`. Later, merge app changes into `main` to publish new images. You can also use **Run workflow** from `main` to retry publishing.
5. Review the promotion PR and merge it into `main`. If GitHub prompts you to **Approve workflows to run** for that PR, approve them before merging. Argo CD then deploys the Docker Hub images by digest. Check the `taskboard` Application for **Synced** and **Healthy**.

Once the image references point to Docker Hub, Minikube pulls them during a rollout and the local image build commands are optional for development. To roll back, revert the promotion commit on `main` so Argo CD deploys the previous image references. Keep those images available.

## Practice GitOps

1. Change the frontend heading in `app/web/index.html` and build a new image with `minikube -p lab image build -t taskboard-web:v4 ./app/web`.
2. Set the web image's `newTag` to `v4` in `deploy/app/kustomization.yaml`, then commit and push both changes. Watch Argo CD roll out the new image.
3. Practice self-healing by changing the web Deployment replica count directly in the cluster. Argo CD should restore the value from Git. Revert the image-tag commit to practice rolling back through Git.

For API changes, follow the same build-and-tag workflow with `taskboard-api`. Keep the previous images in Minikube for rollbacks. PostgreSQL, Prometheus, Loki, and Grafana keep data on persistent volume claims. PostgreSQL runs `01-tasks.sql` on first initialization of an empty data directory. Apply future schema changes as migrations for existing databases.
