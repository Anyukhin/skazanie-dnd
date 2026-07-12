#!/bin/sh

set -u

target="${TUNNEL_TARGET:-skazanie:8787}"
state_dir="${TUNNEL_STATE_DIR:-/state}"
state_file="$state_dir/PUBLIC_LINK.txt"
known_hosts_file="$state_dir/known_hosts"

mkdir -p "$state_dir"

write_public_url() {
  line="$1"
  address="$(printf '%s\n' "$line" | grep -Eo 'https://[[:alnum:]][[:alnum:].-]*\.(free\.pinggy\.net|pinggy-free\.link|pinggy\.link)' | tail -n 1)"

  case "$address" in
    https://*.free.pinggy.net|https://*.pinggy-free.link|https://*.pinggy.link) public_url="$address" ;;
    *) return 0 ;;
  esac

  temporary_file="$state_file.tmp"
  printf '%s\n' "$public_url" > "$temporary_file"
  mv -f "$temporary_file" "$state_file"
}

while true; do
  : > "$state_file"
  ssh \
    -p 443 \
    -T \
    -o ConnectTimeout=15 \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new \
    -o "UserKnownHostsFile=$known_hosts_file" \
    -R "0:$target" \
    free.pinggy.io 2>&1 | while IFS= read -r line; do
      printf '%s\n' "$line"
      write_public_url "$line"
    done

  printf '%s\n' 'Pinggy tunnel disconnected or expired; reconnecting in 3 seconds.'
  sleep 3
done
