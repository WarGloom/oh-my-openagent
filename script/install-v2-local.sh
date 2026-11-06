#!/usr/bin/env bash
# Install the latest committed product snapshot; in-progress working files are not included.
set -Eeuo pipefail
umask 077

ws=/home/nikita/work/Projects/ai/op
repo=$ws/.omo/worktrees/omo-v2-dev
host=$ws/opencode-wt/v2
binary=$host/packages/cli/dist/cli-linux-x64/bin/opencode
launcher=/home/nikita/.local/bin/opencode-v2-lab
host_oid=018d2e5c4a876176fa3e1d045a914a4acfad79b4
host_hash=979db3b759f84eae60e5f19dbdbe14c1f728c52291a12dd1505b12b55ec06f3c
paths=(dist packages/lsp-tools-mcp/dist packages/lsp-daemon/dist packages/git-bash-mcp/dist packages/shared-skills/skills)

fail() {
	printf '%s\n' "$*" >&2
	exit 1
}
g() { GIT_MASTER=1 GIT_OPTIONAL_LOCKS=0 command git "$@"; }
digest() { sha256sum "$1" | cut -d ' ' -f 1; }
lab() { env -u OPENCODE_V2_BIN HOME=/home/nikita "$launcher" port "$@" 9>&-; }

[[ $# == 0 ]] || fail 'Usage: script/install-v2-local.sh (build, install, restart port V2)'
[[ $(realpath -- "$0") == "$repo/script/install-v2-local.sh" ]] || fail 'Use the canonical dev helper.'
[[ $(g -C "$repo" branch --show-current) == local/opencode-v2-dev ]] || fail 'Canonical dev branch required.'
omo_oid=$(g -C "$repo" rev-parse HEAD)
g -C "$repo" show "$omo_oid:script/install-v2-local.sh" | cmp -s - "$0" || fail 'Commit this helper before use.'

identity() {
	[[ $(g -C "$repo" rev-parse HEAD) == "$omo_oid" ]] || fail 'OMO HEAD changed; build the latest commit again.'
	[[ $(g -C "$host" rev-parse HEAD) == "$host_oid" ]] || fail 'Host source changed; a separately verified host build is required.'
	[[ $(digest "$binary") == "$host_hash" ]] || fail 'Installed host differs from the verified baseline.'
}
identity
grep -Fxq "  port|dev) omo=\$ws/.omo/worktrees/omo-v2-dev ;;" "$launcher" ||
	fail 'Apply the canonical port/dev launcher mapping before installation.'
for tool in bun node git tar cp bwrap unshare jq flock; do
	command -v "$tool" >/dev/null || fail "Missing existing tool: $tool"
done

stamp=$(date -u +%Y%m%dT%H%M%S.%NZ)
evidence=$repo/.omo/evidence/v2-install-$stamp
mkdir -p "$evidence/candidate" "$evidence/previous" "$evidence/failed"
exec 9>"$repo/.omo/v2-install.lock"
flock -n 9 || fail 'Another canonical V2 installation is active.'
[[ -d $ws/.tmp ]] || fail 'Workspace .tmp directory required.'
work=$(mktemp -d "$ws/.tmp/omo-v2-build.XXXXXXXX")
copy=$work/source
mkdir "$copy" "$work/home" "$work/tmp"
# Archive committed bytes, never the dirty port tree or generated Senpi working files.
g -C "$repo" archive "$omo_oid" | tar -xf - -C "$copy"
cp -p "$repo/.git" "$copy/.git"
for deps in "$repo/node_modules" "$repo"/packages/*/node_modules "$repo/packages/omo-codex/plugin/node_modules"; do
	[[ -d $deps ]] || continue
	relative=${deps#"$repo/"}
	mkdir -p "$copy/$(dirname "$relative")"
	cp -a --reflink=auto "$deps" "$copy/$relative"
done
common=$(g -C "$repo" rev-parse --path-format=absolute --git-common-dir)
printf 'omo_commit=%s\nhost_commit=%s\nhost_sha256=%s\nbuild_copy=%s\n' \
	"$omo_oid" "$host_oid" "$host_hash" "$copy" >"$evidence/provenance"

# The source bind is a real directory: materialization must rename entire directories.
TMPDIR="$work/tmp" unshare -r bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc \
	--bind "$work" "$work" \
	--bind "$copy" "$repo" --overlay-src "$common" --tmp-overlay "$common" \
	--clearenv \
	--setenv PATH "/home/nikita/.local/bin:/home/nikita/.nvm/versions/node/v24.16.0/bin:/usr/bin:/bin:$repo/node_modules/.bin" \
	--setenv HOME "$work/home" --setenv TMPDIR "$work/tmp" \
	--setenv XDG_CONFIG_HOME "$work/home/config" --setenv XDG_DATA_HOME "$work/home/data" \
	--setenv XDG_CACHE_HOME "$work/home/cache" --setenv XDG_STATE_HOME "$work/home/state" \
	--setenv CI true --setenv GIT_MASTER 1 --setenv GIT_TERMINAL_PROMPT 0 \
	--setenv GIT_CONFIG_NOSYSTEM 1 --setenv GIT_CONFIG_GLOBAL /dev/null \
	--setenv GIT_CONFIG_COUNT 1 --setenv GIT_CONFIG_KEY_0 safe.directory --setenv GIT_CONFIG_VALUE_0 '*' \
	--chdir "$repo" bash -Eeuo pipefail -c "git read-tree \"\$1\"; bun install --frozen-lockfile --ignore-scripts; bun run build" bash "$omo_oid" \
	2>&1 | tee "$evidence/build.log"

for path in "${paths[@]}"; do
	[[ -d $copy/$path && -d $repo/$path && ! -L $repo/$path ]] || fail "Missing or linked runtime directory: $path"
	mkdir -p "$evidence/candidate/$(dirname "$path")" "$evidence/previous/$(dirname "$path")" "$evidence/failed/$(dirname "$path")"
	cp -a --reflink=auto "$copy/$path" "$evidence/candidate/$path"
done
[[ -s $evidence/candidate/dist/index.js && -s $evidence/candidate/dist/tui.js ]] || fail 'Missing plugin entrypoints.'
(
	cd "$evidence/candidate"
	find "${paths[@]}" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) >"$evidence/artifacts.sha256"
(
	cd "$evidence/candidate"
	tar -czf "$evidence/artifacts.tar.gz" "${paths[@]}"
)
printf 'archive_sha256=%s\n' "$(digest "$evidence/artifacts.tar.gz")" >>"$evidence/provenance"
cp -p "$evidence/provenance" "$evidence/candidate/dist/v2-provenance"
cp -p "$evidence/artifacts.sha256" "$evidence/candidate/dist/v2-artifacts.sha256"
identity

activation=0
moved=()
rollback() {
	result=$?
	trap - EXIT INT TERM
	if ((activation)); then
		set +e
		lab service stop >>"$evidence/rollback.log" 2>&1
		restored=1
		for ((i = ${#moved[@]} - 1; i >= 0; i--)); do
			path=${moved[i]}
			[[ -d $evidence/previous/$path ]] || continue
			if [[ -e $repo/$path ]]; then
				mv -T "$repo/$path" "$evidence/failed/$path" || {
					restored=0
					continue
				}
			fi
			mv -T "$evidence/previous/$path" "$repo/$path" || restored=0
		done
		if ((restored)); then
			lab service restart >>"$evidence/rollback.log" 2>&1 || restored=0
		fi
		printf 'Activation failed; restored=%s. Backups and candidates: %s\n' "$restored" "$evidence" >&2
	fi
	exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
activation=1
lab service stop >"$evidence/stop.log" 2>&1
identity
for path in "${paths[@]}"; do
	moved+=("$path")
	mv -T "$repo/$path" "$evidence/previous/$path"
	mv -T "$evidence/candidate/$path" "$repo/$path"
done

lab service restart >"$evidence/restart.log" 2>&1
registration=/home/nikita/.local/share/opencode-v2-lab/port/state/opencode/service-local.json
running_matches() {
	pid=$(jq -er '.pid | select(type == "number" and . > 0 and floor == .)' "$registration") || return 1
	[[ $(digest "/proc/$pid/exe") == "$host_hash" ]]
}
# An older mapped client has raced service startup before; force the installed image once.
if ! running_matches; then
	lab service restart >>"$evidence/restart.log" 2>&1
	running_matches || fail 'Running V2 executable does not match the installed host.'
fi
identity
(
	cd "$repo"
	sha256sum --check "$evidence/artifacts.sha256"
) >"$evidence/installed-hashes.log"
printf 'running_pid=%s\nrunning_exe_sha256=%s\n' "$pid" "$host_hash" >>"$evidence/provenance"
# A matching server executable does not prove that the workspace plugin loaded.
password=$(lab service get password 2>/dev/null) || fail 'Unable to obtain the V2 service credential.'
printf '%s' "$password" | OMO_INSTALL_WORKSPACE="$ws" bun -e '
try {
	const password = (await Bun.stdin.text()).trim()
	if (!password) throw new Error("credential unavailable")
	const signal = AbortSignal.timeout(120000)
	const authorization = `Basic ${btoa(`opencode:${password}`)}`
	// RPC awaits native activation; the event-only OMO channel rejects this probe before any handler executes.
	const readyURL = new URL("http://127.0.0.1:49375/api/rpc/omo/__omo_install_activation_probe__")
	readyURL.searchParams.set("location[directory]", process.env.OMO_INSTALL_WORKSPACE)
	const ready = await fetch(readyURL, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: "{}",
		signal,
	})
	const readiness = await ready.json()
	if (ready.status !== 400 || readiness?._tag !== "RpcError" || readiness.type !== "rpc.method_not_found") throw new Error("activation barrier failed")
	const url = new URL("http://127.0.0.1:49375/api/agent")
	url.searchParams.set("location[directory]", process.env.OMO_INSTALL_WORKSPACE)
	const response = await fetch(url, {
		headers: { authorization },
		signal,
	})
	if (response.status !== 200) {
		console.error(`OMO activation check failed: HTTP ${response.status}`)
		process.exit(1)
	}
	const body = await response.json()
	if (!Array.isArray(body?.data)) throw new Error("invalid response")
	const ids = body.data.map((agent) => agent?.id).filter((id) => typeof id === "string")
	const primary = [/sisyphus/i, /hephaestus/i, /prometheus/i, /atlas/i]
	if (!primary.every((name) => ids.some((id) => name.test(id)))) throw new Error("missing primary")
	console.log(`OMO activation check: HTTP 200; primary agents ${primary.length}`)
} catch {
	console.error("OMO activation check failed: credential, request, response, or primary agents invalid")
	process.exit(1)
}
' || fail 'OMO plugin activation was not verified.'
unset password
activation=0
printf 'Installed OMO %s using host %s; receipt and rollback: %s\n' "$omo_oid" "$host_oid" "$evidence"
