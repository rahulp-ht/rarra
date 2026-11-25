# Taskboard DevOps lab

Taskboard is a single-user task tracker. The browser can add, list, complete, reopen, and delete tasks. Nginx serves the frontend and proxies API requests to Flask. The API persists tasks in PostgreSQL.

Argo CD reconciles the application and monitoring manifests from Git. Prometheus scrapes the API, Alloy sends taskboard pod logs to Loki, and Grafana provisions both data sources and a dashboard. The services are exposed locally through port-forwarding.

| Directory | Contents |
| --- | --- |
| `app/web` | HTML, CSS, JavaScript, and Nginx image |
| `app/api` | Flask API, Prometheus instrumentation, and API image |
| `deploy/app` | Web, API, PostgreSQL, and SQL initialization |
| `deploy/monitoring` | Prometheus, Grafana, Loki, Alloy, and dashboard |
| `deploy/bootstrap` | Namespaces, pinned Argo CD installation, and Argo CD Applications |

## Run on Minikube

Use a single-node Minikube cluster with the Docker driver, `kubectl`, Bash, and a Git repository reachable by Argo CD. Allow about 4 CPUs and 8 GB of RAM for the cluster. The manifests use Minikube's default dynamic storage. Argo CD 3.2 targets Kubernetes 1.31 through 1.34.

### 1. Prepare the Git source and local images

In `deploy/bootstrap/applications.yaml`, replace **both** example `repoURL` values and update `targetRevision` if your branch differs from `main`. Commit and push the project files to that branch so Argo CD can fetch them. For a private repository, configure its credentials in Argo CD before applying the Applications.

From the repository root:

```bash
minikube start --driver=docker --cpus=4 --memory=8192 --kubernetes-version=v1.34.0
minikube image build -t taskboard-api:v1 ./app/api
minikube image build -t taskboard-web:v1 ./app/web
```

The images are built directly into Minikube. Their tags match `deploy/app/kustomization.yaml`.

### 2. Install Argo CD and create local Secrets

```bash
kubectl --context=minikube apply -f deploy/bootstrap/namespaces.yaml
kubectl --context=minikube apply --server-side -k deploy/bootstrap/argocd
kubectl --context=minikube wait --for=condition=Established crd/applications.argoproj.io --timeout=120s
kubectl --context=minikube -n argocd rollout status deployment/argocd-server --timeout=300s
kubectl --context=minikube -n argocd rollout status deployment/argocd-repo-server --timeout=300s
```

Run the following once for a fresh cluster. Use separate local passwords and keep them outside Git.

```bash
read -rsp 'PostgreSQL password: ' db_password
printf '\n'
kubectl --context=minikube -n taskboard create secret generic taskboard-db \
  --from-literal=POSTGRES_DB=taskboard \
  --from-literal=POSTGRES_USER=taskboard \
  --from-literal=POSTGRES_PASSWORD="$db_password"
unset db_password

read -rsp 'Grafana admin password: ' grafana_password
printf '\n'
kubectl --context=minikube -n monitoring create secret generic grafana-admin \
  --from-literal=admin-password="$grafana_password"
unset grafana_password
```

### 3. Let Argo CD deploy both Applications

```bash
kubectl --context=minikube apply -f deploy/bootstrap/applications.yaml
kubectl --context=minikube -n argocd get applications -w
```

Wait for both Applications to report `Synced` and `Healthy`. On the first sync, image downloads and PostgreSQL initialization can take a few minutes. Check pods and volume claims with `kubectl --context=minikube -n taskboard get pods,pvc` and `kubectl --context=minikube -n monitoring get pods,pvc`.

### 4. Open and verify the stack

Run each port-forward in its own terminal.

| Service | Command | URL |
| --- | --- | --- |
| Taskboard | `kubectl --context=minikube -n taskboard port-forward svc/web 8080:8080` | http://localhost:8080 |
| Argo CD | `kubectl --context=minikube -n argocd port-forward svc/argocd-server 8443:443` | https://localhost:8443 |
| Grafana | `kubectl --context=minikube -n monitoring port-forward svc/grafana 3000:3000` | http://localhost:3000 |
| Prometheus | `kubectl --context=minikube -n monitoring port-forward svc/prometheus 9090:9090` | http://localhost:9090/targets |

- **Taskboard.** Add a task, mark it complete, refresh to verify persistence, then reopen and delete it. `GET /api/tasks` returns the stored tasks as JSON.
- **Argo CD.** Sign in as `admin`. The initial password is in the `argocd-initial-admin-secret`: `kubectl --context=minikube -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`. The local HTTPS endpoint uses a self-signed certificate.
- **Prometheus.** Confirm the `taskboard-api` target is up. Generate several task actions and allow at least two 15-second scrapes for rate queries.
- **Grafana.** Sign in as `admin` with the password you set. Open the **Taskboard** dashboard to see request rates, latency, and logs. In Explore, use the Loki query `{namespace="taskboard", container="api"}` to inspect API access logs.

## Practice GitOps

1. Change the frontend heading in `app/web/index.html` and build a new image with `minikube image build -t taskboard-web:v2 ./app/web`.
2. Set the web image's `newTag` to `v2` in `deploy/app/kustomization.yaml`, then commit and push both changes. Watch Argo CD roll out the new image.
3. Practice self-healing by changing the web Deployment replica count directly in the cluster. Argo CD should restore the value from Git. Revert the image-tag commit to practice rolling back through Git.

For API changes, follow the same build-and-tag workflow with `taskboard-api`. Keep the previous images in Minikube for rollbacks. PostgreSQL, Prometheus, Loki, and Grafana keep data on persistent volume claims. PostgreSQL runs `01-tasks.sql` on first initialization of an empty data directory. Apply future schema changes as migrations for existing databases.
