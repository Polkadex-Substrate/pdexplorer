#!/usr/bin/env bash
#
# Capture the digest of every base image and rewrite the pins.  (Audit F-150)
#
# `FROM node:22.11-alpine` and `image: certbot/certbot:v2.11.0` name a TAG, and
# a tag is a mutable pointer. Docker Hub can retag `22.11-alpine` at any time —
# routinely, for a base-OS CVE patch, and not routinely if the namespace is ever
# compromised. Either way the next `docker compose build` on a fresh host pulls
# different bytes than the last one, with nothing in git recording the change.
# That is the supply-chain half of reproducibility: the lockfile pins our npm
# tree exactly (F-102) while the layer underneath it floats.
#
# A digest is content-addressed, so `name:tag@sha256:…` is the same bytes
# forever. The tag stays for readability; the digest is what Docker resolves.
#
# This script must run WHERE THE IMAGES ARE — it reads digests from the local
# daemon rather than the network, so it cannot be run from a sandbox and does
# not need registry credentials.
#
#   bash tools/pin-image-digests.sh            # show what would change
#   bash tools/pin-image-digests.sh --write    # rewrite the files
#
# After a bump: change the TAG by hand, `docker compose pull`, re-run with
# --write, and commit both. The digest is the record of what you actually
# shipped, which is the point.
set -uo pipefail

WRITE=0
[ "${1:-}" = "--write" ] && WRITE=1

command -v docker >/dev/null 2>&1 || { echo "docker not found — run this on the deployment host." >&2; exit 2; }

# file : tag  (the tag as it appears today, without any existing @sha256)
TARGETS=(
    "Dockerfile.backend:node:22.11-alpine"
    "Dockerfile.frontend:node:22.11-alpine"
    "Dockerfile.frontend:nginxinc/nginx-unprivileged:1.27-alpine"
    "docker-compose.yml:certbot/certbot:v2.11.0"
)

changed=0
for entry in "${TARGETS[@]}"; do
    file="${entry%%:*}"
    tag="${entry#*:}"
    [ -f "$file" ] || { echo "SKIP  $file not found"; continue; }

    # Already pinned? Leave it — re-pinning silently would defeat the purpose.
    if grep -qF "${tag}@sha256:" "$file"; then
        echo "OK    $file  $tag is already digest-pinned"
        continue
    fi

    digest=$(docker image inspect "$tag" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//')
    if [ -z "$digest" ]; then
        echo "MISS  $file  $tag — not pulled locally. Run: docker pull $tag" >&2
        continue
    fi

    echo "PIN   $file  $tag@$digest"
    changed=1
    if [ "$WRITE" = "1" ]; then
        # Only on FROM / image: lines, so a tag mentioned in prose stays prose.
        tmp=$(mktemp)
        sed -E "s#^([[:space:]]*(FROM|image:)[[:space:]]+)${tag//\//\\/}([[:space:]]|\$)#\1${tag//\//\\/}@${digest}\3#" "$file" > "$tmp"
        if cmp -s "$file" "$tmp"; then
            echo "      (no FROM/image: line matched — check the tag spelling)" >&2
            rm -f "$tmp"
        else
            mv "$tmp" "$file"
        fi
    fi
done

if [ "$changed" = "0" ]; then
    echo; echo "Nothing to do — every base image is already pinned by digest."
elif [ "$WRITE" = "0" ]; then
    echo; echo "Dry run. Re-run with --write to apply, then commit the change."
else
    echo; echo "Written. Verify with:  git diff -- Dockerfile.backend Dockerfile.frontend docker-compose.yml"
    echo "Then rebuild:            bash deploy.sh"
fi
