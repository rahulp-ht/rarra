# Repository instructions

`README.md` is the entry point for project documentation. It documents the local image builds, Minikube bootstrap, and verification steps. Application code is under `app/` and Kubernetes manifests are under `deploy/`.

## Making changes

- Keep changes focused on the requested task and preserve unrelated edits.
- Follow the conventions of nearby files as the repository grows. Add or update setup and verification instructions in `README.md` when a change introduces or alters those steps.

## Verification

- Review the diff for scope and run `git diff --check` for whitespace errors. For new untracked files, inspect their contents directly because `git diff` omits them.
- Run relevant checks when the repository provides them, and report what you verified.
