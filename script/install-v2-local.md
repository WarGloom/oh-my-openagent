# Local OpenCode V2 installer

Run the installer from the canonical OMO checkout. The build reads committed source only.

| Mode | Effect |
| --- | --- |
| No arguments | Build and activate on Port in the calling shell. Use an independent terminal. |
| `--build-only` | Stage the host and OMO artifacts. Print the receipt path. Do not restart a service. |
| `--activate-built EVIDENCE` | Validate the exact-HEAD receipt and activate in the calling shell. Use an independent terminal. |
| `--activate-built-detached EVIDENCE [dev]` | Validate the receipt and submit activation to a transient user unit. Port is the default; `dev` requires a running, independently provisioned Dev service and private OMO and host paths. |

The calling session is interrupted by the restart and receives the service’s restart message afterwards. Save the unit name and log path printed by the detached mode. Submission is not activation success; inspect the final exit and rollback status in that log. A concurrent installer is refused.

The detached worker captures the incumbent service environment from procfs before it stops the service. It passes the NUL-delimited entries through an anonymous pipe and starts the replacement with the exact environment. The comparison reports sorted names and `same` or `differs`; it does not report values or hashes. On failure the worker restores the prior artifacts and starts the old executable with the same snapshot.

The unit uses `ExitType=cgroup` so the daemon outlives the installer shell. It still responds to the launcher's `service stop`. Do not use `systemctl stop` as part of a normal activation; it would also stop the service in the unit.
