#!/usr/bin/env bash
# Install the latest committed product snapshot; in-progress working files are not included.
set -Eeuo pipefail
umask 077

ws=/home/nikita/work/Projects/ai/op
repo=$ws/oh-my-openagent
canonical_repo=$repo
host=$ws/opencode
binary=$host/packages/cli/dist/cli-linux-x64/bin/opencode
launcher=/home/nikita/.local/bin/opencode-v2-lab
standard_launcher=/home/nikita/.local/bin/opencode
host_oid=751c96ed038e2d7ef1f15ca86f4373e9aed50696
host_checkout_oid=751c96ed038e2d7ef1f15ca86f4373e9aed50696
host_hash=bdbc6167a21922715f0b5003cc2eb943e9150fbc4b799f98e7d7baab8f4b9fb5
old_host_hash=460747d6626558bf79f75000ab1117df8214fe9c84eab1dc6818354b0c5bfa04
host_candidate=$ws/.tmp/v2-host-local-751c96ed038e2d7ef1f15ca86f4373e9aed50696/cli-linux-x64/bin/opencode
paths=(dist packages/lsp-tools-mcp/dist packages/lsp-daemon/dist packages/git-bash-mcp/dist packages/shared-skills/skills)

fail() {
	if [[ -n ${evidence:-} && -d $evidence ]]; then
		printf '%s\n' "$*" >>"$evidence/failure.log"
	fi
	printf '%s\n' "$*" >&2
	exit 1
}
g() { GIT_MASTER=1 GIT_OPTIONAL_LOCKS=0 command git "$@"; }
digest() { sha256sum "$1" | cut -d ' ' -f 1; }
lab() {
	if [[ $profile == dev ]]; then
		env -u OPENCODE_V2_BIN HOME=/home/nikita "$launcher" dev "$@" 9>&-
	else
		env -u OPENCODE_V2_BIN -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME HOME=/home/nikita "$standard_launcher" "$@" 9>&-
	fi
}

host_flavor() {
	local executable=$1 root=$2 user_agent db
	mkdir -p "$root"
	user_agent=$(LC_ALL=C grep -aEo 'opencode/[a-zA-Z0-9._-]+/[0-9][a-zA-Z0-9.+-]*/cli' "$executable" | sort -u) || return 1
	[[ $user_agent =~ ^opencode/local/[^/]+/cli$ ]] || return 1
	db=$(env -i PATH=/usr/bin:/bin HOME="$root" XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" TMPDIR="$root" "$executable" debug paths db) || return 1
	[[ $db == "$root/data/opencode/opencode-local.db" && ! -e $db ]] || return 1
	printf '%s\n' 'channel=local' 'default_port=49375' 'registration=service-local.json' 'database=opencode-local.db'
}

snapshot_tool() {
	/usr/bin/python3 -I -c '
import hashlib, hmac, os, re, secrets, subprocess, sys
from pathlib import Path

def parse(raw):
    if not raw or not raw.endswith(bytes(1)):
        raise ValueError()
    values = {}
    for entry in raw[:-1].split(bytes(1)):
        key, value = entry.split(b"=", 1)
        if not re.fullmatch(rb"[A-Za-z_][A-Za-z_0-9]*", key) or key in values:
            raise ValueError()
        values[key] = value
    return values

try:
    mode, *args = sys.argv[1:]
    old = parse(sys.stdin.buffer.read())
    if mode == "validate":
        profile, pid, expected = args
        if profile == "dev":
            base = os.fsencode("/home/nikita/.local/share/opencode-v2-lab/" + profile)
            for key, subdir in ((b"HOME", b"home"), (b"XDG_STATE_HOME", b"state"), (b"XDG_DATA_HOME", b"data"), (b"XDG_CONFIG_HOME", b"config")):
                if old.get(key) != base + b"/" + subdir:
                    raise ValueError()
        else:
            if old.get(b"HOME") != b"/home/nikita":
                raise ValueError()
            for key, path in ((b"XDG_STATE_HOME", b"/home/nikita/.local/state"), (b"XDG_DATA_HOME", b"/home/nikita/.local/share"), (b"XDG_CONFIG_HOME", b"/home/nikita/.config"), (b"XDG_CACHE_HOME", b"/home/nikita/.cache")):
                if key in old and old[key] != path:
                    raise ValueError()
            if any(b"opencode-v2-lab" in value for value in old.values()):
                raise ValueError()
        proc = Path("/proc") / pid
        argv = (proc / "cmdline").read_bytes().split(bytes(1))
        if argv[1:] != [b"serve", b"--service", b""]:
            raise ValueError()
        exe = (proc / "exe").resolve(strict=True)
        if profile == "dev":
            image = Path(os.fsdecode(old[b"OPENCODE_V2_BIN"]))
            runtime = Path(os.fsdecode(old[b"OPENCODE_V2_OMO"]))
            if image != exe or runtime != exe.parent / "omo" or not re.fullmatch(r"dev-activation\.[A-Za-z0-9]+", exe.parent.name) or exe.name != "host-opencode" or exe.parent.parent != Path("/home/nikita/work/Projects/adversa/.tmp/agent-models"):
                raise ValueError()
            if runtime.resolve(strict=True) != runtime:
                raise ValueError()
            print(runtime)
        elif exe != Path(expected):
            raise ValueError()
    elif mode == "compare":
        new = parse((Path("/proc") / args[0] / "environ").read_bytes())
        key = secrets.token_bytes(32)
        def digest(value):
            return hmac.digest(key, value, hashlib.sha256)
        equal = True
        for name in sorted(old.keys() | new.keys()):
            same = name in old and name in new and hmac.compare_digest(digest(old[name]), digest(new[name]))
            print(name.decode("ascii"), "same" if same else "differs")
            equal &= same
        sys.exit(0 if equal else 1)
    elif mode == "start":
        process = subprocess.Popen([args[0], "serve", "--service"], env=old, cwd=old[b"HOME"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(process.pid)
    elif mode == "launcher":
        old[b"HOME"] = b"/home/nikita"
        os.execve(args[0], args, old)
    else:
        raise ValueError()
except (OSError, ValueError, KeyError):
    sys.exit("Activation environment or service identity validation failed.")
' "$@" 9>&-
}

operation=${1:-install}
profile=port
case $operation in
--activate-built-detached|--detached-worker)
	profile=${3:-port}
	[[ $profile == port || $profile == dev ]] || fail 'Activation profile must be port or dev.' ;;
esac
if [[ $operation == --detached-worker ]]; then
	[[ $(</proc/self/cgroup) == */opencode-v2-activate-"$profile"-"${4:-}".service ]] || fail 'Detached worker is outside its activation unit.'
	export PATH=/home/nikita/.local/bin:/home/nikita/.nvm/versions/node/v24.16.0/bin:/usr/bin:/bin
fi
lab_root=/home/nikita/.local/share/opencode-v2-lab/$profile
registration=$lab_root/state/opencode/service-local.json
[[ $profile == dev ]] || registration=/home/nikita/.local/state/opencode/service-local.json
activation_url=http://127.0.0.1:49375
[[ $profile == port ]] || activation_url=http://127.0.0.1:49581
registered_pid() {
	jq -er --arg url "$activation_url" 'select(.url == $url) | .pid | select(type == "number" and . > 0 and floor == .)' "$registration"
}
with_snapshot() { printf '%s\0' "${service_env[@]}" | snapshot_tool "$@"; }

case $operation in
install) [[ $# == 0 ]] || fail 'Default installation takes no arguments.' ;;
--build-only) [[ $# == 1 ]] || fail '--build-only takes no additional arguments.' ;;
--activate-built-detached) [[ $# == 2 || ( $# == 3 && $3 == dev ) ]] || fail '--activate-built-detached requires a build evidence directory and optional dev profile.' ;;
--detached-worker) [[ $# == 4 && $4 =~ ^[1-9][0-9]*$ && ${INVOCATION_ID:-} =~ ^[a-f0-9]{32}$ ]] || fail 'Detached worker requires a transient user unit.' ;;
--activate-built) [[ $# == 2 ]] || fail '--activate-built requires a build evidence directory.' ;;
*) fail 'Usage: script/install-v2-local.sh [--build-only | --activate-built EVIDENCE | --activate-built-detached EVIDENCE [dev]]' ;;
esac
[[ $(realpath -- "$0") == "$repo/script/install-v2-local.sh" ]] || fail 'Use the canonical dev helper.'
[[ $(g -C "$repo" branch --show-current) == local/v2-stack ]] || fail 'Active branch local/v2-stack required.'
omo_oid=$(g -C "$repo" rev-parse HEAD)
[[ $profile == dev ]] || g -C "$repo" show "$omo_oid:script/install-v2-local.sh" | cmp -s - "$0" || fail 'Commit this helper before use.'

installed_host_hash=$(digest "$binary")
case $installed_host_hash in
"$old_host_hash") ;;
"$host_hash") host_candidate=$binary ;;
*) fail 'Installed host differs from the verified baseline.' ;;
esac
identity() {
	[[ $(g -C "$canonical_repo" rev-parse HEAD) == "$omo_oid" ]] || fail 'OMO HEAD changed; build the latest commit again.'
	[[ $(g -C "$host" rev-parse HEAD) == "$host_checkout_oid" ]] || fail 'Host checkout changed; verify its source against the host build.'
	[[ $(digest "$binary") == "$installed_host_hash" ]] || fail 'Installed host differs from the verified baseline.'
}
identity
[[ -x $host_candidate && $(digest "$host_candidate") == "$host_hash" ]] || fail 'Verified staged host missing or changed.'
(cd "$repo" && grep -v '  packages/shared-skills/skills/' dist/v2-artifacts.sha256 | sha256sum --status --check) || fail 'Installed prebuilt asset manifest mismatch.'
if [[ $profile == dev ]]; then
	grep -Fxq "  port|dev) omo=\$ws/oh-my-openagent ;;" "$launcher" ||
		fail 'Apply the canonical port/dev launcher mapping before installation.'
else
	jq -e --arg plugin "file://$repo" 'any(.plugin[]; . == $plugin or (type == "array" and .[0] == $plugin))' /home/nikita/.config/opencode/opencode.json >/dev/null ||
		fail 'Standard V2 configuration does not load the canonical OMO plugin.'
fi
for tool in bun node git tar cp bwrap jq flock; do
	command -v "$tool" >/dev/null || fail "Missing existing tool: $tool"
done
bun_bin=/home/nikita/.local/lib/node_modules/bun/bin/bun.exe
node_bin=/home/nikita/.nvm/versions/node/v24.16.0/bin/node
for file in "$bun_bin" "$node_bin"; do
	[[ -x $file ]] || fail "Missing executable: $file"
done
for asset in packages/lsp-tools-mcp/dist/cli.js packages/lsp-daemon/dist/cli.js packages/git-bash-mcp/dist/cli.js; do
	[[ -s $repo/$asset ]] || fail "Missing existing prebuilt asset: $asset"
done
[[ -d $repo/packages/shared-skills/skills && -d $repo/node_modules ]] || fail 'Missing existing skills or dependencies.'
for file in /etc/ld.so.cache /etc/ssl/certs/ca-certificates.crt /etc/hosts /etc/nsswitch.conf /etc/resolv.conf; do
	[[ -f $file && -r $file ]] || fail "Missing runtime input: $file"
done

stamp=$(date -u +%Y%m%dT%H%M%S.%NZ)
exec 9>"$repo/.omo/v2-install.lock"
if [[ $operation == --detached-worker ]]; then
	flock -w 5 9 || fail 'Another canonical V2 installation is active.'
else
	flock -n 9 || fail 'Another canonical V2 installation is active.'
fi
if [[ $operation == install || $operation == --build-only ]]; then
	evidence=$repo/.omo/evidence/v2-install-$stamp
	mkdir -p "$evidence/candidate" "$evidence/previous" "$evidence/failed"
	[[ -d $ws/.tmp ]] || fail 'Workspace .tmp directory required.'
	work=$(mktemp -d "$ws/.tmp/omo-v2-build.XXXXXXXX")
	copy=$work/source
	mkdir "$copy" "$work/home" "$work/tmp"
	host_flavor "$binary" "$work/probe-installed" >"$evidence/host-flavor-installed.log" || fail 'Installed host is not the expected local flavor.'
	host_flavor "$host_candidate" "$work/probe-candidate" >"$evidence/host-flavor-candidate.log" || fail 'Staged host is not the expected local flavor.'
	cmp -s "$evidence/host-flavor-installed.log" "$evidence/host-flavor-candidate.log" || fail 'Staged and installed host flavors differ.'
	# Archive committed bytes, never the dirty port tree or generated Senpi working files.
	g -C "$repo" archive "$omo_oid" | tar -xf - -C "$copy"
	cp -p "$repo/.git" "$copy/.git"
	for deps in "$repo/node_modules" "$repo"/packages/*/node_modules "$repo/packages/omo-codex/plugin/node_modules"; do
		[[ -d $deps ]] || continue
		relative=${deps#"$repo/"}
		mkdir -p "$copy/$(dirname "$relative")"
		cp -a --reflink=auto "$deps" "$copy/$relative"
	done
	for asset in packages/lsp-tools-mcp/dist packages/lsp-daemon/dist packages/git-bash-mcp/dist; do
		mkdir -p "$copy/$asset"
		cp -a --reflink=auto "$repo/$asset/." "$copy/$asset/"
	done
	common=$(g -C "$repo" rev-parse --path-format=absolute --git-common-dir)
	printf 'omo_commit=%s\nhost_commit=%s\nhost_sha256=%s\nbuild_copy=%s\n' \
		"$omo_oid" "$host_oid" "$host_hash" "$copy" >"$evidence/provenance"

	# The source bind is a real directory: materialization must rename entire directories.
	TMPDIR="$work/tmp" bwrap --unshare-all --die-with-parent --tmpfs / --ro-bind /usr /usr \
		--symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
		--dir /etc/ssl/certs --ro-bind /etc/ld.so.cache /etc/ld.so.cache \
		--ro-bind /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt \
		--ro-bind /etc/hosts /etc/hosts --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf \
		--ro-bind /etc/resolv.conf /etc/resolv.conf \
		--dir /tools --ro-bind "$bun_bin" /tools/bun --ro-bind "$node_bin" /tools/node \
		--dev /dev --proc /proc \
		--bind "$work" "$work" \
		--bind "$copy" "$repo" --overlay-src "$common" --tmp-overlay "$common" \
		--clearenv \
		--setenv PATH "/tools:$repo/node_modules/.bin:/usr/bin:/bin" \
		--setenv SSL_CERT_FILE /etc/ssl/certs/ca-certificates.crt \
		--setenv HOME "$work/home" --setenv TMPDIR "$work/tmp" \
		--setenv XDG_CONFIG_HOME "$work/home/config" --setenv XDG_DATA_HOME "$work/home/data" \
		--setenv XDG_CACHE_HOME "$work/home/cache" --setenv XDG_STATE_HOME "$work/home/state" \
		--setenv CI true --setenv GIT_MASTER 1 --setenv GIT_TERMINAL_PROMPT 0 \
		--setenv OMO_SKIP_MATERIALIZE 1 \
		--setenv GIT_CONFIG_NOSYSTEM 1 --setenv GIT_CONFIG_GLOBAL /dev/null \
		--setenv GIT_CONFIG_COUNT 1 --setenv GIT_CONFIG_KEY_0 safe.directory --setenv GIT_CONFIG_VALUE_0 '*' \
		--chdir "$repo" bash -Eeuo pipefail -c '
		git read-tree "$1"
		bun build packages/omo-opencode/src/index.ts --outdir dist --target bun --format esm --external zod
		bun build packages/omo-opencode/src/tui.ts --outdir dist --target bun --format esm --external @opentui/core --external @opentui/keymap --external @opentui/solid --external solid-js
		bun run build:shared-skills-assets
		bun run build:node-require-shim
		tsc --emitDeclarationOnly
		bun build packages/omo-opencode/src/cli/index.ts --outdir dist/cli --target bun --format esm
		bun run build:cli-node
		bun run build:schema
		bun run build:omo-schema
	' bash "$omo_oid" \
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
	cp -p "$binary" "$evidence/previous/host-opencode"
	cp -p "$host_candidate" "$evidence/candidate/host-opencode"
	[[ $(digest "$evidence/previous/host-opencode") == "$installed_host_hash" && $(digest "$evidence/candidate/host-opencode") == "$host_hash" ]] || fail 'Host backup or candidate hash mismatch.'
else
	evidence=$(realpath -e -- "$2") || fail 'Build evidence directory is missing.'
	[[ $evidence == "$repo/.omo/evidence/v2-install-"* ]] || fail 'Use a canonical V2 build receipt.'
	for binding in "omo_commit=$omo_oid" "host_commit=$host_oid" "host_sha256=$host_hash"; do
		grep -Fxq "$binding" "$evidence/provenance" || fail 'Build receipt does not match current committed source and host.'
	done
	copy=
	while IFS='=' read -r key value; do
		[[ $key != build_copy ]] || copy=$value
	done <"$evidence/provenance"
	[[ -n $copy ]] || fail 'Build receipt has no source identity.'
	for path in "${paths[@]}"; do
		[[ -d $evidence/candidate/$path && ! -L $evidence/candidate/$path ]] || fail 'Built runtime candidate is missing or linked.'
	done
	(cd "$evidence/candidate" && sha256sum --status --check "$evidence/artifacts.sha256") || fail 'Built runtime candidate changed.'
	[[ $(digest "$evidence/previous/host-opencode") == "$installed_host_hash" && $(digest "$evidence/candidate/host-opencode") == "$host_hash" ]] || fail 'Build receipt host baseline or candidate changed.'
fi
if [[ $operation == --build-only ]]; then
	printf 'Built OMO %s; candidate and receipt: %s; smoke source: %s\n' "$omo_oid" "$evidence" "$copy"
	exit 0
fi
if [[ $operation == --activate-built-detached ]]; then
	old_pid=$(registered_pid) || fail "No running $profile service registration."
	kill -0 "$old_pid" || fail "The registered $profile service is not running."
	unit=opencode-v2-activate-$profile-$old_pid.service
	log=$(mktemp "$evidence/activation-$profile.XXXXXXXX.log")
	systemd-run --user --quiet --unit="$unit" --service-type=exec \
		--property=ExitType=cgroup --property=SuccessExitStatus=1 --expand-environment=no \
		--property="StandardOutput=append:$log" --property=StandardError=inherit \
		/usr/bin/bash -c '"$@"; result=$?; printf "Activation exit: %s\n" "$result"; ((result == 0))' bash \
		"$canonical_repo/script/install-v2-local.sh" --detached-worker "$evidence" "$profile" "$old_pid" 9>&- || fail 'Cannot submit detached activation.'
	printf 'Unit: %s\nLog: %s\n' "$unit" "$log"
	exit 0
fi

if [[ $operation == --detached-worker ]]; then
	[[ $(registered_pid) == "$4" ]] || fail 'The service changed after activation submission.'
	mapfile -d '' -t service_env <"/proc/$4/environ" || fail 'Cannot read the running service environment.'
	runtime=$(with_snapshot validate "$profile" "$4" "$binary") || fail 'Cannot preserve the running service environment.'
	[[ $(registered_pid) == "$4" ]] || fail 'The service changed during environment capture.'
	if [[ $profile == dev ]]; then
		source_evidence=$evidence
		repo=$runtime
		binary=$(dirname "$runtime")/host-opencode
		installed_host_hash=$(digest "$binary")
		evidence=$source_evidence/dev-$stamp
		mkdir -p "$evidence/previous" "$evidence/failed"
		cp -a --reflink=auto "$source_evidence/candidate" "$evidence/candidate"
		cp -p "$source_evidence/"{provenance,artifacts.sha256} "$evidence/"
		cp -p "$binary" "$evidence/previous/host-opencode"
		for path in "${paths[@]}"; do
			[[ -d $repo/$path && ! -L $repo/$path && $(realpath -e "$repo/$path") == "$repo/$path" ]] || fail 'Dev artifacts must be isolated.'
			mkdir -p "$evidence/previous/$(dirname "$path")" "$evidence/failed/$(dirname "$path")"
		done
		jq -e --arg plugin "file://$repo" 'any(.plugin[]; . == $plugin or (type == "array" and .[0] == $plugin))' "$lab_root/config/opencode/opencode.json" >/dev/null || fail 'Dev is not configured to load its isolated OMO copy.'
	fi
	if [[ $profile == dev ]]; then
		lab() { with_snapshot launcher "$launcher" "$profile" "$@"; }
	else
		lab() { with_snapshot launcher "$standard_launcher" "$@"; }
	fi
fi

restart_service() {
	if [[ $operation != --detached-worker ]]; then
		lab service restart
		return
	fi
	local child current attempt
	child=$(with_snapshot start "$binary") || return 1
	for ((attempt = 0; attempt < 200; attempt++)); do
		current=$(registered_pid 2>/dev/null) || current=
		if [[ $current == "$child" ]]; then
			with_snapshot compare "$child"
			return
		fi
		kill -0 "$child" 2>/dev/null || break
		sleep 0.1
	done
	kill "$child" 2>/dev/null || true
	printf '%s\n' 'Replacement service did not register under its new PID.' >&2
	return 1
}

lab_config=$lab_root/config/opencode
if [[ $profile == dev ]]; then
	[[ -e $lab_root/.credentials-imported ]] || fail 'Credential-import marker missing; refusing to modify credentials.'
else
	lab_config=/home/nikita/.config/opencode
fi
config_before=$(sha256sum "$lab_config/opencode.json" "$lab_config/cli.json")
printf '\n- Install checkpoint: OMO commit `%s`, host commit `%s`, host SHA-256 `%s`; staged and rollback artifacts `%s`; build copy `%s`. Activation will replace both artifacts and restart the selected profile once.\n' \
	"$omo_oid" "$host_oid" "$host_hash" "$evidence" "$copy" >"$evidence/activation-checkpoint.md"

activation=0
host_swapped=0
moved=()
rollback() {
	result=$?
	trap - EXIT INT TERM
	if ((activation)); then
		set +e
		printf 'Restoring previous %s artifacts and service.\n' "$profile"
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
		if ((host_swapped)); then
			cp -p "$evidence/previous/host-opencode" "$binary.rollback.$stamp" && mv -T "$binary.rollback.$stamp" "$binary" || restored=0
		fi
		if ((restored)); then
			restart_service >>"$evidence/rollback.log" 2>&1 || restored=0
		fi
		if [[ $operation == --detached-worker ]]; then cat "$evidence/rollback.log"; fi
		printf 'Activation failed; exit=%s; restored=%s. Backups and candidates: %s\n' "$result" "$restored" "$evidence" | tee -a "$evidence/failure.log" >&2
	fi
	exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
activation=1
printf 'Stopping %s service and installing verified artifacts.\n' "$profile"
lab service stop >"$evidence/stop.log" 2>&1
identity
[[ $(sha256sum "$lab_config/opencode.json" "$lab_config/cli.json") == "$config_before" ]] || fail 'Activation changed lab configuration.'
if [[ $installed_host_hash != "$host_hash" ]]; then
	[[ ! -e $binary.staged.$stamp && ! -L $binary.staged.$stamp ]] || fail 'Host staging path already exists.'
	cp -p "$evidence/candidate/host-opencode" "$binary.staged.$stamp"
	host_swapped=1
	mv -T "$binary.staged.$stamp" "$binary"
	installed_host_hash=$host_hash
fi
for path in "${paths[@]}"; do
	moved+=("$path")
	mv -T "$repo/$path" "$evidence/previous/$path"
	mv -T "$evidence/candidate/$path" "$repo/$path"
done

printf 'Starting replacement service; evidence: %s\n' "$evidence"
if [[ $operation == --detached-worker ]]; then
	restart_service 2>&1 | tee "$evidence/restart.log"
else
	restart_service >"$evidence/restart.log" 2>&1
fi
running_matches() {
	pid=$(registered_pid) || return 1
	[[ $(digest "/proc/$pid/exe") == "$host_hash" ]]
}
running_matches || fail 'Running V2 executable does not match the installed host.'
identity
[[ $(sha256sum "$lab_config/opencode.json" "$lab_config/cli.json") == "$config_before" ]] || fail 'Activation changed lab configuration.'
(
	cd "$repo"
	sha256sum --check "$evidence/artifacts.sha256"
) >"$evidence/installed-hashes.log"
printf 'running_pid=%s\nrunning_exe_sha256=%s\n' "$pid" "$host_hash" >>"$evidence/provenance"
# A matching server executable does not prove that the workspace plugin loaded.
password=$(lab service get password 2>/dev/null) || fail 'Unable to obtain the V2 service credential.'
printf '%s' "$password" | OMO_INSTALL_WORKSPACE="$ws" OMO_INSTALL_URL="$activation_url" OMO_INSTALL_PLUGIN="$repo" bun --cwd "$canonical_repo" -e '
try {
	const password = (await Bun.stdin.text()).trim()
	if (!password) throw new Error("credential unavailable")
	const signal = AbortSignal.timeout(120000)
	const { setTimeout } = await import("node:timers/promises")
	const { z } = await import("zod")
	const authorization = `Basic ${btoa(`opencode:${password}`)}`
	const url = new URL("/api/agent", process.env.OMO_INSTALL_URL)
	url.searchParams.set("location[directory]", process.env.OMO_INSTALL_WORKSPACE)
	const catalog = z.object({ data: z.array(z.object({ id: z.string().min(1) })) })
	const pluginUrl = new URL("/api/plugin", process.env.OMO_INSTALL_URL)
	pluginUrl.searchParams.set("location[directory]", process.env.OMO_INSTALL_WORKSPACE)
	const plugins = z.object({ data: z.array(z.object({ source: z.object({ type: z.string(), path: z.string().optional() }), state: z.object({ status: z.string() }) })) })
	const requiredPaths = [process.env.OMO_INSTALL_PLUGIN, "/op/opencode-with-claude", "/oc-codex-multi-auth"]
	const primary = [/sisyphus/i, /hephaestus/i, /prometheus/i, /atlas/i]
	let last = "catalog or plugin inventory incomplete"
	async function request(endpoint, schema) {
		let response
		try {
			response = await fetch(endpoint, { headers: { authorization }, signal, redirect: "error" })
		} catch (error) {
			if (error?.code !== "ECONNREFUSED") throw new Error(endpoint.pathname + ": request failed")
			last = endpoint.pathname + ": connection refused"
			return
		}
		if (response.status !== 200) {
			await response.body?.cancel()
			last = endpoint.pathname + ": HTTP " + response.status
			if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) return
			throw new Error(last)
		}
		try {
			return schema.parse(await response.json())
		} catch {
			throw new Error(endpoint.pathname + ": invalid response")
		}
	}
	for (;;) {
		if (signal.aborted) throw new Error("deadline expired; last observation: " + last)
		const body = await request(url, catalog)
		const inventory = body && await request(pluginUrl, plugins)
		if (inventory && primary.every((name) => body.data.some((agent) => name.test(agent.id))) &&
			requiredPaths.every((path) => inventory.data.some((plugin) => plugin.state.status === "active" && plugin.source.type === "local" && plugin.source.path?.includes(path)))) break
		if (inventory) last = "catalog or plugin inventory incomplete"
		try { await setTimeout(100, undefined, { signal }) } catch {
			throw new Error("deadline expired; last observation: " + last)
		}
	}
	console.log(`OMO activation check: HTTP 200; primary agents ${primary.length}; OMO/OWC/oc-codex plugins active`)
} catch (error) {
	console.error("OMO activation check failed: " + (error instanceof Error ? error.message : "unexpected error"))
	process.exit(1)
}
' 2>&1 | tee "$evidence/activation-check.log" || fail 'OMO plugin activation was not verified.'
unset password
[[ $(sha256sum "$lab_config/opencode.json" "$lab_config/cli.json") == "$config_before" ]] || fail 'Activation changed lab configuration.'
activation=0
printf 'Installed OMO %s using host %s; receipt and rollback: %s\n' "$omo_oid" "$host_oid" "$evidence"
